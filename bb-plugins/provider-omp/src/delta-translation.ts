import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LOCAL_BASH_TASK_TYPE,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  bashArgsSchema,
  errorEnvelopeSchema,
  extractResultText,
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  experimental_toolPresentation as toolPresentation,
  jsonRpcEnvelopeSchema,
  normalizeProviderCommandOutput,
  providerRawEventSchema,
  sdkMessageEnvelopeSchema,
  textBlockSchema,
  threadContextWindowUsageEnvelopeSchema,
  toNonNegativeNumber,
  toOptionalString,
  toPositiveNumber,
  type DeltaBackgroundTaskShape,
  type DeltaItemShape,
  type DeltaNoTurnFallback,
  type DeltaPresentation,
  type JsonRpcMessage,
  type ProviderRawEvent,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import { toCanonicalOmpModelId } from "./model-list.js";
import {
  classifyTypedOmpTool,
  ompToolPresentation,
  type ClassifiedOmpTool,
} from "./tool-classification.js";
import { ompVisibilityMetadata } from "./visibility.js";
import { runSettlementError } from "./bridge/run-settlement.js";
import { createOmpNoticeDeltas } from "./bridge/extension-notices.js";
import { createOmpCardDeltas } from "./bridge/extension-cards.js";
import { buildOmpCustomMessageCard, buildOmpEventCard } from "./omp-cards.js";
import { ompSessionStatsEventSchema } from "./bridge/session-stats.js";
import { rewriteOmpFileLinks } from "./link-rewrite.js";
import {
  OMP_EXTENSION_UI_STATE_KIND,
  ompExtensionUiStateSchema,
  stripOmpAnsi,
  type OmpCard,
} from "./extension-ui-contract.js";

export interface OmpContextWindowModel {
  contextWindow?: number;
  id: string;
  provider: string;
}

const ompEventTypeSchema = z
  .object({
    type: z.enum([
      "agent_end",
      "agent_start",
      "auto_compaction_end",
      "auto_compaction_start",
      "auto_retry_start",
      "auto_retry_end",
      "bb_compaction_end",
      "cache_warming_start",
      "cache_warming_end",
      "bb_compaction_start",
      "bb_extension_ui_state",
      "bb_rpc_response_error",
      "bb_session_stats",
      "extension_error",
      "irc_message",
      "manual_compaction_end",
      "manual_compaction_start",
      "message_end",
      "message_start",
      "message_update",
      "notice",
      "retry_fallback_applied",
      "retry_fallback_succeeded",
      "todo_reminder",
      "ttsr_triggered",
      "tool_execution_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_stream_update",
    ]),
  })
  .passthrough();

const ompPromptSettledEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("omp/prompt/settled"),
  params: z.object({
    threadId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    error: z.string().optional(),
  }),
});

const ompContextWindowUsageEnvelopeSchema = threadContextWindowUsageEnvelopeSchema.extend({
  params: threadContextWindowUsageEnvelopeSchema.shape.params.extend({
    contextWindowUsage: threadContextWindowUsageEnvelopeSchema.shape.params.shape.contextWindowUsage.extend({
      cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
    }),
  }),
});


const ompMessageContentBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const ompAssistantUsageSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().nonnegative().optional().catch(undefined),
    cacheWrite: z.number().nonnegative().optional().catch(undefined),
    totalTokens: z.number().optional(),
    reasoningTokens: z.number().nonnegative().optional().catch(undefined),
  })
  .passthrough();

const ompConversationMessageSchema = z
  .object({
    role: z.string(),
    messageId: z.string().optional(),
    content: z
      .union([z.string(), z.array(ompMessageContentBlockSchema)])
      .optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: ompAssistantUsageSchema.optional(),
  })
  .passthrough();

const ompAssistantMessageSchema = ompConversationMessageSchema.extend({
  role: z.literal("assistant"),
  content: z.array(ompMessageContentBlockSchema),
});

