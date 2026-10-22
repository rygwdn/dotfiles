import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  FULL_PERMISSION_OPTIONS,
  startFakeOmpBridge,
  type FakeOmpBridgeHarness,
} from "./test-support.js";

const objectSchema = z.record(z.string(), z.unknown());
const toolCloseSchema = z.object({
  kind: z.literal("item.close"),
  key: z.object({ providerItemId: z.string() }),
  providerTurnId: z.string().optional(),
  status: z.enum(["completed", "failed", "interrupted"]),
  resultText: z.string(),
  item: z.object({
    type: z.literal("tool"),
    tool: z.literal("btw"),
    args: z.object({ question: z.string().optional(), recordId: z.string().optional(), operation: z.string().optional() }),
  }),
});

function btwCloses(deltas: Record<string, unknown>[]) {
  return deltas.flatMap((delta) => {
    const parsed = toolCloseSchema.safeParse(delta);
    return parsed.success ? [parsed.data] : [];
  });
}

function rootBoundaries(deltas: Record<string, unknown>[]) {
  return deltas.filter((delta) => (delta.kind === "turn.open" && !delta.parentRef) ||
    (delta.kind === "turn.boundary" && !delta.providerTurnId));
}

function expectSettledLocalTurns(deltas: Record<string, unknown>[]) {
  const roots = rootBoundaries(deltas);
  expect(roots.filter((delta) => delta.kind === "turn.open")).toHaveLength(
    roots.filter((delta) => delta.kind === "turn.boundary").length,
  );
  for (const child of deltas.filter((delta) => delta.kind === "turn.open" && delta.providerTurnId)) {
    expect(child.parentRef).toEqual(expect.any(String));
  }
}

