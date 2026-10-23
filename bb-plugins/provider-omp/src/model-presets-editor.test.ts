// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { z } from "zod";
import {
  OMP_PRESET_BUILT_IN_ROLES,
  type OmpEditableModelPreset,
  type OmpModelPresetsList,
  type OmpModelPresetsRpcContract,
  type OmpModelPresetsSnapshot,
} from "./model-presets-contract.js";
import { OmpModelPresetsEditor, splitOmpPresetSelector } from "./model-presets-editor.js";

type SaveInput = z.input<OmpModelPresetsRpcContract["saveModelPreset"]["input"]>;
type DeleteInput = z.input<OmpModelPresetsRpcContract["deleteModelPreset"]["input"]>;
const COLON_MODEL = "fireworks-300k/fireworks:accounts/fireworks/routers/glm-5p3-fast";
const INITIAL_REVISION = { mtimeMs: 100, contentHash: "initial-config" };
const NEXT_REVISION = { mtimeMs: 200, contentHash: "next-config" };
const INITIAL_PRESET: OmpEditableModelPreset = {
  name: "balanced",
  modelRoles: {
    default: `${COLON_MODEL}:high`,
    review: "private-alias",
    opaque: "models/*:future",
  },
  defaultThinkingLevel: "auto",
};

function snapshot(overrides: Partial<OmpModelPresetsSnapshot> = {}): OmpModelPresetsSnapshot {
  return {
    configPath: "/home/test/.omp/agent/config.yml",
    revision: INITIAL_REVISION,
    presetsRevision: "initial-presets",
    presets: [INITIAL_PRESET],
    modelRoles: { default: "global-model:max", review: "global-review:auto", constructor: "safe-alias:low" },
    ...overrides,
  };
}

function list(overrides: Partial<OmpModelPresetsList> = {}): OmpModelPresetsList {
  return {
    ...snapshot(),
    models: [
      { id: COLON_MODEL, name: "GLM router", thinkingLevels: ["off", "high"] },
      { id: "openai/gpt-6.1", name: "GPT", thinkingLevels: ["low", "high", "max"] },
    ],
    ...overrides,
  };
}

function renderEditor(overrides: Partial<PluginRpcTestHandlers<OmpModelPresetsRpcContract>> = {}) {
  const rpc: PluginRpcTestHandlers<OmpModelPresetsRpcContract> = {
    listModelPresets: () => list(),
    saveModelPreset: () => { throw new Error("Unexpected save."); },
    deleteModelPreset: () => { throw new Error("Unexpected deletion."); },
    ...overrides,
  };
  return renderSlot({ component: OmpModelPresetsEditor }, {}, { rpc });
}

afterEach(() => cleanup());

describe("splitOmpPresetSelector", () => {
  it("splits only a recognized final suffix, without splitting model ID colons", () => {
    expect(splitOmpPresetSelector(`${COLON_MODEL}:high`)).toEqual({ model: COLON_MODEL, thinkingLevel: "high" });
    expect(splitOmpPresetSelector(`${COLON_MODEL}:off`)).toEqual({ model: COLON_MODEL, thinkingLevel: "off" });
    expect(splitOmpPresetSelector(COLON_MODEL)).toEqual({ model: COLON_MODEL, thinkingLevel: "" });
    expect(splitOmpPresetSelector("private-alias:auto")).toEqual({ model: "private-alias", thinkingLevel: "auto" });
    expect(splitOmpPresetSelector("provider/model:high:low")).toEqual({ model: "provider/model:high", thinkingLevel: "low" });
    for (const selector of ["models/*:future", "alias:HIGH", " alias:high ", ":high", ""]) {
      expect(splitOmpPresetSelector(selector)).toEqual({ model: selector, thinkingLevel: "" });
    }
  });
});

