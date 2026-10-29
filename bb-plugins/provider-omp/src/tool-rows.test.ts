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

describe("OMP tool lifecycle", () => {
  it.each([
    { toolName: "grep", args: { pattern: "needle", path: "src" } },
    { toolName: "ast_grep", args: { pat: "foo($ARG)" } },
    { toolName: "glob", args: { path: "src/**/*.ts" } },
    { toolName: "find", args: { query: "authentication", grep_keywords: [] } },
    { toolName: "web_search", args: { query: "release notes" } },
  ])("assembles one generic $toolName completion with original arguments and result", ({ toolName, args }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const start = h.send({ type: "tool_execution_start", toolName, toolCallId: "generic", args });
    const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "generic", result: textResult });
    expect(start.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", key: { providerItemId: "generic" }, item: { type: "tool", tool: toolName, args } }),
    ]);
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", status: "completed", resultText: "complete tool output", item: { type: "tool", tool: toolName, args, result: textResult } }),
    ]);
    const started = start.events.filter((event) => event.type === "item/started");
    const completed = end.events.filter((event) => event.type === "item/completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.item).toMatchObject({ type: "toolCall", tool: toolName, arguments: args, status: "pending" });
    expect(completed[0]?.item).toMatchObject({ type: "toolCall", tool: toolName, arguments: args, result: textResult, status: "completed", id: started[0]?.item.id });
    const closed = end.deltas[0];
    if (closed?.kind !== "item.close" || closed.item?.type !== "tool") throw new Error("Expected a generic tool completion");
    expect(closed.item.result).toBe(textResult);
    expect(closed.item.args).toBe(args);
  });

  it("keeps valid think calls as reasoning", () => {
    const h = harness();
    const args = { thoughts: "Consider the invariants" };
    h.send({ type: "agent_start" });
    const start = h.send({ type: "tool_execution_start", toolName: "think", toolCallId: "thinking", args });
    const end = h.send({ type: "tool_execution_end", toolName: "think", toolCallId: "thinking", result: textResult });
    const started = start.events.filter((event) => event.type === "item/started");
    const completed = end.events.filter((event) => event.type === "item/completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.item).toMatchObject({ type: "reasoning", summary: [], content: ["Consider the invariants"], id: started[0]?.item.id });
  });

  it.each([
    { name: "local file", args: { path: "src/app.ts:20-40:raw" }, details: { resolvedPath: "/workspace/src/app.ts" } },
    { name: "directory", args: { path: "src" }, details: { isDirectory: true, resolvedPath: "/workspace/src" } },
    { name: "URL", args: { path: "https://example.com:8443/doc:20-40" }, details: { kind: "url", url: "https://example.com:8443/doc", finalUrl: "https://example.com:8443/final" } },
  ])("opens a generic $name read immediately and preserves metadata, intent and parent", ({ args, details }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const parent = h.send({ type: "tool_execution_start", toolName: "task", toolCallId: "parent", args: {} }).events.find((event) => event.type === "item/started");
    const context = { parentToolCallId: "parent" };
    const key = { providerItemId: "read", parentRef: "parent" };
    const start = h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "read", args, intent: "Inspect target" }, context);
    expect(start.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", key, item: { type: "tool", tool: "read", args }, presentation: expect.objectContaining({ title: "Inspect target" }) }),
    ]);
    expect(h.send({ type: "tool_execution_update", toolName: "read", toolCallId: "read", partialResult: textResult }, context).deltas).toEqual([
      expect.objectContaining({ kind: "item.progress", key, message: "complete tool output" }),
    ]);
    expect(h.send({ type: "tool_stream_update", toolName: "read", toolCallId: "read", update: "preview" }, context).deltas).toEqual([
      expect.objectContaining({ kind: "item.progress", key, message: "preview" }),
    ]);
    const result = { ...textResult, details };
    const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "read", result }, context);
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", key, status: "completed", item: { type: "tool", tool: "read", args, result }, resultText: "complete tool output", presentation: expect.objectContaining({ title: "Inspect target" }) }),
    ]);
    const started = start.events.filter((event) => event.type === "item/started");
    const completed = end.events.filter((event) => event.type === "item/completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.item).toMatchObject({ type: "toolCall", tool: "read", arguments: args, parentToolCallId: parent?.item.id, presentation: { title: "Inspect target" } });
    expect(completed[0]?.item).toMatchObject({ type: "toolCall", tool: "read", arguments: args, result, status: "completed", id: started[0]?.item.id, parentToolCallId: parent?.item.id, presentation: { title: "Inspect target" } });
  });

  it.each([":600-700", ":raw:600-700", ":600-700:raw", ":600-700,900-950", ":-60", ""])("preserves requested file selector %s in generic arguments and exact output", (suffix) => {
    const h = harness();
    const args = { path: `src/app.ts${suffix}` };
    const resultText = "[src/app.ts#ABCD]\n599: preceding context\n600: selected content\n701: following context";
    const result = { details: { resolvedPath: "/resolved/src/app.ts" }, content: [{ type: "text", text: resultText }] };
    h.send({ type: "agent_start" });
    const start = h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "selected", args, intent: "Inspect read:1-2" });
    expect(start.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", item: { type: "tool", tool: "read", args }, presentation: expect.objectContaining({ title: "Inspect read:1-2" }) }),
    ]);
    const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "selected", result });
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", status: "completed", item: { type: "tool", tool: "read", args, result }, resultText }),
    ]);
    const completed = end.events.find((event) => event.type === "item/completed");
    expect(completed?.item).toMatchObject({ type: "toolCall", tool: "read", arguments: args, result, status: "completed" });
    const closed = end.deltas[0];
    if (closed?.kind !== "item.close" || closed.item?.type !== "tool") throw new Error("Expected a generic read completion");
    expect(closed.item.result).toBe(result);
    expect(closed.item.args).toBe(args);
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
    const start = h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "fallback", args });
    expect(start.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", item: { type: "tool", tool: "read", args } }),
    ]);
    const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "fallback", result });
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", status: "completed", resultText: "complete tool output", item: { type: "tool", tool: "read", args, result } }),
    ]);
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "read", arguments: args, result, status: "completed" });
  });

  it.each([
    { name: "envelope failure", envelopeError: true, resultError: false },
    { name: "result failure", envelopeError: false, resultError: true },
  ])("keeps $name diagnostics on generic read closes with or without backing metadata", ({ envelopeError, resultError }) => {
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
      expect(end.deltas).toEqual([
        expect.objectContaining({ kind: "item.close", status: "failed", resultText, item: { type: "tool", tool: "read", args, result } }),
      ]);
      expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "read", arguments: args, result, status: "failed" });
    }
  });

  it.each([
    { envelopeError: true, resultError: false },
    { envelopeError: false, resultError: true },
    { envelopeError: true, resultError: true },
  ])("preserves grep failure status (envelope=$envelopeError, result=$resultError)", ({ envelopeError, resultError }) => {
    const h = harness();
    const args = { pattern: "x" };
    const result = { ...textResult, isError: resultError };
    h.send({ type: "agent_start" });
    h.send({ type: "tool_execution_start", toolName: "grep", toolCallId: "failed", args });
    const end = h.send({ type: "tool_execution_end", toolName: "grep", toolCallId: "failed", isError: envelopeError, result });
    expect(end.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", status: "failed", resultText: "complete tool output", item: { type: "tool", tool: "grep", args, result } }));
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "grep", arguments: args, result, status: "failed" });
  });

  it("preserves a device write as the outer generic tool, including missing start", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const args = { path: "xd://ast_grep", content: JSON.stringify({ pat: "foo()" }) };
    const result = { ...textResult, details: { xdev: { tool: "ast_grep", mode: "execute", args: { pat: "foo()" }, inner: textResult } } };
    const start = h.send({ type: "tool_execution_start", toolName: "write", toolCallId: "device", args });
    expect(start.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", item: { type: "tool", tool: "write", args } }),
    ]);
    const end = h.send({ type: "tool_execution_end", toolName: "write", toolCallId: "device", result });
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", item: { type: "tool", tool: "write", args, result }, resultText: "complete tool output" }),
    ]);
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "write", arguments: args, result });
    const unseen = h.send({ type: "tool_execution_end", toolName: "write", toolCallId: "unseen", result });
    expect(unseen.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", item: { type: "tool", tool: "write", args: undefined, result }, resultText: "complete tool output" }),
    ]);
    const completed = unseen.events.find((event) => event.type === "item/completed");
    expect(completed?.item).toMatchObject({ type: "toolCall", tool: "write", result });
    expect(completed?.item).not.toHaveProperty("arguments");
  });

  it("isolates started read arguments by thread and parent and clears them on reset", () => {
    const h = harness();
    for (const threadId of ["thread", "other"]) {
      h.send({ type: "agent_start" }, { threadId });
      for (const parentToolCallId of ["a", "b"]) {
        h.send({ type: "tool_execution_start", toolName: "task", toolCallId: parentToolCallId, args: {} }, { threadId });
        h.send({ type: "tool_execution_start", toolName: "read", toolCallId: "shared", args: { path: `${threadId}/${parentToolCallId}:2-4` }, intent: `Inspect ${threadId}/${parentToolCallId}` }, { threadId, parentToolCallId });
      }
    }
    for (const threadId of ["other", "thread"]) {
      for (const parentToolCallId of ["b", "a"]) {
        const args = { path: `${threadId}/${parentToolCallId}:2-4` };
        const result = { ...textResult, details: { resolvedPath: `/workspace/${threadId}/${parentToolCallId}` } };
        const end = h.send({ type: "tool_execution_end", toolName: "read", toolCallId: "shared", result }, { threadId, parentToolCallId });
        expect(end.deltas).toEqual([
          expect.objectContaining({ kind: "item.close", key: { providerItemId: "shared", parentRef: parentToolCallId }, item: { type: "tool", tool: "read", args, result }, presentation: expect.objectContaining({ title: `Inspect ${threadId}/${parentToolCallId}` }) }),
        ]);
        expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({ type: "toolCall", tool: "read", arguments: args, result, presentation: { title: `Inspect ${threadId}/${parentToolCallId}` } });
      }
    }
    h.send({ type: "tool_execution_start", toolName: "grep", toolCallId: "reset", args: { pattern: "x" }, intent: "Stale intent" });
    h.translator.resetThread("thread");
    const end = h.send({ type: "tool_execution_end", toolName: "grep", toolCallId: "reset", result: textResult });
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", item: { type: "tool", tool: "grep", args: undefined, result: textResult } }),
    ]);
    expect(end.deltas[0]).not.toHaveProperty("presentation");
    const completed = end.events.find((event) => event.type === "item/completed");
    expect(completed?.item).toMatchObject({ type: "toolCall", tool: "grep", result: textResult });
    expect(completed?.item).not.toHaveProperty("arguments");
  });
});

