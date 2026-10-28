import { describe, expect, it } from "vitest";
import { threadDeltaSchema, type ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOmpDeltaTranslator, type OmpDeltaTranslationContext, type OmpDeltaTranslator } from "./delta-translation.js";

const THREAD = "wait-thread";
const WAIT = "wait-call";
const context = { threadId: THREAD, cwd: "/repo" };

interface Translation {
  deltas: ThreadDelta[];
  events: ThreadEvent[];
}

interface Harness {
  translator: OmpDeltaTranslator;
  send(event: unknown, scope?: OmpDeltaTranslationContext): Translation;
}

function harness(): Harness {
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const assembler = createDeltaAssembler({
    providerId: "omp", entropyPrefix: "wait", textDeltaFlushMs: 0, progressThrottleMs: 0,
  });
  return {
    translator,
    send(event: unknown, scope: OmpDeltaTranslationContext = context) {
      const deltas = translator.translate(event, scope);
      for (const delta of deltas) expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
      return { deltas, events: assembler.assemble({ threadId: scope.threadId ?? THREAD, deltas }) };
    },
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: "bg_1", type: "bash", status: "running", label: "Checks", durationMs: 0, ...overrides };
}

function waitResult(jobs: unknown[]) {
  return { content: [{ type: "text", text: "" }], details: { op: "wait", jobs } };
}

function startWait(h: Harness, scope: OmpDeltaTranslationContext = context, toolCallId = WAIT) {
  return h.send({
    type: "tool_execution_start", toolName: "wait", toolCallId, args: {}, intent: "Waiting for work",
  }, scope);
}

function updateWait(h: Harness, partialResult: unknown, scope: OmpDeltaTranslationContext = context, toolCallId = WAIT) {
  return h.send({ type: "tool_execution_update", toolName: "wait", toolCallId, partialResult }, scope);
}

function endWait(h: Harness, result: unknown, scope: OmpDeltaTranslationContext = context, toolCallId = WAIT) {
  return h.send({ type: "tool_execution_end", toolName: "wait", toolCallId, isError: false, result }, scope);
}

function messages(deltas: ThreadDelta[], toolCallId = WAIT) {
  return deltas.flatMap((delta) =>
    delta.kind === "item.progress" && delta.key.providerItemId === toolCallId && delta.message !== undefined
      ? [delta.message] : [],
  );
}

function backgroundDeltas(deltas: ThreadDelta[]) {
  return deltas.filter((delta) =>
    ((delta.kind === "item.open" || delta.kind === "item.close") && delta.item.type === "backgroundTask") ||
    (delta.kind === "item.progress" && delta.snapshot?.type === "backgroundTask"),
  );
}

function expectProgress(result: Translation, message: string, toolCallId = WAIT) {
  expect(messages(result.deltas, toolCallId)).toEqual([message]);
  expect(result.events).toContainEqual(expect.objectContaining({ type: "item/toolCall/progress", message }));
}

function expectRawTerminal(result: Translation, raw: unknown, status: "completed" | "failed" = "completed", toolCallId = WAIT) {
  const close = result.deltas.find((delta) => delta.kind === "item.close" && delta.key.providerItemId === toolCallId);
  if (close?.kind !== "item.close" || close.item.type !== "tool") throw new Error("Expected generic wait close");
  expect(close.status).toBe(status);
  expect(close.item.tool).toBe("wait");
  expect(close.item.args).toEqual({});
  expect(close.item.result).toEqual(raw);
  const completed = result.events.find((event) => event.type === "item/completed" && event.item.type === "toolCall" && event.item.tool === "wait");
  if (completed?.type !== "item/completed" || completed.item.type !== "toolCall") throw new Error("Expected assembled wait completion");
  expect(completed.item).toMatchObject({ tool: "wait", status });
  expect(completed.item.result).toEqual(raw);
  return completed.item;
}

function launchBash(h: Harness) {
  h.send({ type: "tool_execution_start", toolName: "bash", toolCallId: "bash-launch", args: { command: "run-checks", async: true } });
  const launched = h.send({
    type: "tool_execution_end", toolName: "bash", toolCallId: "bash-launch", isError: false,
    result: { content: [{ type: "text", text: "Dispatched" }], details: { async: { state: "running", jobId: "bg_1", type: "bash" } } },
  });
  const job = launched.deltas.find((delta) => delta.kind === "item.open" && delta.item.type === "backgroundTask");
  if (job?.kind !== "item.open") throw new Error("Expected launched bash job");
  return job.key;
}

