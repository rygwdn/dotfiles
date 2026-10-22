import { expect, it } from "vitest";
import { z } from "zod";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { FULL_PERMISSION_OPTIONS, startFakeOmpBridge } from "./test-support.js";

it("reports all three model calls and USD cost, then retains native totals after release/resume", async () => {
  const harness = await startFakeOmpBridge({ prefix: "bb-omp-usage-", initialize: true });
  try {
    const threadId = "usage-resume";
    const start = await harness.startThread(threadId);
    expect(start.error).toBeUndefined();
    const { providerThreadId } = z.object({ providerThreadId: z.string() }).parse(start.result);
    const since = harness.deltasOf(threadId).length;
    const turn = await harness.request(2001, "turn/start", {
      threadId, providerThreadId, clientRequestId: "creq_usage23456",
      input: [{ type: "text", text: "/usage-loop", mentions: [] }], options: FULL_PERMISSION_OPTIONS,
    });
    expect(turn.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, since);
    const first = harness.deltasOf(threadId).slice(since).map((delta) => threadDeltaSchema.parse(delta));
    expect(first.findLast((delta) => delta.kind === "usage")).toMatchObject({
      total: { inputTokens: 36, outputTokens: 15, totalTokens: 51 },
      last: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    const firstContext = first.findLast((delta) => delta.kind === "contextWindow");
    expect(firstContext?.cost?.currency).toBe("USD");
    expect(firstContext?.cost?.amount).toBeCloseTo(0.03);
    const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "usage", textDeltaFlushMs: 0 });
    const events = assembler.assemble({ threadId, deltas: first });
    const completed = events.flatMap((event) => event.type === "item/completed" && event.item.type === "agentMessage" ? [event.item] : []);
    expect(completed.map((item) => item.text)).toEqual(["Loop step 1", "Loop step 2", "Loop complete"]);
    expect(new Set(completed.map((item) => item.id)).size).toBe(3);
    expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);

    const released = await harness.request(2002, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    });
    expect(released.error).toBeUndefined();
    const resumed = await harness.request(2003, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error).toBeUndefined();
    const resumedSince = harness.deltasOf(threadId).length;
    const next = await harness.request(2004, "turn/start", {
      threadId, providerThreadId, clientRequestId: "creq_usage34567",
      input: [{ type: "text", text: "Continue", mentions: [] }], options: FULL_PERMISSION_OPTIONS,
    });
    expect(next.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, resumedSince);
    const afterResume = harness.deltasOf(threadId).slice(resumedSince).map((delta) => threadDeltaSchema.parse(delta));
    expect(afterResume.findLast((delta) => delta.kind === "usage")).toMatchObject({
      total: { inputTokens: 48, outputTokens: 20, totalTokens: 68 },
      last: { totalTokens: 17 },
    });
    const resumedContext = afterResume.findLast((delta) => delta.kind === "contextWindow");
    expect(resumedContext?.cost?.currency).toBe("USD");
    expect(resumedContext?.cost?.amount).toBeCloseTo(0.04);
    expect(afterResume.filter((delta) => delta.kind === "item.textClose" && delta.channel === "agentMessage")).toHaveLength(1);
    expect(afterResume.filter((delta) => delta.kind === "turn.boundary")).toHaveLength(1);
  } finally {
    await harness.teardown();
  }
}, 90_000);
