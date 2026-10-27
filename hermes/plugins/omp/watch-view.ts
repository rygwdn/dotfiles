import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import type { Component } from "@oh-my-pi/pi-tui/tui";

type Assistant = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
// Supervisor journal frames are versioned OMP JSON, including extension-defined fields.
type Frame = Record<string, any>;
type MessageSlot = { message: Frame; component?: AssistantMessageComponent };

/** Journal-order projection. Never creates an agent or opens a session file. */
export class WatchTranscript {
  readonly blocks: Component[] = [];
  private messages = new Map<string, MessageSlot>();
  private tools = new Map<string, ToolExecutionComponent>();
  private currentMessage = "";
  private epoch = 0;
  private lastSeq = 0;
  private expanded = false;
  state = "Following journal";

  constructor(private readonly ui: ToolExecutionUi) {}

  private notice(text: string): void {
    this.blocks.push(new Text(text, 1, 0));
  }

  private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
    let component = this.tools.get(id);
    if (!component) {
      component = new ToolExecutionComponent(name, args, { showImages: false }, undefined, this.ui, undefined, id);
      component.setExpanded(this.expanded);
      this.tools.set(id, component);
      this.blocks.push(component);
    }
    return component;
  }

  private showMessage(slot: MessageSlot, transient: boolean): void {
    const message = slot.message;
    if (message.role === "assistant") {
      if (!slot.component) {
        slot.component = new AssistantMessageComponent(undefined, false, () => this.ui.requestRender());
        this.blocks.push(slot.component);
      }
      slot.component.updateContent(message as Assistant, { transient });
    }
  }

  apply(seq: number, frame: Frame): void {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    const kind = frame.type;
    if (kind === "worker_exit") {
      // OMP message and tool IDs restart when the same worker is resumed.
      this.dispose();
      this.epoch++;
      this.currentMessage = "";
      this.messages.clear();
      this.tools.clear();
      this.state = "worker exited";
      this.ui.requestRender();
      return;
    }
    if (kind === "message_start" || kind === "message_update" || kind === "message_end") {
      const id = `${this.epoch}:${frame.messageId ?? (kind === "message_start" ? seq : this.currentMessage)}`;
      let slot = this.messages.get(id);
      if (kind === "message_start") this.currentMessage = String(frame.messageId ?? seq);
      if (!slot) {
        slot = { message: structuredClone(frame.message ?? { role: "assistant", content: [] }) };
        this.messages.set(id, slot);
        if (slot.message.role === "user") {
          const content = slot.message.content;
          const text = typeof content === "string" ? content : (content ?? []).map((b: Frame) => b.type === "text" ? b.text : b.type === "image" ? "[Image]" : "").join("\n");
          this.blocks.push(new UserMessageComponent(text));
        }
      }
      if (kind === "message_update") {
        const update = frame.assistantMessageEvent ?? {};
        if (update.partial) slot.message = structuredClone(update.partial);
        else if (frame.message?.content) slot.message = structuredClone(frame.message);
        else {
          const content = slot.message.content ??= [];
          const index = update.contentIndex;
          if (Number.isInteger(index) && index >= 0) {
            if (update.type === "text_start") content[index] = { type: "text", text: "" };
            if (update.type === "thinking_start") content[index] = { type: "thinking", thinking: "" };
            if (update.type === "toolcall_start") content[index] = { type: "toolCall", id: "", name: "", arguments: {} };
            if (update.type === "toolcall_end") content[index] = update.toolCall;
            if (update.type === "image_end") content[index] = { type: "text", text: "[Generated image]" };
            if (update.type === "text_delta" || update.type === "thinking_delta") {
              const field = update.type === "text_delta" ? "text" : "thinking";
              const type = field === "text" ? "text" : "thinking";
              const block = content[index] ??= { type, [field]: "" };
              block[field] += update.delta;
            }
            if (update.type === "text_end") content[index] = { type: "text", text: update.content };
            if (update.type === "thinking_end") content[index] = { type: "thinking", thinking: update.content };
          }
        }
      }
      if (kind === "message_end") slot.message = structuredClone(frame.message);
      if (slot.message.role === "toolResult" && kind === "message_end") {
        const m = slot.message;
        this.tool(m.toolCallId, m.toolName, {}).updateResult(m, false, m.toolCallId);
      } else this.showMessage(slot, kind !== "message_end");
      if (kind === "message_end") this.messages.delete(id);
      this.ui.requestRender();
      return;
    }
    if (kind === "tool_execution_start") {
      const tool = this.tool(frame.toolCallId, frame.toolName, frame.args);
      tool.updateArgs(frame.args);
      tool.setArgsComplete();
      tool.setExecutionStarted();
    } else if (kind === "tool_execution_update" || kind === "tool_execution_end") {
      this.tool(frame.toolCallId, frame.toolName, frame.args ?? {}).updateResult(
        { ...(kind === "tool_execution_end" ? frame.result : frame.partialResult), isError: frame.isError },
        kind !== "tool_execution_end", frame.toolCallId,
      );
    } else if (kind === "extension_ui_request" && ["select", "confirm", "input", "editor", "ask"].includes(frame.method)) {
      this.notice(`[Input requested: ${frame.method ?? "dialog"}] Read-only viewer; answer through Hermes or the answer command.`);
    } else if (kind === "notice" || kind === "transport_error" || kind === "extension_error") {
      this.notice(`[${kind}] ${frame.message ?? frame.error ?? ""}`);
    } else if (kind === "worker_stopping" || kind === "session_settled" || kind === "agent_start") {
      this.state = kind.replaceAll("_", " ");
    } else return;
    this.ui.requestRender();
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    for (const block of this.blocks) {
      if ("setExpanded" in block) (block as ToolExecutionComponent).setExpanded(this.expanded);
    }
    this.ui.requestRender();
  }

  dispose(): void {
    for (const block of this.blocks) if (block instanceof ToolExecutionComponent) block.seal();
  }
}
