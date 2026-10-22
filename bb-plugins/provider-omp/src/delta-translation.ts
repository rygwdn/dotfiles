import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  bashArgsSchema,
  errorEnvelopeSchema,
  extractResultText,
  jsonRpcEnvelopeSchema,
  normalizeProviderCommandOutput,
  providerRawEventSchema,
  sdkMessageEnvelopeSchema,
  textBlockSchema,
  threadContextWindowUsageEnvelopeSchema,
  toNonNegativeNumber,
  toOptionalString,
  toPositiveNumber,
  type DeltaItemShape,
  type DeltaNoTurnFallback,
  type JsonRpcMessage,
  type ProviderRawEvent,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import { toCanonicalOmpModelId } from "./model-list.js";
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
      "bb_compaction_start",
      "bb_extension_ui_state",
      "bb_rpc_response_error",
      "bb_session_stats",
      "extension_error",
      "irc_message",
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
  message: z.object({ role: z.literal("assistant") }),
});

const ompAssistantMessageEndEventSchema = z.object({
  type: z.literal("message_end"),
  messageId: z.string().optional(),
  message: ompAssistantMessageSchema,
});

const ompCompactionStartEventSchema = z
  .object({
    type: z.enum(["auto_compaction_start", "bb_compaction_start"]),
  })
  .passthrough();

