import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { findNewestOmpSessionFile, resolveOmpThreadSessionDir } from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const TIMEOUT_MS = 90_000;
const objectSchema = z.record(z.string(), z.unknown());
const deltaBatchSchema = z.object({
  threadId: z.string(),
  deltas: z.array(objectSchema),
});
const toolCloseSchema = z.object({
  kind: z.literal("item.close"),
  status: z.string(),
  resultText: z.string(),
  item: z.object({ type: z.literal("tool"), tool: z.string() }),
});
const commandRowSchema = z.object({
  kind: z.enum(["item.open", "item.close"]),
  providerTurnId: z.string(),
  key: z.object({ providerItemId: z.string(), parentRef: z.string() }),
  status: z.string().optional(),
  item: z.object({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.string(),
    aggregatedOutput: z.string().optional(),
    exitCode: z.number().optional(),
  }),
});
const backgroundTaskRowSchema = z.object({
  kind: z.enum(["item.open", "item.close"]),
  key: z.object({ providerItemId: z.string() }),
  item: z.object({
    type: z.literal("backgroundTask"),
    status: z.string(),
    taskStatus: z.string(),
    description: z.string().optional(),
  }),
});
const editorStateSchema = z.object({
  kind: z.literal("extension.state"),
  extensionKind: z.literal("provider-omp/editor-text"),
  payload: z.object({ requestId: z.string().min(1), text: z.string() }),
});

type NativeQueuedMessage = string | {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};
interface NativeQueues {
  steering: NativeQueuedMessage[];
  followUp: NativeQueuedMessage[];
}

let harness: FakeOmpBridgeHarness;
let rpcLog: string;
let nextId: number;

