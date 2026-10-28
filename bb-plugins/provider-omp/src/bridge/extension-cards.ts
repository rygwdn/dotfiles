import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { OMP_CARD_KIND, type OmpCard } from "../extension-ui-contract.js";
import { boundOmpCard } from "../omp-cards.js";

export function createOmpCardDeltas(
  card: OmpCard,
  { activeTurn, id }: { activeTurn: boolean; id: string },
): ThreadDelta[] {
  const payload = boundOmpCard(card);
  const glyph = payload.type === "irc_message" || payload.type.startsWith("irc:")
    ? "MessageSquare"
    : payload.tone === "error" ? "CircleX" : payload.tone === "warning" ? "AlertTriangle" : payload.tone === "success" ? "Check" : "Info";
  // Only bb's fallback body (payload unparseable or ExtensionCard crashed)
  // shows detail. `||` so empty headings/meta never hide the body.
  const detail = payload.sections.map((section) => section.heading || section.body || section.meta || "").filter(Boolean).join(" · ").replace(/\s+/gu, " ").trim();
  let detailEnd = 279;
  if (/[\ud800-\udbff]/u.test(detail[detailEnd - 1] ?? "")) detailEnd--;
  return [
    ...(!activeTurn ? [{ kind: "turn.open" } as const] : []),
    {
      kind: "item.close",
      key: { providerItemId: `omp-card:${JSON.stringify(id)}` },
      item: { type: "extension", kind: OMP_CARD_KIND, payload },
      status: "completed",
      // bb's collapsed row reads label then title; the title holds only the
      // short summary so the card title never repeats.
      presentation: {
        label: { pending: payload.title, completed: payload.title },
        icon: { glyph },
        ...(payload.summary ? { title: payload.summary } : {}),
        detail: detail.length > 280 ? `${detail.slice(0, detailEnd)}…` : detail,
      },
    },
    ...(!activeTurn ? [{ kind: "turn.boundary", status: "completed" } as const] : []),
  ];
}
