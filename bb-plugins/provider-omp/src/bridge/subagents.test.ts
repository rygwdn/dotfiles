import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DeltaBackgroundTaskShape,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { OmpRpcSession } from "./rpc-session.js";
import {
  OMP_AGENTS_ROSTER_LIMIT,
  OMP_AGENTS_STATE_KIND,
  ompAgentsStateSchema,
} from "../hub-contract.js";
import {
  createOmpSubagentCoordinator,
  type OmpSubagentCoordinator,
  type OmpSubagentMessages,
  type OmpSubagentSnapshot,
} from "./subagents.js";
import { OMP_CARD_KIND, ompCardSchema } from "../extension-ui-contract.js";

const SESSION = "session-one";
const THREAD = "thread-one";
const FILE = "/workspace/sessions/research.jsonl";
const providerId = (id: string) => `omp-subagent:${SESSION}:${id}`;
const childTurn = (id: string) => `${providerId(id)}:transcript`;

type SubagentRpc = Pick<
  OmpRpcSession,
  "getSubagents" | "getSubagentMessages" | "cancelSubagent" | "steerSubagent"
>;

function snapshot(
  id: string,
  overrides: Partial<OmpSubagentSnapshot> = {},
): OmpSubagentSnapshot {
  return {
    id, index: 0, agent: "explore", status: "running", lastUpdate: 100,
    ...overrides,
  };
}

function assistant(text: string, timestamp: number, toolCallId?: string) {
  return {
    role: "assistant", timestamp, provider: "openai", model: "gpt-5",
    content: [
      { type: "text", text },
      ...(toolCallId ? [{
        type: "toolCall", id: toolCallId, name: "probe",
        arguments: { path: "src/index.ts" },
      }] : []),
    ],
    usage: { input: 12, output: 4, totalTokens: 16 },
    stopReason: toolCallId ? "toolUse" : "stop",
  };
}

function toolResult(toolCallId: string, timestamp: number) {
  return {
    role: "toolResult", timestamp, toolCallId, toolName: "probe",
    content: [{ type: "text", text: "Found the entry point." }],
    details: { matches: 1 }, isError: false,
  };
}

function page(
  messages: Record<string, unknown>[],
  overrides: Partial<Pick<
    OmpSubagentMessages, "sessionFile" | "fromByte" | "nextByte" | "reset"
  >> = {},
): OmpSubagentMessages {
  return {
    sessionFile: FILE, fromByte: 0, nextByte: 0, reset: false,
    entries: messages.map((message, index) => ({
      type: "message", id: `entry-${index}`, message,
    })),
    // The RPC deliberately returns both views of the same records.
    messages,
    ...overrides,
  };
}

function createHarness(roster: OmpSubagentSnapshot[] = []) {
  const deltas: ThreadDelta[] = [];
  const events: ThreadEvent[] = [];
  const assembler = createDeltaAssembler({
    providerId: "omp", entropyPrefix: "subagent-test",
    textDeltaFlushMs: 0, progressThrottleMs: 0,
  });
  const apply = (batch: ThreadDelta[]) => {
    events.push(...assembler.assemble({ threadId: THREAD, deltas: batch }));
  };
  apply([{ kind: "turn.open" }]);
  const rootTurnId = assembler.getOpenTurnId(THREAD);
  const rpc = {
    getSubagents: vi.fn<SubagentRpc["getSubagents"]>().mockResolvedValue(roster),
    getSubagentMessages: vi.fn<SubagentRpc["getSubagentMessages"]>()
      .mockResolvedValue(page([])),
    cancelSubagent: vi.fn<SubagentRpc["cancelSubagent"]>().mockResolvedValue(true),
    steerSubagent: vi.fn<SubagentRpc["steerSubagent"]>().mockResolvedValue(undefined),
  } satisfies SubagentRpc;
  const coordinator = createOmpSubagentCoordinator({
    rpc, sessionRef: SESSION, cwd: "/workspace",
    resolveModelContextWindow: () => 128_000,
    emit(batch) {
      deltas.push(...batch);
      apply(batch);
    },
  });
  return { coordinator, rpc, deltas, events, assembler, apply, rootTurnId };
}

function lifecycle(
  id: string,
  status: "started" | "completed" | "failed" | "aborted",
  metadata: Partial<OmpSubagentSnapshot> = {},
): Record<string, unknown> {
  return {
    type: "subagent_lifecycle",
    payload: { id, index: 0, agent: "explore", ...metadata, status },
  };
}

function child(
  coordinator: OmpSubagentCoordinator,
  id: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  return coordinator.handleEvent({ type: "subagent_event", payload: { id, event } });
}