beforeEach(async () => {
  harness = await startFakeOmpBridge({ prefix: "bb-omp-native-commands-", initialize: true });
  rpcLog = join(harness.workspaceDir, "rpc.jsonl");
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
  nextId = 80_000;
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function jsonLines(path: string): Record<string, unknown>[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => objectSchema.parse(JSON.parse(line))) : [];
}

function commands(type: string) {
  return jsonLines(rpcLog).filter((command) => command.type === type);
}

function commandRows(deltas: Record<string, unknown>[]) {
  return deltas.flatMap((delta) => {
    const parsed = commandRowSchema.safeParse(delta);
    return parsed.success ? [parsed.data] : [];
  });
}

function toolCloses(deltas: Record<string, unknown>[], tool: string) {
  return deltas.flatMap((delta) => {
    const parsed = toolCloseSchema.safeParse(delta);
    return parsed.success && parsed.data.item.tool === tool ? [parsed.data] : [];
  });
}

function rootLifecycle(deltas: Record<string, unknown>[]) {
  return deltas.filter((delta) =>
    delta.kind === "turn.open" ? !delta.parentRef
      : delta.kind === "turn.boundary" && !delta.providerTurnId,
  );
}

function expectIdleShellAdmission(deltas: Record<string, unknown>[]): void {
  expect(rootLifecycle(deltas)).toEqual([
    expect.objectContaining({ kind: "turn.open" }),
    expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
  ]);
}

async function start(threadId: string): Promise<string> {
  const response = await harness.startThread(threadId);
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
}

async function requestInput(
  threadId: string,
  providerThreadId: string,
  text: string,
  method: "turn/start" | "turn/steer" = "turn/start",
) {
  const since = harness.deltasOf(threadId).length;
  const clientRequestId = `creq_${randomUUID().replace(/-/gu, "").replace(/[01]/gu, "a").slice(0, 10)}`;
  const response = await harness.request(++nextId, method, {
    threadId, providerThreadId, clientRequestId,
    ...(method === "turn/steer" ? { expectedTurnId: "turn-1" } : {}),
    input: [{ type: "text", text, mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  return { since, clientRequestId, response };
}

async function submit(
  threadId: string,
  providerThreadId: string,
  text: string,
  method: "turn/start" | "turn/steer" = "turn/start",
) {
  const input = await requestInput(threadId, providerThreadId, text, method);
  expect(input.response.error, JSON.stringify(input.response)).toBeUndefined();
  expect(input.response.result).toMatchObject({ threadId });
  return input;
}

async function completeTool(threadId: string, providerThreadId: string, text: string, tool = "omp-queue") {
  const input = await submit(threadId, providerThreadId, text);
  await harness.waitForDelta(threadId, (delta) => toolCloses([delta], tool).length > 0, input.since);
  const deltas = harness.deltasOf(threadId).slice(input.since);
  expect(deltas.filter((delta) => delta.kind === "input.accepted" && delta.clientRequestId === input.clientRequestId))
    .toHaveLength(1);
  const closes = toolCloses(deltas, tool);
  expect(closes).toHaveLength(1);
  return { ...input, deltas, close: closes[0]! };
}

async function beginShell(threadId: string, providerThreadId: string, command: string) {
  const rootWasActive = rootLifecycle(harness.deltasOf(threadId)).at(-1)?.kind === "turn.open";
  const input = await submit(threadId, providerThreadId, `/omp-bash ${command}`);
  await harness.waitForDelta(threadId, (delta) => {
    const parsed = backgroundTaskRowSchema.safeParse(delta);
    return parsed.success && parsed.data.kind === "item.open";
  }, input.since);
  const deltas = harness.deltasOf(threadId).slice(input.since);
  const accepted = deltas.filter((delta) =>
    delta.kind === "input.accepted" && delta.clientRequestId === input.clientRequestId,
  );
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.providerTurnId).toBeUndefined();
  const opening = deltas.find((delta) =>
    delta.kind === "item.open" && backgroundTaskRowSchema.safeParse(delta).success,
  );
  const backgroundTask = backgroundTaskRowSchema.parse(opening);
  expect(backgroundTask.item).toMatchObject({ status: "pending", taskStatus: "running" });
  expect(backgroundTask.item.description).toContain(command);
  const childOpening = deltas.find((delta) => delta.kind === "turn.open" && delta.parentRef);
  const providerTurnId = z.string().parse(childOpening?.providerTurnId);
  const wrapperId = z.string().parse(childOpening?.parentRef);
  const admissionBatch = harness.messages.filter((message) => message.method === "thread/delta")
    .map((message) => deltaBatchSchema.parse(message.params))
    .find((batch) => batch.threadId === threadId && batch.deltas.some((delta) =>
      delta.kind === "input.accepted" && delta.clientRequestId === input.clientRequestId,
    ));
  expect(admissionBatch).toBeDefined();
  if (rootWasActive) expect(rootLifecycle(admissionBatch!.deltas)).toEqual([]);
  else expectIdleShellAdmission(admissionBatch!.deltas);
  expect(admissionBatch!.deltas).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: "item.open", key: { providerItemId: wrapperId },
      item: expect.objectContaining({ type: "delegation", background: true }),
    }),
    expect.objectContaining({ kind: "turn.open", providerTurnId, parentRef: wrapperId }),
    expect.objectContaining({
      kind: "item.open", key: { providerItemId: backgroundTask.key.providerItemId },
      item: expect.objectContaining({ type: "backgroundTask", status: "pending", taskStatus: "running" }),
    }),
  ]));
  expect(admissionBatch!.deltas.filter((delta) =>
    delta.kind === "item.open" && objectSchema.parse(delta.item ?? {}).type === "command",
  )).toEqual([]);
  for (const delta of deltas.filter((delta) => delta.kind === "turn.open" && delta.providerTurnId)) {
    expect(delta.parentRef).toBe(wrapperId);
  }
  return { ...input, providerTurnId, wrapperId, backgroundTaskId: backgroundTask.key.providerItemId };
}

