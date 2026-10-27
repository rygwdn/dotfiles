import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hostContract } from "./contracts";
import { policySchema, runtimeSignalSchema, statusSchema, threadIdSchema, type RuntimeStatus } from "./schema";
import { atomicJson, isMissing, readJson } from "./files";
import { extensionSource } from "./generated/extension-source";

const controlSchema = z.object({ policy: policySchema, compactRequestId: z.string().max(200).nullable() }).strict();
/** Structural slice of the host RPC context needed to run the status watcher. */
interface WatchContext {
  readonly experimental_paths: { readonly dataDir: string };
  experimental_emitSignal(name: "runtime", payload: { threadId: string; status: RuntimeStatus | null }): Promise<void>;
  experimental_retainWorker(): { dispose(): Promise<void> };
  experimental_watch(options: { rootPath: string; debounceMs?: number; maxWaitMs?: number }, listener: (event:
    | { kind: "changed"; changes: readonly { path: string; type: string }[] }
    | { kind: "rescan-required" }
    | { kind: "watch-error"; message: string }) => void | Promise<void>): Promise<{ dispose(): Promise<void> }>;
}
let watchStarted = false;
// One watcher per host worker. status.json is rewritten every ~2s by a resident
// extension, so identical payloads are suppressed and a heartbeat re-emits at
// least every 30s: clients treat silence past their freshness window as a dead
// runtime without confusing "no change" with "gone". A 5s directory poll backs
// the daemon watcher — observed native-watch delivery is not reliable across
// worker generations, and the poll keeps signal flow deterministic.
function startRuntimeWatch(ctx: WatchContext): void {
  if (watchStarted) return;
  watchStarted = true;
  const threads = join(ctx.experimental_paths.dataDir, "threads");
  try { directory(threads); } catch { return; }
  const last = new Map<string, { sig: string; at: number }>();
  async function emitThread(threadId: string): Promise<void> {
    if (!threadIdSchema.safeParse(threadId).success) return;
    let status: RuntimeStatus | null = null;
    try { status = statusSchema.parse(readJson(join(threads, threadId, "status.json"))); }
    catch { status = null; }
    const sig = status === null ? null :
      JSON.stringify([status.state, status.reason, status.demotedResults, status.reclaimedTokens, status.estimatedTokens, status.lastCompactedAt]);
    const prev = last.get(threadId);
    const now = Date.now();
    if (prev && prev.sig === sig && now - prev.at < 30_000) return;
    last.set(threadId, { sig: sig ?? "null", at: now });
    try { await ctx.experimental_emitSignal("runtime", { threadId, status }); } catch (error) { process.stderr.write(`continuity host emit error: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  async function scanAll(): Promise<void> {
    let entries: string[] = [];
    try { entries = readdirSync(threads); } catch { return; }
    for (const threadId of entries) await emitThread(threadId);
  }
  void ctx.experimental_retainWorker();
  setInterval(() => { void scanAll(); }, 5000);
  void ctx.experimental_watch({ rootPath: threads, debounceMs: 250, maxWaitMs: 1000 }, async event => {
    if (event.kind === "watch-error") return;
    if (event.kind === "rescan-required") { await scanAll(); return; }
    const ids = new Set<string>();
    for (const change of event.changes) {
      // change.path may be absolute or root-relative; match "<threadId>/status.json" at the tail.
      const match = /(?:^|[/\\])(thr_[a-zA-Z0-9_-]+)[/\\]status\.json$/.exec(change.path);
      if (match) ids.add(match[1]!);
    }
    for (const threadId of ids) await emitThread(threadId);
  }).catch(error => { process.stderr.write(`continuity host watch failed: ${error instanceof Error ? error.message : String(error)}\n`); });
}
const BOOTSTRAP = `// Owned by bb-plugin-continuity. No effect outside an opted-in BB provider process.\nimport { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";\nexport default async function continuityBootstrap(pi) {\n  const entry = process.env.BB_CONTINUITY_EXTENSION;\n  if (!entry || !process.env.BB_CONTINUITY_DIRECTORY) return;\n  // The host registry must be statically resolved by OMP's extension loader; the plugin runtime path is selected at launch.\n  const extension = await import(entry);\n  return extension.default(pi, { lookup });\n}\n`;
function directory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory or symlink: ${path}`);
}
function threadDirectory(root: string, threadId: string): string {
  threadIdSchema.parse(threadId);
  const threads = join(root, "threads");
  directory(root); directory(threads);
  const path = join(threads, threadId);
  directory(path); chmodSync(path, 0o700);
  return path;
}
export default experimental_defineHostEntry({ contract: hostContract, experimental_signals: { runtime: { payload: runtimeSignalSchema } }, handlers: {
  prepare({ threadId, workspace, policy }, ctx) {
    startRuntimeWatch(ctx);
    if (!isAbsolute(workspace)) throw new Error("Continuity requires an absolute host workspace");
    const root = realpathSync(workspace);
    const omp = join(root, ".omp"), extensions = join(omp, "extensions");
    directory(omp); directory(extensions);
    const bootstrap = join(extensions, "bb-continuity.ts");
    try { writeFileSync(bootstrap, BOOTSTRAP, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(bootstrap);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || readFileSync(bootstrap, "utf8") !== BOOTSTRAP) throw new Error(`Refusing existing non-Continuity extension: ${bootstrap}`);
    }
    const path = threadDirectory(ctx.experimental_paths.dataDir, threadId);
    const extension = join(path, "extension.mjs");
    // Atomically replace only plugin-owned runtime files; no transcript is stored here.
    const temporary = join(path, `extension-${randomUUID()}.tmp`);
    writeFileSync(temporary, extensionSource, { flag: "wx", mode: 0o600 });
    renameSync(temporary, extension);
    let compactRequestId: string | null = null;
    try { compactRequestId = controlSchema.parse(readJson(join(path, "control.json"))).compactRequestId; }
    catch (error) { if (!isMissing(error)) throw error; }
    atomicJson(join(path, "control.json"), { policy, compactRequestId });
    return { directory: path, extension };
  },
  inspect({ threadId }, ctx) {
    startRuntimeWatch(ctx);
    const path = join(ctx.experimental_paths.dataDir, "threads", threadIdSchema.parse(threadId), "status.json");
    try { return { status: statusSchema.parse(readJson(path)) }; }
    catch (error) { if (!isMissing(error)) throw error; return { status: null }; }
  },
  control({ threadId, policy, compact }, ctx) {
    startRuntimeWatch(ctx);
    const path = threadDirectory(ctx.experimental_paths.dataDir, threadId);
    let compactRequestId: string | null = null;
    try { compactRequestId = controlSchema.parse(readJson(join(path, "control.json"))).compactRequestId; }
    catch (error) { if (!isMissing(error)) throw error; }
    if (compact) compactRequestId = randomUUID();
    atomicJson(join(path, "control.json"), { policy, compactRequestId });
    return { queued: compact };
  },
} });
