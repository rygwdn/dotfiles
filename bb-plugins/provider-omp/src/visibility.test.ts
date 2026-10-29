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
    { type: "thinking_delta", delta: "Considering the options" },
    { type: "thinking_end", content: "The final reasoning" },
  ])("normalizes assistant $type", (assistantMessageEvent) => {
    expect(
      describeSdkEvent({ type: "message_update", assistantMessageEvent }),
    ).toEqual({
      kind: `sdk/message_update:${assistantMessageEvent.type}`,
      coverage: "normalized",
    });
  });

  it.each([
    { type: "thinking_delta", delta: "" },
    { type: "thinking_delta", delta: { text: "Not a string" } },
    { type: "thinking_end", content: "" },
    { type: "thinking_end", content: { thinking: "Not a string" } },
    { type: "text_start" },
    { type: "text_end", content: "Hello" },
    { type: "thinking_start" },
    { type: "toolcall_start" },
    { type: "toolcall_delta", delta: "{\"question\":" },
    { type: "toolcall_end", toolCall: { name: "ask" } },
    {
      type: "image_end",
      content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    },
    { type: "future_assistant_event", content: { arbitrary: true } },
  ])("ignores assistant $type safely", (assistantMessageEvent) => {
    expect(
      describeSdkEvent({
        type: "message_update",
        assistantMessageEvent,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Snapshot reasoning" }],
        },
      }),
    ).toEqual({
      kind: `sdk/message_update:${assistantMessageEvent.type}`,
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
