import type { ChildProcess } from "node:child_process";
import {
  experimental_killPortableProcess,
  experimental_readBoundedLines,
  experimental_recordProviderChildIo,
  experimental_spawnPortableProcess,
  sanitizeInheritedChildProcessEnv,
  withoutBridgeRuntimeEnv,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const OMP_BRIDGE_COMMAND_ENV = "BB_OMP_BRIDGE_COMMAND";
export const OMP_BRIDGE_ARGS_ENV = "BB_OMP_BRIDGE_ARGS";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
export const NO_REQUEST_TIMEOUT = 0;
const STDERR_TAIL_BYTES = 4_096;
const SIGTERM_GRACE_MS = 4_000;
const SIGKILL_ESCALATION_MS = 4_000;

// Native OMP modes/rpc/rpc-frame.ts limits. Physical frame size includes LF;
// reassembled byteLength measures only the logical JSON, before UTF-8 decoding.
const MAX_RPC_FRAME_BYTES = 1024 * 1024;
const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const rpcFrameSchema = z.record(z.string(), z.unknown());

export interface OmpRpcChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface OmpRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export class OmpRpcResponseError extends Error {
  readonly code: string | undefined;
  readonly command: string;

  constructor(response: OmpRpcResponse) {
    super(response.error ?? `omp rejected ${response.command}`);
    this.name = "OmpRpcResponseError";
    this.code = response.code;
    this.command = response.command;
  }
}

export interface SpawnOmpRpcChildArgs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (info: OmpRpcChildExitInfo) => void;
  recordThreadId: string | null;
  onExtensionUiRequest?: (request: Record<string, unknown>) => void;
}

export class OmpRpcChildExitedError extends Error {
  constructor(info: OmpRpcChildExitInfo) {
    super(
      `omp exited (code ${info.code ?? "null"}, signal ${info.signal ?? "null"})${
        info.stderrTail ? `: ${info.stderrTail.trim()}` : ""
      }`,
    );
    this.name = "OmpRpcChildExitedError";
  }
}

