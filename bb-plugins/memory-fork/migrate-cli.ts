import { PluginCliError, cliCommand, type PluginCliCommand } from "@get-bb/plugin-sdk";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// Mnemopi bank root; overridable for tests and alternate installs.
// Resolved at call time so tests can point it at a temporary fixture.
function banksRoot(): string {
  return (
    process.env.MEMORY_FORK_BANKS_ROOT ??
    join(homedir(), ".omp/agent/memories/mnemopi/banks")
  );
}

interface Candidate {
  bank: string;
  table: string;
  rowid: number;
  content: string;
  timestamp: string | null;
  source: string | null;
  suggestedName: string;
  suggestedKind: string;
}

function openBankReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unnamed";
}

function listBanks(): string[] {
  if (!existsSync(banksRoot())) return [];
  return readdirSync(banksRoot()).filter((entry) =>
    existsSync(join(banksRoot(), entry, "mnemopi.db")),
  );
}

function candidatesForBank(bank: string): Candidate[] {
  const db = openBankReadOnly(join(banksRoot(), bank, "mnemopi.db"));
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((t) => t.name));
    const candidates: Candidate[] = [];
    if (names.has("working_memory")) {
      const rows = db
        .prepare(
          "SELECT rowid, id, content, source, timestamp, metadata_json FROM working_memory ORDER BY rowid",
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const source = typeof row.source === "string" ? row.source : null;
        let metadata: Record<string, unknown> = {};
        try {
          metadata =
            typeof row.metadata_json === "string"
              ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
              : {};
        } catch {
          metadata = {};
        }
        const isLearn =
          source === "coding-agent-learn" ||
          source === "learn" ||
          metadata.learn === true;
        const content = typeof row.content === "string" ? row.content : "";
        if (!isLearn || content.trim().length === 0) continue;
        candidates.push({
          bank,
          table: "working_memory",
          rowid: Number(row.rowid),
          content,
          timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
          source,
          suggestedName: `mnemopi-${sanitizeName(bank)}-w${Number(row.rowid)}`,
          suggestedKind: "procedure",
        });
      }
    }
    if (names.has("episodic_memory")) {
      const rows = db
        .prepare(
          "SELECT rowid, id, content, source, timestamp, metadata_json FROM episodic_memory ORDER BY rowid",
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        let metadata: Record<string, unknown> = {};
        try {
          metadata =
            typeof row.metadata_json === "string"
              ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
              : {};
        } catch {
          metadata = {};
        }
        // Transcript-style episodic rows are excluded by default; only rows
        // the LLM itself distilled (llm_used true) are candidates.
        if (metadata.llm_used !== true) continue;
        const content = typeof row.content === "string" ? row.content : "";
        if (content.trim().length === 0) continue;
        candidates.push({
          bank,
          table: "episodic_memory",
          rowid: Number(row.rowid),
          content,
          timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
          source: typeof row.source === "string" ? row.source : null,
          suggestedName: `mnemopi-${sanitizeName(bank)}-e${Number(row.rowid)}`,
          suggestedKind: "fact",
        });
      }
    }
    return candidates;
  } finally {
    db.close();
  }
}

interface PlanItem {
  bank: string;
  table: string;
  rowid: number;
  name?: string;
  kind?: string;
  tags?: string[];
  importance?: number;
  scope?: "project" | "global" | "bot";
  projectId?: string;
}

