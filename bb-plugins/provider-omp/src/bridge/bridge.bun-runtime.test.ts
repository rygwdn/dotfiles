import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleLine } from "./bridge.js";
import { OMP_BRIDGE_ARGS_ENV, OMP_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import {
  FULL_PERMISSION_OPTIONS,
  fakeOmpPath,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness;
let nextId = 2000;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-bun-",
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

function bunBinary(): string | null {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    if (process.env.CI)
      throw new Error("Bun is required for the OMP runtime regression in CI");
    return null;
  }
  return "bun";
}

it.skipIf(bunBinary() === null)(
  "delivers native stdin/stdout host-tool results under the Bun runtime",
  async () => {
    const bun = "bun";
    vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, bun);
    vi.stubEnv(OMP_BRIDGE_ARGS_ENV, JSON.stringify([fakeOmpPath]));
    const rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    const eventLog = join(harness.workspaceDir, "events.jsonl");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
    vi.stubEnv("FAKE_OMP_EVENT_LOG", eventLog);

    const threadId = "thr_bun_dyn_tool";
    const started = await harness.request((nextId += 1), "thread/start", {
      threadId,
      cwd: harness.workspaceDir,
      instructionMode: "append",
      options: FULL_PERMISSION_OPTIONS,
      dynamicTools: [
        {
          name: "bb_probe",
          description: "A bb tool.",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        },
      ],
    });
    expect(started.error, JSON.stringify(started)).toBeUndefined();
    const providerThreadId = String(
      (started.result as { providerThreadId?: unknown }).providerThreadId,
    );
    expect(providerThreadId).toMatch(/^omp_[0-9a-f-]{36}$/u);

    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: (nextId += 1),
        method: "turn/start",
        params: {
          threadId,
          providerThreadId,
          clientRequestId: "creq_bu23456789",
          input: [
            {
              type: "text",
              text: `/tool bb_probe ${JSON.stringify({ value: "hi" })}`,
              mentions: [],
            },
          ],
          options: FULL_PERMISSION_OPTIONS,
        },
      }),
    );
    const toolCall = await harness.waitForMessage(
      (m) => m.method === "item/tool/call",
      "the dynamic tool call",
    );
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: toolCall.id,
        result: {
          contentItems: [{ type: "inputText", text: "bun-result-text" }],
          success: true,
        },
      }),
    );
    await harness.waitForMessage(
      () =>
        harness
          .deltasOf(threadId)
          .some(
            (d) =>
              d.kind === "item.textDelta" &&
              String(d.text).includes("Tool said: bun-result-text"),
          ),
      "the tool result to reach omp under Bun",
    );
    await harness.waitForDelta(threadId, (d) => d.kind === "turn.boundary");
    const commands = readFileSync(rpcLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = readFileSync(eventLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "set_host_tools",
        tools: [
          expect.objectContaining({
            name: "bb_probe",
            loadMode: "essential",
          }),
        ],
      }),
    );
    const nativeCall = events.find((event) => event.type === "host_tool_call");
    expect(nativeCall).toMatchObject({
      toolName: "bb_probe",
      arguments: { value: "hi" },
    });
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "host_tool_result",
        id: nativeCall?.id,
        result: {
          content: [{ type: "text", text: "bun-result-text" }],
          details: {},
        },
      }),
    );
    const prompt = commands.find((command) => command.type === "prompt");
    expect(events).toContainEqual({
      type: "prompt_result",
      id: prompt?.id,
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    });
    expect(events).toContainEqual({ type: "session_settled" });
  },
  90_000,
);
