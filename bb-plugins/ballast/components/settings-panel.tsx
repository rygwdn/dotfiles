import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Config, ConfigPatch, ProjectRef } from "@/lib/contract";
import type { rpcContract } from "@/server";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="space-y-3 px-3 py-3">{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint === undefined ? null : (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  suffix,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  suffix?: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="flex items-baseline justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint === undefined ? null : (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        <Input
          value={draft}
          inputMode="numeric"
          className="h-7 w-20 text-right tabular-nums"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const next = Number(draft);
            if (Number.isFinite(next)) onCommit(next);
            else setDraft(String(value));
          }}
        />
        {suffix === undefined ? null : (
          <span className="text-xs text-muted-foreground">{suffix}</span>
        )}
      </span>
    </label>
  );
}

function TextField({
  label,
  hint,
  value,
  placeholder,
  multiline,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="block">
      <span className="block text-sm">{label}</span>
      {hint === undefined ? null : (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
      {multiline === true ? (
        <textarea
          value={draft}
          placeholder={placeholder}
          rows={3}
          spellCheck={false}
          className="mt-1.5 w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft)}
        />
      ) : (
        <Input
          value={draft}
          placeholder={placeholder}
          className="mt-1.5 h-7 font-mono text-xs"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onCommit(draft)}
        />
      )}
    </label>
  );
}

const AUTO_RELIEVE_OPTIONS: Array<{ value: Config["autoRelieve"]; label: string; hint: string }> = [
  { value: "off", label: "Never", hint: "Ballast reports; you decide." },
  {
    value: "safe",
    label: "Safe only",
    hint: "Orphaned processes and abandoned headless browsers, at critical pressure.",
  },
  {
    value: "aggressive",
    label: "Aggressive",
    hint: "Also stops running work, starting one level earlier.",
  },
];

/**
 * The settings tab.
 *
 * Grouped by the question each group answers — when is this a problem, what may
 * be stopped, and how far may the guard go — rather than by setting type. The
 * ladder section lists its rungs in the order they fire, with what each one
 * costs, because "check the box that kills things" deserves to be read in
 * context rather than found on its own.
 */
export function SettingsPanel({ onChanged }: { onChanged?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<Config | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("config").then(setConfig, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
    rpc.call("projects").then((result) => setProjects(result.projects), () => {});
  }, [rpc]);

  const patch = useCallback(
    (next: ConfigPatch) => {
      rpc.call("configSet", next).then(
        (updated) => {
          setConfig(updated);
          setError(null);
          onChanged?.();
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [rpc, onChanged],
  );

  if (error !== null && config === null) {
    return <p className="px-4 py-6 text-sm text-destructive md:px-5">{error}</p>;
  }
  if (config === null) {
    return <p className="px-4 py-6 text-sm text-muted-foreground md:px-5">Loading settings…</p>;
  }

  return (
    <div className="space-y-3 px-4 py-4 md:px-5">
      {error === null ? null : (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <Section
        title="When memory is a problem"
        description="Four signals are graded independently and the worst one wins, so a full-but-calm machine and an emptier-but-thrashing one are told apart."
      >
        <NumberField
          label="Minimum headroom"
          hint="Free plus reclaimable cache. The signal that matters most on a big machine."
          value={config.thresholds.minHeadroomGb}
          suffix="GB"
          onCommit={(minHeadroomGb) => patch({ thresholds: { minHeadroomGb } })}
        />
        <NumberField
          label="Paging in"
          hint="Reading memory back off disk. Above this, the machine is already hurting."
          value={config.thresholds.swapRateMbPerMin}
          suffix="MB/min"
          onCommit={(swapRateMbPerMin) => patch({ thresholds: { swapRateMbPerMin } })}
        />
        <NumberField
          label="Watch at"
          value={config.thresholds.watchPercent}
          suffix="% used"
          onCommit={(watchPercent) => patch({ thresholds: { watchPercent } })}
        />
        <NumberField
          label="Warn at"
          value={config.thresholds.warnPercent}
          suffix="% used"
          onCommit={(warnPercent) => patch({ thresholds: { warnPercent } })}
        />
        <NumberField
          label="Critical at"
          value={config.thresholds.criticalPercent}
          suffix="% used"
          onCommit={(criticalPercent) => patch({ thresholds: { criticalPercent } })}
        />
        <NumberField
          label="Check every"
          hint="Under pressure. A healthy machine is checked six times less often, and costs only a memory read."
          value={config.sampleSeconds}
          suffix="seconds"
          onCommit={(sampleSeconds) => patch({ sampleSeconds })}
        />
      </Section>

      <Section
        title="What may be stopped"
        description="A process is only a safe candidate when nothing can still be waiting on it: it is orphaned, or it is a headless browser idle at no CPU. Agents, editors, browsers, containers, long-lived tool services, system processes and anything unrecognised are refused by construction."
      >
        <NumberField
          label="Counts as idle after"
          hint="At effectively no CPU. A browser nothing is driving is abandoned; a dev server is not, so idle alone never makes one a safe candidate."
          value={config.idleMinutes}
          suffix="minutes"
          onCommit={(idleMinutes) => patch({ idleMinutes })}
        />
        <TextField
          label="Protected ports"
          hint="Anything listening here is never touched, however idle. Empty by default — ports are your convention, not Ballast's."
          placeholder="3000, 5173, 8080-8090"
          value={config.protectedPorts}
          onCommit={(protectedPorts) => patch({ protectedPorts })}
        />
        <TextField
          label="Protected processes"
          hint="One substring per line; a command line containing any of them is refused."
          placeholder={"my-long-running-job\n--keep-alive"}
          multiline
          value={config.exemptPatterns}
          onCommit={(exemptPatterns) => patch({ exemptPatterns })}
        />
      </Section>

      <Section
        title="How far the guard may go"
        description="Rungs fire in this order, cheapest first. Each is independent; all of them are off unless you say otherwise."
      >
        <Toggle
          checked={config.throttleFleet}
          onChange={(throttleFleet) => patch({ throttleFleet })}
          label="1. Throttle BB concurrency"
          hint="Stops new threads starting. Reversible, loses nothing, and lifted automatically when pressure clears."
        />
        {config.throttleFleet ? (
          <NumberField
            label="Throttled limit"
            value={config.throttleLimit}
            suffix="threads"
            onCommit={(throttleLimit) => patch({ throttleLimit })}
          />
        ) : null}
        {config.throttledFrom === null ? null : (
          <p className="text-xs text-muted-foreground">
            <Icon name="Info" className="mr-1 inline size-3.5 align-[-2px]" />
            Currently throttled; the previous limit was {config.throttledFrom}.
          </p>
        )}

        <Toggle
          checked={config.steerThreads}
          onChange={(steerThreads) => patch({ steerThreads })}
          label="2. Ask the hungriest threads to release memory"
          hint="Steers up to two live threads. Costs each one a turn; costs no work."
        />

        <div>
          <span className="block text-sm">3. Stop processes automatically</span>
          <span className="block text-xs text-muted-foreground">
            The first rung that destroys something.
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {AUTO_RELIEVE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                onClick={() => patch({ autoRelieve: option.value })}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  config.autoRelieve === option.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {AUTO_RELIEVE_OPTIONS.find((option) => option.value === config.autoRelieve)?.hint}
          </p>
        </div>

        <Toggle
          checked={config.agentEscalation}
          onChange={(agentEscalation) => patch({ agentEscalation })}
          label="4. Hand the problem to an agent"
          hint="At critical, and only when there is something it could actually do. Starts one thread, at most once every 20 minutes, and runs it unattended with full permissions so it does not stall on an approval nobody is there to give."
        />
        {config.agentEscalation ? (
          <label className="block">
            <span className="block text-sm">Escalation project</span>
            <select
              value={config.escalationProjectId ?? ""}
              onChange={(event) =>
                patch({ escalationProjectId: event.target.value === "" ? null : event.target.value })
              }
              className="mt-1.5 h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="">Choose a project…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {config.escalationProjectId === null ? (
              <span className="mt-1 block text-xs text-destructive/80">
                Without a project the guard logs the escalation and does nothing.
              </span>
            ) : null}
          </label>
        ) : null}
      </Section>

      <p className="text-xs text-muted-foreground">
        Every automatic action is written to the Activity tab with the numbers that triggered it.
      </p>
    </div>
  );
}

export { Button };
