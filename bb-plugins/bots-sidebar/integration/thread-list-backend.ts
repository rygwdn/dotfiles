import { setTimeout } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { threadListRpcContract } from "../vendor/bb/thread-list/server";
import { PREFERENCES_CHANGED_CHANNEL, type PreferenceValues } from "../vendor/bb/thread-list/shared/preferences";

// Keep the bundled plugin authoritative: its CLI, Move action and the copied
// list must agree. The public SDK has no cross-plugin realtime subscription,
// so external changes are reconciled every three seconds; local writes publish
// immediately. No second preference store or competing Move action is created.
const PREFERENCE_SYNC_MS = 3000;

export function registerThreadListBackend(bb: BbPluginApi) {
  type Snapshot = { preferences: PreferenceValues };
  let previous: Snapshot | undefined;
  async function list() {
    return bb.sdk.plugins.callRpc({
      pluginId: "thread-list", method: "listPreferences", input: null,
      outputSchema: threadListRpcContract.listPreferences.output,
    });
  }
  function reconcile(snapshot: Snapshot) {
    for (const [key, value] of Object.entries(snapshot.preferences)) {
      if (!previous || JSON.stringify(previous.preferences[key as keyof Snapshot["preferences"]]) !== JSON.stringify(value)) {
        bb.realtime.publish(PREFERENCES_CHANGED_CHANNEL, { key, value });
      }
    }
    previous = snapshot;
  }
  // Serialize reads and writes so an older poll cannot overwrite a completed
  // local write with a stale snapshot.
  let pending = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.then(() => {}, () => {});
    return result;
  }
  bb.rpc.register(threadListRpcContract, {
    listPreferences: () => serial(async () => {
      const snapshot = await list();
      reconcile(snapshot);
      return snapshot;
    }),
    setPreference: input => serial(async () => {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "thread-list", method: "setPreference", input: { key: input.key, value: z.json().parse(input.value) },
        outputSchema: threadListRpcContract.setPreference.output,
      });
      reconcile(await list());
      return result;
    }),
    resetPreference: input => serial(async () => {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "thread-list", method: "resetPreference", input,
        outputSchema: threadListRpcContract.resetPreference.output,
      });
      reconcile(await list());
      return result;
    }),
  });
  bb.background.service("builtin-thread-list-preferences", {
    async start(signal) {
      let reportedFailure = false;
      while (!signal.aborted) {
        try {
          await serial(async () => reconcile(await list()));
          reportedFailure = false;
        } catch (error) {
          if (!reportedFailure) bb.log.warn(`Builtin Thread list must remain enabled: ${error instanceof Error ? error.message : String(error)}`);
          reportedFailure = true;
        }
        try { await setTimeout(PREFERENCE_SYNC_MS, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    },
  });
}
