/**
 * The wire contract between Ballast's server and its app bundle.
 *
 * Schemas live here rather than in `server.ts` so the CLI, the agent tools and
 * the React app all describe the same shapes. `app.tsx` imports only the
 * inferred types (`import type`), so zod never reaches the frontend bundle.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Pressure                                                            */
/* ------------------------------------------------------------------ */

export const PRESSURE_LEVELS = ["ok", "watch", "warn", "critical"] as const;
export const pressureLevelSchema = z.enum(PRESSURE_LEVELS);
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

/**
 * One memory reading, in the terms the operating system actually uses.
 *
 * Deliberately not "used / free". On a modern kernel that pair is meaningless:
 * this machine reports 61% free from `memory_pressure` while holding 5 GB of
 * swap and 6 GB of compressed pages. The fields below are the ones that decide
 * whether the next allocation costs a pointer bump or a page-in from disk.
 */
export const memorySampleSchema = z.object({
  atMs: z.number(),
  totalBytes: z.number(),
  /** Pages the kernel has on hand right now. Almost always small; that's fine. */
  freeBytes: z.number(),
  /** Anonymous, non-purgeable pages: the memory programs actually asked for. */
  appBytes: z.number(),
  /** Kernel and drivers. Cannot be compressed, swapped, or reclaimed. */
  wiredBytes: z.number(),
  /** Already squeezed. Cheap to read back, but it was RAM once. */
  compressedBytes: z.number(),
  /** Clean file pages. The kernel drops these for free under demand. */
  cachedFileBytes: z.number(),
  /** Allocated but discardable on request (caches that opted in). */
  purgeableBytes: z.number(),
  /**
   * What a new allocation can draw on before anything has to be compressed or
   * paged out: free + speculative + clean file cache + purgeable. The single
   * number worth alarming on.
   */
  headroomBytes: z.number(),
  /** appBytes + wiredBytes + compressedBytes — Activity Monitor's "Memory Used". */
  usedBytes: z.number(),
  swapTotalBytes: z.number(),
  swapUsedBytes: z.number(),
  /** Bytes/second paged in from swap since the previous sample. The thrash signal. */
  swapInRate: z.number(),
  swapOutRate: z.number(),
  /** Uncompressed bytes per byte of compressor. Above ~2 the compressor is working hard. */
  compressionRatio: z.number(),
  /**
   * The kernel's own verdict, when it exposes one: macOS
   * `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical).
   * Null on platforms without it.
   */
  kernelPressure: z.enum(["normal", "warn", "critical"]).nullable(),
});
export type MemorySample = z.infer<typeof memorySampleSchema>;

export const diskReportSchema = z.object({
  atMs: z.number(),
  volumes: z.array(z.object({
    path: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
  })),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type DiskReport = z.infer<typeof diskReportSchema>;

export const projectDiskInputSchema = z.object({
  projectId: z.string().min(1).optional(),
  measure: z.boolean().optional(),
}).strict();
export const projectDiskReportSchema = z.object({
  atMs: z.number(),
  warnings: z.array(z.string()),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    warnings: z.array(z.string()),
    paths: z.array(z.object({
      path: z.string(), hostId: z.string(), local: z.boolean(),
      kind: z.string(), branch: z.string().nullable(),
      environmentIds: z.array(z.string()),
      bytes: z.number().nullable(), complete: z.boolean(), notes: z.array(z.string()),
    })),
    threads: z.array(z.object({
      id: z.string(), title: z.string(), status: z.string(), environmentId: z.string().nullable(),
    })),
  })),
});
export type ProjectDiskReport = z.infer<typeof projectDiskReportSchema>;

