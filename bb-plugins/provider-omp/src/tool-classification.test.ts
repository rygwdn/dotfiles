import { describe, expect, it } from "vitest";
import {
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  experimental_toolPresentation as toolPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  classifyTypedOmpTool,
  ompToolPresentation,
  type ClassifiedOmpTool,
} from "./tool-classification.js";

function expectGeneric(tool: string, args: unknown) {
  const classified = classifyTypedOmpTool(tool, args);
  expect(classified).toEqual({ item: { type: "tool", tool, args } });
  if (classified?.item.type === "tool") expect(classified.item.args).toBe(args);
  return classified;
}


describe("classifyTypedOmpTool", () => {
  describe("eval and Tool Gateway presentation", () => {
    it.each([
      {
        tool: "eval",
        args: { language: "py", code: "print(total)\nprint(count)", title: "Summarizing checkout totals", untouched: { nested: true } },
        title: "Summarizing checkout totals",
        preview: "print(total) print(count)",
        label: { pending: "Running Python", completed: "Ran Python" },
      },
      {
        tool: "eval",
        args: { language: "js", code: "const result = await browser.snapshot();\nprint(result);", i: "Inspecting checkout controls" },
        title: "Inspecting checkout controls",
        preview: "const result = await browser.snapshot(); print(result);",
        label: { pending: "Running JavaScript", completed: "Ran JavaScript" },
      },
      {
        tool: "tool_gateway_code_search",
        args: { query: "buildkite\nfailed job logs", i: "Finding build log signatures" },
        title: "Finding build log signatures",
        preview: "buildkite failed job logs",
        label: { pending: "Discovering Tool Gateway signatures", completed: "Discovered Tool Gateway signatures" },
      },
      {
        tool: "tool_gateway_code_execute",
        args: { code: "const jobs = await buildkite.jobs();\nreturn jobs;", title: "Reading failed build jobs" },
        title: "Reading failed build jobs",
        preview: "const jobs = await buildkite.jobs(); return jobs;",
        label: { pending: "Running Tool Gateway program", completed: "Ran Tool Gateway program" },
      },
    ])("adds hints without changing $tool items or arguments", ({ tool, args, title, preview, label }) => {
      const classified = classifyTypedOmpTool(tool, args);
      expect(classified?.item).toEqual({ type: "tool", tool, args });
      if (classified?.item.type === "tool") expect(classified.item.args).toBe(args);
      expect(classified?.presentation).toMatchObject({ title, label, detail: preview });
    });

    it.each([
      { i: "Comparing model labels", title: "Inspecting the model catalog", expected: "Comparing model labels" },
      { i: "Running Python", title: "Inspecting the model catalog", expected: "Inspecting the model catalog" },
      { i: null, title: "Inspecting the model catalog", expected: "Inspecting the model catalog" },
      { i: "", title: "Ran eval", expected: "print(models)" },
      { i: undefined, title: undefined, expected: "print(models)" },
    ])("chooses useful argument intent before title or source: $expected", ({ i, title, expected }) => {
      const classified = classifyTypedOmpTool("eval", { language: "py", code: "print(models)", i, title });
      expect(classified?.presentation?.title).toBe(expected);
    });

    it.each([
      { tool: "eval", args: { language: "py", code: "print(models)" }, intent: "Running Python" },
      { tool: "eval", args: { language: "js", code: "print(models);" }, intent: "Ran eval" },
      { tool: "tool_gateway_code_search", args: { query: "buildkite failed job logs" }, intent: "Discovering Tool Gateway signatures" },
      { tool: "tool_gateway_code_execute", args: { code: "return jobs;" }, intent: "Running Tool Gateway program" },
    ])("ignores vacuous top-level $tool intent without losing semantic labels", ({ tool, args, intent }) => {
      const classified = classifyTypedOmpTool(tool, args)!;
      expect(ompToolPresentation(classified, tool, intent)).toBe(classified.presentation);
      const explicit = ompToolPresentation(classified, tool, "Inspecting failed build jobs");
      expect(explicit).toMatchObject({
        title: "Inspecting failed build jobs",
        detail: classified.presentation?.detail,
        label: classified.presentation?.label,
        icon: classified.presentation?.icon,
      });
    });

    it("prefers useful native intent over useful argument intent", () => {
      const classified = classifyTypedOmpTool("eval", {
        language: "py", code: "print(models)", i: "Comparing models", title: "Inspecting catalog",
      })!;
      expect(ompToolPresentation(classified, "eval", "Reading supported model labels")).toMatchObject({
        title: "Reading supported model labels", detail: "print(models)",
      });
    });

    it("bounds single-line source previews without rewriting source arguments", () => {
      const code = `  const rows = [\n\t${"row, ".repeat(100)}\n];  `;
      const args = { code };
      const classified = classifyTypedOmpTool("tool_gateway_code_execute", args)!;
      const expected = `${code.trim().replace(/\s+/g, " ").slice(0, 159)}…`;
      expect(classified.presentation?.title).toBe(expected);
      expect(classified.presentation?.detail).toBe(expected);
      expect(classified.presentation?.title).toHaveLength(160);
      expect(classified.item).toEqual({ type: "tool", tool: "tool_gateway_code_execute", args });
      expect(args.code).toBe(code);
    });

    it.each([
      { tool: "eval", args: undefined },
      { tool: "eval", args: null },
      { tool: "eval", args: [{ language: "py", code: "print(1)" }] },
      { tool: "eval", args: { code: "print(1)" } },
      { tool: "eval", args: { language: "python", code: "print(1)" } },
      { tool: "eval", args: { language: "js", code: 42 } },
      { tool: "eval", args: { language: "py", code: " \n\t" } },
      { tool: "eval", args: { language: "py", code: "print(1)", title: 42 } },
      { tool: "tool_gateway_code_execute", args: { code: [] } },
      { tool: "tool_gateway_code_execute", args: { code: " " } },
      { tool: "tool_gateway_code_execute", args: { code: "return 1;", i: false } },
      { tool: "tool_gateway_code_search", args: { code: "return 1;" } },
      { tool: "tool_gateway_code_search", args: { query: ["buildkite"] } },
      { tool: "tool_gateway_code_search", args: { query: "" } },
    ])("retains the generic fallback for malformed $tool args $args", ({ tool, args }) => {
      const classified = expectGeneric(tool, args)!;
      expect(ompToolPresentation(classified, tool, "Running Python")?.title).toBe("Running Python");
    });

    it.each(["functions.eval", "eval_extra", "tool_gateway_code_execute_extra", "tool_gateway_code_search_extra"])(
      "does not classify near-match identity %s",
      (tool) => {
        expect(classifyTypedOmpTool(tool, { language: "py", code: "print(1)", query: "buildkite" })).toBeNull();
      },
    );
  });

  describe("display-heavy generic tools", () => {
    it.each([
      { tool: "read", args: { path: "src/module.ts:10-20" } },
      { tool: "read", args: { path: "src" } },
      { tool: "read", args: { path: "https://example.com/docs:2-4" } },
      { tool: "grep", args: { pattern: "TODO", path: "src" } },
      { tool: "ast_grep", args: { pat: "$OBJ.$METHOD($$$ARGS)", path: "src/**/*.ts" } },
      { tool: "glob", args: { path: "src/**/*.test.ts" } },
      { tool: "glob", args: {} },
      { tool: "find", args: { query: "Locate the session cache", path: "src" } },
      { tool: "web_search", args: { query: "site:example.com native tools" } },
      { tool: "write", args: { path: "src/a.ts", content: "source" } },
      { tool: "edit", args: { path: "src/a.ts", oldText: "before", newText: "after" } },
      { tool: "edit", args: { path: "src/a.ts", edits: [{ oldText: "before", newText: "after" }] } },
      { tool: "edit", args: "*** Begin Patch\n*** End Patch" },
    ])("keeps $tool generic without rewriting arguments", ({ tool, args }) => {
      expectGeneric(tool, args);
    });

    describe.each(["read", "grep", "glob", "find", "ast_grep", "web_search", "write", "edit"])(
      "%s malformed and terminal-only calls",
      (tool) => {
        it.each([undefined, null, [], 42, "unrecognized", { untouched: { nested: true } }])(
          "preserves original arguments %j without native fallback",
          (args) => {
            expectGeneric(tool, args);
          },
        );
      },
    );


    it.each(["read", "grep", "glob", "find", "ast_grep", "web_search", "think", "unknown"])(
      "keeps device write to %s generic",
      (tool) => {
        const args = { path: `xd://${tool}`, content: JSON.stringify({ thoughts: "Compare paths", pattern: "needle" }) };
        expectGeneric("write", args);
      },
    );
  });

  describe("unselected tools", () => {
    it("keeps think as native reasoning", () => {
      const classified = classifyTypedOmpTool("think", { thoughts: "Compare the two possible call paths." });
      expect(classified?.item).toEqual({
        type: "reasoning", summary: [], content: ["Compare the two possible call paths."],
      });
      expect(classified?.presentation?.icon).toBeDefined();
      expect(classified?.presentation?.label).toBeDefined();
    });

    it.each([undefined, null, [], {}, { thoughts: 42 }, { thoughts: "" }, { thoughts: " \n\t" }])(
      "keeps malformed think arguments %j generic",
      (args) => {
        expectGeneric("think", args);
      },
    );

    it.each(["bash", "wait", "task", "lsp", "unknown"])(
      "leaves lifecycle or unknown tool %s to the translator",
      (tool) => {
        expect(classifyTypedOmpTool(tool, { untouched: true })).toBeNull();
      },
    );
  });
});

