import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OMP_MODEL_FILTER,
  curateOmpModels,
  parseOmpModelFilter,
  type OmpModelFilter,
} from "./model-curation.js";
import type { OmpCatalogModel } from "./model-list.js";
import { OMP_MODEL_FILTER_SETTINGS, settingsToOmpModelFilter } from "./model-filter-settings.js";

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/omp-models.json", import.meta.url), "utf8"),
) as { models: OmpCatalogModel[]; syntheticModels: string[] };

function model(id: string, metadata: Partial<OmpCatalogModel> = {}): OmpCatalogModel {
  return {
    id,
    name: id,
    provider: "test",
    reasoning: true,
    input: ["text", "image"],
    ...metadata,
  };
}

function familyModel(
  id: string,
  family: string,
  revision: string,
  provider = "openai",
  modelClass = provider,
): OmpCatalogModel {
  return model(id, { provider, identity: { class: modelClass, family, revision } });
}

function filter(overrides: Partial<OmpModelFilter> = {}): OmpModelFilter {
  return { ...DEFAULT_OMP_MODEL_FILTER, latestPerFamily: false, repairIdentity: false,
    hideTaskModels: false, shareScores: false, hideOldGenerations: false, collapseCopies: false, ...overrides };
}

const expectedDefaults: OmpModelFilter = {
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

describe("parseOmpModelFilter", () => {
  it("defaults to the model-list noise rules without threshold filters", () => {
    expect(DEFAULT_OMP_MODEL_FILTER).toEqual(expectedDefaults);
    expect(parseOmpModelFilter({})).toEqual(expectedDefaults);
  });

  it.each([undefined, null, false, 3, "latest", [], ["openai"]])(
    "uses defaults for a non-object value: %j",
    (value) => {
      expect(parseOmpModelFilter(value)).toEqual(expectedDefaults);
    },
  );

  it("parses each supported field without coercion and trims glob entries", () => {
    expect(parseOmpModelFilter({
      modelPresetsInPicker: "presets",
      latestPerFamily: false,
      repairIdentity: false,
      hideTaskModels: false,
      shareScores: false,
      hideOldGenerations: false,
      collapseCopies: false,
      providerRanking: [" ANTHROPIC* ", ""],
      minIntelligence: 35,
      maxInputPrice: 1.25,
      maxOutputPrice: null,
      minContextWindow: 128_000,
      requireReasoning: true,
      requireImageInput: true,
      requireTools: true,
      providerAllow: [" OPENAI* ", ""],
      providerDeny: ["blocked?"],
      alwaysShow: [" */favorite ", " \t"],
      ignored: "unknown fields do not leak through",
    })).toEqual({
      modelPresetsInPicker: "presets",
      latestPerFamily: false,
      repairIdentity: false,
      hideTaskModels: false,
      shareScores: false,
      hideOldGenerations: false,
      collapseCopies: false,
      providerRanking: ["ANTHROPIC*"],
      minIntelligence: 35,
      maxInputPrice: 1.25,
      maxOutputPrice: null,
      minContextWindow: 128_000,
      requireReasoning: true,
      requireImageInput: true,
      requireTools: true,
      providerAllow: ["OPENAI*"],
      providerDeny: ["blocked?"],
      alwaysShow: ["*/favorite"],
    });
  });

  it("falls back field by field instead of discarding valid siblings", () => {
    expect(parseOmpModelFilter({
      latestPerFamily: "false",
      repairIdentity: "false",
      hideTaskModels: 0,
      shareScores: null,
      hideOldGenerations: [],
      collapseCopies: {},
      providerRanking: ["anthropic", 5],
      modelPresetsInPicker: "unknown",
      minIntelligence: -1,
      maxInputPrice: "2",
      maxOutputPrice: 4,
      minContextWindow: Number.POSITIVE_INFINITY,
      requireReasoning: true,
      requireImageInput: 1,
      requireTools: null,
      providerAllow: ["openai"],
      providerDeny: ["blocked", 5],
      alwaysShow: "favorite",
    })).toEqual({
      ...expectedDefaults,
      maxOutputPrice: 4,
      requireReasoning: true,
      providerAllow: ["openai"],
    });
  });

  it.each(["minIntelligence", "maxInputPrice", "maxOutputPrice", "minContextWindow"] as const)(
    "treats zero as off and rejects non-finite, negative, or coercible %s values",
    (field) => {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10", true, {}, []]) {
        const parsed = parseOmpModelFilter({ [field]: value, requireTools: true });
        expect(parsed[field]).toBeNull();
        expect(parsed.requireTools).toBe(true);
      }
      expect(parseOmpModelFilter({ [field]: null })[field]).toBeNull();
    },
  );

  it("does not share parsed glob arrays with input, defaults, or subsequent calls", () => {
    const input = { providerAllow: ["openai"] };
    const first = parseOmpModelFilter(input);
    first.providerAllow.push("anthropic");
    first.providerDeny.push("blocked");
    first.alwaysShow.push("favorite");
    first.providerRanking.push("anthropic");
    expect(input.providerAllow).toEqual(["openai"]);
    expect(parseOmpModelFilter(input).providerAllow).toEqual(["openai"]);
    expect(parseOmpModelFilter({})).toEqual(expectedDefaults);
    expect(DEFAULT_OMP_MODEL_FILTER).toEqual(expectedDefaults);
  });

  it.each(["both", "presets", "off"] as const)("preserves the %s picker mode through settings and bridge parsing", (mode) => {
    const defaults = Object.fromEntries(Object.entries(OMP_MODEL_FILTER_SETTINGS)
      .map(([key, descriptor]) => [key, descriptor.default])) as Parameters<typeof settingsToOmpModelFilter>[0];
    const fromSettings = settingsToOmpModelFilter({ ...defaults, modelPresetsInPicker: mode });
    expect(fromSettings).toEqual({ ...expectedDefaults, modelPresetsInPicker: mode });
    expect(parseOmpModelFilter(JSON.parse(JSON.stringify(fromSettings)))).toEqual(fromSettings);
    expect(OMP_MODEL_FILTER_SETTINGS.modelPresetsInPicker.options).toContain(mode);
  });

  it.each([undefined, null, true, 0, [], {}, "Both", "presets-only"])(
    "defaults an invalid picker mode without discarding valid sibling filters: %j",
    (mode) => {
      expect(parseOmpModelFilter({ modelPresetsInPicker: mode, requireTools: true }))
        .toEqual({ ...expectedDefaults, requireTools: true });
    },
  );

  it("changes serialized bridge options when the picker setting changes", () => {
    expect(JSON.stringify(parseOmpModelFilter({ modelPresetsInPicker: "presets" })))
      .not.toBe(JSON.stringify(parseOmpModelFilter({ modelPresetsInPicker: "both" })));
  });
});

