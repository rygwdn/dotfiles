import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProviderBridge from "@get-bb/plugin-sdk/provider-bridge";
import {
  NO_REQUEST_TIMEOUT,
  OMP_BRIDGE_ARGS_ENV,
  OMP_BRIDGE_COMMAND_ENV,
  OmpRpcChild,
  OmpRpcChildExitedError,
  OmpRpcResponseError,
  resolveOmpLaunch,
} from "./rpc-child.js";
import type { OmpRpcChildExitInfo, SpawnOmpRpcChildArgs } from "./rpc-child.js";

const transport = vi.hoisted(() => ({
  spawn: vi.fn(),
  kill: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderBridge>();
  return {
    ...actual,
    experimental_spawnPortableProcess: transport.spawn,
    experimental_killPortableProcess: transport.kill,
    experimental_recordProviderChildIo: transport.record,
  };
});

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: MAX_FRAME_BYTES,
  maxReassembledFrameBytes: MAX_REASSEMBLED_BYTES,
};

interface RpcChunk extends Record<string, unknown> {
  type: "rpc_chunk";
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface TransportHarness {
  rpc: OmpRpcChild;
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  sent: Record<string, unknown>[];
  wire: string[];
  events: Record<string, unknown>[];
  exits: OmpRpcChildExitInfo[];
  emit(frame: Record<string, unknown>): void;
}

const children: TransportHarness[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(OMP_BRIDGE_COMMAND_ENV, undefined);
  vi.stubEnv(OMP_BRIDGE_ARGS_ENV, undefined);
  vi.stubEnv("BB_OMP_BRIDGE_READINESS_TIMEOUT_MS", undefined);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  for (const harness of children.splice(0)) {
    harness.child.emit("close", 0, null);
    harness.stdin.destroy();
    harness.stdout.destroy();
    harness.stderr.destroy();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function createHarness(
  options: {
    env?: NodeJS.ProcessEnv;
    onExtensionUiRequest?: SpawnOmpRpcChildArgs["onExtensionUiRequest"];
  } = {},
): TransportHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  transport.spawn.mockReturnValue(child);
  const sent: Record<string, unknown>[] = [];
  const wire: string[] = [];
  stdin.on("data", (chunk: Buffer) => {
    const line = chunk.toString("utf8");
    wire.push(line);
    sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const events: Record<string, unknown>[] = [];
  const exits: OmpRpcChildExitInfo[] = [];
  const rpc = new OmpRpcChild({
    cwd: process.cwd(),
    env: { ...process.env, ...options.env },
    args: ["--mode", "rpc"],
    recordThreadId: "omp_transport_test",
    onEvent: (event) => events.push(event),
    onExit: (info) => exits.push(info),
    onExtensionUiRequest: options.onExtensionUiRequest,
  });
  const harness: TransportHarness = {
    rpc, child, stdin, stdout, stderr, sent, wire, events, exits,
    emit(frame) {
      stdout.write(`${JSON.stringify(frame)}\n`);
    },
  };
  children.push(harness);
  return harness;
}

async function negotiate(harness: TransportHarness): Promise<void> {
  harness.emit(READY);
  const request = harness.sent.at(-1)!;
  expect(request).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 });
  harness.emit({
    type: "response",
    id: request.id,
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  });
  await harness.rpc.ready;
}

// Matches native rpc-frame.ts: raw UTF-8 slices, not chunks of JSON characters.
function chunkFrames(bytes: Buffer): RpcChunk[] {
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  const chunks: RpcChunk[] = [];
  for (let index = 0; index < count; index += 1) {
    chunks.push({
      type: "rpc_chunk",
      chunkId: "rpc-test",
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
    });
  }
  return chunks;
}

describe("native OMP process launch", () => {
  it("preserves explicit native commands and arguments without npm shim resolution", () => {
    const config = {
      BB_OMP_BRIDGE_COMMAND: "C:\\Program Files\\OMP\\omp.exe",
      BB_OMP_BRIDGE_ARGS: '["--flag","value with spaces"]',
    };
    expect(resolveOmpLaunch(config)).toEqual({
      command: config.BB_OMP_BRIDGE_COMMAND,
      args: ["--flag", "value with spaces"],
    });
    expect(resolveOmpLaunch({ BB_OMP_BRIDGE_ARGS: "invalid" })).toEqual({
      command: "omp", args: [],
    });
    expect(() => resolveOmpLaunch({
      BB_OMP_BRIDGE_COMMAND: "omp", BB_OMP_BRIDGE_ARGS: "[1]",
    })).toThrow("must be a JSON array of strings");
  });

  it("uses and records only stdin, stdout, and stderr", () => {
    const harness = createHarness();
    expect(transport.spawn).toHaveBeenCalledWith(expect.objectContaining({
      command: "omp",
      args: ["--mode", "rpc"],
      stdio: ["pipe", "pipe", "pipe"],
    }));
    expect(transport.record).toHaveBeenCalledExactlyOnceWith(harness.child, {
      threadId: "omp_transport_test",
    });
  });
});

describe("native OMP readiness and routing", () => {
  it("waits for ready and the v2 acknowledgment, preserving a supplied prompt id", async () => {
    const harness = createHarness();
    const request = harness.rpc.request({ type: "prompt", id: "prompt-owned-id", message: "hello" });
    await Promise.resolve();
    expect(harness.sent).toEqual([]);
    harness.emit(READY);
    expect(harness.sent).toHaveLength(1);
    await Promise.resolve();
    expect(harness.sent).toHaveLength(1);
    const negotiation = harness.sent[0]!;
    harness.emit({
      type: "response", id: negotiation.id, command: "negotiate_protocol",
      success: true, data: { protocolVersion: 2 },
    });
    await harness.rpc.ready;
    expect(harness.sent[1]).toEqual({ type: "prompt", id: "prompt-owned-id", message: "hello" });
    const result = {
      type: "prompt_result", id: "prompt-owned-id", agentInvoked: true,
      status: "completed", sessionSettled: true,
    };
    harness.stdout.write([
      { type: "response", id: "prompt-owned-id", command: "prompt", success: true },
      result,
      { type: "session_settled" },
    ].map((frame) => `${JSON.stringify(frame)}\n`).join(""));
    await expect(request).resolves.toMatchObject({ id: "prompt-owned-id", success: true });
    expect(harness.events).toEqual([result, { type: "session_settled" }]);
  });

  it("starts request timeouts only after native readiness and negotiation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness();
    const request = harness.rpc.request({ type: "get_state" }, 10);
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(request).rejects.toThrow("omp did not answer get_state in time");
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    expect(harness.sent).toEqual([]);
    await negotiate(harness);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it.each([false, true])("times out readiness with negotiation started=%s", async (beginNegotiation) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness({ env: { BB_OMP_BRIDGE_READINESS_TIMEOUT_MS: "25" } });
    const readiness = expect(harness.rpc.ready).rejects.toThrow("within 25ms");
    const request = expect(harness.rpc.request({ type: "get_state" }, NO_REQUEST_TIMEOUT))
      .rejects.toThrow("within 25ms");
    if (beginNegotiation) harness.emit(READY);
    await vi.advanceTimersByTimeAsync(25);
    await Promise.all([readiness, request]);
    expect(transport.kill).toHaveBeenCalledWith(harness.child, "SIGTERM");
  });

  it("rejects unsupported ready capabilities and failed negotiation explicitly", async () => {
    const unsupported = createHarness();
    unsupported.emit({ ...READY, supportedProtocolVersions: [1] });
    await expect(unsupported.rpc.ready).rejects.toThrow("does not support RPC protocol v2");
    const rejected = createHarness();
    rejected.emit(READY);
    rejected.emit({
      type: "response", id: rejected.sent[0]!.id, command: "negotiate_protocol",
      success: false, error: "unsupported version",
    });
    await expect(rejected.rpc.ready).rejects.toThrow("negotiation failed: unsupported version");
  });

  it("routes out-of-order replies and rejects duplicate pending ids without replacing their request", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const supplied = harness.rpc.request({ type: "get_state", id: "bb-2" });
    const generated = harness.rpc.request({ type: "get_state" });
    await Promise.resolve();
    const generatedId = harness.sent.at(-1)!.id;
    expect(generatedId).toBe("bb-3");
    await expect(harness.rpc.request({ type: "get_state", id: "bb-2" }))
      .rejects.toThrow("id is already pending: bb-2");
    harness.emit({ type: "response", id: "unrelated", command: "get_state", success: true });
    harness.emit({ type: "response", id: generatedId, command: "get_state", success: true, data: "second" });
    harness.emit({ type: "response", id: "bb-2", command: "get_state", success: true, data: "first" });
    await expect(supplied).resolves.toMatchObject({ data: "first" });
    await expect(generated).resolves.toMatchObject({ data: "second" });
  });

  it.each(["session_busy", "stale_cursor", "unknown_since"])("retains the native %s response code and command", async (code) => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.requestOk({ type: "get_messages_page", id: "page" });
    const rejected = expect(request).rejects.toMatchObject({
      name: "OmpRpcResponseError", message: "native failure", code, command: "get_messages_page",
    });
    await Promise.resolve();
    harness.emit({ type: "response", id: "page", command: "get_messages_page", success: false, error: "native failure", code });
    await rejected;
    await expect(request).rejects.toBeInstanceOf(OmpRpcResponseError);
    expect(harness.events).toEqual([]);
  });

  it("forwards id-less and unmatched failures but lets prompt_result own correlated late errors", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.requestOk({ type: "prompt", id: "prompt" });
    await Promise.resolve();
    harness.emit({ type: "response", id: "prompt", command: "prompt", success: true });
    await request;
    harness.emit({ type: "response", id: "prompt", command: "prompt", success: false, error: "late prompt failure" });
    const result = { type: "prompt_result", id: "prompt", agentInvoked: true, status: "error", sessionSettled: true, error: { message: "late prompt failure" } };
    harness.emit(result);
    harness.emit({ type: "response", command: "parse", success: false, error: "invalid JSON" });
    harness.emit({ type: "response", id: "unknown", command: "extension_send", success: false, error: "send failed", code: "extension_failure" });
    expect(harness.events).toEqual([
      result,
      { type: "bb_rpc_response_error", command: "parse", success: false, error: "invalid JSON" },
      { type: "bb_rpc_response_error", id: "unknown", command: "extension_send", success: false, error: "send failed", code: "extension_failure" },
    ]);
    const next = harness.rpc.request({ type: "get_state", id: "next" });
    await Promise.resolve();
    harness.emit({ type: "response", id: "next", command: "get_state", success: true, data: "still alive" });
    await expect(next).resolves.toMatchObject({ data: "still alive" });
  });

