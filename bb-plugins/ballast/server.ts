/**
 * Ballast — backend.
 *
 * Structure mirrors the shape of the problem:
 *
 *   sample  →  grade  →  attribute  →  plan  →  intervene
 *
 * `sample` and `grade` live in lib/memory and lib/pressure; `attribute` in
 * lib/procs; `plan` and `intervene` in lib/relieve. What is left here is the
 * wiring: a background service that runs the loop, the escalation ladder that
 * decides how far to go, and the three faces the result wears — RPC for the
 * panel, tools for agents, and a CLI.
 *
 * The ladder is the interesting part. It climbs in order of what an action
 * costs: throttle (reversible, loses nothing) → steer (costs a turn) →
 * relieve (kills disposable processes) → escalate (hands the problem to an
 * agent). Each rung is independently switchable, and each has its own cooldown
 * so a machine that sits at critical for an hour does not get forty threads
 * spawned at it.
 */
import { exec } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rpcShape,
  projectDiskInputSchema,
  type Candidate,
  type Config as PanelConfig,
  type Consumer,
  type GuardEvent,
  type Overview,
  type Plan,
  type Pressure,
  type PressureLevel,
  type ProcessRow,
  type Thresholds,
} from "./lib/contract";
import { sampleMemory, type RateCursor } from "./lib/memory";
import { readDisk, renderDisk } from "./lib/disk";
import { readProjectDisk, renderProjectDisk } from "./lib/project-disk";
import { DEFAULT_THRESHOLDS, evaluatePressure, usedFraction } from "./lib/pressure";
import { groupByThread, groupConsumers, readProcesses, totalsByKind } from "./lib/procs";
import { attributeThreads, readAgentThreads } from "./lib/attribution";
import { applyRelief, buildPlan, type RelieveConfig } from "./lib/relieve";
import { Store, MIGRATIONS } from "./lib/store";
import { cadenceMs, parseLines, parsePorts } from "./lib/policy";
import {
  ellipsize,
  formatBytes,
  formatLocalStamp,
  formatPercent,
  formatRate,
  padBytes,
} from "./lib/format";
import { levelLabel } from "./lib/ui";

export const rpcContract = defineRpcContract(rpcShape);

const run = promisify(exec);

const CHANNEL_PRESSURE = "pressure";
const CHANNEL_PLAN = "plan";

/** Long enough that a machine pinned at critical does not spawn a thread a minute. */
const ESCALATION_COOLDOWN_MS = 20 * 60_000;
const RELIEF_COOLDOWN_MS = 2 * 60_000;
const STEER_COOLDOWN_MS = 10 * 60_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

interface Config {
  thresholds: Thresholds;
  sampleSeconds: number;
  relieve: RelieveConfig;
  autoRelieve: "off" | "safe" | "aggressive";
  throttleFleet: boolean;
  throttleLimit: number;
  steerThreads: boolean;
  agentEscalation: boolean;
  escalationProjectId: string | null;
}

/* ------------------------------------------------------------------ */
/* Rendering — shared by the CLI and the agent tools                   */
/* ------------------------------------------------------------------ */

function renderPressure(pressure: Pressure): string {
  const { sample } = pressure;
  const lines = [
    `Memory pressure: ${levelLabel(pressure.level).toUpperCase()} — ${pressure.reason}`,
    `  Total      ${padBytes(sample.totalBytes)}`,
    `  Used       ${padBytes(sample.usedBytes)}  (${formatPercent(usedFraction(sample), 1)})`,
    `    app      ${padBytes(sample.appBytes)}`,
    `    wired    ${padBytes(sample.wiredBytes)}`,
    `    compressed ${padBytes(sample.compressedBytes)}` +
      (sample.compressionRatio > 1 ? `  (${sample.compressionRatio.toFixed(1)}x)` : ""),
    `  Cached     ${padBytes(sample.cachedFileBytes)}  (reclaimable for free)`,
    `  Headroom   ${padBytes(sample.headroomBytes)}  before the machine has to page`,
    `  Swap       ${padBytes(sample.swapUsedBytes)} of ${formatBytes(sample.swapTotalBytes)}` +
      (sample.swapInRate > 0 ? `  paging in ${formatRate(sample.swapInRate)}` : ""),
  ];
  if (pressure.signals.length > 1) {
    lines.push("  Signals:");
    for (const signal of pressure.signals) {
      lines.push(`    ${signal.level.padEnd(8)} ${signal.detail}`);
    }
  }
  return lines.join("\n");
}

function renderConsumers(title: string, consumers: readonly Consumer[], limit = 15): string {
  if (consumers.length === 0) return `${title}: nothing above the reporting floor.`;
  const lines = [`${title}:`];
  for (const consumer of consumers.slice(0, limit)) {
    const thread = consumer.threadTitle === null ? "" : `  [${ellipsize(consumer.threadTitle, 38)}]`;
    lines.push(
      `  ${padBytes(consumer.bytes)}  ${consumer.label.padEnd(30)} ` +
        `pid ${String(consumer.rootPid).padEnd(7)}${thread}`,
    );
  }
  return lines.join("\n");
}

