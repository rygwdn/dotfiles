import { useEffect, useMemo, useState } from "react";
import { useSdk, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  OMP_AGENTS_ROSTER_LIMIT,
  OMP_AGENTS_STATE_KIND,
  ompAgentsStateSchema,
  type OmpHubAgent,
} from "../hub-contract.js";
import { AgentControls } from "./agent-controls.js";
import { AgentConversation } from "./agent-conversation.js";
import { useHubSelection } from "./hub-navigation.js";
import { OmpServices } from "./service-panel.js";
import { useLatestExtensionState } from "./use-extension-state.js";

const STATUS_DOT: Record<OmpHubAgent["status"], string> = {
  pending: "bg-muted-foreground",
  running: "bg-blue-500",
  completed: "bg-green-500",
  failed: "bg-destructive",
  aborted: "bg-amber-500",
};

interface AgentTreeNode {
  agent: OmpHubAgent;
  children: AgentTreeNode[];
}

function agentTree(agents: OmpHubAgent[]): AgentTreeNode[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, OmpHubAgent[]>();
  for (const agent of byId.values()) {
    if (!agent.parentId || !byId.has(agent.parentId) || agent.parentId === agent.id) continue;
    const siblings = children.get(agent.parentId) ?? [];
    siblings.push(agent);
    children.set(agent.parentId, siblings);
  }
  const visited = new Set<string>();
  const visit = (agent: OmpHubAgent): AgentTreeNode => {
    visited.add(agent.id);
    const nested: AgentTreeNode[] = [];
    for (const child of children.get(agent.id) ?? []) {
      if (!visited.has(child.id)) nested.push(visit(child));
    }
    return { agent, children: nested };
  };
  const roots: AgentTreeNode[] = [];
  for (const agent of byId.values()) {
    if (!agent.parentId || !byId.has(agent.parentId) || agent.parentId === agent.id) {
      roots.push(visit(agent));
    }
  }
  // Malformed parent cycles must not hide otherwise valid roster entries.
  for (const agent of byId.values()) {
    if (!visited.has(agent.id)) roots.push(visit(agent));
  }
  return roots;
}

export function OmpHubPanel(props: PluginThreadPanelProps) {
  const sdk = useSdk();
  const [attempt, setAttempt] = useState(0);
  const [thread, setThread] = useState<{
    id: string;
    providerId: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void sdk.threads.get({ threadId: props.threadId, signal: controller.signal }).then(
      (result) => {
        if (!disposed) setThread({ id: props.threadId, providerId: result.providerId, error: null });
      },
      (cause: unknown) => {
        if (!disposed) {
          setThread({
            id: props.threadId,
            providerId: null,
            error: cause instanceof Error ? cause.message : "Could not load this thread.",
          });
        }
      },
    );
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [sdk, props.threadId, attempt]);

  if (!thread || thread.id !== props.threadId) {
    return <p role="status" className="text-xs text-muted-foreground">Loading omp Hub…</p>;
  }
  if (thread.error) {
    return (
      <div className="space-y-3 text-xs">
        <p role="alert" className="break-words text-destructive">{thread.error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
      </div>
    );
  }
  if (thread.providerId !== "omp") {
    return <p className="text-xs text-muted-foreground">omp Hub is available for omp-provider threads.</p>;
  }
  return <ThreadHub key={props.threadId} {...props} />;
}

function ThreadHub({ threadId, params }: PluginThreadPanelProps) {
  const roster = useLatestExtensionState(threadId, OMP_AGENTS_STATE_KIND, ompAgentsStateSchema);
  const [selectedId, selectAgent] = useHubSelection(threadId, params);
  const agents = roster?.agents ?? [];
  const tree = useMemo(() => agentTree(agents), [roster]);
  const selected = agents.find((agent) => agent.id === selectedId);
  const counts = { running: 0, finished: 0, failed: 0, pending: 0 };
  for (const agent of agents) {
    if (agent.status === "running") counts.running++;
    else if (agent.status === "pending") counts.pending++;
    else if (agent.status === "failed") counts.failed++;
    else counts.finished++;
  }

  return (
    <div className="min-w-0 space-y-5 text-foreground">
      <section aria-label="Agents" className="min-w-0 space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Agents</h2>
          <p aria-label="Agent counts" className="text-xs text-muted-foreground">
            {counts.running} running · {counts.finished} finished · {counts.failed} failed
            {counts.pending > 0 ? ` · ${counts.pending} pending` : ""}
          </p>
        </div>
        {selectedId ? (
          <>
            <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => selectAgent(undefined)}>
              <Icon name="ArrowLeft" className="size-3" />
              All agents
            </Button>
            {selected ? (
              <div className="min-w-0 space-y-4">
                <AgentSummary agent={selected} />
                <AgentConversation key={selected.id} threadId={threadId} agent={selected} />
              </div>
            ) : (
              <p className="break-words text-xs text-muted-foreground">
                Agent {selectedId} is not in the latest roster. It may not have started yet or may be older than the retained agents.
              </p>
            )}
          </>
        ) : agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No subagents have been delegated in this thread.</p>
        ) : (
          <AgentTree threadId={threadId} nodes={tree} onSelect={selectAgent} />
        )}
        {roster?.truncated ? (
          <p className="text-xs text-muted-foreground">Showing the newest {OMP_AGENTS_ROSTER_LIMIT} agents.</p>
        ) : null}
      </section>
      <OmpServices threadId={threadId} />
    </div>
  );
}

