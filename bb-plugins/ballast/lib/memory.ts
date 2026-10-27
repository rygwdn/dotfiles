/**
 * Reading physical memory, without the lie.
 *
 * The obvious source on macOS is `memory_pressure`, whose "System-wide memory
 * free percentage" is what most scripts reach for. It should not be trusted:
 * on the machine this plugin was written for it reported **61% free** while
 * the box held 5.2 GB of swap, 6 GB of compressed pages and had 1.4 GB
 * genuinely unused. It counts inactive and speculative pages as free, so it
 * stays reassuring right up until the machine starts paging.
 *
 * So Ballast reads `vm_stat` page classes directly and reconstructs the four
 * numbers Activity Monitor shows, plus the two rates that actually predict
 * trouble: swap-in and compression. On Linux the same shape comes out of
 * /proc/meminfo, where `MemAvailable` is the kernel's own answer to the
 * question this module exists to ask.
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { MemorySample } from "./contract";

const run = promisify(exec);

/** Counters that only mean something as a delta between two samples. */
export interface RateCursor {
  atMs: number;
  swapInPages: number;
  swapOutPages: number;
  pageSize: number;
}

export interface SampleResult {
  sample: MemorySample;
  cursor: RateCursor;
}

/** `vm_stat` prints `Pages free: 11887.` — keys vary by OS version, values don't. */
export function parseVmStat(text: string): { pageSize: number; pages: Map<string, number> } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (match === null) continue;
    pages.set(match[1].trim().toLowerCase(), Number(match[2]));
  }
  return { pageSize, pages };
}

/** `vm.swapusage: total = 6144.00M  used = 5192.50M  free = 951.50M` */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } {
  const scale = (value: string, unit: string): number => {
    const n = Number(value);
    if (unit === "G") return n * 1024 ** 3;
    if (unit === "M") return n * 1024 ** 2;
    if (unit === "K") return n * 1024;
    return n;
  };
  const total = /total\s*=\s*([\d.]+)([KMG])/.exec(text);
  const used = /used\s*=\s*([\d.]+)([KMG])/.exec(text);
  return {
    totalBytes: total === null ? 0 : scale(total[1], total[2]),
    usedBytes: used === null ? 0 : scale(used[1], used[2]),
  };
}

/**
 * macOS grades its own memory pressure and exposes the verdict. 1 is normal,
 * 2 warn, 4 critical — the same ladder that drives the kernel's jetsam
 * notifications, which is to say the ladder that decides when the OS starts
 * killing things on its own. Worth more than any threshold we could invent.
 */
export function parseKernelPressure(text: string): MemorySample["kernelPressure"] {
  const value = Number(/:\s*(\d+)/.exec(text)?.[1] ?? NaN);
  if (value === 4) return "critical";
  if (value === 2) return "warn";
  if (value === 1) return "normal";
  return null;
}

/**
 * The swap traffic counters, in pages.
 *
 * Swapins/Swapouts only. Pageins counts every file-backed page fault —
 * launching a binary, reading an mmap'd file, refilling the file cache — and
 * runs at hundreds of MB a minute on a healthy machine with no swap at all.
 * A zero swap counter is a real zero, so test for the key rather than falling
 * back on falsiness; Pageins is only a stand-in when vm_stat has no swap rows.
 */
export function swapCounters(pages: Map<string, number>): { swapInPages: number; swapOutPages: number } {
  const pick = (swap: string, page: string): number =>
    pages.has(swap) ? (pages.get(swap) ?? 0) : (pages.get(page) ?? 0);
  return { swapInPages: pick("swapins", "pageins"), swapOutPages: pick("swapouts", "pageouts") };
}

function rate(current: number, previous: number, elapsedMs: number, pageSize: number): number {
  // A counter that went backwards means the machine rebooted or the cursor is
  // from a previous plugin load. Report nothing rather than a fabricated spike.
  if (elapsedMs <= 0 || current < previous) return 0;
  return ((current - previous) * pageSize) / (elapsedMs / 1000);
}

