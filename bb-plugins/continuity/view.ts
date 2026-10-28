import type { RuntimeStatus } from "./schema";

/** A consumed/failed request must not reappear when a later heartbeat is ready. */
export function reconcileRequest(requestAt: number, status: RuntimeStatus | null): boolean {
  return status === null || status.updatedAt < requestAt || !["compacting", "error", "stopped", "disabled"].includes(status.state) &&
    (status.lastCompactedAt ?? 0) < requestAt;
}

/** Freshness only describes the resident runtime; it never removes saved policy. */
export function continuityView(enabled: boolean, status: RuntimeStatus | null, now: number) {
  const live = enabled && status !== null && status.state !== "stopped" && status.state !== "disabled" &&
    now >= status.updatedAt && now - status.updatedAt < 15_000;
  const phase = live ? status : null;
  let label = "Continuity: enabled — no fresh resident OMP runtime";
  if (phase) {
    const results = phase.demotedResults === 1 ? "result" : "results";
    switch (phase.state) {
      case "compacting": label = "Continuity: compacting context now"; break;
      case "compacted": label = "Continuity: context compacted; history preserved in the OMP journal"; break;
      case "error": label = `Continuity: error — ${phase.reason}`; break;
      case "deferred": label = `Continuity: maintenance deferred — ${phase.reason}`; break;
      default: label = `Continuity: enabled (${phase.demotedResults} preserved ${results})`;
    }
  } else if (status?.state === "stopped") label = "Continuity: enabled — OMP stopped";
  else if (status?.state === "disabled") label = "Continuity: enabled — waiting for the OMP runtime to load saved policy";
  if (!live && status?.lastCompactedAt) label += `; last compaction ${new Date(status.lastCompactedAt).toLocaleString()}`;
  return { enabled, phase, label };
}
