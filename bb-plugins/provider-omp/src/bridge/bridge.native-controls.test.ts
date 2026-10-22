import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import type { BridgeJsonRpcObject } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ompProviderDeclaration } from "../declaration.js";
import { DEFAULT_OMP_MODEL_FILTER } from "../model-curation.js";
import { OMP_STATUS_STATE_KIND, ompStatusStateSchema } from "../extension-ui-contract.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const TEST_TIMEOUT_MS = 90_000;
const CONFIGURATION_WIDGET = "bb:omp:configuration";
const GOAL_WIDGET = "bb:omp:goal";
const OPTIONS = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
  serviceTier: "default",
};
const GOAL = {
  id: "goal-native-controls",
  objective: "Finish the native controls integration",
  status: "active" as const,
  tokenBudget: 12_000,
  tokensUsed: 2_345,
  timeUsedSeconds: 17,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_017_000,
};
const INITIAL_CONTROLS = {
  steeringMode: "all",
  followUpMode: "all",
  interruptMode: "wait",
  autoCompactionEnabled: "off",
  autoRetryEnabled: "off",
  cacheWarmingMode: "streaming",
};
const NATIVE_CONTROLS = {
  steeringMode: "native",
  followUpMode: "native",
  interruptMode: "native",
  autoCompactionEnabled: "native",
  autoRetryEnabled: "native",
  cacheWarmingMode: "native",
};
const MATCHING_NATIVE_CONTROLS = {
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: "on",
  autoRetryEnabled: "native",
  cacheWarmingMode: "native",
};
const CONTROL_CHANGES = [
  { id: "steeringMode", value: "one-at-a-time", command: { type: "set_steering_mode", mode: "one-at-a-time" } },
  { id: "followUpMode", value: "one-at-a-time", command: { type: "set_follow_up_mode", mode: "one-at-a-time" } },
  { id: "interruptMode", value: "immediate", command: { type: "set_interrupt_mode", mode: "immediate" } },
  { id: "autoCompactionEnabled", value: "on", command: { type: "set_auto_compaction", enabled: true } },
  { id: "autoRetryEnabled", value: "on", command: { type: "set_auto_retry", enabled: true } },
  { id: "cacheWarmingMode", value: "idle", command: { type: "set_cache_warming", mode: "idle" } },
] as const;
const CONTROL_COMMAND_TYPES: Record<string, true> = {
  set_steering_mode: true,
  set_follow_up_mode: true,
  set_interrupt_mode: true,
  set_auto_compaction: true,
  set_auto_retry: true,
  set_cache_warming: true,
};
const PICKER_COMMAND_TYPES: Record<string, true> = {
  set_model: true,
  set_thinking_level: true,
  set_fast_mode: true,
};
const objectSchema = z.record(z.string(), z.unknown());
const identitySchema = z.object({ threadId: z.string(), providerThreadId: z.string() });
const sessionOptionsSchema = z.object({
  options: z.array(z.object({
    id: z.string(),
    type: z.literal("select"),
    value: z.string(),
    values: z.array(z.object({ id: z.string() })),
  })),
});

