import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  experimental_closeAllForTests,
  experimental_scratchDirForTests,
} from "./bridge.js";
import {
  findNewestOmpSessionFile,
  resolveOmpThreadSessionDir,
} from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-lifecycle-",
    initialize: true,
    processLog: true,
  });
}, 90_000);

afterEach(async () => {
  await harness.teardown();
}, 90_000);

let nextId = 1000;
const identityParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
});
const providerThreadSchema = z.object({ providerThreadId: z.string() });
const sessionRecordSchema = z.record(z.string(), z.unknown());
const rpcCommandSchema = z.object({
  type: z.string(),
  tools: z.array(z.object({ name: z.string() })).optional(),
});

function resultProviderThreadId(result: unknown): string {
  return providerThreadSchema.parse(result).providerThreadId;
}

function providerThreadIdFor(threadId: string): string {
  const identity = [...harness.messages]
    .reverse()
    .find(
      (message) =>
        message.method === "thread/identity" &&
        identityParamsSchema.parse(message.params).threadId === threadId,
    );
  return resultProviderThreadId(identity?.params);
}

function sessionFileFor(providerThreadId: string): string {
  const directory = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: providerThreadId,
  });
  const resumed = findNewestOmpSessionFile(directory);
  if (resumed !== undefined) return resumed;
  const files = readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return join(directory, files[0]!);
}

function sessionRecords(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => sessionRecordSchema.parse(JSON.parse(line)));
}

async function expectEveryChildGone(expectedSpawns: number): Promise<void> {
  await harness.waitFor(() => {
    const log = harness.readProcessLog();
    return (
      log.spawned.length >= expectedSpawns &&
      log.spawned.every((pid) => log.exited.includes(pid)) &&
      harness.runningChildPids().length === 0
    );
  }, "all OMP children to exit");
  expect(harness.readProcessLog().spawned).toHaveLength(expectedSpawns);
}

