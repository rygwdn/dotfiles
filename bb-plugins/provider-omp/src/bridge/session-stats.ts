import { z } from "zod";

export const ompSessionStatsSchema = z.object({
  sessionFile: z.string().optional(),
  sessionId: z.string(),
  userMessages: z.number().nonnegative(),
  assistantMessages: z.number().nonnegative(),
  toolCalls: z.number().nonnegative(),
  toolResults: z.number().nonnegative(),
  totalMessages: z.number().nonnegative(),
  tokens: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
  premiumRequests: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  credits: z.object({
    cost: z.number().nonnegative(),
    committedCost: z.number().nonnegative(),
    acuCost: z.number().nonnegative(),
  }).optional(),
  routedModels: z.record(z.string(), z.number().nonnegative()).optional(),
  contextUsage: z.object({
    tokens: z.number().nullable().optional(),
    contextWindow: z.number(),
    percent: z.number().optional(),
  }).nullish(),
});

export type OmpSessionStats = z.infer<typeof ompSessionStatsSchema>;

export const ompSessionStatsEventSchema = z.object({
  type: z.literal("bb_session_stats"),
  stats: ompSessionStatsSchema,
  initial: z.boolean().optional(),
  modelContextWindow: z.number().optional(),
});
