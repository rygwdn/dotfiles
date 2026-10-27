import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  defineRpcContract,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isMemoryKind, MEMORY_KINDS, type MemoryKind } from "./memory-kinds.js";
import { ProposalStore, type ProposalMemorySink, type MemorySnapshot, type ProposalRecord } from "./proposal-store.js";
import { proposalAndDreamCommands } from "./dreams-cli.js";
import { migrateCommands } from "./migrate-cli.js";
import { ompCutoverHostContract } from "./omp-cutover-contract.js";

const CATALOG_MAX_CHARS = 3_900;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

type MemoryScope = "global" | "project" | "bot";
type ReadScope = MemoryScope | "all";
type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  ownerBotId: string | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  sourceThreadId: string | null;
  writeReason: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const memoryKindSchema = z.enum(MEMORY_KINDS);
const memoryRecordSchema: z.ZodType<MemoryRecord> = z
  .object({
    id: z.string(),
    scope: z.enum(["global", "project", "bot"]),
    projectId: z.string().nullable(),
    ownerBotId: z.string().nullable(),
    name: z.string(),
    summary: z.string(),
    details: z.string(),
    kind: memoryKindSchema,
    tags: z.array(z.string()),
    importance: z.number().int().min(0).max(100),
    pinned: z.boolean(),
    sourceThreadId: z.string().nullable(),
    writeReason: z.string(),
    version: z.number().int().positive(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const memoryUpdateInputSchema = z
  .object({
    id: z.string(),
    expectedVersion: z.number().int().positive(),
    summary: z.string(),
    details: z.string(),
    kind: memoryKindSchema,
    tags: z.array(z.string()),
    importance: z.number().int().min(0).max(100),
    pinned: z.boolean(),
  })
  .strict();

const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "applied",
  "rolled_back",
] as const;

const proposalRecordSchema: z.ZodType<ProposalRecord> = z.object({
  id: z.string(),
  action: z.enum(["dedupe", "supersede", "retire", "skill", "edit"]),
  targetIds: z.array(z.string()),
  payload: z.unknown(),
  evidence: z.unknown(),
  status: z.enum(PROPOSAL_STATUSES),
  runId: z.string().nullable(),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  decisionReason: z.string().nullable(),
  appliedVersion: z.number().nullable(),
  appliedSnapshot: z
    .object({
      memories: z.array(
        z.custom<MemorySnapshot>(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "record" in value &&
            "deleted" in value,
        ),
      ),
    })
    .nullable(),
});

export const memoryRpcContract = defineRpcContract({
  listMemories: {
    input: z.null(),
    output: z.object({ memories: z.array(memoryRecordSchema) }).strict(),
  },
  updateMemory: {
    input: memoryUpdateInputSchema,
    output: z.object({ memory: memoryRecordSchema }).strict(),
  },
  deleteMemory: {
    input: z
      .object({
        id: z.string(),
        expectedVersion: z.number().int().positive(),
      })
      .strict(),
    output: z
      .object({
        deleted: z
          .object({ id: z.string(), version: z.number().int().positive() })
          .strict(),
      })
      .strict(),
  },
  listProposals: {
    input: z
      .object({ status: z.enum(["all", ...PROPOSAL_STATUSES]).default("all") })
      .strict(),
    output: z
      .object({ proposals: z.array(proposalRecordSchema) })
      .strict(),
  },
  dreamsStatus: {
    input: z.null(),
    output: z
      .object({
        lastRun: z.record(z.string(), z.unknown()).nullable(),
        proposalCounts: z.record(z.string(), z.number()),
        pending: z.number().int().nonnegative(),
      })
      .strict(),
  },
  decideProposal: {
    input: z
      .object({
        id: z.string().min(1),
        decision: z.enum(["approved", "rejected", "cancelled"]),
        reason: z.string().min(1),
      })
      .strict(),
    output: z.object({ proposal: proposalRecordSchema }).strict(),
  },
  applyProposal: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ proposal: proposalRecordSchema }).strict(),
  },
  rollbackProposal: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ proposal: proposalRecordSchema }).strict(),
  },
});

type MemorySummary = Omit<
  MemoryRecord,
  "details" | "sourceThreadId" | "writeReason" | "createdAt"
>;

interface MemoryCreate {
  scope: MemoryScope;
  projectId: string | null;
  ownerBotId: string | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  sourceThreadId: string | null;
  writeReason: string;
}

interface MemoryUpdate {
  expectedVersion: number;
  summary?: string;
  details?: string;
  kind?: MemoryKind;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  sourceThreadId: string | null;
  writeReason: string;
}

