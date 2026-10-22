import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  curateOmpModels,
  DEFAULT_OMP_MODEL_FILTER,
  type OmpModelFilter,
} from "./model-curation.js";
import {
  resolveOmpPresetDefaultCandidates,
  splitOmpSelectorThinking,
  toOmpModelPresetId,
  type OmpModelPreset,
} from "./native-roots.js";
import { OMP_SESSION_OPTIONS } from "./session-options.js";

const NONE_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "none",
  description: "No extended thinking",
};

const MINIMAL_REASONING_EFFORT: ModelReasoningEffort = {
  reasoningEffort: "minimal",
  description: "Minimal reasoning",
};

export interface OmpModelCost {
  /** USD per million tokens. All-zero costs mean "unknown", not free. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface OmpModelIdentity {
  class?: string;
  family?: string;
  revision?: string;
  effort?: string;
  logicalId?: string;
}

export interface OmpCatalogModel {
  id: string;
  input: string[];
  name: string;
  provider: string;
  reasoning: boolean;
  serviceTiers?: readonly string[];
  thinking?: {
    efforts?: readonly string[];
    defaultLevel?: string;
  };
  cost?: OmpModelCost;
  contextWindow?: number | null;
  maxTokens?: number | null;
  identity?: OmpModelIdentity;
  /** omp catalog intelligence score; absent for most routers and custom models. */
  int?: number;
  /** Only `false` means the model has no tool support. */
  supportsTools?: boolean;
}

interface BuildOmpAvailableModelsArgs {
  models: readonly OmpCatalogModel[];
  preferredDefaultId?: string;
  filter?: OmpModelFilter;
  /** Effective omp role assignments; their models always show. */
  modelRoles?: Readonly<Record<string, string>>;
  presets?: readonly OmpModelPreset[];
}

interface BuildOmpAvailableModelsResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

function buildOmpAvailableModel(model: OmpCatalogModel): AvailableModel {
  const canonicalId = toCanonicalOmpModelId(model.provider, model.id);
  const supportedReasoningEfforts = getOmpReasoningEfforts(model);
  const defaultReasoningEffort =
    supportedReasoningEfforts.find(
      ({ reasoningEffort }) => reasoningEffort === model.thinking?.defaultLevel,
    )?.reasoningEffort ??
    supportedReasoningEfforts.find(
      ({ reasoningEffort }) => reasoningEffort === "medium",
    )?.reasoningEffort ??
    supportedReasoningEfforts.find(
      ({ reasoningEffort }) => reasoningEffort !== "none",
    )?.reasoningEffort ??
    supportedReasoningEfforts[0]?.reasoningEffort ??
    "none";
  return {
    id: canonicalId,
    model: canonicalId,
    displayName: model.name,
    routeProviderId: model.provider,
    description: describeOmpModel(model),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    sessionOptions: OMP_SESSION_OPTIONS,
    ...ompServiceTierOptions(model),
    isDefault: false,
  };
}

export function buildOmpAvailableModels(
  args: BuildOmpAvailableModelsArgs,
): BuildOmpAvailableModelsResult {
  const filter = args.filter ?? DEFAULT_OMP_MODEL_FILTER;
  const presets = filter.modelPresetsInPicker === "off" ? [] : (args.presets ?? []);
  const roles = [
    ...Object.values(args.modelRoles ?? {}),
    ...presets.flatMap((preset) => Object.values(preset.modelRoles)),
  ].flatMap((value) => value.split(",")
    .map((entry) => splitOmpSelectorThinking(entry.trim()).selector));
  const pinnedIds = args.models
    .map((model) => toCanonicalOmpModelId(model.provider, model.id))
    .filter((id) => id === args.preferredDefaultId || roles.includes(id));
  const presetsOnly = filter.modelPresetsInPicker === "presets" && presets.length > 0;
  const curated = presetsOnly
    ? { shown: [], more: args.models }
    : curateOmpModels(args.models, filter, pinnedIds);
  const rawModels = curated.shown.map(buildOmpAvailableModel);
  const presetModels = presets.map((preset) => buildOmpPresetModel(preset, args.models));
  const models = [...presetModels, ...rawModels];

  // Raw defaults stay pinned in both mode; presets-only prefers the effective role map.
  const activePreset = presetsOnly
    ? presets.find((preset) => sameModelRoles(preset.modelRoles, args.modelRoles ?? {}))
    : undefined;
  const defaultId = presetsOnly
    ? toOmpModelPresetId((activePreset ?? presets[0]!).name)
    : rawModels.find((model) => model.id === args.preferredDefaultId)?.id ??
      rawModels[0]?.id ??
      presetModels[0]?.id;
  return {
    models: models.map((model) =>
      model.id === defaultId ? { ...model, isDefault: true } : model,
    ),
    selectedOnlyModels: curated.more.map(buildOmpAvailableModel),
  };
}

function ompServiceTierOptions(
  model: OmpCatalogModel | undefined,
): Pick<AvailableModel, "supportedServiceTiers"> {
  return model?.serviceTiers === undefined
    ? {}
    : {
        supportedServiceTiers: [
          { id: "default", label: "Default" },
          ...(model.serviceTiers.includes("priority")
            ? [{ id: "fast", label: "Fast" }]
            : []),
        ],
      };
}