const ompCustomMessageBoundaryEventSchema = z
  .object({
    type: z.enum(["message_end", "message_start"]),
    messageId: z.string().optional(),
    message: z
      .object({
        role: z.literal("custom"),
        customType: z.string().optional(),
        content: z.union([z.string(), z.array(ompMessageContentBlockSchema)]),
        display: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const ompCardMessageIdentitySchema = z.object({
  customType: z.string(),
  timestamp: z.number().optional(),
  details: z.unknown().optional(),
}).passthrough();
const ompIrcIdentityDetailsSchema = z.object({ id: z.string().min(1) });
const ompCollabPromptDetailsSchema = z.object({ from: z.string() });

function cardMessageIdentity(message: unknown, messageId?: string): unknown[] {
  const parsed = ompCardMessageIdentitySchema.safeParse(message);
  if (parsed.success && parsed.data.customType.startsWith("irc:")) {
    const { customType, timestamp, details } = parsed.data;
    const irc = ompIrcIdentityDetailsSchema.safeParse(details);
    return irc.success
      ? ["irc", customType, irc.data.id]
      : ["irc", customType, timestamp, details ?? message];
  }
  return ["message", messageId ?? message];
}

const ompAgentEndEventSchema = z
  .object({
    type: z.literal("agent_end"),
    messages: z.array(ompConversationMessageSchema).optional(),
    providerCheckpointId: z.string().min(1).optional(),
    deferSettlement: z.boolean().optional(),
    settlementOnly: z.boolean().optional(),
    settlementStatus: z.literal("interrupted").optional(),
    settlementError: z.string().optional(),
    settlementErrorInfo: z.object({
      message: z.string(),
      provider: z.string().optional(),
      model: z.string().optional(),
      httpStatus: z.number().optional(),
      retryable: z.boolean().optional(),
    }).optional(),
    settlementErrorReported: z.boolean().optional(),
    settlementSuperseded: z.boolean().optional(),
  })
  .passthrough();

const ompAssistantMessageStartEventSchema = z.object({
  type: z.literal("message_start"),
  messageId: z.string().optional(),
  message: z.object({ role: z.literal("assistant"), api: z.string().optional() }),
});

// omp flags narration only from Claude thinking signatures.
const ompNarrationApis: Record<string, true> = {
  "anthropic-messages": true,
  "bedrock-converse-stream": true,
};

const ompThinkingEndPartialSchema = z.object({
  content: z.array(z.unknown()),
});

const ompThinkingBlockFlagsSchema = z.object({
  type: z.literal("thinking"),
  narration: z.boolean().optional(),
});

function isNarrationBlock(block: unknown): boolean {
  const parsed = ompThinkingBlockFlagsSchema.safeParse(block);
  return parsed.success && parsed.data.narration === true;
}

const ompAssistantMessageEndEventSchema = z.object({
  type: z.literal("message_end"),
  messageId: z.string().optional(),
  message: ompAssistantMessageSchema,
});

const ompCompactionStartEventSchema = z
  .object({
    type: z.enum([
      "auto_compaction_start",
      "bb_compaction_start",
      "manual_compaction_start",
    ]),
  })
  .passthrough();

const ompCompactionEndEventSchema = z
  .object({
    type: z.enum([
      "auto_compaction_end",
      "bb_compaction_end",
      "manual_compaction_end",
    ]),
    aborted: z.boolean(),
    skipped: z.boolean().optional(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

const ompAutoRetryStartEventSchema = z.object({
  type: z.literal("auto_retry_start"),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  delayMs: z.number().int(),
  errorMessage: z.string(),
  errorId: z.number().int().optional(),
});

const ompAutoRetryEndEventSchema = z.object({
  type: z.literal("auto_retry_end"),
  success: z.boolean(),
  attempt: z.number().int(),
  finalError: z.string().optional(),
});

const ompCacheWarmingStartEventSchema = z.object({
  type: z.literal("cache_warming_start"),
  phase: z.enum(["streaming", "idle"]),
  provider: z.string(),
  model: z.string(),
});
const ompCacheWarmingEndEventSchema = ompCacheWarmingStartEventSchema.extend({
  type: z.literal("cache_warming_end"),
  outcome: z.enum(["hit", "miss", "error", "aborted"]),
  usage: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    cost: z.object({ total: z.number().nonnegative() }).passthrough(),
  }).passthrough().optional(),
  warmingStopReason: z.string().optional(),
});

const ompRetryFallbackAppliedEventSchema = z.object({
  type: z.literal("retry_fallback_applied"),
  from: z.string(),
  to: z.string(),
  role: z.string(),
  reason: z.string().optional(),
});

const ompNoticeEventSchema = z.object({
  type: z.literal("notice"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  source: z.string().optional(),
});

const ompCompactionNoopMessages: Record<string, true> = {
  "Nothing to compact (session too small)": true,
  "Already compacted": true,
  "Nothing to compact (session too small or already rolled over)": true,
};

function isOmpCompactionNoop(errorMessage: string): boolean {
  return Object.hasOwn(ompCompactionNoopMessages, errorMessage.trim());
}

const ompMessageUpdateEventSchema = z
  .object({
    type: z.literal("message_update"),
    messageId: z.string().optional(),
    assistantMessageEvent: z
      .object({
        type: z.string(),
        content: z.unknown().optional(),
        contentIndex: z.number().optional(),
        delta: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const ompToolExecutionStartEventSchema = z
  .object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    intent: z.string().optional(),
  })
  .passthrough();

const ompToolExecutionEndEventSchema = z
  .object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

const ompFailedToolResultSchema = z.object({ isError: z.literal(true) });
const ompSkippedToolResultSchema = z.object({
  details: z.union([
    z.object({ __synthetic: z.literal(true) }),
    z.object({ executed: z.literal(false) }),
  ]),
});

const ompBashResultSchema = z.object({
  details: z.object({
    exitCode: z.number().int().optional().catch(undefined),
    wallTimeMs: z.number().nonnegative().optional().catch(undefined),
  }),
});

const ompAsyncJobStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);
const ompBashAsyncResultSchema = z.object({
  details: z.object({
    async: z.object({
      state: ompAsyncJobStatusSchema,
      jobId: z.string().min(1),
      type: z.literal("bash"),
    }),
    exitCode: z.number().int().optional().catch(undefined),
  }),
});
const ompJobsResultSchema = z.object({
  details: z.object({ jobs: z.array(z.unknown()) }),
});
const ompWaitJobsResultSchema = z.object({
  details: ompJobsResultSchema.shape.details.extend({
    op: z.literal("wait"),
    __synthetic: z.literal(false).optional(),
    executed: z.literal(true).optional(),
  }),
});
const ompWaitProgressJobsSchema = z.array(z.object({
  id: z.string().min(1),
  type: z.enum(["bash", "task", "eval"]),
  status: ompAsyncJobStatusSchema,
  label: z.string(),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().optional().catch(undefined),
  completionPercent: z.number().min(0).max(100).optional().catch(undefined),
  stage: z.string().optional().catch(undefined),
}));
const ompWaitProseResultSchema = z.object({
  content: z.array(textBlockSchema),
});
const ompWaitBashJobSchema = z.object({
  id: z.string().min(1),
  type: z.literal("bash").optional(),
  status: ompAsyncJobStatusSchema,
  resultText: z.string().optional().catch(undefined),
  errorText: z.string().optional().catch(undefined),
  exitCode: z.number().int().optional().catch(undefined),
});
const ompDeliveredBashJobSchema = z.object({
  jobId: z.string().min(1),
  type: z.literal("bash").optional(),
  status: ompAsyncJobStatusSchema.optional(),
});

const ompExtensionErrorSchema = z.object({
  extensionPath: z.string(),
  event: z.string(),
  error: z.string(),
});

const ompRpcResponseErrorSchema = z.object({
  command: z.string(),
  error: z.string(),
  code: z.string().optional(),
});


const ompToolExecutionUpdateEventSchema = z
  .object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    partialResult: z.unknown().optional(),
  })
  .passthrough();

const ompToolStreamUpdateEventSchema = z
  .object({
    type: z.literal("tool_stream_update"),
    toolCallId: z.string(),
    toolName: z.string(),
    update: z.unknown().optional(),
  })
  .passthrough();

const ompEditPreviewBatchSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      diff: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});


type OmpAssistantMessage = z.infer<typeof ompAssistantMessageSchema>;
type OmpConversationMessage = z.infer<typeof ompConversationMessageSchema>;
type OmpToolExecutionUpdateEvent = z.infer<
  typeof ompToolExecutionUpdateEventSchema
>;

const OMP_EMPTY_BASH_OUTPUT_PLACEHOLDERS = ["(no output)"] as const;
const OMP_COMMAND_TOOL_NAMES = new Set(["bash"]);


function classifyOmpToolUse(
  toolName: string,
  args: unknown,
  sessionCwd: string | undefined,
): DeltaItemShape {
  if (OMP_COMMAND_TOOL_NAMES.has(toolName)) {
    const parsed = bashArgsSchema.safeParse(args);
    const command = parsed.success
      ? toOptionalString(parsed.data.command)
      : undefined;
    const cwd =
      (parsed.success ? toOptionalString(parsed.data.cwd) : undefined) ??
      toOptionalString(sessionCwd);
    if (!command || !cwd) {
      return { type: "tool", tool: toolName, args };
    }
    return { type: "command", command, cwd };
  }

  return { type: "tool", tool: toolName, args };
}


function classifyOmpToolResultFallback(toolName: string): DeltaItemShape {
  return { type: "tool", tool: toolName };
}

interface OmpModelContextWindowLookup {
  byCanonicalId: ReadonlyMap<string, number>;
  byModelId: ReadonlyMap<string, number>;
}

export type OmpModelContextWindowResolver = (
  lastAssistant: OmpAssistantMessage | undefined,
) => number | null;

function buildOmpModelContextWindowLookup(
  models: readonly OmpContextWindowModel[],
): OmpModelContextWindowLookup {
  const byCanonicalId = new Map<string, number>();
  const byModelId = new Map<string, number>();
  for (const model of models) {
    const contextWindow = toPositiveNumber(model.contextWindow);
    if (contextWindow === undefined) {
      continue;
    }
    byCanonicalId.set(
      toCanonicalOmpModelId(model.provider, model.id),
      contextWindow,
    );
    byModelId.set(model.id, contextWindow);
  }
  return { byCanonicalId, byModelId };
}

export function createOmpModelContextWindowResolverFrom(
  models: readonly OmpContextWindowModel[],
): OmpModelContextWindowResolver {
  const modelContextWindowLookup = buildOmpModelContextWindowLookup(models);
  return (lastAssistant) =>
    resolveOmpModelContextWindow(lastAssistant, modelContextWindowLookup);
}

function resolveOmpModelContextWindow(
  lastAssistant: OmpAssistantMessage | undefined,
  modelContextWindowLookup: OmpModelContextWindowLookup,
): number | null {
  const modelId = toOptionalString(lastAssistant?.model);
  if (!modelId) {
    return null;
  }

  const providerId = toOptionalString(lastAssistant?.provider);
  if (providerId) {
    return (
      modelContextWindowLookup.byCanonicalId.get(
        toCanonicalOmpModelId(providerId, modelId),
      ) ?? null
    );
  }

  return modelContextWindowLookup.byModelId.get(modelId) ?? null;
}

export interface OmpDeltaTranslationContext {
  threadId?: string;
  parentToolCallId?: string;
  cwd?: string;
  activeTurn?: boolean;
  fileRoots?: { artifactsDir?: string; localDir?: string };
}

export interface OmpDeltaTranslator {
  translate(event: unknown, context?: OmpDeltaTranslationContext): ThreadDelta[];
  resetThread(threadId: string): void;
}

interface CreateOmpDeltaTranslatorOptions {
  resolveModelContextWindow: OmpModelContextWindowResolver;
}

const MAX_STARTED_TOOL_SHAPES = 1024;

interface StartedOmpTool {
  shape: DeltaItemShape;
  args: unknown;
  intent?: string;
  presentation?: ClassifiedOmpTool["presentation"];
  waitProgress?: string;
}

interface OmpBashJobObservation {
  status: z.infer<typeof ompAsyncJobStatusSchema>;
  resultText?: string;
  errorText?: string;
  exitCode?: number;
}

interface OmpBashJob extends OmpBashJobObservation {
  jobId: string;
  key: { providerItemId: string; parentRef?: string };
  description: string;
}

interface OmpAssistantStream {
  id: string;
  closed: boolean;
  /** Thinking block index -> whether its item has settled. */
  thinking: Map<number, boolean>;
  /** Narration blocks shown as answer text rather than reasoning. */
  narration: Set<number>;
  /** Settle thinking at message_end, the first point narration is known. */
  deferThinking: boolean;
  answerStreamed: boolean;
}

interface OmpAssistantStreams {
  generation: string;
  nextMessage: number;
  turnOpen: boolean;
  nextCard: number;
  cardIds: Set<string>;
  nextRetry: number;
  retry?: { id: string; localTurn: boolean };
  manualCompaction?: { id: string; localTurn: boolean };
  lastManualCompactionEnd?: string;
  syntheticManualCompaction: boolean;
  cacheWarming: Map<string, string>;
  activeMessageId?: string;
  snapshotHandled: boolean;
  messages: Map<string, OmpAssistantStream>;
}

export function createOmpDeltaTranslator(
  options: CreateOmpDeltaTranslatorOptions,
): OmpDeltaTranslator {
  const { resolveModelContextWindow } = options;

  const startedToolShapes = new Map<string, StartedOmpTool>();
  const pendingToolPreviews = new Map<string, string>();
  // Detached jobs outlive tool invocations and turns; only a session reset
  // discards their associations and terminal-state tombstones.
  const bashJobsByCall = new Map<string, OmpBashJob>();
  const bashJobsById = new Map<string, OmpBashJob>();
  const lastAssistantByThreadId = new Map<
    string,
    Map<string, OmpAssistantMessage>
  >();
  const cumulativeTokensByThreadId = new Map<
    string,
    ThreadEventTokenUsageBreakdown
  >();
  const assistantStreamsByThreadId = new Map<string, Map<string, OmpAssistantStreams>>();
  const lastUsageByThreadId = new Map<string, ThreadEventTokenUsageBreakdown>();
  const lastReportedUsageByThreadId = new Map<string, ThreadEventTokenUsageBreakdown>();
  const authoritativeUsageByThreadId = new Set<string>();

  function resetThread(threadId: string): void {
    // A child restart changes stream identity, not the native usage baseline.
    assistantStreamsByThreadId.delete(threadId);
    lastUsageByThreadId.delete(threadId);
    lastReportedUsageByThreadId.delete(threadId);
    lastAssistantByThreadId.delete(threadId);
    clearThreadToolShapes({ threadId });
    const prefix = `${threadId} `;
    for (const key of bashJobsByCall.keys()) {
      if (key.startsWith(prefix)) bashJobsByCall.delete(key);
    }
    for (const key of bashJobsById.keys()) {
      if (key.startsWith(prefix)) bashJobsById.delete(key);
    }
  }

  function forgetAssistant(context: OmpDeltaTranslationContext | undefined): void {
    const threadId = context?.threadId ?? "";
    const messages = lastAssistantByThreadId.get(threadId);
    messages?.delete(context?.parentToolCallId ?? "");
    if (messages?.size === 0) lastAssistantByThreadId.delete(threadId);
  }

  function assistantStreams(context: OmpDeltaTranslationContext | undefined): OmpAssistantStreams {
    const threadId = context?.threadId ?? "";
    let parents = assistantStreamsByThreadId.get(threadId);
    if (!parents) {
      parents = new Map();
      assistantStreamsByThreadId.set(threadId, parents);
    }
    const parent = context?.parentToolCallId ?? "";
    let streams = parents.get(parent);
    if (!streams) {
      streams = {
        generation: randomUUID(),
        nextMessage: 0,
        snapshotHandled: false,
        turnOpen: false,
        nextCard: 0,
        cardIds: new Set(),
        nextRetry: 0,
        syntheticManualCompaction: false,
        cacheWarming: new Map(),
        messages: new Map(),
      };
      parents.set(parent, streams);
    }
    return streams;
  }

  function assistantStream(
    streams: OmpAssistantStreams,
    messageId?: string,
    starting = false,
  ): OmpAssistantStream {
    const id = messageId !== undefined
      ? `${streams.generation}:rpc:${messageId}`
      : (!starting && streams.activeMessageId) ||
        `${streams.generation}:local-${++streams.nextMessage}`;
    let stream = streams.messages.get(id);
    if (!stream) {
      stream = {
        id, closed: false, thinking: new Map(), narration: new Set(),
        deferThinking: false, answerStreamed: false,
      };
      streams.messages.set(id, stream);
    }
    streams.activeMessageId = id;
    return stream;
  }

  function cardDeltas(
    card: OmpCard,
    identity: unknown[],
    context: OmpDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const streams = assistantStreams(context);
    const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const id = `omp-card:${streams.generation}:${fingerprint}`;
    if (streams.cardIds.has(id)) return [];
    const parentRef = context?.parentToolCallId;
    const deltas = createOmpCardDeltas(card, {
      activeTurn: context?.activeTurn ?? streams.turnOpen,
      id,
    }).map((delta): ThreadDelta =>
      delta.kind === "item.close" && parentRef
        ? { ...delta, key: { ...delta.key, parentRef } }
        : delta,
    );
    if (deltas.length > 0) streams.cardIds.add(id);
    return deltas;
  }

  function retryNoticeDeltas(
    notice: { severity: "info" | "warning" | "error"; message: string },
    status: "inProgress" | "completed" | "failed",
    context: OmpDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const streams = assistantStreams(context);
    const activeTurn = context?.activeTurn ?? streams.turnOpen;
    const openLocalTurn = !activeTurn && !streams.retry?.localTurn;
    const retry = streams.retry ??= {
      id: `retry:${streams.generation}:${++streams.nextRetry}`,
      localTurn: !activeTurn,
    };
    if (openLocalTurn) retry.localTurn = true;
    const parentRef = context?.parentToolCallId;
    const deltas = createOmpNoticeDeltas(notice, {
      activeTurn: true,
      id: retry.id,
      status,
    }).map((delta): ThreadDelta =>
      (delta.kind === "item.open" || delta.kind === "item.close") && parentRef
        ? { ...delta, key: { ...delta.key, parentRef } }
        : delta,
    );
    if (openLocalTurn) deltas.unshift({ kind: "turn.open" });
    if (status !== "inProgress") {
      // Only close turns created for idle notices; native prompt settlement
      // continues to own real turns, including terminal assistant failures.
      if (retry.localTurn && !activeTurn) {
        deltas.push({ kind: "turn.boundary", status });
      }
      streams.retry = undefined;
    }
    return deltas;
  }

  function manualCompactionNoticeDeltas(
    event: z.infer<typeof ompCompactionStartEventSchema> | z.infer<typeof ompCompactionEndEventSchema>,
    context: OmpDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const streams = assistantStreams(context);
    if (streams.syntheticManualCompaction) return [];
    const activeTurn = context?.activeTurn ?? streams.turnOpen;
    const parentRef = context?.parentToolCallId;

    if (event.type === "manual_compaction_start") {
      if (streams.manualCompaction) return [];
      const manualCompaction = {
        id: `manual-compaction:${streams.generation}:${randomUUID()}`,
        localTurn: !activeTurn,
      };
      streams.manualCompaction = manualCompaction;
      streams.lastManualCompactionEnd = undefined;
      const deltas = createOmpNoticeDeltas({
        severity: "info",
        message: "Compacting context",
      }, { activeTurn: true, id: manualCompaction.id, status: "inProgress" }).map((delta): ThreadDelta =>
        (delta.kind === "item.open" || delta.kind === "item.close") && parentRef
          ? { ...delta, key: { ...delta.key, parentRef } }
          : delta,
      );
      if (manualCompaction.localTurn) deltas.unshift({ kind: "turn.open" });
      return deltas;
    }

    const signature = JSON.stringify(event);
    if (streams.lastManualCompactionEnd === signature) return [];
    const manualCompaction = streams.manualCompaction;
    streams.manualCompaction = undefined;
    streams.lastManualCompactionEnd = signature;
    const errorMessage = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
    const status = event.aborted || errorMessage ? "failed" : "completed";
    const notice = event.skipped
      ? {
        severity: "info" as const,
        message: "Context compaction skipped",
        ...(errorMessage ? { instructions: errorMessage } : {}),
      }
      : event.aborted
        ? {
          severity: "error" as const,
          message: "Context compaction interrupted",
          ...(errorMessage ? { instructions: errorMessage } : {}),
        }
        : errorMessage
          ? { severity: "error" as const, message: "Context compaction failed", instructions: errorMessage }
          : { severity: "info" as const, message: "Context compaction completed" };
    const localTurn = manualCompaction?.localTurn ?? !activeTurn;
    const deltas = createOmpNoticeDeltas(notice, {
      activeTurn: true,
      id: manualCompaction?.id ?? `manual-compaction:${streams.generation}:${randomUUID()}`,
      status,
    }).map((delta): ThreadDelta =>
      (delta.kind === "item.open" || delta.kind === "item.close") && parentRef
        ? { ...delta, key: { ...delta.key, parentRef } }
        : delta,
    );
    if (localTurn) {
      deltas.unshift({ kind: "turn.open" });
      deltas.push({ kind: "turn.boundary", status });
    }
    return deltas;
  }

  function completeAssistantMessage(
    message: OmpAssistantMessage,
    context: OmpDeltaTranslationContext | undefined,
    messageId?: string,
  ): ThreadDelta[] {
    const streams = assistantStreams(context);
    const stream = assistantStream(streams, messageId ?? message.messageId);
    if (stream.closed) return [];
    stream.closed = true;
    streams.activeMessageId = undefined;
    streams.snapshotHandled = false;
    const threadId = context?.threadId ?? "";
    let messages = lastAssistantByThreadId.get(threadId);
    if (!messages) {
      messages = new Map();
      lastAssistantByThreadId.set(threadId, messages);
    }
    messages.set(context?.parentToolCallId ?? "", message);
    const parentRef = context?.parentToolCallId;
    const parentRefField = parentRef ? { parentRef } : {};
    const deltas: ThreadDelta[] = [];
    for (const [index, block] of message.content.entries()) {
      if (block.type !== "thinking" || typeof block.thinking !== "string") continue;
      const settled = stream.thinking.get(index);
      if (isNarrationBlock(block)) {
        // A narration block that already settled as reasoning stays there.
        if (settled === true) continue;
        if (settled === false) deltas.push(retractedReasoningDelta(stream, index, parentRef));
        stream.thinking.set(index, true);
        stream.narration.add(index);
        continue;
      }
      if (settled) continue;
      stream.thinking.set(index, true);
      deltas.push({
        kind: "item.textClose",
        key: { providerItemId: `${stream.id}:thinking-${index}`, ...parentRefField },
        channel: "reasoningText",
        text: rewriteOmpFileLinks(block.thinking, context?.fileRoots),
      });
    }
    for (const [index, closed] of stream.thinking) {
      if (closed) continue;
      stream.thinking.set(index, true);
      deltas.push({
        kind: "item.textClose",
        key: { providerItemId: `${stream.id}:thinking-${index}`, ...parentRefField },
        channel: "reasoningText",
      });
    }
    const text = extractAssistantText(message, stream.narration);
    if (text) deltas.push({
      kind: "item.textClose",
      key: { providerItemId: stream.id, ...parentRefField },
      channel: "agentMessage",
      // textClose replaces the same item's accumulated deltas. Rewriting the
      // complete snapshot avoids corrupting URLs split across stream chunks.
      text: rewriteOmpFileLinks(text, context?.fileRoots),
    });
    const usage = toAssistantUsageBreakdown(message);
    if (usage && !(runSettlementError([message]) && usage.totalTokens === 0)) {
      lastUsageByThreadId.set(threadId, usage);
      // Native totals can include frames still waiting in the delivery queue.
      // Once available, replace totals from stats rather than adding to them.
      if (!authoritativeUsageByThreadId.has(threadId)) {
        const total = addTokenUsage(
          cumulativeTokensByThreadId.get(threadId) ?? ZERO_TOKEN_USAGE,
          usage,
        );
        cumulativeTokensByThreadId.set(threadId, total);
        deltas.push({
          kind: "usage",
          total,
          last: usage,
          modelContextWindow: resolveModelContextWindow(message),
        });
      }
    }
    return deltas;
  }

  function toolShapeKey(
    context: OmpDeltaTranslationContext | undefined,
    toolCallId: string,
  ): string {
    return `${context?.threadId ?? ""} ${JSON.stringify([context?.parentToolCallId ?? "", toolCallId])}`;
  }

  function bashJobShape(job: OmpBashJob): DeltaBackgroundTaskShape {
    const summary = [
      job.resultText,
      ...(job.exitCode !== undefined ? [`Exit code: ${job.exitCode}`] : []),
    ].filter(Boolean).join("\n\n");
    return {
      type: "backgroundTask",
      familyId: job.key.providerItemId,
      taskType: LOCAL_BASH_TASK_TYPE,
      description: job.description,
      workflowName: `Bash job ${job.jobId}`,
      status: job.status === "running" ? "pending"
        : job.status === "cancelled" ? "interrupted" : job.status,
      taskStatus: job.status === "cancelled" ? "stopped" : job.status,
      skipTranscript: false,
      ...(summary ? { summary } : {}),
      ...(job.errorText ? { error: job.errorText } : {}),
    };
  }

  function bashJobPresentation(job: OmpBashJob): DeltaPresentation {
    return {
      ...toolPresentation("bash"),
      label: { pending: "Running background bash", completed: "Background bash finished" },
      title: presentationTitle(job.jobId),
      detail: presentationDetail(job.description),
    };
  }

  function jobText(value: string | undefined): string | undefined {
    const text = value === undefined ? undefined : stripOmpAnsi(value);
    return text?.trim() ? text : undefined;
  }

  function updateBashJob(job: OmpBashJob, observation: OmpBashJobObservation): ThreadDelta[] {
    const settled = job.status !== "running";
    // A terminal observation is immutable. Replays cannot reopen or reverse it,
    // but a matching later snapshot can fill in diagnostics omitted by delivery.
    if (settled && observation.status !== job.status) return [];
    const resultText = jobText(observation.resultText) ?? job.resultText;
    const errorText = jobText(observation.errorText) ?? job.errorText;
    const exitCode = observation.exitCode ?? job.exitCode;
    if (
      job.status === observation.status && job.resultText === resultText &&
      job.errorText === errorText && job.exitCode === exitCode
    ) return [];
    job.status = observation.status;
    job.resultText = resultText;
    job.errorText = errorText;
    job.exitCode = exitCode;
    const item = bashJobShape(job);
    if (!settled && job.status !== "running") {
      return [{
        kind: "item.close", key: job.key, status: item.status, item,
        presentation: bashJobPresentation(job),
      }];
    }
    return [{ kind: "item.progress", key: job.key, snapshot: item, ...(settled ? { flush: true } : {}) }];
  }

  function bashAsyncDeltas(
    event: { toolCallId: string; toolName: string },
    result: z.infer<typeof ompBashAsyncResultSchema>,
    resultText: string,
    args: unknown,
    context: OmpDeltaTranslationContext | undefined,
    canRegister: boolean,
  ): ThreadDelta[] {
    const { async, exitCode } = result.details;
    const callKey = toolShapeKey(context, event.toolCallId);
    let job = bashJobsByCall.get(callKey);
    if (job && job.jobId !== async.jobId) return [];
    const output = jobText(resultText);
    const observation: OmpBashJobObservation = {
      status: async.state, resultText: output, exitCode,
      ...(async.state === "failed" && output ? { errorText: output } : {}),
    };
    const deltas: ThreadDelta[] = [];
    if (!job) {
      if (!canRegister) return [];
      const command = bashArgsSchema.safeParse(args);
      const fingerprint = createHash("sha256").update(JSON.stringify([
        assistantStreams(context).generation, event.toolCallId, async.jobId,
      ])).digest("hex");
      job = {
        ...observation,
        status: "running",
        jobId: async.jobId,
        key: {
          providerItemId: `omp-bash-job:${fingerprint}`,
          ...(context?.parentToolCallId ? { parentRef: context.parentToolCallId } : {}),
        },
        description: `${(command.success ? toOptionalString(command.data.command) : undefined) ?? "Bash"} [job ${async.jobId}]`,
      };
      bashJobsByCall.set(callKey, job);
      bashJobsById.set(toolShapeKey(context, async.jobId), job);
      deltas.push({
        kind: "item.open", key: job.key, item: bashJobShape(job),
        presentation: bashJobPresentation(job), attach: "currentOrLast",
        noTurnFallback: noTurnFallbackFor(event, context),
      });
    }
    return [...deltas, ...updateBashJob(job, observation)];
  }

  function waitBashJobDeltas(jobs: unknown[], context: OmpDeltaTranslationContext | undefined): ThreadDelta[] {
    const deltas: ThreadDelta[] = [];
    for (const value of jobs) {
      const snapshot = ompWaitBashJobSchema.safeParse(value);
      if (!snapshot.success) continue;
      const job = bashJobsById.get(toolShapeKey(context, snapshot.data.id));
      if (job) deltas.push(...updateBashJob(job, snapshot.data));
    }
    return deltas;
  }

  function deliveredBashJobDeltas(jobs: unknown[], context: OmpDeltaTranslationContext | undefined): ThreadDelta[] {
    const deltas: ThreadDelta[] = [];
    for (const value of jobs) {
      const snapshot = ompDeliveredBashJobSchema.safeParse(value);
      if (!snapshot.success || snapshot.data.status === undefined) continue;
      const job = bashJobsById.get(toolShapeKey(context, snapshot.data.jobId));
      if (job) deltas.push(...updateBashJob(job, { status: snapshot.data.status }));
    }
    return deltas;
  }

  function rememberStartedToolShape(key: string, started: StartedOmpTool): void {
    startedToolShapes.set(key, started);
    while (startedToolShapes.size > MAX_STARTED_TOOL_SHAPES) {
      const oldest = startedToolShapes.keys().next();
      if (oldest.done === true) {
        break;
      }
      startedToolShapes.delete(oldest.value);
    }
  }

  function toolPreviewDelta(
    event: { toolCallId: string; toolName: string },
    shape: DeltaItemShape,
    text: string,
    context: OmpDeltaTranslationContext | undefined,
    flush = false,
  ): ThreadDelta {
    const key = {
      providerItemId: event.toolCallId,
      ...(context?.parentToolCallId
        ? { parentRef: context.parentToolCallId }
        : {}),
    };
    const noTurnFallback = noTurnFallbackFor(event, context);
    return shape.type === "command"
      ? {
          kind: "item.outputDelta",
          channel: shape.type,
          key,
          text,
          noTurnFallback,
        }
      : { kind: "item.progress", key, message: text, noTurnFallback, flush };
  }

  function clearThreadToolShapes(
    context: OmpDeltaTranslationContext | undefined,
  ): void {
    const prefix = `${context?.threadId ?? ""} `;
    for (const key of startedToolShapes.keys()) {
      if (key.startsWith(prefix)) startedToolShapes.delete(key);
    }
    for (const key of pendingToolPreviews.keys()) {
      if (key.startsWith(prefix)) pendingToolPreviews.delete(key);
    }
  }

  function toRawEvent(rawEvent: JsonRpcMessage): ProviderRawEvent {
    const parsed = providerRawEventSchema.safeParse(rawEvent);
    if (parsed.success) {
      return parsed.data;
    }
    return {
      jsonrpc: "2.0",
      ...(rawEvent.id !== undefined ? { id: rawEvent.id } : {}),
      method: rawEvent.method,
      params: {
        serializationError:
          "Provider raw event params were not JSON-serializable.",
      },
    };
  }

  function unhandledDeltas(
    rawEvent: JsonRpcMessage,
    parentToolCallId: string | undefined,
  ): ThreadDelta[] {
    const description = ompVisibilityMetadata.describeRawEvent(rawEvent);
    if (description.coverage !== "unknown") {
      return [];
    }
    return [
      {
        kind: "unhandled",
        raw: toRawEvent(rawEvent),
        rawType: description.kind,
        vouchedTurn: true,
        ...(parentToolCallId ? { parentRef: parentToolCallId } : {}),
      },
    ];
  }

  function noTurnFallbackFor(
    rawMessage: unknown,
    context: OmpDeltaTranslationContext | undefined,
  ): DeltaNoTurnFallback {
    const rawEvent: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        message: rawMessage,
      },
    };
    return {
      raw: toRawEvent(rawEvent),
      rawType: ompVisibilityMetadata.describeRawEvent(rawEvent).kind,
    };
  }

  function unexpectedSdkEventDeltas(
    rawMessage: unknown,
    context: OmpDeltaTranslationContext | undefined,
  ): ThreadDelta[] {
    const fallback = noTurnFallbackFor(rawMessage, context);
    return [
      {
        kind: "unhandled",
        raw: fallback.raw,
        rawType: fallback.rawType,
        vouchedTurn: true,
        ...(context?.parentToolCallId
          ? { parentRef: context.parentToolCallId }
          : {}),
      },
    ];
  }

  function translate(
    event: unknown,
    context?: OmpDeltaTranslationContext,
  ): ThreadDelta[] {
    const sdkEnvelope = sdkMessageEnvelopeSchema.safeParse(event);
    if (sdkEnvelope.success) {
      const parentToolCallId =
        sdkEnvelope.data.params.parent_tool_use_id ?? context?.parentToolCallId;
      const translated = translate(sdkEnvelope.data.params.message, {
        ...context,
        threadId: context?.threadId ?? sdkEnvelope.data.params.threadId,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
      return translated.length > 0
        ? translated
        : unhandledDeltas(
            {
              jsonrpc: "2.0",
              method: sdkEnvelope.data.method,
              params: sdkEnvelope.data.params,
            },
            parentToolCallId,
          );
    }

    const promptSettledEnvelope =
      ompPromptSettledEnvelopeSchema.safeParse(event);
    if (promptSettledEnvelope.success) {
      clearThreadToolShapes(context);
      forgetAssistant(context);
      assistantStreams(context).turnOpen = false;
      return [
        {
          kind: "turn.boundary",
          status: promptSettledEnvelope.data.params.status,
          ...(promptSettledEnvelope.data.params.error !== undefined
            ? { error: { message: promptSettledEnvelope.data.params.error } }
            : {}),
          claimIfIdle: true,
        },
      ];
    }

    const contextWindowUsageEnvelope =
      ompContextWindowUsageEnvelopeSchema.safeParse(event);
    if (contextWindowUsageEnvelope.success) {
      const { contextWindowUsage } = contextWindowUsageEnvelope.data.params;
      const used = contextWindowUsage.usedTokens;
      const size = contextWindowUsage.modelContextWindow;
      return [
        {
          kind: "contextWindow",
          used:
            typeof used === "number" && Number.isFinite(used) && used >= 0
              ? used
              : null,
          size: toPositiveNumber(size) ?? null,
          estimated: contextWindowUsage.estimated,
          attach: "currentOrLast",
          ...(contextWindowUsage.cost ? { cost: contextWindowUsage.cost } : {}),
        },
      ];
    }

    const errorEnvelope = errorEnvelopeSchema.safeParse(event);
    if (errorEnvelope.success) {
      clearThreadToolShapes(context);
      forgetAssistant(context);
      assistantStreams(context).turnOpen = false;
      return [
        {
          kind: "provider.error",
          message: "Provider error",
          detail: errorEnvelope.data.params?.message ?? "unknown error",
          settlesTurn: true,
        },
      ];
    }

    const envelope = jsonRpcEnvelopeSchema.safeParse(event);
    if (envelope.success) {
      return unhandledDeltas(
        {
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...(envelope.data.params ? { params: envelope.data.params } : {}),
        },
        context?.parentToolCallId,
      );
    }

    const eventType = ompEventTypeSchema.safeParse(event);
    if (!eventType.success) {
      return [];
    }
    const parentRef = context?.parentToolCallId;
    const parentRefField = parentRef ? { parentRef } : {};

    switch (eventType.data.type) {
      case "bb_extension_ui_state": {
        const state = ompExtensionUiStateSchema.safeParse(event);
        if (!state.success) return unexpectedSdkEventDeltas(event, context);
        return [
          {
            kind: "extension.state",
            extensionKind: OMP_EXTENSION_UI_STATE_KIND,
            payload: state.data,
          },
        ];
      }

      case "extension_error": {
        const parsed = ompExtensionErrorSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        return [{
          kind: "provider.warning",
          category: "general",
          summary: "OMP extension error",
          details: stripOmpAnsi(`${parsed.data.extensionPath} (${parsed.data.event}): ${parsed.data.error}`),
        }];
      }

      case "bb_rpc_response_error": {
        const parsed = ompRpcResponseErrorSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        return [{
          kind: "provider.warning",
          category: "general",
          summary: "OMP RPC error",
          details: stripOmpAnsi(`${parsed.data.command}${parsed.data.code ? ` (${parsed.data.code})` : ""}: ${parsed.data.error}`),
        }];
      }

      case "bb_session_stats": {
        const parsed = ompSessionStatsEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        const { stats } = parsed.data;
        const threadId = context?.threadId ?? "";
        if (parsed.data.initial) lastUsageByThreadId.delete(threadId);
        const total: ThreadEventTokenUsageBreakdown = {
          totalTokens: stats.tokens.total,
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          cachedInputTokens: stats.tokens.cacheRead + stats.tokens.cacheWrite,
          cacheReadInputTokens: stats.tokens.cacheRead,
          cacheWriteInputTokens: stats.tokens.cacheWrite,
          reasoningOutputTokens: stats.tokens.reasoning,
        };
        const modelContextWindow = toPositiveNumber(stats.contextUsage?.contextWindow) ??
          toPositiveNumber(parsed.data.modelContextWindow) ?? null;
        const previous = cumulativeTokensByThreadId.get(threadId);
        const last = lastUsageByThreadId.get(threadId);
        cumulativeTokensByThreadId.set(threadId, total);
        authoritativeUsageByThreadId.add(threadId);
        const unchanged = previous !== undefined &&
          previous.totalTokens === total.totalTokens &&
          previous.inputTokens === total.inputTokens &&
          previous.outputTokens === total.outputTokens &&
          previous.cachedInputTokens === total.cachedInputTokens &&
          previous.cacheReadInputTokens === total.cacheReadInputTokens &&
          previous.cacheWriteInputTokens === total.cacheWriteInputTokens &&
          previous.reasoningOutputTokens === total.reasoningOutputTokens;
        if (!last || (unchanged &&
          (last.totalTokens === 0 || lastReportedUsageByThreadId.get(threadId) === last))) return [];
        lastReportedUsageByThreadId.set(threadId, last);
        return [{
          kind: "usage",
          total,
          last,
          modelContextWindow,
        }];
      }

      case "agent_start": {
        forgetAssistant(context);
        const streams = assistantStreams(context);
        streams.turnOpen = true;
        streams.activeMessageId = undefined;
        streams.snapshotHandled = false;
        lastUsageByThreadId.delete(context?.threadId ?? "");
        return [{ kind: "turn.open" }];
      }

      case "cache_warming_start": {
        const parsed = ompCacheWarmingStartEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        if (parsed.data.phase === "idle") return [];
        const streams = assistantStreams(context);
        const key = JSON.stringify([parsed.data.provider, parsed.data.model]);
        if (streams.cacheWarming.has(key)) return [];
        const id = `cache-warming:${streams.generation}:${randomUUID()}`;
        streams.cacheWarming.set(key, id);
        return createOmpNoticeDeltas({
          severity: "info",
          message: `Warming cache for ${parsed.data.provider}/${parsed.data.model}`,
        }, { activeTurn: true, id, status: "inProgress" }).map((delta) =>
          delta.kind === "item.open"
            ? { ...delta, key: { ...delta.key, ...parentRefField } }
            : delta);
      }

      case "cache_warming_end": {
        const parsed = ompCacheWarmingEndEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        const { phase, provider, model, outcome, usage, warmingStopReason } = parsed.data;
        const streams = assistantStreams(context);
        const key = JSON.stringify([provider, model]);
        const id = phase === "streaming" ? streams.cacheWarming.get(key) : undefined;
        if (phase === "streaming") streams.cacheWarming.delete(key);
        if (!id && outcome !== "error") return [];
        const billed = usage
          ? `Billed usage: ${usage.totalTokens} tokens (input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}); cost $${usage.cost.total}`
          : undefined;
        return createOmpNoticeDeltas({
          severity: outcome === "error" ? "warning" : "info",
          message: `Cache warming ${outcome} for ${provider}/${model}`,
          ...((billed || warmingStopReason) ? { instructions: [billed, warmingStopReason].filter(Boolean).join("\n") } : {}),
        }, {
          // Warming never owns a turn: only the notice item is completed.
          activeTurn: id !== undefined || (context?.activeTurn ?? streams.turnOpen),
          id: id ?? `cache-warming:${streams.generation}:${randomUUID()}`,
          status: outcome === "error" ? "failed" : "completed",
        }).map((delta) =>
          delta.kind === "item.close"
            ? { ...delta, key: { ...delta.key, ...parentRefField } }
            : delta);
      }

      case "auto_retry_start": {
        const parsed = ompAutoRetryStartEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        const { attempt, maxAttempts, delayMs, errorMessage } = parsed.data;
        return retryNoticeDeltas({
          severity: "warning",
          message: `Retrying (attempt ${attempt}/${maxAttempts} in ${delayMs / 1000}s): ${errorMessage}`,
        }, "inProgress", context);
      }

      case "auto_retry_end": {
        const parsed = ompAutoRetryEndEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        const { success, attempt, finalError } = parsed.data;
        // Recovery without a corresponding start has no stale item to resolve.
        // Failures must still be visible if the host missed the start frame.
        if (success && !assistantStreams(context).retry) return [];
        return retryNoticeDeltas({
          severity: success ? "info" : "error",
          message: success
            ? `Recovered after ${attempt} ${attempt === 1 ? "retry" : "retries"}`
            : finalError ?? `Retry failed after ${attempt} ${attempt === 1 ? "retry" : "retries"}`,
        }, success ? "completed" : "failed", context);
      }

      case "retry_fallback_applied": {
        const parsed = ompRetryFallbackAppliedEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        const from = stripOmpAnsi(parsed.data.from);
        const to = stripOmpAnsi(parsed.data.to);
        const role = stripOmpAnsi(parsed.data.role);
        const reason = parsed.data.reason
          ? stripOmpAnsi(parsed.data.reason)
          : undefined;
        return [
          {
            kind: "provider.modelFallback",
            originalModel: from,
            fallbackModel: to,
            reason: "provider",
            message: `Switching ${role} model from ${from} to ${to}${reason ? `: ${reason}` : ""}`,
          },
        ];
      }

      case "retry_fallback_succeeded":
        return [];

      case "notice": {
        const parsed = ompNoticeEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        const notice = {
          ...parsed.data,
          message: stripOmpAnsi(parsed.data.message),
          ...(parsed.data.source !== undefined
            ? { source: stripOmpAnsi(parsed.data.source) }
            : {}),
        };
        if (notice.level !== "info") {
          return [
            {
              kind: "provider.warning",
              category: "general",
              summary: `OMP ${notice.level === "error" ? "Error" : "Warning"}${notice.source ? ` (${notice.source})` : ""}`,
              details: notice.message,
            },
          ];
        }
        // The SDK has no thread-scoped informational notice. Reuse the
        // neutral extension item when a turn exists, otherwise preserve the
        // raw notice rather than mislabeling information as a warning.
        return createOmpNoticeDeltas(
          {
            severity: "info",
            message: notice.source
              ? `${notice.source}: ${notice.message}`
              : notice.message,
          },
          { activeTurn: true, id: `session-notice-${randomUUID()}` },
        ).flatMap((delta) =>
          delta.kind === "item.close"
            ? [{ ...delta, noTurnFallback: noTurnFallbackFor(notice, context) }]
            : unexpectedSdkEventDeltas(notice, context),
        );
      }

      case "ttsr_triggered":
      case "irc_message":
      case "todo_reminder": {
        const card = buildOmpEventCard(event);
        if (!card) return [];
        // Rules and todo reminders have no upstream occurrence identity.
        // Identical payloads can be distinct triggers, so preserve each one.
        const identity = eventType.data.type === "irc_message"
          ? cardMessageIdentity(eventType.data.message)
          : ["event", eventType.data.type, ++assistantStreams(context).nextCard];
        return cardDeltas(card, identity, context);
      }

      case "message_end":
      case "message_start": {
        if (eventType.data.type === "message_end") {
          const boundary = ompAssistantMessageEndEventSchema.safeParse(event);
          if (boundary.success) {
            return completeAssistantMessage(boundary.data.message, context, boundary.data.messageId);
          }
        } else {
          const start = ompAssistantMessageStartEventSchema.safeParse(event);
          if (start.success) {
            const streams = assistantStreams(context);
            const stream = assistantStream(streams, start.data.messageId, true);
            const api = start.data.message.api;
            stream.deferThinking = api !== undefined && Object.hasOwn(ompNarrationApis, api);
            streams.snapshotHandled = false;
            return [];
          }
        }
        const ompEvent = ompCustomMessageBoundaryEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return [];
        }
        const message = ompEvent.data.message;
        const delivered = message.customType === "async-result"
          ? ompJobsResultSchema.safeParse(message) : undefined;
        const jobDeltas = delivered?.success
          ? deliveredBashJobDeltas(delivered.data.details.jobs, context) : [];
        if (
          ompEvent.data.type === "message_end" ||
          !message.display
        ) {
          return jobDeltas;
        }
        const card = buildOmpCustomMessageCard(message);
        if (card) {
          return [...jobDeltas, ...cardDeltas(
            card,
            cardMessageIdentity(message, ompEvent.data.messageId),
            context,
          )];
        }
        const text = extractCustomMessageText(ompEvent.data.message.content);
        if (text === undefined) {
          return jobDeltas;
        }
        if (message.customType === "collab-prompt") {
          const author = ompCollabPromptDetailsSchema.safeParse(message.details);
          const name = author.success ? stripOmpAnsi(author.data.from).trim() : "";
          return [{
            kind: "input.provider",
            text: name ? `«${name}» ›\n\n${text}` : text,
            ...parentRefField,
          }];
        }
        return [{ kind: "input.provider", text, ...parentRefField }];
      }

      case "auto_compaction_start":
      case "bb_compaction_start":
      case "manual_compaction_start": {
        const parsed = ompCompactionStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        if (parsed.data.type === "manual_compaction_start") {
          return manualCompactionNoticeDeltas(parsed.data, context);
        }
        if (parsed.data.type === "bb_compaction_start") {
          assistantStreams(context).syntheticManualCompaction = true;
        }
        const open: ThreadDelta = {
          kind: "item.open",
          key: { channel: "compaction" },
          item: { type: "compaction" },
          ...(parsed.data.type === "bb_compaction_start"
            ? {}
            : { attach: "currentOrLast" }),
          noTurnFallback: noTurnFallbackFor(event, context),
        };
        return parsed.data.type === "bb_compaction_start"
          ? [{ kind: "turn.open" }, open]
          : [open];
      }
      case "auto_compaction_end":
      case "bb_compaction_end":
      case "manual_compaction_end": {
        const parsed = ompCompactionEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        if (parsed.data.type === "manual_compaction_end") {
          return manualCompactionNoticeDeltas(parsed.data, context);
        }
        const succeeded = !parsed.data.aborted && !parsed.data.errorMessage;
        const compacted: ThreadDelta = {
          kind: "context.compacted",
          noTurnFallback: noTurnFallbackFor(event, context),
        };
        if (parsed.data.type === "bb_compaction_end") {
          assistantStreams(context).syntheticManualCompaction = false;
          clearThreadToolShapes(context);
          forgetAssistant(context);
          const compactionNoopDetail =
            !parsed.data.aborted &&
            parsed.data.errorMessage !== undefined &&
            isOmpCompactionNoop(parsed.data.errorMessage)
              ? parsed.data.errorMessage
              : undefined;
          if (compactionNoopDetail !== undefined) {
            return [
              {
                kind: "provider.warning",
                category: "compaction-skipped",
                summary: "Context compaction skipped",
                details: compactionNoopDetail,
                vouchedTurn: true,
              },
              { kind: "turn.boundary", status: "completed" },
            ];
          }
          return [
            ...(succeeded ? [compacted] : []),
            {
              kind: "turn.boundary",
              status: parsed.data.aborted
                ? "interrupted"
                : parsed.data.errorMessage
                  ? "failed"
                  : "completed",
              ...(parsed.data.errorMessage
                ? { error: { message: parsed.data.errorMessage } }
                : {}),
            },
          ];
        }
        if (parsed.data.skipped) return [];
        if (succeeded) {
          return [compacted];
        }
        return [
          {
            kind: "provider.error",
            message: parsed.data.aborted
              ? "Context compaction interrupted"
              : "Context compaction failed",
            detail:
              parsed.data.errorMessage ??
              "Automatic context compaction was interrupted",
          },
        ];
      }

      case "agent_end": {
        const ompEvent = ompAgentEndEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const cachedAssistant = ompEvent.data.settlementOnly
          ? undefined
          : lastAssistantByThreadId
              .get(context?.threadId ?? "")
              ?.get(context?.parentToolCallId ?? "");
        const messages = ompEvent.data.messages ?? [];
        const lastAssistant =
          findLastAssistantMessage(messages) ?? cachedAssistant;
        forgetAssistant(context);
        const deferSettlement =
          !ompEvent.data.settlementOnly &&
          ompEvent.data.deferSettlement !== false;
        const settlementError =
          ompEvent.data.settlementStatus === "interrupted"
            ? undefined
            : ompEvent.data.settlementError ??
              runSettlementError(lastAssistant ? [lastAssistant] : messages);
        const deltas: ThreadDelta[] = [];
        const streams = assistantStreams(context);
        if (!deferSettlement) streams.turnOpen = false;
        if (!ompEvent.data.settlementOnly && !streams.snapshotHandled) {
          for (const message of messages) {
            const assistant = ompAssistantMessageSchema.safeParse(message);
            if (!assistant.success) continue;
            // The live session annotates snapshots with their RPC identity.
            // Unidentified child/legacy snapshots follow a delivered message_end.
            if (assistant.data.messageId !== undefined || !cachedAssistant) {
              deltas.push(...completeAssistantMessage(assistant.data, context));
            }
          }
          streams.snapshotHandled = true;
          forgetAssistant(context);
        }
        const info = ompEvent.data.settlementErrorInfo;
        const errorInfo = info ? {
          category: "unknown" as const,
          httpStatusCode: info.httpStatus ?? null,
          providerCode: info.provider ?? null,
        } : undefined;
        const errorDetail = [
          settlementError,
          ...(info?.provider ? [`Provider: ${info.provider}`] : []),
          ...(info?.model ? [`Model: ${info.model}`] : []),
          ...(info?.retryable !== undefined
            ? [`Retryable: ${info.retryable ? "yes (resubmitting may succeed)" : "no"}`] : []),
        ].filter(Boolean).join("\n");
        if (settlementError && !deferSettlement) {
          clearThreadToolShapes(context);
          const failure: ThreadDelta[] = [...deltas];
          if (!ompEvent.data.settlementErrorReported) {
            failure.push({
              kind: "provider.error",
              message: "Provider error",
              detail: errorDetail,
              ...(errorInfo ? { errorInfo } : {}),
            });
          }
          failure.push({
            kind: "turn.boundary",
            status: "failed",
            ...(ompEvent.data.providerCheckpointId !== undefined
              ? { providerCheckpointId: ompEvent.data.providerCheckpointId }
              : {}),
          });
          return failure;
        }
        if (!deferSettlement) clearThreadToolShapes(context);
        if (
          settlementError &&
          deferSettlement &&
          ompEvent.data.settlementSuperseded
        ) {
          deltas.push({
            kind: "provider.error",
            message: "Provider error",
            detail: errorDetail,
            ...(errorInfo ? { errorInfo } : {}),
          });
        }
        if (deferSettlement) return deltas;
        deltas.push({
          kind: "turn.boundary",
          status: ompEvent.data.settlementStatus ?? "completed",
          ...(ompEvent.data.providerCheckpointId !== undefined
            ? { providerCheckpointId: ompEvent.data.providerCheckpointId }
            : {}),
          claimIfIdle: true,
        });
        return deltas;
      }

      case "message_update": {
        const ompEvent = ompMessageUpdateEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const assistantEvent = ompEvent.data.assistantMessageEvent;
        const streams = assistantStreams(context);
        const stream = assistantStream(streams, ompEvent.data.messageId);
        if (stream.closed) return [];
        streams.snapshotHandled = false;
        if (assistantEvent.type === "text_delta") {
          const delta = assistantEvent.delta;
          if (!delta) {
            return [];
          }
          stream.answerStreamed = true;
          return [
            {
              kind: "item.textDelta",
              key: { providerItemId: stream.id, ...parentRefField },
              channel: "agentMessage",
              text: delta,
            },
          ];
        }
        if (assistantEvent.type === "thinking_delta") {
          const delta = assistantEvent.delta;
          if (!delta) {
            return [];
          }
          if (typeof assistantEvent.contentIndex !== "number") {
            return unexpectedSdkEventDeltas(event, context);
          }
          stream.thinking.set(assistantEvent.contentIndex, false);
          return [
            {
              kind: "item.textDelta",
              key: {
                providerItemId: `${stream.id}:thinking-${assistantEvent.contentIndex}`,
                ...parentRefField,
              },
              channel: "reasoningText",
              text: delta,
            },
          ];
        }
        if (assistantEvent.type === "thinking_end") {
          const content = assistantEvent.content;
          if (typeof content !== "string" || content.length === 0) {
            return [];
          }
          if (typeof assistantEvent.contentIndex !== "number") {
            return unexpectedSdkEventDeltas(event, context);
          }
          const index = assistantEvent.contentIndex;
          if (stream.thinking.get(index)) return [];
          // `messageUpdates: "delta"` strips `partial`; then narration is
          // first known at message_end. Full frames (e.g. subagents) carry it.
          const partial = ompThinkingEndPartialSchema.safeParse(assistantEvent.partial);
          const block = partial.success ? partial.data.content[index] : undefined;
          if (block !== undefined && isNarrationBlock(block)) {
            const streamed = stream.thinking.get(index) === false;
            stream.thinking.set(index, true);
            stream.narration.add(index);
            // message_end presents an unstreamed block with the answer text.
            if (!streamed) return [];
            const preview: ThreadDelta = {
              kind: "item.textDelta",
              key: { providerItemId: stream.id, ...parentRefField },
              channel: "agentMessage",
              // message_end replaces this preview with the joined answer text.
              text: stream.answerStreamed ? `\n${content}` : content,
            };
            stream.answerStreamed = true;
            return [retractedReasoningDelta(stream, index, context?.parentToolCallId), preview];
          }
          if (block === undefined && stream.deferThinking) {
            if (stream.thinking.has(index)) return [];
            stream.thinking.set(index, false);
            return [
              {
                kind: "item.textDelta",
                key: { providerItemId: `${stream.id}:thinking-${index}`, ...parentRefField },
                channel: "reasoningText",
                text: content,
              },
            ];
          }
          stream.thinking.set(index, true);
          return [
            {
              kind: "item.textClose",
              key: { providerItemId: `${stream.id}:thinking-${index}`, ...parentRefField },
              channel: "reasoningText",
              text: rewriteOmpFileLinks(content, context?.fileRoots),
            },
          ];
        }
        return [];
      }

      case "tool_execution_start": {
        const ompEvent = ompToolExecutionStartEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const classified: ClassifiedOmpTool = classifyTypedOmpTool(
          ompEvent.data.toolName,
          ompEvent.data.args,
        ) ?? { item: classifyOmpToolUse(ompEvent.data.toolName, ompEvent.data.args, context?.cwd) };
        // The bridge retains object arguments only; keep freeform patches intact.
        const shape = classified.item.type === "tool" && typeof classified.item.args === "string"
          ? { ...classified.item, args: { input: classified.item.args } }
          : classified.item;
        const presentation = ompToolPresentation(classified, ompEvent.data.toolName, ompEvent.data.intent);
        rememberStartedToolShape(
          toolShapeKey(context, ompEvent.data.toolCallId),
          {
            shape,
            args: ompEvent.data.args,
            intent: ompEvent.data.intent,
            presentation,
          },
        );
        const shapeKey = toolShapeKey(context, ompEvent.data.toolCallId);
        const preview = pendingToolPreviews.get(shapeKey);
        pendingToolPreviews.delete(shapeKey);
        const deltas: ThreadDelta[] = [
          {
            kind: "item.open",
            key: {
              providerItemId: ompEvent.data.toolCallId,
              ...parentRefField,
            },
            item: shape,
            ...(presentation ? { presentation } : {}),
            noTurnFallback: noTurnFallbackFor(ompEvent.data, context),
          },
        ];
        if (preview !== undefined) {
          deltas.push(
            toolPreviewDelta(ompEvent.data, shape, preview, context, true),
          );
        }
        return deltas;
      }

      case "tool_execution_end": {
        const ompEvent = ompToolExecutionEndEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const aggregatedOutput = OMP_COMMAND_TOOL_NAMES.has(
          ompEvent.data.toolName,
        )
          ? extractOmpCommandExecutionOutput(ompEvent.data.result)
          : undefined;
        const shapeKey = toolShapeKey(context, ompEvent.data.toolCallId);
        const started = startedToolShapes.get(shapeKey);
        startedToolShapes.delete(shapeKey);
        pendingToolPreviews.delete(shapeKey);
        const failed = ompEvent.data.isError === true ||
          ompFailedToolResultSchema.safeParse(ompEvent.data.result).success;
        const classified = !started
          ? classifyTypedOmpTool(ompEvent.data.toolName, undefined)
          : undefined;
        const resultText = extractResultText(ompEvent.data.result);
        const bashAsync = ompEvent.data.toolName === "bash"
          ? ompBashAsyncResultSchema.safeParse(ompEvent.data.result) : undefined;
        let terminalShape: DeltaItemShape = classified?.item ??
          started?.shape ?? classifyOmpToolResultFallback(ompEvent.data.toolName);
        let presentation = classified
          ? ompToolPresentation(classified, ompEvent.data.toolName, started?.intent)
          : started?.presentation;
        if (bashAsync?.success) {
          const jobId = bashAsync.data.details.async.jobId;
          presentation = {
            ...(presentation ?? toolPresentation("bash")),
            label: { pending: "Dispatching background bash", completed: "Dispatched background bash" },
            title: presentation?.title ?? presentationTitle(`Bash job ${jobId}`),
            detail: presentationDetail(
              [presentation?.detail, `Background job: ${jobId}`].filter(Boolean).join("\n"),
            ),
          };
        }
        if (
          terminalShape.type === "tool" &&
          ompEvent.data.result !== undefined
        ) {
          terminalShape = { ...terminalShape, result: ompEvent.data.result };
        }
        const bashResult = terminalShape.type === "command"
          ? ompBashResultSchema.safeParse(ompEvent.data.result) : undefined;
        const exitCode = (bashResult?.success ? bashResult.data.details.exitCode : undefined) ??
          (bashAsync?.success ? undefined : failed ? 1 : 0);
        if (terminalShape.type === "command") {
          const durationMs = bashResult?.success ? bashResult.data.details.wallTimeMs : undefined;
          terminalShape = {
            ...terminalShape,
            exitCode,
            ...(durationMs !== undefined ? { durationMs } : {}),
          };
        }
        const key = {
          providerItemId: ompEvent.data.toolCallId,
          ...parentRefField,
        };
        const noTurnFallback = noTurnFallbackFor(ompEvent.data, context);
        const jobDeltas = bashAsync?.success
          ? bashAsyncDeltas(
              ompEvent.data, bashAsync.data, resultText, started?.args, context, true,
            )
          : [];
        const waited = ompEvent.data.toolName === "wait"
          ? ompWaitJobsResultSchema.safeParse(ompEvent.data.result) : undefined;
        return [
          {
            kind: "item.close",
            key,
            status: failed ? "failed" : "completed",
            resultText,
            exitCode,
            ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
            item: terminalShape,
            ...(presentation ? { presentation } : {}),
            noTurnFallback,
          },
          ...jobDeltas,
          ...(waited?.success ? waitBashJobDeltas(waited.data.details.jobs, context) : []),
        ];
      }

      case "tool_stream_update": {
        const parsed = ompToolStreamUpdateEventSchema.safeParse(event);
        if (!parsed.success) return unexpectedSdkEventDeltas(event, context);
        if (parsed.data.update === undefined) return [];
        const shapeKey = toolShapeKey(context, parsed.data.toolCallId);
        const started = startedToolShapes.get(shapeKey);
        const text = extractOmpStreamPreviewText(
          parsed.data.toolName,
          parsed.data.update,
        );
        if (started === undefined) {
          pendingToolPreviews.set(shapeKey, text);
          while (pendingToolPreviews.size > MAX_STARTED_TOOL_SHAPES) {
            const oldest = pendingToolPreviews.keys().next();
            if (oldest.done) break;
            pendingToolPreviews.delete(oldest.value);
          }
          return [];
        }
        return [
          toolPreviewDelta(parsed.data, started.shape, text, context),
        ];
      }

      case "tool_execution_update": {
        const ompEvent = ompToolExecutionUpdateEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const started = startedToolShapes.get(
          toolShapeKey(context, ompEvent.data.toolCallId),
        );
        const bashAsync = ompEvent.data.toolName === "bash"
          ? ompBashAsyncResultSchema.safeParse(ompEvent.data.partialResult) : undefined;
        if (bashAsync?.success) {
          return bashAsyncDeltas(
            ompEvent.data, bashAsync.data, extractResultText(ompEvent.data.partialResult),
            started?.args ?? ompEvent.data.args, context, started !== undefined,
          );
        }
        if (ompEvent.data.toolName === "wait") {
          if (ompSkippedToolResultSchema.safeParse(ompEvent.data.partialResult).success) return [];
          const waited = ompWaitJobsResultSchema.safeParse(ompEvent.data.partialResult);
          // Job observations remain independent of the wait invocation's display.
          const jobDeltas = waited.success ? waitBashJobDeltas(waited.data.details.jobs, context) : [];
          if (
            started === undefined ||
            started.shape.type !== "tool" || started.shape.tool !== "wait"
          ) return jobDeltas;
          const prose = ompWaitProseResultSchema.safeParse(ompEvent.data.partialResult);
          const message = (waited.success ? formatOmpWaitProgress(waited.data.details.jobs) : undefined) ??
            (prose.success ? extractResultText(prose.data.content).trim() : "");
          // Native snapshots arrive every 500 ms. Elapsed time and repeated
          // status frames are not progress, and empty frames need no placeholder.
          if (!message || started.waitProgress === message) return jobDeltas;
          started.waitProgress = message;
          return [
            ...jobDeltas,
            {
              kind: "item.progress",
              key: { providerItemId: ompEvent.data.toolCallId, ...parentRefField },
              message,
              noTurnFallback: noTurnFallbackFor(ompEvent.data, context),
            },
          ];
        }
        if (OMP_COMMAND_TOOL_NAMES.has(ompEvent.data.toolName)) {
          const snapshot = extractOmpCommandExecutionOutput(
            ompEvent.data.partialResult,
          );
          if (snapshot === undefined) {
            return [];
          }
          return [
            {
              kind: "command.outputSnapshot",
              key: {
                providerItemId: ompEvent.data.toolCallId,
                ...parentRefField,
              },
              text: snapshot,
              noTurnFallback: noTurnFallbackFor(ompEvent.data, context),
            },
          ];
        }
        return [
          {
            kind: "item.progress",
            key: {
              providerItemId: ompEvent.data.toolCallId,
              ...parentRefField,
            },
            message: extractOmpToolProgressText(ompEvent.data),
            noTurnFallback: noTurnFallbackFor(ompEvent.data, context),
          },
        ];
      }

      default:
        return [];
    }
  }

  return { translate, resetThread };
}

function findLastAssistantMessage(
  messages: OmpConversationMessage[],
): OmpAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const parsedMessage = ompAssistantMessageSchema.safeParse(message);
    if (parsedMessage.success) {
      return parsedMessage.data;
    }
  }
  return undefined;
}