class CliError extends PluginCliError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMemoryRow(row: unknown): MemoryRecord {
  if (!isRecord(row))
    throw new Error("memory database returned an invalid row");
  const scope: MemoryScope =
    row.scope === "project"
      ? "project"
      : row.scope === "bot"
        ? "bot"
        : "global";
  const kind = isMemoryKind(row.kind) ? row.kind : "fact";
  return {
    id: String(row.id),
    scope,
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    ownerBotId: typeof row.owner_bot_id === "string" ? row.owner_bot_id : null,
    name: String(row.name),
    summary: String(row.summary),
    details: String(row.details),
    kind,
    tags: parseTags(row.tags_json),
    importance: Number(row.importance),
    pinned: Number(row.pinned) === 1,
    sourceThreadId:
      typeof row.source_thread_id === "string" ? row.source_thread_id : null,
    writeReason: String(row.write_reason),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toMemorySummary(memory: MemoryRecord): MemorySummary {
  return {
    id: memory.id,
    scope: memory.scope,
    projectId: memory.projectId,
    ownerBotId: memory.ownerBotId,
    name: memory.name,
    summary: memory.summary,
    kind: memory.kind,
    tags: memory.tags,
    importance: memory.importance,
    pinned: memory.pinned,
    version: memory.version,
    updatedAt: memory.updatedAt,
  };
}

function createMemoryId(): string {
  return `mem_${randomBytes(8).toString("base64url").toLowerCase()}`;
}

function scopeKey(scope: MemoryScope, projectId: string | null, botId: string | null): string {
  if (scope === "global") return "global";
  if (scope === "bot") return `bot:${botId ?? "missing"}`;
  return `project:${projectId ?? "missing"}`;
}

function normalizeOneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unsafeMemoryReason(value: string): string | null {
  if (/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u.test(value)) {
    return "contains invisible or bidirectional control characters";
  }
  if (/<\/?\s*(system|developer|assistant|tool)(?:\s|>)/iu.test(value)) {
    return "contains a role-like prompt tag";
  }
  if (
    /\b(ignore|disregard|override)\b.{0,50}\b(previous|prior|system|developer)\b/isu.test(
      value,
    )
  ) {
    return "looks like a prompt-injection instruction";
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) {
    return "contains a private key";
  }
  if (/\b(?:sk-[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,})\b/iu.test(value)) {
    return "contains a token-like secret";
  }
  if (/\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*\S+/u.test(value)) {
    return "contains a credential assignment";
  }
  return null;
}

function validateText(label: string, value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new CliError(`${label} must not be empty`);
  if (trimmed.length > maxChars) {
    throw new CliError(`${label} must be at most ${maxChars} characters`);
  }
  const unsafe = unsafeMemoryReason(trimmed);
  if (unsafe) throw new CliError(`${label} ${unsafe}; memory was not written`);
  return trimmed;
}

function validateName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!NAME_PATTERN.test(normalized)) {
    throw new CliError(
      "name must be 1-80 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

function validateTags(values: string[]): string[] {
  const tags = [...new Set(values.map((tag) => tag.trim().toLowerCase()))];
  if (tags.length > 20) throw new CliError("at most 20 tags are allowed");
  for (const tag of tags) {
    if (!TAG_PATTERN.test(tag)) {
      throw new CliError(
        `invalid tag "${tag}"; use lowercase letters, digits, dots, underscores, or hyphens`,
      );
    }
  }
  return tags;
}

interface WriteScopeResult {
  scope: MemoryScope;
  projectId: string | null;
  botId: string | null;
}

function writeScope(
  scope: MemoryScope,
  projectId: string | undefined,
  botId: string | null,
): WriteScopeResult {
  if (scope === "global") return { scope: "global", projectId: null, botId: null };
  if (scope === "bot") {
    if (!botId) {
      throw new CliError(
        "bot-scoped memory requires a bot bound to this thread; use project or global scope instead",
      );
    }
    return { scope: "bot", projectId: null, botId };
  }
  if (projectId === undefined) {
    throw new CliError(
      "project-scoped memory requires a BB project context; run inside a project thread",
    );
  }
  return { scope: "project", projectId, botId: null };
}

function scopeSql(
  scope: ReadScope,
  projectId: string | undefined,
  botId: string | null,
): { sql: string; params: string[] } {
  if (scope === "global") {
    return { sql: "m.scope = 'global'", params: [] };
  }
  if (scope === "project") {
    if (!projectId)
      throw new CliError("project scope requires a BB project context");
    return {
      sql: "m.scope = 'project' AND m.project_id = ?",
      params: [projectId],
    };
  }
  if (scope === "bot") {
    if (!botId)
      throw new CliError(
        "bot scope requires a bot bound to this thread",
      );
    return {
      sql: "m.scope = 'bot' AND m.owner_bot_id = ?",
      params: [botId],
    };
  }
  if (!projectId && !botId) return { sql: "m.scope = 'global'", params: [] };
  const parts: string[] = ["m.scope = 'global'"];
  const params: string[] = [];
  if (projectId) {
    parts.push("(m.scope = 'project' AND m.project_id = ?)");
    params.push(projectId);
  }
  if (botId) {
    parts.push("(m.scope = 'bot' AND m.owner_bot_id = ?)");
    params.push(botId);
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}

function searchExpression(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0)
    throw new CliError("search query has no searchable terms");
  return [...new Set(tokens)]
    .slice(0, 12)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function memorySnapshot(memory: MemoryRecord): Record<string, unknown> {
  return {
    id: memory.id,
    scope: memory.scope,
    projectId: memory.projectId,
    ownerBotId: memory.ownerBotId,
    name: memory.name,
    summary: memory.summary,
    details: memory.details,
    kind: memory.kind,
    tags: memory.tags,
    importance: memory.importance,
    pinned: memory.pinned,
    sourceThreadId: memory.sourceThreadId,
    writeReason: memory.writeReason,
    version: memory.version,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

class MemoryStore {
  constructor(private readonly db: PluginDatabase) {}

  add(input: MemoryCreate): MemoryRecord {
    if (input.scope === "bot" && !input.ownerBotId)
      throw new CliError("bot-scoped memory requires an owning bot");
    if (input.scope !== "bot" && input.ownerBotId)
      throw new CliError("only bot-scoped memory carries an owning bot");
    const now = Date.now();
    const id = createMemoryId();
    const record: MemoryRecord = {
      id,
      scope: input.scope,
      projectId: input.projectId,
      ownerBotId: input.ownerBotId,
      name: validateName(input.name),
      summary: validateText("summary", input.summary, 400),
      details: validateText("details", input.details, 16_000),
      kind: input.kind,
      tags: validateTags(input.tags),
      importance: input.importance,
      pinned: input.pinned,
      sourceThreadId: input.sourceThreadId,
      writeReason: validateText("reason", input.writeReason, 500),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO memories (
               id, scope, scope_key, project_id, owner_bot_id, name, summary, details, kind,
               tags_json, importance, pinned, source_thread_id, write_reason,
               version, created_at, updated_at, deleted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            record.id,
            record.scope,
            scopeKey(record.scope, record.projectId, record.ownerBotId),
            record.projectId,
            record.ownerBotId,
            record.name,
            record.summary,
            record.details,
            record.kind,
            JSON.stringify(record.tags),
            record.importance,
            record.pinned ? 1 : 0,
            record.sourceThreadId,
            record.writeReason,
            record.version,
            record.createdAt,
            record.updatedAt,
          );
        this.insertHistory(
          record,
          "create",
          record.sourceThreadId,
          record.writeReason,
        );
      })();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new CliError(
          `an active ${record.scope} memory named "${record.name}" already exists`,
        );
      }
      throw error;
    }
    return record;
  }

  update(
    id: string,
    input: MemoryUpdate,
    ctxProjectId: string | undefined,
    ctxBotId: string | null,
    includeQuarantined = false,
  ): MemoryRecord {
    return this.db.transaction(() => {
      const current = includeQuarantined ? this.getIncludingQuarantined(id, "all", ctxProjectId, ctxBotId) : this.get(id, "all", ctxProjectId, ctxBotId, false);
      if (!current)
        throw new CliError(`memory "${id}" was not found in the current scope`);
      if (current.scope === "bot" && current.ownerBotId !== ctxBotId) {
        throw new CliError("bot-scoped memory can only be changed by its owning bot");
      }
      if (current.version !== input.expectedVersion) {
        throw new CliError(
          `version conflict for ${id}: expected ${input.expectedVersion}, current ${current.version}`,
        );
      }
      const updated: MemoryRecord = {
        ...current,
        summary:
          input.summary === undefined
            ? current.summary
            : validateText("summary", input.summary, 400),
        details:
          input.details === undefined
            ? current.details
            : validateText("details", input.details, 16_000),
        kind: input.kind ?? current.kind,
        tags:
          input.tags === undefined ? current.tags : validateTags(input.tags),
        importance: input.importance ?? current.importance,
        pinned: input.pinned ?? current.pinned,
        sourceThreadId: input.sourceThreadId,
        writeReason: validateText("reason", input.writeReason, 500),
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      const result = this.db
        .prepare(
          `UPDATE memories SET
             summary = ?, details = ?, kind = ?, tags_json = ?, importance = ?,
             pinned = ?, source_thread_id = ?, write_reason = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .run(
          updated.summary,
          updated.details,
          updated.kind,
          JSON.stringify(updated.tags),
          updated.importance,
          updated.pinned ? 1 : 0,
          updated.sourceThreadId,
          updated.writeReason,
          updated.version,
          updated.updatedAt,
          updated.id,
          current.version,
        );
      if (result.changes !== 1)
        throw new CliError(`memory ${id} changed concurrently; retry`);
      this.insertHistory(
        updated,
        "update",
        updated.sourceThreadId,
        updated.writeReason,
      );
      return updated;
    })();
  }

  forget(
    id: string,
    expectedVersion: number,
    reason: string,
    sourceThreadId: string | null,
    ctxProjectId: string | undefined,
    ctxBotId: string | null,
    includeQuarantined = false,
  ): MemoryRecord {
    return this.db.transaction(() => {
      const current = includeQuarantined
        ? this.getIncludingQuarantined(id, "all", ctxProjectId, ctxBotId)
        : this.get(id, "all", ctxProjectId, ctxBotId, false);
      if (!current)
        throw new CliError(`memory "${id}" was not found in the current scope`);
      if (current.scope === "bot" && current.ownerBotId !== ctxBotId) {
        throw new CliError("bot-scoped memory can only be forgotten by its owning bot");
      }
      if (current.version !== expectedVersion) {
        throw new CliError(
          `version conflict for ${id}: expected ${expectedVersion}, current ${current.version}`,
        );
      }
      const writeReason = validateText("reason", reason, 500);
      const forgotten: MemoryRecord = {
        ...current,
        sourceThreadId,
        writeReason,
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      const result = this.db
        .prepare(
          `UPDATE memories SET deleted_at = ?, source_thread_id = ?, write_reason = ?,
             version = ?, updated_at = ?
           WHERE id = ? AND version = ? AND deleted_at IS NULL`,
        )
        .run(
          forgotten.updatedAt,
          sourceThreadId,
          writeReason,
          forgotten.version,
          forgotten.updatedAt,
          current.id,
          current.version,
        );
      if (result.changes !== 1)
        throw new CliError(`memory ${id} changed concurrently; retry`);
      this.insertHistory(forgotten, "forget", sourceThreadId, writeReason);
      return forgotten;
    })();
  }

  get(
    idOrName: string,
    scope: ReadScope,
    projectId: string | undefined,
    ctxBotId: string | null,
    touch = true,
  ): MemoryRecord | null {
    const scoped = scopeSql(scope, projectId, ctxBotId);
    const row: unknown = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.deleted_at IS NULL AND (m.id = ? OR m.name = ?)
           AND m.tags_json NOT LIKE '%"validity-quarantined"%' AND ${scoped.sql}
         ORDER BY CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END, m.updated_at DESC
         LIMIT 1`,
      )
      .get(idOrName, idOrName, ...scoped.params);
    if (row === undefined) return null;
    const memory = parseMemoryRow(row);
    if (touch) {
      this.db
        .prepare("UPDATE memories SET last_accessed_at = ? WHERE id = ?")
        .run(Date.now(), memory.id);
    }
    return memory;
  }

  /**
   * Look up a record regardless of validity-quarantine status. Only for
   * admin paths (quarantine notice in CLI get, migrate review); ordinary
   * reads must not see quarantined records.
   */
  getIncludingQuarantined(
    idOrName: string,
    scope: ReadScope,
    projectId: string | undefined,
    ctxBotId: string | null,
  ): MemoryRecord | null {
    const scoped = scopeSql(scope, projectId, ctxBotId);
    const row: unknown = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.deleted_at IS NULL AND (m.id = ? OR m.name = ?) AND ${scoped.sql}
         ORDER BY CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END, m.updated_at DESC
         LIMIT 1`,
      )
      .get(idOrName, idOrName, ...scoped.params);
    return row === undefined ? null : parseMemoryRow(row);
  }

  list(
    scope: ReadScope,
    projectId: string | undefined,
    ctxBotId: string | null,
    limit: number,
  ): {
    memories: MemoryRecord[];
    total: number;
  } {
    const scoped = scopeSql(scope, projectId, ctxBotId);
    const rows: unknown[] = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.deleted_at IS NULL
           AND m.tags_json NOT LIKE '%"validity-quarantined"%' AND ${scoped.sql}
         ORDER BY m.pinned DESC,
           CASE WHEN m.scope = 'project' THEN 0 ELSE 1 END,
           m.importance DESC, COALESCE(m.last_accessed_at, 0) DESC,
           m.updated_at DESC, m.name ASC
         LIMIT ?`,
      )
      .all(...scoped.params, limit);
    const countRow: unknown = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM memories m
         WHERE m.deleted_at IS NULL
           AND m.tags_json NOT LIKE '%"validity-quarantined"%' AND ${scoped.sql}`,
      )
      .get(...scoped.params);
    const total = isRecord(countRow) ? Number(countRow.count) : 0;
    return { memories: rows.map(parseMemoryRow), total };
  }

  listAll(): MemoryRecord[] {
    const rows: unknown[] = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE deleted_at IS NULL
         ORDER BY pinned DESC, scope ASC, project_id ASC, importance DESC,
           updated_at DESC, name ASC`,
      )
      .all();
    return rows.map(parseMemoryRow);
  }

  getAdmin(id: string): MemoryRecord | null {
    const row: unknown = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    return row === undefined ? null : parseMemoryRow(row);
  }

  search(
    query: string,
    scope: ReadScope,
    projectId: string | undefined,
    ctxBotId: string | null,
    limit: number,
  ): MemoryRecord[] {
    const scoped = scopeSql(scope, projectId, ctxBotId);
    const rows: unknown[] = this.db
      .prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE memories_fts MATCH ? AND m.deleted_at IS NULL
           AND m.tags_json NOT LIKE '%"validity-quarantined"%' AND ${scoped.sql}
         ORDER BY bm25(memories_fts), m.pinned DESC, m.importance DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(searchExpression(query), ...scoped.params, limit);
    return rows.map(parseMemoryRow);
  }

  history(
    id: string,
    projectId: string | undefined,
    ctxBotId: string | null,
    limit: number,
  ): unknown[] {
    const scoped = scopeSql("all", projectId, ctxBotId);
    return this.db
      .prepare(
        `SELECT h.version, h.action, h.snapshot_json, h.source_thread_id,
           h.write_reason, h.created_at
         FROM memory_history h
         JOIN memories m ON m.id = h.memory_id
         WHERE h.memory_id = ? AND m.tags_json NOT LIKE '%"validity-quarantined"%' AND ${scoped.sql}
         ORDER BY h.version DESC
         LIMIT ?`,
      )
      .all(id, ...scoped.params, limit);
  }

  restoreSnapshot(snapshot: { record: unknown; deleted: boolean }, reason: string): MemoryRecord {
    return this.db.transaction(() => {
      const memory = parseMemoryRow(snapshot.record);
      const currentRow: unknown = this.db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(memory.id);
      if (currentRow === undefined) {
        throw new CliError(`memory ${memory.id} no longer exists; cannot restore`);
      }
      const current = parseMemoryRow(currentRow);
      const restored: MemoryRecord = {
        ...memory,
        version: current.version + 1,
        updatedAt: Date.now(),
        writeReason: validateText("reason", reason, 500),
      };
      const result = this.db
        .prepare(
          `UPDATE memories SET
             scope = ?, scope_key = ?, project_id = ?, owner_bot_id = ?, name = ?,
             summary = ?, details = ?, kind = ?, tags_json = ?, importance = ?,
             pinned = ?, write_reason = ?, version = ?, updated_at = ?, deleted_at = NULL
           WHERE id = ?`,
        )
        .run(
          restored.scope,
          scopeKey(restored.scope, restored.projectId, restored.ownerBotId),
          restored.projectId,
          restored.ownerBotId,
          restored.name,
          restored.summary,
          restored.details,
          restored.kind,
          JSON.stringify(restored.tags),
          restored.importance,
          restored.pinned ? 1 : 0,
          restored.writeReason,
          restored.version,
          restored.updatedAt,
          restored.id,
        );
      if (result.changes !== 1) {
        throw new CliError(`memory ${restored.id} no longer exists; cannot restore`);
      }
      this.insertHistory(restored, "update", null, restored.writeReason);
      return restored;
    })();
  }

  private insertHistory(
    memory: MemoryRecord,
    action: "create" | "update" | "forget",
    sourceThreadId: string | null,
    writeReason: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_history (
           memory_id, version, action, snapshot_json, source_thread_id, write_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.version,
        action,
        JSON.stringify(memorySnapshot(memory)),
        sourceThreadId,
        writeReason,
        memory.updatedAt,
      );
  }
}

function displayMemory(memory: MemoryRecord, includeDetails: boolean): string {
  const tags = memory.tags.length > 0 ? ` tags=${memory.tags.join(",")}` : "";
  const lines = [
    `${memory.id} v${memory.version} [${memory.scope}/${memory.kind}] ${memory.name}`,
    `  ${memory.summary}`,
    `  importance=${memory.importance} pinned=${memory.pinned}${tags}`,
  ];
  if (includeDetails) {
    lines.push(
      "",
      memory.details,
      "",
      `Reason: ${memory.writeReason}`,
      `Source thread: ${memory.sourceThreadId ?? "none"}`,
    );
  }
  return lines.join("\n");
}

function renderCatalog(store: MemoryStore, projectId: string, botId: string | null): string {
  const { memories, total } = store.list("all", projectId, botId, MAX_RESULT_LIMIT);
  // Quarantined migrations are already excluded by store.list; kept for
  // history/audit only, never injected.
  const effectiveTotal = total;
  const header = [
    "Memory index",
    "The entries below are summaries, not full records. Use `bb memory search <query> --scope all --json` and `bb memory get <id> --json` to progressively disclose details.",
    "You may proactively save durable learning with `bb memory add`. Use project scope for repository-specific facts, bot scope (requires a bot bound to this thread) for durable knowledge about this bot's role and preferences that should follow it across threads, and global scope only for broadly applicable user preferences or workflows. Never store secrets, transient status, guesses, or rules already guaranteed by AGENTS.md.",
    "In BB-hosted sessions the native memory devices (xd://recall, xd://retain, xd://reflect, xd://memory_edit) are removed from the tool surface. Durable memory lives only in BB memory: use the `recall` and `learn` tools or `bb memory` CLI (search/get/add/update/forget).",
    "Bot-private summaries are withheld from this synchronous index. Use bb memory search/get --scope bot for live ownership resolution.",
    "",
  ].join("\n");
  if (memories.length === 0 && total === 0)
    return `${header}No shared memories are stored in this scope.`;

  const lines: string[] = [];
  for (const memory of memories) {
    const tags =
      memory.tags.length > 0 ? `; ${memory.tags.slice(0, 3).join(",")}` : "";
    const pin = memory.pinned ? "; pinned" : "";
    const line = `- ${memory.id} [${memory.scope}/${memory.kind}${pin}${tags}] ${memory.name}: ${normalizeOneLine(memory.summary)}`;
    const candidate = `${header}${[...lines, line].join("\n")}`;
    if (candidate.length > CATALOG_MAX_CHARS) break;
    lines.push(line);
  }
  let finalLines = lines;
  let footer = "";
  while (true) {
    const finalShown = finalLines.length;
    footer =
      finalShown < effectiveTotal
        ? `\nShowing ${finalShown} of ${total}; run \`bb memory catalog --scope all --json\` for the rest.`
        : "";
    if (
      `${header}${finalLines.join("\n")}${footer}`.length <= CATALOG_MAX_CHARS
    ) {
      break;
    }
    finalLines = finalLines.slice(0, -1);
  }
  return `${header}${finalLines.join("\n")}${footer}`;
}

function managedSkillsDir(): string {
  return (
    process.env.MEMORY_FORK_MANAGED_SKILLS_DIR ||
    join(homedir(), ".omp/agent/managed-skills")
  );
}

function userSkillDirs(): string[] {
  const home = homedir();
  const dirs = new Set<string>();
  if (process.env.MEMORY_FORK_USER_SKILLS_DIR) {
    dirs.add(process.env.MEMORY_FORK_USER_SKILLS_DIR);
  }
  dirs.add(join(home, ".omp/agent/skills"));
  dirs.add(join(home, ".omp/skills"));
  dirs.add(join(home, ".bb/skills"));
  dirs.add(join(home, ".hermes/skills"));
  // OMP also walks up from the project for project-level skill dirs
  // (.omp/skills, .agents/skills, agent/skills); mirror that walk-up.
  let dir = process.cwd();
  for (let depth = 0; dir.startsWith(home) && depth < 8; depth += 1) {
    dirs.add(join(dir, ".omp/skills"));
    dirs.add(join(dir, ".agents/skills"));
    dirs.add(join(dir, "agent/skills"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...dirs];
}

/** Refuse to mint a managed skill whose name collides with a user-authored skill. */
function assertManagedSkillWritable(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new PluginCliError(`invalid skill name: ${name}`);
  }
  const managedRoot = managedSkillsDir();
  const collision = (): string | null => {
    try {
      const out = execFileSync("omp", ["skills", "list", "--json"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      const parsed = JSON.parse(out) as {
        skills?: Array<{ name?: string; filePath?: string; source?: string }>;
      };
      for (const skill of parsed.skills ?? []) {
        if (skill.name !== name) continue;
        const filePath = skill.filePath ?? "";
        if (filePath.startsWith(managedRoot + "/")) continue;
        return filePath || skill.source || "unknown source";
      }
      return null;
    } catch (error) {
      if (process.env.MEMORY_FORK_DEBUG) {
        console.log("registry check failed:", (error as Error).message);
      }
      throw new PluginCliError("Cannot verify authored skill registry; refusing managed skill write");
    }
  };
  const collisionPath = collision();
  if (collisionPath) {
    throw new PluginCliError(
      `skill "${name}" already exists outside the managed-skills directory (${collisionPath}); managed skills must not shadow user-authored skills`,
    );
  }
  for (const dir of userSkillDirs()) {
    if (existsSync(join(dir, name, "SKILL.md")) || existsSync(join(dir, `${name}.md`))) {
      throw new PluginCliError(
        `skill "${name}" already exists as a user-authored skill; managed skills must not overwrite user skills`,
      );
    }
  }
}

function writeManagedSkill(name: string, description: string, body: string): string {
  assertManagedSkillWritable(name);
  const managedRoot = managedSkillsDir();
  const dir = join(managedRoot, name);
  mkdirSync(dir, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\n/g, " "))}\n---\n\n`;
  atomicWrite(join(dir, "SKILL.md"), `${frontmatter}${body.trim()}\n`);
  return ` Managed skill created at ${join(dir, "SKILL.md")}.`;
}

function atomicWrite(file: string, body: string): void {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const BOT_RESOLVE_SCHEMA = z
  .object({
    botId: z.string().nullable(),
    botName: z.string().nullable(),
  })
  .strict().nullable();

async function resolveBotForThread(
  sdk: BbPluginApi["sdk"],
  db: PluginDatabase,
  threadId: string | null,
): Promise<string | null> {
  if (!threadId) return null;
  try {
    const result = await sdk.plugins.callRpc({
      pluginId: "bots-sidebar",
      method: "resolveBotForThread",
      input: { threadId },
      outputSchema: BOT_RESOLVE_SCHEMA,
    });
    // The legacy cache is no longer an authorization or catalog source.
    db.prepare("DELETE FROM thread_bot_cache WHERE thread_id = ?").run(threadId);
    return result?.botId ?? null;
  } catch {
    db.prepare("DELETE FROM thread_bot_cache WHERE thread_id = ?").run(threadId);
    // A lookup failure is not proof of an unbound thread. Never widen a
    // private learn into project/global scope during an ownership outage.
    throw new CliError("Cannot verify live bot ownership; retry when bots-sidebar is available");
  }
}

const SCOPE_DESCRIPTION = "Which memories to read";
const READ_SCOPES = ["all", "project", "global", "bot"] as const;
const MAX_EXPECTED_VERSION = Number.MAX_SAFE_INTEGER;

const freshLearnSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .describe("Stable lowercase kebab name, unique per scope"),
    summary: z
      .string()
      .min(1)
      .max(400)
      .describe("One-line retrieval summary"),
    details: z
      .string()
      .min(1)
      .max(16000)
      .describe("Complete durable detail: exact commands, evidence, caveats"),
    kind: z
      .enum(MEMORY_KINDS)
      .default("procedure")
      .describe("What kind of learning this is"),
    tags: z.array(z.string()).max(20).default([]),
    importance: z.number().int().min(0).max(100).default(60),
    reason: z
      .string()
      .min(1)
      .max(500)
      .describe("Why this will help a future thread"),
    skill: z
      .object({
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case skill name"),
        description: z
          .string()
          .min(1)
          .max(300)
          .describe("One-line description of when to use the skill"),
        body: z
          .string()
          .min(1)
          .max(32000)
          .describe("Markdown skill body (no frontmatter; generated from name/description)"),
      })
      .optional()
      .describe("Also codify this learning as a managed skill (created in the isolated managed-skills directory; user-authored skills are never touched)"),
  })
  .strict();

const correctionSchema = z.object({
  id: z.string().regex(/^mem_[a-z0-9_-]+$/, "Stable memory ID from recall"),
  expectedVersion: z.number().int().positive().max(MAX_EXPECTED_VERSION),
  replacement: z.object({
    name: z.string().regex(NAME_PATTERN).optional(),
    summary: z.string().trim().min(1).max(400),
    details: z.string().trim().min(1).max(16000),
    kind: memoryKindSchema.optional(),
    tags: z.array(z.string().regex(TAG_PATTERN)).max(20).optional(),
    importance: z.number().int().min(0).max(100).optional(),
    pinned: z.boolean().optional(),
  }).strict().optional().describe("Explicit replacement summary and full details; omit to report wrong-only for retirement review"),
}).strict();

const learnSchema = freshLearnSchema.partial({
  name: true, summary: true, details: true, kind: true, tags: true, importance: true,
}).extend({
  // Avoid inherited defaults being inserted into a correction-only payload.
  kind: memoryKindSchema.optional(),
  tags: z.array(z.string()).max(20).optional(),
  importance: z.number().int().min(0).max(100).optional(),
  correction: correctionSchema.optional().describe("Propose a correction to an existing ID/version for human review; never mutates canonical memory"),
}).superRefine((value, ctx) => {
  if (value.correction) {
    if (Object.keys(value).some(key => !["reason", "correction"].includes(key)))
      ctx.addIssue({ code: "custom", message: "Correction accepts only reason and correction; fresh learning/skill fields cannot be combined" });
  } else {
    const result = freshLearnSchema.safeParse(value);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
});

const recallSchema = z.object({
  query: z.string().trim().min(1).max(400).optional().describe("Search text; returns bounded summaries with IDs and versions"),
  id: z.string().regex(/^mem_[a-z0-9_-]+$/).optional().describe("Stable memory ID; returns the complete record"),
  scope: z.enum(READ_SCOPES).default("all"),
  limit: z.number().int().min(1).max(20).default(5).describe("Maximum search summaries, 1–20"),
}).strict().refine(value => (value.query !== undefined) !== (value.id !== undefined),
  "Provide exactly one of query or id");

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: ompCutoverHostContract });
  // This is a supported launch hook for ACP, regardless of which ACP plugin
  // owns the provider. No global OMP config or provider defaults are changed.
  bb.providers.experimental_contributeEnv("acp-omp", async ({ hostId }) => {
    const { configFiles } = await host.call("prepareOmpMemoryOverlay", null, { hostId });
    return [{
      name: "PI_CONFIG_FILES",
      value: configFiles,
      reason: "BB owns durable memory; disable native OMP memory and automatic private capture for this child only",
    }];
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS thread_bot_cache (
       thread_id TEXT PRIMARY KEY,
       bot_id TEXT NOT NULL,
       resolved_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS memories (
       id TEXT PRIMARY KEY,
       scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'bot')),
       scope_key TEXT NOT NULL,
       project_id TEXT,
       owner_bot_id TEXT,
       name TEXT NOT NULL,
       summary TEXT NOT NULL,
       details TEXT NOT NULL,
       kind TEXT NOT NULL,
       tags_json TEXT NOT NULL,
       importance INTEGER NOT NULL CHECK (importance BETWEEN 0 AND 100),
       pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
       source_thread_id TEXT,
       write_reason TEXT NOT NULL,
       version INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       deleted_at INTEGER,
       last_accessed_at INTEGER,
       access_count INTEGER NOT NULL DEFAULT 0,
       CHECK ((scope = 'global' AND project_id IS NULL AND owner_bot_id IS NULL) OR
              (scope = 'project' AND project_id IS NOT NULL AND owner_bot_id IS NULL) OR
              (scope = 'bot' AND project_id IS NULL AND owner_bot_id IS NOT NULL))
     );
     CREATE UNIQUE INDEX IF NOT EXISTS memories_active_scope_name
       ON memories(scope_key, name) WHERE deleted_at IS NULL;
     CREATE INDEX IF NOT EXISTS memories_catalog
       ON memories(scope, project_id, deleted_at, pinned, importance, updated_at);
     CREATE TABLE IF NOT EXISTS memory_history (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       memory_id TEXT NOT NULL,
       version INTEGER NOT NULL,
       action TEXT NOT NULL CHECK (action IN ('create', 'update', 'forget')),
       snapshot_json TEXT NOT NULL,
       source_thread_id TEXT,
       write_reason TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       UNIQUE(memory_id, version)
     );
     CREATE INDEX IF NOT EXISTS memory_history_memory
       ON memory_history(memory_id, version DESC);
     CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
       memory_id UNINDEXED, name, summary, details, tags
     );
     CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
       INSERT INTO memories_fts(memory_id, name, summary, details, tags)
       VALUES (new.id, new.name, new.summary, new.details, new.tags_json);
     END;
     CREATE TRIGGER IF NOT EXISTS memories_fts_update
       AFTER UPDATE OF name, summary, details, tags_json ON memories BEGIN
       DELETE FROM memories_fts WHERE memory_id = old.id;
       INSERT INTO memories_fts(memory_id, name, summary, details, tags)
       VALUES (new.id, new.name, new.summary, new.details, new.tags_json);
     END;
     CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
       DELETE FROM memories_fts WHERE memory_id = old.id;
     END;`,
    `CREATE TABLE IF NOT EXISTS memory_proposals (
       id TEXT PRIMARY KEY,
       action TEXT NOT NULL CHECK (action IN ('dedupe', 'supersede', 'retire', 'skill', 'edit')),
       target_ids_json TEXT NOT NULL,
       payload_json TEXT NOT NULL,
       evidence_json TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'rolled_back')),
       run_id TEXT,
       created_at INTEGER NOT NULL,
       decided_at INTEGER,
       decision_reason TEXT,
       applied_version INTEGER,
       applied_snapshot_json TEXT
     );
     CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_pending_unique
       ON memory_proposals(action, target_ids_json, run_id) WHERE status = 'pending';
     CREATE INDEX IF NOT EXISTS memory_proposals_status
       ON memory_proposals(status, created_at DESC);
     CREATE TABLE IF NOT EXISTS dream_runs (
       run_id TEXT PRIMARY KEY,
       started_at INTEGER NOT NULL,
       finished_at INTEGER,
       status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'quiet')),
       watermark TEXT,
       stats_json TEXT NOT NULL DEFAULT '{}'
     );`,
  ]);
  // Older installs have a proposals status CHECK without 'cancelled'; SQLite
  // cannot alter a CHECK constraint, so rebuild the table in place.
  const proposalsSql =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_proposals'",
        )
        .get() as { sql: string } | undefined
    )?.sql ?? "";
  if (proposalsSql && !proposalsSql.includes("'cancelled'")) {
    db.exec(`BEGIN;
CREATE TABLE memory_proposals_rebuild (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('dedupe', 'supersede', 'retire', 'skill', 'edit')),
  target_ids_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'applied', 'rolled_back')),
  run_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decision_reason TEXT,
  applied_version INTEGER,
  applied_snapshot_json TEXT
);
INSERT INTO memory_proposals_rebuild
  SELECT id, action, target_ids_json, payload_json, evidence_json, status,
         run_id, created_at, decided_at, decision_reason, applied_version,
         applied_snapshot_json FROM memory_proposals;
DROP TABLE memory_proposals;
ALTER TABLE memory_proposals_rebuild RENAME TO memory_proposals;
CREATE UNIQUE INDEX IF NOT EXISTS memory_proposals_pending_unique
  ON memory_proposals(action, target_ids_json, run_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS memory_proposals_status
  ON memory_proposals(status, created_at DESC);
COMMIT;`);
  }
  const store = new MemoryStore(db);

  const proposalSink: ProposalMemorySink = {
    update: (input) => {
      const current = store.getAdmin(input.id);
      if (!current) throw new CliError(`memory "${input.id}" was not found`);
      const updated = store.update(
        input.id,
        {
          expectedVersion: input.expectedVersion,
          summary: input.summary,
          details: input.details,
          kind: input.kind as MemoryKind | undefined,
          tags: input.tags,
          importance: input.importance,
          pinned: input.pinned,
          sourceThreadId: input.sourceThreadId,
          writeReason: input.writeReason,
        },
        current.projectId ?? undefined,
        current.ownerBotId,
      );
      return { version: updated.version };
    },
    forget: (input) => {
      const current = store.getAdmin(input.id);
      if (!current) throw new CliError(`memory "${input.id}" was not found`);
      const forgotten = store.forget(
        input.id,
        input.expectedVersion,
        input.reason,
        input.sourceThreadId,
        current.projectId ?? undefined,
        current.ownerBotId,
      );
      return { version: forgotten.version };
    },
    add: (input) => {
      const memory = store.add({
        scope: input.scope as MemoryScope,
        projectId: input.projectId,
        ownerBotId: input.ownerBotId,
        name: input.name,
        summary: input.summary,
        details: input.details,
        kind: input.kind as MemoryKind,
        tags: input.tags,
        importance: input.importance,
        pinned: input.pinned,
        sourceThreadId: input.sourceThreadId,
        writeReason: input.writeReason,
      });
      return { id: memory.id, version: memory.version };
    },
    restoreSnapshot: (snapshot: MemorySnapshot, reason: string) => {
      const restored = store.restoreSnapshot(snapshot, reason);
      return { version: restored.version };
    },
  };
  const proposals = new ProposalStore(db, proposalSink, managedSkillsDir(), assertManagedSkillWritable);

  bb.rpc.register(memoryRpcContract, {
    listMemories() {
      return { memories: store.listAll() };
    },
    updateMemory(input) {
      const { id } = input;
      const current = store.getAdmin(id);
      if (!current) throw new Error(`memory "${id}" was not found`);
      const memory = store.update(
        id,
        {
          expectedVersion: input.expectedVersion,
          summary: input.summary,
          details: input.details,
          kind: input.kind,
          tags: input.tags,
          importance: input.importance,
          pinned: input.pinned,
          sourceThreadId: null,
          writeReason: "Edited in Memory settings",
        },
        current.projectId ?? undefined,
        current.ownerBotId,
      );
      return { memory };
    },
    deleteMemory(input) {
      const { id } = input;
      const current = store.getAdmin(id);
      if (!current) throw new Error(`memory "${id}" was not found`);
      const memory = store.forget(
        id,
        input.expectedVersion,
        "Deleted in Memory settings",
        null,
        current.projectId ?? undefined,
        current.ownerBotId,
        true, // Explicit Settings deletion; scoped agent deletion stays filtered.
      );
      return { deleted: { id: memory.id, version: memory.version } };
    },
    listProposals(input) {
      return { proposals: proposals.list(input.status) };
    },
    dreamsStatus() {
      const counts = proposals.counts();
      const lastRun = db
        .prepare("SELECT * FROM dream_runs ORDER BY started_at DESC LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      return {
        lastRun: lastRun ?? null,
        proposalCounts: counts,
        pending: counts.pending ?? 0,
      };
    },
    decideProposal(input) {
      return { proposal: input.decision === "cancelled" ? proposals.cancel(input.id, input.reason) : proposals.decide(input.id, input.decision, input.reason) };
    },
    applyProposal(input) {
      return { proposal: proposals.apply(input.id, null) };
    },
    rollbackProposal(input) {
      return { proposal: proposals.rollback(input.id, null) };
    },
  });

  bb.agents.contributeInstructions(({ projectId }) => {
    // This callback is synchronous, and explicit Send-now can bypass admission
    // hooks. A cached binding cannot authorize disclosure after a bot rebind.
    // Private records are therefore retrieved on demand after live resolution.
    return renderCatalog(store, projectId, null);
  });

  bb.cli.register(
    defineCli({
      name: "memory",
      summary: "Read and maintain durable global and project memories",
      description:
        "Memories are summaries first: search or list, then read one in full.\nProject scope holds repository facts; global scope holds durable user preferences.",
      commands: {
        catalog: cliCommand({
          summary: "List compact memory summaries",
          aliases: ["list"],
          options: {
            scope: {
              type: "enum",
              values: READ_SCOPES,
              default: "all",
              description: SCOPE_DESCRIPTION,
            },
            limit: {
              type: "integer",
              min: 1,
              max: MAX_RESULT_LIMIT,
              default: DEFAULT_RESULT_LIMIT,
              description: "How many memories to list",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const { scope, limit } = input.options;
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const result = store.list(scope, ctx.projectId, botId, limit);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({
                    ok: true,
                    scope,
                    memories: result.memories.map(toMemorySummary),
                    total: result.total,
                  })
                : result.memories
                    .map((memory) => displayMemory(memory, false))
                    .join("\n") || "No memories.",
            };
          },
        }),
        search: cliCommand({
          summary: "Search memory summaries and details",
          positionals: [
            {
              name: "query",
              description: "Words to match; every word is searched",
              required: true,
              variadic: true,
            },
          ],
          options: {
            scope: {
              type: "enum",
              values: READ_SCOPES,
              default: "all",
              description: SCOPE_DESCRIPTION,
            },
            limit: {
              type: "integer",
              min: 1,
              max: MAX_RESULT_LIMIT,
              default: DEFAULT_RESULT_LIMIT,
              description: "How many matches to return",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const query = input.positionals.query.join(" ").trim();
            if (!query) throw new CliError("search requires a query");
            const { scope, limit } = input.options;
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const memories = store.search(query, scope, ctx.projectId, botId, limit);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({
                    ok: true,
                    query,
                    scope,
                    memories: memories.map(toMemorySummary),
                  })
                : memories
                    .map((memory) => displayMemory(memory, false))
                    .join("\n") || "No matches.",
            };
          },
        }),
        get: cliCommand({
          summary: "Read one complete memory",
          positionals: [
            {
              name: "id-or-name",
              description: "Memory id or its unique name",
              required: true,
            },
          ],
          options: {
            scope: {
              type: "enum",
              values: READ_SCOPES,
              default: "all",
              description: SCOPE_DESCRIPTION,
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const idOrName = input.positionals["id-or-name"];
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const memory = store.get(
              idOrName,
              input.options.scope,
              ctx.projectId,
              botId,
            );
            if (!memory) {
              const quarantined = store.getIncludingQuarantined(
                idOrName,
                input.options.scope,
                ctx.projectId,
                botId,
              );
              if (quarantined) {
                throw new CliError(
                  `memory "${idOrName}" is quarantined (validity-quarantined) pending scope/validity review; it is excluded from catalog, search, and get until reviewed. Use \`bb memory migrate review --names <name> --verdict valid|quarantined --reason <TEXT>\` to record a verdict (history is preserved).`,
                );
              }
              throw new CliError(
                `memory "${idOrName}" was not found in the current scope`,
              );
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, memory })
                : displayMemory(memory, true),
            };
          },
        }),
        add: cliCommand({
          summary: "Save a project or global memory",
          unexpectedPositionalHint:
            "memory text belongs in --details <TEXT>, not a bare argument",
          options: {
            scope: {
              type: "enum",
              values: ["project", "global", "bot"],
              required: true,
              description:
                "project for repository facts, bot for durable knowledge about this bot, global for user preferences",
            },
            name: {
              type: "string",
              required: true,
              placeholder: "NAME",
              aliases: ["title"],
              description:
                "Unique 1-80 character lowercase name (letters, digits, dots, underscores, hyphens)",
            },
            summary: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description: "One line retrieval summary, at most 400 characters",
            },
            details: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              aliases: ["body", "text", "content"],
              description: "Full memory text, at most 16000 characters",
            },
            reason: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description:
                "Why this is worth remembering, at most 500 characters",
            },
            kind: {
              type: "enum",
              values: MEMORY_KINDS,
              default: "fact",
              aliases: ["type"],
              description: "What kind of memory this is",
            },
            tag: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "TAG",
              aliases: ["tags"],
              description:
                "Lowercase tag; repeat or pass a comma-separated list, at most 20",
            },
            importance: {
              type: "integer",
              min: 0,
              max: 100,
              default: 50,
              description: "Ranking weight for the injected catalog",
            },
            pinned: {
              type: "boolean",
              description: "Keep this memory at the top of the catalog",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const scoped = writeScope(input.options.scope, ctx.projectId, botId);
            const memory = store.add({
              scope: scoped.scope,
              projectId: scoped.projectId,
              ownerBotId: scoped.botId,
              name: input.options.name,
              summary: input.options.summary,
              details: input.options.details,
              kind: input.options.kind,
              tags: input.options.tag,
              importance: input.options.importance,
              pinned: input.options.pinned,
              sourceThreadId: ctx.threadId ?? null,
              writeReason: input.options.reason,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, memory })
                : `Saved ${memory.id} v${memory.version} (${memory.scope}/${memory.name}).`,
            };
          },
        }),
        update: cliCommand({
          summary: "Update a memory with version checking",
          positionals: [
            { name: "id", description: "Memory id", required: true },
          ],
          constraints: [
            {
              kind: "at-least-one",
              options: [
                "summary",
                "details",
                "kind",
                "tag",
                "importance",
                "pinned",
              ],
            },
          ],
          options: {
            "expected-version": {
              type: "integer",
              min: 1,
              max: MAX_EXPECTED_VERSION,
              required: true,
              description: "Version this update is based on",
            },
            reason: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description: "Why the memory changed, at most 500 characters",
            },
            summary: {
              type: "string",
              placeholder: "TEXT",
              description: "Replacement summary, at most 400 characters",
            },
            details: {
              type: "string",
              placeholder: "TEXT",
              aliases: ["body", "text", "content"],
              description: "Replacement details, at most 16000 characters",
            },
            kind: {
              type: "enum",
              values: MEMORY_KINDS,
              aliases: ["type"],
              description: "Replacement kind",
            },
            tag: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "TAG",
              aliases: ["tags"],
              description:
                "Replacement tags; repeat or pass a comma-separated list",
            },
            importance: {
              type: "integer",
              min: 0,
              max: 100,
              description: "Replacement ranking weight",
            },
            pinned: {
              type: "enum",
              values: ["true", "false"],
              description: "Pin or unpin the memory",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const tags = input.options.tag;
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const memory = store.update(
              input.positionals.id,
              {
                expectedVersion: input.options["expected-version"],
                summary: input.options.summary,
                details: input.options.details,
                kind: input.options.kind,
                tags: tags.length > 0 ? tags : undefined,
                importance: input.options.importance,
                pinned:
                  input.options.pinned === undefined
                    ? undefined
                    : input.options.pinned === "true",
                sourceThreadId: ctx.threadId ?? null,
                writeReason: input.options.reason,
              },
              ctx.projectId,
              botId,
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, memory })
                : `Updated ${memory.id} to v${memory.version}.`,
            };
          },
        }),
        forget: cliCommand({
          summary: "Soft-delete a memory with version checking",
          positionals: [
            { name: "id", description: "Memory id", required: true },
          ],
          options: {
            "expected-version": {
              type: "integer",
              min: 1,
              max: MAX_EXPECTED_VERSION,
              required: true,
              description: "Version this deletion is based on",
            },
            reason: {
              type: "string",
              required: true,
              placeholder: "TEXT",
              description: "Why the memory is gone, at most 500 characters",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const memory = store.forget(
              input.positionals.id,
              input.options["expected-version"],
              input.options.reason,
              ctx.threadId ?? null,
              ctx.projectId,
              botId,
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({
                    ok: true,
                    forgotten: { id: memory.id, version: memory.version },
                  })
                : `Forgot ${memory.id} at v${memory.version}.`,
            };
          },
        }),
        history: cliCommand({
          summary: "Show a memory's version history",
          positionals: [
            { name: "id", description: "Memory id", required: true },
          ],
          options: {
            limit: {
              type: "integer",
              min: 1,
              max: MAX_RESULT_LIMIT,
              default: DEFAULT_RESULT_LIMIT,
              description: "How many versions to show, newest first",
            },
            json: {
              type: "boolean",
              description: "Emit machine-readable JSON",
            },
          },
          run: async (input, ctx) => {
            const id = input.positionals.id;
            const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
            const history = store.history(
              id,
              ctx.projectId,
              botId,
              input.options.limit,
            );
            if (history.length === 0) {
              throw new CliError(`memory history for "${id}" was not found`);
            }
            return {
              exitCode: 0,
              stdout: input.options.json
                ? jsonOutput({ ok: true, id, history })
                : jsonOutput(history),
            };
          },
        }),
        ...proposalAndDreamCommands({ proposals, db, scan: (limit, watermark) => {
          // Exclude the current millisecond: a concurrent writer can still
          // create another ID in it. Keep this upper bound until the page drains.
          const maximum = Math.max(0, Date.now() - 1);
          const timestamp = z.number().int().nonnegative().max(maximum);
          const tuple = z.object({ updatedAt: timestamp, id: z.string().min(1).max(128) }).strict();
          let since = 0;
          let until = maximum;
          let after: { updatedAt: number; id: string } | undefined;
          if (watermark) {
            try {
              if (watermark.startsWith("{")) {
                const parsed: unknown = JSON.parse(watermark);
                if (isRecord(parsed) && parsed.v === 1) {
                  const cursor = z.object({ v: z.literal(1), since: timestamp,
                    until: timestamp.optional(), after: tuple.optional() }).strict().parse(parsed);
                  since = cursor.since;
                  if (cursor.after) {
                    if (cursor.until === undefined || cursor.until <= since ||
                        cursor.after.updatedAt <= since || cursor.after.updatedAt > cursor.until) throw new Error();
                    until = cursor.until;
                    after = cursor.after;
                  } else if (cursor.until !== undefined) throw new Error();
                } else {
                  // Replay the legacy tuple's millisecond, including smaller
                  // IDs. Stable proposal fingerprints make this safe to repeat.
                  const legacy = z.object({ updatedAt: timestamp, id: z.string().max(128) }).strict().parse(parsed);
                  since = Math.max(0, legacy.updatedAt - 1);
                }
              } else {
                if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(watermark)) throw new Error();
                since = Math.max(0, timestamp.parse(Date.parse(watermark)) - 1);
              }
            } catch { throw new CliError("Invalid dream watermark"); }
          }
          const lower = after ?? { updatedAt: since, id: "" };
          const rows = db.prepare(`SELECT * FROM memories
            WHERE deleted_at IS NULL AND tags_json NOT LIKE '%"validity-quarantined"%'
              AND updated_at > ? AND updated_at <= ?
              AND (updated_at > ? OR (updated_at = ? AND id > ?))
            ORDER BY updated_at, id LIMIT ?`).all(since, until,
              lower.updatedAt, lower.updatedAt, lower.id, limit + 1);
          const memories = rows.slice(0, limit).map(parseMemoryRow);
          const peers = new Map<string, MemoryRecord>();
          const pageIds = new Set(memories.map(memory => memory.id));
          for (const memory of memories) {
            const matches = db.prepare(`SELECT * FROM memories
              WHERE deleted_at IS NULL AND tags_json NOT LIKE '%"validity-quarantined"%'
                AND scope_key = ? AND summary = ? AND details = ? AND kind = ?
                AND updated_at <= ?
              ORDER BY updated_at, id LIMIT 1001`).all(
                scopeKey(memory.scope, memory.projectId, memory.ownerBotId),
                memory.summary, memory.details, memory.kind, until);
            if (matches.length > 1000) throw new CliError("Dream peer budget exceeded; narrow the evidence set");
            for (const row of matches) {
              const peer = parseMemoryRow(row);
              if (!pageIds.has(peer.id)) peers.set(peer.id, peer);
            }
            if (peers.size > 1000) throw new CliError("Dream peer budget exceeded");
          }
          const last = memories.at(-1);
          const hasMore = rows.length > limit;
          return { memories, peers: [...peers.values()], hasMore,
            watermark: JSON.stringify(hasMore
              ? { v: 1, since, until, after: { updatedAt: last!.updatedAt, id: last!.id } }
              : { v: 1, since: until }) };
        } }),
        ...migrateCommands({
          reviewMemory: ({ name, verdict, reason }) => {
            let current = store.getAdmin(name);
            if (!current) {
              // Project-scoped records are invisible to context-scoped lookups;
              // migration review is an admin operation over the full store.
              const row = db.prepare("SELECT id FROM memories WHERE name = ? AND deleted_at IS NULL").get(name) as
                | { id: string }
                | undefined;
              current = row ? store.getAdmin(row.id) : null;
            }
            if (!current) throw new CliError(`memory "${name}" was not found`);
            const nextTags = [
              ...current.tags.filter(
                (tag) => tag !== "validity-unreviewed" && tag !== "validity-valid" && tag !== "validity-quarantined",
              ),
              `validity-${verdict}`,
            ];
            const updated = store.update(
              current.id,
              {
                expectedVersion: current.version,
                tags: nextTags,
                sourceThreadId: current.sourceThreadId,
                writeReason: `migration review (${verdict}): ${reason} — original imported version preserved in history`,
              },
              current.projectId ?? undefined,
              current.ownerBotId,
              true,
            );
            return { version: updated.version, tags: updated.tags };
          },
          addMemory: (input) =>
            store.add({
              scope: input.scope as MemoryScope,
              projectId: input.projectId,
              ownerBotId: input.ownerBotId,
              name: input.name,
              summary: input.summary,
              details: input.details,
              kind: input.kind as MemoryKind,
              tags: input.tags,
              importance: input.importance,
              pinned: input.pinned,
              sourceThreadId: input.sourceThreadId,
              writeReason: input.writeReason,
            }),
        }),
      },
    }),
  );

  // Learn replacement for agents whose native memory backend is disabled
  // (notably BB-hosted OMP with memory.backend=off). Writes a durable BB
  // memory; optional managed skills are guarded against authored-name collisions.
  bb.agents.registerTool({
    name: "learn",
    description:
      "Save durable, verified learning to the authoritative BB memory store. Use for procedures, conventions, decisions, and reusable facts likely to help future threads. Do not store secrets, guesses, transient status, or facts trivial to rediscover. To report an existing memory as wrong, provide reason and correction {id, expectedVersion, replacement?}; this creates a pending review proposal only.",
    instructions:
      "Call `learn` after completing verified work that produced reusable knowledge. Provide a stable kebab-case name, a one-line retrieval summary, complete details (commands, evidence, caveats), and a kind (procedure|fact|preference|decision|reference). Scope is chosen automatically: the current bot's private scope when a bot is bound to this thread, otherwise the project, otherwise global. For corrections, pass only reason and correction (id, expectedVersion, optional explicit replacement summary/details). Wrong-only creates a pending retirement candidate, not a verified verdict; explicit replacement creates a pending supersede. Both require review before canonical changes.",
    parameters: learnSchema,
    execute: async (params, ctx) => {
      // Reject unknown fields when a bridge preserves the raw payload. Bridges
      // may strip extras before execution; ownership never comes from params.
      const allowed = new Set(["name", "summary", "details", "reason", "kind", "tags", "importance", "skill", "correction"]);
      if (Object.keys(params).some(key => !allowed.has(key)) ||
          (params.skill && Object.keys(params.skill).some(key => !["name", "description", "body"].includes(key))))
        throw new CliError("Unexpected learn fields; ownership comes only from host context");
      // Re-parse at execution too: direct SDK callers must obey the same
      // conditional contract even when their bridge skips schema validation.
      const input = learnSchema.parse(params);
      const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
      if (input.correction) {
        const correction = correctionSchema.parse(input.correction);
        const target = store.get(correction.id, "all", ctx.projectId, botId, false);
        if (!target || target.id !== correction.id)
          throw new CliError(`memory "${correction.id}" was not found in the current scope`);
        if (target.version !== correction.expectedVersion)
          throw new CliError(`version conflict for ${target.id}: expected ${correction.expectedVersion}, current ${target.version}`);
        const reason = validateText("reason", input.reason, 500);
        const replacement = correction.replacement;
        const result = proposals.createValidated({
          action: replacement ? "supersede" : "retire",
          targetIds: [target.id],
          payload: replacement ? {
            oldId: target.id, oldExpectedVersion: target.version,
            newMemory: {
              scope: target.scope, projectId: target.projectId, ownerBotId: target.ownerBotId,
              name: replacement.name ?? target.name,
              summary: validateText("summary", replacement.summary, 400),
              details: validateText("details", replacement.details, 16000),
              kind: replacement.kind ?? target.kind,
              tags: validateTags(replacement.tags ?? target.tags),
              importance: replacement.importance ?? target.importance,
              pinned: replacement.pinned ?? target.pinned,
            },
          } : {
            memoryId: target.id, expectedVersion: target.version,
            reason: "Agent reports this record is wrong; review required before retirement",
          },
          evidence: {
            source: "agent-correction", verification: "agent-proposed",
            intent: replacement ? "explicit-replacement" : "wrong-only-report",
            reason, sourceThreadId: ctx.threadId, sourceProjectId: ctx.projectId,
            sourceBotId: botId,
            sourceMemory: { id: target.id, version: target.version, name: target.name,
              scope: target.scope, projectId: target.projectId, ownerBotId: target.ownerBotId },
          },
          runId: null,
        });
        return jsonOutput({ ok: true, ...result, canonicalUnchanged: true, reviewRequired: true });
      }
      const learning = freshLearnSchema.parse(input);
      const scope: MemoryScope = botId ? "bot" : ctx.projectId ? "project" : "global";
      // Validate the skill payload BEFORE storing the memory: a refused skill
      // must not leave a half-completed learn behind (no orphan record).
      if (learning.skill) {
        assertManagedSkillWritable(learning.skill.name);
      }
      const skillFile = learning.skill ? join(managedSkillsDir(), learning.skill.name, "SKILL.md") : null;
      const previousSkill = skillFile && existsSync(skillFile) ? readFileSync(skillFile, "utf8") : null;
      let skillWritten = false;
      let skillNote = "";
      let memory: MemoryRecord;
      try {
        memory = db.transaction(() => {
          const saved = store.add({
            scope,
            projectId: scope === "project" ? ctx.projectId : null,
            ownerBotId: scope === "bot" ? botId : null,
            name: learning.name,
            summary: learning.summary,
            details: learning.details,
            kind: learning.kind,
            tags: learning.tags,
            importance: learning.importance,
            pinned: false,
            sourceThreadId: ctx.threadId,
            writeReason: `learn tool: ${learning.reason}`,
          });
          if (learning.skill) {
            skillNote = writeManagedSkill(learning.skill.name, learning.skill.description, learning.skill.body);
            skillWritten = true;
          }
          return saved;
        })();
      } catch (error) {
        if (skillWritten && skillFile) {
          if (previousSkill === null) rmSync(skillFile, { force: true });
          else atomicWrite(skillFile, previousSkill);
        }
        throw error;
      }
      return `Saved ${memory.id} v${memory.version} (${memory.scope}/${memory.name}). Retrieve it later with recall or the memory CLI.${skillNote}`;
    },
  });

  bb.agents.registerTool({
    name: "recall",
    description: "Retrieve authoritative BB memories in the current scope. Search by query for bounded summaries with stable IDs/versions, or pass id for the complete record. Quarantined and inaccessible records are excluded.",
    instructions: "Use recall({query}) to find relevant memories, then recall({id}) for full detail and current version. Scope defaults to all accessible global/current-project/current-bot memories; ownership is resolved from live host context. Use learn with correction to propose changes for review.",
    parameters: recallSchema,
    execute: async (params, ctx) => {
      if (Object.keys(params).some(key => !["query", "id", "scope", "limit"].includes(key)))
        throw new CliError("Unexpected recall fields; ownership comes only from host context");
      const input = recallSchema.parse(params);
      const botId = await resolveBotForThread(bb.sdk, db, ctx.threadId ?? null);
      if (input.id) {
        const memory = store.get(input.id, input.scope, ctx.projectId, botId);
        if (!memory || memory.id !== input.id)
          throw new CliError(`memory "${input.id}" was not found in the current scope`);
        return jsonOutput({ ok: true, scope: input.scope, memory });
      }
      const memories = store.search(input.query!, input.scope, ctx.projectId, botId, input.limit);
      return jsonOutput({ ok: true, query: input.query, scope: input.scope,
        memories: memories.map(toMemorySummary), limit: input.limit });
    },
  });

}
