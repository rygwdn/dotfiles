import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BridgeJsonRpcObject } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_closeAllForTests } from "./bridge.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const TIMEOUT_MS = 60_000;
const identitySchema = z.object({ providerThreadId: z.string() });
const launchSchema = z.object({ args: z.array(z.string()), threadId: z.string().nullable() });
const overlaySchema = z.object({
  memory: z.object({ backend: z.literal("off") }),
  skills: z.object({ customDirectories: z.array(z.string()) }).optional(),
  modelRoles: z.record(z.string(), z.string().nullable()).optional(),
  defaultThinkingLevel: z.string().optional(),
  tools: z.object({ approvalMode: z.enum(["yolo", "write"]) }).optional(),
});
const rpcSchema = z.object({
  type: z.string(),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  level: z.string().optional(),
  enabled: z.boolean().optional(),
});

let harness: FakeOmpBridgeHarness;
let agentDir: string;
let configPath: string;
let launchLog: string;
let overlayLog: string;
let rpcLog: string;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-model-presets-",
    initialize: true,
    processLog: true,
  });
  agentDir = join(harness.workspaceDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  configPath = join(agentDir, "config.yml");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CONFIG_FILES", undefined);
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  overlayLog = join(harness.workspaceDir, "overlays.jsonl");
  rpcLog = join(harness.workspaceDir, "rpc.jsonl");
  vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLog);
  vi.stubEnv("FAKE_OMP_CONFIG_LOG", overlayLog);
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
  await harness.request(99, "skills/configure", { roots: [] });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function writeConfig(config: unknown): string {
  const content = JSON.stringify(config);
  writeFileSync(configPath, content);
  return content;
}

function launches(threadId: string) {
  return readFileSync(launchLog, "utf8").trim().split("\n")
    .map((line) => launchSchema.parse(JSON.parse(line)))
    .filter((launch) => launch.args[1] === "rpc-ui" && launch.threadId === threadId);
}

function overlays() {
  return existsSync(overlayLog)
    ? readFileSync(overlayLog, "utf8").trim().split("\n")
      .map((line) => overlaySchema.parse(JSON.parse(line)))
    : [];
}

function rpcCommands() {
  return readFileSync(rpcLog, "utf8").trim().split("\n")
    .map((line) => rpcSchema.parse(JSON.parse(line)));
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function snapshotFile(threadId: string): string {
  return join(flag(launches(threadId)[0]!.args, "--session-dir")!, "bb-model-preset.json");
}

function replacements(threadId: string) {
  return harness.messages
    .filter((message) => message.method === "session/replaced")
    .map((message) => z.object({
      threadId: z.string(),
      providerThreadId: z.string(),
      reason: z.string(),
      contextLost: z.boolean(),
    }).parse(message.params))
    .filter((replacement) => replacement.threadId === threadId);
}

async function startThread(threadId: string, options: BridgeJsonRpcObject): Promise<string> {
  const started = await harness.startThread(threadId, {
    options: { ...FULL_PERMISSION_OPTIONS, ...options },
  });
  expect(started.error, JSON.stringify(started)).toBeUndefined();
  return identitySchema.parse(started.result).providerThreadId;
}

function turn(
  id: number,
  threadId: string,
  providerThreadId: string,
  options: BridgeJsonRpcObject,
) {
  return harness.request(id, "turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: `creq_abcdefghi${"23456789"[id % 8] ?? "2"}`,
    input: [{ type: "text", text: "continue", mentions: [] }],
    options: { ...FULL_PERMISSION_OPTIONS, ...options },
  });
}

