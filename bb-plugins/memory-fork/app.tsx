import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import type { memoryRpcContract } from "./server.js";
import { isMemoryKind, MEMORY_KINDS } from "./memory-kinds.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type MemoryRecord = PluginRpcResult<
  (typeof memoryRpcContract)["listMemories"]
>["memories"][number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MemoryEditor({
  memory,
  onCancel,
  onSaved,
}: {
  memory: MemoryRecord;
  onCancel: () => void;
  onSaved: (memory: MemoryRecord) => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [draft, setDraft] = useState(memory);
  const [tags, setTags] = useState(memory.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="@container/memory-editor space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="grid gap-3 @min-[36rem]/memory-editor:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Summary
          <Input
            aria-label="Memory summary"
            value={draft.summary}
            maxLength={400}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Tags
          <Input
            aria-label="Memory tags"
            value={tags}
            placeholder="comma, separated"
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Details
        <Textarea
          aria-label="Memory details"
          value={draft.details}
          maxLength={16_000}
          className="min-h-28 resize-y text-sm"
          onChange={(event) =>
            setDraft({ ...draft, details: event.target.value })
          }
        />
      </label>
      <div className="grid gap-3 @min-[32rem]/memory-editor:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Kind
          <select
            aria-label="Memory kind"
            value={draft.kind}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={(event) => {
              if (isMemoryKind(event.target.value)) {
                setDraft({ ...draft, kind: event.target.value });
              }
            }}
          >
            {MEMORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Importance
          <Input
            aria-label="Memory importance"
            type="number"
            min={0}
            max={100}
            value={draft.importance}
            onChange={(event) =>
              setDraft({ ...draft, importance: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <Switch
            aria-label="Pinned memory"
            checked={draft.pinned}
            onCheckedChange={(pinned) => setDraft({ ...draft, pinned })}
          />
          Pinned
        </label>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            void rpc
              .call("updateMemory", {
                id: draft.id,
                expectedVersion: draft.version,
                summary: draft.summary,
                details: draft.details,
                kind: draft.kind,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                importance: draft.importance,
                pinned: draft.pinned,
              })
              .then((result) => result.memory)
              .then(onSaved)
              .catch((saveError: unknown) => setError(errorMessage(saveError)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function MemorySettings() {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMemories((await rpc.call("listMemories")).memories);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading memories…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        Durable memory is shared across BB providers. Imported records require
        review before their current correctness is established.
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {memories.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No memories stored yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full table-fixed text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-auto px-3 py-2 font-medium">Memory</th>
                <th className="w-24 px-3 py-2 font-medium">Scope</th>
                <th className="w-28 px-3 py-2 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {memories.map((memory) => (
                <Fragment key={memory.id}>
                  <tr className="align-top">
                    <td className="min-w-0 px-3 py-3">
                      <div className="truncate font-medium text-foreground">
                        {memory.pinned ? "📌 " : ""}
                        {memory.name}
                      </div>
                      <div className="mt-1 line-clamp-2 break-words text-muted-foreground">
                        {memory.summary}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{memory.kind}</span>
                        <span>importance {memory.importance}</span>
                        <span>
                          updated{" "}
                          {new Date(memory.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <div>{memory.scope}</div>
                      {memory.projectId ? (
                        <div
                          className="mt-1 max-w-36 truncate text-xs"
                          title={memory.projectId}
                        >
                          {memory.projectId}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setEditingId((current) =>
                              current === memory.id ? null : memory.id,
                            )
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={deletingId === memory.id}
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            if (
                              !window.confirm(`Delete memory “${memory.name}”?`)
                            ) {
                              return;
                            }
                            setDeletingId(memory.id);
                            setError(null);
                            void rpc
                              .call("deleteMemory", {
                                id: memory.id,
                                expectedVersion: memory.version,
                              })
                              .then(() => {
                                setMemories((current) =>
                                  current.filter(
                                    (entry) => entry.id !== memory.id,
                                  ),
                                );
                                setEditingId((current) =>
                                  current === memory.id ? null : current,
                                );
                              })
                              .catch((deleteError: unknown) =>
                                setError(errorMessage(deleteError)),
                              )
                              .finally(() => setDeletingId(null));
                          }}
                        >
                          {deletingId === memory.id ? "Deleting…" : "Delete"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {editingId === memory.id ? (
                    <tr>
                      <td colSpan={3} className="bg-muted/10 p-3">
                        <MemoryEditor
                          memory={memory}
                          onCancel={() => setEditingId(null)}
                          onSaved={(updated) => {
                            setMemories((current) =>
                              current.map((entry) =>
                                entry.id === updated.id ? updated : entry,
                              ),
                            );
                            setEditingId(null);
                          }}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type ProposalRecord = PluginRpcResult<
  (typeof memoryRpcContract)["listProposals"]
>["proposals"][number];

type DreamsStatus = PluginRpcResult<(typeof memoryRpcContract)["dreamsStatus"]>;

const PROPOSAL_STATUS_OPTIONS = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "applied",
  "rolled_back",
  "all",
] as const;

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded border border-border bg-background/50 text-xs">
      <summary className="cursor-pointer px-2 py-1 text-muted-foreground">
        {label}
      </summary>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-2 pb-2">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function AgentCorrectionEvidence({ evidence }: { evidence: unknown }) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [source, setSource] = useState<MemoryRecord | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  if (!evidence || typeof evidence !== "object" || !("source" in evidence) ||
      evidence.source !== "agent-correction" || !("sourceMemory" in evidence)) return null;
  const target = evidence.sourceMemory;
  if (!target || typeof target !== "object" || !("id" in target) ||
      typeof target.id !== "string" || !("version" in target) || typeof target.version !== "number") return null;
  const wrongOnly = "intent" in evidence && evidence.intent === "wrong-only-report";
  return (
    <div className="mt-2 space-y-2 rounded border border-border p-2 text-xs">
      <p>Agent-proposed correction · requires review</p>
      <p>{wrongOnly
        ? "Wrong-only report: no replacement supplied. Approving retirement accepts removal of the record; the report alone does not establish that it is wrong."
        : "Explicit replacement proposed. The source stays unchanged until approval and apply."}</p>
      {"reason" in evidence && typeof evidence.reason === "string" ? <p>Report reason: {evidence.reason}</p> : null}
      <Button variant="ghost" size="sm" onClick={() => {
        setOpened(!opened);
        if (opened) return;
        setMessage("Loading source…");
        void rpc.call("listMemories").then(({ memories }) => {
          const memory = memories.find(entry => entry.id === target.id) ?? null;
          setSource(memory);
          setMessage(memory ? null : "Source is no longer active. Original ID and expected version remain in the proposal evidence.");
        }).catch((error: unknown) => setMessage(errorMessage(error)));
      }}>
        {opened ? "Hide" : "View"} source {target.id} v{target.version}
      </Button>
      {opened && message ? <p role="status">{message}</p> : null}
      {opened && source ? <div>
        <p>{source.name} · current v{source.version} · {source.scope}</p>
        <p>{source.summary}</p>
        <pre className="whitespace-pre-wrap break-words">{source.details}</pre>
      </div> : null}
    </div>
  );
}

function ProposalRow({
  proposal,
  onDecided,
}: {
  proposal: ProposalRecord;
  onDecided: () => void;
}) {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (method: "decideProposal" | "applyProposal" | "rollbackProposal", input: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    void rpc
      .call(method, input as never)
      .then(onDecided)
      .catch((actError: unknown) => setError(errorMessage(actError)))
      .finally(() => setBusy(false));
  };

  const decide = (decision: "approved" | "rejected" | "cancelled") => {
    if (reason.trim() === "") {
      setError("A reason is required for a decision.");
      return;
    }
    act("decideProposal", { id: proposal.id, decision, reason: reason.trim() });
  };

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">
            {proposal.action} · {proposal.id}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>targets {proposal.targetIds.join(", ")}</span>
            <span>status {proposal.status}</span>
            {proposal.runId ? <span>run {proposal.runId}</span> : null}
            <span>created {new Date(proposal.createdAt).toLocaleString()}</span>
            {proposal.decidedAt ? (
              <span>decided {new Date(proposal.decidedAt).toLocaleString()}</span>
            ) : null}
            {proposal.decisionReason ? (
              <span>reason: {proposal.decisionReason}</span>
            ) : null}
          </div>
        </div>
      </div>
      <AgentCorrectionEvidence evidence={proposal.evidence} />
      <div className="mt-2 space-y-1">
        <JsonBlock label="Payload" value={proposal.payload} />
        <JsonBlock label="Evidence" value={proposal.evidence} />
      </div>
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {proposal.status === "pending" ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label="Decision reason"
            placeholder="Reason (required)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-16 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-destructive hover:text-destructive"
              onClick={() => decide("rejected")}
            >
              Reject
            </Button>
            <Button size="sm" disabled={busy} onClick={() => decide("approved")}>
              Approve
            </Button>
          </div>
        </div>
      ) : null}
      {proposal.status === "approved" ? (
        <div className="mt-2 space-y-2">
          <Textarea aria-label="Cancellation reason" placeholder="Cancellation reason (required)"
            value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => decide("cancelled")}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => act("applyProposal", { id: proposal.id })}
          >
            Apply
          </Button>
          </div>
        </div>
      ) : null}
      {proposal.status === "applied" ? (
        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            className="text-destructive hover:text-destructive"
            onClick={() => act("rollbackProposal", { id: proposal.id })}
          >
            Rollback
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProposalsReview() {
  const rpc = useRpc<typeof memoryRpcContract>();
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [statusFilter, setStatusFilter] =
    useState<(typeof PROPOSAL_STATUS_OPTIONS)[number]>("pending");
  const [dreams, setDreams] = useState<DreamsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedStatus = useRef(statusFilter);
  selectedStatus.current = statusFilter;
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    setLoading(true);
    setError(null);
    try {
      const [list, status] = await Promise.all([
        rpc.call("listProposals", { status: selectedStatus.current }),
        rpc.call("dreamsStatus", null),
      ]);
      if (request !== latestLoad.current) return;
      setProposals(list.proposals);
      setDreams(status);
    } catch (loadError) {
      if (request === latestLoad.current) setError(errorMessage(loadError));
    } finally {
      if (request === latestLoad.current) setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load, statusFilter]);

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        {dreams?.lastRun
          ? `Last dream run: ${String(dreams.lastRun.run_id)} ${String(dreams.lastRun.status)} at ${new Date(Number(dreams.lastRun.started_at)).toLocaleString()} · `
          : "No dream runs yet · "}
        {Object.entries(dreams?.proposalCounts ?? {})
          .map(([key, count]) => `${key}=${count}`)
          .join(" ") || "no proposals"}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="proposal-status-filter" className="text-muted-foreground">
          Status
        </label>
        <select
          id="proposal-status-filter"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as (typeof PROPOSAL_STATUS_OPTIONS)[number])
          }
        >
          {PROPOSAL_STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading proposals…</p>
      ) : proposals.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No proposals with this status.
        </div>
      ) : (
        proposals.map((proposal) => (
          <ProposalRow key={proposal.id} proposal={proposal} onDecided={load} />
        ))
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "memory",
    title: "Memory",
    description:
      "Review and manage provider-independent global and project memories.",
    component: MemorySettings,
  });
  app.slots.settingsSection({
    id: "memory-proposals",
    title: "Proposals & dreams",
    description:
      "Review pending memory proposals from agents and dream runs; approve, reject, cancel, apply, or roll back.",
    component: ProposalsReview,
  });
});
