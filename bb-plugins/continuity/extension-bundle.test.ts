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

for (const trigger of ["requested", "idle"] as const) test(`committed ${trigger} compaction emits one boundary and never re-emits on resume`, async () => {
  assertFreshExtension();
  const directory = mkdtempSync(join(tmpdir(), "continuity-commit-"));
  const previous = process.env.BB_CONTINUITY_DIRECTORY;
  process.env.BB_CONTINUITY_DIRECTORY = directory;
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const handlers = new Map<string, Function>();
  const settings = new Map<string, unknown>();
  const branch: any[] = [{ id: "user-a", message: { role: "user" } }];
  const notices: string[] = [];
  let poll: () => Promise<void>;
  let compactions = 0;
  const event = { compactionEntry: { id: "committed-a", timestamp: new Date(now + 1234).toISOString() }, fromExtension: false };
  const context: any = {
    agent: { kind: "main" }, sessionManager: { getBranch: () => branch, getSessionId: () => "session-a" },
    getContextUsage: () => ({ tokens: 50_000 }), getAsyncJobSnapshot: () => null, isIdle: () => true, hasPendingMessages: () => false,
    setInterval: (callback: () => Promise<void>) => { poll = callback; return 1; }, clearTimer() {},
    ui: { notify: (message: string) => notices.push(message) },
    async compact(options: { onComplete: () => void }) {
      compactions++;
      // OMP's public contract commits first, emits session_compact, then onComplete.
      await handlers.get("session_compact")!(event, context);
      await handlers.get("session_compact")!(event, context);
      options.onComplete();
    },
  };
  try {
    writeFileSync(join(directory, "control.json"), JSON.stringify({ policy: { ...DEFAULT_POLICY, idleSeconds: 30 }, compactRequestId: trigger === "requested" ? "request-a" : null }));
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(extensionSource).toString("base64")}`);
    const api = {
      pi: { settings: {} }, zod: z, on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand() {}, registerTool() {},
      appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
      getActiveTools: () => ["context_notes", "new_context", "read", "grep"],
    };
    const registry = { lookup(id: string) { return { get: () => settings.get(id), provenance: () => "default", override: (_: unknown, value: unknown) => settings.set(id, value), clearOverride: () => settings.delete(id) }; } };
    runtime.default(api, registry);
    await handlers.get("session_start")!({}, context);
    if (trigger === "idle") { now += 30_001; await poll!(); }
    expect(compactions).toBe(1);
    expect(notices).toEqual([`bb-continuity.compacted.v1:${JSON.stringify({ sessionId: "session-a", entryId: "committed-a", timestamp: event.compactionEntry.timestamp, trigger })}`]);
    const committed = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    expect(committed.lastCompactedAt).toBe(Date.parse(event.compactionEntry.timestamp));
    await handlers.get("session_shutdown")!({}, context);
    // New extension instance restores the checkpoint; status/reconnect is not a boundary.
    runtime.default(api, registry);
    await handlers.get("session_start")!({}, context);
    await handlers.get("session_compact")!(event, context);
    expect(notices).toHaveLength(1);
    // External native manual/automatic compactions have their own provider events.
    await handlers.get("session_compact")!({ compactionEntry: { id: "native-b", timestamp: new Date(now).toISOString() }, fromExtension: false }, context);
    expect(notices).toHaveLength(1);
  } finally {
    clock.mockRestore();
    if (previous === undefined) delete process.env.BB_CONTINUITY_DIRECTORY; else process.env.BB_CONTINUITY_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a slow startup compaction publishes heartbeats and shutdown cannot be overwritten", async () => {
  assertFreshExtension();
  const directory = mkdtempSync(join(tmpdir(), "continuity-slow-"));
  const previous = process.env.BB_CONTINUITY_DIRECTORY;
  process.env.BB_CONTINUITY_DIRECTORY = directory;
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const handlers = new Map<string, Function>();
  const settings = new Map<string, unknown>();
  const completion = Promise.withResolvers<void>();
  let poll: () => Promise<void>;
  let start: Promise<void> | undefined;
  const readStatus = () => JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
  try {
    writeFileSync(join(directory, "control.json"), JSON.stringify({ policy: DEFAULT_POLICY, compactRequestId: "startup-request" }));
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(extensionSource).toString("base64")}`);
    runtime.default({
      pi: { settings: {} }, zod: z, on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand() {}, registerTool() {}, appendEntry() {},
      getActiveTools: () => ["context_notes", "new_context", "read", "grep"],
    }, { lookup(id: string) { return { get: () => settings.get(id), provenance: () => "default", override: (_: unknown, value: unknown) => settings.set(id, value), clearOverride: () => settings.delete(id) }; } });
    const context = {
      agent: { kind: "main" }, sessionManager: { getBranch: () => [], getSessionId: () => "slow-session" },
      getContextUsage: () => ({ tokens: 50_000 }), getAsyncJobSnapshot: () => null, isIdle: () => true, hasPendingMessages: () => false,
      setInterval: (callback: () => Promise<void>) => { poll = callback; return 1; }, clearTimer() {},
      compact: async () => { await completion.promise; },
    };
    start = handlers.get("session_start")!({}, context);
    expect(readStatus().state).toBe("compacting");
    now += 90_000;
    await poll!();
    expect(readStatus()).toMatchObject({ state: "compacting", updatedAt: now });
    await handlers.get("session_shutdown")!({}, context);
    now += 2000;
    await poll!();
    expect(readStatus()).toMatchObject({ state: "stopped", updatedAt: now - 2000 });
  } finally {
    completion.resolve(); await start;
    clock.mockRestore();
    if (previous === undefined) delete process.env.BB_CONTINUITY_DIRECTORY; else process.env.BB_CONTINUITY_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
