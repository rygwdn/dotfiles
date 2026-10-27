// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./sidebar-host";
import { bot, personalProjectId, thread } from "./fixtures";

// The SDK test shim records "open" immediately on pointerdown; the real host
// only engages a split after leaving the sidebar. Keep its gesture hook wired
// without treating that shim shortcut as a real navigation during this test.
const split = vi.hoisted(() => ({ onPointerDown: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return { ...sdk, experimental_useSidebarThreadSplit: () => ({ splitProps: { onPointerDown: split.onPointerDown }, isAvailable: true, layout: null }) };
});
const app = await loadPluginApp(() => import("../app"));
let hit: Element | null = null;
const originalHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
beforeEach(() => { split.onPointerDown.mockClear(); hit = null; Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit }); });
afterEach(() => { cleanup(); if (originalHitTest) Object.defineProperty(document, "elementFromPoint", originalHitTest); else Reflect.deleteProperty(document, "elementFromPoint"); });
async function mount(fail = false, afterAssignment?: () => Promise<void>) {
  let assigned = false;
  const bots = [{ ...bot, id: "atlas", name: "Atlas", mainThreadId: "main-a", linkedProjectIds: [], threadOrder: [] as string[] }, { ...bot, id: "nova", name: "Nova", mainThreadId: "main-b", linkedProjectIds: [], threadOrder: ["main-b"] }];
  const rows = [thread("main-a", 100), thread("main-b", 100), thread("chat", 90), thread("child", 80, { parentThreadId: "chat" }), thread("assigned-child", 70, { parentThreadId: "chat" })];
  const bindings = [{ threadId: "main-a", botId: "atlas" }, { threadId: "main-b", botId: "nova" }, { threadId: "assigned-child", botId: "atlas" }];
  const onNavigate = vi.fn();
  const slot = renderSlot(app.threadLists[0]!, { activeThreadId: "main-a", activeProjectId: "project", isCompactViewport: false, onNavigate, searchQuery: "" }, {
    sidebarThreads: { projects: [{ id: "project", name: "Work project", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }], threads: rows },
    rpc: {
      bots_list: async () => {
        if (assigned) await afterAssignment?.();
        return { bots, personalProjectId, hosts: [], sections: [], projects: [], warnings: [], threadBindings: [...bindings] };
      },
      conversation_assign: (value) => {
        if (fail) throw new Error("Assignment failed; try again");
        const { threadId, botId, placeFirst } = value as { threadId: string; botId: string; placeFirst?: boolean };
        bindings.push({ threadId, botId });
        assigned = true;
        const target = bots.find(bot => bot.id === botId)!;
        if (placeFirst) target.threadOrder = [threadId, ...target.threadOrder.filter(id => id !== threadId)];
        else if (placeFirst === false) target.threadOrder.push(threadId);
        return { ok: true };
      },
    },
  });
  await slot.findByText("Atlas");
  // The unassigned conversation lives in the native bottom list, which renders
  // asynchronously once the host resolved the thread list.
  await waitFor(() => expect(slot.container.querySelector('[data-sidebar-thread-id="chat"]')).not.toBeNull());
  const source = slot.container.querySelector<HTMLElement>('[data-sidebar-thread-id="chat"]')!;
  const target = slot.container.querySelector<HTMLElement>('[data-bot-drop-target="nova"]')!;
  return { slot, source, target, bindings, onNavigate };
}
// Alt+left starts the bot assignment gesture; ordinary drags stay native.
function down(source: HTMLElement, pointerType = "mouse", altKey = true) { fireEvent.pointerDown(source, { button: 0, buttons: 1, pointerId: 1, pointerType, altKey, clientX: 40, clientY: 300 }); }
function move(target: Element | null) { hit = target; fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 100 }); }
function up(shiftKey = false) { fireEvent.pointerUp(window, { button: 0, buttons: 0, pointerId: 1, clientX: 40, clientY: 100, shiftKey }); }
// The native row container marks a row that belongs to the host's thread list.
function nativeRow(container: HTMLElement, id: string): HTMLElement | null {
  const anchor = container.querySelector<HTMLElement>(`[data-sidebar-thread-id="${id}"]`);
  return anchor?.closest<HTMLElement>("[data-sidebar-rename-row]") ?? null;
}

