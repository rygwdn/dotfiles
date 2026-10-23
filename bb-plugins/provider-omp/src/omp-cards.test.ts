import { describe, expect, it } from "vitest";
import { ompCardSchema, OMP_CARD_LIMITS } from "./extension-ui-contract.js";
import { buildOmpCustomMessageCard, buildOmpEventCard } from "./omp-cards.js";

describe("OMP custom message cards", () => {
  it("preserves advisor notes, severities, identity and age instead of model boilerplate", () => {
    const card = buildOmpCustomMessageCard({ customType: "advisor", content: "<advisory>instructions</advisory>", details: { notes: [
      { note: "Fix it", severity: "blocker", advisor: "reviewer", turn: 3, turnsAgo: 2 },
      { note: "Consider this", severity: "concern" }, { note: "Polish", severity: "nit" },
    ] } });
    expect(card).toMatchObject({ title: "Advisor", tone: "error", sections: [
      { body: "Fix it", badge: { label: "blocker", tone: "error" }, meta: "reviewer · turn 3 · 2 turns ago" },
      { badge: { tone: "warning" } }, { badge: { tone: "info" } },
    ] });
    expect(JSON.stringify(card)).not.toContain("instructions");
  });
  it("preserves async jobs and artifact capture failures", () => {
    const card = buildOmpCustomMessageCard({ customType: "async-result", details: { jobs: [{ jobId: "job-1", type: "bash", status: "failed", label: "Compile", durationMs: 2500, meta: { artifactError: "write" } }], meta: { artifactError: "close" } } });
    expect(card).toMatchObject({ title: "Background job completed", tone: "error", sections: [
      { heading: "Compile", badge: { label: "failed", tone: "error" }, meta: "bash · job-1 · 2.5s", body: "Full output was not saved completely (artifact write failed)" },
      { badge: { tone: "warning" }, body: "Full output was not saved completely (artifact close failed)" },
    ] });
  });
  it("marks nonzero supervised exits failed and calculates elapsed duration", () => {
    const card = buildOmpCustomMessageCard({ customType: "launch-completion", details: { daemons: [{ name: "dev", id: "d-1", state: "exited", exitCode: 2, startedAt: 100, exitedAt: 1100, exitReason: "terminated" }] } });
    expect(card).toMatchObject({ title: "Supervised process failed", tone: "error", sections: [{ heading: "dev", meta: "d-1 · exit 2 · 1s", body: "terminated" }] });
  });
  it("retains per-file diagnostic summaries and messages", () => {
    expect(buildOmpCustomMessageCard({ customType: "lsp-late-diagnostic", details: { files: [{ path: "src/a.ts", summary: "1 error", errored: true, messages: ["Bad type", "line 2"] }] } })).toMatchObject({ title: "Late diagnostics", tone: "error", sections: [{ heading: "src/a.ts", meta: "1 error", body: "Bad type\nline 2" }] });
  });
  it("presents skill identity, path, arguments and prompt", () => {
    expect(buildOmpCustomMessageCard({ customType: "skill-prompt", details: { name: "review", path: "/skills/review", args: "src", prompt: "Review carefully", lineCount: 4 } })).toMatchObject({ title: "Skill: review", sections: [{ heading: "review", meta: "/skills/review · 4 lines", body: "src · Review carefully" }] });
  });
  it("shows tangent work and session instead of model-only instructions", () => {
    expect(buildOmpCustomMessageCard({ customType: "background-tan-dispatch", content: "Ignore this task", details: { jobId: "task-1", work: "Research APIs", sessionFile: "/session.jsonl" } })).toMatchObject({ title: "Tangent dispatched", sections: [{ heading: "task-1", body: "Research APIs", meta: "/session.jsonl" }] });
  });
  it.each(["irc:incoming", "irc:relay", "irc:workpool", "irc:autoreply", "irc:external"])("supports %s custom messages", (customType) => {
    expect(buildOmpCustomMessageCard({ customType, details: { id: "irc-1", from: "alice", to: "bob", body: "Hello", replyTo: "previous", pool: "workers", mode: "dispatched" } })).toMatchObject({ title: "Pool workers → bob", sections: [{ body: "Hello", meta: "irc-1 · from alice · reply to previous", badge: { label: customType === "irc:autoreply" ? "auto" : "dispatched" } }] });
  });
  it.each(["advisor", "async-result", "launch-completion", "lsp-late-diagnostic", "skill-prompt", "background-tan-dispatch", "irc:external"])("falls back to content text for recognized %s without details", (customType) => {
    expect(buildOmpCustomMessageCard({ customType, content: [{ type: "image", data: "not text" }, { type: "text", text: "Actual text" }] })?.sections).toEqual([{ body: "Actual text", ...(customType.startsWith("irc:") ? { meta: "" } : {}) }]);
  });
  it("rejects unknown, hidden and malformed messages without throwing", () => {
    for (const message of [null, [], 5, {}, { customType: "unknown", content: "text" }, { customType: "advisor", details: { notes: [null, { note: 123 }] } }, { customType: "advisor", display: false, content: "hidden" }]) expect(buildOmpCustomMessageCard(message)).toBeNull();
  });
  it("strips ANSI from all text fields", () => {
    const card = buildOmpCustomMessageCard({ customType: "advisor", details: { notes: [{ note: "\u001b[31mRed\u001b[0m", advisor: "\u001b]0;title\u0007reviewer", severity: "concern" }] } });
    expect(card?.sections[0]).toMatchObject({ body: "Red", meta: "reviewer" });
    expect(JSON.stringify(card)).not.toContain("\\u001b");
  });
  it.each(["😀漢字", "\"\\\n\u0000"])("bounds sections and serialized UTF-8 with %j", (fragment) => {
    const card = buildOmpCustomMessageCard({ customType: "advisor", details: { notes: Array.from({ length: 100 }, () => ({ note: fragment.repeat(20000), advisor: fragment.repeat(2000) })) } });
    expect(card?.sections).toHaveLength(64);
    expect(ompCardSchema.safeParse(card).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(card)).byteLength).toBeLessThanOrEqual(OMP_CARD_LIMITS.payloadBytes);
    for (const section of card!.sections) expect(section.body).not.toMatch(/[\ud800-\udbff]…$/u);
  });
  it("schema rejects excessive sections, strings and aggregate byte size", () => {
    const base = { type: "advisor", title: "Advisor" };
    expect(ompCardSchema.safeParse({ ...base, sections: Array.from({ length: 65 }, () => ({})) }).success).toBe(false);
    expect(ompCardSchema.safeParse({ ...base, title: "x".repeat(201), sections: [] }).success).toBe(false);
    expect(ompCardSchema.safeParse({ ...base, sections: [{ body: "漢".repeat(30000) }] }).success).toBe(false);
  });
});

