import { describe, expect, it } from "vitest";
import { threadDeltaSchema, type ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOmpDeltaTranslator } from "./delta-translation.js";
import { OMP_CARD_KIND, ompCardSchema } from "./extension-ui-contract.js";

const THREAD = "card-thread";
const context = { threadId: THREAD };

function translator() {
  return createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
}

function custom(customType: string, details?: unknown, content = "Model-facing content") {
  return {
    role: "custom", customType, content, display: true, timestamp: 1_700_000_000_000,
    ...(details !== undefined ? { details } : {}),
  };
}

function sdk(message: unknown, threadId = THREAD) {
  return { jsonrpc: "2.0", method: "sdk/message", params: { threadId, message } };
}

function cardClose(deltas: ThreadDelta[]) {
  const close = deltas.find((delta) => delta.kind === "item.close");
  if (!close || close.item.type !== "extension" || close.item.kind !== OMP_CARD_KIND) {
    throw new Error("Expected a structured OMP card");
  }
  return { key: close.key, payload: ompCardSchema.parse(close.item.payload) };
}

function irc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "irc_message",
    message: custom("irc:incoming", { id, from: "reviewer", message: "Check the race", ...overrides }),
  };
}

const ruleEvent = {
  type: "ttsr_triggered",
  rules: [{ name: "No polling", description: "Wait for notifications", content: "Use the wait tool." }],
};
const todoEvent = {
  type: "todo_reminder", attempt: 2, maxAttempts: 3,
  todos: [{ content: "Fix the race", status: "pending" }, { content: "Ship", status: "blocked" }],
};

