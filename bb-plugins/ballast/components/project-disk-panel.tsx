import { useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { ProjectDiskReport } from "@/lib/contract";
import type { rpcContract } from "../server";

export function ProjectDiskPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [report, setReport] = useState<ProjectDiskReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function load(projectId?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(projectId ?? "all");
    setError(null);
    try {
      const next = await rpc.call("diskProjects", projectId ? { projectId, measure: true } : {});
      setReport((previous) => projectId && previous ? {
        ...previous, atMs: next.atMs,
        projects: previous.projects.map((project) => next.projects.find((item) => item.id === project.id) ?? project),
      } : next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return <section className="space-y-3 border-t border-border pt-4">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium">Projects, worktrees & threads</h2>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void load()}>{busy === "all" ? "Loading…" : report ? "Refresh projects" : "Load projects"}</Button>
    </div>
    <p className="text-xs text-muted-foreground">Metadata loads on demand. Measure a project to scan local checkouts, including ignored files and dependencies. Scans stop at 100,000 entries or 5 seconds; partial sizes are lower bounds. Symlinks and other filesystems are not followed.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {report?.projects.length === 0 ? <p className="text-sm">No projects found.</p> : null}
    {report?.projects.map((project) => <details key={project.id} className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">{project.name} · {project.paths.length} paths · {project.threads.length} threads</summary>
      <div className="mt-3 space-y-3">
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate.toProject(project.id)}>Open project</Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void load(project.id)}>{busy === project.id ? "Measuring…" : "Measure project"}</Button>
        </div>
        {project.warnings.map((warning, index) => <p key={index} className="text-xs text-muted-foreground">{warning}</p>)}
        {project.paths.map((path) => {
          const threads = project.threads.filter((thread) => thread.environmentId !== null && path.environmentIds.includes(thread.environmentId));
          return <div key={`${path.hostId}:${path.path}`} className="space-y-1 border-t border-border pt-2">
            <p className="break-all text-sm font-medium">{path.path}</p>
            <p className="text-xs text-muted-foreground">{path.kind} · {path.branch ?? "no branch"} · {path.local ? "local" : "remote"} · {path.hostId}</p>
            <p className="text-sm">{path.bytes === null ? "Not measured" : `${path.complete ? "" : "At least "}${formatBytes(path.bytes)} allocated${path.complete ? "" : " (partial)"}`}</p>
            {path.notes.map((note, index) => <p key={index} className="break-all text-xs text-muted-foreground">{note}</p>)}
            {threads.length === 0 ? <p className="text-xs text-muted-foreground">No associated non-archived BB threads.</p> : threads.map((thread) => <button key={thread.id} className="block text-left text-sm underline underline-offset-2" onClick={() => navigate.toThread(thread.id)}>{thread.title} · {thread.status}</button>)}
          </div>;
        })}
        {project.threads.filter((thread) => !project.paths.some((path) => thread.environmentId !== null && path.environmentIds.includes(thread.environmentId))).map((thread) => <button key={thread.id} className="block text-left text-sm underline underline-offset-2" onClick={() => navigate.toThread(thread.id)}>{thread.title} · {thread.status} · no listed workspace</button>)}
      </div>
    </details>)}
    {report ? <p className="text-xs text-muted-foreground">Thread links reflect BB environment associations, not ownership of bytes. Nested paths and hardlinks are counted once per project; cross-project totals and APFS clones are not additive. Shared Git data is charged to the checkout containing it.</p> : null}
  </section>;
}
