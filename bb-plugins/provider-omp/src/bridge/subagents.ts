import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  LOCAL_WORKFLOW_TASK_TYPE,
  type DeltaBackgroundTaskShape,
  type DeltaItemShape,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  createOmpDeltaTranslator,
  type OmpDeltaTranslationContext,
  type OmpDeltaTranslator,
  type OmpModelContextWindowResolver,
} from "../delta-translation.js";
import type { OmpRpcSession } from "./rpc-session.js";
import {
  OMP_AGENTS_ROSTER_LIMIT,
  OMP_AGENTS_STATE_KIND,
  ompAgentDetailsDirective,
  type OmpAgentsState,
  type OmpHubAgent,
} from "../hub-contract.js";

const statusSchema = z.enum(["pending", "running", "completed", "failed", "aborted"]);
export const ompSubagentProgressSchema = z.object({
  id: z.string(),
  index: z.number(),
  agent: z.string(),
  status: statusSchema,
  task: z.string().optional(),
  assignment: z.string().optional(),
  description: z.string().optional(),
  resolvedModel: z.string().optional(),
  resolvedModelIdentity: z.string().optional(),
  modelRole: z.string().optional(),
  cost: z.number().optional(),
  retryState: z.object({
    attempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorMessage: z.string(),
    startedAtMs: z.number(),
  }).optional(),
  currentTool: z.string().optional(),
  currentToolIntent: z.string().optional(),
  lastIntent: z.string().optional(),
  toolCount: z.number().optional(),
  tokens: z.number().optional(),
  durationMs: z.number().optional(),
  recentOutput: z.array(z.string()).optional(),
  recentTools: z.array(z.object({
    tool: z.string(),
    intent: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();
export const ompSubagentSnapshotSchema = z.object({
  id: z.string(),
  index: z.number(),
  agent: z.string(),
  status: statusSchema,
  lastUpdate: z.number(),
  description: z.string().optional(),
  task: z.string().optional(),
  assignment: z.string().optional(),
  parentToolCallId: z.string().optional(),
  sessionFile: z.string().optional(),
  progress: ompSubagentProgressSchema.optional(),
  detached: z.boolean().optional(),
}).passthrough();
export const ompSubagentMessagesSchema = z.object({
  sessionFile: z.string(),
  fromByte: z.number().nonnegative(),
  nextByte: z.number().nonnegative(),
  reset: z.boolean(),
  entries: z.array(z.record(z.string(), z.unknown())),
  messages: z.array(z.record(z.string(), z.unknown())),
});
export type OmpSubagentSnapshot = z.infer<typeof ompSubagentSnapshotSchema>;
export type OmpSubagentMessages = z.infer<typeof ompSubagentMessagesSchema>;
type Progress = z.infer<typeof ompSubagentProgressSchema>;
type Status = z.infer<typeof statusSchema>;
type Delegation = Extract<DeltaItemShape, { type: "delegation" }>;
type Rpc = Pick<OmpRpcSession, "getSubagents" | "getSubagentMessages" | "cancelSubagent" | "steerSubagent">;

const lifecycleSchema = z.object({
  id: z.string(),
  index: z.number(),
  agent: z.string(),
  status: z.enum(["started", "completed", "failed", "aborted"]),
  description: z.string().optional(),
  parentToolCallId: z.string().optional(),
  sessionFile: z.string().optional(),
  detached: z.boolean().optional(),
});
const progressPayloadSchema = z.object({
  progress: ompSubagentProgressSchema,
  parentToolCallId: z.string().optional(),
  sessionFile: z.string().optional(),
  detached: z.boolean().optional(),
});
const resultSchema = z.object({
  id: z.string(),
  index: z.number(),
  agent: z.string(),
  task: z.string().optional(),
  assignment: z.string().optional(),
  description: z.string().optional(),
  output: z.string(),
  error: z.string().optional(),
  stderr: z.string().optional(),
  aborted: z.boolean().optional(),
  exitCode: z.number(),
  tokens: z.number().optional(),
  durationMs: z.number().optional(),
  resolvedModel: z.string().optional(),
  resolvedModelIdentity: z.string().optional(),
  modelRole: z.string().optional(),
  usage: z.object({
    cost: z.object({ total: z.number() }).passthrough(),
  }).passthrough().optional(),
}).passthrough();
type Result = z.infer<typeof resultSchema>;

interface SpawnRequest {
  task?: string;
  assignment?: string;
  description?: string;
  name?: string;
}
interface ParentTask {
  requests: SpawnRequest[];
  ended: boolean;
}
interface TranscriptMessage {
  logicalKey: string;
  startKey: string;
  fingerprint: string;
  key: string;
  entryId?: string;
  live: boolean;
}
interface Agent {
  id: string;
  index: number;
  agent: string;
  status: Status;
  description?: string;
  task?: string;
  assignment?: string;
  parentToolCallId?: string;
  parentAgent?: Agent;
  sessionFile?: string;
  detached: boolean;
  progress?: Progress;
  result?: Result;
  output?: string;
  error?: string;
  lastUpdate: number;
  transcriptModel?: string;
  transcriptTokens: number;
  opened: boolean;
  closed: boolean;
  finalMessageEmitted: boolean;
  closedFallbackOutput?: string;
  nextByte: number;
  seenEntries: Set<string>;
  messages: TranscriptMessage[];
  startedTools: Set<string>;
  endedTools: Set<string>;
  messageNumber: number;
  activeMessage?: { startKey: string; key: string; settled: boolean };
  translator: OmpDeltaTranslator;
}
interface Workflow {
  familyId: string;
  agents: Set<Agent>;
  opened: boolean;
  closed: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}
function terminal(status: Status): boolean {
  return status !== "pending" && status !== "running";
}
function itemStatus(status: Status): "pending" | "completed" | "failed" | "interrupted" {
  return status === "aborted" ? "interrupted" : terminal(status) ? status as "completed" | "failed" : "pending";
}
function maxCounter(current: number | undefined, previous: number | undefined): number | undefined {
  return current === undefined ? previous : previous === undefined ? current : Math.max(current, previous);
}
function messageStartKey(message: Record<string, unknown>): string {
  return JSON.stringify([message.role, message.timestamp]);
}
function messageLogicalKey(message: Record<string, unknown>): string {
  return JSON.stringify([
    messageStartKey(message), message.provider, message.model, message.responseId,
    message.stopReason, message.toolCallId, message.toolName,
  ]);
}
function fingerprint(message: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    message.role, message.timestamp, message.toolCallId, message.content,
    message.isError, message.errorMessage,
  ])).digest("hex");
}

export interface OmpSubagentCoordinator {
  restore(): Promise<void>;
  onTurnStart(): Promise<void>;
  handleEvent(event: Record<string, unknown>): Promise<boolean>;
  stopTask(taskId: string): Promise<void>;
  steer(subagentId: string, message: string): Promise<void>;
  interrupt(reason: string): Promise<void>;
  stop(reason: string): void;
}

export function createOmpSubagentCoordinator(options: {
  rpc: Rpc;
  sessionRef: string;
  cwd: string;
  resolveModelContextWindow: OmpModelContextWindowResolver;
  getFileRoots?: () => OmpDeltaTranslationContext["fileRoots"];
  emit: (deltas: ThreadDelta[]) => void;
}): OmpSubagentCoordinator {
  // Unlike get_subagents, these maps intentionally retain terminal agents.
  const agents = new Map<string, Agent>();
  const parents = new Map<string, ParentTask>();
  const toolOwners = new Map<string, Agent>();
  const workflows = new Map<string, Workflow>();
  const pendingEvents = new Map<string, Record<string, unknown>[]>();
  let turnStarted = false;
  let stopped = false;
  let lastRoster: OmpAgentsState | undefined;
  let rosterTimer: NodeJS.Timeout | undefined;
  const ROSTER_MAX_BYTES = 48 * 1024;

  const providerId = (agent: Agent) => `omp-subagent:${options.sessionRef}:${agent.id}`;
  const transcriptTurn = (agent: Agent) => `${providerId(agent)}:transcript`;
  const key = (agent: Agent) => ({
    providerItemId: providerId(agent),
    ...(agent.parentAgent ? { parentRef: providerId(agent.parentAgent) } : {}),
  });
  const label = (agent: Agent, details?: string) => {
    const description = agent.description ?? agent.assignment ?? agent.task;
    const title = details ? `${agent.id} · ${details}` : agent.id;
    return description ? `${title}: ${description}`.slice(0, 240) : title;
  };
  const model = (agent: Agent) => agent.result?.resolvedModelIdentity ?? agent.result?.resolvedModel ??
    agent.progress?.resolvedModelIdentity ?? agent.progress?.resolvedModel ?? agent.transcriptModel;
  const modelLabel = (agent: Agent) => {
    const resolved = agent.result?.resolvedModel ?? agent.result?.resolvedModelIdentity ??
      agent.progress?.resolvedModel ?? model(agent);
    const role = agent.result?.modelRole ?? agent.progress?.modelRole;
    return resolved && role ? `${resolved} (${role})` : resolved;
  };
  const costLabel = (agent: Agent) => {
    const cost = agent.result?.usage?.cost.total ?? agent.progress?.cost;
    return cost === undefined ? undefined : `$${cost.toFixed(4)}`;
  };
  const retryLabel = (agent: Agent) => {
    const retry = !terminal(agent.status) ? agent.progress?.retryState : undefined;
    return retry ? `retrying ${retry.attempt}/${retry.maxAttempts}` : undefined;
  };

  function publishRoster(immediate = false): void {
    if (stopped || !agents.size) return;
    const sorted = [...agents.values()].sort((a, b) => a.index - b.index);
    const roster: OmpAgentsState = {
      agents: sorted.slice(-OMP_AGENTS_ROSTER_LIMIT).map((agent): OmpHubAgent => {
        const description = (agent.description ?? agent.assignment ?? agent.task)?.trim().slice(0, 240);
        const resolvedModel = model(agent);
        const modelRole = agent.result?.modelRole ?? agent.progress?.modelRole;
        const tokens = agent.result?.tokens ?? agent.progress?.tokens ?? agent.transcriptTokens;
        const cost = agent.result?.usage?.cost.total ?? agent.progress?.cost;
        const durationMs = agent.result?.durationMs ?? agent.progress?.durationMs;
        const currentTool = agent.progress?.currentTool?.slice(0, 120);
        const intent = (agent.progress?.currentToolIntent ?? agent.progress?.lastIntent)?.slice(0, 240);
        const error = (agent.result?.error || agent.error ||
          (agent.status === "failed" ? agent.result?.stderr : undefined))?.slice(0, 1_000);
        const retry = !terminal(agent.status) ? agent.progress?.retryState : undefined;
        const row: OmpHubAgent = {
          id: agent.id, agent: agent.agent,
          status: agent.status, detached: agent.detached,
          ...(agent.parentAgent ? { parentId: agent.parentAgent.id } : {}),
          ...(description ? { description } : {}),
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(modelRole ? { modelRole } : {}),
          tokens, toolCount: agent.progress?.toolCount ?? agent.endedTools.size,
          ...(cost === undefined ? {} : { cost }),
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(currentTool ? { currentTool } : {}),
          ...(intent ? { intent } : {}),
          ...(error ? { error } : {}),
          ...(retry ? { retry: { attempt: retry.attempt, maxAttempts: retry.maxAttempts } } : {}),
          lastUpdate: agent.lastUpdate,
        };
        const previous = lastRoster?.agents.find((entry) => entry.id === agent.id);
        // Replayed snapshots should not persist another event for a timestamp alone.
        return previous && isDeepStrictEqual({ ...row, lastUpdate: previous.lastUpdate }, previous)
          ? previous : row;
      }),
      ...(sorted.length > OMP_AGENTS_ROSTER_LIMIT ? { truncated: true } : {}),
    };
    // bb rejects extension payloads over 64 KiB; drop the oldest agents first.
    while (roster.agents.length > 1 &&
      Buffer.byteLength(JSON.stringify(roster), "utf8") > ROSTER_MAX_BYTES) {
      roster.agents.shift();
      roster.truncated = true;
    }
    if (isDeepStrictEqual(roster, lastRoster)) {
      clearTimeout(rosterTimer);
      rosterTimer = undefined;
      return;
    }
    immediate ||= !lastRoster || roster.agents.some((agent) =>
      lastRoster?.agents.find((previous) => previous.id === agent.id)?.status !== agent.status);
    if (!immediate) {
      rosterTimer ??= setTimeout(() => {
        rosterTimer = undefined;
        publishRoster(true);
      }, 2_000);
      rosterTimer.unref?.();
      return;
    }
    clearTimeout(rosterTimer);
    rosterTimer = undefined;
    lastRoster = roster;
    options.emit([{ kind: "extension.state", extensionKind: OMP_AGENTS_STATE_KIND, payload: roster }]);
  }
  const summary = (agent: Agent, includeOutput = true) => {
    const output = includeOutput ? agent.result?.output || agent.output : undefined;
    const error = agent.result?.error || agent.error ||
      (agent.status === "failed" ? agent.result?.stderr : undefined);
    const tokens = agent.result?.tokens ?? agent.progress?.tokens ??
      (agent.transcriptTokens > 0 ? agent.transcriptTokens : undefined);
    const duration = agent.result?.durationMs ?? agent.progress?.durationMs;
    const details = [
      modelLabel(agent),
      costLabel(agent),
      retryLabel(agent),
      ...(tokens === undefined ? [] : [`${tokens.toLocaleString("en-US")} tokens`]),
      ...(duration === undefined ? [] : [`${(duration / 1_000).toFixed(1)}s`]),
    ].filter(Boolean).join(" · ");
    const retry = !terminal(agent.status) ? agent.progress?.retryState : undefined;
    const retryDetail = retry
      ? `Retry wait: ${(retry.delayMs / 1_000).toFixed(1)}s. ${retry.errorMessage}`
      : undefined;
    return [output, error !== output ? error : undefined, details, retryDetail].filter(Boolean).join("\n\n");
  };
  const delegation = (agent: Agent): Delegation => {
    const agentSummary = `${summary(agent, !agent.finalMessageEmitted)}\n\n${ompAgentDetailsDirective(agent.id)}`;
    // BB only shows the label on collapsed cards; summary is the expanded body.
    const runningDetails = !terminal(agent.status)
      ? [modelLabel(agent), costLabel(agent), retryLabel(agent)].filter(Boolean).join(" · ")
      : undefined;
    return {
      type: "delegation", childRef: agent.id, label: label(agent, runningDetails), background: agent.detached,
      summary: agentSummary,
    };
  };

  function ensure(data: Partial<OmpSubagentSnapshot> & { id: string }): Agent {
    let agent = agents.get(data.id);
    if (!agent) {
      agent = {
        id: data.id, index: data.index ?? agents.size, agent: data.agent ?? "task",
        status: data.status ?? "running", detached: data.detached ?? false,
        lastUpdate: data.lastUpdate ?? Date.now(), opened: false, closed: false, finalMessageEmitted: false,
        transcriptTokens: 0, nextByte: 0, seenEntries: new Set(), messages: [],
        startedTools: new Set(), endedTools: new Set(), messageNumber: 0,
        translator: createOmpDeltaTranslator({ resolveModelContextWindow: options.resolveModelContextWindow }),
      };
      agents.set(data.id, agent);
    }
    // Copy only wire metadata; passthrough provider fields must never overwrite
    // our local transcript/deduplication state.
    if (data.index !== undefined) agent.index = data.index;
    if (data.agent !== undefined) agent.agent = data.agent;
    if (data.status !== undefined && !(terminal(agent.status) && !terminal(data.status)) &&
      !(agent.status === "running" && data.status === "pending")) agent.status = data.status;
    if (data.description !== undefined) agent.description = data.description;
    if (data.task !== undefined) agent.task = data.task;
    if (data.assignment !== undefined) agent.assignment = data.assignment;
    if (data.parentToolCallId !== undefined) agent.parentToolCallId = data.parentToolCallId;
    if (data.sessionFile !== undefined) agent.sessionFile = data.sessionFile;
    if (data.detached !== undefined) agent.detached = data.detached;
    if (data.progress !== undefined) {
      // TaskToolDetails can contain older/coarser snapshots than the dedicated
      // progress stream. Per-run counters must not go backwards between them.
      agent.progress = {
        ...data.progress,
        tokens: maxCounter(data.progress.tokens, agent.progress?.tokens),
        toolCount: maxCounter(data.progress.toolCount, agent.progress?.toolCount),
        cost: maxCounter(data.progress.cost, agent.progress?.cost),
        durationMs: maxCounter(data.progress.durationMs, agent.progress?.durationMs),
      };
    }
    agent.lastUpdate = data.lastUpdate ?? Date.now();
    if (agent.parentToolCallId) {
      agent.parentAgent = toolOwners.get(agent.parentToolCallId);
      const parent = parents.get(agent.parentToolCallId);
      const request = parent?.requests.find((entry) => entry.name === agent.id) ?? parent?.requests[agent.index];
      agent.task ??= request?.task;
      agent.description ??= request?.description;
      agent.assignment ??= request?.assignment;
    }
    if (agent.detached) workflowFor(agent);
    return agent;
  }

  function open(agent: Agent): void {
    if (agent.opened || stopped || !turnStarted) return;
    agent.opened = true;
    options.emit([
      { kind: "item.open", key: key(agent), item: delegation(agent), attach: "currentOrLast" },
      { kind: "turn.open", providerTurnId: transcriptTurn(agent), parentRef: providerId(agent) },
    ]);
    const pending = pendingEvents.get(agent.id);
    pendingEvents.delete(agent.id);
    for (const event of pending ?? []) childEvent(agent, event);
  }

  function workflowFor(agent: Agent): Workflow {
    const familyId = `omp-subagents:${options.sessionRef}:${agent.parentToolCallId ?? agent.id}`;
    let workflow = workflows.get(familyId);
    if (!workflow) {
      workflow = { familyId, agents: new Set(), opened: false, closed: false };
      workflows.set(familyId, workflow);
    }
    workflow.agents.add(agent);
    return workflow;
  }

  function backgroundShape(workflow: Workflow): DeltaBackgroundTaskShape {
    const children = [...workflow.agents].sort((a, b) => a.index - b.index);
    const finished = children.every((agent) => terminal(agent.status)) && children.every(
      (agent) => !agent.parentToolCallId || parents.get(agent.parentToolCallId)?.ended !== false,
    );
    const status = !finished ? "pending" : children.some((agent) => agent.status === "failed") ? "failed" :
      children.some((agent) => agent.status === "aborted") ? "interrupted" : "completed";
    return {
      type: "backgroundTask", familyId: workflow.familyId, taskType: LOCAL_WORKFLOW_TASK_TYPE,
      description: children.map((agent) => agent.id).join(", "),
      workflowName: "OMP subagents", status,
      taskStatus: !finished ? "running" : status === "interrupted" ? "stopped" : status,
      skipTranscript: false,
      workflow: {
        phases: [],
        agents: children.map((agent, index) => ({
          index: index + 1, label: label(agent),
          state: agent.status === "completed" ? "done" : agent.status === "failed" ? "failed" :
            agent.status === "aborted" ? "skipped" : agent.status === "pending" ? "queued" : "running",
          model: model(agent) ?? "unknown", attempt: 1, cached: false,
          agentType: agent.agent, lastProgressAt: agent.lastUpdate,
          ...(agent.task ? { promptPreview: agent.task } : {}),
          ...(agent.progress?.currentTool ? { lastToolName: agent.progress.currentTool } :
            agent.progress?.recentTools?.[0] ? { lastToolName: agent.progress.recentTools[0].tool } : {}),
          ...(agent.progress?.currentToolIntent ?? agent.progress?.lastIntent
            ? { lastToolSummary: agent.progress.currentToolIntent ?? agent.progress.lastIntent } : {}),
          ...(agent.result?.output || agent.output ? { resultPreview: agent.result?.output || agent.output } : {}),
          ...(agent.error || agent.result?.error ? { error: agent.error || agent.result?.error } : {}),
          tokens: agent.result?.tokens ?? agent.progress?.tokens ?? agent.transcriptTokens,
          toolCalls: agent.progress?.toolCount ?? agent.endedTools.size,
          durationMs: agent.result?.durationMs ?? agent.progress?.durationMs ?? 0,
        })),
      },
      usage: {
        totalTokens: children.reduce((sum, agent) => sum + (agent.result?.tokens ?? agent.progress?.tokens ?? agent.transcriptTokens), 0),
        toolUses: children.reduce((sum, agent) => sum + (agent.progress?.toolCount ?? agent.endedTools.size), 0),
        durationMs: Math.max(0, ...children.map((agent) => agent.result?.durationMs ?? agent.progress?.durationMs ?? 0)),
      },
      ...(finished ? { summary: children.map((agent) => `${agent.id}: ${summary(agent)}`).join("\n\n") } : {}),
    };
  }

  function updateWorkflow(agent: Agent): void {
    if (!agent.detached || stopped || !turnStarted) return;
    const workflow = workflowFor(agent);
    if (workflow.closed) return;
    const item = backgroundShape(workflow);
    const workflowKey = { providerItemId: workflow.familyId };
    if (!workflow.opened) {
      workflow.opened = true;
      options.emit([{ kind: "item.open", key: workflowKey, item, attach: "currentOrLast" }]);
    }
    const finished = [...workflow.agents].every((child) => child.closed) && item.status !== "pending";
    if (finished) {
      workflow.closed = true;
      options.emit([{ kind: "item.close", key: workflowKey, item, status: item.status }]);
    } else {
      options.emit([{ kind: "item.progress", key: workflowKey, snapshot: item }]);
    }
  }

  function close(agent: Agent, force = false): void {
    if (!terminal(agent.status) || agent.closed || !agent.opened) return;
    const parent = agent.parentToolCallId ? parents.get(agent.parentToolCallId) : undefined;
    // The spawning call may carry authoritative output/usage after lifecycle.
    // Even a detached child can finish before that initial task call returns.
    if (!force && parent && !parent.ended) return;
    agent.closed = true;
    agent.closedFallbackOutput = agent.finalMessageEmitted ? undefined : agent.result?.output || agent.output;
    options.emit([
      { kind: "item.close", key: key(agent), item: delegation(agent), status: itemStatus(agent.status) },
      { kind: "turn.boundary", providerTurnId: transcriptTurn(agent), status: itemStatus(agent.status) as "completed" | "failed" | "interrupted" },
    ]);
    updateWorkflow(agent);
  }

  function route(agent: Agent, event: Record<string, unknown>): boolean {
    const deltas = agent.translator.translate(event, {
      threadId: `${options.sessionRef}:${agent.id}`, parentToolCallId: providerId(agent), cwd: options.cwd,
      activeTurn: agent.opened && !agent.closed,
      fileRoots: options.getFileRoots?.(),
    });
    const nested: ThreadDelta[] = [];
    let assistantMessageEmitted = false;
    for (const delta of deltas) {
      switch (delta.kind) {
        case "item.open":
        case "item.close":
        case "item.progress":
        case "item.textDelta":
        case "item.textClose":
        case "item.outputDelta": {
          if (delta.kind === "item.textClose" && delta.channel === "agentMessage") assistantMessageEmitted = true;
          const original = delta.key;
          const stream = agent.activeMessage?.key ?? `message-${agent.messageNumber}`;
          nested.push({
            ...delta,
            key: {
              ...original,
              parentRef: providerId(agent),
              providerItemId: original.providerItemId
                ? `${providerId(agent)}:tool:${original.providerItemId}`
                : `${providerId(agent)}:${stream}:${original.channel ?? "message"}`,
            },
            providerTurnId: transcriptTurn(agent),
          });
          break;
        }
        case "command.outputSnapshot":
          nested.push({ ...delta, key: {
            ...delta.key, parentRef: providerId(agent),
            providerItemId: `${providerId(agent)}:tool:${delta.key.providerItemId}`,
          } });
          break;
        // Child turn boundaries, usage, errors, and context are not root-thread
        // state. Their terminal error and usage belong to the delegation/card.
      }
    }
    if (nested.length) options.emit(nested);
    return assistantMessageEmitted;
  }

  function finishMessage(
    agent: Agent,
    message: Record<string, unknown>,
    backfill: boolean,
    entryId?: string,
  ): void {
    // Tool starts may be missing even when their assistant message arrived live.
    if (backfill && message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          childEvent(agent, { type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
        }
      }
    }
    if (entryId && agent.seenEntries.has(entryId)) return;
    if (entryId) agent.seenEntries.add(entryId);
    const logicalKey = messageLogicalKey(message);
    const contentFingerprint = fingerprint(message);
    const candidates = agent.messages.filter((entry) => entry.logicalKey === logicalKey &&
      (backfill ? entry.entryId === undefined : !entry.live));
    // OMP can deobfuscate/truncate content on persistence. Match logical identity
    // and ordered occurrences first, using content only to disambiguate collisions.
    const matched = candidates.find((entry) => entry.fingerprint === contentFingerprint) ?? candidates[0];
    if (matched) {
      if (backfill) matched.entryId = entryId;
      else matched.live = true;
      if (agent.activeMessage?.startKey === matched.startKey) agent.activeMessage.settled = true;
      return;
    }
    const startKey = messageStartKey(message);
    if (!backfill && message.role === "assistant" && agent.activeMessage?.settled &&
      agent.activeMessage.startKey === startKey) return;
    const streamKey = agent.activeMessage?.startKey === startKey && !agent.activeMessage.settled
      ? agent.activeMessage.key : entryId ? `entry-${entryId}` : contentFingerprint;
    agent.messages.push({
      logicalKey, startKey, fingerprint: contentFingerprint, key: streamKey,
      ...(entryId ? { entryId } : {}), live: !backfill,
    });
    if (message.role === "assistant") {
      agent.activeMessage = { startKey, key: streamKey, settled: false };
      // A final snapshot closes live streams, rather than appending text twice.
      if (Array.isArray(message.content)) {
        for (const [index, value] of message.content.entries()) {
          const block = record(value);
          if (block?.type === "thinking" && typeof block.thinking === "string") {
            route(agent, { type: "message_update", assistantMessageEvent: {
              type: "thinking_end", contentIndex: index, content: block.thinking,
            } });
          }
        }
      }
      const output = contentText(message.content);
      // Tool-use and failed messages can contain prose without a final answer.
      const finalAnswer = message.stopReason !== "toolUse" &&
        message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "length" &&
        !(Array.isArray(message.content) && message.content.some((value) => record(value)?.type === "toolCall"));
      // Native terminal delegations cannot be revised. If late backfill has the
      // exact answer already shown in that card, keep the card as its one row.
      const representedBySummary = backfill && agent.closed && finalAnswer &&
        agent.closedFallbackOutput !== undefined && output.trim() === agent.closedFallbackOutput.trim();
      let emitted = false;
      if (!representedBySummary) {
        emitted = route(agent, { type: "message_end", message });
        emitted = route(agent, { type: "agent_end", messages: [message], deferSettlement: true }) || emitted;
      }
      // Only omit fallback output after the translator actually emitted that row.
      agent.finalMessageEmitted = emitted && finalAnswer;
      agent.activeMessage.settled = true;
      if (output) agent.output = output;
      agent.error = text(message.errorMessage) ?? agent.error;
      if (typeof message.model === "string") agent.transcriptModel =
        typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model;
      const usage = record(message.usage);
      if (usage) agent.transcriptTokens += typeof usage.totalTokens === "number" ? usage.totalTokens :
        [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce<number>(
          (sum, value) => sum + (typeof value === "number" ? value : 0), 0,
        );
      publishRoster(Boolean(agent.error));
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      childEvent(agent, {
        type: "tool_execution_end", toolCallId: message.toolCallId,
        toolName: message.toolName, isError: message.isError,
        result: { content: message.content, details: message.details },
      });
    }
  }

  function childEvent(agent: Agent, event: Record<string, unknown>): void {
    if (!agent.opened) {
      const pending = pendingEvents.get(agent.id) ?? [];
      pending.push(event);
      pendingEvents.set(agent.id, pending);
      return;
    }
    if (event.type === "message_start") {
      const message = record(event.message);
      if (message?.role === "assistant") {
        const startKey = messageStartKey(message);
        const replay = agent.messages.find((entry) => entry.startKey === startKey && !entry.live);
        agent.activeMessage = {
          startKey, key: replay?.key ?? `live-${++agent.messageNumber}`,
          settled: replay !== undefined,
        };
        if (!replay) agent.finalMessageEmitted = false;
      }
    }
    if (event.type === "message_update" && agent.activeMessage?.settled) return;
    if (event.type === "message_end") {
      const message = record(event.message);
      if (message) finishMessage(agent, message, false);
      return;
    }
    if (event.type === "agent_end") {
      // agent_end repeats completed message snapshots; it is not another message.
      // Only use it to finish an in-flight stream whose message_end was missed.
      if (agent.activeMessage && !agent.activeMessage.settled && Array.isArray(event.messages)) {
        const message = record(event.messages.findLast((value) => record(value)?.role === "assistant"));
        if (message) finishMessage(agent, message, false);
      }
      return;
    }
    if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      if (agent.startedTools.has(event.toolCallId) || agent.endedTools.has(event.toolCallId)) return;
      agent.startedTools.add(event.toolCallId);
      toolOwners.set(event.toolCallId, agent);
    }
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      if (agent.endedTools.has(event.toolCallId)) return;
      agent.endedTools.add(event.toolCallId);
    }
    publishRoster();
    route(agent, event);
  }

  async function backfill(agent: Agent): Promise<void> {
    if (!agent.sessionFile || !agent.opened || stopped) return;
    const transcript = await options.rpc.getSubagentMessages({ subagentId: agent.id, fromByte: agent.nextByte });
    if (stopped) return;
    // A reset/replacement restarts the byte cursor, not rendered entry IDs or
    // in-flight streams: forked/rewritten OMP transcripts retain entry IDs.
    agent.sessionFile = transcript.sessionFile;
    let hasMessageEntries = false;
    for (const entry of transcript.entries) {
      const message = record(entry.message);
      if (entry.type === "message" && message) {
        hasMessageEntries = true;
        const entryId = text(entry.id);
        finishMessage(agent, message, true, entryId);
      }
    }
    if (!hasMessageEntries) {
      for (const message of transcript.messages) finishMessage(agent, message, true);
    }
    agent.nextByte = transcript.nextByte;
    publishRoster();
  }

  async function update(agent: Agent, readTranscript = true): Promise<void> {
    open(agent);
    publishRoster();
    if (agent.opened && !agent.closed) {
      options.emit([{ kind: "item.progress", key: key(agent), snapshot: delegation(agent) }]);
      updateWorkflow(agent);
      if (readTranscript) await backfill(agent);
      close(agent);
    }
  }

  async function taskEvent(event: Record<string, unknown>): Promise<boolean> {
    if (event.toolName !== "task" || typeof event.toolCallId !== "string") return false;
    const toolCallId = event.toolCallId;
    if (event.type === "tool_execution_start") {
      const args = record(event.args) ?? {};
      const requests = Array.isArray(args.tasks) ? args.tasks : [args];
      parents.set(toolCallId, { requests: requests.map((entry) => record(entry) ?? {}), ended: false });
      return true;
    }
    if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return false;
    const result = record(event.type === "tool_execution_end" ? event.result : event.partialResult);
    const details = record(result?.details);
    const parent = parents.get(toolCallId) ?? { requests: [], ended: false };
    parents.set(toolCallId, parent);
    const asyncDetails = record(details?.async);
    for (const value of Array.isArray(details?.progress) ? details.progress : []) {
      const parsed = ompSubagentProgressSchema.safeParse(value);
      if (!parsed.success) continue;
      const progress = parsed.data;
      const agent = ensure({ ...progress, progress, parentToolCallId: toolCallId,
        ...(asyncDetails?.state === "running" ? { detached: true } : {}) });
      await update(agent, false);
    }
    for (const value of Array.isArray(details?.results) ? details.results : []) {
      const parsed = resultSchema.safeParse(value);
      if (!parsed.success) continue;
      const result = parsed.data;
      const agent = ensure({ ...result, parentToolCallId: toolCallId,
        status: result.aborted ? "aborted" : result.exitCode === 0 ? "completed" : "failed" });
      agent.result = result;
      publishRoster(true);
      await update(agent);
    }
    const children = [...agents.values()].filter((agent) => agent.parentToolCallId === toolCallId);
    if (event.type === "tool_execution_end") {
      parent.ended = true;
      for (const agent of children) {
        close(agent);
        updateWorkflow(agent);
      }
    }
    // Each successful spawn is a native delegation, as with Claude Agent/Task.
    // A task rejected before spawning still gets the translator's normal error row.
    return event.type === "tool_execution_update" || children.length > 0;
  }

  function settle(reason: string): void {
    for (const parent of parents.values()) parent.ended = true;
    for (const agent of agents.values()) {
      if (!agent.closed) {
        if (!terminal(agent.status)) {
          agent.status = "aborted";
          agent.error = reason;
        }
        close(agent, true);
      }
    }
    publishRoster(true);
  }

  return {
    async restore(): Promise<void> {
      const snapshots = await options.rpc.getSubagents();
      if (stopped) return;
      for (const snapshot of snapshots) ensure(snapshot);
      publishRoster(true);
    },
    async onTurnStart(): Promise<void> {
      turnStarted = true;
      for (const agent of agents.values()) if (!agent.closed) await update(agent);
    },
    async handleEvent(event: Record<string, unknown>): Promise<boolean> {
      if (stopped) return false;
      if (event.type === "subagent_lifecycle") {
        const parsed = lifecycleSchema.safeParse(event.payload);
        if (!parsed.success) return true;
        const payload = parsed.data;
        const agent = ensure({ ...payload, status: payload.status === "started" ? "running" : payload.status });
        if (payload.status === "started" && agent.closed) {
          // Workpool/IRC can wake a keep-alive child under its original ID.
          // Reopen its native surface, but retain its transcript identities.
          agent.status = "running";
          agent.closed = false;
          agent.opened = false;
          agent.result = undefined;
          agent.output = undefined;
          agent.error = undefined;
          agent.progress = undefined;
          agent.transcriptTokens = 0;
          agent.finalMessageEmitted = false;
          agent.closedFallbackOutput = undefined;
          if (agent.detached) {
            const workflow = workflowFor(agent);
            workflow.closed = false;
            workflow.opened = false;
          }
        }
        await update(agent);
        return true;
      }
      if (event.type === "subagent_progress") {
        const parsed = progressPayloadSchema.safeParse(event.payload);
        if (!parsed.success) return true;
        const { progress, ...metadata } = parsed.data;
        await update(ensure({ ...progress, ...metadata, progress, lastUpdate: Date.now() }));
        return true;
      }
      if (event.type === "subagent_event") {
        const payload = record(event.payload);
        const child = record(payload?.event);
        if (typeof payload?.id === "string" && child) {
          const agent = agents.get(payload.id);
          if (agent) childEvent(agent, child);
          else {
            const pending = pendingEvents.get(payload.id) ?? [];
            pending.push(child);
            pendingEvents.set(payload.id, pending);
          }
        }
        return true;
      }
      if (event.type === "agent_end") {
        for (const agent of agents.values()) {
          await backfill(agent);
          if (!agent.closed) close(agent, true);
        }
      }
      return taskEvent(event);
    },
    async stopTask(taskId: string): Promise<void> {
      const workflow = workflows.get(taskId);
      const targets = workflow ? [...workflow.agents] : [...agents.values()].filter(
        (agent) => agent.id === taskId || providerId(agent) === taskId,
      );
      const running = targets.filter((agent) => !terminal(agent.status));
      if (!running.length) throw new Error(`No running OMP subagent for task ${taskId}`);
      await Promise.all(running.map(async (agent) => {
        const cancelled = await options.rpc.cancelSubagent(agent.id);
        // False means the child is already gone; no lifecycle frame need follow.
        if (!cancelled && !terminal(agent.status)) {
          agent.status = "aborted";
          await update(agent);
        }
      }));
    },
    async steer(subagentId: string, message: string): Promise<void> {
      const agent = agents.get(subagentId);
      if (!agent || terminal(agent.status)) throw new Error(`No running OMP subagent ${subagentId}`);
      await options.rpc.steerSubagent(subagentId, message);
    },
    async interrupt(reason: string): Promise<void> {
      await Promise.all([...agents.values()].filter((agent) => !terminal(agent.status)).map(
        (agent) => options.rpc.cancelSubagent(agent.id),
      ));
      settle(reason);
    },
    stop(reason: string): void {
      settle(reason);
      stopped = true;
      clearTimeout(rosterTimer);
      rosterTimer = undefined;
      pendingEvents.clear();
    },
  };
}