async function sampleDarwin(previous: RateCursor | null): Promise<SampleResult> {
  const [vmStat, sysctl] = await Promise.all([
    run("vm_stat", { timeout: 5000 }),
    run("sysctl -n hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level", { timeout: 5000 }),
  ]);
  const { pageSize, pages } = parseVmStat(vmStat.stdout);
  const [memsizeLine, swapLine, pressureLine] = sysctl.stdout.split("\n");

  const get = (key: string): number => pages.get(key) ?? 0;
  const bytes = (key: string): number => get(key) * pageSize;

  const totalBytes = Number(memsizeLine?.trim() ?? 0);
  const swap = parseSwapUsage(swapLine ?? "");

  const wiredBytes = bytes("pages wired down");
  const compressedBytes = bytes("pages occupied by compressor");
  const purgeableBytes = bytes("pages purgeable");
  const cachedFileBytes = bytes("file-backed pages");
  const freeBytes = bytes("pages free");
  const speculativeBytes = bytes("pages speculative");

  // "App Memory" in Activity Monitor: anonymous pages a process asked for and
  // has not volunteered to give back. Purgeable pages are anonymous too, but
  // the kernel may drop them on demand, so they belong in headroom instead.
  const appBytes = Math.max(0, bytes("anonymous pages") - purgeableBytes);

  // Clean file pages and speculative read-ahead cost nothing to reclaim — the
  // kernel drops them without writing anything. That, plus what is genuinely
  // free, is the budget a new allocation draws on before the machine has to
  // start compressing or swapping to satisfy it.
  const headroomBytes = freeBytes + speculativeBytes + cachedFileBytes + purgeableBytes;

  const compressorPages = get("pages occupied by compressor");
  const storedPages = get("pages stored in compressor");

  const cursor: RateCursor = {
    atMs: Date.now(),
    ...swapCounters(pages),
    pageSize,
  };
  const elapsedMs = previous === null ? 0 : cursor.atMs - previous.atMs;

  return {
    cursor,
    sample: {
      atMs: cursor.atMs,
      totalBytes,
      freeBytes,
      appBytes,
      wiredBytes,
      compressedBytes,
      cachedFileBytes,
      purgeableBytes,
      headroomBytes,
      usedBytes: appBytes + wiredBytes + compressedBytes,
      swapTotalBytes: swap.totalBytes,
      swapUsedBytes: swap.usedBytes,
      swapInRate:
        previous === null ? 0 : rate(cursor.swapInPages, previous.swapInPages, elapsedMs, pageSize),
      swapOutRate:
        previous === null
          ? 0
          : rate(cursor.swapOutPages, previous.swapOutPages, elapsedMs, pageSize),
      compressionRatio: compressorPages > 0 ? storedPages / compressorPages : 1,
      kernelPressure: parseKernelPressure(pressureLine ?? ""),
    },
  };
}

/** `MemTotal:       16384000 kB` — every value in /proc/meminfo is in kB. */
export function parseMeminfo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([^:]+):\s+(\d+)\s*kB/.exec(line);
    if (match !== null) out.set(match[1].toLowerCase(), Number(match[2]) * 1024);
  }
  return out;
}

async function sampleLinux(previous: RateCursor | null): Promise<SampleResult> {
  const [meminfoText, vmstatText] = await Promise.all([
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/vmstat", "utf8").catch(() => ""),
  ]);
  const info = parseMeminfo(meminfoText);
  const get = (key: string): number => info.get(key) ?? 0;

  const vmstat = new Map<string, number>();
  for (const line of vmstatText.split("\n")) {
    const [key, value] = line.split(/\s+/);
    if (key !== undefined && value !== undefined) vmstat.set(key, Number(value));
  }

  const totalBytes = get("memtotal");
  const freeBytes = get("memfree");
  const cachedFileBytes = get("cached") + get("buffers");
  const swapTotalBytes = get("swaptotal");
  const swapUsedBytes = Math.max(0, swapTotalBytes - get("swapfree"));
  // MemAvailable is the kernel's own estimate of what a new allocation can get
  // without swapping. It already accounts for unreclaimable slab and low
  // watermarks, so it beats anything assembled from the other fields.
  const headroomBytes = info.has("memavailable") ? get("memavailable") : freeBytes + cachedFileBytes;
  const usedBytes = Math.max(0, totalBytes - freeBytes - cachedFileBytes);
  // zram/zswap when present; otherwise the compressor simply isn't in play.
  const compressedBytes = get("zswap");

  const cursor: RateCursor = {
    atMs: Date.now(),
    swapInPages: vmstat.get("pswpin") ?? 0,
    swapOutPages: vmstat.get("pswpout") ?? 0,
    pageSize: 4096,
  };
  const elapsedMs = previous === null ? 0 : cursor.atMs - previous.atMs;

  return {
    cursor,
    sample: {
      atMs: cursor.atMs,
      totalBytes,
      freeBytes,
      appBytes: Math.max(0, usedBytes - compressedBytes),
      wiredBytes: get("sunreclaim"),
      compressedBytes,
      cachedFileBytes,
      purgeableBytes: 0,
      headroomBytes,
      usedBytes,
      swapTotalBytes,
      swapUsedBytes,
      swapInRate:
        previous === null ? 0 : rate(cursor.swapInPages, previous.swapInPages, elapsedMs, 4096),
      swapOutRate:
        previous === null ? 0 : rate(cursor.swapOutPages, previous.swapOutPages, elapsedMs, 4096),
      compressionRatio: 1,
      kernelPressure: null,
    },
  };
}

export async function sampleMemory(previous: RateCursor | null): Promise<SampleResult> {
  return platform() === "darwin" ? sampleDarwin(previous) : sampleLinux(previous);
}
