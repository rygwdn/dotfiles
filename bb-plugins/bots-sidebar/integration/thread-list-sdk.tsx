import { createContext, useContext, useMemo, type PointerEvent } from "react";
import {
  experimental_useSidebarThreads as useHostSidebarThreads,
  experimental_useSidebarThreadSplit as useHostSidebarThreadSplit,
  experimental_ThreadActionsMenu as HostThreadActionsMenu,
  experimental_ThreadActionsContextMenu as HostThreadActionsContextMenu,
  experimental_THREAD_ACTION_GROUPS,
  type PluginThreadActionsMenuProps,
  type PluginThreadActionsContextMenuProps,
  type PluginThreadActionsInlineItem,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { conversationOwners } from "../lib/conversations";

export * from "@get-bb/plugin-sdk/app";

type BotThreadListBridge = {
  bindings: readonly { threadId: string; botId: string }[];
  onAssign: (threadId: string) => void;
  onAssignmentDrag: (thread: PluginSidebarThread, event: PointerEvent<HTMLElement>) => void;
};
export const BotThreadListContext = createContext<BotThreadListBridge | null>(null);

export function experimental_useSidebarThreads(...args: Parameters<typeof useHostSidebarThreads>) {
  const state = useHostSidebarThreads(...args);
  const bridge = useContext(BotThreadListContext);
  return useMemo(() => {
    if (!bridge) return state;
    const owners = conversationOwners(state.threads, bridge.bindings);
    return { ...state, threads: state.threads.filter(thread => !owners.has(thread.id)) };
  }, [state, bridge?.bindings]);
}

// Normal drags stay native (reorder/nest/split). Alt-drag deliberately opts
// into the bot plugin's assignment gesture, without competing dnd sensors.
export function experimental_useSidebarThreadSplit(threadId: string) {
  const split = useHostSidebarThreadSplit(threadId);
  const bridge = useContext(BotThreadListContext);
  const { threads } = useHostSidebarThreads();
  return useMemo(() => ({
    ...split,
    splitProps: {
      ...split.splitProps,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const thread = bridge && event.altKey && event.button === 0 && event.pointerType !== "touch"
          ? threads.find(row => row.id === threadId) : undefined;
        if (thread && bridge) {
          event.preventDefault();
          event.stopPropagation();
          bridge.onAssignmentDrag(thread, event);
        } else {
          split.splitProps.onPointerDown?.(event);
        }
      },
    },
  }), [split, bridge, threads, threadId]);
}

function useAssignmentItems(threadId: string, inline: readonly PluginThreadActionsInlineItem[] | undefined) {
  const bridge = useContext(BotThreadListContext);
  return useMemo(() => bridge ? [...(inline ?? []), {
    key: "bots-sidebar/assign-conversation",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    action: { label: "Assign to bot…", icon: "Bot", run: () => bridge.onAssign(threadId) },
  } satisfies PluginThreadActionsInlineItem] : inline, [bridge, threadId, inline]);
}

export function experimental_ThreadActionsMenu(props: PluginThreadActionsMenuProps) {
  const inline = useAssignmentItems(props.thread.id, props.inline);
  return <HostThreadActionsMenu {...props} inline={inline} />;
}

export function experimental_ThreadActionsContextMenu(props: PluginThreadActionsContextMenuProps) {
  const inline = useAssignmentItems(props.thread.id, props.inline);
  return <HostThreadActionsContextMenu {...props} inline={inline} />;
}
