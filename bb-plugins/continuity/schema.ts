import { z } from "zod";
import { DEFAULT_POLICY } from "./policy";

const tokens = z.number().int().min(100).max(2_000_000);
export const policySchema = z.object({
  enabled: z.boolean().default(DEFAULT_POLICY.enabled),
  tools: z.array(z.string()).default(DEFAULT_POLICY.tools),
  protectRounds: z.number().int().min(1).max(50).default(DEFAULT_POLICY.protectRounds),
  protectTokens: tokens.default(DEFAULT_POLICY.protectTokens),
  triggerTokens: tokens.default(DEFAULT_POLICY.triggerTokens),
  minResultTokens: tokens.default(DEFAULT_POLICY.minResultTokens),
  minReclaimTokens: tokens.default(DEFAULT_POLICY.minReclaimTokens),
  regrowthTokens: tokens.default(DEFAULT_POLICY.regrowthTokens),
  coldAfterSeconds: z.number().int().min(60).max(86400).default(DEFAULT_POLICY.coldAfterSeconds),
  idleSeconds: z.number().int().min(30).max(86400).default(DEFAULT_POLICY.idleSeconds),
  idleThresholdTokens: tokens.default(DEFAULT_POLICY.idleThresholdTokens),
  keepRecentTokens: tokens.default(DEFAULT_POLICY.keepRecentTokens),
}).strict();
export const threadIdSchema = z.string().regex(/^thr_[a-zA-Z0-9_-]+$/).max(100);
export const statusSchema = z.object({
  sessionId: z.string().max(200), updatedAt: z.number(),
  state: z.enum(["ready", "cache-hot", "demoted", "compacting", "compacted", "deferred", "disabled", "error", "stopped"]),
  reason: z.string().max(1000), demotedResults: z.number().int().nonnegative(),
  reclaimedTokens: z.number().nonnegative(), estimatedTokens: z.number().nonnegative(), lastCompactedAt: z.number().nullable(),
}).strict();
export type RuntimeStatus = z.infer<typeof statusSchema>;
export const runtimeSignalSchema = z.object({
  threadId: threadIdSchema,
  status: statusSchema.nullable(),
}).strict();