export const thresholdsSchema = z.object({
  watchPercent: z.number(),
  warnPercent: z.number(),
  criticalPercent: z.number(),
  minHeadroomGb: z.number(),
  swapRateMbPerMin: z.number(),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const pressureSchema = z.object({
  sample: memorySampleSchema,
  level: pressureLevelSchema,
  /** Plain-language cause of the current level, for the alert banner. */
  reason: z.string(),
  /** Every signal that graded at or above `watch`, worst first. */
  signals: z.array(z.object({ level: pressureLevelSchema, detail: z.string() })),
  thresholds: thresholdsSchema,
});
export type Pressure = z.infer<typeof pressureSchema>;

/* ------------------------------------------------------------------ */
/* Consumers                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a process *is*, which is what decides whether it can be killed.
 *
 * Classification is the whole safety model: a `browser-automation` tree is
 * disposable by definition, an `agent` is someone's work in progress, and
 * `system` is never a candidate no matter how much it holds.
 */
export const PROCESS_KINDS = [
  "agent",
  "bb",
  "browser-automation",
  "dev-server",
  "test-runner",
  "toolchain",
  "container",
  "browser",
  "editor",
  "system",
  "other",
] as const;
export const processKindSchema = z.enum(PROCESS_KINDS);
export type ProcessKind = (typeof PROCESS_KINDS)[number];

export const processSchema = z.object({
  pid: z.number(),
  ppid: z.number(),
  /** Resident set size. Shared pages are counted in every mapper; see `Consumer`. */
  rssBytes: z.number(),
  /** Seconds since the process started, from `ps etime`. */
  ageSeconds: z.number(),
  cpuPercent: z.number(),
  command: z.string(),
  /** argv[0]'s basename, for a short label. */
  name: z.string(),
  user: z.string(),
  kind: processKindSchema,
  /** The BB thread this process belongs to, when the path or argv says so. */
  threadId: z.string().nullable(),
  /** Dev-server port parsed out of argv, when there is one. */
  port: z.number().nullable(),
});
export type ProcessRow = z.infer<typeof processSchema>;

/**
 * A process tree rolled up to one row.
 *
 * Ranking individual PIDs is useless when a headless Chrome is 30 renderers
 * and a Next dev server forks a compiler: you get a list of identical `node`
 * rows that each look survivable. Grouping by tree root makes the real unit of
 * decision — "this browser", "this thread" — the thing you see and act on.
 */
export const consumerSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  kind: processKindSchema,
  bytes: z.number(),
  processCount: z.number(),
  rootPid: z.number(),
  /** The root's parent. `<= 1` means orphaned: nothing is waiting on it. */
  parentPid: z.number(),
  pids: z.array(z.number()),
  ageSeconds: z.number(),
  cpuPercent: z.number(),
  threadId: z.string().nullable(),
  threadTitle: z.string().nullable(),
  port: z.number().nullable(),
});
export type Consumer = z.infer<typeof consumerSchema>;

/* ------------------------------------------------------------------ */
/* Relief                                                              */
/* ------------------------------------------------------------------ */

export const RISKS = ["safe", "disruptive", "protected"] as const;
export const riskSchema = z.enum(RISKS);
export type Risk = (typeof RISKS)[number];

export const ACTIONS = ["terminate", "steer", "throttle", "escalate"] as const;
export const actionSchema = z.enum(ACTIONS);
export type Action = (typeof ACTIONS)[number];

/**
 * A proposed intervention, with an id that `relieve` will take.
 *
 * The id is the whole boundary. Nothing downstream of here accepts a PID from
 * a caller — an agent, the CLI and the panel all hand back ids Ballast minted
 * while building this plan, and each one is re-checked against the protected
 * list at the moment it is acted on.
 */
export const candidateSchema = z.object({
  id: z.string(),
  action: actionSchema,
  risk: riskSchema,
  label: z.string(),
  /** Why this is safe to do, in one line, for a human reading the plan. */
  rationale: z.string(),
  bytes: z.number(),
  pids: z.array(z.number()),
  kind: processKindSchema,
  threadId: z.string().nullable(),
  /** Set when the candidate is `protected`: what refused it. */
  refusal: z.string().nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const planSchema = z.object({
  builtAtMs: z.number(),
  candidates: z.array(candidateSchema),
  /** Bytes the `safe` tier would return. The number the panel leads with. */
  safeBytes: z.number(),
  disruptiveBytes: z.number(),
});
export type Plan = z.infer<typeof planSchema>;

export const reliefItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  bytes: z.number(),
  detail: z.string(),
});
export type ReliefItem = z.infer<typeof reliefItemSchema>;

export const reliefResultSchema = z.object({
  dryRun: z.boolean(),
  succeeded: z.number(),
  failed: z.number(),
  bytesFreed: z.number(),
  items: z.array(reliefItemSchema),
});
export type ReliefResult = z.infer<typeof reliefResultSchema>;

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

