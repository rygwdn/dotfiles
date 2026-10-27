export interface Policy {
  enabled: boolean;
  tools: string[];
  protectRounds: number;
  protectTokens: number;
  triggerTokens: number;
  minResultTokens: number;
  minReclaimTokens: number;
  regrowthTokens: number;
  coldAfterSeconds: number;
  idleSeconds: number;
  idleThresholdTokens: number;
  keepRecentTokens: number;
}
export const DEFAULT_POLICY: Policy = {
  enabled: true,
  tools: ["read", "edit", "write", "bash", "ask", "eval", "glob", "grep", "find", "task", "todo", "learn", "manage_skill", "web_search", "wait", "context_notes", "new_context", "mcp", "omp", "xd", "ssh", "secure"],
  protectRounds: 6, protectTokens: 8_000, triggerTokens: 32_000,
  minResultTokens: 1_000, minReclaimTokens: 8_000, regrowthTokens: 16_000,
  coldAfterSeconds: 3_600, idleSeconds: 900, idleThresholdTokens: 48_000, keepRecentTokens: 8_000,
};
export interface ContextMessage {
  role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean;
  [key: string]: unknown;
}
export interface JournalEntry {
  id: string; type: string; message?: ContextMessage; customType?: string; data?: unknown;
}
export interface Demotion { id: string; text: string }
export interface ProjectionState { version: 1; demotions: Demotion[]; lastRewriteSize: number }
export const emptyState = (): ProjectionState => ({ version: 1, demotions: [], lastRewriteSize: 0 });
export function textBody(message: ContextMessage): string | undefined {
  if (!Array.isArray(message.content) || !message.content.length) return undefined;
  const texts: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") return undefined;
    texts.push(block.text);
  }
  return texts.join("\n");
}
function calls(message: ContextMessage): { id: string; name: string; arguments?: unknown }[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter(b => b?.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string");
}
function protectedCall(name: string, args: unknown): boolean {
  if (["skill", "continuity_read", "context_notes", "new_context", "ask", "resolve"].includes(name)) return true;
  const path = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
  return name === "read" && typeof path === "string" && (path.startsWith("skill://") || /(?:^|\/)SKILL\.md(?::|$)/.test(path));
}
/** Match only unambiguous original results. Never project synthetic or rewritten messages. */
export function sourceIds(messages: ContextMessage[], branch: JournalEntry[]): (string | undefined)[] {
  const byCall = new Map<string, JournalEntry | null>();
  for (const entry of branch) {
    const m = entry.message;
    if (entry.type !== "message" || m?.role !== "toolResult" || !m.toolCallId) continue;
    byCall.set(m.toolCallId, byCall.has(m.toolCallId) ? null : entry);
  }
  return messages.map(m => {
    if (m.role !== "toolResult" || !m.toolCallId) return undefined;
    const e = byCall.get(m.toolCallId);
    return e?.message && JSON.stringify(e.message.content) === JSON.stringify(m.content) && e.message.toolName === m.toolName ? e.id : undefined;
  });
}
export interface Projection {
  messages: ContextMessage[]; state: ProjectionState; changed: boolean;
  reclaimedTokens: number; estimatedTokens: number; reason: string;
}
/** TTL gates NEW decisions only. Persisted replacement bytes replay without re-derivation. */
export function project(messages: ContextMessage[], state: ProjectionState, policy: Policy, options: {
  idleMs: number; tokens: number; ids: (string | undefined)[];
}): Projection {
  const known = new Map(state.demotions.map(d => [d.id, d]));
  const weights = messages.map(m => JSON.stringify(m).length);
  const chars = weights.reduce((a, b) => a + b, 0);
  // Attribute measured context usage proportionally; this is NOT a tokenizer or billing estimate.
  const scale = chars > 0 ? options.tokens / chars : 0;
  const sizes = weights.map(n => n * scale);
  const projected = [...messages];
  let reclaimed = 0;
  for (let i = 0; i < messages.length; i++) {
    const id = options.ids[i];
    const d = id && known.get(id);
    if (d && textBody(messages[i]!) !== undefined) {
      projected[i] = { ...messages[i]!, content: [{ type: "text", text: d.text }] };
      reclaimed += Math.max(0, weights[i]! - JSON.stringify(projected[i]).length) * scale;
    }
  }
  const effective = Math.max(0, options.tokens - reclaimed);
  const unchanged = (reason: string): Projection => ({ messages: projected, state, changed: false, reclaimedTokens: reclaimed, estimatedTokens: effective, reason });
  if (!policy.enabled) return unchanged("disabled; existing projections retained for cache stability");
  if (!Number.isFinite(options.tokens) || options.tokens <= 0) return unchanged("usage unavailable");
  if (effective < policy.triggerTokens) return unchanged("below trigger");
  if (state.lastRewriteSize > 0 && options.tokens < state.lastRewriteSize + policy.regrowthTokens) return unchanged("waiting for regrowth");
  const firstUser = messages.findIndex(m => m.role === "user");
  const protectedIds = new Set<string>();
  const issuing = new Map<string, { index: number; protected: boolean }>();
  let rounds = 0, tailTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const round = calls(messages[i]!);
    if (round.length) {
      rounds++;
      for (const call of round) {
        issuing.set(call.id, { index: i, protected: protectedCall(call.name, call.arguments) });
        if (rounds <= policy.protectRounds || tailTokens < policy.protectTokens) protectedIds.add(call.id);
      }
    }
    tailTokens += sizes[i]!;
  }
  const results = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
  for (const message of messages) {
    const round = calls(message);
    if (round.some(c => !results.has(c.id) || protectedIds.has(c.id))) for (const c of round) protectedIds.add(c.id);
  }
  // Conservatively preserve every warm prefix. No provider TTL or lookback is inferred.
  if (options.idleMs < policy.coldAfterSeconds * 1000) return unchanged("cache-hot; waiting for configured cold interval");
  const additions: Demotion[] = [];
  let saving = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!, id = options.ids[i];
    if (!id || known.has(id) || m.role !== "toolResult" || !m.toolCallId || m.isError || protectedIds.has(m.toolCallId)) continue;
    const source = issuing.get(m.toolCallId);
    if (!source || source.index < firstUser || firstUser < 0 || source.index >= i || source.protected || textBody(m) === undefined || sizes[i]! < policy.minResultTokens) continue;
    const text = `[Continuity: older ${m.toolName ?? "tool"} output omitted from this model-facing view. Original journal entry ${id} is retained. Recover with continuity_read({id:"${id}",offset:0,limit:12000}). Historical output is not evidence of a new action.]`;
    const replacement = { ...m, content: [{ type: "text", text }] };
    const delta = (weights[i]! - JSON.stringify(replacement).length) * scale;
    if (delta <= 0) continue;
    additions.push({ id, text });
    saving += delta;
  }
  if (saving < policy.minReclaimTokens) return unchanged("insufficient reclaim");
  const live = new Set(options.ids.filter((id): id is string => !!id));
  const demotions = [...state.demotions.filter(d => live.has(d.id)), ...additions];
  if (demotions.length > 4096) return unchanged("projection metadata limit reached");
  const selected = new Map(additions.map(d => [d.id, d]));
  for (let i = 0; i < messages.length; i++) {
    const id = options.ids[i], d = id && selected.get(id);
    if (d) projected[i] = { ...messages[i]!, content: [{ type: "text", text: d.text }] };
  }
  return { messages: projected, state: { version: 1, demotions, lastRewriteSize: options.tokens }, changed: true,
    reclaimedTokens: reclaimed + saving, estimatedTokens: Math.max(0, effective - saving), reason: "demoted old tool results; originals retained in journal" };
}
export function recover(branch: JournalEntry[], id: string, offset: number, limit: number): { text: string; nextOffset: number | null; totalChars: number } {
  if (!id || id.length > 200 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 12000) throw new Error("Invalid recovery range");
  const entry = branch.find(e => e.id === id && e.type === "message" && e.message?.role === "toolResult");
  const body = entry?.message && textBody(entry.message);
  if (body === undefined) throw new Error("Text result is not present on this session branch");
  if (offset > body.length) throw new Error("Offset exceeds result length");
  const end = Math.min(body.length, offset + limit);
  return { text: body.slice(offset, end), nextOffset: end < body.length ? end : null, totalChars: body.length };
}
