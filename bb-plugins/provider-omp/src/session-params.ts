import {
  buildShellEnvOverrides,
  type DynamicTool,
  type InstructionMode,
  type ReasoningLevel,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { OmpModelPreset } from "./native-roots.js";
import {
  parseOmpSessionControls,
  type OmpSessionControls,
} from "./session-options.js";

type OmpReasoningLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

function toOmpThinkingLevel(
  reasoningLevel: ReasoningLevel | undefined,
): OmpReasoningLevel | undefined {
  switch (reasoningLevel) {
    case "none":
      return "off";
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return reasoningLevel;
    default:
      return undefined;
  }
}

interface OmpSessionOptions {
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  serviceTier?: string | undefined;
  sessionOptions?: Record<string, string | boolean> | undefined;
  instructions?: string | undefined;
  envVars?: Record<string, string> | undefined;
}

interface BuildOmpSessionParamsArgs {
  threadId: string;
  cwd: string;
  options: OmpSessionOptions;
  instructionMode: InstructionMode;
  dynamicTools?: readonly DynamicTool[] | undefined;
  additionalSkillPaths?: readonly string[] | undefined;
}

export interface OmpSessionParams {
  additionalSkillPaths?: readonly string[];
  /** OMP --append-system-prompt: keep the native prompt and append instructions. */
  appendSystemPrompt?: string;
  /** OMP --system-prompt: replace the native base prompt, not its template. */
  baseInstructions?: string;
  cwd: string;
  dynamicTools?: readonly DynamicTool[];
  fastModeEnabled?: boolean;
  model?: string;
  /** Snapshot the chosen preset so child rebuilds cannot pick up later edits. */
  modelPreset?: OmpModelPreset;
  /** Native roles the preset overlay must clear when it leaves them unset. */
  effectiveModelRoles?: Record<string, string>;
  sessionControls?: OmpSessionControls;
  shellEnvOverrides: Record<string, string>;
  thinkingLevel?: OmpReasoningLevel | "auto" | "inherit";
}

export interface OmpTurnOptions {
  model: string | undefined;
  fastModeEnabled: boolean | undefined;
  sessionControls: OmpSessionControls;
  thinkingLevel: OmpReasoningLevel | undefined;
}

function toOmpFastMode(serviceTier: string | undefined): boolean | undefined {
  if (serviceTier === "fast") return true;
  if (serviceTier === "default") return false;
  return undefined;
}

export function buildOmpTurnOptions(options: OmpSessionOptions): OmpTurnOptions {
  return {
    model: options.model ? options.model : undefined,
    fastModeEnabled: toOmpFastMode(options.serviceTier),
    sessionControls: parseOmpSessionControls(options.sessionOptions),
    thinkingLevel: toOmpThinkingLevel(options.reasoningLevel),
  };
}

export function buildOmpSessionParams(
  args: BuildOmpSessionParamsArgs,
): OmpSessionParams {
  const instructions = args.options.instructions?.trim();
  const thinkingLevel = toOmpThinkingLevel(args.options.reasoningLevel);
  const fastModeEnabled = toOmpFastMode(args.options.serviceTier);
  const sessionControls = parseOmpSessionControls(args.options.sessionOptions);
  return {
    cwd: args.cwd,
    ...(fastModeEnabled === undefined ? {} : { fastModeEnabled }),
    ...(Object.keys(sessionControls).length > 0 ? { sessionControls } : {}),
    shellEnvOverrides: {
      BB_THREAD_ID: args.threadId,
      ...buildShellEnvOverrides(args.options.envVars),
    },
    ...(instructions
      ? args.instructionMode === "replace"
        ? { baseInstructions: instructions }
        : { appendSystemPrompt: instructions }
      : {}),
    ...(args.options.model ? { model: args.options.model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(args.dynamicTools && args.dynamicTools.length > 0
      ? { dynamicTools: args.dynamicTools }
      : {}),
    ...(args.additionalSkillPaths && args.additionalSkillPaths.length > 0
      ? { additionalSkillPaths: [...args.additionalSkillPaths] }
      : {}),
  };
}
