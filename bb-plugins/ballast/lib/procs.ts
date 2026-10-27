/**
 * The process table, classified.
 *
 * Classification is not decoration — it is the safety model. Every decision
 * Ballast is allowed to make about a process follows from what kind it is, so
 * a pattern that mislabels an editor as a test runner is a bug that deletes
 * someone's unsaved work. The rules below are therefore deliberately narrow:
 * anything that does not match a specific, evidence-carrying pattern falls
 * through to `other`, which is never a candidate for anything.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Consumer, ProcessKind, ProcessRow } from "./contract";
import { formatBytes } from "./format";

const run = promisify(exec);

/** `ps` etime is `[[dd-]hh:]mm:ss`. */
export function parseEtime(text: string): number {
  const trimmed = text.trim();
  const [dayPart, clockPart] = trimmed.includes("-") ? trimmed.split("-") : [null, trimmed];
  const parts = clockPart.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
  if (dayPart !== null) seconds += Number(dayPart) * 86_400;
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Basename of argv[0], with the macOS app-bundle tail preferred.
 *
 * `/Applications/bb.app/Contents/MacOS/bb Helper (Renderer)` should read as
 * "bb Helper (Renderer)", not as the path, and `/opt/homebrew/.../bin/node`
 * should read as "node".
 */
export function processName(command: string): string {
  // `ps` joins argv with spaces and executables on macOS have spaces in their
  // paths, so there is no lossless split. Splitting on whitespace is the wrong
  // guess — it turns the user's Chrome into "/Applications/Google". Instead,
  // end argv[0] at the first space that starts something recognisably *not*
  // part of a path: a flag, another absolute path, or a `VAR=value`. A space
  // followed by an ordinary word is assumed to be inside the path, which is
  // the common case this exists for.
  const boundary = /\s(?=[-/]|\S*=)/.exec(command);
  const argv0 = (boundary === null ? command : command.slice(0, boundary.index)).trim();
  const base = (argv0.split("/").pop() ?? argv0).trim();
  // `next-server (v16.3.4)` — the version is noise in a label.
  return base.replace(/\s*\([^)]*\)\s*$/, "") || argv0;
}

