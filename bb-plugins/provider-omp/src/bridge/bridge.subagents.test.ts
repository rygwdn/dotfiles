import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OmpRpcSession } from "./rpc-session.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const objectSchema = z.record(z.string(), z.unknown());
const itemKeySchema = z.object({
  providerItemId: z.string().optional(),
  parentRef: z.string().optional(),
  channel: z.string().optional(),
});
const delegationRowSchema = z.object({
  kind: z.enum(["item.open", "item.close"]),
  key: z.object({ providerItemId: z.string(), parentRef: z.string().optional() }),
  item: z.object({
    type: z.literal("delegation"),
    childRef: z.string(),
    label: z.string(),
    background: z.boolean(),
    summary: z.string().optional(),
  }),
  status: z.string().optional(),
});
const nativeLifecycleSchema = z.object({
  type: z.literal("subagent_lifecycle"),
  payload: z.object({ id: z.string(), sessionFile: z.string(), status: z.string() }),
});

function shapeOf(delta: Record<string, unknown>): Record<string, unknown> {
  return objectSchema.parse(delta.item ?? delta.snapshot ?? {});
}

function isItem(delta: Record<string, unknown>, type: string, kind?: string): boolean {
  return (kind === undefined || delta.kind === kind) && shapeOf(delta).type === type;
}

function isChildTurn(delta: Record<string, unknown>): boolean {
  return typeof delta.providerTurnId === "string" && delta.providerTurnId.startsWith("omp-subagent:");
}

function rootBoundaries(deltas: Record<string, unknown>[]): Record<string, unknown>[] {
  return deltas.filter((delta) => delta.kind === "turn.boundary" && !isChildTurn(delta));
}

function expectRootTurnState(deltas: Record<string, unknown>[], expectedOpen: boolean): void {
  let open = false;
  for (const delta of deltas) {
    if (isChildTurn(delta)) continue;
    if (delta.kind === "turn.open") {
      expect(open, "a root or local command cannot open over another root").toBe(false);
      open = true;
    } else if (delta.kind === "turn.boundary") {
      expect(open, "a child completion cannot close an already completed root").toBe(true);
      open = false;
    }
  }
  expect(open).toBe(expectedOpen);
}

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => objectSchema.parse(JSON.parse(line)));
}

function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const { id, ...fields } = command;
  expect(id).toEqual(expect.any(String));
  return fields;
}

interface FixtureSpec {
  scenario: "batch" | "backfill" | "reset" | "detached" | "yielded" | "error";
  id?: string;
  holdParent?: boolean;
  followUpOnCancel?: boolean;
  holdFollowUp?: boolean;
  tasks?: Array<{ name: string; task?: string; description?: string; assignment?: string }>;
}

