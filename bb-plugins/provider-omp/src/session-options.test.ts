import { describe, expect, it } from "vitest";
import {
  buildOmpLiveSessionOptions,
  parseOmpSessionControls,
} from "./session-options.js";

describe("parseOmpSessionControls", () => {
  it.each<Record<string, string | boolean> | undefined>([
    undefined,
    {},
    { futureControl: "enabled" },
    { futureControl: true },
    { slowModeEnabled: "native" },
  ])(
    "leaves native settings alone for omitted, native or unrecognized options: %j",
    (options) => {
      expect(parseOmpSessionControls(options)).toEqual({});
    },
  );

  it("ignores selections older threads saved for controls omp's config now owns", () => {
    expect(parseOmpSessionControls({
      steeringMode: "all",
      followUpMode: "bogus",
      interruptMode: "wait",
      autoCompactionEnabled: "off",
      autoRetryEnabled: true,
      cacheWarmingMode: "streaming",
      slowModeEnabled: "on",
    })).toEqual({ slowModeEnabled: true });
  });

  it.each([
    ["on", true],
    ["off", false],
  ] as const)("maps slowModeEnabled=%s to a typed override", (value, expected) => {
    expect(parseOmpSessionControls({ slowModeEnabled: value })).toEqual({ slowModeEnabled: expected });
  });

  it.each(["enabled", false, ""])("rejects invalid slowModeEnabled=%j with valid choices", (value) => {
    expect(() => parseOmpSessionControls({ slowModeEnabled: value })).toThrow(
      `Invalid OMP session option slowModeEnabled: ${JSON.stringify(value)}. Expected native, on, off.`,
    );
  });
});

describe("buildOmpLiveSessionOptions", () => {
  it.each([undefined, false])(
    "offers nothing without native slow mode support (%s)",
    (slowModeSupported) => {
      expect(buildOmpLiveSessionOptions(
        { slowModeEnabled: true },
        { slowModeSupported, slowModeScope: "global" },
      )).toEqual([]);
    },
  );

  it.each([
    { slowModeEnabled: undefined, value: "native" },
    { slowModeEnabled: false, value: "off" },
    { slowModeEnabled: true, value: "on" },
  ])("keeps Native available alongside supported slow mode ($value)", ({
    slowModeEnabled,
    value,
  }) => {
    expect(buildOmpLiveSessionOptions(
      { slowModeEnabled },
      { slowModeSupported: true, slowModeScope: "session" },
    )).toMatchObject([{
      id: "slowModeEnabled",
      type: "select",
      value,
      values: [
        { id: "native", label: "Native" },
        { id: "on", label: "Enabled" },
        { id: "off", label: "Disabled" },
      ],
    }]);
  });

  it("warns in both the label and description when slow mode affects every omp session", () => {
    const [option] = buildOmpLiveSessionOptions(
      { slowModeEnabled: false },
      { slowModeSupported: true, slowModeScope: "global" },
    );
    expect(option?.label).toContain("global");
    expect(option?.label).toContain("every omp session");
    expect(option?.description).toContain("every omp session");
  });

  it("describes session-scoped slow mode without a global warning", () => {
    const [option] = buildOmpLiveSessionOptions(
      {},
      { slowModeSupported: true, slowModeScope: "session" },
    );
    expect(option?.description).toContain("this omp session only");
    expect(option?.label).not.toContain("global");
    expect(option?.description).not.toContain("every omp session");
    expect(parseOmpSessionControls(Object.fromEntries(
      buildOmpLiveSessionOptions({}, { slowModeSupported: true })
        .map(({ id, value }) => [id, value]),
    ))).toEqual({});
  });
});
