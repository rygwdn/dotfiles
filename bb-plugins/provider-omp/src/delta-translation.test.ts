import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type DeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  createOmpDeltaTranslator,
  createOmpModelContextWindowResolverFrom,
  type OmpModelContextWindowResolver,
} from "./delta-translation.js";
import { OMP_NOTICE_KIND } from "./extension-ui-contract.js";

const fixtureModelResolver = createOmpModelContextWindowResolverFrom([
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    contextWindow: 200_000,
  },
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "./__fixtures__/omp");

function threadScope(): ThreadEvent["scope"] {
  return { kind: "thread" };
}

function turnScope(turnId: string): ThreadEvent["scope"] {
  return { kind: "turn", turnId };
}

const THREAD_ID = "bb-thread-1";
const ENTROPY = "omp-test";
const TURN_ID_PATTERN = /^omp-test-t\d+$/;
const ITEM_ID_PATTERN = /^omp-test-i\d+$/;

interface NativeOmpEvent {
  type: string;
  [key: string]: unknown;
}

function loadFixture(name: string): NativeOmpEvent {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, name), "utf8"),
  ) as NativeOmpEvent;
}

function loadSettledAgentEndFixture(): NativeOmpEvent {
  return {
    ...loadFixture("agent-end-with-message.json"),
    deferSettlement: false,
  };
}

interface OmpTestContext {
  cwd?: string;
  threadId?: string;
  parentToolCallId?: string;
  fileRoots?: { artifactsDir?: string; localDir?: string };
}

interface OmpEquivalenceHarness {
  assembler: DeltaAssembler;
  translate(event: unknown, context?: OmpTestContext): ThreadEvent[];
  openTurnId(): string;
  resetThread(): void;
}

function createHarness(options?: {
  resolveModelContextWindow?: OmpModelContextWindowResolver;
}): OmpEquivalenceHarness {
  const translator = createOmpDeltaTranslator({
    resolveModelContextWindow:
      options?.resolveModelContextWindow ?? fixtureModelResolver,
  });
  const assembler = createDeltaAssembler({
    providerId: "omp",
    entropyPrefix: ENTROPY,
    textDeltaFlushMs: 0,
    progressThrottleMs: 0,
  });
  return {
    assembler,
    translate(event, context) {
      const threadId = context?.threadId ?? THREAD_ID;
      return assembler.assemble({
        threadId,
        deltas: translator.translate(event, { ...context, threadId }),
      });
    },
    openTurnId() {
      return assembler.getOpenTurnId(THREAD_ID) ?? "";
    },
    resetThread() {
      translator.resetThread(THREAD_ID);
      assembler.assemble({ threadId: THREAD_ID, deltas: [{ kind: "session.reset" }] });
    },
  };
}

function sdkMessage(message: unknown, threadId = "omp-thread-1") {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: { threadId, message },
  };
}

function createOmpCustomMessage(args: {
  content: string | Array<Record<string, unknown>>;
  display?: boolean;
}) {
  return {
    role: "custom",
    customType: "ad-process:notification",
    content: args.content,
    display: args.display ?? true,
    details: { attention: "turn", kind: "success", processId: "proc_551c" },
    timestamp: 1_786_919_243_630,
  };
}

function createOmpAgentErrorEvent(errorMessage: string) {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 1777995781000,
      },
    ],
  };
}

function createAssistantMessageEnd(text: string, messageId?: string) {
  return {
    type: "message_end",
    ...(messageId ? { messageId } : {}),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      stopReason: "stop",
      usage: { input: 2, output: 3, totalTokens: 5 },
      timestamp: 1777995781000,
    },
  };
}

interface OmpBashStartEventArgs {
  command: string;
  cwd?: string;
  toolCallId: string;
}

function createOmpBashStartEvent(args: OmpBashStartEventArgs) {
  return {
    type: "tool_execution_start",
    toolCallId: args.toolCallId,
    toolName: "bash",
    args: { command: args.command, cwd: args.cwd ?? "/repo" },
  };
}

interface OmpBashUpdateEventArgs {
  text: string;
  threadId: string;
  toolCallId: string;
}

function createOmpBashUpdateEvent(args: OmpBashUpdateEventArgs) {
  return {
    jsonrpc: "2.0" as const,
    method: "sdk/message",
    params: {
      threadId: args.threadId,
      message: {
        type: "tool_execution_update" as const,
        toolCallId: args.toolCallId,
        toolName: "bash" as const,
        partialResult: {
          content: [{ type: "text" as const, text: args.text }],
        },
      },
    },
  };
}

function createTextDeltaEvent() {
  return loadFixture("message-update-delta.json");
}

function agentMessageDeltaId(events: ThreadEvent[]): string | undefined {
  const delta = events.find(
    (
      event,
    ): event is Extract<ThreadEvent, { type: "item/agentMessage/delta" }> =>
      event.type === "item/agentMessage/delta",
  );
  return delta?.itemId;
}

