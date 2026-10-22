import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, type CreateFakePluginHostOptions, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import ompPlugin from "./server.js";
import { MODEL_FILTER_REREGISTER_DELAY_MS } from "./src/model-filter-settings.js";

const disposeHosts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposeHosts.splice(0)) await dispose();
});

async function loadedPlugin(): Promise<FakePluginHost> {
  const host = createFakePluginHost({ pluginId: "provider-omp" });
  disposeHosts.push(() => host.harness.lifecycle.dispose());
  await ompPlugin(host.bb);
  return host;
}

function currentDeclaration(host: FakePluginHost) {
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "omp",
  );
  if (declaration === undefined)
    throw new Error("expected omp to be registered");
  return declaration;
}

describe("the omp plugin's environment passthrough", () => {
  it("allows host-set launch, storage, and lifecycle controls to reach the bridge", async () => {
    expect(currentDeclaration(await loadedPlugin()).env?.passthrough).toEqual([
      "BB_OMP_BRIDGE_COMMAND",
      "BB_OMP_BRIDGE_ARGS",
      "BB_OMP_BRIDGE_SESSION_DIR",
      "BB_OMP_BRIDGE_READINESS_TIMEOUT_MS",
      "BB_OMP_CATALOG_IDLE_MS",
    ]);
  });
});

describe("the omp plugin's skill roots", () => {
  it("resolves all roots per host so profiles and disabled sources can remove defaults", async () => {
    const declaration = currentDeclaration(await loadedPlugin());
    expect(declaration.experimental_nativeSkillRoots).toBeUndefined();
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);
  });
});

describe("the omp plugin's extension surfaces", () => {
  it("declares persisted status state and notification items", async () => {
    expect(currentDeclaration(await loadedPlugin()).extensionKinds).toMatchObject({
      status: { state: expect.anything() },
      notice: { item: expect.anything() },
    });
  });
});

