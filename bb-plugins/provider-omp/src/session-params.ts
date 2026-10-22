import {
  buildShellEnvOverrides,
  type DynamicTool,
  type InstructionMode,
  type ReasoningLevel,
  type RuntimePermissionPolicy,
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

export type OmpPermissionPolicy = Exclude<
  RuntimePermissionPolicy,
  { permissionMode: "auto" }
>;

type OmpSessionOptions = (RuntimePermissionPolicy | { permissionMode?: undefined }) & {
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  serviceTier?: string | undefined;
  sessionOptions?: Record<string, string | boolean> | undefined;
  instructions?: string | undefined;
  envVars?: Record<string, string> | undefined;
};

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
  permissionPolicy?: OmpPermissionPolicy;
  sessionControls?: OmpSessionControls;
  shellEnvOverrides: Record<string, string>;
  thinkingLevel?: OmpReasoningLevel | "auto" | "inherit";
}

export interface OmpTurnOptions {
  model: string | undefined;
  fastModeEnabled: boolean | undefined;
  permissionPolicy?: OmpPermissionPolicy;
  sessionControls: OmpSessionControls;
  thinkingLevel: OmpReasoningLevel | undefined;
}

function toOmpFastMode(serviceTier: string | undefined): boolean | undefined {
  if (serviceTier === "fast") return true;
  if (serviceTier === "default") return false;
  return undefined;
}

function toOmpPermissionPolicy(
  options: OmpSessionOptions,
): OmpPermissionPolicy | undefined {
  if (options.permissionMode === undefined) return undefined;
  if (options.permissionMode === "auto") {
    throw new Error("OMP does not support automatic approval review.");
  }
  // Bridge execution schemas validate this union at the JSON-RPC boundary.
  return options.permissionMode === "full"
    ? {
        permissionMode: options.permissionMode,
        permissionScope: options.permissionScope,
        approvalReviewer: options.approvalReviewer,
        permissionEscalation: options.permissionEscalation,
      }
    : {
        permissionMode: options.permissionMode,
        permissionScope: options.permissionScope,
        approvalReviewer: options.approvalReviewer,
        permissionEscalation: options.permissionEscalation,
      };
}

export function buildOmpTurnOptions(options: OmpSessionOptions): OmpTurnOptions {
  const permissionPolicy = toOmpPermissionPolicy(options);
  return {
    model: options.model ? options.model : undefined,
    fastModeEnabled: toOmpFastMode(options.serviceTier),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
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
  const permissionPolicy = toOmpPermissionPolicy(args.options);
  return {
    cwd: args.cwd,
    ...(fastModeEnabled === undefined ? {} : { fastModeEnabled }),
    ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
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