async function liveMessage(
  coordinator: OmpSubagentCoordinator,
  id: string,
  message: Record<string, unknown>,
  text: string,
): Promise<void> {
  await child(coordinator, id, {
    type: "message_start", message: { ...message, content: [] },
  });
  await child(coordinator, id, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  await child(coordinator, id, { type: "message_end", message });
}

function messageCloses(deltas: ThreadDelta[]) {
  return deltas.filter((delta): delta is Extract<ThreadDelta, { kind: "item.textClose" }> =>
    delta.kind === "item.textClose" && delta.channel === "agentMessage");
}

function delegationCloses(deltas: ThreadDelta[]) {
  return deltas.filter((delta): delta is Extract<ThreadDelta, { kind: "item.close" }> =>
    delta.kind === "item.close" && delta.item.type === "delegation");
}

function toolRows(deltas: ThreadDelta[]) {
  return deltas.filter((delta): delta is Extract<ThreadDelta, { kind: "item.open" | "item.close" }> =>
    (delta.kind === "item.open" || delta.kind === "item.close") && delta.item.type === "tool");
}

function workflowSnapshots(deltas: ThreadDelta[]): DeltaBackgroundTaskShape[] {
  return deltas.flatMap((delta) => {
    if (delta.kind === "item.progress" && delta.snapshot?.type === "backgroundTask") {
      return [delta.snapshot];
    }
    if ((delta.kind === "item.open" || delta.kind === "item.close") && delta.item.type === "backgroundTask") {
      return [delta.item];
    }
    return [];
  });
}

function workflowCloses(deltas: ThreadDelta[]) {
  return deltas.filter((delta): delta is Extract<ThreadDelta, { kind: "item.close" }> =>
    delta.kind === "item.close" && delta.item.type === "backgroundTask");
}

function agentRosters(deltas: ThreadDelta[]) {
  return deltas.flatMap((delta) =>
    delta.kind === "extension.state" && delta.extensionKind === OMP_AGENTS_STATE_KIND
      ? [ompAgentsStateSchema.parse(delta.payload)] : []);
}

describe("native OMP subagent coordinator", () => {
  it("routes custom and native cards into the child transcript without changing the root turn", async () => {
    const { coordinator, deltas, events, assembler, rootTurnId } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-card", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", { parentToolCallId: "task-card" }));
    const since = deltas.length;
    const message = {
      role: "custom", customType: "advisor", display: true, timestamp: 100,
      content: "<advisory>Model-facing instructions</advisory>",
      details: { notes: [{ note: "**Review:** protect the write", severity: "concern", advisor: "reviewer" }] },
    };
    await child(coordinator, "research", { type: "message_start", messageId: "msg-card", message });
    await child(coordinator, "research", { type: "message_end", messageId: "msg-card", message });
    await child(coordinator, "research", {
      type: "ttsr_triggered", rules: [{ name: "Guard writes", content: "Use a lock." }],
    });
    await child(coordinator, "research", {
      type: "todo_reminder", attempt: 1, maxAttempts: 2,
      todos: [{ content: "Finish the lock", status: "pending" }],
    });
    const ircMessage = {
      role: "custom", customType: "irc:incoming", display: true, timestamp: 101,
      content: "<irc>Check the lock</irc>",
      details: { id: "irc-child-card", from: "main", message: "Check the lock" },
    };
    await child(coordinator, "research", { type: "irc_message", message: ircMessage });
    await child(coordinator, "research", { type: "message_start", messageId: "msg-irc", message: ircMessage });
    const rows = deltas.slice(since);
    expect(rows).toHaveLength(4);
    expect(rows.every((delta) => delta.kind === "item.close")).toBe(true);
    const cards = rows.flatMap((delta) =>
      delta.kind === "item.close" && delta.item.type === "extension" && delta.item.kind === OMP_CARD_KIND
        ? [{ delta, payload: ompCardSchema.parse(delta.item.payload) }]
        : [],
    );
    expect(cards.map(({ payload }) => payload.type)).toEqual([
      "advisor", "ttsr_triggered", "todo_reminder", "irc_message",
    ]);
    expect(cards[0]?.payload.sections[0]?.body).toBe("**Review:** protect the write");
    for (const { delta } of cards) {
      expect(delta).toMatchObject({
        providerTurnId: childTurn("research"),
        key: { parentRef: providerId("research"), providerItemId: expect.stringContaining(`${providerId("research")}:`) },
      });
    }
    expect(events.filter((event) => event.type === "item/completed" &&
      event.item.type === "extension" && event.item.kind === OMP_CARD_KIND)).toHaveLength(4);
    expect(assembler.getOpenTurnId(THREAD)).toBe(rootTurnId);
  });

  afterEach(() => vi.useRealTimers());

  it.each(["subagent_progress", "tool_execution_update"] as const)(
    "publishes lifecycle, %s, and final result fields before a turn starts",
    async (type) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { coordinator, rpc, deltas, events } = createHarness();
      await coordinator.handleEvent(lifecycle("research", "started", {
        description: `  ${"Find the entry point. ".repeat(20)}  `,
      }));
      expect(agentRosters(deltas)).toEqual([{
        agents: [{
          id: "research", agent: "explore",
          status: "running", description: "Find the entry point. ".repeat(20).slice(0, 240),
          detached: false, tokens: 0, toolCount: 0, lastUpdate: 1_000,
        }],
      }]);
      expect(deltas.every((delta) => delta.kind === "extension.state")).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({
        type: "thread/extensionState/updated", kind: OMP_AGENTS_STATE_KIND,
      }));
      const progress = {
        id: "research", index: 0, agent: "scout", status: "running",
        resolvedModel: "openai/gpt-5:high", resolvedModelIdentity: "openai/gpt-5",
        modelRole: "scout", cost: 0.12, tokens: 123, toolCount: 4, durationMs: 1_500,
        currentTool: "read", currentToolIntent: "Reading the entry point", lastIntent: "Older intent",
        retryState: {
          attempt: 2, maxAttempts: 5, delayMs: 30_000,
          errorMessage: "Rate limited", startedAtMs: 1_000,
        },
      };
      await coordinator.handleEvent(type === "subagent_progress"
        ? { type, payload: { progress, detached: true } }
        : {
          type, toolName: "task", toolCallId: "task-one",
          partialResult: { details: { progress: [progress], async: { state: "running" } } },
        });
      expect(agentRosters(deltas)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(agentRosters(deltas).at(-1)?.agents).toEqual([expect.objectContaining({
        id: "research", agent: "scout", status: "running", detached: true,
        model: "openai/gpt-5", modelRole: "scout", cost: 0.12,
        tokens: 123, toolCount: 4, durationMs: 1_500,
        currentTool: "read", intent: "Reading the entry point",
        retry: { attempt: 2, maxAttempts: 5 },
      })]);
      await coordinator.handleEvent(lifecycle("research", "failed"));
      expect(agentRosters(deltas).at(-1)?.agents[0]).toMatchObject({ status: "failed" });
      expect(agentRosters(deltas).at(-1)?.agents[0]).not.toHaveProperty("retry");
      await coordinator.handleEvent({
        type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
        result: { details: { results: [{
          id: "research", index: 0, agent: "scout", exitCode: 1, output: "Could not finish.",
          error: "Final error", tokens: 456, durationMs: 4_000,
          resolvedModel: "anthropic/sonnet:high", resolvedModelIdentity: "anthropic/sonnet",
          modelRole: "worker", usage: { cost: { total: 0.34 } },
        }] } },
      });
      const finalRoster = agentRosters(deltas).at(-1);
      expect(finalRoster?.agents[0]).toMatchObject({
        status: "failed", model: "anthropic/sonnet", modelRole: "worker",
        cost: 0.34, tokens: 456, toolCount: 4, durationMs: 4_000, error: "Final error",
      });
      rpc.getSubagents.mockResolvedValue([]);
      await coordinator.restore();
      expect(agentRosters(deltas).at(-1)).toEqual(finalRoster);
      expect(agentRosters(deltas)).toHaveLength(4);
    },
  );

  it("does not persist unchanged lifecycle, progress, or restored snapshots again", async () => {
    vi.useFakeTimers();
    const { coordinator, rpc, deltas } = createHarness();
    await coordinator.handleEvent(lifecycle("research", "started"));
    await vi.advanceTimersByTimeAsync(100);
    await coordinator.handleEvent(lifecycle("research", "started"));
    const progress = {
      id: "research", index: 0, agent: "explore", status: "running", tokens: 123,
    };
    await coordinator.handleEvent({ type: "subagent_progress", payload: { progress } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(agentRosters(deltas)).toHaveLength(2);
    await coordinator.handleEvent({ type: "subagent_progress", payload: { progress } });
    rpc.getSubagents.mockResolvedValue([snapshot("research", {
      progress: { ...progress, status: "running" }, lastUpdate: Date.now() + 100,
    })]);
    await coordinator.restore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agentRosters(deltas)).toHaveLength(2);
  });

  it("coalesces progress bursts and flushes immediately for status changes and new agents", async () => {
    vi.useFakeTimers();
    const { coordinator, deltas } = createHarness();
    const progress = (tokens: number) => coordinator.handleEvent({
      type: "subagent_progress",
      payload: { progress: {
        id: "research", index: 0, agent: "explore", status: "running", tokens,
      } },
    });
    await coordinator.handleEvent(lifecycle("research", "started"));
    await progress(1);
    await vi.advanceTimersByTimeAsync(500);
    await progress(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await progress(3);
    await vi.advanceTimersByTimeAsync(499);
    expect(agentRosters(deltas)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(agentRosters(deltas)).toHaveLength(2);
    expect(agentRosters(deltas).at(-1)?.agents[0]?.tokens).toBe(3);
    await progress(4);
    await vi.advanceTimersByTimeAsync(500);
    await coordinator.handleEvent(lifecycle("research", "completed"));
    expect(agentRosters(deltas)).toHaveLength(3);
    expect(agentRosters(deltas).at(-1)?.agents[0]).toMatchObject({ status: "completed", tokens: 4 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(agentRosters(deltas)).toHaveLength(3);
    await coordinator.handleEvent(lifecycle("verify", "started", { index: 1 }));
    expect(agentRosters(deltas)).toHaveLength(4);
    expect(agentRosters(deltas).at(-1)?.agents.map((agent) => agent.id)).toEqual(["research", "verify"]);
  });

  it("restores one bounded ordered roster and emits nothing for an empty session", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    await coordinator.restore();
    expect(agentRosters(deltas)).toEqual([]);
    rpc.getSubagents.mockResolvedValue(Array.from({ length: OMP_AGENTS_ROSTER_LIMIT + 2 }, (_, index) =>
      snapshot(`worker-${index}`, {
        index, status: index % 2 ? "completed" : "aborted",
        assignment: index === 2 ? "  Assigned work  " : undefined,
        task: "Fallback task",
      })).reverse());
    await coordinator.restore();
    expect(agentRosters(deltas)).toHaveLength(1);
    const roster = agentRosters(deltas)[0]!;
    expect(roster.truncated).toBe(true);
    expect(roster.agents.map((agent) => agent.id)).toEqual(
      Array.from({ length: OMP_AGENTS_ROSTER_LIMIT }, (_, index) => `worker-${index + 2}`),
    );
    expect(roster.agents[0]).toMatchObject({ status: "aborted", description: "Assigned work" });
    expect(roster.agents[1]).toMatchObject({ status: "completed", description: "Fallback task" });
  });

  it("maps nested parent ids and transcript model, tokens, tools, intent, and errors", async () => {
    vi.useFakeTimers();
    const { coordinator, deltas } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("parent", "started"));
    await child(coordinator, "parent", {
      type: "tool_execution_start", toolCallId: "nested-task", toolName: "task", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      index: 1, parentToolCallId: "nested-task",
    }));
    await child(coordinator, "research", {
      type: "tool_execution_start", toolCallId: "probe-one", toolName: "probe", args: {},
    });
    await child(coordinator, "research", { type: "message_end", message: toolResult("probe-one", 10) });
    await liveMessage(coordinator, "research", assistant("Found it.", 11), "Found it.");
    await coordinator.handleEvent({
      type: "subagent_progress", payload: { progress: {
        id: "research", index: 1, agent: "explore", status: "running", lastIntent: "Checking the result",
      } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(agentRosters(deltas).at(-1)?.agents[1]).toMatchObject({
      id: "research", parentId: "parent", model: "openai/gpt-5", tokens: 16,
      toolCount: 1, intent: "Checking the result",
    });
    await child(coordinator, "research", {
      type: "message_end", message: { ...assistant("Failed.", 12), errorMessage: "Provider failed" },
    });
    expect(agentRosters(deltas).at(-1)?.agents[1]).toMatchObject({ error: "Provider failed", tokens: 32 });
  });

  it("clears trailing publication on stop and ignores later events and restore responses", async () => {
    vi.useFakeTimers();
    const { coordinator, rpc, deltas } = createHarness();
    await coordinator.handleEvent(lifecycle("research", "started"));
    await coordinator.handleEvent({
      type: "subagent_progress", payload: { progress: {
        id: "research", index: 0, agent: "explore", status: "running", tokens: 123,
      } },
    });
    let resolveRestore!: (snapshots: OmpSubagentSnapshot[]) => void;
    rpc.getSubagents.mockImplementation(() => new Promise((resolve) => { resolveRestore = resolve; }));
    const restoring = coordinator.restore();
    coordinator.stop("Session stopped");
    const count = agentRosters(deltas).length;
    expect(agentRosters(deltas).at(-1)?.agents[0]).toMatchObject({
      status: "aborted", error: "Session stopped", tokens: 123,
    });
    resolveRestore([snapshot("late")]);
    await restoring;
    await coordinator.handleEvent(lifecycle("late", "started"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agentRosters(deltas)).toHaveLength(count);
  });

  it.each(["subagent_progress", "tool_execution_update"] as const)(
    "shows model, role, cost, and retry state on a running card from %s",
    async (type) => {
      const { coordinator, deltas, events } = createHarness();
      await coordinator.onTurnStart();
      await coordinator.handleEvent({
        type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
      });
      await coordinator.handleEvent(lifecycle("research", "started", {
        parentToolCallId: "task-one", description: "Find entry point",
      }));
      const progress = {
        id: "research", index: 0, agent: "explore", status: "running",
        resolvedModel: "anthropic/claude-sonnet:high",
        resolvedModelIdentity: "anthropic/claude-sonnet",
        modelRole: "scout", cost: 0.0123, tokens: 123, durationMs: 1_500,
        retryState: {
          attempt: 2, maxAttempts: 5, delayMs: 30_000,
          errorMessage: "Provider rate limit", startedAtMs: 100,
        },
      };
      const emitProgress = (next: Record<string, unknown>) => coordinator.handleEvent(
        type === "subagent_progress"
          ? { type, payload: { progress: next, parentToolCallId: "task-one" } }
          : {
            type, toolName: "task", toolCallId: "task-one",
            partialResult: { details: { progress: [next] } },
          },
      );
      await emitProgress(progress);
      expect(deltas.findLast(
        (delta) => delta.kind === "item.progress" && delta.snapshot?.type === "delegation",
      )).toMatchObject({
        kind: "item.progress",
        snapshot: {
          type: "delegation",
          label: "research · anthropic/claude-sonnet:high (scout) · $0.0123 · retrying 2/5: Find entry point",
          summary: "anthropic/claude-sonnet:high (scout) · $0.0123 · retrying 2/5 · 123 tokens · 1.5s\n\nRetry wait: 30.0s. Provider rate limit\n\n::omp-agent-details{id=\"research\"}",
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "item/delegation/progress",
        item: expect.objectContaining({
          status: "pending",
          label: "research · anthropic/claude-sonnet:high (scout) · $0.0123 · retrying 2/5: Find entry point",
          summary: expect.stringContaining("anthropic/claude-sonnet:high (scout) · $0.0123"),
        }),
      }));
      expect(delegationCloses(deltas)).toEqual([]);

      await emitProgress({ ...progress, cost: 0.02, retryState: undefined });
      await emitProgress({ ...progress, cost: 0.001, retryState: undefined });
      expect(deltas.findLast(
        (delta) => delta.kind === "item.progress" && delta.snapshot?.type === "delegation",
      )).toMatchObject({
        snapshot: {
          label: "research · anthropic/claude-sonnet:high (scout) · $0.0200: Find entry point",
          summary: "anthropic/claude-sonnet:high (scout) · $0.0200 · 123 tokens · 1.5s\n\n::omp-agent-details{id=\"research\"}",
        },
      });
      await coordinator.handleEvent({
        type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
        result: { details: { results: [{
          id: "research", index: 0, agent: "explore", exitCode: 0, output: "Found it.",
          resolvedModel: "anthropic/claude-sonnet:high", modelRole: "scout",
          usage: { cost: { total: 0.0345 } },
        }] } },
      });
      expect(delegationCloses(deltas)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({
            label: "research: Find entry point",
            summary: "Found it.\n\nanthropic/claude-sonnet:high (scout) · $0.0345 · 123 tokens · 1.5s\n\n::omp-agent-details{id=\"research\"}",
          }),
        }),
      ]);
    },
  );

  it.each(["message_start", "message_end"] as const)(
    "retains fallback when a later assistant %s supersedes an earlier final row",
    async (type) => {
      const { coordinator, deltas } = createHarness();
      await coordinator.onTurnStart();
      await coordinator.handleEvent({
        type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
      });
      await coordinator.handleEvent(lifecycle("research", "started", { parentToolCallId: "task-one" }));
      await liveMessage(coordinator, "research", assistant("Earlier answer.", 10), "Earlier answer.");
      await child(coordinator, "research", {
        type, message: assistant("Still investigating.", 20, "probe-one"),
      });
      await coordinator.handleEvent({
        type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
        result: { details: { results: [{
          id: "research", index: 0, agent: "explore", exitCode: 0, output: "Final fallback answer.",
        }] } },
      });

      expect(delegationCloses(deltas)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({ summary: expect.stringContaining("Final fallback answer.") }),
        }),
      ]);
    },
  );

  it("clears an output-only opening summary when final backfill has no metadata", async () => {
    const { coordinator, rpc, deltas, events } = createHarness();
    const message = {
      role: "assistant", timestamp: 10, stopReason: "stop",
      content: [{ type: "text", text: "Final finding." }],
    };
    rpc.getSubagentMessages.mockResolvedValue(page([message], { nextByte: 120 }));
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-one", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Final finding.",
      }] } },
    });
    await coordinator.onTurnStart();

    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Final finding."]);
    expect(events.filter((event) =>
      event.type === "item/completed" && event.item.type === "delegation")).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ summary: "\n\n::omp-agent-details{id=\"research\"}" }) }),
    ]);
  });

  it.each([
    { label: "an exact final answer", finalText: "Late final finding.", nestedFinal: [] },
    { label: "a trimmed exact final answer", finalText: " \nLate final finding.\n ", nestedFinal: [] },
    {
      label: "a different final answer", finalText: "Late final finding. Additional detail.",
      nestedFinal: ["Late final finding. Additional detail."],
    },
  ])("uses the closed fallback only for $label in late backfill", async ({ finalText, nestedFinal }) => {
    const { coordinator, rpc, deltas, events } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-one", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Late final finding.",
        tokens: 42, durationMs: 1_250, resolvedModelIdentity: "openai/gpt-5",
      }] } },
    });
    expect(messageCloses(deltas)).toEqual([]);
    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ summary: "Late final finding.\n\nopenai/gpt-5 · 42 tokens · 1.3s\n\n::omp-agent-details{id=\"research\"}" }),
      }),
    ]);
    const beforeBackfill = deltas.length;
    const intermediate = assistant("Still investigating.", 10, "probe-one");
    const final = assistant(finalText, 12);
    rpc.getSubagentMessages.mockResolvedValue(page([
      intermediate, toolResult("probe-one", 11), final,
    ], { nextByte: 120 }));
    await coordinator.handleEvent({ type: "agent_end" });
    await coordinator.handleEvent({ type: "agent_end" });
    // Replaying the suppressed persisted entry live must also remain deduplicated.
    await liveMessage(coordinator, "research", final, finalText);

    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Still investigating.", ...nestedFinal]);
    expect(toolRows(deltas).map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
    expect(deltas.slice(beforeBackfill).filter((delta) =>
      ((delta.kind === "item.open" || delta.kind === "item.close") && delta.item.type === "delegation") ||
      (delta.kind === "item.progress" && delta.snapshot?.type === "delegation"))).toEqual([]);
    expect(rpc.getSubagentMessages.mock.calls.slice(-2)).toEqual([
      [{ subagentId: "research", fromByte: 0 }],
      [{ subagentId: "research", fromByte: 120 }],
    ]);
    // SDK 0.6.49 cannot revise settled delegations; their fallback stays visible.
    expect(events.filter((event) =>
      event.type === "item/completed" && event.item.type === "delegation")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          status: "completed", summary: "Late final finding.\n\nopenai/gpt-5 · 42 tokens · 1.3s\n\n::omp-agent-details{id=\"research\"}",
        }),
      }),
    ]);
  });

  it("does not reuse a closed fallback representation after a keep-alive child reopens", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-one", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Shared answer.",
      }] } },
    });
    const first = assistant("Shared answer.", 10);
    rpc.getSubagentMessages.mockResolvedValue(page([first], { nextByte: 120 }));
    await coordinator.handleEvent({ type: "agent_end" });
    expect(messageCloses(deltas)).toEqual([]);
    const followup = assistant("Shared answer.", 20);
    rpc.getSubagentMessages.mockResolvedValue(page([first, followup], { reset: true, nextByte: 240 }));
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-two", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-two", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-two",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Shared answer.",
      }] } },
    });

    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Shared answer."]);
    expect(delegationCloses(deltas).map((delta) => delta.item)).toEqual([
      expect.objectContaining({ summary: "Shared answer.\n\n::omp-agent-details{id=\"research\"}" }),
      expect.objectContaining({ summary: "openai/gpt-5 · 16 tokens\n\n::omp-agent-details{id=\"research\"}" }),
    ]);
  });

  it.each(["live", "backfill"] as const)(
    "omits output already emitted as a final nested assistant row (%s)",
    async (source) => {
      const { coordinator, rpc, deltas, events } = createHarness();
      const message = assistant("Final finding.", 10);
      if (source === "backfill") rpc.getSubagentMessages.mockResolvedValue(page([message], { nextByte: 120 }));
      await coordinator.onTurnStart();
      await coordinator.handleEvent({
        type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
      });
      await coordinator.handleEvent(lifecycle("research", "started", {
        parentToolCallId: "task-one", ...(source === "backfill" ? { sessionFile: FILE } : {}),
      }));
      if (source === "live") await liveMessage(coordinator, "research", message, "Final finding.");
      await coordinator.handleEvent({
        type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
        result: { details: { results: [{
          id: "research", index: 0, agent: "explore", exitCode: 0,
          output: "Final finding.", tokens: 42, durationMs: 1_250, resolvedModelIdentity: "openai/gpt-5",
        }] } },
      });

      expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Final finding."]);
      expect(events.filter((event) =>
        event.type === "item/completed" && event.item.type === "agentMessage")).toEqual([
        expect.objectContaining({ item: expect.objectContaining({ text: "Final finding." }) }),
      ]);
      expect(delegationCloses(deltas)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({ summary: "openai/gpt-5 · 42 tokens · 1.3s\n\n::omp-agent-details{id=\"research\"}" }),
        }),
      ]);
    },
  );

  it.each(["Result validation failed", "Final finding."])(
    "retains the terminal error when nested final output is omitted (%s)",
    async (error) => {
      const { coordinator, deltas } = createHarness();
      await coordinator.onTurnStart();
      await coordinator.handleEvent({
        type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
      });
      await coordinator.handleEvent(lifecycle("research", "started", { parentToolCallId: "task-one" }));
      await liveMessage(coordinator, "research", assistant("Final finding.", 10), "Final finding.");
      await coordinator.handleEvent({
        type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
        result: { details: { results: [{
          id: "research", index: 0, agent: "explore", exitCode: 1, output: "Final finding.", error,
        }] } },
      });

      expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Final finding."]);
      expect(delegationCloses(deltas)).toEqual([
        expect.objectContaining({
          status: "failed", item: expect.objectContaining({ summary: `${error}\n\nopenai/gpt-5 · 16 tokens\n\n::omp-agent-details{id="research"}` }),
        }),
      ]);
    },
  );

  it.each([
    { label: "no transcript", message: undefined, rendered: false },
    {
      label: "intermediate tool-use prose",
      message: { ...assistant("Still investigating.", 10), stopReason: "toolUse" }, rendered: true,
    },
    {
      label: "an intermediate tool-call message",
      message: { ...assistant("Still investigating.", 10, "probe-one"), stopReason: undefined }, rendered: true,
    },
    {
      label: "an error snapshot with visible assistant text",
      message: { ...assistant("Partial finding.", 10), stopReason: "error", errorMessage: "Provider failed" },
      rendered: true,
    },
  ])("retains fallback output with $label", async ({ message, rendered }) => {
    const { coordinator, deltas } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", { parentToolCallId: "task-one" }));
    if (message) await child(coordinator, "research", { type: "message_end", message });
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Fallback answer.",
      }] } },
    });

    expect(messageCloses(deltas)).toHaveLength(rendered ? 1 : 0);
    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ summary: expect.stringContaining("Fallback answer.") }),
      }),
    ]);
  });

  it("retains a reopened run's fallback output when reset backfill only repeats an earlier final row", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    const first = assistant("Initial finding.", 10);
    rpc.getSubagentMessages.mockResolvedValue(page([first], { nextByte: 120 }));
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-one", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Initial finding.",
      }] } },
    });
    rpc.getSubagentMessages.mockResolvedValue(page([first], { reset: true, nextByte: 120 }));
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-two", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-two", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-two",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0, output: "Follow-up fallback.",
        tokens: 23, durationMs: 2_000,
      }] } },
    });

    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Initial finding."]);
    expect(delegationCloses(deltas).map((delta) => delta.item)).toEqual([
      expect.objectContaining({ summary: "openai/gpt-5 · 16 tokens\n\n::omp-agent-details{id=\"research\"}" }),
      expect.objectContaining({ summary: "Follow-up fallback.\n\nopenai/gpt-5 · 23 tokens · 2.0s\n\n::omp-agent-details{id=\"research\"}" }),
    ]);
  });

  it("deduplicates live assistant/tool events against both transcript views and repeated backfills", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    const message = assistant("Inspecting the entry point.", 10, "probe-one");
    const result = toolResult("probe-one", 11);
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started"));
    await liveMessage(coordinator, "research", message, "Inspecting the entry point.");
    await child(coordinator, "research", {
      type: "tool_execution_start", toolCallId: "probe-one", toolName: "probe",
      args: { path: "src/index.ts" },
    });
    await child(coordinator, "research", {
      type: "tool_execution_end", toolCallId: "probe-one", toolName: "probe",
      result: { content: result.content, details: result.details }, isError: false,
    });
    await child(coordinator, "research", { type: "agent_end", messages: [message, result] });
    rpc.getSubagentMessages.mockResolvedValue(page([message, result], { nextByte: 256 }));
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    await coordinator.handleEvent(lifecycle("research", "completed", { sessionFile: FILE }));

    expect(rpc.getSubagentMessages.mock.calls).toEqual([
      [{ subagentId: "research", fromByte: 0 }],
      [{ subagentId: "research", fromByte: 256 }],
    ]);
    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Inspecting the entry point."]);
    expect(deltas.filter((delta) => delta.kind === "item.textDelta")).toHaveLength(1);
    expect(toolRows(deltas).map((delta) => [delta.kind, delta.key.providerItemId])).toEqual([
      ["item.open", `${providerId("research")}:tool:probe-one`],
      ["item.close", `${providerId("research")}:tool:probe-one`],
    ]);
    expect(delegationCloses(deltas)).toHaveLength(1);
    expect(deltas.some((delta) => delta.kind === "usage" || delta.kind === "contextWindow" || delta.kind === "provider.error")).toBe(false);
  });

  it("does not replay a rendered assistant stream when backfill arrives ahead of its live start and deltas", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    const first = assistant("Inspecting the entry point.", 10, "probe-one");
    const result = toolResult("probe-one", 11);
    rpc.getSubagentMessages.mockResolvedValue(page([first, result], { nextByte: 256 }));
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    const beforeReplay = deltas.length;
    await liveMessage(coordinator, "research", first, "Inspecting the entry point.");
    await child(coordinator, "research", {
      type: "tool_execution_start", toolCallId: "probe-one", toolName: "probe",
      args: { path: "src/index.ts" },
    });
    await child(coordinator, "research", {
      type: "tool_execution_end", toolCallId: "probe-one", toolName: "probe",
      result: { content: result.content, details: result.details }, isError: false,
    });
    expect(deltas.slice(beforeReplay)).toEqual([]);

    const second = assistant("The entry point is ready.", 12);
    await liveMessage(coordinator, "research", second, "The entry point is ready.");
    const closes = messageCloses(deltas);
    expect(closes.map((delta) => delta.text)).toEqual([
      "Inspecting the entry point.", "The entry point is ready.",
    ]);
    expect(new Set(closes.map((delta) => delta.key.providerItemId)).size).toBe(2);
    expect(deltas.filter((delta) => delta.kind === "item.textDelta")).toEqual([
      expect.objectContaining({ text: "The entry point is ready.", providerTurnId: childTurn("research") }),
    ]);
  });

  it.each(["live first", "backfill first"] as const)(
    "deduplicates transformed live and persisted content by logical identity ($0)",
    async (order) => {
      const { coordinator, rpc, deltas, events } = createHarness();
      const live = assistant("Account 1234 owns the entry point.", 10);
      const persisted = assistant("Account [redacted] owns the entry point.", 10);
      const renderedText = order === "live first"
        ? "Account 1234 owns the entry point."
        : "Account [redacted] owns the entry point.";
      rpc.getSubagentMessages.mockResolvedValue(page([persisted], { nextByte: 160 }));
      await coordinator.onTurnStart();
      await coordinator.handleEvent(lifecycle("research", "started", {
        ...(order === "backfill first" ? { sessionFile: FILE } : {}),
      }));
      await liveMessage(coordinator, "research", live, "Account 1234 owns the entry point.");
      await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
      await coordinator.handleEvent(lifecycle("research", "completed"));

      expect(messageCloses(deltas).map((delta) => delta.text)).toEqual([renderedText]);
      const completedMessages = events.filter((event) =>
        event.type === "item/completed" && event.item.type === "agentMessage");
      expect(completedMessages).toHaveLength(1);
      expect(completedMessages[0]).toMatchObject({ item: { text: renderedText } });
      expect(deltas.filter((delta) => delta.kind === "item.textDelta")).toHaveLength(
        order === "live first" ? 1 : 0,
      );
      expect(delegationCloses(deltas)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({ summary: "openai/gpt-5 · 16 tokens\n\n::omp-agent-details{id=\"research\"}" }),
        }),
      ]);
    },
  );

  it("finishes the existing live assistant item when backfill overtakes a partial stream", async () => {
    const { coordinator, rpc, deltas, events } = createHarness();
    const final = assistant("Final finding.", 10);
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started"));
    await child(coordinator, "research", {
      type: "message_start", message: { ...final, content: [] },
    });
    await child(coordinator, "research", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Final " },
    });
    const liveDeltas = deltas.filter((delta) => delta.kind === "item.textDelta");
    expect(liveDeltas).toHaveLength(1);
    rpc.getSubagentMessages.mockResolvedValue(page([final], { nextByte: 160 }));
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    await child(coordinator, "research", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "finding." },
    });
    await child(coordinator, "research", { type: "message_end", message: final });
    await child(coordinator, "research", { type: "agent_end", messages: [final] });

    expect(messageCloses(deltas)).toEqual([
      expect.objectContaining({
        key: liveDeltas[0]?.key, text: "Final finding.",
        providerTurnId: childTurn("research"),
      }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "item.textDelta")).toEqual(liveDeltas);
    const assistantItemIds = events.flatMap((event) =>
      (event.type === "item/started" || event.type === "item/completed") &&
      event.item.type === "agentMessage" ? [event.item.id] : []);
    expect(assistantItemIds.length).toBeGreaterThan(0);
    expect(new Set(assistantItemIds).size).toBe(1);
    expect(events.filter((event) =>
      event.type === "item/completed" && event.item.type === "agentMessage")).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ text: "Final finding." }) }),
    ]);
  });

  it("deduplicates repeated persisted entry IDs across reset even when retained content changes", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    const first = assistant("Account 1234 owns the entry point.", 10);
    const rewritten = assistant("Account [redacted] owns the entry point.", 10);
    // A separate persisted entry may share a timestamp with the retained entry.
    const second = assistant("A second finding at the same timestamp.", 10);
    rpc.getSubagentMessages
      .mockResolvedValueOnce(page([first], { nextByte: 160 }))
      .mockResolvedValueOnce(page([rewritten, second], { reset: true, nextByte: 240 }))
      .mockResolvedValueOnce(page([rewritten, second], { fromByte: 240, nextByte: 240 }))
      .mockResolvedValueOnce(page([rewritten, second], { fromByte: 240, nextByte: 240 }));
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    const firstKey = messageCloses(deltas)[0]?.key;
    await coordinator.handleEvent(lifecycle("research", "started"));
    await coordinator.handleEvent(lifecycle("research", "started"));
    await coordinator.handleEvent(lifecycle("research", "completed"));

    expect(rpc.getSubagentMessages.mock.calls).toEqual([
      [{ subagentId: "research", fromByte: 0 }],
      [{ subagentId: "research", fromByte: 160 }],
      [{ subagentId: "research", fromByte: 240 }],
      [{ subagentId: "research", fromByte: 240 }],
    ]);
    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual([
      "Account 1234 owns the entry point.", "A second finding at the same timestamp.",
    ]);
    expect(messageCloses(deltas)[0]?.key).toEqual(firstKey);
    expect(new Set(messageCloses(deltas).map((delta) => delta.key.providerItemId)).size).toBe(2);
    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          summary: "openai/gpt-5 · 32 tokens\n\n::omp-agent-details{id=\"research\"}",
        }),
      }),
    ]);
  });

  it("recovers tool-call arguments from backfill even when the assistant message was already seen live", async () => {
    const { coordinator, rpc, deltas } = createHarness();
    const message = assistant("Inspecting the entry point.", 10, "probe-one");
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started"));
    await liveMessage(coordinator, "research", message, "Inspecting the entry point.");
    // The live tool_execution_start was lost, but the transcript has the call.
    rpc.getSubagentMessages.mockResolvedValue(page([message, toolResult("probe-one", 11)], { nextByte: 256 }));
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    expect(messageCloses(deltas)).toHaveLength(1);
    expect(toolRows(deltas)).toEqual([
      expect.objectContaining({
        kind: "item.open", key: expect.objectContaining({ providerItemId: `${providerId("research")}:tool:probe-one` }),
        item: expect.objectContaining({ tool: "probe", args: { path: "src/index.ts" } }),
      }),
      expect.objectContaining({ kind: "item.close", status: "completed" }),
    ]);
  });

  it.each([
    { label: "reset=true", reset: true, sessionFile: FILE },
    { label: "a replacement session file", reset: false, sessionFile: "/workspace/sessions/replaced.jsonl" },
  ])("preserves rendered identities across $label while rendering new records", async ({ reset, sessionFile }) => {
    const { coordinator, rpc, deltas } = createHarness();
    const first = assistant("First finding.", 10, "probe-one");
    const firstResult = toolResult("probe-one", 11);
    const second = assistant("Second finding.", 12, "probe-two");
    const secondResult = toolResult("probe-two", 13);
    rpc.getSubagentMessages
      .mockResolvedValueOnce(page([first, firstResult], { nextByte: 400 }))
      .mockResolvedValueOnce(page([first, firstResult, second, secondResult], {
        reset, sessionFile, nextByte: 200,
      }))
      .mockResolvedValueOnce(page([first, firstResult, second, secondResult], {
        sessionFile, fromByte: 200, nextByte: 200,
      }));
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    const originalKey = messageCloses(deltas)[0]?.key;
    await coordinator.handleEvent(lifecycle("research", "started"));
    await coordinator.handleEvent(lifecycle("research", "started"));

    expect(rpc.getSubagentMessages.mock.calls).toEqual([
      [{ subagentId: "research", fromByte: 0 }],
      [{ subagentId: "research", fromByte: 400 }],
      [{ subagentId: "research", fromByte: 200 }],
    ]);
    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["First finding.", "Second finding."]);
    expect(messageCloses(deltas)[0]?.key).toEqual(originalKey);
    expect(new Set(messageCloses(deltas).map((delta) => delta.key.providerItemId)).size).toBe(2);
    expect(toolRows(deltas).map((delta) => delta.kind)).toEqual([
      "item.open", "item.close", "item.open", "item.close",
    ]);
    expect(new Set(toolRows(deltas).map((delta) => delta.key.providerItemId)).size).toBe(2);
  });

  it("restores without rendering until the first turn, backfills then, and retains terminal history after roster removal", async () => {
    const { coordinator, rpc, deltas } = createHarness([
      snapshot("research", { sessionFile: FILE }),
    ]);
    const message = assistant("Recovered finding.", 10);
    rpc.getSubagentMessages.mockResolvedValue(page([message], { nextByte: 120 }));
    await coordinator.restore();
    expect(rpc.getSubagents).toHaveBeenCalledTimes(1);
    expect(rpc.getSubagentMessages).not.toHaveBeenCalled();
    expect(agentRosters(deltas)).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind !== "extension.state")).toEqual([]);
    await coordinator.onTurnStart();
    expect(rpc.getSubagentMessages).toHaveBeenCalledWith({ subagentId: "research", fromByte: 0 });
    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Recovered finding."]);
    await coordinator.handleEvent(lifecycle("research", "completed"));
    const rendered = [...deltas];
    rpc.getSubagents.mockResolvedValue([]);
    await coordinator.restore();
    await coordinator.onTurnStart();
    expect(rpc.getSubagents).toHaveBeenCalledTimes(2);
    expect(rpc.getSubagentMessages).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual(rendered);
    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({
        status: "completed", item: expect.objectContaining({ summary: "openai/gpt-5 · 16 tokens\n\n::omp-agent-details{id=\"research\"}" }),
      }),
    ]);
  });

  it("reopens a keep-alive child on explicit started without replaying its persisted transcript", async () => {
    const { coordinator, rpc, deltas, assembler, rootTurnId } = createHarness();
    const first = assistant("Initial transcript finding.", 10, "probe-one");
    const firstResult = toolResult("probe-one", 11);
    const followup = assistant("Follow-up finding.", 20);
    rpc.getSubagentMessages
      .mockResolvedValueOnce(page([first, firstResult], { nextByte: 120 }))
      .mockResolvedValueOnce(page([first, firstResult], { fromByte: 120, nextByte: 120 }))
      .mockResolvedValueOnce(page([first, firstResult], { fromByte: 120, nextByte: 120 }))
      .mockResolvedValueOnce(page([first, firstResult, followup], { fromByte: 120, nextByte: 240 }));
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {},
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      parentToolCallId: "task-one", sessionFile: FILE,
    }));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", exitCode: 0,
        output: "Initial authoritative result.", tokens: 99, durationMs: 2_000,
        resolvedModelIdentity: "openai/previous-model",
      }] } },
    });
    await coordinator.handleEvent(lifecycle("research", "completed", { sessionFile: FILE }));
    expect(delegationCloses(deltas)).toHaveLength(1);
    const beforeRestart = deltas.length;
    await coordinator.handleEvent(lifecycle("research", "started", { sessionFile: FILE }));
    const restarted = deltas.slice(beforeRestart);
    expect(restarted).toContainEqual(expect.objectContaining({
      kind: "item.open", key: { providerItemId: providerId("research") },
      item: expect.objectContaining({ type: "delegation", childRef: "research" }),
    }));
    expect(restarted).not.toContainEqual(expect.objectContaining({
      item: expect.objectContaining({ summary: expect.stringContaining("Initial authoritative result.") }),
    }));
    expect(messageCloses(restarted)).toEqual([]);
    expect(toolRows(restarted)).toEqual([]);
    expect(delegationCloses(deltas)).toHaveLength(1);
    await liveMessage(coordinator, "research", followup, "Follow-up finding.");
    await coordinator.handleEvent(lifecycle("research", "completed", { sessionFile: FILE }));

    expect(rpc.getSubagentMessages.mock.calls).toEqual([
      [{ subagentId: "research", fromByte: 0 }],
      [{ subagentId: "research", fromByte: 120 }],
      [{ subagentId: "research", fromByte: 120 }],
      [{ subagentId: "research", fromByte: 120 }],
    ]);
    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual([
      "Initial transcript finding.", "Follow-up finding.",
    ]);
    expect(new Set(messageCloses(deltas).map((delta) => delta.key.providerItemId)).size).toBe(2);
    expect(toolRows(deltas).map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
    expect(delegationCloses(deltas).map((delta) => [delta.key.providerItemId, delta.status])).toEqual([
      [providerId("research"), "completed"], [providerId("research"), "completed"],
    ]);
    expect(delegationCloses(deltas)[1]).toMatchObject({
      item: { summary: "openai/gpt-5 · 16 tokens\n\n::omp-agent-details{id=\"research\"}" },
    });
    expect(delegationCloses(deltas)[1]).not.toMatchObject({
      item: { summary: expect.stringMatching(/Initial authoritative result|previous-model|99 tokens/) },
    });
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      { kind: "turn.boundary", providerTurnId: childTurn("research"), status: "completed" },
      { kind: "turn.boundary", providerTurnId: childTurn("research"), status: "completed" },
    ]);
    expect(assembler.getOpenTurnId(THREAD)).toBe(rootTurnId);
  });

  it("waits for the authoritative blocking task result even after terminal lifecycle and a terminal progress batch", async () => {
    const { coordinator, deltas } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "task-one",
      args: { tasks: [{ name: "research", task: "Inspect the entry point", description: "Find the owner" }] },
    });
    await coordinator.handleEvent(lifecycle("research", "started", { parentToolCallId: "task-one" }));
    await child(coordinator, "research", {
      type: "message_end", message: assistant("Provisional finding.", 10, "probe-one"),
    });
    await coordinator.handleEvent(lifecycle("research", "completed", { parentToolCallId: "task-one" }));
    expect(delegationCloses(deltas)).toEqual([]);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
    expect(await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: {
        progress: [{ id: "research", index: 0, agent: "explore", status: "completed", tokens: 16 }],
        results: [{
          id: "research", index: 0, agent: "explore", exitCode: 0,
          output: "Final authoritative finding.", tokens: 42, durationMs: 1_250,
          resolvedModelIdentity: "openai/gpt-5",
        }],
      } },
    })).toBe(true);
    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({
        key: { providerItemId: providerId("research") }, status: "completed",
        item: expect.objectContaining({
          label: "research: Find the owner",
          summary: "Final authoritative finding.\n\nopenai/gpt-5 · 42 tokens · 1.3s\n\n::omp-agent-details{id=\"research\"}",
        }),
      }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      { kind: "turn.boundary", providerTurnId: childTurn("research"), status: "completed" },
    ]);
  });

  it.each([
    { lifecycleStatus: "failed" as const, status: "failed", exitCode: 1, aborted: false, output: "", error: "Probe failed" },
    { lifecycleStatus: "aborted" as const, status: "interrupted", exitCode: 0, aborted: true, output: "Partial finding", error: "Stopped" },
  ])("maps $lifecycleStatus results and child boundaries without settling the root", async ({ lifecycleStatus, status, exitCode, aborted, output, error }) => {
    const { coordinator, deltas, events, assembler, rootTurnId } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({ type: "tool_execution_start", toolName: "task", toolCallId: "task-one", args: {} });
    await coordinator.handleEvent(lifecycle("research", "started", { parentToolCallId: "task-one" }));
    await coordinator.handleEvent(lifecycle("research", lifecycleStatus));
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "task-one",
      result: { details: { results: [{
        id: "research", index: 0, agent: "explore", output, error, exitCode, aborted,
      }] } },
    });
    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({ status, item: expect.objectContaining({
        summary: `${[output, error].filter(Boolean).join("\n\n")}\n\n::omp-agent-details{id="research"}`,
      }) }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      { kind: "turn.boundary", providerTurnId: childTurn("research"), status },
    ]);
    expect(events.filter((event) => event.type === "turn/completed")).toEqual([
      expect.objectContaining({ status, scope: { kind: "turn", turnId: assembler.getBbTurnId(THREAD, childTurn("research")) } }),
    ]);
    expect(assembler.getOpenTurnId(THREAD)).toBe(rootTurnId);
  });

  it("queues out-of-order child events until lifecycle and links grandchildren to the owning delegation", async () => {
    const { coordinator, deltas } = createHarness();
    await coordinator.onTurnStart();
    const message = assistant("Queued finding.", 10);
    await liveMessage(coordinator, "research", message, "Queued finding.");
    await child(coordinator, "research", {
      type: "tool_execution_start", toolCallId: "nested-task", toolName: "task",
      args: { task: "Verify the finding" },
    });
    expect(deltas).toEqual([]);
    await coordinator.handleEvent(lifecycle("research", "started"));
    await coordinator.handleEvent(lifecycle("verify", "started", { parentToolCallId: "nested-task" }));
    await liveMessage(coordinator, "verify", assistant("Verified.", 11), "Verified.");
    expect(deltas[0]).toMatchObject({ kind: "item.open", item: { type: "delegation", childRef: "research" } });
    expect(messageCloses(deltas).map((delta) => delta.text)).toEqual(["Queued finding.", "Verified."]);
    expect(deltas).toContainEqual(expect.objectContaining({
      kind: "item.open",
      key: { providerItemId: providerId("verify"), parentRef: providerId("research") },
      item: expect.objectContaining({ type: "delegation", childRef: "verify" }),
    }));
    expect(messageCloses(deltas)[1]).toMatchObject({
      providerTurnId: childTurn("verify"), key: { parentRef: providerId("verify") },
    });
  });

  it("handles mixed valid task batches individually while leaving pre-spawn errors for the generic translator", async () => {
    const { coordinator, deltas } = createHarness();
    await coordinator.onTurnStart();
    expect(await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "rejected",
      result: { content: [{ type: "text", text: "Unknown agent" }] }, isError: true,
    })).toBe(false);
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "batch",
      args: { tasks: [
        { name: "research", task: "Inspect", description: "Research" },
        { name: "verify", task: "Check", description: "Verify" },
      ] },
    });
    expect(await coordinator.handleEvent({
      type: "tool_execution_update", toolName: "task", toolCallId: "batch",
      partialResult: { details: { progress: [
        { id: "research", index: 0, agent: "explore", status: "running" },
        { id: "bad", status: "unsupported" },
        { id: "verify", index: 1, agent: "explore", status: "running" },
      ] } },
    })).toBe(true);
    expect(await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "batch",
      result: { details: { results: [
        { id: "research", index: 0, agent: "explore", output: "Found it", exitCode: 0 },
        { id: "malformed", output: "Missing required metadata" },
        { id: "verify", index: 1, agent: "explore", output: "", error: "No access", exitCode: 1 },
      ] } },
    })).toBe(true);
    expect(delegationCloses(deltas).map((delta) => [delta.key.providerItemId, delta.status])).toEqual([
      [providerId("research"), "completed"], [providerId("verify"), "failed"],
    ]);
    expect(delegationCloses(deltas).map((delta) => delta.item)).toEqual([
      expect.objectContaining({ label: "research: Research", summary: "Found it\n\n::omp-agent-details{id=\"research\"}" }),
      expect.objectContaining({ label: "verify: Verify", summary: "No access\n\n::omp-agent-details{id=\"verify\"}" }),
    ]);
    expect(toolRows(deltas)).toEqual([]);
  });

  it("routes child transcript rows and terminal delegation updates after the root boundary without reopening it", async () => {
    const { coordinator, deltas, events, assembler, apply, rootTurnId } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent(lifecycle("research", "started", { detached: true, parentToolCallId: "batch" }));
    const delegationId = assembler.getBbItemId(THREAD, providerId("research"));
    const transcriptTurnId = assembler.getBbTurnId(THREAD, childTurn("research"));
    expect(delegationId).toBeDefined();
    expect(transcriptTurnId).toBeDefined();
    expect(assembler.getOpenTurnId(THREAD)).toBe(rootTurnId);
    apply([{ kind: "turn.boundary", status: "completed" }]);
    const afterRoot = events.length;
    await liveMessage(coordinator, "research", assistant("Late finding.", 10), "Late finding.");
    await child(coordinator, "research", {
      type: "tool_execution_start", toolCallId: "late-probe", toolName: "probe", args: { path: "src/index.ts" },
    });
    await child(coordinator, "research", {
      type: "tool_execution_end", toolCallId: "late-probe", toolName: "probe",
      result: { content: [{ type: "text", text: "Late result" }] }, isError: false,
    });
    await coordinator.handleEvent(lifecycle("research", "completed"));
    const lateEvents = events.slice(afterRoot);
    expect(messageCloses(deltas)).toEqual([
      expect.objectContaining({ text: "Late finding.", providerTurnId: childTurn("research"), key: expect.objectContaining({ parentRef: providerId("research") }) }),
    ]);
    expect(lateEvents).toContainEqual(expect.objectContaining({
      type: "item/completed", scope: { kind: "turn", turnId: transcriptTurnId },
      item: expect.objectContaining({ type: "agentMessage", text: "Late finding.", parentToolCallId: delegationId }),
    }));
    expect(lateEvents).toContainEqual(expect.objectContaining({
      type: "item/completed", scope: { kind: "turn", turnId: transcriptTurnId },
      item: expect.objectContaining({ type: "toolCall", tool: "probe", status: "completed", parentToolCallId: delegationId }),
    }));
    expect(lateEvents).toContainEqual(expect.objectContaining({
      type: "item/delegation/completed",
      item: expect.objectContaining({ id: delegationId, status: "completed", summary: "openai/gpt-5 · 16 tokens\n\n::omp-agent-details{id=\"research\"}" }),
    }));
    expect(lateEvents.filter((event) => event.type === "turn/completed")).toEqual([
      expect.objectContaining({ scope: { kind: "turn", turnId: transcriptTurnId }, status: "completed" }),
    ]);
    expect(lateEvents.some((event) => event.type === "turn/started")).toBe(false);
    expect(assembler.getOpenTurnId(THREAD)).toBeUndefined();
  });

  it("keeps newer per-run counters when stale task progress arrives, but accepts authoritative final usage", async () => {
    const { coordinator, deltas } = createHarness();
    await coordinator.onTurnStart();
    await coordinator.handleEvent({
      type: "tool_execution_start", toolName: "task", toolCallId: "batch",
      args: { tasks: [{ name: "research" }, { name: "verify" }] },
    });
    await coordinator.handleEvent(lifecycle("research", "started", {
      index: 0, detached: true, parentToolCallId: "batch",
    }));
    await coordinator.handleEvent(lifecycle("verify", "started", {
      index: 1, detached: true, parentToolCallId: "batch",
    }));
    for (const [id, index, tokens, toolCount, durationMs] of [
      ["research", 0, 100, 5, 5_000], ["verify", 1, 20, 2, 1_000],
    ] as const) {
      await coordinator.handleEvent({
        type: "subagent_progress",
        payload: {
          parentToolCallId: "batch", detached: true,
          progress: { id, index, agent: "explore", status: "running", tokens, toolCount, durationMs },
        },
      });
    }
    await coordinator.handleEvent(lifecycle("research", "completed"));
    const beforeStale = deltas.length;
    await coordinator.handleEvent({
      type: "tool_execution_update", toolName: "task", toolCallId: "batch",
      partialResult: { details: { progress: [
        { id: "research", index: 0, agent: "explore", status: "completed", tokens: 0, toolCount: 0, durationMs: 0 },
        { id: "verify", index: 1, agent: "explore", status: "running", tokens: 0, toolCount: 0, durationMs: 0 },
      ] } },
    });
    const staleSnapshots = workflowSnapshots(deltas.slice(beforeStale));
    expect(staleSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of staleSnapshots) {
      expect(snapshot).toMatchObject({
        taskStatus: "running", status: "pending",
        workflow: { agents: [
          { label: "research", state: "done", tokens: 100, toolCalls: 5, durationMs: 5_000 },
          { label: "verify", state: "running", tokens: 20, toolCalls: 2, durationMs: 1_000 },
        ] },
        usage: { totalTokens: 120, toolUses: 7, durationMs: 5_000 },
      });
    }
    expect(workflowCloses(deltas)).toEqual([]);
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "batch",
      result: { details: { results: [
        { id: "research", index: 0, agent: "explore", exitCode: 0, output: "Owner found", tokens: 80, durationMs: 4_500 },
        { id: "verify", index: 1, agent: "explore", exitCode: 0, output: "Verified", tokens: 10, durationMs: 900 },
      ] } },
    });
    expect(workflowCloses(deltas)).toEqual([
      expect.objectContaining({
        status: "completed",
        item: expect.objectContaining({
          usage: { totalTokens: 90, toolUses: 7, durationMs: 4_500 },
          workflow: expect.objectContaining({ agents: [
            expect.objectContaining({ label: "research", state: "done", tokens: 80, durationMs: 4_500 }),
            expect.objectContaining({ label: "verify", state: "done", tokens: 10, durationMs: 900 }),
          ] }),
        }),
      }),
    ]);
  });

  it("groups detached siblings into ordered workflow snapshots and aggregates final output and usage", async () => {
    const { coordinator, deltas } = createHarness();
    const familyId = `omp-subagents:${SESSION}:batch`;
    await coordinator.onTurnStart();
    await coordinator.handleEvent({ type: "tool_execution_start", toolName: "task", toolCallId: "batch", args: { tasks: [{}, {}] } });
    await coordinator.handleEvent(lifecycle("verify", "started", { index: 1, detached: true, parentToolCallId: "batch" }));
    await coordinator.handleEvent(lifecycle("research", "started", { index: 0, detached: true, parentToolCallId: "batch" }));
    for (const [id, index, tokens, toolCount, durationMs] of [
      ["research", 0, 20, 2, 1_000], ["verify", 1, 30, 3, 1_500],
    ] as const) {
      await coordinator.handleEvent({ type: "subagent_progress", payload: {
        parentToolCallId: "batch", detached: true,
        progress: { id, index, agent: "explore", status: "running", tokens, toolCount, durationMs, resolvedModelIdentity: "openai/gpt-5", currentTool: "probe", currentToolIntent: "Checking the entry point" },
      } });
    }
    await liveMessage(coordinator, "research", assistant("Found the owner", 10), "Found the owner");
    expect(workflowSnapshots(deltas).at(-1)).toMatchObject({
      familyId, taskStatus: "running", status: "pending",
      workflow: { agents: [
        { index: 1, label: "research", state: "running", model: "openai/gpt-5", tokens: 20, toolCalls: 2, lastToolName: "probe" },
        { index: 2, label: "verify", state: "running", model: "openai/gpt-5", tokens: 30, toolCalls: 3 },
      ] },
      usage: { totalTokens: 50, toolUses: 5, durationMs: 1_500 },
    });
    await coordinator.handleEvent(lifecycle("research", "completed"));
    expect(workflowCloses(deltas)).toEqual([]);
    await coordinator.handleEvent({
      type: "tool_execution_end", toolName: "task", toolCallId: "batch",
      result: { details: { results: [
        { id: "research", index: 0, agent: "explore", exitCode: 0, output: "Found the owner", tokens: 25, durationMs: 1_200 },
        { id: "verify", index: 1, agent: "explore", exitCode: 1, output: "", error: "Verification failed", tokens: 35, durationMs: 1_800 },
      ] } },
    });
    expect(workflowCloses(deltas)).toEqual([
      expect.objectContaining({
        key: { providerItemId: familyId }, status: "failed",
        item: expect.objectContaining({
          taskStatus: "failed", status: "failed",
          usage: { totalTokens: 60, toolUses: 5, durationMs: 1_800 },
          workflow: expect.objectContaining({ agents: [
            expect.objectContaining({ label: "research", state: "done", resultPreview: "Found the owner" }),
            expect.objectContaining({ label: "verify", state: "failed", error: "Verification failed" }),
          ] }),
          summary: expect.stringContaining("Found the owner"),
        }),
      }),
    ]);
    expect(workflowSnapshots(deltas).at(-1)?.summary).toContain("Verification failed");
    const closedDelegations = delegationCloses(deltas).map((delta) => delta.item);
    expect(closedDelegations).toHaveLength(2);
    expect(closedDelegations).toEqual(expect.arrayContaining([
      expect.objectContaining({ childRef: "research", summary: "openai/gpt-5 · 25 tokens · 1.2s\n\n::omp-agent-details{id=\"research\"}" }),
      expect.objectContaining({ childRef: "verify", summary: "Verification failed\n\nopenai/gpt-5 · 35 tokens · 1.8s\n\n::omp-agent-details{id=\"verify\"}" }),
    ]));
    expect(workflowSnapshots(deltas).at(-1)?.summary).not.toContain("::omp-agent-details");
    expect(workflowSnapshots(deltas).at(-1)?.workflow?.agents.map((agent) => agent.label).join(" "))
      .not.toContain("::omp-agent-details");
  });

  it("includes all restored detached siblings before considering a workflow terminal", async () => {
    const { coordinator, deltas } = createHarness([
      snapshot("research", { status: "completed", detached: true, parentToolCallId: "batch" }),
      snapshot("verify", { index: 1, detached: true, parentToolCallId: "batch" }),
    ]);
    await coordinator.restore();
    await coordinator.onTurnStart();
    expect(workflowSnapshots(deltas)[0]).toMatchObject({
      familyId: `omp-subagents:${SESSION}:batch`, status: "pending", taskStatus: "running",
      workflow: { agents: [
        { index: 1, label: "research", state: "done" },
        { index: 2, label: "verify", state: "running" },
      ] },
    });
    expect(workflowCloses(deltas)).toEqual([]);
    await coordinator.handleEvent(lifecycle("verify", "aborted"));
    expect(workflowCloses(deltas)).toEqual([
      expect.objectContaining({ status: "interrupted", item: expect.objectContaining({ taskStatus: "stopped" }) }),
    ]);
  });

  it("settles an already-gone child when native cancellation returns false", async () => {
    const { coordinator, rpc, deltas } = createHarness([
      snapshot("research", { detached: true }),
    ]);
    await coordinator.restore();
    await coordinator.onTurnStart();
    rpc.cancelSubagent.mockResolvedValue(false);

    await expect(coordinator.stopTask(providerId("research"))).resolves.toBeUndefined();

    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({ status: "interrupted" }),
    ]);
    expect(workflowCloses(deltas)).toEqual([
      expect.objectContaining({
        status: "interrupted",
        item: expect.objectContaining({ taskStatus: "stopped" }),
      }),
    ]);
    await expect(coordinator.steer("research", "Too late")).rejects.toThrow("No running OMP subagent research");
  });

  it("preserves a child completion received during an already-gone cancellation", async () => {
    const { coordinator, rpc, deltas } = createHarness([snapshot("research")]);
    await coordinator.restore();
    await coordinator.onTurnStart();
    rpc.cancelSubagent.mockImplementation(async () => {
      await coordinator.handleEvent(lifecycle("research", "completed"));
      return false;
    });

    await expect(coordinator.stopTask(providerId("research"))).resolves.toBeUndefined();

    expect(delegationCloses(deltas)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("reports genuine native cancellation failures without settling the child", async () => {
    const { coordinator, rpc, deltas } = createHarness([snapshot("research")]);
    await coordinator.restore();
    await coordinator.onTurnStart();
    rpc.cancelSubagent.mockRejectedValue(new Error("Transport disconnected"));

    await expect(coordinator.stopTask(providerId("research"))).rejects.toThrow("Transport disconnected");

    expect(delegationCloses(deltas)).toEqual([]);
  });

  it("uses native RPC controls for running family members and rejects terminal steering", async () => {
    const { coordinator, rpc } = createHarness([
      snapshot("research", { detached: true, parentToolCallId: "batch" }),
      snapshot("verify", { index: 1, detached: true, parentToolCallId: "batch" }),
    ]);
    await coordinator.restore();
    await coordinator.onTurnStart();
    await coordinator.steer("research", "Check the exported API instead.");
    expect(rpc.steerSubagent).toHaveBeenCalledWith("research", "Check the exported API instead.");
    await coordinator.handleEvent(lifecycle("research", "completed"));
    await coordinator.stopTask(`omp-subagents:${SESSION}:batch`);
    expect(rpc.cancelSubagent.mock.calls).toEqual([["verify"]]);
    await expect(coordinator.steer("research", "Too late")).rejects.toThrow("No running OMP subagent research");
    expect(rpc.steerSubagent).toHaveBeenCalledTimes(1);
  });
});
