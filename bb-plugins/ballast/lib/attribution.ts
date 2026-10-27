import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessRow } from "./contract";
import { SHARED_BB_PATTERN } from "./procs";

const run = promisify(execFile);
type ThreadPath = { threadId: string; path: string };

/**
 * BB infrastructure that serves every thread at once.
 *
 * These processes must never be charged to a thread, whatever the topology
 * looks like when the table is read. BB's server, launcher and plugin host
 * worker outlive any single session, so a rule that resolved them would make
 * a machine running one thread report that the whole of BB belongs to it.
 */
function isSharedInfrastructure(row: ProcessRow): boolean {
  return row.kind === "system" || SHARED_BB_PATTERN.test(row.command);
}

/** Read only agent environments; never expose or retain other environment values. */
export async function readAgentThreads(rows: readonly ProcessRow[]): Promise<Map<number, string>> {
  const ids = rows.filter((row) => row.kind === "agent").map((row) => row.pid);
  const threads = new Map<number, string>();
  for (let offset = 0; offset < ids.length; offset += 64) {
    try {
      const { stdout } = await run("ps", ["eww", "-p", ids.slice(offset, offset + 64).join(","), "-o", "pid=,command="], {
        timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of stdout.split("\n")) {
        const pid = /^\s*(\d+)\s/.exec(line);
        const thread = /(?:^|\s)BB_THREAD_ID=(thr_[a-z0-9]{8,})(?=\s|$)/.exec(line);
        if (pid !== null && thread !== null) threads.set(Number(pid[1]), thread[1]);
      }
    } catch {
      // Processes may exit or deny environment access. Leave them unattributed.
    }
  }
  return threads;
}

/** Identity is local to an agent subtree, never inferred from a shared BB parent. */
export function attributeThreads(
  rows: readonly ProcessRow[], paths: readonly ThreadPath[], agents: ReadonlyMap<number, string>,
): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const sorted = [...paths].sort((a, b) => b.path.length - a.path.length);
  const direct = new Map<number, string>();
  for (const row of rows) {
    if (isSharedInfrastructure(row)) continue;
    const explicit = agents.get(row.pid) ?? row.threadId;
    if (explicit !== null && explicit !== undefined) {
      direct.set(row.pid, explicit);
      continue;
    }
    // Equal paths can belong to many threads in a project checkout. Never pick the first.
    const matches = sorted.filter(({ path }) => {
      const index = row.command.indexOf(path);
      if (index < 0) return false;
      const before = row.command[index - 1];
      const after = row.command[index + path.length];
      return (before === undefined || /[\s='"]/.test(before)) &&
        (after === undefined || /[\s/'"]/.test(after));
    });
    const longest = matches[0]?.path.length;
    const owners = new Set(matches.filter((entry) => entry.path.length === longest).map((entry) => entry.threadId));
    if (owners.size === 1) direct.set(row.pid, owners.values().next().value!);
  }
  const resolved = new Map<number, string>();
  for (const row of rows) {
    const threadId = direct.get(row.pid);
    if (threadId !== undefined) resolved.set(row.pid, threadId);
  }

  /** Inherit from the nearest ancestor that owns a thread, stopping at shared infrastructure. */
  const inheritDown = (row: ProcessRow): string | null => {
    let current: ProcessRow | undefined = row;
    const seen = new Set<number>();
    while (current !== undefined && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (current.pid !== row.pid && isSharedInfrastructure(current)) break;
      const threadId = resolved.get(current.pid);
      if (threadId !== undefined) return threadId;
      current = byPid.get(current.ppid);
    }
    return null;
  };

  for (const row of rows) {
    if (resolved.has(row.pid)) continue;
    const inherited = inheritDown(row);
    if (inherited !== null) resolved.set(row.pid, inherited);
  }

  /**
   * A session's infrastructure inherits from the agent it hosts.
   *
   * BB starts each thread's agent under a per-session bridge worker, and that
   * worker holds real memory while carrying no thread identity of its own —
   * its environment is the daemon's, not the thread's. The rule is deliberately
   * narrow: exactly one agent child, a parent that is not shared
   * infrastructure, and an agent whose thread is known.
   *
   * "Exactly one" is what keeps a shared hub out. A hub whose children are
   * agents would qualify with only one session running, and the whole of BB
   * would then be charged to whichever thread happened to be live. The
   * explicit shared-infrastructure check is the second lock on the same door.
   */
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list === undefined) children.set(row.ppid, [row]);
    else list.push(row);
  }
  for (const row of rows) {
    if (resolved.has(row.pid) || isSharedInfrastructure(row)) continue;
    const agentChildren = (children.get(row.pid) ?? []).filter((child) => child.kind === "agent");
    if (agentChildren.length !== 1) continue;
    const threadId = resolved.get(agentChildren[0].pid);
    if (threadId !== undefined) resolved.set(row.pid, threadId);
  }

  for (const row of rows) {
    if (resolved.has(row.pid)) continue;
    const inherited = inheritDown(row);
    if (inherited !== null) resolved.set(row.pid, inherited);
  }

  return rows.map((row) => ({ ...row, threadId: resolved.get(row.pid) ?? null }));
}
