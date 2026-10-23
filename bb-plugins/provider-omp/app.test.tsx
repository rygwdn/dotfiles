// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
  type PluginSdkTestFakes,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  JsonValue,
  PluginBrowserBbSdk,
  PluginComposerScope,
  PluginTimelineRendererProps,
} from "@get-bb/plugin-sdk/app";
import {
  OMP_EXTENSION_UI_KIND,
  OMP_EXTENSION_UI_STATE_KIND,
  OMP_EDITOR_TEXT_STATE_KIND,
  OMP_STATUS_STATE_KIND,
  OMP_NOTICE_KIND,
  OMP_CARD_KIND,
  ompCardSchema,
} from "./src/extension-ui-contract.js";
import { ompProviderDeclaration } from "./src/declaration.js";
import { DEFAULT_OMP_MODEL_FILTER } from "./src/model-curation.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function render(
  data: JsonValue | undefined,
  handlers: {
    submit?: (value: unknown) => Promise<void>;
    cancel?: () => Promise<void>;
    sdk?: PluginSdkTestFakes;
  } = {},
  payload: JsonValue | undefined = data,
) {
  return renderSlot(app.pendingInteractions[0]!, {
    interaction: {
      id: "pint_test",
      threadId: "thr_test",
      title: "Allow access?",
      payload: payload ?? null,
      createdAt: 0,
      expiresAt: null,
    },
    submit: handlers.submit ?? (async () => undefined),
    cancel: handlers.cancel ?? (async () => undefined),
  }, { sdk: handlers.sdk });
}

type SdkSubscription = Parameters<PluginBrowserBbSdk["subscribe"]>[0];
interface StateEvent {
  id: string;
  threadId: string;
  seq: number;
  createdAt: number;
  scope: { kind: "thread" };
  type: "thread/extensionState/updated";
  data: {
    providerThreadId: string;
    kind: typeof OMP_EXTENSION_UI_STATE_KIND | typeof OMP_STATUS_STATE_KIND | typeof OMP_EDITOR_TEXT_STATE_KIND;
    payload: JsonValue;
  };
}
type SdkConnectionState = Parameters<
  Extract<SdkSubscription, { event: "realtime:connection" }>["callback"]
>[0]["state"];

function stateEvent(
  payload: JsonValue,
  threadId = "thr_test",
  seq = 1,
  kind: StateEvent["data"]["kind"] = OMP_EXTENSION_UI_STATE_KIND,
): StateEvent {
  return {
    id: `event-${seq}`,
    threadId,
    seq,
    createdAt: seq,
    scope: { kind: "thread" },
    type: "thread/extensionState/updated",
    data: {
      providerThreadId: "omp_test",
      kind,
      payload,
    },
  };
}

function stateSdk(events: StateEvent[]) {
  const list = vi.fn<PluginBrowserBbSdk["threads"]["events"]["list"]>()
    .mockResolvedValue(events);
  const listeners: SdkSubscription[] = [];
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((subscription: SdkSubscription) => {
    listeners.push(subscription);
    return () => {
      const index = listeners.indexOf(subscription);
      if (index >= 0) listeners.splice(index, 1);
      unsubscribe();
    };
  });
  const sdk: PluginSdkTestFakes = {
    subscribe,
    threads: { events: { list } },
  };
  const threadChanged = (id?: string) => {
    for (const subscription of listeners) {
      if (subscription.event === "thread:changed") {
        subscription.callback({
          type: "changed",
          entity: "thread",
          ...(id === undefined ? {} : { id }),
          changes: ["events-appended"],
        });
      }
    }
  };
  const connectionChanged = (
    state: SdkConnectionState,
    reconnected = false,
  ) => {
    for (const subscription of listeners) {
      if (subscription.event === "realtime:connection") {
        subscription.callback({
          state,
          reconnected,
          reconnectDelayMs: null,
        });
      }
    }
  };
  return {
    sdk,
    list,
    subscribe,
    unsubscribe,
    threadChanged,
    connectionChanged,
    reconnected: () => connectionChanged("connected", true),
  };
}

function statusEvent(
  payload: JsonValue,
  threadId = "thr_test",
  seq = 1,
): StateEvent {
  return stateEvent(payload, threadId, seq, OMP_STATUS_STATE_KIND);
}

function renderStatus(
  sdk: PluginSdkTestFakes,
  scope: PluginComposerScope = { kind: "thread", threadId: "thr_test" },
  text = "",
) {
  return renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    sdk,
    context: { threadId: "thr_route" },
    composer: { scope, text },
  });
}

function renderTimeline(
  kind: typeof OMP_NOTICE_KIND | typeof OMP_CARD_KIND,
  payload: JsonValue,
) {
  const props: PluginTimelineRendererProps = {
    row: {
      id: "row-notice",
      threadId: "thr_test",
      turnId: "turn_test",
      kind,
      toolName: null,
      status: "completed",
      startedAt: 0,
      completedAt: 1,
    },
    payload,
    presentation: null,
    thread: { id: "thr_test", providerId: "omp" },
    Original: () => <p>Original timeline body</p>,
  };
  return renderSlot(app.timelineRenderers.find((renderer) => renderer.kind === kind)!, props);
}

function renderNotice(payload: JsonValue) {
  return renderTimeline(OMP_NOTICE_KIND, payload);
}

