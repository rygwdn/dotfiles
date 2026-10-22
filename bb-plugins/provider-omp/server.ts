import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ompProviderDeclaration } from "./src/declaration.js";
import { ompHubRpcContract, ompServicesHostMethods } from "./src/hub-contract.js";
import { ompModelPresetsHostMethods, ompModelPresetsRpcContract } from "./src/model-presets-contract.js";
import {
  MODEL_FILTER_REREGISTER_DELAY_MS,
  OMP_MODEL_FILTER_SETTINGS,
  settingsToOmpModelFilter,
} from "./src/model-filter-settings.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(OMP_MODEL_FILTER_SETTINGS);
  let modelFilter = settingsToOmpModelFilter(await settings.get());
  let presetsRevision: string | undefined;
  let registered = bb.providers.register(ompProviderDeclaration(modelFilter, presetsRevision));
  let registeredOptions = JSON.stringify([modelFilter, presetsRevision]);
  const lifecycle = new AbortController();
  // Both settings and preset writes share one settled re-declaration. It refreshes
  // bb's catalog cache without replacing bridges for running threads.
  // Debouncing avoids retiring an idle bridge while its model probe is in flight.
  let pendingReregister: NodeJS.Timeout | undefined;
  function scheduleReregister(): void {
    clearTimeout(pendingReregister);
    pendingReregister = setTimeout(() => {
      pendingReregister = undefined;
      if (lifecycle.signal.aborted) return;
      const nextOptions = JSON.stringify([modelFilter, presetsRevision]);
      if (nextOptions === registeredOptions) return;
      registered.dispose();
      registered = bb.providers.register(ompProviderDeclaration(modelFilter, presetsRevision));
      registeredOptions = nextOptions;
    }, MODEL_FILTER_REREGISTER_DELAY_MS);
  }
  settings.onChange((next) => {
    modelFilter = settingsToOmpModelFilter(next);
    scheduleReregister();
  });
  const host = bb.hosts.experimental_client({
    contract: { ...ompServicesHostMethods, ...ompModelPresetsHostMethods },
  });

  async function workspace(threadId: string): Promise<{ hostId: string; cwd: string }> {
    const thread = await bb.sdk.threads.get({ threadId, signal: lifecycle.signal });
    if (thread.providerId !== "omp") throw new Error("Services are only available for omp threads.");
    if (!thread.environmentId) throw new Error("This thread has no workspace.");
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal: lifecycle.signal,
    });
    if (!environment.path) throw new Error("This thread has no workspace path.");
    return { hostId: environment.hostId, cwd: environment.path };
  }

  bb.rpc.register(ompHubRpcContract, {
    async listServices({ threadId }) {
      try {
        const { hostId, cwd } = await workspace(threadId);
        const [result, config] = await Promise.all([
          host.call("listOmpServices", { cwd }, { hostId, signal: lifecycle.signal }),
          bb.sdk.system.config({ signal: lifecycle.signal }),
        ]);
        return { available: true as const, ...result, hostIsLocal: hostId === config.primaryHostId };
      } catch (error) {
        return { available: false as const, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async serviceLogs({ threadId, name, lines }) {
      const { hostId, cwd } = await workspace(threadId);
      return host.call("readOmpServiceLogs", { cwd, name, lines }, { hostId, signal: lifecycle.signal });
    },
    async controlService({ threadId, name, action }) {
      const { hostId, cwd } = await workspace(threadId);
      return host.call("controlOmpService", { cwd, name, action }, { hostId, signal: lifecycle.signal });
    },
  });
  async function primaryHost(): Promise<string> {
    const config = await bb.sdk.system.config({ signal: lifecycle.signal });
    if (!config.primaryHostId) {
      throw new Error("No primary host is configured. Connect a host to edit omp model presets.");
    }
    return config.primaryHostId;
  }

  bb.rpc.register(ompModelPresetsRpcContract, {
    async listModelPresets(input) {
      return host.call("listModelPresets", input, {
        hostId: await primaryHost(),
        signal: lifecycle.signal,
      });
    },
    async saveModelPreset(input) {
      const result = await host.call("saveModelPreset", input, {
        hostId: await primaryHost(),
        signal: lifecycle.signal,
      });
      presetsRevision = result.presetsRevision;
      scheduleReregister();
      return result;
    },
    async deleteModelPreset(input) {
      const result = await host.call("deleteModelPreset", input, {
        hostId: await primaryHost(),
        signal: lifecycle.signal,
      });
      presetsRevision = result.presetsRevision;
      scheduleReregister();
      return result;
    },
  });
  bb.onDispose(() => {
    clearTimeout(pendingReregister);
    lifecycle.abort();
    registered.dispose();
  });
}
