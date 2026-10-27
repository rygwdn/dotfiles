import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, emptyState, project, recover, sourceIds, textBody } from "./policy";
import type { ContextMessage, JournalEntry, Policy } from "./policy";

const policy: Policy = { ...DEFAULT_POLICY, protectRounds: 2, protectTokens: 100, triggerTokens: 1000, minResultTokens: 100, minReclaimTokens: 1000, regrowthTokens: 10000, coldAfterSeconds: 60 };
function fixture() {
  const messages: ContextMessage[] = [{ role: "user", content: [{ type: "text", text: "Inspect this project" }] }];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `call${i}`, name: "read", arguments: { path: `src/${i}.ts` } }] });
    messages.push({ role: "toolResult", toolCallId: `call${i}`, toolName: "read", content: [{ type: "text", text: `${i}:` + "x".repeat(20000) }] });
  }
  const branch: JournalEntry[] = messages.map((message, i) => ({ type: "message", id: `entry${i}`, message }));
  return { messages, branch, options: { idleMs: 60001, tokens: 100000, ids: sourceIds(messages, branch) } };
}
describe("journal-backed context projection", () => {
  test("old text is projected without changing originals; recent complete rounds survive", () => {
    const { messages, branch, options } = fixture();
    const original = JSON.stringify(branch);
    const result = project(messages, emptyState(), policy, options);
    expect(result.changed).toBe(true);
    expect(result.state.demotions.map(d => d.id)).toEqual(["entry2", "entry4", "entry6", "entry8"]);
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(JSON.stringify(branch)).toBe(original);
    const page = recover(branch, "entry2", 2000, 12000);
    expect(page.text).toBe(textBody(messages[2]!)!.slice(2000, 14000));
    expect(page.nextOffset).toBe(14000);
  });
  test("hot-cache replay survives resume exactly, while new hot decisions are deferred", () => {
    const { messages, options } = fixture();
    const cold = project(messages, emptyState(), policy, options);
    const resumed = JSON.parse(JSON.stringify(cold.state));
    const hot = project(messages, resumed, policy, { ...options, idleMs: 0 });
    expect(hot.messages).toEqual(cold.messages);
    expect(hot.changed).toBe(false);
    expect(project(messages, emptyState(), policy, { ...options, idleMs: 0 }).messages).toEqual(messages);
  });
  test("regrowth and minimum reclamation prevent repeated low-value rewrites", () => {
    const { messages, options } = fixture();
    const first = project(messages, emptyState(), policy, options);
    const later = project(messages, first.state, policy, { ...options, tokens: 105000 });
    expect(later.reason).toBe("waiting for regrowth");
    expect(project(messages, emptyState(), { ...policy, minReclaimTokens: 200000 }, options).changed).toBe(false);
  });
  test("errors, skills, nontext content, and incomplete parallel batches are protected", () => {
    const { messages, branch } = fixture();
    messages[2]!.isError = true;
    (messages[3]!.content as { arguments: unknown }[])[0]!.arguments = { path: "skill://important" };
    messages[6]!.content = [{ type: "image", data: "bytes", mimeType: "image/png" }];
    (messages[7]!.content as unknown[]).push({ type: "toolCall", id: "pending", name: "read", arguments: { path: "later" } });
    const result = project(messages, emptyState(), policy, { idleMs: 60001, tokens: 100000, ids: sourceIds(messages, branch) });
    expect(result.changed).toBe(false);
    expect(result.messages).toEqual(messages);
  });
  test("bootstrap results before the first user message are never demoted", () => {
    const { messages, branch, options } = fixture();
    const user = messages.shift()!;
    messages.push(user);
    const result = project(messages, emptyState(), { ...policy, protectRounds: 1 }, { ...options, ids: sourceIds(messages, branch) });
    expect(result.changed).toBe(false);
  });
  test("different branch entry IDs cannot inherit a projection or recover foreign results", () => {
    const { messages, branch, options } = fixture();
    const first = project(messages, emptyState(), policy, options);
    const fork = branch.map(entry => ({ ...entry, id: `other-${entry.id}` }));
    const next = project(messages, first.state, policy, { ...options, idleMs: 0, ids: sourceIds(messages, fork) });
    expect(next.messages).toEqual(messages);
    expect(() => recover(fork, "entry2", 0, 100)).toThrow("not present");
  });
  test("ambiguous tool-call IDs fail open and exact recovery rejects invalid ranges", () => {
    const { messages, branch } = fixture();
    branch.push({ ...branch[2]!, id: "duplicate" });
    expect(sourceIds(messages, branch)[2]).toBeUndefined();
    expect(() => recover(branch, "entry2", -1, 100)).toThrow("Invalid");
    expect(() => recover(branch, "entry2", 0, 12001)).toThrow("Invalid");
    expect(() => recover(branch, "entry2", 30000, 100)).toThrow("exceeds");
    const page = recover(branch, "entry2", 20000, 100);
    expect(page.text).toBe("xx");
    expect(page.nextOffset).toBeNull();
  });
});
