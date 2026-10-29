import {
  createProviderVisibilityMetadata,
  getRawSdkMessage,
  getRecordProperty,
  getStringProperty,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  JsonRpcMessage,
  ProviderRawEventDescription,
  ProviderVisibilityMetadata,
} from "@get-bb/plugin-sdk/provider-bridge";

function hasBlockContent(block: unknown, type: "text" | "thinking"): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return false;
  }
  const record = block as Record<string, unknown>;
  return (
    getStringProperty(record, "type") === type &&
    Boolean(getStringProperty(record, type))
  );
}

function hasAssistantSnapshotContent(
  snapshot: Record<string, unknown> | undefined,
  allowMissingRole = false,
): boolean {
  if (!snapshot) {
    return false;
  }
  const role = snapshot["role"];
  if (role !== "assistant" && !(allowMissingRole && role === undefined)) {
    return false;
  }
  const content = snapshot["content"];
  return (
    Array.isArray(content) &&
    content.some(
      (block: unknown) =>
        hasBlockContent(block, "text") || hasBlockContent(block, "thinking"),
    )
  );
}

function parseOmpRawEvent(event: JsonRpcMessage): ProviderRawEventDescription {
  switch (event.method) {
    case "thread/identity":
    case "thread/contextWindowUsage/updated":
    case "error":
      return { kind: event.method, coverage: "normalized" };
    case "sdk/message":
      break;
    default:
      return { kind: event.method, coverage: "unknown" };
  }

  const message = getRawSdkMessage(event);
  const type = message ? getStringProperty(message, "type") : undefined;
  const kind = `sdk/${type ?? "unknown"}`;
  if (!message) {
    return { kind, coverage: "noise" };
  }

  switch (type) {
    case "agent_start":
    case "agent_end":
    case "auto_compaction_start":
    case "auto_compaction_end":
    case "manual_compaction_start":
    case "manual_compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "retry_fallback_applied":
    case "notice":
    case "ttsr_triggered":
    case "irc_message":
    case "todo_reminder":
    case "bb_compaction_start":
    case "bb_compaction_end":
    case "bb_extension_ui_state":
    case "extension_error":
    case "bb_rpc_response_error":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_stream_update":
    case "tool_execution_end":
      return { kind, coverage: "normalized" };

    case "message_start":
    case "message_end": {
      const payload = getRecordProperty(message, "message");
      const role = payload ? getStringProperty(payload, "role") : undefined;
      return {
        kind: role ? `${kind}:${role}` : kind,
        coverage:
          type === "message_start" &&
          role === "custom" &&
          payload?.["display"] === true
            ? "normalized"
            : "noise",
      };
    }

    case "message_update": {
      const assistantEvent = getRecordProperty(message, "assistantMessageEvent");
      if (!assistantEvent) {
        return { kind, coverage: "noise" };
      }
      const assistantType = getStringProperty(assistantEvent, "type");
      const updateKind = assistantType ? `${kind}:${assistantType}` : kind;
      const hasSnapshotContent =
        hasAssistantSnapshotContent(
          getRecordProperty(assistantEvent, "partial") ?? undefined,
          true,
        ) ||
        hasAssistantSnapshotContent(getRecordProperty(message, "message") ?? undefined);
      switch (assistantType) {
        case "text_delta":
          return { kind: updateKind, coverage: "normalized" };
        case "thinking_delta": {
          const delta = getStringProperty(assistantEvent, "delta");
          return {
            kind: updateKind,
            coverage: delta || hasSnapshotContent ? "normalized" : "noise",
          };
        }
        case "text_start":
        case "text_end":
        case "thinking_start":
        case "thinking_end": {
          const blockType = assistantType.startsWith("text_")
            ? "text"
            : "thinking";
          const content = assistantEvent["content"];
          return {
            kind: updateKind,
            coverage:
              (typeof content === "string" && content.length > 0) ||
              hasBlockContent(content, blockType) ||
              hasSnapshotContent
                ? "normalized"
                : "noise",
          };
        }
        case "start":
        case "done":
          return {
            kind: updateKind,
            coverage: hasSnapshotContent ? "normalized" : "noise",
          };
        default:
          // Assistant tool calls and unsupported blocks remain noise even if
          // accompanied by a snapshot; execution events alone own tool rows.
          return { kind: updateKind, coverage: "noise" };
      }
    }

    default:
      // Native control frames and future events are not raw UI items. Only
      // events explicitly normalized by the translator need a mapping here.
      return { kind, coverage: "noise" };
  }
}

export const ompVisibilityMetadata: ProviderVisibilityMetadata<ProviderRawEventDescription> =
  createProviderVisibilityMetadata({
    parseRawEvent: parseOmpRawEvent,
    describeParsedRawEvent: (event) => event,
  });
