/**
 * Proposing and performing relief.
 *
 * Two rules carry the whole safety model:
 *
 * 1. **`relieve` never accepts a PID.** It accepts ids that `buildPlan` minted,
 *    and re-derives the target from a freshly read process table. A caller —
 *    the panel, `bb ballast`, or an agent — cannot name a process Ballast did
 *    not already decide was fair game.
 * 2. **Authorization is re-checked at the moment of the kill, not when the
 *    plan was built.** A plan is a snapshot; by the time it is acted on the
 *    PID may have been recycled onto something precious. Every candidate is
 *    re-validated against the live table and the protected list immediately
 *    before a signal is sent, and a command line that no longer matches is a
 *    refusal rather than a kill.
 */
import { userInfo } from "node:os";
import type {
  Candidate,
  Consumer,
  Plan,
  ProcessKind,
  ProcessRow,
  ReliefItem,
  ReliefResult,
  Risk,
} from "./contract";
import { formatBytes, formatDuration } from "./format";

/**
 * The only kinds a `terminate` candidate may ever have.
 *
 * Absent from this list, and therefore unkillable by construction no matter
 * what any caller asks for: `agent` (someone's work in progress), `bb`
 * (the app running this code), `editor`, `browser` (the user's own windows),
 * `container` (killing Docker's VM loses every running container), `system`,
 * and `other` (unclassified means unknown means untouched).
 */
const KILLABLE_KINDS: ReadonlySet<ProcessKind> = new Set<ProcessKind>([
  "browser-automation",
  "dev-server",
  "test-runner",
  "toolchain",
]);

/**
 * Nothing that started in the last minute is a candidate.
 *
 * A process under a second old is very likely the thing the user just
 * launched, and a race between "the guard noticed pressure" and "the test
 * suite started" should always resolve in the suite's favour.
 */
const MIN_AGE_SECONDS = 60;

export interface RelieveConfig {
  /**
   * Ports whose listener is never a candidate. Empty by default.
   *
   * This is an exemption, not the safety model. An early version shipped a
   * default list of ports and treated anything outside it as a stray to be
   * killed — which encoded one machine's conventions as everyone's. Whether a
   * process is disposable is decided by whether anything is waiting on it; the
   * port list only ever takes candidates away.
   */
  protectedPorts: ReadonlySet<number>;
  /** Substrings that exempt a process from every candidate list. */
  exemptPatterns: readonly string[];
  /** A browser or server idle this long, at no CPU, is abandoned. */
  idleSeconds: number;
  /** Never propose terminating processes belonging to these threads. */
  protectedThreadIds: ReadonlySet<string>;
}

export interface Authorization {
  ok: boolean;
  refusal: string | null;
}

/**
 * The gate. Called once while planning (to mark rows `protected` so the panel
 * can show what was refused and why) and again at apply time against the live
 * table (where its answer is binding).
 */
export function authorize(
  consumer: Consumer,
  rows: readonly ProcessRow[],
  config: RelieveConfig,
  selfPids: ReadonlySet<number>,
): Authorization {
  if (!KILLABLE_KINDS.has(consumer.kind)) {
    return { ok: false, refusal: `${consumer.kind} processes are never terminated` };
  }
  if (consumer.threadId !== null && config.protectedThreadIds.has(consumer.threadId)) {
    return { ok: false, refusal: "belongs to a protected thread" };
  }
  if (consumer.port !== null && config.protectedPorts.has(consumer.port)) {
    return { ok: false, refusal: `:${consumer.port} is a protected port` };
  }

  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  for (const pid of consumer.pids) {
    if (selfPids.has(pid)) return { ok: false, refusal: "this is Ballast's own process tree" };
    const row = byPid.get(pid);
    // Gone already is not a refusal — the rest of the tree is still actionable.
    if (row === undefined) continue;
    if (row.user !== userInfo().username) {
      return { ok: false, refusal: `owned by ${row.user}, not the current user` };
    }
    if (row.ageSeconds < MIN_AGE_SECONDS) {
      return { ok: false, refusal: `started ${formatDuration(row.ageSeconds * 1000)} ago` };
    }
    for (const pattern of config.exemptPatterns) {
      if (pattern !== "" && row.command.includes(pattern)) {
        return { ok: false, refusal: `matches exempt pattern "${pattern}"` };
      }
    }
  }
  return { ok: true, refusal: null };
}

