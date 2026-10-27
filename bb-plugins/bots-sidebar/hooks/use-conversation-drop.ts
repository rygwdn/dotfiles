import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

type DragState = { threadId: string; title: string; botId: string | null; shiftKey: boolean };

/** Pointer-based so BB's drag-to-split can still take over outside the sidebar. */
export function useConversationDrop(onDrop: (thread: PluginSidebarThread, botId: string, shiftKey: boolean) => void, canDrop: (botId: string) => boolean,
  getTarget?: (thread: PluginSidebarThread, element: Element, x: number, y: number, shiftKey: boolean) => string | null) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const position = useRef({ x: 0, y: 0 });
  const cancel = useRef<(() => void) | null>(null);
  const clickCleanup = useRef<(() => void) | null>(null);
  const releaseCleanup = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onDrop, canDrop, getTarget });
  callbacks.current = { onDrop, canDrop, getTarget };
  useEffect(() => () => { cancel.current?.(); clickCleanup.current?.(); releaseCleanup.current?.(); }, []);

  function swallowClick() {
    clickCleanup.current?.();
    const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); clear(); };
    const timer = setTimeout(clear, 0);
    function clear() { clearTimeout(timer); window.removeEventListener("click", swallow, true); clickCleanup.current = null; }
    window.addEventListener("click", swallow, true);
    clickCleanup.current = clear;
  }
  function guardCancelledRelease(pointerId: number) {
    releaseCleanup.current?.();
    const up = (event: PointerEvent) => { if (event.pointerId === pointerId) { clear(); swallowClick(); } };
    function clear() { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", clear); window.removeEventListener("blur", clear); releaseCleanup.current = null; }
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    releaseCleanup.current = clear;
  }
  function moveGhost() { if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${position.current.x + 12}px, ${position.current.y + 12}px, 0)`; }
  useEffect(moveGhost, [drag]);

  function begin(thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const sidebar = event.currentTarget.closest(".bots-sidebar");
    if (!sidebar) return;
    cancel.current?.(); releaseCleanup.current?.();
    // Touch engages by long-press instead of a movement threshold so ordinary
    // scrolling keeps working; while engaged, touchmove is blocked.
    const touch = event.pointerType === "touch";
    const start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    let engaged = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let targetId: string | null = null;
    let ended = false;
    let shiftKey = event.shiftKey;
    const title = thread.title ?? thread.titleFallback ?? "Untitled conversation";
    function blockScroll(move: TouchEvent) { if (engaged) move.preventDefault(); }
    function engage() {
      if (engaged || ended) return;
      engaged = true;
      holdTimer = null;
      position.current = { x: start.x, y: start.y };
      targetId = targetAt(start.x, start.y, shiftKey);
      setDrag({ threadId: thread.id, title, botId: targetId, shiftKey });
    }
    function targetAt(x: number, y: number, shiftKey = false) {
      const element = document.elementFromPoint(x, y);
      if (!element || !sidebar!.contains(element)) return null;
      if (callbacks.current.getTarget) return callbacks.current.getTarget(thread, element, x, y, shiftKey);
      const target = element.closest<HTMLElement>("[data-bot-drop-target]");
      const id = target?.dataset.botDropTarget;
      return target && sidebar!.contains(target) && id && callbacks.current.canDrop(id) ? id : null;
    }
    function cleanup() {
      if (ended) return; ended = true;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("blur", cancelled);
      window.removeEventListener("touchmove", blockScroll);
      document.removeEventListener("keydown", key);
      document.removeEventListener("keyup", key);
      cancel.current = null; setDrag(null);
    }
    function cancelled() { cleanup(); }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") { if (engaged) guardCancelledRelease(start.pointerId); cleanup(); }
      else if (event.key === "Shift" && engaged) {
        shiftKey = event.shiftKey;
        targetId = targetAt(position.current.x, position.current.y, shiftKey);
        setDrag({ threadId: thread.id, title, botId: targetId, shiftKey });
      }
    }
    function move(event: PointerEvent) {
      if (ended || event.pointerId !== start.pointerId) return;
      if (!(event.buttons & 1)) { cancelled(); return; }
      if (!engaged) {
        const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (touch) {
          // Scrolling: cancel the pending hold instead of starting a drag.
          if (distance > 8 && holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          return;
        }
        if (distance < 6) return;
      }
      const first = !engaged; engaged = true;
      event.preventDefault(); position.current = { x: event.clientX, y: event.clientY }; moveGhost();
      const next = targetAt(event.clientX, event.clientY, event.shiftKey);
      if (first || next !== targetId || shiftKey !== event.shiftKey) { shiftKey = event.shiftKey; targetId = next; setDrag({ threadId: thread.id, title, botId: next, shiftKey }); }
    }
    function up(event: PointerEvent) {
      if (ended || event.pointerId !== start.pointerId) return;
      // If a live update moved another bot under the pointer, require a new
      // hover/highlight rather than assigning to an unseen replacement target.
      const dropped = engaged && targetId && targetAt(event.clientX, event.clientY, event.shiftKey) === targetId ? targetId : null;
      // A long-press that never became a drag was a context-menu request, not
      // a drag pick-up: hand off to the row's context menu at the touch point.
      const stationary = engaged && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8;
      if (engaged) swallowClick(); cleanup();
      if (stationary) {
        document.elementFromPoint(event.clientX, event.clientY)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY }));
        return;
      }
      if (dropped) callbacks.current.onDrop(thread, dropped, event.shiftKey);
    }
    cancel.current = cancelled;
    if (touch) {
      holdTimer = setTimeout(engage, 350);
      window.addEventListener("touchmove", blockScroll, { passive: false });
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelled);
    window.addEventListener("blur", cancelled);
    document.addEventListener("keydown", key);
    document.addEventListener("keyup", key);
  }
  return { drag, ghostRef, begin };
}
