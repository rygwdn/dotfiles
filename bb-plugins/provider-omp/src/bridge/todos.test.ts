import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOmpTodoCoordinator } from "./todos.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const planSnapshotSchema = z.object({
  kind: z.literal("item.close"),
  status: z.literal("completed"),
  key: z.object({ channel: z.literal("planSteps") }),
  item: z.object({
    type: z.literal("planSteps"),
    steps: z.array(z.object({
      step: z.string(),
      status: z.enum(["pending", "active", "completed", "failed"]),
    })),
  }),
});

const onePhase = [{
  name: "Work",
  tasks: [{ content: "Implement", status: "in_progress" as const }],
}];

function isPlanSnapshot(delta: Record<string, unknown>): boolean {
  return delta.kind === "item.close" && typeof delta.item === "object" &&
    delta.item !== null && "type" in delta.item && delta.item.type === "planSteps";
}

function isToolClose(delta: Record<string, unknown>, name: string): boolean {
  return delta.kind === "item.close" && typeof delta.item === "object" &&
    delta.item !== null && "type" in delta.item && delta.item.type === "tool" &&
    "tool" in delta.item && delta.item.tool === name;
}

describe("canonical OMP todos in native bb planSteps", () => {
  let harness: FakeOmpBridgeHarness;
  let nextId = 40_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-todos-", initialize: true });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function snapshots(threadId: string) {
    return harness.deltasOf(threadId).filter(isPlanSnapshot)
      .map((delta) => planSnapshotSchema.parse(delta).item.steps);
  }

  async function start(threadId: string) {
    const response = await harness.startThread(threadId);
    expect(response.error).toBeUndefined();
    return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  }

  async function turn(threadId: string, providerThreadId: string, text: string) {
    const since = harness.deltasOf(threadId).length;
    const response = await harness.request(++nextId, "turn/start", {
      threadId, providerThreadId, clientRequestId: "creq_td23456789",
      input: [{ type: "text", text, mentions: [] }], options: FULL_PERMISSION_OPTIONS,
    });
    expect(response.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, since);
    return harness.deltasOf(threadId).slice(since);
  }

  it("keeps the generic todo row and publishes all task statuses as a completed snapshot", async () => {
    const threadId = "thr_todo_statuses";
    const providerThreadId = await start(threadId);
    const deltas = await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ phases: [{
      name: "Only phase",
      tasks: [
        { content: "Current", status: "in_progress" },
        { content: "Next", status: "pending" },
        { content: "Done", status: "completed" },
        { content: "Dropped", status: "abandoned" },
        { content: "Waiting", status: "blocked", blocker: "API access" },
      ],
    }] })}`);
    expect(snapshots(threadId)).toEqual([[
      { step: "Current", status: "active" },
      { step: "Next", status: "pending" },
      { step: "Done", status: "completed" },
      { step: "Dropped", status: "failed" },
      { step: "Waiting (blocked: API access)", status: "pending" },
    ]]);
    const toolIndex = deltas.findIndex((delta) => isToolClose(delta, "todo"));
    const snapshotIndex = deltas.findLastIndex(isPlanSnapshot);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(toolIndex);
    expect(snapshotIndex).toBeLessThan(deltas.findIndex((delta) => delta.kind === "turn.boundary"));
  }, 90_000);

  it("flattens phases in order, prefixes only multi-phase steps, and truncates at 240 UTF-16 units", async () => {
    const threadId = "thr_todo_phases";
    const providerThreadId = await start(threadId);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ phases: [
      { name: "Build", tasks: [
        { content: `${"x".repeat(231)}😀tail`, status: "pending" },
        { content: "Second", status: "completed" },
      ] },
      { name: "Ship", tasks: [
        { content: "Release", status: "blocked", blocker: "Approval" },
        { content: "z".repeat(250), status: "pending" },
      ] },
    ] })}`);
    expect(snapshots(threadId).at(-1)).toEqual([
      { step: `Build · ${"x".repeat(231)}`, status: "pending" },
      { step: "Build · Second", status: "completed" },
      { step: "Ship · Release (blocked: Approval)", status: "pending" },
      { step: `Ship · ${"z".repeat(233)}`, status: "pending" },
    ]);
  }, 90_000);

  it("refreshes nested eval todos and turn-end state without repeating unchanged snapshots", async () => {
    const threadId = "thr_todo_nested";
    const providerThreadId = await start(threadId);
    const deltas = await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via: "eval", phases: onePhase })}`);
    expect(snapshots(threadId)).toEqual([[{ step: "Implement", status: "active" }]]);
    const evalIndex = deltas.findIndex((delta) => isToolClose(delta, "eval"));
    expect(evalIndex).toBeGreaterThanOrEqual(0);
    expect(deltas.findLastIndex(isPlanSnapshot)).toBeGreaterThan(evalIndex);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via: "eval", phases: onePhase })}`);
    await turn(threadId, providerThreadId, "An unrelated turn");
    expect(snapshots(threadId)).toHaveLength(1);
    const completed = [{ name: "Work", tasks: [{ content: "Implement", status: "completed" }] }];
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via: "turn", phases: completed })}`);
    expect(snapshots(threadId)).toEqual([
      [{ step: "Implement", status: "active" }],
      [{ step: "Implement", status: "completed" }],
    ]);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ phases: completed })}`);
    expect(snapshots(threadId)).toHaveLength(2);
  }, 90_000);

  it.each(["todo", "eval"])("clears the native card with an empty %s snapshot only once", async (via) => {
    const threadId = `thr_todo_clear_${via}`;
    const providerThreadId = await start(threadId);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via, phases: onePhase })}`);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via, phases: [] })}`);
    expect(snapshots(threadId)).toEqual([[{ step: "Implement", status: "active" }], []]);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via, phases: [] })}`);
    expect(snapshots(threadId)).toHaveLength(2);
  }, 90_000);

  it("seeds start and resume from canonical get_state and publishes after the bb turn opens", async () => {
    const threadId = "thr_todo_resume";
    vi.stubEnv("FAKE_OMP_TODO_PHASES", JSON.stringify(onePhase));
    const providerThreadId = await start(threadId);
    expect(snapshots(threadId)).toEqual([]);
    await turn(threadId, providerThreadId, "Initial turn");
    expect(snapshots(threadId)).toEqual([[{ step: "Implement", status: "active" }]]);
    const completed = [{ name: "Work", tasks: [{ content: "Implement", status: "completed" }] }];
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via: "eval", phases: completed })}`);
    await harness.request(++nextId, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    });
    vi.stubEnv("FAKE_OMP_TODO_PHASES", "[]");
    // The resumed child must recover the nested update from its session, not startup env.
    const resumed = await harness.request(++nextId, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error).toBeUndefined();
    await turn(threadId, providerThreadId, "Resumed turn");
    expect(snapshots(threadId)).toEqual([
      [{ step: "Implement", status: "active" }],
      [{ step: "Implement", status: "completed" }],
      [{ step: "Implement", status: "completed" }],
    ]);
  }, 90_000);

  it("ignores failed todo details and incomplete-only reminder frames", async () => {
    const threadId = "thr_todo_canonical";
    const providerThreadId = await start(threadId);
    const phases = [{ name: "Work", tasks: [
      { content: "Implement", status: "in_progress" },
      { content: "Research", status: "completed" },
    ] }];
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ phases })}`);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ isError: true, phases: [] })}`);
    await turn(threadId, providerThreadId, `/todos ${JSON.stringify({ via: "reminder", phases: onePhase })}`);
    expect(snapshots(threadId)).toEqual([[
      { step: "Implement", status: "active" },
      { step: "Research", status: "completed" },
    ]]);
  }, 90_000);
});

