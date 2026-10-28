import { describe, expect, it } from "vitest";
import { createOmpModelContextWindowResolverFrom } from "./delta-translation.js";
import { DEFAULT_OMP_MODEL_FILTER } from "./model-curation.js";
import {
  bbDisplayedReasoningLevel,
  buildOmpAvailableModels,
  type OmpCatalogModel,
} from "./model-list.js";
import type { OmpModelPreset } from "./native-roots.js";

describe("omp model list", () => {
  it("adds off as none and preserves a sparse native effort ladder", () => {
    const { models } = buildOmpAvailableModels({
      models: [
        {
          id: "sparse-reasoning-model",
          name: "Sparse reasoning model",
          provider: "custom",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["high", "low", "high"] },
        },
      ],
    });

    expect(
      models[0]?.supportedReasoningEfforts.map(
        ({ reasoningEffort }) => reasoningEffort,
      ),
    ).toEqual(["none", "low", "high"]);
    expect(models[0]?.defaultReasoningEffort).toBe("low");
  });

  it("maps minimal, xhigh, and max without inventing intermediate efforts", () => {
    const { models } = buildOmpAvailableModels({
      models: [
        {
          id: "extended-reasoning-model",
          name: "Extended reasoning model",
          provider: "custom",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["max", "minimal", "xhigh"] },
        },
      ],
    });

    expect(
      models[0]?.supportedReasoningEfforts.map(
        ({ reasoningEffort }) => reasoningEffort,
      ),
    ).toEqual(["none", "minimal", "xhigh", "max"]);
    expect(models[0]?.supportedReasoningEfforts[1]).toEqual({
      reasoningEffort: "minimal",
      description: "Minimal reasoning",
    });
    expect(models[0]?.defaultReasoningEffort).toBe("minimal");
  });

  it.each([
    undefined,
    {},
    { efforts: [] },
    { efforts: ["unknown"] },
    { defaultLevel: "high" },
  ])("does not infer efforts from missing or unusable thinking metadata: %j", (thinking) => {
    const { models } = buildOmpAvailableModels({
      models: [
        {
          id: "uncontrollable-reasoning-model",
          name: "Uncontrollable reasoning model",
          provider: "custom",
          reasoning: true,
          input: ["text"],
          thinking,
        },
      ],
    });

    expect(models[0]).toMatchObject({
      supportedReasoningEfforts: [
        { reasoningEffort: "none", description: "No extended thinking" },
      ],
      defaultReasoningEffort: "none",
    });
  });

  it("exposes only none for non-reasoning models even with thinking metadata", () => {
    const { models } = buildOmpAvailableModels({
      models: [
        {
          id: "non-reasoning-model",
          name: "Non-reasoning model",
          provider: "custom",
          reasoning: false,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"], defaultLevel: "high" },
        },
      ],
    });

    expect(models[0]).toMatchObject({
      supportedReasoningEfforts: [{ reasoningEffort: "none" }],
      defaultReasoningEffort: "none",
    });
  });

  it.each(["minimal", "low", "medium", "high", "xhigh", "max"])(
    "uses the native defaultLevel when %s is supported",
    (defaultLevel) => {
      const { models } = buildOmpAvailableModels({
        models: [
          {
            id: "reasoning-model",
            name: "Reasoning model",
            provider: "custom",
            reasoning: true,
            input: ["text"],
            thinking: {
              efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
              defaultLevel,
            },
          },
        ],
      });

      expect(models[0]?.defaultReasoningEffort).toBe(defaultLevel);
    },
  );

  it.each([
    {
      efforts: ["low", "medium", "high"],
      defaultLevel: undefined,
      expected: "medium",
    },
    {
      efforts: ["low", "medium", "high"],
      defaultLevel: "max",
      expected: "medium",
    },
    {
      efforts: ["minimal", "max"],
      defaultLevel: "unknown",
      expected: "minimal",
    },
    { efforts: [], defaultLevel: "high", expected: "none" },
  ])(
    "falls back to $expected when defaultLevel is $defaultLevel for $efforts",
    ({ efforts, defaultLevel, expected }) => {
      const { models } = buildOmpAvailableModels({
        models: [
          {
            id: "reasoning-model",
            name: "Reasoning model",
            provider: "custom",
            reasoning: true,
            input: ["text"],
            thinking: { efforts, defaultLevel },
          },
        ],
      });

      expect(models[0]?.defaultReasoningEffort).toBe(expected);
    },
  );

  it.each([
    {
      provider: "anthropic",
      reasoning: true,
      input: ["text", "image"],
      description: "Anthropic reasoning, multimodal model via OMP",
    },
    {
      provider: "custom",
      reasoning: false,
      input: ["text"],
      description: "Custom non-reasoning model via OMP",
    },
  ])("preserves model descriptions: $description", ({ description, ...metadata }) => {
    const { models } = buildOmpAvailableModels({
      models: [{ id: "model", name: "Model", ...metadata }],
    });

    expect(models[0]?.description).toBe(description);
  });

  it.each([
    {
      metadata: { cost: { input: 5, output: 25 }, contextWindow: 1_000_000, int: 57.63 },
      suffix: " · $5/$25 per M tokens · 1M context · score 57.6",
    },
    {
      metadata: { cost: { input: 0.15, output: 0.6 }, contextWindow: 128_000 },
      suffix: " · $0.15/$0.6 per M tokens · 128K context",
    },
    // All-zero cost means unknown price, not free.
    { metadata: { cost: { input: 0, output: 0 }, contextWindow: null }, suffix: "" },
  ])("adds price, context and score to the description: '$suffix'", ({ metadata, suffix }) => {
    const { models } = buildOmpAvailableModels({
      models: [{ id: "model", name: "Model", provider: "custom", reasoning: false, input: ["text"], ...metadata }],
    });
    expect(models[0]?.description).toBe(`Custom non-reasoning model via OMP${suffix}`);
  });

  it("moves filtered models to More models but keeps omp's current model and modelRoles targets shown", () => {
    const opus = (revision: string, id: string) => ({
      id,
      name: id,
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      identity: { class: "anthropic", family: "opus", revision },
    });
    const { models, selectedOnlyModels } = buildOmpAvailableModels({
      models: [opus("4.1.0", "claude-opus-4-1"), opus("4.5.0", "claude-opus-4-5"), opus("5.5.0", "claude-opus-5-5"), opus("4.0.0", "claude-opus-4")],
      preferredDefaultId: "anthropic/claude-opus-4-1",
      modelRoles: { default: "anthropic/claude-opus-4-5:high", task: "web/perplexity" },
    });
    expect(models.map((model) => [model.id, model.isDefault])).toEqual([
      ["anthropic/claude-opus-4-1", true],
      ["anthropic/claude-opus-4-5", false],
      ["anthropic/claude-opus-5-5", false],
    ]);
    expect(selectedOnlyModels.map((model) => model.id)).toEqual(["anthropic/claude-opus-4"]);
  });

  it("keeps native dated models and aliases selectable in catalog order", () => {
    const { models, selectedOnlyModels } = buildOmpAvailableModels({
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high", "xhigh"] },
        },
        {
          id: "claude-opus-4-6-20240620",
          name: "Claude Opus 4.6 (2024-06-20)",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"] },
        },
      ],
    });

    expect(models.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-6-20240620",
    ]);
    expect(selectedOnlyModels).toEqual([]);
    expect(models[1]).toEqual(
      expect.objectContaining({
        displayName: "Claude Opus 4.6 (2024-06-20)",
        isDefault: false,
      }),
    );
  });

  it("keeps canonical provider prefixes on model IDs containing slashes", () => {
    const { models } = buildOmpAvailableModels({
      models: [
        {
          id: "deepseek/deepseek-v4-flash-0731",
          name: "DeepSeek V4 Flash",
          provider: "openrouter",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"] },
        },
        {
          id: "openai/gpt-5.1-codex",
          name: "GPT-5.1 Codex",
          provider: "openrouter",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"] },
        },
        {
          id: "accounts/fireworks/models/deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          provider: "fireworks",
          reasoning: false,
          input: ["text"],
        },
      ],
    });

    expect(models.map(({ id, model, routeProviderId }) => ({ id, model, routeProviderId }))).toEqual([
      {
        id: "openrouter/deepseek/deepseek-v4-flash-0731",
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
        routeProviderId: "openrouter",
      },
      {
        id: "openrouter/openai/gpt-5.1-codex",
        model: "openrouter/openai/gpt-5.1-codex",
        routeProviderId: "openrouter",
      },
      {
        id: "fireworks/accounts/fireworks/models/deepseek-v4-flash",
        model: "fireworks/accounts/fireworks/models/deepseek-v4-flash",
        routeProviderId: "fireworks",
      },
    ]);
  });

  it.each([
    { preferredDefaultId: "custom/second-model", expected: "custom/second-model" },
    { preferredDefaultId: undefined, expected: "custom/first-model" },
    { preferredDefaultId: "custom/unavailable-model", expected: "custom/first-model" },
  ])(
    "selects $expected with preferredDefaultId $preferredDefaultId",
    ({ preferredDefaultId, expected }) => {
      const { models } = buildOmpAvailableModels({
        models: [
          {
            id: "first-model",
            name: "First model",
            provider: "custom",
            reasoning: false,
            input: ["text"],
          },
          {
            id: "second-model",
            name: "Second model",
            provider: "custom",
            reasoning: false,
            input: ["text"],
          },
        ],
        preferredDefaultId,
      });

      expect(models.map((model) => model.id)).toEqual([
        expected,
        ...["custom/first-model", "custom/second-model"].filter((id) => id !== expected),
      ]);
      expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
        expected,
      ]);
    },
  );

  it("uses the active dated default without hiding any native models", () => {
    const { models, selectedOnlyModels } = buildOmpAvailableModels({
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"] },
        },
        {
          id: "claude-opus-4-8-20260115",
          name: "Claude Opus 4.8 (2026-01-15)",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"] },
        },
        {
          id: "claude-opus-4-6-20240620",
          name: "Claude Opus 4.6 (2024-06-20)",
          provider: "anthropic",
          reasoning: true,
          input: ["text"],
          thinking: { efforts: ["low", "medium", "high"] },
        },
      ],
      preferredDefaultId: "anthropic/claude-opus-4-8-20260115",
    });

    expect(models.map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4-8-20260115",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-6-20240620",
    ]);
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4-8-20260115",
    ]);
    expect(selectedOnlyModels).toEqual([]);
  });

  it("keeps role targets immediately after a late default ahead of unpinned raw models", () => {
    const catalog: OmpCatalogModel[] = ["ordinary", "role", "preset-role", "active"].map((id) => ({
      id, name: id, provider: "custom", reasoning: false, input: ["text"],
    }));
    const { models } = buildOmpAvailableModels({
      models: catalog,
      preferredDefaultId: "custom/active",
      modelRoles: { task: "custom/role:high" },
      presets: [{
        name: "coding", source: "global",
        modelRoles: { default: "custom/active", advisor: "custom/preset-role" },
      }],
    });
    expect(models[0]).toMatchObject({ id: "custom/active", isDefault: true });
    expect(models.filter(({ id }) => !id.startsWith("preset:")).map(({ id }) => id))
      .toEqual(["custom/active", "custom/role", "custom/preset-role", "custom/ordinary"]);
    expect(models.map(({ id }) => id)).toEqual([
      "custom/active", "preset:coding", "custom/role", "custom/preset-role", "custom/ordinary",
    ]);
  });

  it("keeps collapsed copies and task models selectable without losing catalog rows", () => {
    const catalog: OmpCatalogModel[] = [
      { id: "glm-5.3", provider: "zai", identity: { class: "glm" } },
      { id: "z-ai/glm-5.3", provider: "openrouter", identity: { class: "glm" } },
      { id: "specialist", provider: "custom", kind: "embedding" },
      { id: "gpt-5.6-terra", provider: "openai", identity: { class: "gpt" }, kind: "chat" },
    ].map((model) => ({ ...model, name: model.id, reasoning: false, input: ["text"] }));
    const { models, selectedOnlyModels } = buildOmpAvailableModels({ models: catalog });
    expect(models.map(({ id }) => id)).toEqual(["zai/glm-5.3", "openai/gpt-5.6-terra"]);
    expect(selectedOnlyModels.map(({ id }) => id)).toEqual([
      "openrouter/z-ai/glm-5.3", "custom/specialist",
    ]);
    expect([...models, ...selectedOnlyModels].map(({ id }) => id).sort())
      .toEqual(catalog.map(({ provider, id }) => `${provider}/${id}`).sort());
  });

  it("handles an empty catalog", () => {
    expect(buildOmpAvailableModels({ models: [] })).toEqual({
      models: [],
      selectedOnlyModels: [],
    });
  });

  it("reads the context window of the provider that served the message", () => {
    const resolveContextWindow = createOmpModelContextWindowResolverFrom([
      {
        id: "deepseek/deepseek-v4-flash",
        provider: "openrouter",
        contextWindow: 1_048_575,
      },
      {
        id: "deepseek-v4-flash",
        provider: "deepseek",
        contextWindow: 1_000_000,
      },
    ]);

    const assistant = (provider: string | undefined, model: string) => ({
      role: "assistant" as const,
      content: [],
      ...(provider === undefined ? {} : { provider }),
      model,
    });

    expect(
      resolveContextWindow(
        assistant("openrouter", "deepseek/deepseek-v4-flash"),
      ),
    ).toBe(1_048_575);
    expect(
      resolveContextWindow(assistant("deepseek", "deepseek-v4-flash")),
    ).toBe(1_000_000);
    expect(
      resolveContextWindow(assistant(undefined, "deepseek-v4-flash")),
    ).toBe(1_000_000);
    expect(resolveContextWindow(assistant("openrouter", "unknown"))).toBeNull();
    expect(
      resolveContextWindow(assistant("openrouter", "deepseek-v4-flash")),
    ).toBeNull();
  });
});

