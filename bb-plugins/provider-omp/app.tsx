import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  Markdown,
  experimental_usePluginId,
  useComposer,
  useSdk,
  type PluginPendingInteractionProps,
  type PluginTimelineRendererProps,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { QuestionForm } from "@/components/ui/question-form";
import {
  OMP_EXTENSION_UI_RENDERER_ID,
  OMP_EXTENSION_UI_STATE_KIND,
  OMP_EDITOR_TEXT_STATE_KIND,
  ompEditorTextSchema,
  OMP_STATUS_STATE_KIND,
  OMP_NOTICE_KIND,
  OMP_CARD_KIND,
  ompCardSchema,
  ompStatusStateSchema,
  ompNoticeSchema,
  stripOmpAnsi,
  type OmpStatusState,
  ompExtensionUiStateSchema,
  ompExtensionUiPayloadDataSchema,
  type OmpExtensionUiPayloadData,
} from "./src/extension-ui-contract.js";
import {
  OMP_AGENT_DETAILS_DIRECTIVE,
  OMP_HUB_PANEL_ACTION_ID,
} from "./src/hub-contract.js";
import { OmpHubPanel } from "./src/hub/hub-panel.js";
import { OmpAgentDetailsDirective } from "./src/hub/hub-navigation.js";
import { OmpModelPresetsEditor } from "./src/model-presets-editor.js";

function parseRequest(payload: unknown): OmpExtensionUiPayloadData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const direct = ompExtensionUiPayloadDataSchema.safeParse(payload);
  if (direct.success) return direct.data;
  if (!("data" in payload)) return null;
  const wrapped = ompExtensionUiPayloadDataSchema.safeParse(payload.data);
  return wrapped.success ? wrapped.data : null;
}

function ExtensionUiInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const request = useMemo(
    () => parseRequest(interaction.payload),
    [interaction.payload],
  );

  if (!request) {
    return (
      <div className="space-y-3 text-xs text-muted-foreground">
        <p>This request could not be displayed.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void cancel()}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {request.truncated ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Some OMP dialog content was truncated to fit bb's 64 KiB limit.
          Review the visible truncation markers before answering.
        </p>
      ) : null}
      {request.detail ? (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">
          {request.detail}
        </p>
      ) : null}
      <ExtensionUiDialog
        key={interaction.id}
        interaction={interaction}
        request={request}
        submit={submit}
      />
    </div>
  );
}

