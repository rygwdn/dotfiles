import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const TURN_OPTIONS_TEST_TIMEOUT_MS = 60_000;

const MINI = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
};
const FULL_MODEL = { ...MINI, model: "fake-provider/fake-model" };

const sessionReplacedParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  reason: z.string(),
  contextLost: z.boolean(),
});
const identityParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
});
const launchSchema = z.object({
  args: z.array(z.string()),
  threadId: z.string().nullable(),
  marker: z.string().nullable(),
});

let harness: FakeOmpBridgeHarness;
let rpcLogPath: string;
let launchLogPath: string;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-turn-options-",
    initialize: true,
    processLog: true,
  });
  rpcLogPath = join(harness.workspaceDir, "rpc.jsonl");
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLogPath);
  launchLogPath = join(harness.workspaceDir, "launches.jsonl");
  vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLogPath);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function sessionReplacements(
  threadId: string,
): z.infer<typeof sessionReplacedParamsSchema>[] {
  return harness.messages
    .filter((message) => message.method === "session/replaced")
    .map((message) => sessionReplacedParamsSchema.parse(message.params))
    .filter((params) => params.threadId === threadId);
}

function contextWindowSizes(threadId: string): number[] {
  return harness
    .deltasOf(threadId)
    .filter((delta) => delta.kind === "contextWindow")
    .map((delta) => delta.size)
    .filter((size): size is number => typeof size === "number");
}

function providerThreadIdFor(threadId: string): string {
  const identity = [...harness.messages]
    .reverse()
    .find(
      (message) =>
        message.method === "thread/identity" &&
        identityParamsSchema.parse(message.params).threadId === threadId,
    );
  const { providerThreadId } = identityParamsSchema.parse(identity?.params);
  return providerThreadId;
}

function turnStart(
  id: number,
  threadId: string,
  text: string,
  options: BridgeJsonRpcObject,
): Promise<BridgeJsonRpcOutputMessage> {
  return harness.request(id, "turn/start", {
    threadId,
    providerThreadId: providerThreadIdFor(threadId),
    clientRequestId: `creq_abcdefghi${"23456789"[id % 8] ?? "2"}`,
    input: [{ type: "text", text, mentions: [] }],
    options,
  });
}

function rpcCommands(): { type: string; enabled?: boolean | undefined }[] {
  return readFileSync(rpcLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => z.object({
      type: z.string(),
      enabled: z.boolean().optional(),
    }).parse(JSON.parse(line)));
}

function liveLaunches() {
  return readFileSync(launchLogPath, "utf8").trim().split("\n")
    .map((line) => launchSchema.parse(JSON.parse(line)))
    .filter((launch) => launch.args[1] === "rpc-ui");
}

