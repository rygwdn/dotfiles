import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes, formatPercent, formatRate } from "@/lib/format";
import {
  barPercent,
  levelIcon,
  levelLabel,
  levelTone,
  toneBorder,
  toneFill,
  toneText,
  toneTrack,
  type Tone,
} from "@/lib/ui";
import type { HistoryPoint, Pressure } from "@/lib/contract";

/** A thin magnitude bar for a table row. One hue: it encodes size, not identity. */
export function SizeBar({
  bytes,
  max,
  tone = "info",
  className,
}: {
  bytes: number;
  max: number;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-muted-foreground/10", className)}>
      <div
        className={cn("h-full rounded-full", toneFill[tone])}
        style={{ width: `${barPercent(bytes, max)}%` }}
      />
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 truncate text-lg font-semibold tabular-nums", toneText[tone])}>
        {value}
      </div>
      {hint === undefined ? null : (
        <div className="truncate text-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

export function LevelPill({ pressure }: { pressure: Pressure }) {
  const tone = levelTone(pressure.level);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        toneBorder[tone],
        toneText[tone],
      )}
    >
      <Icon name={levelIcon(pressure.level)} className="size-3.5" />
      {levelLabel(pressure.level)}
    </span>
  );
}

/**
 * The composition bar: where memory actually is, in one row.
 *
 * Four segments in the order they cost you something — app memory you asked
 * for, wired memory you cannot get back, compressed memory that used to be
 * app memory, and cached files the kernel will drop for free. The last
 * segment is drawn as track rather than fill on purpose: it looks like space,
 * because functionally it is.
 */
function CompositionBar({ pressure }: { pressure: Pressure }) {
  const { sample } = pressure;
  const tone = levelTone(pressure.level);
  const total = Math.max(1, sample.totalBytes);
  const pct = (bytes: number): number => (bytes / total) * 100;
  const segments = [
    { key: "app", bytes: sample.appBytes, className: toneFill[tone], label: "App memory" },
    { key: "wired", bytes: sample.wiredBytes, className: cn(toneFill[tone], "opacity-70"), label: "Wired" },
    {
      key: "compressed",
      bytes: sample.compressedBytes,
      className: cn(toneFill[tone], "opacity-40"),
      label: "Compressed",
    },
    {
      key: "cached",
      bytes: sample.cachedFileBytes,
      className: "bg-muted-foreground/25",
      label: "Cached files",
    },
  ].filter((segment) => segment.bytes > 0);

  const accounted = segments.reduce((sum, segment) => sum + segment.bytes, 0);
  const free = Math.max(0, total - accounted);

  return (
    <div>
      <div
        className="mt-3 flex h-2.5 w-full gap-0.5"
        role="img"
        aria-label={`${formatBytes(sample.usedBytes)} used of ${formatBytes(sample.totalBytes)}`}
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn("rounded-[3px]", segment.className)}
            style={{ width: `${pct(segment.bytes)}%` }}
          />
        ))}
        {free > 0 ? (
          <div className={cn("rounded-[3px]", toneTrack[tone])} style={{ width: `${pct(free)}%` }} />
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-[2px]", segment.className)} aria-hidden />
            {segment.label} {formatBytes(segment.bytes)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The header band: one hero number, the composition, and the four figures that
 * decide whether the number matters.
 */
export function PressureBand({ pressure }: { pressure: Pressure }) {
  const { sample } = pressure;
  const tone = levelTone(pressure.level);
  const used = sample.totalBytes > 0 ? sample.usedBytes / sample.totalBytes : 0;

  return (
    <div className="border-b border-border bg-card/40 px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-3">
          <span className={cn("text-3xl font-semibold tabular-nums leading-none", toneText[tone])}>
            {formatPercent(used, 1)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">in use</span>
              <LevelPill pressure={pressure} />
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {formatBytes(sample.totalBytes)} physical memory
            </div>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <StatTile
            label="Headroom"
            value={formatBytes(sample.headroomBytes)}
            tone={tone}
            hint="before it pages"
          />
          <StatTile
            label="Compressed"
            value={formatBytes(sample.compressedBytes)}
            hint={sample.compressionRatio > 1 ? `${sample.compressionRatio.toFixed(1)}x squeeze` : undefined}
          />
          <StatTile
            label="Swap"
            value={formatBytes(sample.swapUsedBytes)}
            hint={`of ${formatBytes(sample.swapTotalBytes)}`}
          />
          <StatTile
            label="Paging in"
            value={sample.swapInRate > 0 ? formatRate(sample.swapInRate) : "—"}
            tone={sample.swapInRate > 0 ? "warn" : "neutral"}
            hint={sample.swapInRate > 0 ? "reading memory off disk" : "not paging"}
          />
        </div>
      </div>

      <CompositionBar pressure={pressure} />

      {pressure.signals.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {pressure.signals.map((signal) => (
            <span
              key={signal.detail}
              className={cn("inline-flex items-center gap-1.5", toneText[levelTone(signal.level)])}
            >
              <Icon name={levelIcon(signal.level)} className="size-3.5" />
              {signal.detail}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{pressure.reason}</p>
      )}
    </div>
  );
}

/**
 * Six hours of headroom, as an area.
 *
 * Headroom rather than "used" because it is the number the thresholds are set
 * against, and because a line that falls toward zero reads as danger without
 * needing a legend to explain which direction is bad.
 */
export function HistoryChart({
  history,
  pressure,
}: {
  history: readonly HistoryPoint[];
  pressure: Pressure;
}) {
  if (history.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
        Collecting history…
      </div>
    );
  }
  const tone = levelTone(pressure.level);
  const width = 600;
  const height = 96;
  const max = Math.max(...history.map((point) => point.headroomBytes), 1);
  const firstAt = history[0].atMs;
  const span = Math.max(1, history[history.length - 1].atMs - firstAt);

  const points = history.map((point) => {
    const x = ((point.atMs - firstAt) / span) * width;
    const y = height - (point.headroomBytes / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${points.join(" ")} ${width},${height}`;

  return (
    <div className="px-4 pb-3 md:px-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Headroom over time</h2>
        <span className="text-xs text-muted-foreground">
          peak {formatBytes(max)} · {Math.round(span / 60_000)} minutes
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="mt-2 h-24 w-full"
        role="img"
        aria-label={`Headroom over the last ${Math.round(span / 60_000)} minutes, currently ${formatBytes(
          pressure.sample.headroomBytes,
        )}`}
      >
        <polygon points={area} className={cn(toneFill[tone], "opacity-15")} fill="currentColor" />
        <polyline
          points={points.join(" ")}
          fill="none"
          strokeWidth={1.5}
          className={toneText[tone]}
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
