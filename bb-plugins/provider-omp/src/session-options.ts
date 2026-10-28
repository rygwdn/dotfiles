import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * The only per-thread control bb sets. Steering, follow-up, interrupt,
 * compaction, retry and cache warming come from omp's own config, and
 * selections bb saved for them on older threads are ignored.
 */
export interface OmpSessionControls {
  slowModeEnabled?: boolean;
}

export function buildOmpLiveSessionOptions(
  controls: OmpSessionControls,
  nativeState: {
    slowModeSupported?: boolean;
    slowModeScope?: "session" | "global";
  } = {},
): NonNullable<AvailableModel["sessionOptions"]> {
  if (!nativeState.slowModeSupported) return [];
  const global = nativeState.slowModeScope === "global";
  return [{
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
  }];
}

export function parseOmpSessionControls(
  options: Record<string, string | boolean> | undefined,
): OmpSessionControls {
  const value = options?.slowModeEnabled;
  if (value === undefined || value === "native") return {};
  if (value === "on" || value === "off") return { slowModeEnabled: value === "on" };
  throw new Error(
    `Invalid OMP session option slowModeEnabled: ${JSON.stringify(value)}. Expected native, on, off.`,
  );
}