it("combines preset roles, omitted-role tombstones, thinking, and skills in one disposable overlay", async () => {
  const modelRoles = {
    default: "fake-provider/fake-mini:high",
    smol: "fake-provider/fake-mini",
    task: "fake-gateway/vendor/slash-model",
    custom: "@slow",
  };
  const originalConfig = writeConfig({
    modelRoles: {
      default: "fake-provider/fake-model",
      smol: "fake-provider/fake-model",
      advisor: "fake-provider/fake-model",
      commit: "fake-provider/fake-mini",
    },
    modelPresets: { balanced: { modelRoles, defaultThinkingLevel: "low" } },
    skills: { customDirectories: ["user-skills"] },
  });
  const bbRoot = join(harness.workspaceDir, "bb-skills");
  await harness.request(1, "skills/configure", {
    roots: [{ id: "bb", path: bbRoot, skills: [] }],
  });
  const threadId = "thr_preset_overlay";
  const providerThreadId = await startThread(threadId, { model: "preset:balanced" });
  const [launch] = launches(threadId);
  expect(launch).toBeDefined();
  const args = launch!.args;
  expect(args.filter((arg) => arg === "--config")).toHaveLength(1);
  expect(flag(args, "--model")).toBe("fake-provider/fake-mini");
  expect(flag(args, "--thinking")).toBe("high");
  expect(overlays()).toEqual([{ memory: { backend: "off" }, 
    skills: { customDirectories: [join(harness.workspaceDir, "user-skills"), bbRoot] },
    modelRoles: { ...modelRoles, advisor: null, commit: null },
    defaultThinkingLevel: "low",
    tools: { approvalMode: "yolo" },
  }]);
  expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
  const overlayPath = flag(args, "--config")!;
  expect(existsSync(overlayPath)).toBe(true);
  await harness.request(2, "thread/stop", {
    threadId, providerThreadId, intent: "release", activeTurnId: null,
  });
  await harness.waitFor(() => !existsSync(overlayPath), "the preset overlay to be removed");
}, TIMEOUT_MS);

it.each([
  { label: "preset thinking default", selector: "fake-gateway/vendor/slash-model", thinking: "auto", reasoning: undefined, model: "fake-gateway/vendor/slash-model", expectedThinking: "auto" },
  { label: "explicit bb reasoning", selector: "fake-provider/fake-mini:xhigh", thinking: "low", reasoning: "none", model: "fake-provider/fake-mini", expectedThinking: "off" },
  { label: "unresolved native alias", selector: "@slow:high", thinking: "low", reasoning: undefined, model: undefined, expectedThinking: "low" },
  { label: "native pattern", selector: "fake-provider/*:medium", thinking: undefined, reasoning: undefined, model: undefined, expectedThinking: undefined },
  { label: "absent default role", selector: undefined, thinking: "auto", reasoning: undefined, model: undefined, expectedThinking: "auto" },
  { label: "unavailable literal default", selector: "unavailable/model", thinking: undefined, reasoning: undefined, model: undefined, expectedThinking: undefined },
  { label: "ambiguous bare model", selector: "vendor/shared-model", thinking: undefined, reasoning: undefined, model: undefined, expectedThinking: undefined },
])("starts a preset with $label without forcing an unresolved default", async ({
  selector, thinking, reasoning, model, expectedThinking,
}) => {
  const modelRoles = { smol: "fake-provider/fake-mini", ...(selector ? { default: selector } : {}) };
  writeConfig({ modelPresets: { selected: { modelRoles, ...(thinking ? { defaultThinkingLevel: thinking } : {}) } } });
  const threadId = "thr_preset_default";
  await startThread(threadId, {
    model: "preset:selected",
    ...(reasoning ? { reasoningLevel: reasoning } : {}),
  });
  const [launch] = launches(threadId);
  expect(flag(launch!.args, "--model")).toBe(model);
  expect(flag(launch!.args, "--thinking")).toBe(expectedThinking);
  expect(overlays()).toEqual([{ memory: { backend: "off" }, 
    modelRoles,
    ...(thinking ? { defaultThinkingLevel: thinking } : {}),
    tools: { approvalMode: "yolo" },
  }]);
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.warning"))
    .toHaveLength(model === undefined ? 1 : 0);
}, TIMEOUT_MS);

