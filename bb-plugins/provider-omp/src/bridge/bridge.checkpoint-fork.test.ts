import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
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
    prefix: "bb-omp-checkpoint-fork-",
    initialize: true,
  });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

it("snapshots the source through an assistant checkpoint without changing its history", async () => {
  const sourceDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: "thr_ckpt_src",
  });
  mkdirSync(sourceDir, { recursive: true });
  const sourceFile = join(sourceDir, "2026-01-01T00-00-00_source.jsonl");
  const checkpointId = "assistant-first";
  const records = [
    { type: "title", title: "Checkpoint source" },
    {
      type: "session",
      version: 3,
      id: "checkpoint-source",
      cwd: harness.workspaceDir,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "message",
      id: "user-first",
      parentId: null,
      message: { role: "user", content: "first question", timestamp: 1 },
    },
    {
      type: "message",
      id: checkpointId,
      parentId: "user-first",
      message: assistant("first answer", 2),
    },
    {
      type: "message",
      id: "user-second",
      parentId: checkpointId,
      message: { role: "user", content: "second question", timestamp: 3 },
    },
    {
      type: "message",
      id: "assistant-second",
      parentId: "user-second",
      message: assistant("second answer", 4),
    },
  ];
  const sourceBefore = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(sourceFile, sourceBefore);

  const fork = await harness.request(1, "thread/fork", {
    threadId: "thr_ckpt_fork",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: "thr_ckpt_src",
    sourceProviderCheckpointId: checkpointId,
    options: FULL_PERMISSION_OPTIONS,
    instructionMode: "append",
  });
  expect(fork.error, JSON.stringify(fork)).toBeUndefined();
  expect(fork.result).toMatchObject({
    providerThreadId: "thr_ckpt_fork",
    sessionRestorable: true,
  });

  const forkDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: "thr_ckpt_fork",
  });
  const forkFile = findNewestOmpSessionFile(forkDir);
  expect(forkFile).toBeDefined();
  if (forkFile === undefined) throw new Error("Missing forked OMP session");
  expect(forkFile).not.toBe(sourceFile);
  const forked = readFileSync(forkFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => z.object({
      type: z.string(),
      id: z.string().optional(),
      cwd: z.string().optional(),
      message: z.object({
        role: z.string(),
        content: z.union([
          z.string(),
          z.array(z.object({ text: z.string().optional() })),
        ]),
      }).optional(),
    }).parse(JSON.parse(line)));
  expect(forked.find((entry) => entry.type === "session")).toMatchObject({
    cwd: realpathSync(harness.workspaceDir),
  });
  const messages = forked.filter((entry) => entry.type === "message");
  expect(
    messages.map((entry) => {
      const message = entry.message!;
      return `${message.role}:${typeof message.content === "string" ? message.content : message.content.map((block) => block.text ?? "").join("")}`;
    }),
  ).toEqual(["user:first question", "assistant:first answer"]);
  expect(messages.at(-1)?.id).toBe(checkpointId);
  expect(readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
}, 30_000);

it("refuses a fork whose source session is missing", async () => {
  const fork = await harness.request(1, "thread/fork", {
    threadId: "thr_ckpt_missing",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: "thr_never_existed",
    options: FULL_PERMISSION_OPTIONS,
    instructionMode: "append",
  });
  expect(fork.error).toMatchObject({
    message: expect.stringContaining("source omp session file not found"),
  });
  expect(
    existsSync(resolveOmpThreadSessionDir({
      env: process.env,
      threadId: "thr_ckpt_missing",
    })),
  ).toBe(false);
}, 30_000);