  it("rejects mismatched response commands instead of routing them by id alone", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state", id: "state" });
    await Promise.resolve();
    const rejection = expect(request).rejects.toThrow("response command mismatch");
    harness.emit({ type: "response", id: "state", command: "prompt", success: true });
    await rejection;
  });

  it("drains the final reply and stderr before settling process exit", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state", id: "last" });
    await Promise.resolve();
    harness.child.emit("exit", 0, null);
    harness.emit({ type: "response", id: "last", command: "get_state", success: true, data: "last response" });
    harness.stderr.write("last stderr diagnostic");
    harness.child.emit("close", 0, null);
    await expect(request).resolves.toMatchObject({ data: "last response" });
    await expect(harness.rpc.waitForExit()).resolves.toEqual({
      code: 0, signal: null, stderrTail: "last stderr diagnostic",
    });
    expect(harness.rpc.exited).toBe(true);
    expect(harness.exits).toHaveLength(1);
  });

  it("rejects readiness on process exit and refuses writes to closed stdin", async () => {
    const exited = createHarness();
    exited.stderr.write("failed to initialize");
    exited.child.emit("close", 1, null);
    await expect(exited.rpc.ready).rejects.toBeInstanceOf(OmpRpcChildExitedError);
    const harness = createHarness();
    await negotiate(harness);
    harness.rpc.closeGracefully();
    expect(() => harness.rpc.send({ type: "host_tool_result", id: "late" })).toThrow("stdin is closed");
    await expect(harness.rpc.request({ type: "get_state" })).rejects.toThrow("stdin is closed");
  });
});

