import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { DEFAULT_POLICY } from "./policy";
import { hostContract } from "./contracts";

for (const providerId of ["acp-omp", "omp"]) test(`${providerId} creation opt-in persists before a workspace exists, preserves policy, and can be disabled`, async () => {
  const host = createFakePluginHost({ pluginId: "continuity", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thr_new", providerId, environmentId: null }) },
  } });
  plugin(host.bb);
  try {
    await host.harness.behavior.callRpc("setEnabled", { threadId: "thr_new", enabled: true });
    const first = await host.harness.behavior.callRpc("inspect", { threadId: "thr_new" }) as { configured: boolean; policy: { enabled: boolean } };
    expect(first.configured).toBe(true);
    expect(first.policy.enabled).toBe(true);
    await host.harness.behavior.callRpc("setEnabled", { threadId: "thr_new", enabled: false });
    const disabled = await host.harness.behavior.callRpc("inspect", { threadId: "thr_new" }) as { policy: Record<string, unknown> };
    expect(disabled.policy).toEqual({ ...first.policy, enabled: false });
  } finally { await host.harness.lifecycle.dispose(); }
});

test("creation opt-in rejects non-OMP threads without saving a policy", async () => {
  const host = createFakePluginHost({ pluginId: "continuity", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thr_other", providerId: "codex", environmentId: null }) },
  } });
  plugin(host.bb);
  try {
    await expect(host.harness.behavior.callRpc("setEnabled", { threadId: "thr_other", enabled: true })).rejects.toThrow("acp-omp");
    expect(await host.bb.storage.kv.get("thread:thr_other")).toBeUndefined();
  } finally { await host.harness.lifecycle.dispose(); }
});

test("resident reconcile observes later policies, preserves maintenance requests, and stops on abort", async () => {
  // Integration coverage intentionally exercises Node's abortable service timer,
  // rather than replacing the timer implementation used by plugin shutdown.
  const reconciled = Promise.withResolvers<void>();
  let reconciliations = 0;
  const host = createFakePluginHost({ pluginId: "continuity", sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, providerId: threadId === "thr_rpc" ? "omp" : "acp-omp", environmentId: "env_test" }) },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method !== "control") throw new Error(`Unexpected host call: ${method}`);
    if (++reconciliations === 2) reconciled.resolve();
    return { queued: false };
  } });
  host.harness.sdk.stub("environments.get", async () => ({ hostId: "host_test", path: "/workspace", lifecycle: { phase: "active" } }));
  plugin(host.bb);
  const service = host.harness.behavior.runService("reconcile");
  let settled = false;
  void service.done.then(() => { settled = true; });
  try {
    // Let the initial empty scan finish; a one-shot service would now be stopped.
    await Bun.sleep(20);
    expect(settled).toBe(false);
    await host.harness.behavior.callRpc("setEnabled", { threadId: "thr_rpc", enabled: true });
    await host.harness.behavior.callRpc("setEnabled", { threadId: "thr_acp", enabled: false });
    await reconciled.promise;
    const calls = host.harness.experimental_hostRpcCalls;
    expect(calls.map(call => hostContract.control.input.parse(call.input)).sort((a, b) => a.threadId.localeCompare(b.threadId))).toEqual([
      { threadId: "thr_acp", policy: { ...DEFAULT_POLICY, enabled: false }, compact: false },
      { threadId: "thr_rpc", policy: { ...DEFAULT_POLICY, enabled: true }, compact: false },
    ]);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    service.controller.abort();
    await service.done;
    expect(settled).toBe(true);
  } finally { service.controller.abort(); await service.done; await host.harness.lifecycle.dispose(); }
}, 10_000);

for (const providerId of ["omp", "acp-omp"]) test(`${providerId} launch prepares the scoped extension and exposes live controls`, async () => {
  const host = createFakePluginHost({ pluginId: "continuity", sdk: {
    threads: { get: async () => makeThreadResponse({ id: "thr_launch", projectId: "proj_test", providerId, environmentId: "env_test" }) },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "prepare") return { directory: "/continuity/thr_launch", extension: "/continuity/thr_launch/extension.mjs" };
    if (method === "inspect") return { status: null };
    if (method === "control") return { queued: true };
    throw new Error(`Unexpected host method: ${method}`);
  } });
  host.harness.sdk.stub("environments.get", async () => ({ hostId: "host_test", path: "/workspace", lifecycle: { phase: "active" } }));
  plugin(host.bb);
  try {
    await host.harness.behavior.callRpc("setEnabled", { threadId: "thr_launch", enabled: true });
    const env = await host.harness.behavior.resolveProviderEnv(providerId, { threadId: "thr_launch", projectId: "proj_test", hostId: "host_test" });
    expect(Object.fromEntries(env.map(entry => [entry.name, entry.value]))).toEqual({
      BB_CONTINUITY_DIRECTORY: "/continuity/thr_launch",
      BB_CONTINUITY_EXTENSION: "/continuity/thr_launch/extension.mjs",
    });
    expect(await host.harness.behavior.callRpc("configure", { threadId: "thr_launch", policy: { ...DEFAULT_POLICY, tools: ["read", "grep"] } })).toMatchObject({ applied: true });
    expect(await host.harness.behavior.callRpc("inspect", { threadId: "thr_launch" })).toMatchObject({ supported: true, configured: true, policy: { tools: ["read", "grep"] } });
    expect(await host.harness.behavior.callRpc("compact", { threadId: "thr_launch" })).toMatchObject({ queued: true });
    expect(await host.harness.behavior.callRpc("statuses", { threadIds: ["thr_launch"] })).toEqual({ statuses: { thr_launch: null } });
    const before = host.harness.experimental_hostRpcCalls.length;
    expect(await host.harness.behavior.resolveProviderEnv(providerId, { threadId: "thr_launch", projectId: "proj_other", hostId: "host_test" })).toEqual([]);
    expect(host.harness.experimental_hostRpcCalls.length).toBe(before);
  } finally { await host.harness.lifecycle.dispose(); }
});