function ExtensionUiDialog({
  interaction,
  request,
  submit,
}: Pick<PluginPendingInteractionProps, "interaction" | "submit"> & {
  request: OmpExtensionUiPayloadData;
}) {
  const sdk = useSdk();
  const [text, setText] = useState(
    request.method === "editor" ? request.prefill ?? "" : "",
  );
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const settled = useRef(false);

  const send = useCallback(
    async (value: JsonValue) => {
      if (settled.current) return;
      settled.current = true;
      setBusy(true);
      try {
        await submit(value);
      } catch (cause) {
        settled.current = false;
        setBusy(false);
        throw cause;
      }
    },
    [submit],
  );

  const expiresAt = request.expiresAt ?? interaction.expiresAt;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => {
      if (settled.current) return;
      setExpired(true);
      void send({ cancelled: true, timedOut: true }).catch(() => {});
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, send]);

  useEffect(() => {
    const lifecycle = request.lifecycle;
    if (!lifecycle) return;
    const controller = new AbortController();
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const currentRevision = ++revision;
      try {
        const events = await sdk.threads.events.list({
          threadId: interaction.threadId,
          types: ["thread/extensionState/updated"],
          order: "desc",
          limit: "100",
          signal: controller.signal,
        });
        if (disposed || currentRevision !== revision || settled.current) return;
        const event = events.find(
          (event) =>
            event.threadId === interaction.threadId &&
            event.type === "thread/extensionState/updated" &&
            event.data.kind === OMP_EXTENSION_UI_STATE_KIND,
        );
        if (!event || event.type !== "thread/extensionState/updated") return;
        const parsed = ompExtensionUiStateSchema.safeParse(event.data.payload);
        if (
          !parsed.success ||
          parsed.data.coordinatorId !== lifecycle.coordinatorId ||
          parsed.data.issuedThrough < lifecycle.sequence ||
          parsed.data.pendingRequestIds.includes(request.requestId)
        ) {
          return;
        }
        setDismissed(true);
        await send(null);
      } catch {}
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId: interaction.threadId,
      callback: (event) => {
        if (event.id === undefined || event.id === interaction.threadId) {
          void refresh();
        }
      },
    });
    const unsubscribeConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected" && event.reconnected) void refresh();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe();
      unsubscribeConnection();
    };
  }, [sdk, request.lifecycle, request.requestId, interaction.threadId, send]);

  if (dismissed) {
    return <p role="status">This request was dismissed.</p>;
  }

  if (expired) {
    return <p role="status">This request has timed out.</p>;
  }

  if (request.method === "select") {
    return (
      <QuestionForm
        questions={[
          {
            id: "select",
            prompt: "",
            shortLabel: "Select",
            multiSelect: false,
            allowFreeText: false,
            options: request.options.map((label, index) => ({
              value: `option-${index}`,
              label,
              description: request.optionDetails?.[index]?.description,
            })),
          },
        ]}
        disabled={busy}
        cancelDisabled={busy}
        onCancel={() => send(null)}
        onSubmit={async (answers) => {
          const selected = answers.select?.selected[0];
          const index = selected?.startsWith("option-")
            ? Number(selected.slice("option-".length))
            : Number.NaN;
          const option = request.options[index];
          if (option === undefined) throw new Error(`Unknown option: ${selected}`);
          await send(option);
        }}
      />
    );
  }

  if (request.method === "ask") {
    return (
      <QuestionForm
        questions={request.questions.map((question, questionIndex) => ({
          id: `question-${questionIndex}`,
          prompt: question.question,
          shortLabel: question.header || `Question ${questionIndex + 1}`,
          multiSelect: question.multi ?? false,
          allowEmpty: question.multi ?? false,
          allowFreeText: true,
          options: question.options.map((option, index) => ({
            value: `option-${index}`,
            label:
              index === question.recommended
                ? `${option.label} (Recommended)`
                : option.label,
            description: option.description,
            preview: option.preview,
          })),
        }))}
        disabled={busy}
        cancelDisabled={busy}
        onCancel={() => send(null)}
        onSubmit={async (answers) => {
          await send({
            answers: request.questions.map((question, questionIndex) => {
              const answer = answers[`question-${questionIndex}`]!;
              return {
                id: question.id,
                selectedOptions: answer.selected.map((selected) => {
                  const index = selected.startsWith("option-")
                    ? Number(selected.slice("option-".length))
                    : Number.NaN;
                  const option = question.options[index];
                  if (option === undefined) {
                    throw new Error(`Unknown option: ${selected}`);
                  }
                  return option.label;
                }),
                ...(answer.freeText ? { customInput: answer.freeText } : {}),
              };
            }),
          });
        }}
      />
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (request.method !== "confirm") {
      void send(text).catch(() => {});
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 text-xs text-muted-foreground"
    >
      {request.method === "confirm" ? (
        <p className="text-sm text-foreground">{request.message}</p>
      ) : null}
      {request.method === "input" ? (
        <input
          type="text"
          aria-label={interaction.title}
          className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground focus-visible:border-ring/50 focus-visible:outline-none"
          value={text}
          placeholder={request.placeholder}
          autoFocus
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      {request.method === "editor" ? (
        <>
          <textarea
            aria-label={interaction.title}
            className={`min-h-32 w-full resize-y rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground focus-visible:border-ring/50 focus-visible:outline-none ${request.promptStyle ? "" : "font-mono"}`}
            value={text}
            placeholder={request.promptStyle ? "Type your answer" : undefined}
            autoFocus
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.shiftKey || event.altKey) {
                return;
              }
              if (
                event.key === "Enter" &&
                (request.promptStyle || event.ctrlKey || event.metaKey)
              ) {
                event.preventDefault();
                void send(text).catch(() => {});
              } else if (event.key === "Escape") {
                event.preventDefault();
                void send(null).catch(() => {});
              }
            }}
          />
          {request.promptStyle ? (
            <p>Enter to submit · Shift+Enter for a new line</p>
          ) : null}
        </>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void send(null).catch(() => {})}
        >
          Cancel
        </Button>
        {request.method === "confirm" ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void send(false).catch(() => {})}
            >
              No
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void send(true).catch(() => {})}
            >
              Yes
            </Button>
          </div>
        ) : (
          <Button type="submit" size="sm" disabled={busy}>
            Submit
          </Button>
        )}
      </div>
    </form>
  );
}

function ExtensionStatusBanner() {
  const { scope } = useComposer();
  if (scope.kind !== "thread") return null;
  return <ExtensionThreadStatus key={scope.threadId} threadId={scope.threadId} />;
}

// Remember consumption across remounts, including environments where storage is
// unavailable. Persistent ids also protect drafts after a full app reload.
const consumedEditorRequests = new Map<string, string>();

