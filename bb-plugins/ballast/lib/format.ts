/**
 * Formatting shared by the server (CLI + agent tools) and the app bundle.
 * Everything here is pure so it can be unit-tested without a plugin host.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * RAM is the one place the powers-of-two convention actually wins.
 *
 * A machine has 24 GiB of memory and every tool that reports on it — Activity
 * Monitor, `top`, `vm_stat`, `free` — counts in 1024s. Reclaim uses powers of
 * 1000 because disk vendors and Finder do; Ballast uses 1024 for the same
 * reason in reverse. Agreeing with the OS matters more than agreeing with the
 * sibling plugin.
 */
export function formatBytes(bytes: number, options?: { precise?: boolean }): string {
  if (!Number.isFinite(bytes)) return "—";
  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = options?.precise
    ? value >= 100
      ? 1
      : 2
    : unit === 0 || value >= 100
      ? 0
      : value >= 10
        ? 1
        : 2;
  return `${negative ? "-" : ""}${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Fixed-width byte column for CLI tables, so sizes line up under each other. */
export function padBytes(bytes: number, width = 9): string {
  return formatBytes(bytes).padStart(width);
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Swap and compression rates, the signals that say "this machine is thrashing"
 * rather than "this machine is full". Per minute, because per second is noise
 * at a 10-second sample and per hour hides a spike entirely.
 */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0";
  return `${formatBytes(bytesPerSecond * 60)}/min`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

/**
 * `MM-DD HH:MM` in the machine's own timezone, for the activity log.
 *
 * Local, not UTC. An activity log is read against the reader's memory of what
 * they were doing; printing 23:26 for something that happened at 19:26 made a
 * stale event look like it had just fired, and cost an hour of chasing a bug
 * that had already been fixed.
 */
export function formatLocalStamp(atMs: number): string {
  const at = new Date(atMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Relative age, for "last sampled" and "running for" labels. */
export function formatAgo(atMs: number | null, nowMs = Date.now()): string {
  if (atMs === null || !Number.isFinite(atMs)) return "never";
  const delta = Math.max(0, nowMs - atMs);
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Shorten a path for display without losing the tail, which is the part that
 * identifies what the row actually is.
 */
export function shortenPath(path: string, homeDir: string | null): string {
  if (homeDir && path === homeDir) return "~";
  if (homeDir && path.startsWith(`${homeDir}/`)) {
    return `~/${path.slice(homeDir.length + 1)}`;
  }
  return path;
}

/** Left-truncate to a budget: `…/deep/tail/segment`. */
export function ellipsize(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}