/** Answer text in content order; `narration` indexes thinking blocks presented as answer text. */
function extractAssistantText(
  message: OmpAssistantMessage,
  narration: ReadonlySet<number>,
): string | undefined {
  const chunks: string[] = [];
  for (const [index, block] of message.content.entries()) {
    const parsedBlock = textBlockSchema.safeParse(block);
    if (parsedBlock.success) {
      chunks.push(parsedBlock.data.text);
    } else if (narration.has(index) && typeof block.thinking === "string") {
      chunks.push(block.thinking);
    }
  }
  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Retracts a reasoning item whose block turned out to be narration. bb settles
 * an item once and cannot remove a started one; a blank final text replaces
 * the streamed reasoning, and bb renders no row for blank reasoning.
 */
function retractedReasoningDelta(
  stream: OmpAssistantStream,
  index: number,
  parentRef: string | undefined,
): ThreadDelta {
  return {
    kind: "item.textClose",
    key: { providerItemId: `${stream.id}:thinking-${index}`, ...(parentRef ? { parentRef } : {}) },
    channel: "reasoningText",
    text: " ",
  };
}

function extractCustomMessageText(
  content: z.infer<
    typeof ompCustomMessageBoundaryEventSchema
  >["message"]["content"],
): string | undefined {
  const text = (
    typeof content === "string"
      ? content
      : content
          .flatMap((block) => {
            const parsedBlock = textBlockSchema.safeParse(block);
            return parsedBlock.success ? [parsedBlock.data.text] : [];
          })
          .join("\n")
  ).trim();
  return text.length > 0 ? text : undefined;
}

function extractOmpStreamPreviewText(toolName: string, update: unknown): string {
  if (toolName === "edit") {
    const preview = ompEditPreviewBatchSchema.safeParse(update);
    if (preview.success && preview.data.files.length > 0) {
      return preview.data.files
        .map((file) => `${file.path}\n${file.diff ?? file.error ?? ""}`.trim())
        .join("\n");
    }
  }
  return extractResultText(update).trim() || `${toolName} progress update`;
}


function extractOmpCommandExecutionOutput(content: unknown): string | undefined {
  return normalizeProviderCommandOutput({
    text: extractResultText(content),
    emptyPlaceholders: OMP_EMPTY_BASH_OUTPUT_PLACEHOLDERS,
  });
}

function extractOmpToolProgressText(event: OmpToolExecutionUpdateEvent): string {
  const text = extractResultText(event.partialResult).trim();
  return text.length > 0 ? text : `${event.toolName} progress update`;
}

function formatOmpWaitProgress(jobs: unknown[]): string | undefined {
  const parsed = ompWaitProgressJobsSchema.safeParse(jobs);
  if (!parsed.success || parsed.data.length === 0) return undefined;
  return parsed.data.map((job) => [
    `${job.id} [${job.type}]: ${job.status}`,
    job.status === "running" && job.completionPercent !== undefined ? `${job.completionPercent}%` : undefined,
    job.label.trim() || undefined,
    job.stage?.trim() || undefined,
    job.exitCode !== undefined ? `exit ${job.exitCode}` : undefined,
  ].filter(Boolean).join(" — ")).join("\n");
}

function toAssistantUsageBreakdown(
  lastAssistant: OmpAssistantMessage | undefined,
) {
  const typedUsage = lastAssistant?.usage;
  if (!typedUsage) return undefined;

  const inputTokens = toNonNegativeNumber(typedUsage.input);
  const outputTokens = toNonNegativeNumber(typedUsage.output);
  const cachedInputTokens =
    toNonNegativeNumber(typedUsage.cacheRead) +
    toNonNegativeNumber(typedUsage.cacheWrite);
  const totalTokens = toNonNegativeNumber(typedUsage.totalTokens);

  return {
    totalTokens:
      totalTokens > 0
        ? totalTokens
        : inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    ...(typedUsage.cacheRead === undefined
      ? {}
      : { cacheReadInputTokens: typedUsage.cacheRead }),
    ...(typedUsage.cacheWrite === undefined
      ? {}
      : { cacheWriteInputTokens: typedUsage.cacheWrite }),
    outputTokens,
    reasoningOutputTokens: toNonNegativeNumber(typedUsage.reasoningTokens),
  };
}