describe("OmpModelPresetsEditor", () => {
  it("loads all roles and saves aliases, colon IDs and the default thinking level without catalog loss", async () => {
    const save = vi.fn(async (input: SaveInput) => snapshot({
      revision: NEXT_REVISION,
      presetsRevision: "saved-presets",
      presets: [{ name: input.name, ...input.preset }],
    }));
    const view = renderEditor({ saveModelPreset: save });
    await view.findByRole("heading", { name: "balanced" });
    expect(view.getByText("/home/test/.omp/agent/config.yml")).toBeTruthy();
    expect(view.inspection.rpcCalls[0]).toMatchObject({ method: "listModelPresets", input: {} });
    fireEvent.click(view.getByRole("button", { name: "Edit preset balanced" }));
    for (const role of OMP_PRESET_BUILT_IN_ROLES) {
      expect(view.getByLabelText(`${role.name} model`)).toBeInstanceOf(HTMLSelectElement);
    }
    expect(view.getByText("Other roles").closest("details")?.hasAttribute("open")).toBe(false);
    expect(view.getByRole("group", { name: "review" })).toBeTruthy();
    expect(view.getByRole("group", { name: "constructor" })).toBeTruthy();
    expect(view.getByLabelText("constructor model")).toHaveProperty("value", "not-set");
    expect(view.getByLabelText("Default model")).toHaveProperty("value", `model:${COLON_MODEL}`);
    expect(view.getByLabelText("Default thinking suffix")).toHaveProperty("value", "high");
    expect(view.getByLabelText("review model")).toHaveProperty("value", "custom");
    expect(view.getByLabelText("review custom selector")).toHaveProperty("value", "private-alias");
    expect(view.getByLabelText("opaque custom selector")).toHaveProperty("value", "models/*:future");
    expect(view.getByLabelText("opaque thinking suffix")).toHaveProperty("value", "");
    expect(view.getByLabelText("Default thinking level")).toHaveProperty("value", "level:auto");
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "renamed" } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByRole("heading", { name: "renamed" });
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: "renamed",
      previousName: "balanced",
      preset: { modelRoles: INITIAL_PRESET.modelRoles, defaultThinkingLevel: "auto" },
      expectedRevision: INITIAL_REVISION,
    });

    fireEvent.click(view.getByRole("button", { name: "Edit preset renamed" }));
    expect(view.getByLabelText("Default model")).toHaveProperty("value", `model:${COLON_MODEL}`);
    expect(within(view.getByLabelText("Default model")).getByRole("option", { name: /GLM router/ })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[0].expectedRevision).toEqual(NEXT_REVISION);
    await view.findByText("Saved preset “renamed”.");
  });

  it("offers only supported default levels while preserving an off role suffix on save", async () => {
    const preset = { ...INITIAL_PRESET, modelRoles: { ...INITIAL_PRESET.modelRoles, default: `${COLON_MODEL}:off` } };
    const save = vi.fn(async (input: SaveInput) => snapshot({ presets: [{ name: input.name, ...input.preset }] }));
    const view = renderEditor({
      listModelPresets: () => list({ presets: [preset] }),
      saveModelPreset: save,
    });
    await view.findByRole("heading", { name: "balanced" });
    fireEvent.click(view.getByRole("button", { name: "Edit preset balanced" }));
    const defaultLevel = within(view.getByLabelText("Default thinking level"));
    expect(defaultLevel.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
      "unset", "level:auto", "level:minimal", "level:low", "level:medium", "level:high", "level:xhigh", "level:max",
    ]);
    expect(defaultLevel.queryByRole("option", { name: "off" })).toBeNull();
    expect(within(view.getByLabelText("Default thinking suffix")).getByRole("option", { name: "off" })).toHaveProperty("value", "off");
    expect(view.getByLabelText("Default thinking suffix")).toHaveProperty("value", "off");
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByText("Saved preset “balanced”.");
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: "balanced",
      previousName: "balanced",
      preset: { modelRoles: preset.modelRoles, defaultThinkingLevel: "auto" },
      expectedRevision: INITIAL_REVISION,
    });
  });

  it("starts from current global roles, replacing draft assignments and retaining custom role selectors", async () => {
    const save = vi.fn(async (input: SaveInput) => snapshot({ presets: [{ name: input.name, ...input.preset }] }));
    const view = renderEditor({ saveModelPreset: save });
    await view.findByRole("heading", { name: "balanced" });
    fireEvent.click(view.getByRole("button", { name: "New preset" }));
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "current-roles" } });
    fireEvent.change(view.getByLabelText("Fast model"), { target: { value: "model:openai/gpt-6.1" } });
    fireEvent.change(view.getByLabelText("Default thinking level"), { target: { value: "level:auto" } });
    fireEvent.click(view.getByRole("button", { name: "Start from current roles" }));
    expect(view.getByLabelText("Fast model")).toHaveProperty("value", "not-set");
    expect(view.getByLabelText("Default custom selector")).toHaveProperty("value", "global-model");
    expect(view.getByLabelText("Default thinking suffix")).toHaveProperty("value", "max");
    expect(view.getByLabelText("review custom selector")).toHaveProperty("value", "global-review");
    expect(view.getByLabelText("review thinking suffix")).toHaveProperty("value", "auto");
    expect(view.getByLabelText("constructor custom selector")).toHaveProperty("value", "safe-alias");
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByRole("heading", { name: "current-roles" });
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: "current-roles",
      preset: { modelRoles: snapshot().modelRoles, defaultThinkingLevel: "auto" },
      expectedRevision: INITIAL_REVISION,
    });
  });

  it("keeps unsaved form values on conflict and reloads the revision without retrying a save automatically", async () => {
    const listPresets = vi.fn(async () => list())
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce(list({ revision: NEXT_REVISION, presetsRevision: "external-change" }));
    const save = vi.fn(async (input: SaveInput) => snapshot({ presets: [{ name: input.name, ...input.preset }] }))
      .mockRejectedValueOnce(new Error("Configuration changed on disk. Reload presets and try again."));
    const view = renderEditor({ listModelPresets: listPresets, saveModelPreset: save });
    await view.findByRole("heading", { name: "balanced" });
    fireEvent.click(view.getByRole("button", { name: "Edit preset balanced" }));
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "unsaved-name" } });
    fireEvent.change(view.getByLabelText("review custom selector"), { target: { value: "my-team/*:unknown" } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    expect((await view.findByRole("alert")).textContent).toContain("Configuration changed on disk");
    expect(view.getByLabelText("Preset name")).toHaveProperty("value", "unsaved-name");
    expect(view.getByLabelText("review custom selector")).toHaveProperty("value", "my-team/*:unknown");
    fireEvent.click(view.getByRole("button", { name: "Reload and keep draft" }));
    await view.findByText("Model presets reloaded. Any unsaved edits have been kept.");
    expect(save).toHaveBeenCalledTimes(1);
    expect(view.getByLabelText("Preset name")).toHaveProperty("value", "unsaved-name");
    expect(view.getByLabelText("review custom selector")).toHaveProperty("value", "my-team/*:unknown");
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByRole("heading", { name: "unsaved-name" });
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      name: "unsaved-name",
      previousName: "balanced",
      preset: { modelRoles: { review: "my-team/*:unknown" } },
      expectedRevision: NEXT_REVISION,
    });
  });

  it("validates names, duplicate names and empty role maps before saving", async () => {
    const save = vi.fn(async () => snapshot());
    const view = renderEditor({ saveModelPreset: save });
    await view.findByRole("heading", { name: "balanced" });
    fireEvent.click(view.getByRole("button", { name: "New preset" }));
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "1-invalid" } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    expect(view.getByRole("alert").textContent).toContain("starting with a letter");
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "balanced" } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    expect(view.getByRole("alert").textContent).toContain("already exists");
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "valid_name-2" } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    expect(view.getByRole("alert").textContent).toContain("Assign at least one role");
    fireEvent.change(view.getByLabelText("Default model"), { target: { value: "custom" } });
    fireEvent.change(view.getByLabelText("Default custom selector"), { target: { value: "   " } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    expect(view.getByRole("alert").textContent).toContain("Assign at least one role");
    expect(save).not.toHaveBeenCalled();
  });

  it("requires an in-UI confirmation before deletion and retains catalog models and the new revision", async () => {
    const remove = vi.fn(async (_input: DeleteInput) => snapshot({ presets: [], revision: NEXT_REVISION }));
    const save = vi.fn(async (input: SaveInput) => snapshot({ presets: [{ name: input.name, ...input.preset }] }));
    const view = renderEditor({ deleteModelPreset: remove, saveModelPreset: save });
    await view.findByRole("heading", { name: "balanced" });
    fireEvent.click(view.getByRole("button", { name: "Delete preset balanced" }));
    expect(remove).not.toHaveBeenCalled();
    expect(view.getByRole("alertdialog", { name: "Delete preset balanced?" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Cancel deletion" }));
    expect(view.queryByRole("alertdialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Delete preset balanced" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm delete balanced" }));
    await view.findByText("No model presets configured.");
    expect(remove).toHaveBeenCalledExactlyOnceWith({ name: "balanced", expectedRevision: INITIAL_REVISION });
    fireEvent.click(view.getByRole("button", { name: "New preset" }));
    fireEvent.change(view.getByLabelText("Preset name"), { target: { value: "after-delete" } });
    fireEvent.change(view.getByLabelText("Default model"), { target: { value: `model:${COLON_MODEL}` } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByRole("heading", { name: "after-delete" });
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: "after-delete",
      preset: { modelRoles: { default: COLON_MODEL } },
      expectedRevision: NEXT_REVISION,
    });
  });

  it("offers retry after a load failure and supports manual selectors when the model catalog is unavailable", async () => {
    const listPresets = vi.fn(async () => list({ models: [], catalogError: "Catalog timed out." }))
      .mockRejectedValueOnce(new Error("Could not reach the OMP host."));
    const save = vi.fn(async (input: SaveInput) => snapshot({ presets: [{ name: input.name, ...input.preset }] }));
    const view = renderEditor({ listModelPresets: listPresets, saveModelPreset: save });
    expect((await view.findByRole("alert")).textContent).toContain("Could not reach the OMP host");
    fireEvent.click(view.getByRole("button", { name: "Retry loading presets" }));
    await view.findByRole("heading", { name: "balanced" });
    expect(view.getByText(/Model catalog unavailable: Catalog timed out/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Edit preset balanced" }));
    expect(view.getByLabelText("Default custom selector")).toHaveProperty("value", COLON_MODEL);
    expect(view.getByLabelText("Default thinking suffix")).toHaveProperty("value", "high");
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByText("Saved preset “balanced”.");
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: "balanced",
      previousName: "balanced",
      preset: { modelRoles: INITIAL_PRESET.modelRoles, defaultThinkingLevel: "auto" },
      expectedRevision: INITIAL_REVISION,
    });
  });

  it.each([
    { stored: "future-thinking", correction: "level:auto", expected: "auto" },
    { stored: "off", correction: "level:auto", expected: "auto" },
    { stored: "off", correction: "unset", expected: undefined },
    { stored: "", correction: "unset", expected: undefined },
  ])("retains unsupported default '$stored' until the user corrects it", async ({ stored, correction, expected }) => {
    const save = vi.fn(async (input: SaveInput) => snapshot({ presets: [{ name: input.name, ...input.preset }] }));
    const view = renderEditor({
      listModelPresets: () => list({ presets: [{ ...INITIAL_PRESET, defaultThinkingLevel: stored }] }),
      saveModelPreset: save,
    });
    await view.findByRole("heading", { name: "balanced" });
    fireEvent.click(view.getByRole("button", { name: "Edit preset balanced" }));
    expect(view.getByLabelText("Default thinking level")).toHaveProperty("value", `level:${stored}`);
    expect(view.getByRole("option", { name: `Unsupported value: ${stored || "(empty value)"}` })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    expect(view.getByRole("alert").textContent).toContain("Choose a supported default thinking level or Not set");
    expect(save).not.toHaveBeenCalled();
    expect(view.getByLabelText("Default thinking level")).toHaveProperty("value", `level:${stored}`);
    expect(view.getByLabelText("opaque custom selector")).toHaveProperty("value", "models/*:future");
    fireEvent.change(view.getByLabelText("Default thinking level"), { target: { value: correction } });
    fireEvent.click(view.getByRole("button", { name: "Save preset" }));
    await view.findByText("Saved preset “balanced”.");
    expect(save).toHaveBeenCalledExactlyOnceWith({
      name: "balanced",
      previousName: "balanced",
      preset: {
        modelRoles: INITIAL_PRESET.modelRoles,
        ...(expected === undefined ? {} : { defaultThinkingLevel: expected }),
      },
      expectedRevision: INITIAL_REVISION,
    });
  });

  it("disables operations during pending requests and ignores a load result after unmount", async () => {
    const { promise: waitingLoad, resolve: resolveLoad } = Promise.withResolvers<OmpModelPresetsList>();
    const listPresets = vi.fn(() => waitingLoad);
    const view = renderEditor({ listModelPresets: listPresets });
    expect(view.getByText("Loading model presets…")).toBeTruthy();
    expect(view.getByRole("button", { name: "New preset" })).toHaveProperty("disabled", true);
    expect(view.getByRole("button", { name: "Reload presets" })).toHaveProperty("disabled", true);
    view.lifecycle.unmount();
    await act(async () => { resolveLoad(list()); await waitingLoad; });
    expect(view.container.childElementCount).toBe(0);

    const { promise: waitingSave, resolve: resolveSave } = Promise.withResolvers<OmpModelPresetsSnapshot>();
    const save = vi.fn(() => waitingSave);
    const nextView = renderEditor({ saveModelPreset: save });
    await nextView.findByRole("heading", { name: "balanced" });
    fireEvent.click(nextView.getByRole("button", { name: "Edit preset balanced" }));
    fireEvent.click(nextView.getByRole("button", { name: "Save preset" }));
    expect(nextView.getByLabelText("Preset name")).toHaveProperty("disabled", true);
    expect(nextView.getByLabelText("Default model")).toHaveProperty("disabled", true);
    expect(nextView.getByLabelText("Default thinking suffix")).toHaveProperty("disabled", true);
    expect(nextView.getByRole("button", { name: "Cancel editing" })).toHaveProperty("disabled", true);
    expect(nextView.getByRole("button", { name: "Reload presets" })).toHaveProperty("disabled", true);
    fireEvent.submit(nextView.getByRole("form", { name: "Edit preset balanced" }));
    expect(save).toHaveBeenCalledTimes(1);
    nextView.lifecycle.unmount();
    await act(async () => { resolveSave(snapshot()); await waitingSave; });
    expect(nextView.container.childElementCount).toBe(0);
  });
});
