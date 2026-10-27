// @vitest-environment jsdom
import { createElement } from "react";
import type { NewThreadComposerProps } from "@get-bb/plugin-sdk/app";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./sidebar-host";
import { bot, personalProjectId, request, thread } from "./fixtures";
import { rpcContract, type BotMetadata } from "../contract";
import { emptyLaunchPreset, type LaunchPreset } from "../lib/launch-preset";

const composer = vi.hoisted(() => ({ props: null as NewThreadComposerProps | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...sdk, experimental_NewThreadComposer: (props: NewThreadComposerProps) => {
    composer.props = props;
    return createElement(sdk.experimental_NewThreadComposer, props);
  } };
});
const app = await loadPluginApp(() => import("../app"));
afterEach(async () => { cleanup(); composer.props = null; await new Promise(resolve => setTimeout(resolve, 0)); });
const preset: LaunchPreset = {
  execution: { providerId: "test-harness", model: "review-model", reasoningLevel: "deep", serviceTier: "priority", permissionMode: null },
  workspace: "worktree", initialPrompt: "Review the changes.\nStart with failing tests.",
};
function props() { if (!composer.props) throw new Error("Missing composer"); return composer.props; }

async function mount(launchPreset?: LaunchPreset | null, owned = false) {
  let current: BotMetadata = { ...bot, ...(launchPreset === undefined ? {} : { launchPreset }) };
  const slot = renderSlot(app.threadLists[0]!, { activeThreadId: "main", activeProjectId: "project", isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "" }, {
    sidebarThreads: { projects: [{ id: "project", name: "Example project", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }], threads: [thread("main", 1)] },
    rpc: {
      bots_list: () => ({ bots: [current], hosts: [{ id: "host", name: "Example machine", connected: true }], sections: [], projects: [{ id: "project", name: "Example project" }], threadBindings: [{ botId: bot.id, threadId: "main" }], warnings: [], personalProjectId, projectOwners: owned ? [{ botId: bot.id, projectId: "project" }] : [] }),
      bot_prepare: () => current,
      bot_update: raw => { const input = rpcContract.bot_update.input.parse(raw); current = { ...current, ...input }; return current; },
      conversation_create: () => ({ threadId: "created" }),
    },
  });
  await slot.findByText(bot.name);
  return { slot, change: (patch: Partial<BotMetadata>) => { current = { ...current, ...patch }; } };
}
async function edit(slot: Awaited<ReturnType<typeof mount>>["slot"]) {
  fireEvent.contextMenu(slot.getByText(bot.name));
  fireEvent.click(await slot.findByRole("menuitem", { name: "Edit bot…" }));
  return await slot.findByRole("dialog", { name: "Edit bot" });
}

it("keeps old bots on project defaults and validates an incomplete preferred model before any write", async () => {
  const { slot } = await mount();
  const dialog = await edit(slot);
  expect(within(dialog).queryByTestId("bb-provider-model-picker")).toBeNull();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Use a preferred model" }));
  expect(within(dialog).getByTestId("bb-provider-model-picker").getAttribute("data-routing-id")).toBe("host");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bot" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Choose a harness");
  expect(slot.inspection.rpcCalls.some(call => call.method === "bot_update")).toBe(false);
});

it("saves native model selections and a multiline prompt explicitly, retaining drafts across tabs", async () => {
  const { slot } = await mount(); const dialog = await edit(slot);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Use a preferred model" }));
  fireEvent.change(within(dialog).getByLabelText("Provider ID"), { target: { value: "test-harness" } });
  fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "review-model" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(within(dialog).getByLabelText("Starter prompt"), { target: { value: preset.initialPrompt } });
  expect(fireEvent.keyDown(within(dialog).getByLabelText("Starter prompt"), { key: "Enter" })).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Project workspace"), { target: { value: "worktree" } });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Context" }));
  fireEvent.click(within(dialog).getByRole("tab", { name: "Bot" }));
  expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Starter prompt" }).value).toBe(preset.initialPrompt);
  expect(slot.inspection.rpcCalls.some(call => call.method === "bot_update")).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bot" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.inspection.rpcCalls.find(call => call.method === "bot_update")?.input).toMatchObject({ launchPreset: { ...preset, execution: { providerId: "test-harness", model: "review-model", reasoningLevel: "medium", permissionMode: null } } });
});