function renderCard(payload: JsonValue) {
  return renderTimeline(OMP_CARD_KIND, payload);
}

const lifecycleRequest = {
  requestId: "omp-ui-1",
  method: "input",
  lifecycle: { coordinatorId: "coordinator-current", sequence: 1 },
};

describe("omp extension ui interaction", () => {
  const titledDialogs: Array<Record<string, JsonValue>> = [
    { method: "select", options: ["Approve", "Deny"] },
    { method: "confirm", message: "Proceed?" },
    { method: "input" },
    { method: "editor", prefill: "Draft" },
    { method: "ask", questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }] },
  ];
  it.each(titledDialogs)("renders the entire multiline title in the $method dialog body", (request) => {
    const detail = "Full approval details\n".repeat(50).slice(0, 1_000);
    const view = render({ requestId: "long-ui", detail, ...request });
    const body = view.container.querySelector("p.whitespace-pre-wrap");
    expect(body?.textContent).toBe(detail);
    expect(view.queryByText("This request could not be displayed.")).toBeNull();
  });

  it("makes aggregate truncation explicit before the user answers", () => {
    const view = render({
      requestId: "truncated-ui",
      method: "editor",
      prefill: "Visible text\n[… truncated to fit bb's 64 KiB dialog limit …]",
      truncated: true,
    });
    expect(view.getByRole("alert").textContent).toContain("truncated");
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toContain("truncated to fit bb");
  });

  it("submits the chosen option label for a select dialog", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-1", method: "select", options: ["Allow once", "Deny"] },
      { submit },
    );
    fireEvent.click(view.getByText("Allow once"));
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("Allow once"));
  });

  it("lets a select dialog retry after a failed submit", async () => {
    const submit = vi
      .fn<(value: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const view = render(
      { requestId: "ui-1", method: "select", options: ["Allow once", "Deny"] },
      { submit },
    );
    fireEvent.click(view.getByText("Allow once"));
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        (view.getByText("Submit answer").closest("button") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  });

  it("keeps submit disabled until a select option is chosen", () => {
    const view = render({
      requestId: "ui-1",
      method: "select",
      options: ["A", "B"],
    });
    expect((view.getByText("Submit answer") as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(view.getByText("B"));
    expect((view.getByText("Submit answer") as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("submits a boolean for a confirm dialog", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-2", method: "confirm", message: "This modifies files." },
      { submit },
    );
    expect(view.getByText("This modifies files.")).toBeDefined();
    fireEvent.click(view.getByText("No"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(false));
  });

  it("submits typed text for an input dialog", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-3", method: "input", placeholder: "type here" },
      { submit },
    );
    fireEvent.change(view.getByPlaceholderText("type here"), {
      target: { value: "hello" },
    });
    fireEvent.click(view.getByText("Submit"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("hello"));
  });

  it("keeps an input dialog locked after a successful submit and retryable after a failure", async () => {
    const submit = vi
      .fn<(value: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const view = render(
      { requestId: "ui-3", method: "input", placeholder: "type here" },
      { submit },
    );
    const input = view.getByPlaceholderText("type here") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(view.getByText("Submit"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(input.disabled).toBe(false));

    fireEvent.click(view.getByText("Submit"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("hello");
  });

  it("renders editor prefill and submits the edited text", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-4", method: "editor", prefill: "line one" },
      { submit },
    );
    const editor = view.container.querySelector("textarea")!;
    fireEvent.change(editor, { target: { value: "line one\nline two" } });
    fireEvent.click(view.getByText("Submit"));
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith("line one\nline two"),
    );
  });

  it("still renders the wrapped stored-payload shape for robustness", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      undefined,
      { submit },
      {
        kind: OMP_EXTENSION_UI_KIND,
        title: "Allow access?",
        data: { requestId: "ui-1", method: "select", options: ["A"] },
      },
    );
    fireEvent.click(view.getByText("A"));
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("A"));
  });

  it("offers cancel for an unrenderable payload", async () => {
    const cancel = vi.fn(async () => undefined);
    const view = render({ broken: true }, { cancel });
    expect(view.getByText(/could not be displayed/)).toBeDefined();
    fireEvent.click(view.getByText("Cancel"));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("cancels a rendered dialog without stopping the whole provider turn", async () => {
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-1", method: "select", options: ["A"] },
      { submit, cancel },
    );
    fireEvent.click(view.getByText("Cancel"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(null));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("renders aligned select option descriptions without changing the selected label", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      {
        requestId: "ui-select",
        method: "select",
        options: ["A", "B"],
        optionDetails: [{}, { description: "The second option" }],
      },
      { submit },
    );
    expect(view.getByText("The second option")).toBeDefined();
    fireEvent.click(view.getByText("B"));
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("B"));
  });

  it("submits ordered ask answers using exact labels for both single and multiple selections", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      {
        requestId: "ui-ask",
        method: "ask",
        questions: [
          {
            id: "language",
            question: "Which language?",
            header: "Language",
            options: [
              {
                label: "TypeScript",
                description: "Typed JavaScript",
                preview: "const n: number = 1;",
              },
              { label: "Rust" },
            ],
            recommended: 0,
          },
          {
            id: "targets",
            question: "Which targets?",
            header: "Targets",
            options: [{ label: "Web" }, { label: "CLI" }],
            multi: true,
          },
        ],
      },
      { submit },
    );
    expect(view.getByText("Typed JavaScript")).toBeDefined();
    fireEvent.click(view.getByText("TypeScript (Recommended)"));
    expect(view.getByText("const n: number = 1;")).toBeDefined();
    fireEvent.click(view.getByText("Next"));
    fireEvent.click(view.getByText("Web"));
    fireEvent.click(view.getByText("CLI"));
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        answers: [
          { id: "language", selectedOptions: ["TypeScript"] },
          { id: "targets", selectedOptions: ["Web", "CLI"] },
        ],
      }),
    );
  });

  it("supports custom ask input alone for single-select and alongside multi-select labels", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      {
        requestId: "ui-ask",
        method: "ask",
        questions: [
          {
            id: "__proto__",
            question: "Which language?",
            header: "Language",
            options: [{ label: "TypeScript" }],
          },
          {
            id: "targets",
            question: "Which targets?",
            header: "Targets",
            options: [{ label: "Web" }],
            multi: true,
          },
        ],
      },
      { submit },
    );
    fireEvent.click(view.getByText("Other…"));
    fireEvent.change(view.getByLabelText("Language answer"), {
      target: { value: " Ruby " },
    });
    fireEvent.click(view.getByText("Next"));
    fireEvent.click(view.getByText("Web"));
    fireEvent.click(view.getByText("Other…"));
    fireEvent.change(view.getByLabelText("Targets answer"), {
      target: { value: "Mobile" },
    });
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        answers: [
          { id: "__proto__", selectedOptions: [], customInput: "Ruby" },
          { id: "targets", selectedOptions: ["Web"], customInput: "Mobile" },
        ],
      }),
    );
  });

  it("allows an empty multi-select ask answer", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      {
        requestId: "ui-ask",
        method: "ask",
        questions: [
          {
            id: "targets",
            question: "Which targets?",
            options: [{ label: "Web" }, { label: "CLI" }],
            multi: true,
          },
        ],
      },
      { submit },
    );
    expect((view.getByText("Submit answer") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        answers: [{ id: "targets", selectedOptions: [] }],
      }),
    );
  });

  it("supports ask questions with only free text", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      {
        requestId: "ui-ask",
        method: "ask",
        questions: [{ id: "notes", question: "Anything else?", header: "Notes", options: [] }],
      },
      { submit },
    );
    fireEvent.change(view.getByLabelText("Notes answer"), {
      target: { value: "Additional context" },
    });
    fireEvent.click(view.getByText("Submit answer"));
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        answers: [{ id: "notes", selectedOptions: [], customInput: "Additional context" }],
      }),
    );
  });

  it("uses prompt-style editor Enter submission while preserving Shift+Enter and IME composition", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-editor", method: "editor", prefill: "answer", promptStyle: true },
      { submit },
    );
    const editor = view.getByPlaceholderText("Type your answer");
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("answer"));
  });

  it("keeps plain editor Enter as a newline and supports Ctrl+Enter submission", async () => {
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-editor", method: "editor", prefill: "first\nsecond" },
      { submit },
    );
    const editor = view.getByRole("textbox");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("first\nsecond"));
  });

  it("cancels an editor with Escape without invoking the provider stop action", async () => {
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-editor", method: "editor", promptStyle: true },
      { submit, cancel },
    );
    fireEvent.keyDown(view.getByRole("textbox"), { key: "Escape" });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(null));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("dismisses an expired request and reports a timed-out cancellation without stopping the turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-timed", method: "input", expiresAt: 1_100 },
      { submit, cancel },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith({ cancelled: true, timedOut: true });
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("timed out");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not timeout a dialog that has already been submitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-timed", method: "input", expiresAt: 1_100 },
      { submit },
    );
    fireEvent.click(view.getByText("Submit"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("clears a dialog timeout when its renderer is unmounted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const submit = vi.fn(async () => undefined);
    const view = render(
      { requestId: "ui-timed", method: "input", expiresAt: 1_100 },
      { submit },
    );
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("dismisses a matching server-cancelled dialog through supported extension state without stopping the turn", async () => {
    const host = stateSdk([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: ["omp-ui-1"],
    })]);
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const view = render(lifecycleRequest, { sdk: host.sdk, submit, cancel });
    await vi.waitFor(() => expect(host.list).toHaveBeenCalledTimes(1));
    expect(host.list).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thr_test",
      types: ["thread/extensionState/updated"],
      order: "desc",
    }));
    expect(host.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      event: "thread:changed",
      threadId: "thr_test",
    }));
    host.list.mockResolvedValue([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: [],
    }, "thr_test", 2)]);
    await act(async () => host.threadChanged("thr_test"));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(null));
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("dismissed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("dismisses a request cancelled before its renderer mounted", async () => {
    const host = stateSdk([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 4,
      pendingRequestIds: ["omp-ui-4"],
    })]);
    const submit = vi.fn(async () => undefined);
    const view = render(lifecycleRequest, { sdk: host.sdk, submit });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(null));
    expect(view.queryByRole("textbox")).toBeNull();
  });

  it.each([
    { coordinatorId: "coordinator-old", issuedThrough: 100, pendingRequestIds: [] },
    { coordinatorId: "coordinator-current", issuedThrough: 0, pendingRequestIds: [] },
    { coordinatorId: "coordinator-current", issuedThrough: 1, pendingRequestIds: ["omp-ui-1"] },
    { coordinatorId: "coordinator-current", issuedThrough: "invalid", pendingRequestIds: [] },
  ])("does not dismiss from stale, unrelated, open, or malformed state: %j", async (state) => {
    const host = stateSdk([stateEvent(state)]);
    const submit = vi.fn(async () => undefined);
    const view = render(lifecycleRequest, { sdk: host.sdk, submit });
    await act(async () => {});
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(view.getByRole("textbox")).toBeDefined();
  });

  it("filters both state rows and realtime callbacks by thread", async () => {
    const host = stateSdk([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 100,
      pendingRequestIds: [],
    }, "thr_other")]);
    const submit = vi.fn(async () => undefined);
    const view = render(lifecycleRequest, { sdk: host.sdk, submit });
    await act(async () => {});
    await act(async () => host.threadChanged("thr_other"));
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(view.getByRole("textbox")).toBeDefined();
  });

  it("reconciles cancellation after the realtime connection reconnects", async () => {
    const host = stateSdk([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: ["omp-ui-1"],
    })]);
    const submit = vi.fn(async () => undefined);
    render(lifecycleRequest, { sdk: host.sdk, submit });
    await act(async () => {});
    host.list.mockResolvedValue([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: [],
    }, "thr_test", 2)]);
    await act(async () => host.reconnected());
    await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(null));
  });

  it("ignores older asynchronous snapshots that finish after a newer refresh", async () => {
    const oldRead = Promise.withResolvers<StateEvent[]>();
    const host = stateSdk([]);
    host.list.mockReturnValueOnce(oldRead.promise).mockResolvedValue([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: ["omp-ui-1"],
    }, "thr_test", 2)]);
    const submit = vi.fn(async () => undefined);
    const view = render(lifecycleRequest, { sdk: host.sdk, submit });
    await act(async () => host.threadChanged("thr_test"));
    await act(async () => oldRead.resolve([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: [],
    })]));
    expect(host.list).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    expect(view.getByRole("textbox")).toBeDefined();
  });

  it("unsubscribes, aborts its state query, and ignores a cancellation read completing after unmount", async () => {
    const lateRead = Promise.withResolvers<StateEvent[]>();
    const host = stateSdk([]);
    host.list.mockReturnValueOnce(lateRead.promise);
    const submit = vi.fn(async () => undefined);
    const view = render(lifecycleRequest, { sdk: host.sdk, submit });
    const signal = host.list.mock.calls[0]![0].signal;
    view.unmount();
    await act(async () => lateRead.resolve([stateEvent({
      coordinatorId: "coordinator-current",
      issuedThrough: 1,
      pendingRequestIds: [],
    })]));
    expect(signal?.aborted).toBe(true);
    expect(host.unsubscribe).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("omp extension status banner", () => {
  it("registers a thread-scoped composer banner with host card chrome", () => {
    expect(app.composerCustomizations).toEqual([{
      id: "omp-extension-status",
      scopes: ["thread"],
      banners: [{
        id: "status",
        chrome: "card",
        component: expect.any(Function),
      }],
    }]);
  });

  it("loads the latest matching snapshot for the composer thread, not the current route", async () => {
    const host = stateSdk([
      stateEvent({ coordinatorId: "dialog", issuedThrough: 1, pendingRequestIds: [] }, "thr_test", 5),
      statusEvent({ statuses: [{ key: "other", text: "Other thread" }], widgets: [] }, "thr_other", 4),
      statusEvent({ statuses: [{ key: "review", text: "Latest status" }], widgets: [] }, "thr_test", 3),
      statusEvent({ statuses: [{ key: "review", text: "Old status" }], widgets: [] }, "thr_test", 2),
    ]);
    const view = renderStatus(host.sdk);

    await view.findByText("Latest status");
    expect(view.getByText("review:")).toBeDefined();
    expect(view.queryByText("Old status")).toBeNull();
    expect(view.queryByText("Other thread")).toBeNull();
    expect(host.list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      threadId: "thr_test",
      types: ["thread/extensionState/updated"],
      order: "desc",
      limit: "100",
      signal: expect.any(AbortSignal),
    }));
    expect(host.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      event: "thread:changed",
      threadId: "thr_test",
    }));
    expect(host.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      event: "realtime:connection",
    }));
  });

  it("pages past newer extension states of other kinds to find the latest OMP status", async () => {
    const host = stateSdk([]);
    host.list.mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) =>
      stateEvent({ coordinatorId: "dialog", issuedThrough: index, pendingRequestIds: [] }, "thr_test", 200 - index)
    )).mockResolvedValueOnce([
      statusEvent({ statuses: [{ key: "review", text: "Persisted status" }], widgets: [] }, "thr_test", 100),
    ]);
    const view = renderStatus(host.sdk);

    await view.findByText("Persisted status");
    expect(host.list).toHaveBeenCalledTimes(2);
    expect(host.list.mock.calls[1]![0]).toMatchObject({
      threadId: "thr_test",
      beforeSeq: "101",
      order: "desc",
      types: ["thread/extensionState/updated"],
    });
  });

  it.each([
    { label: "no snapshot", events: [] },
    {
      label: "an empty snapshot",
      events: [statusEvent({ statuses: [], widgets: [] })],
    },
    {
      label: "only unrelated extension state",
      events: [stateEvent({ coordinatorId: "dialog", issuedThrough: 1, pendingRequestIds: [] })],
    },
    {
      label: "an invalid latest snapshot instead of reviving an older one",
      events: [
        statusEvent({ statuses: "invalid", widgets: [] }, "thr_test", 2),
        statusEvent({ statuses: [{ key: "old", text: "Stale status" }], widgets: [] }),
      ],
    },
  ])("renders nothing for $label", async ({ events }) => {
    const host = stateSdk(events);
    const view = renderStatus(host.sdk);
    await act(async () => {});

    expect(host.list).toHaveBeenCalledTimes(1);
    expect(view.container.innerHTML).toBe("");
  });

  const otherScopes: PluginComposerScope[] = [
    { kind: "new-thread", projectId: null },
    { kind: "queued-message", threadId: "thr_test", queuedMessageId: "queued_1" },
  ];
  it.each(otherScopes)("does not fetch or render for a $kind composer", async (scope) => {
    const host = stateSdk([
      statusEvent({ statuses: [{ key: "review", text: "Thread status" }], widgets: [] }),
    ]);
    const view = renderStatus(host.sdk, scope);
    await act(async () => {});

    expect(view.container.innerHTML).toBe("");
    expect(host.list).not.toHaveBeenCalled();
    expect(host.subscribe).not.toHaveBeenCalled();
  });

  it("refreshes on matching and unscoped thread changes but ignores other threads", async () => {
    const host = stateSdk([
      statusEvent({ statuses: [{ key: "review", text: "Initial status" }], widgets: [] }),
    ]);
    const view = renderStatus(host.sdk);
    await view.findByText("Initial status");
    host.list.mockResolvedValue([
      statusEvent({ statuses: [{ key: "review", text: "Updated status" }], widgets: [] }, "thr_test", 2),
    ]);

    await act(async () => host.threadChanged("thr_other"));
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(view.queryByText("Updated status")).toBeNull();

    await act(async () => host.threadChanged("thr_test"));
    await view.findByText("Updated status");
    expect(view.queryByText("Initial status")).toBeNull();

    host.list.mockResolvedValue([
      statusEvent({ statuses: [{ key: "review", text: "Unscoped refresh" }], widgets: [] }, "thr_test", 3),
    ]);
    await act(async () => host.threadChanged());
    await view.findByText("Unscoped refresh");
    expect(host.list).toHaveBeenCalledTimes(3);
  });

  it("clears rendered statuses and widgets when the latest snapshot is empty", async () => {
    const host = stateSdk([statusEvent({
      statuses: [{ key: "review", text: "Active status" }],
      widgets: [{ key: "progress", lines: ["Working"], placement: "aboveEditor" }],
    })]);
    const view = renderStatus(host.sdk);
    await view.findByText("Active status");
    expect(view.getByText("Working")).toBeDefined();

    host.list.mockResolvedValue([statusEvent({ statuses: [], widgets: [] }, "thr_test", 2)]);
    await act(async () => host.threadChanged("thr_test"));
    expect(view.container.innerHTML).toBe("");
  });

  it("reconciles after a reconnect, but not on ordinary connection-state changes", async () => {
    const host = stateSdk([
      statusEvent({ statuses: [{ key: "review", text: "Before disconnect" }], widgets: [] }),
    ]);
    const view = renderStatus(host.sdk);
    await view.findByText("Before disconnect");
    host.list.mockResolvedValue([
      statusEvent({ statuses: [{ key: "review", text: "After reconnect" }], widgets: [] }, "thr_test", 2),
    ]);

    await act(async () => {
      host.connectionChanged("disconnected");
      host.connectionChanged("connecting");
      host.connectionChanged("connected");
    });
    expect(host.list).toHaveBeenCalledTimes(1);
    await act(async () => host.reconnected());
    await view.findByText("After reconnect");
    expect(host.list).toHaveBeenCalledTimes(2);
  });

  it("retains the last snapshot on a failed refresh and can reconcile on reconnect", async () => {
    const host = stateSdk([
      statusEvent({ statuses: [{ key: "review", text: "Last known status" }], widgets: [] }),
    ]);
    const view = renderStatus(host.sdk);
    await view.findByText("Last known status");
    host.list.mockRejectedValueOnce(new Error("offline"));
    await act(async () => host.threadChanged("thr_test"));
    expect(view.getByText("Last known status")).toBeDefined();

    host.list.mockResolvedValue([
      statusEvent({ statuses: [{ key: "review", text: "Recovered status" }], widgets: [] }, "thr_test", 2),
    ]);
    await act(async () => host.reconnected());
    await view.findByText("Recovered status");
  });

  it("ignores an older asynchronous snapshot that finishes after a newer refresh", async () => {
    const oldRead = Promise.withResolvers<StateEvent[]>();
    const host = stateSdk([]);
    host.list.mockReturnValueOnce(oldRead.promise).mockResolvedValue([
      statusEvent({ statuses: [{ key: "review", text: "Newer status" }], widgets: [] }, "thr_test", 2),
    ]);
    const view = renderStatus(host.sdk);
    await act(async () => host.threadChanged("thr_test"));
    await view.findByText("Newer status");

    await act(async () => oldRead.resolve([
      statusEvent({ statuses: [{ key: "review", text: "Older status" }], widgets: [] }),
    ]));
    expect(view.getByText("Newer status")).toBeDefined();
    expect(view.queryByText("Older status")).toBeNull();
    expect(host.list).toHaveBeenCalledTimes(2);
  });

  it("clears the previous thread immediately and retires its in-flight reads on a thread switch", async () => {
    const host = stateSdk([
      statusEvent({ statuses: [{ key: "review", text: "Previous thread" }], widgets: [] }),
    ]);
    const view = renderStatus(host.sdk);
    await view.findByText("Previous thread");
    const oldRead = Promise.withResolvers<StateEvent[]>();
    const nextRead = Promise.withResolvers<StateEvent[]>();
    host.list.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(nextRead.promise);
    await act(async () => host.threadChanged("thr_test"));
    const oldSignal = host.list.mock.calls[1]![0].signal;

    await view.behavior.setComposerScope({ kind: "thread", threadId: "thr_next" });
    expect(view.container.innerHTML).toBe("");
    expect(oldSignal?.aborted).toBe(true);
    expect(host.unsubscribe).toHaveBeenCalledTimes(2);
    expect(host.list.mock.calls[2]![0].threadId).toBe("thr_next");
    expect(host.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      event: "thread:changed",
      threadId: "thr_next",
    }));

    await act(async () => oldRead.resolve([
      statusEvent({ statuses: [{ key: "review", text: "Retired thread update" }], widgets: [] }, "thr_test", 2),
    ]));
    expect(view.container.innerHTML).toBe("");
    await act(async () => nextRead.resolve([
      statusEvent({ statuses: [{ key: "review", text: "Next thread status" }], widgets: [] }, "thr_next"),
    ]));
    expect(view.getByText("Next thread status")).toBeDefined();
    expect(view.queryByText("Previous thread")).toBeNull();
    expect(view.queryByText("Retired thread update")).toBeNull();

    await act(async () => host.threadChanged("thr_test"));
    expect(host.list).toHaveBeenCalledTimes(3);
  });

  it("aborts reads and removes both subscriptions when unmounted", async () => {
    const lateRead = Promise.withResolvers<StateEvent[]>();
    const host = stateSdk([]);
    host.list.mockReturnValueOnce(lateRead.promise);
    const view = renderStatus(host.sdk);
    const signal = host.list.mock.calls[0]![0].signal;

    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(host.unsubscribe).toHaveBeenCalledTimes(2);
    await act(async () => {
      host.threadChanged("thr_test");
      host.reconnected();
      lateRead.resolve([
        statusEvent({ statuses: [{ key: "late", text: "Late status" }], widgets: [] }),
      ]);
    });
    expect(host.list).toHaveBeenCalledTimes(1);
    expect(view.container.innerHTML).toBe("");
  });

  it("renders compact plain-text chips and monospace widgets grouped by requested placement", async () => {
    const host = stateSdk([statusEvent({
      statuses: [
        { key: "\u001b[36mreview\u001b[0m", text: "\u001b[32mReady\u001b[0m" },
        { key: "empty", text: "" },
      ],
      widgets: [
        { key: "below-first", lines: ["Bottom line"], placement: "belowEditor" },
        {
          key: "\u001b[36mabove-first\u001b[0m",
          lines: [
            "\u001b[31mFirst line\u001b[0m",
            "\u001b]8;;https://example.com\u0007Linked text\u001b]8;;\u0007",
          ],
          placement: "aboveEditor",
        },
        { key: "below-empty", lines: [], placement: "belowEditor" },
        { key: "above-second", lines: ["Second widget"], placement: "aboveEditor" },
      ],
    })]);
    const view = renderStatus(host.sdk);
    await view.findByText("Ready");
    const banner = view.getByRole("status", { name: "OMP extension status" });
    expect(view.getByText("review:").parentElement).toBe(view.getByText("Ready").parentElement);
    expect(view.getByText("empty:")).toBeDefined();
    expect(banner.textContent).not.toContain("\u001b");

    const groups = view.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("data-widget-placement"))).toEqual([
      "aboveEditor",
      "belowEditor",
    ]);
    const above = view.getByRole("group", { name: "Above-editor widgets" });
    const below = view.getByRole("group", { name: "Below-editor widgets" });
    expect(within(above).getByText("above-first")).toBeDefined();
    expect(Array.from(above.querySelectorAll("pre"), (pre) => pre.textContent)).toEqual([
      "First line\nLinked text",
      "Second widget",
    ]);
    expect(Array.from(below.querySelectorAll("pre"), (pre) => pre.textContent)).toEqual([
      "Bottom line",
      "",
    ]);
    expect(within(below).getByText("below-empty")).toBeDefined();
    expect(within(below).getByText("(shown here above the editor)")).toBeDefined();
    for (const pre of banner.querySelectorAll("pre")) {
      expect(pre.classList.contains("font-mono")).toBe(true);
      expect(pre.classList.contains("whitespace-pre")).toBe(true);
    }
  });

  it("keeps entries with colliding clipped display keys distinct and clears them without stale content", async () => {
    const clippedKey = "x".repeat(128);
    const host = stateSdk([statusEvent({
      statuses: [
        { key: clippedKey, text: "First clipped status" },
        { key: clippedKey, text: "Second clipped status" },
        { key: "retained", text: "Retained status" },
      ],
      widgets: [
        { key: clippedKey, lines: ["First clipped widget"], placement: "aboveEditor" },
        { key: clippedKey, lines: ["Second clipped widget"], placement: "aboveEditor" },
        { key: "retained-widget", lines: ["Retained widget"], placement: "aboveEditor" },
      ],
      truncated: true,
    })]);
    const view = renderStatus(host.sdk);
    await view.findByText("Second clipped status");
    expect(view.getAllByText(`${clippedKey}:`)).toHaveLength(2);
    expect(view.getAllByText(clippedKey)).toHaveLength(2);
    expect(view.getByText("First clipped widget")).toBeDefined();
    expect(view.getByText("Second clipped widget")).toBeDefined();

    host.list.mockResolvedValue([statusEvent({
      statuses: [{ key: "retained", text: "Retained status" }],
      widgets: [
        { key: "retained-widget", lines: ["Retained widget"], placement: "aboveEditor" },
      ],
    }, "thr_test", 2)]);
    await act(async () => host.threadChanged("thr_test"));
    expect(view.getByText("Retained status")).toBeDefined();
    expect(view.getByText("Retained widget")).toBeDefined();
    expect(view.queryByText("First clipped status")).toBeNull();
    expect(view.queryByText("Second clipped status")).toBeNull();
    expect(view.queryByText("First clipped widget")).toBeNull();
    expect(view.queryByText("Second clipped widget")).toBeNull();
    expect(view.container.querySelectorAll("pre")).toHaveLength(1);
  });

  it.each([
    { statuses: [{ key: "review", text: "Clipped status" }], widgets: [], truncated: true },
    { statuses: [], widgets: [], truncated: true },
  ])("shows a truncation marker even when every entry was omitted: %j", async (state) => {
    const host = stateSdk([statusEvent(state)]);
    const view = renderStatus(host.sdk);
    await view.findByText("OMP status or widget content was truncated.");
    expect(view.getByRole("status", { name: "OMP extension status" })).toBeDefined();
  });
});

