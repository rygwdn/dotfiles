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
    { toolName: "find", args: { query: "authentication", grep_keywords: [] }, expected: { type: "search", mode: "content", query: "authentication", status: "completed" } },
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
      expect(start.deltas).toContainEqual(expect.objectContaining({ kind: "item.open", item: expect.objectContaining({ tool: toolName }) }));
      expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", resultText: "complete tool output", item: expect.objectContaining({ tool: toolName }) }));
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

  it.each([
    { suffix: ":600-700", selection: { selector: ":600-700", startLine: 600, endLine: 700 } },
    { suffix: ":raw:600-700", selection: { selector: ":raw:600-700", startLine: 600, endLine: 700 } },
    { suffix: ":600-700:raw", selection: { selector: ":600-700:raw", startLine: 600, endLine: 700 } },
    { suffix: ":600-700,900-950", selection: { selector: ":600-700,900-950" } },
    { suffix: ":-60", selection: { selector: ":-60" } },
    { suffix: "", selection: {} },
  ])("emits requested file selector $suffix and exact output on translated deltas", ({ suffix, selection }) => {
    const h = harness();
    const args = { path: `src/app.ts${suffix}` };
    const resultText = "[src/app.ts#ABCD]\n599: preceding context\n600: selected content\n701: following context";
    const result = { details: { resolvedPath: "/resolved/src/app.ts" }, content: [{ type: "text", text: resultText }] };
    h.send({ type: "agent_start" });
    expect(h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "selected", args, intent: "Inspect read:1-2" }).deltas).toEqual([]);
    const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "selected", result });
    const item = { type: "fileRead", path: "/resolved/src/app.ts", ...selection };
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", item }),
      expect.objectContaining({ kind: "item.close", status: "completed", item, resultText }),
    ]);
    // The pinned 0.6.75 SDK drops fileRead selector metadata and resultText.
    // The emitted wire contract is asserted above; updated bb core covers retention.
    const completed = end.events.find((event) => event.type === "item/completed");
    expect(completed?.item).toMatchObject({ type: "fileRead", path: "/resolved/src/app.ts" });
  });

  it.each([
    { name: "multiple local targets with metadata", path: "src/a.ts:2-4;src/b.ts:6-8", details: { resolvedPath: "/workspace/src/a.ts", displayReadTargets: ["src/a.ts", "src/b.ts"] } },
    { name: "multiple local targets without target metadata", path: "src/a.ts:2-4;src/b.ts:6-8", details: { resolvedPath: "/workspace/src/a.ts" } },
    { name: "newline local targets", path: "src/a.ts:2-4\nsrc/b.ts:6-8", details: { resolvedPath: "/workspace/src/a.ts" } },
    { name: "URL-first mixed targets without target metadata", path: "https://example.com/read;src/a.ts", details: { kind: "url", url: "https://example.com/read" } },
    { name: "missing backing metadata", path: "src/a.ts:600-700", details: {} },
    { name: "malformed backing metadata", path: "src/a.ts:600-700", details: { resolvedPath: 42 } },
  ])("preserves $name as a generic read with original output", ({ path, details }) => {
    const h = harness();
    const args = { path, i: "Inspect paths" };
    const result = { ...textResult, details };
    h.send({ type: "agent_start" });
    h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "fallback", args });
    const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "fallback", result });
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", item: { type: "tool", tool: "read", args, result } }),
      expect.objectContaining({ kind: "item.close", status: "completed", resultText: "complete tool output", item: { type: "tool", tool: "read", args, result } }),
    ]);
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "read", result });
  });

  it.each([
    { name: "envelope failure", envelopeError: true, resultError: false },
    { name: "result failure", envelopeError: false, resultError: true },
  ])("keeps $name diagnostics on typed and generic read closes", ({ envelopeError, resultError }) => {
    for (const resolvedPath of ["/workspace/src/app.ts", undefined]) {
      const h = harness();
      const args = { path: "src/app.ts:raw:600-700" };
      const resultText = "ENOENT: cannot read requested file";
      const result = {
        content: [{ type: "text", text: resultText }],
        ...(resultError ? { isError: true } : {}),
        ...(resolvedPath ? { details: { resolvedPath } } : {}),
      };
      h.send({ type: "agent_start" });
      h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "failed-read", args });
      const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "failed-read", isError: envelopeError, result });
      const item = resolvedPath
        ? { type: "fileRead", path: resolvedPath, selector: ":raw:600-700", startLine: 600, endLine: 700 }
        : { type: "tool", tool: "read", args, result };
      expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", status: "failed", resultText, item }));
      expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: resolvedPath ? "fileRead" : "toolCall", status: "failed" });
    }
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