describe("the omp plugin's model filter settings", () => {
  it("starts with only latest-per-family on", async () => {
    expect(currentDeclaration(await loadedPlugin()).experimental_bridgeOptions).toEqual({
      modelFilter: expect.objectContaining({
        latestPerFamily: true,
        minIntelligence: null,
        maxInputPrice: null,
        minContextWindow: null,
        requireTools: false,
        providerDeny: [],
      }),
    });
  });

  it("re-registers once with the settled filter after a burst of setting changes", async () => {
    const host = await loadedPlugin();
    vi.useFakeTimers();
    try {
      const register = vi.spyOn(host.bb.providers, "register");
      await host.harness.setSettings({ modelFilterMinIntelligence: 40 });
      await host.harness.setSettings({
        modelFilterMinContextWindow: 200,
        modelFilterProviderDeny: " openrouter , example-router-* ,",
      });
      expect(currentDeclaration(host).experimental_bridgeOptions).toMatchObject({
        modelFilter: { minIntelligence: null },
      });
      await vi.advanceTimersByTimeAsync(MODEL_FILTER_REREGISTER_DELAY_MS);
      expect(register).toHaveBeenCalledTimes(1);
      expect(host.harness.registrations.providerRegistrations.filter((entry) => entry.id === "omp")).toHaveLength(1);
      expect(currentDeclaration(host).experimental_bridgeOptions).toMatchObject({
        modelFilter: {
          latestPerFamily: true,
          minIntelligence: 40,
          minContextWindow: 200_000,
          providerDeny: ["openrouter", "example-router-*"],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

async function serviceHost(options: {
  providerId?: string;
  environmentId?: string | null;
  path?: string | null;
  hostId?: string;
  primaryHostId?: string | null;
  callHost?: CreateFakePluginHostOptions["experimental_callHostRpc"];
} = {}) {
  const hostId = options.hostId ?? "host-server";
  const host = createFakePluginHost({
    pluginId: "provider-omp",
    sdk: {
      threads: {
        get: async () => makeThreadResponse({
          providerId: options.providerId ?? "omp",
          environmentId: options.environmentId === undefined ? "env-omp" : options.environmentId,
        }),
      },
      environments: {
        get: async () => ({ hostId, path: options.path === undefined ? "/workspace/omp" : options.path }),
      },
      system: {
        config: async () => ({ primaryHostId: options.primaryHostId === undefined ? "host-server" : options.primaryHostId }),
      },
    },
    experimental_callHostRpc: options.callHost ?? (async () => ({
      projectDir: "/workspace/omp",
      services: [{ name: "web", state: "ready", internal: false, url: "http://127.0.0.1:3000", port: 3000 }],
    })),
  });
  await ompPlugin(host.bb);
  disposeHosts.push(() => host.harness.lifecycle.dispose());
  return host;
}

describe("the omp Hub service RPC", () => {
  it("lists services in the thread's resolved workspace and identifies the server's machine", async () => {
    const host = await serviceHost();
    await expect(host.harness.behavior.callRpc("listServices", { threadId: "thread-omp" })).resolves.toEqual({
      available: true,
      hostIsLocal: true,
      projectDir: "/workspace/omp",
      services: [{ name: "web", state: "ready", internal: false, url: "http://127.0.0.1:3000", port: 3000 }],
    });
    expect(host.harness.experimental_hostRpcCalls[0]).toMatchObject({
      method: "listOmpServices", hostId: "host-server", input: { cwd: "/workspace/omp" },
    });
  });

  it.each(["remote-machine", null])("does not mark a non-server host as local (%s)", async (primaryHostId) => {
    const host = await serviceHost({ primaryHostId });
    await expect(host.harness.behavior.callRpc("listServices", { threadId: "thread-omp" })).resolves.toMatchObject({ available: true, hostIsLocal: false });
  });

  it.each([
    { providerId: "codex", reason: "Services are only available for omp threads." },
    { environmentId: null, reason: "This thread has no workspace." },
    { path: null, reason: "This thread has no workspace path." },
  ])("returns a readable unavailable state without contacting the host: $reason", async ({ reason, ...options }) => {
    const host = await serviceHost(options);
    await expect(host.harness.behavior.callRpc("listServices", { threadId: "thread-omp" })).resolves.toEqual({ available: false, reason });
    expect(host.harness.experimental_hostRpcCalls).toHaveLength(0);
  });

  it.each(["Host is disconnected", "spawn omp ENOENT"])("returns host failures as unavailable: %s", async (reason) => {
    const host = await serviceHost({ callHost: async () => { throw new Error(reason); } });
    await expect(host.harness.behavior.callRpc("listServices", { threadId: "thread-omp" })).resolves.toEqual({ available: false, reason });
  });

  it("uses the environment's host and path for logs and controls, and propagates action failures", async () => {
    const host = await serviceHost({
      hostId: "remote-workstation",
      path: "/remote/workspace",
      callHost: async ({ method }) => {
        if (method === "readOmpServiceLogs") return { text: "web ready\\n" };
        throw new Error("Cannot stop web: access denied");
      },
    });
    await expect(host.harness.behavior.callRpc("serviceLogs", { threadId: "thread-omp", name: "web", lines: 75 })).resolves.toEqual({ text: "web ready\\n" });
    await expect(host.harness.behavior.callRpc("controlService", { threadId: "thread-omp", name: "web", action: "stop" })).rejects.toThrow("Cannot stop web: access denied");
    expect(host.harness.experimental_hostRpcCalls).toMatchObject([
      { method: "readOmpServiceLogs", hostId: "remote-workstation", input: { cwd: "/remote/workspace", name: "web", lines: 75 } },
      { method: "controlOmpService", hostId: "remote-workstation", input: { cwd: "/remote/workspace", name: "web", action: "stop" } },
    ]);
  });

  it("aborts host calls when the plugin is disposed", async () => {
    const host = await serviceHost();
    await host.harness.behavior.callRpc("listServices", { threadId: "thread-omp" });
    const signal = host.harness.experimental_hostRpcCalls[0]?.signal;
    expect(signal?.aborted).toBe(false);
    await host.harness.lifecycle.dispose();
    expect(signal?.aborted).toBe(true);
  });
});