it("lets an existing preset be reset to inherited defaults", async () => {
  const { slot } = await mount(preset); const dialog = await edit(slot);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Use a preferred model" }));
  fireEvent.change(within(dialog).getByLabelText("Starter prompt"), { target: { value: "" } });
  fireEvent.change(within(dialog).getByLabelText("Project workspace"), { target: { value: "checkout" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bot" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.inspection.rpcCalls.find(call => call.method === "bot_update")?.input).toMatchObject({ launchPreset: null });
});

it("makes permission overrides explicit and passes the selected mode to new conversations", async () => {
  const { slot } = await mount(preset); const dialog = await edit(slot);
  expect(within(dialog).queryByLabelText("Permission mode")).toBeNull();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Custom permissions" }));
  const picker = within(dialog).getByLabelText("Permission mode");
  expect(picker.getAttribute("data-provider-id")).toBe("test-harness");
  expect(picker.getAttribute("data-routing-id")).toBe("host");
  fireEvent.change(picker, { target: { value: "auto" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save bot" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  fireEvent.click(slot.getByRole("button", { name: `New conversation with ${bot.name}` }));
  await slot.findByRole("dialog", { name: "New conversation" });
  expect(props().defaultPermissionMode).toBe("auto");
});

it.each([false, true])("seeds fresh conversations without overriding ownership or later user choices (owned=%s)", async owned => {
  const { slot, change } = await mount(preset, owned);
  fireEvent.click(slot.getByRole("button", { name: `New conversation with ${bot.name}` }));
  await slot.findByRole("dialog", { name: owned ? "New conversation in worktree" : "New conversation" });
  expect(props()).toMatchObject({ defaultProviderId: "test-harness", defaultModel: "review-model", defaultReasoningLevel: "deep", defaultServiceTier: "priority", initialPrompt: preset.initialPrompt, defaultProjectId: owned ? "project" : personalProjectId });
  expect(props().defaultPermissionMode).toBeUndefined();
  expect(props().defaultEnvironment).toEqual({ type: "host", hostId: "host", workspace: owned ? { type: "managed-worktree", baseBranch: { kind: "default" } } : { type: "personal" } });
  const initial = props(); change({ launchPreset: emptyLaunchPreset() });
  await slot.behavior.emitRealtime("project-bots-changed", {});
  expect(props().defaultModel).toBe(initial.defaultModel);
  expect(props().initialPrompt).toBe(initial.initialPrompt);
  expect(props().defaultEnvironment).toBe(initial.defaultEnvironment);
  const chosen = { ...request, providerId: "different", model: "my-choice", permissionMode: "accept-edits" as const, sessionOptions: { mode: "plan" } };
  await act(() => props().onSubmit(chosen));
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "conversation_create", input: { botId: bot.id, request: chosen, makeMain: false } });
});

it("keeps an explicit checkout action a checkout even when the bot prefers worktrees", async () => {
  const { slot } = await mount(preset, true);
  fireEvent.contextMenu(slot.getByText(bot.name));
  fireEvent.click(await slot.findByRole("menuitem", { name: "New conversation in project…" }));
  await slot.findByRole("dialog", { name: "New conversation in project" });
  expect(props().defaultEnvironment).toMatchObject({ workspace: { type: "unmanaged", path: null } });
  expect(props().defaultModel).toBe("review-model");
});

it("does not apply a new-conversation preset to forks", async () => {
  const { slot } = await mount(preset, true);
  fireEvent.click(slot.getByRole("button", { name: `Expand conversations for ${bot.name}` }));
  fireEvent.contextMenu(slot.getByText("Conversation main"));
  fireEvent.click(await slot.findByRole("menuitem", { name: "Fork in same environment…" }));
  await slot.findByRole("dialog", { name: "Fork conversation" });
  expect(props().defaultEnvironment).toEqual({ type: "reuse", environmentId: "env-existing" });
  expect(props().defaultProviderId).toBeUndefined();
  expect(props().defaultModel).toBeUndefined();
  expect(props().initialPrompt).toBeUndefined();
});
