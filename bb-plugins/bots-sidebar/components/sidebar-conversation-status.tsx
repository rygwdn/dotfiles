import {
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ConversationStatusIcon } from "./conversation-status-icon";
import { isWorking } from "../lib/conversations";

export function SidebarConversationStatus({ thread }: { thread: PluginSidebarThread }) {
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  // Keep BB's precedence for work/errors/input while allowing other plugins'
  // row statuses and this client's unsent draft to appear in our custom list.
  const indicator = thread.hasPendingInteraction ? "waiting-for-input"
    : isWorking(thread) ? (hasUnsubmittedDraft ? "working-draft" : "runtime")
    : thread.indicator === "unread-error" ? thread.indicator
    : hasUnsubmittedDraft ? "draft" : thread.indicator;
  if (rowStatus || hasUnsubmittedDraft || indicator === "queued-waiting" || indicator === "queued-failed") {
    return <ThreadStatusGlyph indicator={indicator} rowStatus={rowStatus} size="compact" />;
  }
  // Preserve the approved green-unread / gray-read completion dots.
  return <ConversationStatusIcon thread={thread} />;
}