describe("native OMP goals, configuration, and session controls", () => {
  let harness: FakeOmpBridgeHarness;
  let rpcLog: string;
  let eventLog: string;
  let initializeResult: unknown;
  let nextId = 40_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({
      prefix: "bb-omp-native-controls-",
      initialize: false,
    });
    rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    eventLog = join(harness.workspaceDir, "events.jsonl");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
    vi.stubEnv("FAKE_OMP_EVENT_LOG", eventLog);
    const response = await harness.request(++nextId, "initialize", {
      protocolVersion: 2,
      client: { name: "native-controls-test", version: "0" },
      grammarVersions: [3, 3],
    });
    expect(response.error).toBeUndefined();
    initializeResult = response.result;
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    await harness.teardown();
  }, TEST_TIMEOUT_MS);

  function readJsonLines(path: string): Record<string, unknown>[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean)
      .map((line) => objectSchema.parse(JSON.parse(line)));
  }

  function commands(types: Readonly<Record<string, true>>): Record<string, unknown>[] {
    return readJsonLines(rpcLog)
      .filter((command) => typeof command.type === "string" && types[command.type] === true)
      .map(({ id: _id, ...command }) => command);
  }

  function goalCommands(): Record<string, unknown>[] {
    return commands({ goal: true });
  }

  function statusFromDelta(delta: Record<string, unknown>) {
    if (delta.kind !== "extension.state" || delta.extensionKind !== OMP_STATUS_STATE_KIND) return undefined;
    return ompStatusStateSchema.parse(delta.payload);
  }

  function widgetLines(threadId: string, key: string): string[] | undefined {
    const latest = harness.deltasOf(threadId).flatMap((delta) => {
      const state = statusFromDelta(delta);
      return state === undefined ? [] : [state];
    }).at(-1);
    return latest?.widgets.find((widget) => widget.key === key)?.lines;
  }

  async function waitForWidget(
    threadId: string,
    key: string,
    lines: string[] | null,
    since = 0,
  ): Promise<void> {
    await harness.waitForDelta(threadId, (delta) => {
      const state = statusFromDelta(delta);
      if (state === undefined) return false;
      const widget = state.widgets.find((candidate) => candidate.key === key);
      return lines === null
        ? widget === undefined
        : lines.every((line) => widget?.lines.includes(line));
    }, since);
    if (lines === null) expect(widgetLines(threadId, key)).toBeUndefined();
    else expect(widgetLines(threadId, key)).toEqual(expect.arrayContaining(lines));
  }

  function providerThreadIdFor(threadId: string): string {
    const identity = [...harness.messages].reverse().find((message) =>
      message.method === "thread/identity" && identitySchema.parse(message.params).threadId === threadId,
    );
    return identitySchema.parse(identity?.params).providerThreadId;
  }

  async function start(threadId: string, options: BridgeJsonRpcObject = OPTIONS): Promise<string> {
    const response = await harness.startThread(threadId, { options });
    expect(response.error).toBeUndefined();
    return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  }

  async function turn(
    threadId: string,
    text: string,
    options: BridgeJsonRpcObject = OPTIONS,
    goalMention = false,
  ): Promise<Record<string, unknown>[]> {
    const since = harness.deltasOf(threadId).length;
    const clientRequestId = `creq_${randomUUID().replace(/-/gu, "").replace(/[01]/gu, "a").slice(0, 10)}`;
    const response = await harness.request(++nextId, "turn/start", {
      threadId,
      providerThreadId: providerThreadIdFor(threadId),
      clientRequestId,
      input: [{
        type: "text",
        text,
        mentions: goalMention ? [{
          start: 0,
          end: 5,
          resource: {
            kind: "command",
            trigger: "/",
            name: "goal",
            source: "command",
            origin: "builtin",
            label: "goal",
            argumentHint: null,
          },
        }] : [],
      }],
      options,
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ threadId });
    await harness.waitForDelta(threadId,
      (delta) => delta.kind === "turn.boundary" && delta.status === "completed", since);
    const deltas = harness.deltasOf(threadId).slice(since);
    expect(deltas).toContainEqual({ kind: "input.accepted", clientRequestId });
    return deltas;
  }

  function expectNoNativeAgentTurn(): void {
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_start")).toEqual([]);
  }

  function expectLocalGoalTurn(deltas: Record<string, unknown>[]): void {
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  }

  function expectSessionOptions(threadId: string, selected: Record<string, string>): void {
    const snapshot = [...harness.deltasOf(threadId)].reverse().find((delta) =>
      delta.kind === "extension.state" && delta.extensionKind === "bb/session-options",
    );
    expect(snapshot).toBeDefined();
    const { options } = sessionOptionsSchema.parse(snapshot?.payload);
    expect(options).toHaveLength(6);
    expect(Object.fromEntries(options.map(({ id, value }) => [id, value]))).toEqual(selected);
    for (const option of options) {
      expect(option.values.some(({ id }) => id === "native")).toBe(option.value === "native");
    }
  }

  it("advertises the goal composer but not native goal clearing", () => {
    expect(ompProviderDeclaration(DEFAULT_OMP_MODEL_FILTER).composerActions).toContain("goal");
    expect(initializeResult).toMatchObject({ capabilities: { threadGoalClear: false } });
  });

  it("hydrates a budgeted goal while hiding matching native configuration before any turn", async () => {
    const threadId = "thr_native_goal_startup";
    const goal = { ...GOAL, status: "budget-limited" };
    vi.stubEnv("FAKE_OMP_GOAL_STATE", JSON.stringify({ enabled: true, mode: "active", goal }));
    await start(threadId);
    await waitForWidget(threadId, GOAL_WIDGET, [
      "Goal: budget-limited", goal.objective, "Tokens: 2345 / 12000",
    ]);
    expect(widgetLines(threadId, GOAL_WIDGET)).toEqual([
      "Goal: budget-limited", goal.objective, "Tokens: 2345 / 12000",
    ]);
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null);
    expect(commands({ prompt: true })).toEqual([]);
    expectNoNativeAgentTurn();
    expect(harness.deltasOf(threadId).filter((delta) =>
      delta.kind === "turn.open" || delta.kind === "turn.boundary",
    )).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(["/goal", "/goal set"])("maps composer text %s <objective> to structured creation", async (prefix) => {
    const threadId = "thr_native_goal_composer";
    const objective = "Ship a useful native goal, with its full objective";
    await start(threadId);
    expectLocalGoalTurn(await turn(threadId, `${prefix} ${objective}`, OPTIONS, true));
    await waitForWidget(threadId, GOAL_WIDGET, ["Goal: active", objective, "Tokens: 0 / unlimited"]);
    expect(goalCommands()).toEqual([{ type: "goal", op: "create", objective }]);
    expect(commands({ prompt: true })).toEqual([]);
    expectNoNativeAgentTurn();
  }, TEST_TIMEOUT_MS);

  it("gets, pauses, resumes, and drops the native goal without invoking an agent", async () => {
    const threadId = "thr_native_goal_operations";
    vi.stubEnv("FAKE_OMP_GOAL_STATE", JSON.stringify({ enabled: true, mode: "active", goal: GOAL }));
    await start(threadId);
    for (const text of ["/goal", "/goal show"]) {
      expectLocalGoalTurn(await turn(threadId, text));
      expect(widgetLines(threadId, GOAL_WIDGET)).toEqual([
        "Goal: active", GOAL.objective, "Tokens: 2345 / 12000",
      ]);
    }
    expectLocalGoalTurn(await turn(threadId, "/goal pause"));
    await waitForWidget(threadId, GOAL_WIDGET, ["Goal: paused", GOAL.objective, "Tokens: 2345 / 12000"]);
    expectLocalGoalTurn(await turn(threadId, "/goal resume"));
    await waitForWidget(threadId, GOAL_WIDGET, ["Goal: active", GOAL.objective, "Tokens: 2345 / 12000"]);
    const beforeDrop = harness.deltasOf(threadId).length;
    expectLocalGoalTurn(await turn(threadId, "/goal drop"));
    await waitForWidget(threadId, GOAL_WIDGET, null, beforeDrop);
    expect(goalCommands()).toEqual(["get", "get", "pause", "resume", "drop"].map((op) => ({ type: "goal", op })));
    expect(commands({ prompt: true })).toEqual([]);
    expectNoNativeAgentTurn();
  }, TEST_TIMEOUT_MS);

  it("rejects unsupported goal-clear requests without dropping the native goal", async () => {
    const threadId = "thr_native_goal_clear";
    vi.stubEnv("FAKE_OMP_GOAL_STATE", JSON.stringify({ enabled: true, mode: "active", goal: GOAL }));
    const providerThreadId = await start(threadId);
    await waitForWidget(threadId, GOAL_WIDGET, [GOAL.objective]);
    const before = harness.deltasOf(threadId).length;
    for (const identity of [
      { threadId, providerThreadId },
      { threadId, providerThreadId: "omp_stale_identity" },
      { threadId: "thr_native_goal_missing", providerThreadId },
    ]) {
      const rejected = await harness.request(++nextId, "thread/goal/clear", identity);
      expect(rejected.error).toMatchObject({ code: BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND });
      expect(rejected.result).toBeUndefined();
    }
    expect(goalCommands()).toEqual([]);
    expect(harness.deltasOf(threadId)).toHaveLength(before);
    expect(widgetLines(threadId, GOAL_WIDGET)).toEqual([
      "Goal: active", GOAL.objective, "Tokens: 2345 / 12000",
    ]);
    expectNoNativeAgentTurn();
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "turn.open")).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("publishes unsolicited goal updates and removes dropped or null goals without a turn", async () => {
    const threadId = "thr_native_goal_events";
    const nativeEvents = join(harness.workspaceDir, "native-events.jsonl");
    writeFileSync(nativeEvents, "");
    vi.stubEnv("FAKE_OMP_NATIVE_EVENTS_FILE", nativeEvents);
    await start(threadId);
    const before = harness.deltasOf(threadId).length;
    const updatedGoal = {
      ...GOAL,
      objective: "A goal changed directly inside OMP",
      status: "paused",
      tokensUsed: 8_765,
      tokenBudget: 9_000,
    };
    let since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({
      type: "goal_updated", goal: updatedGoal,
      state: { enabled: true, mode: "active", goal: updatedGoal },
    })}\n`);
    await waitForWidget(threadId, GOAL_WIDGET, [
      "Goal: paused", updatedGoal.objective, "Tokens: 8765 / 9000",
    ], since);

    since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({ type: "goal_updated", goal: { ...updatedGoal, status: "dropped" } })}\n`);
    await waitForWidget(threadId, GOAL_WIDGET, null, since);
    since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({
      type: "goal_updated", goal: GOAL,
      state: { enabled: true, mode: "active", goal: GOAL },
    })}\n`);
    await waitForWidget(threadId, GOAL_WIDGET, ["Goal: active", GOAL.objective], since);
    since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({ type: "goal_updated", goal: null })}\n`);
    await waitForWidget(threadId, GOAL_WIDGET, null, since);
    expect(goalCommands()).toEqual([]);
    expect(commands({ prompt: true })).toEqual([]);
    expect(harness.deltasOf(threadId).slice(before).filter((delta) =>
      delta.kind === "input.accepted" || delta.kind === "turn.open" || delta.kind === "turn.boundary",
    )).toEqual([]);
    expectNoNativeAgentTurn();
  }, TEST_TIMEOUT_MS);

  it.each([
    { inactive: false, active: "yes" },
    { inactive: true, active: "no" },
  ])("shows slash configuration and retains it across repeated BB choices (inactive=$inactive)", async ({ inactive, active }) => {
    if (inactive) vi.stubEnv("FAKE_OMP_FAST_MODE_INACTIVE", "1");
    const threadId = "thr_native_configuration";
    await start(threadId);
    const beforeSetters = commands(PICKER_COMMAND_TYPES);
    await turn(threadId, "/model fake-provider/fake-model");
    await waitForWidget(threadId, CONFIGURATION_WIDGET, ["Model: omp fake-provider/fake-model (bb selected fake-provider/fake-mini)"]);
    await turn(threadId, "/effort auto");
    await waitForWidget(threadId, CONFIGURATION_WIDGET, ["Thinking: omp high (bb selected medium); configured: auto; resolved: high"]);
    await turn(threadId, "/fast on");
    const nativeLines = [
      "Model: omp fake-provider/fake-model (bb selected fake-provider/fake-mini)",
      "Thinking: omp high (bb selected medium); configured: auto; resolved: high",
      `Fast: omp enabled (bb selected disabled); active: ${active}`,
    ];
    await waitForWidget(threadId, CONFIGURATION_WIDGET, nativeLines);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual(nativeLines);
    expect(commands(PICKER_COMMAND_TYPES)).toEqual(beforeSetters);
    expectNoNativeAgentTurn();

    await turn(threadId, "Keep the native choices", { ...OPTIONS });
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual(expect.arrayContaining(nativeLines));
    expect(commands(PICKER_COMMAND_TYPES)).toEqual(beforeSetters);
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_start")).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("avoids setters for changed BB choices already matching native and applies genuinely changed choices once", async () => {
    const threadId = "thr_native_changed_pickers";
    await start(threadId);
    await turn(threadId, "/model fake-provider/fake-model");
    await turn(threadId, "/effort high");
    await turn(threadId, "/fast on");
    const matching = { ...OPTIONS, model: "fake-provider/fake-model", reasoningLevel: "high", serviceTier: "fast" };
    const beforeMatching = commands(PICKER_COMMAND_TYPES);
    await turn(threadId, "The picker now matches the native choices", matching);
    expect(commands(PICKER_COMMAND_TYPES)).toEqual(beforeMatching);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();

    await turn(threadId, "Change the pickers back", { ...OPTIONS });
    const expectedSetters = [
      ...beforeMatching,
      { type: "set_model", provider: "fake-provider", modelId: "fake-mini" },
      { type: "set_thinking_level", level: "medium" },
      { type: "set_fast_mode", enabled: false },
    ];
    expect(commands(PICKER_COMMAND_TYPES)).toEqual(expectedSetters);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
    await turn(threadId, "Repeat the same picker record", { ...OPTIONS });
    expect(commands(PICKER_COMMAND_TYPES)).toEqual(expectedSetters);
  }, TEST_TIMEOUT_MS);

  it("preserves slash selections and their separate BB picker baseline across an environment rebuild", async () => {
    const threadId = "thr_native_environment_rebuild";
    const originalOptions = { ...OPTIONS, envVars: { FAKE_OMP_ENV_MARKER: "original" } };
    await start(threadId, originalOptions);
    await turn(threadId, "/model fake-provider/fake-model", originalOptions);
    await turn(threadId, "/effort auto", originalOptions);
    await turn(threadId, "/fast on", originalOptions);
    const replacementOptions = { ...OPTIONS, envVars: { FAKE_OMP_ENV_MARKER: "replacement" } };
    await turn(threadId, "Rebuild using the native configuration", replacementOptions);
    const replacements = harness.messages.filter((message) =>
      message.method === "session/replaced" && objectSchema.parse(message.params).threadId === threadId,
    );
    expect(replacements).toHaveLength(1);
    const configuration = widgetLines(threadId, CONFIGURATION_WIDGET);
    expect(configuration).toEqual(expect.arrayContaining([
      "Model: omp fake-provider/fake-model (bb selected fake-provider/fake-mini)",
      "Thinking: omp high (bb selected medium); configured: auto; resolved: high",
      "Fast: omp enabled (bb selected disabled); active: yes",
    ]));
    const afterRebuild = commands(PICKER_COMMAND_TYPES);
    await turn(threadId, "The unchanged BB snapshot must still not override native", { ...replacementOptions });
    expect(commands(PICKER_COMMAND_TYPES)).toEqual(afterRebuild);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual(configuration);
  }, TEST_TIMEOUT_MS);

  it("hides thinking details when native resolution matches BB's selected level", async () => {
    const threadId = "thr_native_matching_thinking";
    const options = { ...OPTIONS, reasoningLevel: "high" };
    await start(threadId, options);
    await turn(threadId, "/effort auto", options);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
    expect(commands(PICKER_COMMAND_TYPES)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("compares bare BB model IDs to the resolved provider/model identity", async () => {
    const threadId = "thr_native_bare_model";
    const options = { ...OPTIONS, model: "fake-mini" };
    await start(threadId, options);
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null);
    await turn(threadId, "/model fake-provider/fake-model", options);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual([
      "Model: omp fake-provider/fake-model (bb selected fake-provider/fake-mini)",
    ]);
    await turn(threadId, "/model fake-provider/fake-mini", options);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it("does not treat unselected BB pickers as native overrides", async () => {
    const threadId = "thr_native_no_pickers";
    await start(threadId, FULL_PERMISSION_OPTIONS);
    await turn(threadId, "/model fake-provider/fake-model", FULL_PERMISSION_OPTIONS);
    await turn(threadId, "/effort auto", FULL_PERMISSION_OPTIONS);
    await turn(threadId, "/fast on", FULL_PERMISSION_OPTIONS);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
    expect(commands(PICKER_COMMAND_TYPES)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each([
    { key: "steeringMode", initial: "all", changed: "one-at-a-time", label: "Steering" },
    { key: "followUpMode", initial: "all", changed: "one-at-a-time", label: "Follow-up" },
    { key: "interruptMode", initial: "wait", changed: "immediate", label: "Interrupt" },
    { key: "autoCompactionEnabled", initial: false, changed: true, label: "Auto-compaction" },
  ])("shows only $key when it changes away from the user's startup default", async ({ key, initial, changed, label }) => {
    const threadId = `thr_native_default_${key}`;
    const nativeEvents = join(harness.workspaceDir, "native-events.jsonl");
    writeFileSync(nativeEvents, "");
    vi.stubEnv("FAKE_OMP_NATIVE_EVENTS_FILE", nativeEvents);
    vi.stubEnv("FAKE_OMP_SESSION_CONTROLS", JSON.stringify({ [key]: initial }));
    vi.stubEnv("FAKE_OMP_GOAL_STATE", JSON.stringify({ enabled: true, mode: "active", goal: GOAL }));
    await start(threadId);
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null);
    let since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({
      type: "config_update", sessionControls: { [key]: changed },
    })}\n`);
    const liveText = typeof changed === "boolean" ? (changed ? "on" : "off") : changed;
    const defaultText = typeof initial === "boolean" ? (initial ? "on" : "off") : initial;
    const line = `${label}: omp ${liveText} (omp default ${defaultText})`;
    await waitForWidget(threadId, CONFIGURATION_WIDGET, [line], since);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual([line]);
    expect(widgetLines(threadId, GOAL_WIDGET)).toEqual([
      "Goal: active", GOAL.objective, "Tokens: 2345 / 12000",
    ]);
    expectSessionOptions(threadId, MATCHING_NATIVE_CONTROLS);
    since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({
      type: "config_update", sessionControls: { [key]: initial },
    })}\n`);
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null, since);
    expect(widgetLines(threadId, GOAL_WIDGET)).toBeDefined();
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual([]);
    expectNoNativeAgentTurn();
  }, TEST_TIMEOUT_MS);

  it("compares controls with the last BB choice after acknowledgements and environment rebuilds", async () => {
    const threadId = "thr_native_chosen_control";
    const nativeEvents = join(harness.workspaceDir, "native-events.jsonl");
    writeFileSync(nativeEvents, "");
    vi.stubEnv("FAKE_OMP_NATIVE_EVENTS_FILE", nativeEvents);
    await start(threadId, {
      ...OPTIONS, sessionOptions: { steeringMode: "all" },
      envVars: { FAKE_OMP_ENV_MARKER: "original" },
    });
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null);
    const originalOptions = { ...OPTIONS, envVars: { FAKE_OMP_ENV_MARKER: "original" } };
    await turn(threadId, "BB acknowledged its selection", originalOptions);
    const since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({
      type: "config_update", sessionControls: { steeringMode: "one-at-a-time" },
    })}\n`);
    const line = "Steering: omp one-at-a-time (bb selected all)";
    await waitForWidget(threadId, CONFIGURATION_WIDGET, [line], since);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual([line]);
    const replacementOptions = { ...OPTIONS, envVars: { FAKE_OMP_ENV_MARKER: "replacement" } };
    await turn(threadId, "Keep native state across the environment rebuild", replacementOptions);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toEqual([line]);
    expectSessionOptions(threadId, MATCHING_NATIVE_CONTROLS);
    const beforeMatching = commands(CONTROL_COMMAND_TYPES);
    await turn(threadId, "BB now chooses the live value", {
      ...replacementOptions, sessionOptions: { steeringMode: "one-at-a-time" },
    });
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual(beforeMatching);
  }, TEST_TIMEOUT_MS);

  it("applies all six controls at startup and only each changed key on later turns", async () => {
    const threadId = "thr_native_session_controls";
    let selections = { ...INITIAL_CONTROLS };
    await start(threadId, { ...OPTIONS, sessionOptions: selections });
    const startupCommands = [
      { type: "set_steering_mode", mode: "all" },
      { type: "set_follow_up_mode", mode: "all" },
      { type: "set_interrupt_mode", mode: "wait" },
      { type: "set_auto_compaction", enabled: false },
      { type: "set_auto_retry", enabled: false },
      { type: "set_cache_warming", mode: "streaming" },
    ];
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual(startupCommands);
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null);
    expectSessionOptions(threadId, selections);
    await turn(threadId, "Repeat all six controls", { ...OPTIONS, sessionOptions: { ...selections } });
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual(startupCommands);

    const applied: Record<string, unknown>[] = [...startupCommands];
    for (const change of CONTROL_CHANGES) {
      selections = { ...selections, [change.id]: change.value };
      await turn(threadId, `Change only ${change.id}`, { ...OPTIONS, sessionOptions: selections });
      applied.push(change.command);
      expect(commands(CONTROL_COMMAND_TYPES)).toEqual(applied);
      expectSessionOptions(threadId, selections);
    }
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
    await turn(threadId, "Repeat the changed controls", { ...OPTIONS, sessionOptions: { ...selections } });
    await turn(threadId, "Native does not reset explicit native state", { ...OPTIONS, sessionOptions: NATIVE_CONTROLS });
    await turn(threadId, "Omitting controls also leaves native state alone", { ...OPTIONS });
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual(applied);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
    expectSessionOptions(threadId, selections);
  }, TEST_TIMEOUT_MS);

  it.each<{ name: string; options: BridgeJsonRpcObject }>([
    { name: "absent", options: {} },
    { name: "native", options: { sessionOptions: NATIVE_CONTROLS } },
    { name: "already matching native", options: { sessionOptions: MATCHING_NATIVE_CONTROLS } },
  ])("leaves $name session defaults untouched at startup and across repeated records", async ({ name, options }) => {
    const threadId = `thr_native_default_controls_${name.replaceAll(" ", "_")}`;
    await start(threadId, { ...OPTIONS, ...options });
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual([]);
    await waitForWidget(threadId, CONFIGURATION_WIDGET, null);
    expectSessionOptions(threadId, MATCHING_NATIVE_CONTROLS);
    await turn(threadId, "Keep the startup defaults", { ...OPTIONS, ...options });
    await turn(threadId, "Choose the already matching known native values", {
      ...OPTIONS, sessionOptions: { ...MATCHING_NATIVE_CONTROLS },
    });
    await turn(threadId, "Repeat the matching record", {
      ...OPTIONS, sessionOptions: { ...MATCHING_NATIVE_CONTROLS },
    });
    expect(commands(CONTROL_COMMAND_TYPES)).toEqual([]);
    expectSessionOptions(threadId, MATCHING_NATIVE_CONTROLS);
    expect(widgetLines(threadId, CONFIGURATION_WIDGET)).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});
