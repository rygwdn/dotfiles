import { expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { continuityCompactionDeltas } from "./continuity-compaction.js";

const commit = { sessionId: "omp-a", entryId: "entry-a", timestamp: "2026-10-27T18:00:00.000Z", trigger: "requested" };
const encode = (data: unknown) => `bb-continuity.compacted.v1:${JSON.stringify(data)}`;

it("records separate committed boundaries in order without closing an existing user turn", () => {
  const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "continuity", textDeltaFlushMs: 0, progressThrottleMs: 0 });
  const threadId = "thr_compactions";
  assembler.assemble({ threadId, deltas: [{ kind: "turn.open" }] });
  const userTurn = assembler.getOpenTurnId(threadId);
  const completed = [];
  for (const data of [commit, { ...commit, entryId: "entry-b", trigger: "idle" }, { ...commit, sessionId: "omp-b" }]) {
    const deltas = continuityCompactionDeltas(encode(data))!;
    for (const delta of deltas) expect(threadDeltaSchema.parse(delta)).toEqual(delta);
    const events = assembler.assemble({ threadId, deltas });
    const item = events.find(e => e.type === "item/completed");
    const compacted = events.find(e => e.type === "thread/compacted");
    const settled = events.find(e => e.type === "turn/completed");
    expect(item).toMatchObject({ item: { type: "contextCompaction" } });
    expect(compacted).toBeDefined();
    expect(settled).toBeDefined();
    expect(events.indexOf(item!)).toBeLessThan(events.indexOf(compacted!));
    expect(events.indexOf(compacted!)).toBeLessThan(events.indexOf(settled!));
    expect(assembler.getOpenTurnId(threadId)).toBe(userTurn);
    completed.push(item);
  }
  expect(new Set(completed.map(e => e && "item" in e ? e.item.id : null)).size).toBe(3);
});

it.each(["Ordinary notification", "bb-continuity.compacted.v1:{", encode({ ...commit, entryId: "" }), encode({ ...commit, timestamp: "not-a-time" }), encode({ ...commit, summary: "private" })])("leaves non-contract notices to their existing handler: %s", message => {
  expect(continuityCompactionDeltas(message)).toBeNull();
});
