import { expect, it } from "vitest";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createOmpDeltaTranslator } from "./delta-translation.js";
import type { OmpSessionStats } from "./bridge/session-stats.js";

const context = { threadId: "usage-thread" };

function stats(tokens = 0): OmpSessionStats {
  return {
    sessionFile: "/sessions/resumed.jsonl", sessionId: "resumed",
    userMessages: 1, assistantMessages: tokens ? 3 : 0, toolCalls: 2, toolResults: 2, totalMessages: 6,
    tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
    premiumRequests: 3, cost: 0.6,
    credits: { cost: 2, committedCost: 1, acuCost: 0.5 },
    routedModels: { "routed-model": 3 },
    contextUsage: { tokens: 45, contextWindow: 100_000, percent: 0.045 },
  };
}

it("finishes three distinct assistant messages and reasoning items in a two-tool loop", () => {
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => 100_000 });
  const assembler = createDeltaAssembler({ providerId: "omp", entropyPrefix: "identity", textDeltaFlushMs: 0 });
  const events: ThreadEvent[] = [];
  const send = (event: unknown) => {
    const deltas = translator.translate(event, context);
    events.push(...assembler.assemble({ threadId: context.threadId, deltas }));
    return deltas;
  };
  send({ type: "agent_start" });
  const messages = [];
  for (let index = 1; index <= 3; index++) {
    const messageId = `msg-${index}`;
    send({ type: "message_start", messageId, message: { role: "assistant", content: [] } });
    send({ type: "message_update", messageId, assistantMessageEvent: {
      type: "thinking_delta", contentIndex: 0, delta: `Reasoning ${index}`,
    } });
    send({ type: "message_update", messageId, assistantMessageEvent: {
      type: "text_delta", contentIndex: 1, delta: `Draft ${index}`,
    } });
    const message = {
      role: "assistant", messageId, provider: "test", model: "test-model",
      stopReason: index < 3 ? "toolUse" : "stop",
      content: [
        { type: "thinking", thinking: `Reasoning ${index}` },
        { type: "text", text: `Answer ${index}` },
      ],
      usage: {
        input: 10 * index, output: 5 * index, cacheRead: 2 * index, cacheWrite: index,
        reasoningTokens: 3 * index, totalTokens: 18 * index,
        cost: { total: index / 10 },
      },
    };
    messages.push(message);
    const closed = send({ type: "message_end", messageId, message });
    expect(closed.filter((delta) => delta.kind === "item.textClose")).toHaveLength(2);
    expect(send({ type: "message_end", messageId, message })).toEqual([]);
    if (index < 3) {
      send({ type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "read", args: { path: "file.txt" } });
      send({ type: "tool_execution_end", toolCallId: `tool-${index}`, toolName: "read", result: { content: [] } });
    }
  }
  const snapshot = send({ type: "agent_end", messages, deferSettlement: true });
  expect(snapshot).toEqual([]);
  send({ type: "agent_end", messages, settlementOnly: true, providerCheckpointId: "checkpoint" });
  const completed = events.flatMap((event) => event.type === "item/completed" && event.item.type === "agentMessage" ? [event.item] : []);
  expect(completed.map((item) => item.text)).toEqual(["Answer 1", "Answer 2", "Answer 3"]);
  expect(new Set(completed.map((item) => item.id)).size).toBe(3);
  const reasoning = events.flatMap((event) => event.type === "item/completed" && event.item.type === "reasoning" ? [event.item] : []);
  expect(new Set(reasoning.map((item) => item.id)).size).toBe(3);
  const streamed = events.filter((event) => event.type === "item/agentMessage/delta");
  expect(streamed.map((event) => event.itemId)).toEqual(completed.map((item) => item.id));
  expect(events.findLast((event) => event.type === "thread/tokenUsage/updated")?.tokenUsage).toMatchObject({
    last: { totalTokens: 54 },
    total: {
      inputTokens: 60, outputTokens: 30, cachedInputTokens: 18,
      cacheReadInputTokens: 12, cacheWriteInputTokens: 6,
      reasoningOutputTokens: 18, totalTokens: 108,
    },
  });
  expect(events.filter((event) => event.type === "turn/completed")).toEqual([
    expect.objectContaining({ status: "completed", providerCheckpointId: "checkpoint" }),
  ]);
});

it("uses native resumed totals without adding assistant frames already covered by a stats reply", () => {
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => 100_000 });
  expect(translator.translate({ type: "bb_session_stats", stats: stats(100) }, context)).toEqual([]);
  translator.resetThread(context.threadId);
  translator.translate({ type: "agent_start" }, context);
  const message = {
    role: "assistant", content: [{ type: "text", text: "First resumed answer" }],
    usage: { input: 2, output: 3, totalTokens: 5 },
  };
  expect(translator.translate({ type: "message_end", messageId: "msg-1", message }, context)
    .some((delta) => delta.kind === "usage")).toBe(false);
  const first = translator.translate({ type: "bb_session_stats", stats: stats(112) }, context);
  expect(first).toContainEqual(expect.objectContaining({
    kind: "usage", total: expect.objectContaining({ totalTokens: 112 }),
    last: expect.objectContaining({ totalTokens: 5 }),
  }));
  // The native snapshot includes a second response and non-message model usage
  // before that second message_end has reached the translator.
  translator.translate({ type: "message_end", messageId: "msg-2", message }, context);
  const repeated = translator.translate({ type: "bb_session_stats", stats: stats(112) }, context);
  expect(repeated).toContainEqual(expect.objectContaining({
    kind: "usage", total: expect.objectContaining({ totalTokens: 112 }),
  }));
  expect(translator.translate({
    type: "agent_end", messages: [{ ...message, messageId: "msg-1" }, { ...message, messageId: "msg-2" }],
  }, context)).toEqual([]);
});