it("drags a project-associated private chat onto a bot without prior membership or navigation", async () => {
  const { slot, source, target, bindings, onNavigate } = await mount();
  down(source); move(target);
  expect(target.getAttribute("data-conversation-drop")).toBe("true");
  expect(slot.container.querySelector('[data-conversation-dragging="true"]')).not.toBeNull();
  expect(target.textContent).toContain("Add to end");
  expect(document.querySelector(".conversation-drag-ghost")).not.toBeNull();
  up(); fireEvent.click(target.querySelector("button")!);
  await waitFor(() => expect(bindings).toContainEqual({ threadId: "chat", botId: "nova" }));
  await waitFor(() => expect(nativeRow(slot.container, "chat")).toBeNull());
  expect(slot.inspection.rpcCalls.filter(call => call.method === "conversation_assign")).toEqual([{ method: "conversation_assign", input: { threadId: "chat", botId: "nova", placeFirst: false } }]);
  expect(slot.inspection.rpcCalls.some(call => call.method === "bots_reorder" || call.method === "main_set")).toBe(false);
  expect(slot.inspection.navigateCalls).toEqual([]); expect(onNavigate).not.toHaveBeenCalled();
  expect(bindings.find(entry => entry.threadId === "assigned-child")?.botId).toBe("atlas");
  expect(document.querySelector(".conversation-drag-ghost")).toBeNull();
  await waitFor(() => expect(target.querySelector(".conversation-disclosure")?.getAttribute("aria-expanded")).toBe("true"));
  fireEvent.click(target.querySelector("button")!);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "main-b", options: undefined });
});

it("Shift promotes an outside drop and unfolds, updating the hint without pointer movement", async () => {
  const { slot, source, target } = await mount(); down(source); move(target);
  fireEvent.keyDown(document, { key: "Shift", shiftKey: true });
  expect(target.textContent).toContain("Make first");
  fireEvent.keyUp(document, { key: "Shift", shiftKey: false });
  expect(target.textContent).toContain("Add to end");
  fireEvent.keyDown(document, { key: "Shift", shiftKey: true }); up(true);
  await waitFor(() => expect(target.querySelector(".conversation-disclosure")?.getAttribute("aria-expanded")).toBe("true"));
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "conversation_assign", input: { threadId: "chat", botId: "nova", placeFirst: true } });
  fireEvent.click(target.querySelector("button")!);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "chat", options: undefined });
});

it("Escape cancels the drop and suppresses the eventual release click", async () => {
  const { slot, source, target, onNavigate } = await mount(); down(source); move(target);
  fireEvent.keyDown(document, { key: "Escape" }); expect(document.querySelector(".conversation-drag-ghost")).toBeNull();
  up(); fireEvent.click(target.querySelector("button")!);
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
  expect(slot.inspection.navigateCalls).toEqual([]); expect(onNavigate).not.toHaveBeenCalled();
});

it("drops on the face to promote without Shift, switching feedback between both zones", async () => {
  const { slot, source, target } = await mount();
  const face = target.querySelector<HTMLElement>("[data-bot-drop-first]")!;
  const body = target.querySelector<HTMLElement>("[data-bot-drop-append]")!;
  down(source); move(face.firstElementChild ?? face);
  expect(face.dataset.dropActive).toBe("true");
  expect(target.textContent).toContain("Make first");
  move(body);
  expect(face.dataset.dropActive).toBe("false");
  expect(body.dataset.dropActive).toBe("true");
  expect(target.textContent).toContain("Add to end");
  move(face); up();
  await waitFor(() => expect(target.querySelector(".conversation-disclosure")?.getAttribute("aria-expanded")).toBe("true"));
  expect(slot.inspection.rpcCalls).toContainEqual({ method: "conversation_assign", input: { threadId: "chat", botId: "nova", placeFirst: true } });
  expect(slot.inspection.navigateCalls).toEqual([]);
});

it("does not change drop zones unseen at release", async () => {
  const { slot, source, target } = await mount(); down(source); move(target);
  hit = target.querySelector("[data-bot-drop-first]"); up();
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
});