it.each([false, true])("preserves colons in a catalog model id (thinking suffix: %s)", async (withSuffix) => {
  const provider = "fireworks-300k";
  const modelId = "fireworks:accounts/fireworks/routers/glm-5p3-fast:route";
  const model = `${provider}/${modelId}`;
  const modelsFile = join(harness.workspaceDir, "models.json");
  writeFileSync(modelsFile, JSON.stringify([{
    id: modelId, provider, name: "Colon model", input: ["text"], reasoning: true, contextWindow: 300_000,
  }]));
  const scopedAgentDir = join(harness.workspaceDir, "scoped-agent");
  mkdirSync(scopedAgentDir, { recursive: true });
  const selector = `${model}${withSuffix ? ":xhigh" : ""}`;
  writeFileSync(join(scopedAgentDir, "config.yml"), JSON.stringify({
    modelPresets: { colon: { modelRoles: { default: selector }, defaultThinkingLevel: "low" } },
  }));
  writeConfig({ modelPresets: {} });
  const threadId = "thr_preset_colons";
  await startThread(threadId, {
    model: "preset:colon",
    envVars: { PI_CODING_AGENT_DIR: scopedAgentDir, FAKE_OMP_MODELS_FILE: modelsFile },
  });
  const [launch] = launches(threadId);
  expect(flag(launch!.args, "--model")).toBe(model);
  expect(flag(launch!.args, "--thinking")).toBe(withSuffix ? "xhigh" : "low");
  expect(overlays()).toEqual([{ memory: { backend: "off" }, 
    modelRoles: { default: selector }, defaultThinkingLevel: "low",
    tools: { approvalMode: "yolo" },
  }]);
}, TIMEOUT_MS);

it.each([
  {
    label: "a role alias",
    modelRoles: { default: "@slow", slow: "fake-provider/fake-model:high" },
    model: "fake-provider/fake-model",
    thinking: "high",
    reasoning: undefined,
  },
  {
    label: "chained aliases and a fallback list",
    modelRoles: { default: "@slow", slow: "@plan", plan: "unavailable/model:off, fake-gateway/vendor/slash-model:xhigh, fake-provider/fake-model:low" },
    model: "fake-gateway/vendor/slash-model",
    thinking: "xhigh",
    reasoning: undefined,
  },
  {
    label: "the first available candidate",
    modelRoles: { default: "fake-provider/fake-model:low, fake-gateway/vendor/slash-model:high" },
    model: "fake-provider/fake-model",
    thinking: "low",
    reasoning: undefined,
  },
  {
    label: "bb reasoning over the chosen candidate",
    modelRoles: { default: "@slow", slow: "unavailable/model:off, fake-provider/fake-model:xhigh" },
    model: "fake-provider/fake-model",
    thinking: "medium",
    reasoning: "medium",
  },
])("overrides a continued session's old model using $label", async ({ modelRoles, model, thinking, reasoning }) => {
  writeConfig({ modelPresets: { selected: { modelRoles, defaultThinkingLevel: "auto" } } });
  const threadId = "thr_preset_candidates";
  const providerThreadId = await startThread(threadId, { model: "fake-provider/fake-mini" });
  expect((await turn(1, threadId, providerThreadId, { model: "fake-provider/fake-mini" })).error).toBeUndefined();
  const seen = await harness.waitForTurnBoundary(threadId, 0);
  expect((await turn(2, threadId, providerThreadId, {
    model: "preset:selected",
    ...(reasoning ? { reasoningLevel: reasoning } : {}),
  })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  const liveLaunches = launches(threadId);
  expect(liveLaunches).toHaveLength(2);
  expect(liveLaunches[1]!.args).toContain("--continue");
  expect(flag(liveLaunches[1]!.args, "--model")).toBe(model);
  expect(flag(liveLaunches[1]!.args, "--thinking")).toBe(thinking);
  expect(overlays().at(-1)).toEqual({ memory: { backend: "off" },  modelRoles, defaultThinkingLevel: "auto", tools: { approvalMode: "yolo" } });
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.warning")).toEqual([]);
  expect(rpcCommands().filter((command) => command.type === "set_model")).toEqual([]);
}, TIMEOUT_MS);

it("warns when a continued preset's default cannot resolve and leaves its current model in place", async () => {
  const modelRoles = { default: "@missing", smol: "fake-provider/fake-mini" };
  writeConfig({ modelPresets: { selected: { modelRoles, defaultThinkingLevel: "auto" } } });
  const threadId = "thr_preset_unresolved_default";
  const providerThreadId = await startThread(threadId, { model: "fake-provider/fake-mini" });
  expect((await turn(1, threadId, providerThreadId, { model: "fake-provider/fake-mini" })).error).toBeUndefined();
  let seen = await harness.waitForTurnBoundary(threadId, 0);
  expect((await turn(2, threadId, providerThreadId, { model: "preset:selected" })).error).toBeUndefined();
  seen = await harness.waitForTurnBoundary(threadId, seen);
  expect(flag(launches(threadId)[1]!.args, "--model")).toBeUndefined();
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "contextWindow").at(-1))
    .toMatchObject({ size: 32_000 });
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "provider.warning",
    details: 'OMP could not resolve a default model for preset "selected". The session keeps its current model.',
  }));
  expect((await turn(3, threadId, providerThreadId, { model: "preset:selected" })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  expect(launches(threadId)).toHaveLength(2);
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.warning")).toHaveLength(1);
}, TIMEOUT_MS);

