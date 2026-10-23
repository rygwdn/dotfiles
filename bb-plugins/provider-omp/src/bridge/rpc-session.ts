import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { experimental_buildBridgeToolCallContent as buildBridgeToolCallContent } from "@get-bb/plugin-sdk/provider-bridge";
import { runSettlementError } from "./run-settlement.js";
import type { ImageContent } from "./turn-input.js";
import {
  NO_REQUEST_TIMEOUT,
  OmpRpcChild,
  OmpRpcChildExitedError,
  buildOmpChildEnv,
  type OmpRpcChildExitInfo,
} from "./rpc-child.js";
import {
  resolveOmpCustomSkillDirectories,
  type OmpModelPreset,
} from "../native-roots.js";
import { todoPhasesSchema } from "./todos.js";
import { ompSessionStatsSchema, type OmpSessionStats } from "./session-stats.js";
import type { OmpSessionControls } from "../session-options.js";
import type { OmpPermissionPolicy } from "../session-params.js";
import {
  ensureForkLocalThreadStorageLink,
  ensureLocalThreadStorageLink,
  getOmpArtifactsDir,
} from "./local-storage.js";
import {
  ompSubagentMessagesSchema,
  ompSubagentSnapshotSchema,
  type OmpSubagentMessages,
  type OmpSubagentSnapshot,
} from "./subagents.js";

export interface OmpRpcSessionOptions {
  cwd: string;
  model?: { provider: string; id: string };
  modelPreset?: OmpModelPreset;
  effectiveModelRoles?: Record<string, string>;
  thinkingLevel?: string;
  fastModeEnabled?: boolean;
  sessionControls?: OmpSessionControls;
  permissionPolicy?: OmpPermissionPolicy;
  additionalSkillPaths?: readonly string[];
  shellEnvOverrides?: Record<string, string>;
  dynamicTools?: readonly DynamicToolDefinition[];
  sessionDir: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  scratchDir: string;
  recordThreadId: string;
  onExtensionUiRequest?: (request: Record<string, unknown>) => void;
  onExtensionUiReset?: () => void;
}

export interface DynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

type BridgeToolResult = Parameters<typeof buildBridgeToolCallContent>[0] & {
  isError?: boolean;
};

export type ToolCallForwarder = (
  toolName: string,
  args: Record<string, unknown>,
  control?: {
    signal: AbortSignal;
    onUpdate: (result: Parameters<typeof buildBridgeToolCallContent>[0]) => void;
  },
) => Promise<BridgeToolResult>;

export type OmpRpcEvent = Record<string, unknown> & { type: string };

export const ompAvailableCommandsSchema = z.array(z.object({
  name: z.string(),
  description: z.string().optional(),
  input: z.object({ hint: z.string().optional() }).optional(),
  subcommands: z.array(z.object({ name: z.string() })).optional(),
}));
export type OmpAvailableCommand = z.infer<typeof ompAvailableCommandsSchema>[number];

const btwTurnSchema = z.object({
  question: z.string(),
  answer: z.string(),
  status: z.enum(["running", "complete", "cancelled", "error", "interrupted"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  error: z.string().optional(),
});
export const ompBtwRecordSchema = btwTurnSchema.extend({
  id: z.string(),
  leafId: z.string().nullable(),
  followUps: z.array(btwTurnSchema).optional(),
});
export type OmpBtwRecord = z.infer<typeof ompBtwRecordSchema>;
const loginProvidersSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  authenticated: z.boolean(),
}));
const logoutAccountsSchema = z.array(z.object({
  credentialId: z.number().int(),
  provider: z.string(),
  label: z.string(),
  detail: z.string(),
  type: z.enum(["oauth", "api_key"]),
  active: z.boolean(),
}));

type OmpSessionEventHandler = (event: OmpRpcEvent) => void | Promise<void>;
type OmpSessionDoneHandler = (error?: unknown, turnHandled?: boolean) => void;
type OmpInputQueue = "followUp" | "steering";

interface PendingInputConsumption {
  queue: OmpInputQueue;
  queuedText: string | null;
  reject: (error: Error) => void;
  resolve: () => void;
}

export interface OmpPromptRunOutcome {
  boundaryDelivered?: boolean;
  localCommandDone?: boolean;
  error?: unknown;
}

export interface OmpInputDispatch {
  consumed: Promise<void>;
  settled: Promise<OmpPromptRunOutcome | null>;
}

const promptResultSchema = z.object({
  agentInvoked: z.boolean(),
  status: z.enum(["completed", "aborted", "error"]),
  sessionSettled: z.boolean(),
  error: z.object({
    message: z.string(),
    provider: z.string().optional(),
    model: z.string().optional(),
    httpStatus: z.number().optional(),
    retryable: z.boolean().optional(),
  }).optional(),
});
type PromptResult = z.infer<typeof promptResultSchema>;

