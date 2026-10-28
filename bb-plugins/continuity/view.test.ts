import { expect, test } from "bun:test";
import { continuityView, reconcileRequest } from "./view";
import type { RuntimeStatus } from "./schema";

const now = 1_800_000_000_000;
const status: RuntimeStatus = { sessionId: "session-a", updatedAt: now, state: "compacting", reason: "Compacting", demotedResults: 0, reclaimedTokens: 0, estimatedTokens: 50_000, lastCompactedAt: now - 60_000 };

test("saved policy remains visible before launch, after stop, and after lost heartbeats", () => {
  expect(continuityView(true, null, now)).toMatchObject({ enabled: true, phase: null });
  const stopped = continuityView(true, { ...status, state: "stopped" }, now);
  expect(stopped).toMatchObject({ enabled: true, phase: null });
  expect(stopped.label).toContain("OMP stopped");
  expect(continuityView(true, status, now + 15_000)).toMatchObject({ enabled: true, phase: null });
});

test("only a fresh resident runtime can advertise a live operation", () => {
  expect(continuityView(true, status, now).phase?.state).toBe("compacting");
  expect(continuityView(true, { ...status, state: "disabled" }, now).phase).toBeNull();
  expect(continuityView(true, status, now - 1).phase).toBeNull();
  expect(continuityView(false, status, now)).toMatchObject({ enabled: false, phase: null });
});

test("cooldown keeps a request queued, but consumed requests cannot return on a ready heartbeat", () => {
  const requestedAt = now - 1000;
  expect(reconcileRequest(requestedAt, { ...status, state: "deferred" })).toBe(true);
  for (const state of ["compacting", "error", "stopped", "disabled"] as const) {
    expect(reconcileRequest(requestedAt, { ...status, state })).toBe(false);
  }
  expect(reconcileRequest(requestedAt, { ...status, state: "ready", lastCompactedAt: now })).toBe(false);
});

test("older terminal snapshots cannot consume a newer request", () => {
  for (const state of ["compacting", "error", "stopped", "disabled"] as const) {
    expect(reconcileRequest(now + 1000, { ...status, state })).toBe(true);
    expect(reconcileRequest(now + 1000, { ...status, state, updatedAt: now + 2000 })).toBe(false);
  }
});

test("a slow summary stays live through real heartbeats, then stops immediately", () => {
  const later = now + 90_000;
  expect(continuityView(true, { ...status, updatedAt: later }, later).phase?.state).toBe("compacting");
  expect(continuityView(true, { ...status, updatedAt: later, state: "stopped" }, later).phase).toBeNull();
});
