import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleLine } from "./bridge.js";
import {
  startFakeOmpBridge,
  type FakeOmpBridgeHarness,
  FULL_PERMISSION_OPTIONS,
} from "./test-support.js";

let h: FakeOmpBridgeHarness | undefined;
let nextId = 2000;
afterEach(async () => {
  await h?.teardown();
  h = undefined;
});

async function start(
  options: {
    version?: string;
    duplicate?: boolean;
  } = {},
) {
  const harness = await startFakeOmpBridge({
    prefix: "bb-omp-settlement-",
    initialize: true,
    processLog: true,
  });
  h = harness;
  vi.stubEnv("FAKE_OMP_VERSION", options.version ?? "18.10.4");
  vi.stubEnv("FAKE_OMP_FINAL_LEAF", "settled-leaf");
  vi.stubEnv("FAKE_OMP_COMMAND_LOG", join(harness.workspaceDir, "commands.log"));
  vi.stubEnv("FAKE_OMP_EVENT_LOG", join(harness.workspaceDir, "events.jsonl"));
  vi.stubEnv("FAKE_OMP_RPC_LOG", join(harness.workspaceDir, "rpc.jsonl"));
  if (options.duplicate) vi.stubEnv("FAKE_OMP_DUPLICATE_SETTLED", "1");
  const response = await harness.startThread("thread");
  const result = response.result;
  if (
    !result ||
    typeof result !== "object" ||
    !("providerThreadId" in result) ||
    typeof result.providerThreadId !== "string"
  )
    throw new Error("missing provider identity");
  const providerThreadId = result.providerThreadId;
  const send = (method: string, fields: Record<string, unknown>) =>
    harness.request(++nextId, method, {
      threadId: "thread",
      providerThreadId,
      ...fields,
    });
  let turnCount = 0;
  const turn = async (text: string) => {
    const response = await send("turn/start", {
      clientRequestId:
        ++turnCount === 1 ? "creq_ab23456789" : "creq_ef23456789",
      input: [{ type: "text", text, mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(response.error).toBeUndefined();
    return response;
  };
  const deltas = () => harness.deltasOf("thread");
  const run = async (text: string) => {
    const since = deltas().length;
    await turn(text);
    await harness.waitForTurnBoundary("thread", since);
    return deltas().slice(since);
  };
  const wireEvents = (): Record<string, unknown>[] => {
    const path = join(harness.workspaceDir, "events.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };
  const commands = () =>
    readFileSync(join(harness.workspaceDir, "commands.log"), "utf8")
      .trim()
      .split("\n");
  const rpcCommands = (): Record<string, unknown>[] =>
    readFileSync(join(harness.workspaceDir, "rpc.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { harness, send, turn, run, deltas, wireEvents, commands, rpcCommands };
}

it.each(["18.10.0", "18.10.4"])(
  "uses native prompt/session settlement and its checkpoint on OMP %s",
  async (version) => {
    const t = await start({ version, duplicate: true });
    const deltas = await t.run("hello");
    expect(deltas.filter((d) => d.kind === "turn.boundary")).toEqual([
      expect.objectContaining({
        status: "completed",
        providerCheckpointId: "settled-leaf",
      }),
    ]);
    expect(deltas.filter((d) => d.kind === "usage")).toHaveLength(1);
    expect(t.commands().filter((c) => c === "prompt")).toHaveLength(1);
    const prompt = t.rpcCommands().find((command) => command.type === "prompt");
    expect(t.wireEvents().filter((event) => event.type === "prompt_result")).toEqual([
      {
        type: "prompt_result",
        id: prompt?.id,
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      },
    ]);
    expect(t.wireEvents().filter((event) => event.type === "session_settled")).toHaveLength(2);
    expect(t.wireEvents().some((event) => event.type === "agent_settled")).toBe(false);
    for (const event of t.wireEvents().filter((event) => event.type === "agent_end")) {
      expect(event.messages).toBeUndefined();
      expect(event.willRetry).toBeUndefined();
      expect(event.messageCount).toBeGreaterThan(0);
    }
  },
);

it.each([
  ["hello", "completed", "completed"],
  ["/unexpected-abort", "aborted", "failed"],
  ["/fail-run", "error", "failed"],
])("uses native prompt status for %s", async (text, status, boundaryStatus) => {
  const t = await start();
  const deltas = await t.run(text);
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: boundaryStatus }),
  ]);
  expect(t.wireEvents().filter((event) => event.type === "prompt_result")).toEqual([
    expect.objectContaining({
      status,
      agentInvoked: true,
      sessionSettled: true,
    }),
  ]);
  expect(deltas.filter((delta) => delta.kind === "provider.error")).toHaveLength(
    status === "completed" ? 0 : 1,
  );
});

it("keeps yielded background work live until native session_settled", async () => {
  const t = await start();
  const deltas = await t.run("/background");
  const events = t.wireEvents();
  expect(events.filter((event) => event.type === "prompt_result")).toEqual([
    expect.objectContaining({ status: "completed", sessionSettled: false }),
  ]);
  expect(
    events
      .filter((event) =>
        ["agent_start", "agent_end", "prompt_result", "session_settled"].includes(String(event.type)),
      )
      .map((event) => event.type),
  ).toEqual([
    "agent_start", "agent_end", "prompt_result",
    "agent_start", "agent_end", "session_settled",
  ]);
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({
      status: "completed",
      providerCheckpointId: "settled-leaf",
    }),
  ]);
  expect(JSON.stringify(deltas)).toContain("Response to: background work");
});

it.each(["/native-retry", "/native-overflow"])(
  "allows OMP's native recovery after %s with one final boundary",
  async (text) => {
    const t = await start();
    const deltas = await t.run(text);
    expect(deltas.filter((d) => d.kind === "turn.boundary")).toEqual([
      expect.objectContaining({
        status: "completed",
        providerCheckpointId: "settled-leaf",
      }),
    ]);
    expect(
      deltas.filter(
        (d) =>
          d.kind === "item.textClose" &&
          String(d.text).includes("Response to:"),
      ),
    ).toHaveLength(1);
    expect(t.commands().filter((c) => c === "prompt")).toHaveLength(1);
    expect(t.wireEvents().filter((e) => e.type === "agent_start")).toHaveLength(
      2,
    );
    expect(deltas.filter((delta) => delta.kind === "provider.error")).toHaveLength(0);
    const retryCloses = deltas.filter((delta) =>
      delta.kind === "item.close" && /retr(y|ies)/i.test(JSON.stringify(delta.item)));
    if (text === "/native-retry") {
      // The recovered retry ends as a resolved, non-error notice.
      expect(retryCloses).toEqual([
        expect.objectContaining({ status: "completed", item: expect.objectContaining({
          payload: expect.objectContaining({ severity: "info" }),
        }) }),
      ]);
    } else {
      expect(retryCloses).toHaveLength(0);
    }
    expect(t.wireEvents().filter((event) => event.type === "prompt_result")).toEqual([
      expect.objectContaining({ status: "completed", sessionSettled: true }),
    ]);
    if (text === "/native-overflow") {
      expect(t.wireEvents()).toContainEqual(
        expect.objectContaining({
          type: "auto_compaction_start",
          reason: "overflow",
        }),
      );
      const end = t.wireEvents().find((event) => event.type === "auto_compaction_end");
      expect(end).toMatchObject({ willRetry: true, aborted: false });
      expect(end?.reason).toBeUndefined();
    }
  },
);

it("shows a failed run's error when queued work continues to a completed turn", async () => {
  const t = await start();
  const deltas = await t.run("/failed-then-queued");
  expect(deltas.filter((d) => d.kind === "provider.error")).toEqual([
    expect.objectContaining({
      kind: "provider.error",
      detail: expect.stringContaining("scripted unrecovered failure"),
    }),
  ]);
  expect(deltas.filter((d) => d.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "completed" }),
  ]);
  expect(
    deltas.filter(
      (d) =>
        d.kind === "item.textClose" && String(d.text).includes("Response to:"),
    ),
  ).toHaveLength(1);
  expect(deltas.filter((d) => d.kind === "turn.open")).toHaveLength(1);
});