function completeBash(h: Harness) {
  return h.send({
    type: "tool_execution_update", toolName: "bash", toolCallId: "bash-launch",
    partialResult: { content: [{ type: "text", text: "Actually completed" }], details: { async: { state: "completed", jobId: "bg_1", type: "bash" }, exitCode: 0 } },
  });
}

describe("native wait invocation presentation", () => {
  it("retains native args on the wire and one generic call identity through mixed job progress and completion", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const start = startWait(h);
    expect(start.deltas).toContainEqual(expect.objectContaining({
      kind: "item.open", key: { providerItemId: WAIT }, item: { type: "tool", tool: "wait", args: {} },
    }));
    const started = start.events.find((event) => event.type === "item/started");
    expect(started?.item).toMatchObject({ type: "toolCall", tool: "wait", status: "pending" });
    const raw = waitResult([
      snapshot({ label: "  Checks  ", resultText: "Do not copy output", errorText: "Do not copy errors" }),
      snapshot({ id: "task_2", type: "task", label: "  Review  ", completionPercent: 0, stage: "  Planning  " }),
      snapshot({ id: "eval_3", type: "eval", status: "completed", label: "  ", exitCode: 0 }),
    ]);
    const progress = updateWait(h, raw);
    expectProgress(progress, "bg_1 [bash]: running — Checks\ntask_2 [task]: running — 0% — Review — Planning\neval_3 [eval]: completed — exit 0");
    expect(backgroundDeltas(progress.deltas)).toEqual([]);
    const completed = expectRawTerminal(endWait(h, raw), raw);
    expect(completed.id).toBe(started?.item.id);
  });

  it("deduplicates semantic snapshots but emits changed percentages, shorter stages and terminal statuses", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    startWait(h);
    const task = snapshot({ id: "task_1", type: "task", label: "Review", completionPercent: 40, stage: "Inspecting all modules" });
    expectProgress(updateWait(h, waitResult([task])), "task_1 [task]: running — 40% — Review — Inspecting all modules");
    for (const replay of [task, { ...task, durationMs: 500 }, {
      ...task, durationMs: 1000, label: "  Review ", stage: " Inspecting all modules  ", resultText: "New output", errorText: "New diagnostics", nativeHeartbeat: 2,
    }]) {
      const unchanged = updateWait(h, waitResult([replay]));
      expect(messages(unchanged.deltas)).toEqual([]);
      expect(unchanged.events.filter((event) => event.type === "item/toolCall/progress")).toEqual([]);
    }
    expectProgress(updateWait(h, waitResult([{ ...task, completionPercent: 41 }])), "task_1 [task]: running — 41% — Review — Inspecting all modules");
    const shorter = { ...task, completionPercent: 41, stage: "Done" };
    expectProgress(updateWait(h, waitResult([shorter])), "task_1 [task]: running — 41% — Review — Done");
    expectProgress(updateWait(h, waitResult([{ ...shorter, status: "completed", completionPercent: 100 }])), "task_1 [task]: completed — Review — Done");
    expect(messages(updateWait(h, waitResult([{ ...shorter, status: "completed", completionPercent: 95, durationMs: 5000 }])).deltas)).toEqual([]);
  });

  it.each([
    { name: "failed process", errorText: "Process exited unsuccessfully", exitCode: 9 },
    { name: "native timeout without an exit code", errorText: "Timed out after 300 seconds", exitCode: undefined },
  ])("keeps a $name independent of the successful wait invocation", ({ errorText, exitCode }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const key = launchBash(h);
    startWait(h);
    const raw = waitResult([snapshot({ status: "failed", resultText: "Partial output", errorText, ...(exitCode !== undefined ? { exitCode } : {}) })]);
    const observed = updateWait(h, raw);
    expectProgress(observed, `bg_1 [bash]: failed — Checks${exitCode !== undefined ? ` — exit ${exitCode}` : ""}`);
    expect(backgroundDeltas(observed.deltas)).toMatchObject([{
      kind: "item.close", key, status: "failed", item: { type: "backgroundTask", status: "failed", taskStatus: "failed", error: errorText },
    }]);
    expect(observed.events).toContainEqual(expect.objectContaining({
      type: "item/backgroundTask/completed", item: expect.objectContaining({ status: "failed", error: errorText }),
    }));
    const end = endWait(h, raw);
    expect(backgroundDeltas(end.deltas)).toEqual([]);
    expectRawTerminal(end, raw);
  });

  it("preserves long output, errors and arbitrary native fields byte-exactly without copying them into status text", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    startWait(h);
    const resultText = "\u001b[32moutput\u001b[0m\r\n零\t\"quoted\" ".repeat(4096);
    const errorText = "\u001b[31merror\u001b[0m\r\nخطأ\t\\path ".repeat(4096);
    const raw = {
      ...waitResult([snapshot({ status: "failed", resultText, errorText, exitCode: 23, native: { diagnostics: [errorText], artifact: "artifact://native" } })]),
      nativeEnvelope: { output: resultText, opaque: [null, false, 0, "\r\n"] },
    };
    const update = updateWait(h, raw);
    expectProgress(update, "bg_1 [bash]: failed — Checks — exit 23");
    expect(backgroundDeltas(update.deltas)).toEqual([]);
    expectRawTerminal(endWait(h, raw), raw);
  });

  it.each([
    { name: "empty jobs", raw: waitResult([]) },
    { name: "metadata-only empty jobs", raw: { details: { op: "wait", jobs: [] } } },
    { name: "metadata-only malformed jobs", raw: { details: { op: "wait", jobs: [snapshot({ status: "unknown" })] } } },
    { name: "absent jobs", raw: { content: [{ type: "text", text: "" }], details: { op: "wait" } } },
    { name: "nonarray jobs", raw: { content: [{ type: "text", text: "" }], details: { op: "wait", jobs: {} } } },
    { name: "null snapshot", raw: waitResult([null]) },
    { name: "missing label", raw: waitResult([{ id: "bg_1", type: "bash", status: "running", durationMs: 0 }]) },
    { name: "empty job id", raw: waitResult([snapshot({ id: "" })]) },
    { name: "invalid job type", raw: waitResult([snapshot({ type: "process" })]) },
    { name: "invalid status", raw: waitResult([snapshot({ status: "timeout" })]) },
    { name: "negative duration", raw: waitResult([snapshot({ durationMs: -1 })]) },
    { name: "unstructured empty result", raw: { content: [{ type: "text", text: "" }] } },
  ])("does not manufacture wait progress for $name and retains the terminal envelope", ({ raw }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    startWait(h);
    const update = updateWait(h, raw);
    expect(update.deltas).toEqual([]);
    expect(update.events).toEqual([]);
    const end = endWait(h, raw);
    expect(messages(end.deltas)).toEqual([]);
    expect(backgroundDeltas(end.deltas)).toEqual([]);
    expectRawTerminal(end, raw);
  });

  it("retains a non-synthetic native wait execution error without failing its known background job", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const key = launchBash(h);
    startWait(h);
    const raw = { content: [{ type: "text", text: "Wait failed" }] };
    const end = h.send({ type: "tool_execution_end", toolName: "wait", toolCallId: WAIT, isError: true, result: raw });
    expect(messages(end.deltas)).toEqual([]);
    expect(backgroundDeltas(end.deltas)).toEqual([]);
    expectRawTerminal(end, raw, "failed");
    expect(backgroundDeltas(completeBash(h).deltas)).toMatchObject([{ kind: "item.close", key, status: "completed" }]);
  });

  it.each([
    { __synthetic: true },
    { executed: false },
    { __synthetic: true, executed: false },
  ])("never observes contradictory jobs from a skipped native result (%j)", (markers) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const key = launchBash(h);
    startWait(h);
    const raw = {
      content: [{
        type: "text",
        text: "Skipped due to a queued background completion (job or supervised process). Do not count this skipped result as completed work or verification. After the completion notice is handled on the next step, retry the skipped tool if it is still needed.",
      }],
      details: { op: "wait", ...markers, source: "interrupt_skipped", jobs: [snapshot({ status: "failed", errorText: "Not executed" })] },
    };
    expect(updateWait(h, raw).deltas).toEqual([]);
    const end = h.send({ type: "tool_execution_end", toolName: "wait", toolCallId: WAIT, isError: true, result: raw });
    expect(messages(end.deltas)).toEqual([]);
    expect(backgroundDeltas(end.deltas)).toEqual([]);
    expectRawTerminal(end, raw, "failed");
    expect(backgroundDeltas(completeBash(h).deltas)).toMatchObject([{
      kind: "item.close", key, status: "completed", item: { taskStatus: "completed" },
    }]);
  });

  it("ignores orphan snapshots before start and after settlement without poisoning the next call's progress", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const raw = waitResult([snapshot()]);
    expect(updateWait(h, raw).deltas).toEqual([]);
    startWait(h);
    expectProgress(updateWait(h, raw), "bg_1 [bash]: running — Checks");
    expectRawTerminal(endWait(h, raw), raw);
    expect(updateWait(h, waitResult([snapshot({ status: "failed" })])).deltas).toEqual([]);
  });

  it("displays nonempty unstructured native text only as prose, not as a known job's state", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const key = launchBash(h);
    startWait(h);
    const raw = { content: [{ type: "text", text: "bg_1 failed: Timed out after 300 seconds" }] };
    const update = updateWait(h, raw);
    expectProgress(update, raw.content[0]!.text);
    expect(backgroundDeltas(update.deltas)).toEqual([]);
    expectRawTerminal(endWait(h, raw), raw);
    expect(backgroundDeltas(completeBash(h).deltas)).toMatchObject([{ kind: "item.close", key, status: "completed" }]);
  });

  it("retains a message-only wait terminal without inferring jobs from its opaque waited payload", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    const key = launchBash(h);
    startWait(h);
    const raw = {
      content: [{ type: "text", text: "bg_1 failed: Timed out after 300 seconds" }],
      details: { op: "wait", from: "Main", waited: {
        id: "msg-1", from: "Worker", to: "Main", body: "bg_1 failed: Timed out after 300 seconds", ts: 1_700_000_000_000, replyTo: "question-1",
      } },
    };
    const end = endWait(h, raw);
    expect(messages(end.deltas)).toEqual([]);
    expect(backgroundDeltas(end.deltas)).toEqual([]);
    expectRawTerminal(end, raw);
    expect(backgroundDeltas(completeBash(h).deltas)).toMatchObject([{ kind: "item.close", key, status: "completed" }]);
  });

  it.each([
    { name: "active jobs at the wait cap", raw: { ...waitResult([snapshot({ durationMs: 1_800_000 })]), useless: true } },
    { name: "service/reply wait cap", raw: {
      content: [{ type: "text", text: "Wait limit reached; background work may still be running. Read proc:// for status." }],
      details: { op: "wait", jobs: [] }, useless: true,
    } },
  ])("retains $name as successful wait settlement, not a background job timeout", ({ raw }) => {
    const h = harness();
    h.send({ type: "agent_start" });
    const key = launchBash(h);
    startWait(h);
    const end = endWait(h, raw);
    expect(messages(end.deltas)).toEqual([]);
    expect(backgroundDeltas(end.deltas)).toEqual([]);
    expectRawTerminal(end, raw);
    expect(backgroundDeltas(completeBash(h).deltas)).toMatchObject([{ kind: "item.close", key, status: "completed" }]);
  });

  it("isolates deduplication by native call, thread and parent, and clears it on reset", () => {
    const h = harness();
    h.send({ type: "agent_start" });
    h.send({ type: "agent_start" }, { ...context, threadId: "other-thread" });
    h.send({ type: "tool_execution_start", toolName: "task", toolCallId: "parent", args: {} });
    const scopes: OmpDeltaTranslationContext[] = [context, { ...context, threadId: "other-thread" }, { ...context, parentToolCallId: "parent" }];
    const raw = waitResult([snapshot()]);
    for (const scope of scopes) {
      for (const toolCallId of [WAIT, "other-wait"]) {
        startWait(h, scope, toolCallId);
        expectProgress(updateWait(h, raw, scope, toolCallId), "bg_1 [bash]: running — Checks", toolCallId);
        expect(messages(updateWait(h, raw, scope, toolCallId).deltas, toolCallId)).toEqual([]);
      }
    }
    h.translator.resetThread(THREAD);
    expect(updateWait(h, raw).deltas).toEqual([]);
    expect(messages(updateWait(h, raw, scopes[1]).deltas)).toEqual([]);
    startWait(h);
    expect(messages(updateWait(h, raw).deltas)).toEqual(["bg_1 [bash]: running — Checks"]);
  });
});