describe("bb's displayed reasoning level", () => {
  function pickerModel(efforts: string[]) {
    const [model] = buildOmpAvailableModels({
      models: [{
        id: "m", name: "M", provider: "p", reasoning: true, input: ["text"], thinking: { efforts },
      }],
    }).models;
    return model!;
  }

  it.each([
    { efforts: ["low", "high", "max"], level: "medium", shown: "high" },
    { efforts: ["low", "high", "max"], level: "xhigh", shown: "high" },
    { efforts: ["low", "medium", "high"], level: "max", shown: "high" },
    { efforts: ["low", "high", "max"], level: "low", shown: "low" },
    { efforts: ["low", "high", "max"], level: "none", shown: "none" },
    { efforts: ["minimal", "high"], level: "low", shown: "none" },
    { efforts: ["low", "high"], level: "minimal", shown: "high" },
  ])("shows $shown for $level on $efforts", ({ efforts, level, shown }) => {
    expect(bbDisplayedReasoningLevel(level, pickerModel(efforts))).toBe(shown);
  });
});

describe("omp preset picker entries", () => {
  const oldModel: OmpCatalogModel = {
    id: "old",
    name: "Old",
    provider: "custom",
    reasoning: true,
    input: ["text"],
    thinking: { efforts: ["low", "high"] },
    int: 10,
  };
  const newModel: OmpCatalogModel = {
    ...oldModel,
    id: "new",
    name: "New",
    int: 80,
  };
  const hiddenModel: OmpCatalogModel = {
    ...oldModel,
    id: "hidden",
    name: "Hidden",
    int: 5,
  };
  const catalog = [oldModel, hiddenModel, newModel];
  const curatedFilter = { ...DEFAULT_OMP_MODEL_FILTER, minIntelligence: 50 };
  const presets: OmpModelPreset[] = [
    {
      name: "best-coder",
      modelRoles: { default: "custom/old:high", task: "@slow" },
      source: "global",
    },
    {
      name: "economy",
      modelRoles: { default: "custom/new:low" },
      source: "project",
    },
  ];

  it.each([
    {
      mode: "both" as const,
      shown: ["custom/new", "preset:best-coder", "preset:economy", "custom/old"],
      more: ["custom/hidden"],
      defaultId: "custom/new",
    },
    {
      mode: "presets" as const,
      shown: ["preset:best-coder", "preset:economy"],
      more: ["custom/old", "custom/hidden", "custom/new"],
      defaultId: "preset:best-coder",
    },
    {
      mode: "off" as const,
      shown: ["custom/new"],
      more: ["custom/old", "custom/hidden"],
      defaultId: "custom/new",
    },
  ])("orders presets and raw models in $mode mode", ({ mode, shown, more, defaultId }) => {
    const result = buildOmpAvailableModels({
      models: catalog,
      presets,
      preferredDefaultId: "custom/new",
      filter: { ...curatedFilter, modelPresetsInPicker: mode },
    });
    expect(result.models.map(({ id }) => id)).toEqual(shown);
    expect(result.models.map(({ model }) => model)).toEqual(shown);
    expect(result.selectedOnlyModels.map(({ id }) => id)).toEqual(more);
    expect(result.models.filter(({ isDefault }) => isDefault).map(({ id }) => id))
      .toEqual([defaultId]);
    expect(result.selectedOnlyModels.every(({ isDefault }) => !isDefault)).toBe(true);
  });

  it("uses both mode by default and describes preset roles and non-global sources", () => {
    const { models } = buildOmpAvailableModels({ models: catalog, presets });
    expect(models.find(({ id }) => id === "preset:best-coder")).toMatchObject({
      id: "preset:best-coder",
      model: "preset:best-coder",
      displayName: "Best coder",
      description: "Preset · default old · task @slow",
      defaultReasoningEffort: "high",
    });
    expect(models.find(({ id }) => id === "preset:economy")?.description).toBe("Preset · default new · project");
  });

  it("pins raw models referenced by every preset role, not only the default role", () => {
    const { models, selectedOnlyModels } = buildOmpAvailableModels({
      models: catalog,
      preferredDefaultId: "custom/new",
      presets: [{ ...presets[0]!, modelRoles: { default: "custom/new", advisor: "custom/old:max" } }],
      filter: curatedFilter,
    });
    expect(models.map(({ id }) => id)).toEqual(["custom/new", "preset:best-coder", "custom/old"]);
    expect(selectedOnlyModels.map(({ id }) => id)).toEqual(["custom/hidden"]);
  });

  it("keeps descriptions compact with default first and includes overlay provenance", () => {
    const { models } = buildOmpAvailableModels({
      models: catalog,
      presets: [{
        name: "many_roles",
        source: "overlay",
        modelRoles: { task: "@slow", plan: "custom/new", default: "custom/old", advisor: "custom/new" },
      }],
    });
    expect(models.find(({ id }) => id === "preset:many_roles")).toMatchObject({
      displayName: "Many roles",
      description: "Preset · default old · task @slow · plan new · … · overlay",
    });
  });

  it("marks the preset with the same complete role map as the single default", () => {
    const matching = { default: "custom/new:low", task: "@slow" };
    const { models } = buildOmpAvailableModels({
      models: catalog,
      presets: [presets[0]!, { ...presets[1]!, modelRoles: matching }],
      modelRoles: { task: "@slow", default: "custom/new:low", unused: "" },
      filter: { ...DEFAULT_OMP_MODEL_FILTER, modelPresetsInPicker: "presets" },
    });
    expect(models[0]).toMatchObject({ id: "preset:economy", isDefault: true });
    expect(models.filter(({ isDefault }) => isDefault).map(({ id }) => id))
      .toEqual(["preset:economy"]);
  });

  it.each([
    { default: "custom/new" },
    { default: "custom/new:low", task: "custom/old" },
    { default: "custom/new:low", extra: "custom/old" },
  ] as Record<string, string>[])("falls back to the first preset when effective roles do not exactly match: %j", (modelRoles) => {
    const { models } = buildOmpAvailableModels({
      models: catalog,
      presets,
      modelRoles,
      filter: { ...DEFAULT_OMP_MODEL_FILTER, modelPresetsInPicker: "presets" },
    });
    expect(models.filter(({ isDefault }) => isDefault).map(({ id }) => id))
      .toEqual(["preset:best-coder"]);
  });

  it.each(["both", "presets", "off"] as const)("keeps curated behavior with no presets in %s mode", (mode) => {
    const result = buildOmpAvailableModels({
      models: catalog,
      presets: [],
      preferredDefaultId: "custom/new",
      filter: { ...curatedFilter, modelPresetsInPicker: mode },
    });
    expect(result.models.map(({ id, isDefault }) => [id, isDefault])).toEqual([["custom/new", true]]);
    expect(result.selectedOnlyModels.map(({ id }) => id)).toEqual(["custom/old", "custom/hidden"]);
  });

  it.each([
    { modelId: "fireworks:accounts/fireworks/routers/glm-5p3-fast", suffix: ":high", effort: "high" },
    { modelId: "fireworks:accounts/fireworks/routers/glm-5p3-fast:custom", suffix: "", effort: "medium" },
  ])("resolves default role metadata without splitting internal colons: $modelId$suffix", ({ modelId, suffix, effort }) => {
    const { models } = buildOmpAvailableModels({
      models: [{ ...oldModel, id: modelId, provider: "fireworks-300k" }],
      presets: [{
        name: "router",
        modelRoles: { default: `fireworks-300k/${modelId}${suffix}` },
        source: "global",
      }],
    });
    expect(models.find(({ id }) => id === "preset:router")?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort))
      .toEqual(["none", "low", "high"]);
    expect(models.find(({ id }) => id === "preset:router")?.defaultReasoningEffort).toBe(effort);
  });

  it("follows the preset's default role alias for reasoning metadata", () => {
    const { models } = buildOmpAvailableModels({
      models: [{ ...oldModel, provider: "provider", id: "B" }],
      presets: [{
        name: "aliased",
        source: "global",
        modelRoles: { default: "@slow", slow: "provider/B:high" },
        defaultThinkingLevel: "low",
      }],
    });
    expect(models.find(({ id }) => id === "preset:aliased")?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort))
      .toEqual(["none", "low", "high"]);
    expect(models.find(({ id }) => id === "preset:aliased")?.defaultReasoningEffort).toBe("high");
  });

  it("uses the first resolvable default candidate's metadata and pins every role-list candidate", () => {
    const { models, selectedOnlyModels } = buildOmpAvailableModels({
      models: [
        oldModel,
        { ...hiddenModel, id: "unreferenced" },
        hiddenModel,
        newModel,
      ],
      filter: curatedFilter,
      presets: [{
        name: "fallbacks",
        source: "global",
        defaultThinkingLevel: "high",
        modelRoles: {
          default: "@slow",
          slow: "missing/model:off, custom/old:low, custom/new:high",
          task: "missing/other, custom/hidden:max",
        },
      }],
    });
    expect(models.map(({ id }) => id))
      .toEqual(["custom/old", "preset:fallbacks", "custom/hidden", "custom/new"]);
    expect(selectedOnlyModels.map(({ id }) => id)).toEqual(["custom/unreferenced"]);
    expect(models.find(({ id }) => id === "preset:fallbacks")?.defaultReasoningEffort).toBe("low");
    expect(models.find(({ id }) => id === "preset:fallbacks")?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort))
      .toEqual(["none", "low", "high"]);
  });

  it.each([
    { level: "off", expected: "none" },
    { level: "auto", expected: "medium" },
    { level: "low", expected: "low" },
  ])("uses preset thinking $level when the default role has no suffix", ({ level, expected }) => {
    const { models } = buildOmpAvailableModels({
      models: catalog,
      presets: [{ ...presets[0]!, modelRoles: { default: "custom/old" }, defaultThinkingLevel: level }],
    });
    expect(models.find(({ id }) => id === "preset:best-coder")?.defaultReasoningEffort).toBe(expected);
  });

  it("prefers the default role's explicit suffix over preset-wide thinking", () => {
    const { models } = buildOmpAvailableModels({
      models: catalog,
      presets: [{ ...presets[0]!, defaultThinkingLevel: "low" }],
    });
    expect(models.find(({ id }) => id === "preset:best-coder")?.defaultReasoningEffort).toBe("high");
  });

  it.each([
    { selector: "custom/old:off", expected: "none" },
    { selector: "custom/old:auto", expected: "medium" },
    { selector: "custom/old", expected: "medium" },
  ])("maps default role thinking $selector", ({ selector, expected }) => {
    const { models } = buildOmpAvailableModels({
      models: catalog,
      presets: [{ ...presets[0]!, modelRoles: { default: selector } }],
    });
    expect(models.find(({ id }) => id === "preset:best-coder")?.defaultReasoningEffort).toBe(expected);
  });

  it.each(["@slow", "custom/*", "missing/model:high", undefined])(
    "uses the full effort ladder for an unresolved default role %s",
    (selector) => {
      const { models } = buildOmpAvailableModels({
        models: catalog,
        presets: [{ ...presets[0]!, modelRoles: selector ? { default: selector } : { task: "@slow" } }],
      });
      const preset = models.find(({ id }) => id === "preset:best-coder");
      expect(preset?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort))
        .toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
      expect(preset?.defaultReasoningEffort).toBe("medium");
      if (selector) expect(preset?.description).toContain(`default ${selector}`);
    },
  );

  it("uses a non-reasoning default model's actual ladder", () => {
    const { models } = buildOmpAvailableModels({
      models: [{ ...oldModel, reasoning: false }],
      presets,
    });
    expect(models.find(({ id }) => id === "preset:best-coder")?.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort))
      .toEqual(["none"]);
  });

  it("still selects exactly one preset when there are no raw models", () => {
    const { models } = buildOmpAvailableModels({ models: [], presets });
    expect(models.filter(({ isDefault }) => isDefault).map(({ id }) => id))
      .toEqual(["preset:best-coder"]);
  });
});
