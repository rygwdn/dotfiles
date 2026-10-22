import type { OmpCatalogModel } from "./model-list.js";

export interface OmpModelFilter {
  modelPresetsInPicker: "both" | "presets" | "off";
  latestPerFamily: boolean;
  minIntelligence: number | null;
  /** USD per million input tokens; null disables the ceiling. */
  maxInputPrice: number | null;
  maxOutputPrice: number | null;
  minContextWindow: number | null;
  requireReasoning: boolean;
  requireImageInput: boolean;
  requireTools: boolean;
  providerAllow: string[];
  providerDeny: string[];
  alwaysShow: string[];
}

export const DEFAULT_OMP_MODEL_FILTER: OmpModelFilter = {
  modelPresetsInPicker: "both",
  latestPerFamily: true,
  minIntelligence: null,
  maxInputPrice: null,
  maxOutputPrice: null,
  minContextWindow: null,
  requireReasoning: false,
  requireImageInput: false,
  requireTools: false,
  providerAllow: [],
  providerDeny: [],
  alwaysShow: [],
};

function filterField(value: unknown, key: keyof OmpModelFilter): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function booleanFilter(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// 0 is "off", like the settings: a $0 ceiling would hide every priced model.
function thresholdFilter(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function globFilter(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return [];
  }
  return value.map((entry: string) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Parse providerOptions without letting one malformed field discard its siblings. */
export function parseOmpModelFilter(value: unknown): OmpModelFilter {
  return {
    modelPresetsInPicker:
      filterField(value, "modelPresetsInPicker") === "presets"
        ? "presets"
        : filterField(value, "modelPresetsInPicker") === "off"
          ? "off"
          : "both",
    latestPerFamily: booleanFilter(
      filterField(value, "latestPerFamily"),
      DEFAULT_OMP_MODEL_FILTER.latestPerFamily,
    ),
    minIntelligence: thresholdFilter(filterField(value, "minIntelligence")),
    maxInputPrice: thresholdFilter(filterField(value, "maxInputPrice")),
    maxOutputPrice: thresholdFilter(filterField(value, "maxOutputPrice")),
    minContextWindow: thresholdFilter(filterField(value, "minContextWindow")),
    requireReasoning: booleanFilter(filterField(value, "requireReasoning"), false),
    requireImageInput: booleanFilter(filterField(value, "requireImageInput"), false),
    requireTools: booleanFilter(filterField(value, "requireTools"), false),
    providerAllow: globFilter(filterField(value, "providerAllow")),
    providerDeny: globFilter(filterField(value, "providerDeny")),
    alwaysShow: globFilter(filterField(value, "alwaysShow")),
  };
}

function compileGlobs(globs: readonly string[]): RegExp[] {
  return globs.map((glob) => {
    const source = glob.replace(/[.*+?^${}()|[\]\\]/g, (character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return `\\${character}`;
    });
    return new RegExp(`^(?:${source})$`, "is");
  });
}

function matchesGlobs(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

const RELEASE_MARKERS: Readonly<Record<string, true>> = {
  latest: true,
  preview: true,
  beta: true,
  exp: true,
  experimental: true,
};
const OPENROUTER_SUFFIX = /-(?:fast|nitro|free|batch|extended|thinking|online|floor)$/;
const DATE_STAMP = /(?:^|-)(?:(?:19|20)\d{2}(?:-?\d{2}){2}|\d{2}-(?:19|20)\d{2}|\d{2}-\d{2}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?=$|-)/;
const VERSION_TOKEN = /^v?\d+(?:p\d+)*$/;
const MODEL_STEMS: Readonly<Record<string, string>> = {
  anthropic: "claude",
  openai: "gpt",
  xai: "grok",
};

interface FamilyCandidate {
  index: number;
  revision: number[];
  aliasRank: number;
}

function tokenSequenceIndex(tokens: readonly string[], sequence: readonly string[]): number {
  for (let index = 0; index <= tokens.length - sequence.length; index++) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) return index;
  }
  return -1;
}

function familyIdentity(model: OmpCatalogModel): { key: string; aliasRank: number } | null {
  const family = model.identity?.family?.trim().toLowerCase();
  if (!family) return null;
  const modelClass = model.identity?.class?.toLowerCase() ?? "";

  // Remove vendor namespaces (including nested Fireworks paths) before parsing the id.
  let id = model.id.slice(model.id.lastIndexOf("/") + 1).toLowerCase();
  let routed = false;
  const colon = id.indexOf(":");
  if (colon >= 0) {
    routed = true;
    id = id.slice(0, colon);
  }
  if (model.provider.toLowerCase() === "openrouter") {
    while (OPENROUTER_SUFFIX.test(id)) {
      routed = true;
      id = id.replace(OPENROUTER_SUFFIX, "");
    }
  }

  // Some families attach the version to the stem: llama3, o3, etc.
  const familyStem = family === "o-series" ? "o" : family;
  const escapedStem = familyStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokens = id
    .replace(new RegExp(`(^|[-_.])(${escapedStem})(?=\\d)`, "g"), "$1$2-")
    .split(/[-_.]+/)
    .filter(Boolean);
  const familyTokens = familyStem.split(/[-_.]+/);
  const familyIndex = tokenSequenceIndex(tokens, familyTokens);
  const stemTokens = (Object.hasOwn(MODEL_STEMS, modelClass)
    ? MODEL_STEMS[modelClass]
    : modelClass).split(/[-_.]+/);
  const stemIndex = modelClass ? tokenSequenceIndex(tokens, stemTokens) : -1;

  // Keep meaningful pre-family variants (gemini-live-...-flash) but not region,
  // vendor, or product prefixes (us.anthropic.claude-...-opus).
  const variantTokens = familyIndex < 0
    ? tokens
    : [
        ...(stemIndex >= 0 && stemIndex + stemTokens.length <= familyIndex
          ? tokens.slice(stemIndex + stemTokens.length, familyIndex)
          : []),
        ...tokens.slice(familyIndex + familyTokens.length),
      ];
  const variant = variantTokens
    .filter((token) => !VERSION_TOKEN.test(token) && RELEASE_MARKERS[token] !== true)
    .join("-");
  const aliasRank = Number(routed) + Number(DATE_STAMP.test(id)) +
    Number(tokens.some((token) => RELEASE_MARKERS[token] === true));
  return { key: JSON.stringify([model.provider, modelClass, family, variant]), aliasRank };
}

function isNewer(candidate: FamilyCandidate, previous: FamilyCandidate): boolean {
  const segments = Math.max(candidate.revision.length, previous.revision.length);
  for (let index = 0; index < segments; index++) {
    const difference = (candidate.revision[index] ?? 0) - (previous.revision[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return candidate.aliasRank < previous.aliasRank;
}

function latestModelIndices(models: readonly OmpCatalogModel[]): Set<number> {
  const shown = new Set<number>();
  const families = new Map<string, FamilyCandidate>();
  models.forEach((model, index) => {
    const identity = familyIdentity(model);
    if (!identity) {
      shown.add(index);
      return;
    }
    const revision = model.identity?.revision;
    const candidate: FamilyCandidate = {
      index,
      revision: revision && /^\d+(?:\.\d+)*$/.test(revision)
        ? revision.split(".").map(Number)
        : [],
      aliasRank: identity.aliasRank,
    };
    const previous = families.get(identity.key);
    if (!previous || isNewer(candidate, previous)) families.set(identity.key, candidate);
  });
  for (const candidate of families.values()) shown.add(candidate.index);
  return shown;
}

function passesFilters(
  model: OmpCatalogModel,
  filter: OmpModelFilter,
  allow: readonly RegExp[],
  deny: readonly RegExp[],
): boolean {
  if (matchesGlobs(model.provider, deny)) return false;
  if (allow.length > 0 && !matchesGlobs(model.provider, allow)) return false;
  if (filter.minIntelligence !== null && model.int !== undefined && model.int < filter.minIntelligence) {
    return false;
  }
  const cost = model.cost;
  const knownCost = cost !== undefined && (
    cost.input !== 0 || cost.output !== 0 || (cost.cacheRead ?? 0) !== 0 || (cost.cacheWrite ?? 0) !== 0
  );
  if (knownCost && cost) {
    if (filter.maxInputPrice !== null && cost.input > filter.maxInputPrice) return false;
    if (filter.maxOutputPrice !== null && cost.output > filter.maxOutputPrice) return false;
  }
  if (
    filter.minContextWindow !== null && model.contextWindow !== undefined &&
    model.contextWindow !== null && model.contextWindow < filter.minContextWindow
  ) return false;
  if (filter.requireReasoning && !model.reasoning) return false;
  if (filter.requireImageInput && !model.input.includes("image")) return false;
  if (filter.requireTools && model.supportsTools === false) return false;
  return true;
}

/** Soft-filter the catalog: every input row remains available in shown or more. */
export function curateOmpModels(
  models: readonly OmpCatalogModel[],
  filter: OmpModelFilter,
  pinnedIds: readonly string[],
): { shown: OmpCatalogModel[]; more: OmpCatalogModel[] } {
  const pins = new Set(pinnedIds);
  const alwaysShow = compileGlobs(filter.alwaysShow);
  const allow = compileGlobs(filter.providerAllow);
  const deny = compileGlobs(filter.providerDeny);
  const latest = filter.latestPerFamily ? latestModelIndices(models) : null;
  const shown: OmpCatalogModel[] = [];
  const more: OmpCatalogModel[] = [];
  models.forEach((model, index) => {
    const canonicalId = `${model.provider}/${model.id}`;
    const visible = pins.has(canonicalId) ||
      matchesGlobs(canonicalId, alwaysShow) || matchesGlobs(model.id, alwaysShow) ||
      ((latest === null || latest.has(index)) && passesFilters(model, filter, allow, deny));
    (visible ? shown : more).push(model);
  });
  return shown.length === 0 ? { shown: [...models], more: [] } : { shown, more };
}
