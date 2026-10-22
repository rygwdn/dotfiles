import { describe, expect, it } from "vitest";
import { buildOmpSessionParams, buildOmpTurnOptions } from "./session-params.js";

describe("buildOmpSessionParams", () => {
  it("injects the bb thread id into the shell env and drops invalid keys", () => {
    expect(
      buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          envVars: {
            "BAD.KEY": "ignored",
            TEST_VAR: "123",
          },
        },
      }).shellEnvOverrides,
    ).toEqual({
      BB_THREAD_ID: "bb-thread-1",
      TEST_VAR: "123",
    });
  });

  it("passes contributed variables into OMP session parameters", () => {
    expect(
      buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options: {
          envVars: {
            POOL_E2E_URL: "http://127.0.0.1:3334/plugins/pool-e2e/auth",
          },
        },
      }).shellEnvOverrides,
    ).toMatchObject({
      POOL_E2E_URL: "http://127.0.0.1:3334/plugins/pool-e2e/auth",
    });
  });

  it("keeps preset picker ids opaque until the bridge resolves the native config", () => {
    const options = { model: "preset:best-coder", reasoningLevel: "native" };
    const params = buildOmpSessionParams({
      threadId: "bb-thread-1",
      cwd: "/tmp/worktree",
      instructionMode: "append",
      options,
    });
    expect(params.model).toBe("preset:best-coder");
    expect(params).not.toHaveProperty("thinkingLevel");
    expect(buildOmpTurnOptions(options)).toEqual({
      model: "preset:best-coder",
      fastModeEnabled: undefined,
      sessionControls: {},
      thinkingLevel: undefined,
    });
  });

  it.each([
    ["none", "off"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ])(
    "maps bb reasoning %s to OMP thinking %s for sessions and turns",
    (reasoningLevel, thinkingLevel) => {
      const options = { model: "openai/gpt-5.2", reasoningLevel };
      expect(
        buildOmpSessionParams({
          threadId: "bb-thread-1",
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options,
        }).thinkingLevel,
      ).toBe(thinkingLevel);
      expect(buildOmpTurnOptions(options)).toEqual({
        model: "openai/gpt-5.2",
        fastModeEnabled: undefined,
        sessionControls: {},
        thinkingLevel,
      });
    },
  );

  it.each(["ultra", "ultracode", undefined])(
    "does not invent an OMP thinking level for %s",
    (reasoningLevel) => {
      expect(
        buildOmpSessionParams({
          threadId: "bb-thread-1",
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options: { reasoningLevel },
        }),
      ).not.toHaveProperty("thinkingLevel");
      expect(
        buildOmpTurnOptions({ reasoningLevel }).thinkingLevel,
      ).toBeUndefined();
    },
  );

  it.each([
    ["fast", true],
    ["default", false],
    [undefined, undefined],
    ["unknown", undefined],
  ] as const)(
    "maps service tier %s to fast mode %s for sessions and turns",
    (serviceTier, fastModeEnabled) => {
      const options = { serviceTier };
      expect(
        buildOmpSessionParams({
          threadId: "bb-thread-1",
          cwd: "/tmp/worktree",
          instructionMode: "append",
          options,
        }).fastModeEnabled,
      ).toBe(fastModeEnabled);
      expect(buildOmpTurnOptions(options).fastModeEnabled).toBe(fastModeEnabled);
    },
  );

  it("leaves native fast mode unchanged when the service tier is omitted", () => {
    const params = buildOmpSessionParams({
      threadId: "bb-thread-1",
      cwd: "/tmp/worktree",
      instructionMode: "append",
      options: {},
    });
    expect(params).not.toHaveProperty("fastModeEnabled");
  });

  it("projects explicit session controls for startup and subsequent turns", () => {
    const options = {
      sessionOptions: {
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        interruptMode: "wait",
        autoCompactionEnabled: "off",
        autoRetryEnabled: "on",
        cacheWarmingMode: "streaming",
      },
    };
    const sessionControls = {
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      interruptMode: "wait",
      autoCompactionEnabled: false,
      autoRetryEnabled: true,
      cacheWarmingMode: "streaming",
    };
    expect(
      buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options,
      }).sessionControls,
    ).toEqual(sessionControls);
    expect(buildOmpTurnOptions(options).sessionControls).toEqual(sessionControls);
  });

  it.each<Record<string, string | boolean> | undefined>([
    undefined,
    {},
    {
      steeringMode: "native",
      followUpMode: "native",
      interruptMode: "native",
      autoCompactionEnabled: "native",
      autoRetryEnabled: "native",
      cacheWarmingMode: "native",
    },
    { futureOption: "enabled" },
  ])("does not override native session controls for %j", (sessionOptions) => {
    const options = { sessionOptions };
    expect(
      buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options,
      }),
    ).not.toHaveProperty("sessionControls");
    expect(buildOmpTurnOptions(options).sessionControls).toEqual({});
  });

  it("rejects invalid controls before constructing startup or turn options", () => {
    const options = { sessionOptions: { interruptMode: "later" } };
    expect(() =>
      buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode: "append",
        options,
      }),
    ).toThrow(/interruptMode.*later/u);
    expect(() => buildOmpTurnOptions(options)).toThrow(/interruptMode.*later/u);
  });

  it("routes instructions by mode", () => {
    const withMode = (instructionMode: "append" | "replace") =>
      buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode,
        options: { instructions: "  Focus on the failing tests first.  " },
      });

    expect(withMode("append")).toMatchObject({
      appendSystemPrompt: "Focus on the failing tests first.",
    });
    expect(withMode("append")).not.toHaveProperty("baseInstructions");
    expect(withMode("replace")).toMatchObject({
      baseInstructions: "Focus on the failing tests first.",
    });
    expect(withMode("replace")).not.toHaveProperty("appendSystemPrompt");
  });

  it.each(["append", "replace"] as const)(
    "preserves multiline instructions in %s mode",
    (instructionMode) => {
      const instructions = "First instruction.\n\nSecond instruction.";
      const params = buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode,
        options: { instructions },
      });
      const field =
        instructionMode === "append" ? "appendSystemPrompt" : "baseInstructions";
      expect(params[field]).toBe(instructions);
    },
  );

  it.each(["append", "replace"] as const)(
    "leaves native prompt defaults alone for blank %s instructions",
    (instructionMode) => {
      const params = buildOmpSessionParams({
        threadId: "bb-thread-1",
        cwd: "/tmp/worktree",
        instructionMode,
        options: { instructions: " \n\t " },
      });
      expect(params).not.toHaveProperty("baseInstructions");
      expect(params).not.toHaveProperty("appendSystemPrompt");
    },
  );
});
