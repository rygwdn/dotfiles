// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./sidebar-host";
import { bot, personalProjectId, thread } from "./fixtures";
import { newThreadRequestSchema } from "../lib/new-thread-request";
import { request } from "./fixtures";
import { conversationStatus } from "../components/conversation-status-icon";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

async function mount(options: RenderSlotOptions = {}) {
  const rows = [
    thread("main", 10, { title: "Review @project:project", displayTitle: "Review Project" }),
    thread("hidden", 20, { isHidden: true }),
    thread("pending", 5, { environment: { ...thread("p", 1).environment!, id: null } }),
  ];
  const slot = renderSlot(app.threadLists[0]!, {
    activeThreadId: "main", activeProjectId: "project", searchQuery: "", isCompactViewport: false, onNavigate() {},
  }, {
    ...options,
    sidebarThreads: { threads: rows, projects: [] },
    rpc: { bots_list: () => ({ personalProjectId, bots: [bot], hosts: [], sections: [], projects: [], warnings: [],
      threadBindings: rows.map(row => ({ threadId: row.id, botId: bot.id })) }) },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Expand conversations for Test bot" }));
  return slot;
}

it("uses resolved titles, real URLs and keyboard hints while omitting internal helper threads", async () => {
  const slot = await mount({ sidebarShortcuts: { main: { label: "⌘1", ariaKeyshortcuts: "Meta+1" } } });
  const link = slot.container.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="main"]')!;
  expect(link.getAttribute("href")).toBe("/projects/project/threads/main");
  expect(link.getAttribute("aria-keyshortcuts")).toBe("Meta+1");
  expect(within(link).getByText("⌘1")).toBeTruthy();
  expect(slot.queryByText("Conversation hidden")).toBeNull();
  expect(slot.getByRole("button", { name: "Archive Review Project" })).toBeTruthy();
});

it("shows local drafts and statuses contributed by other plugins", async () => {
  const slot = await mount({
    sidebarDraftThreadIds: ["main"],
    sidebarRowStatuses: { pending: { icon: "Clock", label: "Scheduled task", tone: "default" } },
  });
  expect(slot.container.querySelector('[data-sidebar-thread-id="main"] [data-thread-status-glyph="draft"]')).not.toBeNull();
  expect(slot.container.querySelector('[data-sidebar-thread-id="pending"] [data-thread-status-glyph]')).not.toBeNull();
});

it("includes another plugin's action and safely represents pending environments", async () => {
  const run = vi.fn(async () => {});
  const targets: Array<string | null> = [];
  const slot = await mount({ threadActions: (target) => {
    if (target.id === "pending") targets.push(target.environment?.id ?? null);
    return [{ key: "example/inspect", pluginId: "example", group: "settings",
      action: { label: "Inspect with example", icon: "Search", run } }];
  } });
  fireEvent.contextMenu(slot.getByText("Conversation pending"));
  fireEvent.click(await slot.findByRole("menuitem", { name: "Inspect with example" }));
  expect(run).toHaveBeenCalledOnce();
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.every(id => id === null)).toBe(true);
});

it("keeps typed provider session options and rejects invalid values", () => {
  const sessionOptions = { mode: "plan", thinking: true };
  expect(newThreadRequestSchema.parse({ ...request, sessionOptions }).sessionOptions).toEqual(sessionOptions);
  expect(newThreadRequestSchema.safeParse({ ...request, sessionOptions: { mode: { nested: true } } }).success).toBe(false);
});

it("preserves provider-defined service tiers for the host to validate", () => {
  expect(newThreadRequestSchema.parse({ ...request, serviceTier: "ultrafast" }).serviceTier).toBe("ultrafast");
  expect(newThreadRequestSchema.safeParse({ ...request, serviceTier: "" }).success).toBe(false);
});

it("recognizes waiting machines and queued work instead of showing them as done", () => {
  expect(conversationStatus(thread("offline", 1, { runtimeStatus: "waiting-for-host" })).state).toBe("waiting");
  expect(conversationStatus(thread("queue", 1, { indicator: "queued-waiting" })).state).toBe("waiting");
  expect(conversationStatus(thread("failed", 1, { indicator: "queued-failed" })).state).toBe("error");
});
