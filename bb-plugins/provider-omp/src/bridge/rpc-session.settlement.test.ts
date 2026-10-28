import { expect, it, vi } from "vitest";
import { OmpRpcSession, type OmpRpcEvent, type ToolCallForwarder } from "./rpc-session.js";
import { createOmpDeltaTranslator } from "../delta-translation.js";

function harness(
  forward: ToolCallForwarder = async () => ({ content: "tool result" }),
  onEvent: (event: OmpRpcEvent) => void = () => undefined,
) {
  const events: OmpRpcEvent[] = [];
  const done = vi.fn();
  let leafId = "checkpoint";
  let state = {
    isStreaming: false,
    isCompacting: false,
    sessionFile: "/sessions/generated.jsonl",
    model: { provider: "test", id: "initial", contextWindow: 100_000 },
  };
  const requestOk = vi.fn(async (command: Record<string, unknown>): Promise<unknown> => {
    switch (command.type) {
      case "get_tree": return { tree: [{ entry: { id: leafId, type: "message", parentId: null }, children: [] }], leafId };
      case "get_state": return state;
      case "get_session_stats": return {
        sessionFile: state.sessionFile, sessionId: "native-session",
        userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
        tokens: { input: 2, output: 3, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 5 },
        premiumRequests: 2, cost: 0.03,
        credits: { cost: 4, committedCost: 3, acuCost: 2 },
        routedModels: { "routed-model": 1 },
        contextUsage: { tokens: 42, contextWindow: 100_000, percent: 0.042 },
      };
      case "set_model":
        state = { ...state, model: { ...state.model, provider: String(command.provider), id: String(command.modelId) } };
        return state.model;
      case "compact": return { summary: "compacted", firstKeptEntryId: "kept", tokensBefore: 50 };
      default: return undefined;
    }
  });
  const child = {
    exited: false,
    // Like the real child: a successful reply is acknowledged before its promise settles.
    async requestOk(command: Record<string, unknown>, _timeoutMs?: number, onAcknowledged?: () => void) {
      const data = await requestOk(command);
      onAcknowledged?.();
      return data;
    },
    request: vi.fn(async () => ({ type: "response", success: true })),
    send: vi.fn(),
    kill: vi.fn(),
    closeGracefully: vi.fn(),
  };
  const session = new OmpRpcSession({
    cwd: ".", sessionDir: ".", scratchDir: ".", recordThreadId: "settlement-test",
  }, forward, (event) => { events.push(event); onEvent(event); }, done);
  const control = session as unknown as {
    child: typeof child;
    handleEvent(event: OmpRpcEvent): void;
    handleExit(info: { code: number | null; signal: null; stderrTail: string }): void;
    deliveryChain: Promise<void>;
    refreshContextUsage(): Promise<void>;
  };
  control.child = child;
  const event = (value: OmpRpcEvent) => control.handleEvent(value);
  return {
    session, child, requestOk, events, done, event, control,
    setLeaf(value: string) { leafId = value; },
    async prompt(text = "hello") {
      const dispatch = session.prompt(text);
      await dispatch.consumed;
      const command = requestOk.mock.calls.findLast(([value]) => value.type === "prompt")?.[0];
      expect(typeof command?.id).toBe("string");
      return { ...dispatch, id: String(command?.id) };
    },
    run(text = "answer", stopReason = "stop") {
      const message = {
        role: "assistant", content: [{ type: "text", text }], stopReason,
        model: "initial", provider: "test", api: "test", timestamp: 1,
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      };
      event({ type: "agent_start" });
      event({ type: "message_end", messageId: `message-${text}`, message });
      event({ type: "agent_end", messageCount: 1, isTerminal: true, yielded: true });
      return { ...message, messageId: `message-${text}` };
    },
    result(id: string, fields: Record<string, unknown> = {}) {
      event({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true, ...fields });
    },
    async flush() { await control.deliveryChain; },
  };
}

it("retains final message snapshots but waits for the correlated native result", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  const settled = vi.fn();
  void dispatch.settled.then(settled);
  const message = h.run("pong");
  await h.flush();
  expect(settled).not.toHaveBeenCalled();
  expect(h.events.find((event) => event.type === "agent_end")).toMatchObject({
    messages: [message], deferSettlement: true,
  });
  h.result("another-prompt");
  await h.flush();
  expect(settled).not.toHaveBeenCalled();
  h.setLeaf("final-leaf");
  h.result(dispatch.id);
  expect(await dispatch.settled).toEqual({ boundaryDelivered: true });
  h.event({ type: "session_settled" });
  h.event({ type: "session_settled" });
  await h.flush();
  expect(h.events.filter((event) => event.settlementOnly)).toEqual([
    expect.objectContaining({ messages: [message], providerCheckpointId: "final-leaf" }),
  ]);
  expect(h.done).not.toHaveBeenCalled();
});

