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
      presentation: expect.objectContaining({ label: { pending: "Advisor", completed: "Advisor" }, detail: "Review this", icon: { glyph: "AlertTriangle" } }),
    }));
    const close = deltas.find((delta) => delta.kind === "item.close");
    expect(close?.kind === "item.close" ? close.presentation?.title : "no close").toBeUndefined();
    expect(deltas.some((delta) => delta.kind === "turn.open")).toBe(!activeTurn);
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(!activeTurn);
    const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "cards-test", textDeltaFlushMs: 0, progressThrottleMs: 0 });
    if (activeTurn) assembler.assemble({ threadId: "cards-thread", deltas: [{ kind: "turn.open" }] });
    const events = assembler.assemble({ threadId: "cards-thread", deltas });
    expect(events).toContainEqual(expect.objectContaining({ type: "item/completed", item: expect.objectContaining({ type: "extension", payload: card }) }));
    expect(Boolean(assembler.getOpenTurnId("cards-thread"))).toBe(activeTurn);
  });
  it.each(["irc_message", "irc:message"])("presents %s with a dedicated icon and preserves summary, body, and turn wrapping", (type) => {
    const body = "Full IRC message\n" + "Keep this section body intact. ".repeat(20);
    const ircCard: OmpCard = {
      type, title: "IRC message", summary: "A short message preview", tone: "warning",
      sections: [{ body }],
    };
    for (const activeTurn of [true, false]) {
      const deltas = createOmpCardDeltas(ircCard, { activeTurn, id: type });
      for (const delta of deltas) expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
      expect(deltas.map((delta) => delta.kind)).toEqual(activeTurn
        ? ["item.close"]
        : ["turn.open", "item.close", "turn.boundary"]);
      const close = deltas.find((delta) => delta.kind === "item.close");
      expect(close?.kind).toBe("item.close");
      if (close?.kind !== "item.close" || close.item.type !== "extension") throw new Error("Missing extension item");
      expect(close.item.payload).toEqual(ircCard);
      expect(close.presentation).toMatchObject({
        label: { pending: "IRC message", completed: "IRC message" },
        title: "A short message preview",
        icon: { glyph: "MessageSquare" },
      });
      expect(close.presentation?.detail?.length).toBeLessThanOrEqual(280);
      const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "irc-cards-test", textDeltaFlushMs: 0, progressThrottleMs: 0 });
      if (activeTurn) assembler.assemble({ threadId: "irc-cards-thread", deltas: [{ kind: "turn.open" }] });
      const events = assembler.assemble({ threadId: "irc-cards-thread", deltas });
      expect(events).toContainEqual(expect.objectContaining({
        type: "item/completed", item: expect.objectContaining({ type: "extension", payload: ircCard }),
      }));
      expect(Boolean(assembler.getOpenTurnId("irc-cards-thread"))).toBe(activeTurn);
    }
  });
  it.each([
    ["error", "CircleX"],
    ["warning", "AlertTriangle"],
    ["success", "Check"],
    ["info", "Info"],
  ] as const)("preserves the non-IRC %s icon", (tone, glyph) => {
    const delta = createOmpCardDeltas({ ...card, tone }, { activeTurn: true, id: tone })[0];
    expect(delta?.kind === "item.close" ? delta.presentation?.icon : undefined).toEqual({ glyph });
  });
  it("escapes opaque IDs and preserves distinct identities", () => {
    const keys = ['a/b', 'a:b', 'a"b', 'a\\b'].map((id) => {
      const delta = createOmpCardDeltas(card, { activeTurn: true, id })[0];
      return delta?.kind === "item.close" ? delta.key : undefined;
    });
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(4);
  });
  it("shows the card title once in the label and the summary as the collapsed title", () => {
    const delta = createOmpCardDeltas({ ...card, summary: "2 concerns, 1 nit" }, { activeTurn: true, id: "summary" })[0];
    expect(delta?.kind === "item.close" ? delta.presentation : undefined).toMatchObject({
      label: { pending: "Advisor", completed: "Advisor" },
      title: "2 concerns, 1 nit",
    });
  });
  it("builds the fallback detail from note bodies even when meta is empty or present", () => {
    const delta = createOmpCardDeltas({ ...card, sections: [
      { body: "Race on reload", meta: "reviewer · turn 4", badge: { label: "concern" } },
      { heading: "", body: "Missing test", meta: "" },
      { meta: "only meta" },
    ] }, { activeTurn: true, id: "detail" })[0];
    expect(delta?.kind === "item.close" ? delta.presentation?.detail : undefined).toBe("Race on reload · Missing test · only meta");
  });
  it("sanitizes and bounds directly supplied cards and presentation", () => {
    const deltas = createOmpCardDeltas({ ...card, title: "\u001b[31mAdvisor\u001b[0m", summary: "\u001b[1m1 blocker\u001b[0m", sections: Array.from({ length: 100 }, () => ({ heading: "😀".repeat(1000), body: "\"\\漢".repeat(20000) })) }, { activeTurn: false, id: "bounded" });
    const delta = deltas.find((entry) => entry.kind === "item.close");
    expect(delta?.kind).toBe("item.close");
    if (delta?.kind !== "item.close" || delta.item.type !== "extension") throw new Error("Missing extension item");
    expect(ompCardSchema.safeParse(delta.item.payload).success).toBe(true);
    expect(delta.presentation?.label.completed).toBe("Advisor");
    expect(delta.presentation?.title).toBe("1 blocker");
    expect(delta.presentation?.detail?.length).toBeLessThanOrEqual(280);
  });
});
