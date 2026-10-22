import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { getOmpArtifactsDir } from "./local-storage.js";
import { resolveOmpThreadSessionDir } from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness;
let nextId: number;
const providerThreadSchema = z.object({ providerThreadId: z.string() });

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-bridge-local-storage-",
    initialize: true,
  });
  nextId = 1;
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function sessionFiles(providerThreadId: string): string[] {
  const directory = resolveOmpThreadSessionDir({ env: process.env, threadId: providerThreadId });
  return readdirSync(directory).filter((name) => name.endsWith(".jsonl")).map((name) => join(directory, name));
}

async function startThread(threadId: string) {
  const storage = join(harness.workspaceDir, "thread-storage", threadId);
  const response = await harness.startThread(threadId, {
    options: { ...FULL_PERMISSION_OPTIONS, envVars: { BB_THREAD_STORAGE: storage } },
  });
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  const { providerThreadId } = providerThreadSchema.parse(response.result);
  return { providerThreadId, storage };
}

async function prompt(threadId: string, providerThreadId: string, text: string): Promise<void> {
  const since = harness.deltasOf(threadId).length;
  const response = await harness.request(nextId++, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: "creq_ab23456789",
    input: [{ type: "text", text, mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, since);
}

it("links fresh sessions before their first prompt and passes the real local root to chat", async () => {
  const threadId = "thr_fresh_storage";
  const { providerThreadId, storage } = await startThread(threadId);
  const files = sessionFiles(providerThreadId);
  expect(files).toHaveLength(1);
  const local = join(getOmpArtifactsDir(files[0]!), "local");
  expect(lstatSync(local).isSymbolicLink()).toBe(true);
  writeFileSync(join(local, "x.md"), "real thread file\n");
  const realFile = join(storage, "local", "x.md");
  expect(lstatSync(realFile).isFile()).toBe(true);
  expect(readFileSync(realFile, "utf8")).toBe("real thread file\n");

  await prompt(threadId, providerThreadId, "See local://x.md");
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "item.textClose",
    text: expect.stringContaining(realFile),
  }));
}, 30_000);

it("does not link a thread without a per-thread BB_THREAD_STORAGE override", async () => {
  const response = await harness.startThread("thr_no_storage");
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  const { providerThreadId } = providerThreadSchema.parse(response.result);
  const files = sessionFiles(providerThreadId);
  expect(files).toHaveLength(1);
  expect(existsSync(join(getOmpArtifactsDir(files[0]!), "local"))).toBe(false);
}, 30_000);

it("relinks native new, fork, and resumed session files to the same thread storage", async () => {
  const threadId = "thr_session_changes";
  const { providerThreadId, storage } = await startThread(threadId);
  const original = sessionFiles(providerThreadId)[0]!;
  writeFileSync(join(getOmpArtifactsDir(original), "local", "kept.md"), "available in every session");

  await prompt(threadId, providerThreadId, "/new");
  const second = sessionFiles(providerThreadId).find((file) => file !== original);
  expect(second).toBeDefined();
  if (!second) throw new Error("The native command did not create a new session");
  await harness.waitFor(() => existsSync(join(getOmpArtifactsDir(second), "local")), "new session storage link");
  expect(lstatSync(join(getOmpArtifactsDir(second), "local")).isSymbolicLink()).toBe(true);
  expect(realpathSync(join(getOmpArtifactsDir(second), "local")))
    .toBe(realpathSync(join(storage, "local")));

  await prompt(threadId, providerThreadId, "/fork");
  const third = sessionFiles(providerThreadId).find((file) => file !== original && file !== second);
  expect(third).toBeDefined();
  if (!third) throw new Error("The native command did not fork the session");
  await harness.waitFor(() => existsSync(join(getOmpArtifactsDir(third), "local")), "forked session storage link");
  expect(realpathSync(join(getOmpArtifactsDir(third), "local")))
    .toBe(realpathSync(join(storage, "local")));

  await prompt(threadId, providerThreadId, `/resume ${original}`);
  await prompt(threadId, providerThreadId, "See local://kept.md");
  expect(readFileSync(join(getOmpArtifactsDir(original), "local", "kept.md"), "utf8"))
    .toBe("available in every session");
  expect(readdirSync(join(storage, "local"))).toEqual(["kept.md"]);
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "item.textClose",
    text: expect.stringContaining(join(storage, "local", "kept.md")),
  }));
}, 30_000);

