import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { OMP_CARD_KIND, type OmpCard } from "../extension-ui-contract.js";
import { boundOmpCard } from "../omp-cards.js";

export function createOmpCardDeltas(
  card: OmpCard,
  { activeTurn, id }: { activeTurn: boolean; id: string },
): ThreadDelta[] {
  const payload = boundOmpCard(card);
  const glyph = payload.tone === "error" ? "CircleX" : payload.tone === "warning" ? "AlertTriangle" : payload.tone === "success" ? "Check" : "Info";
  const detail = payload.sections.map((section) => section.heading ?? section.meta ?? section.body ?? "").filter(Boolean).join(" · ").replace(/\s+/gu, " ").trim();
  let detailEnd = 279;
  if (/[\ud800-\udbff]/u.test(detail[detailEnd - 1] ?? "")) detailEnd--;
  return [
    ...(!activeTurn ? [{ kind: "turn.open" } as const] : []),
    {
      kind: "item.close",
      key: { providerItemId: `omp-card:${JSON.stringify(id)}` },
      item: { type: "extension", kind: OMP_CARD_KIND, payload },
      status: "completed",
      presentation: {
        label: { pending: payload.title, completed: payload.title },
        icon: { glyph },
        title: payload.title,
        detail: detail.length > 280 ? `${detail.slice(0, detailEnd)}…` : detail,
      },
    },
    ...(!activeTurn ? [{ kind: "turn.boundary", status: "completed" } as const] : []),
  ];
}