it.each([
  "/unexpected-abort",
  "/retry-exhausted",
  "/fail-run",
  "/overflow-failed",
  "/overflow-aborted",
])("fails %s once without automatic resume or replay", async (text) => {
  const t = await start();
  const deltas = await t.run(text);
  expect(deltas.filter((d) => d.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "failed" }),
  ]);
  expect(deltas.filter((d) => d.kind === "provider.error")).toHaveLength(1);
  expect(t.commands().filter((c) => c === "prompt")).toHaveLength(1);
  expect(t.wireEvents().filter((e) => e.type === "agent_start")).toHaveLength(
    1,
  );
});

it.each(["/threshold-cancel", "/stop-overflow-cancel", "/stop-overflow-error"])(
  "does not mistake optional compaction %s for failed recovery",
  async (text) => {
    const t = await start();
    const deltas = await t.run(text);
    expect(deltas.filter((d) => d.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(
      deltas.some(
        (d) =>
          d.kind === "item.textClose" &&
          String(d.text).includes("Response to:"),
      ),
    ).toBe(true);
    expect(deltas.filter((d) => d.kind === "usage")).toHaveLength(1);
  },
);

it("settles a locally handled slash command from its ack without prompt_result", async () => {
  const t = await start();
  const deltas = await t.run("/slash-non-agent");
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "completed" }),
  ]);
  expect(deltas.filter((delta) => delta.kind === "provider.error")).toHaveLength(0);
  expect(
    t.wireEvents().filter((event) =>
      ["agent_start", "prompt_result", "session_settled"].includes(String(event.type)),
    ),
  ).toEqual([]);
  expect(t.commands().filter((command) => command === "prompt")).toHaveLength(1);
});

