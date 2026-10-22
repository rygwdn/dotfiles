import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

export interface OmpSessionControls {
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  interruptMode?: "immediate" | "wait";
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  cacheWarmingMode?: "off" | "streaming" | "idle";
  slowModeEnabled?: boolean;
}

export const OMP_SESSION_OPTIONS: NonNullable<AvailableModel["sessionOptions"]> = [
  {
    id: "steeringMode",
    label: "Steering delivery",
    description: "How OMP delivers queued steering messages.",
    type: "select",
    value: "native",
    values: [
      { id: "native", label: "Native" },
      { id: "all", label: "All queued messages" },
      { id: "one-at-a-time", label: "One at a time" },
    ],
  },
  {
    id: "followUpMode",
    label: "Follow-up delivery",
    description: "How OMP delivers queued follow-up messages.",
    type: "select",
    value: "native",
    values: [
      { id: "native", label: "Native" },
      { id: "all", label: "All queued messages" },
      { id: "one-at-a-time", label: "One at a time" },
    ],
  },
  {
    id: "interruptMode",
    label: "Steering interruption",
    description: "Whether steering interrupts tools immediately or waits.",
    type: "select",
    value: "native",
    values: [
      { id: "native", label: "Native" },
      { id: "immediate", label: "Immediate" },
      { id: "wait", label: "Wait" },
    ],
  },
  {
    id: "autoCompactionEnabled",
    label: "Automatic compaction",
    description: "Automatically compact this session when context fills up.",
    type: "select",
    value: "native",
    values: [
      { id: "native", label: "Native" },
      { id: "on", label: "Enabled" },
      { id: "off", label: "Disabled" },
    ],
  },
  {
    id: "autoRetryEnabled",
    label: "Automatic retry",
    description: "Automatically retry recoverable errors in this session.",
    type: "select",
    value: "native",
    values: [
      { id: "native", label: "Native" },
      { id: "on", label: "Enabled" },
      { id: "off", label: "Disabled" },
    ],
  },
  {
    id: "cacheWarmingMode",
    label: "Cache warming",
    description: "Override cache warming for this session only.",
    type: "select",
    value: "native",
    values: [
      { id: "native", label: "Native" },
      { id: "off", label: "Off" },
      { id: "streaming", label: "Streaming" },
      { id: "idle", label: "Idle" },
    ],
  },
];

export function buildOmpLiveSessionOptions(
  controls: OmpSessionControls,
  nativeState: {
    slowModeSupported?: boolean;
    slowModeScope?: "session" | "global";
  } = {},
): NonNullable<AvailableModel["sessionOptions"]> {
  const options = OMP_SESSION_OPTIONS.map((option) => {
    const value = controls[option.id as keyof OmpSessionControls];
    if (value === undefined || option.type !== "select") return option;
    return {
      ...option,
      value: typeof value === "boolean" ? (value ? "on" : "off") : value,
      values: option.values.filter(({ id }) => id !== "native"),
    };
  });
  if (nativeState.slowModeSupported) {
    const global = nativeState.slowModeScope === "global";
    options.push({
      id: "slowModeEnabled",
      label: global ? "Slow mode — global, affects every omp session" : "Slow mode",
      description: global
        ? "Changing slow mode affects every omp session, not just this thread."
        : nativeState.slowModeScope === "session"
          ? "Control slow mode for this omp session only."
          : "Control slow mode for the active omp model.",
      type: "select",
      value: controls.slowModeEnabled === undefined
        ? "native"
        : controls.slowModeEnabled ? "on" : "off",
      values: [
        { id: "native", label: "Native" },
        { id: "on", label: "Enabled" },
        { id: "off", label: "Disabled" },
      ],
    });
  }
  return options;
}

function parseSelection<T extends string>(
  options: Record<string, string | boolean> | undefined,
  id: keyof OmpSessionControls,
  values: readonly T[],
): T | undefined {
  const value = options?.[id];
  if (value === undefined || value === "native") return undefined;
  const selected = values.find((candidate) => candidate === value);
  if (selected !== undefined) return selected;
  throw new Error(
    `Invalid OMP session option ${id}: ${JSON.stringify(value)}. Expected native, ${values.join(", ")}.`,
  );
}

function parseEnabled(
  options: Record<string, string | boolean> | undefined,
  id: "autoCompactionEnabled" | "autoRetryEnabled" | "slowModeEnabled",
): boolean | undefined {
  const value = parseSelection(options, id, ["on", "off"] as const);
  return value === undefined ? undefined : value === "on";
}

export function parseOmpSessionControls(
  options: Record<string, string | boolean> | undefined,
): OmpSessionControls {
  const controls: OmpSessionControls = {};
  const steeringMode = parseSelection(options, "steeringMode", [
    "all",
    "one-at-a-time",
  ] as const);
  const followUpMode = parseSelection(options, "followUpMode", [
    "all",
    "one-at-a-time",
  ] as const);
  const interruptMode = parseSelection(options, "interruptMode", [
    "immediate",
    "wait",
  ] as const);
  const autoCompactionEnabled = parseEnabled(options, "autoCompactionEnabled");
  const autoRetryEnabled = parseEnabled(options, "autoRetryEnabled");
  const slowModeEnabled = parseEnabled(options, "slowModeEnabled");
  const cacheWarmingMode = parseSelection(options, "cacheWarmingMode", [
    "off",
    "streaming",
    "idle",
  ] as const);
  if (steeringMode !== undefined) controls.steeringMode = steeringMode;
  if (followUpMode !== undefined) controls.followUpMode = followUpMode;
  if (interruptMode !== undefined) controls.interruptMode = interruptMode;
  if (autoCompactionEnabled !== undefined) {
    controls.autoCompactionEnabled = autoCompactionEnabled;
  }
  if (autoRetryEnabled !== undefined) controls.autoRetryEnabled = autoRetryEnabled;
  if (cacheWarmingMode !== undefined) controls.cacheWarmingMode = cacheWarmingMode;
  if (slowModeEnabled !== undefined) controls.slowModeEnabled = slowModeEnabled;
  return controls;
}