it.each(["fake-provider/fake-mini", "preset:quiet"])(
  "restarts once when switching from %s to a different preset and ignores repeated snapshots",
  async (initialModel) => {
    const quiet = { default: "fake-provider/fake-mini", smol: "fake-provider/fake-mini" };
    const intense = { default: "fake-provider/fake-model", advisor: "fake-gateway/vendor/slash-model" };
    writeConfig({
      modelRoles: { slow: "fake-provider/fake-model" },
      modelPresets: {
        quiet: { modelRoles: quiet },
        intense: { modelRoles: intense, defaultThinkingLevel: "high" },
      },
    });
    const threadId = "thr_preset_switch";
    const providerThreadId = await startThread(threadId, { model: initialModel });
    expect((await turn(1, threadId, providerThreadId, { model: initialModel })).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    const originalArgs = launches(threadId)[0]!.args;
    const oldOverlay = flag(originalArgs, "--config");
    expect((await turn(2, threadId, providerThreadId, { model: "preset:intense" })).error).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);
    const liveLaunches = launches(threadId);
    expect(liveLaunches).toHaveLength(2);
    expect(flag(liveLaunches[1]!.args, "--session-dir")).toBe(flag(originalArgs, "--session-dir"));
    expect(liveLaunches[1]!.args).toContain("--continue");
    expect(flag(liveLaunches[1]!.args, "--model")).toBe("fake-provider/fake-model");
    expect(flag(liveLaunches[1]!.args, "--thinking")).toBe("high");
    expect(overlays().at(-1)).toEqual({ memory: { backend: "off" }, 
      modelRoles: { ...intense, slow: null }, defaultThinkingLevel: "high",
      tools: { approvalMode: "yolo" },
    });
    expect(replacements(threadId)).toEqual([{
      threadId,
      providerThreadId,
      contextLost: false,
      reason: "Model preset changed; the OMP session was restarted to apply it.",
    }]);
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "session.reset")).toHaveLength(2);
    expect(rpcCommands().filter((command) => command.type === "set_model")).toEqual([]);
    if (oldOverlay) {
      await harness.waitFor(() => !existsSync(oldOverlay), "the previous child's overlay to be removed");
    }
    expect((await turn(3, threadId, providerThreadId, { model: "preset:intense" })).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(launches(threadId)).toHaveLength(2);
    expect(replacements(threadId)).toHaveLength(1);
  },
  TIMEOUT_MS,
);

