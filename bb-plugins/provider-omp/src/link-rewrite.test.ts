import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteOmpFileLinks, type OmpFileLinkRoots } from "./link-rewrite.js";

let directory: string;
let localDir: string;
let artifactsDir: string;
let roots: OmpFileLinkRoots;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bb-omp-links-"));
  localDir = join(directory, "local");
  artifactsDir = join(directory, "artifacts");
  mkdirSync(localDir);
  mkdirSync(artifactsDir);
  writeFileSync(join(localDir, "plan.md"), "# Plan");
  writeFileSync(join(artifactsDir, "0.json"), "{}");
  writeFileSync(join(artifactsDir, "Worker.md"), "# Result");
  roots = { localDir, artifactsDir };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe("rewriteOmpFileLinks", () => {
  it("keeps native URLs as visible labels and points to existing files", () => {
    expect(rewriteOmpFileLinks("See local://plan.md, artifact://0 and agent://Worker.", roots)).toBe(
      `See [local://plan.md](${localDir}/plan.md), [artifact://0](${artifactsDir}/0.json) and [agent://Worker](${artifactsDir}/Worker.md).`,
    );
  });

  it("leaves missing files, directories, and roots alone", () => {
    const text = "local://missing.md artifact://99 agent://Missing";
    expect(rewriteOmpFileLinks(text, roots)).toBe(text);
    expect(rewriteOmpFileLinks("local://plan.md", { localDir: join(directory, "absent") })).toBe("local://plan.md");
    mkdirSync(join(localDir, "folder"));
    expect(rewriteOmpFileLinks("local://folder", roots)).toBe("local://folder");
    expect(rewriteOmpFileLinks("artifact://0", { localDir })).toBe("artifact://0");
  });

  it("resolves dot-qualified and nested agent outputs, ignoring JSON extraction paths", () => {
    mkdirSync(join(artifactsDir, "child", "grandchild"), { recursive: true });
    writeFileSync(join(artifactsDir, "child", "grandchild", "Parent.Child.md"), "result");
    expect(rewriteOmpFileLinks("agent://Parent.Child/reports/0/data", roots)).toBe(
      `[agent://Parent.Child/reports/0/data](${artifactsDir}/child/grandchild/Parent.Child.md)`,
    );
    expect(rewriteOmpFileLinks("agent://Worker/key", roots)).toBe(
      `[agent://Worker/key](${artifactsDir}/Worker.md)`,
    );
  });

  it("prefers shallow agent outputs and bounds recursive directory scans", () => {
    mkdirSync(join(artifactsDir, "a", "b", "c", "d", "e"), { recursive: true });
    writeFileSync(join(artifactsDir, "a", "Worker.md"), "other");
    writeFileSync(join(artifactsDir, "a", "b", "c", "d", "e", "Deep.md"), "deep");
    expect(rewriteOmpFileLinks("agent://Worker agent://Deep", roots)).toBe(
      `[agent://Worker](${artifactsDir}/Worker.md) agent://Deep`,
    );
  });

  it.each([
    "```md\nlocal://plan.md\n```\n",
    "~~~~\nartifact://0\n~~~\nagent://Worker\n~~~~\n",
    "> ```\n> local://plan.md\n> ```\n",
    "```\nlocal://plan.md",
  ])("does not rewrite fenced code: %j", (fence) => {
    expect(rewriteOmpFileLinks(`local://plan.md\n${fence}`, roots)).toBe(
      `[local://plan.md](${localDir}/plan.md)\n${fence}`,
    );
  });

  it("links standalone inline-code URLs but preserves code containing other text", () => {
    const text = "`local://plan.md` and ``agent://Worker``; `read local://plan.md` and `local://missing.md`.";
    expect(rewriteOmpFileLinks(text, roots)).toBe(
      `[\`local://plan.md\`](${localDir}/plan.md) and [\`\`agent://Worker\`\`](${artifactsDir}/Worker.md); \`read local://plan.md\` and \`local://missing.md\`.`,
    );
  });

  it("rewrites only existing markdown hrefs, preserving their labels and titles", () => {
    const text = '[local://plan.md](agent://Worker "result") [Plan [draft]](local://plan.md) [external local://plan.md](https://example.com)';
    expect(rewriteOmpFileLinks(text, roots)).toBe(
      `[local://plan.md](${artifactsDir}/Worker.md "result") [Plan [draft]](${localDir}/plan.md) [external local://plan.md](https://example.com)`,
    );
  });

  it("preserves code inside link labels and rewrites reference definitions", () => {
    const text = '[`a]b`](local://plan.md) [result][plan]\n\n[plan]: local://plan.md "Plan"';
    expect(rewriteOmpFileLinks(text, roots)).toBe(
      `[\`a]b\`](${localDir}/plan.md) [result][plan]\n\n[plan]: ${localDir}/plan.md "Plan"`,
    );
  });

  it("handles adjacent URLs separated only by punctuation", () => {
    expect(rewriteOmpFileLinks("local://plan.md,artifact://0;agent://Worker", roots)).toBe(
      `[local://plan.md](${localDir}/plan.md),[artifact://0](${artifactsDir}/0.json);[agent://Worker](${artifactsDir}/Worker.md)`,
    );
  });

  it("handles angle-bracket destinations, spaces, encoding, and parentheses", () => {
    writeFileSync(join(localDir, "my plan (draft)100%.md"), "draft");
    expect(rewriteOmpFileLinks('[plan](<local://my plan (draft)100%25.md> "draft")', roots)).toBe(
      `[plan](<${localDir}/my%20plan%20%28draft%29100%25.md> "draft")`,
    );
    expect(rewriteOmpFileLinks("<local://my plan (draft)100%25.md>", roots)).toBe(
      `[local://my plan (draft)100%25.md](${localDir}/my%20plan%20%28draft%29100%25.md)`,
    );
    writeFileSync(join(localDir, "draft(1).md"), "draft");
    expect(rewriteOmpFileLinks("([plan](local://draft(1).md)).", roots)).toBe(
      `([plan](${localDir}/draft%281%29.md)).`,
    );
  });

  it("strips selectors and queries from paths without consuming sentence punctuation", () => {
    expect(rewriteOmpFileLinks("(local://plan.md:10-20), artifact://0:raw; agent://Worker/key:2-3!", roots)).toBe(
      `([local://plan.md:10-20](${localDir}/plan.md#L10-L20)), [artifact://0:raw](${artifactsDir}/0.json); [agent://Worker/key:2-3](${artifactsDir}/Worker.md#L2-L3)!`,
    );
    expect(rewriteOmpFileLinks("local://plan.md:raw:2-4:img artifact://0?q=.a", roots)).toBe(
      `[local://plan.md:raw:2-4:img](${localDir}/plan.md#L2-L4) [artifact://0?q=.a](${artifactsDir}/0.json)`,
    );
  });

  it("decodes percent escapes once and supports the empty-authority local form", () => {
    writeFileSync(join(localDir, "notes:10.md"), "notes");
    expect(rewriteOmpFileLinks("local://notes%3A10.md local:///plan.md", roots)).toBe(
      `[local://notes%3A10.md](${localDir}/notes%3A10.md) [local:///plan.md](${localDir}/plan.md)`,
    );
    expect(rewriteOmpFileLinks("local://bad%zz.md", roots)).toBe("local://bad%zz.md");
  });

  it.each([
    "local://../outside.md",
    "local://nested/../../outside.md",
    "local://%2e%2e/outside.md",
    "local://%2Foutside.md",
    "local://C:%2Foutside.md",
    "local://..%5Coutside.md",
    "agent://Worker/../outside",
    "agent://%2e%2e/outside",
    "artifact://../0",
  ])("rejects traversal and absolute destinations: %s", (url) => {
    writeFileSync(join(directory, "outside.md"), "private");
    expect(rewriteOmpFileLinks(url, roots)).toBe(url);
  });

  it("rejects symlink escapes while allowing a symlinked root", () => {
    writeFileSync(join(directory, "outside.md"), "private");
    symlinkSync(join(directory, "outside.md"), join(localDir, "escape.md"));
    symlinkSync(localDir, join(directory, "local-link"));
    expect(rewriteOmpFileLinks("local://escape.md", roots)).toBe("local://escape.md");
    expect(rewriteOmpFileLinks("local://plan.md", { localDir: join(directory, "local-link") })).toBe(
      `[local://plan.md](${directory}/local-link/plan.md)`,
    );
    symlinkSync(directory, join(artifactsDir, "external"));
    expect(rewriteOmpFileLinks("agent://outside", roots)).toBe("agent://outside");
  });

  it("leaves files that bb cannot represent safely as native URLs", () => {
    for (const name of ["Makefile", "a#b.md", "a?b.md", "a.md:10"]) {
      writeFileSync(join(localDir, name), "contents");
      const url = `local://${encodeURIComponent(name)}`;
      expect(rewriteOmpFileLinks(url, roots)).toBe(url);
    }
  });

  it("caches scans only briefly so newly published outputs become clickable", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(rewriteOmpFileLinks("artifact://1", roots)).toBe("artifact://1");
    writeFileSync(join(artifactsDir, "1.txt"), "new");
    expect(rewriteOmpFileLinks("artifact://1", roots)).toBe("artifact://1");
    vi.advanceTimersByTime(1_001);
    expect(rewriteOmpFileLinks("artifact://1", roots)).toBe(`[artifact://1](${artifactsDir}/1.txt)`);
    rmSync(join(artifactsDir, "1.txt"));
    expect(rewriteOmpFileLinks("artifact://1", roots)).toBe("artifact://1");
  });

  it("returns original text without file roots", () => {
    const text = "local://plan.md artifact://0 agent://Worker";
    expect(rewriteOmpFileLinks(text)).toBe(text);
    expect(rewriteOmpFileLinks(text, {})).toBe(text);
    expect(rewriteOmpFileLinks("ordinary markdown **stays unchanged**", roots)).toBe("ordinary markdown **stays unchanged**");
  });
});
