import { describe, expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOmpDeltaTranslator, type OmpDeltaTranslationContext } from "./delta-translation.js";

function harness() {
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "tool-rows", textDeltaFlushMs: 0, progressThrottleMs: 0 });
  return {
    translator,
    assembler,
    send(event: unknown, context: OmpDeltaTranslationContext = {}) {
      const threadId = context.threadId ?? "thread";
      const deltas = translator.translate(event, { ...context, threadId });
      for (const delta of deltas) expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
      return { deltas, events: assembler.assemble({ threadId, deltas }) };
    },
  };
}

const textResult = { content: [{ type: "text", text: "complete tool output" }] };

describe("typed OMP tool lifecycle", () => {
  it.each([
    { toolName: "grep", args: { pattern: "needle", path: "src" }, expected: { type: "search", mode: "content", query: "needle", path: "src", status: "completed" } },
    { toolName: "ast_grep", args: { pat: "foo($ARG)" }, expected: { type: "search", mode: "content", query: "foo($ARG)", status: "completed" } },
    { toolName: "glob", args: { path: "src/**/*.ts" }, expected: { type: "search", mode: "path", query: "src/**/*.ts", status: "completed" } },
    { toolName: "find", args: { query: "authentication", grep_keywords: [] }, expected: { type: "search", mode: "path", query: "authentication", status: "completed" } },
    { toolName: "web_search", args: { query: "release notes" }, expected: { type: "webSearch", queries: ["release notes"], resultText: "complete tool output" } },
    { toolName: "think", args: { thoughts: "Consider the invariants" }, expected: { type: "reasoning", summary: [], content: ["Consider the invariants"] } },
  ])("assembles one typed $toolName completion", ({ toolName, args, expected }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const start = h.send({ type: "tool_execution_start", toolName, toolCallId: "typed", args });
    const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "typed", result: textResult });
    const started = start.events.filter((event) => event.type === "item/started");
    const completed = end.events.filter((event) => event.type === "item/completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.item).toMatchObject({ ...expected, id: started[0]?.item.id });
    if (expected.type === "search") {
      expect(completed[0]?.item).not.toHaveProperty("resultText");
      expect(completed[0]?.item).not.toHaveProperty("result");
    }
  });

  it.each([
    { args: { path: "src/app.ts:20-40:raw" }, details: { resolvedPath: "/workspace/src/app.ts" }, expected: { type: "fileRead", path: "/workspace/src/app.ts" } },
    { args: { path: "src" }, details: { isDirectory: true, resolvedPath: "/workspace/src" }, expected: { type: "search", mode: "list", path: "/workspace/src", query: "src" } },
    { args: { path: "https://example.com:8443/doc:20-40" }, details: { kind: "url", url: "https://example.com:8443/doc", finalUrl: "https://example.com:8443/final" }, expected: { type: "webFetch", url: "https://example.com:8443/doc", resultText: "complete tool output" } },
  ])("defers read and uses result metadata for $expected.type", ({ args, details, expected }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const parent = h.send({ type: "tool_execution_start", toolName: "task", toolCallId: "parent", args: {} }).events.find((event) => event.type === "item/started");
    const context = { parentToolCallId: "parent" };
    expect(h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "read", args, intent: "Inspect target" }, context).deltas).toEqual([]);
    expect(h.send({ type: "tool_execution_update", toolName: "read", toolCallId: "read", partialResult: textResult }, context).deltas).toEqual([]);
    expect(h.send({ type: "tool_stream_update", toolName: "read", toolCallId: "read", update: "preview" }, context).deltas).toEqual([]);
    const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "read", result: { ...textResult, details } }, context);
    expect(end.deltas.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
    const started = end.events.filter((event) => event.type === "item/started");
    const completed = end.events.filter((event) => event.type === "item/completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.item).toMatchObject({ ...expected, id: started[0]?.item.id, parentToolCallId: parent?.item.id });
    expect(started[0]?.item).toMatchObject({ presentation: { title: "Inspect target" } });
    if (expected.type === "fileRead") expect(completed[0]?.item).not.toHaveProperty("resultText");
  });

  it("preserves failure status from both the envelope and the result", () => {
    for (const isError of [false, true]) {
      const h = harness();
      h.send({ type: "agent_start" });
      h.send({ type: "tool_execution_start", toolName: "grep", toolCallId: "failed", args: { pattern: "x" } });
      const end = h.send({ type: "tool_execution_end", toolName: "grep", toolCallId: "failed", isError, result: { ...textResult, isError: true } });
      expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", status: "failed" }));
      expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "search", status: "failed" });
    }
  });

  it("never treats a device write as a file change, including missing start", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const args = { path: "xd://ast_grep", content: JSON.stringify({ pat: "foo()" }) };
    const result = { ...textResult, details: { xdev: { tool: "ast_grep", mode: "execute", args: { pat: "foo()" }, inner: textResult } } };
    expect(h.send({ type: "tool_execution_start", toolName: "write", toolCallId: "device", args }).deltas).toEqual([]);
    const end = h.send({ type: "tool_execution_end", toolName: "write", toolCallId: "device", result });
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "search", mode: "content", query: "foo()" });
    const unseen = h.send({ type: "tool_execution_end", toolName: "write", toolCallId: "unseen", result });
    expect(unseen.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "write", result });
  });

  it("isolates deferred reads by thread and parent and clears them on reset", () => {
    const h = harness();
    for (const parentToolCallId of ["a", "b"]) {
      h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "shared", args: { path: `${parentToolCallId}:2-4` } }, { parentToolCallId });
    }
    for (const parentToolCallId of ["b", "a"]) {
      const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "shared", result: { ...textResult, details: { resolvedPath: `/workspace/${parentToolCallId}` } } }, { parentToolCallId });
      expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", presentation: expect.objectContaining({ detail: `${parentToolCallId}:2-4` }) }));
    }
    h.send({ type: "tool_execution_start", toolName: "grep", toolCallId: "reset", args: { pattern: "x" } });
    h.translator.resetThread("thread");
    expect(h.send({ type: "tool_execution_end", toolName: "grep", toolCallId: "reset", result: textResult }).deltas).toContainEqual(expect.objectContaining({ kind: "item.close", item: expect.objectContaining({ type: "tool", tool: "grep" }) }));
  });
});