it.each(["tip", "checkpoint", "offline"] as const)(
  "copies local thread files independently into a %s BB thread fork",
  async (kind) => {
    const sourceThreadId = "thr_storage_source";
    const source = await startThread(sourceThreadId);
    await prompt(sourceThreadId, source.providerThreadId, "Create a checkpoint");
    const sourceFile = sessionFiles(source.providerThreadId)[0]!;
    const sourceLocal = join(source.storage, "local");
    mkdirSync(join(sourceLocal, "nested"));
    writeFileSync(join(sourceLocal, "x.md"), "source snapshot");
    writeFileSync(join(sourceLocal, "nested", "y.md"), "nested source");
    const checkpoint = harness.deltasOf(sourceThreadId).findLast(
      (delta) => delta.kind === "turn.boundary" && typeof delta.providerCheckpointId === "string",
    )?.providerCheckpointId;
    if (kind === "checkpoint") expect(typeof checkpoint).toBe("string");
    if (kind === "offline") {
      const stopped = await harness.request(nextId++, "thread/stop", {
        threadId: sourceThreadId, providerThreadId: source.providerThreadId, intent: "release", activeTurnId: null,
      });
      expect(stopped.error, JSON.stringify(stopped)).toBeUndefined();
    }

    const threadId = "thr_storage_fork";
    const storage = join(harness.workspaceDir, "thread-storage", threadId);
    const fork = await harness.request(nextId++, "thread/fork", {
      threadId,
      cwd: harness.workspaceDir,
      sourceProviderThreadId: source.providerThreadId,
      ...(kind === "checkpoint" ? { sourceProviderCheckpointId: z.string().parse(checkpoint) } : {}),
      options: { ...FULL_PERMISSION_OPTIONS, envVars: { BB_THREAD_STORAGE: storage } },
      instructionMode: "append",
    });
    expect(fork.error, JSON.stringify(fork)).toBeUndefined();
    const { providerThreadId } = providerThreadSchema.parse(fork.result);
    const forkFiles = sessionFiles(providerThreadId);
    expect(forkFiles).toHaveLength(1);
    const forkLocal = join(getOmpArtifactsDir(forkFiles[0]!), "local");
    expect(lstatSync(forkLocal).isSymbolicLink()).toBe(true);
    expect(realpathSync(forkLocal)).toBe(realpathSync(join(storage, "local")));
    expect(readFileSync(join(forkLocal, "x.md"), "utf8")).toBe("source snapshot");
    expect(readFileSync(join(forkLocal, "nested", "y.md"), "utf8")).toBe("nested source");
    expect(readdirSync(join(storage, "local")).sort()).toEqual(["nested", "x.md"]);
    expect(readFileSync(join(sourceLocal, "x.md"), "utf8")).toBe("source snapshot");
    expect(realpathSync(join(getOmpArtifactsDir(sourceFile), "local"))).toBe(realpathSync(sourceLocal));
    writeFileSync(join(forkLocal, "x.md"), "fork changed independently");
    expect(readFileSync(join(sourceLocal, "x.md"), "utf8")).toBe("source snapshot");
  },
  30_000,
);

it("passes the parent's shared local root to subagent transcript translation", async () => {
  const threadId = "thr_child_storage";
  const { providerThreadId, storage } = await startThread(threadId);
  const realFile = join(storage, "local", "child.md");
  writeFileSync(realFile, "A child uses its parent's local:// mapping");
  await prompt(threadId, providerThreadId, `/subagents ${JSON.stringify({
    scenario: "batch",
    tasks: [{ name: "Worker", finalText: "Child file: local://child.md" }],
  })}`);
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "item.textClose",
    providerTurnId: expect.stringContaining("omp-subagent:"),
    text: expect.stringMatching(/^Child file:/u),
  }));
  const childText = harness.deltasOf(threadId).find((delta) => delta.kind === "item.textClose" &&
    typeof delta.text === "string" && delta.text.startsWith("Child file:"))?.text;
  expect(childText).toContain(realFile);
}, 30_000);

it("migrates an existing resumed local directory and keeps the link on another resume", async () => {
  const threadId = "thr_legacy_storage";
  const providerThreadId = "omp-legacy-storage";
  const directory = resolveOmpThreadSessionDir({ env: process.env, threadId: providerThreadId });
  const sessionFile = join(directory, "legacy.jsonl");
  const local = join(getOmpArtifactsDir(sessionFile), "local");
  const storage = join(harness.workspaceDir, "thread-storage", threadId);
  mkdirSync(join(local, "nested"), { recursive: true });
  mkdirSync(join(storage, "local"), { recursive: true });
  writeFileSync(sessionFile, [
    { type: "title", title: "Legacy local files" },
    {
      type: "session", version: 3, id: "legacy-storage",
      cwd: harness.workspaceDir, timestamp: "2026-01-01T00:00:00.000Z",
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(local, "x.md"), "legacy file");
  writeFileSync(join(local, "nested", "y.md"), "legacy nested file");
  writeFileSync(join(storage, "local", "x.md"), "existing thread file");
  const resumed = await harness.request(nextId++, "thread/resume", {
    threadId, providerThreadId, cwd: harness.workspaceDir, instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, envVars: { BB_THREAD_STORAGE: storage } },
  });
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
  expect(lstatSync(local).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(storage, "local", "x.md"), "utf8")).toBe("existing thread file");
  expect(readFileSync(join(storage, "local", "x.md.from-omp-1"), "utf8")).toBe("legacy file");
  expect(readFileSync(join(storage, "local", "nested", "y.md"), "utf8")).toBe("legacy nested file");
  const stopped = await harness.request(nextId++, "thread/stop", {
    threadId, providerThreadId, intent: "release", activeTurnId: null,
  });
  expect(stopped.error, JSON.stringify(stopped)).toBeUndefined();
  const resumedAgain = await harness.request(nextId++, "thread/resume", {
    threadId, providerThreadId, cwd: harness.workspaceDir, instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, envVars: { BB_THREAD_STORAGE: storage } },
  });
  expect(resumedAgain.error, JSON.stringify(resumedAgain)).toBeUndefined();
  expect(lstatSync(local).isSymbolicLink()).toBe(true);
  expect(readdirSync(join(storage, "local")).sort()).toEqual(["nested", "x.md", "x.md.from-omp-1"]);
}, 30_000);
