// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./sidebar-host";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
const Sidebar = app.threadLists[0]!.component;
afterEach(cleanup);

// The bottom list is the host's native thread list now, so the conversation
// tree covered here is the bot's own tree.
async function mount() {
  const projectId = "project";
  const rows = [
    thread("main", 200), thread("root", 150),
    thread("child", 149, { parentThreadId: "root" }),
    thread("grandchild", 148, { parentThreadId: "child" }),
    thread("sibling", 147), thread("sibling-child", 146, { parentThreadId: "sibling" }),
  ].map((row) => ({ ...row, projectId }));
  function Host() {
    const [activeThreadId, setActiveThreadId] = useState("root");
    return <>
      <button onClick={() => setActiveThreadId("grandchild")}>Navigate grandchild</button>
      <Sidebar activeThreadId={activeThreadId} activeProjectId={projectId} isCompactViewport={false} onNavigate={() => {}} searchQuery="" />
    </>;
  }
  const slot = renderSlot({ component: Host }, {}, {
    sidebarThreads: { projects: [{ id: projectId, name: "Test project", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }], threads: rows },
    rpc: { bots_list: () => ({ personalProjectId, bots: [bot], sections: [], hosts: [], projects: [{ id: "project", name: "Test project" }], warnings: [], threadBindings: rows.filter((row) => !row.parentThreadId).map((row) => ({ threadId: row.id, botId: bot.id })) }) },
  });
  await slot.findByText("Test bot");
  fireEvent.click(slot.getByRole("button", { name: "Expand conversations for Test bot" }));
  return slot;
}

it("children default closed and form nested, independently collapsible branches", async () => {
  const slot = await mount();
  expect(slot.queryByText("Conversation child")).toBeNull();
  const toggle = slot.getByRole("button", { name: "Expand children of Conversation root" });
  expect(toggle.textContent?.trim()).toBe("1");
  expect(toggle.parentElement?.lastElementChild).toBe(toggle);
  expect(toggle.previousElementSibling?.getAttribute("data-archive-thread-id")).toBe("root");
  expect(toggle.previousElementSibling?.previousElementSibling?.getAttribute("data-sidebar-thread-id")).toBe("root");
  expect(slot.container.querySelector(".conversation-disclosure-spacer")).toBeNull();
  fireEvent.click(toggle);
  const child = slot.getByText("Conversation child");
  expect(child.closest("ul")?.classList.contains("conversation-children")).toBe(true);
  expect(slot.queryByText("Conversation grandchild")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Expand children of Conversation child" }));
  expect(slot.getByText("Conversation grandchild").closest("ul")?.parentElement?.closest("ul")?.classList.contains("conversation-children")).toBe(true);
  expect(slot.queryByText("Conversation sibling-child")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Collapse children of Conversation root" }));
  expect(slot.queryByText("Conversation child")).toBeNull();
  expect(slot.queryByText("Conversation grandchild")).toBeNull();
  expect(slot.inspection.navigateCalls).toEqual([]);
});

it("reveals and highlights the current chat without expanding unrelated branches", async () => {
  const slot = await mount();
  expect(slot.container.querySelector('[data-sidebar-thread-id="root"]')?.getAttribute("aria-current")).toBe("page");
  fireEvent.click(slot.getByRole("button", { name: "Navigate grandchild" }));
  await slot.findByText("Conversation grandchild");
  const active = slot.container.querySelector('[data-sidebar-thread-id="grandchild"]')!;
  expect(active.getAttribute("aria-current")).toBe("page");
  expect(active.closest(".thread-row")?.getAttribute("aria-current")).toBe("page");
  expect(slot.container.querySelector('[data-sidebar-thread-id="root"]')?.hasAttribute("aria-current")).toBe(false);
  expect(slot.getByRole("button", { name: "Collapse children of Conversation root" }).getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByRole("button", { name: "Collapse children of Conversation child" }).getAttribute("aria-expanded")).toBe("true");
  expect(slot.queryByText("Conversation sibling-child")).toBeNull();
});

it("reveals a previously hidden active descendant once it becomes active", async () => {
  const slot = await mount();
  expect(slot.queryByText("Conversation grandchild")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Navigate grandchild" }));
  await waitFor(() => expect(slot.container.querySelector('[data-sidebar-thread-id="grandchild"]')?.getAttribute("aria-current")).toBe("page"));
});
