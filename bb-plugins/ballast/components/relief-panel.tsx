import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { riskLabel, riskTone, toneBorder, toneText } from "@/lib/ui";
import type { Candidate, Plan, ReliefResult } from "@/lib/contract";

/**
 * The relief tab.
 *
 * Grouped by risk, not by size, because the decision a reader is making is
 * "how much am I willing to break" — and within that, size ranks. Safe
 * candidates are preselected; nothing else ever is. Protected rows are shown
 * with the reason they were refused rather than hidden, so the boundary is
 * legible instead of mysterious.
 */
function RiskGroup({
  risk,
  title,
  description,
  candidates,
  selected,
  onToggle,
}: {
  risk: Candidate["risk"];
  title: string;
  description: string;
  candidates: readonly Candidate[];
  selected: ReadonlySet<string>;
  onToggle?: (id: string, next: boolean) => void;
}) {
  if (candidates.length === 0) return null;
  const tone = riskTone(risk);
  const total = candidates.reduce((sum, row) => sum + row.bytes, 0);

  return (
    <section className={cn("rounded-lg border bg-card", toneBorder[tone])}>
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className={cn("text-sm font-medium", toneText[tone])}>{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {formatBytes(total)}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="flex items-start gap-2.5 px-3 py-2">
            {onToggle === undefined ? (
              <Icon name="Lock" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Checkbox
                className="mt-0.5"
                checked={selected.has(candidate.id)}
                onCheckedChange={(next) => onToggle(candidate.id, next === true)}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm">{candidate.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {candidate.action === "steer" ? "a turn" : formatBytes(candidate.bytes)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{candidate.rationale}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReliefPanel({
  plan,
  busy,
  result,
  onRelieve,
  onRefresh,
}: {
  plan: Plan | null;
  busy: boolean;
  result: ReliefResult | null;
  onRelieve: (ids: string[], dryRun: boolean) => void;
  onRefresh: () => void;
}) {
  const safe = useMemo(
    () => plan?.candidates.filter((row) => row.risk === "safe") ?? [],
    [plan],
  );
  const disruptive = useMemo(
    () => plan?.candidates.filter((row) => row.risk === "disruptive") ?? [],
    [plan],
  );
  const protectedRows = useMemo(
    () => plan?.candidates.filter((row) => row.risk === "protected") ?? [],
    [plan],
  );

  // Safe candidates start selected; disruptive ones never do. Re-deriving from
  // the plan means a refresh cannot leave a stale id selected.
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const selected = useMemo(() => {
    const next = new Set<string>();
    for (const row of safe) if (!deselected.has(row.id)) next.add(row.id);
    for (const row of disruptive) if (added.has(row.id)) next.add(row.id);
    return next;
  }, [safe, disruptive, deselected, added]);

  const selectedBytes = (plan?.candidates ?? [])
    .filter((row) => selected.has(row.id) && row.action === "terminate")
    .reduce((sum, row) => sum + row.bytes, 0);

  const toggle = (id: string, next: boolean): void => {
    setDeselected((current) => {
      const copy = new Set(current);
      if (next) copy.delete(id);
      else copy.add(id);
      return copy;
    });
    setAdded((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };

  if (plan === null) {
    return <p className="px-4 py-6 text-sm text-muted-foreground md:px-5">Building a plan…</p>;
  }

  return (
    <div className="space-y-3 px-4 py-4 md:px-5">
      <RiskGroup
        risk="safe"
        title="Safe"
        description="Orphaned processes and idle headless browsers. Nothing is waiting on any of these."
        candidates={safe}
        selected={selected}
        onToggle={toggle}
      />
      <RiskGroup
        risk="disruptive"
        title="Disruptive"
        description="Still doing work, or costs a thread a turn. Never selected for you, never run automatically unless you set auto-relief to aggressive."
        candidates={disruptive}
        selected={selected}
        onToggle={toggle}
      />
      <RiskGroup
        risk="protected"
        title="Refused"
        description="Big enough to notice, and Ballast will not touch them. Here is why."
        candidates={protectedRows}
        selected={selected}
      />

      {safe.length === 0 && disruptive.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to stop. No idle automation, no stray servers, no orphaned builds.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || selected.size === 0}
          onClick={() => onRelieve([...selected], false)}
        >
          {busy ? "Working…" : `Free ${formatBytes(selectedBytes)}`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || selected.size === 0}
          onClick={() => onRelieve([...selected], true)}
        >
          Dry run
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>
          <Icon name="RefreshCw" className="mr-1.5 size-3.5" />
          Rebuild plan
        </Button>
      </div>

      {result === null ? null : (
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <p className="text-sm">
            {result.dryRun ? "Dry run" : "Applied"}: {result.succeeded} succeeded, {result.failed}{" "}
            failed, {formatBytes(result.bytesFreed)}{" "}
            {result.dryRun ? "would be released" : "released"}.
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.items.map((item) => (
              <li key={item.id} className="flex items-baseline gap-2 text-xs">
                <Icon
                  name={item.ok ? "CircleCheck" : "AlertCircle"}
                  className={cn("size-3.5 shrink-0", item.ok ? toneText.good : toneText.warn)}
                />
                <span className="truncate">{item.label}</span>
                <span className="truncate text-muted-foreground">— {item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export { riskLabel };
