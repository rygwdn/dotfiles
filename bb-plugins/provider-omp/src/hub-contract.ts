import { z } from "zod";
import { OMP_PLUGIN_ID } from "./extension-ui-contract.js";

// ---------------------------------------------------------------------------
// Agents: the bridge's subagent coordinator publishes a roster snapshot as a
// thread `extension.state` delta of this kind; the hub panel reads the newest.
// ---------------------------------------------------------------------------

export const OMP_AGENTS_STATE_KIND = `${OMP_PLUGIN_ID}/agents`;

/** Newest agents kept in one roster snapshot. */
export const OMP_AGENTS_ROSTER_LIMIT = 64;

export const ompHubAgentStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
]);

export const ompHubAgentSchema = z.object({
  /** omp agent id (e.g. "AuthLoader"); also the delegation's `childRef`. */
  id: z.string().min(1),
  parentId: z.string().min(1).optional(),
  /** omp agent type ("task", "scout", …). */
  agent: z.string(),
  status: ompHubAgentStatusSchema,
  description: z.string().optional(),
  detached: z.boolean(),
  model: z.string().optional(),
  modelRole: z.string().optional(),
  tokens: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  toolCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  currentTool: z.string().optional(),
  intent: z.string().optional(),
  error: z.string().optional(),
  retry: z
    .object({ attempt: z.number().int(), maxAttempts: z.number().int() })
    .optional(),
  lastUpdate: z.number(),
});

export const ompAgentsStateSchema = z.object({
  agents: z.array(ompHubAgentSchema),
  truncated: z.boolean().optional(),
});

export type OmpHubAgent = z.infer<typeof ompHubAgentSchema>;
export type OmpAgentsState = z.infer<typeof ompAgentsStateSchema>;

// ---------------------------------------------------------------------------
// Panel identity: the thread panel action id and its persisted params.
// ---------------------------------------------------------------------------

export const OMP_HUB_PANEL_ACTION_ID = "omp-hub";

export const ompHubPanelParamsSchema = z.object({
  agentId: z.string().min(1).optional(),
});

export type OmpHubPanelParams = z.infer<typeof ompHubPanelParamsSchema>;

/** Markdown directive name the bridge appends to delegation summaries. */
export const OMP_AGENT_DETAILS_DIRECTIVE = "omp-agent-details";

/** `::omp-agent-details{id="…"}`: a leaf directive on its own line. */
export function ompAgentDetailsDirective(agentId: string): string {
  return `::${OMP_AGENT_DETAILS_DIRECTIVE}{id="${agentId.replace(/["\\\n\r]/g, "")}"}`;
}

// ---------------------------------------------------------------------------
// Services: omp daemon-supervised processes (`omp ps`) for a thread's cwd.
// The host entry runs `omp ps` on the thread's host; the server relays.
// ---------------------------------------------------------------------------

export const ompServiceSchema = z.object({
  name: z.string().min(1),
  /** Broker state: starting | ready | exited | failed | … (omp-owned). */
  state: z.string(),
  pid: z.number().int().optional(),
  startedAt: z.number().optional(),
  readyAt: z.number().optional(),
  exitedAt: z.number().optional(),
  exitCode: z.number().int().nullable().optional(),
  restartCount: z.number().int().optional(),
  readyMatch: z.string().optional(),
  command: z.string().optional(),
  /** From spec.ready.{host,port}, or the first http(s) URL in readyMatch. */
  url: z.string().optional(),
  port: z.number().int().optional(),
  persist: z.boolean().optional(),
  detached: z.boolean().optional(),
  /** omp's own helpers (names starting with "omp."), hidden by default. */
  internal: z.boolean(),
});

export type OmpService = z.infer<typeof ompServiceSchema>;

export const ompServiceActionSchema = z.enum(["stop", "kill", "restart"]);
export type OmpServiceAction = z.infer<typeof ompServiceActionSchema>;

export const OMP_SERVICE_LOG_LINES_MAX = 1000;

const serviceListSchema = z.object({
  projectDir: z.string().nullable(),
  services: z.array(ompServiceSchema),
});

/** Methods added to the plugin's host entry contract (src/host.ts). */
export const ompServicesHostMethods = {
  listOmpServices: {
    input: z.object({ cwd: z.string().min(1) }).strict(),
    output: serviceListSchema,
  },
  readOmpServiceLogs: {
    input: z
      .object({
        cwd: z.string().min(1),
        name: z.string().min(1),
        lines: z.number().int().min(1).max(OMP_SERVICE_LOG_LINES_MAX).optional(),
      })
      .strict(),
    output: z.object({ text: z.string() }),
  },
  controlOmpService: {
    input: z
      .object({
        cwd: z.string().min(1),
        name: z.string().min(1),
        action: ompServiceActionSchema,
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
} as const;

/** Server RPC the panel calls (`bb.rpc.register` / `useRpc`). */
export const ompHubRpcContract = {
  listServices: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("available", [
      serviceListSchema.extend({
        available: z.literal(true),
        /** False when the thread runs on another machine: URLs are that host's loopback. */
        hostIsLocal: z.boolean(),
      }),
      z.object({ available: z.literal(false), reason: z.string() }),
    ]),
  },
  serviceLogs: {
    input: z
      .object({
        threadId: z.string().min(1),
        name: z.string().min(1),
        lines: z.number().int().min(1).max(OMP_SERVICE_LOG_LINES_MAX).optional(),
      })
      .strict(),
    output: z.object({ text: z.string() }),
  },
  controlService: {
    input: z
      .object({
        threadId: z.string().min(1),
        name: z.string().min(1),
        action: ompServiceActionSchema,
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
} as const;

export type OmpHubRpcContract = typeof ompHubRpcContract;
