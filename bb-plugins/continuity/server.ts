import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { assertFreshExtension } from "./extension-bundle";
import { hostContract, rpcContract } from "./contracts";
import { policySchema, runtimeSignalSchema, threadIdSchema, type RuntimeStatus } from "./schema";
import { DEFAULT_POLICY, type Policy } from "./policy";

const OMP_PROVIDERS = ["acp-omp", "omp"];
const supportsProvider = (providerId: string) => OMP_PROVIDERS.includes(providerId);

export default function continuity(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: { runtime: { payload: runtimeSignalSchema } } });
  host.experimental_onSignal("runtime", ({ payload }) => { bb.realtime.publish("runtime", payload); });
  async function readPolicy(threadId: string): Promise<Policy | null> {
    const stored = await bb.storage.kv.get<unknown>(`thread:${threadIdSchema.parse(threadId)}`);
    return stored === undefined ? null : policySchema.parse(stored);
  }
  async function target(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId: threadIdSchema.parse(threadId) });
    if (!supportsProvider(thread.providerId)) throw new Error("Continuity supports only the acp-omp and omp providers.");
    if (!thread.environmentId) throw new Error("This thread does not have a host workspace yet.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (!environment.path || environment.lifecycle.phase !== "active") throw new Error("Thread workspace is unavailable.");
    return { hostId: environment.hostId, workspace: environment.path, projectId: thread.projectId };
  }
  async function inspect({ threadId }: { threadId: string }) {
    const policy = await readPolicy(threadId);
    const thread = await bb.sdk.threads.get({ threadId });
    if (!supportsProvider(thread.providerId)) return { supported: false, configured: false, policy: DEFAULT_POLICY, runtime: null, note: "Only acp-omp and omp threads are supported." };
    if (!policy) return { supported: true, configured: false, policy: DEFAULT_POLICY, runtime: null, note: "Not configured. Enabling installs a gated workspace extension; restart the provider once to load it." };
    try {
      const location = await target(threadId);
      const { status: runtime } = await host.call("inspect", { threadId }, { hostId: location.hostId });
      const stale = !runtime || Date.now() - runtime.updatedAt > 10_000 || runtime.state === "stopped";
      return { supported: true, configured: true, policy, runtime,
        note: stale ? "No fresh resident OMP runtime. Desired policy is saved; start/restart the provider to load Continuity. No separate worker resumes sessions." : runtime.reason };
    } catch (error) {
      return { supported: true, configured: true, policy, runtime: null, note: `Runtime unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  // Creation callers can opt in before workspace provisioning. The existing
  // provider env contributor prepares the extension before OMP starts.
  async function setEnabled({ threadId, enabled }: { threadId: string; enabled: boolean }) {
    const thread = await bb.sdk.threads.get({ threadId: threadIdSchema.parse(threadId) });
    if (!supportsProvider(thread.providerId)) throw new Error("Continuity supports only the acp-omp and omp providers.");
    const policy = { ...((await readPolicy(threadId)) ?? DEFAULT_POLICY), enabled };
    await bb.storage.kv.set(`thread:${threadId}`, policy);
    bb.realtime.publish("changed", { threadId });
    return { enabled };
  }
  async function configure({ threadId, policy }: { threadId: string; policy: Policy }) {
    const location = await target(threadId);
    assertFreshExtension();
    await host.call("prepare", { threadId, workspace: location.workspace, policy }, { hostId: location.hostId });
    await bb.storage.kv.set(`thread:${threadId}`, policy);
    bb.realtime.publish("changed", { threadId });
    return { applied: true, note: "Policy saved. A loaded extension picks it up within two seconds; otherwise restart the provider once. Automatic rollover is notes-backed; idle summaries use native OMP soft compaction." };
  }
  async function compact({ threadId }: { threadId: string }) {
    const policy = await readPolicy(threadId);
    if (!policy?.enabled) throw new Error("Enable Continuity for this thread before requesting compaction.");
    const location = await target(threadId);
    const { queued } = await host.call("control", { threadId, policy, compact: true }, { hostId: location.hostId });
    bb.realtime.publish("requested", { threadId });
    return { queued, note: "Request saved for the resident OMP extension. It waits for idle, pending work, and the 15-minute cooldown; it never starts a provider or interrupts a user turn." };
  }
  async function statuses({ threadIds }: { threadIds: string[] }) {
    const out: Record<string, RuntimeStatus | null> = {};
    await Promise.all(threadIds.map(async threadId => {
      const policy = await readPolicy(threadId);
      if (!policy?.enabled) { out[threadId] = null; return; }
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (!supportsProvider(thread.providerId) || !thread.environmentId) { out[threadId] = null; return; }
        const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
        if (!environment.path || environment.lifecycle.phase !== "active") { out[threadId] = null; return; }
        const { status } = await host.call("inspect", { threadId }, { hostId: environment.hostId });
        out[threadId] = status;
      } catch { out[threadId] = null; }
    }));
    return { statuses: out };
  }
  bb.rpc.register(rpcContract, { inspect, configure, setEnabled, compact, statuses });
  for (const providerId of OMP_PROVIDERS) bb.providers.experimental_contributeEnv(providerId, async ctx => {
    const policy = await readPolicy(ctx.threadId);
    if (!policy) return [];
    assertFreshExtension();
    const location = await target(ctx.threadId);
    if (location.hostId !== ctx.hostId || location.projectId !== ctx.projectId) throw new Error("Continuity provider scope changed during launch.");
    const prepared = await host.call("prepare", { threadId: ctx.threadId, workspace: location.workspace, policy }, { hostId: ctx.hostId });
    return [
      { name: "BB_CONTINUITY_DIRECTORY", value: prepared.directory, reason: "Per-thread Continuity control/status directory; contains no transcript archive." },
      { name: "BB_CONTINUITY_EXTENSION", value: prepared.extension, reason: "Opted-in in-process OMP extension." },
    ];
  });
  bb.cli.register({ name: "continuity", summary: "Manage OMP Continuity policy and safe native compaction", commands: [
    { name: "status", summary: "Inspect policy and runtime", usage: "bb continuity status <thread-id> [--json]" },
    { name: "enable", summary: "Enable history-preserving Continuity", usage: "bb continuity enable <thread-id> [--json]" },
    { name: "disable", summary: "Restore native OMP policy", usage: "bb continuity disable <thread-id> [--json]" },
    { name: "compact", summary: "Queue safe native compaction", usage: "bb continuity compact <thread-id> [--json]" },
  ], async run(argv) {
    const args = argv.filter(arg => arg !== "--json"), [command, threadId] = args;
    if (args.length !== 2 || !["status", "enable", "disable", "compact"].includes(command!)) return { exitCode: 1, stderr: "Usage: bb continuity <status|enable|disable|compact> <thread-id> [--json]" };
    try {
      threadIdSchema.parse(threadId);
      const result = command === "status" ? await inspect({ threadId: threadId! }) : command === "compact" ? await compact({ threadId: threadId! }) :
        await configure({ threadId: threadId!, policy: { ...((await readPolicy(threadId!)) ?? DEFAULT_POLICY), enabled: command === "enable" } });
      return { exitCode: 0, stdout: JSON.stringify(result, null, argv.includes("--json") ? undefined : 2) };
    } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
  } });
  // Reassert desired state after reload; teardown turns off runtime behavior without deleting policy/history.
  bb.background.service("reconcile", { async start(signal) {
    while (!signal.aborted) {
      for (const key of await bb.storage.kv.list("thread:")) {
        if (signal.aborted) return;
        const threadId = key.slice("thread:".length);
        try {
          const policy = await readPolicy(threadId);
          if (policy) { const location = await target(threadId); await host.call("control", { threadId, policy, compact: false }, { hostId: location.hostId, signal }); }
        } catch (error) {
          if (signal.aborted) return;
          bb.log.warn(`Continuity reconcile: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try { await delay(5_000, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  } });
  bb.onDispose(async () => {
    for (const key of await bb.storage.kv.list("thread:")) {
      const threadId = key.slice("thread:".length);
      try {
        const policy = await readPolicy(threadId);
        if (policy) { const location = await target(threadId); await host.call("control", { threadId, policy: { ...policy, enabled: false }, compact: false }, { hostId: location.hostId }); }
      } catch (error) { bb.log.warn(`Continuity teardown: ${error instanceof Error ? error.message : String(error)}`); }
    }
  });
}
