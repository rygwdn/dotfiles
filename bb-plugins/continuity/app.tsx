import "./app.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { definePluginApp, experimental_Icon, useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginAppBuilder, PluginComposerThreadRowStatus, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { rpcContract } from "./contracts";
import type { Policy } from "./policy";
import type { RuntimeStatus } from "./schema";
import { continuityView, reconcileRequest } from "./view";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

type Snapshot = z.infer<typeof rpcContract.inspect.output>;
const FIELDS: { key: Exclude<keyof Policy, "enabled">; label: string; min: number; max: number; note: string }[] = [
  { key: "triggerTokens", label: "Projection trigger (tokens)", min: 100, max: 2000000, note: "Measured context usage; per-result allocation is approximate." },
  { key: "protectRounds", label: "Protected complete tool rounds", min: 1, max: 50, note: "Keep recent work and incomplete parallel batches intact." },
  { key: "protectTokens", label: "Protected tail budget (tokens)", min: 100, max: 2000000, note: "Additional recent-tail protection." },
  { key: "minResultTokens", label: "Minimum result size (estimated tokens)", min: 100, max: 2000000, note: "Leave small results alone." },
  { key: "minReclaimTokens", label: "Minimum reclamation (estimated tokens)", min: 100, max: 2000000, note: "Skip low-value projection changes." },
  { key: "regrowthTokens", label: "Regrowth before another projection (tokens)", min: 100, max: 2000000, note: "Avoid repeatedly rewriting the same prefix." },
  { key: "coldAfterSeconds", label: "Cold-interval heuristic (seconds)", min: 60, max: 86400, note: "New projections wait this long between activity. Not observed provider cache expiry." },
  { key: "idleSeconds", label: "Idle summary delay (seconds)", min: 30, max: 86400, note: "Only while this OMP process is resident; no overnight worker." },
  { key: "idleThresholdTokens", label: "Idle summary threshold (tokens)", min: 100, max: 2000000, note: "Native soft summaries can incur model charges; 15-minute cooldown." },
  { key: "keepRecentTokens", label: "Native retained-tail budget (tokens)", min: 100, max: 2000000, note: "Used by OMP rollover and compaction." },
];

export function ContinuityPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { const result = await rpc.call("inspect", { threadId }); setSnapshot(result); setLoadError(null); }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc, threadId]);
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh]);
  useRealtime("changed", () => { void refresh(); });
  useEffect(() => { if (snapshot && !draft) setDraft(snapshot.policy); }, [snapshot, draft]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || pending) return;
    setPending(true); setNotice(null); setError(null);
    try { const result = await rpc.call("configure", { threadId, policy: draft }); setNotice(result.note); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  async function compact() {
    if (pending) return;
    setPending(true); setNotice(null); setError(null);
    try { const result = await rpc.call("compact", { threadId }); setNotice(result.note); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  const runtime = snapshot?.runtime;
  const stale = !runtime || Date.now() - runtime.updatedAt > 10000 || runtime.state === "stopped";
  return <div className="continuity-root h-full min-h-0 overflow-y-auto p-4 md:p-5"><div className="mx-auto max-w-3xl space-y-4">
    <p className="text-xs font-mono text-muted-foreground">{threadId}</p>
    {(error || loadError) && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm text-destructive">{error || loadError}</p>}
    {notice && <p role="status" className="rounded-lg border border-border bg-card p-3 text-sm">{notice}</p>}
    {!snapshot ? <p role="status">Loading Continuity…</p> : <>
      <section className="space-y-2 rounded-lg border border-border bg-card p-4" aria-label="Runtime status">
        <div className="flex items-center justify-between gap-3"><strong>{!snapshot.configured ? "Not configured" : stale ? "No fresh runtime" : runtime!.state}</strong><Button size="sm" variant="outline" onClick={() => { void refresh(); }}>Refresh</Button></div>
        <p className="text-sm text-muted-foreground">{snapshot.note}</p>
        {runtime && <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-muted-foreground">Projected results</dt><dd>{runtime.demotedResults}</dd></div>
          <div><dt className="text-muted-foreground">Estimated tokens omitted</dt><dd>{Math.round(runtime.reclaimedTokens).toLocaleString()}</dd></div>
          <div><dt className="text-muted-foreground">Last compaction</dt><dd>{runtime.lastCompactedAt ? new Date(runtime.lastCompactedAt).toLocaleString() : "None recorded"}</dd></div>
          <div><dt className="text-muted-foreground">OMP session</dt><dd className="break-all font-mono text-xs">{runtime.sessionId}</dd></div>
        </dl>}
        <p className="text-xs text-muted-foreground">Estimates describe the model-facing projection, not billed savings. Native summary usage is not exposed separately through this extension API; consult OMP’s provider usage reporting. Native compaction may use multiple summarizer requests.</p>
      </section>
      {snapshot.supported && draft && <form onSubmit={save} className="space-y-4 rounded-lg border border-border bg-card p-4">
        <label className="flex items-center gap-3 text-sm font-medium"><Checkbox checked={draft.enabled} onCheckedChange={checked => setDraft({ ...draft, enabled: checked === true })} />Enable for this thread</label>
        <p className="text-sm text-muted-foreground">History-first strategy: native notes-backed automatic rollover plus native soft summaries while idle. Original tool results stay in the OMP journal; cache warming is stopped. This deliberately replaces automatic speculative summaries while enabled.</p>
        <details><summary className="cursor-pointer text-sm font-medium">Policy budgets</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">{FIELDS.map(field => <label key={field.key} className="space-y-1 text-sm">
          <span>{field.label}</span><Input type="number" required min={field.min} max={field.max} step={1} value={draft[field.key]} onChange={event => setDraft({ ...draft, [field.key]: Number(event.target.value) })} />
          <span className="block text-xs text-muted-foreground">{field.note}</span>
        </label>)}</div></details>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending}>{pending ? "Working…" : "Save policy"}</Button><Button type="button" variant="outline" disabled={pending || !snapshot.configured || !snapshot.policy.enabled} onClick={() => { void compact(); }}>Queue native compaction</Button></div>
        <p className="text-xs text-muted-foreground">Supports omp (RPC) and acp-omp. New providers load Continuity at launch; an already-running provider without the extension must reach its next user-controlled restart. Saving never starts or restarts a provider. Disabling restores native OMP behavior, including its usual pruning rules.</p>
      </form>}
    </>}
  </div></div>;
}
const QUEUED_TTL_MS = 15 * 60_000;
const TONE_CLASS: Record<RuntimeStatus["state"], string> = {
  "ready": "text-muted-foreground",
  "cache-hot": "text-muted-foreground",
  "demoted": "text-primary",
  "compacting": "text-primary animate-pulse",
  "compacted": "text-primary",
  "deferred": "text-muted-foreground",
  "disabled": "text-muted-foreground",
  "error": "text-destructive",
  "stopped": "text-muted-foreground",
};