/** `-p 4801`, `--port=4801`, `--port 4801`. */
export function parsePort(command: string): number | null {
  const match = /(?:--port[= ]|-p\s+)(\d{2,5})\b/.exec(command);
  if (match === null) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

/** BB names every worktree after the thread that owns it, so argv carries the id. */
export function parseThreadId(command: string): string | null {
  return /\b(thr_[a-z0-9]{8,})\b/.exec(command)?.[1] ?? null;
}

/**
 * A headless or automation-driven browser, as distinct from the one the user
 * is reading this in.
 *
 * The distinction is the entire reason Ballast can be trusted to kill
 * browsers: every pattern here requires a flag that only an automation harness
 * passes. `--type=` is excluded so a tree collapses to its parent rather than
 * offering 30 individually-killable renderers.
 */
export function isAutomationBrowser(command: string): boolean {
  if (/--type=/.test(command)) return false;
  if (/chrome-headless-shell|headless_shell/.test(command)) return true;
  if (!/(Chrome|Chromium|firefox|webkit|msedge)/i.test(command)) return false;
  return /--headless|--remote-debugging-(port|pipe)|--user-data-dir=\S*(playwright|puppeteer|ms-playwright)/i.test(
    command,
  );
}

const AGENT_PATTERNS =
  /(claude-code|@anthropic-ai\/claude-code|\bcodex\b|opencode|cursor-agent|amp\b|\bgemini-cli\b|aider|\bomp\s+acp\b)/i;
const DEV_SERVER_PATTERNS =
  /(next-server|next(-router-worker)?\s+dev|\bvite\b|webpack(-dev-server)?|nodemon|ng serve|rails server|\bdjango\b.*runserver)/i;
const TEST_RUNNER_PATTERNS =
  /(\bvitest\b|\bjest\b|--test-concurrency|node\s+--test|playwright\s+test|playwright[\\/]lib[\\/](worker|server)|mocha|pytest)/i;
const TOOLCHAIN_PATTERNS =
  /(\btsc\b|\beslint\b|\bprettier\b|\btsserver\b|typescript[\\/]lib|\bwebpack\b|\bturbopack\b|\brollup\b|\besbuild\b|gradle|\bcargo\b|\bgo build\b)/i;
const CONTAINER_PATTERNS = /(com\.docker|docker-desktop|\bqemu\b|vpnkit|containerd|colima|\blima\b)/i;
const EDITOR_PATTERNS =
  /(Visual Studio Code|Code Helper|\bXcode\b|IntelliJ|PyCharm|WebStorm|GoLand|\bzed\b|Cursor Helper|\bCursor\b.*Helper)/i;
const INTERACTIVE_BROWSER_PATTERNS =
  /(Google Chrome|Safari|firefox|Firefox|Microsoft Edge|Arc|Brave Browser)/;
/**
 * BB itself — the application binaries only.
 *
 * Emphatically *not* "anything under ~/.bb". Every worktree BB creates lives
 * there, so a path rule that broad would classify every process the fleet runs
 * — every dev server, every Playwright worker, every test runner — as BB, and
 * `bb` is outside the killable set. The plugin would have looked like it was
 * working and quietly refused to reclaim anything.
 */
const BB_PATTERNS =
  /(bb\.app[\\/]Contents|\bbb Helper\b|bb-app[\\/](server[\\/]dist|host-daemon[\\/]dist|dist[\\/]bb-app\.js))/;
/**
 * BB infrastructure that serves every thread at once.
 *
 * These are the processes that must never be charged to a single thread, no
 * matter what the topology looks like when the table is read: the server
 * itself, the launcher, the desktop app, and the plugin host worker. The
 * per-session bridge worker is deliberately *not* here — it exists to serve
 * one agent, and that agent's thread is the only thread it serves.
 */
export const SHARED_BB_PATTERN =
  /(bb\.app[\\/]Contents|bb-app[\\/]server[\\/]dist|bb-app[\\/]dist[\\/]bb-app\.js|bb-plugin-host-worker\.mjs)/;
/**
 * Processes owned by the OS. Matching here is a refusal, not a label: nothing
 * classified `system` is ever offered as a candidate, so a false positive
 * costs a missed opportunity and a false negative costs a reboot.
 */
const SYSTEM_PATTERNS =
  /^(kernel_task|launchd|logd|WindowServer|loginwindow|Finder|Dock|SystemUIServer|systemd|init|mds|mds_stores|mdworker\S*|spotlight\S*|backupd|coreaudiod|bluetoothd|WindowManager|Spotlight|cfprefsd|distnoted|securityd|opendirectoryd|powerd|kextd|diskarbitrationd|configd|syslogd|sshd|fseventsd)$/;

/**
 * A shell is never what its arguments say it is.
 *
 * `sh -c 'npm run build'` contains the word `build`, `zsh -c 'npx tsc'`
 * contains `tsc`, and a naive content match labels both of them `toolchain` —
 * which is a *killable* kind. Interpreters are therefore classified by what
 * they are, before any content pattern gets a look: an unclassified `other`,
 * which nothing will ever stop. The real build tool is a child process and
 * gets classified on its own merits.
 */
const INTERPRETER_NAMES =
  /^(sh|bash|zsh|fish|dash|ksh|csh|tcsh|env|xargs|timeout|nohup|sudo|script|expect|login|tmux|screen)$/;

/**
 * Long-lived tool *servers*, which are infrastructure rather than build steps.
 *
 * `esbuild --service=...`, a TypeScript server, a language server and a file
 * watcher all sit at zero CPU between requests for as long as their host is
 * open. Treating them as build tools and killing them for being idle is not a
 * reclaim — it silently breaks the thing that spawned them, and it does not
 * come back.
 *
 * This is not hypothetical. An earlier version of this plugin classified
 * `esbuild --service` as `toolchain`, found it idle, and terminated it. It was
 * BB's own bundler: every plugin install afterwards failed with "The service
 * is no longer running" until BB was restarted. The plugin broke its own
 * install path by reclaiming 141 MB.
 */
const TOOL_SERVICE_PATTERNS =
  /(--service=|\btsserver\b|language-?server|\bwatchman\b|\bdaemon\b|--watch\b|\besbuild\b.*--serve)/i;

export function classify(command: string, name: string): ProcessKind {
  if (SYSTEM_PATTERNS.test(name)) return "system";
  if (INTERPRETER_NAMES.test(name)) return "other";
  if (isAutomationBrowser(command)) return "browser-automation";
  // BB is checked before the generic tool-service rule on purpose. The BB
  // service launcher carries `--host-daemon-port`, which the daemon pattern
  // matches, so a launcher that classified as a tool service came back as
  // generic `other` and merged with every other BB-owned process into one
  // unattributed blob. BB's own processes are `bb` whatever their flags say.
  if (BB_PATTERNS.test(command)) return "bb";
  if (AGENT_PATTERNS.test(command)) return "agent";
  if (TOOL_SERVICE_PATTERNS.test(command)) return "other";
  if (CONTAINER_PATTERNS.test(command)) return "container";
  if (EDITOR_PATTERNS.test(command)) return "editor";
  if (DEV_SERVER_PATTERNS.test(command)) return "dev-server";
  if (TEST_RUNNER_PATTERNS.test(command)) return "test-runner";
  if (TOOLCHAIN_PATTERNS.test(command)) return "toolchain";
  if (INTERACTIVE_BROWSER_PATTERNS.test(command)) return "browser";
  return "other";
}

/**
 * Read every process once.
 *
 * `ps` is ~50 ms for a full table, which is why this samples on a timer rather
 * than maintaining anything. `rss` overstates: shared pages are counted in
 * every process that maps them, so the column sums to well over physical
 * memory. That is acceptable for *ranking*, which is all this is used for —
 * and it is the same number `top` shows. Absolute totals come from `vm_stat`,
 * never from adding this column up.
 */
export async function readProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await run("ps -axo pid=,ppid=,rss=,etime=,pcpu=,user=,command=", {
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = match[7];
    const name = processName(command);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      ageSeconds: parseEtime(match[4]),
      cpuPercent: Number(match[5]),
      user: match[6],
      command,
      name,
      kind: classify(command, name),
      threadId: parseThreadId(command),
      port: parsePort(command),
    });
  }
  return rows;
}

