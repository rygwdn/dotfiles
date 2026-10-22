import type { JsonValue, PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  ompCardSchema,
  ompEditorTextSchema,
  ompExtensionUiStateSchema,
  ompNoticeSchema,
  ompStatusStateSchema,
} from "./extension-ui-contract.js";
import { ompAgentsStateSchema } from "./hub-contract.js";
import type { OmpModelFilter } from "./model-curation.js";
import { OMP_NATIVE_ROOTS_DECLARATION } from "./native-roots.js";

export const OMP_TERMINAL_SIGN_IN_HINT = "Run `omp`, then `/login` on the machine to sign in.";

// Bridge options reach `model/list` and participate in bb's catalog cache key,
// so filter changes and saved presets both refresh the picker.
export function ompProviderDeclaration(
  modelFilter: OmpModelFilter,
  presetsRevision?: string,
): PluginProviderDeclaration {
  return {
    id: "omp",
    displayName: "omp (RPC)",
    icon: "./icons/omp.svg",
    experimental_bridgeOptions: {
      modelFilter: modelFilter as unknown as JsonValue,
      ...(presetsRevision === undefined ? {} : { presetsRevision }),
    },
    strings: {
      signInHint: OMP_TERMINAL_SIGN_IN_HINT,
      expiredHint:
        "Your OMP session expired. Run `omp`, then `/login`, then reload.",
      installUrl: "https://github.com/can1357/oh-my-pi",
      iconTint: { light: "#6D5DFB", dark: "#6D5DFB" },
    },
    maintenance: { health: true, usage: false, installation: true },
    // Non-BB environment (including OMP's retained PI_* settings) is inherited.
    env: {
      passthrough: [
        "BB_OMP_BRIDGE_COMMAND",
        "BB_OMP_BRIDGE_ARGS",
        "BB_OMP_BRIDGE_SESSION_DIR",
        "BB_OMP_BRIDGE_READINESS_TIMEOUT_MS",
        "BB_OMP_CATALOG_IDLE_MS",
      ],
    },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: true,
      permissionModes: ["full"],
      // The SDK's coarse ladder omits "minimal"; its descriptor below carries it.
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    extensionKinds: {
      "extension-ui-state": { state: ompExtensionUiStateSchema },
      "editor-text": { state: ompEditorTextSchema },
      status: { state: ompStatusStateSchema },
      notice: { item: ompNoticeSchema },
      card: { item: ompCardSchema },
      agents: { state: ompAgentsStateSchema },
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    ...OMP_NATIVE_ROOTS_DECLARATION,
    composerActions: ["goal"],
  };
}
