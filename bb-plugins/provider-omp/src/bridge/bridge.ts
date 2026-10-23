#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  LOCAL_WORKFLOW_TASK_TYPE,
  THREAD_DELTA_NOTIFICATION_METHOD,
  buildShellEnvOverrides,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  isStandaloneBuiltinCompactCommand,
  modelListParamsSchema as sdkModelListParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeToolCallRequest,
  type DeltaBackgroundTaskShape,
  type InitializeResult,
  type ThreadDelta,
  type ThreadEventContextWindowUsage,
} from "@get-bb/plugin-sdk/provider-bridge";
import { createOmpDeltaTranslator } from "../delta-translation.js";
import { parseOmpModelFilter } from "../model-curation.js";
import {
  OMP_MODEL_PRESET_NAME_PATTERN,
  parseOmpModelPresetId,
  resolveOmpModelPresets,
  resolveOmpPresetDefaultCandidates,
  type OmpModelPreset,
} from "../native-roots.js";
import {
  buildOmpSessionParams,
  buildOmpTurnOptions,
  type OmpSessionParams,
} from "../session-params.js";
import { buildOmpLiveSessionOptions, type OmpSessionControls } from "../session-options.js";
import { ompSessionNeedsRelocation } from "./session-cwd.js";
import {
  createExtensionUiCoordinator,
  type ExtensionUiCoordinator,
} from "./extension-ui.js";
import {
  OMP_STATUS_STATE_KIND,
  OMP_EDITOR_TEXT_STATE_KIND,
  stripOmpAnsi,
  type InteractionUiRequest,
} from "../extension-ui-contract.js";
import { createOmpNoticeDeltas } from "./extension-notices.js";
import { OMP_TERMINAL_SIGN_IN_HINT } from "../declaration.js";
import {
  getOmpInstallGate,
  getOmpProviderInstallationRun,
  getOmpProviderInstallationStatus,
  getOmpProviderUsage,
  ompHealthResult,
  resetOmpInstallGateForTests,
} from "./provider-maintenance.js";
import {
  closeAllOmpCatalogs,
  createLiveContextWindowResolver,
  getOmpCatalog,
} from "./catalog.js";
import {
  OmpRpcSession,
  ompAvailableCommandsSchema,
  ompBtwRecordSchema,
  ompGoalUpdatedSchema,
  type OmpGoal,
  type OmpAvailableCommand,
  type OmpBtwRecord,
  type OmpRpcSessionOptions,
  type ToolCallForwarder,
} from "./rpc-session.js";
import { buildOmpChildEnv, OmpRpcChildExitedError, OmpRpcResponseError } from "./rpc-child.js";
import {
  findNewestOmpSessionFile,
  resolveOmpThreadSessionDir,
} from "./session-paths.js";
import { extractOmpPromptInput, type ImageContent } from "./turn-input.js";
import { createOmpTodoCoordinator, type OmpTodoCoordinator } from "./todos.js";
import {
  createOmpSubagentCoordinator,
  type OmpSubagentCoordinator,
} from "./subagents.js";

const modelListParamsSchema = sdkModelListParamsSchema.extend({
  envVars: z.record(z.string(), z.string()).optional(),
});

const ompCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: threadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: threadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: threadForkParamsSchema,
  }),
  z.object({
    method: z.literal("thread/name/set"),
    params: threadNameSetParamsSchema,
  }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({
    method: z.literal("thread/stop"),
    params: threadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: threadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type OmpCommand = z.infer<typeof ompCommandSchema>;

const ompCommandMethodValues = ompCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedOmpBridgeRequest =
  | { kind: "request"; request: OmpCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodeOmpJsonRpcRequest(raw: unknown): DecodedOmpBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = ompCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id },
    };
  }
  if (
    !(ompCommandMethodValues as readonly string[]).includes(envelope.data.method)
  ) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface CurrentThreadSessionArgs {
  sessionSerial: number;
  threadId: string;
}

interface LocalCommandTurn {
  pending: Set<LocalPromptPresentation>;
  error?: unknown;
}

interface LocalPromptPresentation {
  localTurn?: LocalCommandTurn;
  acceptedIntoTurn: boolean;
}

interface NativeControlTurn {
  providerTurnId: string;
  parentRef: string;
  label: string;
  closed: boolean;
  pendingItem?: {
    providerItemId: string;
    item: Extract<ThreadDelta, { kind: "item.open" }>["item"];
  };
}

interface BtwCommandStart {
  question: string;
  recordId?: string;
  control: NativeControlTurn;
  recordKey?: string;
}

interface BtwPresentation {
  record: OmpBtwRecord;
  providerItemId: string;
  control: NativeControlTurn;
  answer: string;
  terminal: boolean;
}

interface ThreadSession {
  session: OmpRpcSession;
  todos: OmpTodoCoordinator;
  subagents: OmpSubagentCoordinator;
  sessionSerial: number;
  closing: boolean;
  providerThreadId: string;
  cwd: string;
  construction: OmpSessionParams;
  constructionModel: { provider: string; id: string } | undefined;
  pickerOptions: {
    model: string | undefined;
    thinkingLevel: string | undefined;
    fastModeEnabled: boolean | undefined;
  };
  pickerModel: { provider: string; id: string } | undefined;
  chosenSessionControls: OmpSessionControls;
  reportedSessionControls?: OmpSessionControls & {
    slowModeSupported: boolean;
    slowModeScope?: "session" | "global";
  };
  pendingToolCallScopes: Set<object>;
  pendingPromptPresentations: Set<LocalPromptPresentation>;
  localCommandTurn?: LocalCommandTurn;
  btwStarts?: Set<BtwCommandStart>;
  btwPresentations?: Map<string, BtwPresentation>;
  btwRunning?: BtwPresentation;
  nativeControlTurns?: Set<NativeControlTurn>;
}

type ThreadPickerSelection = Pick<ThreadSession, "pickerOptions" | "chosenSessionControls"> &
  Partial<Pick<ThreadSession, "pickerModel">>;

let sessionSerialCounter = 0;
const THREAD_STOP_CLOSE_TIMEOUT_MS = 8_000;

const { send, sendResult, sendError } = createBridgeIo<
  BridgeEventNotification | BridgeToolCallRequest | InteractionUiRequest
>();

function sendOmpError(id: string | number, error: unknown): void {
  sendError(
    id,
    BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    error instanceof Error ? error.message : String(error),
    error instanceof OmpRpcResponseError
      ? { providerCode: error.code ?? null, command: error.command } : undefined,
  );
}

const sessions = new Map<string, ThreadSession>();
const closingSessions = new Map<string, Promise<string | undefined>>();
const activeTurnThreads = new Set<string>();
const { forwardToolCall, handleToolCallResponse, resolvePendingToolCalls } =
  createPendingToolCallTracker({ sendToolCall: send });

const extensionUi: ExtensionUiCoordinator = createExtensionUiCoordinator({
  sendInteractionRequest: send,
  onStatusChanged: ({ threadId, statuses, widgets, truncated }) => {
    sendThreadDeltas(threadId, [{
      kind: "extension.state",
      extensionKind: OMP_STATUS_STATE_KIND,
      payload: {
        statuses,
        widgets,
        ...(truncated ? { truncated: true } : {}),
      },
    }]);
  },
  onEditorText: ({ threadId, requestId, text }) => {
    sendThreadDeltas(threadId, [{
      kind: "extension.state",
      extensionKind: OMP_EDITOR_TEXT_STATE_KIND,
      payload: { requestId, text },
    }]);
  },
  onNotice: ({ threadId, severity, message, url, launchUrl, instructions }) => {
    sendThreadDeltas(threadId, createOmpNoticeDeltas(
      {
        severity,
        message,
        ...(url !== undefined ? { url } : {}),
        ...(launchUrl !== undefined ? { launchUrl } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
      },
      {
        activeTurn: activeTurnThreads.has(threadId),
        id: `omp-notice-${randomUUID()}`,
      },
    ));
  },
  onStateChanged: ({
    threadId,
    coordinatorId,
    issuedThrough,
    pendingRequestIds,
  }) => {
    emitForSession(threadId, "sdk/message", {
      threadId,
      message: {
        type: "bb_extension_ui_state",
        coordinatorId,
        issuedThrough,
        pendingRequestIds,
      },
    });
  },
});

let configuredSkillPaths: string[] | null = null;

let scratchDir: string | null = null;
let scratchDirIsPrivate = false;

function requireScratchDir(): string {
  if (scratchDir === null) {
    scratchDir = join(
      tmpdir(),
      `bb-omp-bridge-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    scratchDirIsPrivate = true;
    mkdirSync(scratchDir, { recursive: true });
  }
  return scratchDir;
}


const contextWindows = createLiveContextWindowResolver();
const ompDeltaTranslator = createOmpDeltaTranslator({
  resolveModelContextWindow: contextWindows.resolve,
});

function createForwardToolCall(getThreadId: () => string): ToolCallForwarder {
  return async (toolName, args, control) => {
    const threadId = getThreadId();
    const threadSession = sessions.get(threadId);
    if (!threadSession || threadSession.closing) {
      return { content: "Thread session not found", isError: true };
    }
    if (control?.signal.aborted) {
      return { content: "OMP cancelled tool call", isError: true };
    }
    const scope = {};
    const cancel = () =>
      resolvePendingToolCalls(scope, "OMP cancelled tool call");
    threadSession.pendingToolCallScopes.add(scope);
    control?.signal.addEventListener("abort", cancel, { once: true });
    try {
      return await forwardToolCall({
        arguments: args,
        providerThreadId: threadSession.providerThreadId,
        scope,
        threadId,
        toolName,
      });
    } finally {
      control?.signal.removeEventListener("abort", cancel);
      threadSession.pendingToolCallScopes.delete(scope);
    }
  };
}

function resolveThreadToolCalls(
  threadSession: ThreadSession,
  message: string,
): void {
  for (const scope of threadSession.pendingToolCallScopes) {
    resolvePendingToolCalls(scope, message);
  }
}

async function closeThreadSession(args: {
  message: string;
  threadId: string;
}): Promise<string | undefined> {
  const existingClose = closingSessions.get(args.threadId);
  if (existingClose) {
    return existingClose;
  }
  const threadSession = sessions.get(args.threadId);
  if (!threadSession) {
    return;
  }
  threadSession.subagents.stop(args.message);
  interruptNativeControlTurns(args.threadId, threadSession, args.message);
  threadSession.closing = true;
  resolveThreadToolCalls(threadSession, args.message);
  extensionUi.cancelPendingForScope(threadSession);
  extensionUi.clearStatusForScope(threadSession);
  activeTurnThreads.delete(args.threadId);
  const closePromise = Promise.resolve()
    .then(() =>
      threadSession.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS),
    )
    .finally(() => {
      if (sessions.get(args.threadId) === threadSession) {
        sessions.delete(args.threadId);
      }
      closingSessions.delete(args.threadId);
    });
  closingSessions.set(args.threadId, closePromise);
  return closePromise;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(sessions.keys()).map((threadId) =>
      closeThreadSession({ message, threadId }),
    ),
  );
}

function sendThreadDeltas(
  threadId: string,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  for (const delta of deltas) {
    if (delta.kind === "turn.open" && !delta.parentRef && !delta.providerTurnId) activeTurnThreads.add(threadId);
    else if (
      (delta.kind === "turn.boundary" && !delta.providerTurnId) ||
      delta.kind === "session.reset" ||
      (delta.kind === "provider.error" && delta.settlesTurn)
    ) activeTurnThreads.delete(threadId);
  }
  send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [...deltas] },
  });
}

function emitForSession(
  threadId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const threadSession = sessions.get(threadId);
  sendThreadDeltas(
    threadId,
    ompDeltaTranslator.translate(
      { jsonrpc: "2.0", method, params },
      {
        threadId,
        cwd: threadSession?.cwd,
        fileRoots: threadSession?.session.getFileRoots(),
        activeTurn: activeTurnThreads.has(threadId),
      },
    ),
  );
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId, sessionRestorable: true },
  });
}

function sendSessionScopedError(
  threadId: string,
  providerThreadId: string,
  message: string,
): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.error,
    params: { threadId, providerThreadId, message },
  });
}

function emitSessionError(
  threadSession: ThreadSession,
  threadId: string,
  message: string,
): void {
  emitForSession(threadId, "error", { threadId, message });
  sendSessionScopedError(threadId, threadSession.providerThreadId, message);
}

function toContextWindowUsagePayload(
  contextUsage: { tokens: number | null; contextWindow: number; cost: number } | null,
): ThreadEventContextWindowUsage | null {
  if (!contextUsage) {
    return null;
  }
  return {
    usedTokens: contextUsage.tokens,
    modelContextWindow:
      contextUsage.contextWindow > 0 ? contextUsage.contextWindow : null,
    estimated: true,
    cost: { amount: contextUsage.cost, currency: "USD" },
  };
}

function emitContextWindowUsage(threadId: string): void {
  const threadSession = sessions.get(threadId);
  if (!threadSession) {
    return;
  }
  const contextWindowUsage = toContextWindowUsagePayload(
    threadSession.session.getContextUsage(),
  );
  if (!contextWindowUsage) {
    return;
  }
  emitForSession(threadId, "thread/contextWindowUsage/updated", {
    threadId,
    contextWindowUsage,
  });
}

function nextSessionSerial(): number {
  sessionSerialCounter += 1;
  return sessionSerialCounter;
}

function getCurrentThreadSession(
  args: CurrentThreadSessionArgs,
): ThreadSession | undefined {
  const threadSession = sessions.get(args.threadId);
  if (
    !threadSession ||
    threadSession.closing ||
    threadSession.sessionSerial !== args.sessionSerial
  ) {
    return undefined;
  }
  return threadSession;
}

function publishNativeGoal(threadId: string, threadSession: ThreadSession, goal: OmpGoal | null): void {
  extensionUi.handle({
    scope: threadSession,
    threadId,
    providerThreadId: threadSession.providerThreadId,
    request: {
      method: "setWidget",
      widgetKey: "bb:omp:goal",
      ...(goal && goal.status !== "dropped" ? {
        widgetLines: [
          `Goal: ${goal.status}`,
          goal.objective,
          `Tokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? "unlimited"}`,
        ],
      } : {}),
    },
    respond: (id, fields) => threadSession.session.respondToExtensionUi(id, fields),
  });
}

function publishNativeConfiguration(threadId: string, threadSession: ThreadSession): void {
  const state = threadSession.session.getLiveState();
  if (!state) return;
  const lines: string[] = [];
  const pickers = threadSession.pickerOptions;
  const selectedModel = threadSession.pickerModel;
  const selectedPreset = pickers.model ? parseOmpModelPresetId(pickers.model) : undefined;
  if (threadSession.construction.modelPreset) {
    lines.push(`Model preset: ${threadSession.construction.modelPreset.name}`);
  }
  if (pickers.model && selectedModel && (
    state.model?.provider !== selectedModel.provider || state.model?.id !== selectedModel.id
  )) {
    const selected = selectedPreset
      ? `preset ${selectedPreset}`
      : `${selectedModel.provider}/${selectedModel.id}`;
    lines.push(`Model: omp ${state.model?.provider ?? "unknown"}/${state.model?.id ?? "unknown"} (bb selected ${selected})`);
  }
  const selection = threadSession.session.getThinkingSelection();
  if (pickers.thinkingLevel && pickers.thinkingLevel !== "native" &&
      pickers.thinkingLevel !== state.thinkingLevel) {
    lines.push([
      `Thinking: omp ${state.thinkingLevel ?? "native"} (bb selected ${pickers.thinkingLevel})`,
      ...(selection.configured ? [`configured: ${selection.configured}`] : []),
      ...(selection.resolved ? [`resolved: ${selection.resolved}`] : []),
    ].join("; "));
  }
  if (pickers.fastModeEnabled !== undefined &&
      pickers.fastModeEnabled !== (state.fastModeEnabled ?? false)) {
    lines.push(`Fast: omp ${state.fastModeEnabled ? "enabled" : "disabled"} (bb selected ${pickers.fastModeEnabled ? "enabled" : "disabled"}); active: ${state.fastModeActive ? "yes" : "no"}`);
  }
  const controls = threadSession.session.getSessionControls();
  const reportedControls = {
    ...controls,
    slowModeSupported: state.slowModeSupported,
    slowModeScope: state.slowModeScope,
  };
  if (!isDeepStrictEqual(threadSession.reportedSessionControls, reportedControls)) {
    sendThreadDeltas(threadId, [{
      kind: "extension.state",
      extensionKind: "bb/session-options",
      payload: { options: buildOmpLiveSessionOptions(controls, state) },
    }]);
    threadSession.reportedSessionControls = reportedControls;
  }
  const baseline = threadSession.session.getInitialSessionControls();
  const labels: Record<keyof OmpSessionControls, string> = {
    steeringMode: "Steering",
    followUpMode: "Follow-up",
    interruptMode: "Interrupt",
    autoCompactionEnabled: "Auto-compaction",
    autoRetryEnabled: "Auto-retry",
    cacheWarmingMode: "Cache warming",
    slowModeEnabled: "Slow mode",
  };
  for (const key of Object.keys(labels) as (keyof OmpSessionControls)[]) {
    const value = controls[key];
    const chosen = threadSession.chosenSessionControls[key];
    const expected = chosen ?? baseline[key];
    // OMP does not report every default; do not invent a baseline for those.
    if (value === undefined || expected === undefined || value === expected) continue;
    const liveText = typeof value === "boolean" ? (value ? "on" : "off") : value;
    const expectedText = typeof expected === "boolean" ? (expected ? "on" : "off") : expected;
    lines.push(`${labels[key]}: omp ${liveText} (${chosen === undefined ? "omp default" : "bb selected"} ${expectedText})`);
  }
  extensionUi.handle({
    scope: threadSession,
    threadId,
    providerThreadId: threadSession.providerThreadId,
    request: {
      method: "setWidget",
      widgetKey: "bb:omp:configuration",
      ...(lines.length > 0 ? { widgetLines: lines } : {}),
    },
    respond: (id, fields) => threadSession.session.respondToExtensionUi(id, fields),
  });
}

function publishLocalCommandResult(args: CurrentThreadSessionArgs & {
  tool: string;
  commandArgs?: Record<string, unknown>;
  resultText: string;
  status?: "completed" | "failed" | "interrupted";
  providerItemId?: string;
  providerTurnId?: string;
  parentRef?: string;
  deferBoundary?: boolean;
  filePath?: string;
}): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) return;
  const ownsTurn = args.providerTurnId === undefined && !activeTurnThreads.has(args.threadId);
  let deferBoundary = false;
  if (ownsTurn && args.deferBoundary) {
    let localTurn: LocalCommandTurn | undefined;
    for (const presentation of threadSession.pendingPromptPresentations) {
      if (presentation.localTurn) continue;
      localTurn ??= { pending: new Set<LocalPromptPresentation>() };
      presentation.localTurn = localTurn;
      localTurn.pending.add(presentation);
    }
    if (localTurn) {
      threadSession.localCommandTurn = localTurn;
      deferBoundary = true;
    }
  }
  sendThreadDeltas(args.threadId, [
    ...(ownsTurn ? [{ kind: "turn.open" } as const] : []),
    {
      kind: "item.close",
      key: {
        providerItemId: args.providerItemId ?? `omp-command:${randomUUID()}`,
        ...(args.parentRef === undefined ? {} : { parentRef: args.parentRef }),
      },
      ...(args.providerTurnId === undefined ? {} : { providerTurnId: args.providerTurnId }),
      item: { type: "tool", tool: args.tool, args: args.commandArgs ?? {} },
      status: args.status ?? "completed",
      resultText: stripOmpAnsi(args.resultText),
    },
    ...(args.filePath ? [{
      kind: "item.close" as const,
      key: { providerItemId: `omp-export-link:${randomUUID()}` },
      item: {
        type: "agentMessage" as const,
        text: `[Open HTML export](<${pathToFileURL(args.filePath).href}>)`,
      },
      status: "completed" as const,
    }] : []),
    ...(ownsTurn && !deferBoundary
      ? [{ kind: "turn.boundary", status: "completed" } as const]
      : []),
  ]);
}

function nativeControlBackground(
  control: NativeControlTurn,
  status: "pending" | "completed" | "failed" | "interrupted",
  summary?: string,
): DeltaBackgroundTaskShape {
  return {
    type: "backgroundTask", familyId: control.parentRef, taskType: LOCAL_WORKFLOW_TASK_TYPE,
    description: control.label, workflowName: control.label, status,
    taskStatus: status === "pending" ? "running" : status === "interrupted" ? "stopped" : status,
    skipTranscript: false,
    ...(summary === undefined ? {} : { summary }),
  };
}

function finishNativeControlTurn(
  threadId: string,
  threadSession: ThreadSession,
  control: NativeControlTurn,
  status: "completed" | "failed" | "interrupted",
  summary: string,
): void {
  if (control.closed) return;
  control.closed = true;
  threadSession.nativeControlTurns?.delete(control);
  sendThreadDeltas(threadId, [
    {
      kind: "item.close",
      key: { providerItemId: control.parentRef },
      item: { type: "delegation", childRef: control.parentRef, label: control.label, background: true, summary },
      status,
    },
    {
      kind: "item.close",
      key: { providerItemId: `${control.parentRef}:status` },
      item: nativeControlBackground(control, status, summary),
      status,
    },
    { kind: "turn.boundary", providerTurnId: control.providerTurnId, status },
  ]);
}

function interruptNativeControlTurns(threadId: string, threadSession: ThreadSession, message: string): void {
  for (const control of threadSession.nativeControlTurns ?? []) {
    if (control.pendingItem) {
      sendThreadDeltas(threadId, [{
        kind: "item.close", providerTurnId: control.providerTurnId,
        key: { providerItemId: control.pendingItem.providerItemId, parentRef: control.parentRef },
        item: control.pendingItem.item.type === "command"
          ? { ...control.pendingItem.item, aggregatedOutput: message } : control.pendingItem.item,
        status: "interrupted", resultText: message,
      }]);
    }
    finishNativeControlTurn(threadId, threadSession, control, "interrupted", message);
  }
}

function publishBtwRecord(
  threadId: string,
  threadSession: ThreadSession,
  record: OmpBtwRecord,
): void {
  const latest = record.followUps?.at(-1) ?? record;
  const key = JSON.stringify([record.id, record.followUps?.length ?? 0]);
  const presentations = threadSession.btwPresentations ??= new Map<string, BtwPresentation>();
  let presentation = presentations.get(key);
  if (presentation?.terminal) return;
  if (!presentation) {
    const start = [...threadSession.btwStarts ?? []].find((pending) =>
      pending.recordKey === key || (pending.recordKey === undefined &&
        pending.question === latest.question && (pending.recordId === undefined || pending.recordId === record.id)),
    );
    if (start) start.recordKey = key;
    presentation = {
      record,
      providerItemId: `omp-btw:${key}`,
      control: start?.control ?? beginScopedLocalCommand({ threadId, threadSession }, "omp-btw", `Side question: ${latest.question}`),
      answer: latest.answer,
      terminal: false,
    };
    presentations.set(key, presentation);
    if (presentation.control.closed) return;
    const item = { type: "tool" as const, tool: "btw", args: { recordId: record.id, question: latest.question } };
    presentation.control.pendingItem = { providerItemId: presentation.providerItemId, item };
  }
  presentation.record = record;
  if (latest.status === "running") {
    threadSession.btwRunning = presentation;
    return;
  }
  presentation.terminal = true;
  presentation.answer = latest.answer;
  if (threadSession.btwRunning === presentation) threadSession.btwRunning = undefined;
  const status = latest.status === "error" ? "failed"
    : latest.status === "complete" ? "completed" : "interrupted";
  const resultText = stripOmpAnsi([
    `Topic: ${record.id}`,
    `Question: ${latest.question}`,
    latest.answer,
    latest.error,
    ...(latest.status === "cancelled" || latest.status === "interrupted"
      ? [`Side question ${latest.status}.`] : []),
  ].filter(Boolean).join("\n\n"));
  sendThreadDeltas(threadId, [{
    kind: "item.close",
    providerTurnId: presentation.control.providerTurnId,
    key: { providerItemId: presentation.providerItemId, parentRef: presentation.control.parentRef },
    item: { type: "tool", tool: "btw", args: { recordId: record.id, question: latest.question } },
    status,
    resultText,
    presentation: {
      icon: { glyph: "MessageCircle" },
      label: { pending: "Answering side question", completed: "Side question" },
      title: latest.question,
      detail: `Topic: ${record.id}`,
    },
  }]);
  finishNativeControlTurn(threadId, threadSession, presentation.control, status, resultText);
}

function createOnOmpEvent(
  args: CurrentThreadSessionArgs,
): (event: Record<string, unknown>) => Promise<void> {
  return async (event) => {
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) return;
    if (event.type === "available_commands_update") {
      publishProviderCommands(args.threadId, ompAvailableCommandsSchema.parse(event.commands));
      return;
    }
    if (event.type === "session_info_update") {
      if (typeof event.title === "string") {
        sendThreadDeltas(args.threadId, [{
          kind: "thread.name",
          name: event.title,
          source: "agent",
        }]);
      }
      return;
    }
    if (event.type === "command_output") {
      if (typeof event.text === "string") {
        publishLocalCommandResult({
          ...args,
          tool: "omp-command",
          resultText: event.text,
          deferBoundary: event.deferLocalBoundary === true,
        });
      }
      return;
    }
    if (event.type === "btw_delta") {
      const parsed = z.object({ recordId: z.string(), delta: z.string() }).parse(event);
      const presentation = threadSession.btwRunning;
      if (presentation && !presentation.terminal && !presentation.control.closed && presentation.record.id === parsed.recordId) {
        presentation.answer += parsed.delta;
        const answer = stripOmpAnsi(presentation.answer);
        const control = presentation.control;
        sendThreadDeltas(args.threadId, [{
          kind: "item.progress",
          key: { providerItemId: `${control.parentRef}:status` },
          snapshot: nativeControlBackground(control, "pending", answer),
          flush: true,
        }]);
      }
      return;
    }
    if (event.type === "btw_record") {
      publishBtwRecord(args.threadId, threadSession, ompBtwRecordSchema.parse(event.record));
      return;
    }
    if (event.type === "goal_updated") {
      const { goal } = ompGoalUpdatedSchema.parse(event);
      await threadSession.session.getState();
      if (!getCurrentThreadSession(args)) return;
      publishNativeGoal(args.threadId, threadSession, goal);
      return;
    }
    if (
      event.type === "config_update" ||
      event.type === "model_changed" ||
      event.type === "thinking_level_changed"
    ) {
      await threadSession.session.refreshConfiguration(event);
      if (!getCurrentThreadSession(args)) return;
      publishNativeConfiguration(args.threadId, threadSession);
      return;
    }
    if (event.type === "agent_start") threadSession.localCommandTurn = undefined;
    if (event.type === "agent_end") await threadSession.todos.handleEvent(event);
    const handled = await threadSession.subagents.handleEvent(event);
    if (!getCurrentThreadSession(args)) return;
    if (!handled) {
      emitForSession(args.threadId, "sdk/message", {
        threadId: args.threadId,
        message: event,
      });
    }
    if (event.type === "agent_start") await threadSession.subagents.onTurnStart();
    if (event.type !== "agent_end") await threadSession.todos.handleEvent(event);
    if (
      event.type === "turn_end" ||
      event.type === "auto_compaction_end" ||
      event.type === "bb_compaction_end"
    ) {
      emitContextWindowUsage(args.threadId);
    }
  };
}

function createOnExtensionUiRequest(
  args: CurrentThreadSessionArgs,
): (request: Record<string, unknown>) => void {
  return (request) => {
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession || threadSession.closing) return;
    extensionUi.handle({
      scope: threadSession,
      request,
      threadId: args.threadId,
      providerThreadId: threadSession.providerThreadId,
      respond: (requestId, fields) =>
        threadSession.session.respondToExtensionUi(requestId, fields),
    });
  };
}

function createOnExtensionUiReset(args: CurrentThreadSessionArgs): () => void {
  return () => {
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) return;
    activeTurnThreads.delete(args.threadId);
    extensionUi.cancelPendingForScope(threadSession);
    extensionUi.resetStatus({
      scope: threadSession,
      threadId: args.threadId,
      providerThreadId: threadSession.providerThreadId,
    });
  };
}

function createOnSessionDone(
  args: CurrentThreadSessionArgs,
): (error?: unknown, turnHandled?: boolean) => void {
  return (error?: unknown, turnHandled = false) => {
    if (error instanceof OmpRpcChildExitedError) {
      const threadSession = getCurrentThreadSession(args);
      if (threadSession) {
        threadSession.subagents.stop("OMP process exited");
        interruptNativeControlTurns(args.threadId, threadSession, "OMP process exited");
      }
    }
    if (error && turnHandled) {
      const threadSession = getCurrentThreadSession(args);
      if (threadSession) {
        sendSessionScopedError(
          args.threadId,
          threadSession.providerThreadId,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    if (error) {
      reportSessionError({ ...args, error });
      return;
    }
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) {
      return;
    }
    void closeThreadSession({
      message: "OMP session ended while tool call was pending",
      threadId: args.threadId,
    }).catch((shutdownError: unknown) => {
      sendSessionScopedError(
        args.threadId,
        threadSession.providerThreadId,
        shutdownError instanceof Error
          ? shutdownError.message
          : String(shutdownError),
      );
    });
  };
}

function reportPromptSettled(args: {
  error?: unknown;
  sessionSerial: number;
  threadId: string;
}): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) {
    return;
  }
  const errorMessage =
    args.error === undefined
      ? undefined
      : args.error instanceof Error
        ? args.error.message
        : String(args.error);
  emitForSession(args.threadId, "omp/prompt/settled", {
    threadId: args.threadId,
    status: errorMessage === undefined ? "completed" : "failed",
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  });
}

function reportSessionError(
  args: CurrentThreadSessionArgs & { error: unknown },
): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) return;
  emitSessionError(
    threadSession,
    args.threadId,
    args.error instanceof Error ? args.error.message : String(args.error),
  );
}

async function handleRequest(
  request: OmpCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize": {
      const result: InitializeResult = {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: true,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "inject",
          skills: { configure: true },
        },
      };
      sendResult(request.id, result);
      break;
    }
    case "model/list":
      await handleModelList(request.id, request.params);
      break;
    case "provider/health":
      await handleProviderHealth(request.id, request.params);
      break;
    case "provider/usage":
      sendResult(request.id, await getOmpProviderUsage(request.params));
      break;
    case "provider/installation/status":
      sendResult(
        request.id,
        await getOmpProviderInstallationStatus(request.params.checkUpdates),
      );
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getOmpProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        `omp_${randomUUID()}`,
        toOmpSessionParams(request.params),
      );
      break;
    case "thread/resume": {
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        request.params.providerThreadId,
        toOmpSessionParams(request.params),
      );
      break;
    }
    case "thread/fork":
      await handleThreadFork(request.id, request.params);
      break;
    case "thread/name/set": {
      const { threadId, providerThreadId, title } = request.params;
      if (!title.trim()) {
        sendError(request.id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Session name cannot be empty");
        break;
      }
      const threadSession = sessions.get(threadId);
      if (!threadSession || threadSession.closing || threadSession.providerThreadId !== providerThreadId) {
        sendError(request.id, -32000, "No active omp session");
        break;
      }
      await threadSession.session.setSessionName(title);
      sendResult(request.id, { ok: true });
      break;
    }
    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      await handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      await handleThreadStop(request.id, request.params);
      break;
    case "thread/discard":
      sendResult(request.id, await handleThreadDiscard(request.params));
      break;
    case "skills/configure":
      configuredSkillPaths = request.params.roots.map((root) => root.path);
      sendResult(request.id, { ok: true });
      break;
  }
}

type ThreadForkParams = z.infer<typeof threadForkParamsSchema>;
type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParams = z.infer<typeof turnSteerParamsSchema>;
type ThreadStopParams = z.infer<typeof threadStopParamsSchema>;
type ThreadRefParams = z.infer<typeof threadDiscardParamsSchema>;

function toOmpSessionParams(
  params: z.infer<typeof threadStartParamsSchema>,
): OmpSessionParams {
  return buildOmpSessionParams({
    threadId: params.threadId,
    cwd: params.cwd,
    options: params.options,
    instructionMode: params.instructionMode,
    dynamicTools: params.dynamicTools,
    additionalSkillPaths: configuredSkillPaths ?? undefined,
  });
}

async function handleModelList(
  id: string | number,
  params: z.infer<typeof modelListParamsSchema>,
): Promise<void> {
  const gate = await getOmpInstallGate();
  if (!gate.ok) {
    sendError(
      id,
      gate.status === "not_installed"
        ? BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE
        : -32000,
      gate.status === "not_installed"
        ? "Could not find the omp CLI on this host. Install OMP from https://github.com/can1357/oh-my-pi and retry."
        : (gate.statusMessage ?? "OMP is not supported on this host."),
    );
    return;
  }
  try {
    const catalog = await getOmpCatalog(
      params.cwd ?? process.cwd(),
      buildShellEnvOverrides(params.envVars),
    );
    // The plugin server re-registers the provider with new bridgeOptions when
    // a filter setting changes; they arrive here as providerOptions.
    const filter = parseOmpModelFilter(
      (params.providerOptions as { modelFilter?: unknown } | undefined)?.modelFilter,
    );
    // Started together, both calls share one in-flight omp read.
    const [raw, list] = await Promise.all([catalog.rawModels(), catalog.listModels(filter)]);
    contextWindows.learn(raw);
    sendResult(id, list);
  } catch (error) {
    sendOmpError(id, error);
  }
}

async function handleProviderHealth(
  id: string | number,
  params: { cwd?: string },
): Promise<void> {
  const gate = await getOmpInstallGate();
  if (!gate.ok) {
    sendResult(id, gate.result);
    return;
  }
  const installedVersion = gate.installedVersion;
  try {
    const catalog = await getOmpCatalog(params.cwd ?? process.cwd());
    await catalog.probe();
    const models = await catalog.rawModels();
    sendResult(
      id,
      models.length > 0
        ? ompHealthResult("ready", { installedVersion })
        : ompHealthResult("unauthenticated", {
            installedVersion,
            statusMessage: "OMP has no authenticated model provider available.",
          }),
    );
  } catch (error) {
    sendResult(
      id,
      ompHealthResult("unknown", {
        installedVersion,
        statusMessage: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function resolveOmpModel(
  modelStr: string,
  cwd: string,
  shellEnvOverrides?: Record<string, string>,
): Promise<{ provider: string; id: string } | undefined> {
  const catalog = await getOmpCatalog(cwd, shellEnvOverrides);
  const models = await catalog.rawModels();
  contextWindows.learn(models);
  return findOmpModel(modelStr, models);
}

function findOmpModel(
  modelStr: string,
  models: readonly { provider: string; id: string }[],
  allowUnresolved = false,
): { provider: string; id: string } | undefined {
  const canonical = models.find(
    (model) => `${model.provider}/${model.id}` === modelStr,
  );
  if (canonical) {
    return { provider: canonical.provider, id: canonical.id };
  }
  const served = models.filter((model) => model.id === modelStr);
  if (served.length > 1) {
    if (allowUnresolved) return undefined;
    throw new Error(
      `Ambiguous OMP model "${modelStr}": served by ${served
        .map((m) => String(m.provider))
        .join(", ")}. Prefix it with the provider you want.`,
    );
  }
  const match = served[0];
  if (!match || typeof match.provider !== "string") {
    if (allowUnresolved) return undefined;
    throw new Error(`Failed to resolve OMP model "${modelStr}"`);
  }
  return { provider: match.provider, id: modelStr };
}

function readOmpSessionPresets(
  cwd: string,
  shellEnvOverrides: Record<string, string>,
) {
  return resolveOmpModelPresets({
    homeDir: homedir(),
    cwd,
    env: buildOmpChildEnv(shellEnvOverrides),
  });
}

async function resolveOmpPresetModel(
  preset: OmpModelPreset,
  cwd: string,
  shellEnvOverrides: Record<string, string>,
): Promise<{ model: { provider: string; id: string }; thinking?: string } | undefined> {
  const candidates = resolveOmpPresetDefaultCandidates(preset);
  if (candidates.length === 0) return undefined;
  const catalog = await getOmpCatalog(cwd, shellEnvOverrides);
  const models = await catalog.rawModels();
  contextWindows.learn(models);
  for (const candidate of candidates) {
    const model = findOmpModel(candidate.selector, models, true);
    if (model) return { model, ...(candidate.thinking ? { thinking: candidate.thinking } : {}) };
  }
  return undefined;
}

// OMP restores session history with --continue, but its per-child role overlay
// must be restored separately when BB's picker now names a raw model.
const OMP_MODEL_PRESET_SNAPSHOT_FILE = "bb-model-preset.json";
const ompModelPresetSnapshotSchema = z.object({
  name: z.string().regex(OMP_MODEL_PRESET_NAME_PATTERN),
  modelRoles: z.record(z.string(), z.string()),
  defaultThinkingLevel: z.string().optional(),
  source: z.enum(["global", "project", "overlay"]),
});

function readOmpModelPresetSnapshot(sessionDir: string): OmpModelPreset | undefined {
  let snapshot: string;
  try {
    snapshot = readFileSync(join(sessionDir, OMP_MODEL_PRESET_SNAPSHOT_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return ompModelPresetSnapshotSchema.parse(JSON.parse(snapshot));
}

function writeOmpModelPresetSnapshot(sessionDir: string, preset: OmpModelPreset | undefined): void {
  const file = join(sessionDir, OMP_MODEL_PRESET_SNAPSHOT_FILE);
  if (!preset) {
    rmSync(file, { force: true });
    return;
  }
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(preset), "utf8");
    renameSync(temporaryFile, file);
  } finally {
    rmSync(temporaryFile, { force: true });
  }
}

function sendOmpWarning(threadId: string, message: string): void {
  sendThreadDeltas(threadId, createOmpNoticeDeltas({
    severity: "warning",
    message,
  }, { activeTurn: false, id: `omp-notice-${randomUUID()}` }));
}

function publishUnresolvedPresetDefault(threadId: string, threadSession: ThreadSession): void {
  const { model, modelPreset } = threadSession.construction;
  if (modelPreset && model && parseOmpModelPresetId(model) !== undefined &&
      threadSession.constructionModel === undefined) {
    sendOmpWarning(
      threadId,
      `OMP could not resolve a default model for preset "${modelPreset.name}". The session keeps its current model.`,
    );
  }
}

const OMP_BRIDGE_COMMANDS = [
  {
    name: "omp-agent",
    description: "Cancel or message a running OMP subagent",
    inputHint: "cancel <id> | steer <id> <message>",
  },
  { name: "goal", description: "Manage OMP's persistent objective", inputHint: "<objective> | show | pause | resume | drop" },
  { name: "btw", description: "Ask an OMP side question without interrupting the main run", inputHint: "[question|cancel|history|follow <recordId> <question>]" },
  { name: "omp-bash", description: "Run a shell command in the OMP session or abort running shell commands", inputHint: "<command>|abort" },
  { name: "omp-queue", description: "Inspect or edit OMP's native queued messages", inputHint: "[remove <n>|promote <n>|restore]" },
  { name: "login", description: "List OMP sign-in providers or start OAuth sign-in", inputHint: "[provider]" },
  { name: "logout", description: "List OMP accounts or sign out a stored account", inputHint: "[provider] [credential-id]" },
  { name: "export-html", description: "Export the OMP session as an HTML file", inputHint: "[path]" },
];

function publishProviderCommands(threadId: string, commands: readonly OmpAvailableCommand[]): void {
  sendThreadDeltas(threadId, [{
    kind: "extension.state",
    extensionKind: "bb/provider-commands",
    payload: { commands: [
      ...OMP_BRIDGE_COMMANDS,
      ...commands
        .filter((command) => !OMP_BRIDGE_COMMANDS.some((bridge) => bridge.name === command.name))
        // BB accepts at most 500 entries, including bridge-owned commands.
        .slice(0, 500 - OMP_BRIDGE_COMMANDS.length)
        .map((command) => ({
          name: command.name,
          description: command.description ?? "",
          ...withInputHint(command),
        })),
    ] },
  }]);
}

// bb has no argument completion, so omp's subcommands only reach the user through the hint.
// Hints that already list them ("[on|off|status]") stay as they are; generic ones
// ("<subcommand>", "[level]") get the list appended.
function withInputHint(command: OmpAvailableCommand): { inputHint?: string } {
  const hint = command.input?.hint?.trim() ?? "";
  // Multi-word subcommands ("mm list") are offered by their first word.
  const words = [...new Set(
    (command.subcommands ?? []).map((sub) => sub.name.trim().split(/\s+/)[0] ?? "").filter(Boolean),
  )];
  if (words.length === 0) return hint ? { inputHint: hint } : {};
  const hintTokens = hint.split(/[^\w-]+/);
  if (words.some((word) => hintTokens.includes(word))) return { inputHint: hint };
  const list = words.join("|");
  return { inputHint: hint ? `${hint} (${list})` : list };
}

const DELEGATION_GUIDANCE = [
  "## OMP subagents and BB threads",
  "- Use omp's `task` subagents for work that serves the current turn: research, parallel fan-out, reviews, and edits the parent will integrate. They're private to this session, cheaper and faster, get role-based models, and their results come straight back.",
  "- Use `herd_spawn` only when the work should be its own bb thread: long-lived or long-running work (CI/deploy waits), work that may outlive this thread, work the user may want to open, watch or talk to directly, or work that needs its own worktree/branch/PR.",
  "- Default to `task` when unsure.",
].join("\n");

async function buildSessionOptions(args: {
  params: OmpSessionParams;
  providerThreadId: string;
  threadId: string;
  sessionSerial: number;
}): Promise<OmpRpcSessionOptions> {
  const presetSelected = args.params.model !== undefined &&
    parseOmpModelPresetId(args.params.model) !== undefined;
  const presetDefault = presetSelected && args.params.modelPreset
    ? await resolveOmpPresetModel(args.params.modelPreset, args.params.cwd, args.params.shellEnvOverrides)
    : undefined;
  const model = presetSelected ? presetDefault?.model
    : args.params.model
      ? await resolveOmpModel(args.params.model, args.params.cwd, args.params.shellEnvOverrides)
      : undefined;
  const thinkingLevel = args.params.thinkingLevel ??
    (presetSelected ? presetDefault?.thinking ?? args.params.modelPreset?.defaultThinkingLevel : undefined);
  return {
    cwd: args.params.cwd,
    ...(args.params.fastModeEnabled === undefined ? {} : { fastModeEnabled: args.params.fastModeEnabled }),
    ...(args.params.sessionControls === undefined ? {} : { sessionControls: args.params.sessionControls }),
    ...(args.params.permissionPolicy === undefined ? {} : { permissionPolicy: args.params.permissionPolicy }),
    ...(model ? { model } : {}),
    ...(args.params.modelPreset ? {
      modelPreset: args.params.modelPreset,
      effectiveModelRoles: args.params.effectiveModelRoles,
    } : {}),
    sessionDir: resolveOmpThreadSessionDir({
      env: process.env,
      threadId: args.providerThreadId,
    }),
    systemPrompt: args.params.baseInstructions,
    appendSystemPrompt: args.params.dynamicTools?.some((tool) => tool.name === "herd_spawn")
      ? [args.params.appendSystemPrompt, DELEGATION_GUIDANCE].filter(Boolean).join("\n\n")
      : args.params.appendSystemPrompt,
    shellEnvOverrides: args.params.shellEnvOverrides,
    ...(args.params.additionalSkillPaths
      ? { additionalSkillPaths: [...args.params.additionalSkillPaths] }
      : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(args.params.dynamicTools && args.params.dynamicTools.length > 0
      ? { dynamicTools: args.params.dynamicTools }
      : {}),
    scratchDir: requireScratchDir(),
    recordThreadId: args.threadId,
    onExtensionUiRequest: createOnExtensionUiRequest({
      sessionSerial: args.sessionSerial,
      threadId: args.threadId,
    }),
    onExtensionUiReset: createOnExtensionUiReset({
      sessionSerial: args.sessionSerial,
      threadId: args.threadId,
    }),
  };
}

async function constructOmpThreadSession(
  threadId: string,
  providerThreadId: string,
  params: OmpSessionParams,
  selection?: ThreadPickerSelection,
): Promise<ThreadSession> {
  const sessionSerial = nextSessionSerial();
  const sessionOptions = await buildSessionOptions({
    params,
    providerThreadId,
    threadId,
    sessionSerial,
  });
  const session = new OmpRpcSession(
    sessionOptions,
    createForwardToolCall(() => threadId),
    createOnOmpEvent({ sessionSerial, threadId }),
    createOnSessionDone({ sessionSerial, threadId }),
  );
  const threadSession: ThreadSession = {
    session,
    todos: createOmpTodoCoordinator({
      readState: () => session.getState(2_000),
      publish: (deltas) => {
        if (getCurrentThreadSession({ sessionSerial, threadId })) {
          sendThreadDeltas(threadId, deltas);
        }
      },
    }),
    subagents: createOmpSubagentCoordinator({
      rpc: session,
      sessionRef: providerThreadId,
      cwd: params.cwd,
      resolveModelContextWindow: contextWindows.resolve,
      getFileRoots: () => session.getFileRoots(),
      emit: (deltas) => sendThreadDeltas(threadId, deltas),
    }),
    sessionSerial,
    closing: false,
    providerThreadId,
    cwd: params.cwd,
    construction: params,
    constructionModel: sessionOptions.model,
    pickerOptions: {
      model: params.model,
      thinkingLevel: params.thinkingLevel,
      fastModeEnabled: params.fastModeEnabled,
    },
    pickerModel: sessionOptions.model,
    chosenSessionControls: { ...params.sessionControls },
    ...selection,
    pendingToolCallScopes: new Set(),
    pendingPromptPresentations: new Set(),
  };
  sessions.set(threadId, threadSession);
  try {
    await session.start();
    await threadSession.todos.refresh();
    await threadSession.subagents.restore();
    publishNativeConfiguration(threadId, threadSession);
    publishNativeGoal(threadId, threadSession, session.getLiveState()?.goal?.goal ?? null);
    publishProviderCommands(threadId, await session.getAvailableCommands());
    const liveModel = session.getLiveModel();
    if (
      liveModel &&
      typeof liveModel.id === "string" &&
      typeof liveModel.provider === "string"
    ) {
      contextWindows.learn([
        {
          id: liveModel.id,
          provider: liveModel.provider,
          contextWindow: liveModel.contextWindow,
        },
      ]);
    }
    // A failed replacement must leave the previous child's saved preset intact.
    writeOmpModelPresetSnapshot(sessionOptions.sessionDir, params.modelPreset);
    return threadSession;
  } catch (error) {
    extensionUi.clearStatusForScope(threadSession);
    if (sessions.get(threadId) === threadSession) {
      sessions.delete(threadId);
    }
    session.kill();
    throw error;
  }
}

function retireReplacedOmpChild(replaced: ThreadSession): void {
  replaced.subagents.stop("OMP session replaced");
  replaced.closing = true;
  resolveThreadToolCalls(
    replaced,
    "OMP thread session replaced while tool call was pending",
  );
  extensionUi.cancelPendingForScope(replaced);
  extensionUi.clearStatusForScope(replaced);
  void replaced.session
    .closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS)
    .catch(() => undefined);
}

async function rebuildThreadSession(
  threadId: string,
  previous: ThreadSession,
  params: OmpSessionParams,
  selection: ThreadPickerSelection,
): Promise<ThreadSession> {
  if (
    previous.construction.permissionPolicy?.permissionMode !==
    params.permissionPolicy?.permissionMode
  ) {
    // A watched-overlay rewrite has no acknowledgement. Fence the old process
    // (and cancel its approvals) before the replacement can load the new mode.
    await closeThreadSession({
      threadId,
      message: "OMP permission mode changed while a request was pending",
    });
    await previous.session.waitForExit();
  }
  let replacement: ThreadSession;
  try {
    replacement = await constructOmpThreadSession(
      threadId,
      previous.providerThreadId,
      params,
      selection,
    );
  } catch (error) {
    if (!sessions.has(threadId) && !previous.closing) {
      sessions.set(threadId, previous);
    }
    throw error;
  }
  if (!previous.closing) retireReplacedOmpChild(previous);
  return replacement;
}

function sendSessionResetBoundary(threadId: string): void {
  ompDeltaTranslator.resetThread(threadId);
  sendThreadDeltas(threadId, [{ kind: "session.reset" }]);
}

function sendThreadSessionResult(
  id: string | number,
  threadId: string,
  providerThreadId: string,
): void {
  sendThreadIdentity(threadId, providerThreadId);
  sendSessionResetBoundary(threadId);
  sendResult(id, { providerThreadId, sessionRestorable: true });
}

async function handleThreadConstruction(
  id: string | number,
  threadId: string,
  providerThreadId: string,
  params: OmpSessionParams,
): Promise<void> {
  const existing = sessions.get(threadId);
  if (existing) {
    await closeThreadSession({
      message: "OMP thread session replaced while tool call was pending",
      threadId,
    });
  }
  const sourceDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: providerThreadId,
  });
  const sourceFile = findNewestOmpSessionFile(sourceDir);
  const relocate =
    sourceFile !== undefined &&
    ompSessionNeedsRelocation(sourceFile, params.cwd);
  const nextProviderThreadId = relocate
    ? `omp_${randomUUID()}`
    : providerThreadId;
  const targetDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: nextProviderThreadId,
  });
  let missingPresetName: string | undefined;
  let threadSession: ThreadSession;
  try {
    if (relocate && sourceFile !== undefined) {
      await OmpRpcSession.forkSessionFile({
        sourceFile,
        targetDir,
        cwd: params.cwd,
        recordThreadId: threadId,
        shellEnvOverrides: params.shellEnvOverrides,
        sourceThreadStorageDir: existing?.construction.shellEnvOverrides.BB_THREAD_STORAGE,
      });
    }
    const presetName = params.model ? parseOmpModelPresetId(params.model) : undefined;
    if (presetName !== undefined) {
      const { presets, modelRoles } = await readOmpSessionPresets(params.cwd, params.shellEnvOverrides);
      const modelPreset = presets.find((preset) => preset.name === presetName);
      if (modelPreset) {
        params = { ...params, modelPreset, effectiveModelRoles: modelRoles };
      } else {
        missingPresetName = presetName;
      }
    } else {
      const modelPreset = params.modelPreset ?? readOmpModelPresetSnapshot(sourceDir);
      if (modelPreset) {
        const { modelRoles } = await readOmpSessionPresets(params.cwd, params.shellEnvOverrides);
        params = { ...params, modelPreset, effectiveModelRoles: modelRoles };
      }
    }
    threadSession = await constructOmpThreadSession(threadId, nextProviderThreadId, params);
  } catch (error) {
    if (relocate) rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }
  sendThreadSessionResult(id, threadId, nextProviderThreadId);
  if (missingPresetName !== undefined) {
    sendOmpWarning(
      threadId,
      `OMP model preset "${missingPresetName}" is unavailable. Continuing with OMP's native model roles.`,
    );
  }
  publishUnresolvedPresetDefault(threadId, threadSession);
}

async function handleThreadFork(
  id: string | number,
  params: ThreadForkParams,
): Promise<void> {
  const sourceSessionFile = findNewestOmpSessionFile(
    resolveOmpThreadSessionDir({
      env: process.env,
      threadId: params.sourceProviderThreadId,
    }),
  );
  if (sourceSessionFile === undefined) {
    sendError(
      id,
      -32000,
      `Cannot fork: source omp session file not found for thread "${params.sourceProviderThreadId}"`,
    );
    return;
  }
  const targetDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: params.threadId,
  });
  const sessionParams = toOmpSessionParams(params);
  const sourceThreadSession = [...sessions.values()].find(
    (session) => session.providerThreadId === params.sourceProviderThreadId,
  );
  try {
    if (!sessionParams.model || parseOmpModelPresetId(sessionParams.model) === undefined) {
      const modelPreset = sourceThreadSession?.construction.modelPreset ??
        readOmpModelPresetSnapshot(resolveOmpThreadSessionDir({
          env: process.env,
          threadId: params.sourceProviderThreadId,
        }));
      if (modelPreset) sessionParams.modelPreset = modelPreset;
    }
    await OmpRpcSession.forkSessionFile({
      sourceFile: sourceSessionFile,
      targetDir,
      cwd: params.cwd,
      ...(params.sourceProviderCheckpointId === undefined
        ? {}
        : { checkpointId: params.sourceProviderCheckpointId }),
      recordThreadId: params.threadId,
      shellEnvOverrides: sessionParams.shellEnvOverrides,
      sourceThreadStorageDir: sourceThreadSession?.construction.shellEnvOverrides.BB_THREAD_STORAGE,
    });
    await handleThreadConstruction(
      id,
      params.threadId,
      params.threadId,
      sessionParams,
    );
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    sendOmpError(id, error);
    return;
  }
}

