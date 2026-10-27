import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { DiskReport } from "@/lib/contract";
import type { rpcContract } from "../server";
import { ProjectDiskPanel } from "./project-disk-panel";

export function DiskPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<DiskReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await rpc.call("disk");
        if (active) { setReport(next); setError(null); }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [rpc, revision]);
  return (
    <section className="space-y-4 p-4 md:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Disk capacity</h2>
        <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>Refresh</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!report && !error ? <p className="text-sm text-muted-foreground">Reading disk capacity…</p> : null}
      {report ? <>
        <p className="text-xs text-muted-foreground">Sampled {new Date(report.atMs).toLocaleTimeString()}. Root and home filesystems only; no directory scan.</p>
        {report.volumes.map((volume) => {
          const percent = volume.totalBytes > 0 ? 100 * volume.usedBytes / volume.totalBytes : 0;
          return <div key={volume.path} className="space-y-2 rounded-lg border border-border p-3">
            <h3 className="break-all text-sm font-medium">{volume.path}</h3>
            <p className="text-sm">{formatBytes(volume.usedBytes)} used of {formatBytes(volume.totalBytes)} ({percent.toFixed(1)}%)</p>
            <div role="meter" aria-label={`Disk usage for ${volume.path}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
            </div>
            <p className="text-sm">{formatBytes(volume.availableBytes)} available</p>
          </div>;
        })}
        {report.errors.map((failure) => <p key={failure.path} role="alert" className="break-all text-sm text-destructive">{failure.path}: {failure.message}</p>)}
        <p className="text-xs text-muted-foreground">Available space excludes filesystem reservations. APFS volumes can share capacity; do not add their totals. This view does not delete files or change memory relief.</p>
      </> : null}
      <ProjectDiskPanel />
    </section>
  );
}
