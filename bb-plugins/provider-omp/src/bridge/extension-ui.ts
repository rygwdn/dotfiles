import { createHash, randomUUID } from "node:crypto";
import {
  isApprovalPendingInteractionResolution,
  pendingInteractionResolutionSchema,
  type ApprovalPendingInteractionPayload,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  OMP_EXTENSION_UI_KIND,
  OMP_EXTENSION_UI_LIMITS,
  OMP_STATUS_LIMITS,
  createBoundedExtensionUiPayload,
  ompExtensionUiRequestSchema,
  ompExtensionUiResolutionSchema,
  ompNoticeSchema,
  resolveExtensionUiResponseFields,
  stripOmpAnsi,
  type InteractionUiRequest,
  type OmpEditorText,
  type OmpExtensionUiRequest,
  type OmpExtensionUiResponseFields,
  type OmpExtensionUiState,
  type OmpNotice,
  type OmpStatusState,
  type RuntimeInteractionUiResponse,
} from "../extension-ui-contract.js";

const INTERACTIVE_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
  ask: true,
};

interface OmpToolApproval {
  tool: string;
  reason: string;
  sessionOption?: string;
}

function recognizeToolApproval(
  request: OmpExtensionUiRequest,
): OmpToolApproval | undefined {
  if (
    request.method !== "select" ||
    (request.options.length !== 2 && request.options.length !== 3) ||
    request.options[0] !== "Approve" ||
    request.options.at(-1) !== "Deny"
  ) {
    return undefined;
  }
  const tool = /^Allow tool: ([^\r\n]+)(?:\r?\n|$)/u.exec(request.title)?.[1];
  if (!tool?.trim()) return undefined;

  const sessionOption =
    request.options.length === 3 ? request.options[1] : undefined;
  if (sessionOption !== undefined) {
    const session = /^Approve ([^\r\n]+) for this session$/u.exec(sessionOption);
    if (!session || session[0] !== sessionOption || !session[1]!.trim()) {
      return undefined;
    }
  }
  return { tool, reason: request.title, sessionOption };
}

function resolveToolApprovalResponse(
  approval: OmpToolApproval,
  response: RuntimeInteractionUiResponse,
): OmpExtensionUiResponseFields {
  if (response.error !== undefined) return { cancelled: true };
  const parsed = pendingInteractionResolutionSchema.safeParse(response.result);
  if (!parsed.success || !isApprovalPendingInteractionResolution(parsed.data)) {
    return { cancelled: true };
  }
  switch (parsed.data.decision) {
    case "allow_once":
      return { value: "Approve" };
    case "allow_for_session":
      return approval.sessionOption === undefined
        ? { cancelled: true }
        : { value: approval.sessionOption };
    case "deny":
      return { value: "Deny" };
  }
}

interface PendingExtensionUiRequest {
  scope: object;
  threadId: string;
  providerThreadId: string;
  request: OmpExtensionUiRequest;
  approval?: OmpToolApproval;
  respond: (
    requestId: string | number,
    fields: OmpExtensionUiResponseFields,
  ) => void;
}

export interface ExtensionUiCoordinatorOptions {
  sendInteractionRequest: (request: InteractionUiRequest) => void;
  onStateChanged?: (
    state: OmpExtensionUiState & {
      scope: object;
      threadId: string;
      providerThreadId: string;
    },
  ) => void;
  onStatusChanged?: (
    state: OmpStatusState & {
      scope: object;
      threadId: string;
      providerThreadId: string;
    },
  ) => void;
  onNotice?: (
    notice: OmpNotice & {
      scope: object;
      threadId: string;
      providerThreadId: string;
    },
  ) => void;
  onEditorText?: (request: OmpEditorText & StatusContext) => void;
}

export interface HandleExtensionUiRequestArgs {
  scope: object;
  request: Record<string, unknown>;
  threadId: string;
  providerThreadId: string;
  respond: (
    requestId: string | number,
    fields: OmpExtensionUiResponseFields,
  ) => void;
}

export interface ExtensionUiCoordinator {
  handle(args: HandleExtensionUiRequestArgs): void;
  handleRuntimeResponse(response: RuntimeInteractionUiResponse): boolean;
  cancelPendingForScope(scope: object): void;
  resetStatus(
    args: Pick<HandleExtensionUiRequestArgs, "scope" | "threadId" | "providerThreadId">,
  ): void;
  clearStatusForScope(scope: object): void;
}

type StatusContext = Pick<
  HandleExtensionUiRequestArgs,
  "scope" | "threadId" | "providerThreadId"
>;

