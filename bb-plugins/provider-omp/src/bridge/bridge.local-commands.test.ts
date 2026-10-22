import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OMP_TERMINAL_SIGN_IN_HINT } from "../declaration.js";
import { handleLine } from "./bridge.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const objectSchema = z.record(z.string(), z.unknown());
const providerThreadSchema = z.object({ providerThreadId: z.string() });
const toolCloseSchema = z.object({
  kind: z.literal("item.close"),
  status: z.enum(["completed", "failed", "interrupted"]),
  resultText: z.string(),
  item: z.object({ type: z.literal("tool"), tool: z.string() }),
});
const agentMessageCloseSchema = z.object({
  kind: z.literal("item.close"),
  status: z.literal("completed"),
  key: z.object({ providerItemId: z.string() }),
  item: z.object({ type: z.literal("agentMessage"), text: z.string() }),
});
const deltaBatchSchema = z.object({
  threadId: z.string(),
  deltas: z.array(objectSchema),
});
const planCloseSchema = z.object({
  kind: z.literal("item.close"),
  item: z.object({
    type: z.literal("planSteps"),
    steps: z.array(z.object({ step: z.string(), status: z.string() })),
  }),
});
const contextUsageSchema = z.object({
  kind: z.literal("contextWindow"),
  used: z.number().nullable(),
});
const interactionSchema = z.object({
  id: z.string(),
  params: z.object({
    threadId: z.string(),
    payload: z.object({
      kind: z.literal("provider-omp/extension-ui"),
      data: z.object({ method: z.literal("input") }),
    }),
  }),
});

function readJsonLines(path: string): Record<string, unknown>[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
      .map((line) => objectSchema.parse(JSON.parse(line)))
    : [];
}

function toolCloses(deltas: Record<string, unknown>[], name: string) {
  return deltas.flatMap((delta) => {
    const parsed = toolCloseSchema.safeParse(delta);
    return parsed.success && parsed.data.item.tool === name ? [parsed.data] : [];
  });
}

function planSteps(deltas: Record<string, unknown>[]) {
  return deltas.flatMap((delta) => {
    const parsed = planCloseSchema.safeParse(delta);
    return parsed.success ? [parsed.data.item.steps] : [];
  });
}

function assistantText(deltas: Record<string, unknown>[]): string {
  return deltas.filter((delta) =>
    delta.kind === "item.textDelta" && delta.channel === "agentMessage",
  ).map((delta) => String(delta.text)).join("");
}