function renderPlan(plan: Plan, options?: { verbose?: boolean }): string {
  const actionable = plan.candidates.filter((row) => row.risk !== "protected");
  if (actionable.length === 0) {
    return "Relief plan: nothing to do — no disposable processes and no thread worth steering.";
  }
  const lines = [
    `Relief plan: ${formatBytes(plan.safeBytes)} from safe candidates, ` +
      `${formatBytes(plan.disruptiveBytes)} more if you accept disruption.`,
  ];
  for (const candidate of plan.candidates) {
    if (candidate.risk === "protected" && options?.verbose !== true) continue;
    const size = candidate.action === "terminate" ? padBytes(candidate.bytes) : "        —";
    lines.push(`  ${size}  ${candidate.risk.padEnd(11)} ${candidate.id}`);
    lines.push(`             ${candidate.label} — ${candidate.rationale}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);

  const settings = bb.settings.define({
    watchPercent: { type: "number", label: "Watch at (% of memory used)", default: DEFAULT_THRESHOLDS.watchPercent },
    warnPercent: { type: "number", label: "Warn at (% of memory used)", default: DEFAULT_THRESHOLDS.warnPercent },
    criticalPercent: { type: "number", label: "Critical at (% of memory used)", default: DEFAULT_THRESHOLDS.criticalPercent },
    minHeadroomGb: {
      type: "number",
      label: "Minimum headroom (GB)",
      default: DEFAULT_THRESHOLDS.minHeadroomGb,
    },
    swapRateMbPerMin: {
      type: "number",
      label: "Warn when paging in more than (MB/min)",
      default: DEFAULT_THRESHOLDS.swapRateMbPerMin,
    },
    sampleSeconds: { type: "number", label: "Sample every (seconds)", default: 10 },
    /**
     * Off by default, and it earned that.
     *
     * This shipped as "safe" and the first thing it did on a real machine was
     * terminate BB's own `esbuild --service` for idling at 0% CPU. The rule is
     * fixed and covered by tests, but a plugin that stops processes has to be
     * switched on deliberately: the cost of a wrong classification is someone
     * else's tooling, and nobody installs a memory monitor expecting it to
     * start killing things before they have looked at it once.
     */
    autoRelieve: {
      type: "select",
      label: "Automatically stop processes under pressure",
      options: ["off", "safe", "aggressive"],
      default: "off",
    },
    // Empty by default, and it must stay that way. A shipped port list is one
    // machine's conventions imposed on everyone else's.
    protectedPorts: {
      type: "string",
      label: "Ports to never touch (e.g. 3000, 8080-8090)",
      default: "",
    },
    exemptPatterns: {
      type: "string",
      label: "Never touch processes matching (one per line)",
      experimental_multiline: true,
      default: "",
    },
    idleMinutes: {
      type: "number",
      label: "Counts as idle after (minutes at no CPU)",
      default: 10,
    },
    throttleFleet: {
      type: "boolean",
      label: "Throttle BB concurrency before stopping anything",
      default: false,
    },
    throttleLimit: { type: "number", label: "Throttled concurrency limit", default: 6 },
    steerThreads: {
      type: "boolean",
      label: "Ask the hungriest threads to release memory",
      default: false,
    },
    /**
     * Off by default, like every other rung.
     *
     * Escalation destroys nothing, but it spawns a thread and spends tokens,
     * and doing that uninvited on a machine someone just installed a memory
     * monitor on is its own kind of surprise. It also cannot work until an
     * escalation project is chosen, so defaulting it on mostly produced a
     * banner and a log line saying it had been suppressed.
     */
    agentEscalation: {
      type: "boolean",
      label: "Hand the problem to an agent when critical",
      default: false,
    },
    escalationProject: { type: "project", label: "Project for escalation threads" },
  });

  async function readConfig(): Promise<Config> {
    const values = await settings.get();
    return {
      thresholds: {
        watchPercent: values.watchPercent,
        warnPercent: values.warnPercent,
        criticalPercent: values.criticalPercent,
        minHeadroomGb: values.minHeadroomGb,
        swapRateMbPerMin: values.swapRateMbPerMin,
      },
      sampleSeconds: Math.min(300, Math.max(5, values.sampleSeconds)),
      relieve: {
        protectedPorts: parsePorts(values.protectedPorts),
        exemptPatterns: parseLines(values.exemptPatterns),
        idleSeconds: Math.max(60, values.idleMinutes * 60),
        protectedThreadIds: new Set<string>(),
      },
      autoRelieve:
        values.autoRelieve === "aggressive"
          ? "aggressive"
          : values.autoRelieve === "off"
            ? "off"
            : "safe",
      throttleFleet: values.throttleFleet,
      throttleLimit: Math.max(1, values.throttleLimit),
      steerThreads: values.steerThreads,
      agentEscalation: values.agentEscalation,
      escalationProjectId:
        typeof values.escalationProject === "string" && values.escalationProject !== ""
          ? values.escalationProject
          : null,
    };
  }

  /* ---------------- sampling ---------------- */

  let cursor: RateCursor | null = null;
  /**
   * Last reading, kept in memory for `contributeInstructions`.
   *
   * That callback is synchronous and runs on every thread start and turn
   * submit, so it cannot shell out to `vm_stat`. The guard already samples on a
   * timer; this makes its most recent answer readable without blocking a turn.
   */
  let lastPressure: Pressure | null = null;

  /**
   * Recent paging rates, for smoothing.
   *
   * Paging is bursty: a single ten-second delta swings between zero and
   * gigabytes-per-minute while the machine does one large read, and grading
   * that raw made the level flap between warn and critical every sample and
   * fill the activity log with transitions that described nothing. Averaging
   * the last few samples reports the trend, which is what the threshold is
   * really about.
   */
  const RATE_WINDOW = 3;
  const recentSwapIn: number[] = [];
  const recentSwapOut: number[] = [];

  function smooth(window: number[], value: number): number {
    window.push(value);
    if (window.length > RATE_WINDOW) window.shift();
    return window.reduce((sum, entry) => sum + entry, 0) / window.length;
  }

  async function readPressure(config: Config, maxAgeMs = 0): Promise<Pressure> {
    // Serving a recent reading is not just a saving. Rates are deltas between
    // consecutive samples, so an extra out-of-band read — the sidebar chip
    // refreshing, say — would move the cursor forward and compute the paging
    // rate over a two-second window instead of the guard's interval, which is
    // where the worst of the spurious spikes came from.
    if (lastPressure !== null && Date.now() - lastPressure.sample.atMs < maxAgeMs) {
      return lastPressure;
    }
    const { sample, cursor: next } = await sampleMemory(cursor);
    cursor = next;
    const smoothed = {
      ...sample,
      swapInRate: smooth(recentSwapIn, sample.swapInRate),
      swapOutRate: smooth(recentSwapOut, sample.swapOutRate),
    };
    const pressure = evaluatePressure(smoothed, config.thresholds);
    lastPressure = pressure;
    return pressure;
  }

  /**
   * Thread titles, for attribution — cached, because this is the expensive call.
   *
   * Listing threads goes over the SDK and returns every thread BB knows about;
   * on a machine that has run a few fleets that is a thousand rows. Thread
   * titles and worktree paths change on the order of minutes, and a name in a
   * label being a minute stale costs nothing, so this is cached well past the
   * sampling interval. Running it every ten seconds — which the first version
   * did — made the memory monitor one of the more expensive things on the
   * machine.
   */
  const THREAD_CACHE_MS = 120_000;
  let threadCache: {
    at: number;
    titles: Map<string, string>;
    pathsByThread: Array<{ threadId: string; path: string }>;
  } | null = null;

  async function readThreadTitles(): Promise<NonNullable<typeof threadCache>> {
    if (threadCache !== null && Date.now() - threadCache.at < THREAD_CACHE_MS) return threadCache;
    const titles = new Map<string, string>();
    const pathsByThread: Array<{ threadId: string; path: string }> = [];
    try {
      const threads = await bb.sdk.threads.list({ includeHidden: true });
      for (const thread of threads) {
        const title = thread.title ?? thread.titleFallback ?? thread.id;
        titles.set(thread.id, title);
        const path = thread.environmentPath;
        if (typeof path === "string" && path !== "") {
          pathsByThread.push({ threadId: thread.id, path });
        }
      }
    } catch (cause) {
      bb.log.warn(`could not list threads: ${cause instanceof Error ? cause.message : cause}`);
      // Serve the last good mapping rather than losing every label.
      if (threadCache !== null) return threadCache;
    }
    threadCache = { at: Date.now(), titles, pathsByThread };
    return threadCache;
  }


  /**
   * Ballast's own process tree: this process and its ancestors, and nothing else.
   *
   * Ancestors only, emphatically. The plugin runs inside the BB server, so
   * `process.pid` is the server — and *every* process any thread starts is a
   * descendant of it. An earlier version closed over descendants as well,
   * which protected the entire fleet from the plugin whose whole purpose is to
   * reclaim from the fleet: the plan came back with zero candidates and a
   * headless browser refused as "Ballast's own process tree".
   *
   * Nothing is lost by narrowing it. The processes Ballast itself spawns are
   * `ps` and `vm_stat`, which exit in milliseconds and are excluded by the
   * minimum-age rule long before they could be selected, and the BB app is
   * already unkillable by kind.
   */
  function selfPids(rows: readonly ProcessRow[]): Set<number> {
    const byPid = new Map(rows.map((row) => [row.pid, row] as const));
    const pids = new Set<number>([process.pid]);
    let current = byPid.get(process.pid);
    while (current !== undefined && current.ppid > 1 && !pids.has(current.ppid)) {
      pids.add(current.ppid);
      current = byPid.get(current.ppid);
    }
    return pids;
  }

  interface Snapshot {
    pressure: Pressure;
    rows: ProcessRow[];
    consumers: Consumer[];
    threads: Consumer[];
    selfPids: Set<number>;
    titles: Map<string, string>;
  }

  /**
   * The expensive half of the loop, cached and de-duplicated.
   *
   * Reading and classifying the process table costs orders of magnitude more
   * than reading memory totals does, and a panel render fires `overview`,
   * `plan` and `pressure` within the same second. Without this, that is three
   * full `ps` invocations and three passes over a thousand processes to draw
   * one screen.
   *
   * `inFlight` matters as much as the TTL: concurrent callers join the
   * snapshot already running instead of starting their own.
   */
  const SNAPSHOT_TTL_MS = 4000;
  let snapshotCache: { at: number; value: Snapshot } | null = null;
  let snapshotInFlight: Promise<Snapshot> | null = null;

  async function snapshot(config: Config, maxAgeMs = SNAPSHOT_TTL_MS): Promise<Snapshot> {
    if (snapshotCache !== null && Date.now() - snapshotCache.at < maxAgeMs) {
      return snapshotCache.value;
    }
    if (snapshotInFlight !== null) return snapshotInFlight;

    snapshotInFlight = (async () => {
      const [pressure, rawRows, { titles, pathsByThread }] = await Promise.all([
        readPressure(config),
        readProcesses(),
        readThreadTitles(),
      ]);
      const rows = attributeThreads(rawRows, pathsByThread, await readAgentThreads(rawRows));
      const consumers = groupConsumers(rows, titles);
      const value: Snapshot = {
        pressure,
        rows,
        consumers,
        threads: groupByThread(consumers, titles),
        selfPids: selfPids(rows),
        titles,
      };
      snapshotCache = { at: Date.now(), value };
      return value;
    })();

    try {
      return await snapshotInFlight;
    } finally {
      snapshotInFlight = null;
    }
  }

  /** Force the next snapshot to be real — after a kill, the table has changed. */
  function invalidateSnapshot(): void {
    snapshotCache = null;
  }

  /* ---------------- plan ---------------- */

  let cachedPlan: Plan | null = null;
  let cachedCandidates = new Map<string, Candidate>();

  async function makePlan(config: Config, snap?: Snapshot): Promise<{ plan: Plan; snap: Snapshot }> {
    const current = snap ?? (await snapshot(config));
    const plan = buildPlan({
      consumers: current.consumers,
      threadConsumers: current.threads,
      rows: current.rows,
      config: config.relieve,
      selfPids: current.selfPids,
      steerLimit: 3,
    });
    cachedPlan = plan;
    cachedCandidates = new Map(plan.candidates.map((row) => [row.id, row] as const));
    bb.realtime.publish(CHANNEL_PLAN, { at: Date.now() });
    return { plan, snap: current };
  }

  /**
   * Nudge a thread that is running right now — and nothing else.
   *
   * Two rules, both learned the hard way. A message must never land in the
   * human composer inbox: that queue is for a person, it waits until the
   * thread is free, and a note about memory pressure read twenty minutes late
   * is noise addressed to the wrong reader. And an idle thread is not the one
   * allocating, so there is nothing to ask it for.
   *
   * So the running set is checked first and the mode is plain `steer`. A
   * thread that is not running is skipped, not queued.
   */
  async function steerThread(threadId: string, message: string): Promise<void> {
    const running = await bb.sdk.threads.listRunning().catch(() => []);
    if (!running.some((row) => row.id === threadId)) {
      throw new Error("thread is not running — skipped rather than queued to the inbox");
    }
    await bb.sdk.threads.send({
      threadId,
      mode: "steer",
      input: [{ type: "text", text: message, mentions: [] }],
    });
  }

  async function runRelief(
    config: Config,
    ids: readonly string[],
    dryRun: boolean,
  ): Promise<ReturnType<typeof applyRelief>> {
    // Re-authorization has to see the table as it is now, not as the plan
    // remembered it — that is the entire point of the second check.
    const snap = await snapshot(config, 0);
    const candidates = ids
      .map((id) => cachedCandidates.get(id))
      .filter((row): row is Candidate => row !== undefined);
    if (!dryRun) invalidateSnapshot();
    return applyRelief({
      candidates,
      rows: snap.rows,
      consumers: snap.consumers,
      config: config.relieve,
      selfPids: snap.selfPids,
      dryRun,
      log: (message) => bb.log.info(`relieve: ${message}`),
      steer: steerThread,
    });
  }

  /* ---------------- the throttle rung ---------------- */

  /**
   * Stop the bleeding before treating the wound.
   *
   * Lowering BB's host concurrency does not free a single byte, but it stops
   * new threads from starting and allocating more, which is the only
   * intervention here that costs nothing and loses nothing. The previous limit
   * is stored so it can be put back when pressure clears — a throttle nobody
   * remembers to lift is just a slower machine.
   */
  async function throttle(config: Config): Promise<{ ok: boolean; message: string }> {
    try {
      const status = await run("bb concurrency-limit status --json", { timeout: 15_000 });
      const parsed = JSON.parse(status.stdout) as {
        hosts?: Array<{ id: string; effectiveLimit: number; override: number | null }>;
      };
      const host = parsed.hosts?.[0];
      if (host === undefined) return { ok: false, message: "no host reported a concurrency limit" };
      if (host.effectiveLimit <= config.throttleLimit) {
        return { ok: false, message: `concurrency is already ${host.effectiveLimit}` };
      }
      if (store.getMeta<number>("throttle-previous") === null) {
        store.setMeta("throttle-previous", host.override ?? host.effectiveLimit);
        store.setMeta("throttle-host", host.id);
      }
      await run(`bb concurrency-limit host ${host.id} ${config.throttleLimit}`, { timeout: 15_000 });
      return {
        ok: true,
        message: `concurrency ${host.effectiveLimit} → ${config.throttleLimit}; no new threads will start`,
      };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function restoreThrottle(): Promise<{ ok: boolean; message: string }> {
    const previous = store.getMeta<number>("throttle-previous");
    const host = store.getMeta<string>("throttle-host");
    if (previous === null || host === null) return { ok: false, message: "nothing to restore" };
    try {
      await run(`bb concurrency-limit host ${host} ${previous}`, { timeout: 15_000 });
      store.deleteMeta("throttle-previous");
      store.deleteMeta("throttle-host");
      return { ok: true, message: `concurrency restored to ${previous}` };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /* ---------------- the escalation rung ---------------- */

  async function escalate(
    config: Config,
    snap: Snapshot,
    note?: string,
  ): Promise<{ threadId: string | null; started: boolean; message: string }> {
    if (config.escalationProjectId === null) {
      return {
        threadId: null,
        started: false,
        message: "Set an escalation project in Ballast's settings first.",
      };
    }
    const { plan } = await makePlan(config, snap);

    /**
     * Do not spawn an agent that has nothing to do.
     *
     * The guard escalated twice on this machine with "0 B safe to reclaim" and
     * no thread worth steering. There was no action available to it, so the
     * thread could only report back or ask a question — which is the one thing
     * an unattended escalation must never do. Pressure with no remedy is a
     * fact for the activity log, not a reason to start an agent.
     */
    const actionable = plan.candidates.filter((row) => row.risk !== "protected");
    if (actionable.length === 0) {
      return {
        threadId: null,
        started: false,
        message:
          "Nothing actionable: no disposable processes and no running thread to ask. " +
          "Logged the pressure instead of starting an agent that could only report it.",
      };
    }

    const prompt = [
      "This machine is out of memory and needs a decision that a fixed rule cannot make.",
      "",
      renderPressure(snap.pressure),
      "",
      renderConsumers("Largest consumers", snap.consumers, 12),
      "",
      renderConsumers("By BB thread", snap.threads, 8),
      "",
      renderPlan(plan, { verbose: true }),
      "",
      note === undefined || note.trim() === "" ? "" : `Operator note: ${note.trim()}`,
      "",
      "**Work autonomously and finish in one turn. Do not ask the user anything.**",
      "Nobody is waiting at the keyboard — this thread was started by a background guard because the",
      "machine was already paging. A question here does not get answered; it just leaves the machine",
      "in trouble with a thread parked on a prompt. If you are unsure whether an action is warranted,",
      "the answer is to not take it and to say so in your summary.",
      "",
      "Work in this order:",
      "1. `ballast_status` for the current numbers — they will have moved since this prompt was written.",
      "2. `ballast_plan` for candidates and their ids.",
      "3. `ballast_relieve` with `dryRun: true` on the `safe` ids, check the total, then apply them.",
      "4. Prefer asking a thread over killing its processes. The plan's `steer:` candidates do this",
      "   through `ballast_relieve` — that routes to threads that are running right now and never",
      "   queues. Do **not** use `bb thread tell` or `bb thread queue`: those can land in the user's",
      "   composer inbox, where a memory warning is read long after it mattered, by the wrong reader.",
      "5. Leave `disruptive` candidates alone unless nothing else gets headroom above the threshold.",
      "   If you take one, say which and why.",
      "",
      "Ballast only ever signals processes it classified as disposable, and never agents, editors,",
      "browsers, containers or anything it could not identify. Do not use `kill` directly to work",
      "around that boundary, and do not change Ballast's settings to widen it.",
      "",
      "Finish with a short summary: what you freed, how much headroom came back, what you chose not",
      "to touch, and what a human should decide later. Then stop — do not poll or wait.",
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    try {
      const thread = await bb.sdk.threads.spawn({
        projectId: config.escalationProjectId,
        environment: { type: "project-default" },
        prompt,
        // Nobody is at the keyboard. A thread that stops on an approval prompt
        // is worse than no thread at all: the machine stays in trouble and a
        // parked prompt is the only evidence. The blast radius is bounded by
        // Ballast's own gate rather than by per-call approvals — relieve takes
        // only ids the plan minted and re-checks them against the live table.
        permissionMode: "full",
        title: `Memory pressure — ${formatBytes(snap.pressure.sample.headroomBytes)} headroom`,
      });
      return {
        threadId: thread.id,
        started: true,
        message: `Started a thread to work the problem (${formatBytes(plan.safeBytes)} safe to reclaim).`,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.error(`escalation failed: ${message}`);
      return { threadId: null, started: false, message: `Could not start a thread: ${message}` };
    }
  }

  /* ---------------- overview ---------------- */

  async function buildOverview(): Promise<Overview> {
    const config = await readConfig();
    const snap = await snapshot(config);
    const { plan } = await makePlan(config, snap);
    return {
      pressure: snap.pressure,
      consumers: snap.consumers.slice(0, 40),
      threads: snap.threads.slice(0, 20),
      byKind: totalsByKind(snap.consumers),
      history: store.history(),
      events: store.events(40),
      plan,
      escalationUnconfigured: config.agentEscalation && config.escalationProjectId === null,
      hostname: hostname(),
    };
  }

  function record(
    pressure: Pressure,
    action: GuardEvent["action"],
    detail: string,
    bytesFreed = 0,
    threadId: string | null = null,
  ): void {
    store.recordGuardEvent({
      atMs: Date.now(),
      level: pressure.level,
      headroomBytes: pressure.sample.headroomBytes,
      usedFraction: usedFraction(pressure.sample),
      action,
      detail,
      bytesFreed,
      threadId,
    });
  }

  /* ---------------- RPC ---------------- */

  /** The settings the panel edits, in the shape the panel shows them. */
  async function readPanelConfig(): Promise<PanelConfig> {
    const values = await settings.get();
    return {
      thresholds: {
        watchPercent: values.watchPercent,
        warnPercent: values.warnPercent,
        criticalPercent: values.criticalPercent,
        minHeadroomGb: values.minHeadroomGb,
        swapRateMbPerMin: values.swapRateMbPerMin,
      },
      sampleSeconds: values.sampleSeconds,
      protectedPorts: values.protectedPorts,
      exemptPatterns: values.exemptPatterns,
      idleMinutes: values.idleMinutes,
      autoRelieve:
        values.autoRelieve === "aggressive"
          ? "aggressive"
          : values.autoRelieve === "off"
            ? "off"
            : "safe",
      throttleFleet: values.throttleFleet,
      throttleLimit: values.throttleLimit,
      steerThreads: values.steerThreads,
      agentEscalation: values.agentEscalation,
      escalationProjectId:
        typeof values.escalationProject === "string" && values.escalationProject !== ""
          ? values.escalationProject
          : null,
      throttledFrom: store.getMeta<number>("throttle-previous"),
    };
  }

  bb.rpc.register(rpcContract, {
    config: () => readPanelConfig(),
    async configSet(patch) {
      await settings.experimental_set({
        ...(patch.thresholds?.watchPercent === undefined
          ? {}
          : { watchPercent: patch.thresholds.watchPercent }),
        ...(patch.thresholds?.warnPercent === undefined
          ? {}
          : { warnPercent: patch.thresholds.warnPercent }),
        ...(patch.thresholds?.criticalPercent === undefined
          ? {}
          : { criticalPercent: patch.thresholds.criticalPercent }),
        ...(patch.thresholds?.minHeadroomGb === undefined
          ? {}
          : { minHeadroomGb: patch.thresholds.minHeadroomGb }),
        ...(patch.thresholds?.swapRateMbPerMin === undefined
          ? {}
          : { swapRateMbPerMin: patch.thresholds.swapRateMbPerMin }),
        ...(patch.sampleSeconds === undefined ? {} : { sampleSeconds: patch.sampleSeconds }),
        ...(patch.protectedPorts === undefined ? {} : { protectedPorts: patch.protectedPorts }),
        ...(patch.exemptPatterns === undefined ? {} : { exemptPatterns: patch.exemptPatterns }),
        ...(patch.idleMinutes === undefined ? {} : { idleMinutes: patch.idleMinutes }),
        ...(patch.autoRelieve === undefined ? {} : { autoRelieve: patch.autoRelieve }),
        ...(patch.throttleFleet === undefined ? {} : { throttleFleet: patch.throttleFleet }),
        ...(patch.throttleLimit === undefined ? {} : { throttleLimit: patch.throttleLimit }),
        ...(patch.steerThreads === undefined ? {} : { steerThreads: patch.steerThreads }),
        ...(patch.agentEscalation === undefined ? {} : { agentEscalation: patch.agentEscalation }),
        ...(patch.escalationProjectId === undefined
          ? {}
          : { escalationProject: patch.escalationProjectId }),
      });
      // Ports, patterns and the idle window all change what counts as a
      // candidate, so the cached plan no longer describes the settings the
      // user is looking at.
      cachedPlan = null;
      return readPanelConfig();
    },
    async projects() {
      const rows = await bb.sdk.projects.list({ includePersonal: true });
      return { projects: rows.map((row) => ({ id: row.id, name: row.name })) };
    },
    overview: () => buildOverview(),
    disk: () => readDisk(),
    diskProjects: (input) => readProjectDisk(bb, input),
    // The sidebar chip and the homepage tile both call this on a timer. Neither
    // needs a fresher answer than the guard already has.
    pressure: async () => readPressure(await readConfig(), 5000),
    async plan({ force }) {
      const config = await readConfig();
      if (cachedPlan !== null && force !== true && Date.now() - cachedPlan.builtAtMs < 15_000) {
        return cachedPlan;
      }
      const { plan } = await makePlan(config);
      return plan;
    },
    async relieve({ ids, dryRun }) {
      const config = await readConfig();
      const result = await runRelief(config, ids, dryRun);
      if (!dryRun && result.bytesFreed > 0) {
        bb.realtime.publish(CHANNEL_PRESSURE, { at: Date.now(), reason: "relieved" });
      }
      return result;
    },
    async escalate({ note }) {
      const config = await readConfig();
      const snap = await snapshot(config);
      const result = await escalate(config, snap, note);
      record(
        snap.pressure,
        result.started ? "escalated" : "suppressed",
        result.message,
        0,
        result.threadId,
      );
      return result;
    },
    restoreThrottle: () => restoreThrottle(),
  });

  /* ---------------- the guard ---------------- */

  bb.background.service("guard", {
    async start(signal) {
      // Persisted, not just in-memory: a plugin reload is not a pressure event,
      // and treating it as one fills the activity log with duplicates that say
      // nothing happened.
      let lastLevel = store.getMeta<PressureLevel>("last-level");
      /** A level seen once, waiting for a second sample to confirm it. */
      let pendingLevel: PressureLevel | null = null;
      let lastReliefMs = store.getMeta<number>("last-relief") ?? 0;
      let lastSteerMs = store.getMeta<number>("last-steer") ?? 0;
      let lastEscalationMs = store.getMeta<number>("last-escalation") ?? 0;

      while (!signal.aborted) {
        let level: PressureLevel = "ok";
        try {
          const config = await readConfig();

          // Tier one: totals only. Two short-lived reads, no process table, no
          // SDK call — a few milliseconds. This is all a healthy machine ever
          // pays, and it is the whole reason the guard can run on a short
          // interval without being part of the problem it monitors.
          const pressure = await readPressure(config);
          if (signal.aborted) break;
          level = pressure.level;
          store.recordSample(pressure.sample);

          // A level change has to survive one more sample before it counts.
          //
          // The UI is told immediately — a chip that lags reality is worse
          // than one that occasionally flickers — but the activity log and the
          // ladder wait for confirmation. Without this, a single burst of
          // paging writes a critical/warn pair into the log every couple of
          // minutes, and the reader learns nothing from a record of noise.
          if (level !== lastLevel) {
            bb.realtime.publish(CHANNEL_PRESSURE, { at: Date.now(), level });
            if (level === pendingLevel) {
              if (lastLevel !== null || level !== "ok") {
                record(pressure, "observed", pressure.reason);
              }
              bb.log.info(`pressure ${lastLevel ?? "unknown"} → ${level}: ${pressure.reason}`);
              lastLevel = level;
              store.setMeta("last-level", level);
              pendingLevel = null;
            } else {
              pendingLevel = level;
            }
          } else {
            pendingLevel = null;
          }

          // Recovered: put back anything reversible, then go back to sleep
          // without ever touching the process table.
          if (level === "ok") {
            if (store.getMeta<number>("throttle-previous") !== null) {
              const restored = await restoreThrottle();
              if (restored.ok) record(pressure, "restored", restored.message);
            }
            await sleep(cadenceMs(config, level), signal);
            continue;
          }

          // Tier two: who is holding it. Only reached at `watch` or above, and
          // only when a rung might actually act.
          const snap = await snapshot(config, 0);
          if (signal.aborted) break;

          const now = Date.now();

          // Rung 1 — throttle. Reversible, loses nothing, so it goes first and
          // fires a level earlier than anything that destroys state.
          if (
            (level === "warn" || level === "critical") &&
            config.throttleFleet &&
            store.getMeta<number>("throttle-previous") === null
          ) {
            const result = await throttle(config);
            record(pressure, result.ok ? "throttled" : "suppressed", result.message);
            if (result.ok) bb.log.info(`throttled: ${result.message}`);
          }

          // Rung 2 — ask. Costs a turn, so it is cooled down hard and only
          // targets threads actually holding memory.
          if (
            (level === "warn" || level === "critical") &&
            config.steerThreads &&
            now - lastSteerMs > STEER_COOLDOWN_MS
          ) {
            const { plan } = await makePlan(config, snap);
            const steers = plan.candidates.filter((row) => row.action === "steer").slice(0, 2);
            if (steers.length > 0) {
              lastSteerMs = now;
              store.setMeta("last-steer", now);
              const result = await runRelief(
                config,
                steers.map((row) => row.id),
                false,
              );
              for (const item of result.items) {
                record(pressure, item.ok ? "steered" : "suppressed", `${item.label}: ${item.detail}`);
              }
            }
          }

          // Rung 3 — relieve. The first rung that destroys something, so it
          // waits for `critical` unless the user asked for aggressive.
          const reliefLevel = config.autoRelieve === "aggressive" ? "warn" : "critical";
          const reliefDue =
            config.autoRelieve !== "off" &&
            (level === "critical" || (reliefLevel === "warn" && level === "warn")) &&
            now - lastReliefMs > RELIEF_COOLDOWN_MS;

          if (reliefDue) {
            const { plan } = await makePlan(config, snap);
            const ids = plan.candidates
              .filter(
                (row) =>
                  row.action === "terminate" &&
                  (row.risk === "safe" ||
                    (config.autoRelieve === "aggressive" && row.risk === "disruptive")),
              )
              .map((row) => row.id);
            if (ids.length > 0) {
              lastReliefMs = now;
              store.setMeta("last-relief", now);
              const result = await runRelief(config, ids, false);
              record(
                pressure,
                result.bytesFreed > 0 ? "relieved" : "suppressed",
                `${result.succeeded} stopped, ${result.failed} refused — ${formatBytes(result.bytesFreed)} released`,
                result.bytesFreed,
              );
              bb.log.info(`relieved ${formatBytes(result.bytesFreed)} from ${result.succeeded} trees`);
              bb.realtime.publish(CHANNEL_PRESSURE, { at: Date.now(), reason: "relieved" });
            }
          }

          // Rung 4 — escalate. Everything deterministic has been tried and the
          // machine is still critical, so hand it to something that can reason.
          if (
            level === "critical" &&
            config.agentEscalation &&
            now - lastEscalationMs > ESCALATION_COOLDOWN_MS
          ) {
            lastEscalationMs = now;
            store.setMeta("last-escalation", now);
            const result = await escalate(config, snap);
            record(
              pressure,
              result.started ? "escalated" : "suppressed",
              result.message,
              0,
              result.threadId,
            );
          }
        } catch (cause) {
          bb.log.warn(`guard: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        const config = await readConfig().catch(() => null);
        await sleep(config === null ? 60_000 : cadenceMs(config, level), signal);
      }
    },
  });

  /* ---------------- agents ---------------- */

  /**
   * Tell every thread about memory pressure, as it happens.
   *
   * The tools are always registered, but an agent only reaches for one if
   * something prompts it — a thread debugging a failing test has no reason to
   * suspect the machine is paging. So when pressure is real, say so up front,
   * with the numbers and the tool names. Below `watch` this contributes
   * nothing at all: a healthy machine is not worth a line of anyone's context.
   */
  bb.agents.contributeInstructions(() => {
    const pressure = lastPressure;
    if (pressure === null || pressure.level === "ok") return null;
    const { sample } = pressure;
    return [
      `Memory pressure on this machine is ${pressure.level.toUpperCase()}: ` +
        `${formatBytes(sample.headroomBytes)} headroom, ${formatPercent(usedFraction(sample), 1)} used` +
        (sample.swapInRate > 0 ? `, paging in ${formatRate(sample.swapInRate)}` : "") +
        `. ${pressure.reason}.`,
      "Before starting anything memory-hungry here — a dev server, a build, a browser, a broad test " +
        "run — check `ballast_status`. Release what you are done with: close Playwright browsers and " +
        "contexts, stop dev servers you started, let watchers exit.",
      pressure.level === "critical"
        ? "At this level the machine is paging and new allocations may fail or hang. Use " +
          "`ballast_top` to see who is holding it before you add to it."
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  });

  bb.agents.registerTool({
    name: "ballast_disk",
    description: "Report filesystem capacity, or project paths, linked Git worktrees and relevant non-archived BB threads. Pass projects for metadata; projectId with measure for a bounded read-only project disk scan. Never deletes files.",
    presentation: {
      label: { pending: "Reading disk capacity", completed: "Read disk capacity" },
    },
    parameters: projectDiskInputSchema.extend({ projects: z.boolean().optional() }),
    async execute({ projects, projectId, measure }) {
      if (projects || projectId || measure) return renderProjectDisk(await readProjectDisk(bb, { projectId, measure }));
      return renderDisk(await readDisk());
    },
  });

  bb.agents.registerTool({
    name: "ballast_status",
    description:
      "Report physical memory pressure on this machine: used, headroom, swap, compression, and the " +
      "processes holding the most, grouped by process tree and by BB thread. Use this instead of " +
      "top, vm_stat, ps or memory_pressure whenever a task involves memory, a slow machine, an " +
      "out-of-memory failure, or deciding whether it is safe to start something large.",
    instructions:
      "Use ballast_status before starting a dev server, a build, or a browser-driven test run on this " +
      "machine, and before proposing that anything be killed to free memory.",
    presentation: {
      label: { pending: "Reading memory pressure", completed: "Read memory pressure" },
    },
    parameters: z.object({}),
    async execute() {
      const config = await readConfig();
      const snap = await snapshot(config);
      return [
        renderPressure(snap.pressure),
        "",
        renderConsumers("Largest consumers", snap.consumers, 12),
        "",
        renderConsumers("By BB thread", snap.threads, 8),
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "ballast_plan",
    description:
      "List processes that can be stopped to free memory, with byte counts and the ids ballast_relieve " +
      "takes. Candidates are graded safe only when nothing can still be waiting on them — orphaned, " +
      "or an abandoned headless browser — and disruptive otherwise. Anything protected is listed " +
      "with the reason it was refused.",
    presentation: {
      label: { pending: "Planning memory relief", completed: "Planned memory relief" },
    },
    parameters: z.object({
      refresh: z.boolean().optional().describe("Rebuild instead of serving the cached plan."),
    }),
    async execute({ refresh }) {
      const config = await readConfig();
      if (cachedPlan !== null && refresh !== true && Date.now() - cachedPlan.builtAtMs < 15_000) {
        return renderPlan(cachedPlan, { verbose: true });
      }
      const { plan } = await makePlan(config);
      return renderPlan(plan, { verbose: true });
    },
  });

  bb.agents.registerTool({
    name: "ballast_relieve",
    description:
      "Free memory by stopping candidate ids from ballast_plan, or by asking a BB thread to release " +
      "what it is holding. Always dry-run first and check the total.",
    instructions:
      "ballast_relieve only accepts ids minted by ballast_plan, and re-checks each one against the live " +
      "process table before signalling it. It never touches agents, editors, browsers, containers or " +
      "unclassified processes. Never use `kill` to work around that boundary.",
    presentation: {
      label: { pending: "Freeing memory", completed: "Freed memory" },
    },
    parameters: z.object({
      ids: z.array(z.string().min(1)).min(1).max(100),
      dryRun: z.boolean().describe("True reports what would be stopped without signalling anything."),
    }),
    async execute({ ids, dryRun }) {
      const config = await readConfig();
      const known = ids.filter((id) => cachedCandidates.has(id));
      if (known.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "None of those ids are in the current plan. Run ballast_plan with refresh: true.",
            },
          ],
          isError: true,
        };
      }
      const result = await runRelief(config, known, dryRun);
      const lines = [
        `${dryRun ? "Dry run" : "Applied"}: ${result.succeeded} succeeded, ${result.failed} failed, ` +
          `${formatBytes(result.bytesFreed)} ${dryRun ? "would be released" : "released"}.`,
      ];
      for (const item of result.items) lines.push(`  ${item.ok ? "ok" : "--"} ${item.label}: ${item.detail}`);
      if (known.length < ids.length) {
        lines.push(`  ${ids.length - known.length} ids were not in the current plan.`);
      }
      return lines.join("\n");
    },
  });

  /* ---------------- CLI ---------------- */

  bb.cli.register({
    name: "ballast",
    summary: "Show memory pressure, find what is holding it, and get it back",
    commands: [
      { name: "status", summary: "Memory pressure and the signals behind it", usage: "bb ballast status [--json]" },
      { name: "disk", summary: "Filesystem capacity or project/worktree/thread details", usage: "bb ballast disk [--projects | --project <id> [--measure]] [--json]" },
      { name: "top", summary: "Largest consumers, by tree and by thread", usage: "bb ballast top [--limit 20] [--json]" },
      { name: "plan", summary: "Relief candidates with ids", usage: "bb ballast plan [--refresh] [--json]" },
      {
        name: "relieve",
        summary: "Free memory (dry run unless --yes)",
        usage: "bb ballast relieve [--id <id>]... [--safe] [--yes] [--json]",
      },
      { name: "log", summary: "What the guard has done", usage: "bb ballast log [--limit 20] [--json]" },
      { name: "restore", summary: "Undo a concurrency throttle", usage: "bb ballast restore" },
    ],
    async run(argv) {
      const args = argv.filter((value) => value !== "");
      const json = args.includes("--json");
      const flag = (name: string): string | null => {
        const index = args.indexOf(name);
        return index >= 0 ? (args[index + 1] ?? null) : null;
      };
      const flagAll = (name: string): string[] => {
        const values: string[] = [];
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]);
        }
        return values;
      };
      const command = args.find((value) => !value.startsWith("--")) ?? "status";
      const config = await readConfig();
      const ok = (stdout: string) => ({
        exitCode: 0,
        stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`,
      });
      const asJson = (value: unknown) => ok(JSON.stringify(value, null, 2));

      switch (command) {
        case "disk": {
          const projectId = flag("--project") ?? undefined;
          if (args.includes("--projects") || projectId || args.includes("--measure")) {
            const report = await readProjectDisk(bb, { projectId, measure: args.includes("--measure") });
            return json ? asJson(report) : ok(renderProjectDisk(report));
          }
          const report = await readDisk();
          return json ? asJson(report) : ok(renderDisk(report));
        }
        case "status": {
          const snap = await snapshot(config);
          if (json) return asJson(snap.pressure);
          return ok(renderPressure(snap.pressure));
        }

        case "top": {
          const limit = Math.min(100, Math.max(1, Number(flag("--limit") ?? 20) || 20));
          const snap = await snapshot(config);
          if (json) {
            return asJson({
              consumers: snap.consumers.slice(0, limit),
              threads: snap.threads.slice(0, limit),
            });
          }
          return ok(
            [
              renderConsumers("Largest consumers", snap.consumers, limit),
              "",
              renderConsumers("By BB thread", snap.threads, limit),
            ].join("\n"),
          );
        }

        case "plan": {
          const { plan } = await makePlan(config);
          if (json) return asJson(plan);
          return ok(renderPlan(plan, { verbose: true }));
        }

        case "relieve": {
          const { plan } = await makePlan(config);
          const planIds = new Set(plan.candidates.map((row) => row.id));
          const explicit = flagAll("--id");
          const wantsSafe = args.includes("--safe");
          if (explicit.length === 0 && !wantsSafe) {
            return {
              exitCode: 1,
              stderr: "Nothing selected. Pass --safe for every safe candidate, or --id <id>.\n",
            };
          }
          const ids =
            explicit.length > 0
              ? explicit
              : plan.candidates
                  .filter((row) => row.risk === "safe" && row.action === "terminate")
                  .map((row) => row.id);
          // Asking for every safe candidate and finding none is a healthy
          // answer, not a usage error — say so rather than repeating the flag
          // the user just passed back at them.
          if (ids.length === 0) {
            return ok("No safe candidates: nothing is orphaned or idle. Run `bb ballast plan` to see what is left.");
          }
          const dryRun = !args.includes("--yes");
          // An id the plan never minted is refused here rather than reported as
          // a silent zero. Saying "0 succeeded, 0 failed" to someone who just
          // asked to stop something reads like the command worked.
          const unknown = ids.filter((id) => !planIds.has(id));
          if (unknown.length === ids.length) {
            return {
              exitCode: 1,
              stderr:
                `Not in the current plan: ${unknown.join(", ")}\n` +
                "Ballast only acts on ids from `bb ballast plan`. Run it again for current ids.\n",
            };
          }
          const result = await runRelief(config, ids, dryRun);
          if (json) return asJson({ ...result, unknownIds: unknown });
          const lines = [
            `${dryRun ? "Dry run" : "Applied"}: ${result.succeeded} succeeded, ${result.failed} failed, ` +
              `${formatBytes(result.bytesFreed)} ${dryRun ? "would be released" : "released"}.`,
          ];
          for (const item of result.items) {
            lines.push(`  ${item.ok ? "ok" : "--"} ${item.label}: ${item.detail}`);
          }
          if (unknown.length > 0) {
            lines.push(`  -- ${unknown.length} id(s) were not in the current plan and were ignored.`);
          }
          if (dryRun) lines.push("", "Re-run with --yes to apply.");
          return ok(lines.join("\n"));
        }

        case "log": {
          const limit = Math.min(200, Math.max(1, Number(flag("--limit") ?? 20) || 20));
          const events = store.events(limit);
          if (json) return asJson(events);
          if (events.length === 0) return ok("The guard has not done anything yet.");
          const lines = events.map(
            (event) =>
              // Local time, not UTC. An activity log is read against the
              // user's own memory of what they were doing, and printing
              // "23:26" for something that happened at 19:26 made a stale
              // event look like it had just fired.
              `${formatLocalStamp(event.atMs)}  ` +
              `${event.level.padEnd(8)} ${event.action.padEnd(10)} ${event.detail}`,
          );
          return ok(lines.join("\n"));
        }

        case "restore": {
          const result = await restoreThrottle();
          return result.ok
            ? ok(result.message)
            : { exitCode: 1, stderr: `${result.message}\n` };
        }

        default:
          return { exitCode: 1, stderr: `Unknown command "${command}". Try: status, disk, top, plan, relieve, log, restore.\n` };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

export { renderPressure, renderPlan, renderConsumers };
export type { Config };
