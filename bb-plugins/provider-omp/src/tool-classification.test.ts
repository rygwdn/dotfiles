import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

const cwd = resolve("/workspace");
const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
const text = { type: "text", text: "contents" };

function expectGeneric(tool: string, args: unknown, options: Parameters<typeof classifyTypedOmpTool>[2] = {}) {
  const classified = classifyTypedOmpTool(tool, args, options);
  expect(classified).toEqual({ item: { type: "tool", tool, args } });
  if (classified?.item.type === "tool") expect(classified.item.args).toBe(args);
  return classified;
}

function dispatch(tool: string, args?: unknown, inner?: unknown) {
  return {
    details: {
      xdev: {
        tool,
        mode: "execute",
        ...(args === undefined ? {} : { args }),
        ...(inner === undefined ? {} : { inner }),
      },
    },
  };
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
    ])("adds hints without changing $tool items, arguments or failure semantics", ({ tool, args, title, preview, label }) => {
      for (const options of [
        {},
        { ended: true, result: { content: [text] } },
        { ended: true, failed: true, result: { isError: true, content: [text, image] } },
      ]) {
        const classified = classifyTypedOmpTool(tool, args, options);
        expect(classified?.item).toEqual({ type: "tool", tool, args });
        if (classified?.item.type === "tool") expect(classified.item.args).toBe(args);
        expect(classified?.presentation).toMatchObject({ title, label, detail: preview });
        expect(classified?.deferred).toBeUndefined();
        expect(classified?.result).toBeUndefined();
      }
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
      const classified = expectGeneric(tool, args, { ended: true, failed: true, result: { isError: true, content: [text] } })!;
      expect(ompToolPresentation(classified, tool, "Running Python")?.title).toBe("Running Python");
    });

    it.each(["functions.eval", "eval_extra", "tool_gateway_code_execute_extra", "tool_gateway_code_search_extra"])(
      "does not classify near-match identity %s",
      (tool) => {
        expect(classifyTypedOmpTool(tool, { language: "py", code: "print(1)", query: "buildkite" })).toBeNull();
      },
    );
  });

  describe("native search and reasoning tools", () => {
    it.each([
      { tool: "grep", args: { pattern: "TODO", path: "src" }, item: { type: "search", tool: "grep", mode: "content", query: "TODO", path: "src" } },
      { tool: "grep", args: { pattern: "class.*Controller" }, item: { type: "search", tool: "grep", mode: "content", query: "class.*Controller" } },
      { tool: "ast_grep", args: { pat: "$OBJ.$METHOD($$$ARGS)", path: "src/**/*.ts", lang: "typescript" }, item: { type: "search", tool: "ast_grep", mode: "content", query: "$OBJ.$METHOD($$$ARGS)", path: "src/**/*.ts" } },
      { tool: "ast_grep", args: { pat: "function $NAME() { $$$ }" }, item: { type: "search", tool: "ast_grep", mode: "content", query: "function $NAME() { $$$ }" } },
      { tool: "glob", args: { path: "src/**/*.test.ts" }, item: { type: "search", tool: "glob", mode: "path", query: "src/**/*.test.ts" } },
      { tool: "glob", args: {}, item: { type: "search", tool: "glob", mode: "path", query: "." } },
      { tool: "find", args: { query: "Locate the session cache", path: "src" }, item: { type: "search", tool: "find", mode: "content", query: "Locate the session cache", path: "src" } },
      { tool: "find", args: { query: "Who owns model selection?" }, item: { type: "search", tool: "find", mode: "content", query: "Who owns model selection?" } },
      { tool: "web_search", args: { query: "site:example.com native tools" }, item: { type: "webSearch", queries: ["site:example.com native tools"] } },
      { tool: "think", args: { thoughts: "Compare the two possible call paths." }, item: { type: "reasoning", summary: [], content: ["Compare the two possible call paths."] } },
    ])("classifies $tool with $args", ({ tool, args, item }) => {
      const classified = classifyTypedOmpTool(tool, args);
      expect(classified?.item).toEqual(item);
      expect(classified?.presentation?.icon).toBeDefined();
      expect(classified?.presentation?.label).toBeDefined();
    });

    describe.each([
      { tool: "grep", field: "pattern" },
      { tool: "ast_grep", field: "pat" },
      { tool: "find", field: "query" },
      { tool: "web_search", field: "query" },
      { tool: "think", field: "thoughts" },
      { tool: "read", field: "path" },
    ])("$tool argument validation", ({ tool, field }) => {
      it.each([
        { name: "missing arguments", args: undefined },
        { name: "null arguments", args: null },
        { name: "array arguments", args: [{ [field]: "valid" }] },
        { name: "missing required field", args: { untouched: { nested: true } } },
        ...[null, 12, false, [], ["valid"], "", " \n\t"].map((value) => ({
          name: `invalid ${field}: ${JSON.stringify(value)}`,
          args: { [field]: value, untouched: { nested: true } },
        })),
      ])("preserves original generic args for $name", ({ args }) => {
        expectGeneric(tool, args, { ended: true, result: { content: [text] }, cwd });
      });
    });

    describe.each([
      { tool: "grep", required: { pattern: "needle" } },
      { tool: "ast_grep", required: { pat: "$VALUE" } },
      { tool: "find", required: { query: "session setup" } },
      { tool: "glob", required: {} },
    ])("$tool path validation", ({ tool, required }) => {
      it.each([null, 42, false, [], ["src"], { root: "src" }, "", " \t"])(
        "preserves generic args for optional path %j",
        (path) => {
          expectGeneric(tool, { ...required, path, untouched: true });
        },
      );
      it("rejects an argument array rather than treating it as default path", () => {
        expectGeneric(tool, []);
      });
    });
  });

  describe("read metadata", () => {
    it("defers a valid read until result metadata arrives", () => {
      const args = { path: "src/module.ts:10-20" };
      expect(classifyTypedOmpTool("read", args, { cwd })).toEqual({
        item: { type: "tool", tool: "read", args },
        deferred: true,
      });
    });

    it.each([
      { name: "resolved absolute path", path: "src/module.ts:10-20", details: { resolvedPath: join(cwd, "src/module.ts") }, expected: join(cwd, "src/module.ts"), selection: { selector: ":10-20", startLine: 10, endLine: 20 } },
      { name: "cwd-relative metadata", path: "@src/module.ts:10+5", details: { resolvedPath: "src/module.ts" }, expected: join(cwd, "src/module.ts"), selection: { selector: ":10+5" } },
      { name: "path source metadata", path: "local://notes.md:2-4", details: { meta: { source: { type: "path", value: join(cwd, "notes.md") } } }, expected: join(cwd, "notes.md"), selection: { selector: ":2-4", startLine: 2, endLine: 4 } },
      { name: "home-relative metadata", path: "~/notes.md:-5", details: { resolvedPath: "~/notes.md" }, expected: join(homedir(), "notes.md"), selection: { selector: ":-5" } },
      { name: "directory metadata", path: "src", details: { isDirectory: true, resolvedPath: join(cwd, "src") }, expected: join(cwd, "src"), directory: true },
      { name: "selected directory metadata", path: "src:600-700", details: { isDirectory: true, resolvedPath: join(cwd, "src") }, expected: join(cwd, "src"), directory: true },
    ])("uses $name and preserves the invocation in detail", ({ path, details, expected, directory, selection }) => {
      const classified = classifyTypedOmpTool("read", { path }, { ended: true, result: { details, content: [text] }, cwd });
      expect(classified?.item).toEqual(directory
        ? { type: "search", tool: "read", mode: "list", path: expected, query: path }
        : { type: "fileRead", path: expected, ...selection });
      expect(classified?.presentation?.detail).toBe(path);
      if (directory) {
        expect(classified?.presentation).toMatchObject({
          icon: { glyph: "FolderOpen" },
          label: { pending: "Listing directory", completed: "Listed directory" },
        });
      }
    });

    it.each([
      { suffix: ":600-700", selection: { selector: ":600-700", startLine: 600, endLine: 700 } },
      { suffix: ":raw:600-700", selection: { selector: ":raw:600-700", startLine: 600, endLine: 700 } },
      { suffix: ":600-700:raw", selection: { selector: ":600-700:raw", startLine: 600, endLine: 700 } },
      { suffix: ":600-600", selection: { selector: ":600-600", startLine: 600, endLine: 600 } },
      { suffix: ":raw", selection: { selector: ":raw" } },
      { suffix: ":conflicts", selection: { selector: ":conflicts" } },
      { suffix: ":600", selection: { selector: ":600" } },
      { suffix: ":600-", selection: { selector: ":600-" } },
      { suffix: ":600+101", selection: { selector: ":600+101" } },
      { suffix: ":-60", selection: { selector: ":-60" } },
      { suffix: ":600-700,900-950", selection: { selector: ":600-700,900-950" } },
      { suffix: ":raw:600-700,900-950", selection: { selector: ":raw:600-700,900-950" } },
      { suffix: ":700-600", selection: { selector: ":700-600" } },
      { suffix: ":0-10", selection: { selector: ":0-10" } },
      { suffix: ":9007199254740992-9007199254740993", selection: { selector: ":9007199254740992-9007199254740993" } },
      { suffix: ":not-a-selector", selection: {} },
      { suffix: "", selection: {} },
    ])("preserves explicit $suffix without inventing bounds", ({ suffix, selection }) => {
      const path = join(cwd, "src/module.ts");
      const classified = classifyTypedOmpTool("read", { path: `@src/module.ts${suffix}` }, {
        ended: true,
        result: { details: { resolvedPath: path }, content: [{ type: "text", text: "99: a misleading presentation line" }] },
        cwd,
      });
      expect(classified?.item).toEqual({ type: "fileRead", path, ...selection });
    });

    it("does not turn recovered metadata or response presentation into a requested selector", () => {
      const path = join(cwd, "module:600-700");
      const result = { details: { resolvedPath: path }, content: [{ type: "text", text: "[module:raw:600-700]\n600: contents" }] };
      expect(classifyTypedOmpTool("read", undefined, { ended: true, result, cwd })?.item).toEqual({ type: "fileRead", path });
    });

    it.each([
      { name: "internal resource without backing path", path: "skill://brain:1-20", result: { content: [text] } },
      { name: "relative invocation without metadata", path: "src/module.ts:10-20", result: { content: [text] } },
      { name: "local invocation without metadata", path: join(cwd, "module.ts"), result: { content: [text] } },
      { name: "directory without resolved path", path: "src", result: { details: { isDirectory: true }, content: [text] } },
      { name: "nonlocal resolved path", path: "skill://brain", result: { details: { resolvedPath: "skill://brain" }, content: [text] } },
      { name: "mixed local targets", path: "src/a.ts;src/b.ts", result: { details: { resolvedPath: join(cwd, "src/a.ts"), displayReadTargets: ["src/a.ts", "src/b.ts"] }, content: [text] } },
      { name: "multipath without target metadata", path: "src/a.ts:2-4;src/b.ts:6-8", result: { details: { resolvedPath: join(cwd, "src/a.ts") }, content: [text] } },
      { name: "newline targets without target metadata", path: "src/a.ts:2-4\nsrc/b.ts:6-8", result: { details: { resolvedPath: join(cwd, "src/a.ts") }, content: [text] } },
      { name: "mixed local and web targets", path: "src/a.ts;https://example.com", result: { details: { url: "https://example.com", displayReadTargets: ["src/a.ts", "https://example.com"] }, content: [image] } },
      { name: "URL-first mixed targets without target metadata", path: "https://example.com/read;src/a.ts", result: { details: { kind: "url", url: "https://example.com/read" }, content: [text] } },
      { name: "ambiguous URL semicolon without target metadata", path: "https://example.com/docs;section:600-700", result: { details: { kind: "url", url: "https://example.com/docs;section" }, content: [text] } },
      { name: "malformed metadata", path: "src/a.ts", result: { details: null, content: [text] } },
      { name: "malformed content envelope", path: "src/a.ts", result: { details: { resolvedPath: join(cwd, "src/a.ts") }, content: "contents" } },
      { name: "missing result", path: "src/a.ts", result: undefined },
    ])("keeps $name generic", ({ path, result }) => {
      expectGeneric("read", { path }, { ended: true, result, cwd });
    });

    it.each([
      { name: "local metadata", result: { details: { resolvedPath: join(cwd, "module.ts") }, content: [text] }, expected: { type: "fileRead", path: join(cwd, "module.ts") } },
      { name: "URL metadata", result: { details: { kind: "url", url: "https://example.com/docs" }, content: [text] }, expected: { type: "webFetch", url: "https://example.com/docs", pattern: null } },
    ])("recovers a read without start arguments from $name", ({ result, expected }) => {
      expect(classifyTypedOmpTool("read", undefined, { ended: true, result, cwd })?.item).toEqual(expected);
    });
  });

  describe("web reads", () => {
    it.each([
      { name: "URL metadata strips read selectors", path: "https://example.com/docs:10-20", details: { kind: "url", url: "https://example.com/docs" }, url: "https://example.com/docs" },
      { name: "redirect metadata retains both URLs", path: "https://example.com/docs:-10", details: { kind: "url", url: "https://example.com/docs", finalUrl: "https://docs.example.com/guide" }, url: "https://example.com/docs", detail: "https://example.com/docs:-10 → https://docs.example.com/guide" },
      { name: "finalUrl-only metadata", path: "https://example.com/docs:4-8", details: { kind: "url", finalUrl: "https://docs.example.com/guide" }, url: "https://docs.example.com/guide" },
      { name: "explicit port is not a read selector", path: "http://localhost:4173/guide:2-7", details: { kind: "url", url: "http://localhost:4173/guide" }, url: "http://localhost:4173/guide" },
      { name: "unchanged final URL has no redirect arrow", path: "https://example.com/docs:raw", details: { kind: "url", url: "https://example.com/docs", finalUrl: "https://example.com/docs" }, url: "https://example.com/docs" },
      { name: "www invocation", path: "www.example.com/docs", details: {}, url: "https://www.example.com/docs" },
      { name: "collapsed HTTPS scheme", path: "https:/example.com/docs", details: {}, url: "https://example.com/docs" },
      { name: "collapsed HTTP scheme with port", path: "http:/localhost:4173/guide", details: {}, url: "http://localhost:4173/guide" },
      { name: "www metadata with selectors", path: "www.example.com/docs:1-4", details: { kind: "url", url: "www.example.com/docs" }, url: "https://www.example.com/docs" },
      { name: "collapsed scheme metadata with selectors", path: "https:/example.com/docs:1-4", details: { kind: "url", url: "https:/example.com/docs" }, url: "https://example.com/docs" },
    ])("classifies $name", ({ path, details, url, detail }) => {
      const classified = classifyTypedOmpTool("read", { path }, { ended: true, result: { details, content: [text] }, cwd });
      expect(classified?.item).toEqual({ type: "webFetch", url, pattern: null });
      expect(classified?.presentation?.detail).toBe(detail ?? path);
    });

    it.each(["file:///workspace/a.png", "ftp://example.com/a.png", "https://", "www."])(
      "does not promote invalid or non-HTTP resource %s",
      (path) => {
        expectGeneric("read", { path }, { ended: true, result: { content: [text] }, cwd });
      },
    );
  });

  describe("image bytes", () => {
    it.each([
      { name: "extensionless file", path: join(cwd, "asset"), result: { content: [image] }, expected: join(cwd, "asset") },
      { name: "SVG rasterization selector", path: "icons/logo.svg:img", result: { details: { resolvedPath: join(cwd, "icons/logo.svg") }, content: [image] }, expected: join(cwd, "icons/logo.svg") },
      { name: "metadata-backed internal image", path: "artifact://rendered:img", result: { details: { resolvedPath: join(cwd, "rendered") }, content: [text, image] }, expected: join(cwd, "rendered") },
      { name: "media path metadata", path: "artifact://rendered", result: { details: { mediaPath: join(cwd, "rendered.png") }, content: [image] }, expected: join(cwd, "rendered.png") },
      { name: "relative path", path: "shots/../asset", result: { content: [image] }, expected: join(cwd, "asset") },
      { name: "at-prefixed path", path: "@shots/asset", result: { content: [image] }, expected: join(cwd, "shots/asset") },
    ])("opens $name from image content", ({ path, result, expected }) => {
      expect(classifyTypedOmpTool("read", { path }, { ended: true, result, cwd })?.item).toEqual({ type: "imageView", path: expected });
    });

    it.each([
      { name: "text response at PNG path", content: [text] },
      { name: "empty image data", content: [{ ...image, data: "" }] },
      { name: "blank image data", content: [{ ...image, data: " \n" }] },
      { name: "numeric image data", content: [{ ...image, data: 12 }] },
      { name: "missing image data", content: [{ type: "image", mimeType: "image/png" }] },
      { name: "non-image MIME", content: [{ ...image, mimeType: "text/plain" }] },
      { name: "malformed MIME", content: [{ ...image, mimeType: "image/png extra" }] },
      { name: "missing image MIME", content: [{ type: "image", data: image.data }] },
      { name: "null content block", content: [null] },
      { name: "empty content", content: [] },
      { name: "result error", content: [image], isError: true },
      { name: "execution failure", content: [image], failed: true },
    ])("does not imageView $name even with a resolved image path", ({ content, isError, failed }) => {
      const path = join(cwd, "asset.png");
      expect(classifyTypedOmpTool("read", { path }, {
        ended: true,
        failed,
        result: { details: { resolvedPath: path }, content, ...(isError === undefined ? {} : { isError }) },
        cwd,
      })?.item).toEqual({ type: "fileRead", path });
    });

    it.each([
      { name: "selector without backing metadata", path: "asset.svg:img", result: { content: [image] }, options: { cwd } },
      { name: "mixed invocation without backing metadata", path: "asset.png;other.png", result: { content: [image] }, options: { cwd } },
      { name: "relative image without cwd", path: "asset.png", result: { content: [image] }, options: {} },
      { name: "internal image without local backing", path: "artifact://rendered", result: { content: [image] }, options: { cwd } },
      { name: "malformed content collection", path: join(cwd, "asset.png"), result: { content: image }, options: { cwd } },
    ])("keeps $name generic", ({ path, result, options }) => {
      expectGeneric("read", { path }, { ...options, ended: true, result });
    });

    it("keeps URL images as webFetch even when a local media cache exists", () => {
      const url = "https://example.com/image.png";
      expect(classifyTypedOmpTool("read", { path: `${url}:img` }, {
        ended: true,
        cwd,
        result: { details: { kind: "url", url, mediaPath: join(cwd, "cached.png") }, content: [image] },
      })?.item).toEqual({ type: "webFetch", url, pattern: null });
    });
  });

  describe("device write guard", () => {
    it.each([
      { tool: "grep", args: { pattern: "needle", path: "src" }, expected: { type: "search", tool: "grep", mode: "content", query: "needle", path: "src" } },
      { tool: "ast_grep", args: { pat: "$CALL($$$ARGS)" }, expected: { type: "search", tool: "ast_grep", mode: "content", query: "$CALL($$$ARGS)" } },
      { tool: "glob", args: {}, expected: { type: "search", tool: "glob", mode: "path", query: "." } },
      { tool: "find", args: { query: "Find cache initialization" }, expected: { type: "search", tool: "find", mode: "content", query: "Find cache initialization" } },
      { tool: "web_search", args: { query: "native OMP tools" }, expected: { type: "webSearch", queries: ["native OMP tools"] } },
      { tool: "think", args: { thoughts: "Choose the narrowest search." }, expected: { type: "reasoning", summary: [], content: ["Choose the narrowest search."] } },
      { tool: "read", args: { path: "src/a.ts:2-5" }, inner: { details: { resolvedPath: join(cwd, "src/a.ts") }, content: [text] }, expected: { type: "fileRead", path: join(cwd, "src/a.ts"), selector: ":2-5", startLine: 2, endLine: 5 } },
      { tool: "read", args: { path: "src:20-30" }, inner: { details: { resolvedPath: join(cwd, "src"), isDirectory: true }, content: [text] }, expected: { type: "search", tool: "read", mode: "list", path: join(cwd, "src"), query: "src:20-30" } },
    ])("unwraps validated $tool execution", ({ tool, args, inner, expected }) => {
      for (const metadataArgs of [args, undefined]) {
        const outer = { path: `xd://${tool}`, content: JSON.stringify(args), i: "Running inner tool" };
        expect(classifyTypedOmpTool("write", outer, {
          ended: true, result: dispatch(tool, metadataArgs, inner), cwd,
        })?.item).toEqual(expected);
      }
    });

    it("defers a device write without presenting it as a file change", () => {
      const args = { path: "xd://grep", content: '{"pattern":"needle"}' };
      expect(classifyTypedOmpTool("write", args)).toEqual({ item: { type: "tool", tool: "write", args }, deferred: true });
    });

    it.each(["XD://grep", "  xd://grep  "])("recognizes canonical device path %j", (path) => {
      const args = { path, content: '{"pattern":"needle"}' };
      expect(classifyTypedOmpTool("write", args, {
        ended: true, result: dispatch("grep", { pattern: "needle" }), cwd,
      })?.item).toEqual({ type: "search", tool: "grep", mode: "content", query: "needle" });
    });

    it.each([
      { name: "help result", args: { path: "xd://grep", content: null }, result: { details: { xdev: { tool: "grep", mode: "help", args: { pattern: "needle" } } } } },
      { name: "missing dispatch metadata", args: { path: "xd://grep", content: '{"pattern":"needle"}' }, result: { content: [text] } },
      { name: "mismatched dispatch tool", args: { path: "xd://grep", content: '{"pattern":"needle"}' }, result: dispatch("find", { query: "needle" }) },
      { name: "unknown device", args: { path: "xd://unknown", content: '{"pattern":"needle"}' }, result: dispatch("unknown", { pattern: "needle" }) },
      { name: "LSP device", args: { path: "xd://lsp", content: '{"action":"diagnostics","file":"src/a.ts"}' }, result: dispatch("lsp", { action: "diagnostics", file: "src/a.ts" }) },
      { name: "malformed device URL", args: { path: "xd://grep/extra", content: '{"pattern":"needle"}' }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "device root without a name", args: { path: "xd://", content: '{"pattern":"needle"}' }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "trailing device slash", args: { path: "xd://grep/", content: '{"pattern":"needle"}' }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "device query suffix", args: { path: "xd://grep?pattern=needle", content: '{"pattern":"needle"}' }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "device fragment suffix", args: { path: "xd://grep#help", content: '{"pattern":"needle"}' }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "malformed JSON", args: { path: "xd://grep", content: "{broken" }, result: dispatch("grep") },
      { name: "malformed JSON despite metadata args", args: { path: "xd://grep", content: "{broken" }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "JSON array despite metadata args", args: { path: "xd://grep", content: "[]" }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "JSON null despite metadata args", args: { path: "xd://grep", content: "null" }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "JSON scalar despite metadata args", args: { path: "xd://grep", content: '"needle"' }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "wrong outer content type", args: { path: "xd://grep", content: 42 }, result: dispatch("grep", { pattern: "needle" }) },
      { name: "malformed inner args", args: { path: "xd://grep", content: '{"pattern":42}' }, result: dispatch("grep", { pattern: 42 }) },
      { name: "array metadata args", args: { path: "xd://grep", content: '{"pattern":"needle"}' }, result: dispatch("grep", [{ pattern: "needle" }]) },
      { name: "wrong optional inner path type", args: { path: "xd://grep", content: '{"pattern":"needle","path":["src"]}' }, result: dispatch("grep", { pattern: "needle", path: ["src"] }) },
      { name: "malformed dispatch mode", args: { path: "xd://grep", content: '{"pattern":"needle"}' }, result: { details: { xdev: { tool: "grep", mode: "executing", args: { pattern: "needle" } } } } },
    ])("keeps $name generic and never fileChange", ({ args, result }) => {
      const classified = expectGeneric("write", args, { ended: true, result, cwd });
      expect(classified?.item.type).not.toBe("fileChange");
    });

    it.each(["bash", "edit", "lsp", "unknown"])("leaves legacy or unknown tool %s to the translator", (tool) => {
      expect(classifyTypedOmpTool(tool, { path: "src/a.ts" })).toBeNull();
    });

    it("does not intercept an ordinary file write", () => {
      expect(classifyTypedOmpTool("write", { path: "src/a.ts", content: "source" })).toBeNull();
    });
  });
});