const promptAckSchema = z.object({ agentInvoked: z.boolean().optional() }).nullish();
const sessionChangeResultSchema = z.object({ cancelled: z.boolean() });
const treeResultSchema = z.object({
  leafId: z.string().nullable(),
  tree: z.array(z.unknown()),
});
const treeNodeSchema = z.object({
  entry: z.object({ id: z.string(), type: z.string() }),
  children: z.array(z.unknown()),
});
const hostToolCallSchema = z.object({
  type: z.literal("host_tool_call"),
  id: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
const queueUpdateSchema = z.object({
  steering: z.array(z.string()),
  followUp: z.array(z.string()),
});

const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const bashResultSchema = z.object({
  output: z.string(),
  exitCode: z.number().int().optional(),
  cancelled: z.boolean(),
  timedOut: z.boolean().optional(),
  truncated: z.boolean(),
  artifactId: z.string().optional(),
  workingDir: z.string().optional(),
  images: z.array(imageContentSchema).optional(),
});
export type OmpBashResult = z.infer<typeof bashResultSchema>;
const restoredQueueSchema = z.object({
  steering: z.array(z.object({ text: z.string(), images: z.array(imageContentSchema).optional() })),
  followUp: z.array(z.object({ text: z.string(), images: z.array(imageContentSchema).optional() })),
  imagesDropped: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

interface PendingPrompt {
  activity: SessionActivity;
  input: PendingInputConsumption;
  result?: PromptResult;
  resolve: (outcome: OmpPromptRunOutcome | null) => void;
}

interface SessionActivity {
  started: boolean;
  finalizing: boolean;
  interrupted: boolean;
  run: number;
  messages: unknown[];
  end?: OmpRpcEvent;
  result?: { value: PromptResult; run: number };
  maintenanceFailure?: { message: string; run: number };
  reportedErrors: Set<string>;
  prompts: Map<string, PendingPrompt>;
}

const OMP_TRANSIENT_AUTH_RETRY_DELAY_MS = 250;
const OMP_TRANSIENT_AUTH_MAX_RETRIES = 8;
const LEAF_REQUEST_TIMEOUT_MS = 5_000;

type OmpSessionConstructionOutcome = { ok: true } | { ok: false; error: Error };

function waitForOmpTransientAuthRetry(): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, OMP_TRANSIENT_AUTH_RETRY_DELAY_MS);
  return promise;
}

export async function runOmpTransientAuthConstruction(args: {
  attempt: () => Promise<OmpSessionConstructionOutcome>;
  discardFailedAttempt: () => void;
  isClosed: () => boolean;
  waitBeforeRetry: () => Promise<void>;
}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await args.attempt();
    if (outcome.ok) return;
    if (attempt >= OMP_TRANSIENT_AUTH_MAX_RETRIES || args.isClosed()) {
      throw outcome.error;
    }
    args.discardFailedAttempt();
    await args.waitBeforeRetry();
  }
}

export const ompThinkingLevelSchema = z.enum([
  "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
export const ompConfiguredThinkingLevelSchema = z.enum([
  "auto", ...ompThinkingLevelSchema.options,
]);
const thinkingLevelChangedSchema = z.object({
  thinkingLevel: ompThinkingLevelSchema.optional(),
  configured: ompConfiguredThinkingLevelSchema.optional(),
  resolved: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});

export const ompGoalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(["active", "paused", "budget-limited", "complete", "dropped"]),
  tokenBudget: z.number().int().optional(),
  tokensUsed: z.number().int(),
  timeUsedSeconds: z.number(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
const goalModeStateSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["active", "exiting"]),
  reason: z.literal("completed").optional(),
  goal: ompGoalSchema,
});
const goalResultSchema = z.object({
  goal: ompGoalSchema.nullable(),
  state: goalModeStateSchema.nullable(),
});
export const ompGoalUpdatedSchema = z.object({
  goal: ompGoalSchema.nullable(),
  state: goalModeStateSchema.optional(),
});
const cacheWarmingResultSchema = z.object({
  mode: z.enum(["off", "streaming", "idle"]),
});
export type OmpGoal = z.infer<typeof ompGoalSchema>;
export type OmpGoalResult = z.infer<typeof goalResultSchema>;

const sessionStateSchema = z.object({
  model: z.object({
    provider: z.string().optional(),
    id: z.string().optional(),
    contextWindow: z.number().optional(),
  }).optional(),
  thinkingLevel: ompThinkingLevelSchema.optional(),
  fastModeEnabled: z.boolean().optional(),
  fastModeActive: z.boolean().optional(),
  slowModeSupported: z.boolean().default(false),
  slowModeEnabled: z.boolean().default(false),
  slowModeScope: z.enum(["session", "global"]).optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
  followUpMode: z.enum(["all", "one-at-a-time"]).optional(),
  interruptMode: z.enum(["immediate", "wait"]).optional(),
  autoCompactionEnabled: z.boolean().optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  isSettled: z.boolean().optional(),
  queuedMessageCount: z.number().optional(),
  queuedMessages: queueUpdateSchema.extend({ liveSteered: z.number().optional() }).optional(),
  sessionFile: z.string().optional(),
  todoPhases: todoPhasesSchema.optional(),
  goal: goalModeStateSchema.nullable().optional(),
});
export type OmpRpcSessionState = z.infer<typeof sessionStateSchema>;

export class OmpRpcSession {
  private child: OmpRpcChild | undefined;
  private closed = false;
  private isProcessing = false;
  private fastModeEnabled = false;
  private isCompacting = false;
  private compactionInterrupted = false;
  private activity: SessionActivity | undefined;
  private nextPromptId = 0;
  private deliveryChain: Promise<void> = Promise.resolve();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly pendingPromptAcks = new Set<string>();
  private readonly hostCalls = new Map<string, AbortController>();
  private readonly pendingInputConsumptions: PendingInputConsumption[] = [];
  private readonly pendingQueuePromotions = new Set<PendingInputConsumption>();
  private lastObservedQueues: Record<OmpInputQueue, string[]> = {
    followUp: [],
    steering: [],
  };
  private lastKnownLeafId: string | null = null;
  private sessionFile: string | undefined;
  private fileRoots: { artifactsDir: string; localDir: string } | undefined;
  private lastContextUsage: {
    tokens: number | null;
    contextWindow: number;
    cost: number;
  } | null = null;
  private sessionStats: OmpSessionStats | undefined;
  private liveModel: OmpRpcSessionState["model"] | undefined;
  private liveState: OmpRpcSessionState | undefined;
  private thinkingSelection: z.infer<typeof thinkingLevelChangedSchema> = {};
  private liveSessionControls: OmpSessionControls = {};
  private initialSessionControls: OmpSessionControls | undefined;

  constructor(
    private readonly options: OmpRpcSessionOptions,
    private readonly forwardToolCall: ToolCallForwarder,
    private readonly onEvent: OmpSessionEventHandler,
    private readonly onDone: OmpSessionDoneHandler,
  ) {}

  getIsCompacting(): boolean {
    return this.isCompacting;
  }

  getLiveModel(): OmpRpcSessionState["model"] | undefined {
    return this.liveModel;
  }

  getFastModeEnabled(): boolean {
    return this.fastModeEnabled;
  }

  getLiveState(): OmpRpcSessionState | undefined {
    return this.liveState;
  }

  getThinkingSelection(): z.infer<typeof thinkingLevelChangedSchema> {
    return this.thinkingSelection;
  }

  getSessionControls(): OmpSessionControls {
    return this.liveSessionControls;
  }

  getInitialSessionControls(): OmpSessionControls {
    return this.initialSessionControls ?? {};
  }

  async refreshConfiguration(event: Record<string, unknown>): Promise<OmpRpcSessionState> {
    if (event.type === "thinking_level_changed") {
      this.thinkingSelection = thinkingLevelChangedSchema.parse(event);
    }
    return await this.getState();
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getFileRoots(): { artifactsDir: string; localDir: string } | undefined {
    return this.fileRoots;
  }

  getContextUsage(): { tokens: number | null; contextWindow: number; cost: number } | null {
    return this.lastContextUsage;
  }

  getSessionStats(): OmpSessionStats | undefined {
    return this.sessionStats;
  }

  respondToExtensionUi(id: string | number, fields: Record<string, unknown>): void {
    this.child?.respondToExtensionUi(id, fields);
  }

  async start(): Promise<void> {
    await runOmpTransientAuthConstruction({
      attempt: () => this.spawnAndVerify(),
      discardFailedAttempt: () => {
        this.options.onExtensionUiReset?.();
        const failed = this.child;
        this.child = undefined;
        failed?.kill();
      },
      isClosed: () => this.closed,
      waitBeforeRetry: waitForOmpTransientAuthRetry,
    });
  }

  private async spawnAndVerify(): Promise<OmpSessionConstructionOutcome> {
    mkdirSync(this.options.sessionDir, { recursive: true });
    mkdirSync(this.options.scratchDir, { recursive: true });
    this.liveState = undefined;
    this.thinkingSelection = {};
    this.liveSessionControls = {};
    this.initialSessionControls = undefined;
    const env = buildOmpChildEnv(this.options.shellEnvOverrides ?? {});
    const promptFiles = this.writePromptFiles();
    const args = [
      "--mode", "rpc-ui", "--cwd", this.options.cwd,
      "--session-dir", this.options.sessionDir, "--continue",
      ...promptFiles.args,
    ];
    const configOverlay = await this.writeConfigOverlay(env);
    args.push("--config", configOverlay);
    promptFiles.paths.push(configOverlay);
    if (this.options.model) {
      // The registry-derived provider/id selector also identifies custom providers.
      args.push("--model", `${this.options.model.provider}/${this.options.model.id}`);
    }
    if (this.options.thinkingLevel) args.push("--thinking", this.options.thinkingLevel);
    this.options.onExtensionUiReset?.();
    const child = new OmpRpcChild({
      cwd: this.options.cwd,
      env,
      args,
      onEvent: (event) => {
        if (child === this.child) this.handleEvent(event);
      },
      onExit: (info) => {
        for (const file of promptFiles.paths) rmSync(file, { force: true });
        if (child === this.child) {
          void this.deliverInOrder(() => {
            if (child === this.child) this.options.onExtensionUiReset?.();
          });
          this.handleExit(info);
        }
      },
      recordThreadId: this.options.recordThreadId,
      onExtensionUiRequest: this.options.onExtensionUiRequest
        ? (request) => {
            // A single stdout chunk can contain agent_start and a notice.
            // Deliver both through one queue so the notice gets the right turn.
            void this.deliverInOrder(() => {
              if (child === this.child) this.options.onExtensionUiRequest?.(request);
            });
          }
        : undefined,
    });
    this.child = child;
    await child.ready;
    await child.requestOk({
      type: "set_host_tools",
      tools: (this.options.dynamicTools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        loadMode: "essential",
      })),
    });
    await child.requestOk({ type: "set_event_filter", events: null, messageUpdates: "delta" });
    await child.requestOk({ type: "set_subagent_subscription", level: "events" });
    await child.requestOk({ type: "set_ask_dialog", enabled: true });
    const state = await this.getState();
    if (state.model?.provider === "unknown") {
      return { ok: false, error: new Error("OMP has no authenticated model provider available.") };
    }
    const wanted = this.options.model;
    if (wanted && (state.model?.provider !== wanted.provider || state.model.id !== wanted.id)) {
      return {
        ok: false,
        error: new Error(
          `OMP did not start with model "${wanted.provider}/${wanted.id}"` +
          (state.model?.id ? ` (it chose "${String(state.model.provider)}/${state.model.id}")` : "") +
          ". Check that the provider is authenticated.",
        ),
      };
    }
    const fastModeEnabled = this.options.fastModeEnabled;
    if (fastModeEnabled !== undefined && state.fastModeEnabled !== fastModeEnabled) {
      await this.setFastMode(fastModeEnabled);
    }
    await this.applySessionControls(this.options.sessionControls ?? {});
    await this.refreshContextUsage();
    return { ok: true };
  }

  async getState(timeoutMs?: number): Promise<OmpRpcSessionState> {
    const data = await this.requireChild().requestOk({ type: "get_state" }, timeoutMs);
    const state = sessionStateSchema.parse(data);
    this.liveState = state;
    this.liveSessionControls = {
      ...this.liveSessionControls,
      ...(state.steeringMode === undefined ? {} : { steeringMode: state.steeringMode }),
      ...(state.followUpMode === undefined ? {} : { followUpMode: state.followUpMode }),
      ...(state.interruptMode === undefined ? {} : { interruptMode: state.interruptMode }),
      ...(state.autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled: state.autoCompactionEnabled }),
    };
    if (state.slowModeSupported) {
      this.liveSessionControls.slowModeEnabled = state.slowModeEnabled;
    } else {
      delete this.liveSessionControls.slowModeEnabled;
    }
    // Preserve the user's native defaults before startup applies BB's choices.
    this.initialSessionControls ??= { ...this.liveSessionControls };
    this.liveModel = state.model;
    this.fastModeEnabled = state.fastModeEnabled ?? false;
    if (this.sessionFile !== state.sessionFile || !this.fileRoots) {
      this.sessionFile = state.sessionFile;
      this.fileRoots = undefined;
      if (state.sessionFile) {
        const artifactsDir = getOmpArtifactsDir(state.sessionFile);
        const threadStorageDir = this.options.shellEnvOverrides?.BB_THREAD_STORAGE;
        const linked = threadStorageDir
          ? ensureLocalThreadStorageLink({ artifactsDir, threadStorageDir })
          : false;
        this.fileRoots = {
          artifactsDir,
          localDir: linked && threadStorageDir
            ? resolve(threadStorageDir, "local")
            : join(artifactsDir, "local"),
        };
      }
    }
    return state;
  }

  async setSessionName(name: string): Promise<void> {
    await this.requireChild().requestOk({ type: "set_session_name", name });
  }

  async getAvailableCommands(): Promise<OmpAvailableCommand[]> {
    const data = await this.requireChild().requestOk({ type: "get_available_commands" });
    return z.object({ commands: ompAvailableCommandsSchema }).parse(data).commands;
  }

  async askBtw(question: string, recordId?: string): Promise<OmpBtwRecord> {
    try {
      const data = await this.requireChild().requestOk({
        type: "btw", question, ...(recordId === undefined ? {} : { recordId }),
      });
      return z.object({ record: ompBtwRecordSchema }).parse(data).record;
    } finally {
      // A cancellation while starting can emit the authoritative terminal
      // record before rejecting this request. Deliver that record first.
      await this.deliveryChain;
    }
  }

  async cancelBtw(recordId?: string): Promise<boolean> {
    const data = await this.requireChild().requestOk({
      type: "btw_cancel", ...(recordId === undefined ? {} : { recordId }),
    });
    return z.object({ cancelled: z.boolean() }).parse(data).cancelled;
  }

  async getBtwHistory(): Promise<OmpBtwRecord[]> {
    const data = await this.requireChild().requestOk({ type: "get_btw_history" });
    return z.object({ records: z.array(ompBtwRecordSchema) }).parse(data).records;
  }

  async bash(command: string): Promise<OmpBashResult> {
    const data = await this.requireChild().requestOk({ type: "bash", command }, NO_REQUEST_TIMEOUT);
    return bashResultSchema.parse(data);
  }

  async abortBash(): Promise<void> {
    await this.requireChild().requestOk({ type: "abort_bash" });
  }

  async removeQueuedMessage(message: string, queue: OmpInputQueue): Promise<boolean> {
    const data = await this.requireChild().requestOk({ type: "remove_queued_message", message, queue });
    return z.object({ removed: z.boolean() }).parse(data).removed;
  }

  async promoteQueuedMessage(message: string): Promise<boolean> {
    const pending = this.pendingInputConsumptions.find(
      (entry) => entry.queue === "followUp" && entry.queuedText === message,
    );
    if (pending) this.pendingQueuePromotions.add(pending);
    try {
      const data = await this.requireChild().requestOk({ type: "promote_queued_message", message });
      return z.object({ promoted: z.boolean() }).parse(data).promoted;
    } finally {
      if (pending) this.pendingQueuePromotions.delete(pending);
    }
  }

  async abortAndRestoreQueue(): Promise<z.infer<typeof restoredQueueSchema>> {
    if (this.activity) this.activity.interrupted = true;
    if (this.isCompacting) this.compactionInterrupted = true;
    const data = await this.requireChild().requestOk({ type: "abort_and_restore_queue" });
    await this.deliveryChain;
    return restoredQueueSchema.parse(data);
  }

  async getLoginProviders(): Promise<z.infer<typeof loginProvidersSchema>> {
    const data = await this.requireChild().requestOk({ type: "get_login_providers" });
    return z.object({ providers: loginProvidersSchema }).parse(data).providers;
  }

  async login(providerId: string): Promise<void> {
    const data = await this.requireChild().requestOk({ type: "login", providerId }, NO_REQUEST_TIMEOUT);
    z.object({ providerId: z.string() }).parse(data);
  }

  async getLogoutAccounts(providerId: string): Promise<z.infer<typeof logoutAccountsSchema>> {
    const data = await this.requireChild().requestOk({ type: "get_logout_accounts", providerId });
    return z.object({ accounts: logoutAccountsSchema }).parse(data).accounts;
  }

  async logout(providerId: string, credentialId: number): Promise<{ remainingSource?: string }> {
    const data = await this.requireChild().requestOk({ type: "logout", providerId, credentialId });
    return z.object({ remainingSource: z.string().optional() }).parse(data);
  }

  async exportHtml(outputPath?: string): Promise<string> {
    const data = await this.requireChild().requestOk({
      type: "export_html",
      ...(outputPath === undefined ? {} : { outputPath }),
    });
    return resolve(this.options.cwd, z.object({ path: z.string() }).parse(data).path);
  }

  async getSubagents(): Promise<OmpSubagentSnapshot[]> {
    const data = await this.requireChild().requestOk({ type: "get_subagents" });
    return z.object({ subagents: z.array(ompSubagentSnapshotSchema) }).parse(data).subagents;
  }

  async getSubagentMessages(params: {
    subagentId?: string;
    sessionFile?: string;
    fromByte?: number;
  }): Promise<OmpSubagentMessages> {
    const data = await this.requireChild().requestOk({ type: "get_subagent_messages", ...params });
    return ompSubagentMessagesSchema.parse(data);
  }

  async cancelSubagent(subagentId: string): Promise<boolean> {
    const data = await this.requireChild().requestOk({ type: "cancel_subagent", subagentId });
    return z.object({ cancelled: z.boolean() }).parse(data).cancelled;
  }

  async steerSubagent(subagentId: string, message: string): Promise<void> {
    await this.requireChild().requestOk({ type: "steer_subagent", subagentId, message });
  }

  async setModel(model: { provider: string; id: string }): Promise<void> {
    await this.requireChild().requestOk({ type: "set_model", provider: model.provider, modelId: model.id });
    await this.getState();
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingSelection = {};
    await this.requireChild().requestOk({ type: "set_thinking_level", level });
    await this.getState();
  }

  async setFastMode(enabled: boolean): Promise<void> {
    await this.requireChild().requestOk({ type: "set_fast_mode", enabled });
    await this.getState();
  }

  async getGoal(): Promise<OmpGoalResult> {
    return await this.requestGoal({ op: "get" });
  }

  async createGoal(objective: string, tokenBudget?: number): Promise<OmpGoalResult> {
    return await this.requestGoal({
      op: "create",
      objective,
      ...(tokenBudget === undefined ? {} : { token_budget: tokenBudget }),
    });
  }

  async resumeGoal(): Promise<OmpGoalResult> {
    return await this.requestGoal({ op: "resume" });
  }

  async pauseGoal(): Promise<OmpGoalResult> {
    return await this.requestGoal({ op: "pause" });
  }

  async dropGoal(): Promise<OmpGoalResult> {
    return await this.requestGoal({ op: "drop" });
  }

  private async requestGoal(command: {
    op: "get" | "create" | "resume" | "pause" | "drop";
    objective?: string;
    token_budget?: number;
  }): Promise<OmpGoalResult> {
    const data = await this.requireChild().requestOk({ type: "goal", ...command });
    const result = goalResultSchema.parse(data);
    if (this.liveState) this.liveState = { ...this.liveState, goal: result.state };
    return result;
  }

  async setSteeringMode(mode: NonNullable<OmpSessionControls["steeringMode"]>): Promise<void> {
    await this.requireChild().requestOk({ type: "set_steering_mode", mode });
    this.liveSessionControls.steeringMode = mode;
    if (this.liveState) this.liveState.steeringMode = mode;
  }

  async setFollowUpMode(mode: NonNullable<OmpSessionControls["followUpMode"]>): Promise<void> {
    await this.requireChild().requestOk({ type: "set_follow_up_mode", mode });
    this.liveSessionControls.followUpMode = mode;
    if (this.liveState) this.liveState.followUpMode = mode;
  }

  async setInterruptMode(mode: NonNullable<OmpSessionControls["interruptMode"]>): Promise<void> {
    await this.requireChild().requestOk({ type: "set_interrupt_mode", mode });
    this.liveSessionControls.interruptMode = mode;
    if (this.liveState) this.liveState.interruptMode = mode;
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.requireChild().requestOk({ type: "set_auto_compaction", enabled });
    this.liveSessionControls.autoCompactionEnabled = enabled;
    if (this.liveState) this.liveState.autoCompactionEnabled = enabled;
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.requireChild().requestOk({ type: "set_auto_retry", enabled });
    this.liveSessionControls.autoRetryEnabled = enabled;
  }

  async setCacheWarming(mode: NonNullable<OmpSessionControls["cacheWarmingMode"]>): Promise<void> {
    const data = await this.requireChild().requestOk({ type: "set_cache_warming", mode });
    this.liveSessionControls.cacheWarmingMode = cacheWarmingResultSchema.parse(data).mode;
  }

  async setSlowMode(enabled: boolean): Promise<void> {
    if (!this.liveState?.slowModeSupported) {
      throw new Error(
        "Slow mode is not supported by the active OMP model. Choose Native or select a model that supports slow mode.",
      );
    }
    await this.requireChild().requestOk({ type: "set_slow_mode", enabled });
    await this.getState();
  }

  async applySessionControls(controls: OmpSessionControls): Promise<void> {
    const current = this.liveSessionControls;
    if (controls.slowModeEnabled !== undefined) {
      if (!this.liveState?.slowModeSupported ||
          controls.slowModeEnabled !== current.slowModeEnabled) {
        await this.setSlowMode(controls.slowModeEnabled);
      }
    }
    if (controls.steeringMode !== undefined && controls.steeringMode !== current.steeringMode) {
      await this.setSteeringMode(controls.steeringMode);
    }
    if (controls.followUpMode !== undefined && controls.followUpMode !== current.followUpMode) {
      await this.setFollowUpMode(controls.followUpMode);
    }
    if (controls.interruptMode !== undefined && controls.interruptMode !== current.interruptMode) {
      await this.setInterruptMode(controls.interruptMode);
    }
    if (controls.autoCompactionEnabled !== undefined && controls.autoCompactionEnabled !== current.autoCompactionEnabled) {
      await this.setAutoCompaction(controls.autoCompactionEnabled);
    }
    if (controls.autoRetryEnabled !== undefined && controls.autoRetryEnabled !== current.autoRetryEnabled) {
      await this.setAutoRetry(controls.autoRetryEnabled);
    }
    if (controls.cacheWarmingMode !== undefined && controls.cacheWarmingMode !== current.cacheWarmingMode) {
      await this.setCacheWarming(controls.cacheWarmingMode);
    }
  }

  prompt(text: string, images?: ImageContent[]): OmpInputDispatch {
    const child = this.child;
    if (this.closed || !child || child.exited) {
      const consumed = Promise.reject(new Error("No active OMP session"));
      void consumed.catch(() => undefined);
      return { consumed, settled: Promise.resolve(null) };
    }
    const activity = this.ensureActivity();
    this.isProcessing = true;
    const tracked = this.trackPendingInputConsumption("followUp");
    const id = `bb-prompt-${++this.nextPromptId}`;
    const { promise: settled, resolve: settle } = Promise.withResolvers<OmpPromptRunOutcome | null>();
    const pending: PendingPrompt = { activity, input: tracked.pending, resolve: settle };
    activity.prompts.set(id, pending);
    this.prompts.set(id, pending);
    this.pendingPromptAcks.add(id);
    const command = {
      id,
      type: "prompt",
      message: text,
      ...(images && images.length > 0 ? { images } : {}),
      streamingBehavior: "followUp",
    };
    // Native commands and extensions can switch sessions between inputs. Keep
    // linked thread storage current before OMP admits another prompt.
    const dispatch = this.options.shellEnvOverrides?.BB_THREAD_STORAGE
      ? this.getState().then(() => this.dispatchWithTransientAuthRetry(child, command, NO_REQUEST_TIMEOUT))
      : this.dispatchWithTransientAuthRetry(child, command, NO_REQUEST_TIMEOUT);
    void dispatch.then(
      async (data) => {
        this.pendingPromptAcks.delete(id);
        if (pending.input.queuedText === null) this.resolvePendingInputConsumption(pending.input);
        if (promptAckSchema.parse(data)?.agentInvoked === false && this.prompts.has(id)) {
          this.removePrompt(id, pending);
          // Command output precedes this ack. Let the bridge render it before
          // refreshing local mutations and deciding who owns the turn boundary.
          await this.deliverInOrder(async () => {
            if (this.options.shellEnvOverrides?.BB_THREAD_STORAGE) {
              await this.getState().catch(() => undefined);
            }
            await this.refreshContextUsage().catch(() => undefined);
          });
          pending.resolve({
            localCommandDone: true,
            ...(activity.started ? { boundaryDelivered: true } : {}),
          });
          this.clearUnusedActivity(activity);
        }
      },
    ).catch(async (error: unknown) => {
      this.pendingPromptAcks.delete(id);
      this.rejectPendingInputConsumption(pending.input, asError(error));
      if (!this.prompts.has(id)) return;
      this.removePrompt(id, pending);
      await this.deliveryChain;
      pending.resolve({ ...(activity.started ? { boundaryDelivered: true } : {}), error });
      this.clearUnusedActivity(activity);
    });
    return { consumed: tracked.promise, settled };
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    const tracked = this.trackPendingInputConsumption("steering");
    try {
      await this.dispatchWithTransientAuthRetry(this.requireChild(), {
        type: "steer",
        message: text,
        ...(images && images.length > 0 ? { images } : {}),
      });
    } catch (error) {
      this.rejectPendingInputConsumption(tracked.pending, asError(error));
      throw error;
    }
    if (tracked.pending.queuedText === null) this.resolvePendingInputConsumption(tracked.pending);
    else void tracked.promise.catch((error: unknown) => this.onDone(error));
  }

  async compact(): Promise<OmpPromptRunOutcome> {
    const child = this.requireChild();
    if (this.isProcessing || (await this.getState()).isStreaming) {
      throw new Error("Cannot compact context while OMP is processing a turn");
    }
    this.isProcessing = true;
    this.isCompacting = true;
    this.compactionInterrupted = false;
    await this.deliverInOrder(() => this.onEvent({ type: "bb_compaction_start" }));
    let result: unknown;
    let error: unknown;
    try {
      result = await child.requestOk({ type: "compact" }, 10 * 60_000);
    } catch (cause) {
      error = cause;
    }
    await this.refreshContextUsage().catch(() => undefined);
    await this.deliverInOrder(() => this.onEvent({
      type: "bb_compaction_end",
      aborted: this.compactionInterrupted,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { errorMessage: asError(error).message }),
    }));
    this.isProcessing = false;
    this.isCompacting = false;
    return { boundaryDelivered: true, ...(error === undefined ? {} : { error }) };
  }

  async abort(): Promise<string | undefined> {
    if (this.activity) this.activity.interrupted = true;
    if (this.isCompacting) this.compactionInterrupted = true;
    await this.requireChild().requestOk({ type: "abort" });
    await this.deliveryChain;
    await this.refreshLeafId();
    return this.lastKnownLeafId ?? undefined;
  }

  async closeGracefully(timeoutMs: number): Promise<string | undefined> {
    const child = this.child;
    this.closed = true;
    this.cancelHostCalls();
    this.rejectPendingInputConsumptions("OMP session closed before input was consumed");
    if (!child || child.exited) return this.lastKnownLeafId ?? undefined;
    if (this.activity) this.activity.interrupted = true;
    if (this.isCompacting) this.compactionInterrupted = true;
    const deadline = Date.now() + timeoutMs;
    await child.request({ type: "abort" }, Math.max(1, Math.floor(timeoutMs / 2))).catch(() => undefined);
    await this.refreshLeafId(Math.max(1, deadline - Date.now())).catch(() => undefined);
    child.closeGracefully();
    this.isProcessing = false;
    this.isCompacting = false;
    return this.lastKnownLeafId ?? undefined;
  }

  async waitForExit(): Promise<void> {
    await this.child?.waitForExit();
  }

  kill(): void {
    this.closed = true;
    this.cancelHostCalls();
    this.child?.kill();
  }

  static async forkSessionFile(args: {
    sourceFile: string;
    targetDir: string;
    cwd: string;
    checkpointId?: string;
    recordThreadId: string;
    shellEnvOverrides?: Record<string, string>;
    sourceThreadStorageDir?: string;
  }): Promise<void> {
    mkdirSync(args.targetDir, { recursive: true });
    const overlayFile = join(args.targetDir, "bb-config-overlay.json");
    writeFileSync(overlayFile, JSON.stringify({ memory: { backend: "off" } }), "utf8");
    const child = new OmpRpcChild({
      cwd: args.cwd,
      env: buildOmpChildEnv({ ...args.shellEnvOverrides, BB_THREAD_ID: args.recordThreadId }),
      args: [
        "--mode", "rpc", "--cwd", args.cwd,
        "--fork", args.sourceFile, "--session-dir", args.targetDir,
        "--config", overlayFile,
      ],
      onEvent: () => undefined,
      onExit: () => undefined,
      recordThreadId: args.recordThreadId,
    });
    let bootstrapFile: string | undefined;
    let finalFile: string | undefined;
    try {
      await child.ready;
      const initial = sessionStateSchema.parse(await child.requestOk({ type: "get_state" }));
      bootstrapFile = initial.sessionFile;
      if (!bootstrapFile || resolve(args.sourceFile) === resolve(bootstrapFile)) {
        throw new Error("OMP did not create a forked session file");
      }
      if (resolve(dirname(bootstrapFile)) !== resolve(args.targetDir)) {
        throw new Error("OMP created the fork outside the target thread directory");
      }
      const threadStorageDir = args.shellEnvOverrides?.BB_THREAD_STORAGE;
      if (threadStorageDir) {
        ensureForkLocalThreadStorageLink({
          artifactsDir: getOmpArtifactsDir(bootstrapFile),
          threadStorageDir,
          sourceArtifactsDir: getOmpArtifactsDir(args.sourceFile),
          sourceThreadStorageDir: args.sourceThreadStorageDir,
        });
      }
      finalFile = bootstrapFile;
      if (args.checkpointId !== undefined) {
        const result = sessionChangeResultSchema.parse(await child.requestOk({ type: "fork", entryId: args.checkpointId }));
        if (result.cancelled) throw new Error("OMP session fork was cancelled");
        const state = sessionStateSchema.parse(await child.requestOk({ type: "get_state" }));
        finalFile = state.sessionFile;
        if (!finalFile || resolve(finalFile) === resolve(bootstrapFile)) {
          throw new Error("OMP did not create a checkpoint fork");
        }
      }
      if (resolve(dirname(finalFile)) !== resolve(args.targetDir)) {
        throw new Error("OMP created the fork outside the target thread directory");
      }
      if (threadStorageDir && finalFile !== bootstrapFile) {
        ensureLocalThreadStorageLink({
          artifactsDir: getOmpArtifactsDir(finalFile),
          threadStorageDir,
        });
      }
    } finally {
      child.closeGracefully();
      await child.waitForExit();
      if (bootstrapFile && finalFile && bootstrapFile !== finalFile) {
        rmSync(bootstrapFile, { force: true });
        if (bootstrapFile.endsWith(".jsonl")) {
          rmSync(bootstrapFile.slice(0, -6), { recursive: true, force: true });
        }
      }
    }
  }

  private requireChild(): OmpRpcChild {
    if (!this.child || this.child.exited || this.closed) throw new Error("No active OMP session");
    return this.child;
  }

  private writePromptFiles(): { args: string[]; paths: string[] } {
    const args: string[] = [];
    const paths: string[] = [];
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (this.options.systemPrompt !== undefined) {
      const file = join(this.options.scratchDir, `omp-system-${stamp}.md`);
      writeFileSync(file, this.options.systemPrompt, "utf8");
      args.push("--system-prompt", file);
      paths.push(file);
    }
    if (this.options.appendSystemPrompt !== undefined) {
      const file = join(this.options.scratchDir, `omp-append-${stamp}.md`);
      writeFileSync(file, this.options.appendSystemPrompt, "utf8");
      args.push("--append-system-prompt", file);
      paths.push(file);
    }
    return { args, paths };
  }

  /**
   * Skills, model presets, approvals, and the memory cutover share one per-child overlay.
   * Arrays need the user's effective skill directories carried over; omitted preset roles
   * need null tombstones so lower config layers cannot keep them assigned. BB-hosted
   * sessions always run with OMP's native memory backend off — durable memory is owned by
   * the bb memory-fork plugin, not OMP's Mnemopi store (BI-11 §4).
   */
  private async writeConfigOverlay(env: Readonly<Record<string, string | undefined>>): Promise<string> {
    const extra = this.options.additionalSkillPaths ?? [];
    const preset = this.options.modelPreset;
    const permissionPolicy = this.options.permissionPolicy;
    const overlay: {
      memory?: { backend: "off" };
      skills?: { customDirectories: string[] };
      modelRoles?: Record<string, string | null>;
      defaultThinkingLevel?: string;
      tools?: { approvalMode: "yolo" | "write" };
    } = { memory: { backend: "off" } };
    if (permissionPolicy) {
      overlay.tools = {
        approvalMode: permissionPolicy.permissionMode === "full" ? "yolo" : "write",
      };
    }
    if (extra.length > 0) {
      const existing = await resolveOmpCustomSkillDirectories({ homeDir: homedir(), cwd: this.options.cwd, env });
      overlay.skills = { customDirectories: [...new Set([...existing, ...extra.map((dir) => resolve(dir))])] };
    }
    if (preset) {
      const modelRoles: Record<string, string | null> = { ...preset.modelRoles };
      for (const role of Object.keys(this.options.effectiveModelRoles ?? {})) {
        if (!Object.hasOwn(modelRoles, role)) modelRoles[role] = null;
      }
      overlay.modelRoles = modelRoles;
      if (preset.defaultThinkingLevel !== undefined) {
        overlay.defaultThinkingLevel = preset.defaultThinkingLevel;
      }
    }
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const file = join(this.options.scratchDir, `omp-config-${stamp}.yml`);
    // JSON is valid YAML, and avoids quoting rules for arbitrary paths/selectors.
    writeFileSync(file, JSON.stringify(overlay), "utf8");
    return file;
  }

  private async dispatchWithTransientAuthRetry(
    child: OmpRpcChild,
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await child.requestOk(command, timeoutMs);
      } catch (error) {
        if (!(error instanceof Error) || error instanceof OmpRpcChildExitedError ||
          !error.message.startsWith("No API key found for ") || attempt >= OMP_TRANSIENT_AUTH_MAX_RETRIES) {
          throw error;
        }
        await waitForOmpTransientAuthRetry();
      }
    }
  }

  private ensureActivity(): SessionActivity {
    return this.activity ??= {
      started: false,
      finalizing: false,
      interrupted: false,
      run: 0,
      messages: [],
      reportedErrors: new Set(),
      prompts: new Map(),
    };
  }

  private handleEvent(raw: Record<string, unknown>): void {
    if (typeof raw.type !== "string") return;
    const event = raw as OmpRpcEvent;
    if (event.type === "host_tool_call") {
      this.handleHostToolCall(event);
      return;
    }
    if (event.type === "host_tool_cancel") {
      if (typeof event.targetId === "string") {
        const controller = this.hostCalls.get(event.targetId);
        this.hostCalls.delete(event.targetId);
        controller?.abort();
      }
      return;
    }
    if (event.type === "prompt_result") {
      this.handlePromptResult(event);
      return;
    }
    if (event.type === "session_settled") {
      if (this.activity) this.finishActivity(this.activity);
      return;
    }
    this.observeInputConsumption(event);
    if (event.type === "agent_start") {
      const activity = this.ensureActivity();
      activity.run++;
      activity.messages = [];
      activity.end = undefined;
      this.isProcessing = true;
      if (activity.started) return;
      activity.started = true;
    }
    if (event.type === "message_end" && this.activity &&
      event.message !== null && typeof event.message === "object" &&
      "role" in event.message && event.message.role === "assistant") {
      this.activity.messages.push({ ...event.message, messageId: event.messageId });
    }
    if (event.type === "agent_end") {
      const activity = this.ensureActivity();
      const messages = activity.messages.length > 0
        ? activity.messages
        : Array.isArray(event.messages) ? event.messages : [];
      activity.end = { ...event, messages };
      const delivered = { ...activity.end, deferSettlement: true };
      void this.deliverInOrder(() => this.onEvent(delivered));
      return;
    }
    if (event.type === "auto_compaction_end" && this.activity && event.willRetry !== true &&
      (event.aborted === true || typeof event.errorMessage === "string")) {
      const activity = this.activity;
      const message = activity.messages.at(-1);
      const stopReason = message !== null && typeof message === "object" && "stopReason" in message
        ? message.stopReason : undefined;
      if (stopReason === "error" || stopReason === "length" || stopReason === "aborted") {
        const detail = typeof event.errorMessage === "string" && event.errorMessage.trim()
          ? event.errorMessage : "Automatic context compaction was interrupted";
        activity.maintenanceFailure = { message: detail, run: activity.run };
        activity.reportedErrors.add(detail);
      }
    }
    if (event.type === "turn_end" || event.type === "auto_compaction_end") {
      void this.deliverInOrder(async () => {
        await this.refreshContextUsage().catch(() => undefined);
        await this.onEvent(event);
      });
      return;
    }
    if (event.type === "command_output") {
      const deferLocalBoundary = this.pendingPromptAcks.size > 0;
      void this.deliverInOrder(() => this.onEvent({ ...event, deferLocalBoundary }));
      return;
    }
    void this.deliverInOrder(() => this.onEvent(event));
  }

  private handlePromptResult(event: OmpRpcEvent): void {
    const id = typeof event.id === "string" ? event.id : undefined;
    const pending = id === undefined ? undefined : this.prompts.get(id);
    if (!pending) return;
    const activity = pending.activity;
    const parsed = promptResultSchema.safeParse(event);
    if (!parsed.success) {
      this.finishActivity(activity, new Error("OMP sent an invalid prompt_result"));
      return;
    }
    const result = parsed.data;
    pending.result = result;
    this.resolvePendingInputConsumption(pending.input);
    if (result.agentInvoked || !activity.started) activity.result = { value: result, run: activity.run };
    if (result.status !== "completed" && !activity.interrupted) {
      const message = activity.maintenanceFailure?.run === activity.run
        ? activity.maintenanceFailure.message : promptResultError(result);
      if (message && !activity.reportedErrors.has(message)) {
        activity.reportedErrors.add(message);
        void this.deliverInOrder(() => this.onEvent({
          type: "agent_end", messages: [], deferSettlement: true,
          settlementSuperseded: true, settlementError: message,
          ...(activity.maintenanceFailure?.run !== activity.run && result.status === "error"
            ? { settlementErrorInfo: result.error } : {}),
        }));
      }
    }
    // A detached job can wake the root later, but OMP has already yielded this
    // prompt. Give bb its boundary now; the later agent_start opens a new turn.
    if (result.sessionSettled || (result.agentInvoked &&
      activity.end?.yielded === true && activity.end.awaitingAsyncWork === true)) {
      this.finishActivity(activity);
    }
  }

  private finishActivity(activity: SessionActivity, protocolError?: Error): void {
    if (activity.finalizing) return;
    activity.finalizing = true;
    if (this.activity === activity) {
      this.activity = undefined;
      this.isProcessing = false;
    }
    const checkpoint = this.refreshLeafId().catch(() => null);
    const messages = activity.end?.messages ?? activity.messages;
    const result = activity.result?.run === activity.run ? activity.result.value : undefined;
    const maintenanceError = activity.maintenanceFailure?.run === activity.run
      ? activity.maintenanceFailure.message : undefined;
    const assistant = Array.isArray(messages) ? messages.findLast(
      (message: unknown): message is { role: "assistant"; stopReason?: unknown; errorMessage?: unknown } =>
        message !== null && typeof message === "object" && "role" in message && message.role === "assistant",
    ) : undefined;
    const resultError = result ? promptResultError(result) : undefined;
    const snapshotError = runSettlementError(messages);
    const assistantError = snapshotError && assistant?.stopReason === "error" &&
      (typeof assistant.errorMessage !== "string" || !assistant.errorMessage.trim())
      ? resultError ?? snapshotError : snapshotError;
    // A correlated result can arrive after a later run has already yielded.
    // Its failure belongs to that prompt; the latest snapshot owns the final boundary.
    const errorMessage = protocolError?.message ??
      (activity.interrupted ? undefined : maintenanceError ??
        (assistant ? assistantError : resultError));
    const errorInfo = errorMessage && !protocolError && !maintenanceError &&
      !activity.interrupted && result?.status === "error" ? result.error : undefined;
    void this.deliverInOrder(async () => {
      const leafId = await checkpoint;
      const boundaryDelivered = activity.started;
      if (boundaryDelivered) {
        await this.onEvent({
          type: "agent_end", messages, settlementOnly: true,
          ...(activity.interrupted ? { settlementStatus: "interrupted" } : {}),
          ...(errorMessage ? { settlementError: errorMessage } : {}),
          ...(errorInfo ? { settlementErrorInfo: errorInfo } : {}),
          ...(errorMessage && activity.reportedErrors.has(errorMessage) ? { settlementErrorReported: true } : {}),
          ...(leafId ? { providerCheckpointId: leafId } : {}),
        });
      }
      for (const [id, pending] of activity.prompts) {
        this.removePrompt(id, pending);
        const promptError = activity.interrupted ? undefined : pending.result && promptResultError(pending.result);
        pending.resolve({
          ...(boundaryDelivered ? { boundaryDelivered: true } : {}),
          ...((promptError ?? errorMessage) ? { error: new Error(promptError ?? errorMessage) } : {}),
        });
      }
      if (!this.activity) this.rejectPendingInputConsumptions("OMP turn ended before steer was consumed", "steering");
    });
  }

  private removePrompt(id: string, pending: PendingPrompt): void {
    this.prompts.delete(id);
    this.pendingPromptAcks.delete(id);
    pending.activity.prompts.delete(id);
  }

  private clearUnusedActivity(activity: SessionActivity): void {
    if (this.activity === activity && !activity.started && activity.prompts.size === 0) {
      this.activity = undefined;
      this.isProcessing = false;
    }
  }

  private handleHostToolCall(event: OmpRpcEvent): void {
    const child = this.child;
    const parsed = hostToolCallSchema.safeParse(event);
    if (!child || !parsed.success) return;
    const { id, toolName, arguments: toolArguments } = parsed.data;
    if (this.hostCalls.has(id)) return;
    const controller = new AbortController();
    this.hostCalls.set(id, controller);
    const stillPending = () => this.child === child && this.hostCalls.get(id) === controller && !controller.signal.aborted;
    void Promise.resolve().then(() => {
      if (!stillPending()) return;
      return this.forwardToolCall(toolName, toolArguments, {
        signal: controller.signal,
        onUpdate: (result) => {
          if (stillPending()) child.send({
            type: "host_tool_update", id,
            partialResult: { content: buildBridgeToolCallContent(result), details: {} },
          });
        },
      });
    }).then(
      (result) => {
        if (!result || !stillPending()) return;
        this.hostCalls.delete(id);
        child.send({
          type: "host_tool_result", id,
          result: { content: buildBridgeToolCallContent(result), details: {} },
          ...(result.isError ? { isError: true } : {}),
        });
      },
      (error: unknown) => {
        if (!stillPending()) return;
        this.hostCalls.delete(id);
        child.send({
          type: "host_tool_result", id, isError: true,
          result: { content: [{ type: "text", text: asError(error).message }], details: {} },
        });
      },
    );
  }

  private cancelHostCalls(): void {
    const controllers = [...this.hostCalls.values()];
    this.hostCalls.clear();
    for (const controller of controllers) controller.abort();
  }

  private deliverInOrder(deliver: () => void | Promise<void>): Promise<void> {
    const next = this.deliveryChain.then(deliver, deliver);
    this.deliveryChain = next.catch((error: unknown) => this.onDone(error));
    return this.deliveryChain;
  }

  private async refreshLeafId(timeoutMs = LEAF_REQUEST_TIMEOUT_MS): Promise<string | null> {
    const child = this.child;
    if (!child || child.exited) return this.lastKnownLeafId;
    const data = treeResultSchema.parse(await child.requestOk({ type: "get_tree" }, timeoutMs));
    if (data.leafId === null) return this.lastKnownLeafId = null;
    // Native fork accepts message entries, not bookkeeping leaves such as model_usage.
    const pending: [unknown, string | null][] = data.tree.map((node) => [node, null]);
    while (pending.length > 0) {
      const [raw, ancestor] = pending.pop()!;
      const { entry, children } = treeNodeSchema.parse(raw);
      const checkpoint = entry.type === "message" ? entry.id : ancestor;
      if (entry.id === data.leafId) return this.lastKnownLeafId = checkpoint;
      for (const node of children) pending.push([node, checkpoint]);
    }
    throw new Error("OMP get_tree leaf is missing from its session tree");
  }

  private async refreshContextUsage(): Promise<void> {
    const child = this.child;
    if (!child || child.exited) return;
    const data = ompSessionStatsSchema.parse(await child.requestOk({ type: "get_session_stats" }));
    const initial = this.sessionStats === undefined;
    this.sessionStats = data;
    const usage = data.contextUsage;
    if (usage && typeof usage.contextWindow === "number") this.lastContextUsage = {
      tokens: typeof usage.tokens === "number" ? usage.tokens : null,
      contextWindow: usage.contextWindow,
      cost: data.cost,
    };
    await this.onEvent({
      type: "bb_session_stats",
      stats: data,
      initial,
      modelContextWindow: this.liveModel?.contextWindow,
    });
  }

  private handleExit(info: OmpRpcChildExitInfo): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.cancelHostCalls();
    this.rejectPendingInputConsumptions("OMP exited before input was consumed");
    const error = new OmpRpcChildExitedError(info);
    const turnHandled = this.activity !== undefined || this.prompts.size > 0;
    if (wasClosed) {
      for (const [id, pending] of this.prompts) {
        this.removePrompt(id, pending);
        pending.resolve(null);
      }
      this.activity = undefined;
    } else if (this.activity) {
      this.finishActivity(this.activity, error);
    }
    this.isProcessing = false;
    this.isCompacting = false;
    if (!wasClosed) this.onDone(error, turnHandled);
  }

  private trackPendingInputConsumption(queue: OmpInputQueue): {
    pending: PendingInputConsumption;
    promise: Promise<void>;
  } {
    const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers<void>();
    const pending: PendingInputConsumption = {
      queue, queuedText: null, resolve: resolvePromise, reject: rejectPromise,
    };
    this.pendingInputConsumptions.push(pending);
    void promise.catch(() => undefined);
    return { pending, promise };
  }

  private observeInputConsumption(event: OmpRpcEvent): void {
    if (event.type !== "queue_update") return;
    const parsed = queueUpdateSchema.safeParse(event);
    if (!parsed.success) return;
    if (this.pendingQueuePromotions.size > 0) {
      const addedSteering = listMultisetDifference(parsed.data.steering, this.lastObservedQueues.steering);
      const removedFollowUp = listMultisetDifference(this.lastObservedQueues.followUp, parsed.data.followUp);
      for (const text of addedSteering) {
        const removedIndex = removedFollowUp.indexOf(text);
        if (removedIndex < 0) continue;
        const pending = [...this.pendingQueuePromotions].find((entry) => entry.queuedText === text);
        if (!pending) continue;
        // Only an observed atomic queue move is promotion, not a concurrent
        // follow-up consumption that happened before the RPC could promote it.
        pending.queue = "steering";
        this.pendingQueuePromotions.delete(pending);
        removedFollowUp.splice(removedIndex, 1);
      }
    }
    this.observeQueue("steering", parsed.data.steering);
    this.observeQueue("followUp", parsed.data.followUp);
  }

  private observeQueue(queue: OmpInputQueue, queuedTexts: readonly string[]): void {
    const lastObserved = this.lastObservedQueues[queue];
    const added = listMultisetDifference(queuedTexts, lastObserved);
    const removed = listMultisetDifference(lastObserved, queuedTexts);
    this.lastObservedQueues[queue] = [...queuedTexts];
    for (const queuedText of added) {
      const pending = this.pendingInputConsumptions.find((entry) => entry.queue === queue && entry.queuedText === null);
      if (!pending) break;
      pending.queuedText = queuedText;
    }
    for (const queuedText of removed) {
      const pending = this.pendingInputConsumptions.find((entry) => entry.queue === queue && entry.queuedText === queuedText);
      if (pending) this.resolvePendingInputConsumption(pending);
    }
  }

  private resolvePendingInputConsumption(pending: PendingInputConsumption): void {
    const index = this.pendingInputConsumptions.indexOf(pending);
    if (index === -1) return;
    this.pendingInputConsumptions.splice(index, 1);
    this.pendingQueuePromotions.delete(pending);
    pending.resolve();
  }

  private rejectPendingInputConsumption(pending: PendingInputConsumption, error: Error): void {
    const index = this.pendingInputConsumptions.indexOf(pending);
    if (index === -1) return;
    this.pendingInputConsumptions.splice(index, 1);
    this.pendingQueuePromotions.delete(pending);
    pending.reject(error);
  }

  private rejectPendingInputConsumptions(message: string, queue?: OmpInputQueue): void {
    for (const pending of [...this.pendingInputConsumptions]) {
      if (queue === undefined || pending.queue === queue) this.rejectPendingInputConsumption(pending, new Error(message));
    }
  }
}

function promptResultError(result: PromptResult): string | undefined {
  if (result.status === "aborted") return "OMP run interrupted unexpectedly; no automatic resume was attempted";
  if (result.status === "error") return result.error?.message.trim() || "OMP run failed";
  return undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function listMultisetDifference(source: readonly string[], subtract: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of subtract) counts.set(value, (counts.get(value) ?? 0) + 1);
  return source.filter((value) => {
    const count = counts.get(value) ?? 0;
    if (count === 0) return true;
    counts.set(value, count - 1);
    return false;
  });
}