describe("OMP native side-question controls", () => {
  let harness: FakeOmpBridgeHarness;
  let rpcLog: string;
  let nextId = 280_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-btw-controls-", initialize: true });
    rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
  }, 90_000);

  afterEach(async () => {
    await harness.teardown();
  }, 90_000);

  async function start(threadId: string) {
    const response = await harness.startThread(threadId);
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  }

  function commands() {
    return existsSync(rpcLog) ? readFileSync(rpcLog, "utf8").split("\n").filter(Boolean)
      .map((line) => objectSchema.parse(JSON.parse(line))) : [];
  }

  async function submit(threadId: string, providerThreadId: string, text: string, steer = false) {
    const since = harness.deltasOf(threadId).length;
    const clientRequestId = `creq_${randomUUID().replace(/-/gu, "").replace(/[01]/gu, "a").slice(0, 10)}`;
    const response = await harness.request(++nextId, steer ? "turn/steer" : "turn/start", {
      threadId, providerThreadId, clientRequestId,
      ...(steer ? { expectedTurnId: "turn-root" } : {}),
      input: [{ type: "text", text, mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    return { since, clientRequestId, response };
  }

  async function result(threadId: string, since: number, predicate: (close: z.infer<typeof toolCloseSchema>) => boolean) {
    await harness.waitForDelta(threadId, (delta) => btwCloses([delta]).some(predicate), since);
    const close = btwCloses(harness.deltasOf(threadId).slice(since)).find(predicate);
    if (!close) throw new Error("Missing side-question result");
    return close;
  }

  it("lists empty history, follows a topic by its id, and keeps same-text follow-ups distinct", async () => {
    const threadId = "thr_btw_follow";
    const providerThreadId = await start(threadId);
    const empty = await submit(threadId, providerThreadId, "/btw history");
    expect(empty.response.error).toBeUndefined();
    const emptyCard = await result(threadId, empty.since, (close) => close.item.args.operation === "history");
    expect(emptyCard.resultText).toBe("No OMP side-question history.");
    const question = "Explain that tradeoff";
    const first = await submit(threadId, providerThreadId, `/btw ${question}`);
    const original = await result(threadId, first.since, (close) => close.item.args.question === question);
    const recordId = original.item.args.recordId;
    expect(recordId).toBeTruthy();
    const second = await submit(threadId, providerThreadId, `/btw follow ${recordId} ${question}`);
    expect(second.response.error).toBeUndefined();
    const follow = await result(threadId, second.since, (close) => close.item.args.question === question);
    expect(follow.item.args.recordId).toBe(recordId);
    expect(follow.key).not.toEqual(original.key);
    expect(follow.providerTurnId).not.toBe(original.providerTurnId);
    const history = await submit(threadId, providerThreadId, "/btw history");
    const historyCard = await result(threadId, history.since, (close) => close.item.args.operation === "history");
    expect(historyCard.resultText).toContain(`Topic: ${recordId}`);
    expect(historyCard.resultText).toContain(`Question (complete): ${question}`);
    expect(historyCard.resultText).toContain(`Follow-up 1 (complete): ${question}`);
    expect(historyCard.resultText.match(/Side answer:/gu)).toHaveLength(2);
    expect(commands().filter((command) => command.type === "btw")).toEqual([
      expect.objectContaining({ question }),
      expect.objectContaining({ question, recordId }),
    ]);
    expect(commands().filter((command) => command.type === "btw")[0]).not.toHaveProperty("recordId");
    expect(commands().filter((command) => command.type === "get_btw_history")).toHaveLength(2);
    expect(commands().filter((command) => command.type === "prompt")).toEqual([]);
    expectSettledLocalTurns(harness.deltasOf(threadId));
  }, 90_000);

  it("surfaces an unknown follow-up topic without invoking or settling a root run", async () => {
    const threadId = "thr_btw_unknown";
    const providerThreadId = await start(threadId);
    const call = await submit(threadId, providerThreadId, "/btw follow missing-topic What happened?");
    expect(call.response.error).toBeUndefined();
    const failed = await result(threadId, call.since, (close) => close.status === "failed");
    expect(failed.resultText).toContain("Unknown /btw topic: missing-topic");
    expect(failed.item.args).toMatchObject({ recordId: "missing-topic", question: "What happened?" });
    expectSettledLocalTurns(harness.deltasOf(threadId));
    expect(commands().filter((command) => command.type === "prompt")).toEqual([]);
    expect(harness.deltasOf(threadId).slice(call.since).filter((delta) => delta.kind === "input.accepted")).toEqual([
      expect.objectContaining({ clientRequestId: call.clientRequestId }),
    ]);
  }, 90_000);

  it("keeps the authoritative cancellation when a side question is cancelled before its start acknowledgement", async () => {
    vi.stubEnv("FAKE_OMP_BTW_CANCEL_DURING_START", "1");
    const threadId = "thr_btw_cancel_start";
    const providerThreadId = await start(threadId);
    const call = await submit(threadId, providerThreadId, "/btw Cancelled during startup");
    const terminal = await result(threadId, call.since, (close) =>
      close.item.args.question === "Cancelled during startup",
    );
    expect(terminal.status).toBe("interrupted");
    const barrier = await submit(threadId, providerThreadId, "/btw history");
    await result(threadId, barrier.since, (close) => close.item.args.operation === "history");
    const sideResults = btwCloses(harness.deltasOf(threadId).slice(call.since))
      .filter((close) => close.item.args.question === "Cancelled during startup");
    expect(sideResults).toEqual([terminal]);
    expect(harness.messages.filter((message) => message.method === "error")).toEqual([]);
  }, 90_000);

  it("cancels a starting/running question once and admits a later question after a busy error", async () => {
    vi.stubEnv("FAKE_OMP_BTW_RELEASE_FILE", join(harness.workspaceDir, "release-btw"));
    vi.stubEnv("FAKE_OMP_DUPLICATE_BTW_RECORD", "1");
    const threadId = "thr_btw_cancel";
    const providerThreadId = await start(threadId);
    const first = await submit(threadId, providerThreadId, "/btw First side question");
    expect(first.response.error).toBeUndefined();
    const busy = await submit(threadId, providerThreadId, "/btw Another side question");
    const refused = await result(threadId, busy.since, (close) => close.status === "failed");
    expect(refused.resultText).toContain("still running");
    const cancelled = await submit(threadId, providerThreadId, "/btw cancel");
    const cancellation = await result(threadId, cancelled.since, (close) => close.item.args.operation === "cancel");
    expect(cancellation.resultText).toBe("Side question cancelled.");
    const firstResult = await result(threadId, first.since, (close) => close.item.args.question === "First side question");
    expect(firstResult.status).toBe("interrupted");
    expect(firstResult.resultText).toContain("Side question cancelled.");
    const again = await submit(threadId, providerThreadId, "/btw cancel");
    expect((await result(threadId, again.since, (close) => close.item.args.operation === "cancel")).resultText).toContain("No side question");
    expect(btwCloses(harness.deltasOf(threadId)).filter((close) => close.item.args.question === "First side question")).toHaveLength(1);
    writeFileSync(join(harness.workspaceDir, "release-btw"), "continue", "utf8");
    const later = await submit(threadId, providerThreadId, "/btw A later question");
    expect((await result(threadId, later.since, (close) => close.item.args.question === "A later question")).status).toBe("completed");
    expect(commands().filter((command) => command.type === "btw_cancel")).toHaveLength(2);
    expectSettledLocalTurns(harness.deltasOf(threadId));
  }, 90_000);

  it("keeps the side card addressable when a concurrent root finishes before the side answer", async () => {
    const releaseFile = join(harness.workspaceDir, "release-btw");
    vi.stubEnv("FAKE_OMP_BTW_RELEASE_FILE", releaseFile);
    const threadId = "thr_btw_after_root";
    const providerThreadId = await start(threadId);
    await submit(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open" && !delta.providerTurnId);
    const side = await submit(threadId, providerThreadId, "/btw Answer after the root", true);
    await harness.waitForDelta(threadId, (delta) => delta.kind === "item.progress" &&
      objectSchema.parse(delta.snapshot).type === "backgroundTask", side.since);
    await submit(threadId, providerThreadId, "Finish the real root", true);
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.boundary" && !delta.providerTurnId, side.since);
    const rootEnd = harness.deltasOf(threadId).length;
    writeFileSync(releaseFile, "continue", "utf8");
    const answer = await result(threadId, rootEnd, (close) => close.item.args.question === "Answer after the root");
    expect(answer.status).toBe("completed");
    expect(answer.resultText).toContain("Side answer: Answer after the root");
    expect(rootBoundaries(harness.deltasOf(threadId).slice(rootEnd))).toEqual([]);
    expect(rootBoundaries(harness.deltasOf(threadId))).toEqual([
      expect.objectContaining({ kind: "turn.open" }),
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]);
  }, 90_000);

  it("preserves full long terminal answers without a size-limited extension-state projection", async () => {
    const answer = `Authoritative side answer\n${"complete ".repeat(12_000)}`;
    vi.stubEnv("FAKE_OMP_BTW_ANSWER", answer);
    const threadId = "thr_btw_long";
    const providerThreadId = await start(threadId);
    const call = await submit(threadId, providerThreadId, "/btw Long side answer");
    const complete = await result(threadId, call.since, (close) => close.item.args.question === "Long side answer");
    expect(complete.resultText).toContain(answer);
    expect(complete.resultText).not.toContain("Partial BTW");
    expect(harness.deltasOf(threadId).slice(call.since).filter((delta) => delta.kind === "extension.state")).toEqual([]);
  }, 90_000);

  it("reads completed native history after releasing and resuming a side-only session", async () => {
    const threadId = "thr_btw_resume";
    const providerThreadId = await start(threadId);
    expect((await harness.request(++nextId, "thread/name/set", {
      threadId, providerThreadId, title: "Saved side questions",
    })).error).toBeUndefined();
    const call = await submit(threadId, providerThreadId, "/btw Saved across resume");
    await result(threadId, call.since, (close) => close.item.args.question === "Saved across resume");
    expect((await harness.request(++nextId, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    })).error).toBeUndefined();
    const resumed = await harness.request(++nextId, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
    const history = await submit(threadId, providerThreadId, "/btw history");
    const card = await result(threadId, history.since, (close) => close.item.args.operation === "history");
    expect(card.resultText).toContain("Topic: btw-1");
    expect(card.resultText).toContain("Question (complete): Saved across resume");
    expect(card.resultText).toContain("Side answer: Saved across resume");
  }, 90_000);

  it("renders recovered interrupted history without treating it as a root failure", async () => {
    vi.stubEnv("FAKE_OMP_BTW_HISTORY", JSON.stringify([{
      id: "recovered-topic", leafId: null, question: "Previously interrupted question",
      answer: "Native saved partial answer", status: "interrupted", createdAt: 10, updatedAt: 20,
    }]));
    const threadId = "thr_btw_interrupted_history";
    const providerThreadId = await start(threadId);
    const history = await submit(threadId, providerThreadId, "/btw history");
    const card = await result(threadId, history.since, (close) => close.item.args.operation === "history");
    expect(card.status).toBe("completed");
    expect(card.resultText).toContain("Topic: recovered-topic");
    expect(card.resultText).toContain("Question (interrupted): Previously interrupted question");
    expect(card.resultText).toContain("Native saved partial answer");
    expect(harness.messages.filter((message) => message.method === "error")).toEqual([]);
  }, 90_000);

  it.each(["/btw", "/btw follow", "/btw follow topic-only", "/btw cancel extra", "/btw history extra"])("rejects malformed %s without dispatching native work", async (text) => {
    const threadId = "thr_btw_usage";
    const providerThreadId = await start(threadId);
    const call = await submit(threadId, providerThreadId, text);
    expect(call.response.error).toMatchObject({ message: expect.stringContaining("Usage: /btw") });
    expect(harness.deltasOf(threadId).slice(call.since)).toEqual([]);
    expect(commands().filter((command) => ["btw", "btw_cancel", "get_btw_history", "prompt"].includes(String(command.type)))).toEqual([]);
  }, 90_000);
});