it("keeps a preset's role snapshot when a raw model is selected and the environment later rebuilds", async () => {
  const modelRoles = { default: "fake-provider/fake-mini", advisor: "fake-gateway/vendor/slash-model" };
  writeConfig({
    modelRoles: { smol: "fake-provider/fake-model" },
    modelPresets: { selected: { modelRoles, defaultThinkingLevel: "high" } },
  });
  const threadId = "thr_preset_raw";
  const providerThreadId = await startThread(threadId, { model: "preset:selected" });
  const originalOverlay = flag(launches(threadId)[0]!.args, "--config")!;
  const originalContents = readFileSync(originalOverlay, "utf8");
  const rawOptions = {
    model: "fake-provider/fake-model",
    reasoningLevel: "low",
    serviceTier: "fast",
    sessionOptions: { interruptMode: "wait" },
  };
  expect((await turn(1, threadId, providerThreadId, rawOptions)).error).toBeUndefined();
  let seen = await harness.waitForTurnBoundary(threadId, 0);
  expect(launches(threadId)).toHaveLength(1);
  expect(replacements(threadId)).toEqual([]);
  expect(readFileSync(originalOverlay, "utf8")).toBe(originalContents);
  expect(rpcCommands().filter((command) => command.type === "set_model")).toEqual([
    { type: "set_model", provider: "fake-provider", modelId: "fake-model" },
  ]);
  expect(rpcCommands()).toContainEqual({ type: "set_thinking_level", level: "low" });
  expect(rpcCommands()).toContainEqual({ type: "set_fast_mode", enabled: true });

  writeConfig({
    modelRoles: { plan: "fake-provider/fake-model" },
    modelPresets: { selected: { modelRoles: { default: "fake-gateway/vendor/slash-model" }, defaultThinkingLevel: "off" } },
  });
  const rebuiltOptions = { ...rawOptions, envVars: { FAKE_OMP_ENV_MARKER: "rebuild" } };
  expect((await turn(2, threadId, providerThreadId, rebuiltOptions)).error).toBeUndefined();
  seen = await harness.waitForTurnBoundary(threadId, seen);
  expect(launches(threadId)).toHaveLength(2);
  expect(flag(launches(threadId)[1]!.args, "--model")).toBe("fake-provider/fake-model");
  expect(flag(launches(threadId)[1]!.args, "--thinking")).toBe("low");
  expect(overlays().at(-1)).toEqual({ memory: { backend: "off" }, 
    modelRoles: { ...modelRoles, plan: null },
    defaultThinkingLevel: "high",
    tools: { approvalMode: "yolo" },
  });
  expect(replacements(threadId)).toEqual([{
    threadId,
    providerThreadId,
    contextLost: false,
    reason: "Execution environment changed; the OMP session was rebuilt to apply it.",
  }]);
  expect((await turn(3, threadId, providerThreadId, { ...rebuiltOptions, model: "preset:selected" })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  expect(launches(threadId)).toHaveLength(2);
  expect(rpcCommands().filter((command) => command.type === "set_model")).toHaveLength(1);
}, TIMEOUT_MS);

it("falls back to native model roles with a visible warning for an unknown preset on start and resume", async () => {
  writeConfig({ modelRoles: { default: "fake-provider/fake-model" }, modelPresets: {} });
  const threadId = "thr_preset_unknown";
  const options = { model: "preset:missing" };
  const providerThreadId = await startThread(threadId, options);
  expect(flag(launches(threadId)[0]!.args, "--model")).toBeUndefined();
  expect(flag(launches(threadId)[0]!.args, "--config")).toBeDefined();
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "provider.warning",
    details: 'OMP model preset "missing" is unavailable. Continuing with OMP\'s native model roles.',
  }));
  expect((await turn(1, threadId, providerThreadId, options)).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, 0);
  expect(replacements(threadId)).toEqual([]);
  await harness.request(2, "thread/stop", {
    threadId, providerThreadId, intent: "release", activeTurnId: null,
  });
  const resumed = await harness.request(3, "thread/resume", {
    threadId, providerThreadId, cwd: harness.workspaceDir,
    instructionMode: "append", options: { ...FULL_PERMISSION_OPTIONS, ...options },
  });
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
  expect(resumed.result).toMatchObject({ providerThreadId });
  expect(launches(threadId)).toHaveLength(2);
  expect(launches(threadId).every((launch) => flag(launch.args, "--model") === undefined)).toBe(true);
  expect(overlays()).toEqual([
    { memory: { backend: "off" }, tools: { approvalMode: "yolo" } },
    { memory: { backend: "off" }, tools: { approvalMode: "yolo" } },
  ]);
  expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.warning")).toHaveLength(2);
}, TIMEOUT_MS);