it("settles the prompt and reports the error when the settlement handler throws", async () => {
  const failure = new Error("Could not read a subagent transcript");
  const h = harness(undefined, (event) => {
    if (event.settlementOnly) throw failure;
  });
  const dispatch = await h.prompt();
  h.run("pong");
  h.result(dispatch.id);
  expect(await dispatch.settled).toEqual({ boundaryDelivered: true });
  await h.flush();
  expect(h.done).toHaveBeenCalledWith(failure);
});

it("retains every assistant message identity when the native ending omits its snapshots", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.event({ type: "agent_start" });
  const messages = Array.from({ length: 3 }, (_, index) => ({
    role: "assistant", content: [{ type: "text", text: `Answer ${index}` }],
    stopReason: index === 2 ? "stop" : "toolUse",
    usage: { input: 2, output: 3, totalTokens: 5 },
    messageId: `msg-${index}`,
  }));
  for (const message of messages) {
    const { messageId, ...snapshot } = message;
    h.event({ type: "message_end", messageId, message: snapshot });
  }
  h.event({ type: "agent_end", messageCount: 3, messages: [] });
  h.result(dispatch.id);
  expect(await dispatch.settled).toEqual({ boundaryDelivered: true });
  expect(h.events.filter((event) => event.type === "agent_end")).toEqual([
    expect.objectContaining({ messages, deferSettlement: true }),
    expect.objectContaining({ messages, settlementOnly: true }),
  ]);
});

it("keeps the turn open through a yielded background task and its autonomous continuation", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  const settled = vi.fn();
  void dispatch.settled.then(settled);
  h.run("yielded");
  h.result(dispatch.id, { sessionSettled: false });
  await h.flush();
  expect(settled).not.toHaveBeenCalled();
  expect(h.events.filter((event) => event.settlementOnly)).toHaveLength(0);
  const last = h.run("background complete");
  h.event({ type: "session_settled" });
  expect(await dispatch.settled).toEqual({ boundaryDelivered: true });
  expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(1);
  expect(h.events.filter((event) => event.settlementOnly)).toEqual([
    expect.objectContaining({ messages: [last] }),
  ]);
});

it("preserves ordered checkpoints when a later run starts before the earlier tree reply", async () => {
  const h = harness();
  const firstTree = Promise.withResolvers<unknown>();
  h.requestOk.mockImplementationOnce(async () => undefined);
  const first = await h.prompt("A");
  h.run("A");
  h.requestOk.mockImplementationOnce(() => firstTree.promise);
  h.result(first.id);
  const second = await h.prompt("B");
  h.run("B");
  h.setLeaf("leaf-B");
  h.result(second.id);
  firstTree.resolve({ tree: [{ entry: { id: "leaf-A", type: "message", parentId: null }, children: [] }], leafId: "leaf-A" });
  await Promise.all([first.settled, second.settled]);
  expect(h.events.filter((event) => event.settlementOnly).map((event) => event.providerCheckpointId)).toEqual([
    "leaf-A", "leaf-B",
  ]);
  expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(2);
});

it("exposes a forkable conversation checkpoint when OMP's leaf is bookkeeping", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.run("answer");
  h.requestOk.mockResolvedValueOnce({
    leafId: "usage-entry",
    tree: [{
      entry: { id: "answer-entry", type: "message", parentId: null },
      children: [{ entry: { id: "usage-entry", type: "model_usage", parentId: "answer-entry" }, children: [] }],
    }],
  });
  h.result(dispatch.id);
  await dispatch.settled;
  expect(h.events.filter((event) => event.settlementOnly)).toEqual([
    expect.objectContaining({ providerCheckpointId: "answer-entry" }),
  ]);
});

it("handles a local-only ack without waiting for a nonexistent prompt_result", async () => {
  const h = harness();
  h.requestOk.mockResolvedValueOnce({ agentInvoked: false });
  const dispatch = h.session.prompt("/local-command");
  await dispatch.consumed;
  expect(await dispatch.settled).toEqual({ localCommandDone: true });
  expect(h.events).toEqual([expect.objectContaining({ type: "bb_session_stats" })]);
  expect(h.session.getContextUsage()).toMatchObject({ tokens: 42, contextWindow: 100_000 });
  await expect(h.session.compact()).resolves.toMatchObject({ boundaryDelivered: true });
});

it("surfaces a native failed result even when no agent run was invoked", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.result(dispatch.id, { agentInvoked: false, status: "error", error: { message: "local dispatch failed", retryable: false } });
  expect(await dispatch.settled).toEqual({ error: new Error("local dispatch failed") });
  expect(h.events.filter((event) => event.settlementOnly)).toHaveLength(0);
});