/**
 * Roll the process table into the units a person reasons about.
 *
 * A headless Chrome is one browser, not 30 renderers; a Next dev server is one
 * server, not a server plus its compiler forks. Grouping walks each process up
 * to the nearest ancestor that shares its identity, so the row you see is the
 * thing you would actually decide to stop, and its byte total is the whole
 * tree's.
 */
export function groupConsumers(
  rows: ProcessRow[],
  threadTitles: Map<string, string>,
  options?: { minBytes?: number },
): Consumer[] {
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);

  /**
   * The row that owns a process.
   *
   * Climb only while the parent is *the same thing*: same kind, or a generic
   * helper of a classified parent. The temptation is to be generous here so
   * trees collapse neatly — but a permissive rule walks everything up to the
   * application root, and the first version of this function rolled 88
   * unrelated processes into BB and reported them as one 5 GB row belonging to
   * whichever thread it happened to see first.
   *
   * `bb` and `agent` are hard stops. Both are long-lived parents of work that
   * is not theirs: every thread's processes descend from BB, and absorbing
   * them would destroy the per-thread attribution that makes this plugin
   * worth having.
   */
  const rootOf = (row: ProcessRow): ProcessRow => {
    let current = row;
    const seen = new Set<number>([row.pid]);
    for (;;) {
      const parent = byPid.get(current.ppid);
      if (parent === undefined || parent.pid <= 1 || seen.has(parent.pid)) return current;
      if (parent.threadId !== current.threadId) return current;
      if (parent.kind === "system" || parent.kind === "bb" || parent.kind === "agent") {
        return current;
      }
      // A generic child (a shell, a wrapper, an unclassified fork) belongs to
      // its classified parent. The reverse is never true: a classified child
      // does not belong to an unclassified parent.
      const sameIdentity =
        parent.kind === current.kind || (current.kind === "other" && parent.kind !== "other");
      if (!sameIdentity) return current;
      seen.add(parent.pid);
      current = parent;
    }
  };

  const groups = new Map<number, { root: ProcessRow; members: ProcessRow[] }>();
  for (const row of rows) {
    if (row.kind === "system") continue;
    const root = rootOf(row);
    const group = groups.get(root.pid);
    if (group === undefined) groups.set(root.pid, { root, members: [row] });
    else group.members.push(row);
  }

  const minBytes = options?.minBytes ?? 32 * 1024 * 1024;
  const consumers: Consumer[] = [];
  for (const { root, members } of groups.values()) {
    const bytes = members.reduce((sum, row) => sum + row.rssBytes, 0);
    if (bytes < minBytes) continue;
    // A group only carries a thread id when its members agree. Taking the
    // first one found labels a mixed tree with whichever thread happened to
    // sort first — which is how a shared parent ends up captioned with one
    // arbitrary thread's name.
    const memberThreads = new Set(
      members.map((row) => row.threadId).filter((id): id is string => id !== null),
    );
    const threadId =
      root.threadId ?? (memberThreads.size === 1 ? [...memberThreads][0] : null);
    const port = root.port ?? members.find((row) => row.port !== null)?.port ?? null;
    consumers.push({
      id: `pid:${root.pid}`,
      label: describe(root, members.length),
      detail: root.command,
      kind: root.kind,
      bytes,
      processCount: members.length,
      rootPid: root.pid,
      parentPid: root.ppid,
      pids: members.map((row) => row.pid),
      ageSeconds: root.ageSeconds,
      cpuPercent: members.reduce((sum, row) => sum + row.cpuPercent, 0),
      threadId,
      threadTitle: threadId === null ? null : (threadTitles.get(threadId) ?? null),
      port,
    });
  }
  consumers.sort((a, b) => b.bytes - a.bytes);
  return consumers;
}