const Icon = experimental_Icon;

type RuntimeView = ReturnType<typeof continuityView> & { queued: boolean };

function useContinuityRuntime(threadId: string | null): RuntimeView {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<{ threadId: string; enabled: boolean; status: RuntimeStatus | null } | null>(null);
  const [request, setRequest] = useState<{ threadId: string; at: number } | null>(null);
  const [, tick] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    let revision = 0;
    async function refresh() {
      const current = ++revision;
      try {
        const result = await rpc.call("statuses", { threadIds: [threadId!] });
        if (alive && current === revision) setSnapshot({ threadId: threadId!, enabled: result.enabledThreadIds.includes(threadId!), status: result.statuses[threadId!] ?? null });
      } catch { /* Keep saved policy visible; runtime phase expires independently. */ }
    }
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const timer = setInterval(() => { tick(n => n + 1); void refresh(); }, 5000);
    return () => { alive = false; refreshRef.current = () => {}; clearInterval(timer); };
  }, [rpc, threadId]);
  useRealtime("runtime", payload => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) refreshRef.current();
  });
  useRealtime("changed", () => { refreshRef.current(); });
  useRealtime("requested", payload => {
    if (threadId && (payload as { threadId?: string } | null)?.threadId === threadId) {
      setRequest({ threadId, at: Date.now() }); refreshRef.current();
    }
  });
  useEffect(() => {
    if (snapshot?.threadId !== threadId) return;
    setRequest(current => current?.threadId === threadId &&
      (!snapshot.enabled || !reconcileRequest(current.at, snapshot.status)) ? null : current);
  }, [snapshot, threadId]);
  // A component may be reused during navigation; never render its previous thread.
  const saved = snapshot?.threadId === threadId ? snapshot : null;
  const now = Date.now();
  const view = continuityView(saved?.enabled ?? false, saved?.status ?? null, now);
  const queued = !!view.phase && request?.threadId === threadId && now - request.at < QUEUED_TTL_MS &&
    view.phase.state !== "compacting" && view.phase.state !== "error" && (view.phase.lastCompactedAt ?? 0) < request.at;
  return { ...view, queued };
}

