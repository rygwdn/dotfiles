import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MEMORY_KINDS } from "./memory-kinds.js";
import { PluginCliError } from "@get-bb/plugin-sdk";

export type ProposalAction =
  | "dedupe"
  | "supersede"
  | "retire"
  | "skill"
  | "edit";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "applied"
  | "rolled_back";

export interface ProposalRecord {
  id: string;
  action: ProposalAction;
  targetIds: string[];
  payload: unknown;
  evidence: unknown;
  status: ProposalStatus;
  runId: string | null;
  createdAt: number;
  decidedAt: number | null;
  decisionReason: string | null;
  appliedVersion: number | null;
  appliedSnapshot: { memories: MemorySnapshot[]; after?: MemorySnapshot[]; createdIds?: string[] } | null;
}

export interface MemorySnapshot {
  record: Record<string, unknown>;
  deleted: boolean;
}

/** Interface the proposal store needs from the memory store. */
export interface ProposalMemorySink {
  update(input: {
    id: string;
    expectedVersion: number;
    summary?: string;
    details?: string;
    kind?: string;
    tags?: string[];
    importance?: number;
    pinned?: boolean;
    sourceThreadId: string | null;
    writeReason: string;
  }): { version: number };
  forget(input: {
    id: string;
    expectedVersion: number;
    reason: string;
    sourceThreadId: string | null;
  }): { version: number };
  add(input: {
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
  }): { id: string; version: number };
  restoreSnapshot(snapshot: MemorySnapshot, reason: string): { version: number };
}

type ProposalDatabase = {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

function parseProposal(row: unknown): ProposalRecord {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    action: r.action as ProposalAction,
    targetIds: JSON.parse(String(r.target_ids_json)) as string[],
    payload: JSON.parse(String(r.payload_json)) as unknown,
    evidence: JSON.parse(String(r.evidence_json)) as unknown,
    status: r.status as ProposalStatus,
    runId: typeof r.run_id === "string" ? r.run_id : null,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    decisionReason:
      typeof r.decision_reason === "string" ? r.decision_reason : null,
    appliedVersion:
      r.applied_version == null ? null : Number(r.applied_version),
    appliedSnapshot: r.applied_snapshot_json
      ? (JSON.parse(String(r.applied_snapshot_json)) as {
          memories: MemorySnapshot[];
        })
      : null,
  };
}

export class ProposalStore {
  constructor(private readonly db: ProposalDatabase, private readonly memories: ProposalMemorySink, private readonly managedSkillsDir: string, private readonly validateSkill: (name: string) => void = () => {}) {}

