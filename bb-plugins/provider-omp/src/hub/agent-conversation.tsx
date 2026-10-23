import { Fragment, useEffect, useState } from "react";
import { Markdown, useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { OmpHubAgent } from "../hub-contract.js";
import { AgentControls } from "./agent-controls.js";

// Only the public SDK row fields this compact, read-only view displays.
type TranscriptRow =
  | { id: string; kind: "conversation"; role: "assistant" | "user"; text: string }
  | { id: string; kind: "system"; title: string; detail: string | null }
  | { id: string; kind: "turn"; children: TranscriptRow[] | null }
  | {
      id: string;
      kind: "work";
      workKind: string;
      status: string;
      toolName?: string;
      callId?: string;
      output?: string;
      command?: string;
      path?: string | null;
      query?: string;
      url?: string;
      childRows?: TranscriptRow[] | null;
    };

interface TranscriptAnchor {
  turnId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  /** bb's own item id; bb replaces the provider item key when it stores the event. */
  itemId: string;
}

async function findAnchor(
  sdk: PluginBrowserBbSdk,
  threadId: string,
  agentId: string,
  signal: AbortSignal,
): Promise<TranscriptAnchor | null> {
  let beforeSeq: string | undefined;
  while (!signal.aborted) {
    const events = await sdk.threads.events.list({
      threadId,
      types: ["item/started"],
      order: "desc",
      limit: "100",
      beforeSeq,
      signal,
    });
    // Newest first, so a reused agent id resolves to its latest delegation.
    const event = events.find(
      (event) =>
        event.threadId === threadId &&
        event.type === "item/started" &&
        event.data.item.type === "delegation" &&
        event.data.item.childRef === agentId,
    );
    if (event?.type === "item/started" && event.scope.kind === "turn") {
      return {
        turnId: event.scope.turnId,
        sourceSeqStart: event.seq,
        sourceSeqEnd: event.seq,
        itemId: event.data.item.id,
      };
    }
    if (events.length < 100) return null;
    beforeSeq = String(events[events.length - 1]!.seq);
  }
  return null;
}

function findDelegation(
  rows: TranscriptRow[],
  itemId: string,
): Extract<TranscriptRow, { kind: "work" }> | null {
  for (const row of rows) {
    if (row.kind === "work" && row.workKind === "delegation" && row.callId === itemId) {
      return row;
    }
    const children = row.kind === "turn"
      ? row.children
      : row.kind === "work"
        ? row.childRows
        : null;
    const nested = children && findDelegation(children, itemId);
    if (nested) return nested;
  }
  return null;
}

function prependRows(older: TranscriptRow[], newer: TranscriptRow[]): TranscriptRow[] {
  const remaining = new Map(newer.map((row) => [row.id, row]));
  const combined = older.map((row) => {
    const next = remaining.get(row.id);
    if (!next) return row;
    remaining.delete(row.id);
    if (row.kind === "turn" && next.kind === "turn") {
      return { ...next, children: prependRows(row.children ?? [], next.children ?? []) };
    }
    if (row.kind === "work" && next.kind === "work" && row.workKind === "delegation" && next.workKind === "delegation") {
      return { ...next, childRows: prependRows(row.childRows ?? [], next.childRows ?? []) };
    }
    return next;
  });
  return [...combined, ...remaining.values()];
}

interface TranscriptSnapshot {
  rows: TranscriptRow[];
  summary: string;
  olderCursor: string | null;
  loading: boolean;
  error: string | null;
}

export function AgentConversation({ threadId, agent }: { threadId: string; agent: OmpHubAgent }) {
  const sdk = useSdk();
  const [pageCount, setPageCount] = useState(1);
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot>({
    rows: [], summary: "", olderCursor: null, loading: true, error: null,
  });
  const running = agent.status === "pending" || agent.status === "running";

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let revision = 0;
    let anchor: TranscriptAnchor | null = null;
    const refresh = async () => {
      const currentRevision = ++revision;
      setSnapshot((previous) => ({ ...previous, loading: true, error: null }));
      try {
        anchor ??= await findAnchor(sdk, threadId, agent.id, controller.signal);
        if (disposed || currentRevision !== revision) return;
        if (!anchor) {
          setSnapshot({ rows: [], summary: "", olderCursor: null, loading: false, error: null });
          return;
        }
        let rows: TranscriptRow[] = [];
        let summary = "";
        let beforeCursor: string | undefined;
        let olderCursor: string | null = null;
        for (let page = 0; page < pageCount; page++) {
          const details = await sdk.threads.timelineTurnSummaryDetails({
            threadId,
            turnId: anchor.turnId,
            sourceSeqStart: String(anchor.sourceSeqStart),
            sourceSeqEnd: String(anchor.sourceSeqEnd),
            itemId: anchor.itemId,
            deferContent: "false",
            beforeCursor,
            signal: controller.signal,
          });
          if (disposed || currentRevision !== revision) return;
          const delegation = findDelegation(details.rows, anchor.itemId);
          rows = prependRows(delegation?.childRows ?? [], rows);
          summary ||= delegation?.output ?? "";
          olderCursor = details.olderCursor ?? null;
          if (!olderCursor) break;
          beforeCursor = olderCursor;
        }
        setSnapshot({ rows, summary, olderCursor, loading: false, error: null });
      } catch (cause) {
        if (!disposed && currentRevision === revision) {
          setSnapshot((previous) => ({
            ...previous,
            loading: false,
            error: cause instanceof Error ? cause.message : "Could not load this agent’s conversation.",
          }));
        }
      }
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        if (running && (event.id === undefined || event.id === threadId)) void refresh();
      },
    });
    const unsubscribeConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected" && event.reconnected) void refresh();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe();
      unsubscribeConnection();
    };
  }, [sdk, threadId, agent.id, running, pageCount]);

  return (
    <div aria-label={`${agent.id} conversation`} className="min-w-0 space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Read-only conversation</p>
      <AgentControls threadId={threadId} agent={agent} />
      {snapshot.olderCursor ? (
        <Button type="button" variant="outline" size="sm" disabled={snapshot.loading} onClick={() => setPageCount((count) => count + 1)}>
          Load earlier messages
        </Button>
      ) : null}
      {snapshot.error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{snapshot.error}</p> : null}
      {snapshot.loading ? <p role="status" className="text-xs text-muted-foreground">Loading conversation…</p> : null}
      {snapshot.rows.length > 0 ? (
        <TranscriptRows rows={snapshot.rows} />
      ) : snapshot.summary ? (
        <Markdown content={snapshot.summary} className="break-words text-xs" />
      ) : !snapshot.loading && !snapshot.error ? (
        <p className="text-xs text-muted-foreground">
          No persisted messages yet. This agent’s conversation appears after its delegation starts.
        </p>
      ) : null}
    </div>
  );
}

