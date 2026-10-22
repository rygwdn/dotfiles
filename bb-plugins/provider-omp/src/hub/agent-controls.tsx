import { useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { OmpHubAgent } from "../hub-contract.js";

export function AgentControls({ threadId, agent }: { threadId: string; agent: OmpHubAgent }) {
  return agent.status === "running"
    ? <RunningAgentControls key={`${threadId}:${agent.id}`} threadId={threadId} agentId={agent.id} />
    : null;
}

function RunningAgentControls({ threadId, agentId }: { threadId: string; agentId: string }) {
  const sdk = useSdk();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"cancel" | "steer" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationPending = useRef(false);

  const send = async (action: "cancel" | "steer") => {
    const text = message.trim();
    if (operationPending.current || (action === "steer" && !text)) return;
    operationPending.current = true;
    setPending(action);
    setError(null);
    try {
      await sdk.threads.send({
        threadId,
        mode: "steer-if-active",
        input: [{
          type: "text",
          text: `/omp-agent ${action} ${agentId}${action === "steer" ? ` ${text}` : ""}`,
          mentions: [],
        }],
      });
      if (action === "steer") setMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the agent command.");
    } finally {
      operationPending.current = false;
      setPending(null);
    }
  };

  return (
    <div role="group" aria-label={`Controls for agent ${agentId}`} className="min-w-0 space-y-2">
      <form
        aria-label={`Steer agent ${agentId}`}
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send("steer");
        }}
      >
        <input
          type="text"
          aria-label={`Message to agent ${agentId}`}
          placeholder="Steer this agent…"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          value={message}
          disabled={pending !== null}
          onChange={(event) => setMessage(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" aria-label={`Steer agent ${agentId}`} disabled={pending !== null || !message.trim()}>
          {pending === "steer" ? "Sending…" : "Steer"}
        </Button>
        <Button type="button" variant="outline" size="sm" aria-label={`Cancel agent ${agentId}`} disabled={pending !== null} onClick={() => void send("cancel")}>
          {pending === "cancel" ? "Sending…" : "Cancel"}
        </Button>
      </form>
      {error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
