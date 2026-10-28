import { describe, expect, it } from "vitest";
import { threadDeltaSchema, type ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  createOmpDeltaTranslator,
  type OmpDeltaTranslationContext,
  type OmpDeltaTranslator,
} from "./delta-translation.js";

const THREAD = "bash-job-thread";
const context = { threadId: THREAD, cwd: "/repo" };

interface Harness {
  translator: OmpDeltaTranslator;
  translate(event: unknown, scope?: OmpDeltaTranslationContext): {
    deltas: ThreadDelta[];
    events: ThreadEvent[];
  };
}

function harness(): Harness {
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const assembler = createDeltaAssembler({
    providerId: "omp", entropyPrefix: "async-jobs", textDeltaFlushMs: 0, progressThrottleMs: 0,
  });
  return {
    translator,
    translate(event: unknown, scope: OmpDeltaTranslationContext = context) {
      const deltas = translator.translate(event, scope);
      for (const delta of deltas) expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
      return {
        deltas,
        events: assembler.assemble({ threadId: scope.threadId ?? THREAD, deltas }),
      };
    },
  };
}

function asyncResult(state: string, options: { jobId?: string; text?: string; exitCode?: number } = {}) {
  return {
    content: [{ type: "text", text: options.text ?? "" }],
    details: {
      async: { state, jobId: options.jobId ?? "bg_1", type: "bash" },
      ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    },
  };
}

function launch(h: Harness, options: {
  scope?: OmpDeltaTranslationContext; toolCallId?: string; jobId?: string; command?: string;
} = {}) {
  const toolCallId = options.toolCallId ?? "bash-launch";
  h.translate({
    type: "tool_execution_start", toolCallId, toolName: "bash",
    args: { command: options.command ?? "run-checks", cwd: "/repo", async: true },
  }, options.scope);
  return h.translate({
    type: "tool_execution_end", toolCallId, toolName: "bash", isError: false,
    result: asyncResult("running", { jobId: options.jobId, text: "Dispatch accepted" }),
  }, options.scope);
}

function update(state: string, options: {
  toolCallId?: string; jobId?: string; text?: string; exitCode?: number;
} = {}) {
  return {
    type: "tool_execution_update", toolCallId: options.toolCallId ?? "bash-launch", toolName: "bash",
    partialResult: asyncResult(state, options),
  };
}

function waitUpdate(jobs: unknown[], text = "") {
  return {
    type: "tool_execution_update", toolCallId: "wait-call", toolName: "wait",
    partialResult: { content: [{ type: "text", text }], details: { op: "wait", jobs } },
  };
}

function delivery(jobs: unknown[], type = "message_start") {
  return {
    type, messageId: "async-delivery",
    message: {
      role: "custom", customType: "async-result", display: true,
      content: "Background report", details: { jobs }, timestamp: 1_700_000_000_000,
    },
  };
}

function jobDeltas(deltas: ThreadDelta[]) {
  return deltas.filter((delta) =>
    ((delta.kind === "item.open" || delta.kind === "item.close") && delta.item.type === "backgroundTask") ||
    (delta.kind === "item.progress" && delta.snapshot?.type === "backgroundTask"),
  );
}

function openedJob(deltas: ThreadDelta[]) {
  const open = deltas.find((delta) => delta.kind === "item.open" && delta.item.type === "backgroundTask");
  if (open?.kind !== "item.open" || open.item.type !== "backgroundTask") throw new Error("Expected a job open");
  return { key: open.key, item: open.item };
}

function closedJob(deltas: ThreadDelta[]) {
  const close = deltas.find((delta) => delta.kind === "item.close" && delta.item.type === "backgroundTask");
  if (close?.kind !== "item.close" || close.item.type !== "backgroundTask") throw new Error("Expected a job close");
  return { key: close.key, status: close.status, item: close.item };
}

