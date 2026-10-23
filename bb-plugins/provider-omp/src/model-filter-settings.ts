import type { OmpModelFilter } from "./model-curation.js";

/** Settings edits come in bursts (one save per field); re-register once they settle. */
export const MODEL_FILTER_REREGISTER_DELAY_MS = 1500;

// Models a filter hides move to bb's "More models"; they stay searchable and selectable.
export const OMP_MODEL_FILTER_SETTINGS = {
  modelPresetsInPicker: {
    type: "select",
    label: "Model presets in the picker",
    description:
      "Show presets alongside curated models, only presets (raw models stay in More models), or no presets.",
    options: ["both", "presets", "off"] as string[],
    experimental_optionLabels: {
      both: "Presets and models",
      presets: "Presets only",
      off: "Models only",
    },
    default: "both",
  },
  modelFilterLatestPerFamily: {
    type: "boolean",
    label: "Only the latest model per family",
    description:
      "Show only the newest model of each family and variant (for example the newest Opus, the newest GPT mini). Models without a known family always show.",
    default: true,
  },
  modelFilterMinIntelligence: {
    type: "number",
    label: "Minimum intelligence score",
    description:
      "Hide models whose omp catalog intelligence score is lower (for example 40). Models without a score always show. 0 turns this off.",
    default: 0,
  },
  modelFilterMaxInputPrice: {
    type: "number",
    label: "Maximum input price ($ per million tokens)",
    description: "Hide models that cost more per million input tokens. Models with an unknown price always show. 0 turns this off.",
    default: 0,
  },
  modelFilterMaxOutputPrice: {
    type: "number",
    label: "Maximum output price ($ per million tokens)",
    description: "Hide models that cost more per million output tokens. Models with an unknown price always show. 0 turns this off.",
    default: 0,
  },
  modelFilterMinContextWindow: {
    type: "number",
    label: "Minimum context window (thousand tokens)",
    description: "Hide models with a smaller context window, for example 200 for 200K. 0 turns this off.",
    default: 0,
  },
  modelFilterRequireReasoning: {
    type: "boolean",
    label: "Only reasoning models",
    default: false,
  },
  modelFilterRequireImageInput: {
    type: "boolean",
    label: "Only models that accept images",
    default: false,
  },
  modelFilterRequireTools: {
    type: "boolean",
    label: "Only models with tool support",
    description: "Models not known to lack tool support still show.",
    default: false,
  },
  modelFilterProviderAllow: {
    type: "string",
    label: "Only these providers",
    description: "Comma-separated omp provider names or globs, for example `anthropic, openai*`. Empty shows every provider.",
    default: "",
  },
  modelFilterProviderDeny: {
    type: "string",
    label: "Hide these providers",
    description: "Comma-separated omp provider names or globs. Wins over the allow list.",
    default: "",
  },
  modelFilterAlwaysShow: {
    type: "string",
    label: "Always show these models",
    description:
      "Comma-separated model ids or globs, as `provider/model` or just `model`. omp's current model and its modelRoles models always show.",
    default: "",
  },
} as const;

type FilterSettingValues = {
  [K in keyof typeof OMP_MODEL_FILTER_SETTINGS]: (typeof OMP_MODEL_FILTER_SETTINGS)[K]["default"] extends boolean
    ? boolean
    : (typeof OMP_MODEL_FILTER_SETTINGS)[K]["default"] extends number
      ? number
      : string;
};

function positiveOrNull(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function settingsToOmpModelFilter(values: FilterSettingValues): OmpModelFilter {
  const minContextK = positiveOrNull(values.modelFilterMinContextWindow);
  return {
    modelPresetsInPicker:
      values.modelPresetsInPicker === "presets"
        ? "presets"
        : values.modelPresetsInPicker === "off"
          ? "off"
          : "both",
    latestPerFamily: values.modelFilterLatestPerFamily,
    minIntelligence: positiveOrNull(values.modelFilterMinIntelligence),
    maxInputPrice: positiveOrNull(values.modelFilterMaxInputPrice),
    maxOutputPrice: positiveOrNull(values.modelFilterMaxOutputPrice),
    minContextWindow: minContextK === null ? null : Math.round(minContextK * 1000),
    requireReasoning: values.modelFilterRequireReasoning,
    requireImageInput: values.modelFilterRequireImageInput,
    requireTools: values.modelFilterRequireTools,
    providerAllow: list(values.modelFilterProviderAllow),
    providerDeny: list(values.modelFilterProviderDeny),
    alwaysShow: list(values.modelFilterAlwaysShow),
  };
}