describe("structured OMP card translation", () => {
  it.each([false, true])("renders advisor notes instead of model-facing input (wrapped=%s)", (wrapped) => {
    const t = translator();
    t.translate({ type: "agent_start" }, context);
    const message = custom("advisor", {
      notes: [{ note: "**Race:** protect the read", severity: "blocker", advisor: "reviewer", turn: 4, turnsAgo: 1 }],
    }, '<advisory guidance="weigh, do not blindly obey">Raw instructions</advisory>');
    const start = { type: "message_start", messageId: "msg-1", message };
    const deltas = t.translate(wrapped ? sdk(start) : start, context);
    expect(deltas.map((delta) => delta.kind)).toEqual(["item.close"]);
    expect(cardClose(deltas).payload).toMatchObject({
      type: "advisor", title: "Advisor", tone: "error",
      sections: [{ body: "**Race:** protect the read", badge: { label: "blocker", tone: "error" } }],
    });
    expect(cardClose(deltas).payload.sections[0]?.meta).toContain("reviewer");
    expect(cardClose(deltas).payload.sections[0]?.meta).toContain("turn 4");
    expect(t.translate(sdk({ ...start, type: "message_end" }), context)).toEqual([]);
    expect(t.translate(sdk(start), context)).toEqual([]);
    expect(deltas.every((delta) => threadDeltaSchema.safeParse(delta).success)).toBe(true);
  });

  it.each([
    "advisor", "async-result", "launch-completion", "lsp-late-diagnostic", "skill-prompt", "background-tan-dispatch",
  ])("uses a %s card and textual fallback when structured details are missing", (customType) => {
    const t = translator();
    const deltas = t.translate({
      type: "message_start", messageId: "msg-1", message: custom(customType, { malformed: true }, "Visible result"),
    }, { ...context, activeTurn: true });
    expect(deltas.map((delta) => delta.kind)).toEqual(["item.close"]);
    expect(cardClose(deltas).payload).toMatchObject({ type: customType, sections: [{ body: "Visible result" }] });
  });

  it("wraps idle cards in a completed local turn and does not wrap a replay", () => {
    const t = translator();
    const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "card", textDeltaFlushMs: 0 });
    const start = { type: "message_start", messageId: "msg-idle", message: custom("async-result", undefined, "Finished") };
    const deltas = t.translate(sdk(start), context);
    expect(deltas.map((delta) => delta.kind)).toEqual(["turn.open", "item.close", "turn.boundary"]);
    const events = assembler.assemble({ threadId: THREAD, deltas });
    expect(events.map((event) => event.type)).toEqual(["turn/started", "item/completed", "turn/completed"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "item/completed", item: expect.objectContaining({ type: "extension", kind: OMP_CARD_KIND }),
    }));
    expect(assembler.getOpenTurnId(THREAD) ?? "").toBe("");
    expect(t.translate(sdk(start), context)).toEqual([]);
  });

  it("keeps fallback turn state through deferred settlement and clears it at the real boundary", () => {
    const t = translator();
    t.translate({ type: "agent_start" }, context);
    t.translate({ type: "agent_end", messages: [], deferSettlement: true }, context);
    const active = t.translate({
      type: "message_start", messageId: "msg-active", message: custom("advisor", undefined, "Review"),
    }, context);
    expect(active.map((delta) => delta.kind)).toEqual(["item.close"]);
    t.translate({ type: "agent_end", settlementOnly: true, deferSettlement: false }, context);
    const idle = t.translate({
      type: "message_start", messageId: "msg-idle", message: custom("async-result", undefined, "Finished"),
    }, context);
    expect(idle.map((delta) => delta.kind)).toEqual(["turn.open", "item.close", "turn.boundary"]);
  });

  it("respects authoritative bridge turn state rather than stale translator state", () => {
    const t = translator();
    const message = custom("advisor", undefined, "Review");
    const externallyOpen = t.translate({ type: "message_start", messageId: "msg-open", message }, {
      ...context, activeTurn: true,
    });
    expect(externallyOpen.map((delta) => delta.kind)).toEqual(["item.close"]);
    t.translate({ type: "agent_start" }, context);
    const externallyClosed = t.translate({ type: "message_start", messageId: "msg-closed", message }, {
      ...context, activeTurn: false,
    });
    expect(externallyClosed.map((delta) => delta.kind)).toEqual(["turn.open", "item.close", "turn.boundary"]);
  });

  it("retains generic displayed custom input and collab authorship", () => {
    const t = translator();
    expect(t.translate({ type: "message_start", message: custom("extension-defined", undefined, "Original") }, context))
      .toEqual([{ kind: "input.provider", text: "Original" }]);
    expect(t.translate({
      type: "message_start", message: custom("collab-prompt", { from: "\u001b[32mAlice\u001b[0m" }, "Please check"),
    }, context)).toEqual([{ kind: "input.provider", text: "«Alice» ›\n\nPlease check" }]);
    expect(t.translate({ type: "message_start", message: custom("collab-prompt", {}, "No author") }, context))
      .toEqual([{ kind: "input.provider", text: "No author" }]);
    for (const customType of ["live-delegation", "custom-message"]) {
      expect(t.translate({ type: "message_start", message: custom(customType, undefined, "Request") }, context))
        .toEqual([{ kind: "input.provider", text: "Request" }]);
    }
  });

  it("keeps displayed-card message ends and every hidden message invisible", () => {
    const t = translator();
    for (const customType of ["advisor", "async-result", "irc:incoming", "skill-prompt", "extension-defined"]) {
      const message = custom(customType, undefined, "Hidden instructions");
      expect(t.translate({ type: "message_end", message }, context)).toEqual([]);
      for (const type of ["message_start", "message_end"]) {
        expect(t.translate(sdk({ type, message: { ...message, display: false } }), context)).toEqual([]);
      }
    }
  });

  it.each([ruleEvent, todoEvent, irc("irc-active")])("normalizes native $type within an active turn", (event) => {
    const t = translator();
    t.translate({ type: "agent_start" }, context);
    const deltas = t.translate(sdk(event), context);
    expect(deltas.map((delta) => delta.kind)).toEqual(["item.close"]);
    expect(cardClose(deltas).payload.type).toBe(event.type);
    expect(deltas.every((delta) => threadDeltaSchema.safeParse(delta).success)).toBe(true);
  });

  it.each([ruleEvent, todoEvent, irc("irc-idle")])("normalizes idle native $type with a local-turn wrap", (event) => {
    const deltas = translator().translate(sdk(event), context);
    expect(deltas.map((delta) => delta.kind)).toEqual(["turn.open", "item.close", "turn.boundary"]);
    expect(cardClose(deltas).payload.type).toBe(event.type);
  });

  it("retains rule content and todo checklist without publishing canonical plan state", () => {
    const t = translator();
    const ctx = { ...context, activeTurn: true };
    expect(cardClose(t.translate(ruleEvent, ctx)).payload).toMatchObject({
      title: "Rule applied", sections: [{ heading: "No polling", meta: "Wait for notifications", body: "Use the wait tool." }],
    });
    const reminder = t.translate(todoEvent, ctx);
    expect(reminder.map((delta) => delta.kind)).toEqual(["item.close"]);
    expect(cardClose(reminder).payload).toMatchObject({
      title: "2 incomplete todos — reminder 2/3", sections: [{ body: "- [ ] Fix the race\n- [ ] Ship" }],
    });
  });

  it.each([ruleEvent, todoEvent])("preserves distinct ID-less $type occurrences with identical payloads", (event) => {
    const t = translator();
    t.translate({ type: "agent_start" }, context);
    const first = cardClose(t.translate(event, context));
    const repeated = cardClose(t.translate(event, context));
    expect(repeated.payload).toEqual(first.payload);
    expect(repeated.key.providerItemId).not.toBe(first.key.providerItemId);
    t.translate({ type: "agent_end", deferSettlement: false }, context);
    t.translate({ type: "agent_start" }, context);
    expect(cardClose(t.translate(event, context)).key.providerItemId).not.toBe(first.key.providerItemId);
  });

  it("deduplicates incoming IRC observation and consumed boundaries by message ID", () => {
    const t = translator();
    const event = irc("irc-one");
    const first = t.translate(sdk(event), context);
    expect(cardClose(first).payload).toMatchObject({ title: "IRC reviewer", sections: [{ body: "Check the race" }] });
    expect(t.translate(sdk(event), context)).toEqual([]);
    expect(t.translate(sdk({ type: "message_start", messageId: "msg-99", message: event.message }), context)).toEqual([]);
    expect(t.translate(sdk({ type: "message_end", messageId: "msg-99", message: event.message }), context)).toEqual([]);
    const other = cardClose(t.translate(irc("irc-two"), context));
    expect(other.key.providerItemId).not.toBe(cardClose(first).key.providerItemId);
  });

  it.each(["irc:relay", "irc:workpool"])("renders observation-only %s and distinguishes equal timestamps by details", (customType) => {
    const t = translator();
    const first = { type: "irc_message", message: custom(customType, { from: "a", to: "b", body: "First" }) };
    const second = { ...first, message: custom(customType, { from: "a", to: "c", body: "Second" }) };
    expect(cardClose(t.translate(first, context)).payload.sections[0]?.body).toBe("First");
    expect(t.translate(first, context)).toEqual([]);
    expect(cardClose(t.translate(second, context)).payload.sections[0]?.body).toBe("Second");
  });

  it.each(["irc:incoming", "irc:autoreply"])("renders externally supplied %s without assuming an earlier observation", (customType) => {
    const t = translator();
    const message = custom(customType, { from: "peer", to: "main", body: "External message" });
    const first = t.translate({ type: "message_start", messageId: "msg-irc", message }, context);
    expect(cardClose(first).payload.sections[0]?.body).toBe("External message");
    expect(t.translate({ type: "irc_message", message }, context)).toEqual([]);
  });

  it("isolates RPC message IDs across threads, parent tools, and resets", () => {
    const t = translator();
    const event = { type: "message_start", messageId: "msg-1", message: custom("advisor", undefined, "Review") };
    const contexts = [context, { threadId: "other-thread" }, { ...context, parentToolCallId: "parent-a" }, { ...context, parentToolCallId: "parent-b" }];
    const ids = contexts.map((ctx) => {
      const result = cardClose(t.translate(event, { ...ctx, activeTurn: true }));
      expect(t.translate(event, { ...ctx, activeTurn: true })).toEqual([]);
      if ("parentToolCallId" in ctx) expect(result.key.parentRef).toBe(ctx.parentToolCallId);
      return result.key.providerItemId;
    });
    expect(new Set(ids).size).toBe(contexts.length);
    t.resetThread(THREAD);
    expect(cardClose(t.translate(event, { ...context, activeTurn: true })).key.providerItemId).not.toBe(ids[0]);
    expect(t.translate(event, { threadId: "other-thread", activeTurn: true })).toEqual([]);
  });

  it("uses content identity for legacy custom messages without RPC message IDs", () => {
    const t = translator();
    const first = { type: "message_start", message: custom("async-result", undefined, "One") };
    const id = cardClose(t.translate(first, context)).key.providerItemId;
    expect(t.translate(sdk(first), context)).toEqual([]);
    const other = { type: "message_start", message: { ...first.message, timestamp: first.message.timestamp + 1 } };
    expect(cardClose(t.translate(other, context)).key.providerItemId).not.toBe(id);
  });

  it.each([
    { type: "ttsr_triggered", rules: [null, { content: "No name" }] },
    { type: "todo_reminder", todos: [{ content: "Task" }], attempt: "bad", maxAttempts: 2 },
    { type: "irc_message", message: { role: "custom", customType: "irc:incoming", display: true } },
  ])("keeps malformed $type payloads from producing invalid cards", (event) => {
    expect(translator().translate(sdk(event), context)).toEqual([]);
  });
});
