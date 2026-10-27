// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PersistentResponsiveDrawerShell } from "../components/ui/responsive-overlay";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the drawer above a shrinking and panning visual viewport, then restores it", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 800);
  const { rerender } = render(<PersistentResponsiveDrawerShell open onOpenChange={() => {}}><textarea aria-label="Message" /></PersistentResponsiveDrawerShell>);
  const panel = document.querySelector<HTMLElement>("[data-persistent-drawer-content]")!;
  expect(panel.style.bottom).toBe("0px");
  act(() => { viewport.height = 350; viewport.offsetTop = 50; viewport.dispatchEvent(new Event("resize")); });
  await waitFor(() => expect(panel.style.bottom).toBe("400px"));
  expect(Number.parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(350);
  act(() => { viewport.offsetTop = 100; viewport.dispatchEvent(new Event("scroll")); });
  await waitFor(() => expect(panel.style.bottom).toBe("350px"));
  act(() => { viewport.height = 800; viewport.offsetTop = 0; viewport.dispatchEvent(new Event("resize")); });
  await waitFor(() => expect(panel.style.bottom).toBe("0px"));
  expect(Number.parseFloat(panel.style.maxHeight)).toBe(736);
  rerender(<PersistentResponsiveDrawerShell open={false} onOpenChange={() => {}}><textarea aria-label="Message" /></PersistentResponsiveDrawerShell>);
  expect(panel.style.bottom).toBe("");
  expect(panel.style.maxHeight).toBe("");
});