interface StoredStatus {
  key: string;
  text: string;
  truncated: boolean;
}

interface StoredWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
  truncated: boolean;
}

interface ThreadStatus extends StatusContext {
  active: boolean;
  statuses: Map<string, StoredStatus>;
  widgets: Map<string, StoredWidget>;
  omitted: boolean;
  lastSnapshot?: string;
}

function boundStatusText(
  value: string,
  maxLength: number,
): { text: string; truncated: boolean } {
  const plain = stripOmpAnsi(value);
  let end = Math.min(plain.length, maxLength);
  if (
    end < plain.length &&
    end > 0 &&
    plain.charCodeAt(end - 1) >= 0xd800 &&
    plain.charCodeAt(end - 1) <= 0xdbff &&
    plain.charCodeAt(end) >= 0xdc00 &&
    plain.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return { text: plain.slice(0, end), truncated: end < plain.length };
}

function statusKeyIdentity(key: string): string {
  if (key.length <= OMP_STATUS_LIMITS.keyLength) {
    return `raw:${key}`;
  }
  // Hash UTF-16 code units so even distinct lone-surrogate keys stay distinct.
  return `sha256:${createHash("sha256").update(key, "utf16le").digest("hex")}`;
}

function createStatusSnapshot(
  status: ThreadStatus,
): { state: OmpStatusState; serialized: string } {
  const state: OmpStatusState = { statuses: [], widgets: [] };
  let truncated = status.omitted;
  for (const entry of status.statuses.values()) {
    state.statuses.push({ key: entry.key, text: entry.text });
    truncated ||= entry.truncated;
  }
  for (const entry of status.widgets.values()) {
    state.widgets.push({
      key: entry.key,
      lines: [...entry.lines],
      placement: entry.placement,
    });
    truncated ||= entry.truncated;
  }
  if (truncated) state.truncated = true;
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") <= OMP_STATUS_LIMITS.stateBytes) {
    return { state, serialized };
  }

  state.truncated = true;
  let bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  // Keep earlier keys, preferring compact statuses when whole widgets do not fit.
  // Retained map entries can become visible again when another key is cleared.
  while (bytes > OMP_STATUS_LIMITS.stateBytes) {
    const entries = state.widgets.length > 0 ? state.widgets : state.statuses;
    const removed = entries.pop();
    if (!removed) break;
    bytes -=
      Buffer.byteLength(JSON.stringify(removed), "utf8") +
      (entries.length > 0 ? 1 : 0);
  }
  return { state, serialized: JSON.stringify(state) };
}

