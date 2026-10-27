import { beforeAll, expect, test } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { WatchTranscript } from "./watch-view";

beforeAll(async () => { await initTheme(); });
const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
const assistant = (text = "") => ({
  role: "assistant", content: text ? [{ type: "text", text }] : [],
  api: "openai-responses", provider: "openai", model: "test", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop",
});
const visible = (view: WatchTranscript) => Bun.stripANSI(view.blocks.flatMap(b => b.render(100)).join("\n"));

test("delta-only streaming renders before message_end and final snapshot replaces it", () => {
  const view = new WatchTranscript(ui);
  try {
    view.apply(1, { type: "message_start", messageId: "msg-1", message: assistant() });
    view.apply(2, { type: "message_update", messageId: "msg-1", message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    const delta = { type: "message_update", messageId: "msg-1", message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Streaming answer" } };
    view.apply(3, delta);
    view.apply(3, delta); // Redelivered cursor must not duplicate text.
    expect(visible(view)).toContain("Streaming answer");
    expect(visible(view)).not.toContain("Streaming answerStreaming answer");
    view.apply(4, { type: "message_end", messageId: "msg-1", message: assistant("Final answer") });
    expect(visible(view)).toContain("Final answer");
    expect(visible(view)).not.toContain("Streaming answer");
  } finally { view.dispose(); }
});

test("resuming a worker can reuse message IDs without overwriting earlier turns", () => {
  const view = new WatchTranscript(ui);
  try {
    view.apply(1, { type: "message_start", messageId: "msg-1", message: assistant("Before resume") });
    view.apply(2, { type: "worker_exit" });
    view.apply(3, { type: "message_start", messageId: "msg-1", message: assistant("After resume") });
    view.apply(4, { type: "message_end", messageId: "msg-1", message: assistant("After resume") });
    expect(visible(view)).toContain("Before resume");
    expect(visible(view)).toContain("After resume");
  } finally { view.dispose(); }
});

test("text after a streamed tool-call block remains visible before finalization", () => {
  const view = new WatchTranscript(ui);
  try {
    view.apply(1, { type: "message_start", messageId: "msg-1", message: assistant() });
    view.apply(2, { type: "message_update", messageId: "msg-1",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
    view.apply(3, { type: "message_update", messageId: "msg-1",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 0,
        toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } } } });
    view.apply(4, { type: "message_update", messageId: "msg-1",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
    view.apply(5, { type: "message_update", messageId: "msg-1",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Following tool call" } });
    expect(visible(view)).toContain("Following tool call");
  } finally { view.dispose(); }
});