export function migrateCommands(deps: {
  addMemory: (input: {
    scope: string;
    projectId: string | null;
    ownerBotId: string | null;
    name: string;
    summary: string;
    details: string;
    kind: string;
    tags: string[];
    importance: number;
    pinned: boolean;
    sourceThreadId: string | null;
    writeReason: string;
  }) => unknown;
  reviewMemory: (input: {
    name: string;
    verdict: "unreviewed" | "valid" | "quarantined";
    reason: string;
  }) => { version: number; tags: string[] };
}): Record<string, PluginCliCommand> {
  return {
    "migrate inspect": cliCommand({
      summary:
        "Read-only scan of OMP Mnemopi banks: counts and migration candidates",
      options: {
        bank: {
          type: "string",
          description: "Limit to one bank directory name",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        if (ctx.threadId) throw new PluginCliError("Migration requires operator context");
        const banks = input.options.bank
          ? [input.options.bank]
          : listBanks();
        const report: Array<Record<string, unknown>> = [];
        for (const bank of banks) {
          const dbPath = join(banksRoot(), bank, "mnemopi.db");
          if (!existsSync(dbPath)) continue;
          const db = openBankReadOnly(dbPath);
          try {
            const counts: Record<string, number> = {};
            for (const table of [
              "working_memory",
              "episodic_memory",
              "facts",
              "memoria_facts",
            ]) {
              try {
                counts[table] = (
                  db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
                    c: number;
                  }
                ).c;
              } catch {
                counts[table] = 0;
              }
            }
            const candidates = candidatesForBank(bank);
            report.push({ bank, dbPath, counts, candidates });
          } finally {
            db.close();
          }
        }
        return {
          exitCode: 0,
          stdout: input.options.json
            ? JSON.stringify({ ok: true, banks: report }, null, 2)
            : report
                .map(
                  (r) =>
                    `${r.bank}: working=${(r.counts as Record<string, number>).working_memory} episodic=${(r.counts as Record<string, number>).episodic_memory} candidates=${(r.candidates as Candidate[]).length}`,
                )
                .join("\n") || "No mnemopi banks found.",
        };
      },
    }),
    "migrate import": cliCommand({
      summary:
        "Import only plan-listed Mnemopi records as memories (idempotent, provenance kept)",
      description:
        "Plan file shape: { items: [{ bank, table, rowid, name?, kind?, tags?, importance?, scope? }] }. Reruns skip names that already exist in the target scope.",
      options: {
        plan: {
          type: "string",
          required: true,
          description: "Path to the migration plan JSON",
        },
        "dry-run": {
          type: "boolean",
          description: "Validate and report without writing",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        if (ctx.threadId) throw new PluginCliError("Migration requires operator context");
        const planPath = input.options.plan;
        if (!existsSync(planPath)) {
          throw new PluginCliError(`plan file not found: ${planPath}`);
        }
        let plan: unknown;
        try {
          plan = JSON.parse(readFileSync(planPath, "utf8")) as unknown;
        } catch (error) {
          throw new PluginCliError(`plan file is not valid JSON: ${String(error)}`);
        }
        const items = (plan as { items?: unknown }).items;
        if (!Array.isArray(items) || items.length === 0) {
          throw new PluginCliError("plan must contain a non-empty items array");
        }
        const results: Array<Record<string, unknown>> = [];
        for (const raw of items) {
          const item = raw as PlanItem;
          const dbPath = join(banksRoot(), item.bank, "mnemopi.db");
          if (!existsSync(dbPath)) {
            results.push({ item, status: "error", error: "bank not found" });
            continue;
          }
          const db = openBankReadOnly(dbPath);
          let row: Record<string, unknown> | undefined;
          try {
            // episodic_memory carries explicit validity signals (veracity,
            // degraded_at, metadata_json); facts carry a confidence score.
            // Rows flagged superseded/degraded/low-confidence are imported
            // pre-quarantined so they can never masquerade as verified.
            // Schema versions differ. Inspect every available validity column,
            // including working_memory's native superseded/expiry fields.
            const columns = "rowid, *";
            row = db
              .prepare(`SELECT ${columns} FROM ${item.table} WHERE rowid = ?`)
              .get(item.rowid) as Record<string, unknown> | undefined;
          } catch {
            row = undefined;
          } finally {
            db.close();
          }
          if (!row || typeof row.content !== "string") {
            results.push({ item, status: "error", error: "row not found" });
            continue;
          }
          const name = sanitizeName(
            item.name ??
              `mnemopi-${sanitizeName(item.bank)}-${item.table === "episodic_memory" ? "e" : "w"}${item.rowid}`,
          );
          const summary = row.content.trim().slice(0, 200);
          const provenance = `migrated from mnemopi bank ${item.bank} ${item.table} rowid ${item.rowid}${
            row.timestamp ? ` (${row.timestamp})` : ""
          }; original id ${String(row.id)}`;
          // Explicit validity signals from the source bank: superseded/degraded
          // episodes and low-confidence facts are quarantined at import time.
          const validitySignals: string[] = [];
          for (const field of ["superseded_by", "corrected_by", "deleted_at", "degraded_at"]) {
            if (row[field] != null && row[field] !== "") validitySignals.push(`source ${field}`);
          }
          const expired = (value: unknown): boolean => {
            if (value == null || value === "") return false;
            const timestamp = typeof value === "number"
              ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
            return Number.isFinite(timestamp) && timestamp <= Date.now();
          };
          if (expired(row.valid_until) || expired(row.expires_at)) validitySignals.push("source expired");
          if (typeof row.metadata_json === "string") {
            try {
              const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
              if (meta.superseded_by || meta.superseded || meta.corrected_by || meta.deleted || meta.deleted_at || meta.expired || expired(meta.expires_at) || expired(meta.valid_until)) {
                validitySignals.push("source metadata superseded/deleted/expired");
              }
            } catch { validitySignals.push("source metadata unreadable; review required"); }
          }
          if (item.table === "episodic_memory") {
            const veracity = typeof row.veracity === "string" ? row.veracity.toLowerCase() : "";
            if (veracity && veracity !== "unknown" && veracity !== "true") {
              validitySignals.push(`source veracity=${veracity}`);
            }
            if (row.degraded_at) {
              validitySignals.push("source degraded");
            }
            if (typeof row.metadata_json === "string" && row.metadata_json) {
              try {
                const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
                if (meta.superseded_by || meta.superseded || meta.expired) {
                  validitySignals.push("source superseded/expired");
                }
                const expiresAt = typeof meta.expires_at === "string" ? Date.parse(meta.expires_at) : NaN;
                if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
                  validitySignals.push("source expired");
                }
              } catch {
                // unparseable metadata is not a validity signal
              }
            }
          } else if (item.table === "facts" && typeof row.confidence === "number" && row.confidence < 0.5) {
            validitySignals.push(`source confidence=${row.confidence}`);
          }
          const autoTags = [...new Set(["migrated", ...((item.tags ?? []).filter(tag => !tag.startsWith("validity-"))),
            validitySignals.length ? "validity-quarantined" : "validity-unreviewed"])];
          const scope = item.scope ?? "project";
          const projectId = scope === "project" ? (item.projectId ?? ctx.projectId ?? null) : null;
          if (scope === "bot") {
            results.push({ item, status: "error", error: "bot imports require a bound, actor-scoped migration path" });
            continue;
          }
          if (scope === "project" && !projectId) {
            results.push({ item, status: "error", error: "no project context" });
            continue;
          }
          if (input.options["dry-run"]) {
            results.push({ item, status: "dry-run", name, scope, projectId, provenance, validitySignals, tags: autoTags });
            continue;
          }
          try {
            deps.addMemory({
              scope,
              projectId,
              ownerBotId: null,
              name,
              summary,
              details: row.content,
              kind: item.kind ?? "fact",
              tags: autoTags,
              importance: item.importance ?? 50,
              pinned: false,
              sourceThreadId: ctx.threadId ?? null,
              writeReason: validitySignals.length
                ? `${provenance}; quarantined at import: ${validitySignals.join("; ")}`
                : provenance,
            });
            results.push({ item, status: "imported", name, scope });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({
              item,
              status: message.includes("already exists") ? "skipped" : "error",
              error: message,
              name,
            });
          }
        }
        const imported = results.filter((r) => r.status === "imported").length;
        const skipped = results.filter((r) => r.status === "skipped").length;
        const failed = results.filter((r) => r.status === "error").length;
        return {
          exitCode: failed > 0 ? 1 : 0,
          stdout: input.options.json
            ? JSON.stringify(
                { ok: failed === 0, imported, skipped, failed, results },
                null,
                2,
              )
            : `imported=${imported} skipped=${skipped} failed=${failed}`,
        };
      },
    }),
    "migrate review": cliCommand({
      summary:
        "Set an explicit validity verdict on migrated records (versioned; originals stay in history)",
      description:
        "Applies a validity tag as a new version via the normal optimistic-update path, so every prior version — including the exact imported original — remains in `bb memory history`. Use verdict=valid only after reviewing current semantic correctness and scope; matching source bytes alone is insufficient; verdict=quarantined for questionable imports (kept but flagged so recall/injection ordering can skip them).",
      options: {
        names: {
          type: "string",
          required: true,
          description: "Comma-separated memory names to review",
        },
        verdict: {
          type: "enum",
          values: ["unreviewed", "valid", "quarantined"],
          required: true,
          description:
            "validity-unreviewed (re)flags records awaiting content review; valid marks audited records; quarantined flags questionable imports (kept, excluded from injection)",
        },
        reason: {
          type: "string",
          required: true,
          description: "Why this verdict was reached (audit trail)",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        if (ctx.threadId) throw new PluginCliError("Migration requires operator context");
        const names = String(input.options.names)
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        const verdict = String(input.options.verdict) as
          | "unreviewed"
          | "valid"
          | "quarantined";
        const reason = String(input.options.reason);
        const results: Array<Record<string, unknown>> = [];
        for (const name of names) {
          try {
            const result = deps.reviewMemory({
              name,
              verdict,
              reason,
            });
            results.push({ name, status: "reviewed", ...result });
          } catch (error) {
            results.push({
              name,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const failed = results.filter((r) => r.status === "error").length;
        return {
          exitCode: failed > 0 ? 1 : 0,
          stdout: input.options.json
            ? JSON.stringify({ ok: failed === 0, results }, null, 2)
            : results
                .map((r) =>
                  r.status === "error"
                    ? `${r.name}: ERROR ${r.error}`
                    : `${r.name}: ${verdict} at v${r.version}`,
                )
                .join("\n"),
        };
      },
    }),
  };
}