describe("omp model curation filters", () => {
  const cases: {
    name: string;
    enabled: Partial<OmpModelFilter>;
    passing: Partial<OmpCatalogModel>;
    failing: Partial<OmpCatalogModel>;
  }[] = [
    {
      name: "minimum intelligence",
      enabled: { minIntelligence: 30 },
      passing: { int: 30 },
      failing: { int: 29.9 },
    },
    {
      name: "input price ceiling independently of output price",
      enabled: { maxInputPrice: 2 },
      passing: { cost: { input: 2, output: 100 } },
      failing: { cost: { input: 2.01, output: 0 } },
    },
    {
      name: "output price ceiling independently of input price",
      enabled: { maxOutputPrice: 5 },
      passing: { cost: { input: 100, output: 5 } },
      failing: { cost: { input: 0, output: 5.01 } },
    },
    {
      name: "minimum context window",
      enabled: { minContextWindow: 128_000 },
      passing: { contextWindow: 128_000 },
      failing: { contextWindow: 127_999 },
    },
    {
      name: "required reasoning",
      enabled: { requireReasoning: true },
      passing: { reasoning: true },
      failing: { reasoning: false },
    },
    {
      name: "required image input",
      enabled: { requireImageInput: true },
      passing: { input: ["text", "image"] },
      failing: { input: ["text"] },
    },
    {
      name: "required tools",
      enabled: { requireTools: true },
      passing: { supportsTools: true },
      failing: { supportsTools: false },
    },
  ];

  it.each(cases)("applies $name only when enabled, including the exact boundary", ({ enabled, passing, failing }) => {
    const pass = model("pass", passing);
    const fail = model("fail", failing);
    expect(curateOmpModels([fail, pass], filter(), [])).toEqual({ shown: [fail, pass], more: [] });
    expect(curateOmpModels([fail, pass], filter(enabled), [])).toEqual({ shown: [pass], more: [fail] });
  });

  it("passes a missing intelligence score but not a known zero score", () => {
    const unknown = model("unknown");
    const zero = model("zero", { int: 0 });
    expect(curateOmpModels([zero, unknown], filter({ minIntelligence: 1 }), [])).toEqual({
      shown: [unknown], more: [zero],
    });
  });

  it.each([
    { maxInputPrice: 0 },
    { maxOutputPrice: 0 },
    { maxInputPrice: 0, maxOutputPrice: 0 },
  ])("passes absent and all-zero prices for ceilings %j", (ceilings) => {
    const missing = model("missing");
    const unknown = model("zero-cost", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const expensive = model("expensive", { cost: { input: 1, output: 1 } });
    expect(curateOmpModels([missing, expensive, unknown], filter(ceilings), [])).toEqual({
      shown: [missing, unknown], more: [expensive],
    });
  });

  it("checks each price on partially zero costs, rather than treating either zero as unknown", () => {
    const inputOnly = model("input-only", { cost: { input: 1, output: 0 } });
    const outputOnly = model("output-only", { cost: { input: 0, output: 1 } });
    const cached = model("cache-priced", { cost: { input: 0, output: 0, cacheRead: 1 } });
    expect(curateOmpModels([inputOnly, outputOnly, cached], filter({ maxInputPrice: 0 }), [])).toEqual({
      shown: [outputOnly, cached], more: [inputOnly],
    });
    expect(curateOmpModels([inputOnly, outputOnly, cached], filter({ maxOutputPrice: 0 }), [])).toEqual({
      shown: [inputOnly, cached], more: [outputOnly],
    });
  });

  it("passes null and absent context but not a known zero-token window", () => {
    const missing = model("missing");
    const unknown = model("null", { contextWindow: null });
    const zero = model("zero", { contextWindow: 0 });
    expect(curateOmpModels([missing, zero, unknown], filter({ minContextWindow: 1 }), [])).toEqual({
      shown: [missing, unknown], more: [zero],
    });
  });

  it("passes unspecified tool support and rejects only explicit false", () => {
    const missing = model("missing");
    const yes = model("yes", { supportsTools: true });
    const no = model("no", { supportsTools: false });
    expect(curateOmpModels([missing, no, yes], filter({ requireTools: true }), [])).toEqual({
      shown: [missing, yes], more: [no],
    });
  });

  it("requires every enabled filter, not just one", () => {
    const complete = model("complete", { int: 50, cost: { input: 1, output: 1 } });
    const cheap = model("cheap", { int: 10, cost: { input: 1, output: 1 } });
    const smart = model("smart", { int: 50, cost: { input: 5, output: 1 } });
    expect(curateOmpModels([cheap, complete, smart], filter({ minIntelligence: 40, maxInputPrice: 2 }), [])).toEqual({
      shown: [complete], more: [cheap, smart],
    });
  });

  it("uses whole-provider, case-insensitive allow globs with both wildcard forms", () => {
    const exact = model("exact", { provider: "OpenAI" });
    const flex = model("flex", { provider: "openai-flex" });
    const one = model("one", { provider: "route-1" });
    const two = model("two", { provider: "route-12" });
    const substring = model("substring", { provider: "not-openai" });
    const rows = [exact, flex, one, two, substring];
    expect(curateOmpModels(rows, filter(), []).shown).toEqual(rows);
    expect(curateOmpModels(rows, filter({ providerAllow: ["OPENAI", "route-?"] }), [])).toEqual({
      shown: [exact, one], more: [flex, two, substring],
    });
    expect(curateOmpModels(rows, filter({ providerAllow: ["OPENAI*"] }), [])).toEqual({
      shown: [exact, flex], more: [one, two, substring],
    });
  });

  it("lets deny globs win over allow and leaves denies off when empty", () => {
    const allowed = model("allowed", { provider: "openai" });
    const denied = model("denied", { provider: "openai-flex" });
    const other = model("other", { provider: "anthropic" });
    expect(curateOmpModels([allowed, denied, other], filter({ providerAllow: ["openai*"] }), [])).toEqual({
      shown: [allowed, denied], more: [other],
    });
    expect(curateOmpModels([allowed, denied, other], filter({
      providerAllow: ["openai*"], providerDeny: ["OPENAI-????"],
    }), [])).toEqual({ shown: [allowed], more: [denied, other] });
  });

  it("treats regex punctuation as literal rather than extra glob syntax", () => {
    const literal = model("literal", { provider: "vendor.[one]+(x)" });
    const regexLike = model("regex-like", { provider: "vendorXooooox" });
    expect(curateOmpModels([regexLike, literal], filter({ providerAllow: ["vendor.[one]+(x)"] }), [])).toEqual({
      shown: [literal], more: [regexLike],
    });
  });

  it("requires a true whole-string match even before a final newline", () => {
    const exact = model("exact", { provider: "openai" });
    const newline = model("newline", { provider: "openai\n" });
    expect(curateOmpModels([newline, exact], filter({ providerAllow: ["openai"] }), [])).toEqual({
      shown: [exact], more: [newline],
    });
    expect(curateOmpModels([newline, exact], filter({ providerAllow: ["openai?"] }), [])).toEqual({
      shown: [newline], more: [exact],
    });
  });

  it("pins only exact canonical ids and overrides every enabled filter for them", () => {
    const pinned = familyModel("gpt-5", "gpt", "5.0.0");
    Object.assign(pinned, { int: 0, reasoning: false, input: ["text"], supportsTools: false,
      contextWindow: 1, cost: { input: 100, output: 100 } });
    const newer = familyModel("gpt-5.1", "gpt", "5.1.0");
    const otherProvider = { ...pinned, provider: "other" };
    const strict = filter({ latestPerFamily: true, minIntelligence: 100, maxInputPrice: 0,
      maxOutputPrice: 0, minContextWindow: 1_000_000, requireReasoning: true,
      requireImageInput: true, requireTools: true, providerAllow: ["nobody"], providerDeny: ["*"] });
    expect(curateOmpModels([pinned, newer, otherProvider], strict, ["openai/gpt-5"])).toEqual({
      shown: [pinned], more: [newer, otherProvider],
    });
  });

  it("matches always-show against canonical or bare ids despite every enabled filter", () => {
    const canonical = familyModel("gpt-5", "gpt", "5.0.0");
    const bare = model("favorite-x", { provider: "custom", reasoning: false, input: ["text"] });
    const newer = familyModel("gpt-5.1", "gpt", "5.1.0");
    const substring = model("not-favorite-x");
    expect(curateOmpModels([newer, canonical, bare, substring], filter({
      latestPerFamily: true, minIntelligence: 100, maxInputPrice: 0,
      maxOutputPrice: 0, minContextWindow: 1_000_000, requireReasoning: true,
      requireImageInput: true, requireTools: true, providerAllow: ["nobody"], providerDeny: ["*"],
      alwaysShow: ["OPENAI/GPT-?", "FAVORITE-?"],
    }), [])).toEqual({ shown: [canonical, bare], more: [newer, substring] });
  });

  it("falls back to all input rows only when zero models would be shown", () => {
    const rows = [model("one"), model("two")];
    expect(curateOmpModels(rows, filter({ providerDeny: ["*"] }), [])).toEqual({ shown: rows, more: [] });
    expect(curateOmpModels(rows, filter({ providerDeny: ["*"] }), ["test/one"])).toEqual({
      shown: [rows[0]], more: [rows[1]],
    });
    expect(curateOmpModels(rows, filter({ providerDeny: ["*"], alwaysShow: ["two"] }), [])).toEqual({
      shown: [rows[1]], more: [rows[0]],
    });
    expect(curateOmpModels([], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [], more: [] });
  });

  it("preserves row identity and input order in both lists without mutating inputs", () => {
    const oldAlpha = familyModel("alpha-1", "alpha", "1");
    const unknown = model("unknown");
    const beta = familyModel("beta-2", "beta", "2");
    const oldBeta = familyModel("beta-1", "beta", "1");
    const alpha = familyModel("alpha-3", "alpha", "3");
    const oldestAlpha = familyModel("alpha-0", "alpha", "0");
    const rows = [oldAlpha, unknown, beta, oldBeta, alpha, oldestAlpha];
    const original = structuredClone(rows);
    for (const row of rows) {
      Object.freeze(row.input);
      if (row.identity) Object.freeze(row.identity);
      Object.freeze(row);
    }
    Object.freeze(rows);
    const options = Object.freeze(filter({ latestPerFamily: true }));
    const result = curateOmpModels(rows, options, Object.freeze(["openai/beta-1"]));
    expect(result.shown).toEqual([oldBeta, unknown, beta, alpha]);
    expect(result.more).toEqual([oldAlpha, oldestAlpha]);
    expect(result.shown[0]).toBe(oldBeta);
    expect(result.more[0]).toBe(oldAlpha);
    expect(rows).toEqual(original);
  });

  it("partitions repeated input occurrences instead of losing or duplicating them", () => {
    const repeated = familyModel("gpt-5", "gpt", "5");
    expect(curateOmpModels([repeated, repeated], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({
      shown: [repeated], more: [repeated],
    });
  });
});

describe("latest omp model per family", () => {
  it("keeps GPT mini, nano, pro, codex, codex-mini, and codex-max variants separate", () => {
    const rows = [
      familyModel("gpt-5", "gpt", "5.0.0"),
      familyModel("gpt-5-mini", "gpt", "5.0.0"),
      familyModel("gpt-5-nano", "gpt", "5.0.0"),
      familyModel("gpt-5-pro", "gpt", "5.0.0"),
      familyModel("gpt-5-codex", "gpt", "5.0.0"),
      familyModel("gpt-5-codex-mini", "gpt", "5.0.0"),
      familyModel("gpt-5-codex-max", "gpt", "5.0.0"),
      familyModel("gpt-5.1", "gpt", "5.1.0"),
      familyModel("gpt-5.2-mini", "gpt", "5.2.0"),
    ];
    expect(curateOmpModels(rows, DEFAULT_OMP_MODEL_FILTER, [])).toEqual({
      shown: [rows[2], rows[3], rows[4], rows[5], rows[6], rows[7], rows[8]],
      more: [rows[0], rows[1]],
    });
    expect(curateOmpModels(rows, filter(), [])).toEqual({ shown: rows, more: [] });
  });

  it("keeps lite, image, and live variants apart from the regular Gemini flash family", () => {
    const rows = [
      familyModel("gemini-2.5-flash", "flash", "2.5.0", "google", "gemini"),
      familyModel("gemini-2.5-flash-lite", "flash", "2.5.0", "google", "gemini"),
      familyModel("gemini-2.5-flash-image-preview-0528", "flash", "2.5.0", "google", "gemini"),
      familyModel("gemini-live-2.5-flash", "flash", "2.5.0", "google", "gemini"),
      familyModel("gemini-3.5-flash", "flash", "3.5.0", "google", "gemini"),
      familyModel("gemini-3.5-flash-image", "flash", "3.5.0", "google", "gemini"),
    ];
    expect(curateOmpModels(rows, filter({ latestPerFamily: true }), [])).toEqual({
      shown: [rows[1], rows[3], rows[4], rows[5]], more: [rows[0], rows[2]],
    });
  });

  it.each(["-20251101", "-2025-08-07", "-preview-05-2025", "-0528"])(
    "collapses a dated twin %s in favor of its undated alias in either input order",
    (suffix) => {
      const dated = familyModel(`claude-opus-4-5${suffix}`, "opus", "4.5.0", "anthropic");
      const plain = familyModel("claude-opus-4-5", "opus", "4.5.0", "anthropic");
      expect(curateOmpModels([dated, plain], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [plain], more: [dated] });
      expect(curateOmpModels([plain, dated], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [plain], more: [dated] });
    },
  );

  it("uses identity to group Anthropic versions appearing before or after the family", () => {
    const old = familyModel("claude-3-5-sonnet-20241022", "sonnet", "3.5.0", "anthropic");
    const current = familyModel("claude-sonnet-5-5", "sonnet", "5.5.0", "anthropic");
    expect(curateOmpModels([old, current], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [current], more: [old] });
  });

  it("strips Bedrock regions, vendor prefixes, and transport versions before grouping", () => {
    const au = familyModel("au.anthropic.claude-opus-4-5-20251101-v1:0", "opus", "4.5.0", "amazon-bedrock", "anthropic");
    const us = familyModel("us.anthropic.claude-opus-5-5-v1:0", "opus", "5.5.0", "amazon-bedrock", "anthropic");
    expect(curateOmpModels([au, us], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [us], more: [au] });
  });

  it.each([":free", ":batch", ":extended", ":thinking", ":nitro", "-fast", "-nitro"])(
    "ignores OpenRouter suffix %s and keeps the plain vendor-prefixed row on ties",
    (suffix) => {
      const routed = familyModel(`openai/gpt-5${suffix}`, "gpt", "5.0.0", "openrouter", "openai");
      const plain = familyModel("openai/gpt-5", "gpt", "5.0.0", "openrouter", "openai");
      expect(curateOmpModels([routed, plain], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [plain], more: [routed] });
    },
  );

  it("preserves genuine fast variants outside OpenRouter", () => {
    const regular = familyModel("grok-3", "grok", "3.0.0", "xai");
    const fast = familyModel("grok-3-fast", "grok", "3.0.0", "xai");
    expect(curateOmpModels([regular, fast], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [regular, fast], more: [] });
  });

  it("compares dotted numeric revisions rather than lexicographic ids", () => {
    const nine = familyModel("gpt-5.9", "gpt", "5.9.0");
    const ten = familyModel("gpt-5.10", "gpt", "5.10.0");
    const six = familyModel("gpt-6", "gpt", "6.0.0");
    expect(curateOmpModels([nine, ten], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [ten], more: [nine] });
    expect(curateOmpModels([six, ten, nine], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [six], more: [ten, nine] });
  });

  it("normalizes numeric revision lengths and retains the first equally plain twin", () => {
    const first = familyModel("gpt-5.0", "gpt", "5");
    const second = familyModel("gpt-5", "gpt", "5.0.0");
    expect(curateOmpModels([first, second], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [first], more: [second] });
  });

  it("uses input order as the final tie-break rather than inventing chronology from dates", () => {
    const first = familyModel("claude-3-5-sonnet-20240620", "sonnet", "3.5.0", "anthropic");
    const second = familyModel("claude-3-5-sonnet-20241022", "sonnet", "3.5.0", "anthropic");
    expect(curateOmpModels([first, second], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: [first], more: [second] });
  });

  it("never groups across providers or identity classes", () => {
    const direct = familyModel("claude-opus-4-5", "opus", "4.5.0", "anthropic");
    const router = familyModel("anthropic/claude-opus-5-5", "opus", "5.5.0", "openrouter", "anthropic");
    const otherClass = familyModel("claude-opus-6", "opus", "6.0.0", "anthropic", "custom");
    expect(curateOmpModels([direct, router, otherClass], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({
      shown: [direct, router, otherClass], more: [],
    });
  });

  it("keeps every no-family row, including repeated ids and unknown identities", () => {
    const missing = model("same");
    const unknown = model("same", { identity: { class: "unknown" } });
    const blank = model("same", { identity: { class: "unknown", family: "" } });
    expect(curateOmpModels([missing, unknown, blank], DEFAULT_OMP_MODEL_FILTER, [])).toEqual({
      shown: [missing, unknown, blank], more: [],
    });
  });

  it("does not resurrect an older revision merely because the newest fails another filter", () => {
    const old = { ...familyModel("gpt-5", "gpt", "5"), cost: { input: 1, output: 1 } };
    const latest = { ...familyModel("gpt-5.1", "gpt", "5.1"), cost: { input: 10, output: 10 } };
    const unrelated = model("unrelated");
    expect(curateOmpModels([old, latest, unrelated], filter({ latestPerFamily: true, maxInputPrice: 2 }), [])).toEqual({
      shown: [unrelated], more: [old, latest],
    });
  });

  it("curates the captured fixture without hiding no-family models or dropping old revisions", () => {
    const result = curateOmpModels(fixture.models, filter({ latestPerFamily: true }), []);
    const shown = result.shown.map(({ provider, id }) => `${provider}/${id}`);
    const more = result.more.map(({ provider, id }) => `${provider}/${id}`);
    expect(shown).toContain("anthropic/claude-opus-5-5");
    expect(shown).toContain("anthropic/claude-sonnet-5-5");
    expect(shown).toContain("anthropic/claude-haiku-5-5");
    expect(more).toContain("anthropic/claude-opus-4-1");
    expect(more).toContain("anthropic/claude-opus-4-5");
    expect(more).toContain("anthropic/claude-sonnet-4-5");
    expect(more).toContain("anthropic/claude-3-5-sonnet-20240620");
    expect(shown).toContain("openrouter/openai/gpt-5");
    expect(more).toContain("openrouter/openai/gpt-5:free");
    expect(shown).toContain("openrouter/google/gemini-3.8-flash-image");
    expect(more).toContain("openrouter/google/gemini-2.5-flash-image-preview-0528");
    const noFamily = fixture.models.filter((row) => !row.identity?.family);
    expect(noFamily.length).toBeGreaterThan(0);
    for (const row of noFamily) {
      expect(result.shown).toContain(row);
      expect(result.more).not.toContain(row);
    }
    expect(result.shown.length + result.more.length).toBe(fixture.models.length);
    expect(curateOmpModels(fixture.models, filter(), [])).toEqual({ shown: fixture.models, more: [] });
  });
});

describe("omp model-list noise rules", () => {
  const identified = (id: string, modelClass: string, family?: string, provider = "test") =>
    model(id, { provider, identity: { class: modelClass, ...(family ? { family } : {}) } });

  it("round-trips all noise-rule settings and provider ranking", () => {
    const defaults = Object.fromEntries(Object.entries(OMP_MODEL_FILTER_SETTINGS)
      .map(([key, descriptor]) => [key, descriptor.default])) as Parameters<typeof settingsToOmpModelFilter>[0];
    const fromSettings = settingsToOmpModelFilter({
      ...defaults,
      modelFilterRepairIdentity: false,
      modelFilterHideTaskModels: false,
      modelFilterShareScores: false,
      modelFilterHideOldGenerations: false,
      modelFilterCollapseCopies: false,
      modelFilterProviderRanking: " anthropic-250k*, , OPENAI ",
    });
    expect(fromSettings).toEqual({
      ...expectedDefaults, repairIdentity: false, hideTaskModels: false, shareScores: false,
      hideOldGenerations: false, collapseCopies: false, providerRanking: ["anthropic-250k*", "OPENAI"],
    });
    expect(parseOmpModelFilter(JSON.parse(JSON.stringify(fromSettings)))).toEqual(fromSettings);
  });

  describe("identity repair", () => {
    it.each([
      ["glm", ["glm-5.1", "glm-5.3"]],
      ["qwen", ["qwen3.5", "qwen3.6"]],
    ] as const)("folds %s rows without families to the newest", (modelClass, ids) => {
      const rows = ids.map((id) => identified(id, modelClass));
      const enabled = filter({ latestPerFamily: true, repairIdentity: true });
      expect(curateOmpModels(rows, enabled, [])).toEqual({ shown: [rows[1]], more: [rows[0]] });
      expect(curateOmpModels(rows, { ...enabled, repairIdentity: false }, [])).toEqual({ shown: rows, more: [] });
    });

    it("folds versioned Kimi families while preserving the code variant", () => {
      const rows = ["k2.5", "k2.6", "k3", "k2.7-code"]
        .map((family) => identified(`kimi-${family}`, "kimi", family));
      expect(curateOmpModels(rows, filter({ latestPerFamily: true, repairIdentity: true }), []))
        .toEqual({ shown: [rows[2], rows[3]], more: [rows[0], rows[1]] });
    });

    it("reads Minimax id revisions before the number embedded in its family", () => {
      const rows = [identified("minimax-m2.5", "minimax", "m2"),
        identified("minimax-m2.7", "minimax", "m2"), identified("minimax-m3", "minimax", "m3")];
      const enabled = filter({ latestPerFamily: true, repairIdentity: true });
      expect(curateOmpModels(rows.slice(0, 2), enabled, []))
        .toEqual({ shown: [rows[1]], more: [rows[0]] });
      expect(curateOmpModels(rows, enabled, [])).toEqual({ shown: [rows[2]], more: rows.slice(0, 2) });
    });

    it("reads Fireworks p-separated versions and missing o-series revisions", () => {
      const glm = ["glm-5p2", "glm-5p3"].map((id) => identified(id, "glm", undefined, "fireworks"));
      const reasoning = ["o1", "o3"].map((id) => identified(id, "openai", "o-series", "openai"));
      expect(curateOmpModels([...glm, ...reasoning], filter({ latestPerFamily: true, repairIdentity: true }), []))
        .toEqual({ shown: [glm[1], reasoning[1]], more: [glm[0], reasoning[0]] });
    });

    it("leaves unknown identities alone and does not read parameter sizes as generations", () => {
      const unknown = ["unknown-1", "unknown-9"].map((id) => identified(id, "unknown"));
      const sized = identified("qwen-qwq-32b", "qwen");
      const current = identified("qwen3.6", "qwen");
      const rows = [...unknown, sized, current];
      expect(curateOmpModels(rows, DEFAULT_OMP_MODEL_FILTER, [])).toEqual({ shown: rows, more: [] });
    });
  });

  describe("task models", () => {
    it.each([
      "embed", "embedding", "embeddings", "rerank", "reranker", "tts", "realtime",
      "live", "imagine", "flux", "robotics", "safeguard", "compound",
      "native-audio", "computer-use", "deep-research",
    ])("moves whole-token marker %s to More", (marker) => {
      const task = model(`vendor-${marker}-1`);
      const chat = model("chat");
      expect(curateOmpModels([task, chat], filter({ hideTaskModels: true }), []))
        .toEqual({ shown: [chat], more: [task] });
      expect(curateOmpModels([task, chat], filter(), [])).toEqual({ shown: [task, chat], more: [] });
    });

    it("uses non-chat kind without mistaking similar chat tokens for markers", () => {
      const image = model("drawing-1", { kind: "image" });
      const rows = ["gemini-3.5-flash-image", "gpt-5.6-terra", "deliver-1", "olive-2", "liveness-1", "gpt-4o-mini"]
        .map((id) => model(id, { kind: "chat" }));
      expect(curateOmpModels([image, ...rows], filter({ hideTaskModels: true }), []))
        .toEqual({ shown: rows, more: [image] });
    });

    it("excludes a newer task row from latest-per-family competition", () => {
      const chat = familyModel("gpt-5", "gpt", "5");
      const task = { ...familyModel("gpt-6", "gpt", "6"), kind: "image" };
      expect(curateOmpModels([task, chat], DEFAULT_OMP_MODEL_FILTER, []))
        .toEqual({ shown: [chat], more: [task] });
    });
  });

  describe("shared scores", () => {
    it.each([
      "vendor/glm-5.3", "accounts/fireworks/routers/glm-5p3", "glm-5.3-fast",
      "glm-5.3-20261001",
    ])("borrows a score for %s without changing the row", (id) => {
      const scored = model("glm-5.3", { int: 20, provider: "direct" });
      const copy = model(id);
      const original = structuredClone(copy);
      const flagship = model("glm-6");
      const rows = [scored, copy, flagship];
      const enabled = filter({ shareScores: true, minIntelligence: 30 });
      expect(curateOmpModels(rows, enabled, [])).toEqual({ shown: [flagship], more: [scored, copy] });
      expect(curateOmpModels(rows, { ...enabled, shareScores: false }, []))
        .toEqual({ shown: [copy, flagship], more: [scored] });
      expect(copy).toEqual(original);
    });

    it("does not borrow across pro, mini, new flagship, or conflicting loose identities", () => {
      const low = model("gpt-5", { int: 20 });
      const high = model("gpt-5-20261001", { int: 50 });
      const unscored = ["gpt-5-pro", "gpt-5-mini", "gpt-6", "gpt-5-fast"].map((id) => model(id));
      expect(curateOmpModels([low, high, ...unscored], filter({ shareScores: true, minIntelligence: 30 }), []))
        .toEqual({ shown: [high, ...unscored], more: [low] });
    });
  });

  describe("old generations", () => {
    it("hides generations at least two behind within the same provider and class", () => {
      const old = ["gpt-4o", "o3", "o4-mini"].map((id) => identified(id, "openai", undefined, "openai"));
      const current = identified("gpt-6", "openai", undefined, "openai");
      const geminiOld = identified("gemini-1.5", "gemini", undefined, "google");
      const gemini = identified("gemini-3.8", "gemini", undefined, "google");
      const rows = [...old, current, geminiOld, gemini];
      const enabled = filter({ repairIdentity: true, hideOldGenerations: true });
      expect(curateOmpModels(rows, enabled, [])).toEqual({ shown: [current, gemini], more: [...old, geminiOld] });
      expect(curateOmpModels(rows, enabled, ["openai/o3"]))
        .toEqual({ shown: [old[1], current, gemini], more: [old[0], old[2], geminiOld] });
    });

    it("keeps adjacent generations, different providers/classes, unknowns, and separately numbered lines", () => {
      const rows = [
        identified("gpt-5.6", "openai"), identified("gpt-6", "openai"),
        identified("gemini-3.8", "gemini"), identified("gemini-4", "gemini"),
        identified("gpt-1", "openai", undefined, "other"),
        identified("gpt-1", "custom"), identified("gpt-1", "unknown"),
        identified("grok-code-fast-1", "xai"), identified("grok-build-0.1", "xai"),
        identified("grok-4", "xai"),
      ];
      expect(curateOmpModels(rows, filter({ repairIdentity: true, hideOldGenerations: true }), []))
        .toEqual({ shown: rows, more: [] });
    });
  });

  describe("provider copies", () => {
    it("uses catalog order unless ranking, the default provider, or a pin takes precedence", () => {
      const [direct, large] = ["anthropic", "anthropic-250k-prefer-using-this-one"]
        .map((provider) => identified("claude-opus-4-5", "anthropic", "opus", provider));
      const anchor = identified("claude-sonnet-5", "anthropic", "sonnet", large!.provider);
      const rows = [direct!, large!, anchor];
      const enabled = filter({ collapseCopies: true });
      expect(curateOmpModels(rows, enabled, [])).toEqual({ shown: [direct, anchor], more: [large] });
      expect(curateOmpModels(rows, enabled, [], `${anchor.provider}/${anchor.id}`))
        .toEqual({ shown: [anchor, large], more: [direct] });
      const ranked = { ...enabled, providerRanking: ["ANTHROPIC-250K*"] };
      expect(curateOmpModels(rows, ranked, [])).toEqual({ shown: [large, anchor], more: [direct] });
      const directDefault = identified("claude-haiku-5", "anthropic", "haiku", direct!.provider);
      expect(curateOmpModels([...rows, directDefault], ranked, [], `${directDefault.provider}/${directDefault.id}`))
        .toEqual({ shown: [directDefault, large, anchor], more: [direct] });
      expect(curateOmpModels(rows, ranked, [`${direct!.provider}/${direct!.id}`]))
        .toEqual({ shown: [direct, anchor], more: [large] });
    });

    it("honors ranking list order, whole-string matching, and the single-character wildcard", () => {
      const rows = ["route-12", "route-1", "not-route-1"].map((provider) =>
        identified("gpt-6", "openai", undefined, provider));
      expect(curateOmpModels(rows, filter({ collapseCopies: true, providerRanking: ["ROUTE-?", "route-*"] }), []))
        .toEqual({ shown: [rows[1]], more: [rows[0], rows[2]] });
    });

    it("collapses namespaced Groq and Fireworks copies but preserves routing suffixes and unknown classes", () => {
      const groq = identified("openai/gpt-oss-120b", "openai", undefined, "groq");
      const fireworks = identified("gpt-oss-120b", "openai", undefined, "fireworks");
      const free = identified("gpt-oss-120b:free", "openai", undefined, "router");
      const unknown = ["router-a", "router-b"].map((provider) => identified("shopify/auto", "unknown", undefined, provider));
      const only = identified("unique-1", "custom");
      const rows = [groq, fireworks, free, ...unknown, only];
      expect(curateOmpModels(rows, filter({ collapseCopies: true }), []))
        .toEqual({ shown: [groq, free, ...unknown, only], more: [fireworks] });
      expect(curateOmpModels(rows, filter(), [])).toEqual({ shown: rows, more: [] });
    });

    it("keeps both pinned copies and falls through to an eligible copy when the preferred one is denied", () => {
      const rows = ["anthropic", "anthropic-250k-prefer-using-this-one"]
        .map((provider) => identified("claude-opus-4-5", "anthropic", "opus", provider));
      const enabled = filter({ collapseCopies: true });
      expect(curateOmpModels(rows, enabled, rows.map((row) => `${row.provider}/${row.id}`)))
        .toEqual({ shown: rows, more: [] });
      expect(curateOmpModels(rows, { ...enabled, providerRanking: ["anthropic"],
        providerDeny: ["anthropic"] }, [])).toEqual({ shown: [rows[1]], more: [rows[0]] });
    });
  });

  it("orders the late default first, other pins in input order, and the remaining rows in input order", () => {
    const rows = ["regular-a", "favorite-a", "regular-b", "explicit-pin", "favorite-b", "default"]
      .map((id) => model(id));
    expect(curateOmpModels(rows, filter({ alwaysShow: ["favorite-*"] }), ["test/explicit-pin"], "test/default"))
      .toEqual({ shown: [rows[5], rows[1], rows[3], rows[4], rows[0], rows[2]], more: [] });
  });

  it("keeps pinned rows despite all noise and threshold rules", () => {
    const old = identified("gpt-1-live", "openai", undefined, "blocked");
    Object.assign(old, { kind: "image", int: 0, reasoning: false, input: ["text"],
      supportsTools: false, contextWindow: 1, cost: { input: 100, output: 100 } });
    const copy = { ...old, provider: "copy" };
    const always = { ...old, provider: "always" };
    const newest = identified("gpt-6", "openai", undefined, "blocked");
    const strict = { ...DEFAULT_OMP_MODEL_FILTER, minIntelligence: 100, maxInputPrice: 1,
      maxOutputPrice: 1, minContextWindow: 1000, requireReasoning: true, requireImageInput: true,
      requireTools: true, providerAllow: ["none"], providerDeny: ["*"], alwaysShow: ["always/*"] };
    expect(curateOmpModels([newest, old, always, copy], strict, ["blocked/gpt-1-live"], "copy/gpt-1-live"))
      .toEqual({ shown: [copy, old, always], more: [newest] });
  });
});
