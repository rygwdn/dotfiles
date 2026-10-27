import { randomBytes } from "node:crypto";
import { cliCommand, PluginCliError, type PluginCliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import {
  ProposalStore,
  type ProposalAction,
  type ProposalStatus,
} from "./proposal-store.js";

const PROPOSAL_ACTIONS = [
  "dedupe",
  "supersede",
  "retire",
  "skill",
  "edit",
] as const;
const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "applied",
  "rolled_back",
] as const;

function requireOperator(ctx: PluginCliContext): void {
  if (ctx.threadId) throw new PluginCliError("Proposal administration and dreaming require operator context; agents use scoped memory tools");
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseJsonOption(
  label: string,
  value: string | undefined,
  required: boolean,
): unknown {
  if (value === undefined || value === "") {
    if (required) throw new PluginCliError(`${label} is required`);
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PluginCliError(`${label} must be valid JSON`);
  }
}

export function proposalAndDreamCommands(deps: {
  proposals: ProposalStore;
  scan: (limit: number, watermark?: string) => { memories: unknown[]; peers: unknown[]; watermark: string; hasMore: boolean };
  db: {
    prepare(sql: string): {
      run(...args: unknown[]): { changes: number };
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
  };
}): Record<string, PluginCliCommand> {
  return {
    "dream scan": cliCommand({
      summary: "Read a bounded chronological page of full non-quarantined evidence (operator only)",
      options: {
        limit: { type: "integer", min: 1, max: 100, default: 50, description: "Maximum changed records" },
        watermark: { type: "string", description: "Opaque output cursor from the preceding page" },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        if (ctx.threadId) throw new PluginCliError("Dream scans require operator context; agents must use scoped memory reads");
        const result = deps.scan(input.options.limit, input.options.watermark);
        return { exitCode: 0, stdout: jsonOutput({ ok: true, ...result }) };
      },
    }),
    "proposal list": cliCommand({
      summary: "List memory proposals by status",
      options: {
        status: {
          type: "enum",
          values: ["all", ...PROPOSAL_STATUSES],
          default: "pending",
          description: "Filter by status",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposals = deps.proposals.list(
          input.options.status as ProposalStatus | "all",
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposals })
            : proposals
                .map(
                  (p) =>
                    `${p.id} [${p.status}] ${p.action} targets=${p.targetIds.join(",") || "none"} run=${p.runId ?? "-"}`,
                )
                .join("\n") || "No proposals.",
        };
      },
    }),
    "proposal show": cliCommand({
      summary: "Show one proposal with payload and evidence",
      positionals: [{ name: "id", description: "Proposal id", required: true }],
      options: {
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposal = deps.proposals.get(input.positionals.id);
        if (!proposal) {
          throw new PluginCliError(
            `proposal "${input.positionals.id}" was not found`,
          );
        }
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposal })
            : jsonOutput(proposal),
        };
      },
    }),
    "proposal create": cliCommand({
      summary:
        "Create a pending proposal (dream runs and operators only; never auto-applied)",
      options: {
        action: {
          type: "enum",
          values: PROPOSAL_ACTIONS,
          required: true,
          description: "Proposal action",
        },
        targets: {
          type: "string",
          required: true,
          description: "Comma-separated target memory ids",
        },
        payload: {
          type: "string",
          required: true,
          description: "Action payload as JSON",
        },
        evidence: {
          type: "string",
          description: "Evidence references as JSON",
        },
        "run-id": {
          type: "string",
          description: "Dream run id for deduplication",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const payload = parseJsonOption("--payload", input.options.payload, true);
        const evidence = parseJsonOption("--evidence", input.options.evidence, false);
        const targets = input.options.targets
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        const { proposal, created } = deps.proposals.create({
          action: input.options.action as ProposalAction,
          targetIds: targets,
          payload,
          evidence,
          runId: input.options["run-id"] ?? null,
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, created, proposal })
            : `${created ? "Created" : "Existing pending"} proposal ${proposal.id} (${proposal.action}).`,
        };
      },
    }),
    "proposal approve": cliCommand({
      summary: "Approve a pending proposal for application",
      positionals: [{ name: "id", description: "Proposal id", required: true }],
      options: {
        reason: {
          type: "string",
          required: true,
          description: "Why it is approved",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposal = deps.proposals.decide(
          input.positionals.id,
          "approved",
          input.options.reason,
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposal })
            : `Approved ${proposal.id}. Apply with: proposal apply ${proposal.id}`,
        };
      },
    }),
    "proposal reject": cliCommand({
      summary: "Reject a pending proposal; canonical state is preserved",
      positionals: [{ name: "id", description: "Proposal id", required: true }],
      options: {
        reason: {
          type: "string",
          required: true,
          description: "Why it is rejected",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposal = deps.proposals.decide(
          input.positionals.id,
          "rejected",
          input.options.reason,
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposal })
            : `Rejected ${proposal.id}.`,
        };
      },
    }),
    "proposal cancel": cliCommand({
      summary: "Cancel an approved proposal that is unactionable; canonical state is preserved",
      positionals: [{ name: "id", description: "Proposal id", required: true }],
      options: {
        reason: {
          type: "string",
          required: true,
          description: "Why it is cancelled",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposal = deps.proposals.cancel(
          input.positionals.id,
          input.options.reason,
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposal })
            : `Cancelled ${proposal.id}.`,
        };
      },
    }),
    "proposal apply": cliCommand({
      summary: "Apply an approved proposal exactly once (audited, rollback-able)",
      positionals: [{ name: "id", description: "Proposal id", required: true }],
      options: {
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposal = deps.proposals.apply(
          input.positionals.id,
          ctx.threadId ?? null,
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposal })
            : `Applied ${proposal.id} (version ${proposal.appliedVersion ?? "-"}). Rollback with: proposal rollback ${proposal.id}`,
        };
      },
    }),
    "proposal rollback": cliCommand({
      summary: "Roll back an applied proposal from its stored snapshot",
      positionals: [{ name: "id", description: "Proposal id", required: true }],
      options: {
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const proposal = deps.proposals.rollback(
          input.positionals.id,
          ctx.threadId ?? null,
        );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, proposal })
            : `Rolled back ${proposal.id}.`,
        };
      },
    }),
    "dream start": cliCommand({
      summary: "Record the start of a bounded dream run (watermark checkpoint)",
      options: {
        "run-id": {
          type: "string",
          required: true,
          description: "Unique run id (reuse the same id to resume)",
        },
        watermark: {
          type: "string",
          description: "Resume watermark (JSON or cursor string)",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const existing = deps.db
          .prepare("SELECT * FROM dream_runs WHERE run_id = ?")
          .get(input.options["run-id"]) as Record<string, unknown> | undefined;
        if (existing && existing.status === "running") {
          return {
            exitCode: 0,
            stdout: input.options.json
              ? jsonOutput({ ok: true, resumed: true, run: existing })
              : `Run ${input.options["run-id"]} already running (resumable).`,
          };
        }
        deps.db
          .prepare(
            `INSERT INTO dream_runs (run_id, started_at, status, watermark, stats_json)
             VALUES (?, ?, 'running', ?, '{}')
             ON CONFLICT(run_id) DO UPDATE SET
               status = 'running', started_at = excluded.started_at,
               watermark = COALESCE(excluded.watermark, dream_runs.watermark)`,
          )
          .run(
            input.options["run-id"],
            Date.now(),
            input.options.watermark ?? null,
          );
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true, resumed: false })
            : `Started dream run ${input.options["run-id"]}.`,
        };
      },
    }),
    "dream finish": cliCommand({
      summary: "Record the outcome of a dream run and advance its watermark",
      options: {
        "run-id": {
          type: "string",
          required: true,
          description: "Dream run id",
        },
        status: {
          type: "enum",
          values: ["succeeded", "failed", "quiet"],
          required: true,
          description: "Run outcome (quiet = no changes worth proposing)",
        },
        watermark: {
          type: "string",
          description: "New watermark for the next run",
        },
        "stats-json": {
          type: "string",
          description: "Bounded run statistics as JSON",
        },
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const result = deps.db
          .prepare(
            `UPDATE dream_runs
             SET status = ?, finished_at = ?,
               watermark = COALESCE(?, watermark),
               stats_json = COALESCE(?, stats_json)
             WHERE run_id = ?`,
          )
          .run(
            input.options.status,
            Date.now(),
            input.options.watermark ?? null,
            input.options["stats-json"] ?? null,
            input.options["run-id"],
          );
        if (result.changes !== 1) {
          throw new PluginCliError(
            `dream run "${input.options["run-id"]}" was not started`,
          );
        }
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput({ ok: true })
            : `Finished dream run ${input.options["run-id"]}: ${input.options.status}.`,
        };
      },
    }),
    "dreams status": cliCommand({
      summary: "Show dream run observability and pending proposal counts",
      options: {
        json: { type: "boolean", description: "Emit machine-readable JSON" },
      },
      run(input, ctx) {
        requireOperator(ctx);
        const lastRun = deps.db
          .prepare(
            "SELECT * FROM dream_runs ORDER BY started_at DESC LIMIT 1",
          )
          .get() as Record<string, unknown> | undefined;
        const counts = deps.proposals.counts();
        const payload = {
          ok: true,
          lastRun: lastRun ?? null,
          proposalCounts: counts,
          pending: counts.pending ?? 0,
        };
        return {
          exitCode: 0,
          stdout: input.options.json
            ? jsonOutput(payload)
            : `Last dream run: ${
                lastRun
                  ? `${String(lastRun.run_id)} ${String(lastRun.status)} at ${new Date(Number(lastRun.started_at)).toISOString()}`
                  : "none"
              }
Proposals: pending=${counts.pending ?? 0} approved=${counts.approved ?? 0} rejected=${counts.rejected ?? 0} applied=${counts.applied ?? 0} rolled_back=${counts.rolled_back ?? 0}`,
        };
      },
    }),
  };
}

export function newDreamRunId(): string {
  return `dream_${randomBytes(6).toString("base64url").toLowerCase()}`;
}