/**
 * Whether a consumer is disposable *right now*, as opposed to merely the kind
 * of thing that could be disposed of.
 *
 * One question decides it: **is anything still waiting on this?** Not which
 * port it is on, not which directory it was started from — those are local
 * conventions, and a rule built on them is a rule that only works on the
 * machine it was written for.
 *
 * Two kinds of evidence answer it. An *orphan* — reparented to init because
 * whatever launched it is gone — has no caller left to receive its result. An
 * *idle* process has burned no CPU for longer than the configured window,
 * which for a browser or a server means nothing is driving it. A Playwright
 * Chrome at 30% CPU is mid-assertion and killing it fails someone's test run;
 * the same browser at 0% for ten minutes is a leak from a suite that finished.
 *
 * A dev server that is merely idle is deliberately *not* safe. Idle is a dev
 * server's normal resting state between requests, and someone is probably
 * going to reload the page.
 */
function isOrphan(consumer: Consumer): boolean {
  return consumer.parentPid <= 1;
}

function isIdle(consumer: Consumer, config: RelieveConfig): boolean {
  return consumer.cpuPercent < 2 && consumer.ageSeconds > config.idleSeconds;
}

function isDisposable(consumer: Consumer, config: RelieveConfig): boolean {
  // Idle is only evidence of abandonment for a headless browser, whose whole
  // existence is a single test run: nothing drives one between suites, and a
  // driver that finished usually left it behind.
  //
  // For everything else, an alive parent means someone is holding the process
  // and idle means "waiting for its next request". A build tool sitting at 0%
  // is the normal state of a worker pool, not a corpse — grading that as safe
  // is how this plugin once killed BB's own esbuild service.
  if (consumer.kind === "browser-automation") return isOrphan(consumer) || isIdle(consumer, config);
  return isOrphan(consumer);
}

function rationaleFor(consumer: Consumer, config: RelieveConfig): string {
  if (isOrphan(consumer)) {
    return "orphaned — whatever started it is gone, so nothing is waiting on it";
  }
  const idle = `idle ${formatDuration(consumer.ageSeconds * 1000)} at ${consumer.cpuPercent.toFixed(0)}% CPU`;
  if (consumer.kind === "browser-automation") return `${idle} — a finished suite left it behind`;
  if (consumer.kind === "test-runner") return `${idle} — the run it belonged to is over`;
  return `${idle} — no longer doing work`;
}

export interface PlanInput {
  consumers: readonly Consumer[];
  threadConsumers: readonly Consumer[];
  rows: readonly ProcessRow[];
  config: RelieveConfig;
  selfPids: ReadonlySet<number>;
  /** Threads eligible for a `steer` candidate, largest first. */
  steerLimit: number;
}