interface PendingRequest {
  command: string;
  resolve: (response: OmpRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface PendingRpcChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  receivedBytes: number;
  chunks: Buffer[];
}

export function resolveOmpLaunch(env: NodeJS.ProcessEnv): {
  command: string;
  args: string[];
} {
  const command = env[OMP_BRIDGE_COMMAND_ENV];
  if (!command) {
    return { command: "omp", args: [] };
  }
  const rawArgs = env[OMP_BRIDGE_ARGS_ENV];
  if (!rawArgs) {
    return { command, args: [] };
  }
  const parsed: unknown = JSON.parse(rawArgs);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${OMP_BRIDGE_ARGS_ENV} must be a JSON array of strings`);
  }
  return { command, args: parsed };
}

export function buildOmpChildEnv(
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const inheritedEnv = withoutBridgeRuntimeEnv(
    sanitizeInheritedChildProcessEnv({ env: process.env }),
  );
  return {
    ...inheritedEnv,
    ...overrides,
  };
}

export class OmpRpcChild {
  readonly child: ChildProcess;
  private readonly readiness = Promise.withResolvers<void>();
  readonly ready: Promise<void> = this.readiness.promise;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingPromptResults = new Set<string>();
  private nextRequestId = 0;
  private stderrTail = "";
  private exitInfo: OmpRpcChildExitInfo | null = null;
  private readonly settlement = Promise.withResolvers<OmpRpcChildExitInfo>();
  private readinessTimer: NodeJS.Timeout | undefined;
  private gracefulCloseTimer: NodeJS.Timeout | undefined;
  private killEscalation: NodeJS.Timeout | undefined;
  private receivedReady = false;
  private protocolReady = false;
  private negotiationId: string | null = null;
  private pendingChunks: PendingRpcChunks | null = null;
  private transportError: Error | null = null;
  private closing = false;

  constructor(private readonly args: SpawnOmpRpcChildArgs) {
    // Consumers may first observe readiness through request(), after a spawn error.
    void this.ready.catch(() => undefined);

    const launch = resolveOmpLaunch(process.env);
    this.child = experimental_spawnPortableProcess({
      command: launch.command,
      args: [...launch.args, ...args.args],
      cwd: args.cwd,
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    experimental_recordProviderChildIo(this.child, {
      threadId: args.recordThreadId,
    });

    const configuredTimeout = Number(
      args.env.BB_OMP_BRIDGE_READINESS_TIMEOUT_MS ??
        process.env.BB_OMP_BRIDGE_READINESS_TIMEOUT_MS,
    );
    const readinessTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_READINESS_TIMEOUT_MS;
    this.readinessTimer = setTimeout(() => {
      this.failTransport(
        new Error(
          `omp did not become ready with RPC protocol v2 within ${readinessTimeoutMs}ms`,
        ),
      );
    }, readinessTimeoutMs);
    this.readinessTimer.unref?.();

    this.child.stdin?.on("error", (error: Error) => {
      this.failTransport(new Error(`omp stdin failed: ${error.message}`, { cause: error }));
    });
    const stdout = this.child.stdout;
    if (stdout) {
      experimental_readBoundedLines({
        input: stdout,
        maxLineBytes: MAX_RPC_FRAME_BYTES - 1,
        onLine: (line) => this.handleStdoutLine(line),
        onOverflow: (bytes) => {
          this.failTransport(
            new Error(`omp RPC stdout line exceeded the ${MAX_RPC_FRAME_BYTES}-byte transport limit (${bytes} bytes)`),
          );
        },
        onClose: () => {
          if (this.exitInfo !== null || this.closing) return;
          const reason = this.pendingChunks
            ? "omp stdout ended during an rpc chunk sequence"
            : "omp RPC stdout ended unexpectedly";
          const stderr = this.stderrTail.trim();
          this.failTransport(new Error(stderr ? `${reason}: ${stderr}` : reason));
        },
      });
      stdout.on("error", (error: Error) => {
        this.failTransport(new Error(`omp stdout failed: ${error.message}`, { cause: error }));
      });
    }
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
      process.stderr.write(`omp[${String(this.child.pid ?? "?")}]: ${text}`);
    });
    const settleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exitInfo !== null) return;
      clearTimeout(this.gracefulCloseTimer);
      this.gracefulCloseTimer = undefined;
      clearTimeout(this.killEscalation);
      this.killEscalation = undefined;
      const info: OmpRpcChildExitInfo = {
        code,
        signal,
        stderrTail: this.stderrTail,
      };
      this.exitInfo = info;
      this.pendingChunks = null;
      this.rejectRequests(this.transportError ?? new OmpRpcChildExitedError(info));
      this.settlement.resolve(info);
      args.onExit(info);
    };
    this.child.on("error", (error: Error) => {
      this.failTransport(new Error(`omp process failed: ${error.message}`, { cause: error }));
    });
    // close follows drainage of stdout/stderr; exit can overtake the last response.
    this.child.on("close", settleExit);
    if (!stdout || !this.child.stdin) {
      this.failTransport(new Error("omp RPC requires piped stdin and stdout"));
    }
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  waitForExit(): Promise<OmpRpcChildExitInfo> {
    return this.settlement.promise;
  }

  async request(
    command: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<OmpRpcResponse> {
    await this.ready;
    this.assertCanWrite();
    if (command.id !== undefined && typeof command.id !== "string") {
      throw new Error("omp RPC request id must be a string");
    }
    const id = typeof command.id === "string" ? command.id : this.allocateRequestId();
    if (this.pending.has(id)) {
      throw new Error(`omp RPC request id is already pending: ${id}`);
    }
    const { promise, resolve, reject } = Promise.withResolvers<OmpRpcResponse>();
    const timer =
      timeoutMs === NO_REQUEST_TIMEOUT
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            this.pendingPromptResults.delete(id);
            reject(
              new Error(`omp did not answer ${String(command.type)} in time`),
            );
          }, timeoutMs);
    timer?.unref?.();
    this.pending.set(id, { command: String(command.type), resolve, reject, timer });
    if (command.type === "prompt" || command.type === "abort_and_prompt") {
      this.pendingPromptResults.add(id);
    }
    try {
      this.send({ ...command, id });
    } catch (error) {
      this.pending.delete(id);
      this.pendingPromptResults.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  async requestOk(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await this.request(command, timeoutMs);
    if (!response.success) {
      throw new OmpRpcResponseError(response);
    }
    return response.data;
  }

  send(message: Record<string, unknown>): void {
    this.assertCanWrite();
    // OMP decodes stdin as plain JSONL even after negotiating v2 output framing.
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  closeGracefully(): void {
    if (this.exitInfo !== null || this.closing) return;
    this.closing = true;
    this.endStdin();
    this.gracefulCloseTimer = setTimeout(() => {
      this.gracefulCloseTimer = undefined;
      if (this.exitInfo === null) this.kill();
    }, SIGTERM_GRACE_MS);
    this.gracefulCloseTimer.unref?.();
  }

  kill(): void {
    if (this.exitInfo !== null) return;
    this.closing = true;
    this.endStdin();
    if (this.killEscalation === undefined) {
      this.killEscalation = setTimeout(() => {
        this.killEscalation = undefined;
        if (this.exitInfo === null) {
          experimental_killPortableProcess(this.child, "SIGKILL");
        }
      }, SIGKILL_ESCALATION_MS);
      this.killEscalation.unref?.();
    }
    experimental_killPortableProcess(this.child, "SIGTERM");
  }

  respondToExtensionUi(
    id: string | number,
    fields: Record<string, unknown>,
  ): void {
    this.send({ ...fields, type: "extension_ui_response", id });
  }

  private allocateRequestId(): string {
    let id: string;
    do {
      id = `bb-${++this.nextRequestId}`;
    } while (this.pending.has(id) || id === this.negotiationId);
    return id;
  }

  private assertCanWrite(): void {
    if (this.transportError) throw this.transportError;
    if (this.exitInfo !== null) throw new OmpRpcChildExitedError(this.exitInfo);
    const stdin = this.child.stdin;
    if (this.closing || !stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error("omp RPC stdin is closed");
    }
  }

  private endStdin(): void {
    try {
      this.child.stdin?.end();
    } catch {}
  }

  private rejectRequests(error: Error): void {
    clearTimeout(this.readinessTimer);
    this.readinessTimer = undefined;
    this.readiness.reject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failTransport(error: Error): void {
    if (this.transportError || this.exitInfo !== null) return;
    this.transportError = error;
    this.pendingChunks = null;
    this.rejectRequests(error);
    this.stderrTail = `${this.stderrTail}\n${error.message}`.slice(-STDERR_TAIL_BYTES);
    process.stderr.write(`omp bridge: ${error.message}\n`);
    this.kill();
  }

  private handleStdoutLine(line: string): void {
    if (this.transportError || this.exitInfo !== null) return;
    try {
      // The SDK reader bounds partial lines; also check complete lines delivered
      // in one stream chunk, which bypass its partial-line overflow check.
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_RPC_FRAME_BYTES) {
        throw new Error(`omp RPC stdout line exceeded the ${MAX_RPC_FRAME_BYTES}-byte transport limit`);
      }
      if (!line.trim()) return;
      const message = this.decodeFrame(JSON.parse(line));
      if (message) this.handleMessage(message);
    } catch (error) {
      this.failTransport(
        new Error(`omp RPC output failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
      );
    }
  }

  private decodeFrame(raw: unknown): Record<string, unknown> | undefined {
    const value = rpcFrameSchema.parse(raw);
    if (value.type !== "rpc_chunk") {
      if (this.pendingChunks) throw new Error("rpc chunk sequence interrupted");
      return value;
    }
    if (!this.protocolReady) throw new Error("rpc chunk received before protocol v2 negotiation");

    const { chunkId, index, count, byteLength, data } = value;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      typeof index !== "number" || !Number.isSafeInteger(index) ||
      typeof count !== "number" || !Number.isSafeInteger(count) ||
      typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) ||
      index < 0 || count < 2 ||
      count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      index >= count || byteLength < MAX_RPC_FRAME_BYTES ||
      byteLength > MAX_RPC_REASSEMBLED_BYTES
    ) {
      throw new Error("invalid rpc chunk metadata");
    }
    if (
      typeof data !== "string" || data.length === 0 ||
      data.length > 4 * Math.ceil(RPC_CHUNK_PAYLOAD_BYTES / 3)
    ) {
      throw new Error("invalid rpc chunk data");
    }
    const bytes = Buffer.from(data, "base64");
    // A canonical round trip rejects padding, whitespace, and alphabet errors
    // without a repeated-group regexp over a 350KiB base64 string.
    if (bytes.toString("base64") !== data) throw new Error("invalid rpc chunk data");
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new Error("rpc chunk payload exceeds the transport limit");
    }
    if (!this.pendingChunks) {
      if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
      this.pendingChunks = { chunkId, count, byteLength, nextIndex: 0, receivedBytes: 0, chunks: [] };
    }
    const pending = this.pendingChunks;
    if (
      pending.chunkId !== chunkId || pending.count !== count ||
      pending.byteLength !== byteLength || pending.nextIndex !== index
    ) {
      throw new Error("rpc chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength) {
      throw new Error("rpc chunk sequence exceeds declared length");
    }
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw new Error("rpc chunk sequence length mismatch");
    }
    this.pendingChunks = null;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(pending.chunks, pending.byteLength),
    );
    return rpcFrameSchema.parse(JSON.parse(decoded));
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === "ready") {
      if (this.receivedReady) throw new Error("duplicate omp RPC ready frame");
      if (
        message.protocolVersion !== 1 ||
        !Array.isArray(message.supportedProtocolVersions) ||
        !message.supportedProtocolVersions.includes(2)
      ) {
        throw new Error("omp does not support RPC protocol v2");
      }
      if (
        message.maxFrameBytes !== MAX_RPC_FRAME_BYTES ||
        message.maxReassembledFrameBytes !== MAX_RPC_REASSEMBLED_BYTES
      ) {
        throw new Error("omp advertised unsupported RPC frame limits");
      }
      this.receivedReady = true;
      this.negotiationId = this.allocateRequestId();
      this.send({ type: "negotiate_protocol", id: this.negotiationId, protocolVersion: 2 });
      return;
    }
    if (message.type === "response") {
      if (
        typeof message.command !== "string" || typeof message.success !== "boolean" ||
        (message.id !== undefined && typeof message.id !== "string") ||
        (message.success === false && typeof message.error !== "string")
      ) {
        throw new Error("invalid omp RPC response");
      }
      if (this.negotiationId !== null && message.id === this.negotiationId) {
        if (
          message.command !== "negotiate_protocol" || !message.success ||
          typeof message.data !== "object" || message.data === null ||
          !("protocolVersion" in message.data) || message.data.protocolVersion !== 2
        ) {
          throw new Error(`omp RPC protocol v2 negotiation failed: ${String(message.error ?? "invalid acknowledgment")}`);
        }
        // The acknowledgment itself is v1. Enable decoding synchronously so the
        // next line may be a v2 chunk in the very same stdout data callback.
        this.negotiationId = null;
        this.protocolReady = true;
        clearTimeout(this.readinessTimer);
        this.readinessTimer = undefined;
        this.readiness.resolve();
        return;
      }
      const id = typeof message.id === "string" ? message.id : undefined;
      const pending = id === undefined ? undefined : this.pending.get(id);
      if (pending && id !== undefined) {
        if (pending.command !== message.command) {
          throw new Error(`omp RPC response command mismatch for ${id}: expected ${pending.command}, received ${message.command}`);
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (!message.success || (
          typeof message.data === "object" && message.data !== null &&
          "agentInvoked" in message.data && message.data.agentInvoked === false
        )) {
          this.pendingPromptResults.delete(id);
        }
        pending.resolve(message as unknown as OmpRpcResponse);
      } else if (!message.success && (id === undefined || !this.pendingPromptResults.has(id))) {
        this.args.onEvent({ ...message, type: "bb_rpc_response_error" });
      }
      return;
    }
    if (message.type === "rpc_frame_error") {
      const originalType = typeof message.originalType === "string"
        ? ` (${message.originalType})` : "";
      throw new Error(`${String(message.error ?? "omp RPC frame exceeded the transport limit")}${originalType}`);
    }
    if (message.type === "extension_ui_request") {
      if (this.args.onExtensionUiRequest) {
        this.args.onExtensionUiRequest(message);
      } else if (
        typeof message.id === "string" &&
        ["select", "confirm", "input", "editor", "ask"].includes(String(message.method))
      ) {
        this.respondToExtensionUi(message.id, { cancelled: true });
      }
      return;
    }
    if (message.type === "prompt_result" && typeof message.id === "string") {
      this.pendingPromptResults.delete(message.id);
    }
    if (typeof message.type === "string") {
      this.args.onEvent(message);
    }
  }
}
