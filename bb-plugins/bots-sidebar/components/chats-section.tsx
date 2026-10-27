import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

// Stable client preference key: intentionally retained after the plugin-ID
// change to bots-sidebar and the merged-list layout so existing collapsed
// state does not reset.
const COLLAPSED_KEY = "bots:chats-collapsed";

function storedCollapsed() {
  try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
}

/**
 * Chats section at the bottom of the single merged sidebar scroll. It flows
 * inline below the pinned Bots group (no fixed height, no resize handle) and
 * keeps only the collapse toggle, the reopen-on-navigation behavior, and the
 * always-available New chat button.
 */
export function ChatsSection({ children, onNewChat, activeChatId }: { children: ReactNode; onNewChat: () => void; activeChatId: string | null }) {
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const contentId = useId();
  const previousActive = useRef(activeChatId);
  useEffect(() => { try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); } catch { /* Optional client preference. */ } }, [collapsed]);
  useEffect(() => {
    if (activeChatId && activeChatId !== previousActive.current) setCollapsed(false);
    previousActive.current = activeChatId;
  }, [activeChatId]);

  return <section className="recent-section mt-2 flex shrink-0 flex-col border-t border-border pt-1">
    <div className="flex shrink-0 items-center justify-between px-1 py-1">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground hover:text-foreground" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed((current) => !current)}>
        <span>Chats</span>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className={collapsed ? "" : "rotate-90"}><path d="m7 5 5 5-5 5" /></svg>
      </button>
      <button type="button" className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground" aria-label="New unconnected chat" onClick={() => { setCollapsed(false); onNewChat(); }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 4v12M4 10h12" /></svg>
      </button>
    </div>
    <div id={contentId} className="min-h-0" hidden={collapsed}>{collapsed ? null : children}</div>
  </section>;
}