it.each(["fake-provider/fake-model", "preset:selected"])(
  "restores a persisted preset after bridge shutdown when resuming with %s",
  async (resumeModel) => {
    const originalRoles = { default: "fake-provider/fake-mini:high", advisor: "fake-gateway/vendor/slash-model" };
    const updatedRoles = { default: "fake-gateway/vendor/slash-model:xhigh", smol: "fake-provider/fake-mini" };
    const originalSnapshot = {
      name: "selected", modelRoles: originalRoles, defaultThinkingLevel: "high", source: "global",
    };
    writeConfig({ modelPresets: { selected: { modelRoles: originalRoles, defaultThinkingLevel: "high" } } });
    const threadId = "thr_preset_persisted";
    const providerThreadId = await startThread(threadId, { model: "preset:selected" });
    const snapshotPath = snapshotFile(threadId);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(originalSnapshot);
    expect((await turn(1, threadId, providerThreadId, {
      model: "fake-provider/fake-model", reasoningLevel: "low",
    })).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, 0);
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(originalSnapshot);
    await harness.request(2, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    });
    await experimental_closeAllForTests();
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(originalSnapshot);
    const explicitPreset = resumeModel === "preset:selected";
    writeConfig({
      modelRoles: { plan: "fake-provider/fake-model" },
      modelPresets: explicitPreset
        ? { selected: { modelRoles: updatedRoles, defaultThinkingLevel: "auto" } }
        : {},
    });
    const resumed = await harness.request(3, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: { ...FULL_PERMISSION_OPTIONS, model: resumeModel },
    });
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
    expect(resumed.result).toMatchObject({ providerThreadId });
    const args = launches(threadId)[1]!.args;
    expect(flag(args, "--model")).toBe(explicitPreset ? "fake-gateway/vendor/slash-model" : resumeModel);
    expect(flag(args, "--thinking")).toBe(explicitPreset ? "xhigh" : undefined);
    expect(overlays().at(-1)).toEqual({ memory: { backend: "off" }, 
      modelRoles: { ...(explicitPreset ? updatedRoles : originalRoles), plan: null },
      defaultThinkingLevel: explicitPreset ? "auto" : "high",
      tools: { approvalMode: "yolo" },
    });
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(explicitPreset
      ? { name: "selected", modelRoles: updatedRoles, defaultThinkingLevel: "auto", source: "global" }
      : originalSnapshot);
  },
  TIMEOUT_MS,
);

