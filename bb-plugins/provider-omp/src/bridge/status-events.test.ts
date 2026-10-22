import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  OMP_NOTICE_KIND,
  OMP_STATUS_STATE_KIND,
  ompNoticeSchema,
  ompStatusStateSchema,
} from "../extension-ui-contract.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const EMPTY_STATUS = { statuses: [], widgets: [] };

function startupStatus(text: string) {
  return [
    { method: "setStatus", statusKey: "worker", statusText: text },
    { method: "setWidget", widgetKey: "dashboard", widgetLines: [text] },
  ];
}

describe("native OMP status and notice bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let nextId = 30_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({
      prefix: "bb-omp-status-",
      initialize: true,
      processLog: true,
    });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  function statuses(threadId: string) {
    return harness.deltasOf(threadId)
      .filter((delta) => delta.kind === "extension.state" && delta.extensionKind === OMP_STATUS_STATE_KIND)
      .map((delta) => ompStatusStateSchema.parse(delta.payload))
      .filter((state, index, states) =>
        index === 0 || !isDeepStrictEqual(state, states[index - 1]),
      );
  }

  async function start(threadId: string, options: Record<string, unknown> = {}) {
    const response = await harness.startThread(threadId, {
      options: { ...FULL_PERMISSION_OPTIONS, ...options },
    });
    expect(response.error).toBeUndefined();
    return z.object({ providerThreadId: z.string() }).parse(response.result).providerThreadId;
  }

  async function turn(
    threadId: string,
    providerThreadId: string,
    text: string,
    options: Record<string, unknown> = {},
  ) {
    const since = harness.deltasOf(threadId).length;
    const response = await harness.request(++nextId, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId: "creq_st23456789",
      input: [{ type: "text", text, mentions: [] }],
      options: { ...FULL_PERMISSION_OPTIONS, ...options },
    });
    expect(response.error).toBeUndefined();
    await harness.waitForTurnBoundary(threadId, since);
  }

  it("publishes insertion-ordered replace/clear snapshots and preserves empty widgets without answering", async () => {
    const threadId = "thr_status_keyed";
    const uiLog = join(harness.workspaceDir, "ui.jsonl");
    vi.stubEnv("FAKE_OMP_UI_LOG", uiLog);
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify([
      { method: "setStatus", statusKey: "first", statusText: "\u001b[32mReady\u001b[0m" },
      { method: "setStatus", statusKey: "second", statusText: "Waiting" },
      { method: "setWidget", widgetKey: "board", widgetLines: ["\u001b[36mline\u001b[0m"], widgetPlacement: "belowEditor" },
    ]));
    const providerThreadId = await start(threadId);
    expect(statuses(threadId)).toEqual([
      EMPTY_STATUS,
      { statuses: [{ key: "first", text: "Ready" }], widgets: [] },
      { statuses: [{ key: "first", text: "Ready" }, { key: "second", text: "Waiting" }], widgets: [] },
      { statuses: [{ key: "first", text: "Ready" }, { key: "second", text: "Waiting" }], widgets: [{ key: "board", lines: ["line"], placement: "belowEditor" }] },
    ]);
    const before = statuses(threadId).length;
    await turn(threadId, providerThreadId, `/ui ${JSON.stringify([
      { method: "setStatus", statusKey: "first", statusText: "Running" },
      { method: "setStatus", statusKey: "second" },
      { method: "setWidget", widgetKey: "board", widgetLines: [] },
      { method: "setWidget", widgetKey: "board", widgetLines: [] },
      { method: "setStatus", statusKey: "first", statusText: "Running" },
    ])}`);
    expect(statuses(threadId)).toHaveLength(before + 3);
    expect(statuses(threadId).at(-1)).toEqual({
      statuses: [{ key: "first", text: "Running" }],
      widgets: [{ key: "board", lines: [], placement: "aboveEditor" }],
    });
    await turn(threadId, providerThreadId, `/ui ${JSON.stringify([
      { method: "setStatus", statusKey: "first" },
      { method: "setWidget", widgetKey: "board" },
      { method: "setWidget", widgetKey: "missing" },
    ])}`);
    expect(statuses(threadId)).toHaveLength(before + 5);
    expect(statuses(threadId).at(-1)).toEqual(EMPTY_STATUS);
    expect(existsSync(uiLog)).toBe(false);
    expect(harness.messages.some((message) => message.method === "interaction/request")).toBe(false);
  }, 90_000);

  it.each(["info", "warning", "error"] as const)("persists %s notices both before a turn and during a turn without answering", async (severity) => {
    const threadId = `thr_notice_${severity}`;
    const uiLog = join(harness.workspaceDir, "ui.jsonl");
    const startupMessage = `Startup ${severity}`;
    const activeMessage = `Active ${severity}\nfull message`;
    vi.stubEnv("FAKE_OMP_UI_LOG", uiLog);
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify({
      method: "notify", message: startupMessage, notifyType: severity,
    }));
    const providerThreadId = await start(threadId);
    const outside = harness.deltasOf(threadId).filter((delta) => delta.kind === "provider.warning");
    expect(outside).toHaveLength(1);
    expect(outside[0]!.details).toBe(startupMessage);
    expect(String(outside[0]!.summary).toLowerCase()).toContain(severity);
    await turn(threadId, providerThreadId, `/ui ${JSON.stringify({
      method: "notify", message: activeMessage, notifyType: severity,
    })}`);
    const notices = harness.deltasOf(threadId).filter((delta) => {
      const item = delta.item;
      return delta.kind === "item.close" && typeof item === "object" && item !== null &&
        "type" in item && item.type === "extension" && "kind" in item && item.kind === OMP_NOTICE_KIND;
    });
    expect(notices).toHaveLength(1);
    const item = z.object({ payload: ompNoticeSchema }).parse(notices[0]!.item);
    expect(item.payload).toEqual({ severity, message: activeMessage });
    expect(existsSync(uiLog)).toBe(false);
  }, 90_000);

  it("clears status on release and rehydrates only the resumed child's startup state", async () => {
    const threadId = "thr_status_resume";
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify(startupStatus("Original")));
    const providerThreadId = await start(threadId);
    await turn(threadId, providerThreadId, "first");
    await harness.request(++nextId, "thread/stop", {
      threadId, providerThreadId, intent: "release", activeTurnId: null,
    });
    expect(statuses(threadId).at(-1)).toEqual(EMPTY_STATUS);
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify(startupStatus("Resumed")));
    const resumed = await harness.request(++nextId, "thread/resume", {
      threadId, providerThreadId, cwd: harness.workspaceDir,
      instructionMode: "append", options: FULL_PERMISSION_OPTIONS,
    });
    expect(resumed.error).toBeUndefined();
    expect(statuses(threadId).at(-1)).toEqual({
      statuses: [{ key: "worker", text: "Resumed" }],
      widgets: [{ key: "dashboard", lines: ["Resumed"], placement: "aboveEditor" }],
    });
    expect(statuses(threadId).filter((state) => state.statuses.length === 0 && state.widgets.length === 0)).toHaveLength(2);
  }, 90_000);

  it("resets before an environment rebuild and ignores the retired child's later exit", async () => {
    const threadId = "thr_status_rebuild";
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify(startupStatus("Original")));
    const providerThreadId = await start(threadId);
    const previousChildren = harness.readProcessLog().spawned;
    const before = statuses(threadId).length;
    await turn(threadId, providerThreadId, "replacement", {
      envVars: { FAKE_OMP_STARTUP_UI_JSON: JSON.stringify(startupStatus("Replacement")) },
    });
    await harness.waitFor(
      () => previousChildren.every((pid) => harness.readProcessLog().exited.includes(pid)),
      "the retired child to exit",
    );
    expect(statuses(threadId).slice(before)).toEqual([
      EMPTY_STATUS,
      { statuses: [{ key: "worker", text: "Replacement" }], widgets: [] },
      { statuses: [{ key: "worker", text: "Replacement" }], widgets: [{ key: "dashboard", lines: ["Replacement"], placement: "aboveEditor" }] },
    ]);
  }, 90_000);

  it("clears the last snapshot when the child exits unexpectedly", async () => {
    const threadId = "thr_status_exit";
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify(startupStatus("Running")));
    const providerThreadId = await start(threadId);
    const since = statuses(threadId).length;
    const response = await harness.request(++nextId, "turn/start", {
      threadId, providerThreadId, clientRequestId: "creq_st23456789",
      input: [{ type: "text", text: "/die", mentions: [] }], options: FULL_PERMISSION_OPTIONS,
    });
    expect(response.error).toBeUndefined();
    await harness.waitFor(
      () => statuses(threadId).length > since,
      "the exited child's status to clear",
    );
    expect(statuses(threadId).at(-1)).toEqual(EMPTY_STATUS);
  }, 90_000);

  it("clears a failed construction attempt before a successful auth respawn re-emits its state", async () => {
    const catalog = await harness.request(++nextId, "model/list", { cwd: harness.workspaceDir });
    expect(catalog.error).toBeUndefined();
    vi.stubEnv("FAKE_OMP_SPAWN_COUNTER_FILE", join(harness.workspaceDir, "spawns"));
    vi.stubEnv("FAKE_OMP_MISMATCH_FIRST_SPAWN", "1");
    vi.stubEnv("FAKE_OMP_STARTUP_UI_JSON", JSON.stringify({ method: "setStatus", statusKey: "attempt", statusText: "Ready" }));
    const threadId = "thr_status_auth_respawn";
    await start(threadId, { model: "fake-provider/fake-mini" });
    expect(statuses(threadId)).toEqual([
      EMPTY_STATUS,
      { statuses: [{ key: "attempt", text: "Ready" }], widgets: [] },
      EMPTY_STATUS,
      { statuses: [{ key: "attempt", text: "Ready" }], widgets: [] },
    ]);
  }, 90_000);
});
