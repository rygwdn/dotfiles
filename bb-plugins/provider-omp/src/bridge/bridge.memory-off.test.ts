import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { OmpRpcSession } from "./rpc-session.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";
import { resolveOmpThreadSessionDir } from "./session-paths.js";

let harness: FakeOmpBridgeHarness;
let launchLog: string;
let overlayLog: string;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-memory-off-",
    initialize: true,
    processLog: true,
  });
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  overlayLog = join(harness.workspaceDir, "overlays.jsonl");
  vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLog);
  vi.stubEnv("FAKE_OMP_CONFIG_LOG", overlayLog);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

const launchSchema = z.object({
  args: z.array(z.string()),
  threadId: z.string().nullable(),
});

function launches(): z.infer<typeof launchSchema>[] {
  if (!existsSync(launchLog)) return [];
  return readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => launchSchema.parse(JSON.parse(line)));
}

function overlays(): string[] {
  if (!existsSync(overlayLog)) return [];
  return readFileSync(overlayLog, "utf8").trim().split("\n").filter(Boolean);
}

function configPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = args.indexOf("--config"); index !== -1; index = args.indexOf("--config", index + 1)) {
    paths.push(args[index + 1]!);
  }
  return paths;
}

it("every BB-hosted OMP session launch carries a config overlay that turns the native memory backend off", async () => {
  const started = await harness.startThread("thr_mem_off", {
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(started.error, JSON.stringify(started)).toBeUndefined();
  const sessionLaunches = launches().filter((launch) => launch.args[1] === "rpc-ui");
  expect(sessionLaunches.length).toBeGreaterThan(0);
  for (const launch of sessionLaunches) {
    const configPathsForLaunch = configPaths(launch.args);
    expect(configPathsForLaunch.length).toBeGreaterThan(0);
    for (const path of configPathsForLaunch) {
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        memory: { backend: "off" },
      });
    }
  }
  // The overlay log is fed by the fake omp child reading the same files.
  for (const overlay of overlays()) {
    expect(JSON.parse(overlay)).toMatchObject({ memory: { backend: "off" } });
  }
}, 30_000);

it("forked OMP sessions also launch with the memory-off overlay", async () => {
  const sourceDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: "thr_mem_off_src",
  });
  mkdirSync(sourceDir, { recursive: true });
  const sourceFile = join(sourceDir, "2026-01-01T00-00-00_source.jsonl");
  writeFileSync(sourceFile, [
    JSON.stringify({ type: "session", version: 3, id: "mem-off-source", cwd: harness.workspaceDir, timestamp: "2026-01-01T00:00:00.000Z" }),
    JSON.stringify({ type: "message", id: "user-first", parentId: null, message: { role: "user", content: "hello", timestamp: 1 } }),
  ].join("\n") + "\n");

  const targetDir = resolveOmpThreadSessionDir({
    env: process.env,
    threadId: "thr_mem_off_fork",
  });
  await OmpRpcSession.forkSessionFile({
    sourceFile,
    targetDir,
    cwd: harness.workspaceDir,
    recordThreadId: "thr_mem_off_fork",
  });

  const forkLaunches = launches().filter((launch) => launch.args.includes("--fork"));
  expect(forkLaunches.length).toBeGreaterThan(0);
  for (const launch of forkLaunches) {
    const paths = configPaths(launch.args);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        memory: { backend: "off" },
      });
    }
  }
}, 30_000);