describe("OMP local commands through the bb bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let rpcLog: string;
  let eventLog: string;
  let nextId = 70_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-local-commands-", initialize: true });
    rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    eventLog = join(harness.workspaceDir, "events.jsonl");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
    vi.stubEnv("FAKE_OMP_EVENT_LOG", eventLog);
  }, 90_000);

  afterEach(async () => {
    await harness.teardown();
  }, 90_000);

  async function start(threadId: string): Promise<string> {
    const response = await harness.startThread(threadId);
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    return providerThreadSchema.parse(response.result).providerThreadId;
  }

  async function submit(
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
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    expect(response.result).toMatchObject({ threadId });
    return { since, clientRequestId };
  }

  async function completedCommand(threadId: string, providerThreadId: string, text: string) {
    const { since, clientRequestId } = await submit(threadId, providerThreadId, text);
    await harness.waitForTurnBoundary(threadId, since);
    const deltas = harness.deltasOf(threadId).slice(since);
    expect(deltas.filter((delta) =>
      delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId,
    )).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    return deltas;
  }

  function contextTokens(threadId: string): Array<number | null> {
    return harness.deltasOf(threadId).flatMap((delta) => {
      const parsed = contextUsageSchema.safeParse(delta);
      return parsed.success ? [parsed.data.used] : [];
    });
  }

  function expectNoMainAgent(threadId: string): void {
    expect(assistantText(harness.deltasOf(threadId))).toBe("");
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_start")).toEqual([]);
  }

  it.each([
    { command: "/help", output: "Native OMP help" },
    { command: "/handoff delayed", output: "Handoff summary" },
  ])("renders idle $command output once, strips ANSI, and completes after the result", async ({ command, output }) => {
    const threadId = "thr_local_native";
    const providerThreadId = await start(threadId);
    const deltas = await completedCommand(threadId, providerThreadId, command);
    const tools = toolCloses(deltas, "omp-command");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: "completed", resultText: expect.stringContaining(output) });
    expect(tools[0]?.resultText).not.toContain("\u001b");
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    const resultIndex = deltas.findIndex((delta) => toolCloses([delta], "omp-command").length > 0);
    const boundaryIndex = deltas.findIndex((delta) => delta.kind === "turn.boundary");
    expect(resultIndex).toBeGreaterThan(deltas.findIndex((delta) => delta.kind === "turn.open"));
    expect(boundaryIndex).toBeGreaterThan(resultIndex);
    expect(boundaryIndex).toBeGreaterThan(deltas.findIndex((delta) => delta.kind === "input.accepted"));
    await harness.waitFor(() => contextTokens(threadId).at(-1) === 23, "local command context usage");
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.boundary")).toHaveLength(1);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([
      expect.objectContaining({ message: command }),
    ]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it.each([false, true])("renders output before local admission failure without an orphan turn (prior async delivery %s)", async (gated) => {
    const threadId = "thr_local_admission_error";
    const gateDirectory = join(harness.workspaceDir, "admission-error-state-gates");
    if (gated) {
      vi.stubEnv("FAKE_OMP_LOCAL_STATE_GATES_DIR", gateDirectory);
      vi.stubEnv("FAKE_OMP_LOCAL_ERROR_PRELUDE", "1");
    }
    const providerThreadId = await start(threadId);
    const since = harness.deltasOf(threadId).length;
    const clientRequestId = "creq_er23456789";
    const responsePromise = harness.request(++nextId, "turn/start", {
      threadId, providerThreadId, clientRequestId,
      input: [{ type: "text", text: "/local-command-error", mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    if (gated) {
      await harness.waitFor(() => existsSync(join(gateDirectory, "requested-23")), "the event preceding command output to block on state");
      const beforeRelease = harness.deltasOf(threadId).slice(since);
      expect(toolCloses(beforeRelease, "omp-command")).toEqual([]);
      expect(beforeRelease.filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
      writeFileSync(join(gateDirectory, "release-23"), "continue", "utf8");
    }
    const response = await responsePromise;
    if (response.error !== undefined) {
      expect(response.error).toMatchObject({ message: expect.stringContaining("local admission failed") });
    } else {
      expect(response.result).toMatchObject({ threadId });
    }
    await harness.waitForTurnBoundary(threadId, since);
    const deltas = harness.deltasOf(threadId).slice(since);
    expect(toolCloses(deltas, "omp-command")).toEqual([
      expect.objectContaining({ resultText: expect.stringContaining("Local command output before failure") }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "failed", error: expect.objectContaining({ message: expect.stringContaining("local admission failed") }) }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId)).toEqual([]);
    expect(deltas.findIndex((delta) => delta.kind === "turn.boundary")).toBeGreaterThan(
      deltas.findIndex((delta) => toolCloses([delta], "omp-command").length > 0),
    );
    if (gated) writeFileSync(join(gateDirectory, "release-46"), "continue", "utf8");
    await completedCommand(threadId, providerThreadId, "/help");
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.open")).toHaveLength(2);
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.boundary")).toHaveLength(2);
    expectNoMainAgent(threadId);
  }, 90_000);

  it("refreshes canonical todos and context usage after native /todo, including after resume", async () => {
    vi.stubEnv("FAKE_OMP_TODO_PHASES", JSON.stringify([{
      name: "Work", tasks: [{ content: "Existing completed task", status: "completed" }],
    }]));
    const threadId = "thr_local_todo";
    const providerThreadId = await start(threadId);
    // A named local-only session is resumable without inventing an assistant message.
    const renamed = await harness.request(++nextId, "thread/name/set", {
      threadId, providerThreadId, title: "Canonical local todo session",
    });
    expect(renamed.error).toBeUndefined();
    const deltas = await completedCommand(threadId, providerThreadId, "/todo append Preserve the canonical task");
    const expectedSteps = [
      { step: "Existing completed task", status: "completed" },
      { step: "Preserve the canonical task", status: "pending" },
    ];
    expect(planSteps(deltas).at(-1)).toEqual(expectedSteps);
    const resultIndex = deltas.findIndex((delta) => toolCloses([delta], "omp-command").length > 0);
    const planIndex = deltas.findLastIndex((delta) => planCloseSchema.safeParse(delta).success);
    expect(planIndex).toBeGreaterThan(resultIndex);
    expect(planIndex).toBeLessThan(deltas.findIndex((delta) => delta.kind === "turn.boundary"));
    await harness.waitFor(() => contextTokens(threadId).at(-1) === 23, "todo command context usage");
    const stopped = await harness.request(++nextId, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    });
    expect(stopped.error).toBeUndefined();
    vi.stubEnv("FAKE_OMP_TODO_PHASES", "[]");
    const resumed = await harness.request(++nextId, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
    const afterResume = await completedCommand(threadId, providerThreadId, "/help");
    expect(planSteps(afterResume).at(-1)).toEqual(expectedSteps);
    expectNoMainAgent(threadId);
  }, 90_000);

  it("waits for both concurrent native todo refreshes before completing their shared local turn", async () => {
    const gateDirectory = join(harness.workspaceDir, "concurrent-todo-state-gates");
    vi.stubEnv("FAKE_OMP_LOCAL_STATE_GATES_DIR", gateDirectory);
    const threadId = "thr_local_concurrent_todos";
    const providerThreadId = await start(threadId);
    const first = await submit(threadId, providerThreadId, "/todo append One");
    await harness.waitFor(() => existsSync(join(gateDirectory, "requested-23")), "the first canonical todo refresh");
    const second = await submit(threadId, providerThreadId, "/todo append Two");
    await harness.waitFor(() => existsSync(join(gateDirectory, "requested-46")), "the second canonical todo refresh");
    expect(harness.deltasOf(threadId).slice(first.since).filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
    writeFileSync(join(gateDirectory, "release-23"), "continue", "utf8");
    await harness.waitForDelta(threadId, (delta) => planSteps([delta]).some((steps) =>
      steps.length === 1 && steps[0]?.step === "One",
    ), first.since);
    const afterFirstRefresh = harness.deltasOf(threadId).slice(first.since);
    expect(planSteps(afterFirstRefresh).at(-1)).toEqual([{ step: "One", status: "pending" }]);
    expect(afterFirstRefresh.filter((delta) => delta.kind === "turn.boundary")).toEqual([]);
    writeFileSync(join(gateDirectory, "release-46"), "continue", "utf8");
    await harness.waitForTurnBoundary(threadId, first.since);
    const deltas = harness.deltasOf(threadId).slice(first.since);
    expect(planSteps(deltas).at(-1)).toEqual([
      { step: "One", status: "pending" },
      { step: "Two", status: "pending" },
    ]);
    expect(toolCloses(deltas, "omp-command")).toHaveLength(2);
    for (const clientRequestId of [first.clientRequestId, second.clientRequestId]) {
      expect(deltas.filter((delta) => delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId)).toHaveLength(1);
    }
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    const boundaryIndex = deltas.findIndex((delta) => delta.kind === "turn.boundary");
    expect(boundaryIndex).toBeGreaterThan(deltas.findLastIndex((delta) => planCloseSchema.safeParse(delta).success));
    expect(boundaryIndex).toBeGreaterThan(deltas.findLastIndex((delta) => toolCloses([delta], "omp-command").length > 0));
    expectNoMainAgent(threadId);
  }, 90_000);

  it.each([
    { command: "/help", method: "turn/start" as const },
    { command: "/todo append Do not finish the main run", method: "turn/start" as const },
  ])("keeps /hold active while $method runs $command and accepts the following steer", async ({ command, method }) => {
    const threadId = "thr_local_during_hold";
    const providerThreadId = await start(threadId);
    await submit(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
    const { since, clientRequestId } = await submit(threadId, providerThreadId, command, method);
    await harness.waitForDelta(threadId, (delta) =>
      delta.kind === "input.accepted" && delta.clientRequestId === clientRequestId, since,
    );
    await harness.waitFor(() => contextTokens(threadId).at(-1) === 23, "active local command completion");
    const localDeltas = harness.deltasOf(threadId).slice(since);
    expect(toolCloses(localDeltas, "omp-command")).toHaveLength(1);
    expect(localDeltas.filter((delta) => delta.kind === "turn.boundary" || delta.kind === "turn.open")).toEqual([]);
    if (command.startsWith("/todo")) {
      expect(planSteps(localDeltas).at(-1)).toEqual([
        { step: "Do not finish the main run", status: "pending" },
      ]);
    }
    const steered = await submit(threadId, providerThreadId, "continue the original run", "turn/steer");
    await harness.waitForTurnBoundary(threadId, steered.since);
    const allDeltas = harness.deltasOf(threadId);
    expect(allDeltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(allDeltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(assistantText(allDeltas)).toContain("Steered: continue the original run");
    expect(readJsonLines(rpcLog).filter((command) => command.type === "steer")).toEqual([
      expect.objectContaining({ message: "continue the original run" }),
    ]);
    expect(harness.messages.filter((message) => message.method === "error")).toEqual([]);
  }, 90_000);

  it("runs bridge-owned /btw through steer without settling the active main turn", async () => {
    const threadId = "thr_local_btw_during_hold";
    const providerThreadId = await start(threadId);
    await submit(threadId, providerThreadId, "/hold");
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
    const { since, clientRequestId } = await submit(threadId, providerThreadId, "/btw Side question while working", "turn/steer");
    await harness.waitForDelta(threadId, (delta) => toolCloses([delta], "btw").some((tool) =>
      tool.status === "completed",
    ), since);
    const sideDeltas = harness.deltasOf(threadId).slice(since);
    expect(sideDeltas).toContainEqual(expect.objectContaining({ kind: "input.accepted", clientRequestId }));
    expect(sideDeltas.filter((delta) =>
      (delta.kind === "turn.boundary" || delta.kind === "turn.open") && !delta.providerTurnId,
    )).toEqual([]);
    expect(assistantText(sideDeltas)).toBe("");
    const steered = await submit(threadId, providerThreadId, "finish after answering BTW", "turn/steer");
    await harness.waitForTurnBoundary(threadId, steered.since);
    const allDeltas = harness.deltasOf(threadId);
    expect(allDeltas.filter((delta) => delta.kind === "turn.open" && !delta.providerTurnId)).toHaveLength(1);
    expect(allDeltas.filter((delta) => delta.kind === "turn.boundary" && !delta.providerTurnId)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(assistantText(allDeltas)).toContain("Steered: finish after answering BTW");
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([
      expect.objectContaining({ message: "/hold" }),
    ]);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "steer")).toEqual([
      expect.objectContaining({ message: "finish after answering BTW" }),
    ]);
  }, 90_000);

  it("streams BTW deltas into an open side card, settles admission promptly, and replaces streamed text with the terminal record", async () => {
    const releaseFile = join(harness.workspaceDir, "release-btw");
    vi.stubEnv("FAKE_OMP_BTW_RELEASE_FILE", releaseFile);
    vi.stubEnv("FAKE_OMP_BTW_DELTAS", JSON.stringify(["Partial ", "BTW streamed answer."]));
    const threadId = "thr_local_btw";
    const providerThreadId = await start(threadId);
    const question = "Where should the side answer appear?";
    const { since, clientRequestId } = await submit(threadId, providerThreadId, `/btw ${question}`);
    await harness.waitFor(() => readJsonLines(eventLog).some((event) => event.type === "btw_delta"), "initial BTW delta");
    // A second RPC round trip drains the initial record/delta while the terminal record is gated.
    const renamed = await harness.request(++nextId, "thread/name/set", {
      threadId, providerThreadId, title: "BTW delivery barrier",
    });
    expect(renamed.error).toBeUndefined();
    const pending = harness.deltasOf(threadId).slice(since);
    expect(pending.filter((delta) => delta.kind === "turn.open" && !delta.parentRef)).toHaveLength(1);
    expect(pending.filter((delta) => delta.kind === "turn.boundary" && !delta.providerTurnId)).toHaveLength(1);
    expect(pending.filter((delta) => delta.kind === "turn.boundary" && delta.providerTurnId)).toEqual([]);
    const opens = pending.filter((delta) => delta.kind === "item.open" && objectSchema.parse(delta.item).type === "backgroundTask");
    expect(opens).toHaveLength(1);
    expect(objectSchema.parse(opens[0]?.item)).toMatchObject({ status: "pending", taskStatus: "running" });
    const progress = pending.filter((delta) => delta.kind === "item.progress");
    expect(progress.map((delta) => objectSchema.parse(delta.snapshot).summary)).toEqual(["Partial ", "Partial BTW streamed answer."]);
    expect(progress.map((delta) => delta.key)).toEqual([opens[0]?.key, opens[0]?.key]);
    expect(toolCloses(pending, "btw")).toEqual([]);
    writeFileSync(releaseFile, "continue", "utf8");
    await harness.waitForDelta(threadId, (delta) => toolCloses([delta], "btw").length > 0, since);
    const deltas = harness.deltasOf(threadId).slice(since);
    expect(toolCloses(deltas, "btw")).toEqual([
      expect.objectContaining({ status: "completed", resultText: expect.stringContaining(`Side answer: ${question}`) }),
    ]);
    expect(toolCloses(deltas, "btw")[0]?.resultText).toContain(question);
    expect(toolCloses(deltas, "btw")[0]?.resultText).not.toContain("Partial BTW streamed answer.");
    const closed = deltas.find((delta) => toolCloses([delta], "btw").length > 0);
    const childTurn = pending.find((delta) => delta.kind === "turn.open" && delta.providerTurnId);
    expect(closed?.providerTurnId).toEqual(childTurn?.providerTurnId);
    expect(objectSchema.parse(closed?.key).parentRef).toEqual(childTurn?.parentRef);
    const finalTask = deltas.find((delta) => delta.kind === "item.close" && objectSchema.parse(delta.item).type === "backgroundTask");
    expect(finalTask?.key).toEqual(opens[0]?.key);
    expect(objectSchema.parse(finalTask?.item)).toMatchObject({
      status: "completed", summary: expect.stringContaining(`Side answer: ${question}`),
    });
    expect(objectSchema.parse(finalTask?.item).summary).not.toContain("Partial BTW streamed answer.");
    expect(deltas.filter((delta) => delta.kind === "turn.open" && !delta.parentRef)).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary" && !delta.providerTurnId)).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.open" && delta.providerTurnId)).toEqual([
      expect.objectContaining({ parentRef: expect.any(String) }),
    ]);
    expect(deltas).toContainEqual(expect.objectContaining({ kind: "input.accepted", clientRequestId }));
    expect(readJsonLines(rpcLog).filter((command) => command.type === "btw")).toEqual([
      expect.objectContaining({ question }),
    ]);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it.each([
    { marker: "error", status: "failed" },
    { marker: "cancelled", status: "interrupted" },
    { marker: "interrupted", status: "interrupted" },
  ])("renders a terminal $marker BTW result instead of losing the side command", async ({ marker, status }) => {
    const threadId = "thr_local_btw_terminal";
    const providerThreadId = await start(threadId);
    const question = `[${marker}] Explain the side failure`;
    const { since } = await submit(threadId, providerThreadId, `/btw ${question}`);
    await harness.waitForDelta(threadId, (delta) => toolCloses([delta], "btw").length > 0, since);
    const tools = toolCloses(harness.deltasOf(threadId).slice(since), "btw");
    expect(tools).toEqual([
      expect.objectContaining({ status, resultText: expect.stringContaining(question) }),
    ]);
    if (marker === "error") expect(tools[0]?.resultText).toContain("scripted BTW failure");
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it("lists provider availability and authentication for /login and /logout without invoking the agent", async () => {
    const threadId = "thr_local_auth_lists";
    const providerThreadId = await start(threadId);
    for (const name of ["login", "logout"]) {
      const deltas = await completedCommand(threadId, providerThreadId, `/${name}`);
      const tools = toolCloses(deltas, name);
      expect(tools).toHaveLength(1);
      const text = tools[0]!.resultText;
      expect(text).toContain("oauth-test");
      expect(text).toContain("account-test");
      expect(text).toContain("secret-test");
      expect(text).toMatch(/availab/iu);
      expect(text).toMatch(/authenticat/iu);
    }
    expect(readJsonLines(rpcLog).filter((command) => command.type === "get_login_providers")).toHaveLength(2);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "login" || command.type === "logout" || command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it.each([
    { answer: "authorization-code", status: "completed" },
    { answer: "deny", status: "failed" },
  ])("returns /login before OAuth is answered, forwards its URL/input, and later renders $status", async ({ answer, status }) => {
    const uiLog = join(harness.workspaceDir, "ui.jsonl");
    vi.stubEnv("FAKE_OMP_UI_LOG", uiLog);
    const threadId = "thr_local_oauth";
    const providerThreadId = await start(threadId);
    const { since } = await submit(threadId, providerThreadId, "/login oauth-test");
    const interactionMessage = await harness.waitForMessage((message) =>
      message.method === "interaction/request" && interactionSchema.safeParse(message).success &&
      interactionSchema.parse(message).params.threadId === threadId,
    "the pending OAuth input");
    const interaction = interactionSchema.parse(interactionMessage);
    const url = "https://login.example.test/authorize?provider=oauth-test";
    await harness.waitForDelta(threadId, (delta) => JSON.stringify(delta).includes(url), since);
    expect(readJsonLines(uiLog)).toEqual([]);
    // submit has already received its turn response, even though native login is still waiting here.
    const beforeAnswer = harness.deltasOf(threadId).length;
    handleLine(JSON.stringify({ jsonrpc: "2.0", id: interaction.id, result: { kind: "request_answer", value: answer } }));
    await harness.waitForDelta(threadId, (delta) => toolCloses([delta], "login").some((tool) =>
      tool.status === status,
    ), beforeAnswer);
    expect(readJsonLines(uiLog)).toContainEqual(expect.objectContaining({ type: "extension_ui_response", value: answer }));
    const outcome = toolCloses(harness.deltasOf(threadId).slice(beforeAnswer), "login").find((tool) => tool.status === status);
    if (status === "completed") {
      expect(outcome?.resultText).toContain("oauth-test");
      const list = await completedCommand(threadId, providerThreadId, "/logout oauth-test");
      expect(toolCloses(list, "logout")[0]?.resultText).toContain("Signed-in account");
    } else {
      expect(outcome?.resultText).toContain("scripted OAuth login rejected");
    }
    expect(readJsonLines(rpcLog).filter((command) => command.type === "login")).toEqual([
      expect.objectContaining({ providerId: "oauth-test" }),
    ]);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it.each(["secret-test", "oauth-error"])("shows terminal sign-in fallback after %s refuses RPC login", async (provider) => {
    const threadId = "thr_local_login_fallback";
    const providerThreadId = await start(threadId);
    const { since } = await submit(threadId, providerThreadId, `/login ${provider}`);
    await harness.waitForDelta(threadId, (delta) => toolCloses([delta], "login").some((tool) => tool.status === "failed"), since);
    const failed = toolCloses(harness.deltasOf(threadId).slice(since), "login").find((tool) => tool.status === "failed");
    expect(failed?.resultText).toContain(OMP_TERMINAL_SIGN_IN_HINT);
    expect(failed?.resultText).toContain(provider === "secret-test" ? "not supported in RPC mode" : "scripted OAuth setup failed");
    expect(harness.messages.some((message) => message.method === "interaction/request")).toBe(false);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it("lists logout credential IDs without choosing an account, then logs out only the explicit integer ID", async () => {
    const threadId = "thr_local_logout";
    const providerThreadId = await start(threadId);
    const listed = await completedCommand(threadId, providerThreadId, "/logout account-test");
    const listText = toolCloses(listed, "logout")[0]!.resultText;
    expect(listText).toContain("Primary account");
    expect(listText).toContain("Backup account");
    expect(listText).toMatch(/\b7\b/u);
    expect(listText).toMatch(/\b11\b/u);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "logout")).toEqual([]);
    const removed = await completedCommand(threadId, providerThreadId, "/logout account-test 11");
    expect(toolCloses(removed, "logout")[0]?.resultText).toContain("Primary account");
    expect(readJsonLines(rpcLog).filter((command) => command.type === "logout")).toEqual([
      expect.objectContaining({ providerId: "account-test", credentialId: 11 }),
    ]);
    const remaining = await completedCommand(threadId, providerThreadId, "/logout account-test");
    const remainingText = toolCloses(remaining, "logout")[0]!.resultText;
    expect(remainingText).toContain("Primary account");
    expect(remainingText).not.toContain("Backup account");
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);

  it.each([undefined, "exports/session proof.html"])("exports HTML with an absolute written path and a completed clickable message (output %j)", async (outputPath) => {
    const threadId = "thr_local_export";
    const providerThreadId = await start(threadId);
    const workspacePath = realpathSync(harness.workspaceDir);
    const command = outputPath === undefined ? "/export-html" : `/export-html ${outputPath}`;
    const deltas = await completedCommand(threadId, providerThreadId, command);
    const tool = toolCloses(deltas, "export-html")[0];
    const expectedPath = resolve(workspacePath, outputPath ?? "fake-omp-export.html");
    expect(isAbsolute(expectedPath)).toBe(true);
    expect(tool).toMatchObject({ status: "completed" });
    expect(decodeURIComponent(tool!.resultText)).toContain(expectedPath);
    expect(readFileSync(expectedPath, "utf8")).toContain("OMP session export");
    const links = deltas.flatMap((delta) => {
      const parsed = agentMessageCloseSchema.safeParse(delta);
      return parsed.success ? [parsed.data] : [];
    });
    expect(links).toHaveLength(1);
    const link = links[0]!;
    const target = /\[[^\]]+\]\(<?(file:\/\/[^)>]+)>?\)/u.exec(link.item.text)?.[1];
    expect(target).toBe(pathToFileURL(expectedPath).href);
    const resultBatch = harness.messages.filter((message) => message.method === "thread/delta")
      .map((message) => deltaBatchSchema.parse(message.params))
      .find((batch) => batch.threadId === threadId && toolCloses(batch.deltas, "export-html").length > 0);
    expect(resultBatch?.deltas.some((delta) => agentMessageCloseSchema.safeParse(delta).success)).toBe(true);
    const toolDelta = resultBatch?.deltas.find((delta) => toolCloses([delta], "export-html").length > 0);
    expect(link.key.providerItemId).not.toBe(z.object({ providerItemId: z.string() }).parse(toolDelta?.key).providerItemId);
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "item.textDelta" && delta.channel === "agentMessage")).toEqual([]);
    const exports = readJsonLines(rpcLog).filter((command) => command.type === "export_html");
    expect(exports).toHaveLength(1);
    if (outputPath === undefined) expect(exports[0]).not.toHaveProperty("outputPath");
    else expect(resolve(workspacePath, z.string().parse(exports[0]?.outputPath))).toBe(expectedPath);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([]);
    expectNoMainAgent(threadId);
  }, 90_000);
});
