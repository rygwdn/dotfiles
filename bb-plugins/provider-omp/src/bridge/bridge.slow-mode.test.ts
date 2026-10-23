import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import type { BridgeJsonRpcObject } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OMP_STATUS_STATE_KIND, ompStatusStateSchema } from "../extension-ui-contract.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const TEST_TIMEOUT_MS = 90_000;
const OPTIONS = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
  serviceTier: "default",
};
const objectSchema = z.record(z.string(), z.unknown());
const errorSchema = z.object({ code: z.number(), message: z.string() });
const sessionOptionsSchema = z.object({
  options: z.array(z.object({
    id: z.string(),
    type: z.literal("select"),
    label: z.string(),
    description: z.string().optional(),
    value: z.string(),
    values: z.array(z.object({ id: z.string(), label: z.string() })),
  })),
});
type SessionOption = z.infer<typeof sessionOptionsSchema>["options"][number];

function optionsFromDelta(delta: Record<string, unknown>): SessionOption[] | undefined {
  return delta.kind === "extension.state" && delta.extensionKind === "bb/session-options"
    ? sessionOptionsSchema.parse(delta.payload).options
    : undefined;
}

describe("native OMP slow-mode session controls", () => {
  let harness: FakeOmpBridgeHarness;
  let rpcLog: string;
  let nativeEvents: string;
  let nextId = 50_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-slow-mode-", initialize: true });
    rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    nativeEvents = join(harness.workspaceDir, "native-events.jsonl");
    writeFileSync(nativeEvents, "");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
    vi.stubEnv("FAKE_OMP_NATIVE_EVENTS_FILE", nativeEvents);
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    await harness.teardown();
  }, TEST_TIMEOUT_MS);

  function commands(type: string): Record<string, unknown>[] {
    if (!existsSync(rpcLog)) return [];
    return readFileSync(rpcLog, "utf8").split("\n").filter(Boolean)
      .map((line) => objectSchema.parse(JSON.parse(line)))
      .filter((command) => command.type === type)
      .map(({ id: _id, ...command }) => command);
  }

  function publishedOptions(threadId: string): SessionOption[][] {
    return harness.deltasOf(threadId).flatMap((delta) => {
      const options = optionsFromDelta(delta);
      return options === undefined ? [] : [options];
    });
  }

  function slowModeOption(threadId: string): SessionOption | undefined {
    return publishedOptions(threadId).at(-1)?.find(({ id }) => id === "slowModeEnabled");
  }

  function configurationLines(threadId: string): string[] {
    return harness.deltasOf(threadId).flatMap((delta) =>
      delta.kind === "extension.state" && delta.extensionKind === OMP_STATUS_STATE_KIND
        ? [ompStatusStateSchema.parse(delta.payload)] : [],
    ).at(-1)?.widgets.find(({ key }) => key === "bb:omp:configuration")?.lines ?? [];
  }

  async function start(threadId: string, options: BridgeJsonRpcObject = OPTIONS): Promise<string> {
    const response = await harness.startThread(threadId, { options });
    expect(response.error).toBeUndefined();
    return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  }

  function requestTurn(
    threadId: string,
    providerThreadId: string,
    options: BridgeJsonRpcObject = OPTIONS,
  ) {
    return harness.request(++nextId, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId: `creq_${randomUUID().replace(/-/gu, "").replace(/[01]/gu, "a").slice(0, 10)}`,
      input: [{ type: "text", text: "Keep the current native slow-mode settings", mentions: [] }],
      options,
    });
  }

  async function turn(
    threadId: string,
    providerThreadId: string,
    options: BridgeJsonRpcObject = OPTIONS,
  ): Promise<void> {
    const since = harness.deltasOf(threadId).length;
    const response = await requestTurn(threadId, providerThreadId, options);
    expect(response.error).toBeUndefined();
    await harness.waitForDelta(threadId,
      (delta) => delta.kind === "turn.boundary" && delta.status === "completed", since);
  }

  async function nativeUpdate(
    threadId: string,
    update: {
      slowModeSupported?: boolean;
      slowModeScope?: "session" | "global";
      sessionControls?: { slowModeEnabled: boolean };
    },
    matches: (option: SessionOption | undefined) => boolean,
  ): Promise<void> {
    const since = harness.deltasOf(threadId).length;
    appendFileSync(nativeEvents, `${JSON.stringify({ type: "config_update", ...update })}\n`);
    await harness.waitForDelta(threadId, (delta) => {
      const options = optionsFromDelta(delta);
      return options !== undefined && matches(options.find(({ id }) => id === "slowModeEnabled"));
    }, since);
  }

  it.each([
    { supported: false, scope: "session" },
    { supported: true, scope: "session" },
    { supported: true, scope: "global" },
  ] as const)("offers slow-mode controls only with native support ($supported, $scope)", async ({ supported, scope }) => {
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SUPPORTED", supported ? "1" : "0");
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SCOPE", scope);
    const threadId = "thr_slow_visibility";
    await start(threadId);
    expect(publishedOptions(threadId).length).toBeGreaterThan(0);
    const option = slowModeOption(threadId);
    if (!supported) {
      expect(option).toBeUndefined();
    } else {
      expect(option).toMatchObject({
        value: "off",
        values: [
          { id: "native", label: "Native" },
          { id: "on", label: "Enabled" },
          { id: "off", label: "Disabled" },
        ],
      });
      if (scope === "global") {
        expect(option?.label).toContain("global");
        expect(option?.label).toContain("every omp session");
        expect(option?.description).toContain("every omp session");
      } else {
        expect(option?.description).toContain("this omp session only");
        expect(option?.label).not.toContain("global");
        expect(option?.description).not.toContain("every omp session");
      }
    }
    expect(commands("set_slow_mode")).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each([false, true])("leaves Native and omitted selections untouched when native slow mode is %s", async (enabled) => {
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SUPPORTED", "1");
    vi.stubEnv("FAKE_OMP_SESSION_CONTROLS", JSON.stringify({ slowModeEnabled: enabled }));
    const threadId = "thr_slow_native";
    const nativeOptions = { ...OPTIONS, sessionOptions: { slowModeEnabled: "native" } };
    const providerThreadId = await start(threadId, nativeOptions);
    await turn(threadId, providerThreadId);
    await turn(threadId, providerThreadId, nativeOptions);
    expect(commands("set_slow_mode")).toEqual([]);
    expect(slowModeOption(threadId)?.value).toBe(enabled ? "on" : "off");
  }, TEST_TIMEOUT_MS);

  it("applies enabled and disabled choices only when the native value changes", async () => {
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SUPPORTED", "1");
    const threadId = "thr_slow_changes";
    const onOptions = { ...OPTIONS, sessionOptions: { slowModeEnabled: "on" } };
    const offOptions = { ...OPTIONS, sessionOptions: { slowModeEnabled: "off" } };
    const providerThreadId = await start(threadId, onOptions);
    expect(commands("set_slow_mode")).toEqual([{ type: "set_slow_mode", enabled: true }]);
    expect(slowModeOption(threadId)?.value).toBe("on");
    await turn(threadId, providerThreadId, onOptions);
    await turn(threadId, providerThreadId, offOptions);
    await turn(threadId, providerThreadId, offOptions);
    expect(commands("set_slow_mode")).toEqual([
      { type: "set_slow_mode", enabled: true },
      { type: "set_slow_mode", enabled: false },
    ]);
    expect(slowModeOption(threadId)?.value).toBe("off");
  }, TEST_TIMEOUT_MS);

  it("republishes options when support or scope changes without changing the enabled value", async () => {
    const threadId = "thr_slow_support_scope";
    await start(threadId);
    expect(slowModeOption(threadId)).toBeUndefined();
    const initialCount = publishedOptions(threadId).length;
    await nativeUpdate(threadId, { slowModeSupported: true, slowModeScope: "session" },
      (option) => option?.value === "off");
    expect(publishedOptions(threadId)).toHaveLength(initialCount + 1);
    expect(slowModeOption(threadId)?.description).toContain("this omp session only");
    await nativeUpdate(threadId, { slowModeScope: "global" },
      (option) => option?.label.includes("every omp session") === true);
    expect(publishedOptions(threadId)).toHaveLength(initialCount + 2);
    expect(slowModeOption(threadId)?.value).toBe("off");
    expect(slowModeOption(threadId)?.description).toContain("every omp session");
    await nativeUpdate(threadId, { slowModeSupported: false }, (option) => option === undefined);
    expect(publishedOptions(threadId)).toHaveLength(initialCount + 3);
    expect(commands("set_slow_mode")).toEqual([]);
    expect(commands("prompt")).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(["on", "off"])("rejects unsupported slow mode %s without sending a native setter", async (selection) => {
    const response = await harness.startThread("thr_slow_unsupported", {
      options: { ...OPTIONS, sessionOptions: { slowModeEnabled: selection } },
    });
    const error = errorSchema.parse(response.error);
    expect(error.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
    expect(error.message).toContain("not supported by the active OMP model");
    expect(error.message).toContain("Choose Native");
    expect(commands("set_slow_mode")).toEqual([]);
    expect(commands("prompt")).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("rejects a stale slow-mode selection after the active model loses support", async () => {
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SUPPORTED", "1");
    const threadId = "thr_slow_support_lost";
    const providerThreadId = await start(threadId);
    await nativeUpdate(threadId, { slowModeSupported: false }, (option) => option === undefined);
    const response = await requestTurn(threadId, providerThreadId, {
      ...OPTIONS, sessionOptions: { slowModeEnabled: "off" },
    });
    expect(errorSchema.parse(response.error).message).toContain("Choose Native");
    expect(commands("set_slow_mode")).toEqual([]);
    expect(commands("prompt")).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("preserves native changes after BB acknowledges an unchanged slow-mode selection, including rebuilds", async () => {
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SUPPORTED", "1");
    const threadId = "thr_slow_unchanged_selection";
    const originalOptions = { ...OPTIONS, envVars: { FAKE_OMP_ENV_MARKER: "original" } };
    const providerThreadId = await start(threadId, {
      ...originalOptions, sessionOptions: { slowModeEnabled: "on" },
    });
    const initialSetters = commands("set_slow_mode");
    expect(initialSetters).toEqual([{ type: "set_slow_mode", enabled: true }]);
    // Acknowledged session options are omitted from BB's later option diffs.
    await turn(threadId, providerThreadId, originalOptions);
    await nativeUpdate(threadId, { sessionControls: { slowModeEnabled: false } },
      (option) => option?.value === "off");
    const warning = "Slow mode: omp off (bb selected on)";
    await harness.waitFor(() => configurationLines(threadId).includes(warning), "the native slow-mode change");
    await turn(threadId, providerThreadId, originalOptions);
    await turn(threadId, providerThreadId, {
      ...originalOptions, sessionOptions: { slowModeEnabled: "native" },
    });
    expect(commands("set_slow_mode")).toEqual(initialSetters);
    await turn(threadId, providerThreadId, {
      ...OPTIONS, envVars: { FAKE_OMP_ENV_MARKER: "replacement" },
    });
    expect(commands("set_slow_mode")).toEqual(initialSetters);
    expect(slowModeOption(threadId)?.value).toBe("off");
    expect(configurationLines(threadId)).toContain(warning);
  }, TEST_TIMEOUT_MS);

  it.each(["session", "global"] as const)("refreshes native fast-mode state after changing %s-scoped slow mode", async (scope) => {
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SUPPORTED", "1");
    vi.stubEnv("FAKE_OMP_SLOW_MODE_SCOPE", scope);
    const threadId = "thr_slow_fast_interaction";
    const fastOptions = { ...OPTIONS, serviceTier: "fast" };
    const providerThreadId = await start(threadId, fastOptions);
    const fastSetters = commands("set_fast_mode");
    expect(fastSetters).toEqual([{ type: "set_fast_mode", enabled: true }]);
    await turn(threadId, providerThreadId, {
      ...fastOptions, sessionOptions: { slowModeEnabled: "on" },
    });
    const fastWarning = "Fast: omp disabled (bb selected enabled); active: no";
    if (scope === "session") expect(configurationLines(threadId)).toContain(fastWarning);
    else expect(configurationLines(threadId)).not.toContain(fastWarning);
    await turn(threadId, providerThreadId, fastOptions);
    expect(commands("set_fast_mode")).toEqual(fastSetters);
    expect(commands("set_slow_mode")).toEqual([{ type: "set_slow_mode", enabled: true }]);
    expect(slowModeOption(threadId)?.value).toBe("on");
  }, TEST_TIMEOUT_MS);
});
