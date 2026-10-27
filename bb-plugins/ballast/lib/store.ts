/**
 * What Ballast keeps between samples.
 *
 * Almost nothing, deliberately. Memory is a live quantity — the process table
 * is re-read every sample and never cached — so the only things worth
 * persisting are the two that would otherwise be lost across a reload: a
 * downsampled history so the chart survives a restart, and the guard's own
 * activity log, which is the record of every automatic decision the plugin
 * made on the user's behalf.
 */
import type { Database, Statement } from "better-sqlite3";
import type { GuardEvent, HistoryPoint, MemorySample, PressureLevel } from "./contract";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS samples (
     at_ms INTEGER PRIMARY KEY,
     used_bytes INTEGER NOT NULL,
     headroom_bytes INTEGER NOT NULL,
     swap_used_bytes INTEGER NOT NULL,
     compressed_bytes INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS samples_at ON samples (at_ms DESC)`,
  `CREATE TABLE IF NOT EXISTS guard_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at_ms INTEGER NOT NULL,
     level TEXT NOT NULL,
     headroom_bytes INTEGER NOT NULL,
     used_fraction REAL NOT NULL,
     action TEXT NOT NULL,
     detail TEXT NOT NULL,
     bytes_freed INTEGER NOT NULL,
     thread_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS guard_events_at ON guard_events (at_ms DESC)`,
];

/** Six hours at a ten-second sample. Enough to see a build tip the machine over. */
const HISTORY_RETENTION_MS = 6 * 3_600_000;
const EVENT_RETENTION = 500;

export class Store {
  private readonly insertSample: Statement;
  private readonly insertEvent: Statement;

  constructor(private readonly db: Database) {
    this.insertSample = db.prepare(
      `INSERT OR REPLACE INTO samples (at_ms, used_bytes, headroom_bytes, swap_used_bytes, compressed_bytes)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.insertEvent = db.prepare(
      `INSERT INTO guard_events (at_ms, level, headroom_bytes, used_fraction, action, detail, bytes_freed, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  getMeta<T>(key: string): T | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(key, JSON.stringify(value));
  }

  deleteMeta(key: string): void {
    this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
  }

  /**
   * Retention is swept on a timer, not on every insert.
   *
   * The sweep costs more than the insert it would accompany, and running it
   * every sample would mean a scan-and-delete every few seconds to remove rows
   * that are only expiring once an hour. Sweeping every ten minutes bounds the
   * table just as well.
   */
  private lastPruneMs = 0;

  recordSample(sample: MemorySample): void {
    this.insertSample.run(
      sample.atMs,
      sample.usedBytes,
      sample.headroomBytes,
      sample.swapUsedBytes,
      sample.compressedBytes,
    );
    const now = Date.now();
    if (now - this.lastPruneMs > 600_000) {
      this.lastPruneMs = now;
      this.db.prepare(`DELETE FROM samples WHERE at_ms < ?`).run(now - HISTORY_RETENTION_MS);
    }
  }

  /**
   * History for the chart, thinned to a target point count.
   *
   * Six hours of ten-second samples is 2160 rows for a sparkline a few hundred
   * pixels wide. Bucketing by nth-row keeps the shape and the extremes without
   * shipping twenty times more data than the chart can draw.
   */
  history(limit = 240): HistoryPoint[] {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM samples`).get() as { n: number }
    ).n;
    const stride = Math.max(1, Math.ceil(total / limit));
    const rows = this.db
      .prepare(
        `SELECT at_ms, used_bytes, headroom_bytes, swap_used_bytes, compressed_bytes
         FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY at_ms) AS rn FROM samples)
         WHERE rn % ? = 0 ORDER BY at_ms`,
      )
      .all(stride) as Array<{
      at_ms: number;
      used_bytes: number;
      headroom_bytes: number;
      swap_used_bytes: number;
      compressed_bytes: number;
    }>;
    return rows.map((row) => ({
      atMs: row.at_ms,
      usedBytes: row.used_bytes,
      headroomBytes: row.headroom_bytes,
      swapUsedBytes: row.swap_used_bytes,
      compressedBytes: row.compressed_bytes,
    }));
  }

  recordGuardEvent(event: Omit<GuardEvent, "id">): void {
    this.insertEvent.run(
      event.atMs,
      event.level,
      event.headroomBytes,
      event.usedFraction,
      event.action,
      event.detail,
      event.bytesFreed,
      event.threadId,
    );
    this.db
      .prepare(
        `DELETE FROM guard_events WHERE id NOT IN
           (SELECT id FROM guard_events ORDER BY at_ms DESC LIMIT ?)`,
      )
      .run(EVENT_RETENTION);
  }

  events(limit = 50): GuardEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM guard_events ORDER BY at_ms DESC LIMIT ?`)
      .all(limit) as Array<{
      id: number;
      at_ms: number;
      level: string;
      headroom_bytes: number;
      used_fraction: number;
      action: string;
      detail: string;
      bytes_freed: number;
      thread_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      atMs: row.at_ms,
      level: row.level as PressureLevel,
      headroomBytes: row.headroom_bytes,
      usedFraction: row.used_fraction,
      action: row.action as GuardEvent["action"],
      detail: row.detail,
      bytesFreed: row.bytes_freed,
      threadId: row.thread_id,
    }));
  }
}
