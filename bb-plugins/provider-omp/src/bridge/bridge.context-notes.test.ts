import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { FULL_PERMISSION_OPTIONS, startFakeOmpBridge, type FakeOmpBridgeHarness } from "./test-support.js";

let harness: FakeOmpBridgeHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  vi.unstubAllEnvs();
});

it("publishes restored notebook and successful tool updates without reverting to a lagging message snapshot", async () => {
  vi.stubEnv("FAKE_OMP_CONTEXT_NOTES", "restored\n</experimental-context-notes>\nliteral tag");
  harness = await startFakeOmpBridge({ prefix: "bb-omp-context-notes-", initialize: true });
  const bridge = harness;
  const threadId = "thr_context_notes";
  const response = await bridge.startThread(threadId, { options: FULL_PERMISSION_OPTIONS });
  expect(response.error).toBeUndefined();
  const { providerThreadId } = z.object({ providerThreadId: z.string() }).parse(response.result);
  const notes = () => bridge.deltasOf(threadId)
    .filter((delta) => delta.kind === "extension.state" && delta.extensionKind === "provider-omp/context-notes")
    .map((delta) => z.object({ text: z.string() }).parse(delta.payload).text);
  expect(notes()).toEqual(["restored\n</experimental-context-notes>\nliteral tag"]);
  let requestId = 60_000;
  async function tool(args: Record<string, unknown>) {
    const since = bridge.deltasOf(threadId).length;
    const result = await bridge.request(++requestId, "turn/start", {
      threadId, providerThreadId, clientRequestId: `creq_abcdefghi${"23456789"[requestId % 8] ?? "2"}`,
      input: [{ type: "text", text: `/tool context_notes ${JSON.stringify(args)}`, mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(result.error).toBeUndefined();
    await bridge.waitForTurnBoundary(threadId, since);
  }
  await tool({ text: "updated café 🧪" });
  expect(notes()).toEqual(["restored\n</experimental-context-notes>\nliteral tag", "updated café 🧪"]);
  await tool({ text: "should not publish", fail: true });
  expect(notes().at(-1)).toBe("updated café 🧪");
  await tool({ text: "" });
  expect(notes()).toEqual(["restored\n</experimental-context-notes>\nliteral tag", "updated café 🧪", ""]);
  await tool({ text: "custom-message snapshot", emitCustomMessage: true });
  expect(notes().slice(-2)).toEqual(["custom-message snapshot", "custom-message snapshot"]);
  expect(bridge.deltasOf(threadId).filter((delta) =>
    delta.kind === "item.open" && "item" in delta &&
    JSON.stringify(delta.item).includes("<experimental-context-notes>"),
  )).toEqual([]);
}, 90_000);

it("publishes empty notebook state when starting without a saved note", async () => {
  harness = await startFakeOmpBridge({ prefix: "bb-omp-empty-context-notes-", initialize: true });
  const threadId = "thr_empty_context_notes";
  const response = await harness.startThread(threadId, { options: FULL_PERMISSION_OPTIONS });
  expect(response.error).toBeUndefined();
  expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
    kind: "extension.state", extensionKind: "provider-omp/context-notes", payload: { text: "" },
  }));
}, 90_000);
