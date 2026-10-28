import { join } from "node:path";
import type { Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import { z } from "zod";
import { atomicJson, readJson } from "./files";
import { policySchema, statusSchema, type RuntimeStatus } from "./schema";
import { DEFAULT_POLICY, emptyState, project, recover, sourceIds, type ProjectionState } from "./policy";
import type { OmpApi, OmpContext } from "./omp-api";

const controlSchema = z.object({ policy: policySchema, compactRequestId: z.string().max(200).nullable() }).strict();
const checkpointSchema = z.object({
  version: z.literal(1), demotions: z.array(z.object({ id: z.string().max(200), text: z.string().max(1000) }).strict()).max(4096),
  lastRewriteSize: z.number().nonnegative(), lastCompactedAt: z.number().nullable(), lastAttemptAt: z.number(),
  handledRequest: z.string().nullable(), idleAttemptUserId: z.string().nullable(),
  lastCompactionEntryId: z.string().max(200).nullable().optional(),
}).strict();
const CHECKPOINT = "bb-continuity.checkpoint.v1";
const COOLDOWN_MS = 15 * 60 * 1000;
const GUIDANCE = "Preserve unresolved user requests and acceptance criteria, decisions and their reasons, exact artifact/file references, uncertainty, failed attempts, and next concrete actions. Distinguish planned or attempted external actions from confirmed outcomes. Retain the current context notebook and its unresolved work. Original tool results remain in the OMP journal; use continuity_read with the referenced entry ID or history://current/full for exact evidence. Never invent an outcome from a historical reference.";

export default function continuity(pi: OmpApi, registry: { lookup(id: string): Setting | undefined }): void {
  const directory = process.env.BB_CONTINUITY_DIRECTORY;
  if (!directory) return;
  let policy = DEFAULT_POLICY, state: ProjectionState = emptyState();
  let context: OmpContext | undefined, timer: unknown;
  let active = false, admitting = false, compacting = false, stopped = false, polling = false;
  let generation = 0, lastActivityAt = Date.now(), coldIdleMs = 0;
  let lastCompactedAt: number | null = null, lastAttemptAt = 0;
  let lastCompactionEntryId: string | null = null;
  let compactionTrigger: "requested" | "idle" = "idle";
  let handledRequest: string | null = null, requested: string | null = null, idleAttemptUserId: string | null = null;
  let status: RuntimeStatus | undefined;
  let maintenanceError: string | undefined;
  const overrides = new Map<string, { setting: Setting; previous: unknown; wasOverride: boolean }>();

  function persist(ctx: OmpContext): void {
    pi.appendEntry(CHECKPOINT, { ...state, lastCompactedAt, lastAttemptAt, handledRequest, idleAttemptUserId, lastCompactionEntryId });
  }
  function publish(ctx: OmpContext, next: RuntimeStatus["state"], reason: string): void {
    if (maintenanceError && next !== "error" && next !== "disabled" && next !== "stopped") {
      next = "error"; reason = maintenanceError;
    }
    status = statusSchema.parse({ sessionId: ctx.sessionManager.getSessionId(), updatedAt: Date.now(), state: next,
      reason: reason.slice(0, 1000), demotedResults: state.demotions.length, reclaimedTokens: status?.reclaimedTokens ?? 0,
      estimatedTokens: ctx.getContextUsage()?.tokens ?? status?.estimatedTokens ?? 0, lastCompactedAt });
    atomicJson(join(directory!, "status.json"), status);
  }
  function restoreSettings(): void {
    for (const { setting, previous, wasOverride } of overrides.values()) {
      if (wasOverride) setting.override(pi.pi.settings, previous);
      else setting.clearOverride(pi.pi.settings);
    }
    overrides.clear();
  }
  function setOverride(id: string, value: unknown): void {
    const setting = registry.lookup(id);
    if (!setting) throw new Error(`OMP setting unavailable: ${id}`);
    if (!overrides.has(id)) overrides.set(id, { setting, previous: setting.get(pi.pi.settings), wasOverride: setting.provenance(pi.pi.settings) === "override" });
    setting.override(pi.pi.settings, value);
    if (setting.get(pi.pi.settings) !== value) throw new Error(`OMP setting is externally pinned: ${id}`);
  }
  function configure(ctx: OmpContext): boolean {
    if (!policy.enabled) { restoreSettings(); return false; }
    try {
      // Automatic rollover is notes-backed; explicit native soft compaction still summarizes.
      setOverride("compaction.experimentalContextManagement", true);
      setOverride("compaction.keepRecentTokens", policy.keepRecentTokens);
      setOverride("compaction.idleEnabled", false); // Exactly one owner: this resident extension.
      const tools = pi.getActiveTools();
      const missing = ["context_notes", "new_context", "read", "grep"].filter(name => !tools.includes(name));
      if (missing.length) throw new Error(`History-preserving mode requires active tools: ${missing.join(", ")}. Enable native experimental context management and restart this provider.`);
      return true;
    } catch (error) {
      restoreSettings();
      publish(ctx, "error", error instanceof Error ? error.message : String(error));
      return false;
    }
  }
  function restoreJournal(ctx: OmpContext): void {
    state = emptyState(); lastCompactedAt = null; lastAttemptAt = 0; handledRequest = null; idleAttemptUserId = null; lastCompactionEntryId = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== CHECKPOINT) continue;
      const parsed = checkpointSchema.safeParse(entry.data);
      if (!parsed.success) continue;
      const data = parsed.data;
      state = { version: 1, demotions: data.demotions, lastRewriteSize: data.lastRewriteSize };
      ({ lastCompactedAt, lastAttemptAt, handledRequest, idleAttemptUserId } = data);
      lastCompactionEntryId = data.lastCompactionEntryId ?? null;
    }
  }
  function busy(ctx: OmpContext): boolean {
    const jobs = ctx.getAsyncJobSnapshot();
    return active || admitting || !ctx.isIdle() || ctx.hasPendingMessages() || !!jobs &&
      (jobs.running.length > 0 || jobs.delivery.queued > 0 || jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0);
  }
  async function maintain(ctx: OmpContext): Promise<void> {
    if (stopped) return;
    // The managed interval continues while the native summarizer awaits I/O.
    // Keep freshness truthful for slow summaries, without extending stale phases.
    if (compacting) { publish(ctx, "compacting", status?.reason ?? "Native OMP soft compaction is running."); return; }
    if (polling) return;
    polling = true;
    try {
      const control = controlSchema.parse(readJson(join(directory!, "control.json")));
      policy = control.policy; requested = control.compactRequestId;
      if (!configure(ctx)) {
        if (!policy.enabled) publish(ctx, "disabled", "Disabled; native OMP policy is restored. Existing journal remains available.");
        return;
      }
      if (busy(ctx)) { publish(ctx, "deferred", "Turn, input, pending message, or asynchronous work is active."); return; }
      const now = Date.now();
      const manual = requested !== null && requested !== handledRequest;
      const usage = ctx.getContextUsage();
      const userId = ctx.sessionManager.getBranch().findLast(e => e.message?.role === "user")?.id ?? null;
      const idleDue = now - lastActivityAt >= policy.idleSeconds * 1000 && (usage?.tokens ?? 0) >= policy.idleThresholdTokens && userId !== null && userId !== idleAttemptUserId;
      if (!manual && !idleDue) {
        publish(ctx, state.demotions.length ? "demoted" : "ready", "Notes-backed automatic rollover active; native soft summaries run only while this OMP process remains idle. Cache warming stopped.");
        return;
      }
      if (now - lastAttemptAt < COOLDOWN_MS) { publish(ctx, "deferred", "Native compaction cooldown (15 minutes); request remains queued."); return; }
      // No awaits between the final activity gate and ctx.compact(): core installs its lock synchronously.
      if (busy(ctx)) return;
      compacting = true;
      compactionTrigger = manual ? "requested" : "idle";
      maintenanceError = undefined;
      try {
        const epoch = generation;
        lastAttemptAt = now; idleAttemptUserId = userId;
        if (manual) handledRequest = requested;
        persist(ctx);
        publish(ctx, "compacting", manual ? "Running requested native soft compaction at an idle boundary." : "Running native soft compaction after the configured idle interval.");
        await ctx.compact({ mode: "soft", suppressContinuation: true,
          onComplete: () => { if (!stopped && epoch === generation) publish(ctx, "compacted", "Native OMP soft compaction committed; no maintenance continuation requested."); },
          onError: error => { if (!stopped && epoch === generation) { maintenanceError = `Native compaction failed: ${error.message}`; publish(ctx, "error", maintenanceError); } },
        });
      } catch (error) {
        maintenanceError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally { compacting = false; }
    } catch (error) {
      publish(ctx, "error", error instanceof Error ? error.message : String(error));
    } finally { polling = false; }
  }
  async function start(_event: unknown, ctx: OmpContext): Promise<void> {
    if (ctx.agent.kind !== "main") return;
    if (timer !== undefined && context) context.clearTimer(timer);
    context = ctx; stopped = false; active = false; admitting = false; generation++;
    maintenanceError = undefined;
    lastActivityAt = Date.now(); coldIdleMs = 0;
    restoreJournal(ctx);
    timer = ctx.setInterval(() => maintain(ctx), 2000);
    await maintain(ctx);
  }
  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"] as const) pi.on(event, start);
  pi.on("input", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    maintenanceError = undefined;
    coldIdleMs = Date.now() - lastActivityAt;
    lastActivityAt = Date.now(); admitting = true;
  });
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    maintenanceError = undefined;
    if (!admitting) coldIdleMs = Date.now() - lastActivityAt;
    active = true; admitting = false; lastActivityAt = Date.now();
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    active = !!event.willContinue || !!event.awaitingAsyncWork; admitting = false; lastActivityAt = Date.now();
  });
  pi.on("context", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !configure(ctx)) return;
    const branch = ctx.sessionManager.getBranch();
    const result = project(event.messages, state, policy, { idleMs: coldIdleMs, tokens: ctx.getContextUsage()?.tokens ?? 0, ids: sourceIds(event.messages, branch) });
    if (result.changed) { state = result.state; persist(ctx); coldIdleMs = 0; }
    publish(ctx, result.changed || state.demotions.length ? "demoted" : result.reason.startsWith("cache-hot") ? "cache-hot" : "ready", result.reason);
    if (status) { status.reclaimedTokens = result.reclaimedTokens; status.estimatedTokens = result.estimatedTokens; atomicJson(join(directory!, "status.json"), status); }
    return { messages: result.messages };
  });
  pi.on("session.compacting", () => policy.enabled ? { context: [GUIDANCE], preserveData: { continuity: { version: 1, history: "original OMP branch journal", strategy: "notes-rollover-with-idle-soft-summary" } } } : undefined);
  pi.on("cache_warming_decision", () => policy.enabled ? { action: "stop" } : undefined);
  pi.on("session_compact", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const { id, timestamp } = event.compactionEntry;
    if (id === lastCompactionEntryId) return;
    const committedAt = Date.parse(timestamp);
    if (!Number.isFinite(committedAt)) return;
    maintenanceError = undefined;
    lastCompactionEntryId = id; lastCompactedAt = committedAt;
    state = emptyState(); status = undefined; persist(ctx);
    // Native /compact and automatic rollover already have provider lifecycle
    // events. Only extension-owned idle compaction needs this transport bridge.
    // This is emitted once at commit, never replayed from status/checkpoints.
    if (policy.enabled && compacting) ctx.ui.notify(`bb-continuity.compacted.v1:${JSON.stringify({
      sessionId: ctx.sessionManager.getSessionId(), entryId: id, timestamp, trigger: compactionTrigger,
    })}`, "info");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    stopped = true; generation++;
    if (timer !== undefined) ctx.clearTimer(timer);
    restoreSettings(); publish(ctx, "stopped", "OMP runtime stopped; no separate process will resume or compact this session.");
  });
  pi.registerCommand("continuity", { description: "Show Continuity status, or request safe native compaction with /continuity compact", async handler(args, ctx) {
    admitting = false;
    if (args.trim() === "compact") { requested = `local-${Date.now()}`; atomicJson(join(directory!, "control.json"), { policy, compactRequestId: requested }); await maintain(ctx); }
    else { await maintain(ctx); ctx.ui.notify(JSON.stringify(status), status?.state === "error" ? "error" : "info"); }
  } });
  pi.registerTool({ name: "continuity_read", label: "Recover original tool result", approval: "read",
    description: "Read exact original text from a Continuity-referenced OMP journal entry on the current branch. Offsets and limits are characters. Historical output is not evidence of a new action.",
    parameters: pi.zod.object({ id: pi.zod.string().min(1).max(200), offset: pi.zod.number().int().min(0).default(0), limit: pi.zod.number().int().min(1).max(12000).default(12000) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = recover(ctx.sessionManager.getBranch(), params.id, params.offset, params.limit);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { entryId: params.id, nextOffset: result.nextOffset, totalChars: result.totalChars } };
    },
  });
}