it("replaces the saved snapshot on a preset switch and retains it if the next rebuild fails", async () => {
  const quiet = { default: "fake-provider/fake-mini", advisor: "fake-provider/fake-mini" };
  const intense = { default: "fake-provider/fake-model", advisor: "fake-gateway/vendor/slash-model" };
  writeConfig({ modelPresets: { quiet: { modelRoles: quiet }, intense: { modelRoles: intense } } });
  const threadId = "thr_preset_saved_switch";
  const providerThreadId = await startThread(threadId, { model: "preset:quiet" });
  const snapshotPath = snapshotFile(threadId);
  expect((await turn(1, threadId, providerThreadId, { model: "preset:intense" })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, 0);
  const intenseSnapshot = { name: "intense", modelRoles: intense, source: "global" };
  expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(intenseSnapshot);
  vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", "1");
  const failed = await turn(2, threadId, providerThreadId, { model: "preset:quiet" });
  vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", undefined);
  expect(failed.error).toMatchObject({ code: -32000 });
  expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(intenseSnapshot);
  expect(replacements(threadId)).toHaveLength(1);
}, TIMEOUT_MS);

it("clears a stale preset snapshot when an explicit unknown preset falls back to native roles", async () => {
  writeConfig({ modelPresets: { selected: { modelRoles: { default: "fake-provider/fake-mini" } } } });
  const threadId = "thr_preset_saved_unknown";
  const providerThreadId = await startThread(threadId, { model: "preset:selected" });
  const snapshotPath = snapshotFile(threadId);
  expect(existsSync(snapshotPath)).toBe(true);
  await harness.request(1, "thread/stop", {
    threadId, providerThreadId, intent: "release", activeTurnId: null,
  });
  writeConfig({ modelPresets: {} });
  const resumed = await harness.request(2, "thread/resume", {
    threadId, providerThreadId, cwd: harness.workspaceDir, instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, model: "preset:selected" },
  });
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
  expect(overlays().at(-1)).toEqual({ memory: { backend: "off" },  memory: { backend: "off" }, tools: { approvalMode: "yolo" } });
  expect(existsSync(snapshotPath)).toBe(false);
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "provider.warning",
    details: `OMP model preset "selected" is unavailable. Continuing with OMP's native model roles.`,
  }));
}, TIMEOUT_MS);

it("carries a saved preset through relocation and a raw-model fork", async () => {
  const modelRoles = { default: "fake-provider/fake-mini", advisor: "fake-gateway/vendor/slash-model" };
  writeConfig({ modelPresets: { selected: { modelRoles } } });
  const threadId = "thr_preset_saved_relocate";
  const providerThreadId = await startThread(threadId, { model: "preset:selected" });
  expect((await turn(1, threadId, providerThreadId, { model: "fake-provider/fake-model" })).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, 0);
  const snapshot = JSON.parse(readFileSync(snapshotFile(threadId), "utf8"));
  await harness.request(2, "thread/stop", {
    threadId, providerThreadId, intent: "release", activeTurnId: null,
  });
  await experimental_closeAllForTests();
  const relocatedCwd = join(harness.workspaceDir, "relocated");
  mkdirSync(relocatedCwd);
  const resumed = await harness.request(3, "thread/resume", {
    threadId, providerThreadId, cwd: relocatedCwd, instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, model: "fake-provider/fake-model" },
  });
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
  const relocatedId = identitySchema.parse(resumed.result).providerThreadId;
  expect(relocatedId).not.toBe(providerThreadId);
  const relocatedDir = flag(launches(threadId)[1]!.args, "--session-dir")!;
  expect(JSON.parse(readFileSync(join(relocatedDir, "bb-model-preset.json"), "utf8"))).toEqual(snapshot);
  expect(overlays().at(-1)).toEqual({ memory: { backend: "off" },  modelRoles, tools: { approvalMode: "yolo" } });
  const forkId = "thr_preset_saved_fork";
  const forked = await harness.request(4, "thread/fork", {
    threadId: forkId, sourceProviderThreadId: relocatedId, cwd: relocatedCwd, instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, model: "fake-provider/fake-model" },
  });
  expect(forked.error, JSON.stringify(forked)).toBeUndefined();
  expect(JSON.parse(readFileSync(snapshotFile(forkId), "utf8"))).toEqual(snapshot);
  expect(overlays().at(-1)).toEqual({ memory: { backend: "off" },  modelRoles, tools: { approvalMode: "yolo" } });
}, TIMEOUT_MS);