function startOmpPrompt(
  threadSession: ThreadSession,
  threadId: string,
  text: string,
  images: ImageContent[],
  onConsumed: () => void,
): Promise<void> {
  const presentation: LocalPromptPresentation = {
    acceptedIntoTurn: false,
    localTurn: activeTurnThreads.has(threadId) ? threadSession.localCommandTurn : undefined,
  };
  threadSession.pendingPromptPresentations.add(presentation);
  presentation.localTurn?.pending.add(presentation);
  const dispatch = threadSession.session.prompt(
    text,
    images.length > 0 ? images : undefined,
  );
  const consumed = dispatch.consumed.then(() => {
    onConsumed();
    presentation.acceptedIntoTurn = activeTurnThreads.has(threadId);
  });
  void dispatch.settled.then(async (outcome) => {
    await consumed.catch(() => undefined);
    const scope = { threadId, sessionSerial: threadSession.sessionSerial };
    if (outcome?.localCommandDone && getCurrentThreadSession(scope)) {
      await threadSession.todos.refresh(() =>
        presentation.localTurn !== undefined &&
        threadSession.localCommandTurn === presentation.localTurn &&
        activeTurnThreads.has(threadId));
      if (getCurrentThreadSession(scope)) emitContextWindowUsage(threadId);
    }
    threadSession.pendingPromptPresentations.delete(presentation);
    const owner = presentation.localTurn;
    owner?.pending.delete(presentation);
    if (!getCurrentThreadSession(scope) || outcome === null) return;
    let error = outcome.error;
    if (owner) {
      if (error !== undefined && owner.error === undefined) owner.error = error;
      // All inputs and refreshes share one local turn. A real agent_start
      // invalidates its token, so an old callback cannot settle the root run.
      if (threadSession.localCommandTurn !== owner || owner.pending.size > 0) return;
      threadSession.localCommandTurn = undefined;
      error = owner.error;
    } else if (outcome.boundaryDelivered || (outcome.localCommandDone &&
      (activeTurnThreads.has(threadId) || presentation.acceptedIntoTurn))) {
      return;
    }
    reportPromptSettled({
      ...(error !== undefined ? { error } : {}),
      sessionSerial: threadSession.sessionSerial,
      threadId,
    });
  });
  return consumed;
}