describe("omp delta translation equivalence", () => {
  it("keeps turn_start as internal noise while agent_start owns the bb turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "turn_start",
    });

    expect(events).toEqual([]);
  });

  it("agent_start opens exactly one bb turn", () => {
    const harness = createHarness();
    const events = harness.translate(loadFixture("agent-start.json"));
    expect(events).toEqual([
      expect.objectContaining({ type: "turn/started", threadId: "" }),
    ]);
    expect(harness.openTurnId()).toMatch(TURN_ID_PATTERN);
    expect(harness.translate(loadFixture("agent-start.json"))).toEqual([]);
  });

  it("explicitly settled agent_end emits agentMessage + turn/completed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      ...loadSettledAgentEndFixture(),
      providerCheckpointId: "omp-entry-42",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          text: "I've updated the configuration file to use the new database connection string. The change affects `/src/config/database.ts` and should resolve the timeout issues you were experiencing.",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
        providerCheckpointId: "omp-entry-42",
      }),
    );
    expect(events.some((event) => event.type === "provider/error")).toBe(false);
  });

  it("native agent_end without retry or settlement flags emits content and usage but no boundary", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const nativeEnd = loadFixture("agent-end-with-message.json");
    expect(nativeEnd).not.toHaveProperty("willRetry");
    expect(nativeEnd).not.toHaveProperty("deferSettlement");

    const deltas = translator.translate(nativeEnd, { threadId: THREAD_ID });

    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: "item.textClose",
        channel: "agentMessage",
        text: expect.stringContaining("I've updated the configuration file"),
      }),
    );
    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: "usage",
        last: expect.objectContaining({ totalTokens: 7736 }),
        modelContextWindow: 200_000,
      }),
    );
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(false);
  });

  it.each([
    { type: "agent_end", messageCount: 3 },
    { type: "agent_end", messageCount: 3, messages: [] },
    {
      type: "agent_end",
      messageCount: 3,
      messages: [{ role: "toolResult", content: [] }],
    },
  ])("completes messages before a trimmed agent_end without repeating content or usage: %j", (ending) => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    const streamedId = agentMessageDeltaId(
      harness.translate(createTextDeltaEvent()),
    );
    const earlier = harness.translate(createAssistantMessageEnd("Earlier answer"));
    harness.translate({
      type: "message_end",
      message: { role: "toolResult", content: [] },
    });
    const final = harness.translate(createAssistantMessageEnd("Final answer"));

    expect(earlier).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({
        type: "agentMessage", id: streamedId, text: "Earlier answer",
      }),
    }));
    const completed = final.find((event) => event.type === "item/completed");
    expect(completed?.item).toMatchObject({ type: "agentMessage", text: "Final answer" });
    expect(completed?.item.id).not.toBe(streamedId);
    expect(final).toContainEqual(expect.objectContaining({
      type: "thread/tokenUsage/updated",
      tokenUsage: expect.objectContaining({
        last: expect.objectContaining({ totalTokens: 5 }),
        total: expect.objectContaining({ totalTokens: 10 }),
        modelContextWindow: 200_000,
      }),
    }));
    expect(harness.translate(ending)).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);
    expect(harness.translate(ending)).toEqual([]);
  });

  it("isolates native message identities by both thread and parent tool", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const runs: Array<{ context: OmpTestContext; text: string }> = [
      { context: { threadId: "thread-a" }, text: "root a" },
      { context: { threadId: "thread-b" }, text: "root b" },
      { context: { threadId: "thread-a", parentToolCallId: "parent-a" }, text: "nested a" },
      { context: { threadId: "thread-a", parentToolCallId: "parent-b" }, text: "nested b" },
    ];
    const ids = new Set<string | undefined>();
    for (const { context, text } of runs) {
      const boundary = createAssistantMessageEnd(text, "msg-1");
      const deltas = translator.translate(boundary, context);
      const completed = deltas.find((delta) => delta.kind === "item.textClose");
      expect(completed).toMatchObject({
        kind: "item.textClose", text,
        ...(context.parentToolCallId
          ? { key: expect.objectContaining({ parentRef: context.parentToolCallId }) } : {}),
      });
      ids.add(completed?.key.providerItemId);
      expect(translator.translate(boundary, context)).toEqual([]);
      expect(translator.translate({ type: "agent_end" }, context)).toEqual([]);
    }
    expect(ids.size).toBe(runs.length);
  });

  it("uses sdk/message thread ids to isolate completed usage when context omits them", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    for (const [threadId, text] of [
      ["thread-a", "First thread"],
      ["thread-b", "Second thread"],
    ]) {
      const deltas = translator.translate(
        sdkMessage(createAssistantMessageEnd(text, "msg-1"), threadId),
      );
      expect(deltas).toContainEqual(expect.objectContaining({ kind: "item.textClose", text }));
      expect(deltas).toContainEqual(expect.objectContaining({
        kind: "usage", total: expect.objectContaining({ totalTokens: 5 }),
      }));
      expect(translator.translate(sdkMessage({ type: "agent_end" }, threadId))).toEqual([]);
    }
  });

  it("changes message generations on reset without losing accumulated usage", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const root = { threadId: "thread-a" };
    const other = { threadId: "thread-b" };
    const boundary = createAssistantMessageEnd("Answer", "msg-1");
    const first = translator.translate(boundary, root);
    translator.translate(boundary, other);
    translator.resetThread("thread-a");
    const resumed = translator.translate(boundary, root);
    const firstId = first.find((delta) => delta.kind === "item.textClose")?.key.providerItemId;
    const resumedId = resumed.find((delta) => delta.kind === "item.textClose")?.key.providerItemId;
    expect(resumedId).not.toBe(firstId);
    expect(resumed).toContainEqual(expect.objectContaining({
      kind: "usage", total: expect.objectContaining({ totalTokens: 10 }),
    }));
    expect(translator.translate(boundary, other)).toEqual([]);
    expect(translator.translate({ type: "agent_end" }, root)).toEqual([]);
  });

  it.each([undefined, "parent-a"])(
    "agent_start does not replay content from the preceding run under parent %s",
    (parentToolCallId) => {
      const translator = createOmpDeltaTranslator({
        resolveModelContextWindow: fixtureModelResolver,
      });
      const context = { threadId: THREAD_ID, parentToolCallId };
      translator.translate(createAssistantMessageEnd("Stale answer"), context);
      translator.translate({ type: "agent_start" }, context);
      expect(translator.translate({ type: "agent_end" }, context)).toEqual([]);
      expect(translator.translate(createAssistantMessageEnd("New answer"), context)).toContainEqual(
        expect.objectContaining({ kind: "item.textClose", text: "New answer" }),
      );
      expect(translator.translate({ type: "agent_end" }, context)).toEqual([]);
    },
  );

  it("replays real native RPC frames with one host-owned settlement boundary", () => {
    const frames = JSON.parse(
      readFileSync(resolve(FIXTURES, "real-rpc-stream.json"), "utf8"),
    ) as NativeOmpEvent[];
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const context = { threadId: THREAD_ID };
    const nativeDeltas = frames.flatMap((frame) =>
      translator.translate(frame, context),
    );

    expect(nativeDeltas.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(nativeDeltas.filter((delta) => delta.kind === "usage")).toHaveLength(1);
    const settlementDeltas = translator.translate(
      { type: "agent_end", settlementOnly: true },
      context,
    );
    const deltas = [...nativeDeltas, ...settlementDeltas];
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    const assembler = createDeltaAssembler({
      providerId: "omp",
      entropyPrefix: ENTROPY,
      textDeltaFlushMs: 0,
    });
    const events = assembler.assemble({ threadId: THREAD_ID, deltas });
    expect(
      events.filter(
        (event) =>
          event.type === "item/completed" && event.item.type === "agentMessage",
      ),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ type: "agentMessage", text: "Hi." }),
      }),
    ]);
    expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "provider/unhandled" || event.type === "provider/error",
      ),
    ).toBe(false);
  });

  it("completes extension-triggered turns when agent_end includes string custom content", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "agent_end",
      messages: [
        {
          role: "custom",
          customType: "omp-processes",
          content: "Process completed successfully",
          display: true,
          timestamp: 1777995780000,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "The process finished." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 1777995781000,
        },
      ],
      deferSettlement: false,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    );
    expect(events.some((event) => event.type === "provider/unhandled")).toBe(
      false,
    );
  });

  it("records a displayed OMP custom message as the input of the turn it triggered", () => {
    const harness = createHarness();
    harness.translate(sdkMessage(loadFixture("agent-start.json")));
    const turnId = harness.openTurnId();
    const message = createOmpCustomMessage({
      content:
        '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>',
    });

    const startEvents = harness.translate(
      sdkMessage({ type: "message_start", message }),
    );
    const endEvents = harness.translate(
      sdkMessage({ type: "message_end", message }),
    );

    expect(startEvents).toEqual([
      {
        type: "item/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "userMessage",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          content: [
            {
              type: "text",
              text: '<process_event kind="success" process_id="proc_551c">Process completed successfully</process_event>',
            },
          ],
        },
      },
    ]);
    expect(endEvents).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);
  });

  it("joins the text blocks of an array-content OMP custom message", () => {
    const harness = createHarness();
    harness.translate(sdkMessage(loadFixture("agent-start.json")));

    const events = harness.translate(
      sdkMessage({
        type: "message_start",
        message: createOmpCustomMessage({
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "text", text: "second" },
          ],
        }),
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "userMessage",
          content: [{ type: "text", text: "first\nsecond" }],
        }),
      }),
    ]);
  });

  it("drops hidden and idle OMP custom messages without surfacing them as unhandled", () => {
    const harness = createHarness();

    const idleMessage = createOmpCustomMessage({ content: "idle context note" });
    expect(
      harness.translate(
        sdkMessage({ type: "message_start", message: idleMessage }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        sdkMessage({ type: "message_end", message: idleMessage }),
      ),
    ).toEqual([]);
    expect(harness.openTurnId()).toBe("");

    harness.translate(sdkMessage(loadFixture("agent-start.json")));
    const hiddenMessage = createOmpCustomMessage({
      content: "hidden",
      display: false,
    });
    expect(
      harness.translate(
        sdkMessage({ type: "message_start", message: hiddenMessage }),
      ),
    ).toEqual([]);
    expect(
      harness.translate(
        sdkMessage({ type: "message_end", message: hiddenMessage }),
      ),
    ).toEqual([]);
  });

  it("agent_end preserves the checkpoint when OMP assistant stop errors fail the turn", () => {
    const harness = createHarness();
    const quotaMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CajgGfxCAhmznZJw7t6Br"}';

    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      ...createOmpAgentErrorEvent(quotaMessage),
      deferSettlement: false,
      providerCheckpointId: "omp-failed-entry",
    });

    expect(events).toEqual([
      {
        type: "provider/error",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: quotaMessage,
      },
      {
        type: "turn/completed",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        status: "failed",
        providerCheckpointId: "omp-failed-entry",
      },
    ]);
    expect(events.some((event) => event.type === "item/completed")).toBe(false);
  });

  it("keeps the OMP turn active across native recovery until synthetic settlement", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const retryEvents = harness.translate({
      ...createOmpAgentErrorEvent("temporary provider failure"),
      deferSettlement: true,
    });
    const recoveredEvents = harness.translate(
      loadFixture("agent-end-with-message.json"),
    );

    expect(retryEvents).toEqual([]);
    expect(
      recoveredEvents.some((event) => event.type === "turn/completed"),
    ).toBe(false);
    expect(harness.openTurnId()).toBe(turnId);

    const settledEvents = harness.translate({
      type: "agent_end",
      settlementOnly: true,
      providerCheckpointId: "recovered-entry",
    });
    expect(settledEvents).toEqual([
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
        providerCheckpointId: "recovered-entry",
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("auto_compaction_start emits a compaction item in the open turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "auto_compaction_start",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        },
      }),
    ]);
  });

  it("auto_compaction_end without a reason emits thread/compacted", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({
      type: "auto_compaction_start",
    });

    const events = harness.translate({
      type: "auto_compaction_end",
      aborted: false,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/compacted",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
      }),
    );
  });

  it("skipped automatic compaction emits neither compaction success nor a boundary", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({ type: "auto_compaction_start" });

    const events = harness.translate({
      type: "auto_compaction_end",
      aborted: false,
      skipped: true,
    });

    expect(events).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);
  });

  it.each([
    {
      label: "failed",
      end: { aborted: false, errorMessage: "Automatic compaction overflowed" },
      detail: "Automatic compaction overflowed",
    },
    {
      label: "aborted",
      end: { aborted: true },
      detail: "Automatic context compaction was interrupted",
    },
  ])("terminates a $label automatic compaction", ({ end, detail }) => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate({
      type: "auto_compaction_start",
    });

    const events = harness.translate({
      type: "auto_compaction_end",
      ...end,
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        detail,
      }),
    );
    expect(events.some((event) => event.type === "thread/compacted")).toBe(
      false,
    );
  });

  function translateManualCompaction(args: {
    aborted: boolean;
    errorMessage?: string;
  }) {
    const harness = createHarness();
    const started = harness.translate({
      type: "bb_compaction_start",
    });
    const turnId = harness.openTurnId();
    const completed = harness.translate({
      type: "bb_compaction_end",
      ...args,
    });
    return { completed, started, turnId };
  }

  it("manual compaction owns a complete maintenance turn", () => {
    const { completed, started, turnId } = translateManualCompaction({
      aborted: false,
    });

    expect(started.map((event) => event.type)).toEqual([
      "turn/started",
      "item/started",
    ]);
    expect(completed).toEqual([
      expect.objectContaining({
        type: "thread/compacted",
        scope: turnScope(turnId),
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "completed",
      }),
    ]);
  });

  it.each([
    "Nothing to compact (session too small)",
    "Nothing to compact (session too small or already rolled over)",
    "Already compacted",
  ])(
    "manual compaction refusal %j completes the turn as a no-op",
    (errorMessage) => {
      const { completed, turnId } = translateManualCompaction({
        aborted: false,
        errorMessage,
      });

      expect(completed).toEqual([
        expect.objectContaining({
          type: "provider/warning",
          scope: turnScope(turnId),
          category: "compaction-skipped",
          summary: "Context compaction skipped",
          details: errorMessage,
        }),
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(turnId),
          status: "completed",
        }),
      ]);
      expect(completed.some((event) => event.type === "thread/compacted")).toBe(
        false,
      );
    },
  );

  it.each([
    {
      label: "failed",
      args: {
        aborted: false,
        errorMessage: "Summarization failed: 500",
      },
      expected: {
        status: "failed",
        error: {
          message: "Summarization failed: 500",
        },
      },
    },
    {
      label: "aborted",
      args: { aborted: true },
      expected: { status: "interrupted" },
    },
  ])(
    "$label manual compaction does not report success",
    ({ args, expected }) => {
      const { completed, turnId } = translateManualCompaction(args);
      expect(completed).toEqual([
        expect.objectContaining({
          type: "turn/completed",
          scope: turnScope(turnId),
          ...expected,
        }),
      ]);
    },
  );

  it.each([
    {
      label: "succeeds",
      end: loadFixture("manual-compaction-end-18.13.3.json"),
      status: "completed",
      payload: { severity: "info", message: "Context compaction completed" },
    },
    {
      label: "fails",
      end: {
        type: "manual_compaction_end",
        aborted: false,
        errorMessage: "Summarization failed: 500",
      },
      status: "failed",
      payload: {
        severity: "error",
        message: "Context compaction failed",
        instructions: "Summarization failed: 500",
      },
    },
  ])("manual compaction $label updates its provider-owned notice", ({ end, status, payload }) => {
    const harness = createHarness();
    const started = harness.translate(loadFixture("manual-compaction-start-18.13.3.json"));
    const turnId = harness.openTurnId();
    const start = started.find((event) => event.type === "item/started");
    expect(start).toEqual(expect.objectContaining({
      scope: turnScope(turnId),
      item: expect.objectContaining({
        type: "extension",
        kind: OMP_NOTICE_KIND,
        status: "pending",
        payload: { severity: "info", message: "Compacting context" },
      }),
    }));
    expect(harness.translate(loadFixture("manual-compaction-start-18.13.3.json"))).toEqual([]);


    const completed = harness.translate(end);
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "item/completed",
        scope: turnScope(turnId),
        item: expect.objectContaining({
          id: start?.item.id,
          type: "extension",
          kind: OMP_NOTICE_KIND,
          status,
          payload,
        }),
      }),
      expect.objectContaining({ type: "turn/completed", scope: turnScope(turnId), status }),
    ]));
    expect(harness.openTurnId()).toBe("");
    expect(harness.translate(end)).toEqual([]);
  });

  it("recovers a manual compaction end after reconnect", () => {
    const harness = createHarness();
    harness.translate(loadFixture("manual-compaction-start-18.13.3.json"));
    harness.resetThread();
    const completed = harness.translate(loadFixture("manual-compaction-end-18.13.3.json"));
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "extension",
          kind: OMP_NOTICE_KIND,
          status: "completed",
          payload: { severity: "info", message: "Context compaction completed" },
        }),
      }),
      expect.objectContaining({ type: "turn/completed", status: "completed" }),
    ]));
    expect(harness.openTurnId()).toBe("");
  });

  it("suppresses native lifecycle notices inside a synthetic compaction", () => {
    const harness = createHarness();
    harness.translate({ type: "bb_compaction_start" });
    expect(harness.translate(loadFixture("manual-compaction-start-18.13.3.json"))).toEqual([]);
    expect(harness.translate(loadFixture("manual-compaction-end-18.13.3.json"))).toEqual([]);
    expect(harness.translate({ type: "bb_compaction_end", aborted: false })).toContainEqual(
      expect.objectContaining({ type: "thread/compacted" }),
    );
  });


  it("auto_compaction_end without a known turn is unhandled", () => {
    const harness = createHarness();
    const events = harness.translate({
      type: "auto_compaction_end",
      aborted: false,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "omp",
        rawType: "sdk/auto_compaction_end",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
  });

  it("auto_compaction_start reuses the last completed turn id without opening a new turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadSettledAgentEndFixture());

    const events = harness.translate({
      type: "auto_compaction_start",
    });

    expect(events).toEqual([
      {
        type: "item/started",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        item: {
          type: "contextCompaction",
          id: expect.stringMatching(ITEM_ID_PATTERN),
        },
      },
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("late automatic compaction completion attaches to the last completed turn", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadSettledAgentEndFixture());
    harness.translate({ type: "auto_compaction_start" });

    const events = harness.translate({
      type: "auto_compaction_end",
      aborted: false,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "thread/compacted",
        scope: turnScope(turnId),
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("reuses the streamed assistant item id when the turn ends", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const deltaEvents = harness.translate(createTextDeltaEvent());
    const deltaItemId = agentMessageDeltaId(deltaEvents);
    const completedEvents = harness.translate(
      loadSettledAgentEndFixture(),
    );

    expect(deltaItemId).toMatch(ITEM_ID_PATTERN);
    expect(deltaEvents.map((event) => event.type)).toEqual([
      "item/started",
      "item/agentMessage/delta",
    ]);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "agentMessage",
          id: deltaItemId,
        }),
      }),
    );
  });

  it("keeps native assistant identity when another item opens during its stream", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const preDelta = harness.translate({ ...createTextDeltaEvent(), messageId: "msg-1" });
    const preItemId = agentMessageDeltaId(preDelta);

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "ls" },
    });

    const postDelta = harness.translate({ ...createTextDeltaEvent(), messageId: "msg-1" });
    const postItemId = agentMessageDeltaId(postDelta);

    const endEvents = harness.translate(
      loadSettledAgentEndFixture(),
    );
    const completed = endEvents.find(
      (event) =>
        event.type === "item/completed" && event.item.type === "agentMessage",
    );

    expect(preItemId).toMatch(ITEM_ID_PATTERN);
    expect(postItemId).toMatch(ITEM_ID_PATTERN);
    expect(preItemId).toBe(postItemId);
    expect(completed).toBeDefined();
    if (
      completed?.type === "item/completed" &&
      completed.item.type === "agentMessage"
    ) {
      expect(completed.item.id).toBe(postItemId);
    }
  });

  it("streams and finalizes OMP thinking with a stable reasoning id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const deltaEvents = harness.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Thinking through the edit.",
      },
    });
    const reasoningDelta = deltaEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "item/reasoning/textDelta" }> =>
        event.type === "item/reasoning/textDelta",
    );

    const completedEvents = harness.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Thinking through the edit.",
      },
    });

    expect(reasoningDelta?.itemId).toMatch(ITEM_ID_PATTERN);
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "reasoning",
          id: reasoningDelta?.itemId,
          content: ["Thinking through the edit."],
        }),
      }),
    );
  });

  it("surfaces OMP thinking without contentIndex as provider/unhandled", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "Thinking without a scope.",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "omp",
        rawType: "sdk/message_update:thinking_delta",
        scope: turnScope(turnId),
      }),
    ]);
  });

  describe("narration thinking", () => {
    type Item = Extract<ThreadEvent, { type: "item/completed" }>["item"];

    // What bb shows: settled items in first-appearance order. Blank reasoning
    // renders no row; an item that never settled is flagged.
    function rendered(events: ThreadEvent[]): string[] {
      const order: string[] = [];
      const items = new Map<string, { item: Item; completed: boolean }>();
      for (const event of events) {
        if (event.type !== "item/started" && event.type !== "item/completed") continue;
        if (!items.has(event.item.id)) order.push(event.item.id);
        items.set(event.item.id, { item: event.item, completed: event.type === "item/completed" });
      }
      return order.flatMap((id) => {
        const { item, completed } = items.get(id)!;
        if (!completed) return [`open ${item.type}`];
        if (item.type === "reasoning") {
          const text = item.content.join("").trim();
          return text ? [`reasoning: ${text}`] : [];
        }
        if (item.type === "agentMessage") return [`answer: ${item.text}`];
        return [item.type];
      });
    }

    function assistant(content: unknown[], stopReason = "toolUse") {
      return {
        role: "assistant", content, api: "anthropic-messages", provider: "anthropic",
        model: "claude-opus-5-5", stopReason, usage: { input: 2, output: 3, totalTokens: 5 },
        timestamp: 1777995781000,
      };
    }

    function update(messageId: string, assistantMessageEvent: Record<string, unknown>) {
      return { type: "message_update", messageId, assistantMessageEvent };
    }

    function start(messageId: string, api = "anthropic-messages") {
      return { type: "message_start", messageId, message: { role: "assistant", content: [], api } };
    }

    function tool(toolCallId: string): unknown[] {
      return [
        { type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } },
        {
          type: "tool_execution_end", toolCallId, toolName: "bash",
          result: { content: [{ type: "text", text: "ok" }] },
        },
      ];
    }

    function streamThinking(messageId: string, contentIndex: number, text: string): unknown[] {
      return [
        update(messageId, { type: "thinking_delta", contentIndex, delta: text }),
        update(messageId, { type: "thinking_end", contentIndex, content: text }),
      ];
    }

    it("renders narration between tool calls as answer text and keeps real thinking as reasoning", () => {
      const harness = createHarness();
      const events = [
        { type: "agent_start" },
        start("m1"),
        ...streamThinking("m1", 0, "Plan the listing."),
        ...streamThinking("m1", 1, "Listing the repo first."),
        {
          type: "message_end", messageId: "m1", message: assistant([
            { type: "thinking", thinking: "Plan the listing.", thinkingSignature: "s0" },
            { type: "thinking", thinking: "Listing the repo first.", thinkingSignature: "s1", narration: true },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
          ]),
        },
        ...tool("t1"),
        start("m2"),
        ...streamThinking("m2", 0, "Found it; checking tests next."),
        {
          type: "message_end", messageId: "m2", message: assistant([
            { type: "thinking", thinking: "Found it; checking tests next.", thinkingSignature: "s2", narration: true },
            { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } },
          ]),
        },
        ...tool("t2"),
        start("m3"),
        update("m3", { type: "text_delta", contentIndex: 0, delta: "Done." }),
        { type: "message_end", messageId: "m3", message: assistant([{ type: "text", text: "Done." }], "stop") },
      ].flatMap((event) => harness.translate(event));

      expect(rendered(events)).toEqual([
        "reasoning: Plan the listing.",
        "answer: Listing the repo first.",
        "toolCall",
        "answer: Found it; checking tests next.",
        "toolCall",
        "answer: Done.",
      ]);
    });

    it.each([
      { api: "anthropic-messages", settlesAt: "message_end" },
      { api: "openai-responses", settlesAt: "thinking_end" },
    ])("settles $api thinking as reasoning at $settlesAt", ({ api, settlesAt }) => {
      const harness = createHarness();
      harness.translate({ type: "agent_start" });
      harness.translate(start("m1", api));
      const [delta, end] = streamThinking("m1", 0, "Weighing options.");
      const streamed = [...harness.translate(delta), ...harness.translate(end)];
      const completed = harness.translate({
        type: "message_end", messageId: "m1",
        message: { ...assistant([
          { type: "thinking", thinking: "Weighing options.", thinkingSignature: "s0" },
          { type: "text", text: "Answer." },
        ], "stop"), api },
      });
      const settled = settlesAt === "thinking_end" ? streamed : completed;
      expect(rendered([...streamed, ...completed])).toEqual(["reasoning: Weighing options.", "answer: Answer."]);
      expect(settled.some((event) => event.type === "item/completed" && event.item.type === "reasoning")).toBe(true);
    });

    it("presents narration from a message_end-only snapshot in content order", () => {
      const harness = createHarness();
      harness.translate({ type: "agent_start" });
      const events = harness.translate({
        type: "message_end", messageId: "m1", message: assistant([
          { type: "thinking", thinking: "Private reasoning.", thinkingSignature: "s0" },
          { type: "thinking", thinking: "Here is what I found.", thinkingSignature: "s1", narration: true },
          { type: "text", text: "Final answer." },
        ], "stop"),
      });
      expect(rendered(events)).toEqual([
        "reasoning: Private reasoning.",
        "answer: Here is what I found.\nFinal answer.",
      ]);
    });

    it("retracts streamed narration as soon as a full thinking_end frame flags it", () => {
      const harness = createHarness();
      harness.translate({ type: "agent_start" });
      const narration = { type: "thinking", thinking: "Checking the logs.", thinkingSignature: "s0", narration: true };
      const streamed = [
        ...harness.translate(update("m1", { type: "thinking_delta", contentIndex: 0, delta: "Checking the logs." })),
        ...harness.translate(update("m1", {
          type: "thinking_end", contentIndex: 0, content: "Checking the logs.",
          partial: assistant([narration]),
        })),
      ];
      expect(streamed).toContainEqual(expect.objectContaining({
        type: "item/agentMessage/delta", delta: "Checking the logs.",
      }));
      const completed = harness.translate({
        type: "message_end", messageId: "m1", message: assistant([
          narration, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
        ]),
      });
      expect(rendered([...streamed, ...completed])).toEqual(["answer: Checking the logs."]);
    });

    it("never duplicates narration that already settled as reasoning", () => {
      const harness = createHarness();
      harness.translate({ type: "agent_start" });
      // No message_start: thinking settles eagerly at thinking_end.
      const events = [
        ...streamThinking("m1", 0, "Checking the logs."),
        {
          type: "message_end", messageId: "m1", message: assistant([
            { type: "thinking", thinking: "Checking the logs.", thinkingSignature: "s0", narration: true },
            { type: "text", text: "Answer." },
          ], "stop"),
        },
      ].flatMap((event) => harness.translate(event));
      expect(rendered(events)).toEqual(["reasoning: Checking the logs.", "answer: Answer."]);
    });
  });

  it("ignores object image_end content in native delta-projected message updates", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    const event = {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "image_end",
        contentIndex: 1,
        content: { type: "image", data: "AAAA", mimeType: "image/png" },
      },
    };

    expect(harness.translate(event)).toEqual([]);
    expect(harness.translate(sdkMessage(event))).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);
    expect(harness.translate(createTextDeltaEvent())).toContainEqual(
      expect.objectContaining({
        type: "item/agentMessage/delta",
        delta: "current",
      }),
    );
  });

  it("tool_execution_start emits item/started with an assembler-minted id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "commandExecution",
          id: expect.stringMatching(ITEM_ID_PATTERN),
          status: "pending",
        }),
      }),
    ]);
    const startedId =
      events[0]?.type === "item/started" ? events[0].item.id : "";
    expect(harness.assembler.getProviderItemId(THREAD_ID, startedId)).toBe(
      "tc_01a2b3c4d5e6f7g8h9i0j1k2",
    );
  });

  it("keeps the call's own cwd over the session's", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
      { threadId: THREAD_ID, cwd: "/work/tree" },
    );
    expect(events[0]).toMatchObject({
      type: "item/started",
      item: { type: "commandExecution", cwd: "/Users/developer/project" },
    });
  });

  it("never fabricates a command item without a cwd, on start or on a close without start", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate(
      sdkMessage({
        type: "tool_execution_start",
        toolCallId: "tool-bash-nocwd",
        toolName: "bash",
        args: { command: "ls" },
      }),
    );
    expect(started[0]).toMatchObject({
      type: "item/started",
      item: { type: "toolCall" },
    });
    const closed = harness.translate(
      sdkMessage({
        type: "tool_execution_end",
        toolCallId: "tool-bash-unseen",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      }),
    );
    expect(
      closed.some(
        (event) =>
          event.type === "item/started" || event.type === "item/completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(closed)).not.toContain('"cwd":""');
    expect(
      closed.every(
        (event) => !("item" in event) || event.item.type !== "commandExecution",
      ),
    ).toBe(true);
  });

  it("maps parent_tool_use_id on nested sdk/message events to the parent's minted id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "omp-thread-1",
        parent_tool_use_id: "agent-parent-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: { command: "ls", cwd: "/repo" },
        },
      },
    });

    const started = events.find(
      (event) =>
        event.type === "item/started" && event.item.type === "commandExecution",
    );
    if (started?.type !== "item/started") {
      throw new Error("expected a commandExecution item/started");
    }
    expect(started.item.parentToolCallId).toBeDefined();
    expect(started.item.parentToolCallId).not.toBe("agent-parent-1");
    const parentEvents = harness.translate({
      type: "tool_execution_start",
      toolCallId: "agent-parent-1",
      toolName: "spawn_agent",
      args: {},
    });
    expect(parentEvents).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          id: started.item.parentToolCallId,
        }),
      }),
    );
  });

  it("falls back to a generic tool call when bash args are malformed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: 42 },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/started",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bash",
          status: "pending",
        }),
      }),
    );
  });

  it.each([
    { pendingRequestIds: ["omp-ui-1"] },
    { pendingRequestIds: [] },
  ])("publishes extension UI state without a turn: %j", ({ pendingRequestIds }) => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const state = {
      coordinatorId: "ui-coordinator-1",
      issuedThrough: 1,
      pendingRequestIds,
    };
    const message = { type: "bb_extension_ui_state", ...state };

    for (const event of [message, sdkMessage(message)]) {
      expect(translator.translate(event)).toEqual([
        {
          kind: "extension.state",
          extensionKind: "provider-omp/extension-ui-state",
          payload: state,
        },
      ]);
    }
  });

  it.each([
    { type: "agent_end", messages: "not an array" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 7 } },
    { type: "tool_execution_start", toolName: "task", args: {} },
    { type: "tool_execution_end", toolCallId: "task-1", toolName: "task", isError: "yes" },
    { type: "auto_compaction_end", aborted: "no" },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2_000 },
    { type: "auto_retry_end", success: "yes", attempt: 1 },
    { type: "retry_fallback_applied", from: "original", to: "fallback" },
    { type: "notice", level: "debug", message: "Unsupported severity" },
    { type: "bb_extension_ui_state", pendingRequestIds: [] },
    {
      type: "bb_extension_ui_state",
      coordinatorId: "ui-coordinator-1",
      pendingRequestIds: [],
    },
    {
      type: "bb_extension_ui_state",
      issuedThrough: 1,
      pendingRequestIds: [],
    },
    {
      type: "bb_extension_ui_state",
      coordinatorId: 1,
      issuedThrough: 1,
      pendingRequestIds: [],
    },
    {
      type: "bb_extension_ui_state",
      coordinatorId: "ui-coordinator-1",
      issuedThrough: "1",
      pendingRequestIds: [],
    },
    {
      type: "bb_extension_ui_state",
      coordinatorId: "ui-coordinator-1",
      issuedThrough: 1,
      pendingRequestIds: "omp-ui-1",
    },
    {
      type: "bb_extension_ui_state",
      coordinatorId: "ui-coordinator-1",
      issuedThrough: 1,
      pendingRequestIds: [1],
    },
  ])("surfaces malformed known native events as provider/unhandled: %j", (message) => {
    const harness = createHarness();

    for (const event of [message, sdkMessage(message)]) {
      expect(harness.translate(event)).toEqual([
        expect.objectContaining({
          type: "provider/unhandled",
          providerId: "omp",
          rawType: message.type === "message_update"
            ? "sdk/message_update:text_delta"
            : `sdk/${message.type}`,
          scope: threadScope(),
          rawEvent: expect.objectContaining({ method: "sdk/message" }),
        }),
      ]);
    }
  });

  it.each([
    { type: "available_commands_update", commands: [] },
    { type: "extension_ui_request", id: "notice", method: "notify", message: "Ready" },
    { type: "tool_call", toolCallId: "task-1", toolName: "task" },
    { type: "session_settled" },
    { type: "prompt_result", id: "prompt-1", status: "completed", sessionSettled: true },
    { type: "config_warnings_changed" },
    { type: "retry_fallback_succeeded", model: "fallback", role: "default" },
    { type: "future_event", value: true },
  ])("ignores unknown native event $type, raw and wrapped, while active or idle", (message) => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    expect(harness.translate(message)).toEqual([]);
    expect(harness.translate(sdkMessage(message))).toEqual([]);
    expect(harness.openTurnId()).toBe(turnId);

    harness.translate(loadSettledAgentEndFixture());

    expect(harness.translate(message)).toEqual([]);
    expect(harness.translate(sdkMessage(message))).toEqual([]);
    expect(harness.openTurnId()).toBe("");
  });

  describe("display-heavy generic tools", () => {
    const cases = [
      { toolName: "read", args: { path: "src/app.ts:2-4" }, details: { resolvedPath: "/repo/src/app.ts" } },
      { toolName: "read", args: { path: "src" }, details: { resolvedPath: "/repo/src", isDirectory: true } },
      { toolName: "read", args: { path: "https://example.com/docs:raw" }, details: { kind: "url", url: "https://example.com/docs" } },
      { toolName: "grep", args: { pattern: "needle", path: "src" } },
      { toolName: "glob", args: { path: "src/**/*.ts" } },
      { toolName: "find", args: { query: "Locate auth", path: "src" } },
      { toolName: "ast_grep", args: { pat: "$CALL($$$ARGS)", path: "src" } },
      { toolName: "web_search", args: { query: "site:example.com auth" } },
      { toolName: "write", args: { path: "src/app.ts", content: "updated\n" } },
      { toolName: "write", args: { path: "xd://think", content: '{"thoughts":"Compare paths"}' }, details: { xdev: { tool: "think", mode: "execute", inner: { content: [{ type: "text", text: "Inner output" }] } } } },
      { toolName: "edit", args: { path: "src/app.ts", oldText: "before", newText: "after" } },
      { toolName: "edit", args: { path: "src/app.ts", edits: [{ oldText: "before", newText: "after" }] } },
      { toolName: "edit", args: { path: "src/app.ts", edits: [{ old: "before", replacement: "after" }] } },
      { toolName: "edit", args: "*** Begin Patch\n*** End Patch" },
    ];

    it.each(cases)("opens $toolName immediately and preserves its raw result at completion", ({ toolName, args, details }) => {
      const expectedArgs = typeof args === "string" ? { input: args } : args;
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const started = harness.translate({
        type: "tool_execution_start", toolCallId: "display-tool", toolName, args,
      }).find((event) => event.type === "item/started");
      expect(started?.item).toMatchObject({
        type: "toolCall", tool: toolName, status: "pending", arguments: expectedArgs,
      });
      const result = {
        content: [{ type: "text", text: "Full output\nartifact://retained-output" }],
        details: { ...details, artifact: "artifact://retained-output" },
      };
      const completed = harness.translate({
        type: "tool_execution_end", toolCallId: "display-tool", toolName, result,
      }).find((event) => event.type === "item/completed");
      expect(completed?.item).toMatchObject({
        id: started?.item.id, type: "toolCall", tool: toolName, status: "completed",
        arguments: expectedArgs, result,
      });
    });

    describe.each(["read", "grep", "glob", "find", "ast_grep", "web_search", "write", "edit"])(
      "%s terminal fallback",
      (toolName) => {
        it.each([
          { result: { content: [{ type: "text", text: "Output" }], details: { resolvedPath: "/repo/a.ts" } }, failed: false },
          { result: { content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }, failed: false },
          { result: { isError: true, content: [{ type: "text", text: "Raw failure\nartifact://failure" }] }, failed: true },
          { result: "Raw string result", failed: false },
          { result: null, failed: false },
          { result: undefined, failed: false },
        ])("preserves raw $result without a native row", ({ result, failed }) => {
          const translator = createOmpDeltaTranslator({ resolveModelContextWindow: fixtureModelResolver });
          const deltas = translator.translate({
            type: "tool_execution_end", toolCallId: "orphan-display-tool", toolName, result,
          }, { threadId: THREAD_ID, cwd: "/repo" });
          const closed = deltas.find((delta) => delta.kind === "item.close");
          expect(closed).toMatchObject({
            status: failed ? "failed" : "completed",
            item: { type: "tool", tool: toolName, args: undefined },
          });
          if (closed?.kind !== "item.close" || closed.item?.type !== "tool") {
            throw new Error("Expected a generic terminal tool");
          }
          expect(closed.item.result).toBe(result);
          expect(deltas.filter((delta) => delta.kind === "item.open")).toHaveLength(0);
        });
      },
    );

    it.each(cases)("preserves $toolName arguments, intent and raw errors through the bridge", ({ toolName, args }) => {
      const expectedArgs = typeof args === "string" ? { input: args } : args;
      const translator = createOmpDeltaTranslator({ resolveModelContextWindow: fixtureModelResolver });
      const context = { threadId: THREAD_ID, cwd: "/repo" };
      const opened = translator.translate({
        type: "tool_execution_start", toolCallId: "raw-display-tool", toolName, args,
        intent: "Inspecting relevant definitions",
      }, context).find((delta) => delta.kind === "item.open");
      expect(opened).toMatchObject({
        item: { type: "tool", tool: toolName, args: expectedArgs },
        presentation: { title: "Inspecting relevant definitions" },
      });
      if (opened?.kind !== "item.open" || opened.item.type !== "tool") {
        throw new Error("Expected a generic tool start");
      }
      expect(opened.item.args).toEqual(expectedArgs);
      if (typeof args !== "string") expect(opened.item.args).toBe(args);
      const result = { isError: true, content: [{ type: "text", text: "Raw failure" }], details: { artifact: "artifact://failure" } };
      const closed = translator.translate({
        type: "tool_execution_end", toolCallId: "raw-display-tool", toolName, result,
      }, context).find((delta) => delta.kind === "item.close");
      expect(closed).toMatchObject({
        status: "failed", item: { type: "tool", tool: toolName, args: expectedArgs, result },
        presentation: { title: "Inspecting relevant definitions" },
      });
      if (closed?.kind !== "item.close" || closed.item?.type !== "tool") {
        throw new Error("Expected a generic tool completion");
      }
      expect(closed.item.result).toBe(result);
      expect(closed.item.args).toBe(opened.item.args);
    });
  });

  it("keeps direct think calls native reasoning through completion", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = [
      ...harness.translate({
        type: "tool_execution_start", toolCallId: "native-think", toolName: "think",
        args: { thoughts: "Compare the two paths." },
      }),
      ...harness.translate({
        type: "tool_execution_end", toolCallId: "native-think", toolName: "think",
        result: { content: [{ type: "text", text: "Thought recorded" }] },
      }),
    ];
    expect(events).toContainEqual(expect.objectContaining({
      type: "item/started", item: expect.objectContaining({ type: "reasoning", content: ["Compare the two paths."] }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "item/completed", item: expect.objectContaining({ type: "reasoning", content: ["Compare the two paths."] }),
    }));
  });

  it("preserves native bash and background-job lifecycle through wait", () => {
    const translator = createOmpDeltaTranslator({ resolveModelContextWindow: fixtureModelResolver });
    const context = { threadId: THREAD_ID, cwd: "/repo" };
    const started = translator.translate({
      type: "tool_execution_start", toolCallId: "native-bash", toolName: "bash",
      args: { command: "long-command", cwd: "/repo", async: true },
    }, context);
    expect(started).toContainEqual(expect.objectContaining({
      kind: "item.open", item: { type: "command", command: "long-command", cwd: "/repo" },
    }));
    const dispatched = translator.translate({
      type: "tool_execution_end", toolCallId: "native-bash", toolName: "bash",
      result: { content: [{ type: "text", text: "Dispatched" }], details: { async: { state: "running", jobId: "bg_1", type: "bash" } } },
    }, context);
    expect(dispatched).toContainEqual(expect.objectContaining({
      kind: "item.close", item: expect.objectContaining({ type: "command", command: "long-command" }),
    }));
    const job = dispatched.find((delta) => delta.kind === "item.open" && delta.item.type === "backgroundTask");
    expect(job).toMatchObject({
      kind: "item.open", item: { type: "backgroundTask", status: "pending", taskStatus: "running" },
    });
    const waitArgs = { i: "Waiting for background command" };
    expect(translator.translate({
      type: "tool_execution_start", toolCallId: "native-wait", toolName: "wait", args: waitArgs,
    }, context)).toContainEqual(expect.objectContaining({
      kind: "item.open", item: { type: "tool", tool: "wait", args: waitArgs },
    }));
    const waited = translator.translate({
      type: "tool_execution_end", toolCallId: "native-wait", toolName: "wait",
      result: { details: { op: "wait", jobs: [{ id: "bg_1", type: "bash", status: "completed", resultText: "Finished", exitCode: 0 }] } },
    }, context);
    expect(waited).toContainEqual(expect.objectContaining({
      kind: "item.close", item: expect.objectContaining({ type: "tool", tool: "wait", args: waitArgs }),
    }));
    expect(waited).toContainEqual(expect.objectContaining({
      kind: "item.close", key: job && "key" in job ? job.key : undefined,
      item: expect.objectContaining({ type: "backgroundTask", status: "completed", taskStatus: "completed" }),
    }));
  });

  it.each([
    {
      toolName: "task",
      args: {
        agent: "explore",
        tasks: [
          {
            id: "find-auth",
            description: "Find auth",
            assignment: "Locate authentication",
          },
        ],
      },
      result: {
        content: [{ type: "text", text: "Found auth.ts" }],
        details: { tasks: [{ id: "find-auth", status: "completed" }] },
      },
    },
    {
      toolName: "todo",
      args: {
        todos: [{ id: "inspect", content: "Inspect source", status: "completed" }],
      },
      result: {
        content: [{ type: "text", text: "1 item updated" }],
        details: { todos: [{ id: "inspect", status: "completed" }] },
      },
    },
    {
      toolName: "ask",
      args: {
        questions: [
          {
            id: "mode",
            question: "Choose a mode",
            options: [{ label: "Safe" }],
          },
        ],
      },
      result: {
        content: [{ type: "text", text: "Safe" }],
        details: { answers: [{ id: "mode", value: "Safe" }] },
      },
    },
  ])("preserves native $toolName arguments and structured results as a generic tool call", ({ toolName, args, result }) => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const startedEvents = harness.translate({
      type: "tool_execution_start",
      toolCallId: "native-tool-1",
      toolName,
      args,
    });
    const started = startedEvents.find((event) => event.type === "item/started");
    expect(started?.item).toMatchObject({
      type: "toolCall",
      tool: toolName,
      status: "pending",
    });
    expect(started?.item).toHaveProperty("arguments", args);

    const completedEvents = harness.translate({
      type: "tool_execution_end",
      toolCallId: "native-tool-1",
      toolName,
      result,
    });
    const completed = completedEvents.find(
      (event) => event.type === "item/completed",
    );
    expect(completed?.item).toMatchObject({
      type: "toolCall",
      id: started?.item.id,
      tool: toolName,
      status: "completed",
    });
    expect(completed?.item).toHaveProperty("arguments", args);
    expect(completed?.item).toHaveProperty("result", result);
  });

  describe("eval and Tool Gateway semantic presentation", () => {
    const cases = [
      {
        toolName: "eval",
        name: "Python",
        args: {
          language: "py",
          code: "print('chart')\nprint(2)",
          title: null,
          timeout: 0,
          reset: false,
        },
        intent: undefined,
        preview: "print('chart') print(2)",
        label: { pending: "Running Python", completed: "Ran Python" },
        result: {
          content: [
            { type: "text", text: "chart\n2\n" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          details: {
            cells: [{ id: "cell-py", language: "py", output: "chart\n2\n" }],
            async: { state: "running", id: "eval-py", startedAt: 123 },
          },
        },
      },
      {
        toolName: "eval",
        name: "JavaScript",
        args: {
          language: "js",
          code: "console.log('chart');\nconsole.log(2);",
          title: "Ran eval",
          timeout: 0,
          reset: false,
        },
        intent: "Running JavaScript",
        preview: "console.log('chart'); console.log(2);",
        label: { pending: "Running JavaScript", completed: "Ran JavaScript" },
        result: {
          content: [
            { type: "text", text: "chart\n2\n" },
            { type: "image", mimeType: "image/jpeg", data: "anBlZw==" },
          ],
          details: {
            cells: [{ id: "cell-js", language: "js", output: "chart\n2\n" }],
            async: { state: "running", id: "eval-js", startedAt: 456 },
          },
        },
      },
      {
        toolName: "tool_gateway_code_search",
        name: "Gateway signature search",
        args: {
          query: "  buildkite failed jobs\nand log signatures  ",
          i: "Discovering Tool Gateway signatures",
          limit: 4,
        },
        intent: undefined,
        preview: "buildkite failed jobs and log signatures",
        label: {
          pending: "Discovering Tool Gateway signatures",
          completed: "Discovered Tool Gateway signatures",
        },
        result:
          "# Buildkite signatures\n\n```ts\ngetJobLog(jobId: string): Promise<string>\n```\n",
      },
      {
        toolName: "tool_gateway_code_execute",
        name: "Gateway execution",
        args: {
          code: "const result = await buildkite.getJobs('build-1');\nreturn result;",
          i: "Running Tool Gateway program",
          title: null,
          timeout_secs: 60,
        },
        intent: "Ran eval",
        preview: "const result = await buildkite.getJobs('build-1'); return result;",
        label: {
          pending: "Running Tool Gateway program",
          completed: "Ran Tool Gateway program",
        },
        result: {
          jobs: [{ id: "job-1", state: "failed", exitCode: 42 }],
          nextPage: null,
          complete: true,
        },
      },
    ];

    it.each(cases)(
      "keeps $name pending and completed tool calls lossless with source fallback",
      ({ toolName, args, intent, preview, label, result }) => {
        const translator = createOmpDeltaTranslator({
          resolveModelContextWindow: fixtureModelResolver,
        });
        const assembler = createDeltaAssembler({
          providerId: "omp",
          entropyPrefix: ENTROPY,
          textDeltaFlushMs: 0,
          progressThrottleMs: 0,
        });
        const context = { threadId: THREAD_ID };
        assembler.assemble({
          threadId: THREAD_ID,
          deltas: translator.translate({ type: "agent_start" }, context),
        });
        const opened = translator.translate({
          type: "tool_execution_start",
          toolCallId: "semantic-tool",
          toolName,
          args,
          ...(intent ? { intent } : {}),
        }, context);
        expect(opened).toEqual([
          expect.objectContaining({
            kind: "item.open",
            key: { providerItemId: "semantic-tool" },
            item: { type: "tool", tool: toolName, args },
            presentation: expect.objectContaining({
              label,
              title: preview,
              detail: preview,
            }),
          }),
        ]);
        const started = assembler.assemble({
          threadId: THREAD_ID,
          deltas: opened,
        }).find((event) => event.type === "item/started");
        expect(started?.item).toMatchObject({
          type: "toolCall",
          tool: toolName,
          status: "pending",
        });
        expect(started?.item).toHaveProperty("arguments", args);

        const closed = translator.translate({
          type: "tool_execution_end",
          toolCallId: "semantic-tool",
          toolName,
          isError: false,
          result,
        }, context);
        expect(closed).toEqual([
          expect.objectContaining({
            kind: "item.close",
            key: { providerItemId: "semantic-tool" },
            status: "completed",
            item: { type: "tool", tool: toolName, args, result },
            presentation: expect.objectContaining({
              label,
              title: preview,
              detail: preview,
            }),
          }),
        ]);
        const completed = assembler.assemble({
          threadId: THREAD_ID,
          deltas: closed,
        }).find((event) => event.type === "item/completed");
        expect(completed?.item).toMatchObject({
          type: "toolCall",
          id: started?.item.id,
          tool: toolName,
          status: "completed",
        });
        expect(completed?.item).toHaveProperty("arguments", args);
        expect(completed?.item).toHaveProperty("result", result);
      },
    );

    it.each(cases)(
      "uses useful intent before argument hints and source for $name",
      ({ toolName, args, label, preview, result }) => {
        for (const hints of [
          {
            intent: "Inspect failed checkout jobs",
            i: "Summarizing job failures",
            title: "Comparing build results",
            expected: "Inspect failed checkout jobs",
          },
          {
            intent: "Ran eval",
            i: "Summarizing job failures",
            title: "Comparing build results",
            expected: "Summarizing job failures",
          },
          {
            intent: undefined,
            i: "Running Python",
            title: "Comparing build results",
            expected: "Comparing build results",
          },
        ]) {
          const translator = createOmpDeltaTranslator({
            resolveModelContextWindow: fixtureModelResolver,
          });
          const hintedArgs = { ...args, i: hints.i, title: hints.title };
          const opened = translator.translate({
            type: "tool_execution_start",
            toolCallId: "useful-intent",
            toolName,
            args: hintedArgs,
            ...(hints.intent ? { intent: hints.intent } : {}),
          });
          const closed = translator.translate({
            type: "tool_execution_end",
            toolCallId: "useful-intent",
            toolName,
            result,
          });
          expect(opened).toEqual([
            expect.objectContaining({
              kind: "item.open",
              item: { type: "tool", tool: toolName, args: hintedArgs },
              presentation: expect.objectContaining({
                label, title: hints.expected, detail: preview,
              }),
            }),
          ]);
          expect(closed).toEqual([
            expect.objectContaining({
              kind: "item.close",
              status: "completed",
              item: { type: "tool", tool: toolName, args: hintedArgs, result },
              presentation: expect.objectContaining({
                label, title: hints.expected, detail: preview,
              }),
            }),
          ]);
        }
      },
    );

    it.each(cases)(
      "bounds the source or query fallback for $name without changing arguments",
      ({ toolName, args, label }) => {
        const translator = createOmpDeltaTranslator({
          resolveModelContextWindow: fixtureModelResolver,
        });
        const source = `  ${"source ".repeat(40)}\nlast line  `;
        const longArgs = {
          ...args,
          ...(toolName === "tool_gateway_code_search" ? { query: source } : { code: source }),
          i: null,
          title: null,
        };
        const preview = `${source.trim().replace(/\s+/g, " ").slice(0, 159)}…`;
        expect(translator.translate({
          type: "tool_execution_start",
          toolCallId: "bounded-preview",
          toolName,
          args: longArgs,
        })).toEqual([
          expect.objectContaining({
            kind: "item.open",
            item: { type: "tool", tool: toolName, args: longArgs },
            presentation: expect.objectContaining({ label, title: preview, detail: preview }),
          }),
        ]);
      },
    );

    it.each(cases)(
      "keeps $name failures lossless for outer and nested error flags",
      ({ toolName, args, label }) => {
        for (const flags of [
          { isError: true, nestedIsError: false },
          { isError: false, nestedIsError: true },
          { isError: true, nestedIsError: true },
        ]) {
          const translator = createOmpDeltaTranslator({
            resolveModelContextWindow: fixtureModelResolver,
          });
          const harness = createHarness();
          harness.translate({ type: "agent_start" });
          const start = {
            type: "tool_execution_start",
            toolCallId: "semantic-failure",
            toolName,
            args,
            intent: "Inspect failed checkout jobs",
          };
          translator.translate(start);
          const started = harness.translate(start).find(
            (event) => event.type === "item/started",
          );
          const result = {
            isError: flags.nestedIsError,
            content: [{ type: "text", text: "Execution failed\noriginal diagnostic\n" }],
            details: { reason: "upstream", code: 42 },
          };
          const end = {
            type: "tool_execution_end",
            toolCallId: "semantic-failure",
            toolName,
            isError: flags.isError,
            result,
          };
          expect(translator.translate(end)).toEqual([
            expect.objectContaining({
              kind: "item.close",
              status: "failed",
              item: { type: "tool", tool: toolName, args, result },
              presentation: expect.objectContaining({
                label, title: "Inspect failed checkout jobs",
              }),
            }),
          ]);
          const completed = harness.translate(end).find(
            (event) => event.type === "item/completed",
          );
          expect(completed?.item).toMatchObject({
            type: "toolCall",
            id: started?.item.id,
            tool: toolName,
            status: "failed",
          });
          expect(completed?.item).toHaveProperty("arguments", args);
          expect(completed?.item).toHaveProperty("result", result);
        }
      },
    );

    it.each([
      { toolName: "eval", args: { language: "python", code: "print(1)" } },
      { toolName: "eval", args: { language: "py", code: 42 } },
      { toolName: "eval", args: { language: "js", code: " \n " } },
      { toolName: "eval", args: { language: "js", code: "1", title: 42 } },
      { toolName: "tool_gateway_code_search", args: { query: 42 } },
      { toolName: "tool_gateway_code_search", args: { query: " \n " } },
      { toolName: "tool_gateway_code_search", args: { query: "jobs", i: [] } },
      { toolName: "tool_gateway_code_execute", args: { code: null } },
      { toolName: "tool_gateway_code_execute", args: {} },
      { toolName: "tool_gateway_code_execute", args: { code: "return 1", title: {} } },
      { toolName: "tool_gateway_code_search_extra", args: { query: "jobs" } },
      { toolName: "tool_gateway_code_execute_extra", args: { code: "return 1" } },
    ])("retains generic fallback for unvalidated $toolName arguments: $args", ({ toolName, args }) => {
      const translator = createOmpDeltaTranslator({
        resolveModelContextWindow: fixtureModelResolver,
      });
      const harness = createHarness();
      harness.translate({ type: "agent_start" });
      const start = {
        type: "tool_execution_start",
        toolCallId: "generic-fallback",
        toolName,
        args,
        intent: "Running Python",
      };
      const unhinted = translator.translate({
        ...start,
        toolCallId: "unhinted-fallback",
        intent: undefined,
      });
      expect(unhinted).toEqual([
        expect.objectContaining({
          kind: "item.open",
          item: { type: "tool", tool: toolName, args },
        }),
      ]);
      expect(unhinted[0]).not.toHaveProperty("presentation");
      expect(translator.translate(start)).toEqual([
        expect.objectContaining({
          kind: "item.open",
          item: { type: "tool", tool: toolName, args },
          presentation: expect.objectContaining({ title: "Running Python" }),
        }),
      ]);
      harness.translate(start);
      const result = { content: [{ type: "text", text: "Unrecognized arguments" }] };
      const end = {
        type: "tool_execution_end",
        toolCallId: "generic-fallback",
        toolName,
        result,
      };
      expect(translator.translate(end)).toEqual([
        expect.objectContaining({
          kind: "item.close",
          status: "completed",
          item: { type: "tool", tool: toolName, args, result },
          presentation: expect.objectContaining({ title: "Running Python" }),
        }),
      ]);
      expect(harness.translate(end)).toContainEqual(expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall", tool: toolName, status: "completed", arguments: args, result,
        }),
      }));
    });
  });

  it("uses native tool intent as the tool action title", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });

    const deltas = translator.translate({
      type: "tool_execution_start",
      toolCallId: "task-intent-1",
      toolName: "task",
      args: { agent: "explore", tasks: [] },
      intent: "Locate the authentication implementation",
    });

    expect(deltas).toEqual([
      expect.objectContaining({
        kind: "item.open",
        item: expect.objectContaining({ type: "tool", tool: "task" }),
        presentation: expect.objectContaining({
          title: "Locate the authentication implementation",
        }),
      }),
    ]);
  });

  it("accepts native tool completions with optional result and error flags", () => {
    const payloads = [
      {},
      { isError: false },
      { result: { content: [{ type: "text", text: "Completed" }] } },
      { isError: true },
    ];
    for (const payload of payloads) {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const startedEvents = harness.translate({
        type: "tool_execution_start",
        toolCallId: "task-optional",
        toolName: "task",
        args: { tasks: [] },
      });
      const started = startedEvents.find((event) => event.type === "item/started");
      const events = harness.translate({
        type: "tool_execution_end",
        toolCallId: "task-optional",
        toolName: "task",
        ...payload,
      });
      const completed = events.find((event) => event.type === "item/completed");

      expect(completed?.item).toMatchObject({
        type: "toolCall",
        id: started?.item.id,
        tool: "task",
        status: "isError" in payload && payload.isError ? "failed" : "completed",
      });
      if ("result" in payload) {
        expect(completed?.item).toHaveProperty("result", payload.result);
      }
      expect(events.some((event) => event.type === "provider/unhandled")).toBe(false);
    }
  });

  it("tool_execution_end emits item/completed under the started item's id", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate(
      loadFixture("tool-execution-start-bash.json"),
    );
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";

    const events = harness.translate(
      loadFixture("tool-execution-end-bash.json"),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          id: startedId,
          status: "completed",
        }),
      }),
    );
  });

  it("tool_execution_end marks bash failures", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "npm test", cwd: "/repo" },
    });

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: true,
      result: "tests failed",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "commandExecution",
          command: "npm test",
          cwd: "/repo",
          aggregatedOutput: "tests failed",
          exitCode: 1,
          status: "failed",
        }),
      }),
    );
  });

  it.each([
    { exitCode: 42, wallTimeMs: 1_234.5, isError: true },
    { exitCode: 0, wallTimeMs: 0, isError: false },
  ])("preserves Bash exit $exitCode and duration $wallTimeMs", ({ exitCode, wallTimeMs, isError }) => {
    const harness = createHarness();
    harness.translate({ type: "agent_start" });
    harness.translate({
      type: "tool_execution_start", toolCallId: "bash-real-details",
      toolName: "bash", args: { command: "example", cwd: "/repo" },
    });
    expect(harness.translate({
      type: "tool_execution_end", toolCallId: "bash-real-details", toolName: "bash", isError,
      result: { content: [{ type: "text", text: "output" }], details: { exitCode, wallTimeMs } },
    })).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({ type: "commandExecution", exitCode, durationMs: wallTimeMs }),
    }));
  });

  it("recovers non-bash tool results from the started item", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 1, limit: 20 },
    });

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-read-1",
      toolName: "read",
      isError: false,
      result: "file contents",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "read",
          status: "completed",
          result: "file contents",
          arguments: expect.objectContaining({
            path: "src/app.ts",
            offset: 1,
            limit: 20,
          }),
        }),
      }),
    );
  });

  it("maps bash tool execution updates to command output deltas", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const started = harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "printf 'FIRST\\nSECOND\\n'", cwd: "/repo" },
    });
    const startedId =
      started[0]?.type === "item/started" ? started[0].item.id : "";

    const firstEvents = harness.translate(
      createOmpBashUpdateEvent({
        threadId: "omp-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\n",
      }),
    );

    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: startedId,
        delta: "FIRST\n",
      }),
    );

    const secondEvents = harness.translate(
      createOmpBashUpdateEvent({
        threadId: "omp-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        itemId: startedId,
        delta: "SECOND\n",
      }),
    );
  });

  it("emits the full bash delta when OMP resets cumulative output", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createOmpBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );

    harness.translate(
      createOmpBashUpdateEvent({
        threadId: "omp-thread-1",
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    const resetEvents = harness.translate(
      createOmpBashUpdateEvent({
        threadId: "omp-thread-1",
        toolCallId: "tool-bash-1",
        text: "RESET\n",
      }),
    );

    expect(resetEvents).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "RESET\n",
        reset: true,
      }),
    );
  });

  it("clears bash output snapshots when a turn completes", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createOmpBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\n'",
      }),
    );
    harness.translate(
      createOmpBashUpdateEvent({
        threadId: THREAD_ID,
        toolCallId: "tool-bash-1",
        text: "FIRST\n",
      }),
    );

    harness.translate(loadSettledAgentEndFixture());

    harness.translate(loadFixture("agent-start.json"));
    harness.translate(
      createOmpBashStartEvent({
        toolCallId: "tool-bash-1",
        command: "printf 'FIRST\\nSECOND\\n'",
      }),
    );
    const events = harness.translate(
      createOmpBashUpdateEvent({
        threadId: THREAD_ID,
        toolCallId: "tool-bash-1",
        text: "FIRST\nSECOND\n",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/commandExecution/outputDelta",
        delta: "FIRST\nSECOND\n",
      }),
    );
  });

  it("skips empty bash updates with no content", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      createOmpBashUpdateEvent({
        threadId: "omp-thread-1",
        toolCallId: "tool-bash-1",
        text: "",
      }),
    );

    expect(events).toEqual([]);
  });

  it("skips OMP bash update placeholders", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate(
      createOmpBashUpdateEvent({
        threadId: "omp-thread-1",
        toolCallId: "tool-bash-1",
        text: "(no output)",
      }),
    );

    expect(events).toEqual([]);
  });

  it("keeps non-bash tool execution updates as shared tool progress", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "omp-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: {
            content: [{ type: "text", text: "partial output" }],
          },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "partial output",
      }),
    );
  });

  it("uses generic progress text when non-bash partial output is empty", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "omp-thread-1",
        message: {
          type: "tool_execution_update",
          toolCallId: "tool-read-1",
          toolName: "read",
          partialResult: { content: [] },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: "read progress update",
      }),
    );
  });

  it.each(["task", "bash"])(
    "buffers native %s stream previews until execution opens the accurate item",
    (toolName) => {
      const translator = createOmpDeltaTranslator({
        resolveModelContextWindow: fixtureModelResolver,
      });
      const context = { threadId: THREAD_ID };
      const event = {
        type: "tool_stream_update",
        toolCallId: "tool-stream-1",
        toolName,
        update: { content: [{ type: "text", text: "First preview" }] },
      };
      expect(translator.translate(event, context)).toEqual([]);
      expect(
        translator.translate(
          sdkMessage({
            ...event,
            update: { content: [{ type: "text", text: "Latest preview" }] },
          }),
          context,
        ),
      ).toEqual([]);
      const noUpdate = {
        type: "tool_stream_update",
        toolCallId: "tool-stream-1",
        toolName,
      };
      expect(translator.translate(noUpdate, context)).toEqual([]);
      expect(translator.translate(sdkMessage(noUpdate), context)).toEqual([]);

      const started = translator.translate(
        {
          type: "tool_execution_start",
          toolCallId: "tool-stream-1",
          toolName,
          args: toolName === "bash"
            ? { command: "printf hi", cwd: "/repo" }
            : { tasks: [] },
        },
        context,
      );
      expect(started.map((delta) => delta.kind)).toEqual([
        "item.open",
        toolName === "bash" ? "item.outputDelta" : "item.progress",
      ]);
      expect(started[0]).toMatchObject({
        key: { providerItemId: "tool-stream-1" },
        item: { type: toolName === "bash" ? "command" : "tool" },
      });
      expect(started[1]).toMatchObject(
        toolName === "bash"
          ? { channel: "command", text: "Latest preview" }
          : { kind: "item.progress", message: "Latest preview", flush: true },
      );

      const live = translator.translate(
        { ...event, update: { content: [{ type: "text", text: "Live preview" }] } },
        context,
      );
      expect(live).toEqual([
        expect.objectContaining(
          toolName === "bash"
            ? { kind: "item.outputDelta", channel: "command", text: "Live preview" }
            : { kind: "item.progress", message: "Live preview" },
        ),
      ]);
    },
  );

  it("buffers only the latest edit snapshot as generic progress without native file changes", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const assembler = createDeltaAssembler({
      providerId: "omp",
      entropyPrefix: ENTROPY,
      textDeltaFlushMs: 0,
    });
    const context = { threadId: THREAD_ID };
    assembler.assemble({
      threadId: THREAD_ID,
      deltas: translator.translate({ type: "agent_start" }, context),
    });
    const firstPreview = {
      type: "tool_stream_update",
      toolCallId: "edit-preview-1",
      toolName: "edit",
      update: {
        generation: 1,
        streaming: true,
        files: [{ path: "src/stale.ts", diff: "-old\n+stale", op: "update" }],
      },
    };
    const latestPreview = {
      ...firstPreview,
      update: {
        generation: 2,
        streaming: false,
        files: [
          {
            path: "src/auth.ts",
            diff: "-return false;\n+return true;",
            op: "update",
          },
          {
            path: "src/missing.ts",
            error: "Patch target unavailable",
            op: "update",
          },
        ],
      },
    };
    expect(translator.translate(firstPreview, context)).toEqual([]);
    expect(translator.translate(sdkMessage(latestPreview), context)).toEqual([]);
    expect(translator.translate(latestPreview, context)).toEqual([]);
    expect(assembler.getBbItemId(THREAD_ID, "edit-preview-1")).toBeUndefined();

    const startDeltas = translator.translate(
      {
        type: "tool_execution_start",
        toolCallId: "edit-preview-1",
        toolName: "edit",
        args: {
          path: "src/auth.ts",
          oldText: "return false;",
          newText: "return true;",
        },
      },
      context,
    );
    expect(startDeltas.map((delta) => delta.kind)).toEqual([
      "item.open",
      "item.progress",
    ]);
    expect(startDeltas[0]).toMatchObject({
      key: { providerItemId: "edit-preview-1" },
      item: { type: "tool", tool: "edit" },
    });
    const replay = startDeltas.find((delta) => delta.kind === "item.progress");
    expect(replay).toMatchObject({
      kind: "item.progress", flush: true,
      key: { providerItemId: "edit-preview-1" },
    });
    expect(replay?.message).toContain("src/auth.ts");
    expect(replay?.message).toContain("-return false;\n+return true;");
    expect(replay?.message).toContain("src/missing.ts");
    expect(replay?.message).toContain("Patch target unavailable");
    expect(replay?.message).not.toContain("src/stale.ts");
    const startedEvents = assembler.assemble({
      threadId: THREAD_ID,
      deltas: startDeltas,
    });
    const started = startedEvents.find((event) => event.type === "item/started");
    const itemId = started?.item.id;
    expect(itemId).toMatch(ITEM_ID_PATTERN);
    expect(started?.item).toMatchObject({ type: "toolCall", tool: "edit", status: "pending" });

    const liveDeltas = translator.translate(
      {
        ...firstPreview,
        update: {
          generation: 3,
          streaming: true,
          files: [{ path: "src/auth.ts", diff: "Live diff" }],
        },
      },
      context,
    );
    expect(liveDeltas).toEqual([
      expect.objectContaining({
        kind: "item.progress",
        message: expect.stringContaining("Live diff"),
      }),
    ]);
    const liveEvents = assembler.assemble({
      threadId: THREAD_ID,
      deltas: liveDeltas,
    });

    const endDeltas = translator.translate(
      {
        type: "tool_execution_end",
        toolCallId: "edit-preview-1",
        toolName: "edit",
        result: { content: [{ type: "text", text: "Applied patch" }] },
        isError: false,
      },
      context,
    );
    const completedEvents = assembler.assemble({
      threadId: THREAD_ID,
      deltas: endDeltas,
    });
    expect(completedEvents).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          id: itemId,
          status: "completed",
        }),
      }),
    );
    const events = [...startedEvents, ...liveEvents, ...completedEvents];
    expect(events.filter((event) => event.type === "item/started")).toHaveLength(1);
    expect(events.some((event) => "item" in event && event.item.type === "fileChange")).toBe(false);
  });

  it.each([
    { label: "resetThread", event: null },
    { label: "final agent settlement", event: { type: "agent_end", settlementOnly: true } },
    {
      label: "prompt settlement",
      event: {
        jsonrpc: "2.0",
        method: "omp/prompt/settled",
        params: { threadId: THREAD_ID, status: "completed" },
      },
    },
    {
      label: "session error",
      event: {
        jsonrpc: "2.0",
        method: "error",
        params: { threadId: THREAD_ID, message: "Session failed" },
      },
    },
    { label: "manual compaction", event: { type: "bb_compaction_end", aborted: false } },
    {
      label: "orphan tool end",
      event: {
        type: "tool_execution_end",
        toolCallId: "buffer-cleanup-1",
        toolName: "task",
      },
    },
  ])("discards buffered previews after $label", ({ event }) => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const context = { threadId: THREAD_ID };
    expect(
      translator.translate(
        {
          type: "tool_stream_update",
          toolCallId: "buffer-cleanup-1",
          toolName: "task",
          update: "Stale preview",
        },
        context,
      ),
    ).toEqual([]);

    if (event === null) translator.resetThread(THREAD_ID);
    else translator.translate(event, context);

    const started = translator.translate(
      {
        type: "tool_execution_start",
        toolCallId: "buffer-cleanup-1",
        toolName: "task",
        args: { tasks: [] },
      },
      context,
    );
    expect(started.map((delta) => delta.kind)).toEqual(["item.open"]);
  });

  it("keeps buffered previews across deferred native agent_end", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const context = { threadId: THREAD_ID };
    translator.translate(
      {
        type: "tool_stream_update",
        toolCallId: "deferred-preview-1",
        toolName: "task",
        update: "Pending preview",
      },
      context,
    );

    expect(
      translator.translate({ type: "agent_end", messageCount: 0 }, context),
    ).toEqual([]);
    const started = translator.translate(
      {
        type: "tool_execution_start",
        toolCallId: "deferred-preview-1",
        toolName: "task",
        args: { tasks: [] },
      },
      context,
    );
    expect(started.map((delta) => delta.kind)).toEqual(["item.open", "item.progress"]);
    expect(started[1]).toMatchObject({
      kind: "item.progress",
      message: "Pending preview",
      flush: true,
    });
  });

  it("preserves generic progress for opaque native stream updates", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "todo-stream-1",
      toolName: "todo",
      args: { todos: [] },
    });

    const events = harness.translate({
      type: "tool_stream_update",
      toolCallId: "todo-stream-1",
      toolName: "todo",
      update: { completed: 1, total: 2 },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/toolCall/progress",
        message: '{"completed":1,"total":2}',
      }),
    );
  });

  it("strips OMP no-output placeholders from bash completions", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "true", cwd: "/repo" },
    });

    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "(no output)" }] },
    });

    const completedEvent = events.find(
      (event): event is Extract<ThreadEvent, { type: "item/completed" }> =>
        event.type === "item/completed",
    );

    expect(completedEvent?.item).toMatchObject({
      type: "commandExecution",
      command: "true",
      cwd: "/repo",
      status: "completed",
      exitCode: 0,
    });
    if (completedEvent?.item.type !== "commandExecution") {
      throw new Error("Expected commandExecution completion");
    }
    expect(completedEvent.item.aggregatedOutput).toBeUndefined();
  });

  it("surfaces tool events without an active turn as provider/unhandled", () => {
    const harness = createHarness();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "sdk/message",
      params: {
        threadId: "omp-thread-1",
        message: {
          type: "tool_execution_start",
          toolCallId: "tool-bash-1",
          toolName: "bash",
          args: { command: "npm test" },
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        providerId: "omp",
        rawType: "sdk/tool_execution_start",
        scope: threadScope(),
        rawEvent: expect.objectContaining({ method: "sdk/message" }),
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it.each([false, true])(
    "resolves retry progress on the same timeline item without settling the turn (wrapped=%s)",
    (wrapped) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const turnId = harness.openTurnId();
      const start = {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 2_500,
        errorMessage: "\u001b[31mProvider overloaded\u001b[0m",
        errorId: 42,
      };
      const started = harness.translate(wrapped ? sdkMessage(start) : start);
      expect(started).toEqual([
        expect.objectContaining({
          type: "item/started",
          scope: turnScope(turnId),
          item: expect.objectContaining({
            type: "extension",
            kind: OMP_NOTICE_KIND,
            status: "pending",
            payload: {
              severity: "warning",
              message: "Retrying (attempt 1/2 in 2.5s): Provider overloaded",
            },
          }),
        }),
      ]);
      const item = started.find((event) => event.type === "item/started");
      const end = {
        type: "auto_retry_end",
        success: true,
        attempt: 1,
        retryErrors: [],
      };
      const completed = harness.translate(wrapped ? sdkMessage(end) : end);
      expect(completed).toEqual([
        expect.objectContaining({
          type: "item/completed",
          scope: turnScope(turnId),
          item: expect.objectContaining({
            id: item?.item.id,
            type: "extension",
            kind: OMP_NOTICE_KIND,
            status: "completed",
            payload: { severity: "info", message: "Recovered after 1 retry" },
            presentation: expect.objectContaining({
              badge: expect.objectContaining({ label: "Info", tone: "neutral" }),
            }),
          }),
        }),
      ]);
      expect([...started, ...completed].some((event) => event.type === "provider/error")).toBe(false);
      expect(harness.openTurnId()).toBe(turnId);
      expect(harness.translate(createTextDeltaEvent())).toContainEqual(
        expect.objectContaining({ type: "item/agentMessage/delta" }),
      );
      expect(harness.translate(loadSettledAgentEndFixture())).toContainEqual(
        expect.objectContaining({ type: "turn/completed", status: "completed" }),
      );
    },
  );

  it("keeps idle retry updates in one local turn and closes it on recovery", () => {
    const harness = createHarness();
    const start = (attempt: number) => harness.translate(sdkMessage({
      type: "auto_retry_start",
      attempt,
      maxAttempts: 3,
      delayMs: 0,
      errorMessage: "Trying another credential",
    }));
    const first = start(1);
    const turnId = harness.openTurnId();
    expect(turnId).toMatch(TURN_ID_PATTERN);
    const firstItem = first.find((event) => event.type === "item/started");
    expect(firstItem?.item).toMatchObject({ type: "extension", status: "pending" });
    const next = start(2);
    expect(next).toEqual([
      expect.objectContaining({
        type: "item/started",
        scope: turnScope(turnId),
        item: expect.objectContaining({
          id: firstItem?.item.id,
          payload: { severity: "warning", message: "Retrying (attempt 2/3 in 0s): Trying another credential" },
        }),
      }),
    ]);
    expect(harness.translate(sdkMessage({
      type: "auto_retry_end",
      success: true,
      attempt: 2,
    }))).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          id: firstItem?.item.id,
          status: "completed",
          payload: { severity: "info", message: "Recovered after 2 retries" },
        }),
      }),
      expect.objectContaining({ type: "turn/completed", status: "completed" }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it.each([false, true])(
    "ignores unmatched successful retry completion (wrapped=%s)",
    (wrapped) => {
      const harness = createHarness();
      const message = { type: "auto_retry_end", success: true, attempt: 1 };
      expect(harness.translate(wrapped ? sdkMessage(message) : message)).toEqual([]);
      expect(harness.openTurnId()).toBe("");
    },
  );

  it.each([false, true])(
    "updates one failed retry item and preserves terminal assistant error settlement (wrapped=%s)",
    (wrapped) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const turnId = harness.openTurnId();
      const starts = [1, 2].flatMap((attempt) => {
        const message = {
          type: "auto_retry_start",
          attempt,
          maxAttempts: 2,
          delayMs: 0,
          errorMessage: "Provider overloaded",
        };
        return harness.translate(wrapped ? sdkMessage(message) : message);
      });
      const itemIds = starts.flatMap((event) => event.type === "item/started" ? [event.item.id] : []);
      expect(itemIds).toHaveLength(2);
      expect(new Set(itemIds).size).toBe(1);
      expect(starts.some((event) => event.type === "provider/error")).toBe(false);
      const error = createOmpAgentErrorEvent("Retry budget exhausted");
      const assistant = error.messages[0];
      expect(harness.translate({ type: "message_end", message: assistant })).toEqual([]);
      expect(harness.translate(error)).toEqual([]);
      const end = {
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "\u001b[31mProvider unavailable\u001b[0m",
        retryErrors: [],
      };
      expect(harness.translate(wrapped ? sdkMessage(end) : end)).toEqual([
        expect.objectContaining({
          type: "item/completed",
          scope: turnScope(turnId),
          item: expect.objectContaining({
            id: itemIds[0],
            type: "extension",
            kind: OMP_NOTICE_KIND,
            status: "failed",
            payload: { severity: "error", message: "Provider unavailable" },
            presentation: expect.objectContaining({
              badge: expect.objectContaining({ label: "Error", tone: "destructive" }),
            }),
          }),
        }),
      ]);
      expect(harness.openTurnId()).toBe(turnId);
      const events = harness.translate({
        type: "agent_end",
        settlementOnly: true,
        deferSettlement: false,
        settlementError: "Retry budget exhausted",
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: "provider/error",
          scope: turnScope(turnId),
          detail: "Retry budget exhausted",
        }),
        expect.objectContaining({ type: "turn/completed", status: "failed" }),
      ]);
      expect(harness.openTurnId()).toBe("");
    },
  );

  it.each(["Retry cancelled", undefined])(
    "shows unmatched failed retries safely without an active turn (finalError=%s)",
    (finalError) => {
      const harness = createHarness();
      expect(harness.translate(sdkMessage({
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        ...(finalError !== undefined ? { finalError } : {}),
      }))).toEqual([
        expect.objectContaining({ type: "turn/started" }),
        expect.objectContaining({
          type: "item/completed",
          item: expect.objectContaining({
            type: "extension",
            kind: OMP_NOTICE_KIND,
            status: "failed",
            payload: {
              severity: "error",
              message: finalError ?? "Retry failed after 2 retries",
            },
          }),
        }),
        expect.objectContaining({ type: "turn/completed", status: "failed" }),
      ]);
      expect(harness.openTurnId()).toBe("");
    },
  );

  it("separates retry sagas across threads, child sessions, and restarts", () => {
    const translator = createOmpDeltaTranslator({ resolveModelContextWindow: fixtureModelResolver });
    const contexts = [
      { threadId: "parent" },
      { threadId: "child" },
      { threadId: "parent", parentToolCallId: "worker-a" },
      { threadId: "parent", parentToolCallId: "worker-b" },
    ];
    const start = { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: "Busy" };
    const end = { type: "auto_retry_end", success: true, attempt: 1 };
    const keys = contexts.map((context) => {
      const deltas = translator.translate(start, context);
      deltas.forEach((delta) => expect(threadDeltaSchema.parse(delta)).toEqual(delta));
      const item = deltas.find((delta) => delta.kind === "item.open");
      if (!item || item.kind !== "item.open") throw new Error("Expected retry item");
      expect(item.key.parentRef).toBe(context.parentToolCallId);
      return item.key.providerItemId;
    });
    expect(new Set(keys).size).toBe(contexts.length);
    const resolved = translator.translate(end, contexts[2]);
    expect(resolved).toContainEqual(expect.objectContaining({
      kind: "item.close",
      key: { providerItemId: keys[2], parentRef: "worker-a" },
      status: "completed",
    }));
    expect(translator.translate(end, contexts[0])).toContainEqual(expect.objectContaining({
      kind: "item.close",
      key: { providerItemId: keys[0] },
    }));
    const nextSaga = translator.translate(start, contexts[2]).find((delta) => delta.kind === "item.open");
    expect(nextSaga?.key.providerItemId).not.toBe(keys[2]);
    translator.resetThread("parent");
    expect(translator.translate(end, contexts[3])).toEqual([]);
    const restarted = translator.translate(start, contexts[0]).find((delta) => delta.kind === "item.open");
    expect(restarted?.key.providerItemId).not.toBe(keys[0]);
  });

  it.each([false, true])(
    "publishes model fallbacks with plain model IDs and provider reason (wrapped=%s)",
    (wrapped) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const turnId = harness.openTurnId();
      const translator = createOmpDeltaTranslator({
        resolveModelContextWindow: fixtureModelResolver,
      });
      const message = {
        type: "retry_fallback_applied",
        from: "\u001b[31manthropic/primary\u001b[0m",
        to: "\u001b[32mopenai/fallback\u001b[0m",
        role: "\u001b[1mdefault\u001b[0m",
        reason: "\u001b[33mQuota exhausted\u001b[0m",
      };
      const event = wrapped ? sdkMessage(message) : message;
      const expected = {
        originalModel: "anthropic/primary",
        fallbackModel: "openai/fallback",
        reason: "provider",
        message: "Switching default model from anthropic/primary to openai/fallback: Quota exhausted",
      };
      const deltas = translator.translate(event);
      expect(deltas).toEqual([{ kind: "provider.modelFallback", ...expected }]);
      expect(deltas.map((delta) => threadDeltaSchema.parse(delta))).toEqual(deltas);
      expect(harness.translate(event)).toEqual([
        expect.objectContaining({ type: "provider/modelFallback", ...expected }),
      ]);
      expect(harness.openTurnId()).toBe(turnId);
      expect(harness.translate({
        type: "retry_fallback_succeeded",
        model: "openai/fallback",
        role: "default",
      })).toEqual([]);
    },
  );

  it("accepts model fallbacks without an optional explanation", () => {
    const harness = createHarness();
    expect(harness.translate({
      type: "retry_fallback_applied",
      from: "primary",
      to: "fallback",
      role: "advisor",
    })).toEqual([
      expect.objectContaining({
        type: "provider/modelFallback",
        message: "Switching advisor model from primary to fallback",
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it.each([
    {
      type: "extension_error", extensionPath: "/extensions/check.ts",
      event: "before_agent_start", error: "\u001b[31mExtension failed\u001b[0m",
    },
    {
      type: "bb_rpc_response_error", command: "parse",
      error: "\u001b[31mInvalid JSON\u001b[0m", code: "invalid_input",
    },
  ])("shows $type diagnostics without opening or ending a turn", (diagnostic) => {
    for (const active of [false, true]) {
      const harness = createHarness();
      if (active) harness.translate({ type: "agent_start" });
      const turnId = harness.openTurnId();
      for (const event of [diagnostic, sdkMessage(diagnostic)]) {
        const warnings = harness.translate(event);
        expect(warnings).toEqual([expect.objectContaining({
          type: "provider/warning", category: "general",
          details: expect.stringContaining(diagnostic.type === "extension_error" ? "Extension failed" : "Invalid JSON"),
        })]);
        const warning = warnings[0];
        if (warning?.type !== "provider/warning") throw new Error("Expected warning");
        expect(warning.details).not.toContain("\u001b");
        if (diagnostic.type === "extension_error") {
          expect(warning.details).toContain(diagnostic.extensionPath);
          expect(warning.details).toContain(diagnostic.event);
        } else {
          expect(warning.details).toContain(diagnostic.command);
          expect(warning.details).toContain(diagnostic.code);
        }
        expect(harness.openTurnId()).toBe(turnId);
      }
    }
  });

  it.each(["warning", "error"] as const)(
    "publishes %s session notices as non-terminal native warnings, active or idle",
    (level) => {
      for (const active of [false, true]) {
        const harness = createHarness();
        if (active) harness.translate(loadFixture("agent-start.json"));
        const turnId = harness.openTurnId();
        const message = {
          type: "notice",
          level,
          message: "\u001b[31mFirst line\u001b[0m\nFull details",
          source: "\u001b[1msession-persistence\u001b[0m",
        };
        for (const event of [message, sdkMessage(message)]) {
          expect(harness.translate(event)).toEqual([
            expect.objectContaining({
              type: "provider/warning",
              scope: threadScope(),
              category: "general",
              summary: `OMP ${level === "error" ? "Error" : "Warning"} (session-persistence)`,
              details: "First line\nFull details",
            }),
          ]);
          expect(harness.openTurnId()).toBe(turnId);
        }
      }
    },
  );

  it("preserves session notices without a source", () => {
    const harness = createHarness();
    expect(harness.translate({
      type: "notice", level: "warning", message: "Check your configuration",
    })).toEqual([
      expect.objectContaining({
        type: "provider/warning",
        summary: "OMP Warning",
        details: "Check your configuration",
      }),
    ]);
  });

  it.each([false, true])(
    "renders informational session notices as distinct neutral extension items (wrapped=%s)",
    (wrapped) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const turnId = harness.openTurnId();
      const message = {
        type: "notice",
        level: "info",
        source: "\u001b[1msession\u001b[0m",
        message: "\u001b[32mReady\u001b[0m\nFull details",
      };
      const event = wrapped ? sdkMessage(message) : message;
      const first = harness.translate(event);
      const second = harness.translate(event);
      for (const events of [first, second]) {
        expect(events).toEqual([
          expect.objectContaining({
            type: "item/completed",
            scope: turnScope(turnId),
            item: expect.objectContaining({
              type: "extension",
              kind: OMP_NOTICE_KIND,
              payload: { severity: "info", message: "session: Ready\nFull details" },
              status: "completed",
            }),
          }),
        ]);
      }
      const firstItem = first.find((entry) => entry.type === "item/completed");
      const secondItem = second.find((entry) => entry.type === "item/completed");
      expect(firstItem?.item.id).not.toBe(secondItem?.item.id);
      expect(harness.openTurnId()).toBe(turnId);
    },
  );

  it("preserves idle informational notices without inventing a turn or warning", () => {
    const harness = createHarness();
    const message = {
      type: "notice",
      level: "info",
      message: "\u001b[32mReady\u001b[0m",
    };
    expect(harness.translate(sdkMessage(message))).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        rawType: "sdk/notice",
        scope: threadScope(),
        rawEvent: expect.objectContaining({
          method: "sdk/message",
          params: expect.objectContaining({
            message: { ...message, message: "Ready" },
          }),
        }),
      }),
    ]);
    expect(harness.openTurnId()).toBe("");
  });

  it("preserves oversized information on the raw surface instead of upgrading it to a warning", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    const message = {
      type: "notice", level: "info", message: "Full notice\n".repeat(10_000),
    };
    expect(harness.translate(message)).toEqual([
      expect.objectContaining({
        type: "provider/unhandled",
        rawType: "sdk/notice",
        rawEvent: expect.objectContaining({
          params: expect.objectContaining({ message }),
        }),
      }),
    ]);
    expect(harness.openTurnId()).toBe(turnId);
  });

  it.each([0, 7])(
    "maps native snapshot usage.reasoningTokens=%i without adding it to total tokens",
    (reasoningTokens) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const snapshot = createAssistantMessageEnd("Answer");
      const events = harness.translate({
        ...snapshot,
        message: {
          ...snapshot.message,
          usage: { input: 80, output: 20, totalTokens: 100, reasoningTokens },
        },
      });

      expect(harness.translate({ type: "agent_end", messageCount: 1 })).toEqual([]);
      const usage = events.find(
        (event) => event.type === "thread/tokenUsage/updated",
      );

      expect(usage?.tokenUsage.last).toMatchObject({
        totalTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        reasoningOutputTokens: reasoningTokens,
      });
      expect(usage?.tokenUsage.total).toMatchObject({
        totalTokens: 100,
        reasoningOutputTokens: reasoningTokens,
      });
      expect(events.some((event) => event.type === "turn/completed")).toBe(false);
    },
  );

  it.each([
    [{}, {}],
    [{ cacheRead: 0 }, { cacheReadInputTokens: 0 }],
    [{ cacheWrite: 0 }, { cacheWriteInputTokens: 0 }],
    [{ cacheRead: 31 }, { cacheReadInputTokens: 31 }],
    [{ cacheWrite: 9 }, { cacheWriteInputTokens: 9 }],
  ])(
    "preserves independently omitted OMP cache counts %j",
    (counts, expected) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const events = harness.translate({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            usage: { input: 80, output: 20, ...counts },
          },
        ],
      });
      const event = events.find(
        (event) => event.type === "thread/tokenUsage/updated",
      );
      expect(event).toBeDefined();
      expect(event?.tokenUsage.last).toMatchObject(expected);
      expect(
        Object.keys(event?.tokenUsage.last ?? {})
          .filter(
            (key) =>
              key === "cacheReadInputTokens" || key === "cacheWriteInputTokens",
          )
          .sort(),
      ).toEqual(Object.keys(expected).sort());
    },
  );

  it.each(["cacheRead", "cacheWrite"])(
    "invalid %s cannot discard OMP completion or valid usage",
    (field) => {
      for (const invalid of [-1, null, "invalid", Infinity, NaN]) {
        const harness = createHarness();
        harness.translate(loadFixture("agent-start.json"));
        const events = harness.translate({
          type: "agent_end",
          deferSettlement: false,
          providerCheckpointId: "checkpoint-cache",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Finished" }],
              usage: {
                input: 80,
                output: 20,
                cacheRead: 31,
                cacheWrite: 9,
                [field]: invalid,
              },
            },
          ],
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "item/completed",
            item: expect.objectContaining({ text: "Finished" }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "turn/completed",
            providerCheckpointId: "checkpoint-cache",
          }),
        );
        expect(harness.openTurnId()).toBe("");
        const event = events.find(
          (event) => event.type === "thread/tokenUsage/updated",
        );
        const validCounts =
          field === "cacheRead"
            ? { cacheWriteInputTokens: 9 }
            : { cacheReadInputTokens: 31 };
        expect(event?.tokenUsage.last).toEqual({
          totalTokens: field === "cacheRead" ? 109 : 131,
          inputTokens: 80,
          outputTokens: 20,
          cachedInputTokens: field === "cacheRead" ? 9 : 31,
          reasoningOutputTokens: 0,
          ...validCounts,
        });
      }
    },
  );

  it("invalid cache counts in earlier messages cannot discard OMP error settlement", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate({
      type: "agent_end",
      deferSettlement: false,
      messages: [
        { role: "assistant", content: [], usage: { cacheRead: -1 } },
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Provider failed",
          usage: { cacheWrite: -1 },
        },
      ],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider/error",
        detail: "Provider failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn/completed", status: "failed" }),
    );
    expect(harness.openTurnId()).toBe("");
  });

  it("accumulates OMP token usage across turns", () => {
    const harness = createHarness({
      resolveModelContextWindow: () => 123_456,
    });

    harness.translate(loadFixture("agent-start.json"));
    const firstTurnEvents = harness.translate(
      loadSettledAgentEndFixture(),
    );

    harness.translate(loadFixture("agent-start.json"));
    const secondTurnEvents = harness.translate(
      loadSettledAgentEndFixture(),
    );

    const firstTokenUsage = firstTurnEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );
    const secondTokenUsage = secondTurnEvents.find(
      (
        event,
      ): event is Extract<ThreadEvent, { type: "thread/tokenUsage/updated" }> =>
        event.type === "thread/tokenUsage/updated",
    );

    expect(firstTokenUsage?.tokenUsage.last).toMatchObject({
      totalTokens: 7736,
      inputTokens: 4200,
      cachedInputTokens: 3380,
      cacheReadInputTokens: 3100,
      cacheWriteInputTokens: 280,
      outputTokens: 156,
    });
    expect(firstTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
    expect(secondTokenUsage?.tokenUsage.total).toMatchObject({
      totalTokens: 15472,
      inputTokens: 8400,
      cachedInputTokens: 6760,
      cacheReadInputTokens: 6200,
      cacheWriteInputTokens: 560,
      outputTokens: 312,
    });
    expect(secondTokenUsage?.tokenUsage.last).toEqual(
      firstTokenUsage?.tokenUsage.last,
    );
    expect(secondTokenUsage?.tokenUsage.modelContextWindow).toBe(123_456);
  });

  it("maps bridge context-window usage updates into the meter event", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();
    harness.translate(loadSettledAgentEndFixture());

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "thread/contextWindowUsage/updated",
      params: {
        threadId: THREAD_ID,
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
          cost: { amount: 0.6, currency: "USD" },
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread/contextWindowUsage/updated",
        threadId: "",
        providerThreadId: "",
        scope: turnScope(turnId),
        contextWindowUsage: {
          usedTokens: 54321,
          modelContextWindow: 123456,
          estimated: true,
          cost: { amount: 0.6, currency: "USD" },
        },
      }),
    );
  });

  it("clears stale tool state when a turn ends without tool results", () => {
    const harness = createHarness();

    harness.translate(loadFixture("agent-start.json"));
    harness.translate({
      type: "tool_execution_start",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      args: { command: "npm test", cwd: "/repo" },
    });
    harness.translate(loadSettledAgentEndFixture());

    harness.translate(loadFixture("agent-start.json"));
    const events = harness.translate({
      type: "tool_execution_end",
      toolCallId: "tool-bash-1",
      toolName: "bash",
      isError: false,
      result: "late output",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          type: "toolCall",
          tool: "bash",
          result: "late output",
        }),
      }),
    );
  });

  it("prompt-settled settles only a turn owed to accepted input", () => {
    const harness = createHarness();
    const settled = {
      jsonrpc: "2.0",
      method: "omp/prompt/settled",
      params: { threadId: THREAD_ID, status: "completed" as const },
    };

    expect(harness.translate(settled)).toEqual([]);

    harness.assembler.assemble({
      threadId: THREAD_ID,
      deltas: [
        {
          kind: "input.accepted",
          clientRequestId: "creq_abcdefghjk" as never,
        },
      ],
    });
    const events = harness.translate(settled);
    expect(events.map((event) => event.type)).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);
  });

  it.each(["aborted", "error"])(
    "structured %s without errorMessage cannot complete successfully",
    (stopReason) => {
      const harness = createHarness();
      harness.translate(loadFixture("agent-start.json"));
      const events = harness.translate(
        sdkMessage({
          type: "agent_end",
          deferSettlement: false,
          messages: [
            { role: "assistant", stopReason, content: [] },
            { role: "toolResult", content: [] },
          ],
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "turn/completed", status: "failed" }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider/error",
          detail: expect.any(String),
        }),
      );
      expect(
        events.some(
          (event) =>
            event.type === "turn/completed" && event.status === "completed",
        ),
      ).toBe(false);
    },
  );

  it("defers finality across native recovery and does not double-count text or usage at settlement", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const initial = translator.translate(
      sdkMessage({
        type: "agent_end",
        deferSettlement: true,
        messages: [
          {
            role: "assistant",
            stopReason: "length",
            content: [{ type: "text", text: "partial" }],
            usage: { input: 2, output: 3 },
          },
        ],
      }),
    );
    expect(initial.some((delta) => delta.kind === "turn.boundary")).toBe(false);
    expect(initial.filter((delta) => delta.kind === "usage")).toHaveLength(1);
    const settled = translator.translate(
      sdkMessage({
        type: "agent_end",
        settlementOnly: true,
        providerCheckpointId: "settled-checkpoint",
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "partial" }],
            usage: { input: 2, output: 3 },
          },
        ],
      }),
    );
    expect(settled).toEqual([
      expect.objectContaining({
        kind: "turn.boundary",
        status: "completed",
        providerCheckpointId: "settled-checkpoint",
      }),
    ]);
  });

  it("reports a failed run that queued work superseded without ending the turn", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const failedAttempt = translator.translate(
      sdkMessage({
        type: "agent_end",
        deferSettlement: true,
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "original prompt failed",
            content: [],
            usage: { input: 0, output: 0 },
          },
        ],
      }),
    );
    expect(failedAttempt).toEqual([]);
    expect(
      translator.translate(
        sdkMessage({
          type: "agent_end",
          deferSettlement: true,
          settlementSuperseded: true,
          settlementError: "original prompt failed",
          messages: [],
        }),
      ),
    ).toEqual([
      {
        kind: "provider.error",
        message: "Provider error",
        detail: "original prompt failed",
      },
    ]);
  });

  it("normalizes structured prompt settlement errors without promising a retry", () => {
    const translator = createOmpDeltaTranslator({ resolveModelContextWindow: fixtureModelResolver });
    const deltas = translator.translate({
      type: "agent_end", settlementOnly: true, settlementError: "Request rejected", messages: [],
      settlementErrorInfo: {
        message: "Request rejected", provider: "anthropic", model: "claude-sonnet-4-6",
        httpStatus: 429, retryable: true,
      },
    });
    expect(deltas).toContainEqual(expect.objectContaining({
      kind: "provider.error",
      errorInfo: { category: "unknown", httpStatusCode: 429, providerCode: "anthropic" },
      detail: expect.stringContaining("claude-sonnet-4-6"),
    }));
    const error = deltas.find((delta) => delta.kind === "provider.error");
    if (error?.kind !== "provider.error") throw new Error("Expected provider error");
    expect(error.detail).toContain("Retryable: yes");
    expect(error.willRetry).toBeUndefined();
    expect(threadDeltaSchema.safeParse(error).success).toBe(true);
  });

  it("does not repeat a recovery failure that compaction already reported", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const compaction = translator.translate(
      sdkMessage({
        type: "auto_compaction_end",
        aborted: false,
        errorMessage: "overflow recovery exhausted",
      }),
    );
    expect(
      compaction.filter((delta) => delta.kind === "provider.error"),
    ).toEqual([
      expect.objectContaining({ detail: "overflow recovery exhausted" }),
    ]);
    expect(
      translator.translate(
        sdkMessage({
          type: "agent_end",
          settlementOnly: true,
          settlementError: "overflow recovery exhausted",
          settlementErrorReported: true,
          providerCheckpointId: "settled-checkpoint",
          messages: [],
        }),
      ),
    ).toEqual([
      {
        kind: "turn.boundary",
        status: "failed",
        providerCheckpointId: "settled-checkpoint",
      },
    ]);
  });

  it("intentional host settlement interrupts without reporting an aborted assistant as an error", () => {
    const translator = createOmpDeltaTranslator({
      resolveModelContextWindow: fixtureModelResolver,
    });
    const deltas = translator.translate(
      sdkMessage({
        type: "agent_end",
        settlementOnly: true,
        settlementStatus: "interrupted",
        providerCheckpointId: "interrupted-entry",
        messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
      }),
    );

    expect(deltas).toEqual([
      expect.objectContaining({
        kind: "turn.boundary",
        status: "interrupted",
        providerCheckpointId: "interrupted-entry",
      }),
    ]);
  });

  it("session error envelopes settle the open turn as failed", () => {
    const harness = createHarness();
    harness.translate(loadFixture("agent-start.json"));
    const turnId = harness.openTurnId();

    const events = harness.translate({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: THREAD_ID, message: "omp exploded" },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/error",
        scope: turnScope(turnId),
        message: "Provider error",
        detail: "omp exploded",
      }),
      expect.objectContaining({
        type: "turn/completed",
        scope: turnScope(turnId),
        status: "failed",
      }),
    ]);
  });
});