function AgentTree({ threadId, nodes, onSelect }: { threadId: string; nodes: AgentTreeNode[]; onSelect: (id: string) => void }) {
  return (
    <ul className="min-w-0 space-y-2">
      {nodes.map(({ agent, children }) => (
        <li key={agent.id} className="min-w-0 space-y-2">
          <button
            type="button"
            aria-label={`View agent ${agent.id}`}
            className="w-full min-w-0 cursor-pointer rounded-md border border-border bg-surface-raised p-3 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => onSelect(agent.id)}
          >
            <AgentSummary agent={agent} />
          </button>
          <AgentControls threadId={threadId} agent={agent} />
          {children.length > 0 ? (
            <div className="ml-2 min-w-0 border-l border-border pl-2">
              <AgentTree threadId={threadId} nodes={children} onSelect={onSelect} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AgentSummary({ agent }: { agent: OmpHubAgent }) {
  const seconds = agent.durationMs === undefined ? null : Math.floor(agent.durationMs / 1000);
  const duration = seconds === null
    ? null
    : seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return (
    <div className="min-w-0 space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${STATUS_DOT[agent.status]}`} />
        <h3 className="min-w-0 break-all font-medium">{agent.id}</h3>
        <span className="text-[10px] text-muted-foreground">{agent.status}</span>
      </div>
      {agent.description ? <p className="whitespace-pre-wrap break-words">{agent.description}</p> : null}
      <p className="break-words text-muted-foreground">
        {agent.model ?? "Model not reported"}{agent.modelRole ? ` (${agent.modelRole})` : ""}
        {` · ${agent.agent}`}{agent.detached ? " · detached" : ""}
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {agent.cost !== undefined ? <span>${agent.cost.toFixed(4)}</span> : null}
        {agent.tokens !== undefined ? <span>{agent.tokens.toLocaleString()} tokens</span> : null}
        {agent.toolCount !== undefined ? <span>{agent.toolCount} tools</span> : null}
        {duration !== null ? <span>{duration}</span> : null}
      </p>
      {agent.status === "running" && (agent.currentTool || agent.intent) ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {agent.currentTool ? <span className="font-mono">{agent.currentTool}</span> : null}
          {agent.currentTool && agent.intent ? " — " : ""}{agent.intent}
        </p>
      ) : null}
      {agent.retry ? <p className="text-muted-foreground">Retry {agent.retry.attempt}/{agent.retry.maxAttempts}</p> : null}
      {agent.error ? <p className="whitespace-pre-wrap break-words text-destructive">{agent.error}</p> : null}
    </div>
  );
}
