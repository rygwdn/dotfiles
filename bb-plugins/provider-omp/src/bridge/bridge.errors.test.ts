import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { OmpRpcResponseError } from "./rpc-child.js";
import { OmpRpcSession } from "./rpc-session.js";
import { FULL_PERMISSION_OPTIONS, type FakeOmpBridgeHarness, startFakeOmpBridge } from "./test-support.js";

let harness: FakeOmpBridgeHarness;

beforeEach(async () => {
  harness = await startFakeOmpBridge({ prefix: "bb-omp-errors-", initialize: true });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
  vi.restoreAllMocks();
}, 30_000);

it.each(["thread/name/set", "turn/steer"] as const)(
  "preserves native RPC codes in %s error data",
  async (method) => {
    const threadId = "thr_structured_error";
    const started = await harness.startThread(threadId);
    const { providerThreadId } = z.object({ providerThreadId: z.string() }).parse(started.result);
    const error = new OmpRpcResponseError({
      type: "response", success: false, command: "native_command",
      error: "Native operation unavailable", code: "session_busy",
    });
    if (method === "thread/name/set") {
      vi.spyOn(OmpRpcSession.prototype, "setSessionName").mockRejectedValueOnce(error);
    } else {
      vi.spyOn(OmpRpcSession.prototype, "steer").mockRejectedValueOnce(error);
    }
    const response = await harness.request(1, method, {
      threadId,
      providerThreadId,
      ...(method === "thread/name/set" ? { title: "Renamed" } : {
        clientRequestId: "creq_ab23456789",
        expectedTurnId: "turn-1",
        options: FULL_PERMISSION_OPTIONS,
        input: [{ type: "text", text: "Continue", mentions: [] }],
      }),
    });
    expect(response.error).toMatchObject({
      code: -32000,
      message: "Native operation unavailable",
      data: { providerCode: "session_busy", command: "native_command" },
    });
  },
  60_000,
);
