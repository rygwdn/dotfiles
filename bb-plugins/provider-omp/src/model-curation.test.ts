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
  return { ...DEFAULT_OMP_MODEL_FILTER, latestPerFamily: false, ...overrides };
}

const expectedDefaults: OmpModelFilter = {
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

describe("parseOmpModelFilter", () => {
  it("defaults to latest per family with every other filter disabled", () => {
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
    expect(result.shown).toEqual([unknown, beta, oldBeta, alpha]);
    expect(result.more).toEqual([oldAlpha, oldestAlpha]);
    expect(result.shown[0]).toBe(unknown);
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
    expect(curateOmpModels(rows, DEFAULT_OMP_MODEL_FILTER, [])).toEqual({
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
    const result = curateOmpModels(fixture.models, DEFAULT_OMP_MODEL_FILTER, []);
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