describe("native OMP v2 output framing", () => {
  it("reassembles a get_state response over 1MiB without losing UTF-8 or Unicode line separators", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.requestOk({ type: "get_state", id: "large-state" });
    await Promise.resolve();
    const data = { sessionFile: "/sessions/one.jsonl", systemPrompt: "🧪\u2028\u2029".repeat(120_000) };
    const bytes = Buffer.from(JSON.stringify({
      type: "response", id: "large-state", command: "get_state", success: true, data,
    }));
    expect(bytes.byteLength).toBeGreaterThan(MAX_FRAME_BYTES);
    const chunks = chunkFrames(bytes);
    expect(chunks).toHaveLength(5);
    // Multiple physical frames can arrive in the same stream data callback.
    harness.stdout.write(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(""));
    await expect(request).resolves.toEqual(data);
    expect(harness.events).toEqual([]);
  });

  it("enables v2 synchronously before chunks following the acknowledgment in the same write", async () => {
    const harness = createHarness();
    harness.emit(READY);
    const event = { type: "future_native_event", payload: "x".repeat(MAX_FRAME_BYTES) };
    const frames = [
      { type: "response", id: harness.sent[0]!.id, command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } },
      ...chunkFrames(Buffer.from(JSON.stringify(event))),
    ];
    harness.stdout.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
    await harness.rpc.ready;
    expect(harness.events).toEqual([event]);
  });

  const invalidSequences: {
    name: string;
    mutate(chunks: RpcChunk[]): Record<string, unknown>[];
    error: string;
  }[] = [
    { name: "nonzero initial index", mutate: (chunks) => [chunks[1]!], error: "must start at index 0" },
    { name: "out-of-order index", mutate: (chunks) => [chunks[0]!, chunks[2]!], error: "sequence mismatch" },
    { name: "interleaved chunk id", mutate: (chunks) => [chunks[0]!, { ...chunks[1]!, chunkId: "other" }], error: "sequence mismatch" },
    { name: "interrupted sequence", mutate: (chunks) => [chunks[0]!, { type: "available_commands_update", commands: [] }], error: "sequence interrupted" },
    { name: "oversized logical length", mutate: (chunks) => [{ ...chunks[0]!, byteLength: MAX_REASSEMBLED_BYTES + 1 }], error: "invalid rpc chunk metadata" },
    { name: "excessive chunk count", mutate: (chunks) => [{ ...chunks[0]!, count: 257 }], error: "invalid rpc chunk metadata" },
    { name: "invalid base64", mutate: (chunks) => [{ ...chunks[0]!, data: "not base64" }], error: "invalid rpc chunk data" },
    { name: "noncanonical base64", mutate: (chunks) => [{ ...chunks[0]!, data: "Zh==" }], error: "invalid rpc chunk data" },
    { name: "oversized raw chunk", mutate: (chunks) => [{ ...chunks[0]!, data: Buffer.alloc(CHUNK_BYTES + 1).toString("base64") }], error: "payload exceeds the transport limit" },
    { name: "short logical payload", mutate: (chunks) => chunks.map((chunk) => ({ ...chunk, byteLength: chunk.byteLength + 1 })), error: "sequence length mismatch" },
    { name: "excess logical payload", mutate: (chunks) => chunks.map((chunk) => ({ ...chunk, byteLength: chunk.byteLength - 1 })), error: "sequence exceeds declared length" },
  ];

  it.each(invalidSequences)("rejects $name and pending requests explicitly", async ({ mutate, error }) => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state", id: "bad-state" }, NO_REQUEST_TIMEOUT);
    await Promise.resolve();
    const rejection = expect(request).rejects.toThrow(error);
    const chunks = chunkFrames(Buffer.from(JSON.stringify({
      type: "response", id: "bad-state", command: "get_state", success: true,
      data: { payload: "x".repeat(MAX_FRAME_BYTES + 100) },
    })));
    for (const frame of mutate(chunks)) harness.emit(frame);
    await rejection;
    expect(harness.events).toEqual([]);
    expect(transport.kill).toHaveBeenCalledWith(harness.child, "SIGTERM");
  });

  it("rejects chunks before negotiation and oversized unchunked physical frames", async () => {
    const premature = createHarness();
    const chunk = chunkFrames(Buffer.alloc(MAX_FRAME_BYTES))[0]!;
    premature.emit(chunk);
    await expect(premature.rpc.ready).rejects.toThrow("before protocol v2 negotiation");
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state", id: "oversized" }, NO_REQUEST_TIMEOUT);
    await Promise.resolve();
    const rejection = expect(request).rejects.toThrow("stdout line exceeded");
    harness.emit({ type: "unknown_event", payload: "x".repeat(MAX_FRAME_BYTES) });
    await rejection;
  });

  it("rejects invalid UTF-8 after bounded reassembly", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state", id: "bad-utf8" }, NO_REQUEST_TIMEOUT);
    await Promise.resolve();
    const rejection = expect(request).rejects.toThrow(/encoded data|utf-8/i);
    const bytes = Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61);
    bytes[0] = 0xff;
    for (const chunk of chunkFrames(bytes)) harness.emit(chunk);
    await rejection;
  });

  it("fails immediately when stdout ends in the middle of a chunk sequence", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state", id: "incomplete" }, NO_REQUEST_TIMEOUT);
    await Promise.resolve();
    const rejection = expect(request).rejects.toThrow("stdout ended during an rpc chunk sequence");
    harness.emit(chunkFrames(Buffer.alloc(MAX_FRAME_BYTES))[0]!);
    harness.stdout.end();
    await rejection;
  });
});