async function endShell(threadId: string, input: {
  since: number; providerTurnId: string; wrapperId: string; backgroundTaskId: string;
}) {
  await harness.waitForDelta(threadId, (delta) =>
    delta.kind === "turn.boundary" && delta.providerTurnId === input.providerTurnId, input.since,
  );
  await harness.waitForDelta(threadId, (delta) => {
    const parsed = backgroundTaskRowSchema.safeParse(delta);
    return parsed.success && parsed.data.kind === "item.close" &&
      parsed.data.key.providerItemId === input.backgroundTaskId;
  }, input.since);
  const allDeltas = harness.deltasOf(threadId).slice(input.since);
  const deltas = allDeltas.filter((delta) => delta.providerTurnId === input.providerTurnId);
  expect(deltas.filter((delta) => delta.kind === "turn.open")).toEqual([
    expect.objectContaining({ parentRef: input.wrapperId }),
  ]);
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toHaveLength(1);
  const rows = commandRows(deltas);
  expect(rows.map((row) => row.kind)).toEqual(["item.close"]);
  expect(rows[0]?.key.parentRef).toBe(input.wrapperId);
  expect(deltas.findIndex((delta) => delta.kind === "turn.boundary"))
    .toBeGreaterThan(deltas.findIndex((delta) => delta.kind === "item.close"));
  const wrappers = allDeltas.filter((delta) =>
    delta.kind === "item.close" && objectSchema.parse(delta.key ?? {}).providerItemId === input.wrapperId,
  );
  expect(wrappers).toEqual([expect.objectContaining({
    key: { providerItemId: input.wrapperId },
    item: expect.objectContaining({ type: "delegation", background: true, summary: expect.any(String) }),
  })]);
  expect(wrappers[0]?.providerTurnId).toBeUndefined();
  const backgroundTasks = allDeltas.flatMap((delta) => {
    const parsed = backgroundTaskRowSchema.safeParse(delta);
    return parsed.success && parsed.data.key.providerItemId === input.backgroundTaskId ? [parsed.data] : [];
  });
  expect(backgroundTasks.map((row) => row.kind)).toEqual(["item.open", "item.close"]);
  expect(backgroundTasks[1]?.item.status).not.toBe("pending");
  expect(backgroundTasks[1]?.item.taskStatus).not.toBe("running");
  return { deltas, close: rows[0]!, backgroundTask: backgroundTasks[1]! };
}

async function holdAndSeed(threadId: string, providerThreadId: string, queues: NativeQueues) {
  const held = await submit(threadId, providerThreadId, "/hold");
  await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open" && !delta.parentRef, held.since);
  const seeded = await submit(threadId, providerThreadId, `/native-queue ${JSON.stringify(queues)}`);
  await harness.waitForDelta(threadId, (delta) =>
    toolCloses([delta], "omp-command").some((close) => close.resultText.includes("Native queue populated.")), seeded.since,
  );
  expect(rootLifecycle(harness.deltasOf(threadId).slice(seeded.since))).toEqual([]);
}