describe("OMP search wire output", () => {
  const searches = [
    { tool: "grep", args: { pattern: "needle", path: "src;tests" }, text: "[src/app.ts#ABCD]\n12: needle\n[tests/app.test.ts#1234]\n42: needle" },
    { tool: "ast_grep", args: { pat: "$CALL($$$ARGS)", path: "src/**/*.ts" }, text: "src/app.ts:12:3\n  call(argument)" },
    { tool: "glob", args: { path: "src/**/*.ts;tests/**/*.ts" }, text: "src/app.ts\ntests/app.test.ts\n… 12 more" },
    { tool: "find", args: { query: "Where is authentication initialized?", path: "src", grep_keywords: ["authenticate"] }, text: "2 hit(s) (τ 0.20), strongest first\nsrc/auth.ts  0.97  208 lines judged, partial\n  src/auth.ts:18-42  0.97  authenticate(request)\n\nlisted 139 · judged 128 · read 20 files\nCoverage partial; output truncated: artifact://find-output" },
    { tool: "read", args: { path: "src:20-30" }, details: { isDirectory: true, resolvedPath: "/workspace/src" }, text: "# src/\n20: app.ts\n21: auth.ts\n… 12 more" },
  ];

  describe.each(searches)("$tool", ({ tool, args, details, text }) => {
    it.each([
      { label: "success", envelopeError: false, resultError: false },
      { label: "execution failure", envelopeError: true, resultError: false },
      { label: "result failure", envelopeError: false, resultError: true },
    ])("retains identity, query, scope and complete $label output, native or dispatched", ({ envelopeError, resultError }) => {
      for (const device of [false, true]) {
        const h = harness();
        const context = { parentToolCallId: "parent" };
        const key = { providerItemId: "search", parentRef: "parent" };
        const presentation = expect.objectContaining({ title: "Inspecting source" });
        h.send({ type: "agent_start" });
        const parent = h.send({ type: "tool_execution_start", toolName: "task", toolCallId: "parent", args: {} }).events.find((event) => event.type === "item/started");
        const toolName = device ? "write" : tool;
        const toolArgs = device ? { path: `xd://${tool}`, content: JSON.stringify(args) } : args;
        const output = envelopeError || resultError ? `Search failed:\n${text}\nPermission denied` : text;
        const inner = { content: [{ type: "text", text: output }], ...(details ? { details } : {}), isError: resultError };
        const result = device
          ? { content: inner.content, isError: resultError, details: { xdev: { tool, mode: "execute", args, inner } } }
          : inner;
        const status = envelopeError || resultError ? "failed" : "completed";
        const start = h.send({ type: "tool_execution_start", toolName, toolCallId: "search", args: toolArgs, intent: "Inspecting source" }, context);
        expect(start.deltas).toEqual([
          expect.objectContaining({ kind: "item.open", key, item: { type: "tool", tool: toolName, args: toolArgs }, presentation }),
        ]);
        const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "search", result, isError: envelopeError }, context);
        expect(end.deltas).toEqual([
          expect.objectContaining({ kind: "item.close", key, status, item: { type: "tool", tool: toolName, args: toolArgs, result }, resultText: output, presentation }),
        ]);
        const started = start.events.filter((event) => event.type === "item/started");
        const completed = end.events.filter((event) => event.type === "item/completed");
        expect(started).toHaveLength(1);
        expect(completed).toHaveLength(1);
        expect(started[0]?.item).toMatchObject({ type: "toolCall", tool: toolName, arguments: toolArgs, status: "pending", parentToolCallId: parent?.item.id, presentation });
        expect(completed[0]?.item).toMatchObject({ type: "toolCall", tool: toolName, arguments: toolArgs, result, status, id: started[0]?.item.id, parentToolCallId: parent?.item.id, presentation });
        const opened = start.deltas[0];
        const closed = end.deltas[0];
        if (opened?.kind !== "item.open" || opened.item.type !== "tool") throw new Error("Expected a generic search start");
        if (closed?.kind !== "item.close" || closed.item?.type !== "tool") throw new Error("Expected a generic search completion");
        expect(opened.item.args).toBe(toolArgs);
        expect(closed.item.args).toBe(opened.item.args);
        expect(closed.item.result).toBe(result);
      }
    });
  });

  it.each([false, true])("retains semantic find query in original arguments without inventing intent (device=%s)", (device) => {
    const h = harness();
    const args = { query: "Where is authentication initialized?", path: "src" };
    const toolName = device ? "write" : "find";
    const toolArgs = device ? { path: "xd://find", content: JSON.stringify(args) } : args;
    const result = device ? { ...textResult, details: { xdev: { tool: "find", mode: "execute", args, inner: textResult } } } : textResult;
    h.send({ type: "agent_start" });
    const start = h.send({ type: "tool_execution_start", toolName, toolCallId: "semantic", args: toolArgs });
    const end = h.send({ type: "tool_execution_end", toolName, toolCallId: "semantic", result });
    expect(start.deltas).toEqual([
      expect.objectContaining({ kind: "item.open", item: { type: "tool", tool: toolName, args: toolArgs } }),
    ]);
    expect(end.deltas).toEqual([
      expect.objectContaining({ kind: "item.close", item: { type: "tool", tool: toolName, args: toolArgs, result }, resultText: "complete tool output" }),
    ]);
    expect(start.deltas[0]).not.toHaveProperty("presentation");
    expect(end.deltas[0]).not.toHaveProperty("presentation");
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({
      type: "toolCall", tool: toolName, arguments: toolArgs, result, status: "completed",
    });
  });

  it.each([false, true])("retains outer dispatch diagnostics and nested failure without unwrapping (outerFailure=%s)", (outerFailure) => {
    const h = harness();
    const args = { pat: "$CALL($$$ARGS)", path: "src" };
    const outerArgs = { path: "xd://ast_grep", content: JSON.stringify(args) };
    const output = "Dispatcher diagnostic:\nSearch failed: permission denied\nFull trace: artifact://error";
    const inner = { content: [{ type: "text", text: "Search failed: permission denied" }], isError: true };
    const result = { content: [{ type: "text", text: output }], isError: outerFailure, details: { xdev: { tool: "ast_grep", mode: "execute", args, inner } } };
    h.send({ type: "agent_start" });
    h.send({ type: "tool_execution_start", toolName: "write", toolCallId: "dispatch-error", args: outerArgs });
    const end = h.send({ type: "tool_execution_end", toolName: "write", toolCallId: "dispatch-error", result, isError: false });
    expect(end.deltas).toEqual([expect.objectContaining({
      kind: "item.close", status: outerFailure ? "failed" : "completed", resultText: output,
      item: { type: "tool", tool: "write", args: outerArgs, result },
    })]);
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({
      type: "toolCall", tool: "write", arguments: outerArgs, result, status: outerFailure ? "failed" : "completed",
    });
  });

  it("does not bound or normalize large semantic-find output or coverage footers", () => {
    const h = harness();
    const args = { query: "Locate initialization", path: "src" };
    const output = `  Leading whitespace\n${"src/auth.ts:12-42  0.97  partial coverage\n".repeat(8_000)}\nlisted 139 · judged 128 · read 20 files\nOutput truncated; full result: artifact://find-output\n  `;
    const result = { content: [{ type: "text", text: output }] };
    h.send({ type: "agent_start" });
    h.send({ type: "tool_execution_start", toolName: "find", toolCallId: "large", args });
    const end = h.send({ type: "tool_execution_end", toolName: "find", toolCallId: "large", result });
    expect(end.deltas).toEqual([expect.objectContaining({
      kind: "item.close",
      item: { type: "tool", tool: "find", args, result },
      resultText: output,
    })]);
    expect(end.events.find((event) => event.type === "item/completed")?.item).toMatchObject({
      type: "toolCall", tool: "find", arguments: args, result,
    });
    const closed = end.deltas[0];
    if (closed?.kind !== "item.close" || closed.item?.type !== "tool") throw new Error("Expected a generic find completion");
    expect(closed.item.result).toBe(result);
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
        type: "toolCall", tool: toolName, arguments: toolArgs, result, status: "failed",
      });
    }
  });

  it("preserves terminal read metadata without inventing arguments or a missing search query", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const result = { ...textResult, details: { isDirectory: true, resolvedPath: "/workspace/src" } };
    for (const [toolName, toolCallId, output] of [["read", "directory", result], ["find", "unknown-query", textResult]] as const) {
      const end = h.send({ type: "tool_execution_end", toolName, toolCallId, result: output });
      expect(end.deltas).toEqual([expect.objectContaining({
        kind: "item.close", key: { providerItemId: toolCallId }, status: "completed", resultText: "complete tool output",
        item: { type: "tool", tool: toolName, args: undefined, result: output },
      })]);
      expect(end.events.filter((event) => event.type === "item/started")).toHaveLength(0);
      const completed = end.events.find((event) => event.type === "item/completed");
      expect(completed?.item).toMatchObject({
        type: "toolCall", tool: toolName, result: output, status: "completed",
      });
      expect(completed?.item).not.toHaveProperty("arguments");
    }
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