it(
  "sets fast mode once per explicit tier change and returns to default before prompting",
  async () => {
    const threadId = "thr_turn_options_fast";
    await harness.startThread(threadId, { options: MINI });
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([]);
    const fast = { ...MINI, serviceTier: "fast" };

    expect((await turnStart(1, threadId, "first", fast)).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([
      { type: "set_fast_mode", enabled: true },
    ]);

    expect((await turnStart(2, threadId, "second", fast)).error).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toHaveLength(1);

    const normal = { ...MINI, serviceTier: "default" };
    expect((await turnStart(3, threadId, "third", normal)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([
      { type: "set_fast_mode", enabled: true },
      { type: "set_fast_mode", enabled: false },
    ]);
    expect(rpcCommands()
      .map((command) => command.type)
      .filter((type) => type === "set_fast_mode" || type === "prompt"))
      .toEqual(["set_fast_mode", "prompt", "prompt", "set_fast_mode", "prompt"]);
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "applies fast mode at launch and does not confuse inactive with disabled",
  async () => {
    vi.stubEnv("FAKE_OMP_FAST_MODE_INACTIVE", "1");
    const threadId = "thr_turn_options_fast_launch";
    const options = { ...MINI, serviceTier: "fast" };
    await harness.startThread(threadId, { options });
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([
      { type: "set_fast_mode", enabled: true },
    ]);

    expect((await turnStart(1, threadId, "first", options)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    expect((await turnStart(2, threadId, "second", options)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "preserves inherited fast mode when launch and turn options omit the service tier",
  async () => {
    vi.stubEnv("FAKE_OMP_FAST_MODE_ENABLED", "1");
    const threadId = "thr_turn_options_fast_default";
    await harness.startThread(threadId, { options: MINI });
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([]);
    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, 0);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "leaves a previously selected fast tier unchanged when later turns omit it",
  async () => {
    const threadId = "thr_turn_options_fast_omitted";
    await harness.startThread(threadId, { options: MINI });
    expect((await turnStart(1, threadId, "enable", { ...MINI, serviceTier: "fast" })).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);

    expect((await turnStart(2, threadId, "omit", MINI)).error).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);
    expect((await turnStart(3, threadId, "still omitted", MINI)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([
      { type: "set_fast_mode", enabled: true },
    ]);
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "disables inherited fast mode for an explicit default tier",
  async () => {
    vi.stubEnv("FAKE_OMP_FAST_MODE_ENABLED", "1");
    const threadId = "thr_turn_options_fast_explicit_default";
    const options = { ...MINI, serviceTier: "default" };
    await harness.startThread(threadId, { options });
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toEqual([
      { type: "set_fast_mode", enabled: false },
    ]);
    expect((await turnStart(1, threadId, "retain default", options)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, 0);
    expect(rpcCommands().filter((command) => command.type === "set_fast_mode")).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "rebuilds the session with environment from a later turn",
  async () => {
    const threadId = "thr_turn_options_env";
    const workspaceDir = harness.workspaceDir;
    const options = (marker: string) => ({
      ...MINI,
      envVars: { FAKE_OMP_ENV_MARKER: marker },
    });
    await harness.startThread(threadId, { options: options("first") });

    expect(
      (await turnStart(1, threadId, "first", options("first"))).error,
    ).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(
      (await turnStart(2, threadId, "second", options("second"))).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);

    expect(liveLaunches()).toEqual([
      { args: expect.arrayContaining(["--mode", "rpc-ui", "--cwd", workspaceDir]), threadId, marker: "first" },
      { args: expect.arrayContaining(["--mode", "rpc-ui", "--cwd", workspaceDir]), threadId, marker: "second" },
    ]);
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "preserves omitted environment options and clears overrides with an explicit empty object",
  async () => {
    const threadId = "thr_turn_options_clear_env";
    await harness.startThread(threadId, {
      options: { ...MINI, envVars: { FAKE_OMP_ENV_MARKER: "initial" } },
    });
    expect((await turnStart(1, threadId, "retain", MINI)).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(liveLaunches().map((launch) => launch.marker)).toEqual(["initial"]);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect((await turnStart(2, threadId, "clear", { ...MINI, envVars: {} })).error).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);
    expect(liveLaunches().map((launch) => ({ marker: launch.marker, threadId: launch.threadId }))).toEqual([
      { marker: "initial", threadId },
      { marker: null, threadId },
    ]);
    expect(sessionReplacements(threadId)).toHaveLength(1);

    expect((await turnStart(3, threadId, "still clear", { ...MINI, envVars: {} })).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(liveLaunches()).toHaveLength(2);
    expect(sessionReplacements(threadId)).toHaveLength(1);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "changes the live model without replacing the child or resetting the session",
  async () => {
    const threadId = "thr_turn_options_model";
    const start = await harness.startThread(threadId, { options: MINI });
    const originalProviderThreadId = providerThreadIdFor(threadId);
    expect(start.result).toMatchObject({ providerThreadId: originalProviderThreadId });
    const spawned = harness.readProcessLog().spawned;

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    let seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(contextWindowSizes(threadId)).toEqual([32_000]);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect(
      (await turnStart(2, threadId, "second", FULL_MODEL)).error,
    ).toBeUndefined();
    seen = await harness.waitForTurnBoundary(threadId, seen);

    expect(contextWindowSizes(threadId).at(-1)).toBe(200_000);
    expect(sessionReplacements(threadId)).toEqual([]);
    expect(harness.readProcessLog().spawned).toEqual(spawned);
    expect(
      harness
        .deltasOf(threadId)
        .filter((delta) => delta.kind === "session.reset"),
    ).toHaveLength(1);

    expect(
      (await turnStart(3, threadId, "third", FULL_MODEL)).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(sessionReplacements(threadId)).toEqual([]);
    expect(harness.readProcessLog().spawned).toEqual(spawned);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "changes the live thinking level without rebuilding the session",
  async () => {
    const threadId = "thr_turn_options_level";
    await harness.startThread(threadId, { options: MINI });
    const spawned = harness.readProcessLog().spawned;

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);
    expect(sessionReplacements(threadId)).toEqual([]);

    expect(
      (
        await turnStart(2, threadId, "second", {
          ...MINI,
          reasoningLevel: "high",
        })
      ).error,
    ).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);

    expect(sessionReplacements(threadId)).toEqual([]);
    expect(harness.readProcessLog().spawned).toEqual(spawned);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "compacts with the model the compaction turn selected",
  async () => {
    const threadId = "thr_turn_options_compact";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    const compaction = await harness.request(2, "turn/start", {
      threadId,
      providerThreadId: providerThreadIdFor(threadId),
      clientRequestId: "creq_abcdefghij",
      input: [
        {
          type: "text",
          text: "/compact",
          mentions: [
            {
              start: 0,
              end: 8,
              resource: {
                kind: "command",
                trigger: "/",
                name: "compact",
                source: "command",
                origin: "builtin",
                label: "compact",
                argumentHint: null,
              },
            },
          ],
        },
      ],
      options: FULL_MODEL,
    });
    expect(compaction.result).toMatchObject({ threadId });

    await harness.waitForDelta(
      threadId,
      (delta) => delta.kind === "contextWindow" && delta.size === 200_000,
      seen,
    );
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "fails a turn whose model cannot be resolved and keeps the live session",
  async () => {
    const threadId = "thr_turn_options_bad_model";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    expect(
      (
        await turnStart(2, threadId, "second", {
          ...MINI,
          model: "no-such-model",
        })
      ).error,
    ).toMatchObject({
      code: -32000,
      message: 'Failed to resolve OMP model "no-such-model"',
    });
    expect(sessionReplacements(threadId)).toEqual([]);

    expect((await turnStart(3, threadId, "third", MINI)).error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(contextWindowSizes(threadId).at(-1)).toBe(32_000);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "keeps serving the thread when the replacement child never starts",
  async () => {
    const threadId = "thr_turn_options_dead_replacement";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "first", MINI)).error).toBeUndefined();
    const seen = await harness.waitForTurnBoundary(threadId, 0);

    vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", "1");
    const failed = await turnStart(2, threadId, "second", {
      ...FULL_MODEL,
      envVars: { FAKE_OMP_ENV_MARKER: "replacement" },
    });
    vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", undefined);

    expect(failed.error).toMatchObject({ code: -32000 });
    expect(sessionReplacements(threadId)).toEqual([]);

    const recovered = await turnStart(3, threadId, "third", MINI);
    expect(recovered.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, seen);
    expect(contextWindowSizes(threadId).at(-1)).toBe(32_000);
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);

it(
  "steers the running turn without rebuilding on its options",
  async () => {
    const threadId = "thr_turn_options_steer";
    await harness.startThread(threadId, { options: MINI });

    expect((await turnStart(1, threadId, "/hold", MINI)).error).toBeUndefined();
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");

    const steer = await harness.request(2, "turn/steer", {
      threadId,
      providerThreadId: providerThreadIdFor(threadId),
      clientRequestId: "creq_abcdefghik",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steered", mentions: [] }],
      options: FULL_MODEL,
    });
    expect(steer.result).toMatchObject({ threadId });
    expect(sessionReplacements(threadId)).toEqual([]);
  },
  TURN_OPTIONS_TEST_TIMEOUT_MS,
);