describe("native OMP subagents through the bb bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let rpcLog: string;
  let eventLog: string;
  let nextId = 50_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-subagents-", initialize: true });
    rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    eventLog = join(harness.workspaceDir, "events.jsonl");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
    vi.stubEnv("FAKE_OMP_EVENT_LOG", eventLog);
  });

  afterEach(async () => {
    await harness.teardown();
  });

  async function start(threadId: string): Promise<string> {
    const response = await harness.startThread(threadId);
    expect(response.error).toBeUndefined();
    return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  }

  async function sendInput(
    threadId: string,
    providerThreadId: string,
    text: string,
    method: "turn/start" | "turn/steer" = "turn/start",
  ): Promise<number> {
    const since = harness.deltasOf(threadId).length;
    const response = await harness.request(++nextId, method, {
      threadId, providerThreadId, clientRequestId: "creq_sa23456789",
      ...(method === "turn/steer" ? { expectedTurnId: "turn-1" } : {}),
      input: [{ type: "text", text, mentions: [] }], options: FULL_PERMISSION_OPTIONS,
    });
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    return since;
  }

  async function waitForRootEnd(threadId: string, since: number): Promise<void> {
    await harness.waitForDelta(threadId,
      (delta) => delta.kind === "turn.boundary" && !isChildTurn(delta), since);
  }

  async function fixture(threadId: string, providerThreadId: string, spec: FixtureSpec) {
    const since = await sendInput(threadId, providerThreadId, `/subagents ${JSON.stringify(spec)}`);
    await waitForRootEnd(threadId, since);
    return harness.deltasOf(threadId).slice(since);
  }

  function expectSingleChildTranscript(
    deltas: Record<string, unknown>[], providerThreadId: string, id: string, texts: string[], live: boolean,
  ): void {
    const delegationId = `omp-subagent:${providerThreadId}:${id}`;
    const children = deltas.filter((delta) => itemKeySchema.parse(delta.key ?? {}).parentRef === delegationId);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child).toMatchObject({
        providerTurnId: `${delegationId}:transcript`,
        key: { parentRef: delegationId, providerItemId: expect.stringContaining(`${delegationId}:`) },
      });
    }
    expect(children.filter((delta) => delta.kind === "item.textClose" && delta.channel === "agentMessage")
      .map((delta) => delta.text)).toEqual(texts);
    expect(children.filter((delta) => delta.kind === "item.textClose" && delta.channel === "reasoningText")
      .map((delta) => delta.text)).toEqual([`${id} reasoning café`]);
    const tools = children.filter((delta) => isItem(delta, "tool"));
    expect(tools.filter((delta) => delta.kind === "item.open")).toHaveLength(1);
    expect(tools.filter((delta) => delta.kind === "item.close")).toEqual([
      expect.objectContaining({
        kind: "item.close", status: "completed", resultText: `${id} file contents café`,
        key: { parentRef: delegationId, providerItemId: `${delegationId}:tool:${id}-read-1` },
        item: expect.objectContaining({ type: "tool", tool: "read", args: { path: `${id}.txt` } }),
      }),
    ]);
    const streamed = children.filter((delta) => delta.kind === "item.textDelta" && delta.channel === "agentMessage")
      .map((delta) => delta.text).join("");
    expect(streamed).toBe(live ? texts.slice(0, 2).join("") : "");
  }

  it("opens one delegation per batch child, nests native rows, and keeps authoritative summary metadata", async () => {
    const threadId = "thr_subagent_batch";
    const providerThreadId = await start(threadId);
    const deltas = await fixture(threadId, providerThreadId, { scenario: "batch" });
    const openings = deltas.filter((delta) => isItem(delta, "delegation", "item.open"))
      .map((delta) => delegationRowSchema.parse(delta));
    const closures = deltas.filter((delta) => isItem(delta, "delegation", "item.close"))
      .map((delta) => delegationRowSchema.parse(delta));
    expect(openings.map((row) => row.item)).toEqual([
      expect.objectContaining({ childRef: "worker-a", label: "worker-a: Inspect parsing", background: false }),
      expect.objectContaining({ childRef: "worker-b", label: "worker-b: Review streaming", background: false }),
    ]);
    expect(closures).toEqual(["worker-a", "worker-b"].map((id, index) => expect.objectContaining({
      status: "completed", key: { providerItemId: `omp-subagent:${providerThreadId}:${id}` },
      item: expect.objectContaining({
        childRef: id,
        summary: `Fake Mini · ${(1_234 + index).toLocaleString("en-US")} tokens · ${(2.5 + index).toFixed(1)}s\n\n::omp-agent-details{id="${id}"}`,
      }),
    })));
    for (const id of ["worker-a", "worker-b"]) {
      expectSingleChildTranscript(deltas, providerThreadId, id,
        [`${id} live analysis café 🧪`, `${id} final answer: café ✅`], true);
      expect(deltas).toContainEqual(expect.objectContaining({
        kind: "turn.open", parentRef: `omp-subagent:${providerThreadId}:${id}`,
        providerTurnId: `omp-subagent:${providerThreadId}:${id}:transcript`,
      }));
    }
    expect(deltas.filter((delta) => isItem(delta, "tool") && shapeOf(delta).tool === "task")).toEqual([]);
    expect(deltas.findLast((delta) => delta.kind === "usage")).toMatchObject({
      last: { totalTokens: 17 }, total: { totalTokens: 17 },
    });
    expect(rootBoundaries(deltas)).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary" && isChildTurn(delta))).toHaveLength(2);
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(3);
    expect(deltas.indexOf(rootBoundaries(deltas)[0]!)).toBeGreaterThan(
      deltas.findLastIndex((delta) => isItem(delta, "delegation", "item.close")),
    );

    const events = readJsonLines(eventLog);
    for (const id of ["worker-a", "worker-b"]) {
      const lifecycle = events.map((event) => nativeLifecycleSchema.safeParse(event))
        .find((parsed) => parsed.success && parsed.data.payload.id === id);
      if (!lifecycle?.success) throw new Error(`missing lifecycle for ${id}`);
      const records = readJsonLines(lifecycle.data.payload.sessionFile);
      const messages = records.filter((entry) => entry.type === "message").map((entry) => objectSchema.parse(entry.message));
      expect(records[0]).toMatchObject({ type: "session", version: 3, timestamp: expect.any(String) });
      expect(messages.every((message) => typeof message.timestamp === "number")).toBe(true);
      expect(messages).toContainEqual(expect.objectContaining({
        role: "assistant", content: expect.arrayContaining([
          { type: "toolCall", id: `${id}-read-1`, name: "read", arguments: { path: `${id}.txt` } },
        ]),
      }));
      expect(messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: `${id}-read-1` }));
      for (const event of events.filter((event) => event.type === "subagent_event")) {
        const payload = objectSchema.parse(event.payload);
        const child = objectSchema.parse(payload.event);
        if (payload.id === id && child.type === "message_end") expect(messages).toContainEqual(child.message);
      }
    }
  }, 90_000);

  it.each(["backfill", "reset"] as const)("reconstructs %s history without duplicate text or tool rows", async (scenario) => {
    const threadId = `thr_subagent_${scenario}`;
    const providerThreadId = await start(threadId);
    const id = "replay-worker";
    const deltas = await fixture(threadId, providerThreadId, { scenario, id });
    const texts = [`${id} live analysis café 🧪`, `${id} final answer: café ✅`,
      ...(scenario === "reset" ? [`${id} after reset: naïve ✅`] : [])];
    expectSingleChildTranscript(deltas, providerThreadId, id, texts, scenario === "reset");
    const cursors = readJsonLines(rpcLog)
      .filter((command) => command.type === "get_subagent_messages" && command.subagentId === id)
      .map((command) => z.number().parse(command.fromByte));
    expect(cursors[0]).toBe(0);
    expect(cursors.some((cursor) => cursor > 0)).toBe(true);
    if (scenario === "reset") {
      expect(cursors.some((cursor, index) => index > 0 && cursor < cursors[index - 1]!)).toBe(true);
      expect(cursors.some((cursor) => cursor > 16_384)).toBe(true);
    } else {
      expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    }
    expect(rootBoundaries(deltas)).toHaveLength(1);
    expect(deltas.filter((delta) => isItem(delta, "delegation", "item.close"))).toHaveLength(1);
  }, 90_000);

  it("restores the active roster with an events subscription and defers transcript publication to a root turn", async () => {
    vi.stubEnv("FAKE_OMP_SUBAGENTS", JSON.stringify([{
      id: "restored-worker", task: "Recover persisted child history", description: "Recovered inspection",
      parentToolCallId: "restored-task-42", detached: true,
    }]));
    const threadId = "thr_subagent_restore";
    const providerThreadId = await start(threadId);
    expect(harness.deltasOf(threadId).some((delta) => isItem(delta, "delegation"))).toBe(false);
    const commands = readJsonLines(rpcLog);
    const subscription = commands.find((command) => command.type === "set_subagent_subscription");
    const restore = commands.find((command) => command.type === "get_subagents");
    expect(subscription).toEqual({ id: expect.any(String), type: "set_subagent_subscription", level: "events" });
    expect(restore).toEqual({ id: expect.any(String), type: "get_subagents" });
    expect(commands.indexOf(subscription!)).toBeLessThan(commands.indexOf(restore!));

    const since = await sendInput(threadId, providerThreadId, "Continue with the restored worker");
    await waitForRootEnd(threadId, since);
    expectSingleChildTranscript(harness.deltasOf(threadId), providerThreadId, "restored-worker",
      ["restored-worker live analysis café 🧪"], false);
    expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
      kind: "item.open", item: expect.objectContaining({
        type: "delegation", childRef: "restored-worker", label: "restored-worker · Fake Mini: Recovered inspection", background: true,
      }),
    }));
    const second = await sendInput(threadId, providerThreadId, "Refresh unchanged history");
    await waitForRootEnd(threadId, second);
    expectSingleChildTranscript(harness.deltasOf(threadId), providerThreadId, "restored-worker",
      ["restored-worker live analysis café 🧪"], false);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "get_subagents")).toHaveLength(1);
  }, 90_000);

  it("keeps a grouped backgroundTask alive after its spawning turn and closes only when the last child stops", async () => {
    const threadId = "thr_subagent_background";
    const providerThreadId = await start(threadId);
    const deltas = await fixture(threadId, providerThreadId, {
      scenario: "detached", tasks: [
        { name: "background-a", task: "Inspect request parsing", description: "Inspect parsing" },
        { name: "background-b", task: "Review streaming order", description: "Review streaming" },
      ],
    });
    const nativeTask = readJsonLines(eventLog).find((event) => event.type === "tool_execution_start" && event.toolName === "task");
    const parentToolCallId = z.string().parse(nativeTask?.toolCallId);
    const familyId = `omp-subagents:${providerThreadId}:${parentToolCallId}`;
    const workflows = deltas.filter((delta) => isItem(delta, "backgroundTask"));
    expect(workflows.filter((delta) => delta.kind === "item.open")).toHaveLength(1);
    expect(workflows.some((delta) => delta.kind === "item.close")).toBe(false);
    expect(workflows.at(-1)).toMatchObject({
      kind: "item.progress", key: { providerItemId: familyId }, snapshot: {
        type: "backgroundTask", familyId, workflowName: "OMP subagents", taskStatus: "running", status: "pending",
        workflow: { agents: [
          expect.objectContaining({ index: 1, state: "running", promptPreview: "Inspect request parsing", model: "fake-provider/fake-mini" }),
          expect.objectContaining({ index: 2, state: "running", promptPreview: "Review streaming order", model: "fake-provider/fake-mini" }),
        ] },
      },
    });
    expect(rootBoundaries(deltas)).toHaveLength(1);
    expect(deltas.some((delta) => isItem(delta, "delegation", "item.close"))).toBe(false);

    const message = "Focus on café\nThen report 🧪";
    const afterParent = harness.deltasOf(threadId).length;
    await sendInput(threadId, providerThreadId, `/omp-agent steer background-a ${message}`);
    const delegationId = `omp-subagent:${providerThreadId}:background-a`;
    await harness.waitForDelta(threadId,
      (delta) => delta.kind === "item.textClose" && delta.text === `Steered background-a: ${message}`, afterParent);
    expect(harness.deltasOf(threadId).slice(afterParent)).toContainEqual(expect.objectContaining({
      kind: "item.textClose", providerTurnId: `${delegationId}:transcript`, key: expect.objectContaining({ parentRef: delegationId }),
    }));
    await sendInput(threadId, providerThreadId, "/omp-agent cancel background-a");
    await harness.waitForDelta(threadId, (delta) => isItem(delta, "delegation", "item.close") &&
      shapeOf(delta).childRef === "background-a");
    expect(harness.deltasOf(threadId).filter((delta) => isItem(delta, "backgroundTask", "item.close"))).toEqual([]);
    await sendInput(threadId, providerThreadId, `/omp-agent cancel ${familyId}`);
    await harness.waitForDelta(threadId, (delta) => isItem(delta, "backgroundTask", "item.close"));
    const all = harness.deltasOf(threadId);
    expect(all.filter((delta) => isItem(delta, "backgroundTask", "item.close"))).toEqual([
      expect.objectContaining({
        status: "interrupted", key: { providerItemId: familyId }, item: expect.objectContaining({
          type: "backgroundTask", taskStatus: "stopped", status: "interrupted",
          usage: { totalTokens: 2_401, toolUses: 2, durationMs: 3_000 },
          workflow: expect.objectContaining({ agents: [
            expect.objectContaining({ state: "skipped" }), expect.objectContaining({ state: "skipped" }),
          ] }),
        }),
      }),
    ]);
    expect(rootBoundaries(all)).toHaveLength(4); // Spawning turn plus three explicit command turns.
    expect(all.findLast((delta) => delta.kind === "usage")).toMatchObject({
      last: { totalTokens: 17 }, total: { totalTokens: 17 },
    });
    expect(all.filter((delta) => delta.kind === "turn.boundary" && isChildTurn(delta))).toHaveLength(2);
    const commands = readJsonLines(rpcLog);
    expect(commands.filter((command) => command.type === "steer_subagent").map(withoutRequestId)).toEqual([
      { type: "steer_subagent", subagentId: "background-a", message },
    ]);
    expect(commands.filter((command) => command.type === "cancel_subagent").map(withoutRequestId)).toEqual([
      { type: "cancel_subagent", subagentId: "background-a" },
      { type: "cancel_subagent", subagentId: "background-b" },
    ]);
    expect(commands.filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(commands.some((command) => command.type === "steer")).toBe(false);
  }, 90_000);

  it("completes a yielded root before session settlement and gives its cancellation wake a distinct root turn", async () => {
    const threadId = "thr_subagent_yielded";
    const providerThreadId = await start(threadId);
    const id = "yielded-worker";
    const initial = await fixture(threadId, providerThreadId, { scenario: "yielded", id, holdFollowUp: true });
    expectRootTurnState(initial, false);
    expect(rootBoundaries(initial)).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(initial.filter((delta) => isItem(delta, "delegation", "item.open"))).toHaveLength(1);
    expect(initial.some((delta) => isItem(delta, "delegation", "item.close"))).toBe(false);
    expect(initial.filter((delta) => isItem(delta, "backgroundTask")).at(-1)).toMatchObject({
      kind: "item.progress", snapshot: { type: "backgroundTask", status: "pending", taskStatus: "running" },
    });
    const prompt = readJsonLines(rpcLog).find((command) => command.type === "prompt");
    expect(readJsonLines(eventLog)).toContainEqual(expect.objectContaining({
      type: "agent_end", yielded: true, awaitingAsyncWork: true, isTerminal: false,
    }));
    expect(readJsonLines(eventLog)).toContainEqual(expect.objectContaining({
      type: "prompt_result", id: prompt?.id, status: "completed", agentInvoked: true, sessionSettled: false,
    }));
    expect(readJsonLines(eventLog).some((event) => event.type === "session_settled")).toBe(false);

    const afterYield = harness.deltasOf(threadId).length;
    await sendInput(threadId, providerThreadId, `/omp-agent steer ${id} Keep working after the yield`);
    await harness.waitForDelta(threadId,
      (delta) => delta.kind === "item.textClose" && delta.text === `Steered ${id}: Keep working after the yield`, afterYield);
    const childId = `omp-subagent:${providerThreadId}:${id}`;
    const afterSteer = harness.deltasOf(threadId);
    expect(afterSteer.slice(afterYield)).toContainEqual(expect.objectContaining({
      kind: "item.textClose", providerTurnId: `${childId}:transcript`,
      key: expect.objectContaining({ parentRef: childId }),
    }));
    expectRootTurnState(afterSteer, false);
    expect(rootBoundaries(afterSteer)).toHaveLength(2); // Yielded root and the standalone steer acknowledgement.
    expect(afterSteer.some((delta) => isItem(delta, "backgroundTask", "item.close"))).toBe(false);

    const beforeCancel = await sendInput(threadId, providerThreadId, `/omp-agent cancel ${id}`);
    await harness.waitFor(() => {
      const deltas = harness.deltasOf(threadId);
      const rootOpens = deltas.filter((delta) => delta.kind === "turn.open" && !isChildTurn(delta)).length;
      return rootOpens === rootBoundaries(deltas).length + 1 &&
        deltas.some((delta) => isItem(delta, "backgroundTask", "item.close"));
    }, "the automatic root to remain open after the child closes");
    const resumed = harness.deltasOf(threadId);
    expectRootTurnState(resumed, true);
    const automaticOpen = resumed.findLastIndex((delta) => delta.kind === "turn.open" && !isChildTurn(delta));
    expect(automaticOpen).toBeGreaterThanOrEqual(beforeCancel);
    expect(rootBoundaries(resumed.slice(automaticOpen))).toEqual([]);
    expect(resumed.filter((delta) => delta.kind === "turn.boundary" && isChildTurn(delta))).toEqual([
      expect.objectContaining({ providerTurnId: `${childId}:transcript`, status: "interrupted" }),
    ]);
    expect(resumed.findLast((delta) => delta.kind === "usage")).toMatchObject({
      last: { totalTokens: 17 }, total: { totalTokens: 17 },
    });
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_start")).toHaveLength(2);
    expect(readJsonLines(eventLog).some((event) => event.type === "session_settled")).toBe(false);

    await sendInput(threadId, providerThreadId, "Finish autonomous root", "turn/steer");
    await waitForRootEnd(threadId, automaticOpen);
    const completed = harness.deltasOf(threadId);
    expectRootTurnState(completed, false);
    expect(rootBoundaries(completed.slice(automaticOpen))).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    const rootOpens = completed.filter((delta) => delta.kind === "turn.open" && !isChildTurn(delta));
    // A queued native start permits a complete standalone cancel acknowledgement
    // before it; an already delivered start must not receive a synthetic turn.
    expect(rootOpens.length).toBeGreaterThanOrEqual(3);
    expect(rootOpens.length).toBeLessThanOrEqual(4);
    expect(rootBoundaries(completed)).toHaveLength(rootOpens.length);
    const answer = completed.slice(automaticOpen).find((delta) =>
      delta.kind === "item.textClose" && delta.text === "Steered: Finish autonomous root");
    expect(answer).toBeDefined();
    expect(itemKeySchema.parse(answer?.key ?? {}).parentRef).toBeUndefined();
    expect(completed.findLast((delta) => delta.kind === "usage")).toMatchObject({
      last: { totalTokens: 17 }, total: { totalTokens: 34 },
    });
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_end")).toHaveLength(2);
    expect(readJsonLines(eventLog).filter((event) => event.type === "session_settled")).toHaveLength(1);
    const commands = readJsonLines(rpcLog);
    expect(commands.filter((command) => command.type === "prompt")).toHaveLength(1);
    expect(commands.filter((command) => command.type === "steer_subagent").map(withoutRequestId)).toEqual([
      { type: "steer_subagent", subagentId: id, message: "Keep working after the yield" },
    ]);
    expect(commands.filter((command) => command.type === "cancel_subagent").map(withoutRequestId)).toEqual([
      { type: "cancel_subagent", subagentId: id },
    ]);
    expect(commands.filter((command) => command.type === "steer").map((command) => command.message))
      .toEqual(["Finish autonomous root"]);
  }, 90_000);

  it("does not let a yielded child's closure complete a newer held root turn", async () => {
    const threadId = "thr_subagent_yielded_new_root";
    const providerThreadId = await start(threadId);
    const id = "prior-root-worker";
    await fixture(threadId, providerThreadId, { scenario: "yielded", id, followUpOnCancel: false });
    const newRoot = await sendInput(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open" && !isChildTurn(delta), newRoot);
    await sendInput(threadId, providerThreadId, `/omp-agent steer ${id} Keep the new root isolated`, "turn/steer");
    await harness.waitForDelta(threadId,
      (delta) => delta.kind === "item.textClose" && delta.text === `Steered ${id}: Keep the new root isolated`, newRoot);
    await sendInput(threadId, providerThreadId, `/omp-agent cancel ${id}`, "turn/steer");
    await harness.waitForDelta(threadId, (delta) => isItem(delta, "backgroundTask", "item.close"), newRoot);
    const duringNewRoot = harness.deltasOf(threadId);
    expectRootTurnState(duringNewRoot, true);
    expect(rootBoundaries(duringNewRoot.slice(newRoot))).toEqual([]);
    expect(duringNewRoot.filter((delta) => delta.kind === "turn.open" && !isChildTurn(delta))).toHaveLength(2);
    expect(duringNewRoot).toContainEqual(expect.objectContaining({
      kind: "turn.boundary", providerTurnId: `omp-subagent:${providerThreadId}:${id}:transcript`, status: "interrupted",
    }));
    expect(readJsonLines(eventLog).some((event) => event.type === "session_settled")).toBe(false);
    await sendInput(threadId, providerThreadId, "Finish new root", "turn/steer");
    await waitForRootEnd(threadId, newRoot);
    const completed = harness.deltasOf(threadId);
    expectRootTurnState(completed, false);
    expect(rootBoundaries(completed)).toHaveLength(2);
    expect(completed.filter((delta) => delta.kind === "turn.open" && !isChildTurn(delta))).toHaveLength(2);
    expect(completed.slice(newRoot)).toContainEqual(expect.objectContaining({
      kind: "item.textClose", text: "Steered: Finish new root",
    }));
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_start")).toHaveLength(2);
    expect(readJsonLines(eventLog).filter((event) => event.type === "prompt_result").map((event) => event.sessionSettled))
      .toEqual([false, true]);
  }, 90_000);

  it.each(["steer", "cancel"] as const)("intercepts turn/steer %s controls while the parent is held without adding a root turn boundary", async (operation) => {
    const threadId = `thr_subagent_${operation}_active`;
    const providerThreadId = await start(threadId);
    const since = await sendInput(threadId, providerThreadId,
      `/subagents ${JSON.stringify({ scenario: "detached", id: "held-worker", holdParent: true })}`);
    await harness.waitFor(() => readJsonLines(eventLog)
      .some((event) => event.type === "tool_execution_end" && event.toolName === "task"), "the task spawn to finish");
    expect(rootBoundaries(harness.deltasOf(threadId).slice(since))).toEqual([]);
    const command = operation === "steer"
      ? "/omp-agent steer held-worker Keep inspecting café" : "/omp-agent cancel held-worker";
    await sendInput(threadId, providerThreadId, command, "turn/steer");
    await waitForRootEnd(threadId, since);
    expect(rootBoundaries(harness.deltasOf(threadId).slice(since))).toHaveLength(1);
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.open" && !isChildTurn(delta))).toHaveLength(1);
    expect(readJsonLines(rpcLog).filter((command) => command.type === `${operation}_subagent`).map(withoutRequestId)).toEqual([
      { type: `${operation}_subagent`, subagentId: "held-worker", ...(operation === "steer" ? { message: "Keep inspecting café" } : {}) },
    ]);
    expect(readJsonLines(rpcLog).some((command) => command.type === "steer")).toBe(false);
  }, 90_000);

  it.each(["interrupt", "exit"] as const)("interrupts open detached rows when the OMP session receives %s", async (ending) => {
    const threadId = `thr_subagent_cleanup_${ending}`;
    const providerThreadId = await start(threadId);
    await fixture(threadId, providerThreadId, { scenario: "detached", id: "interrupted-worker" });
    if (ending === "interrupt") {
      const stopped = await harness.request(++nextId, "thread/stop", {
        threadId, providerThreadId, intent: "interrupt", activeTurnId: null,
      });
      expect(stopped.error).toBeUndefined();
      expect(stopped.result).toMatchObject({ ok: true });
    } else {
      await harness.request(++nextId, "turn/start", {
        threadId, providerThreadId, clientRequestId: "creq_sb23456789",
        input: [{ type: "text", text: "/die", mentions: [] }], options: FULL_PERMISSION_OPTIONS,
      });
    }
    await harness.waitForDelta(threadId, (delta) => isItem(delta, "backgroundTask", "item.close"));
    const deltas = harness.deltasOf(threadId);
    expect(deltas.filter((delta) => isItem(delta, "delegation", "item.close"))).toEqual([
      expect.objectContaining({
        status: "interrupted",
        key: { providerItemId: `omp-subagent:${providerThreadId}:interrupted-worker` },
        item: expect.objectContaining({ childRef: "interrupted-worker" }),
      }),
    ]);
    expect(deltas.filter((delta) => isItem(delta, "backgroundTask", "item.close"))).toEqual([
      expect.objectContaining({ status: "interrupted", item: expect.objectContaining({ taskStatus: "stopped" }) }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary" && isChildTurn(delta))).toEqual([
      expect.objectContaining({
        providerTurnId: `omp-subagent:${providerThreadId}:interrupted-worker:transcript`, status: "interrupted",
      }),
    ]);
    if (ending === "exit") {
      await harness.waitFor(() => harness.runningChildPids().length === 0, "the exited OMP process to be reaped");
    }
  }, 90_000);

  it("retains the normal failed task row when spawning is rejected before any child exists", async () => {
    const threadId = "thr_subagent_spawn_error";
    const providerThreadId = await start(threadId);
    const deltas = await fixture(threadId, providerThreadId, { scenario: "error" });
    expect(deltas.filter((delta) => isItem(delta, "delegation"))).toEqual([]);
    expect(deltas.filter((delta) => isItem(delta, "backgroundTask"))).toEqual([]);
    expect(deltas.filter((delta) => isItem(delta, "tool", "item.close") && shapeOf(delta).tool === "task")).toEqual([
      expect.objectContaining({ status: "failed", resultText: "No such agent: missing-worker" }),
    ]);
    expect(rootBoundaries(deltas)).toEqual([expect.objectContaining({ status: "completed" })]);
  }, 90_000);

  it("implements UTF-8 byte cursors, partial records, reset, and terminal transcript references in the real RPC wrapper", async () => {
    vi.stubEnv("FAKE_OMP_SUBAGENTS", JSON.stringify([{ id: "cursor-worker", parentToolCallId: "cursor-parent" }]));
    const session = new OmpRpcSession({
      cwd: harness.workspaceDir, sessionDir: join(harness.workspaceDir, "cursor-sessions"),
      scratchDir: join(harness.workspaceDir, "cursor-scratch"), recordThreadId: "thr_subagent_cursor",
    }, async () => ({ content: "", isError: true }), () => undefined, () => undefined);
    try {
      await session.start();
      expect(await session.getSubagents()).toEqual([
        expect.objectContaining({ id: "cursor-worker", status: "running", parentToolCallId: "cursor-parent" }),
      ]);
      const initial = await session.getSubagentMessages({ subagentId: "cursor-worker" });
      const original = readFileSync(initial.sessionFile);
      expect(initial).toMatchObject({ fromByte: 0, nextByte: original.length, reset: false });
      expect(initial.entries[0]).toMatchObject({ type: "session", version: 3 });
      expect(initial.messages.some((message) => message.role === "toolResult")).toBe(true);
      expect(await session.getSubagentMessages({ subagentId: "cursor-worker", fromByte: initial.nextByte + 0.9 }))
        .toMatchObject({ fromByte: initial.nextByte, nextByte: initial.nextByte, reset: false, entries: [], messages: [] });
      expect(await session.getSubagentMessages({ subagentId: "cursor-worker", fromByte: -3.9 }))
        .toMatchObject({ fromByte: 0, reset: false, messages: initial.messages });

      const padding = `${JSON.stringify({ type: "custom", id: "padding", customType: "cursor-padding", data: "x".repeat(16_384) })}\n`;
      appendFileSync(initial.sessionFile, padding);
      const padded = await session.getSubagentMessages({ sessionFile: initial.sessionFile, fromByte: initial.nextByte });
      expect(padded.nextByte).toBe(initial.nextByte + Buffer.byteLength(padding));
      expect(padded.messages).toEqual([]);
      const message = { role: "assistant", content: [{ type: "text", text: "Byte cursor café 🧪" }], timestamp: 1_700_000_000_001 };
      const line = JSON.stringify({ type: "message", id: "partial", parentId: "padding", timestamp: "2023-11-14T22:13:20.001Z", message });
      appendFileSync(initial.sessionFile, line);
      expect(await session.getSubagentMessages({ subagentId: "cursor-worker", fromByte: padded.nextByte }))
        .toMatchObject({ fromByte: padded.nextByte, nextByte: padded.nextByte, reset: false, entries: [], messages: [] });
      appendFileSync(initial.sessionFile, "\n");
      const complete = await session.getSubagentMessages({ subagentId: "cursor-worker", fromByte: padded.nextByte });
      expect(complete).toMatchObject({ nextByte: padded.nextByte + Buffer.byteLength(`${line}\n`), messages: [message] });

      writeFileSync(initial.sessionFile, Buffer.concat([original, Buffer.from(`${line}\n`)]));
      const reset = await session.getSubagentMessages({ sessionFile: initial.sessionFile, fromByte: complete.nextByte });
      expect(reset).toMatchObject({ fromByte: 0, nextByte: original.length + Buffer.byteLength(`${line}\n`), reset: true });
      expect(reset.messages).toEqual([...initial.messages, message]);
      expect(await session.getSubagentMessages({ subagentId: "cursor-worker", fromByte: reset.nextByte }))
        .toMatchObject({ reset: false, nextByte: reset.nextByte, entries: [], messages: [] });
      await session.steerSubagent("cursor-worker", "Inspect bytes, not characters");
      expect(await session.cancelSubagent("cursor-worker")).toBe(true);
      expect(await session.cancelSubagent("cursor-worker")).toBe(false);
      expect(await session.getSubagents()).toEqual([]);
      const terminal = await session.getSubagentMessages({ subagentId: "cursor-worker", fromByte: 0 });
      expect(terminal.sessionFile).toBe(initial.sessionFile);
      expect(terminal.messages).toContainEqual(expect.objectContaining({
        role: "assistant", content: [{ type: "text", text: "Steered cursor-worker: Inspect bytes, not characters" }],
      }));
      expect(terminal.messages).toContainEqual(expect.objectContaining({ role: "assistant", stopReason: "aborted" }));
      expect(readJsonLines(rpcLog)).toContainEqual({
        id: expect.any(String), type: "get_subagent_messages", sessionFile: initial.sessionFile, fromByte: complete.nextByte,
      });
    } finally {
      await session.closeGracefully(1_000);
    }
  }, 90_000);
});
