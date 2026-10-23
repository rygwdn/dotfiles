import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type {
  OmpHubRpcContract,
  OmpService,
  OmpServiceAction,
} from "../hub-contract.js";
import { stripOmpAnsi } from "../extension-ui-contract.js";

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function OmpServices({ threadId }: { threadId: string }) {
  const rpc = useRpc<OmpHubRpcContract>();
  type ServiceList = z.infer<OmpHubRpcContract["listServices"]["output"]>;
  const [result, setResult] = useState<ServiceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || disposed) return;
      pending = true;
      try {
        const next = await rpc.call("listServices", { threadId });
        if (!disposed) {
          setResult(next);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : "Could not load services.");
        }
      } finally {
        pending = false;
      }
    };
    refreshRef.current = refresh;
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const interval = setInterval(refreshVisible, 5000);
    document.addEventListener("visibilitychange", refreshVisible);
    refreshVisible();
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [rpc, threadId]);

  const services = result?.available
    ? result.services.filter((service) => showInternal || !service.internal)
    : [];

  return (
    <section aria-label="Services" className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Services</h2>
        <Button type="button" variant="ghost" size="sm" onClick={() => void refreshRef.current()}>
          Refresh
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={showInternal}
          onChange={(event) => setShowInternal(event.target.checked)}
        />
        Show omp internals
      </label>
      {error ? <p role="alert" className="break-words text-xs text-destructive">{error}</p> : null}
      {!result && !error ? <p role="status" className="text-xs text-muted-foreground">Loading services…</p> : null}
      {result?.available === false ? (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{result.reason}</p>
      ) : null}
      {result?.available ? (
        <>
          {!result.hostIsLocal ? (
            <p className="text-xs text-muted-foreground">
              These services run on the thread’s host. Ports and URLs are local to that host.
            </p>
          ) : null}
          {services.length === 0 ? (
            <p className="text-xs text-muted-foreground">No {showInternal ? "" : "user "}services for this directory.</p>
          ) : (
            <ul className="space-y-2">
              {services.map((service) => (
                <li key={service.name}>
                  <ServiceRow
                    threadId={threadId}
                    service={service}
                    hostIsLocal={result.hostIsLocal}
                    onChanged={() => refreshRef.current()}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function ServiceRow({
  threadId,
  service,
  hostIsLocal,
  onChanged,
}: {
  threadId: string;
  service: OmpService;
  hostIsLocal: boolean;
  onChanged: () => Promise<void>;
}) {
  const rpc = useRpc<OmpHubRpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const readLogs = async () => {
    setLoadingLogs(true);
    setError(null);
    try {
      const result = await rpc.call("serviceLogs", { threadId, name: service.name, lines: 200 });
      setLogs(stripOmpAnsi(result.text));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read service logs.");
    } finally {
      setLoadingLogs(false);
    }
  };
  const control = async (action: OmpServiceAction) => {
    setBusy(true);
    setError(null);
    setConfirmKill(false);
    try {
      await rpc.call("controlService", { threadId, name: service.name, action });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action} service.`);
    } finally {
      setBusy(false);
    }
  };
  const uptime = service.startedAt === undefined
    ? null
    : duration((service.exitedAt ?? Date.now()) - service.startedAt);

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border bg-surface-raised p-3 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="min-w-0 break-all font-medium">{service.name}</h3>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px]">{service.state}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {service.pid !== undefined ? <span>PID {service.pid}</span> : null}
        {uptime !== null ? <span>{service.exitedAt === undefined ? "Uptime" : "Ran"} {uptime}</span> : null}
        {service.exitCode !== undefined && service.exitCode !== null ? <span>Exit {service.exitCode}</span> : null}
      </div>
      {service.url && hostIsLocal ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto max-w-full justify-start whitespace-normal break-all p-0 text-left text-xs"
          onClick={() => navigate.openUrl(service.url!)}
        >
          <Icon name="ExternalLink" className="size-3 shrink-0" />
          {service.url}
        </Button>
      ) : service.port !== undefined ? (
        <p className="text-muted-foreground">Port {service.port}{hostIsLocal ? "" : " on the thread’s host"}</p>
      ) : service.url ? (
        <p className="break-all text-muted-foreground">{service.url} (on the thread’s host)</p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={logsOpen}
          onClick={() => {
            setLogsOpen(!logsOpen);
            if (!logsOpen) void readLogs();
          }}
        >
          Logs
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void control("restart")}>Restart</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void control("stop")}>Stop</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmKill(true)}>Kill</Button>
      </div>
      {confirmKill ? (
        <div role="alertdialog" aria-label={`Kill ${service.name}?`} className="space-y-2 rounded border border-destructive p-2">
          <p>Kill {service.name}? The process will be terminated immediately.</p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void control("kill")}>Kill service</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmKill(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="whitespace-pre-wrap break-words text-destructive">{error}</p> : null}
      {logsOpen ? (
        <div className="space-y-2 border-t border-border pt-2">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span>Last 200 lines</span>
            <Button type="button" variant="ghost" size="sm" disabled={loadingLogs} onClick={() => void readLogs()}>Refresh logs</Button>
          </div>
          {loadingLogs ? <p role="status">Loading logs…</p> : null}
          {logs !== null ? (
            <pre aria-label={`${service.name} logs`} className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{logs || "No logs yet."}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
