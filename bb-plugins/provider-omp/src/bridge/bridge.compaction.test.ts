import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const THREAD_ID = "thr_compactnoop";

let harness: FakeOmpBridgeHarness;
let providerThreadId: string;
let nextId = 1000;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-compaction-",
    initialize: true,
  });
  vi.stubEnv("FAKE_OMP_EVENT_LOG", join(harness.workspaceDir, "events.jsonl"));
  vi.stubEnv("FAKE_OMP_RPC_LOG", join(harness.workspaceDir, "rpc.jsonl"));
  const started = await harness.startThread(THREAD_ID);
  expect(started.error).toBeUndefined();
  const result = started.result as { providerThreadId?: unknown };
  if (typeof result.providerThreadId !== "string") {
    throw new Error("Missing OMP provider thread identity");
  }
  providerThreadId = result.providerThreadId;
});

afterEach(async () => {
  await harness.teardown();
});

function readWireLog(name: string): Record<string, unknown>[] {
  return readFileSync(join(harness.workspaceDir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function compact(clientRequestId: string): Promise<Record<string, unknown>[]> {
  const since = harness.deltasOf(THREAD_ID).length;
  const response = await harness.request(++nextId, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId,
    input: [
      {
        type: "text",
        text: "/compact",
        mentions: [
          {
            start: 0,
            end: 8,
            resource: {
              kind: "command",
              trigger: "/",
              name: "compact",
              source: "command",
              origin: "builtin",
              label: "compact",
              argumentHint: null,
            },
          },
        ],
      },
    ],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error).toBeUndefined();
  await harness.waitFor(
    () =>
      harness.deltasOf(THREAD_ID).slice(since)
        .filter((delta) => delta.kind === "turn.boundary").length >= 1,
    "the host-synthetic compaction boundary",
  );
  return harness.deltasOf(THREAD_ID).slice(since);
}

function expectNativeManualCommandOnly(): void {
  expect(
    readWireLog("rpc.jsonl").filter((command) => command.type === "compact"),
  ).toHaveLength(1);
  expect(
    readWireLog("events.jsonl").filter((event) =>
      [
        "compaction_start", "compaction_end",
        "bb_compaction_start", "bb_compaction_end",
        "auto_compaction_start", "auto_compaction_end",
      ].includes(String(event.type)),
    ),
  ).toEqual([]);
}

it("delivers a skipped warning before completing refused host-synthetic manual compaction", async () => {
  const deltas = await compact("creq_cmpctnpabc");
  const kinds = deltas.map((delta) =>
    delta.kind === "turn.boundary"
      ? `turn.boundary:${String(delta.status)}`
      : String(delta.kind),
  );
  expect(deltas).toContainEqual(
    expect.objectContaining({
      kind: "provider.warning",
      category: "compaction-skipped",
    }),
  );
  expect(kinds.indexOf("provider.warning")).toBeLessThan(
    kinds.indexOf("turn.boundary:completed"),
  );
  expect(kinds.filter((kind) => kind.startsWith("turn.boundary"))).toEqual([
    "turn.boundary:completed",
  ]);
  expect(deltas.some((delta) => delta.kind === "context.compacted")).toBe(false);
  expectNativeManualCommandOnly();
  expect(
    readWireLog("rpc.jsonl").filter((command) => command.type === "prompt"),
  ).toEqual([]);
}, 30_000);

it("completes host-synthetic manual compaction from the native command result", async () => {
  const seeded = await harness.request(++nextId, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_cmpctseed2",
    input: [{ type: "text", text: "seed some history", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(seeded.error).toBeUndefined();
  await harness.waitForTurnBoundary(THREAD_ID);
  const deltas = await compact("creq_cmpctsucab");
  expect(deltas).toContainEqual(
    expect.objectContaining({
      kind: "item.open",
      item: expect.objectContaining({ type: "compaction" }),
    }),
  );
  expect(deltas.filter((delta) => delta.kind === "context.compacted")).toHaveLength(1);
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "completed" }),
  ]);
  expect(
    deltas.filter((delta) =>
      ["provider.warning", "provider.error"].includes(String(delta.kind)),
    ),
  ).toEqual([]);
  const compacted = deltas.findIndex((delta) => delta.kind === "context.compacted");
  const lastBoundary = deltas.findLastIndex((delta) => delta.kind === "turn.boundary");
  expect(compacted).toBeLessThan(lastBoundary);
  expectNativeManualCommandOnly();
  expect(
    readWireLog("rpc.jsonl").filter((command) => command.type === "prompt"),
  ).toHaveLength(1);
}, 30_000);