describe("native OMP events and control frames", () => {
  it("tolerates unknown events and forwards host calls, cancellations, and settlement frames", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const events = [
      { type: "future_native_event", value: 1 },
      { type: "available_commands_update", commands: [] },
      { type: "host_tool_call", id: "host-1", toolCallId: "tool-1", toolName: "bb_probe", arguments: {} },
      { type: "host_tool_cancel", id: "cancel-1", targetId: "host-1" },
      { type: "prompt_result", id: "prompt-1", agentInvoked: true, status: "completed", sessionSettled: false },
      { type: "session_settled" },
    ];
    for (const event of events) harness.emit(event);
    expect(harness.events).toEqual(events);
    harness.rpc.send({ type: "host_tool_update", id: "host-1", partialResult: { content: [] } });
    harness.rpc.send({ type: "host_tool_result", id: "host-1", result: { content: [{ type: "text", text: "x".repeat(MAX_FRAME_BYTES) }] } });
    expect(harness.sent.slice(1).map((frame) => frame.type)).toEqual(["host_tool_update", "host_tool_result"]);
    expect(Buffer.byteLength(harness.wire.at(-1)!)).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(harness.wire.every((line) => line.endsWith("\n") && JSON.parse(line).type !== "rpc_chunk")).toBe(true);
  });

  it("includes the original frame type in transport failure diagnostics", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const request = harness.rpc.request({ type: "get_state" });
    const rejected = expect(request).rejects.toThrow(/oversized.*message_end/);
    await Promise.resolve();
    harness.emit({ type: "rpc_frame_error", error: "oversized", originalType: "message_end" });
    await rejected;
  });

  it("cancels only interactive extension dialogs when no UI handler is installed", async () => {
    const harness = createHarness();
    await negotiate(harness);
    const interactive = ["select", "confirm", "input", "editor", "ask"];
    const notifications = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "cancel", "future_method"];
    for (const method of [...interactive, ...notifications]) {
      harness.emit({ type: "extension_ui_request", id: `ui-${method}`, method });
    }
    expect(harness.sent.slice(1)).toEqual(interactive.map((method) => ({
      type: "extension_ui_response", id: `ui-${method}`, cancelled: true,
    })));
  });

  it("forwards extension UI notifications without automatically answering them", async () => {
    const requests: Record<string, unknown>[] = [];
    const harness = createHarness({ onExtensionUiRequest: (request) => requests.push(request) });
    await negotiate(harness);
    const request = { type: "extension_ui_request", id: "ask-1", method: "ask", questions: [] };
    harness.emit(request);
    harness.emit({ type: "extension_ui_request", id: "notice-1", method: "notify", message: "notice" });
    expect(requests).toHaveLength(2);
    expect(harness.sent).toHaveLength(1);
    const answers = [{ id: "question-1", selectedOptions: ["Option label"] }];
    harness.rpc.respondToExtensionUi("ask-1", { answers });
    expect(harness.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "ask-1", answers });
  });
});