  create(input: {
    action: ProposalAction;
    targetIds: string[];
    payload: unknown;
    evidence: unknown;
    runId: string | null;
  }): { proposal: ProposalRecord; created: boolean } {
    const id = `prop_${randomBytes(8).toString("base64url").toLowerCase()}`;
    try {
      this.db
        .prepare(
          `INSERT INTO memory_proposals (
             id, action, target_ids_json, payload_json, evidence_json,
             status, run_id, created_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          id,
          input.action,
          JSON.stringify(input.targetIds),
          JSON.stringify(input.payload),
          JSON.stringify(input.evidence),
          input.runId,
          Date.now(),
        );
      return { proposal: this.require(id), created: true };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        const existing = this.db
          .prepare(
            `SELECT * FROM memory_proposals
             WHERE action = ? AND target_ids_json = ? AND run_id IS ?
               AND status = 'pending'`,
          )
          .get(input.action, JSON.stringify(input.targetIds), input.runId);
        if (existing) return { proposal: parseProposal(existing), created: false };
      }
      throw error;
    }
  }

  /** Agent proposals must be actionable now as well as at review/apply time.
   * Validate in the same transaction so refusal leaves no pending orphan. */
  createValidated(input: Parameters<ProposalStore["create"]>[0]): ReturnType<ProposalStore["create"]> {
    return this.db.transaction(() => {
      const result = this.create(input);
      this.validatePayload(result.proposal);
      return result;
    })();
  }

  get(id: string): ProposalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM memory_proposals WHERE id = ?")
      .get(id);
    return row === undefined ? null : parseProposal(row);
  }

  list(status: ProposalStatus | "all"): ProposalRecord[] {
    const rows =
      status === "all"
        ? this.db
            .prepare(
              "SELECT * FROM memory_proposals ORDER BY created_at DESC LIMIT 200",
            )
            .all()
        : this.db
            .prepare(
              "SELECT * FROM memory_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 200",
            )
            .all(status);
    return rows.map(parseProposal);
  }

  decide(id: string, status: "approved" | "rejected", reason: string): ProposalRecord {
    const current = this.require(id);
    if (current.status !== "pending") {
      throw new PluginCliError(`proposal ${id} is ${current.status}, not pending`);
    }
    if (status === "approved") {
      // Approval is a gate: an unactionable payload must never reach the
      // applied state through the supported path.
      this.validatePayload(current);
    }
    this.db
      .prepare(
        `UPDATE memory_proposals
         SET status = ?, decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, Date.now(), reason, id);
    return this.require(id);
  }

  /**
   * Recover an approved proposal that turns out to be unactionable (e.g.
   * imported state with an invalid payload): supported cancellation with a
   * recorded reason, preserving the record and its history.
   */
  cancel(id: string, reason: string): ProposalRecord {
    const current = this.require(id);
    if (current.status !== "approved") {
      throw new PluginCliError(
        `proposal ${id} is ${current.status}; only approved proposals can be cancelled`,
      );
    }
    this.db
      .prepare(
        `UPDATE memory_proposals
         SET status = 'cancelled', decided_at = ?, decision_reason = ?
         WHERE id = ? AND status = 'approved'`,
      )
      .run(Date.now(), reason, id);
    return this.require(id);
  }

  /**
   * Validate that a proposal's payload is actionable against current store
   * state: required fields present, target memories exist, and recorded
   * expected versions still match. Called on approve and re-checked on apply.
   */
  private validatePayload(proposal: ProposalRecord): void {
    const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
    const id = z.string().min(1);
    const summary = z.string().trim().min(1).max(400);
    const details = z.string().trim().min(1).max(16000);
    const tags = z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/)).max(20);
    const edits = {
      summary: summary.optional(), details: details.optional(),
      kind: z.enum(MEMORY_KINDS).optional(), tags: tags.optional(),
      importance: z.number().int().min(0).max(100).optional(), pinned: z.boolean().optional(),
    };
    const schemas = {
      edit: z.object({ memoryId: id, expectedVersion: version, ...edits }).strict().refine(
        value => Object.keys(edits).some(key => key in value), "An edit must change at least one field"),
      retire: z.object({ memoryId: id, expectedVersion: version, reason: z.string().max(300).optional() }).strict(),
      dedupe: z.object({ keepId: id, keepExpectedVersion: version, dropId: id,
        dropExpectedVersion: version, mergedDetails: details.optional() }).strict(),
      supersede: z.object({ oldId: id, oldExpectedVersion: version,
        newMemory: z.object({ scope: z.enum(["global", "project", "bot"]),
          projectId: z.string().nullable().optional(), ownerBotId: z.string().nullable().optional(),
          name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/), summary, details,
          kind: z.enum(MEMORY_KINDS).optional(), tags: tags.optional(),
          importance: edits.importance, pinned: edits.pinned }).strict().refine(
            value => value.scope === "global" ? !value.projectId && !value.ownerBotId :
              value.scope === "project" ? !!value.projectId && !value.ownerBotId : !!value.ownerBotId && !value.projectId,
            "Replacement must have a consistent stable scope") }).strict(),
      skill: z.object({ skillName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
        body: z.string().trim().min(1).max(64000), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
    };
    const result = schemas[proposal.action].safeParse(proposal.payload);
    if (!result.success) throw new PluginCliError(`proposal ${proposal.id} invalid payload: ${result.error.message}`);
    const payload = result.data as Record<string, unknown>;
    const targets: Array<[string, string]> = proposal.action === "dedupe" ?
      [["keepId", "keepExpectedVersion"], ["dropId", "dropExpectedVersion"]] :
      proposal.action === "supersede" ? [["oldId", "oldExpectedVersion"]] :
      proposal.action === "skill" ? [] : [["memoryId", "expectedVersion"]];
    const actualIds = targets.map(([key]) => String(payload[key])).sort();
    if (new Set(actualIds).size !== actualIds.length ||
        JSON.stringify(actualIds) !== JSON.stringify([...proposal.targetIds].sort())) {
      throw new PluginCliError("Proposal targetIds must exactly match distinct payload targets");
    }
    const scopes = new Set<string>();
    for (const [idField, versionField] of targets) {
      const row = this.db.prepare("SELECT version, deleted_at, scope_key, tags_json FROM memories WHERE id = ?")
        .get(payload[idField]) as { version: number; deleted_at: number | null; scope_key: string; tags_json: string } | undefined;
      if (!row || row.deleted_at != null) throw new PluginCliError(`proposal target ${payload[idField]} does not exist or is deleted`);
      if (JSON.parse(row.tags_json).includes("validity-quarantined")) throw new PluginCliError("Quarantined records require explicit validity review before proposal use");
      if (payload[versionField] !== row.version) throw new PluginCliError(`proposal target ${payload[idField]} is at version ${row.version}, payload expects ${payload[versionField]}`);
      scopes.add(row.scope_key);
    }
    if (proposal.action === "dedupe" && scopes.size !== 1) throw new PluginCliError("Dedupe targets must share the same scope");
    if (proposal.action === "skill") {
      const name = String(payload.skillName);
      this.validateSkill(name);
      const file = join(this.managedSkillsDir, name, "SKILL.md");
      const current = existsSync(file) ? sha256(readFileSync(file, "utf8")) : null;
      if (current !== payload.expectedSha256) throw new PluginCliError("Managed skill changed; expectedSha256 does not match");
    }
  }