describe("OMP cache warming notices", () => {
  const identity = { provider: "anthropic", model: "claude" };
  it.each(["hit", "miss", "error", "aborted"] as const)("opens and closes one streaming notice for %s without settling the root", (outcome) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const turnId = h.assembler.getOpenTurnId("thread");
    const start = h.send({ type: "cache_warming_start", phase: "streaming", ...identity });
    const end = h.send({ type: "cache_warming_end", phase: "streaming", outcome, ...identity, usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: 11, cost: { total: 0.002 } }, warmingStopReason: "done" });
    expect(start.deltas.map((delta) => delta.kind)).toEqual(["item.open"]);
    expect(end.deltas.map((delta) => delta.kind)).toEqual(["item.close"]);
    expect(h.assembler.getOpenTurnId("thread")).toBe(turnId);
    const opened = start.events.find((event) => event.type === "item/started");
    const closed = end.events.find((event) => event.type === "item/completed");
    expect(opened?.item).toMatchObject({ type: "extension", kind: "provider-omp/notice" });
    expect(closed?.item).toMatchObject({ id: opened?.item.id, type: "extension", kind: "provider-omp/notice", payload: { severity: outcome === "error" ? "warning" : "info", message: expect.stringContaining(outcome), instructions: expect.stringContaining("11 tokens") } });
    expect(closed?.item).toMatchObject({ payload: { instructions: expect.stringContaining("$0.002") } });
  });

  it.each(["hit", "miss", "aborted"] as const)("keeps idle %s silent even if a real turn starts before completion", (outcome) => {
    const h = harness();
    expect(h.send({ type: "cache_warming_start", phase: "idle", ...identity }).deltas).toEqual([]);
    h.send({ type: "agent_start" });
    const turnId = h.assembler.getOpenTurnId("thread");
    expect(h.send({ type: "cache_warming_end", phase: "idle", outcome, ...identity }).deltas).toEqual([]);
    expect(h.assembler.getOpenTurnId("thread")).toBe(turnId);
  });

  it("reports idle errors as warnings without creating or closing a turn", () => {
    const h = harness();
    h.send({ type: "cache_warming_start", phase: "idle", ...identity });
    const end = h.send({ type: "cache_warming_end", phase: "idle", outcome: "error", ...identity, warmingStopReason: "upstream failure" });
    expect(end.deltas).toEqual([expect.objectContaining({ kind: "provider.warning", details: expect.stringContaining("upstream failure") })]);
    expect(h.assembler.getOpenTurnId("thread")).toBeUndefined();
  });

  it("does not settle a newer root when streaming warming completes late", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    h.send({ type: "cache_warming_start", phase: "streaming", ...identity });
    h.send({ type: "agent_end", deferSettlement: false });
    h.send({ type: "agent_start" });
    const turnId = h.assembler.getOpenTurnId("thread");
    const end = h.send({ type: "cache_warming_end", phase: "streaming", outcome: "aborted", ...identity });
    expect(end.deltas.every((delta) => delta.kind !== "turn.boundary" && delta.kind !== "turn.open")).toBe(true);
    expect(h.assembler.getOpenTurnId("thread")).toBe(turnId);
  });

  it("clears pending warming identities when the thread is reset", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    h.send({ type: "cache_warming_start", phase: "streaming", ...identity });
    h.translator.resetThread("thread");
    expect(h.send({ type: "cache_warming_end", phase: "streaming", outcome: "hit", ...identity }).deltas).toEqual([]);
  });

  it("preserves parent nesting and ignores duplicate starts", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const parent = h.send({ type: "tool_execution_start", toolName: "task", toolCallId: "parent", args: {} }).events.find((event) => event.type === "item/started");
    const context = { parentToolCallId: "parent" };
    const start = h.send({ type: "cache_warming_start", phase: "streaming", ...identity }, context);
    expect(h.send({ type: "cache_warming_start", phase: "streaming", ...identity }, context).deltas).toEqual([]);
    const end = h.send({ type: "cache_warming_end", phase: "streaming", outcome: "hit", ...identity }, context);
    expect(start.deltas).toContainEqual(expect.objectContaining({ key: expect.objectContaining({ parentRef: "parent" }) }));
    expect(end.deltas).toContainEqual(expect.objectContaining({ key: expect.objectContaining({ parentRef: "parent" }) }));
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ parentToolCallId: parent?.item.id });
  });
});
