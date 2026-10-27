import { stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import type { DiskReport } from "./contract";
import { formatBytes } from "./format";

/** Capacity only: no directory traversal, file inventory, or cleanup. */
export async function readDisk(): Promise<DiskReport> {
  const report: DiskReport = { atMs: Date.now(), volumes: [], errors: [] };
  const devices = new Set<number>();
  for (const path of new Set(["/", homedir()])) {
    try {
      const [info, space] = await Promise.all([stat(path), statfs(path)]);
      if (devices.has(info.dev)) continue;
      devices.add(info.dev);
      report.volumes.push({
        path,
        totalBytes: space.blocks * space.bsize,
        usedBytes: (space.blocks - space.bfree) * space.bsize,
        availableBytes: space.bavail * space.bsize,
      });
    } catch (error) {
      report.errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export function renderDisk(report: DiskReport): string {
  return [
    "Disk capacity (root and home filesystems; no directory scan):",
    ...report.volumes.map((volume) =>
      `  ${volume.path}: ${formatBytes(volume.usedBytes)} used of ${formatBytes(volume.totalBytes)}` +
      ` (${volume.totalBytes > 0 ? (100 * volume.usedBytes / volume.totalBytes).toFixed(1) : "0.0"}%), ` +
      `${formatBytes(volume.availableBytes)} available`),
    ...report.errors.map((error) => `  ${error.path}: unavailable — ${error.message}`),
    "Available excludes filesystem reservations; shared APFS volumes are not additive.",
  ].join("\n");
}
