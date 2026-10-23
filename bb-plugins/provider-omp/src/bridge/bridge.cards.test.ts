import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OMP_CARD_KIND, ompCardSchema } from "../extension-ui-contract.js";
import { startFakeOmpBridge, type FakeOmpBridgeHarness } from "./test-support.js";

const TEST_TIMEOUT_MS = 90_000;
const cardDeltaSchema = z.object({
  kind: z.literal("item.close"),
  item: z.object({ type: z.literal("extension"), kind: z.literal(OMP_CARD_KIND), payload: ompCardSchema }),
});

// Inspect the bridge wire representation, not the builder's return value.
function cards(deltas: Record<string, unknown>[]) {
  return deltas.flatMap((delta) => {
    const parsed = cardDeltaSchema.safeParse(delta);
    return parsed.success ? [parsed.data.item.payload] : [];
  });
}

describe("structured OMP cards over the bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let nativeEvents: string;
  const threadId = "thr_structured_cards";

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-cards-", initialize: true });
    nativeEvents = join(harness.workspaceDir, "native-events.jsonl");
    writeFileSync(nativeEvents, "");
    vi.stubEnv("FAKE_OMP_NATIVE_EVENTS_FILE", nativeEvents);
    const response = await harness.startThread(threadId);
    expect(response.error).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    await harness.teardown();
  }, TEST_TIMEOUT_MS);

  function inject(...events: Record<string, unknown>[]) {
    appendFileSync(nativeEvents, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }

  it("wraps idle cards, deduplicates IRC, preserves an active root, and wraps again after settlement", async () => {
    const incoming = {
      role: "custom", customType: "irc:incoming", display: true,
      timestamp: 1_700_000_000_000, content: "<irc>Peer has finished.</irc>",
      details: { id: "irc-card-1", from: "peer", message: "Peer has finished." },
    };
    const idleStart = harness.deltasOf(threadId).length;
    inject({ type: "irc_message", message: incoming });
    await harness.waitForTurnBoundary(threadId, idleStart);
    const idle = harness.deltasOf(threadId).slice(idleStart);
    expect(idle.filter((delta) => delta.kind === "turn.open" || delta.kind === "item.close" || delta.kind === "turn.boundary").map((delta) => delta.kind))
      .toEqual(["turn.open", "item.close", "turn.boundary"]);
    expect(cards(idle).map((card) => card.type)).toEqual(["irc_message"]);
    expect(cards(idle)[0]?.sections[0]?.body).toBe("Peer has finished.");

    const activeStart = harness.deltasOf(threadId).length;
    // The following root open acts as an ordered barrier for both replay paths.
    inject(
      { type: "irc_message", message: incoming },
      { type: "message_start", messageId: "irc-consumed-1", message: incoming },
      { type: "message_end", messageId: "irc-consumed-1", message: incoming },
      { type: "agent_start" },
    );
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open", activeStart);
    expect(cards(harness.deltasOf(threadId).slice(activeStart))).toEqual([]);

    const customMessages = [
      { customType: "advisor", details: { notes: [{ note: "Check the transaction boundary.", severity: "blocker", advisor: "reviewer" }] } },
      { customType: "async-result", details: { jobs: [{ jobId: "active-job", type: "bash", status: "completed", durationMs: 1500 }] } },
      { customType: "launch-completion", details: { daemons: [{ name: "dev-server", id: "daemon-1", state: "exited", createdAt: 1000, startedAt: 1000, exitedAt: 2000, exitCode: 0, restartCount: 0, outputBytes: 0, persist: false, detached: false }] } },
      { customType: "lsp-late-diagnostic", details: { files: [{ path: "src/example.ts", summary: "One error", errored: true, messages: ["Type mismatch"] }] } },
      { customType: "skill-prompt", details: { name: "review", path: "/skills/review/SKILL.md", lineCount: 3, prompt: "Review the change." } },
      { customType: "background-tan-dispatch", details: { jobId: "tangent-1", work: "Investigate the regression", sessionFile: "/sessions/tangent.jsonl" } },
    ].map((message, index) => ({ ...message, role: "custom", display: true, timestamp: 1_700_000_000_100 + index, content: "Visible custom message" }));
    for (const [index, message] of customMessages.entries()) {
      const since = harness.deltasOf(threadId).length;
      inject(
        { type: "message_start", messageId: `custom-${index}`, message },
        { type: "message_end", messageId: `custom-${index}`, message },
      );
      await harness.waitForDelta(threadId, (delta) => cards([delta]).some((card) => card.type === message.customType), since);
    }
    inject({
      type: "ttsr_triggered",
      rules: [{ name: "transaction-safety", path: "/rules/transaction.md", content: "Keep the transaction atomic.", description: "Transaction safety", _source: { provider: "file", providerName: "Rules", path: "/rules/transaction.md", level: "project" } }],
    });
    await harness.waitForDelta(threadId, (delta) => cards([delta]).some((card) => card.type === "ttsr_triggered"), activeStart);
    inject({ type: "todo_reminder", todos: [{ id: "todo-1", content: "Finish the migration", status: "pending" }], attempt: 1, maxAttempts: 3 });
    await harness.waitForDelta(threadId, (delta) => cards([delta]).some((card) => card.type === "todo_reminder"), activeStart);
    const active = harness.deltasOf(threadId).slice(activeStart);
    expect(cards(active).map((card) => card.type)).toEqual([
      ...customMessages.map((message) => message.customType), "ttsr_triggered", "todo_reminder",
    ]);
    expect(active.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(active.filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
    expect(active.filter((delta) =>
      typeof delta.item === "object" && delta.item !== null &&
      "type" in delta.item && delta.item.type === "planSteps",
    )).toEqual([]);
    expect(active.filter((delta) => delta.kind === "input.provider")).toEqual([]);

    const settlementStart = harness.deltasOf(threadId).length;
    inject({ type: "agent_end", messages: [], settlementOnly: true, deferSettlement: false });
    await harness.waitForTurnBoundary(threadId, settlementStart);
    const secondIdleStart = harness.deltasOf(threadId).length;
    const completedJob = {
      role: "custom", customType: "async-result", display: true, timestamp: 1_700_000_000_999,
      content: "<system-notice>Background job completed.</system-notice>",
      details: { jobs: [{ jobId: "idle-job", type: "task", status: "completed", durationMs: 2000 }] },
    };
    inject({ type: "message_start", messageId: "idle-job-result", message: completedJob });
    await harness.waitForTurnBoundary(threadId, secondIdleStart);
    const secondIdle = harness.deltasOf(threadId).slice(secondIdleStart);
    expect(secondIdle.filter((delta) => delta.kind === "turn.open" || delta.kind === "item.close" || delta.kind === "turn.boundary").map((delta) => delta.kind))
      .toEqual(["turn.open", "item.close", "turn.boundary"]);
    expect(cards(secondIdle).map((card) => card.type)).toEqual(["async-result"]);
  }, TEST_TIMEOUT_MS);
});
