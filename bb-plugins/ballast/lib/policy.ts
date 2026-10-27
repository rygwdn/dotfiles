/**
 * Pure policy: how often to look, and how to read the two settings that are
 * free text. No plugin host, no I/O — so the rules that decide Ballast's own
 * cost and its refusal lists can be tested directly.
 */
import type { PressureLevel } from "./contract";

/**
 * How often to look, given what we last saw.
 *
 * A fixed interval is the wrong trade in both directions: fast enough to catch
 * a build tipping the machine over is far too fast for a laptop sitting idle,
 * and slow enough to be polite is too slow to intervene before the OS does.
 * So the configured interval is the *pressured* rate, and a healthy machine is
 * checked six times less often. Since a healthy sample reads only memory
 * totals — no process table, no SDK call — the steady-state cost of running
 * Ballast is a few milliseconds a minute.
 */
export function cadenceMs(config: { sampleSeconds: number }, level: PressureLevel): number {
  const base = config.sampleSeconds * 1000;
  if (level === "critical" || level === "warn") return base;
  if (level === "watch") return base * 2;
  return base * 6;
}

/**
 * "8080-8090, 3000" → {8080…8090, 3000}
 *
 * Parsed permissively and validated hard. A typo must not take the guard
 * offline, so malformed input contributes nothing rather than throwing — but
 * it must never *widen* the set either, since every port in here is one
 * Ballast has agreed not to touch. An absurd range is refused outright rather
 * than expanded into tens of thousands of entries.
 */
export function parsePorts(text: string): Set<number> {
  const ports = new Set<number>();
  for (const part of text.split(/[,\s]+/)) {
    if (part === "") continue;
    const range = /^(\d{1,5})-(\d{1,5})$/.exec(part);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from >= 1 && to <= 65535 && to >= from && to - from <= 1000) {
        for (let port = from; port <= to; port += 1) ports.add(port);
      }
      continue;
    }
    const single = Number(part);
    if (Number.isInteger(single) && single >= 1 && single <= 65535) ports.add(single);
  }
  return ports;
}

export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}
