import { describe, expect, it } from "vitest";
import {
  buildOmpLiveSessionOptions,
  OMP_SESSION_OPTIONS,
  parseOmpSessionControls,
  type OmpSessionControls,
} from "./session-options.js";

describe("parseOmpSessionControls", () => {
  it.each<Record<string, string | boolean> | undefined>([
    undefined,
    {},
    { futureControl: "enabled" },
    { futureControl: true },
  ])(
    "leaves native settings alone for omitted or unrecognized options: %j",
    (options) => {
      expect(parseOmpSessionControls(options)).toEqual({});
    },
  );

  it("does not turn descriptor defaults into session overrides", () => {
    const defaults = Object.fromEntries(
      (OMP_SESSION_OPTIONS ?? []).map(({ id, value }) => [id, value]),
    );
    expect(parseOmpSessionControls(defaults)).toEqual({});
  });

  it.each([
    ["steeringMode", "all", "all"],
    ["steeringMode", "one-at-a-time", "one-at-a-time"],
    ["followUpMode", "all", "all"],
    ["followUpMode", "one-at-a-time", "one-at-a-time"],
    ["interruptMode", "immediate", "immediate"],
    ["interruptMode", "wait", "wait"],
    ["autoCompactionEnabled", "on", true],
    ["autoCompactionEnabled", "off", false],
    ["autoRetryEnabled", "on", true],
    ["autoRetryEnabled", "off", false],
    ["cacheWarmingMode", "off", "off"],
    ["cacheWarmingMode", "streaming", "streaming"],
    ["cacheWarmingMode", "idle", "idle"],
  ] as const)("maps %s=%s to a typed override", (id, value, expected) => {
    expect(parseOmpSessionControls({ [id]: value })).toEqual({ [id]: expected });
  });

  it.each([
    "steeringMode",
    "followUpMode",
    "interruptMode",
    "autoCompactionEnabled",
    "autoRetryEnabled",
    "cacheWarmingMode",
  ])("omits %s when native is selected", (id) => {
    expect(parseOmpSessionControls({ [id]: "native" })).toEqual({});
  });

  it("keeps explicit choices alongside native and unknown selections", () => {
    expect(
      parseOmpSessionControls({
        steeringMode: "all",
        interruptMode: "native",
        autoCompactionEnabled: "off",
        cacheWarmingMode: "off",
        futureControl: true,
      }),
    ).toEqual({
      steeringMode: "all",
      autoCompactionEnabled: false,
      cacheWarmingMode: "off",
    });
  });

  it.each([
    ["steeringMode", "one", "all, one-at-a-time"],
    ["followUpMode", "ALL", "all, one-at-a-time"],
    ["interruptMode", "later", "immediate, wait"],
    ["autoCompactionEnabled", "false", "on, off"],
    ["autoRetryEnabled", "enabled", "on, off"],
    ["cacheWarmingMode", "on", "off, streaming, idle"],
    ["steeringMode", true, "all, one-at-a-time"],
    ["autoCompactionEnabled", false, "on, off"],
    ["autoRetryEnabled", true, "on, off"],
    ["cacheWarmingMode", "", "off, streaming, idle"],
  ] as const)("rejects invalid %s=%s with valid choices", (id, value, choices) => {
    expect(() => parseOmpSessionControls({ [id]: value })).toThrow(
      `Invalid OMP session option ${id}: ${JSON.stringify(value)}. Expected native, ${choices}.`,
    );
  });
});

