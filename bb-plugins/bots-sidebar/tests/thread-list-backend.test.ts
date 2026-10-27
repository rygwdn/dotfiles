import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import nativePlugin from "../vendor/bb/thread-list/server";
import { registerThreadListBackend } from "../integration/thread-list-backend";
import { defaultPreferences } from "../vendor/bb/thread-list/shared/preferences";

// Exercise the real copied backend, not an RPC echo: CLI and bot UI must mutate
// the same durable store, and external changes must reach the bot's realtime.
describe("builtin thread-list preference interoperability", () => {
  it("shares CLI writes, UI writes and resets without a second store", async () => {
    const native = createFakePluginHost({ pluginId: "thread-list", sdk: {
      system: { uiPreferences: { list: async () => ({ preferences: {} }) } },
    } });
    await nativePlugin(native.bb);
    const bots = createFakePluginHost({ pluginId: "bots-sidebar", sdk: {
      plugins: { callRpc: async ({ pluginId, method, input, outputSchema }) => {
        if (pluginId !== "thread-list") throw new Error(`Unexpected plugin: ${pluginId}`);
        return outputSchema.parse(await native.harness.behavior.callRpc(method, input));
      } },
    } });
    registerThreadListBackend(bots.bb);
    const service = bots.harness.behavior.runService("builtin-thread-list-preferences");
    try {
      await bots.harness.behavior.callRpc("listPreferences", null);
      const result = await native.harness.behavior.runCli(["prefs", "set", "organizationMode", "machine", "--json"]);
      expect(result.exitCode).toBe(0);
      await vi.waitFor(() => expect(bots.harness.realtimeSignals).toContainEqual({
        channel: "preferences", payload: { key: "organizationMode", value: "machine" },
      }), { timeout: 5000 });
      await bots.harness.behavior.callRpc("setPreference", { key: "organizationMode", value: "project" });
      expect(await native.bb.storage.kv.get("preference:organizationMode")).toBe("project");
      expect(await bots.bb.storage.kv.get("preference:organizationMode")).toBeUndefined();
      await expect(bots.harness.behavior.callRpc("setPreference", { key: "organizationMode", value: "sideways" })).rejects.toThrow(/Invalid value/);
      expect(await native.bb.storage.kv.get("preference:organizationMode")).toBe("project");
      await bots.harness.behavior.callRpc("resetPreference", { key: "organizationMode" });
      expect(await native.bb.storage.kv.get("preference:organizationMode")).toBeUndefined();
      expect(bots.harness.realtimeSignals.at(-1)).toEqual({ channel: "preferences", payload: { key: "organizationMode", value: defaultPreferences().organizationMode } });
    } finally {
      service.controller.abort();
      await service.done;
      await bots.harness.lifecycle.dispose();
      await native.harness.lifecycle.dispose();
    }
  });
});
