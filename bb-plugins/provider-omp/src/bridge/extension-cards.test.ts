import { describe, expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { OMP_CARD_KIND, ompCardSchema, type OmpCard } from "../extension-ui-contract.js";
import { createOmpCardDeltas } from "./extension-cards.js";

const card: OmpCard = { type: "advisor", title: "Advisor", tone: "warning", sections: [{ body: "Review this" }] };

describe("createOmpCardDeltas", () => {
  it.each([true, false])("emits a structured card with activeTurn=%s", (activeTurn) => {
    const deltas = createOmpCardDeltas(card, { activeTurn, id: "card-1" });
    for (const delta of deltas) expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
    expect(deltas).toContainEqual(expect.objectContaining({
      kind: "item.close", key: { providerItemId: 'omp-card:"card-1"' },
      item: { type: "extension", kind: OMP_CARD_KIND, payload: card }, status: "completed",
      presentation: expect.objectContaining({ label: { pending: "Advisor", completed: "Advisor" }, title: "Advisor", detail: "Review this", icon: { glyph: "AlertTriangle" } }),
    }));
    expect(deltas.some((delta) => delta.kind === "turn.open")).toBe(!activeTurn);
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(!activeTurn);
    const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "cards-test", textDeltaFlushMs: 0, progressThrottleMs: 0 });
    if (activeTurn) assembler.assemble({ threadId: "cards-thread", deltas: [{ kind: "turn.open" }] });
    const events = assembler.assemble({ threadId: "cards-thread", deltas });
    expect(events).toContainEqual(expect.objectContaining({ type: "item/completed", item: expect.objectContaining({ type: "extension", payload: card }) }));
    expect(Boolean(assembler.getOpenTurnId("cards-thread"))).toBe(activeTurn);
  });
  it("escapes opaque IDs and preserves distinct identities", () => {
    const keys = ['a/b', 'a:b', 'a"b', 'a\\b'].map((id) => {
      const delta = createOmpCardDeltas(card, { activeTurn: true, id })[0];
      return delta?.kind === "item.close" ? delta.key : undefined;
    });
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(4);
  });
  it("sanitizes and bounds directly supplied cards and presentation", () => {
    const deltas = createOmpCardDeltas({ ...card, title: "\u001b[31mAdvisor\u001b[0m", sections: Array.from({ length: 100 }, () => ({ heading: "😀".repeat(1000), body: "\"\\漢".repeat(20000) })) }, { activeTurn: false, id: "bounded" });
    const delta = deltas.find((entry) => entry.kind === "item.close");
    expect(delta?.kind).toBe("item.close");
    if (delta?.kind !== "item.close" || delta.item.type !== "extension") throw new Error("Missing extension item");
    expect(ompCardSchema.safeParse(delta.item.payload).success).toBe(true);
    expect(delta.presentation?.title).toBe("Advisor");
    expect(delta.presentation?.detail?.length).toBeLessThanOrEqual(280);
  });
});