describe("OMP native user shell commands", () => {
  it("shows a pending background task, completes idle admission immediately, and persists authoritative command output", async () => {
    const releaseFile = join(harness.workspaceDir, "release-bash");
    vi.stubEnv("FAKE_OMP_BASH_RELEASE_FILE", releaseFile);
    const threadId = "thr_native_bash_pending";
    const providerThreadId = await start(threadId);
    const input = await beginShell(threadId, providerThreadId, "printf 'hello café'");
    const pending = harness.deltasOf(threadId).slice(input.since);
    expect(commandRows(pending)).toEqual([]);
    const pendingTask = pending.find((delta) =>
      delta.kind === "item.open" && backgroundTaskRowSchema.safeParse(delta).success,
    );
    expect(backgroundTaskRowSchema.parse(pendingTask).item).toMatchObject({
      status: "pending", taskStatus: "running", description: expect.stringContaining("printf 'hello café'"),
    });
    expect(pending.filter((delta) =>
      delta.kind === "item.textDelta" || delta.kind === "item.progress" ||
      (delta.kind === "turn.boundary" && delta.providerTurnId === input.providerTurnId),
    )).toEqual([]);
    expectIdleShellAdmission(pending);
    writeFileSync(releaseFile, "release");
    const result = await endShell(threadId, input);
    expect(result.close).toMatchObject({
      status: "completed",
      item: { command: "printf 'hello café'", aggregatedOutput: "Executed by OMP: printf 'hello café'", exitCode: 0 },
    });
    expect(result.backgroundTask.item).toMatchObject({ status: "completed", taskStatus: "completed" });
    expectIdleShellAdmission(harness.deltasOf(threadId).slice(input.since));
    expect(commands("bash")).toEqual([expect.objectContaining({ command: "printf 'hello café'" })]);
    expect(commands("prompt")).toEqual([]);
    const directory = resolveOmpThreadSessionDir({ env: process.env, threadId: providerThreadId });
    const sessionFile = findNewestOmpSessionFile(directory);
    expect(sessionFile).toEqual(expect.any(String));
    const executions = jsonLines(sessionFile!).filter((entry) =>
      objectSchema.parse(entry.message ?? {}).role === "bashExecution",
    );
    expect(executions).toHaveLength(1);
    expect(JSON.stringify(executions[0])).toContain("printf 'hello café'");
    expect(JSON.stringify(executions[0])).toContain("Executed by OMP:");
    const stopped = await harness.request(++nextId, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    });
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined();
    const resumed = await harness.request(++nextId, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
    const next = await beginShell(threadId, providerThreadId, "printf 'after resume'");
    await endShell(threadId, next);
    expect(findNewestOmpSessionFile(directory)).toBe(sessionFile);
    expect(jsonLines(sessionFile!).filter((entry) =>
      objectSchema.parse(entry.message ?? {}).role === "bashExecution",
    )).toHaveLength(2);
  }, TIMEOUT_MS);

  it.each([
    { label: "nonzero exit", result: { output: "denied", exitCode: 7 }, status: "failed", warning: "denied" },
    { label: "timeout", result: { output: "partial", exitCode: 0, timedOut: true }, status: "failed", warning: "timed out" },
    { label: "cancellation", result: { output: "partial", exitCode: 0, cancelled: true }, status: "interrupted", warning: "cancelled" },
  ])("preserves $label and its command status", async ({ result, status, warning }) => {
    vi.stubEnv("FAKE_OMP_BASH_RESULT", JSON.stringify(result));
    const threadId = "thr_native_bash_status";
    const providerThreadId = await start(threadId);
    const input = await beginShell(threadId, providerThreadId, "run-command");
    const completed = await endShell(threadId, input);
    expect(completed.close).toMatchObject({ status, item: { exitCode: result.exitCode } });
    expect(completed.close.item.aggregatedOutput).toContain(warning);
    expectIdleShellAdmission(harness.deltasOf(threadId).slice(input.since));
  }, TIMEOUT_MS);

  it("reports truncated text, its artifact, native working directory, and unrendered images", async () => {
    const workingDir = join(harness.workspaceDir, "native-working-directory");
    vi.stubEnv("FAKE_OMP_BASH_RESULT", JSON.stringify({
      output: "\u001b[31mvisible output\u001b[0m", exitCode: 0, truncated: true,
      artifactId: "artifact://native-shell-output", workingDir,
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    }));
    const threadId = "thr_native_bash_metadata";
    const providerThreadId = await start(threadId);
    const completed = await endShell(threadId, await beginShell(threadId, providerThreadId, "render-image"));
    expect(completed.close).toMatchObject({ status: "completed", item: { cwd: workingDir, exitCode: 0 } });
    const output = completed.close.item.aggregatedOutput!;
    expect(output).toContain("visible output");
    expect(output).not.toContain("\u001b");
    expect(output).toMatch(/truncat/iu);
    expect(output).toContain("artifact://native-shell-output");
    expect(output).toMatch(/1 image.*text only/iu);
  }, TIMEOUT_MS);

  it("closes a failed command after a native RPC error without reopening idle admission", async () => {
    const threadId = "thr_native_bash_rpc_error";
    const providerThreadId = await start(threadId);
    const input = await beginShell(threadId, providerThreadId, "[rpc-error]");
    const result = await endShell(threadId, input);
    expect(result.close.status).toBe("failed");
    expect(result.close.item.aggregatedOutput).toMatch(/error|fail/iu);
    expectIdleShellAdmission(harness.deltasOf(threadId).slice(input.since));
    expect(harness.messages.filter((message) => message.method === "error" || message.method === "session/ended")).toEqual([]);
  }, TIMEOUT_MS);

  it("uses abort_bash cancel-all for concurrent shell commands without aborting an active main run", async () => {
    vi.stubEnv("FAKE_OMP_BASH_RELEASE_FILE", join(harness.workspaceDir, "never-release-bash"));
    const threadId = "thr_native_bash_abort_all";
    const providerThreadId = await start(threadId);
    const held = await submit(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open" && !delta.parentRef, held.since);
    const first = await beginShell(threadId, providerThreadId, "sleep first");
    const second = await beginShell(threadId, providerThreadId, "sleep second");
    const aborted = await completeTool(threadId, providerThreadId, "/omp-bash abort", "omp-bash");
    expect(aborted.close.status).toBe("completed");
    expect(aborted.close.resultText).toMatch(/all running/iu);
    expect(aborted.deltas).toContainEqual(expect.objectContaining({
      kind: "item.close", item: expect.objectContaining({ type: "tool", tool: "omp-bash" }),
    }));
    const abortResult = aborted.deltas.find((delta) => toolCloses([delta], "omp-bash").length > 0);
    expect(abortResult?.providerTurnId).toBeUndefined();
    expect((await endShell(threadId, first)).close.status).toBe("interrupted");
    expect((await endShell(threadId, second)).close.status).toBe("interrupted");
    expect(commands("abort_bash")).toHaveLength(1);
    expect(commands("abort")).toEqual([]);
    expect(rootLifecycle(harness.deltasOf(threadId).slice(first.since))).toEqual([]);
    const resumed = await submit(threadId, providerThreadId, "finish the main run", "turn/steer");
    await harness.waitForDelta(threadId, (delta) =>
      delta.kind === "turn.boundary" && delta.providerTurnId === undefined, resumed.since,
    );
    expect(rootLifecycle(harness.deltasOf(threadId))).toEqual([
      expect.objectContaining({ kind: "turn.open" }),
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]);
    expect(commands("steer")).toEqual([expect.objectContaining({ message: "finish the main run" })]);
  }, TIMEOUT_MS);
});

describe("OMP native queue controls", () => {
  it("lists ordered native indexes, removes and promotes exact messages, and leaves the active root running", async () => {
    const threadId = "thr_native_queue_edit";
    const providerThreadId = await start(threadId);
    await holdAndSeed(threadId, providerThreadId, {
      steering: ["steering first", "remove this"], followUp: ["follow-up first", "promote this"],
    });
    const listed = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(listed.close.resultText).toContain("1. [steering] steering first\n2. [steering] remove this\n3. [follow-up] follow-up first\n4. [follow-up] promote this");
    expect(listed.close.resultText).toMatch(/not bb's pending queue/iu);
    expect((await completeTool(threadId, providerThreadId, "/omp-queue remove 2")).close.status).toBe("completed");
    expect(commands("remove_queued_message")).toEqual([
      expect.objectContaining({ message: "remove this", queue: "steering" }),
    ]);
    expect((await completeTool(threadId, providerThreadId, "/omp-queue promote 3")).close.status).toBe("completed");
    expect(commands("promote_queued_message")).toEqual([expect.objectContaining({ message: "promote this" })]);
    const updated = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(updated.close.resultText).toContain("1. [steering] steering first\n2. [steering] promote this\n3. [follow-up] follow-up first");
    expect(updated.close.resultText).not.toContain("remove this");
    const shell = await beginShell(threadId, providerThreadId, "echo while active");
    expect((await endShell(threadId, shell)).close.status).toBe("completed");
    expect(rootLifecycle(harness.deltasOf(threadId).slice(listed.since))).toEqual([]);
    // Withdraw remaining native input before releasing /hold, so it cannot start extra model turns.
    for (let index = 0; index < 3; index += 1) {
      expect((await completeTool(threadId, providerThreadId, "/omp-queue remove 1")).close.status).toBe("completed");
    }
    const resumed = await submit(threadId, providerThreadId, "finish after native controls", "turn/steer");
    await harness.waitForDelta(threadId, (delta) =>
      delta.kind === "turn.boundary" && delta.providerTurnId === undefined, resumed.since,
    );
    expect(rootLifecycle(harness.deltasOf(threadId))).toEqual([
      expect.objectContaining({ kind: "turn.open" }),
      expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
    ]);
  }, TIMEOUT_MS);

  it("does not acknowledge a real queued follow-up merely because promotion moves it to steering", async () => {
    const releaseFile = join(harness.workspaceDir, "release-promoted-input");
    vi.stubEnv("FAKE_OMP_PROMOTE_RELEASE_FILE", releaseFile);
    const threadId = "thr_native_queue_real_promotion";
    const providerThreadId = await start(threadId);
    const held = await submit(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open" && !delta.parentRef, held.since);
    const queuedText = "queued real input";
    const clientRequestId = "creq_qp23456789";
    let responseSettled = false;
    const queuedResponsePromise = harness.request(++nextId, "turn/start", {
      threadId, providerThreadId, clientRequestId,
      input: [{ type: "text", text: queuedText, mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    }).then((response) => {
      responseSettled = true;
      return response;
    });
    try {
      await harness.waitFor(() => commands("prompt").some((command) => command.message === queuedText), "the real follow-up to reach native admission");
      const queued = await completeTool(threadId, providerThreadId, "/omp-queue");
      expect(queued.close.resultText).toContain(`1. [follow-up] ${queuedText}`);
      expect(responseSettled).toBe(false);
      const promoted = await completeTool(threadId, providerThreadId, "/omp-queue promote 1");
      expect(promoted.close.status).toBe("completed");
      expect(commands("promote_queued_message")).toEqual([expect.objectContaining({ message: queuedText })]);
      // A fresh native round trip observes the queue move while consumption is still gated.
      const moved = await completeTool(threadId, providerThreadId, "/omp-queue");
      expect(moved.close.resultText).toContain(`1. [steering] ${queuedText}`);
      expect(moved.close.resultText).not.toContain("[follow-up]");
      expect(responseSettled).toBe(false);
      expect(harness.deltasOf(threadId).filter((delta) =>
        delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId,
      )).toEqual([]);
      expect(rootLifecycle(harness.deltasOf(threadId))).toEqual([
        expect.objectContaining({ kind: "turn.open" }),
      ]);

      writeFileSync(releaseFile, "consume promoted input");
      const queuedResponse = await queuedResponsePromise;
      expect(queuedResponse.error, JSON.stringify(queuedResponse)).toBeUndefined();
      expect(queuedResponse.result).toMatchObject({ threadId });
      await harness.waitForDelta(threadId, (delta) =>
        delta.kind === "turn.boundary" && !delta.providerTurnId, held.since,
      );
      expect(harness.deltasOf(threadId).filter((delta) =>
        delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId,
      )).toHaveLength(1);
      expect(rootLifecycle(harness.deltasOf(threadId))).toEqual([
        expect.objectContaining({ kind: "turn.open" }),
        expect.objectContaining({ kind: "turn.boundary", status: "completed" }),
      ]);
      expect(commands("prompt").map((command) => command.message)).toEqual(["/hold", queuedText]);
      expect(harness.messages.filter((message) => message.method === "error" || message.method === "session/ended")).toEqual([]);
    } finally {
      writeFileSync(releaseFile, "release on cleanup");
      await queuedResponsePromise;
    }
  }, TIMEOUT_MS);

  it("acknowledges a real admitted follow-up exactly once when restoring it without replay", async () => {
    const threadId = "thr_native_queue_real_restore";
    const providerThreadId = await start(threadId);
    const held = await submit(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open" && !delta.parentRef, held.since);
    const queuedText = "queued real input\nKeep these details: café";
    const clientRequestId = "creq_qr23456789";
    let responseSettled = false;
    const queuedResponsePromise = harness.request(++nextId, "turn/start", {
      threadId, providerThreadId, clientRequestId,
      input: [{ type: "text", text: queuedText, mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    }).then((response) => {
      responseSettled = true;
      return response;
    });
    await harness.waitFor(() => commands("prompt").some((command) => command.message === queuedText), "the real restorable follow-up to reach native admission");
    const queued = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(queued.close.resultText).toContain(`1. [follow-up] ${queuedText}`);
    expect(responseSettled).toBe(false);
    expect(harness.deltasOf(threadId).filter((delta) =>
      delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId,
    )).toEqual([]);
    const promptsBefore = commands("prompt");
    const restored = await completeTool(threadId, providerThreadId, "/omp-queue restore");
    expect(restored.close.status).toBe("completed");
    const queuedResponse = await queuedResponsePromise;
    expect(responseSettled).toBe(true);
    expect(queuedResponse.error, JSON.stringify(queuedResponse)).toBeUndefined();
    expect(queuedResponse.result).toMatchObject({ threadId });
    await harness.waitForDelta(threadId, (delta) =>
      delta.kind === "turn.boundary" && !delta.providerTurnId && delta.status === "interrupted", held.since,
    );
    expect(harness.deltasOf(threadId).filter((delta) =>
      delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId,
    )).toHaveLength(1);
    const editorStates = harness.deltasOf(threadId).slice(restored.since).flatMap((delta) => {
      const parsed = editorStateSchema.safeParse(delta);
      return parsed.success ? [parsed.data] : [];
    });
    expect(editorStates).toHaveLength(1);
    expect(editorStates[0]?.payload.text).toBe(queuedText);
    expect(rootLifecycle(harness.deltasOf(threadId)).filter((delta) =>
      delta.kind === "turn.boundary" && delta.status === "interrupted",
    )).toHaveLength(1);
    expect(commands("abort_and_restore_queue")).toHaveLength(1);
    const empty = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(empty.close.resultText).toMatch(/queue is empty/iu);
    expect(commands("prompt")).toEqual(promptsBefore);
    expect(commands("prompt").map((command) => command.message)).toEqual(["/hold", queuedText]);
    expect(commands("steer")).toEqual([]);
    expect(commands("follow_up")).toEqual([]);
    expect(harness.messages.filter((message) => message.method === "error" || message.method === "session/ended")).toEqual([]);
  }, TIMEOUT_MS);

  it("rejects out-of-range, already-steering, and later duplicate indexes without native edits", async () => {
    const threadId = "thr_native_queue_indexes";
    const providerThreadId = await start(threadId);
    await holdAndSeed(threadId, providerThreadId, {
      steering: ["same", "same"], followUp: ["same", "same"],
    });
    for (const [command, message] of [
      ["remove 5", /choose an index|no .*message/iu],
      ["promote 1", /already.*steering/iu],
      ["remove 2", /first identical|earlier index/iu],
      ["remove 4", /first identical|earlier index/iu],
      ["promote 4", /first identical|earlier index/iu],
    ] as const) {
      const rejected = await completeTool(threadId, providerThreadId, `/omp-queue ${command}`);
      expect(rejected.close.status).toBe("failed");
      expect(rejected.close.resultText).toMatch(message);
      expect(rootLifecycle(rejected.deltas)).toEqual([]);
    }
    expect(commands("remove_queued_message")).toEqual([]);
    expect(commands("promote_queued_message")).toEqual([]);
    const listed = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(listed.close.resultText).toContain("1. [steering] same\n2. [steering] same\n3. [follow-up] same\n4. [follow-up] same");
  }, TIMEOUT_MS);

  it.each(["remove", "promote"])("reports native %s errors without claiming or applying an edit", async (operation) => {
    vi.stubEnv("FAKE_OMP_QUEUE_EDIT_FAILURE", "1");
    const threadId = "thr_native_queue_failure";
    const providerThreadId = await start(threadId);
    await holdAndSeed(threadId, providerThreadId, { steering: ["first"], followUp: ["second"] });
    const failed = await completeTool(threadId, providerThreadId, `/omp-queue ${operation} ${operation === "remove" ? 1 : 2}`);
    expect(failed.close.status).toBe("failed");
    expect(failed.close.resultText).toMatch(/error|fail/iu);
    expect(rootLifecycle(failed.deltas)).toEqual([]);
    const listed = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(listed.close.resultText).toContain("1. [steering] first\n2. [follow-up] second");
  }, TIMEOUT_MS);

  it("handles empty native queues for list, edits, and restoration without replacing the composer", async () => {
    const threadId = "thr_native_queue_empty";
    const providerThreadId = await start(threadId);
    for (const [command, status] of [
      ["/omp-queue", "completed"], ["/omp-queue remove 1", "failed"],
      ["/omp-queue promote 1", "failed"], ["/omp-queue restore", "completed"],
    ]) {
      const result = await completeTool(threadId, providerThreadId, command!);
      expect(result.close.status).toBe(status);
      expect(result.close.resultText).toMatch(/queue is empty/iu);
    }
    expect(harness.deltasOf(threadId).filter((delta) => editorStateSchema.safeParse(delta).success)).toEqual([]);
    expect(commands("remove_queued_message")).toEqual([]);
    expect(commands("promote_queued_message")).toEqual([]);
    expect(commands("prompt")).toEqual([]);
  }, TIMEOUT_MS);

  it.each([false, true])("restores exact oldest-first text once, aborts the root, and warns about lost content (flags %s)", async (flags) => {
    if (flags) vi.stubEnv("FAKE_OMP_RESTORE_QUEUE_FLAGS", JSON.stringify({ imagesDropped: true, truncated: true }));
    const threadId = "thr_native_queue_restore";
    const providerThreadId = await start(threadId);
    await holdAndSeed(threadId, providerThreadId, {
      steering: ["same", "same"],
      followUp: [{
        text: "follow-up\nsecond line",
        ...(!flags ? { images: [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }] } : {}),
      }],
    });
    const promptsBefore = commands("prompt");
    const restored = await completeTool(threadId, providerThreadId, "/omp-queue restore");
    expect(restored.close.status).toBe("completed");
    expect(restored.close.resultText).toMatch(/nothing was resubmitted/iu);
    if (flags) {
      expect(restored.close.resultText).toMatch(/dropped images/iu);
      expect(restored.close.resultText).toMatch(/truncated/iu);
    } else {
      expect(restored.close.resultText).toMatch(/1 image.*not restored/iu);
    }
    await harness.waitForDelta(threadId, (delta) =>
      delta.kind === "turn.boundary" && delta.providerTurnId === undefined && delta.status === "interrupted", restored.since,
    );
    const editorStates = harness.deltasOf(threadId).slice(restored.since).flatMap((delta) => {
      const parsed = editorStateSchema.safeParse(delta);
      return parsed.success ? [parsed.data] : [];
    });
    expect(editorStates).toHaveLength(1);
    expect(editorStates[0]?.payload.text).toBe("same\n\nsame\n\nfollow-up\nsecond line");
    expect(commands("abort_and_restore_queue")).toHaveLength(1);
    const empty = await completeTool(threadId, providerThreadId, "/omp-queue");
    expect(empty.close.resultText).toMatch(/queue is empty/iu);
    expect(commands("prompt")).toEqual(promptsBefore);
    expect(commands("steer")).toEqual([]);
    expect(commands("follow_up")).toEqual([]);
  }, TIMEOUT_MS);
});

it.each([
  "/omp-bash", "/omp-bash   ", "/omp-queue remove", "/omp-queue promote",
  "/omp-queue remove 0", "/omp-queue remove -1", "/omp-queue promote 1.5",
  "/omp-queue remove 9007199254740992", "/omp-queue remove 1 extra",
  "/omp-queue restore extra", "/omp-queue unknown",
])("rejects malformed native control arguments %j before invoking OMP", async (text) => {
  const threadId = "thr_native_command_syntax";
  const providerThreadId = await start(threadId);
  const input = await requestInput(threadId, providerThreadId, text);
  expect(input.response.error).toMatchObject({ message: expect.stringMatching(/Usage:/u) });
  expect(input.response.result).toBeUndefined();
  expect(rootLifecycle(harness.deltasOf(threadId).slice(input.since))).toEqual([]);
  for (const type of ["bash", "abort_bash", "remove_queued_message", "promote_queued_message", "abort_and_restore_queue", "prompt"]) {
    expect(commands(type)).toEqual([]);
  }
}, TIMEOUT_MS);