function ContinuityHeaderAction({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { enabled, phase: status, label: savedLabel, queued } = useContinuityRuntime(threadId);
  if (!enabled) return null;
  const label = queued ? "Continuity: compaction queued — runs at the next idle boundary" : savedLabel;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent ${status ? TONE_CLASS[status.state] : "text-primary"}`}
      onClick={() => { navigate.openThreadPanel({ actionId: "continuity" }); }}
    >
      <Icon name="Layers" className="size-4" aria-hidden="true" />
    </button>
  );
}

function ContinuityComposerBanner() {
  const { threadId } = useBbContext();
  const { enabled, phase: status, label, queued } = useContinuityRuntime(threadId);
  if (!threadId || !enabled) return null;
  let text: string | null = null;
  let toneClass = "text-muted-foreground";
  if (status?.state === "compacting") {
    text = "Continuity is compacting context now (native OMP soft summary at an idle boundary)…";
    toneClass = "text-primary";
  } else if (queued) {
    text = "Continuity compaction queued — it runs at the next idle boundary and never interrupts a running turn.";
    toneClass = "text-primary";
  } else if (status?.state === "deferred" && /queued/i.test(status.reason)) {
    text = `Continuity compaction waiting: ${status.reason}`;
  } else if (status?.state === "compacted") {
    text = "Continuity compacted the context; original tool results stay recoverable via continuity_read.";
  } else if (status?.state === "error") {
    text = `Continuity error: ${status.reason}`;
    toneClass = "text-destructive";
  }
  if (!text) text = label;
  return (
    <div role="status" className={`flex items-center gap-2 px-3 py-2 text-sm ${toneClass}`}>
      <Icon name="Layers" className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}

const THREAD_ID_PATTERN = /^thr_[a-zA-Z0-9_-]+$/;

/**
 * Decorates sidebar rows of threads with saved Continuity policy: the host
 * renders the status glyph in place of the draft glyph. Reads the thread ids
 * off the sidebar DOM and batch-fetches statuses over the plugin's same-origin
 * RPC route; realtime is not available to content scripts.
 */
function registerRowStatusScript(app: PluginAppBuilder) {
  app.contentScripts.register({
    id: "row-status",
    mount(context) {
      const setStatus = context.experimental_setThreadRowStatus;
      if (!setStatus) return;
      const apply: (threadId: string, status: PluginComposerThreadRowStatus | null) => void = setStatus;
      let stopped = false;
      let inFlight = false;
      async function refresh() {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const ids = [...new Set(Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"), element => element.getAttribute("data-sidebar-thread-id")).filter((value): value is string => !!value && THREAD_ID_PATTERN.test(value)))].slice(0, 64);
          if (ids.length === 0) return;
          const response = await fetch("/api/v1/plugins/continuity/rpc/statuses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadIds: ids }),
          });
          if (!response.ok) return;
          const body = (await response.json()) as { ok?: boolean; result?: { statuses?: Record<string, RuntimeStatus | null>; enabledThreadIds?: string[] } };
          const statuses = body.ok ? body.result?.statuses : undefined;
          if (!statuses) return;
          const enabled = new Set(body.result?.enabledThreadIds ?? []);
          const now = Date.now();
          for (const threadId of ids) {
            const status = statuses[threadId] ?? null;
            const view = continuityView(enabled.has(threadId), status, now);
            if (!view.enabled) { apply(threadId, null); continue; }
            apply(threadId, {
              icon: "Layers",
              label: view.label,
              tone: view.phase?.state === "compacting" ? "running" : view.phase?.state === "error" ? "error" : "default",
            });
          }
        } catch { /* offline or server restarting; retried on the next tick */ }
        finally { inFlight = false; }
      }
      const timer = setInterval(() => { void refresh(); }, 10_000);
      let scheduled: number | undefined;
      const observer = new MutationObserver(() => {
        if (scheduled !== undefined || stopped) return;
        scheduled = window.setTimeout(() => { scheduled = undefined; void refresh(); }, 1000);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      void refresh();
      return () => {
        stopped = true;
        clearInterval(timer);
        clearTimeout(scheduled);
        observer.disconnect();
      };
    },
  });
}

function ContinuityPage() {
  const { threadId } = useBbContext();
  const [value, setValue] = useState(threadId ?? "");
  const [selected, setSelected] = useState(threadId ?? "");
  return <div className="flex h-full min-h-0 flex-col"><form className="flex gap-2 border-b border-border p-4" onSubmit={event => { event.preventDefault(); setSelected(value.trim()); }}>
    <Input aria-label="BB thread ID" placeholder="thr_…" value={value} onChange={event => setValue(event.target.value)} required pattern="thr_[a-zA-Z0-9_-]+" /><Button type="submit">Inspect thread</Button>
  </form>{selected ? <ContinuityPanel key={selected} threadId={selected} /> : <p className="p-4 text-sm text-muted-foreground">Enter a thread ID, or open Continuity from a thread’s panel actions.</p>}</div>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: "continuity", title: "Continuity", icon: "Layers", path: "continuity", component: ContinuityPage });
  app.slots.threadPanelAction({ id: "continuity", title: "Continuity", icon: "Layers", component: ({ threadId }) => <ContinuityPanel key={threadId} threadId={threadId} /> });
  app.slots.experimental_threadHeaderAction({ id: "continuity", title: "Continuity", component: ContinuityHeaderAction });
  app.composer.customize({ id: "continuity", banners: [{ id: "runtime", component: ContinuityComposerBanner }] });
  registerRowStatusScript(app);
});