it("Stop interrupts intentionally and release never starts a new run", async () => {
  const t = await start();
  await t.turn("/hold");
  await t.harness.waitForDelta("thread", (d) => d.kind === "turn.open");
  await t.send("thread/stop", { intent: "interrupt", activeTurnId: "turn-1" });
  expect(t.deltas().filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "interrupted" }),
  ]);
  expect(t.wireEvents()).toContainEqual(
    expect.objectContaining({ type: "prompt_result", status: "aborted" }),
  );
  expect(
    t
      .deltas()
      .some((d) => d.kind === "turn.boundary" && d.status === "completed"),
  ).toBe(false);
  expect(t.commands().filter((c) => c === "prompt")).toHaveLength(1);
  const count = t.deltas().length;
  await t.send("thread/stop", { intent: "release", activeTurnId: null });
  expect(
    t
      .deltas()
      .slice(count)
      .some((d) => d.kind === "turn.open"),
  ).toBe(false);
});

it.each(["/hold", "/wait-hold"])(
  "keeps %s live until authorized steering is consumed",
  async (text) => {
    const t = await start();
    await t.turn(text);
    await t.harness.waitForDelta("thread", (d) => d.kind === "turn.open");
    if (text === "/wait-hold")
      await t.harness.waitForDelta("thread", (d) => d.kind === "item.open");
    expect(t.deltas().some((d) => d.kind === "turn.boundary")).toBe(false);
    await t.send("turn/steer", {
      expectedTurnId: "turn-1",
      clientRequestId: "creq_cd23456789",
      input: [{ type: "text", text: "authorized next step", mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    await t.harness.waitForTurnBoundary("thread");
    expect(JSON.stringify(t.deltas())).toContain(
      "Steered: authorized next step",
    );
    expect(t.deltas().filter((d) => d.kind === "turn.boundary")).toHaveLength(
      1,
    );
  },
);

it("drains queued followUp before the only final boundary", async () => {
  const t = await start();
  await t.turn("/hold");
  await t.harness.waitForDelta("thread", (d) => d.kind === "turn.open");
  const queued = t.turn("queued authorized work");
  await t.harness.waitFor(
    () =>
      t
        .wireEvents()
        .some(
          (e) =>
            e.type === "queue_update" &&
            Array.isArray(e.followUp) &&
            e.followUp.includes("queued authorized work"),
        ),
    "native followUp queued",
  );
  expect(t.deltas().some((d) => d.kind === "turn.boundary")).toBe(false);
  await t.send("turn/steer", {
    expectedTurnId: "turn-1",
    clientRequestId: "creq_cd23456789",
    input: [{ type: "text", text: "finish hold", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  await queued;
  await t.harness.waitForTurnBoundary("thread");
  expect(
    t
      .wireEvents()
      .filter((e) => e.type === "agent_start" || e.type === "session_settled")
      .map((e) => e.type),
  ).toEqual(["agent_start", "agent_start", "session_settled"]);
  expect(t.deltas().filter((d) => d.kind === "turn.boundary")).toHaveLength(1);
  expect(
    t.wireEvents()
      .filter((event) => event.type === "prompt_result")
      .map((event) => event.sessionSettled),
  ).toEqual([false, true]);
});

it.each(["Approved answer", "Permission refused"])(
  "question response %s stays in the same live run without replay",
  async (answer) => {
    const t = await start();
    await t.turn('/ui {"method":"input","title":"Missing material decision"}');
    const question = await t.harness.waitForMessage(
      (m) => m.method === "interaction/request",
      "question",
    );
    expect(t.deltas().some((d) => d.kind === "turn.boundary")).toBe(false);
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: question.id,
        result: { kind: "request_answer", value: answer },
      }),
    );
    await t.harness.waitForTurnBoundary("thread");
    expect(JSON.stringify(t.deltas())).toContain(answer);
    expect(t.deltas().filter((d) => d.kind === "turn.boundary")).toHaveLength(
      1,
    );
    expect(t.commands().filter((c) => c === "prompt")).toHaveLength(1);
  },
);

it("child exit fails rather than completing", async () => {
  const t = await start();
  expect(
    (await t.run("/die")).filter((d) => d.kind === "turn.boundary"),
  ).toEqual([expect.objectContaining({ status: "failed" })]);
});