function startOmpCompaction(
  threadSession: ThreadSession,
  threadId: string,
): void {
  void threadSession.session.compact().then(
    (outcome) => {
      if (!outcome.boundaryDelivered) {
        reportPromptSettled({
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
          sessionSerial: threadSession.sessionSerial,
          threadId,
        });
      }
    },
    (error: unknown) =>
      reportPromptSettled({
        error,
        sessionSerial: threadSession.sessionSerial,
        threadId,
      }),
  );
}

function recordAcceptedTurnInput(params: TurnStartParams): void {
  sendThreadDeltas(params.threadId, [
    { kind: "input.accepted", clientRequestId: params.clientRequestId },
  ]);
}

async function reconcileTurnOptions(
  threadId: string,
  threadSession: ThreadSession,
  options: TurnStartParams["options"],
): Promise<ThreadSession> {
  const turnOptions = buildOmpTurnOptions(options);
  const construction = threadSession.construction;
  const previousPickers = threadSession.pickerOptions;
  const permissionPolicy = turnOptions.permissionPolicy ?? construction.permissionPolicy;
  const permissionModeChanged =
    permissionPolicy?.permissionMode !== construction.permissionPolicy?.permissionMode;
  const shellEnvOverrides =
    options.envVars !== undefined
      ? { BB_THREAD_ID: threadId, ...buildShellEnvOverrides(options.envVars) }
      : undefined;
  const environmentChanged =
    shellEnvOverrides !== undefined &&
    !isDeepStrictEqual(shellEnvOverrides, construction.shellEnvOverrides);
  // BB repeats its picker snapshot on each turn and cannot follow native slash
  // changes. Only a changed picker value overrides OMP; compare that new intent
  // against the live native state before sending a setter.
  const changedModelRequest =
    turnOptions.model !== undefined && turnOptions.model !== previousPickers.model
      ? turnOptions.model
      : undefined;
  const requestedPresetName = changedModelRequest === undefined
    ? undefined
    : parseOmpModelPresetId(changedModelRequest);
  const presetChanged = requestedPresetName !== undefined &&
    requestedPresetName !== construction.modelPreset?.name;
  const thinkingPickerChanged =
    turnOptions.thinkingLevel !== undefined &&
    turnOptions.thinkingLevel !== previousPickers.thinkingLevel;
  const fastPickerChanged =
    turnOptions.fastModeEnabled !== undefined &&
    turnOptions.fastModeEnabled !== previousPickers.fastModeEnabled;
  // Unlike model pickers, BB transports session options as unacknowledged
  // differences from bb/session-options, so each supplied value is fresh intent.
  const requestedControls = turnOptions.sessionControls;
  const chosenSessionControls = { ...threadSession.chosenSessionControls, ...requestedControls };
  const nativeControls = threadSession.session.getSessionControls();
  const controlsChanged = Object.entries(requestedControls).some(
    ([key, value]) => value !== nativeControls[key as keyof OmpSessionControls],
  );
  if (
    !environmentChanged &&
    !permissionModeChanged &&
    changedModelRequest === undefined &&
    !thinkingPickerChanged &&
    !fastPickerChanged &&
    !controlsChanged
  ) {
    threadSession.pickerOptions = turnOptions;
    construction.permissionPolicy = permissionPolicy;
    threadSession.chosenSessionControls = chosenSessionControls;
    publishNativeConfiguration(threadId, threadSession);
    return threadSession;
  }
  const nextModel =
    changedModelRequest === undefined || requestedPresetName !== undefined
      ? undefined
      : await resolveOmpModel(
        changedModelRequest,
        construction.cwd,
        shellEnvOverrides ?? construction.shellEnvOverrides,
      );
  const resolvedPresets = presetChanged || (environmentChanged && construction.modelPreset)
    ? await readOmpSessionPresets(construction.cwd, shellEnvOverrides ?? construction.shellEnvOverrides)
    : undefined;
  const nextPreset = presetChanged
    ? resolvedPresets?.presets.find((preset) => preset.name === requestedPresetName)
    : construction.modelPreset;
  if (presetChanged && !nextPreset) {
    throw new Error(`OMP model preset "${requestedPresetName}" is unavailable.`);
  }
  const state = await threadSession.session.getState();
  const currentModel = state.model ?? threadSession.constructionModel;
  if (environmentChanged || presetChanged || permissionModeChanged) {
    const nativeModel = currentModel?.provider && currentModel.id
      ? `${currentModel.provider}/${currentModel.id}` : construction.model;
    const nextConstruction: OmpSessionParams = {
      ...construction,
      permissionPolicy,
      ...(shellEnvOverrides === undefined ? {} : { shellEnvOverrides }),
      ...(nextPreset ? {
        modelPreset: nextPreset,
        effectiveModelRoles: resolvedPresets?.modelRoles ?? construction.effectiveModelRoles,
      } : {}),
      model: presetChanged ? changedModelRequest
        : nextModel ? `${nextModel.provider}/${nextModel.id}` : nativeModel,
      thinkingLevel: presetChanged ? turnOptions.thinkingLevel
        : thinkingPickerChanged ? turnOptions.thinkingLevel
        : threadSession.session.getThinkingSelection().configured ?? state.thinkingLevel ?? construction.thinkingLevel,
      fastModeEnabled: fastPickerChanged ? turnOptions.fastModeEnabled : state.fastModeEnabled,
      sessionControls: { ...threadSession.session.getSessionControls(), ...requestedControls },
    };
    const replacement = await rebuildThreadSession(
      threadId,
      threadSession,
      nextConstruction,
      {
        pickerOptions: turnOptions,
        ...(!presetChanged ? { pickerModel: nextModel ?? threadSession.pickerModel } : {}),
        chosenSessionControls,
      },
    );
    sendThreadIdentity(threadId, replacement.providerThreadId);
    sendSessionResetBoundary(threadId);
    send({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
      params: {
        threadId,
        providerThreadId: replacement.providerThreadId,
        reason: permissionModeChanged
          ? "Permission mode changed; the OMP session was restarted to apply it."
          : presetChanged
            ? "Model preset changed; the OMP session was restarted to apply it."
            : "Execution environment changed; the OMP session was rebuilt to apply it.",
        contextLost: false,
      },
    });
    publishUnresolvedPresetDefault(threadId, replacement);
    return replacement;
  }
  if (nextModel && (
    currentModel?.provider !== nextModel.provider || currentModel.id !== nextModel.id
  )) {
    await threadSession.session.setModel(nextModel);
    threadSession.constructionModel = nextModel;
  }
  if (
    thinkingPickerChanged &&
    turnOptions.thinkingLevel !== undefined &&
    turnOptions.thinkingLevel !== (
      threadSession.session.getThinkingSelection().configured ??
      threadSession.session.getLiveState()?.thinkingLevel
    )
  ) {
    await threadSession.session.setThinkingLevel(turnOptions.thinkingLevel);
  }
  if (
    fastPickerChanged &&
    turnOptions.fastModeEnabled !== undefined &&
    turnOptions.fastModeEnabled !== threadSession.session.getFastModeEnabled()
  ) {
    await threadSession.session.setFastMode(turnOptions.fastModeEnabled);
  }
  await threadSession.session.applySessionControls(requestedControls);
  construction.permissionPolicy = permissionPolicy;
  threadSession.pickerOptions = turnOptions;
  threadSession.pickerModel = nextModel ?? threadSession.pickerModel;
  threadSession.chosenSessionControls = chosenSessionControls;
  publishNativeConfiguration(threadId, threadSession);
  return threadSession;
}

