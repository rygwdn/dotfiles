import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureForkLocalThreadStorageLink,
  ensureLocalThreadStorageLink,
} from "./local-storage.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "bb-omp-local-storage-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

function storagePaths(session = "session", thread = "thread") {
  return {
    artifactsDir: join(workspace, "sessions", session),
    threadStorageDir: join(workspace, "storage", thread),
  };
}

describe("ensureLocalThreadStorageLink", () => {
  it("makes new local:// writes real thread files", () => {
    const paths = storagePaths();
    expect(ensureLocalThreadStorageLink(paths)).toBe(true);
    const local = join(paths.artifactsDir, "local");
    const target = join(paths.threadStorageDir, "local");
    expect(lstatSync(local).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(readlinkSync(local)).toBe(target);

    writeFileSync(join(local, "x.md"), "Written through OMP\n");
    expect(readFileSync(join(target, "x.md"), "utf8")).toBe("Written through OMP\n");
    expect(lstatSync(join(target, "x.md")).isFile()).toBe(true);
  });

  it("migrates nested directories and preserves both sides of every collision", () => {
    const paths = storagePaths();
    const local = join(paths.artifactsDir, "local");
    const target = join(paths.threadStorageDir, "local");
    mkdirSync(join(local, "nested"), { recursive: true });
    mkdirSync(join(target, "nested"), { recursive: true });
    writeFileSync(join(local, "x.md"), "incoming");
    writeFileSync(join(local, "nested", "incoming.md"), "nested incoming");
    writeFileSync(join(target, "x.md"), "existing");
    writeFileSync(join(target, "x.md.from-omp-1"), "earlier collision");
    writeFileSync(join(target, "nested", "existing.md"), "nested existing");
    symlinkSync("missing.md", join(target, "dangling.md"));
    writeFileSync(join(local, "dangling.md"), "must not overwrite a dangling link");

    expect(ensureLocalThreadStorageLink(paths)).toBe(true);
    expect(lstatSync(local).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "x.md"), "utf8")).toBe("existing");
    expect(readFileSync(join(target, "x.md.from-omp-1"), "utf8")).toBe("earlier collision");
    expect(readFileSync(join(target, "x.md.from-omp-2"), "utf8")).toBe("incoming");
    expect(readFileSync(join(target, "nested", "existing.md"), "utf8")).toBe("nested existing");
    expect(readFileSync(join(target, "nested.from-omp-1", "incoming.md"), "utf8")).toBe("nested incoming");
    expect(readlinkSync(join(target, "dangling.md"))).toBe("missing.md");
    expect(readFileSync(join(target, "dangling.md.from-omp-1"), "utf8"))
      .toBe("must not overwrite a dangling link");
  });

  it("is idempotent and links a changed session to the same thread directory", () => {
    const paths = storagePaths();
    expect(ensureLocalThreadStorageLink(paths)).toBe(true);
    const local = join(paths.artifactsDir, "local");
    const inode = lstatSync(local).ino;
    writeFileSync(join(local, "retained.md"), "kept across sessions");
    expect(ensureLocalThreadStorageLink(paths)).toBe(true);
    expect(lstatSync(local).ino).toBe(inode);
    expect(readdirSync(join(paths.threadStorageDir, "local"))).toEqual(["retained.md"]);

    const next = storagePaths("changed-session");
    expect(ensureLocalThreadStorageLink(next)).toBe(true);
    expect(realpathSync(join(next.artifactsDir, "local"))).toBe(realpathSync(local));
    expect(readFileSync(join(next.artifactsDir, "local", "retained.md"), "utf8"))
      .toBe("kept across sessions");
  });

  it("copies a foreign symlink's directory before repointing without draining its owner", () => {
    const paths = storagePaths();
    const oldTarget = join(workspace, "old-local");
    mkdirSync(paths.artifactsDir, { recursive: true });
    mkdirSync(oldTarget);
    writeFileSync(join(oldTarget, "old.md"), "old owner keeps me");
    symlinkSync(relative(paths.artifactsDir, oldTarget), join(paths.artifactsDir, "local"), "dir");

    expect(ensureLocalThreadStorageLink(paths)).toBe(true);
    expect(realpathSync(join(paths.artifactsDir, "local")))
      .toBe(realpathSync(join(paths.threadStorageDir, "local")));
    expect(readFileSync(join(paths.threadStorageDir, "local", "old.md"), "utf8"))
      .toBe("old owner keeps me");
    expect(readFileSync(join(oldTarget, "old.md"), "utf8")).toBe("old owner keeps me");
    writeFileSync(join(paths.threadStorageDir, "local", "old.md"), "independent copy");
    expect(readFileSync(join(oldTarget, "old.md"), "utf8")).toBe("old owner keeps me");
  });

  it("replaces a dangling local-root symlink", () => {
    const paths = storagePaths();
    mkdirSync(paths.artifactsDir, { recursive: true });
    symlinkSync(join(workspace, "missing"), join(paths.artifactsDir, "local"), "dir");
    expect(ensureLocalThreadStorageLink(paths)).toBe(true);
    writeFileSync(join(paths.artifactsDir, "local", "new.md"), "available");
    expect(readFileSync(join(paths.threadStorageDir, "local", "new.md"), "utf8"))
      .toBe("available");
  });

  it("logs an unavailable thread directory and leaves OMP's own files usable", () => {
    const paths = storagePaths();
    const local = join(paths.artifactsDir, "local");
    mkdirSync(local, { recursive: true });
    mkdirSync(join(workspace, "storage"));
    writeFileSync(paths.threadStorageDir, "not a directory");
    writeFileSync(join(local, "retained.md"), "OMP fallback");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(ensureLocalThreadStorageLink(paths)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not link OMP local files"));
    expect(lstatSync(local).isDirectory()).toBe(true);
    expect(readFileSync(join(local, "retained.md"), "utf8")).toBe("OMP fallback");
  });

  it("does not put thread files behind an existing target symlink", () => {
    const paths = storagePaths();
    const external = join(workspace, "external");
    mkdirSync(paths.threadStorageDir, { recursive: true });
    mkdirSync(external);
    symlinkSync(external, join(paths.threadStorageDir, "local"), "dir");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(ensureLocalThreadStorageLink(paths)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a real directory"));
    expect(existsSync(join(paths.artifactsDir, "local"))).toBe(false);
  });
});

describe("forked thread storage", () => {
  it.each(["missing", "copied-directory", "inherited-symlink"] as const)(
    "keeps the source independent when the fork local root is %s",
    (kind) => {
      const source = storagePaths("source-session", "source-thread");
      const fork = storagePaths("fork-session", "fork-thread");
      expect(ensureLocalThreadStorageLink(source)).toBe(true);
      const sourceLocal = join(source.artifactsDir, "local");
      mkdirSync(join(sourceLocal, "nested"));
      writeFileSync(join(sourceLocal, "x.md"), "source snapshot");
      writeFileSync(join(sourceLocal, "nested", "y.md"), "nested snapshot");
      if (kind !== "missing") {
        mkdirSync(fork.artifactsDir, { recursive: true });
        if (kind === "copied-directory") {
          cpSync(join(source.threadStorageDir, "local"), join(fork.artifactsDir, "local"), { recursive: true });
        } else {
          symlinkSync(join(source.threadStorageDir, "local"), join(fork.artifactsDir, "local"), "dir");
        }
      }

      expect(ensureForkLocalThreadStorageLink({
        ...fork,
        sourceArtifactsDir: source.artifactsDir,
      })).toBe(true);
      const forkLocal = join(fork.threadStorageDir, "local");
      expect(lstatSync(join(fork.artifactsDir, "local")).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(fork.artifactsDir, "local"))).toBe(realpathSync(forkLocal));
      expect(readdirSync(forkLocal).sort()).toEqual(["nested", "x.md"]);
      expect(readFileSync(join(forkLocal, "x.md"), "utf8")).toBe("source snapshot");
      expect(readFileSync(join(forkLocal, "nested", "y.md"), "utf8")).toBe("nested snapshot");
      expect(readFileSync(join(sourceLocal, "x.md"), "utf8")).toBe("source snapshot");
      writeFileSync(join(forkLocal, "x.md"), "fork-only change");
      expect(readFileSync(join(sourceLocal, "x.md"), "utf8")).toBe("source snapshot");

      expect(ensureForkLocalThreadStorageLink({
        ...fork,
        sourceArtifactsDir: source.artifactsDir,
      })).toBe(true);
      expect(readFileSync(join(forkLocal, "x.md"), "utf8")).toBe("fork-only change");
      expect(readdirSync(forkLocal).sort()).toEqual(["nested", "x.md"]);
    },
  );

  it("can seed a fork from the source thread environment without a source session link", () => {
    const source = storagePaths("unavailable-source-session", "source-thread");
    const fork = storagePaths("fork-session", "fork-thread");
    mkdirSync(join(source.threadStorageDir, "local"), { recursive: true });
    writeFileSync(join(source.threadStorageDir, "local", "env.md"), "from source environment");
    expect(ensureForkLocalThreadStorageLink({
      ...fork,
      sourceArtifactsDir: source.artifactsDir,
      sourceThreadStorageDir: source.threadStorageDir,
    })).toBe(true);
    expect(readFileSync(join(fork.threadStorageDir, "local", "env.md"), "utf8"))
      .toBe("from source environment");
    expect(readFileSync(join(source.threadStorageDir, "local", "env.md"), "utf8"))
      .toBe("from source environment");
  });
});
