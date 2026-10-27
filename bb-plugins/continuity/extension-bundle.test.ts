import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionSource } from "./generated/extension-source";
import { assertFreshExtension } from "./extension-bundle";
import { z } from "zod";
import { DEFAULT_POLICY } from "./policy";

test("fresh embedded extension accepts policy.tools without a nonexistent registry override", async () => {
  assertFreshExtension();
  const directory = mkdtempSync(join(tmpdir(), "continuity-bundle-"));
  const previous = process.env.BB_CONTINUITY_DIRECTORY;
  process.env.BB_CONTINUITY_DIRECTORY = directory;
  const handlers = new Map<string, Function>();
  const settings = new Map<string, unknown>();
  const allowedSettings = ["compaction.experimentalContextManagement", "compaction.keepRecentTokens", "compaction.idleEnabled"];
  try {
    writeFileSync(join(directory, "control.json"), JSON.stringify({ policy: { ...DEFAULT_POLICY, tools: ["read", "grep", "context_notes", "new_context"] }, compactRequestId: null }));
    // Exercise the emitted module loading boundary, not the TypeScript source.
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(extensionSource).toString("base64")}`);
    runtime.default({
      pi: { settings: {} }, zod: z, on: (event: string, handler: Function) => handlers.set(event, handler),
      registerCommand() {}, registerTool() {}, appendEntry() {},
      getActiveTools: () => ["context_notes", "new_context", "read", "grep"],
    }, { lookup(id: string) {
      if (!allowedSettings.includes(id)) throw new Error(`Unsupported registry entry: ${id}`);
      return { get: () => settings.get(id), provenance: () => "default", override: (_: unknown, value: unknown) => settings.set(id, value), clearOverride: () => settings.delete(id) };
    } });
    await handlers.get("session_start")!({}, {
      agent: { kind: "main" }, sessionManager: { getBranch: () => [], getSessionId: () => "bundle-smoke" },
      getContextUsage: () => ({ tokens: 0 }), getAsyncJobSnapshot: () => null, isIdle: () => false,
      setInterval: () => 1, clearTimer() {},
    });
    const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(status.state).toBe("deferred");
    expect(settings.get("compaction.experimentalContextManagement")).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.BB_CONTINUITY_DIRECTORY;
    else process.env.BB_CONTINUITY_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ["callback", "throw"] as const) test(`embedded runtime retains ${failure} compaction failure across idle heartbeats`, async () => {
  assertFreshExtension();
  const directory = mkdtempSync(join(tmpdir(), "continuity-failure-"));
  const previous = process.env.BB_CONTINUITY_DIRECTORY;
  process.env.BB_CONTINUITY_DIRECTORY = directory;
  const handlers = new Map<string, Function>();
  const settings = new Map<string, unknown>();
  let poll: (() => Promise<void>) | undefined;
  let attempts = 0;
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    writeFileSync(join(directory, "control.json"), JSON.stringify({ policy: DEFAULT_POLICY, compactRequestId: "manual-failure" }));
    // Load precisely the embedded deployment artifact, not the source module.
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(extensionSource).toString("base64")}`);
    runtime.default({
      pi: { settings: {} }, zod: z, on: (event: string, handler: Function) => handlers.set(event, handler),
      registerCommand() {}, registerTool() {}, appendEntry() {},
      getActiveTools: () => ["context_notes", "new_context", "read", "grep"],
    }, { lookup(id: string) {
      return { get: () => settings.get(id), provenance: () => "default", override: (_: unknown, value: unknown) => settings.set(id, value), clearOverride: () => settings.delete(id) };
    } });
    const context = {
      agent: { kind: "main" }, sessionManager: { getBranch: () => [], getSessionId: () => "failure-smoke" },
      getContextUsage: () => ({ tokens: 0 }), getAsyncJobSnapshot: () => null, isIdle: () => true, hasPendingMessages: () => false,
      setInterval: (callback: () => Promise<void>) => { poll = callback; return 1; }, clearTimer() {},
      async compact(options: { onError: (error: Error) => void }) {
        attempts++;
        if (failure === "throw") throw new Error("Native compaction refused");
        options.onError(new Error("Native compaction refused"));
      },
    };
    await handlers.get("session_start")!({}, context);
    const failed = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(failed.state).toBe("error");
    expect(failed.lastCompactedAt).toBeNull();
    now += 2_000;
    await poll!();
    const heartbeat = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(heartbeat.state).toBe("error");
    expect(heartbeat.reason).toBe(failed.reason);
    expect(heartbeat.updatedAt).toBeGreaterThan(failed.updatedAt);
    expect(heartbeat.lastCompactedAt).toBeNull();
    expect(attempts).toBe(1);
    await handlers.get("input")!({}, context);
    await poll!();
    expect(JSON.parse(readFileSync(join(directory, "status.json"), "utf8")).state).toBe("deferred");
    expect(attempts).toBe(1);
  } finally {
    clock.mockRestore();
    if (previous === undefined) delete process.env.BB_CONTINUITY_DIRECTORY;
    else process.env.BB_CONTINUITY_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