export function buildPlan(input: PlanInput): Plan {
  const candidates: Candidate[] = [];

  for (const consumer of input.consumers) {
    const auth = authorize(consumer, input.rows, input.config, input.selfPids);
    if (!auth.ok) {
      // Only worth showing when the row is big enough that a reader would
      // otherwise wonder why Ballast is ignoring it.
      if (consumer.bytes > 512 * 1024 * 1024 && KILLABLE_KINDS.has(consumer.kind)) {
        candidates.push({
          id: `protected:${consumer.rootPid}`,
          action: "terminate",
          risk: "protected",
          label: consumer.label,
          rationale: auth.refusal ?? "refused",
          bytes: consumer.bytes,
          pids: consumer.pids,
          kind: consumer.kind,
          threadId: consumer.threadId,
          refusal: auth.refusal,
        });
      }
      continue;
    }

    const disposable = isDisposable(consumer, input.config);
    const risk: Risk = disposable ? "safe" : "disruptive";
    candidates.push({
      id: `kill:${consumer.rootPid}:${consumer.kind}`,
      action: "terminate",
      risk,
      label: consumer.label,
      rationale: disposable
        ? rationaleFor(consumer, input.config)
        : `${consumer.kind} still active — stopping it interrupts work in progress`,
      bytes: consumer.bytes,
      pids: consumer.pids,
      kind: consumer.kind,
      threadId: consumer.threadId,
      refusal: null,
    });
  }

  // Steering is always "disruptive": it costs the thread a turn and changes
  // what an agent does next. It is never bundled into an automatic safe sweep.
  for (const thread of input.threadConsumers.slice(0, input.steerLimit)) {
    if (thread.threadId === null) continue;
    candidates.push({
      id: `steer:${thread.threadId}`,
      action: "steer",
      risk: "disruptive",
      label: `Ask "${thread.label}" to wind down`,
      rationale: `holding ${formatBytes(thread.bytes)} across ${thread.processCount} processes`,
      bytes: thread.bytes,
      pids: thread.pids,
      kind: thread.kind,
      threadId: thread.threadId,
      refusal: null,
    });
  }

  candidates.sort((a, b) => {
    const rank: Record<Risk, number> = { safe: 0, disruptive: 1, protected: 2 };
    if (rank[a.risk] !== rank[b.risk]) return rank[a.risk] - rank[b.risk];
    return b.bytes - a.bytes;
  });

  return {
    builtAtMs: Date.now(),
    candidates,
    safeBytes: candidates
      .filter((row) => row.risk === "safe" && row.action === "terminate")
      .reduce((sum, row) => sum + row.bytes, 0),
    disruptiveBytes: candidates
      .filter((row) => row.risk === "disruptive" && row.action === "terminate")
      .reduce((sum, row) => sum + row.bytes, 0),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop a process tree politely, then insistently.
 *
 * Children first so a supervisor does not respawn what was just stopped, and
 * SIGTERM before SIGKILL so a dev server gets to close its sockets and a test
 * runner gets to flush its output. Five seconds is long enough for anything
 * that handles the signal and short enough that a guard under real pressure is
 * not still waiting when the next sample lands.
 */
async function stopTree(pids: readonly number[], log: (message: string) => void): Promise<number> {
  const ordered = [...pids].sort((a, b) => b - a);
  let signalled = 0;
  for (const pid of ordered) {
    try {
      process.kill(pid, "SIGTERM");
      signalled += 1;
    } catch {
      // Already gone between planning and now. Nothing to do.
    }
  }
  if (signalled === 0) return 0;

  await sleep(5000);

  let survivors = 0;
  for (const pid of ordered) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      survivors += 1;
    } catch {
      // Exited on SIGTERM, which is the outcome we wanted.
    }
  }
  if (survivors > 0) log(`${survivors} of ${signalled} processes needed SIGKILL`);
  return signalled;
}

export interface RelieveInput {
  candidates: readonly Candidate[];
  rows: readonly ProcessRow[];
  consumers: readonly Consumer[];
  config: RelieveConfig;
  selfPids: ReadonlySet<number>;
  dryRun: boolean;
  log: (message: string) => void;
  steer: (threadId: string, message: string) => Promise<void>;
}