const ompCompactionEndEventSchema = z
  .object({
    type: z.enum(["auto_compaction_end", "bb_compaction_end"]),
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

const ompBashResultSchema = z.object({
  details: z.object({
    exitCode: z.number().int().optional().catch(undefined),
    wallTimeMs: z.number().nonnegative().optional().catch(undefined),
  }),
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

const ompReadArgsSchema = z.object({
  path: z.string().refine((path) => path.trim().length > 0),
});

const ompImageContentBlockSchema = z.object({
  type: z.literal("image"),
  data: z.string().trim().min(1),
  mimeType: z.string().regex(/^image\/[^\s/]+$/),
});

const ompToolResultContentSchema = z.object({
  content: z.array(z.unknown()),
});

function hasOmpImageContent(result: unknown): boolean {
  const parsed = ompToolResultContentSchema.safeParse(result);
  return (
    parsed.success &&
    parsed.data.content.some(
      (block) => ompImageContentBlockSchema.safeParse(block).success,
    )
  );
}

const ompToolExecutionUpdateEventSchema = z
  .object({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    toolName: z.string(),
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

const ompFileEditArgsSchema = z
  .object({
    path: z.string().optional(),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    content: z.string().optional(),
    edits: z.unknown().optional(),
  })
  .passthrough();

const ompFileEditBatchSchema = z.array(
  z.object({
    oldText: z.string(),
    newText: z.string(),
  }),
);

type OmpAssistantMessage = z.infer<typeof ompAssistantMessageSchema>;
type OmpConversationMessage = z.infer<typeof ompConversationMessageSchema>;
type OmpToolExecutionUpdateEvent = z.infer<
  typeof ompToolExecutionUpdateEventSchema
>;

const OMP_EMPTY_BASH_OUTPUT_PLACEHOLDERS = ["(no output)"] as const;
const OMP_COMMAND_TOOL_NAMES = new Set(["bash"]);
const OMP_FILE_CHANGE_TOOL_NAMES = new Set(["edit", "write"]);
const OMP_IMAGE_READ_PATH_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const OMP_UNICODE_SPACE_PATTERN = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;


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

  if (OMP_FILE_CHANGE_TOOL_NAMES.has(toolName)) {
    const parsed = ompFileEditArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { type: "tool", tool: toolName, args };
    }
    if (!parsed.data.path) {
      return { type: "tool", tool: toolName, args: parsed.data };
    }
    const path = parsed.data.path;
    const parsedEdits = ompFileEditBatchSchema.safeParse(parsed.data.edits);
    if (parsedEdits.success && parsedEdits.data.length > 0) {
      return {
        type: "fileChange",
        changes: parsedEdits.data.map((edit) => ({
          path,
          kind: "update",
          oldText: edit.oldText,
          newText: edit.newText,
        })),
      };
    }

    const newText = parsed.data.newText ?? parsed.data.content;
    return {
      type: "fileChange",
      changes: [
        {
          path,
          kind:
            toolName === "edit" || parsed.data.oldText !== undefined
              ? "update"
              : "add",
          ...(parsed.data.oldText === undefined
            ? {}
            : { oldText: parsed.data.oldText }),
          ...(newText === undefined ? {} : { newText }),
        },
      ],
    };
  }

  return { type: "tool", tool: toolName, args };
}

function resolveOmpImageReadPath(
  toolName: string,
  args: unknown,
  sessionCwd: string | undefined,
): string | null {
  if (toolName !== "read") {
    return null;
  }
  const parsed = ompReadArgsSchema.safeParse(args);
  if (!parsed.success) {
    return null;
  }
  let path = parsed.data.path.replace(OMP_UNICODE_SPACE_PATTERN, " ");
  if (path.startsWith("@")) {
    path = path.slice(1);
  }
  if (path === "~" || path.startsWith("~/")) {
    path = join(homedir(), path.slice(2));
  }
  if (URL_SCHEME_PATTERN.test(path)) {
    return null;
  }
  const absolutePath = isAbsolute(path)
    ? resolve(path)
    : sessionCwd !== undefined && isAbsolute(sessionCwd)
      ? resolve(sessionCwd, path)
      : null;
  return absolutePath !== null && OMP_IMAGE_READ_PATH_PATTERN.test(absolutePath)
    ? absolutePath
    : null;
}

function classifyOmpToolResultFallback(toolName: string): DeltaItemShape {
  if (OMP_FILE_CHANGE_TOOL_NAMES.has(toolName)) {
    return { type: "fileChange", changes: [] };
  }
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
  deferredImageReadPath: string | null;
}

interface OmpAssistantStream {
  id: string;
  closed: boolean;
  thinking: Map<number, boolean>;
}

interface OmpAssistantStreams {
  generation: string;
  nextMessage: number;
  turnOpen: boolean;
  nextCard: number;
  cardIds: Set<string>;
  nextRetry: number;
  retry?: { id: string; localTurn: boolean };
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
      stream = { id, closed: false, thinking: new Map() };
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
      if (block.type === "thinking" && typeof block.thinking === "string" &&
        !stream.thinking.get(index)) {
        stream.thinking.set(index, true);
        deltas.push({
          kind: "item.textClose",
          key: { providerItemId: `${stream.id}:thinking-${index}`, ...parentRefField },
          channel: "reasoningText",
          text: rewriteOmpFileLinks(block.thinking, context?.fileRoots),
        });
      }
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
    const text = extractAssistantText(message);
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
    return `${context?.threadId ?? ""} ${toolCallId}`;
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
    return shape.type === "command" || shape.type === "fileChange"
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
            assistantStream(streams, start.data.messageId, true);
            streams.snapshotHandled = false;
            return [];
          }
        }
        const ompEvent = ompCustomMessageBoundaryEventSchema.safeParse(event);
        if (!ompEvent.success) {
          return [];
        }
        if (
          ompEvent.data.type === "message_end" ||
          !ompEvent.data.message.display
        ) {
          return [];
        }
        const message = ompEvent.data.message;
        const card = buildOmpCustomMessageCard(message);
        if (card) {
          return cardDeltas(
            card,
            cardMessageIdentity(message, ompEvent.data.messageId),
            context,
          );
        }
        const text = extractCustomMessageText(ompEvent.data.message.content);
        if (text === undefined) {
          return [];
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
      case "bb_compaction_start": {
        const parsed = ompCompactionStartEventSchema.safeParse(event);
        if (!parsed.success) {
          return unexpectedSdkEventDeltas(event, context);
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
      case "bb_compaction_end": {
        const parsed = ompCompactionEndEventSchema.safeParse(event);
        if (!parsed.success) {
          return unexpectedSdkEventDeltas(event, context);
        }
        const succeeded = !parsed.data.aborted && !parsed.data.errorMessage;
        const compacted: ThreadDelta = {
          kind: "context.compacted",
          noTurnFallback: noTurnFallbackFor(event, context),
        };
        if (parsed.data.type === "bb_compaction_end") {
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
          if (stream.thinking.get(assistantEvent.contentIndex)) return [];
          stream.thinking.set(assistantEvent.contentIndex, true);
          return [
            {
              kind: "item.textClose",
              key: {
                providerItemId: `${stream.id}:thinking-${assistantEvent.contentIndex}`,
                ...parentRefField,
              },
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
        const shape = classifyOmpToolUse(
          ompEvent.data.toolName,
          ompEvent.data.args,
          context?.cwd,
        );
        const deferredImageReadPath = resolveOmpImageReadPath(
          ompEvent.data.toolName,
          ompEvent.data.args,
          context?.cwd,
        );
        rememberStartedToolShape(
          toolShapeKey(context, ompEvent.data.toolCallId),
          { shape, deferredImageReadPath },
        );
        const shapeKey = toolShapeKey(context, ompEvent.data.toolCallId);
        const preview = pendingToolPreviews.get(shapeKey);
        pendingToolPreviews.delete(shapeKey);
        if (deferredImageReadPath !== null) {
          return [];
        }
        const deltas: ThreadDelta[] = [
          {
            kind: "item.open",
            key: {
              providerItemId: ompEvent.data.toolCallId,
              ...parentRefField,
            },
            item: shape,
            ...(ompEvent.data.intent
              ? {
                  presentation: {
                    icon: { glyph: "wrench" },
                    label: {
                      pending: ompEvent.data.toolName,
                      completed: ompEvent.data.toolName,
                    },
                    title: ompEvent.data.intent,
                  },
                }
              : {}),
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
        const resultText = extractResultText(ompEvent.data.result);
        const aggregatedOutput = OMP_COMMAND_TOOL_NAMES.has(
          ompEvent.data.toolName,
        )
          ? extractOmpCommandExecutionOutput(ompEvent.data.result)
          : undefined;
        const shapeKey = toolShapeKey(context, ompEvent.data.toolCallId);
        const started = startedToolShapes.get(shapeKey);
        startedToolShapes.delete(shapeKey);
        pendingToolPreviews.delete(shapeKey);
        const deferredImageReadPath = started?.deferredImageReadPath ?? null;
        let terminalShape: DeltaItemShape =
          deferredImageReadPath !== null &&
          !ompEvent.data.isError &&
          hasOmpImageContent(ompEvent.data.result)
            ? { type: "imageView", path: deferredImageReadPath }
            : (started?.shape ??
              classifyOmpToolResultFallback(ompEvent.data.toolName));
        if (
          terminalShape.type === "tool" &&
          ompEvent.data.result !== undefined
        ) {
          terminalShape = { ...terminalShape, result: ompEvent.data.result };
        }
        const bashResult = terminalShape.type === "command"
          ? ompBashResultSchema.safeParse(ompEvent.data.result) : undefined;
        const exitCode = (bashResult?.success ? bashResult.data.details.exitCode : undefined) ??
          (ompEvent.data.isError ? 1 : 0);
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
        const deferredOpen: ThreadDelta[] =
          deferredImageReadPath === null
            ? []
            : [{ kind: "item.open", key, item: terminalShape, noTurnFallback }];
        return [
          ...deferredOpen,
          {
            kind: "item.close",
            key,
            status: ompEvent.data.isError ? "failed" : "completed",
            resultText,
            exitCode,
            ...(aggregatedOutput === undefined ? {} : { aggregatedOutput }),
            item: terminalShape,
            noTurnFallback,
          },
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
        if (started.deferredImageReadPath !== null) return [];
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
        if ((started?.deferredImageReadPath ?? null) !== null) {
          return [];
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

function extractAssistantText(message: OmpAssistantMessage): string | undefined {
  const content = message.content;
  const chunks: string[] = [];
  for (const block of content) {
    const parsedBlock = textBlockSchema.safeParse(block);
    if (parsedBlock.success) {
      chunks.push(parsedBlock.data.text);
    }
  }
  const text = chunks.join("\n").trim();
  return text.length > 0 ? text : undefined;
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