export const guardEventSchema = z.object({
  id: z.number(),
  atMs: z.number(),
  level: pressureLevelSchema,
  headroomBytes: z.number(),
  usedFraction: z.number(),
  action: z.enum([
    "observed",
    "relieved",
    "steered",
    "throttled",
    "restored",
    "escalated",
    "suppressed",
  ]),
  detail: z.string(),
  bytesFreed: z.number(),
  threadId: z.string().nullable(),
});
export type GuardEvent = z.infer<typeof guardEventSchema>;

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export const historyPointSchema = z.object({
  atMs: z.number(),
  usedBytes: z.number(),
  headroomBytes: z.number(),
  swapUsedBytes: z.number(),
  compressedBytes: z.number(),
});
export type HistoryPoint = z.infer<typeof historyPointSchema>;

export const overviewSchema = z.object({
  pressure: pressureSchema,
  consumers: z.array(consumerSchema),
  threads: z.array(consumerSchema),
  /** Totals per kind, for the "where it went" band. */
  byKind: z.array(z.object({ kind: processKindSchema, bytes: z.number(), count: z.number() })),
  history: z.array(historyPointSchema),
  events: z.array(guardEventSchema),
  plan: planSchema.nullable(),
  /** True when agent escalation is on but no project has been chosen yet. */
  escalationUnconfigured: z.boolean(),
  hostname: z.string(),
});
export type Overview = z.infer<typeof overviewSchema>;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const AUTO_RELIEVE = ["off", "safe", "aggressive"] as const;
export const autoRelieveSchema = z.enum(AUTO_RELIEVE);
export type AutoRelieve = (typeof AUTO_RELIEVE)[number];

export const configSchema = z.object({
  thresholds: thresholdsSchema,
  sampleSeconds: z.number(),
  /** Ports whose listener is never touched. Empty by default, by design. */
  protectedPorts: z.string(),
  exemptPatterns: z.string(),
  idleMinutes: z.number(),
  autoRelieve: autoRelieveSchema,
  throttleFleet: z.boolean(),
  throttleLimit: z.number(),
  steerThreads: z.boolean(),
  agentEscalation: z.boolean(),
  escalationProjectId: z.string().nullable(),
  /** Set while a throttle is in force, so the panel can offer to undo it. */
  throttledFrom: z.number().nullable(),
});
export type Config = z.infer<typeof configSchema>;

export const configPatchSchema = z
  .object({
    thresholds: thresholdsSchema.partial().optional(),
    sampleSeconds: z.number().min(5).max(600).optional(),
    protectedPorts: z.string().max(2000).optional(),
    exemptPatterns: z.string().max(8000).optional(),
    idleMinutes: z.number().min(1).max(1440).optional(),
    autoRelieve: autoRelieveSchema.optional(),
    throttleFleet: z.boolean().optional(),
    throttleLimit: z.number().min(1).max(256).optional(),
    steerThreads: z.boolean().optional(),
    agentEscalation: z.boolean().optional(),
    escalationProjectId: z.string().nullable().optional(),
  })
  .strict();
export type ConfigPatch = z.infer<typeof configPatchSchema>;

export const projectRefSchema = z.object({ id: z.string(), name: z.string() });
export type ProjectRef = z.infer<typeof projectRefSchema>;

/* ------------------------------------------------------------------ */
/* RPC                                                                 */
/* ------------------------------------------------------------------ */

export const rpcShape = {
  config: { input: z.null(), output: configSchema },
  configSet: { input: configPatchSchema, output: configSchema },
  projects: { input: z.null(), output: z.object({ projects: z.array(projectRefSchema) }) },
  overview: { input: z.null(), output: overviewSchema },
  disk: { input: z.null(), output: diskReportSchema },
  diskProjects: { input: projectDiskInputSchema, output: projectDiskReportSchema },
  pressure: { input: z.null(), output: pressureSchema },
  plan: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: planSchema,
  },
  relieve: {
    input: z
      .object({ ids: z.array(z.string().min(1)).min(1).max(100), dryRun: z.boolean() })
      .strict(),
    output: reliefResultSchema,
  },
  escalate: {
    input: z.object({ note: z.string().optional() }).strict(),
    output: z.object({ threadId: z.string().nullable(), started: z.boolean(), message: z.string() }),
  },
  restoreThrottle: { input: z.null(), output: z.object({ ok: z.boolean(), message: z.string() }) },
} as const;