export async function applyRelief(input: RelieveInput): Promise<ReliefResult> {
  const items: ReliefItem[] = [];
  let bytesFreed = 0;

  const liveByPid = new Map(input.rows.map((row) => [row.pid, row] as const));
  const consumerByPid = new Map(input.consumers.map((row) => [row.rootPid, row] as const));

  for (const candidate of input.candidates) {
    if (candidate.action === "steer") {
      if (candidate.threadId === null) {
        items.push({ ...base(candidate), ok: false, detail: "no thread to steer" });
        continue;
      }
      if (input.dryRun) {
        items.push({ ...base(candidate), ok: true, detail: "would steer this thread" });
        continue;
      }
      try {
        await input.steer(
          candidate.threadId,
          [
            `Ballast: this machine is under memory pressure and this thread is holding ${formatBytes(candidate.bytes)} across ${candidate.pids.length} processes.`,
            "Before your next step, release what you can: stop any dev server you started, close Playwright browsers and contexts, and let long-running build watchers exit.",
            "Do not stop work — just free the memory you are not actively using, then carry on.",
          ].join(" "),
        );
        items.push({ ...base(candidate), ok: true, detail: "steered" });
      } catch (cause) {
        items.push({
          ...base(candidate),
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
      continue;
    }

    if (candidate.action !== "terminate") {
      items.push({ ...base(candidate), ok: false, detail: `${candidate.action} is not applied here` });
      continue;
    }

    // Re-authorize against the live table. This is the check that matters:
    // the plan may be minutes old and PIDs get recycled.
    const consumer = consumerByPid.get(candidate.pids[0] ?? -1) ?? null;
    const live = rebuildConsumer(candidate, input.rows, consumer);
    if (live === null) {
      items.push({ ...base(candidate), ok: true, bytes: 0, detail: "already gone" });
      continue;
    }
    const auth = authorize(live, input.rows, input.config, input.selfPids);
    if (!auth.ok) {
      items.push({ ...base(candidate), ok: false, detail: `refused: ${auth.refusal}` });
      continue;
    }

    const present = live.pids.filter((pid) => liveByPid.has(pid));
    if (input.dryRun) {
      items.push({
        ...base(candidate),
        ok: true,
        bytes: live.bytes,
        detail: `would stop ${present.length} processes`,
      });
      bytesFreed += live.bytes;
      continue;
    }

    try {
      const signalled = await stopTree(present, input.log);
      bytesFreed += live.bytes;
      input.log(`stopped ${live.label} (${formatBytes(live.bytes)}, ${signalled} processes)`);
      items.push({
        ...base(candidate),
        ok: true,
        bytes: live.bytes,
        detail: `stopped ${signalled} processes`,
      });
    } catch (cause) {
      items.push({
        ...base(candidate),
        ok: false,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return {
    dryRun: input.dryRun,
    succeeded: items.filter((row) => row.ok).length,
    failed: items.filter((row) => !row.ok).length,
    bytesFreed,
    items,
  };
}

function base(candidate: Candidate): Omit<ReliefItem, "ok" | "detail"> {
  return { id: candidate.id, label: candidate.label, bytes: candidate.bytes };
}

/**
 * Re-derive a candidate's target from the live table.
 *
 * The planned PID list is treated as a *claim*, not an instruction: a PID that
 * now hosts a different command than the one planned is dropped, because that
 * is exactly what PID reuse looks like. If the root itself is gone or has been
 * reused, the whole candidate is refused.
 */
function rebuildConsumer(
  candidate: Candidate,
  rows: readonly ProcessRow[],
  planned: Consumer | null,
): Consumer | null {
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  const rootPid = candidate.pids[0] ?? -1;
  const root = byPid.get(rootPid);
  if (root === undefined) return null;
  if (root.kind !== candidate.kind) return null;
  if (planned !== null && !planned.detail.startsWith(root.command.slice(0, 40))) return null;

  const pids = candidate.pids.filter((pid) => {
    const row = byPid.get(pid);
    return row !== undefined && row.kind === candidate.kind;
  });
  if (pids.length === 0) return null;

  const bytes = pids.reduce((sum, pid) => sum + (byPid.get(pid)?.rssBytes ?? 0), 0);
  return {
    id: candidate.id,
    label: candidate.label,
    detail: root.command,
    kind: root.kind,
    bytes,
    processCount: pids.length,
    rootPid,
    parentPid: root.ppid,
    pids,
    ageSeconds: root.ageSeconds,
    cpuPercent: pids.reduce((sum, pid) => sum + (byPid.get(pid)?.cpuPercent ?? 0), 0),
    threadId: root.threadId,
    threadTitle: null,
    port: root.port,
  };
}