function TranscriptRows({ rows }: { rows: TranscriptRow[] }) {
  return (
    <ol className="min-w-0 space-y-3 text-xs">
      {rows.map((row) => {
        if (row.kind === "turn") {
          return <Fragment key={row.id}>{row.children ? <TranscriptRows rows={row.children} /> : null}</Fragment>;
        }
        if (row.kind === "conversation") {
          return (
            <li key={row.id} className="min-w-0 space-y-1">
              <p className="text-[10px] font-medium uppercase text-muted-foreground">{row.role}</p>
              {row.role === "assistant" ? (
                <Markdown content={row.text} className="min-w-0 break-words text-xs" />
              ) : (
                <p className="whitespace-pre-wrap break-words">{row.text}</p>
              )}
            </li>
          );
        }
        if (row.kind === "system") {
          return (
            <li key={row.id} className="whitespace-pre-wrap break-words text-muted-foreground">
              {row.title}{row.detail ? ` — ${row.detail}` : ""}
            </li>
          );
        }
        return (
          <li key={row.id} className="min-w-0 space-y-2">
            <p className="flex min-w-0 items-baseline justify-between gap-2 rounded border border-border bg-surface-raised px-2 py-1">
              <span className="truncate font-mono">{workLabel(row)}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{row.status}</span>
            </p>
            {row.childRows?.length ? <div className="border-l border-border pl-2"><TranscriptRows rows={row.childRows} /></div> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** What a work row acted on, so a bare "command" or "fileRead" row says which. */
function workLabel(row: Extract<TranscriptRow, { kind: "work" }>): string {
  if (row.workKind === "command" && row.command) return row.command;
  if (row.workKind === "fileRead" && row.path) return `read ${row.path}`;
  if (row.workKind === "search" && row.query) return `search ${row.query}`;
  if (row.workKind === "webFetch" && row.url) return `fetch ${row.url}`;
  return row.toolName ?? row.workKind;
}