describe("todo coordinator trigger ordering", () => {
  it.each([
    { todoPhases: [] },
    { todoPhases: [{ name: "Empty phase", tasks: [] }] },
  ])(
    "does not publish an initial empty canonical plan $todoPhases at root start or refresh",
    async ({ todoPhases }) => {
      const publish = vi.fn();
      const readState = vi.fn(async () => ({ todoPhases }));
      const todos = createOmpTodoCoordinator({ publish, readState });
      await todos.refresh();
      await todos.handleEvent({ type: "agent_start" });
      await todos.refresh();
      await todos.handleEvent({ type: "tool_execution_end", toolName: "eval" });
      await todos.handleEvent({ type: "turn_end" });
      await todos.handleEvent({ type: "agent_end" });
      await todos.handleEvent({ type: "agent_start" });
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("publishes exactly one empty snapshot after clearing a non-empty plan", async () => {
    let current = onePhase;
    const publish = vi.fn();
    const todos = createOmpTodoCoordinator({
      publish,
      readState: async () => ({ todoPhases: current }),
    });
    await todos.refresh();
    await todos.handleEvent({ type: "agent_start" });
    current = [];
    await todos.refresh();
    await todos.refresh();
    await todos.handleEvent({ type: "tool_execution_end", toolName: "eval" });
    current = [{ name: "Empty phase", tasks: [] }];
    await todos.refresh();
    await todos.handleEvent({ type: "agent_end" });
    await todos.handleEvent({ type: "agent_start" });
    expect(publish.mock.calls.map(([deltas]) => deltas[0].item)).toEqual([
      { type: "planSteps", steps: [{ step: "Implement", status: "active" }] },
      { type: "planSteps", steps: [] },
    ]);
  });

  it("uses successful tool details immediately and awaits the final get_state refresh before closing", async () => {
    let current = onePhase;
    const publish = vi.fn();
    const readState = vi.fn(async () => ({ todoPhases: current }));
    const todos = createOmpTodoCoordinator({ publish, readState });
    await todos.refresh();
    expect(publish).not.toHaveBeenCalled();
    await todos.handleEvent({ type: "agent_start" });
    readState.mockClear();
    await todos.handleEvent({
      type: "tool_execution_end", toolName: "todo", isError: false,
      result: { details: { phases: [] } },
    });
    expect(readState).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0][0].item).toEqual({ type: "planSteps", steps: [] });
    current = [{ name: "Work", tasks: [{ content: "Final update", status: "in_progress" }] }];
    await todos.handleEvent({ type: "agent_end", settlementOnly: true });
    expect(publish.mock.calls.at(-1)?.[0][0].item).toEqual({
      type: "planSteps", steps: [{ step: "Final update", status: "active" }],
    });
    expect(readState).toHaveBeenCalledTimes(1);
  });

  it("keeps a local refresh cached if its turn ends before canonical state returns", async () => {
    const reply = Promise.withResolvers<{ todoPhases: typeof onePhase }>();
    let localTurnActive = true;
    const publish = vi.fn();
    const todos = createOmpTodoCoordinator({ publish, readState: () => reply.promise });
    const refresh = todos.refresh(() => localTurnActive);
    localTurnActive = false;
    reply.resolve({ todoPhases: onePhase });
    await refresh;
    expect(publish).not.toHaveBeenCalled();
    await todos.handleEvent({ type: "agent_start" });
    expect(publish.mock.calls.at(-1)?.[0][0].item).toEqual({
      type: "planSteps", steps: [{ step: "Implement", status: "active" }],
    });
  });

  it("preserves the last canonical snapshot if a refresh fails", async () => {
    const publish = vi.fn();
    const readState = vi.fn(async () => ({ todoPhases: onePhase }));
    const todos = createOmpTodoCoordinator({ publish, readState });
    await todos.refresh();
    await todos.handleEvent({ type: "agent_start" });
    readState.mockRejectedValueOnce(new Error("child exited"));
    await todos.handleEvent({ type: "agent_end", settlementOnly: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