async function startThread(threadId: string): Promise<string> {
  const response = await harness.startThread(threadId, {
    dynamicTools: [
      {
        name: "bb_probe",
        description: "A bb tool.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
  });
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  const providerThreadId = resultProviderThreadId(response.result);
  expect(providerThreadId).toMatch(/^omp_/u);
  expect(response.result).toMatchObject({ providerThreadId });
  return providerThreadId;
}

it("stop{release} ends the child after a local-file-only turn", async () => {
  const threadId = "thr_lc_release";
  const filePath = join(harness.workspaceDir, "notes.md");
  const providerThreadId = await startThread(threadId);
  const turn = await harness.request((nextId += 1), "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_ab23456789",
    input: [{
      type: "localFile",
      path: filePath,
      name: "notes.md",
      sizeBytes: 6,
      mimeType: "text/markdown",
    }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(turn.result).toEqual({ threadId });
  await harness.waitForTurnBoundary(threadId, 0);
  expect(harness.deltasOf(threadId)).toContainEqual(
    expect.objectContaining({
      kind: "item.textDelta",
      text: expect.stringContaining(`[Attached file "notes.md": ${filePath}]`),
    }),
  );
  const stop = await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  expect(stop.result).toMatchObject({
    ok: true,
    providerCheckpointId: expect.any(String),
  });
  await expectEveryChildGone(1);
}, 90_000);

it("stop{interrupt} settles the turn while keeping the same child available", async () => {
  const threadId = "thr_lc_interrupt";
  const providerThreadId = await startThread(threadId);
  const pids = harness.readProcessLog().spawned;
  await harness.request((nextId += 1), "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_cd23456789",
    input: [{ type: "text", text: "/hold", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
  const stop = await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId,
    intent: "interrupt",
    activeTurnId: "turn-1",
  });
  expect(stop.result).toMatchObject({ ok: true });
  const seen = await harness.waitForTurnBoundary(threadId, 0);
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "interrupted" }),
  ]);
  expect(harness.deltasOf(threadId).some((delta) => delta.kind === "session.ended")).toBe(false);
  expect(harness.runningChildPids()).toEqual(pids);
  expect(harness.readProcessLog().spawned).toEqual(pids);
  const next = await harness.request((nextId += 1), "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_ef23456789",
    input: [{ type: "text", text: "continue after interruption", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(next.result).toEqual({ threadId });
  await harness.waitForTurnBoundary(threadId, seen);
  expect(harness.readProcessLog().spawned).toEqual(pids);
  await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(1);
}, 90_000);

it("discard ends the child and removes the complete per-thread directory", async () => {
  const threadId = "thr_lc_discard";
  const providerThreadId = await startThread(threadId);
  const directory = resolveOmpThreadSessionDir({ env: process.env, threadId: providerThreadId });
  const artifacts = join(directory, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "output.txt"), "session-owned output");
  const discard = await harness.request((nextId += 1), "thread/discard", {
    threadId,
    providerThreadId,
  });
  expect(discard.result).toEqual({ ok: true });
  expect(existsSync(directory)).toBe(false);
  await expectEveryChildGone(1);
}, 90_000);

it("the native fork helper exits after copying history into the new thread directory", async () => {
  const sourceDir = resolveOmpThreadSessionDir({ env: process.env, threadId: "thr_lc_src" });
  mkdirSync(sourceDir, { recursive: true });
  const sourceFile = join(sourceDir, "2026-01-01T00-00-00_source.jsonl");
  const sourceBefore = [
    { type: "title", title: "Source history" },
    { type: "session", version: 3, id: "source", cwd: harness.workspaceDir, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "user1", parentId: null, message: { role: "user", content: "first", timestamp: 1 } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(sourceFile, sourceBefore);
  const forkResponse = await harness.request((nextId += 1), "thread/fork", {
    threadId: "thr_lc_fork",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: "thr_lc_src",
    options: FULL_PERMISSION_OPTIONS,
    instructionMode: "append",
  });
  expect(forkResponse.error).toBeUndefined();
  expect(forkResponse.result).toMatchObject({ providerThreadId: "thr_lc_fork" });
  expect(readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
  expect(readFileSync(sessionFileFor("thr_lc_fork"), "utf8")).toContain('"content":"first"');
  await harness.waitFor(() => harness.readProcessLog().exited.length === 1, "the fork helper to exit");
  expect(harness.runningChildPids()).toHaveLength(1);
  await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_fork",
    providerThreadId: "thr_lc_fork",
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(2);
}, 90_000);

function scratchFiles(): string[] {
  return readdirSync(experimental_scratchDirForTests()).sort();
}

async function expectScratchFilesGone(): Promise<void> {
  await harness.waitFor(() => scratchFiles().length === 0, "session scratch files to be removed");
}

it("start after release allocates a fresh thread directory and leaves previous history unchanged", async () => {
  const threadId = "thr_lc_start_fresh";
  const first = await harness.startThread(threadId);
  const oldProviderThreadId = resultProviderThreadId(first.result);
  const oldSessionFile = sessionFileFor(oldProviderThreadId);
  const released = await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId: oldProviderThreadId,
    intent: "release",
    activeTurnId: null,
  });
  expect(released.result).toMatchObject({ ok: true });
  await expectEveryChildGone(1);
  await expectScratchFilesGone();
  appendFileSync(oldSessionFile, JSON.stringify({
    type: "message",
    id: "sentinel-user",
    parentId: null,
    message: { role: "user", content: "previous session sentinel", timestamp: 3 },
  }) + "\n");
  const oldBytes = readFileSync(oldSessionFile, "utf8");
  const second = await harness.startThread(threadId, {
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "fresh instructions" },
  });
  const newProviderThreadId = resultProviderThreadId(second.result);
  expect(newProviderThreadId).not.toBe(oldProviderThreadId);
  expect(oldProviderThreadId).toMatch(/^omp_[0-9a-f-]{36}$/u);
  expect(newProviderThreadId).toMatch(/^omp_[0-9a-f-]{36}$/u);
  expect(readFileSync(oldSessionFile, "utf8")).toBe(oldBytes);
  const freshSessionFile = sessionFileFor(newProviderThreadId);
  expect(freshSessionFile).not.toBe(oldSessionFile);
  expect(sessionRecords(freshSessionFile).filter((record) => record.type === "message")).toEqual([]);
  const identities = harness.messages
    .filter((message) => message.method === "thread/identity")
    .map((message) => identityParamsSchema.parse(message.params))
    .filter((params) => params.threadId === threadId);
  expect(identities.map((params) => params.providerThreadId)).toEqual([
    oldProviderThreadId,
    newProviderThreadId,
  ]);
  await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId: newProviderThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(2);
  await expectScratchFilesGone();
}, 90_000);

it("release and resume preserve native history while replacing prompts and host tools", async () => {
  const threadId = "thr_lc_facet_switch";
  const rpcLog = join(harness.workspaceDir, "rpc.jsonl");
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
  const oldInstructions = "planner instructions: only plan the work";
  const newInstructions = "orchestrator instructions: implement the approved plan";
  const oldTool = { name: "planner_only_tool", description: "Planner tool.", inputSchema: { type: "object" } };
  const newTool = { name: "orchestrator_only_tool", description: "Orchestrator tool.", inputSchema: { type: "object" } };
  const started = await harness.startThread(threadId, {
    options: { ...FULL_PERMISSION_OPTIONS, instructions: oldInstructions },
    dynamicTools: [oldTool],
  });
  const providerThreadId = resultProviderThreadId(started.result);
  const sessionFile = sessionFileFor(providerThreadId);
  const initialHeader = sessionRecords(sessionFile).find((record) => record.type === "session");
  const initialFiles = scratchFiles();
  expect(initialFiles).toEqual([
    expect.stringMatching(/^omp-append-.*\.md$/u),
    expect.stringMatching(/^omp-config-.*\.yml$/u),
  ]);
  expect(readFileSync(join(experimental_scratchDirForTests(), initialFiles[0]!), "utf8")).toContain(oldInstructions);
  const turn = await harness.request((nextId += 1), "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_facet23456",
    input: [{ type: "text", text: "plan this change", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(turn.error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(1);
  await expectScratchFilesGone();
  const sentinel = "facet switch persisted sentinel";
  appendFileSync(sessionFile, JSON.stringify({
    type: "message",
    id: "facet-sentinel",
    parentId: sessionRecords(sessionFile).at(-1)?.id ?? null,
    message: { role: "user", content: sentinel, timestamp: 10 },
  }) + "\n");
  const resumed = await harness.request((nextId += 1), "thread/resume", {
    threadId,
    providerThreadId,
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, instructions: newInstructions },
    dynamicTools: [newTool],
  });
  expect(resumed.error).toBeUndefined();
  expect(resumed.result).toMatchObject({ providerThreadId });
  expect(sessionFileFor(providerThreadId)).toBe(sessionFile);
  expect(sessionRecords(sessionFile).find((record) => record.type === "session")).toEqual(initialHeader);
  expect(readFileSync(sessionFile, "utf8")).toContain(sentinel);
  const resumedFiles = scratchFiles();
  expect(resumedFiles).toEqual([
    expect.stringMatching(/^omp-append-.*\.md$/u),
    expect.stringMatching(/^omp-config-.*\.yml$/u),
  ]);
  const resumedPrompt = readFileSync(join(experimental_scratchDirForTests(), resumedFiles[0]!), "utf8");
  expect(resumedPrompt).toContain(newInstructions);
  expect(resumedPrompt).not.toContain(oldInstructions);
  const registrations = readFileSync(rpcLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => rpcCommandSchema.parse(JSON.parse(line)))
    .filter((command) => command.type === "set_host_tools");
  expect(registrations[0]?.tools?.map((tool) => tool.name)).toContain(oldTool.name);
  expect(registrations.at(-1)?.tools?.map((tool) => tool.name)).toContain(newTool.name);
  expect(registrations.at(-1)?.tools?.map((tool) => tool.name)).not.toContain(oldTool.name);
  const seen = harness.deltasOf(threadId).length;
  const resumedTurn = await harness.request((nextId += 1), "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_facet34567",
    input: [{ type: "text", text: "implement the change", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(resumedTurn.error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(2);
  await expectScratchFilesGone();
}, 90_000);

it("resumes the newest nonempty native session rather than a newer empty draft", async () => {
  const threadId = "thr_lc_native_resume";
  const providerThreadId = "omp_existing_history";
  const directory = resolveOmpThreadSessionDir({ env: process.env, threadId: providerThreadId });
  mkdirSync(directory, { recursive: true });
  const sourceFile = join(directory, "2026-01-01T00-00-00_history.jsonl");
  const before = [
    { type: "title", title: "Existing history" },
    { type: "session", version: 3, id: "history", cwd: harness.workspaceDir, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "user1", parentId: null, message: { role: "user", content: "native resume sentinel", timestamp: 1 } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(sourceFile, before);
  writeFileSync(join(directory, "2026-01-02T00-00-00_draft.jsonl"), [
    { type: "title", title: "" },
    { type: "session", version: 3, id: "draft", cwd: harness.workspaceDir, timestamp: "2026-01-02T00:00:00.000Z" },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const resumed = await harness.request((nextId += 1), "thread/resume", {
    threadId,
    providerThreadId,
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(resumed.error).toBeUndefined();
  expect(resumed.result).toMatchObject({ providerThreadId });
  expect(sessionFileFor(providerThreadId)).toBe(sourceFile);
  expect(readFileSync(sourceFile, "utf8")).toBe(before);
  await harness.request((nextId += 1), "thread/stop", {
    threadId,
    providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(1);
}, 90_000);

it.each([
  { toolName: undefined, instructions: "BB append instructions", hasGuidance: false },
  { toolName: "herd_stop", instructions: "BB append instructions", hasGuidance: false },
  { toolName: "herd_spawn", instructions: "BB append instructions", hasGuidance: true },
  { toolName: "herd_spawn", instructions: undefined, hasGuidance: true },
  { toolName: undefined, instructions: undefined, hasGuidance: false },
])("adds delegation guidance only with herd_spawn ($toolName, $instructions)", async ({
  toolName, instructions, hasGuidance,
}) => {
  const started = await harness.startThread("thr_delegation_guidance", {
    options: { ...FULL_PERMISSION_OPTIONS, ...(instructions ? { instructions } : {}) },
    ...(toolName ? {
      dynamicTools: [{ name: toolName, description: "A herd tool.", inputSchema: { type: "object" } }],
    } : {}),
  });
  expect(started.error).toBeUndefined();
  const promptFile = scratchFiles().find((file) => file.startsWith("omp-append-"));
  const prompt = promptFile
    ? readFileSync(join(experimental_scratchDirForTests(), promptFile), "utf8")
    : undefined;
  if (hasGuidance) {
    expect(prompt).toContain("## OMP subagents and BB threads");
    expect(prompt).toContain("Use omp's `task` subagents for work that serves the current turn");
    expect(prompt).toContain("private to this session, cheaper and faster, get role-based models");
    expect(prompt).toContain("Use `herd_spawn` only when the work should be its own bb thread");
    expect(prompt).toContain("Default to `task` when unsure.");
    if (instructions) expect(prompt?.startsWith(`${instructions}\n\n`)).toBe(true);
  } else {
    expect(prompt).toBe(instructions);
  }
}, 90_000);

it("prompt scratch files are removed after release and failed construction without generated tool files", async () => {
  await harness.startThread("thr_lc_scratch", {
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "be brief" },
    dynamicTools: [{ name: "bb_probe", description: "A bb tool.", inputSchema: { type: "object" } }],
  });
  expect(scratchFiles()).toEqual([
    expect.stringMatching(/^omp-append-.*\.md$/u),
    expect.stringMatching(/^omp-config-.*\.yml$/u),
  ]);
  await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_scratch",
    providerThreadId: providerThreadIdFor("thr_lc_scratch"),
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(1);
  await expectScratchFilesGone();
  vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", "1");
  const failed = await harness.request((nextId += 1), "thread/start", {
    threadId: "thr_lc_scratch_failed",
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "be brief" },
  });
  expect(failed.error).toMatchObject({
    message: expect.stringMatching(/omp (?:exited|RPC stdout ended unexpectedly)/u),
  });
  await expectEveryChildGone(2);
  await expectScratchFilesGone();
}, 60_000);

it("closing the catalog waits for its child to exit", async () => {
  const models = await harness.request((nextId += 1), "model/list", { cwd: harness.workspaceDir });
  expect(models.result).toMatchObject({ models: expect.any(Array) });
  await experimental_closeAllForTests();
  const log = harness.readProcessLog();
  expect(log.spawned).toHaveLength(1);
  expect(log.exited).toContain(log.spawned[0]);
  expect(harness.runningChildPids()).toEqual([]);
}, 90_000);

it("release escalates to SIGKILL for a child that ignores EOF and SIGTERM", async () => {
  vi.stubEnv("FAKE_OMP_HANG_ON_CLOSE", "1");
  await startThread("thr_lc_kill");
  const pid = harness.readProcessLog().spawned[0]!;
  const stop = await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_kill",
    providerThreadId: providerThreadIdFor("thr_lc_kill"),
    intent: "release",
    activeTurnId: null,
  });
  expect(stop.result).toMatchObject({ ok: true });
  await harness.waitFor(
    () => !harness.runningChildPids().includes(pid),
    "the uncooperative OMP child to be killed",
  );
  expect(harness.runningChildPids()).not.toContain(pid);
}, 90_000);

it("publishes native dialog cancellation as extension state without answering the notification", async () => {
  const threadId = "thr_lc_native_ui_cancel";
  const uiLog = join(harness.workspaceDir, "ui-responses.jsonl");
  vi.stubEnv("FAKE_OMP_UI_LOG", uiLog);
  vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify({
    method: "input",
    title: "Native startup dialog",
  }));
  const started = await harness.startThread(threadId);
  expect(started.error).toBeUndefined();
  const providerThreadId = resultProviderThreadId(started.result);
  const interaction = await harness.waitForMessage(
    (message) => message.method === "interaction/request",
    "the native OMP dialog",
  );
  const dialog = z.object({
    threadId: z.string(),
    payload: z.object({
      kind: z.literal("provider-omp/extension-ui"),
      data: z.object({ requestId: z.string() }),
    }),
  }).parse(interaction.params);
  expect(dialog.threadId).toBe(threadId);
  const interactionId = z.string().parse(interaction.id);
  expect(interactionId).toMatch(/^omp-ui-\d+$/u);
  expect(dialog.payload.data.requestId).toBe(interactionId);
  const turn = await harness.request((nextId += 1), "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_gh23456789",
    input: [{
      type: "text",
      text: '/ui {"method":"cancel","targetId":"startup-ui"}',
      mentions: [],
    }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(turn.error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  const states = harness.deltasOf(threadId)
    .filter((delta) =>
      delta.kind === "extension.state" &&
      delta.extensionKind === "provider-omp/extension-ui-state",
    )
    .map((delta) => z.object({
      payload: z.object({
        coordinatorId: z.string().min(1),
        issuedThrough: z.number().int().nonnegative(),
        pendingRequestIds: z.array(z.string()),
      }),
    }).parse(delta).payload);
  expect(states.map((state) => state.pendingRequestIds)).toContainEqual([interactionId]);
  expect(states.at(-1)?.pendingRequestIds).toEqual([]);
  expect(existsSync(uiLog)).toBe(false);
}, 90_000);
