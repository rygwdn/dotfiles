import { Buffer } from "node:buffer";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import {
  OMP_NOTICE_KIND,
  stripOmpAnsi,
  type OmpNotice,
} from "../extension-ui-contract.js";

const EXTENSION_PAYLOAD_MAX_BYTES = 64 * 1024;
const TITLE_MAX_LENGTH = 200;
const DETAIL_MAX_LENGTH = 280;

const SEVERITY_PRESENTATION = {
  info: { label: "Info", glyph: "Info", tone: "neutral" },
  warning: { label: "Warning", glyph: "AlertTriangle", tone: "neutral" },
  error: { label: "Error", glyph: "CircleX", tone: "destructive" },
} as const;

function clip(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function createOmpNoticeDeltas(
  notice: OmpNotice,
  { activeTurn, id, status }: {
    activeTurn: boolean;
    id: string;
    status?: "inProgress" | "completed" | "failed";
  },
): ThreadDelta[] {
  const payload: OmpNotice = {
    severity: notice.severity,
    message: stripOmpAnsi(notice.message),
    ...(notice.url !== undefined ? { url: notice.url } : {}),
    ...(notice.launchUrl !== undefined ? { launchUrl: notice.launchUrl } : {}),
    ...(notice.instructions !== undefined
      ? { instructions: stripOmpAnsi(notice.instructions) }
      : {}),
  };
  // Lifecycle notices must stay updatable instead of falling back to an
  // immutable warning. Six bytes per code unit covers JSON's worst escaping.
  if (status !== undefined &&
    Buffer.byteLength(JSON.stringify(payload), "utf8") > EXTENSION_PAYLOAD_MAX_BYTES) {
    payload.message = clip(payload.message, Math.floor(EXTENSION_PAYLOAD_MAX_BYTES / 6) - 128);
  }
  const severity = SEVERITY_PRESENTATION[payload.severity];
  const preview = payload.message.replace(/\s+/gu, " ").trim();
  const title = clip(
    `OMP ${severity.label}${preview.length > 0 ? `: ${preview}` : ""}`,
    TITLE_MAX_LENGTH,
  );

  // URL notices need the structured renderer even when login runs outside a
  // model turn. Give just those notices a local turn; ordinary idle notices
  // remain thread-scoped warnings.
  if (
    (!activeTurn && !payload.url) ||
    Buffer.byteLength(JSON.stringify(payload), "utf8") >
      EXTENSION_PAYLOAD_MAX_BYTES
  ) {
    return [
      {
        kind: "provider.warning",
        category: "general",
        summary: title,
        details: [payload.message, payload.url, payload.launchUrl, payload.instructions]
          .filter((text) => text !== undefined)
          .join("\n\n"),
      },
    ];
  }

  return [
    ...(!activeTurn ? [{ kind: "turn.open" } as const] : []),
    {
      // JSON escaping keeps opaque IDs distinct and escapes bb's key separator.
      key: { providerItemId: `omp-notice:${JSON.stringify(id)}` },
      item: { type: "extension", kind: OMP_NOTICE_KIND, payload },
      ...(status === "inProgress"
        ? { kind: "item.open" as const }
        : { kind: "item.close" as const, status: status ?? "completed" }),
      presentation: {
        label: { pending: "OMP notification", completed: "OMP notification" },
        icon: { glyph: severity.glyph },
        title,
        detail: clip(preview, DETAIL_MAX_LENGTH),
        badge: {
          glyph: severity.glyph,
          label: severity.label,
          hint: `OMP ${severity.label.toLowerCase()} notification`,
          tone: severity.tone,
        },
      },
    },
    ...(!activeTurn ? [{ kind: "turn.boundary", status: "completed" } as const] : []),
  ];
}
