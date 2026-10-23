import {
  constants,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function getOmpArtifactsDir(sessionFile: string): string {
  return sessionFile.replace(/\.jsonl$/u, "");
}

function localEntry(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function localDirectory(path: string): string | undefined {
  try {
    return statSync(path).isDirectory() ? realpathSync(path) : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function transferEntries(source: string, target: string, move: boolean): void {
  if (source === target) return;
  if (contains(source, target) || contains(target, source)) {
    throw new Error("Local storage directories must not contain each other");
  }
  const names = readdirSync(source);
  for (const name of names) {
    let destination = join(target, name);
    for (let suffix = 1; localEntry(destination); suffix += 1) {
      destination = join(target, `${name}.from-omp-${suffix}`);
    }
    // Exclusive copies also work across filesystems and retain the originals if
    // any copy fails. In particular, never follow an entry's symlink on a fork.
    cpSync(join(source, name), destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_EXCL,
    });
  }
  if (move) {
    for (const name of names) rmSync(join(source, name), { recursive: true });
  }
}

/** Keep real files in BB's thread storage; its file listing skips symlinks. */
export function ensureLocalThreadStorageLink(args: {
  artifactsDir: string;
  threadStorageDir: string;
}): boolean {
  try {
    const local = resolve(args.artifactsDir, "local");
    const target = resolve(args.threadStorageDir, "local");
    mkdirSync(target, { recursive: true });
    if (!lstatSync(target).isDirectory()) {
      throw new Error(`Thread storage local root is not a real directory: ${target}`);
    }
    const targetDirectory = realpathSync(target);
    const entry = localEntry(local);
    if (entry?.isSymbolicLink()) {
      const previous = localDirectory(local);
      if (previous === targetDirectory) return true;
      // A foreign link may belong to another BB thread (including a fork's
      // inherited root). Copy its files, rather than emptying that thread.
      if (previous) transferEntries(previous, targetDirectory, false);
      unlinkSync(local);
    } else if (entry?.isDirectory()) {
      const previous = realpathSync(local);
      if (previous === targetDirectory) return true;
      transferEntries(previous, targetDirectory, true);
      rmdirSync(local);
    } else if (entry) {
      throw new Error(`OMP local root is not a directory: ${local}`);
    }
    mkdirSync(resolve(args.artifactsDir), { recursive: true });
    symlinkSync(target, local, "dir");
    return true;
  } catch (error) {
    console.warn(`[bb-provider-omp] Could not link OMP local files to thread storage: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Seed a new BB thread without moving files out of the source thread. */
export function ensureForkLocalThreadStorageLink(args: {
  artifactsDir: string;
  threadStorageDir: string;
  sourceArtifactsDir: string;
  sourceThreadStorageDir?: string;
}): boolean {
  try {
    const local = join(args.artifactsDir, "local");
    // OMP normally copies the artifacts tree itself. A copied real directory is
    // already an independent snapshot; an inherited link is copied by ensure.
    if (!localDirectory(local)) {
      const source = (args.sourceThreadStorageDir
        ? localDirectory(join(args.sourceThreadStorageDir, "local"))
        : undefined) ?? localDirectory(join(args.sourceArtifactsDir, "local"));
      if (source) {
        const target = resolve(args.threadStorageDir, "local");
        mkdirSync(target, { recursive: true });
        if (!lstatSync(target).isDirectory()) {
          throw new Error(`Thread storage local root is not a real directory: ${target}`);
        }
        transferEntries(source, realpathSync(target), false);
      }
    }
  } catch (error) {
    console.warn(`[bb-provider-omp] Could not copy forked OMP local files: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ensureLocalThreadStorageLink(args);
}
