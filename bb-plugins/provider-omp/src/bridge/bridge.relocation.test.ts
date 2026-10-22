import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  findNewestOmpSessionFile,
  resolveOmpThreadSessionDir,
} from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  startFakeOmpBridge,
  type FakeOmpBridgeHarness,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness | undefined;

afterEach(async () => {
  await harness?.teardown();
});

it.each(["retained", "removed before relocation", "removed after relocation"])(
  "relocates native OMP history with the previous directory %s",
  async (previousState) => {
    harness = await startFakeOmpBridge({
      prefix: "bb-omp-relocation-",
      initialize: true,
    });
    const launchLog = join(harness.workspaceDir, "launches.jsonl");
    vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLog);
    const target = realpathSync(harness.workspaceDir);
    const previous = join(target, "previous");
    mkdirSync(previous);
    const originalDir = resolveOmpThreadSessionDir({
      env: process.env,
      threadId: "omp_relocation",
    });
    mkdirSync(originalDir, { recursive: true });
    const sourceFile = join(originalDir, "2026-01-01T00-00-00_original.jsonl");
    const sourceBytes = [
      { type: "title", title: "Relocation history" },
      {
        type: "session",
        version: 3,
        id: "original",
        cwd: previous,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "message",
        id: "user1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "Keep this conversation", timestamp: 1 },
      },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    writeFileSync(sourceFile, sourceBytes);
    if (previousState === "removed before relocation") {
      rmSync(previous, { recursive: true });
    }
    const resumed = await harness.request(200, "thread/resume", {
      threadId: "thr_relocation",
      providerThreadId: "omp_relocation",
      cwd: target,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
    const launches = readFileSync(launchLog, "utf8").trim().split("\n")
      .map((line) => z.object({ args: z.array(z.string()) }).parse(JSON.parse(line)));
    expect(launches.map((launch) => launch.args.slice(0, 4))).toEqual([
      ["--mode", "rpc", "--cwd", target],
      ["--mode", "rpc-ui", "--cwd", target],
    ]);
    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse(resumed.result);
    expect(providerThreadId).not.toBe("omp_relocation");
    expect(providerThreadId).toMatch(/^omp_[0-9a-f-]{36}$/u);
    const relocatedDir = resolveOmpThreadSessionDir({
      env: process.env,
      threadId: providerThreadId,
    });
    const relocatedFile = findNewestOmpSessionFile(relocatedDir);
    expect(relocatedFile).toBeDefined();
    if (relocatedFile === undefined) throw new Error("Missing relocated OMP history");
    const relocatedBytes = readFileSync(relocatedFile, "utf8");
    const relocatedRecords = relocatedBytes
      .split("\n")
      .filter(Boolean)
      .map((line) => z.object({
        type: z.string(),
        cwd: z.string().optional(),
      }).parse(JSON.parse(line)));
    expect(relocatedRecords.find((record) => record.type === "session")).toMatchObject({
      cwd: target,
    });
    expect(relocatedBytes).toContain("Keep this conversation");
    expect(readFileSync(sourceFile, "utf8")).toBe(sourceBytes);
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        method: "thread/identity",
        params: expect.objectContaining({ providerThreadId }),
      }),
    );
    const stopped = await harness.request(201, "thread/stop", {
      threadId: "thr_relocation",
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    expect(stopped.error).toBeUndefined();
    if (previousState === "removed after relocation") {
      rmSync(previous, { recursive: true });
    }
    const resumedAgain = await harness.request(202, "thread/resume", {
      threadId: "thr_relocation",
      providerThreadId,
      cwd: target,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumedAgain.error).toBeUndefined();
    expect(resumedAgain.result).toMatchObject({ providerThreadId });
    expect(findNewestOmpSessionFile(relocatedDir)).toBe(relocatedFile);
    expect(readFileSync(sourceFile, "utf8")).toBe(sourceBytes);
    const discarded = await harness.request(203, "thread/discard", {
      threadId: "thr_relocation",
      providerThreadId,
    });
    expect(discarded.result).toEqual({ ok: true });
    expect(existsSync(relocatedDir)).toBe(false);
    expect(readFileSync(sourceFile, "utf8")).toBe(sourceBytes);
  },
  90_000,
);

it("removes an unsuccessful relocation directory before retrying, preserving the source", async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-relocation-retry-",
    initialize: true,
  });
  const sourceDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: "omp_original",
  });
  mkdirSync(sourceDir, { recursive: true });
  const sourceFile = join(sourceDir, "2026-01-01T00-00-00_original.jsonl");
  const contents = [
    { type: "title", title: "Original conversation" },
    {
      type: "session",
      version: 3,
      id: "original",
      cwd: join(harness.workspaceDir, "removed"),
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "message",
      id: "user1",
      parentId: null,
      message: { role: "user", content: "Preserve me", timestamp: 1 },
    },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(sourceFile, contents);
  const params = {
    threadId: "thr_relocation_retry",
    providerThreadId: "omp_original",
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, model: "missing-model" },
  };
  const failed = await harness.request(200, "thread/resume", params);
  expect(failed.error).toMatchObject({
    message: expect.stringContaining("Failed to resolve OMP model"),
  });
  expect(readFileSync(sourceFile, "utf8")).toBe(contents);
  expect(readdirSync(harness.sessionDir)).toEqual(["omp_original"]);
  expect(
    harness.messages.some((message) => message.method === "thread/identity"),
  ).toBe(false);
  const retried = await harness.request(201, "thread/resume", {
    ...params,
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(retried.error).toBeUndefined();
  expect(retried.result).toMatchObject({
    providerThreadId: expect.stringMatching(/^omp_/u),
  });
  expect(readFileSync(sourceFile, "utf8")).toBe(contents);
  expect(readdirSync(harness.sessionDir)).toHaveLength(2);
}, 90_000);
