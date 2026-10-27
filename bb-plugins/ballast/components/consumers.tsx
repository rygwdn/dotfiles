import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration, formatPercent } from "@/lib/format";
import { SizeBar } from "@/components/meter";
import { kindLabel, toneFill, toneText } from "@/lib/ui";
import type { Consumer, ProcessKind } from "@/lib/contract";

/**
 * "Where it went", at a glance.
 *
 * Bytes by kind rather than by process, because the first question is never
 * "which node process" — it is "is this me, or is this the fleet". One row per
 * kind, widest first, sharing a single hue so the bar lengths are the only
 * thing being compared.
 */
export function KindBand({
  byKind,
  total,
}: {
  byKind: ReadonlyArray<{ kind: ProcessKind; bytes: number; count: number }>;
  total: number;
}) {
  if (byKind.length === 0) return null;
  const max = Math.max(...byKind.map((row) => row.bytes), 1);
  return (
    <div className="grid gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-2 md:px-5 lg:grid-cols-3">
      {byKind.map((row) => (
        <div key={row.kind} className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium">{kindLabel(row.kind)}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatBytes(row.bytes)}
              {total > 0 ? ` · ${formatPercent(row.bytes / total)}` : ""}
            </span>
          </div>
          <SizeBar bytes={row.bytes} max={max} className="mt-1" />
        </div>
      ))}
    </div>
  );
}

function ConsumerRow({
  consumer,
  max,
  onSelect,
  selected,
  showComposition,
}: {
  consumer: Consumer;
  max: number;
  onSelect?: (consumer: Consumer) => void;
  selected?: boolean;
  /** Thread rows: what the thread is holding, broken down by process tree. */
  showComposition?: boolean;
}) {
  // A thread row's label *is* the thread title, so repeating it as the caption
  // renders "Fleet8 w1 — e2e project cost-to-cash · Fleet8 w1 — e2e project
  // cost-to-cash". Show the caption only when it says something new.
  const caption =
    showComposition === true
      ? consumer.detail
      : consumer.threadTitle !== null && consumer.threadTitle !== consumer.label
        ? `· ${consumer.threadTitle}`
        : null;
  const interactive = onSelect !== undefined;
  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-3 rounded-md px-2 py-1.5",
          interactive ? "cursor-pointer hover:bg-muted/50" : "",
          selected === true ? "bg-muted/60" : "",
        )}
        onClick={interactive ? () => onSelect(consumer) : undefined}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={
          interactive
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(consumer);
                }
              }
            : undefined
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm">{consumer.label}</span>
            {caption === null || showComposition === true ? null : (
              <span className="truncate text-xs text-muted-foreground">{caption}</span>
            )}
          </div>
          {showComposition === true && caption !== null && caption !== "" ? (
            <div className="truncate text-xs text-muted-foreground">{caption}</div>
          ) : null}
          <SizeBar bytes={consumer.bytes} max={max} className="mt-1" />
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums">{formatBytes(consumer.bytes)}</div>
          <div className="text-[11px] tabular-nums text-muted-foreground">
            {consumer.processCount > 1 ? `${consumer.processCount} procs · ` : ""}
            {formatDuration(consumer.ageSeconds * 1000)}
          </div>
        </div>
      </div>
    </li>
  );
}

export function ConsumerList({
  title,
  hint,
  consumers,
  emptyMessage,
  showComposition,
}: {
  title: string;
  hint?: string;
  consumers: readonly Consumer[];
  emptyMessage: string;
  showComposition?: boolean;
}) {
  const max = Math.max(...consumers.map((row) => row.bytes), 1);
  return (
    <section className="px-4 pb-4 md:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint === undefined ? null : (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </div>
      {consumers.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="mt-1.5 space-y-0.5">
          {consumers.map((consumer) => (
            <ConsumerRow
              key={consumer.id}
              consumer={consumer}
              max={max}
              showComposition={showComposition}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The honesty note.
 *
 * Every per-process memory column on a modern OS overstates, because shared
 * pages are counted once per mapper. Saying so in the UI is cheaper than
 * fielding "why does this add up to 40 GB on a 24 GB machine" — and it tells
 * the reader what the table is actually good for.
 */
export function AttributionNote() {
  return (
    <p className="px-4 pb-4 text-xs text-muted-foreground md:px-5">
      <Icon name="Info" className="mr-1 inline size-3.5 align-[-2px]" />
      Per-process figures are resident set size. Shared pages count once per process that maps them,
      so this table sums to more than the machine holds — rank with it, reconcile with the totals
      above.
    </p>
  );
}

export function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon name={icon} className={cn("size-6", toneText.neutral)} />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

export { toneFill };