/** A label that says what the row is, not which binary happened to run it. */
function describe(root: ProcessRow, memberCount: number): string {
  const suffix = memberCount > 1 ? ` (${memberCount} processes)` : "";
  if (root.kind === "browser-automation") return `Headless browser${suffix}`;
  if (root.kind === "dev-server") {
    return `Dev server${root.port === null ? "" : ` on :${root.port}`}${suffix}`;
  }
  if (root.kind === "test-runner") return `Test runner${suffix}`;
  if (root.kind === "toolchain") return `${root.name} (build)${suffix}`;
  if (root.kind === "agent") return `Agent: ${root.name}${suffix}`;
  // BB's own processes are shared infrastructure, not the user's work. Saying
  // "node" made them look like an unexplained leak.
  if (root.kind === "bb") return `BB service${suffix}`;
  return `${root.name}${suffix}`;
}

/**
 * Regroup by BB thread rather than by process tree.
 *
 * This is the view no general-purpose monitor can offer, and it is the one
 * that makes an intervention actionable: "node is holding 3 GB" tells you
 * nothing you can act on, while "Fleet8 w4 — e2e FX and tax is holding 3 GB
 * across 5 processes" names a thread you can steer.
 */
export function groupByThread(
  consumers: Consumer[],
  threadTitles: Map<string, string>,
): Consumer[] {
  const byThread = new Map<string, Consumer[]>();
  for (const consumer of consumers) {
    if (consumer.threadId === null) continue;
    const list = byThread.get(consumer.threadId);
    if (list === undefined) byThread.set(consumer.threadId, [consumer]);
    else list.push(consumer);
  }

  const rows: Consumer[] = [];
  for (const [threadId, group] of byThread) {
    const bytes = group.reduce((sum, row) => sum + row.bytes, 0);
    const title = threadTitles.get(threadId) ?? threadId;
    rows.push({
      id: `thread:${threadId}`,
      label: title,
      detail: group
        .map((row) => `${row.label} ${formatBytes(row.bytes)}`)
        .slice(0, 4)
        .join(" · "),
      kind: group[0].kind,
      bytes,
      processCount: group.reduce((sum, row) => sum + row.processCount, 0),
      rootPid: group[0].rootPid,
      parentPid: group[0].parentPid,
      pids: group.flatMap((row) => row.pids),
      ageSeconds: Math.max(...group.map((row) => row.ageSeconds)),
      cpuPercent: group.reduce((sum, row) => sum + row.cpuPercent, 0),
      threadId,
      threadTitle: title,
      port: group.find((row) => row.port !== null)?.port ?? null,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows;
}

export function totalsByKind(
  consumers: Consumer[],
): Array<{ kind: ProcessKind; bytes: number; count: number }> {
  const totals = new Map<ProcessKind, { bytes: number; count: number }>();
  for (const consumer of consumers) {
    const current = totals.get(consumer.kind) ?? { bytes: 0, count: 0 };
    current.bytes += consumer.bytes;
    current.count += consumer.processCount;
    totals.set(consumer.kind, current);
  }
  return [...totals.entries()]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => b.bytes - a.bytes);
}