it("unfolds immediately after append succeeds and reveals the added row after a delayed refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    const { slot, source, target } = await mount(false, () => gate);
    down(source); move(target); up();
    await waitFor(() => expect(target.querySelector(".conversation-disclosure")?.getAttribute("aria-expanded")).toBe("true"));
    expect(scroll).not.toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "instant" });
    release();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "instant" }));
    const added = target.closest(".project-group")!.querySelector('[data-sidebar-thread-id="chat"]');
    expect(added).not.toBeNull();
    expect(scroll.mock.contexts).toContain(added);
    expect(slot.inspection.navigateCalls).toEqual([]);
  } finally {
    release();
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it("leaves ordinary drags to the host and never starts assignment dragging for touch", async () => {
  const { slot, source, target } = await mount();
  down(source, "mouse", false); hit = source; fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 300 });
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
  down(source, "touch"); move(target); up();
  expect(document.querySelector(".conversation-drag-ghost")).toBeNull();
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
});

it("dropping outside the bot rows does not assign or accept external targets", async () => {
  const { slot, source } = await mount();
  const external = document.createElement("div"); external.dataset.botDropTarget = "nova"; document.body.append(external);
  down(source); move(external); up(); external.remove();
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
});

it("does not assign to a different bot moved beneath the pointer after the last highlight", async () => {
  const { slot, source, target } = await mount(); down(source); move(target);
  hit = slot.container.querySelector('[data-bot-drop-target="atlas"]'); up();
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
});

it("keeps the chat in place and shows the server error on failure", async () => {
  const { slot, source, target } = await mount(true); down(source); move(target); up();
  expect((await slot.findByRole("alert")).textContent).toContain("Assignment failed");
  expect(nativeRow(slot.container, "chat")).not.toBeNull();
  expect(document.querySelector(".conversation-drag-ghost")).toBeNull();
});

it("cleans up listeners and the ghost on unmount", async () => {
  const { slot, source, target } = await mount(); down(source); move(target); slot.lifecycle.unmount(); up();
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
  expect(document.querySelector(".conversation-drag-ghost")).toBeNull();
});

// Regular HTML5 drags: dropping a native thread drag on a bot row assigns.
// jsdom does not implement DragEvent (testing-library drops unknown init
// fields such as clientY) and rects are all zeros, so dispatch manual
// bubbling events: clientY 0 is inside the face (place first), anything
// else is the append zone.
const threadDrag = (threadId: string | null) => ({
  types: threadId ? ["application/x-bb-thread-id"] : [],
  getData: () => threadId ?? "",
});
function dragEvent(type: "dragstart" | "dragover" | "drop", threadId: string | null, clientY?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: threadDrag(threadId) });
  if (clientY !== undefined) Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}
const dragOverRow = (target: HTMLElement, clientY: number) => { fireEvent(target.parentElement!, dragEvent("dragover", "chat", clientY)); };

it("assigns on a regular drag drop and highlights the hovered bot", async () => {
  const { slot, target } = await mount();
  dragOverRow(target, 100);
  expect(target.dataset.threadDropHover).toBe("true");
  expect(target.textContent).toContain("Drop to add at end");
  fireEvent(target.parentElement!, dragEvent("drop", "chat", 100));
  expect(target.dataset.threadDropHover).toBe("false");
  await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "conversation_assign", input: { threadId: "chat", botId: "nova", placeFirst: false } }));
  expect(slot.inspection.rpcCalls.some(call => call.method === "bots_reorder")).toBe(false);
});

it("a regular drag dropped on the bot's face promotes to first", async () => {
  const { slot, target } = await mount();
  dragOverRow(target, 0);
  expect(target.textContent).toContain("Drop to make top conversation");
  fireEvent(target.parentElement!, dragEvent("drop", "chat", 0));
  await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({ method: "conversation_assign", input: { threadId: "chat", botId: "nova", placeFirst: true } }));
});

it("ignores regular drops for owned threads, other payloads, and other rows", async () => {
  const { slot, source, target } = await mount();
  fireEvent(source, dragEvent("dragstart", "main-a"));
  dragOverRow(target, 100);
  expect(target.dataset.threadDropHover).toBe("false");
  fireEvent(source, dragEvent("dragstart", "chat"));
  fireEvent(source.parentElement!, dragEvent("dragover", null, 100));
  expect(target.dataset.threadDropHover).toBe("false");
  fireEvent.drop(source, { dataTransfer: threadDrag("chat") });
  expect(slot.inspection.rpcCalls.some(call => call.method === "conversation_assign")).toBe(false);
});