describe("omp composer replacements", () => {
  it("replaces only the target thread once, preserving a later human edit across reconnect and remount", async () => {
    const host = stateSdk([]);
    const view = renderStatus(host.sdk, undefined, "Original draft");
    await act(async () => {});
    const request = stateEvent(
      { requestId: "editor-once", text: "Extension replacement" },
      "thr_test",
      2,
      OMP_EDITOR_TEXT_STATE_KIND,
    );
    host.list.mockResolvedValue([request]);
    await act(async () => host.threadChanged("thr_other"));
    expect(view.inspection.composer.text).toBe("Original draft");
    await act(async () => host.threadChanged("thr_test"));
    expect(view.inspection.composer.text).toBe("Extension replacement");
    expect(view.inspection.composer.focusCount).toBe(0);
    await view.behavior.setComposerText("Human revision");
    await act(async () => {
      host.threadChanged("thr_test");
      host.reconnected();
    });
    expect(view.inspection.composer.text).toBe("Human revision");
    view.unmount();
    const remounted = renderStatus(host.sdk, undefined, "Human revision");
    await act(async () => {});
    await act(async () => host.reconnected());
    expect(remounted.inspection.composer.text).toBe("Human revision");
  });

  it("does not replay historical text on first visit and accepts a subsequent empty replacement", async () => {
    const host = stateSdk([stateEvent(
      { requestId: "editor-historical", text: "Stale draft" },
      "thr_test",
      1,
      OMP_EDITOR_TEXT_STATE_KIND,
    )]);
    const view = renderStatus(host.sdk, undefined, "Current human draft");
    await act(async () => {});
    expect(view.inspection.composer.text).toBe("Current human draft");
    host.list.mockResolvedValue([stateEvent(
      { requestId: "editor-empty", text: "" },
      "thr_test",
      2,
      OMP_EDITOR_TEXT_STATE_KIND,
    )]);
    await act(async () => host.threadChanged("thr_test"));
    expect(view.inspection.composer.text).toBe("");
  });

  it("retires in-flight editor actions on a composer thread switch", async () => {
    const host = stateSdk([]);
    const view = renderStatus(host.sdk);
    await act(async () => {});
    const pending = Promise.withResolvers<StateEvent[]>();
    host.list.mockReturnValueOnce(pending.promise);
    await act(async () => host.threadChanged("thr_test"));
    await view.behavior.setComposerScope({ kind: "thread", threadId: "thr_next" });
    await view.behavior.setComposerText("Next thread draft");
    await act(async () => pending.resolve([stateEvent(
      { requestId: "editor-retired", text: "Wrong thread replacement" },
      "thr_test",
      2,
      OMP_EDITOR_TEXT_STATE_KIND,
    )]));
    expect(view.inspection.composer.text).toBe("Next thread draft");
  });
});