describe("OMP_SESSION_OPTIONS", () => {
  it("offers native mode and only the implemented choices for each control", () => {
    expect(
      OMP_SESSION_OPTIONS?.map((option) => ({
        id: option.id,
        type: option.type,
        value: option.value,
        choices: option.type === "select" ? option.values.map(({ id }) => id) : [],
      })),
    ).toEqual([
      {
        id: "steeringMode",
        type: "select",
        value: "native",
        choices: ["native", "all", "one-at-a-time"],
      },
      {
        id: "followUpMode",
        type: "select",
        value: "native",
        choices: ["native", "all", "one-at-a-time"],
      },
      {
        id: "interruptMode",
        type: "select",
        value: "native",
        choices: ["native", "immediate", "wait"],
      },
      {
        id: "autoCompactionEnabled",
        type: "select",
        value: "native",
        choices: ["native", "on", "off"],
      },
      {
        id: "autoRetryEnabled",
        type: "select",
        value: "native",
        choices: ["native", "on", "off"],
      },
      {
        id: "cacheWarmingMode",
        type: "select",
        value: "native",
        choices: ["native", "off", "streaming", "idle"],
      },
    ]);
  });

  it.each(["autoCompactionEnabled", "autoRetryEnabled"])(
    "offers Native, Enabled, and Disabled for %s without guessing a boolean default",
    (id) => {
      expect(OMP_SESSION_OPTIONS?.find((option) => option.id === id)).toMatchObject({
        type: "select",
        value: "native",
        values: [
          { id: "native", label: "Native" },
          { id: "on", label: "Enabled" },
          { id: "off", label: "Disabled" },
        ],
      });
    },
  );
});

describe("buildOmpLiveSessionOptions", () => {
  it("retains all native choices until their actual session values are known", () => {
    expect(buildOmpLiveSessionOptions({})).toEqual(OMP_SESSION_OPTIONS);
  });

  it.each<{
    controls: OmpSessionControls;
    expected: Record<string, string>;
  }>([
    {
      controls: {
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        interruptMode: "immediate",
        autoCompactionEnabled: false,
        autoRetryEnabled: true,
        cacheWarmingMode: "off",
      },
      expected: {
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        interruptMode: "immediate",
        autoCompactionEnabled: "off",
        autoRetryEnabled: "on",
        cacheWarmingMode: "off",
      },
    },
    {
      controls: {
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        interruptMode: "wait",
        autoCompactionEnabled: true,
        autoRetryEnabled: false,
        cacheWarmingMode: "streaming",
      },
      expected: {
        steeringMode: "one-at-a-time",
        followUpMode: "all",
        interruptMode: "wait",
        autoCompactionEnabled: "on",
        autoRetryEnabled: "off",
        cacheWarmingMode: "streaming",
      },
    },
  ])("acknowledges actual values without offering native again: $controls", ({
    controls,
    expected,
  }) => {
    const options = buildOmpLiveSessionOptions(controls);
    expect(options).toHaveLength(6);
    expect(
      Object.fromEntries(options.map(({ id, value }) => [id, value])),
    ).toEqual(expected);
    for (const option of options) {
      expect(option.type).toBe("select");
      if (option.type === "select") {
        expect(option.values.map(({ id }) => id)).not.toContain("native");
        expect(option.values.map(({ id }) => id)).toContain(option.value);
      }
    }
  });

  it("keeps retry and cache warming selectable when get_state cannot report them", () => {
    const options = buildOmpLiveSessionOptions({
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      interruptMode: "wait",
      autoCompactionEnabled: false,
    });
    for (const id of ["autoRetryEnabled", "cacheWarmingMode"]) {
      expect(options.find((option) => option.id === id)).toEqual(
        OMP_SESSION_OPTIONS.find((option) => option.id === id),
      );
    }
  });

  it("updates a known cache mode without mutating catalog defaults or another session", () => {
    const before = buildOmpLiveSessionOptions({});
    const known = buildOmpLiveSessionOptions({ cacheWarmingMode: "idle" });
    expect(known.find(({ id }) => id === "cacheWarmingMode")).toMatchObject({
      value: "idle",
      values: [
        { id: "off", label: "Off" },
        { id: "streaming", label: "Streaming" },
        { id: "idle", label: "Idle" },
      ],
    });
    expect(before).toEqual(OMP_SESSION_OPTIONS);
    expect(before.find(({ id }) => id === "cacheWarmingMode")).toMatchObject({
      value: "native",
      values: expect.arrayContaining([{ id: "native", label: "Native" }]),
    });
  });
});