it("keeps the original failed result visible when later queued work succeeds", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.run("failed", "error");
  h.result(dispatch.id, { status: "error", sessionSettled: false, error: { message: "original failure", retryable: false } });
  h.run("recovered");
  h.event({ type: "session_settled" });
  expect(await dispatch.settled).toEqual({ boundaryDelivered: true, error: new Error("original failure") });
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const deltas = h.events.flatMap((event) => translator.translate(event, { threadId: "thread" }));
  expect(deltas.filter((delta) => delta.kind === "provider.error")).toEqual([
    expect.objectContaining({ detail: expect.stringContaining("original failure") }),
  ]);
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "completed" }),
  ]);
});

it.each(["aborted", "error"])("fails unexpected native %s results once", async (status) => {
  const h = harness();
  const dispatch = await h.prompt();
  h.run("partial", status);
  h.result(dispatch.id, { status, ...(status === "error" ? { error: { message: "provider failed", retryable: false } } : {}) });
  const outcome = await dispatch.settled;
  expect(outcome?.error).toBeInstanceOf(Error);
  expect(h.events.filter((event) => event.settlementOnly)).toEqual([
    expect.objectContaining({ settlementError: expect.stringMatching(status === "aborted" ? /interrupted/ : /provider failed/) }),
  ]);
});

it.each([true, false])("preserves structured prompt failure fields with retryable=%s through settlement", async (retryable) => {
  const h = harness();
  const dispatch = await h.prompt();
  h.run("partial", "error");
  const error = {
    message: "Rate limit exceeded", provider: "anthropic", model: "claude-sonnet-4-6",
    httpStatus: 429, retryable,
  };
  h.result(dispatch.id, { status: "error", error });
  await dispatch.settled;
  expect(h.events.filter((event) => event.settlementOnly)).toEqual([
    expect.objectContaining({ settlementErrorInfo: error }),
  ]);
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const errors = h.events.flatMap((event) => translator.translate(event, { threadId: "thread" }))
    .filter((delta) => delta.kind === "provider.error");
  expect(errors).toEqual([expect.objectContaining({
    errorInfo: { category: "unknown", httpStatusCode: 429, providerCode: "anthropic" },
    detail: expect.stringContaining("claude-sonnet-4-6"),
  })]);
  expect(errors[0]?.willRetry).toBeUndefined();
  expect(errors[0]?.detail).toContain(retryable ? "Retryable: yes" : "Retryable: no");
});

