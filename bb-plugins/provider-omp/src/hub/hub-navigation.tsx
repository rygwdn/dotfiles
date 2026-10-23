import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  experimental_usePluginId,
  useBbNavigate,
  useSdk,
  type JsonValue,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  OMP_HUB_PANEL_ACTION_ID,
  ompHubPanelParamsSchema,
} from "../hub-contract.js";

interface HubSelection {
  params: JsonValue | null;
  agentId: string | undefined;
  listeners: Set<() => void>;
}

// Panel params identify a tab; the SDK has no setter for an existing tab's
// params. Keep selection separate so Details can focus and retarget that tab.
const selections = new Map<string, HubSelection>();
const mountedHubs = new Map<string, Map<HubSelection, number>>();

function hubSelection(threadId: string, params: JsonValue | null): HubSelection {
  const key = JSON.stringify([threadId, params]);
  let selection = selections.get(key);
  if (!selection) {
    const parsed = ompHubPanelParamsSchema.safeParse(params ?? {});
    selection = {
      params,
      agentId: parsed.success ? parsed.data.agentId : undefined,
      listeners: new Set(),
    };
    selections.set(key, selection);
  }
  return selection;
}

function selectAgent(selection: HubSelection, agentId: string | undefined) {
  if (selection.agentId === agentId) return;
  selection.agentId = agentId;
  for (const listener of selection.listeners) listener();
}

export function useHubSelection(threadId: string, params: JsonValue | null) {
  const key = JSON.stringify(params);
  const selection = useMemo(
    () => hubSelection(threadId, JSON.parse(key) as JsonValue),
    [threadId, key],
  );
  const agentId = useSyncExternalStore(
    (listener) => {
      selection.listeners.add(listener);
      return () => selection.listeners.delete(listener);
    },
    () => selection.agentId,
  );

  useEffect(() => {
    let mounted = mountedHubs.get(threadId);
    if (!mounted) {
      mounted = new Map();
      mountedHubs.set(threadId, mounted);
    }
    mounted.set(selection, (mounted.get(selection) ?? 0) + 1);
    return () => {
      const count = (mounted.get(selection) ?? 1) - 1;
      if (count > 0) mounted.set(selection, count);
      else mounted.delete(selection);
      if (mounted.size === 0) mountedHubs.delete(threadId);
    };
  }, [threadId, selection]);

  return [agentId, (id: string | undefined) => selectAgent(selection, id)] as const;
}

export function OmpAgentDetailsDirective({
  attributes,
  message,
}: PluginMessageDirectiveProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = ompHubPanelParamsSchema.safeParse({ agentId: attributes.id });
  const agentId = parsed.success ? parsed.data.agentId : undefined;
  if (!agentId) return null;

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      let selection = mountedHubs.get(message.threadId)?.keys().next().value;
      if (!selection) {
        const { tabs } = await sdk.threads.tabs.get({ threadId: message.threadId });
        const existing = tabs.find(
          (tab) =>
            tab.kind === "plugin-panel" &&
            tab.pluginId === pluginId &&
            tab.actionId === OMP_HUB_PANEL_ACTION_ID,
        );
        const params: JsonValue =
          existing?.kind === "plugin-panel"
            ? existing.paramsJson === null
              ? null
              : JSON.parse(existing.paramsJson)
            : { agentId };
        selection = hubSelection(message.threadId, params);
      }
      selectAgent(selection, agentId);
      if (!navigate.openThreadPanel({
        actionId: OMP_HUB_PANEL_ACTION_ID,
        title: "omp Hub",
        params: selection.params,
      })) {
        setError("omp Hub is not available on this surface.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open omp Hub.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`View agent ${agentId} details`}
        disabled={busy}
        onClick={() => void open()}
      >
        Details
      </Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
