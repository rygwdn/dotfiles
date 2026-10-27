import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { policySchema, statusSchema, threadIdSchema } from "./schema";

export const hostContract = defineRpcContract({
  prepare: {
    input: z.object({ threadId: threadIdSchema, workspace: z.string().min(1), policy: policySchema }),
    output: z.object({ directory: z.string(), extension: z.string() }),
  },
  inspect: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.object({ status: statusSchema.nullable() }),
  },
  control: {
    input: z.object({ threadId: threadIdSchema, policy: policySchema, compact: z.boolean().default(false) }),
    output: z.object({ queued: z.boolean() }),
  },
});
export const rpcContract = defineRpcContract({
  setEnabled: {
    input: z.object({ threadId: threadIdSchema, enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean() }),
  },
  inspect: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.object({ supported: z.boolean(), configured: z.boolean(), policy: policySchema, runtime: statusSchema.nullable(), note: z.string() }),
  },
  configure: {
    input: z.object({ threadId: threadIdSchema, policy: policySchema }),
    output: z.object({ applied: z.boolean(), note: z.string() }),
  },
  compact: {
    input: z.object({ threadId: threadIdSchema }),
    output: z.object({ queued: z.boolean(), note: z.string() }),
  },
  statuses: {
    input: z.object({ threadIds: z.array(threadIdSchema).min(1).max(64) }),
    output: z.object({ statuses: z.record(threadIdSchema, statusSchema.nullable()) }),
  },
});
