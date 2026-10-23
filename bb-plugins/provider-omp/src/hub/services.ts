import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveOmpLaunch } from "../bridge/rpc-child.js";
import {
  ompServiceSchema,
  ompServicesHostMethods,
  type OmpService,
} from "../hub-contract.js";

const COMMAND_TIMEOUT_MS = 10_000;
const LIST_CACHE_MS = 2_000;
const LIST_OUTPUT_BYTES = 1024 * 1024;
const LOG_OUTPUT_BYTES = 64 * 1024;
const ERROR_OUTPUT_BYTES = 8 * 1024;

const daemonSchema = ompServiceSchema.omit({ internal: true, url: true, port: true });
const scopeSchema = z.object({
  kind: z.string(),
  projectDir: z.string().optional(),
  runtimeDir: z.string(),
  daemons: z.array(daemonSchema),
});
const scopesSchema = z.array(scopeSchema);
const readySchema = z.object({
  ready: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().min(1).optional(),
  }).optional(),
});

type ListResult = z.infer<typeof ompServicesHostMethods.listOmpServices.output>;
type ListInput = z.infer<typeof ompServicesHostMethods.listOmpServices.input>;
type LogsInput = z.infer<typeof ompServicesHostMethods.readOmpServiceLogs.input>;
type ControlInput = z.infer<typeof ompServicesHostMethods.controlOmpService.input>;

function validateName(name: string): void {
  if (!name || name.startsWith("-") || name.includes("\0")) {
    throw new Error("Invalid omp service name");
  }
}

function appendTail(previous: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const kept = previous.subarray(Math.max(0, previous.length + chunk.length - limit));
  return Buffer.concat([kept, chunk]);
}

function runOmp(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  tail = false,
): Promise<string> {
  signal.throwIfAborted();
  const launch = resolveOmpLaunch(process.env);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(launch.command, [...launch.args, "ps", ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const abort = () => fail(new Error("omp service request cancelled"));
  const timer = setTimeout(() => fail(new Error("omp ps timed out after 10 seconds")), COMMAND_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  // Cover cancellation between the initial check and listener registration.
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    if (!tail && stdout.length + chunk.length > LIST_OUTPUT_BYTES) {
      fail(new Error("omp ps output exceeded 1 MiB"));
      return;
    }
    stdout = appendTail(stdout, chunk, tail ? LOG_OUTPUT_BYTES : LIST_OUTPUT_BYTES);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendTail(stderr, chunk, ERROR_OUTPUT_BYTES);
  });
  child.on("error", (error) => { failure ??= error; });
  child.on("close", (code) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (failure) reject(failure);
    else if (code !== 0) {
      // omp prints unrelated startup warnings (plugin conflicts, …) on stderr.
      const message = stderr.toString("utf8").split("\n").filter((line) => !line.startsWith("Warning: ")).join("\n").trim();
      reject(new Error(message || stdout.toString("utf8").trim() || `omp ps exited with code ${code}`));
    } else resolve(stdout.toString("utf8"));
  });
  return promise;
}

async function serviceAddress(runtimeDir: string, daemon: z.infer<typeof daemonSchema>): Promise<{ url?: string; port?: number }> {
  // The CLI owns daemon names, but never let a malformed record escape its spec directory.
  if (daemon.name !== "." && daemon.name !== ".." && !/[\\/]/.test(daemon.name)) {
    try {
      const spec = readySchema.parse(JSON.parse(await readFile(join(runtimeDir, "daemons", daemon.name, "spec.json"), "utf8")));
      if (spec.ready?.port !== undefined) {
        const host = spec.ready.host ?? "127.0.0.1";
        const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        const url = new URL(`http://${hostname}:${spec.ready.port}`);
        return { url: url.origin, port: spec.ready.port };
      }
    } catch {
      // A missing or stale launch spec must not hide the daemon snapshot.
    }
  }
  const match = daemon.readyMatch?.match(/https?:\/\/[^\s<>"'`]+/);
  if (match) {
    try {
      const url = new URL(match[0]);
      return { url: url.href, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
    } catch {
      // Non-URL readiness messages are normal.
    }
  }
  return {};
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new Error("omp service request cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  return result;
}

/** One host worker owns its subprocesses and short-lived, per-directory list cache. */
export function createOmpServices() {
  const lifecycle = new AbortController();
  const lists = new Map<string, { promise: Promise<ListResult>; expiresAt: number }>();

  async function collect(cwd: string): Promise<ListResult> {
    const scopes = scopesSchema.parse(JSON.parse(await runOmp(cwd, ["--json", "--dir", cwd], lifecycle.signal)));
    const project = scopes.find((scope) => scope.kind === "project");
    if (!project) return { projectDir: null, services: [] };
    const services: OmpService[] = await Promise.all(project.daemons.map(async (daemon) => ({
      ...daemon,
      internal: daemon.name.startsWith("omp."),
      ...await serviceAddress(project.runtimeDir, daemon),
    })));
    return { projectDir: project.projectDir ?? null, services };
  }

  return {
    listOmpServices(input: ListInput, signal?: AbortSignal): Promise<ListResult> {
      const { cwd } = ompServicesHostMethods.listOmpServices.input.parse(input);
      lifecycle.signal.throwIfAborted();
      signal?.throwIfAborted();
      let cached = lists.get(cwd);
      if (!cached || cached.expiresAt <= Date.now()) {
        const entry = { promise: collect(cwd), expiresAt: Infinity };
        lists.set(cwd, entry);
        entry.promise.then(() => {
          entry.expiresAt = Date.now() + LIST_CACHE_MS;
          // Expired directories do not accumulate for the worker's entire lifetime.
          for (const [key, value] of lists) if (value.expiresAt <= Date.now()) lists.delete(key);
        }, () => {
          if (lists.get(cwd) === entry) lists.delete(cwd);
        });
        cached = entry;
      }
      // Cancelling one caller must not interrupt a list shared with another panel.
      return withSignal(cached.promise, signal);
    },
    async readOmpServiceLogs(input: LogsInput, signal?: AbortSignal): Promise<{ text: string }> {
      const { cwd, name, lines = 200 } = ompServicesHostMethods.readOmpServiceLogs.input.parse(input);
      validateName(name);
      const activeSignal = signal ? AbortSignal.any([lifecycle.signal, signal]) : lifecycle.signal;
      return { text: await runOmp(cwd, ["logs", name, "--dir", cwd, "-n", String(lines)], activeSignal, true) };
    },
    async controlOmpService(input: ControlInput, signal?: AbortSignal): Promise<{ ok: true }> {
      const { cwd, name, action } = ompServicesHostMethods.controlOmpService.input.parse(input);
      validateName(name);
      lists.delete(cwd);
      try {
        const activeSignal = signal ? AbortSignal.any([lifecycle.signal, signal]) : lifecycle.signal;
        await runOmp(cwd, [action, name, "--dir", cwd], activeSignal);
        return { ok: true };
      } finally {
        lists.delete(cwd);
      }
    },
    dispose(): void {
      lifecycle.abort();
      lists.clear();
    },
  };
}
