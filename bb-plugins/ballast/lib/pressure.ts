/**
 * Grading a reading into a level.
 *
 * Four independent signals, each graded on its own, and the worst one wins.
 * A single percentage cannot express this: 90% used with 4 GB of clean file
 * cache behind it is fine, and 70% used while paging in 300 MB a minute is
 * not. The reason string always names the signal that decided, because a
 * banner that says "memory is critical" without saying which number moved is
 * an alarm you learn to ignore.
 */
import type { MemorySample, Pressure, PressureLevel, Thresholds } from "./contract";
import { formatBytes, formatPercent, formatRate } from "./format";

export const DEFAULT_THRESHOLDS: Thresholds = {
  watchPercent: 75,
  warnPercent: 85,
  criticalPercent: 92,
  minHeadroomGb: 3,
  swapRateMbPerMin: 200,
};

const ORDER: Record<PressureLevel, number> = { ok: 0, watch: 1, warn: 2, critical: 3 };

export function worst(a: PressureLevel, b: PressureLevel): PressureLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

interface Signal {
  level: PressureLevel;
  detail: string;
}

/**
 * The used fraction, measured against memory that can actually be handed out.
 *
 * Denominator is total, not total-minus-wired: wired memory is real memory the
 * machine no longer has, and hiding it makes a kernel leak invisible.
 */
export function usedFraction(sample: MemorySample): number {
  if (sample.totalBytes <= 0) return 0;
  return Math.min(1, sample.usedBytes / sample.totalBytes);
}

function gradePercent(sample: MemorySample, thresholds: Thresholds): Signal | null {
  const fraction = usedFraction(sample);
  const percent = fraction * 100;
  const detail = `${formatPercent(fraction, 1)} of ${formatBytes(sample.totalBytes)} in use`;
  if (percent >= thresholds.criticalPercent) return { level: "critical", detail };
  if (percent >= thresholds.warnPercent) return { level: "warn", detail };
  if (percent >= thresholds.watchPercent) return { level: "watch", detail };
  return null;
}

/**
 * Absolute headroom, graded separately from the percentage for the same reason
 * Reclaim grades free bytes separately from percent-full: on a 128 GB machine
 * 8% headroom is 10 GB and nothing is wrong, while on a 16 GB machine the same
 * percentage is 1.3 GB and the next Chrome tab is a swap storm.
 */
function gradeHeadroom(sample: MemorySample, thresholds: Thresholds): Signal | null {
  const gb = sample.headroomBytes / 1024 ** 3;
  const floor = Math.max(0.5, thresholds.minHeadroomGb);
  const detail = `${formatBytes(sample.headroomBytes)} headroom before the machine has to page`;
  if (gb <= floor / 3) return { level: "critical", detail };
  if (gb <= floor / 1.5) return { level: "warn", detail };
  if (gb <= floor) return { level: "watch", detail };
  return null;
}

/**
 * Paging rate: the only signal here that measures harm rather than risk.
 *
 * Every other number says the machine *might* struggle. This one says it is
 * already reading memory back off an SSD, which is where interactive latency
 * goes to die. Swap that is merely *resident* is not a problem — pages parked
 * there since yesterday cost nothing — so the grade is on the rate, never on
 * the total.
 */
function gradeSwapRate(sample: MemorySample, thresholds: Thresholds): Signal | null {
  const mbPerMin = (sample.swapInRate * 60) / 1024 ** 2;
  const limit = Math.max(10, thresholds.swapRateMbPerMin);
  const detail = `paging in ${formatRate(sample.swapInRate)} from swap`;
  if (mbPerMin >= limit * 3) return { level: "critical", detail };
  if (mbPerMin >= limit) return { level: "warn", detail };
  if (mbPerMin >= limit / 4) return { level: "watch", detail };
  return null;
}

/** The kernel's own verdict. It outranks our arithmetic when it disagrees. */
function gradeKernel(sample: MemorySample): Signal | null {
  if (sample.kernelPressure === "critical") {
    return { level: "critical", detail: "the kernel reports critical memory pressure" };
  }
  if (sample.kernelPressure === "warn") {
    return { level: "warn", detail: "the kernel reports elevated memory pressure" };
  }
  return null;
}

export function evaluatePressure(sample: MemorySample, thresholds: Thresholds): Pressure {
  const signals = [
    gradeKernel(sample),
    gradeHeadroom(sample, thresholds),
    gradeSwapRate(sample, thresholds),
    gradePercent(sample, thresholds),
  ].filter((signal): signal is Signal => signal !== null);

  signals.sort((a, b) => ORDER[b.level] - ORDER[a.level]);
  const level = signals.reduce<PressureLevel>((acc, signal) => worst(acc, signal.level), "ok");

  const reason =
    signals.length === 0
      ? `${formatBytes(sample.headroomBytes)} headroom, no swap activity`
      : signals[0].detail;

  return { sample, level, reason, signals, thresholds };
}
