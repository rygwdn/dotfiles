import { afterEach, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend, PERSONAL_ID, project } from "./backend-fixture";

const instances: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(host => host.harness.lifecycle.dispose())); });
async function setup() { const host = await backend([project()]); instances.push(host); return host; }
function addThread(host: Awaited<ReturnType<typeof backend>>, id: string, projectId = PERSONAL_ID, parentThreadId: string | null = null) {
  const value = makeThreadResponse({ id, projectId, parentThreadId, createdAt: 1, title: "Conversation", originPluginId: null }); host.threads.set(id, value); return value;
}

it("resolves the bot bound to a thread", async () => {
  const host = await setup(); const bot = await host.create("Atlas");
  addThread(host, "chat");
  host.store.bind("chat", bot.id);
  await expect(host.harness.behavior.callRpc("resolveBotForThread", { threadId: "chat" })).resolves.toEqual({ botId: bot.id, botName: "Atlas" });
});

it("returns null for an unbound thread without binding it", async () => {
  const host = await setup(); await host.create("Atlas");
  addThread(host, "chat");
  await expect(host.harness.behavior.callRpc("resolveBotForThread", { threadId: "chat" })).resolves.toBeNull();
  expect(host.store.owner("chat")).toBeNull();
});

it("inherits the bot through the parent conversation", async () => {
  const host = await setup(); const bot = await host.create("Atlas");
  addThread(host, "parent"); host.store.bind("parent", bot.id);
  addThread(host, "child", PERSONAL_ID, "parent");
  await expect(host.harness.behavior.callRpc("resolveBotForThread", { threadId: "child" })).resolves.toEqual({ botId: bot.id, botName: "Atlas" });
});

it("returns null for a thread that does not exist", async () => {
  const host = await setup();
  await expect(host.harness.behavior.callRpc("resolveBotForThread", { threadId: "missing" })).resolves.toBeNull();
});

it("lists only the selected bot's BB memories, ranked pinned/importance/recency", async () => {
  const host = await setup(); const bot = await host.create("Atlas"); const other = await host.create("Ponder", []);
  const record = (id: string, ownerBotId: string | null, scope: string, overrides: Record<string, unknown> = {}) => ({
    id, scope, projectId: null, ownerBotId, name: id, summary: `summary ${id}`, details: "d", kind: "fact",
    tags: ["t"], importance: 50, pinned: false, sourceThreadId: null, writeReason: "test", version: 1, createdAt: 1, updatedAt: 1, ...overrides,
  });
  host.harness.sdk.stub("plugins.callRpc", async () => ({ memories: [
    record("global-1", null, "global"),
    record("other-1", other.id, "bot"),
    record("a", bot.id, "bot", { importance: 30 }),
    record("b", bot.id, "bot", { importance: 90 }),
    record("c", bot.id, "bot", { pinned: true, importance: 10 }),
    record("d", bot.id, "bot", { updatedAt: 5, importance: 90 }),
  ] }));
  await expect(host.harness.behavior.callRpc("bot_memory_list", { botId: bot.id })).resolves.toEqual({
    memories: [
      { id: "c", name: "c", summary: "summary c", kind: "fact", tags: ["t"], importance: 10, pinned: true, updatedAt: 1 },
      { id: "d", name: "d", summary: "summary d", kind: "fact", tags: ["t"], importance: 90, pinned: false, updatedAt: 5 },
      { id: "b", name: "b", summary: "summary b", kind: "fact", tags: ["t"], importance: 90, pinned: false, updatedAt: 1 },
      { id: "a", name: "a", summary: "summary a", kind: "fact", tags: ["t"], importance: 30, pinned: false, updatedAt: 1 },
    ],
    available: true,
  });
});

it("reports the memory fork as unavailable instead of failing the editor", async () => {
  const host = await setup(); const bot = await host.create("Atlas");
  host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Plugin memory-fork is not installed"); });
  const result = await host.harness.behavior.callRpc("bot_memory_list", { botId: bot.id }) as { available: boolean; memories: unknown[]; detail?: string };
  expect(result.available).toBe(false);
  expect(result.memories).toEqual([]);
  expect(result.detail).toMatch(/memory-fork/);
});

it("rejects bot_memory_list for an unknown bot", async () => {
  const host = await setup();
  await expect(host.harness.behavior.callRpc("bot_memory_list", { botId: "bot_missing" })).rejects.toThrow();
});