  /** Apply an approved proposal exactly once, with a rollback snapshot. */
  apply(id: string, threadId: string | null): ProposalRecord {
    return this.db.transaction(() => {
      const current = this.require(id);
      if (current.status !== "approved") {
        throw new PluginCliError(
          `proposal ${id} must be approved before apply (currently ${current.status})`,
        );
      }
      // State may have drifted since approval; re-check before mutating.
      this.validatePayload(current);
      const snapshots = this.snapshotTargets(current);
      const createdIds: string[] = [];
      const appliedVersion = this.applyPayload(current, threadId, createdIds);
      const after = [...current.targetIds, ...createdIds].map(target => this.snapshot(target)!);
      this.db
        .prepare(
          `UPDATE memory_proposals
           SET status = 'applied', applied_version = ?, applied_snapshot_json = ?
           WHERE id = ? AND status = 'approved'`,
        )
        .run(appliedVersion, JSON.stringify({ memories: snapshots, after, createdIds }), id);
      return this.require(id);
    })();
  }

  rollback(id: string, threadId: string | null): ProposalRecord {
    return this.db.transaction(() => {
      const current = this.require(id);
      if (current.status !== "applied") {
        throw new PluginCliError(
          `proposal ${id} was not applied (currently ${current.status})`,
        );
      }
      if (!current.appliedSnapshot) {
        throw new PluginCliError(`proposal ${id} has no rollback snapshot`);
      }
      if (current.action === "skill") {
        this.rollbackSkill(current);
      } else {
        if (!current.appliedSnapshot.after) {
          throw new PluginCliError("Legacy proposal lacks post-apply versions; refusing blind rollback");
        }
        for (const expected of current.appliedSnapshot.after) {
          const actual = this.snapshot(String(expected.record.id));
          if (!actual || actual.record.version !== expected.record.version || actual.deleted !== expected.deleted)
            throw new PluginCliError(`memory ${expected.record.id} changed since apply; refusing blind rollback`);
        }
        for (const createdId of current.appliedSnapshot.createdIds ?? []) {
          const created = this.snapshot(createdId)!;
          this.memories.forget({ id: createdId, expectedVersion: Number(created.record.version),
            reason: `rollback of dream proposal ${current.id}: remove replacement`, sourceThreadId: threadId });
        }
        // Restore in reverse order so supersede (forget old, create new)
        // unrolls as: forget replacement (if tracked), restore forgotten.
        for (const snapshot of [...current.appliedSnapshot.memories].reverse()) {
          this.memories.restoreSnapshot(
            snapshot,
            `rollback of dream proposal ${current.id}`,
          );
        }
      }
      this.db
        .prepare(
          "UPDATE memory_proposals SET status = 'rolled_back' WHERE id = ? AND status = 'applied'",
        )
        .run(id);
      void threadId;
      return this.require(id);
    })();
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) AS count FROM memory_proposals GROUP BY status",
      )
      .all() as Array<{ status: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[row.status] = Number(row.count);
    return result;
  }

  private require(id: string): ProposalRecord {
    const current = this.get(id);
    if (!current) throw new PluginCliError(`proposal "${id}" was not found`);
    return current;
  }

  private snapshot(memoryId: string): MemorySnapshot | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(memoryId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      record: row,
      deleted: row.deleted_at != null,
    };
  }

  private snapshotTargets(proposal: ProposalRecord): MemorySnapshot[] {
    if (proposal.action === "skill") return [];
    const payload = proposal.payload as Record<string, unknown>;
    const ids: string[] = [];
    if (payload.memoryId) ids.push(String(payload.memoryId));
    if (payload.keepId) ids.push(String(payload.keepId));
    if (payload.dropId) ids.push(String(payload.dropId));
    if (payload.oldId) ids.push(String(payload.oldId));
    const snapshots: MemorySnapshot[] = [];
    for (const id of ids) {
      const snapshot = this.snapshot(id);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  private applyPayload(proposal: ProposalRecord, threadId: string | null, createdIds: string[]): number {
    const payload = proposal.payload as Record<string, unknown>;
    const reason = `dream proposal ${proposal.id} (${proposal.action})`;
    switch (proposal.action) {
      case "edit": {
        const updated = this.memories.update({
          id: String(payload.memoryId),
          expectedVersion: Number(payload.expectedVersion),
          summary: payload.summary as string | undefined,
          details: payload.details as string | undefined,
          kind: payload.kind as string | undefined,
          tags: payload.tags as string[] | undefined,
          importance: payload.importance as number | undefined,
          pinned: payload.pinned as boolean | undefined,
          sourceThreadId: threadId,
          writeReason: reason,
        });
        return updated.version;
      }
      case "retire": {
        const forgotten = this.memories.forget({
          id: String(payload.memoryId),
          expectedVersion: Number(payload.expectedVersion),
          reason: `${reason}: ${String(payload.reason ?? "retired by review")}`,
          sourceThreadId: threadId,
        });
        return forgotten.version;
      }
      case "dedupe": {
        if (typeof payload.mergedDetails === "string") {
          this.memories.update({
            id: String(payload.keepId),
            expectedVersion: Number(payload.keepExpectedVersion),
            details: payload.mergedDetails,
            sourceThreadId: threadId,
            writeReason: `${reason}: merged duplicate ${String(payload.dropId)}`,
          });
        }
        const forgotten = this.memories.forget({
          id: String(payload.dropId),
          expectedVersion: Number(payload.dropExpectedVersion),
          reason: `${reason}: duplicate of ${String(payload.keepId)}`,
          sourceThreadId: threadId,
        });
        return forgotten.version;
      }
      case "supersede": {
        this.memories.forget({
          id: String(payload.oldId),
          expectedVersion: Number(payload.oldExpectedVersion),
          reason: `${reason}: superseded`,
          sourceThreadId: threadId,
        });
        const replacement = payload.newMemory as Record<string, unknown>;
        const added = this.memories.add({
          scope: String(replacement.scope),
          projectId:
            replacement.projectId == null
              ? null
              : String(replacement.projectId),
          ownerBotId:
            replacement.ownerBotId == null
              ? null
              : String(replacement.ownerBotId),
          name: String(replacement.name),
          summary: String(replacement.summary),
          details: String(replacement.details),
          kind: String(replacement.kind ?? "fact"),
          tags: Array.isArray(replacement.tags)
            ? replacement.tags.map(String)
            : [],
          importance: Number(replacement.importance ?? 50),
          pinned: replacement.pinned === true,
          sourceThreadId: threadId,
          writeReason: reason,
        });
        createdIds.push(added.id);
        return added.version;
      }
      case "skill": {
        return this.applySkill(payload, proposal.id);
      }
    }
  }

  private applySkill(
    payload: Record<string, unknown>,
    proposalId: string,
  ): number {
    const name = String(payload.skillName);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new PluginCliError(`invalid managed skill name "${name}"`);
    }
    const dir = join(this.managedSkillsDir, name);
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    let priorBody: string | null = null;
    if (existsSync(file)) priorBody = readFileSync(file, "utf8");
    writeFileSync(
      join(dir, `.bi11-backup-${proposalId}.json`),
      JSON.stringify({ priorBody, appliedAt: Date.now() }),
    );
    writeAtomic(file, String(payload.body));
    return 1;
  }

  private rollbackSkill(proposal: ProposalRecord): void {
    const payload = proposal.payload as Record<string, unknown>;
    const name = String(payload.skillName);
    const dir = join(this.managedSkillsDir, name);
    const backupFile = join(dir, `.bi11-backup-${proposal.id}.json`);
    if (!existsSync(backupFile)) {
      throw new PluginCliError(`no rollback backup for proposal ${proposal.id}`);
    }
    const parsed = JSON.parse(readFileSync(backupFile, "utf8")) as {
      priorBody: string | null;
    };
    const file = join(dir, "SKILL.md");
    const currentBody = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (currentBody !== String(payload.body)) {
      throw new PluginCliError(
        `managed skill ${name} changed since proposal ${proposal.id} was applied; refusing blind rollback`,
      );
    }
    if (parsed.priorBody === null) {
      // Preserve any other files a user added after this proposal.
      rmSync(file, { force: true });
    } else {
      writeAtomic(file, parsed.priorBody);
    }
  }
}

function writeAtomic(file: string, body: string): void {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, body, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