describe("OMP event cards", () => {
  it("preserves triggered rule descriptions and content", () => {
    expect(buildOmpEventCard({ type: "ttsr_triggered", rules: [{ name: "No secrets", description: "Keep credentials safe", content: "Never print tokens" }] })).toMatchObject({ title: "Rule applied", tone: "warning", sections: [{ heading: "No secrets", meta: "Keep credentials safe", body: "Never print tokens" }] });
  });
  it("uses the nested custom message for IRC observations", () => {
    expect(buildOmpEventCard({ type: "irc_message", message: { customType: "irc:incoming", details: { from: "alice", message: "hello" } } })).toMatchObject({ type: "irc_message", title: "IRC alice", sections: [{ body: "hello" }] });
  });
  it("retains sender alongside pool and recipient for IRC events", () => {
    expect(buildOmpEventCard({
      type: "irc_message",
      message: {
        customType: "irc:workpool",
        details: { from: "dispatcher", to: "worker", pool: "research", body: "Investigate" },
      },
    })).toMatchObject({
      type: "irc_message",
      title: "Pool research → worker",
      sections: [{ meta: "from dispatcher", body: "Investigate" }],
    });
  });
  it("creates reminder checklist without mutating canonical todos", () => {
    const todos = Object.freeze([Object.freeze({ content: "Finish\nwork", status: "in_progress" }), Object.freeze({ content: "Review", status: "pending" })]);
    expect(buildOmpEventCard({ type: "todo_reminder", todos, attempt: 2, maxAttempts: 3 })).toMatchObject({ title: "2 incomplete todos — reminder 2/3", tone: "warning", sections: [{ body: "- [ ] Finish\n  work\n- [ ] Review" }] });
    expect(todos[0]?.status).toBe("in_progress");
  });
  it("rejects non-IRC custom messages inside IRC events", () => {
    expect(buildOmpEventCard({
      type: "irc_message",
      message: {
        customType: "advisor",
        details: { notes: [{ note: "Not an IRC message" }] },
      },
    })).toBeNull();
  });
  it("returns null for malformed and unknown events", () => {
    for (const event of [null, {}, { type: "unknown" }, { type: "irc_message", message: [] }, { type: "ttsr_triggered", rules: [null, {}] }, { type: "todo_reminder", todos: [{ content: "work" }], attempt: "1", maxAttempts: 3 }]) expect(buildOmpEventCard(event)).toBeNull();
  });
});