async function handleOmpGoalCommand(args: {
  threadId: string;
  threadSession: ThreadSession;
  text: string;
  images: readonly ImageContent[];
  clientRequestId: TurnStartParams["clientRequestId"];
  steer: boolean;
}): Promise<boolean> {
  const text = args.text.trim();
  if (!/^\/goal(?:\s|$)/u.test(text)) return false;
  if (args.images.length > 0) {
    throw new Error("OMP goals accept a text objective; send image attachments in a normal message.");
  }
  const argument = text.slice("/goal".length).trim();
  const session = args.threadSession.session;
  let result;
  let operation: "get" | "create" | "resume" | "pause" | "drop";
  if (argument === "" || argument === "show" || argument === "get") {
    operation = "get";
    result = await session.getGoal();
  } else if (argument === "resume") {
    operation = "resume";
    result = await session.resumeGoal();
  } else if (argument === "pause") {
    operation = "pause";
    result = await session.pauseGoal();
  } else if (argument === "drop" || argument === "clear") {
    operation = "drop";
    result = await session.dropGoal();
  } else {
    if (/^budget(?:\s|$)/u.test(argument)) {
      throw new Error("OMP's RPC goal command cannot change an existing goal's token budget.");
    }
    operation = "create";
    const objective = argument.replace(/^set(?:\s|$)/u, "").trim();
    result = await session.createGoal(objective);
  }
  if (!getCurrentThreadSession({
    threadId: args.threadId, sessionSerial: args.threadSession.sessionSerial,
  })) return true;
  publishNativeGoal(args.threadId, args.threadSession, result.goal);
  const ownsTurn = !args.steer && !activeTurnThreads.has(args.threadId);
  const goal = result.goal;
  sendThreadDeltas(args.threadId, [
    { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ...(ownsTurn ? [{ kind: "turn.open" } as const] : []),
    {
      kind: "item.close",
      key: { providerItemId: `omp-goal-command:${randomUUID()}` },
      item: { type: "tool", tool: "goal", args: { operation } },
      status: "completed",
      resultText: [
        goal ? `Goal ${goal.status}: ${goal.objective}\nTokens: ${goal.tokensUsed} / ${goal.tokenBudget ?? "unlimited"}` : "No OMP goal.",
        ...(operation === "create" || operation === "resume"
          ? ["Automatic continuation follows native goal.continuationModes; its default enables interactive mode, not RPC."]
          : []),
      ].join("\n"),
    },
    ...(ownsTurn ? [{ kind: "turn.boundary", status: "completed" } as const] : []),
  ]);
  return true;
}

async function handleOmpAgentCommand(args: {
  threadId: string;
  threadSession: ThreadSession;
  text: string;
  clientRequestId: TurnStartParams["clientRequestId"];
  steer: boolean;
}): Promise<boolean> {
  if (!/^\/omp-agent(?:\s|$)/u.test(args.text.trim())) return false;
  const command = /^\/omp-agent\s+(cancel|steer)\s+(\S+)(?:\s+([\s\S]+))?$/u.exec(args.text.trim());
  if (!command || (command[1] === "steer" && !command[3]?.trim()) ||
    (command[1] === "cancel" && command[3])) {
    throw new Error("Usage: /omp-agent cancel <id> | /omp-agent steer <id> <message>");
  }
  const [, operation, subagentId, message] = command;
  if (operation === "cancel") await args.threadSession.subagents.stopTask(subagentId);
  else await args.threadSession.subagents.steer(subagentId, message);
  // Cancellation can wake the real root before the RPC response arrives.
  // Attach the acknowledgement there rather than opening/settling over it.
  const ownsTurn = !args.steer && !activeTurnThreads.has(args.threadId);
  sendThreadDeltas(args.threadId, [
    { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ...(ownsTurn ? [{ kind: "turn.open" } as const] : []),
    {
      kind: "item.close",
      key: { providerItemId: `omp-agent-command:${randomUUID()}` },
      item: {
        type: "tool", tool: "omp-agent", args: { operation, subagentId, ...(message ? { message } : {}) },
      },
      status: "completed",
      resultText: operation === "cancel"
        ? `Cancellation accepted for OMP subagent ${subagentId}.`
        : `Message accepted for OMP subagent ${subagentId}.`,
    },
    ...(ownsTurn ? [{ kind: "turn.boundary", status: "completed" } as const] : []),
  ]);
  return true;
}

interface OmpLocalCommandArgs {
  threadId: string;
  threadSession: ThreadSession;
  text: string;
  images: readonly ImageContent[];
  clientRequestId: TurnStartParams["clientRequestId"];
}

function beginScopedLocalCommand(
  args: Pick<OmpLocalCommandArgs, "threadId" | "threadSession"> & { clientRequestId?: TurnStartParams["clientRequestId"] },
  prefix: string,
  label: string,
): NativeControlTurn {
  const parentRef = `${prefix}:${randomUUID()}`;
  const control: NativeControlTurn = { providerTurnId: `${parentRef}:transcript`, parentRef, label, closed: false };
  (args.threadSession.nativeControlTurns ??= new Set()).add(control);
  const ownsTurn = !activeTurnThreads.has(args.threadId);
  // A scoped turn is not automatically a child in BB. A real background card
  // must own it, or its turn/started would replace a concurrent native root.
  sendThreadDeltas(args.threadId, [
    ...(args.clientRequestId ? [{ kind: "input.accepted", clientRequestId: args.clientRequestId } as const] : []),
    ...(ownsTurn ? [{ kind: "turn.open" } as const] : []),
    {
      kind: "item.open", key: { providerItemId: `${parentRef}:status` }, attach: "currentOrLast",
      item: nativeControlBackground(control, "pending"),
    },
    {
      kind: "item.open", key: { providerItemId: parentRef }, attach: "currentOrLast",
      item: { type: "delegation", childRef: parentRef, label, background: true },
    },
    { kind: "turn.open", providerTurnId: control.providerTurnId, parentRef },
    ...(ownsTurn ? [{ kind: "turn.boundary", status: "completed" } as const] : []),
  ]);
  return control;
}

function handleOmpBtwCommand(args: OmpLocalCommandArgs): boolean {
  const match = /^\/btw(?:\s+([\s\S]*))?$/u.exec(args.text.trim());
  if (!match) return false;
  const value = match[1]?.trim() ?? "";
  const usage = "Usage: /btw <question> | /btw cancel | /btw history | /btw follow <recordId> <question>";
  if (args.images.length > 0) throw new Error("/btw does not accept image attachments");
  if (!value) throw new Error(usage);
  const follow = /^follow\s+(\S+)\s+([\s\S]+)$/u.exec(value);
  if (/^(?:cancel|history)\s/u.test(value) || (/^follow(?:\s|$)/u.test(value) && !follow)) {
    throw new Error(usage);
  }
  const operation = value === "cancel" || value === "history" ? value : "ask";
  const question = follow?.[2]?.trim() ?? value;
  const recordId = follow?.[1];
  const scope = { threadId: args.threadId, sessionSerial: args.threadSession.sessionSerial };
  const control = operation === "ask"
    ? beginScopedLocalCommand(args, "omp-btw", `Side question: ${question}`) : undefined;
  const start = control ? { question, control, ...(recordId ? { recordId } : {}) } : undefined;
  if (start) (args.threadSession.btwStarts ??= new Set()).add(start);
  else sendThreadDeltas(args.threadId, [{ kind: "input.accepted", clientRequestId: args.clientRequestId }]);
  void (async () => {
    const session = args.threadSession.session;
    if (operation === "ask") {
      const record = await session.askBtw(question, recordId);
      if (getCurrentThreadSession(scope)) publishBtwRecord(args.threadId, args.threadSession, record);
      return;
    }
    const resultText = operation === "cancel"
      ? await session.cancelBtw() ? "Side question cancelled." : "No side question is running."
      : (await session.getBtwHistory()).map((record) => [
        `Topic: ${record.id}`,
        ...[record, ...record.followUps ?? []].map((turn, index) => [
          `${index === 0 ? "Question" : `Follow-up ${index}`} (${turn.status}): ${turn.question}`,
          turn.answer,
          turn.error,
        ].filter(Boolean).join("\n\n")),
      ].join("\n\n")).join("\n\n---\n\n") || "No OMP side-question history.";
    publishLocalCommandResult({
      ...scope, tool: "btw",
      commandArgs: { operation }, resultText,
    });
  })().catch((error: unknown) => {
    if (control?.closed) return;
    const message = error instanceof Error ? error.message : String(error);
    publishLocalCommandResult({
      ...scope, tool: "btw", status: "failed",
      ...(control ? { providerTurnId: control.providerTurnId, parentRef: control.parentRef } : {}),
      commandArgs: { operation, ...(operation === "ask" ? { question, ...(recordId ? { recordId } : {}) } : {}) },
      resultText: message,
    });
    if (control && getCurrentThreadSession(scope)) {
      finishNativeControlTurn(args.threadId, args.threadSession, control, "failed", message);
    }
  }).finally(() => {
    if (start) args.threadSession.btwStarts?.delete(start);
  });
  return true;
}

function handleOmpBashCommand(args: OmpLocalCommandArgs): boolean {
  const match = /^\/omp-bash(?:\s+([\s\S]*))?$/u.exec(args.text.trim());
  if (!match) return false;
  const command = match[1]?.trim() ?? "";
  if (!command) throw new Error("Usage: /omp-bash <command> | /omp-bash abort");
  if (args.images.length > 0) throw new Error("/omp-bash does not accept image attachments");
  const scope = { threadId: args.threadId, sessionSerial: args.threadSession.sessionSerial };
  const control = command === "abort" ? undefined : beginScopedLocalCommand(args, "omp-bash", `OMP shell: ${command}`);
  const key = {
    providerItemId: `omp-user-bash:${randomUUID()}`,
    ...(control ? { parentRef: control.parentRef } : {}),
  };
  const cwd = args.threadSession.cwd;
  if (control) control.pendingItem = { providerItemId: key.providerItemId, item: { type: "command", command, cwd } };
  else sendThreadDeltas(args.threadId, [{ kind: "input.accepted", clientRequestId: args.clientRequestId }]);
  void (async () => {
    if (command === "abort") {
      await args.threadSession.session.abortBash();
      publishLocalCommandResult({
        ...scope, tool: "omp-bash", commandArgs: { operation: "abort" },
        resultText: "Cancellation requested for all running OMP user shell commands.",
      });
      return;
    }
    const result = await args.threadSession.session.bash(command);
    if (!control || control.closed || !getCurrentThreadSession(scope)) return;
    const output = stripOmpAnsi([
      result.output,
      ...(result.cancelled ? ["Shell command cancelled."] : []),
      ...(result.timedOut ? ["Shell command timed out."] : []),
      ...(result.truncated ? [`Output truncated.${result.artifactId ? ` Full output: ${result.artifactId}` : ""}`] : []),
      ...(result.images?.length ? [`OMP recorded ${result.images.length} image(s); this command card displays text only.`] : []),
    ].filter(Boolean).join("\n\n"));
    const status = result.cancelled ? "interrupted"
      : result.timedOut || (result.exitCode !== undefined && result.exitCode !== 0) ? "failed" : "completed";
    sendThreadDeltas(args.threadId, [{
      kind: "item.close", providerTurnId: control.providerTurnId, key,
      item: {
        type: "command", command, cwd: result.workingDir ?? cwd, aggregatedOutput: output,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      },
      status,
      aggregatedOutput: output,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    }]);
    finishNativeControlTurn(args.threadId, args.threadSession, control, status, [
      output,
      ...(result.exitCode === undefined ? [] : [`Exit code: ${result.exitCode}`]),
    ].filter(Boolean).join("\n\n"));
  })().catch((error: unknown) => {
    if (!getCurrentThreadSession(scope)) return;
    const message = stripOmpAnsi(error instanceof Error ? error.message : String(error));
    if (command === "abort") {
      publishLocalCommandResult({
        ...scope, tool: "omp-bash", status: "failed",
        commandArgs: { operation: "abort" }, resultText: message,
      });
    } else if (control && !control.closed) {
      sendThreadDeltas(args.threadId, [{
        kind: "item.close", providerTurnId: control.providerTurnId, key, status: "failed",
        item: { type: "command", command, cwd, aggregatedOutput: message },
        aggregatedOutput: message,
      }]);
      finishNativeControlTurn(args.threadId, args.threadSession, control, "failed", message);
    }
  });
  return true;
}

function handleOmpQueueCommand(args: OmpLocalCommandArgs): boolean {
  const match = /^\/omp-queue(?:\s+([\s\S]*))?$/u.exec(args.text.trim());
  if (!match) return false;
  const value = match[1]?.trim() ?? "";
  const edit = /^(remove|promote)\s+([1-9]\d*)$/u.exec(value);
  if (value !== "" && value !== "restore" && (!edit || !Number.isSafeInteger(Number(edit[2])))) {
    throw new Error("Usage: /omp-queue | /omp-queue remove <n> | /omp-queue promote <n> | /omp-queue restore");
  }
  if (args.images.length > 0) throw new Error("/omp-queue does not accept image attachments");
  const scope = { threadId: args.threadId, sessionSerial: args.threadSession.sessionSerial };
  const operation = edit?.[1] ?? (value || "list");
  const index = edit ? Number(edit[2]) : undefined;
  sendThreadDeltas(args.threadId, [{ kind: "input.accepted", clientRequestId: args.clientRequestId }]);
  void (async () => {
    const session = args.threadSession.session;
    let resultText: string;
    if (operation === "restore") {
      const restored = await session.abortAndRestoreQueue();
      if (!getCurrentThreadSession(scope)) return;
      const messages = [...restored.steering, ...restored.followUp];
      const text = messages.map((message) => message.text).join("\n\n");
      if (text) {
        sendThreadDeltas(args.threadId, [{
          kind: "extension.state", extensionKind: OMP_EDITOR_TEXT_STATE_KIND,
          payload: { requestId: randomUUID(), text },
        }]);
      }
      const imageCount = messages.reduce((count, message) => count + (message.images?.length ?? 0), 0);
      resultText = [
        messages.length > 0 ? `Restored ${messages.length} native queued message(s) to bb's composer as text; nothing was resubmitted.`
          : "OMP's native queue is empty; there is no queued text to restore.",
        ...(restored.imagesDropped ? ["Warning: OMP dropped images from the restored queue response."] : []),
        ...(imageCount > 0 ? [`Warning: ${imageCount} image(s) were not restored to bb's text composer.`] : []),
        ...(restored.truncated ? ["Warning: OMP truncated the restored queue; only the returned oldest-first text is available."] : []),
      ].join("\n\n");
    } else {
      const queues = (await session.getState()).queuedMessages ?? { steering: [], followUp: [] };
      const rows = [
        ...queues.steering.map((message) => ({ queue: "steering" as const, message })),
        ...queues.followUp.map((message) => ({ queue: "followUp" as const, message })),
      ];
      if (index === undefined) {
        resultText = rows.length === 0 ? "OMP's native queue is empty." : [
          "OMP native queued messages (not bb's pending queue):",
          ...rows.map((row, offset) => `${offset + 1}. [${row.queue === "followUp" ? "follow-up" : "steering"}] ${row.message}`),
          "Use /omp-queue remove <n>, /omp-queue promote <n>, or /omp-queue restore.",
        ].join("\n");
      } else {
        const selected = rows[index - 1];
        if (!selected) throw new Error(rows.length === 0 ? "OMP's native queue is empty."
          : `No OMP queued message ${index}; choose an index from 1 to ${rows.length}.`);
        if (operation === "promote" && selected.queue !== "followUp") {
          throw new Error(`OMP queued message ${index} is already in the steering queue; only follow-ups can be promoted.`);
        }
        if (rows.slice(0, index - 1).some((row) => row.queue === selected.queue && row.message === selected.message)) {
          throw new Error("OMP can only edit the first identical message in a queue; choose that earlier index first.");
        }
        const changed = operation === "remove"
          ? await session.removeQueuedMessage(selected.message, selected.queue)
          : await session.promoteQueuedMessage(selected.message);
        if (!changed) throw new Error("That OMP queued message was already delivered or removed; list /omp-queue again.");
        resultText = operation === "remove" ? `Removed OMP queued message ${index} from ${selected.queue}.`
          : `Promoted OMP queued message ${index} to the end of the steering queue.`;
      }
    }
    publishLocalCommandResult({
      ...scope, tool: "omp-queue", commandArgs: { operation, ...(index === undefined ? {} : { index }) }, resultText,
    });
  })().catch((error: unknown) => {
    publishLocalCommandResult({
      ...scope, tool: "omp-queue", commandArgs: { operation, ...(index === undefined ? {} : { index }) },
      status: "failed", resultText: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
}

function handleOmpLocalCommand(args: OmpLocalCommandArgs): boolean {
  if (handleOmpBtwCommand(args) || handleOmpBashCommand(args) || handleOmpQueueCommand(args)) return true;
  const command = /^\/(login|logout|export-html)(?:\s+([\s\S]*))?$/u.exec(args.text.trim());
  if (!command?.[1]) return false;
  const operation = command[1];
  const value = command[2]?.trim() ?? "";
  const words = value ? value.split(/\s+/u) : [];
  if (args.images.length > 0) throw new Error(`/${operation} does not accept image attachments`);
  if (operation === "login" && words.length > 1) throw new Error("Usage: /login [provider]");
  if (operation === "logout" && (words.length > 2 ||
    (words[1] !== undefined && (!/^-?\d+$/u.test(words[1]) || !Number.isSafeInteger(Number(words[1])))))) {
    throw new Error("Usage: /logout [provider] [credential-id]");
  }
  const scope = { threadId: args.threadId, sessionSerial: args.threadSession.sessionSerial };
  const commandArgs = operation === "export-html" ? (value ? { outputPath: value } : {})
    : {
      ...(words[0] === undefined ? {} : { providerId: words[0] }),
      ...(words[1] === undefined ? {} : { credentialId: Number(words[1]) }),
    };
  sendThreadDeltas(args.threadId, [{ kind: "input.accepted", clientRequestId: args.clientRequestId }]);
  // OAuth can wait minutes for a browser/code. Do not hold the bridge request
  // open, nor keep a synthetic turn open across a concurrent main run.
  void (async () => {
    const session = args.threadSession.session;
    let resultText: string;
    if ((operation === "login" || operation === "logout") && words[0] === undefined) {
      const providers = await session.getLoginProviders();
      resultText = [
        "OMP sign-in providers:",
        ...providers.map((provider) =>
          `- ${provider.id} (${provider.name}): ${provider.available ? "available" : "unavailable"}; ` +
          (provider.authenticated ? "authenticated" : "not authenticated")),
        operation === "login" ? "Use /login <provider> to sign in." : "Use /logout <provider> to list stored accounts.",
      ].join("\n");
    } else if (operation === "login") {
      await session.login(words[0]!);
      await closeAllOmpCatalogs();
      resultText = `Signed in to ${words[0]}.`;
    } else if (operation === "logout") {
      const providerId = words[0]!;
      if (words[1] === undefined) {
        const accounts = await session.getLogoutAccounts(providerId);
        resultText = accounts.length === 0 ? `No stored accounts for ${providerId}.` : [
          `Stored accounts for ${providerId}:`,
          ...accounts.map((account) =>
            `- ${account.credentialId}: ${account.label}${account.active ? " (active)" : ""} — ${account.detail}`),
          `Use /logout ${providerId} <credential-id> to remove one stored account.`,
        ].join("\n");
      } else {
        const credentialId = Number(words[1]);
        const result = await session.logout(providerId, credentialId);
        await closeAllOmpCatalogs();
        resultText = `Signed out stored account ${credentialId} from ${providerId}.` +
          (result.remainingSource ? `\nStill authenticated via ${result.remainingSource}.` : "");
      }
    } else {
      resultText = await session.exportHtml(value || undefined);
    }
    publishLocalCommandResult({
      ...scope, tool: operation, commandArgs, resultText,
      ...(operation === "export-html" ? { filePath: resultText } : {}),
    });
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    publishLocalCommandResult({
      ...scope,
      tool: operation,
      commandArgs,
      status: "failed",
      resultText: operation === "login"
        ? `${message}\n\n${OMP_TERMINAL_SIGN_IN_HINT}` : message,
    });
  });
  return true;
}

async function handleTurnStart(
  id: string | number,
  params: TurnStartParams,
): Promise<void> {
  const liveSession = sessions.get(params.threadId);
  if (!liveSession || liveSession.closing) {
    sendError(id, -32000, "No active omp session");
    return;
  }
  let threadSession: ThreadSession;
  try {
    threadSession = await reconcileTurnOptions(
      params.threadId,
      liveSession,
      params.options,
    );
  } catch (error) {
    sendOmpError(id, error);
    return;
  }
  const controlInput = extractOmpPromptInput(params.input);
  try {
    if (controlInput && await handleOmpAgentCommand({
      threadId: params.threadId, threadSession, text: controlInput.text,
      clientRequestId: params.clientRequestId, steer: false,
    })) {
      sendResult(id, { threadId: params.threadId });
      return;
    }
    if (controlInput && (await handleOmpGoalCommand({
      threadId: params.threadId, threadSession, text: controlInput.text,
      images: controlInput.images, clientRequestId: params.clientRequestId, steer: false,
    }) || handleOmpLocalCommand({
      threadId: params.threadId, threadSession, text: controlInput.text,
      images: controlInput.images, clientRequestId: params.clientRequestId,
    }))) {
      sendResult(id, { threadId: params.threadId });
      return;
    }
  } catch (error) {
    sendOmpError(id, error);
    return;
  }
  if (isStandaloneBuiltinCompactCommand(params.input)) {
    recordAcceptedTurnInput(params);
    startOmpCompaction(threadSession, params.threadId);
    sendResult(id, { threadId: params.threadId });
    return;
  }
  const input = extractOmpPromptInput(params.input);
  if (input === null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  const { text, images } = input;
  try {
    await startOmpPrompt(threadSession, params.threadId, text, images, () => recordAcceptedTurnInput(params));
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    sendOmpError(id, error);
  }
}

async function handleTurnSteer(
  id: string | number,
  params: TurnSteerParams,
): Promise<void> {
  const liveSession = sessions.get(params.threadId);
  if (!liveSession || liveSession.closing) {
    sendError(id, -32000, "No active omp session");
    return;
  }
  const input = extractOmpPromptInput(params.input);
  if (input === null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  const { text, images } = input;
  try {
    const threadSession = await reconcileTurnOptions(
      params.threadId,
      liveSession,
      params.options,
    );
    if (threadSession.session.getIsCompacting()) {
      sendError(id, -32000, "Cannot steer while context compaction is active");
      return;
    }
    const continuingTurn = threadSession === liveSession;
    if (await handleOmpAgentCommand({
      threadId: params.threadId, threadSession, text,
      clientRequestId: params.clientRequestId, steer: continuingTurn,
    })) {
      sendResult(id, { threadId: params.threadId });
      return;
    }
    if (await handleOmpGoalCommand({
      threadId: params.threadId, threadSession, text, images,
      clientRequestId: params.clientRequestId, steer: continuingTurn,
    }) || handleOmpLocalCommand({
      threadId: params.threadId, threadSession, text, images, clientRequestId: params.clientRequestId,
    })) {
      sendResult(id, { threadId: params.threadId });
      return;
    }
    if (continuingTurn) {
      await threadSession.session.steer(
        text,
        images.length > 0 ? images : undefined,
      );
      sendThreadDeltas(params.threadId, [
        { kind: "input.accepted", clientRequestId: params.clientRequestId },
      ]);
    } else {
      // Rebuilding interrupted the old run; the steering message must start a
      // run on the continued conversation, not sit in an idle child's queue.
      await startOmpPrompt(threadSession, params.threadId, text, images, () =>
        sendThreadDeltas(params.threadId, [
          { kind: "input.accepted", clientRequestId: params.clientRequestId },
        ]),
      );
    }
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    sendOmpError(id, error);
  }
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): Promise<void> {
  const threadSession = sessions.get(params.threadId);
  let checkpointId: string | undefined;
  if (
    params.intent === "interrupt" &&
    threadSession !== undefined &&
    !threadSession.closing
  ) {
    resolveThreadToolCalls(
      threadSession,
      "OMP thread interrupted while tool call was pending",
    );
    extensionUi.cancelPendingForScope(threadSession);
    await threadSession.subagents.interrupt("OMP thread interrupted");
    checkpointId = await threadSession.session.abort();
  } else {
    checkpointId = await closeThreadSession({
      message: "OMP thread stopped while tool call was pending",
      threadId: params.threadId,
    });
  }
  const providerCheckpointId = checkpointId ?? null;
  sendResult(id, { ok: true, providerCheckpointId });
}

async function handleThreadDiscard(
  params: ThreadRefParams,
): Promise<{ ok: true }> {
  await closeThreadSession({
    message: "OMP staged thread discarded while tool call was pending",
    threadId: params.threadId,
  });
  rmSync(
    resolveOmpThreadSessionDir({
      env: process.env,
      threadId: params.providerThreadId,
    }),
    {
      recursive: true,
      force: true,
    },
  );
  return { ok: true };
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response) {
    if (extensionUi.handleRuntimeResponse(response)) {
      return;
    }
    if (handleToolCallResponse(response)) {
      return;
    }
  }
  const decoded = decodeOmpJsonRpcRequest(parsed);
  if (decoded.kind === "ignored") {
    return;
  }
  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`,
    );
    return;
  }
  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`,
    );
    return;
  }
  runBridgeRequest({
    request: decoded.request,
    handleRequest: async (request) => {
      try {
        await handleRequest(request);
      } catch (error) {
        if (!(error instanceof OmpRpcResponseError)) throw error;
        sendOmpError(request.id, error);
      }
    },
    sendError,
  });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

/** @internal Test inspection: where this process writes its scratch files. */
export function experimental_scratchDirForTests(): string {
  return requireScratchDir();
}

/**
 * @internal Test cleanup: every omp child this process runs, and the private
 * scratch dir (a suite never runs the entry's `start`, so nothing else would
 * remove it).
 */
export async function experimental_closeAllForTests(): Promise<void> {
  await closeThreadSessionsGracefully("OMP bridge test teardown");
  await closeAllOmpCatalogs();
  resetOmpInstallGateForTests();
  if (scratchDir !== null && scratchDirIsPrivate) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
    scratchDirIsPrivate = false;
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: (context) => {
    scratchDir = join(context.tempDir, "omp");
    scratchDirIsPrivate = false;
    mkdirSync(scratchDir, { recursive: true });
  },
  onClose: () => {
    void closeThreadSessionsGracefully(
      "OMP bridge shutting down while tool call was pending",
    ).finally(() => {
      void closeAllOmpCatalogs();
      process.exit(0);
    });
  },
  onSigterm: () => {
    void closeThreadSessionsGracefully(
      "OMP bridge terminated while tool call was pending",
    ).finally(() => {
      void closeAllOmpCatalogs();
      process.exit(0);
    });
  },
});
