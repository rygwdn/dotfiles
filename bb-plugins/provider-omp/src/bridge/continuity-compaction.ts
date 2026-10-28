import { z } from "zod";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

// Versioned wire message from Continuity's committed session_compact hook.
// No transcript or summary crosses this boundary. These notifications are not
// replayed on session resume: BB replays its own durable timeline events.
const PREFIX = "bb-continuity.compacted.v1:";
const commitSchema = z.object({
  sessionId: z.string().min(1).max(200),
  entryId: z.string().min(1).max(200),
  timestamp: z.iso.datetime({ offset: true }),
  trigger: z.enum(["requested", "idle"]),
}).strict();

export function continuityCompactionDeltas(message: string): ThreadDelta[] | null {
  if (!message.startsWith(PREFIX) || message.length > 2048) return null;
  let input: unknown;
  try { input = JSON.parse(message.slice(PREFIX.length)); } catch { return null; }
  const parsed = commitSchema.safeParse(input);
  if (!parsed.success) return null;
  const commit = parsed.data;
  const identity = `continuity:${JSON.stringify([commit.sessionId, commit.entryId])}`;
  // A dedicated turn gives each real commit its own native boundary, including
  // multiple compactions between user turns. Never settle a user/provider turn.
  return [
    { kind: "turn.open", providerTurnId: identity },
    {
      kind: "item.close", providerTurnId: identity,
      key: { providerItemId: identity, channel: "compaction" },
      item: { type: "compaction" }, status: "completed",
      presentation: {
        label: { pending: "Continuity compaction", completed: "Continuity compaction" },
        icon: { glyph: "Layers" }, title: "Context compacted",
        detail: `Continuity ${commit.trigger === "idle" ? "automatic idle" : "requested"} compaction committed at ${commit.timestamp}`,
      },
    },
    { kind: "context.compacted", providerTurnId: identity },
    { kind: "turn.boundary", providerTurnId: identity, status: "completed" },
  ];
}