describe("ompToolPresentation", () => {
  it.each([
    { tool: "grep", args: { pattern: "needle" } },
    { tool: "find", args: { query: "Locate handlers" } },
    { tool: "glob", args: { path: "src/**/*.ts" } },
    { tool: "web_search", args: { query: "native tools" } },
    { tool: "think", args: { thoughts: "Compare the paths." } },
    { tool: "read", args: { path: "src/a.ts:2-4" }, options: { ended: true, cwd, result: { details: { resolvedPath: join(cwd, "src/a.ts") }, content: [text] } } },
    { tool: "read", args: { path: "src" }, options: { ended: true, cwd, result: { details: { resolvedPath: join(cwd, "src"), isDirectory: true }, content: [text] } } },
    { tool: "read", args: { path: "https://example.com/docs:1-5" }, options: { ended: true, result: { details: { kind: "url", url: "https://example.com/docs" }, content: [text] } } },
  ])("retains $tool semantic icon and labels when intent replaces its title", ({ tool, args, options }) => {
    const classified = classifyTypedOmpTool(tool, args, options)!;
    const before = { ...classified.presentation };
    const intent = "Inspecting the relevant definitions";
    const presentation = ompToolPresentation(classified, tool, intent);
    expect(presentation).toMatchObject({
      icon: classified.presentation?.icon,
      label: classified.presentation?.label,
      title: intent,
    });
    expect(presentation?.detail).toBe(
      before.detail || before.title ? presentationDetail(before.detail ?? before.title ?? "") : undefined,
    );
    expect(classified.presentation).toEqual(before);
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
    const base = classified.presentation!;
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