function ExtensionThreadStatus({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const [state, setState] = useState<OmpStatusState | null>(null);

  useEffect(() => {
    const storageKey = `${pluginId}:editor-text:${composer.key}:${threadId}`;
    const controller = new AbortController();
    let disposed = false;
    let revision = 0;
    let initialized = false;
    const refresh = async () => {
      const currentRevision = ++revision;
      let beforeSeq: string | undefined;
      let editorSeen = false;
      try {
        while (!disposed && currentRevision === revision) {
          const events = await sdk.threads.events.list({
            threadId,
            types: ["thread/extensionState/updated"],
            order: "desc",
            limit: "100",
            beforeSeq,
            signal: controller.signal,
          });
          if (disposed || currentRevision !== revision) return;
          const editorEvent = events.find((event) =>
            event.threadId === threadId &&
            event.type === "thread/extensionState/updated" &&
            event.data.kind === OMP_EDITOR_TEXT_STATE_KIND
          );
          if (!editorSeen && editorEvent?.type === "thread/extensionState/updated") {
            editorSeen = true;
            const parsed = ompEditorTextSchema.safeParse(editorEvent.data.payload);
            if (parsed.success) {
              const request = parsed.data;
              let consumed = consumedEditorRequests.get(storageKey);
              try {
                consumed ??= localStorage.getItem(storageKey) ?? undefined;
              } catch {}
              if (!initialized) {
                // Hydration is not a composer action: old state must never
                // overwrite a draft when opening or returning to a thread.
                consumedEditorRequests.set(storageKey, request.requestId);
              } else if (
                consumed !== request.requestId &&
                composer.scope.kind === "thread" &&
                composer.scope.threadId === threadId
              ) {
                consumedEditorRequests.set(storageKey, request.requestId);
                try {
                  localStorage.setItem(storageKey, request.requestId);
                } catch {}
                composer.replace({ text: request.text, mentions: [] });
              }
            }
          }
          const event = events.find(
            (event) =>
              event.threadId === threadId &&
              event.type === "thread/extensionState/updated" &&
              event.data.kind === OMP_STATUS_STATE_KIND,
          );
          if (event?.type === "thread/extensionState/updated") {
            const parsed = ompStatusStateSchema.safeParse(event.data.payload);
            setState(parsed.success ? parsed.data : null);
            initialized = true;
            return;
          }
          if (events.length < 100) {
            setState(null);
            initialized = true;
            return;
          }
          beforeSeq = String(events[events.length - 1]!.seq);
        }
      } catch {}
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (event.id === undefined || event.id === threadId) void refresh();
      },
    });
    const unsubscribeConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected" && event.reconnected) void refresh();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe();
      unsubscribeConnection();
    };
  }, [sdk, composer, pluginId, threadId]);

  if (
    !state ||
    (state.statuses.length === 0 &&
      state.widgets.length === 0 &&
      !state.truncated)
  ) {
    return null;
  }

  return (
    <div
      role="status"
      aria-label="OMP extension status"
      className="space-y-2 text-xs text-muted-foreground"
    >
      {state.statuses.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {state.statuses.map((status, index) => (
            <span
              key={`${index}:${status.key}`}
              className="inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-md border border-border bg-surface-raised px-2 py-1"
            >
              <span className="break-words font-medium text-foreground">
                {stripOmpAnsi(status.key)}:
              </span>{" "}
              <span className="whitespace-pre-wrap break-words">
                {stripOmpAnsi(status.text)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      <ExtensionWidgetGroup widgets={state.widgets} placement="aboveEditor" />
      <ExtensionWidgetGroup widgets={state.widgets} placement="belowEditor" />
      {state.truncated ? (
        <p>OMP status or widget content was truncated.</p>
      ) : null}
    </div>
  );
}

function ExtensionWidgetGroup({
  widgets,
  placement,
}: {
  widgets: OmpStatusState["widgets"];
  placement: OmpStatusState["widgets"][number]["placement"];
}) {
  const group = widgets.filter((widget) => widget.placement === placement);
  if (group.length === 0) return null;
  const aboveEditor = placement === "aboveEditor";

  // bb composer banners sit above the editor; retain OMP's grouping and order.
  return (
    <div
      role="group"
      aria-label={aboveEditor ? "Above-editor widgets" : "Below-editor widgets"}
      data-widget-placement={placement}
      className="space-y-1.5"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide">
        {aboveEditor ? "Above-editor widgets" : "Below-editor widgets"}
        {!aboveEditor ? (
          <span className="ml-1 font-normal normal-case tracking-normal">
            (shown here above the editor)
          </span>
        ) : null}
      </p>
      {group.map((widget, index) => (
        <div
          key={`${index}:${widget.key}`}
          className="min-w-0 rounded-md border border-border bg-surface-raised px-2 py-1.5"
        >
          <p className="break-words font-medium text-foreground">
            {stripOmpAnsi(widget.key)}
          </p>
          <pre className="overflow-x-auto whitespace-pre font-mono text-xs">
            {stripOmpAnsi(widget.lines.join("\n"))}
          </pre>
        </div>
      ))}
    </div>
  );
}

function ExtensionNotice({
  payload,
  Original,
}: PluginTimelineRendererProps) {
  const parsed = ompNoticeSchema.safeParse(payload);
  if (!parsed.success) return <Original />;
  return (
    <div
      role="note"
      aria-label={`OMP ${parsed.data.severity} notification`}
      className="whitespace-pre-wrap break-words text-xs text-foreground"
    >
      <p>{stripOmpAnsi(parsed.data.message)}</p>
      {parsed.data.url ? (
        <p>
          <a
            href={/^https?:\/\//iu.test(parsed.data.url) ? parsed.data.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {parsed.data.url}
          </a>
        </p>
      ) : null}
      {parsed.data.launchUrl ? (
        <p>
          Short sign-in link (copy target):{" "}
          <a
            href={/^https?:\/\//iu.test(parsed.data.launchUrl) ? parsed.data.launchUrl : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {parsed.data.launchUrl}
          </a>
        </p>
      ) : null}
      {parsed.data.instructions ? <p>{stripOmpAnsi(parsed.data.instructions)}</p> : null}
    </div>
  );
}

const cardToneClasses = {
  info: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

function ExtensionCard({ payload, Original }: PluginTimelineRendererProps) {
  const parsed = ompCardSchema.safeParse(payload);
  if (!parsed.success) return <Original />;
  const card = parsed.data;
  const tone = card.tone ?? "info";
  return (
    <div
      role="note"
      aria-label={`OMP ${tone} card: ${stripOmpAnsi(card.title)}`}
      className={`min-w-0 space-y-3 rounded-md border p-3 text-xs ${cardToneClasses[tone]}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="break-words font-medium text-foreground">
          {stripOmpAnsi(card.title)}
        </h3>
        <span className={`rounded border px-1.5 py-0.5 ${cardToneClasses[tone]}`}>
          {tone}
        </span>
      </div>
      {card.sections.map((section, index) => (
        <section key={index} className="min-w-0 space-y-1.5 text-foreground">
          {section.heading || section.badge ? (
            <div className="flex flex-wrap items-center gap-2">
              {section.heading ? (
                <h4 className="break-words font-medium">
                  {stripOmpAnsi(section.heading)}
                </h4>
              ) : null}
              {section.badge ? (
                <span
                  className={`break-words rounded border px-1.5 py-0.5 ${cardToneClasses[section.badge.tone ?? tone]}`}
                >
                  {stripOmpAnsi(section.badge.label)}
                </span>
              ) : null}
            </div>
          ) : null}
          {section.meta ? (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {stripOmpAnsi(section.meta)}
            </p>
          ) : null}
          {section.body ? (
            <Markdown
              content={stripOmpAnsi(section.body)}
              className="min-w-0 break-words"
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "omp-model-presets",
    title: "omp model presets",
    description: "Edit global omp presets. Selecting a preset in a thread applies its model roles without changing your global active roles.",
    component: OmpModelPresetsEditor,
  });
  app.slots.pendingInteraction({
    id: OMP_EXTENSION_UI_RENDERER_ID,
    component: ExtensionUiInteraction,
  });
  app.composer.customize({
    id: "omp-extension-status",
    scopes: ["thread"],
    banners: [{
      id: "status",
      chrome: "card",
      component: ExtensionStatusBanner,
    }],
  });
  app.slots.experimental_timelineRenderer({
    kind: OMP_NOTICE_KIND,
    component: ExtensionNotice,
  });
  app.slots.experimental_timelineRenderer({
    kind: OMP_CARD_KIND,
    component: ExtensionCard,
  });
  app.slots.experimental_tab({
    id: OMP_HUB_PANEL_ACTION_ID,
    title: "omp Hub",
    icon: "Bot",
    layout: "padded",
    context: { kind: "thread" },
    availability: "action",
    component: OmpHubPanel,
  });
  app.slots.messageDirective({
    id: OMP_AGENT_DETAILS_DIRECTIVE,
    component: OmpAgentDetailsDirective,
  });
});