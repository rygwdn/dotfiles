import type { OmpCatalogModel, OmpModelIdentity } from "./model-list.js";

export interface OmpModelFilter {
  modelPresetsInPicker: "both" | "presets" | "off";
  latestPerFamily: boolean;
  /** Fill a missing family or revision from the model class and id before grouping. */
  repairIdentity: boolean;
  /** Embedding, speech, realtime, image-generation and other non-chat models go to More. */
  hideTaskModels: boolean;
  /** An unscored model borrows the score of a scored model with the same bare id. */
  shareScores: boolean;
  /** Models two or more major versions behind their provider and class's newest go to More. */
  hideOldGenerations: boolean;
  /** The same model on several providers shows once. */
  collapseCopies: boolean;
  /** Provider names or globs, best first: which copy of a model shows. */
  providerRanking: string[];
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
  repairIdentity: true,
  hideTaskModels: true,
  shareScores: true,
  hideOldGenerations: true,
  collapseCopies: true,
  providerRanking: [],
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
  const rule = (key: "latestPerFamily" | "repairIdentity" | "hideTaskModels" | "shareScores" |
    "hideOldGenerations" | "collapseCopies") =>
    booleanFilter(filterField(value, key), DEFAULT_OMP_MODEL_FILTER[key]);
  return {
    modelPresetsInPicker:
      filterField(value, "modelPresetsInPicker") === "presets"
        ? "presets"
        : filterField(value, "modelPresetsInPicker") === "off"
          ? "off"
          : "both",
    latestPerFamily: rule("latestPerFamily"),
    repairIdentity: rule("repairIdentity"),
    hideTaskModels: rule("hideTaskModels"),
    shareScores: rule("shareScores"),
    hideOldGenerations: rule("hideOldGenerations"),
    collapseCopies: rule("collapseCopies"),
    providerRanking: globFilter(filterField(value, "providerRanking")),
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
const DATE_STAMPS = new RegExp(DATE_STAMP.source, "g");
const VERSION_TOKEN = /^v?\d+(?:p\d+)*$/;
const MODEL_STEMS: Readonly<Record<string, string>> = {
  anthropic: "claude",
  openai: "gpt",
  xai: "grok",
};

/** The id after vendor namespaces (`openai/`, Fireworks `accounts/.../models/`), lowercased. */
function idTail(model: OmpCatalogModel): string {
  return model.id.slice(model.id.lastIndexOf("/") + 1).toLowerCase();
}

/** Fireworks writes 5.3 as `5p3`. */
function dottedVersions(id: string): string {
  return id.replace(/(\d)p(?=\d)/g, "$1.");
}

/** The id omp scores by: no namespace, no `:routing` suffix, dotted versions. */
function bareId(model: OmpCatalogModel): string {
  const tail = idTail(model);
  const colon = tail.indexOf(":");
  return dottedVersions(colon >= 0 ? tail.slice(0, colon) : tail);
}

function knownClass(identity: OmpModelIdentity | undefined): string | null {
  const modelClass = identity?.class?.trim().toLowerCase();
  return modelClass && modelClass !== "unknown" ? modelClass : null;
}

// A version token: optional letter prefix (k2, o3, llama3, v4), a major of at
// most two digits so dates and context sizes don't count, and an optional
// letter suffix (4o). Parameter sizes (32b, 2.4t, 8k) are not versions.
const ID_VERSION = /^[a-z]*?(\d{1,2}(?:\.\d+)*)([a-z]*)$/;
const SIZE_SUFFIX = /^[bkmt]/;

/** The first version in the id and the words in front of it. */
function idVersion(model: OmpCatalogModel): { revision: string; wordsBefore: string[] } | null {
  const tokens = bareId(model).split(/[-_]+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index++) {
    const match = ID_VERSION.exec(tokens[index]!);
    if (!match || SIZE_SUFFIX.test(match[2]!)) continue;
    return {
      revision: match[1]!,
      // A prefix glued to the number (o3, k2, llama3) is part of the version.
      wordsBefore: tokens.slice(0, index).flatMap((token) => token.split(".")),
    };
  }
  return null;
}

const VERSIONED_FAMILY = /^([a-z]+)(\d+(?:\.\d+)*)(?=$|-)/;

/**
 * Fill what omp's identity leaves out: a known class with no family uses the
 * class (glm, qwen, gemma), a family with the version inside it is split
 * (kimi `k2.5`, minimax `m2`), and a missing revision comes from the id.
 */
function repairIdentity(model: OmpCatalogModel): OmpModelIdentity | undefined {
  const identity = model.identity;
  const modelClass = knownClass(identity);
  if (!identity || modelClass === null) return identity;
  let family = identity.family?.trim().toLowerCase() || modelClass;
  let familyRevision: string | undefined;
  const versioned = VERSIONED_FAMILY.exec(family);
  if (versioned) {
    family = versioned[1]!;
    familyRevision = versioned[2];
  }
  const revision = identity.revision || idVersion(model)?.revision || familyRevision;
  return { ...identity, family, ...(revision ? { revision } : {}) };
}

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

function familyIdentity(
  model: OmpCatalogModel,
  identity: OmpModelIdentity | undefined,
): { key: string; aliasRank: number } | null {
  const family = identity?.family?.trim().toLowerCase();
  if (!family) return null;
  const modelClass = identity?.class?.toLowerCase() ?? "";

  // Remove vendor namespaces (including nested Fireworks paths) before parsing the id.
  let id = idTail(model);
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

function latestModelIndices(
  models: readonly OmpCatalogModel[],
  identities: readonly (OmpModelIdentity | undefined)[],
  skip: ReadonlySet<number>,
): Set<number> {
  const shown = new Set<number>();
  const families = new Map<string, FamilyCandidate>();
  models.forEach((model, index) => {
    if (skip.has(index)) return;
    const identity = familyIdentity(model, identities[index]);
    if (!identity) {
      shown.add(index);
      return;
    }
    const revision = identities[index]?.revision;
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

// Whole id tokens or token runs that mark a model built for one job rather than chat.
const TASK_TOKENS: Readonly<Record<string, true>> = {
  embed: true, embedding: true, embeddings: true, rerank: true, reranker: true, tts: true,
  realtime: true, live: true, imagine: true, flux: true, robotics: true, safeguard: true,
  compound: true,
};
const TASK_SEQUENCES: readonly (readonly string[])[] = [
  ["native", "audio"],
  ["computer", "use"],
  ["deep", "research"],
];

function isTaskModel(model: OmpCatalogModel): boolean {
  if (model.kind !== undefined && model.kind !== "chat") return true;
  const tokens = bareId(model).split(/[-_.]+/);
  return tokens.some((token) => TASK_TOKENS[token] === true) ||
    TASK_SEQUENCES.some((sequence) => tokenSequenceIndex(tokens, sequence) >= 0);
}

/**
 * Old generations: a model whose major version is two or more below the
 * newest major for its provider and class (gpt-4o and o3 next to gpt-6).
 * Only ids that number the generation count: a version after other words
 * (grok-code-fast-1, grok-build-0.1) numbers its own product line.
 */
function oldGenerationIndices(
  models: readonly OmpCatalogModel[],
  identities: readonly (OmpModelIdentity | undefined)[],
  tasks: ReadonlySet<number>,
): Set<number> {
  const majors = models.map((model, index): { key: string; major: number } | null => {
    const identity = identities[index];
    const modelClass = knownClass(identity);
    const major = Number.parseInt(identity?.revision ?? "", 10);
    if (modelClass === null || !Number.isFinite(major)) return null;
    const version = idVersion(model);
    if (version) {
      const ownWords = new Set([
        modelClass,
        ...(Object.hasOwn(MODEL_STEMS, modelClass) ? [MODEL_STEMS[modelClass]!] : []),
        ...(identity?.family?.toLowerCase().split(/[-_.]+/) ?? []),
      ]);
      if (version.wordsBefore.some((word) => !ownWords.has(word))) return null;
    }
    return { key: JSON.stringify([model.provider, modelClass]), major };
  });
  const newest = new Map<string, number>();
  majors.forEach((entry, index) => {
    if (entry && !tasks.has(index)) {
      newest.set(entry.key, Math.max(newest.get(entry.key) ?? entry.major, entry.major));
    }
  });
  const old = new Set<number>();
  majors.forEach((entry, index) => {
    if (entry && entry.major <= (newest.get(entry.key) ?? entry.major) - 2) old.add(index);
  });
  return old;
}

/**
 * omp scores one provider's copy of a model and not another's. An unscored
 * model takes the score of the same bare id; failing that, of the same id
 * without `-fast` and date stamps, when every such scored model agrees.
 */
function sharedScores(models: readonly OmpCatalogModel[]): (number | undefined)[] {
  const looseId = (id: string) => id.replace(DATE_STAMPS, "").replace(/-fast$/, "");
  const exact = new Map<string, number>();
  const loose = new Map<string, number | null>();
  for (const model of models) {
    if (model.int === undefined) continue;
    const id = bareId(model);
    if (!exact.has(id)) exact.set(id, model.int);
    const key = looseId(id);
    const seen = loose.get(key);
    loose.set(key, seen === undefined || seen === model.int ? model.int : null);
  }
  return models.map((model) => {
    if (model.int !== undefined) return model.int;
    const id = bareId(model);
    return exact.get(id) ?? loose.get(looseId(id)) ?? undefined;
  });
}

/** Copies: the same class and id (namespace stripped, `5p3` read as 5.3). */
function copyKey(model: OmpCatalogModel): string | null {
  const modelClass = knownClass(model.identity);
  return modelClass === null ? null : JSON.stringify([modelClass, dottedVersions(idTail(model))]);
}

function passesFilters(
  model: OmpCatalogModel,
  score: number | undefined,
  filter: OmpModelFilter,
  allow: readonly RegExp[],
  deny: readonly RegExp[],
): boolean {
  if (matchesGlobs(model.provider, deny)) return false;
  if (allow.length > 0 && !matchesGlobs(model.provider, allow)) return false;
  if (filter.minIntelligence !== null && score !== undefined && score < filter.minIntelligence) {
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

/**
 * Soft-filter the catalog: every input row remains available in shown or more.
 * Pinned rows (`pinnedIds`, `defaultId`, always-show matches) always show and
 * sort first, the default model at the very top.
 */
export function curateOmpModels(
  models: readonly OmpCatalogModel[],
  filter: OmpModelFilter,
  pinnedIds: readonly string[],
  defaultId?: string,
): { shown: OmpCatalogModel[]; more: OmpCatalogModel[] } {
  const pins = new Set(pinnedIds);
  const alwaysShow = compileGlobs(filter.alwaysShow);
  const allow = compileGlobs(filter.providerAllow);
  const deny = compileGlobs(filter.providerDeny);
  const ranking = compileGlobs(filter.providerRanking);
  const canonicalIds = models.map((model) => `${model.provider}/${model.id}`);
  const pinned = models.map((model, index) => canonicalIds[index] === defaultId ||
    pins.has(canonicalIds[index]!) ||
    matchesGlobs(canonicalIds[index]!, alwaysShow) || matchesGlobs(model.id, alwaysShow));

  const identities = models.map((model) =>
    filter.repairIdentity ? repairIdentity(model) : model.identity);
  const tasks = new Set<number>();
  models.forEach((model, index) => {
    if (isTaskModel(model)) tasks.add(index);
  });
  const hiddenTasks = filter.hideTaskModels ? tasks : new Set<number>();
  const scores = filter.shareScores ? sharedScores(models) : models.map((model) => model.int);
  const latest = filter.latestPerFamily ? latestModelIndices(models, identities, hiddenTasks) : null;
  const old = filter.hideOldGenerations ? oldGenerationIndices(models, identities, tasks) : null;
  const candidate = models.map((model, index) => !hiddenTasks.has(index) &&
    (old === null || !old.has(index)) && (latest === null || latest.has(index)) &&
    passesFilters(model, scores[index], filter, allow, deny));

  if (filter.collapseCopies) {
    const defaultProvider = models.find((_, index) => canonicalIds[index] === defaultId)?.provider;
    const rank = (index: number): [number, number, number] => {
      const provider = models[index]!.provider;
      const ranked = ranking.findIndex((pattern) => pattern.test(provider));
      return [ranked < 0 ? ranking.length : ranked, provider === defaultProvider ? 0 : 1, index];
    };
    const better = (a: number, b: number) => {
      const [left, right] = [rank(a), rank(b)];
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    };
    const groups = new Map<string, number[]>();
    models.forEach((model, index) => {
      if (!candidate[index] && !pinned[index]) return;
      const key = copyKey(model);
      if (key === null) return;
      const group = groups.get(key);
      if (group) group.push(index);
      else groups.set(key, [index]);
    });
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keep = group.some((index) => pinned[index])
        ? null
        : group.reduce((best, index) => (better(index, best) < 0 ? index : best));
      for (const index of group) {
        if (index !== keep && !pinned[index]) candidate[index] = false;
      }
    }
  }

  const top: OmpCatalogModel[] = [];
  const pinnedRows: OmpCatalogModel[] = [];
  const rest: OmpCatalogModel[] = [];
  const more: OmpCatalogModel[] = [];
  models.forEach((model, index) => {
    if (canonicalIds[index] === defaultId && top.length === 0) top.push(model);
    else if (pinned[index]) pinnedRows.push(model);
    else (candidate[index] ? rest : more).push(model);
  });
  const shown = [...top, ...pinnedRows, ...rest];
  return shown.length === 0 ? { shown: [...models], more: [] } : { shown, more };
}