describe("omp display file links", () => {
  let directory: string;
  let localDir: string;
  let context: OmpTestContext;

  beforeEach(() => {
    directory = mkdtempSync(resolve(tmpdir(), "bb-omp-link-translation-"));
    localDir = resolve(directory, "local");
    mkdirSync(localDir);
    writeFileSync(resolve(localDir, "plan.md"), "# Plan");
    context = { fileRoots: { localDir } };
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(["message_end", "agent_end"])("rewrites the final assistant text from %s without changing omp messages", (kind) => {
    const harness = createHarness();
    harness.translate({ type: "agent_start" }, context);
    const boundary = createAssistantMessageEnd("Open local://plan.md:10-20.", "file-message");
    const original = JSON.stringify(boundary);
    const event = kind === "message_end" ? boundary : {
      type: "agent_end", messages: [boundary.message],
    };
    const events = harness.translate(event, context);
    expect(events).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({
        type: "agentMessage",
        text: `Open [local://plan.md:10-20](${localDir}/plan.md#L10-L20).`,
      }),
    }));
    expect(JSON.stringify(boundary)).toBe(original);
  });

  it("replaces split streamed URLs on the same item instead of appending a duplicate", () => {
    const harness = createHarness();
    harness.translate({ type: "agent_start" }, context);
    const streamed = ["Open loc", "al://pl", "an.md."].flatMap((delta) => harness.translate({
      type: "message_update",
      messageId: "file-message",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    }, context));
    const streamedId = agentMessageDeltaId(streamed);
    const textDeltas = streamed.filter((event) => event.type === "item/agentMessage/delta");
    expect(textDeltas.map((event) => event.delta).join("")).toBe("Open local://plan.md.");

    const boundary = createAssistantMessageEnd("Open local://plan.md.", "file-message");
    const completed = harness.translate(boundary, context);
    expect(completed.filter((event) => event.type === "item/completed" &&
      event.item.type === "agentMessage")).toEqual([
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({
          id: streamedId,
          type: "agentMessage",
          text: `Open [local://plan.md](${localDir}/plan.md).`,
        }),
      }),
    ]);
    expect(completed.some((event) => event.type === "item/agentMessage/delta")).toBe(false);
    expect(harness.translate({ type: "agent_end", messages: [boundary.message] }, context)).toEqual([]);
  });

  it.each(["thinking_end", "message_end"])("rewrites final reasoning text from %s", (kind) => {
    const harness = createHarness();
    harness.translate({ type: "agent_start" }, context);
    const streamed = harness.translate({
      type: "message_update",
      messageId: "file-message",
      assistantMessageEvent: {
        type: "thinking_delta", contentIndex: 0, delta: "Inspect local://plan.md",
      },
    }, context);
    const reasoning = streamed.find((event) => event.type === "item/reasoning/textDelta");
    const boundary = createAssistantMessageEnd("Answer", "file-message");
    const event = kind === "thinking_end" ? {
      type: "message_update",
      messageId: "file-message",
      assistantMessageEvent: {
        type: "thinking_end", contentIndex: 0, content: "Inspect local://plan.md",
      },
    } : {
      ...boundary,
      message: {
        ...boundary.message,
        content: [
          { type: "thinking", thinking: "Inspect local://plan.md" },
          { type: "text", text: "Answer" },
        ],
      },
    };
    expect(harness.translate(event, context)).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({
        id: reasoning?.itemId,
        type: "reasoning",
        content: [`Inspect [local://plan.md](${localDir}/plan.md)`],
      }),
    }));
  });

  it("keeps native URLs when roots are absent and preserves literal tool output", () => {
    const harness = createHarness();
    harness.translate({ type: "agent_start" });
    expect(harness.translate(createAssistantMessageEnd("local://plan.md"))).toContainEqual(
      expect.objectContaining({
        type: "item/completed",
        item: expect.objectContaining({ type: "agentMessage", text: "local://plan.md" }),
      }),
    );
    harness.translate({
      type: "tool_execution_start", toolName: "read", toolCallId: "file-read",
      args: { path: "plan.md" },
    }, context);
    const result = { content: [{ type: "text", text: "local://plan.md" }] };
    expect(harness.translate({
      type: "tool_execution_end", toolName: "read", toolCallId: "file-read", result,
    }, context)).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({ type: "toolCall", result }),
    }));
  });
});