describe("OMP search wire output", () => {
  const searches = [
    { tool: "grep", args: { pattern: "needle", path: "src;tests" }, item: { type: "search", tool: "grep", mode: "content", query: "needle", path: "src;tests" }, text: "[src/app.ts#ABCD]\n12: needle\n[tests/app.test.ts#1234]\n42: needle" },
    { tool: "ast_grep", args: { pat: "$CALL($$$ARGS)", path: "src/**/*.ts" }, item: { type: "search", tool: "ast_grep", mode: "content", query: "$CALL($$$ARGS)", path: "src/**/*.ts" }, text: "src/app.ts:12:3\n  call(argument)" },
    { tool: "glob", args: { path: "src/**/*.ts;tests/**/*.ts" }, item: { type: "search", tool: "glob", mode: "path", query: "src/**/*.ts;tests/**/*.ts" }, text: "src/app.ts\ntests/app.test.ts\n… 12 more" },
    { tool: "find", args: { query: "Where is authentication initialized?", path: "src", grep_keywords: ["authenticate"] }, item: { type: "search", tool: "find", mode: "content", query: "Where is authentication initialized?", path: "src" }, text: "2 hit(s) (τ 0.20), strongest first\nsrc/auth.ts  0.97  208 lines judged, partial\n  src/auth.ts:18-42  0.97  authenticate(request)\n\nlisted 139 · judged 128 · read 20 files\nCoverage partial; output truncated: artifact://find-output" },
    { tool: "read", args: { path: "src:20-30" }, details: { isDirectory: true, resolvedPath: "/workspace/src" }, item: { type: "search", tool: "read", mode: "list", path: "/workspace/src", query: "src:20-30" }, text: "# src/\n20: app.ts\n21: auth.ts\n… 12 more" },
  ];

  describe.each(searches)("$tool", ({ tool, args, item, details, text }) => {
    it.each([
      { label: "success", envelopeError: false, resultError: false },
      { label: "execution failure", envelopeError: true, resultError: false },
      { label: "result failure", envelopeError: false, resultError: true },
    ])("retains identity, query, scope and complete $label output, native or dispatched", ({ envelopeError, resultError }) => {
      for (const device of [false, true]) {
        const h = harness();
        const context = { parentToolCallId: "parent" };
        h.send({ type: "agent_start" });
        h.send({ type: "tool_execution_start", toolName: "task", toolCallId: "parent", args: {} });
        const toolName = device ? "write" : tool;
        const toolArgs = device ? { path: `xd://${tool}`, content: JSON.stringify(args) } : args;
        const output = envelopeError || resultError ? `Search failed:\n${text}\nPermission denied` : text;
        const inner = { content: [{ type: "text", text: output }], ...(details ? { details } : {}), isError: resultError };
        const result = device
          ? { details: { xdev: { tool, mode: "execute", args, inner } } }
          : inner;
        const start = h.send({ type: "tool_execution_start", toolName, toolCallId: "search", args: toolArgs, intent: "Inspecting source" }, context);
        if (device || tool === "read") expect(start.deltas).toEqual([]);
        else expect(start.deltas).toEqual([expect.objectContaining({ kind: "item.open", item })]);
        const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "search", result, isError: envelopeError }, context);
        expect(end.deltas.map((delta) => delta.kind)).toEqual(device || tool === "read" ? ["item.open", "item.close"] : ["item.close"]);
        expect(end.deltas).toContainEqual(expect.objectContaining({
          kind: "item.close",
          key: { providerItemId: "search", parentRef: "parent" },
          status: envelopeError || resultError ? "failed" : "completed",
          item,
          resultText: output,
          presentation: expect.objectContaining({ title: "Inspecting source" }),
        }));
        const completed = end.events.find((event) => event.type === "item/completed");
        expect(completed?.item).toMatchObject({ type: "search", status: envelopeError || resultError ? "failed" : "completed" });
        if (tool === "find") {
          const presentation = {
            icon: { glyph: "Search" },
            label: { pending: "Searching semantically", completed: "Searched semantically" },
            title: "Inspecting source",
            detail: item.query,
          };
          const opened = device ? end.deltas : start.deltas;
          expect(opened).toContainEqual(expect.objectContaining({ kind: "item.open", item, presentation }));
          expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", presentation }));
          expect(completed?.item).toMatchObject({ mode: "content", presentation });
        }
        // SDK 0.6.75 drops search.tool/resultText; the emitted wire fields above
        // are retained by the matching updated bb core rather than this assembler.
      }
    });
  });

  it.each([false, true])("presents semantic find with its natural-language query without intent (device=%s)", (device) => {
    const h = harness();
    const args = { query: "Where is authentication initialized?", path: "src" };
    const toolName = device ? "write" : "find";
    const toolArgs = device ? { path: "xd://find", content: JSON.stringify(args) } : args;
    const result = device ? { details: { xdev: { tool: "find", mode: "execute", args, inner: textResult } } } : textResult;
    const item = { type: "search", tool: "find", mode: "content", query: args.query, path: args.path };
    const presentation = {
      icon: { glyph: "Search" },
      label: { pending: "Searching semantically", completed: "Searched semantically" },
      title: args.query,
    };
    h.send({ type: "agent_start" });
    const start = h.send({ type: "tool_execution_start", toolName, toolCallId: "semantic", args: toolArgs });
    const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "semantic", result });
    expect(device ? end.deltas : start.deltas).toContainEqual(expect.objectContaining({ kind: "item.open", item, presentation }));
    expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", item, presentation, resultText: "complete tool output" }));
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({
      type: "search", mode: "content", query: args.query, presentation,
    });
  });

  it("retains outer dispatch diagnostics as well as an inner failure flag", () => {
    const h = harness();
    const args = { pat: "$CALL($$$ARGS)", path: "src" };
    const outerArgs = { path: "xd://ast_grep", content: JSON.stringify(args) };
    const output = "Dispatcher diagnostic:\nSearch failed: permission denied\nFull trace: artifact://error";
    const inner = { content: [{ type: "text", text: "Search failed: permission denied" }], isError: true };
    const result = { content: [{ type: "text", text: output }], details: { xdev: { tool: "ast_grep", mode: "execute", args, inner } } };
    h.send({ type: "agent_start" });
    h.send({ type: "tool_execution_start", toolName: "write", toolCallId: "dispatch-error", args: outerArgs });
    expect(h.send({ type: "tool_execution_end", toolName: "write", toolCallId: "dispatch-error", result, isError: false }).deltas).toContainEqual(expect.objectContaining({
      kind: "item.close", status: "failed", resultText: output,
      item: { type: "search", tool: "ast_grep", mode: "content", query: args.pat, path: args.path },
    }));
  });

  it("does not bound or normalize large semantic-find output or coverage footers", () => {
    const h = harness();
    const args = { query: "Locate initialization", path: "src" };
    const output = `  Leading whitespace\n${"src/auth.ts:12-42  0.97  partial coverage\n".repeat(8_000)}\nlisted 139 · judged 128 · read 20 files\nOutput truncated; full result: artifact://find-output\n  `;
    h.send({ type: "agent_start" });
    h.send({ type: "tool_execution_start", toolName: "find", toolCallId: "large", args });
    const end = h.send({ type: "tool_execution_end", toolName: "find", toolCallId: "large", result: { content: [{ type: "text", text: output }] } });
    expect(end.deltas).toEqual([expect.objectContaining({
      kind: "item.close",
      item: { type: "search", tool: "find", mode: "content", query: args.query, path: args.path },
      resultText: output,
    })]);
  });

  it.each([
    { tool: "grep", args: { pattern: 42, path: "src" }, details: {} },
    { tool: "ast_grep", args: { pat: ["$CALL"], path: "src" }, details: {} },
    { tool: "glob", args: { path: ["src"] }, details: {} },
    { tool: "find", args: { query: "", path: "src" }, details: {} },
    { tool: "read", args: { path: "src" }, details: { isDirectory: true } },
  ])("preserves unsafe $tool invocations as generic tools, native or dispatched", ({ tool, args, details }) => {
    for (const device of [false, true]) {
      const h = harness();
      h.send({ type: "agent_start" });
      const toolName = device ? "write" : tool;
      const toolArgs = device ? { path: `xd://${tool}`, content: JSON.stringify(args) } : args;
      const inner = { ...textResult, details, isError: true };
      const result = device ? { ...textResult, details: { xdev: { tool, mode: "execute", args, inner } }, isError: true } : inner;
      h.send({ type: "tool_execution_start", toolName, toolCallId: "unsafe", args: toolArgs });
      const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "unsafe", result });
      expect(end.deltas).toContainEqual(expect.objectContaining({
        kind: "item.close", status: "failed", resultText: "complete tool output",
        item: { type: "tool", tool: toolName, args: toolArgs, result },
      }));
      expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({
        type: "toolCall", tool: toolName, arguments: toolArgs, result,
      });
    }
  });

  it("recovers directory identity from metadata without inventing a missing search query", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const result = { ...textResult, details: { isDirectory: true, resolvedPath: "/workspace/src" } };
    expect(h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "directory", result }).deltas).toContainEqual(expect.objectContaining({
      kind: "item.close", resultText: "complete tool output",
      item: { type: "search", tool: "read", mode: "list", path: "/workspace/src", query: "/workspace/src" },
    }));
    expect(h.send({ type: "tool_execution_end", toolName: "find", toolCallId: "unknown-query", result: textResult }).deltas).toContainEqual(expect.objectContaining({
      kind: "item.close", resultText: "complete tool output",
      item: { type: "tool", tool: "find", args: undefined, result: textResult },
    }));
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