describe("omp notification timeline renderer", () => {
  it("shows the full OAuth URL as a clickable link, preserving instructions and the short copy target", () => {
    const url = "https://auth.example.com/oauth?state=full&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback";
    const launchUrl = "http://127.0.0.1:1234/";
    const view = renderNotice({
      severity: "info",
      message: "Open this link to continue signing in.",
      url,
      launchUrl,
      instructions: "Sign in, then paste the returned code.",
    });
    expect(view.getByRole("link", { name: url }).getAttribute("href")).toBe(url);
    expect(view.getByRole("link", { name: launchUrl }).getAttribute("href")).toBe(launchUrl);
    expect(view.getByText("Sign in, then paste the returned code.")).toBeDefined();
  });

  it("never turns non-HTTP URLs into executable links", () => {
    const view = renderNotice({ message: "Sign in", url: "javascript:alert(1)" });
    expect(view.getByText("javascript:alert(1)").getAttribute("href")).toBeNull();
    expect(view.queryByRole("link")).toBeNull();
  });

  it("registers the provider-owned notice kind", () => {
    expect(app.timelineRenderers).toContainEqual({
      kind: OMP_NOTICE_KIND,
      component: expect.any(Function),
    });
  });

  it.each(["info", "warning", "error"])("renders the complete plain-text %s message without ANSI", (severity) => {
    const text = `${"Full notification detail. ".repeat(40)}\n\n<strong>Literal text</strong>\nLast line`;
    const view = renderNotice({ severity, message: `\u001b[31m${text}\u001b[0m` });
    const notice = view.getByRole("note", { name: `OMP ${severity} notification` });

    expect(notice.textContent).toBe(text);
    expect(notice.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(notice.querySelector("strong")).toBeNull();
    expect(view.queryByText("Original timeline body")).toBeNull();
  });

  it("uses the informational severity default from the notice schema", () => {
    const view = renderNotice({ message: "Informational notice" });
    expect(view.getByRole("note", { name: "OMP info notification" }).textContent)
      .toBe("Informational notice");
  });

  const invalidNotices: JsonValue[] = [
    null,
    { severity: "info", message: 42 },
    { severity: "fatal", message: "Unknown severity" },
    { severity: "error" },
  ];
  it.each(invalidNotices)("preserves the host renderer for invalid notice data: %j", (payload) => {
    const view = renderNotice(payload);
    expect(view.getByText("Original timeline body")).toBeDefined();
    expect(view.queryByRole("note")).toBeNull();
  });
});

describe("omp structured card timeline renderer", () => {
  it("registers the card renderer and declares its shared item schema", () => {
    expect(app.timelineRenderers).toContainEqual({
      kind: OMP_CARD_KIND,
      component: expect.any(Function),
    });
    expect(ompProviderDeclaration(DEFAULT_OMP_MODEL_FILTER).extensionKinds?.card).toEqual({
      item: ompCardSchema,
    });
  });

  it("renders section Markdown through the SDK while keeping headings and metadata plain", () => {
    const body = "**Review finding**\n\n- First detail\n- Second detail";
    const view = renderCard({
      type: "advisor",
      title: "\u001b[31mAdvisor review\u001b[0m",
      tone: "warning",
      sections: [{
        heading: "<strong>Reviewer</strong>",
        badge: { label: "blocker", tone: "error" },
        meta: "Model: reviewer\n2 turns ago",
        body: `\u001b[31m${body}\u001b[0m`,
      }, {
        body: "A second note.",
      }],
    });
    const card = view.getByRole("note", { name: "OMP warning card: Advisor review" });
    expect(view.getByRole("heading", { name: "Advisor review", level: 3 })).toBeDefined();
    expect(view.getByRole("heading", { name: "<strong>Reviewer</strong>", level: 4 }).querySelector("strong")).toBeNull();
    expect(view.getByText("Model: reviewer\n2 turns ago", { exact: true, normalizer: (text) => text }).classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(view.getAllByTestId("bb-markdown").map((node) => node.textContent))
      .toEqual([body, "A second note."]);
    expect(card.classList.contains("border-amber-500/40")).toBe(true);
    expect(view.getByText("blocker").classList.contains("text-red-700")).toBe(true);
    expect(view.queryByText("Original timeline body")).toBeNull();
  });

  it.each([
    ["info", "text-blue-700"],
    ["warning", "text-amber-700"],
    ["error", "text-red-700"],
    ["success", "text-emerald-700"],
  ])("shows the %s tone in text and styling", (tone, colorClass) => {
    const view = renderCard({
      type: "custom",
      title: "Status",
      tone,
      sections: [{ badge: { label: "Result" } }],
    });
    expect(view.getByRole("note", { name: `OMP ${tone} card: Status` }).classList.contains(colorClass)).toBe(true);
    expect(view.getByText(tone).classList.contains(colorClass)).toBe(true);
    expect(view.getByText("Result").classList.contains(colorClass)).toBe(true);
  });

  it("defaults an omitted tone to info and supports empty sections", () => {
    const view = renderCard({ type: "custom", title: "Information", sections: [] });
    expect(view.getByRole("note", { name: "OMP info card: Information" })).toBeDefined();
    expect(view.getByText("info")).toBeDefined();
    expect(view.queryByTestId("bb-markdown")).toBeNull();
  });

  const invalidCards: JsonValue[] = [
    null,
    { type: "custom", title: 42, sections: [] },
    { type: "custom", title: "Invalid tone", tone: "fatal", sections: [] },
    { type: "custom", title: "Missing sections" },
    { type: "custom", title: "Invalid badge", sections: [{ badge: { label: "Bad", tone: "fatal" } }] },
    { type: "custom", title: "Too many sections", sections: Array.from({ length: 65 }, () => ({ body: "Detail" })) },
    { type: "custom", title: "Too large", sections: [{ body: "x".repeat(65 * 1024) }] },
  ];
  it.each(invalidCards)("preserves the host renderer for malformed card data: %j", (payload) => {
    const view = renderCard(payload);
    expect(view.getByText("Original timeline body")).toBeDefined();
    expect(view.queryByRole("note")).toBeNull();
    expect(view.queryByTestId("bb-markdown")).toBeNull();
  });
});