export function createExtensionUiCoordinator(
  options: ExtensionUiCoordinatorOptions,
): ExtensionUiCoordinator {
  const pending = new Map<string, PendingExtensionUiRequest>();
  const statusByThread = new Map<string, ThreadStatus>();
  const coordinatorId = randomUUID();
  let nextRequestId = 0;

  const publishState = (
    entry: Pick<PendingExtensionUiRequest, "scope" | "threadId" | "providerThreadId">,
  ) => {
    if (!options.onStateChanged) return;
    const pendingRequestIds: string[] = [];
    for (const [interactionId, request] of pending) {
      if (request.threadId === entry.threadId) {
        pendingRequestIds.push(interactionId);
      }
    }
    options.onStateChanged({
      scope: entry.scope,
      threadId: entry.threadId,
      providerThreadId: entry.providerThreadId,
      coordinatorId,
      issuedThrough: nextRequestId,
      pendingRequestIds,
    });
  };

  const statusForRequest = (entry: StatusContext): ThreadStatus | undefined => {
    const current = statusByThread.get(entry.threadId);
    if (current) {
      return current.active &&
        current.scope === entry.scope &&
        current.providerThreadId === entry.providerThreadId
        ? current
        : undefined;
    }
    const status: ThreadStatus = {
      scope: entry.scope,
      threadId: entry.threadId,
      providerThreadId: entry.providerThreadId,
      active: true,
      statuses: new Map(),
      widgets: new Map(),
      omitted: false,
    };
    statusByThread.set(entry.threadId, status);
    return status;
  };

  const publishStatus = (status: ThreadStatus) => {
    if (!options.onStatusChanged) return;
    const snapshot = createStatusSnapshot(status);
    if (snapshot.serialized === status.lastSnapshot) return;
    status.lastSnapshot = snapshot.serialized;
    options.onStatusChanged({
      ...snapshot.state,
      scope: status.scope,
      threadId: status.threadId,
      providerThreadId: status.providerThreadId,
    });
  };

  return {
    handle(args) {
      const method = args.request.method;
      if (method === "setStatus") {
        const key = args.request.statusKey;
        const text = args.request.statusText;
        if (
          typeof key !== "string" ||
          (text !== undefined && typeof text !== "string")
        ) {
          return;
        }
        const status = statusForRequest(args);
        if (!status) return;
        const identity = statusKeyIdentity(key);
        if (text === undefined) {
          status.statuses.delete(identity);
        } else if (
          !status.statuses.has(identity) &&
          status.statuses.size >= OMP_STATUS_LIMITS.statusKeys
        ) {
          // Without retaining unbounded omitted identities, this remains marked
          // until the child scope is explicitly reset or cleared.
          status.omitted = true;
        } else {
          const boundedKey = boundStatusText(key, OMP_STATUS_LIMITS.keyLength);
          const boundedText = boundStatusText(text, OMP_STATUS_LIMITS.statusLength);
          status.statuses.set(identity, {
            key: boundedKey.text,
            text: boundedText.text,
            truncated: boundedKey.truncated || boundedText.truncated,
          });
        }
        publishStatus(status);
        return;
      }
      if (method === "setWidget") {
        const key = args.request.widgetKey;
        const lines = args.request.widgetLines;
        const placement = args.request.widgetPlacement;
        if (
          typeof key !== "string" ||
          (lines !== undefined && !Array.isArray(lines)) ||
          (placement !== undefined &&
            placement !== "aboveEditor" &&
            placement !== "belowEditor")
        ) {
          return;
        }
        const boundedLines: string[] = [];
        let truncated = false;
        if (lines !== undefined) {
          for (const line of lines) {
            if (typeof line !== "string") return;
            if (boundedLines.length >= OMP_STATUS_LIMITS.widgetLines) {
              truncated = true;
              continue;
            }
            const bounded = boundStatusText(line, OMP_STATUS_LIMITS.lineLength);
            boundedLines.push(bounded.text);
            truncated ||= bounded.truncated;
          }
        }
        const status = statusForRequest(args);
        if (!status) return;
        const identity = statusKeyIdentity(key);
        if (lines === undefined) {
          status.widgets.delete(identity);
        } else if (
          !status.widgets.has(identity) &&
          status.widgets.size >= OMP_STATUS_LIMITS.widgetKeys
        ) {
          status.omitted = true;
        } else {
          const boundedKey = boundStatusText(key, OMP_STATUS_LIMITS.keyLength);
          status.widgets.set(identity, {
            key: boundedKey.text,
            lines: boundedLines,
            placement: placement ?? "aboveEditor",
            truncated: truncated || boundedKey.truncated,
          });
        }
        publishStatus(status);
        return;
      }
      if (method === "notify") {
        const parsed = ompNoticeSchema.safeParse({
          severity: args.request.notifyType,
          message: args.request.message,
        });
        if (!parsed.success || !statusForRequest(args)) return;
        options.onNotice?.({
          severity: parsed.data.severity,
          message: stripOmpAnsi(parsed.data.message),
          scope: args.scope,
          threadId: args.threadId,
          providerThreadId: args.providerThreadId,
        });
        return;
      }
      if (method === "set_editor_text") {
        if (typeof args.request.text !== "string" || !statusForRequest(args)) return;
        options.onEditorText?.({
          scope: args.scope,
          threadId: args.threadId,
          providerThreadId: args.providerThreadId,
          requestId: randomUUID(),
          text: args.request.text,
        });
        return;
      }
      if (method === "open_url") {
        const parsed = ompNoticeSchema.safeParse({
          message: "Open this link to continue signing in.",
          url: args.request.url,
          launchUrl: args.request.launchUrl,
          instructions: args.request.instructions,
        });
        if (!parsed.success || !parsed.data.url || !statusForRequest(args)) return;
        options.onNotice?.({
          ...parsed.data,
          scope: args.scope,
          threadId: args.threadId,
          providerThreadId: args.providerThreadId,
        });
        return;
      }
      if (method === "cancel") {
        const targetId = args.request.targetId;
        if (typeof targetId !== "string") return;
        let changed = false;
        for (const [interactionId, entry] of pending) {
          if (entry.scope === args.scope && entry.request.id === targetId) {
            pending.delete(interactionId);
            changed = true;
          }
        }
        if (changed) publishState(args);
        return;
      }
      if (typeof method !== "string" || !Object.hasOwn(INTERACTIVE_METHODS, method)) {
        return;
      }
      const parsed = ompExtensionUiRequestSchema.safeParse(args.request);
      if (!parsed.success) {
        const id = args.request.id;
        if (typeof id === "string") {
          args.respond(id, { cancelled: true });
        }
        return;
      }
      const request: OmpExtensionUiRequest = parsed.data;
      nextRequestId += 1;
      const interactionId = `omp-ui-${nextRequestId}`;
      const approval = recognizeToolApproval(request);
      pending.set(interactionId, {
        scope: args.scope,
        threadId: args.threadId,
        providerThreadId: args.providerThreadId,
        request,
        approval,
        respond: args.respond,
      });
      try {
        let payload: InteractionUiRequest["params"]["payload"];
        if (approval) {
          payload = {
            kind: "approval",
            subject: {
              kind: "tool_use",
              // RPC supplies no tool-call linkage, including for same-name calls.
              itemId: `omp-approval:${coordinatorId}:${nextRequestId}:${request.id}`,
              tool: approval.tool,
              presentation: {
                icon: { glyph: "wrench" },
                label: { pending: approval.tool, completed: approval.tool },
                title: `Allow tool: ${approval.tool}`,
              },
            },
            reason: approval.reason,
            availableDecisions: approval.sessionOption === undefined
              ? ["allow_once", "deny"]
              : ["allow_once", "allow_for_session", "deny"],
          } satisfies ApprovalPendingInteractionPayload;
        } else {
          const fullTitle =
            request.method === "ask"
              ? request.questions.length === 1
                ? request.questions[0]!.header?.trim() || "Question"
                : "Questions"
              : request.title;
          const title = fullTitle.trim();
          const titleTooLong = title.length > OMP_EXTENSION_UI_LIMITS.titleLength;
          const envelopeTitle = titleTooLong
            ? `${boundStatusText(title, OMP_EXTENSION_UI_LIMITS.titleLength - 1).text}…`
            : title;
          const data = createBoundedExtensionUiPayload({
            ...request,
            requestId: interactionId,
            lifecycle: { coordinatorId, sequence: nextRequestId },
            ...(titleTooLong && request.method !== "ask" ? { detail: fullTitle } : {}),
            ...("timeout" in request && request.timeout !== undefined
              ? { expiresAt: Date.now() + Math.max(0, request.timeout) }
              : {}),
          });
          payload = { kind: OMP_EXTENSION_UI_KIND, title: envelopeTitle, data };
        }
        options.sendInteractionRequest({
          jsonrpc: "2.0",
          id: interactionId,
          method: "interaction/request",
          params: {
            providerThreadId: args.providerThreadId,
            threadId: args.threadId,
            turnId: null,
            payload,
          },
        });
      } catch (cause) {
        options.onNotice?.({
          scope: args.scope,
          threadId: args.threadId,
          providerThreadId: args.providerThreadId,
          severity: "error",
          message: `OMP dialog could not be displayed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        pending.delete(interactionId);
        args.respond(request.id, { cancelled: true });
      } finally {
        publishState(args);
      }
    },

    handleRuntimeResponse(response) {
      const entry = pending.get(String(response.id));
      if (!entry) {
        return false;
      }
      pending.delete(String(response.id));
      publishState(entry);
      if (entry.approval) {
        entry.respond(entry.request.id, resolveToolApprovalResponse(entry.approval, response));
        return true;
      }
      const parsed = ompExtensionUiResolutionSchema.safeParse(response.result);
      entry.respond(
        entry.request.id,
        parsed.success
          ? resolveExtensionUiResponseFields(entry.request, parsed.data)
          : { cancelled: true },
      );
      return true;
    },

    cancelPendingForScope(scope) {
      const changedThreads = new Map<string, PendingExtensionUiRequest>();
      for (const [interactionId, entry] of pending) {
        if (entry.scope !== scope) {
          continue;
        }
        pending.delete(interactionId);
        changedThreads.set(entry.threadId, entry);
        entry.respond(entry.request.id, { cancelled: true });
      }
      for (const entry of changedThreads.values()) publishState(entry);
    },

    resetStatus(args) {
      const current = statusByThread.get(args.threadId);
      if (current) {
        current.scope = args.scope;
        current.providerThreadId = args.providerThreadId;
        current.active = true;
        current.statuses.clear();
        current.widgets.clear();
        current.omitted = false;
        publishStatus(current);
        return;
      }
      const status = statusForRequest(args);
      if (status) publishStatus(status);
    },

    clearStatusForScope(scope) {
      for (const status of statusByThread.values()) {
        if (!status.active || status.scope !== scope) continue;
        status.active = false;
        status.statuses.clear();
        status.widgets.clear();
        status.omitted = false;
        publishStatus(status);
      }
    },
  };
}