describe("ompToolPresentation", () => {
  it.each([
    { tool: "grep", args: { pattern: "needle" } },
    { tool: "find", args: { query: "Locate handlers" } },
    { tool: "glob", args: { path: "src/**/*.ts" } },
    { tool: "web_search", args: { query: "native tools" } },
    { tool: "think", args: { thoughts: "Compare the paths." } },
    { tool: "read", args: { path: "src/a.ts:2-4" } },
    { tool: "read", args: { path: "src" } },
    { tool: "read", args: { path: "https://example.com/docs:1-5" } },
  ])("retains $tool header semantics when intent replaces its title", ({ tool, args }) => {
    const classified = classifyTypedOmpTool(tool, args)!;
    const before = { ...(classified.presentation ?? toolPresentation(tool)) };
    const intent = "Inspecting the relevant definitions";
    const presentation = ompToolPresentation(classified, tool, intent);
    expect(presentation).toMatchObject({
      icon: before.icon,
      label: before.label,
      title: intent,
    });
    expect(presentation?.detail).toBe(
      before.detail || before.title ? presentationDetail(before.detail ?? before.title ?? "") : undefined,
    );
    expect(classified.presentation).toEqual(tool === "think" ? before : undefined);
    expect(ompToolPresentation(classified, tool)).toBe(classified.presentation);
    expect(ompToolPresentation(classified, tool, "")).toBe(classified.presentation);
  });

  it.each(["Running Python", "Ran eval", "Discovering Tool Gateway signatures"])(
    "preserves existing intent precedence outside program tools for %s",
    (intent) => {
      const classified = classifyTypedOmpTool("grep", { pattern: "needle" })!;
      expect(ompToolPresentation(classified, "grep", intent)?.title).toBe(intent);
    },
  );

  it("uses generic tool semantics when only an intent is available", () => {
    const classified: ClassifiedOmpTool = { item: { type: "tool", tool: "custom_tool", args: { untouched: true } } };
    const fallback = toolPresentation("custom_tool");
    const presentation = ompToolPresentation(classified, "custom_tool", "Inspecting custom state");
    expect(presentation).toMatchObject({ icon: fallback.icon, label: fallback.label, title: "Inspecting custom state" });
    expect(presentation?.detail).toBe(
      fallback.detail || fallback.title ? presentationDetail(fallback.detail ?? fallback.title ?? "") : undefined,
    );
    expect(ompToolPresentation(classified, "custom_tool")).toBeUndefined();
  });

  it("bounds intent titles and original details through the SDK helpers", () => {
    const intent = "Inspecting definitions ".repeat(1_000);
    const detail = "src/very-long-component.ts:10-20 ".repeat(1_000);
    const classified = classifyTypedOmpTool("grep", { pattern: "needle" })!;
    const base = toolPresentation("grep");
    classified.presentation = { ...base, detail };
    const presentation = ompToolPresentation(classified, "grep", intent);
    expect(presentation?.title).toBe(presentationTitle(intent));
    expect(presentation?.detail).toBe(presentationDetail(detail));
    expect(presentation?.title).toBeTruthy();
    expect(presentation?.title?.length).toBeLessThan(intent.length);
    expect(presentation?.detail?.length).toBeLessThan(detail.length);
    expect(presentation?.icon).toEqual(base.icon);
    expect(presentation?.label).toEqual(base.label);
  });
});
