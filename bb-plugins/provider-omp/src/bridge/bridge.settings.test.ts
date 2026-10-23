import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const OPTIONS = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "high",
};

const SETTINGS_PROCESS_TEST_TIMEOUT_MS = 60_000;

let harness: FakeOmpBridgeHarness;
let commandLogPath: string;

let rpcLogPath: string;
beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-settings-",
    initialize: true,
    processLog: true,
  });
  commandLogPath = join(harness.workspaceDir, "commands.log");
  vi.stubEnv("FAKE_OMP_COMMAND_LOG", commandLogPath);
  rpcLogPath = join(harness.workspaceDir, "rpc.jsonl");
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLogPath);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function commandsSent(): string[] {
  return existsSync(commandLogPath)
    ? readFileSync(commandLogPath, "utf8").split("\n").filter(Boolean)
    : [];
}

it(
  "pins initial settings at spawn and applies later model and thinking changes through native RPC",
  async () => {
    const threadId = "thr_settings";
    const start = await harness.request(1, "thread/start", {
      threadId,
      cwd: harness.workspaceDir,
      instructionMode: "append",
      options: OPTIONS,
    });
    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse(start.result);
    expect(providerThreadId).toMatch(/^omp_/u);
    const spawned = harness.readProcessLog().spawned;
    await harness.request(2, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId: "creq_ab23456789",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: OPTIONS,
    });
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    await harness.request(3, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId: "creq_cd23456789",
      input: [{ type: "text", text: "again", mentions: [] }],
      options: {
        ...OPTIONS,
        model: "fake-provider/fake-model",
        reasoningLevel: "low",
      },
    });
    await harness.waitForTurnBoundary(threadId, seen);
    expect(harness.readProcessLog().spawned).toEqual(spawned);
    expect(harness.messages.some((message) => message.method === "session/replaced")).toBe(false);
    await harness.request(4, "thread/stop", {
      threadId,
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const resume = await harness.request(5, "thread/resume", {
      threadId,
      providerThreadId,
      cwd: harness.workspaceDir,
      instructionMode: "append",
      options: { ...OPTIONS, model: "fake-provider/fake-model" },
    });
    expect(resume.result).toMatchObject({ providerThreadId });
    const fork = await harness.request(6, "thread/fork", {
      threadId: "thr_settings_fork",
      cwd: harness.workspaceDir,
      sourceProviderThreadId: providerThreadId,
      options: OPTIONS,
      instructionMode: "append",
    });
    expect(fork.error, JSON.stringify(fork)).toBeUndefined();

    const sent = commandsSent();
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.filter((c) => c === "set_model" || c === "set_thinking_level"),
    ).toEqual(["set_model", "set_thinking_level"]);
    const settingCommands = readFileSync(rpcLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => z.object({
        type: z.string(),
        provider: z.string().optional(),
        modelId: z.string().optional(),
        level: z.string().optional(),
      }).parse(JSON.parse(line)))
      .filter((command) => command.type === "set_model" || command.type === "set_thinking_level");
    expect(settingCommands).toEqual([
      { type: "set_model", provider: "fake-provider", modelId: "fake-model" },
      { type: "set_thinking_level", level: "low" },
    ]);
    const contextWindows = harness
      .deltasOf(threadId)
      .filter((delta) => delta.kind === "contextWindow")
      .map((delta) => delta.size);
    expect(contextWindows[0]).toBe(32_000);
    expect(contextWindows.at(-1)).toBe(200_000);
  },
  SETTINGS_PROCESS_TEST_TIMEOUT_MS,
);

it(
  "hands bb skill roots to OMP as custom skill directories without dropping the user's own",
  async () => {
    const agentDir = join(harness.workspaceDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "config.yml"), "skills:\n  customDirectories:\n    - user-skills\n");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const configLogPath = join(harness.workspaceDir, "config.log");
    vi.stubEnv("FAKE_OMP_CONFIG_LOG", configLogPath);
    const bbRoot = join(harness.workspaceDir, "bb-skills");
    await harness.request(1, "skills/configure", {
      roots: [{ id: "bb", path: bbRoot, skills: [] }],
    });
    await harness.request(2, "thread/start", {
      threadId: "thr_skills",
      cwd: harness.workspaceDir,
      instructionMode: "append",
      options: OPTIONS,
    });
    const overlay: unknown = JSON.parse(readFileSync(configLogPath, "utf8"));
    expect(overlay).toEqual({
      memory: { backend: "off" },
      extensions: [expect.stringMatching(/bb-hide-dead-memory-tools\.ts$/u)],
      skills: { customDirectories: [join(harness.workspaceDir, "user-skills"), bbRoot] },
      tools: { approvalMode: "yolo" },
    });
  },
  SETTINGS_PROCESS_TEST_TIMEOUT_MS,
);