it("marks an intentional abort interrupted and leaves the session available for another prompt", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.event({ type: "agent_start" });
  const abort = h.session.abort();
  h.event({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
  h.event({ type: "agent_end", messageCount: 1 });
  h.result(dispatch.id, { status: "aborted" });
  await abort;
  expect(await dispatch.settled).toEqual({ boundaryDelivered: true });
  expect(h.events.filter((event) => event.settlementOnly)).toEqual([
    expect.objectContaining({ settlementStatus: "interrupted" }),
  ]);
  expect(h.child.kill).not.toHaveBeenCalled();
  const next = await h.prompt("continue");
  h.run("continued");
  h.result(next.id);
  expect(await next.settled).toEqual({ boundaryDelivered: true });
});

it("correlates tool progress and completion by host id, preserving text and images", async () => {
  const result = Promise.withResolvers<{ content: string; images: { data: string; mimeType: string }[] }>();
  const forward: ToolCallForwarder = vi.fn(async (_name, _args, control) => {
    control?.onUpdate({ content: "working" });
    return result.promise;
  });
  const h = harness(forward);
  h.event({ type: "host_tool_call", id: "host-1", toolCallId: "agent-tool-9", toolName: "bb_tool", arguments: { value: 1 } });
  await vi.waitFor(() => expect(h.child.send).toHaveBeenCalledWith({
    type: "host_tool_update", id: "host-1", partialResult: { content: [{ type: "text", text: "working" }], details: {} },
  }));
  result.resolve({ content: "finished", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });
  await vi.waitFor(() => expect(h.child.send).toHaveBeenCalledWith({
    type: "host_tool_result", id: "host-1", result: { content: [
      { type: "text", text: "finished" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ], details: {} },
  }));
});

it("cancels one host call without forwarding late progress or a late result", async () => {
  const result = Promise.withResolvers<{ content: string }>();
  let control: Parameters<ToolCallForwarder>[2];
  const h = harness(async (_name, _args, value) => { control = value; return result.promise; });
  h.event({ type: "host_tool_call", id: "host-cancelled", toolCallId: "tool", toolName: "slow", arguments: {} });
  await vi.waitFor(() => expect(control).toBeDefined());
  h.event({ type: "host_tool_cancel", id: "cancel-1", targetId: "host-cancelled" });
  expect(control?.signal.aborted).toBe(true);
  control?.onUpdate({ content: "late progress" });
  result.resolve({ content: "late result" });
  await result.promise;
  await h.flush();
  expect(h.child.send).not.toHaveBeenCalled();
});

it("does not invoke a host tool cancelled before forwarding begins", async () => {
  const forward = vi.fn(async () => ({ content: "not invoked" }));
  const h = harness(forward);
  h.event({ type: "host_tool_call", id: "cancel-now", toolCallId: "tool", toolName: "side_effect", arguments: {} });
  h.event({ type: "host_tool_cancel", id: "cancel-1", targetId: "cancel-now" });
  await h.flush();
  expect(forward).not.toHaveBeenCalled();
  expect(h.child.send).not.toHaveBeenCalled();
});

it("reports thrown bb tool failures in the native host result", async () => {
  const h = harness(async () => { throw new Error("bb tool unavailable"); });
  h.event({ type: "host_tool_call", id: "host-error", toolCallId: "tool", toolName: "broken", arguments: {} });
  await vi.waitFor(() => expect(h.child.send).toHaveBeenCalledWith({
    type: "host_tool_result", id: "host-error", isError: true,
    result: { content: [{ type: "text", text: "bb tool unavailable" }], details: {} },
  }));
});

it("derives manual compaction lifecycle from the compact response", async () => {
  const h = harness();
  expect(await h.session.compact()).toEqual({ boundaryDelivered: true });
  expect(h.events).toEqual([
    { type: "bb_compaction_start" },
    expect.objectContaining({ type: "bb_session_stats" }),
    { type: "bb_compaction_end", aborted: false, result: { summary: "compacted", firstKeptEntryId: "kept", tokensBefore: 50 } },
  ]);
  expect(h.session.getContextUsage()).toEqual({ tokens: 42, contextWindow: 100_000, cost: 0.03 });
  expect(h.session.getSessionStats()).toMatchObject({
    tokens: { input: 2, output: 3, reasoning: 1, total: 5 },
    premiumRequests: 2, cost: 0.03,
    credits: { cost: 4, committedCost: 3, acuCost: 2 },
    routedModels: { "routed-model": 1 },
  });
  expect(h.session.getIsCompacting()).toBe(false);
});

it("refuses manual compaction without opening another turn while agent work is outstanding", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.run();
  await expect(h.session.compact()).rejects.toThrow("processing a turn");
  expect(h.events.some((event) => event.type === "bb_compaction_start")).toBe(false);
  h.result(dispatch.id);
  await dispatch.settled;
});

it("applies live model settings and tolerates unknown native events", async () => {
  const h = harness();
  await h.session.setModel({ provider: "other", id: "new" });
  await h.session.setThinkingLevel("max");
  expect(h.session.getLiveModel()).toMatchObject({ provider: "other", id: "new" });
  expect(h.session.getSessionFile()).toBe("/sessions/generated.jsonl");
  h.event({ type: "future_native_event", value: true });
  const dispatch = await h.prompt();
  h.run();
  h.result(dispatch.id);
  await dispatch.settled;
  expect(h.done).not.toHaveBeenCalled();
  expect(h.child.kill).not.toHaveBeenCalled();
});

it("delivers one explicit failed boundary after the streamed events when a child exits", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.event({ type: "agent_start" });
  h.event({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "partial", contentIndex: 0 },
  });
  h.child.exited = true;
  h.control.handleExit({ code: 1, signal: null, stderrTail: "terminated" });
  expect(await dispatch.settled).toEqual({
    boundaryDelivered: true, error: expect.objectContaining({ message: expect.stringContaining("terminated") }),
  });
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const deltas = h.events.flatMap((event) => translator.translate(event, { threadId: "thread" }));
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "failed" }),
  ]);
  expect(deltas.filter((delta) => delta.kind === "provider.error")).toHaveLength(1);
  expect(h.events.at(-1)).toMatchObject({ type: "agent_end", settlementOnly: true });
  expect(h.done).toHaveBeenCalledWith(expect.any(Error), true);
});

it("does not assign a late failed prompt result to a later successful native run", async () => {
  const h = harness();
  const dispatch = await h.prompt();
  h.run("earlier failure", "error");
  h.run("later success");
  h.result(dispatch.id, {
    status: "error", sessionSettled: true,
    error: { message: "earlier prompt failed", retryable: false },
  });
  expect(await dispatch.settled).toEqual({
    boundaryDelivered: true, error: new Error("earlier prompt failed"),
  });
  const translator = createOmpDeltaTranslator({ resolveModelContextWindow: () => null });
  const deltas = h.events.flatMap((event) => translator.translate(event, { threadId: "thread" }));
  expect(deltas.filter((delta) => delta.kind === "provider.error")).toEqual([
    expect.objectContaining({ detail: expect.stringContaining("earlier prompt failed") }),
  ]);
  expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
    expect.objectContaining({ status: "completed" }),
  ]);
});
