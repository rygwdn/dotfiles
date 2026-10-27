import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ProjectDiskReport } from "./contract";
import { formatBytes } from "./format";

const run = promisify(execFile);

/** Bounded allocated-byte inventory. Symlinks and other filesystems are not traversed. */
export async function measureProjectPaths(paths: string[], options = { maxEntries: 100_000, maxMs: 5_000 }) {
  const seen = new Set<string>();
  const roots = [...new Set(paths)].sort();
  const deadline = Date.now() + options.maxMs;
  let entries = 0;
  const results: Array<{ path: string; bytes: number; complete: boolean; notes: string[] }> = [];
  for (const root of roots) {
    const result = { path: root, bytes: 0, complete: true, notes: [] as string[] };
    results.push(result);
    const pending = [root];
    try {
      if (root === sep || root === await realpath(homedir())) throw new Error("Root/home directory inventory is excluded; select a project checkout.");
      const device = (await lstat(root)).dev;
      scan: while (pending.length > 0) {
        if (entries >= options.maxEntries || Date.now() >= deadline) {
          result.complete = false;
          result.notes.push("Project scan limit reached; bytes are a lower bound.");
          break;
        }
        const path = pending.pop()!;
        // Give nested worktrees their own row rather than charging them to the parent too.
        if (path !== root && roots.includes(path)) continue;
        try {
          const info = await lstat(path);
          entries++;
          if (info.dev !== device) continue;
          const key = `${info.dev}:${info.ino}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.bytes += info.blocks * 512;
          if (info.isDirectory() && !info.isSymbolicLink()) {
            const directory = await opendir(path);
            for await (const entry of directory) {
              if (entries + pending.length >= options.maxEntries || Date.now() >= deadline) {
                result.complete = false;
                result.notes.push("Project scan limit reached; bytes are a lower bound.");
                break scan;
              }
              pending.push(join(path, entry.name));
            }
          }
        } catch (error) {
          result.complete = false;
          if (result.notes.length < 5) result.notes.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      result.complete = false;
      result.notes.push(error instanceof Error ? error.message : String(error));
    }
  }
  return results;
}

export async function readProjectDisk(bb: BbPluginApi, input: { projectId?: string; measure?: boolean }): Promise<ProjectDiskReport> {
  if (input.measure && !input.projectId) throw new Error("Select a project before measuring disk usage.");
  const [config, projects] = await Promise.all([bb.sdk.system.config(), bb.sdk.projects.list({ includePersonal: true })]);
  const report: ProjectDiskReport = { atMs: Date.now(), projects: [], warnings: [] };
  const selected = input.projectId ? projects.filter((project) => project.id === input.projectId) : projects;
  if (input.projectId && selected.length === 0) throw new Error("Project not found.");
  for (const project of selected) {
    const row: ProjectDiskReport["projects"][number] = { id: project.id, name: project.name, paths: [], threads: [], warnings: [] };
    report.projects.push(row);
    const [environments, threads] = await Promise.all([
      bb.sdk.environments.list({ projectId: project.id, limit: 500 }),
      bb.sdk.threads.list({ projectId: project.id, includeHidden: true, limit: 500 }),
    ]);
    if (environments.length === 500 || threads.length === 500) row.warnings.push("Metadata limited to 500 environments and 500 non-archived threads.");
    row.threads = threads.map((thread) => ({ id: thread.id, title: thread.title ?? thread.titleFallback ?? thread.id, status: thread.status, environmentId: thread.environmentId }));
    const candidates = [
      ...project.sources.map((source) => ({ path: source.path, hostId: source.hostId, environmentId: null as string | null, branch: null as string | null, kind: "source" })),
      ...environments.filter((environment) => environment.path !== null).map((environment) => ({ path: environment.path!, hostId: environment.hostId, environmentId: environment.id, branch: environment.branchName, kind: environment.isWorktree ? "worktree" : "environment" })),
    ];
    for (const candidate of candidates) {
      let path = candidate.path;
      const local = candidate.hostId === config.primaryHostId;
      if (local) {
        try { path = await realpath(path); } catch { path = resolve(path); }
      }
      let existing = row.paths.find((item) => item.path === path && item.hostId === candidate.hostId);
      if (!existing) {
        existing = { path, hostId: candidate.hostId, local, kind: candidate.kind, branch: candidate.branch, environmentIds: [], bytes: null, complete: false, notes: [] };
        row.paths.push(existing);
      }
      if (candidate.environmentId && !existing.environmentIds.includes(candidate.environmentId)) existing.environmentIds.push(candidate.environmentId);
      if (candidate.branch) existing.branch = candidate.branch;
    }
    // Git is authoritative for linked worktrees that have no BB environment yet.
    for (const source of project.sources.filter((source) => source.hostId === config.primaryHostId)) {
      try {
        const { stdout } = await run("git", ["-C", source.path, "worktree", "list", "--porcelain", "-z"], { timeout: 2_000, maxBuffer: 256 * 1024 });
        let current: ProjectDiskReport["projects"][number]["paths"][number] | undefined;
        for (const field of stdout.split("\0")) {
          if (field.startsWith("worktree ")) {
            const path = await realpath(field.slice(9)).catch(() => resolve(field.slice(9)));
            current = row.paths.find((item) => item.local && item.path === path);
            if (!current) {
              current = { path, hostId: source.hostId, local: true, kind: "worktree", branch: null, environmentIds: [], bytes: null, complete: false, notes: [] };
              row.paths.push(current);
            }
          } else if (current && field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, "");
        }
      } catch (error) {
        row.warnings.push(`Linked worktree discovery for ${source.path}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
      }
    }
    if (input.measure) {
      const measured = await measureProjectPaths(row.paths.filter((path) => path.local).map((path) => path.path));
      for (const result of measured) Object.assign(row.paths.find((path) => path.local && path.path === result.path)!, result);
    }
    for (const path of row.paths.filter((path) => !path.local)) path.notes.push("Remote host: listed but not scanned on this machine.");
  }
  return report;
}

export function renderProjectDisk(report: ProjectDiskReport): string {
  const lines = ["Project disk details (allocated bytes; partial scans are lower bounds):"];
  for (const project of report.projects) {
    lines.push(`${project.name} [${project.id}]`);
    for (const path of project.paths.slice(0, 40)) {
      lines.push(`  ${path.bytes === null ? "not measured" : `${path.complete ? "" : "at least "}${formatBytes(path.bytes)}`}  ${path.path}  ${path.kind}${path.branch ? ` (${path.branch})` : ""} [${path.hostId}]`);
      for (const note of path.notes) lines.push(`    ${note}`);
      const threads = project.threads.filter((thread) => thread.environmentId !== null && path.environmentIds.includes(thread.environmentId));
      for (const thread of threads.slice(0, 20)) lines.push(`    ${thread.status}: ${thread.title} [${thread.id}]`);
      if (threads.length > 20) lines.push(`    ${threads.length - 20} more threads; use JSON for the full report.`);
    }
    if (project.paths.length > 40) lines.push(`  ${project.paths.length - 40} more paths; use JSON for the full report.`);
    const unassigned = project.threads.filter((thread) => !project.paths.some((path) => thread.environmentId !== null && path.environmentIds.includes(thread.environmentId)));
    for (const thread of unassigned.slice(0, 20)) lines.push(`  Project thread (no listed path): ${thread.title} [${thread.id}] ${thread.status}`);
    for (const warning of project.warnings) lines.push(`  Warning: ${warning}`);
  }
  lines.push(...report.warnings, "Shared hardlinks are counted once within a project; APFS clones and cross-project overlap are not additive. Thread association is metadata, not ownership of bytes.");
  return lines.join("\n");
}
