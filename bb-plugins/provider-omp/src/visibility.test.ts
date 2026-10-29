import { describe, expect, it } from "vitest";
import { ompVisibilityMetadata } from "./visibility.js";

function describeSdkEvent(message: unknown) {
  return ompVisibilityMetadata.describeRawEvent({
    jsonrpc: "2.0",
    method: "sdk/message",
    params: { threadId: "t1", message },
  });
}

describe("provider visibility raw events", () => {
  it("classifies shared handled non-sdk envelopes as normalized", () => {
    expect(
      ompVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "thread/contextWindowUsage/updated",
        params: {
          threadId: "t1",
          contextWindowUsage: {
            usedTokens: 12,
            modelContextWindow: 100,
            estimated: false,
          },
        },
      }),
    ).toEqual({
      kind: "thread/contextWindowUsage/updated",
      coverage: "normalized",
    });

    expect(
      ompVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "error",
        params: {
          message: "provider failed",
        },
      }),
    ).toEqual({
      kind: "error",
      coverage: "normalized",
    });
  });

  it("preserves thread identity normalization and unknown non-sdk fallback", () => {
    expect(
      ompVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "thread/identity",
        params: { threadId: "t1" },
      }),
    ).toEqual({ kind: "thread/identity", coverage: "normalized" });
    expect(
      ompVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "future/provider-event",
        params: { type: "ready" },
      }),
    ).toEqual({ kind: "future/provider-event", coverage: "unknown" });
  });

  it.each([
    "agent_start",
    "agent_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "manual_compaction_start",
    "manual_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "retry_fallback_applied",
    "notice",
    "ttsr_triggered",
    "irc_message",
    "todo_reminder",
    "bb_compaction_start",
    "bb_compaction_end",
    "extension_error",
    "bb_rpc_response_error",
  ])("classifies %s as normalized", (type) => {
    expect(describeSdkEvent({ type })).toEqual({
      kind: `sdk/${type}`,
      coverage: "normalized",
    });
  });

  it.each([
    { pendingRequestIds: ["ui-1", "ui-2"] },
    { pendingRequestIds: [] },
  ])(
    "normalizes persisted extension dialog state: $pendingRequestIds",
    ({ pendingRequestIds }) => {
      expect(
        describeSdkEvent({ type: "bb_extension_ui_state", pendingRequestIds }),
      ).toEqual({
        kind: "sdk/bb_extension_ui_state",
        coverage: "normalized",
      });
    },
  );

  it.each(["task", "todo", "ask"])(
    "classifies the generic %s tool lifecycle as normalized",
    (toolName) => {
      const tool = { toolCallId: "call-1", toolName };
      const args = { entries: [{ text: "Continue", completed: false }] };
      const result = {
        content: [{ type: "text", text: "Completed" }],
        details: { completed: true },
      };
      const events = [
        { ...tool, type: "tool_execution_start", args },
        {
          ...tool,
          type: "tool_execution_update",
          args,
          partialResult: result,
        },
        {
          ...tool,
          type: "tool_stream_update",
          update: { text: "Working", completed: 1 },
        },
        { ...tool, type: "tool_execution_end", result, isError: false },
      ];
      for (const event of events) {
        expect(describeSdkEvent(event)).toEqual({
          kind: `sdk/${event.type}`,
          coverage: "normalized",
        });
      }
    },
  );

  it.each([
    { type: "text_delta", delta: "Hello" },
    { type: "text_delta", delta: "" },
    { type: "text_start", content: "Hello" },
    { type: "text_end", content: "Hello" },
    { type: "thinking_delta", delta: "Considering the options" },
    {
      type: "thinking_start",
      contentIndex: 0,
      content: "Considering the options",
    },
    { type: "thinking_end", content: "The final reasoning" },
  ])("normalizes legacy string assistant $type", (assistantMessageEvent) => {
    expect(
      describeSdkEvent({ type: "message_update", assistantMessageEvent }),
    ).toEqual({
      kind: `sdk/message_update:${assistantMessageEvent.type}`,
      coverage: "normalized",
    });
  });

  it.each([
    { type: "text_start", content: { type: "text", text: "Hello" } },
    { type: "text_end", content: { type: "text", text: "Hello there" } },
    {
      type: "thinking_start",
      content: { type: "thinking", thinking: "Considering the options" },
    },
    {
      type: "thinking_end",
      content: { type: "thinking", thinking: "The final reasoning" },
    },
    {
      type: "thinking_end",
      content: { type: "thinking", thinking: "Narration", narration: true },
    },
  ])("normalizes block-bearing assistant $type", (assistantMessageEvent) => {
    expect(
      describeSdkEvent({
        type: "message_update",
        assistantMessageEvent: { ...assistantMessageEvent, contentIndex: 0 },
      }),
    ).toEqual({
      kind: `sdk/message_update:${assistantMessageEvent.type}`,
      coverage: "normalized",
    });
  });

  it.each([
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "done",
  ])("normalizes renderable %s restart snapshots", (type) => {
    for (const content of [
      [{ type: "text", text: "Recovered answer" }],
      [{ type: "thinking", thinking: "Recovered reasoning" }],
      [{ type: "thinking", thinking: "Recovered narration", narration: true }],
      [
        { type: "text", text: "Before the tool" },
        { type: "toolCall", id: "call-1", name: "ask", arguments: {} },
        { type: "thinking", thinking: "After the tool" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    ]) {
      const snapshot = { role: "assistant", content };
      for (const update of [
        {
          assistantMessageEvent: { type, contentIndex: 0 },
          message: snapshot,
        },
        {
          assistantMessageEvent: { type, contentIndex: 0, partial: snapshot },
        },
      ]) {
        expect(describeSdkEvent({ type: "message_update", ...update })).toEqual({
          kind: `sdk/message_update:${type}`,
          coverage: "normalized",
        });
      }
    }
  });

  it("preserves legacy partial snapshots without a role", () => {
    expect(
      describeSdkEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          partial: {
            content: [{ type: "thinking", thinking: "Recovered reasoning" }],
          },
        },
      }),
    ).toEqual({
      kind: "sdk/message_update:thinking_end",
      coverage: "normalized",
    });
  });

  it.each([
    { type: "thinking_delta", delta: "" },
    { type: "thinking_delta", delta: { text: "Not a string" } },
    { type: "thinking_end", content: "" },
    { type: "thinking_end", content: { thinking: "Missing block type" } },
    { type: "text_start" },
    { type: "text_start", content: { type: "text", text: "" } },
    { type: "text_end", content: "" },
    { type: "text_end", content: { type: "text", text: 42 } },
    {
      type: "text_end",
      content: { type: "thinking", thinking: "Wrong block type" },
    },
    { type: "thinking_start" },
    { type: "thinking_start", content: { type: "thinking", thinking: "" } },
    { type: "thinking_end", content: { type: "thinking", thinking: "" } },
    { type: "thinking_end", content: { type: "text", text: "Wrong block type" } },
    { type: "start" },
    { type: "done" },
  ])(
    "ignores empty or unsupported assistant $type content",
    (assistantMessageEvent) => {
      expect(
        describeSdkEvent({ type: "message_update", assistantMessageEvent }),
      ).toEqual({
        kind: `sdk/message_update:${assistantMessageEvent.type}`,
        coverage: "noise",
      });
    },
  );

  it.each([
    { type: "toolcall_start" },
    { type: "toolcall_delta", delta: "{\"question\":" },
    { type: "toolcall_end", toolCall: { name: "ask" } },
    {
      type: "image_end",
      content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    },
    { type: "future_assistant_event", content: { arbitrary: true } },
  ])(
    "ignores assistant $type even with renderable snapshots",
    (assistantMessageEvent) => {
      const snapshot = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Snapshot reasoning" },
          { type: "text", text: "Snapshot answer" },
        ],
      };
      expect(
        describeSdkEvent({
          type: "message_update",
          assistantMessageEvent: { ...assistantMessageEvent, partial: snapshot },
          message: snapshot,
        }),
      ).toEqual({
        kind: `sdk/message_update:${assistantMessageEvent.type}`,
        coverage: "noise",
      });
    },
  );

  it.each([
    { role: "assistant", content: [] },
    {
      role: "assistant",
      content: [
        null,
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "toolCall", name: "ask", arguments: {} },
        { type: "future", text: "Unsupported block" },
      ],
    },
    { role: "assistant", content: "Not a content-block array" },
    { role: "user", content: [{ type: "text", text: "User content" }] },
    { role: null, content: [{ type: "text", text: "Invalid role" }] },
    { role: 42, content: [{ type: "text", text: "Invalid role" }] },
  ])("ignores nonrenderable snapshots: %j", (snapshot) => {
    for (const update of [
      { assistantMessageEvent: { type: "start" }, message: snapshot },
      { assistantMessageEvent: { type: "start", partial: snapshot } },
    ]) {
      expect(describeSdkEvent({ type: "message_update", ...update })).toEqual({
        kind: "sdk/message_update:start",
        coverage: "noise",
      });
    }
  });

  it("requires an assistant role on an outer restart snapshot", () => {
    expect(
      describeSdkEvent({
        type: "message_update",
        assistantMessageEvent: { type: "start" },
        message: { content: [{ type: "text", text: "Missing role" }] },
      }),
    ).toEqual({
      kind: "sdk/message_update:start",
      coverage: "noise",
    });
  });

  it("normalizes only displayed custom message starts", () => {
    expect(
      describeSdkEvent({
        type: "message_start",
        message: { role: "custom", content: "Notice", display: true },
      }),
    ).toEqual({
      kind: "sdk/message_start:custom",
      coverage: "normalized",
    });
    for (const event of [
      {
        type: "message_start",
        message: { role: "custom", content: "Hidden", display: false },
      },
      {
        type: "message_end",
        message: { role: "custom", content: "Notice", display: true },
      },
      { type: "message_start", message: { role: "user", content: [] } },
      { type: "message_start", message: { role: "assistant", content: [] } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Snapshot for agent_end" }],
        },
      },
      { type: "message_end", message: { role: "future_role" } },
    ]) {
      expect(describeSdkEvent(event)).toEqual({
        kind: `sdk/${event.type}:${event.message.role}`,
        coverage: "noise",
      });
    }
  });

  it.each([
    { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] },
    {
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: true,
      status: "success",
      sessionSettled: true,
    },
    { type: "session_settled" },
    { type: "response", command: "get_available_models", success: true },
    { type: "available_commands_update", commands: [] },
    { type: "extension_ui_request", id: "ui-1", method: "setWidget" },
    { type: "extension_ui_request", id: "ui-2", method: "ask", questions: [] },
    { type: "subagent_lifecycle", payload: { subagentId: "worker-1" } },
    { type: "subagent_progress", payload: { subagentId: "worker-1" } },
    { type: "subagent_event", payload: { subagentId: "worker-1" } },
    { type: "host_tool_call", id: "host-1", toolName: "host-tool" },
    { type: "host_tool_cancel", id: "host-2", targetId: "host-1" },
    { type: "retry_fallback_succeeded" },
    { type: "config_warnings_changed" },
    { type: "turn_start" },
    { type: "turn_end" },
    { type: "cache_warming_start" },
    { type: "cache_warming_end" },
    { type: "todo_auto_clear" },
    { type: "model_changed" },
    { type: "queue_update", steering: [], followUp: [] },
    { type: "future_native_event", payload: { arbitrary: true } },
  ])("ignores native control or unmapped $type frames", (event) => {
    expect(describeSdkEvent(event)).toEqual({
      kind: `sdk/${event.type}`,
      coverage: "noise",
    });
  });

  it.each([undefined, null, {}, { type: 42 }, { type: "message_update" }])(
    "ignores incomplete sdk payloads: %j",
    (message) => {
      expect(describeSdkEvent(message).coverage).toBe("noise");
    },
  );

  it("ignores missing sdk envelope params", () => {
    expect(
      ompVisibilityMetadata.describeRawEvent({
        jsonrpc: "2.0",
        method: "sdk/message",
      }),
    ).toEqual({ kind: "sdk/unknown", coverage: "noise" });
  });
});