function sameModelRoles(
  presetRoles: Readonly<Record<string, string>>,
  effectiveRoles: Readonly<Record<string, string>>,
): boolean {
  const roles = Object.keys(presetRoles);
  return roles.length === Object.values(effectiveRoles).filter(Boolean).length &&
    roles.every((role) => Object.hasOwn(effectiveRoles, role) &&
      effectiveRoles[role] === presetRoles[role]);
}

function buildOmpPresetModel(
  preset: OmpModelPreset,
  models: readonly OmpCatalogModel[],
): AvailableModel {
  let defaultModel: OmpCatalogModel | undefined;
  let thinking = preset.defaultThinkingLevel ?? "medium";
  for (const candidate of resolveOmpPresetDefaultCandidates(preset)) {
    const model = models.find((entry) =>
      toCanonicalOmpModelId(entry.provider, entry.id) === candidate.selector);
    if (model === undefined) continue;
    defaultModel = model;
    thinking = candidate.thinking ?? thinking;
    break;
  }
  const name = preset.name.replace(/[-_]+/gu, " ");
  const roleEntries = Object.entries(preset.modelRoles);
  const orderedRoles = [
    ...roleEntries.filter(([role]) => role === "default"),
    ...roleEntries.filter(([role]) => role !== "default"),
  ];
  const description = [
    "Preset",
    ...orderedRoles.slice(0, 3).map(([role, value]) => {
      const { selector } = splitOmpSelectorThinking(value);
      const resolvedModel = models.find((model) =>
        toCanonicalOmpModelId(model.provider, model.id) === selector);
      return `${role} ${resolvedModel?.id ?? value}`;
    }),
    ...(orderedRoles.length > 3 ? ["…"] : []),
    ...(preset.source === "global" ? [] : [preset.source]),
  ].join(" · ");
  return {
    id: toOmpModelPresetId(preset.name),
    model: toOmpModelPresetId(preset.name),
    displayName: name[0]!.toUpperCase() + name.slice(1),
    description,
    supportedReasoningEfforts: defaultModel
      ? getOmpReasoningEfforts(defaultModel)
      : [
          NONE_REASONING_EFFORT,
          MINIMAL_REASONING_EFFORT,
          LOW_REASONING_EFFORT,
          MEDIUM_REASONING_EFFORT,
          HIGH_REASONING_EFFORT,
          XHIGH_REASONING_EFFORT,
          MAX_REASONING_EFFORT,
        ],
    defaultReasoningEffort: thinking === "off" ? "none" : thinking === "auto" ? "medium" : thinking,
    sessionOptions: OMP_SESSION_OPTIONS,
    ...ompServiceTierOptions(defaultModel),
    isDefault: false,
  };
}

export function toCanonicalOmpModelId(
  provider: string,
  modelId: string,
): string {
  return `${provider}/${modelId}`;
}

function getOmpReasoningEfforts(model: OmpCatalogModel): ModelReasoningEffort[] {
  const efforts: ModelReasoningEffort[] = [NONE_REASONING_EFFORT];
  if (!model.reasoning) return efforts;

  const supportedLevels = model.thinking?.efforts ?? [];
  if (supportedLevels.includes("minimal")) efforts.push(MINIMAL_REASONING_EFFORT);
  if (supportedLevels.includes("low")) efforts.push(LOW_REASONING_EFFORT);
  if (supportedLevels.includes("medium")) efforts.push(MEDIUM_REASONING_EFFORT);
  if (supportedLevels.includes("high")) efforts.push(HIGH_REASONING_EFFORT);
  if (supportedLevels.includes("xhigh")) efforts.push(XHIGH_REASONING_EFFORT);
  if (supportedLevels.includes("max")) efforts.push(MAX_REASONING_EFFORT);
  return efforts;
}

function describeOmpModel(model: OmpCatalogModel): string {
  const capabilities: string[] = [];
  capabilities.push(model.reasoning ? "reasoning" : "non-reasoning");
  if (model.input.includes("image")) {
    capabilities.push("multimodal");
  }

  const provider =
    model.provider.length > 0
      ? model.provider[0].toUpperCase() + model.provider.slice(1)
      : model.provider;
  const parts = [`${provider} ${capabilities.join(", ")} model via OMP`];
  // bb has no price, context or score fields, so they ride in the description.
  const cost = model.cost;
  if (cost !== undefined && (cost.input > 0 || cost.output > 0)) {
    parts.push(`$${Number(cost.input.toFixed(2))}/$${Number(cost.output.toFixed(2))} per M tokens`);
  }
  const context = model.contextWindow;
  if (typeof context === "number" && context > 0) {
    parts.push(
      context >= 1_000_000
        ? `${Number((context / 1_000_000).toFixed(1))}M context`
        : `${Math.round(context / 1000)}K context`,
    );
  }
  if (model.int !== undefined) parts.push(`score ${Number(model.int.toFixed(1))}`);
  return parts.join(" · ");
}