describe("structured bash async job lifecycles", () => {
  it("keeps completed dispatch distinct from a pending native job without inventing shell success", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const result = launch(h);
    const job = openedJob(result.deltas);
    const dispatch = result.deltas.find((delta) => delta.kind === "item.close" && delta.item.type === "command");
    expect(dispatch).toMatchObject({
      kind: "item.close", key: { providerItemId: "bash-launch" }, status: "completed",
      presentation: {
        icon: { glyph: "Toolbox" },
        label: { completed: "Dispatched background bash" }, title: "Bash job bg_1",
        detail: "Background job: bg_1",
      },
    });
    if (dispatch?.kind !== "item.close" || dispatch.item.type !== "command") throw new Error("Expected dispatch");
    expect(dispatch.exitCode).toBeUndefined();
    expect(dispatch.item.exitCode).toBeUndefined();
    expect(job.key.providerItemId).not.toBe(dispatch.key.providerItemId);
    expect(job.item).toMatchObject({
      type: "backgroundTask", taskType: "local_bash", status: "pending", taskStatus: "running",
      workflowName: "Bash job bg_1", description: "run-checks [job bg_1]", summary: "Dispatch accepted",
    });
    expect(result.deltas).toContainEqual(expect.objectContaining({
      kind: "item.open", key: job.key, presentation: expect.objectContaining({ icon: { glyph: "Toolbox" } }),
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "item/started", item: expect.objectContaining({ type: "backgroundTask", status: "pending", taskStatus: "running" }),
    }));
    expect(result.events.some((event) => event.type === "item/backgroundTask/completed")).toBe(false);
  });

  it.each([
    { state: "completed", status: "completed", taskStatus: "completed", exitCode: 0, text: "All checks passed" },
    { state: "failed", status: "failed", taskStatus: "failed", exitCode: 7, text: "Permission denied" },
    { state: "cancelled", status: "interrupted", taskStatus: "stopped", exitCode: undefined, text: "Cancelled by operator" },
  ])("tracks running output then explicit $state after dispatch", ({ state, status, taskStatus, exitCode, text }) => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const job = openedJob(launch(h).deltas);
    const running = h.translate(update("running", { text: "Still checking" }));
    expect(running.deltas).toMatchObject([{
      kind: "item.progress", key: job.key,
      snapshot: { type: "backgroundTask", status: "pending", taskStatus: "running", summary: "Still checking" },
    }]);
    const terminal = h.translate(update(state, { text, exitCode }));
    expect(terminal.deltas).toHaveLength(1);
    expect(closedJob(terminal.deltas)).toMatchObject({ key: job.key, status, item: { status, taskStatus } });
    expect(closedJob(terminal.deltas).item.summary).toContain(text);
    if (exitCode !== undefined) expect(closedJob(terminal.deltas).item.summary).toContain(`Exit code: ${exitCode}`);
    if (state === "failed") expect(closedJob(terminal.deltas).item.error).toBe(text);
    expect(terminal.events).toContainEqual(expect.objectContaining({
      type: "item/backgroundTask/completed", scope: { kind: "thread" },
      item: expect.objectContaining({ type: "backgroundTask", status, taskStatus }),
    }));
    expect(h.translate(update(state, { text, exitCode })).deltas).toEqual([]);
    expect(h.translate(update("running", { text: "Stale running frame" })).deltas).toEqual([]);
  });

  it("routes late originating updates to the same job after the spawning turn has closed", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const job = openedJob(launch(h).deltas);
    h.translate({ type: "agent_end", messages: [], deferSettlement: false });
    const running = h.translate(update("running", { text: "Still running while idle" }));
    expect(running.events).toContainEqual(expect.objectContaining({
      type: "item/backgroundTask/progress", scope: { kind: "thread" },
      item: expect.objectContaining({ status: "pending", taskStatus: "running" }),
    }));
    h.translate({ type: "agent_start" });
    expect(closedJob(h.translate(update("failed", { text: "Late failure", exitCode: 2 })).deltas)).toMatchObject({
      key: job.key, status: "failed", item: { taskStatus: "failed", error: "Late failure" },
    });
  });

  it("observes failed wait snapshots across turn settlement while the wait invocation succeeds", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const job = openedJob(launch(h).deltas);
    h.translate({ type: "agent_end", messages: [], deferSettlement: false });
    h.translate({ type: "agent_start" });
    h.translate({ type: "tool_execution_start", toolCallId: "wait-call", toolName: "wait", args: {} });
    const failed = h.translate(waitUpdate([
      { id: "unknown-job", type: "bash", status: "completed" },
      { id: "bg_1", type: "bash", status: "failed", resultText: "Partial output", errorText: "Signal failure", exitCode: 9 },
    ]));
    expect(failed.deltas).toHaveLength(1);
    expect(closedJob(failed.deltas)).toMatchObject({
      key: job.key, status: "failed", item: { status: "failed", taskStatus: "failed", error: "Signal failure" },
    });
    expect(closedJob(failed.deltas).item.summary).toContain("Partial output");
    expect(closedJob(failed.deltas).item.summary).toContain("Exit code: 9");
    const waitEnd = h.translate({
      type: "tool_execution_end", toolCallId: "wait-call", toolName: "wait", isError: false,
      result: { content: [{ type: "text", text: "Observed job failure" }], details: {
        op: "wait", jobs: [{ id: "bg_1", status: "failed", resultText: "", errorText: "", exitCode: 9 }],
      } },
    });
    expect(jobDeltas(waitEnd.deltas)).toEqual([]);
    expect(waitEnd.events).toContainEqual(expect.objectContaining({
      type: "item/completed", item: expect.objectContaining({ type: "toolCall", tool: "wait", status: "completed" }),
    }));
  });

  it("uses terminal wait results even when there was no update or later delivery", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const job = openedJob(launch(h).deltas);
    const end = h.translate({
      type: "tool_execution_end", toolCallId: "wait-call", toolName: "wait", isError: false,
      result: { details: { op: "wait", jobs: [{ id: "bg_1", status: "completed", resultText: "Done", exitCode: 0 }] } },
    });
    expect(closedJob(end.deltas)).toMatchObject({
      key: job.key, status: "completed", item: { taskStatus: "completed", summary: "Done\n\nExit code: 0" },
    });
  });

  it("ignores empty/duration-only wait heartbeats and interrupted waits without changing wait presentation", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    launch(h);
    h.translate({ type: "tool_execution_start", toolCallId: "wait-call", toolName: "wait", args: {} });
    for (const durationMs of [0, 500, 1000]) {
      expect(h.translate(waitUpdate([{ id: "bg_1", type: "bash", status: "running", durationMs }])).deltas).toEqual([]);
    }
    expect(h.translate(waitUpdate([{ id: "bg_1", status: "running" }], "Still waiting")).deltas).toMatchObject([{
      kind: "item.progress", key: { providerItemId: "wait-call" }, message: "Still waiting",
    }]);
    const interrupted = h.translate({
      type: "tool_execution_end", toolCallId: "wait-call", toolName: "wait",
      result: { details: { op: "wait", jobs: [], interrupted: true } },
    });
    expect(jobDeltas(interrupted.deltas)).toEqual([]);
    expect(closedJob(h.translate(update("failed", { text: "Later failure" })).deltas).status).toBe("failed");
  });

  it("consumes explicit delivery statuses only for known jobs and retains the separate report card", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const job = openedJob(launch(h).deltas);
    const otherJob = openedJob(launch(h, { toolCallId: "other-bash", jobId: "bg_2" }).deltas);
    const jobs = [
      { jobId: "unknown-job", type: "bash", status: "completed" },
      { jobId: "bg_1", type: "bash", status: "failed" },
      { jobId: "bg_2", type: "bash", status: "completed" },
    ];
    const message = h.translate(delivery(jobs));
    expect(jobDeltas(message.deltas)).toHaveLength(2);
    expect(closedJob(message.deltas)).toMatchObject({ key: job.key, status: "failed", item: { taskStatus: "failed" } });
    expect(message.deltas).toContainEqual(expect.objectContaining({
      kind: "item.close", key: otherJob.key, status: "completed",
      item: expect.objectContaining({ type: "backgroundTask", taskStatus: "completed" }),
    }));
    expect(message.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", item: expect.objectContaining({ type: "extension" }) }));
    expect(jobDeltas(h.translate(delivery(jobs, "message_end")).deltas)).toEqual([]);
    expect(jobDeltas(h.translate(delivery(jobs)).deltas)).toEqual([]);
  });

  it("never infers job success from invocation settlement, absent/unknown delivery status or unknown wait metadata", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    launch(h);
    expect(jobDeltas(h.translate({ type: "agent_end", messages: [], deferSettlement: false }).deltas)).toEqual([]);
    h.translate({ type: "agent_start" });
    for (const status of [undefined, "unknown"]) {
      expect(jobDeltas(h.translate(delivery([{ jobId: "bg_1", status }])).deltas)).toEqual([]);
    }
    expect(h.translate(waitUpdate([
      { id: "bg_1", status: "unknown", exitCode: 0 },
      { id: "bg_1", type: "eval", status: "completed" },
      { id: "bg_1", exitCode: 0, resultText: "Completed" },
      { id: "unknown-job", status: "completed" },
    ])).deltas).toEqual([]);
    expect(jobDeltas(h.translate(update("unknown", { text: "Completed", exitCode: 0 })).deltas)).toEqual([]);
    expect(closedJob(h.translate(update("failed", { text: "Actual failure" })).deltas).status).toBe("failed");
  });

  it("fills late diagnostics without a second terminal event or terminal-state reversal", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const job = openedJob(launch(h).deltas);
    h.translate(delivery([{ jobId: "bg_1", status: "failed" }]));
    const diagnostic = h.translate(update("failed", { text: "\u001b[31mPermission denied\u001b[0m", exitCode: 13 }));
    expect(diagnostic.deltas).toMatchObject([{
      kind: "item.progress", key: job.key, flush: true,
      snapshot: { status: "failed", taskStatus: "failed", error: "Permission denied", summary: "Permission denied\n\nExit code: 13" },
    }]);
    expect(diagnostic.events.some((event) => event.type === "item/backgroundTask/completed")).toBe(false);
    expect(h.translate(update("failed", { text: "Permission denied", exitCode: 13 })).deltas).toEqual([]);
    expect(h.translate(update("completed", { text: "Contradictory replay", exitCode: 0 })).deltas).toEqual([]);
    expect(h.translate(waitUpdate([{ id: "bg_1", status: "failed", resultText: "", errorText: "" }])).deltas).toEqual([]);
  });

  it.each([
    undefined,
    { state: "completed", id: "bg_1", type: "bash" },
    { state: "completed", jobId: "bg_1" },
    { state: "unknown", jobId: "bg_1", type: "bash" },
    { state: "running", jobId: "bg_1", type: "eval" },
  ])("keeps malformed/unstructured async metadata invocation-only (%j)", (async) => {
    const h = harness();
    h.translate({ type: "agent_start" });
    h.translate({ type: "tool_execution_start", toolCallId: "bash-plain", toolName: "bash", args: { command: "work", cwd: "/repo", async: true } });
    const result = h.translate({
      type: "tool_execution_end", toolCallId: "bash-plain", toolName: "bash",
      result: { content: [{ type: "text", text: "Job bg_1 running; completed successfully" }], details: { async } },
    });
    expect(jobDeltas(result.deltas)).toEqual([]);
    expect(result.deltas).toContainEqual(expect.objectContaining({ kind: "item.close", item: expect.objectContaining({ type: "command" }) }));
    expect(jobDeltas(h.translate(delivery([{ jobId: "bg_1", status: "completed" }])).deltas)).toEqual([]);
  });

  it("accepts structured async updates during a known invocation without duplicating its job at dispatch", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    h.translate({ type: "tool_execution_start", toolCallId: "bash-launch", toolName: "bash", args: { command: "work", cwd: "/repo" } });
    const job = openedJob(h.translate(update("running", { text: "Working" })).deltas);
    const end = h.translate({ type: "tool_execution_end", toolCallId: "bash-launch", toolName: "bash", result: asyncResult("running", { text: "Working" }) });
    expect(jobDeltas(end.deltas)).toEqual([]);
    expect(closedJob(h.translate(update("completed", { text: "Done" })).deltas).key).toEqual(job.key);
    expect(jobDeltas(h.translate(update("completed", { toolCallId: "unknown-call", jobId: "unknown-job" })).deltas)).toEqual([]);
  });

  it("uses an explicit terminal async result without treating dispatch success as shell success", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    h.translate({
      type: "tool_execution_start", toolCallId: "bash-launch", toolName: "bash",
      args: { command: "work", cwd: "/repo" },
    });
    const result = h.translate({
      type: "tool_execution_end", toolCallId: "bash-launch", toolName: "bash", isError: false,
      result: asyncResult("failed", { text: "Job failed before dispatch returned" }),
    });
    expect(closedJob(result.deltas)).toMatchObject({ status: "failed", item: { taskStatus: "failed" } });
    const dispatch = result.deltas.find((delta) => delta.kind === "item.close" && delta.item.type === "command");
    expect(dispatch).toMatchObject({
      kind: "item.close", status: "completed", presentation: { label: { completed: "Dispatched background bash" } },
    });
    if (dispatch?.kind !== "item.close") throw new Error("Expected dispatch");
    expect(dispatch.exitCode).toBeUndefined();
  });

  it("isolates thread/parent ownership and starts a fresh identity after session reset", () => {
    const h = harness();
    const scopes = [context, { ...context, threadId: "other-thread" }, { ...context, parentToolCallId: "parent-task" }];
    const keys = scopes.map((scope) => {
      h.translate({ type: "agent_start" }, scope);
      return openedJob(launch(h, { scope }).deltas).key;
    });
    expect(new Set(keys.map((key) => key.providerItemId)).size).toBe(3);
    expect(keys[2]?.parentRef).toBe("parent-task");
    expect(closedJob(h.translate(waitUpdate([{ id: "bg_1", status: "failed" }]), scopes[1]).deltas).key).toEqual(keys[1]);
    expect(closedJob(h.translate(update("completed"), scopes[2]).deltas).key).toEqual(keys[2]);
    h.translator.resetThread(THREAD);
    expect(h.translate(waitUpdate([{ id: "bg_1", status: "completed" }])).deltas).toEqual([]);
    const replacement = openedJob(launch(h).deltas);
    expect(replacement.key.providerItemId).not.toBe(keys[0]?.providerItemId);
    expect(closedJob(h.translate(update("completed")).deltas).key).toEqual(replacement.key);
  });

  it("does not alias a reused job ID to an earlier native call", () => {
    const h = harness();
    h.translate({ type: "agent_start" });
    const old = openedJob(launch(h, { toolCallId: "old-call" }).deltas);
    h.translate(update("completed", { toolCallId: "old-call" }));
    const current = openedJob(launch(h, { toolCallId: "new-call" }).deltas);
    expect(current.key.providerItemId).not.toBe(old.key.providerItemId);
    expect(h.translate(update("failed", { toolCallId: "old-call", text: "Stale failure" })).deltas).toEqual([]);
    expect(closedJob(h.translate(waitUpdate([{ id: "bg_1", status: "completed" }])).deltas).key).toEqual(current.key);
  });
  it.each([
    ["pr_review_ask", "The request is shown to the user. A successful result will arrive separately."],
    ["pr_review_add", "Added PR A. Not added: PR B: timeout."],
  ])("keeps %s output as invocation evidence, not a derived outcome", (toolName, text) => {
    const h = harness();
    h.translate({ type: "agent_start" });
    h.translate({ type: "tool_execution_start", toolCallId: "pr-call", toolName, args: {} });
    const result = h.translate({
      type: "tool_execution_end", toolCallId: "pr-call", toolName,
      result: { content: [{ type: "text", text }], details: {} },
    });
    expect(jobDeltas(result.deltas)).toEqual([]);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({ type: "toolCall", tool: toolName, status: "completed",
        result: expect.objectContaining({ content: [{ type: "text", text }] }) }),
    }));
  });

});
