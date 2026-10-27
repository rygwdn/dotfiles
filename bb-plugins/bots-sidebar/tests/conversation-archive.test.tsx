// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./sidebar-host";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

// The bottom list is the host's native thread list now, so archiving is
// exercised on the bot's own conversation rows.
async function mount() {
  const rows = [thread("main", 200), thread("root", 150), thread("child", 140, { parentThreadId: "root" }),
    thread("main-child", 1, { parentThreadId: "main" }), thread("old-leaf", 1, { title: null, titleFallback: "Older conversation" }),
    thread("archived", 500, { isArchived: true }), ...Array.from({ length: 9 }, (_, i) => thread(`recent-${i}`, 100 - i)),
  ].map(row => ({ ...row, projectId: "project" }));
  const onNavigate = vi.fn();
  const slot = renderSlot(app.threadLists[0]!, { activeThreadId: "root", activeProjectId: rows[0]!.projectId, isCompactViewport: false, onNavigate, searchQuery: "" }, {
    sidebarThreads: { projects: [{ id: rows[0]!.projectId, name: "Project", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }], threads: rows },
    rpc: { bots_list: () => ({ bots: [bot], personalProjectId, hosts: [], sections: [], projects: [], warnings: [], threadBindings: rows.filter(row => !row.parentThreadId).map(row => ({ threadId: row.id, botId: bot.id })) }) },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Expand conversations for Test bot" }));
  await slot.findByText("Conversation root");
  return { slot, onNavigate };
}

it("requests native archive without prematurely hiding rows before confirmation", async () => {
  const { slot, onNavigate } = await mount();
  const link = slot.container.querySelector('[data-sidebar-thread-id="root"]')!;
  const row = link.parentElement!;
  const archive = within(row).getByRole("button", { name: "Archive Conversation root" });
  expect(archive.closest("a")).toBeNull(); expect(archive.previousElementSibling).toBe(link);
  const disclosure = within(row).getByRole("button", { name: "Expand children of Conversation root" });
  expect(row.lastElementChild).toBe(disclosure); expect(archive.nextElementSibling).toBe(disclosure);
  fireEvent.click(archive, { ctrlKey: true });
  expect(slot.nativeActionCalls).toEqual([{ key: "bb--core/archive", threadId: "root" }]);
  expect(slot.container.querySelector('[data-sidebar-thread-id="root"]')).not.toBeNull();
  expect(onNavigate).not.toHaveBeenCalled(); expect(slot.inspection.navigateCalls).toEqual([]);
});

it("gives each expanded child its own archive action", async () => {
  const { slot } = await mount();
  fireEvent.click(slot.getByRole("button", { name: "Expand children of Conversation root" }));
  fireEvent.click(slot.getByRole("button", { name: "Archive Conversation child" }));
  expect(slot.nativeActionCalls).toEqual([{ key: "bb--core/archive", threadId: "child" }]);
  expect(slot.queryByText("Conversation child")).not.toBeNull();
  expect(slot.queryByRole("button", { name: /children of Conversation root/ })).not.toBeNull();
});

it("archives a title-fallback conversation without opening it", async () => {
  const { slot, onNavigate } = await mount();
  const archive = slot.getByRole("button", { name: "Archive Older conversation" });
  expect(archive.getAttribute("data-archive-thread-id")).toBe("old-leaf");
  fireEvent.keyDown(archive, { key: "Enter" }); fireEvent.click(archive, { detail: 0 });
  expect(slot.nativeActionCalls).toEqual([{ key: "bb--core/archive", threadId: "old-leaf" }]);
  expect(onNavigate).not.toHaveBeenCalled();
});

it("archives a main child, never the bot identity or main pointer", async () => {
  const { slot } = await mount();
  expect(slot.container.querySelector(".project-row .conversation-archive")).toBeNull();
  expect(slot.queryByRole("button", { name: "Archive Conversation archived" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Expand children of Conversation main" }));
  fireEvent.click(slot.getByRole("button", { name: "Archive Conversation main-child" }));
  expect(slot.nativeActionCalls).toEqual([{ key: "bb--core/archive", threadId: "main-child" }]);
});
