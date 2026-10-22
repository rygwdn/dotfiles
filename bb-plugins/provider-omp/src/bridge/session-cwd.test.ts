import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ompSessionNeedsRelocation } from "./session-cwd.js";
import {
  OMP_BRIDGE_SESSION_DIR_ENV,
  findNewestOmpSessionFile,
  resolveOmpThreadSessionDir,
} from "./session-paths.js";

it("does not modify a session when its requested directory or header is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-omp-relocation-invalid-"));
  const file = join(root, "session.jsonl");
  try {
    const contents = JSON.stringify({ type: "session", cwd: root }) + "\n";
    writeFileSync(file, contents);
    expect(() =>
      ompSessionNeedsRelocation(file, join(root, "missing")),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(contents);
    expect(() => ompSessionNeedsRelocation(file, file)).toThrow(
      "not a directory",
    );
    expect(readFileSync(file, "utf8")).toBe(contents);
    writeFileSync(file, "invalid header\nuntouched history\n");
    expect(() => ompSessionNeedsRelocation(file, root)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(
      "invalid header\nuntouched history\n",
    );
    expect(readdirSync(root)).toEqual(["session.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("requires relocation only for a different directory", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-omp-relocation-file-"));
  const file = join(root, "session.jsonl");
  try {
    expect(ompSessionNeedsRelocation(file, root)).toBe(false);
    writeFileSync(
      file,
      JSON.stringify({ type: "session", cwd: realpathSync(root) }),
    );
    expect(ompSessionNeedsRelocation(file, root)).toBe(false);
    const contents = JSON.stringify({
      type: "session",
      cwd: join(root, "removed"),
    });
    writeFileSync(file, contents);
    expect(ompSessionNeedsRelocation(file, root)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(contents);
    expect(readdirSync(root)).toEqual(["session.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["", "A native OMP title"])(
  "reads the session header after OMP's fixed-width title record (%s)",
  (title) => {
    const root = mkdtempSync(join(tmpdir(), "bb-omp-title-cwd-"));
    const file = join(root, "session.jsonl");
    try {
      const prefix = JSON.stringify({ type: "title", title }).padEnd(255, " ") + "\n";
      const current = prefix + JSON.stringify({ type: "session", cwd: realpathSync(root) }) + "\n";
      writeFileSync(file, current);
      expect(ompSessionNeedsRelocation(file, root)).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(current);
      const relocated = prefix + JSON.stringify({ type: "session", cwd: join(root, "removed") }) + "\n";
      writeFileSync(file, relocated);
      expect(ompSessionNeedsRelocation(file, root)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(relocated);
      writeFileSync(file, prefix);
      expect(() => ompSessionNeedsRelocation(file, root)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(prefix);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("uses a sanitized per-thread directory, never a deterministic session filename", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-omp-thread-paths-"));
  try {
    const env = { [OMP_BRIDGE_SESSION_DIR_ENV]: root };
    expect(resolveOmpThreadSessionDir({ env, threadId: "omp_thread" })).toBe(join(root, "omp_thread"));
    expect(resolveOmpThreadSessionDir({ env, threadId: "omp_thread/child" })).toBe(join(root, "omp_thread_child"));
    for (const threadId of ["", ".", ".."]) {
      expect(resolveOmpThreadSessionDir({ env, threadId })).toBe(join(root, "_"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeNativeSession(
  directory: string,
  name: string,
  records: readonly Record<string, unknown>[],
  title = "",
  timestamp = "2026-01-01T00:00:00.000Z",
): string {
  const file = join(directory, name);
  const entries = [
    { type: "title", title },
    { type: "session", version: 3, id: name, cwd: directory, timestamp },
    ...records,
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

it("finds the newest nonempty OMP history while skipping empty drafts and unrelated files", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-omp-session-discovery-"));
  try {
    expect(findNewestOmpSessionFile(join(root, "missing"))).toBeUndefined();
    expect(findNewestOmpSessionFile(root)).toBeUndefined();
    const older = writeNativeSession(root, "older.jsonl", [
      { type: "message", id: "answer", parentId: null, message: { role: "assistant", content: [] } },
    ]);
    const newer = writeNativeSession(root, "newer.jsonl", [
      { type: "message", id: "question", parentId: null, message: { role: "user", content: [{ type: "text", text: "Resume this history" }] } },
    ]);
    const draft = writeNativeSession(root, "draft.jsonl", [
      { type: "model_change", id: "model", parentId: null, model: "fake-provider/fake-model" },
    ]);
    const zero = join(root, "empty.jsonl");
    writeFileSync(zero, "");
    writeFileSync(join(root, "invalid.jsonl"), "not a session\n");
    writeNativeSession(root, "unrelated.txt", [], "Not a session file");
    mkdirSync(join(root, "directory.jsonl"));
    utimesSync(older, 1, 1);
    utimesSync(newer, 2, 2);
    utimesSync(draft, 3, 3);
    utimesSync(zero, 4, 4);
    const before = readFileSync(newer, "utf8");
    expect(findNewestOmpSessionFile(root)).toBe(newer);
    expect(readFileSync(newer, "utf8")).toBe(before);
    writeNativeSession(root, "newer.jsonl", []);
    expect(findNewestOmpSessionFile(root)).toBe(older);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps named zero-turn sessions resumable and breaks timestamp ties like OMP", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-omp-session-ties-"));
  try {
    const older = writeNativeSession(root, "z-older.jsonl", [], "Named older session");
    const newer = writeNativeSession(root, "a-newer.jsonl", [], "Named newer session", "2026-01-02T00:00:00.000Z");
    utimesSync(older, 1, 1);
    utimesSync(newer, 1, 1);
    expect(findNewestOmpSessionFile(root)).toBe(newer);
    const sameDate = writeNativeSession(root, "z-newer.jsonl", [], "Also named", "2026-01-02T00:00:00.000Z");
    utimesSync(sameDate, 1, 1);
    expect(findNewestOmpSessionFile(root)).toBe(sameDate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
