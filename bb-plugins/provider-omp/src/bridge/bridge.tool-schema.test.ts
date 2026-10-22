import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OmpRpcChild } from "./rpc-child.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

let harness: FakeOmpBridgeHarness;
let dumpPath: string;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-tool-schema-",
    initialize: true,
  });
  dumpPath = join(harness.workspaceDir, "tools.ndjson");
  vi.stubEnv("FAKE_OMP_TOOLS_DUMP", dumpPath);
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

it("preserves JSON Schema unchanged in native host-tool registration", async () => {
  await harness.request(1, "thread/start", {
    threadId: "thr_schema",
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
    dynamicTools: [
      {
        name: "bb_rich",
        description: "A richly typed bb tool.",
        inputSchema: {
          type: "object",
          description: "The call.",
          additionalProperties: false,
          required: ["mode", "count"],
          properties: {
            mode: {
              type: "string",
              enum: ["fast", "slow"],
              description: "How fast.",
            },
            count: { type: "integer", description: "How many.", minimum: 1 },
            label: {
              type: ["string", "null"],
              description: "An optional label.",
            },
            target: {
              description: "A path or an id.",
              anyOf: [
                {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
                {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
              ],
            },
            kind: { const: "file", description: "Always file." },
          },
        },
      },
    ],
  });
  expect(existsSync(dumpPath)).toBe(true);
  const registered = readFileSync(dumpPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          name: string;
          description: string;
          parameters: Record<string, unknown>;
          loadMode?: string;
        },
    );
  const tool = registered.find((entry) => entry.name === "bb_rich");
  expect(tool).toBeDefined();
  expect(tool!.description).toBe("A richly typed bb tool.");
  expect(tool!.loadMode).toBe("essential");
  const parameters = tool!.parameters as {
    description?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties: Record<string, Record<string, unknown>>;
  };
  expect(parameters.description).toBe("The call.");
  expect(parameters.additionalProperties).toBe(false);
  expect(parameters.required).toEqual(["mode", "count"]);
  expect(parameters.properties.mode).toMatchObject({
    description: "How fast.",
    enum: ["fast", "slow"],
  });
  expect(parameters.properties.count).toMatchObject({
    type: "integer",
    description: "How many.",
  });
  expect(parameters.properties.label).toMatchObject({
    description: "An optional label.",
    type: ["string", "null"],
  });
  expect(parameters.properties.target).toMatchObject({
    description: "A path or an id.",
    anyOf: [
      {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    ],
  });
  expect(parameters.properties.kind).toMatchObject({
    const: "file",
    description: "Always file.",
  });
}, 30_000);

const nativeTool = {
  name: "bb_probe",
  description: "Exercise native host-tool execution.",
  parameters: { type: "object", properties: { value: { type: "string" } } },
  loadMode: "essential",
};

async function withNativeHostTool(
  run: (
    child: OmpRpcChild,
    events: Record<string, unknown>[],
  ) => Promise<void>,
): Promise<void> {
  const events: Record<string, unknown>[] = [];
  const child = new OmpRpcChild({
    cwd: harness.workspaceDir,
    env: process.env,
    args: ["--mode", "rpc", "--no-session"],
    onEvent: (event) => events.push(event),
    onExit: () => undefined,
    recordThreadId: null,
  });
  try {
    await child.ready;
    expect(
      await child.requestOk({ type: "set_host_tools", tools: [nativeTool] }),
    ).toEqual({ toolNames: ["bb_probe"] });
    await run(child, events);
  } finally {
    child.closeGracefully();
    await child.waitForExit();
  }
}

async function waitForWireEvent(
  events: Record<string, unknown>[],
  type: string,
): Promise<Record<string, unknown>> {
  await harness.waitFor(
    () => events.some((event) => event.type === type),
    `native ${type}`,
  );
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Missing native ${type}`);
  return event;
}

it.each([false, true])(
  "correlates native host-tool updates and results by host-call id (isError=%s)",
  async (isError) => {
    await withNativeHostTool(async (child, events) => {
      await child.requestOk({
        type: "prompt",
        id: "native-prompt-id",
        message: '/tool bb_probe {"value":"hi"}',
      });
      const call = await waitForWireEvent(events, "host_tool_call");
      expect(call).toMatchObject({
        toolName: "bb_probe",
        arguments: { value: "hi" },
      });
      expect(call.id).not.toBe(call.toolCallId);

      // The agent's tool-call id is not the native host-call correlation id.
      child.send({
        type: "host_tool_result",
        id: call.toolCallId,
        result: { content: [{ type: "text", text: "wrong correlation" }] },
      });
      expect(await child.requestOk({ type: "get_state" })).toMatchObject({
        isStreaming: true,
      });
      expect(events.some((event) => event.type === "tool_execution_end")).toBe(false);

      child.send({
        type: "host_tool_update",
        id: call.id,
        partialResult: {
          content: [{ type: "text", text: "working" }],
          details: { stage: 1 },
        },
      });
      child.send({
        type: "host_tool_result",
        id: call.id,
        result: {
          content: [{ type: "text", text: "native result" }],
          details: { stage: 2 },
        },
        isError,
      });
      await waitForWireEvent(events, "session_settled");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_execution_update",
          toolCallId: call.toolCallId,
          partialResult: {
            content: [{ type: "text", text: "working" }],
            details: { stage: 1 },
          },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_execution_end",
          toolCallId: call.toolCallId,
          isError,
          result: {
            content: [{ type: "text", text: "native result" }],
            details: isError ? {} : { stage: 2 },
          },
        }),
      );
      expect(events.filter((event) => event.type === "prompt_result")).toEqual([
        {
          type: "prompt_result",
          id: "native-prompt-id",
          agentInvoked: true,
          status: "completed",
          sessionSettled: true,
        },
      ]);
    });
  },
  30_000,
);

it("cancels pending native host tools on abort and ignores late results", async () => {
  await withNativeHostTool(async (child, events) => {
    await child.requestOk({
      type: "prompt",
      id: "aborted-prompt",
      message: "/tool bb_probe {}",
    });
    const call = await waitForWireEvent(events, "host_tool_call");
    await child.requestOk({ type: "abort" });
    expect(await waitForWireEvent(events, "host_tool_cancel")).toMatchObject({
      targetId: call.id,
    });
    expect(events.filter((event) => event.type === "prompt_result")).toEqual([
      {
        type: "prompt_result",
        id: "aborted-prompt",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      },
    ]);
    const ended = events.filter((event) => event.type === "tool_execution_end");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ isError: true });
    child.send({
      type: "host_tool_result",
      id: call.id,
      result: { content: [{ type: "text", text: "late result" }], details: {} },
    });
    expect(await child.requestOk({ type: "get_state" })).toMatchObject({
      isStreaming: false,
    });
    expect(events.filter((event) => event.type === "tool_execution_end")).toEqual(ended);
  });
}, 30_000);

it("rejects invalid native host-tool schemas without replacing registered tools", async () => {
  await withNativeHostTool(async (child, events) => {
    const response = await child.request({
      type: "set_host_tools",
      id: "invalid-tool",
      tools: [{ name: "bad", description: "Invalid parameters.", parameters: [] }],
    });
    expect(response).toMatchObject({
      type: "response",
      id: "invalid-tool",
      command: "set_host_tools",
      success: false,
      error: expect.stringContaining("JSON Schema object"),
    });
    await child.requestOk({
      type: "prompt",
      id: "registered-tool-survives",
      message: "/tool bb_probe {}",
    });
    const call = await waitForWireEvent(events, "host_tool_call");
    expect(call.toolName).toBe("bb_probe");
    child.send({
      type: "host_tool_result",
      id: call.id,
      result: { content: [{ type: "text", text: "still registered" }], details: {} },
    });
    await waitForWireEvent(events, "session_settled");
    expect(
      await child.requestOk({ type: "set_host_tools", tools: [] }),
    ).toEqual({ toolNames: [] });
  });
}, 30_000);
