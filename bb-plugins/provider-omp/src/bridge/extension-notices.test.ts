import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  threadDeltaSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  OMP_NOTICE_KIND,
  ompNoticeSchema,
  type OmpNotice,
} from "../extension-ui-contract.js";
import { createOmpNoticeDeltas } from "./extension-notices.js";

const THREAD_ID = "notice-thread";
const PAYLOAD_MAX_BYTES = 64 * 1024;
const severities = [
  { severity: "info", label: "Info", glyph: "Info", tone: "neutral" },
  {
    severity: "warning",
    label: "Warning",
    glyph: "AlertTriangle",
    tone: "neutral",
  },
  {
    severity: "error",
    label: "Error",
    glyph: "CircleX",
    tone: "destructive",
  },
] as const;

function noticeDeltas(
  notice: OmpNotice,
  activeTurn = true,
  id = "notice-1",
): ThreadDelta[] {
  const deltas = createOmpNoticeDeltas(notice, { activeTurn, id });
  for (const delta of deltas) {
    expect(threadDeltaSchema.parse(delta)).toEqual(delta);
  }
  expect(deltas.some((delta) => delta.kind === "turn.open")).toBe(false);
  return deltas;
}

function createAssembler() {
  return createDeltaAssembler({
    providerId: "omp",
    entropyPrefix: "notice-test",
    textDeltaFlushMs: 0,
    progressThrottleMs: 0,
  });
}

describe("createOmpNoticeDeltas", () => {
  it.each([true, false])("preserves a structured sign-in link when activeTurn=%s", (activeTurn) => {
    const notice: OmpNotice = {
      severity: "info",
      message: "Open this link to continue signing in.",
      url: "https://auth.example.com/oauth?state=full",
      launchUrl: "http://127.0.0.1:1234/",
      instructions: "Sign in, then return here.",
    };
    const deltas = createOmpNoticeDeltas(notice, { activeTurn, id: "login-url" });
    for (const delta of deltas) expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
    expect(deltas).toContainEqual(expect.objectContaining({
      kind: "item.close",
      item: { type: "extension", kind: OMP_NOTICE_KIND, payload: notice },
    }));
    expect(deltas.some((delta) => delta.kind === "turn.open")).toBe(!activeTurn);
    expect(deltas.some((delta) => delta.kind === "turn.boundary")).toBe(!activeTurn);
    const assembler = createAssembler();
    if (activeTurn) assembler.assemble({ threadId: THREAD_ID, deltas: [{ kind: "turn.open" }] });
    const events = assembler.assemble({ threadId: THREAD_ID, deltas });
    expect(events).toContainEqual(expect.objectContaining({
      type: "item/completed",
      item: expect.objectContaining({ type: "extension", payload: notice }),
    }));
    expect(Boolean(assembler.getOpenTurnId(THREAD_ID))).toBe(activeTurn);
  });

  it.each(severities)(
    "presents an active $severity notification as a completed extension item",
    ({ severity, label, glyph, tone }) => {
      const notice = { severity, message: "First line\nFull second line" };
      const deltas = noticeDeltas(notice);
      expect(deltas).toEqual([
        {
          kind: "item.close",
          key: { providerItemId: expect.any(String) },
          item: { type: "extension", kind: OMP_NOTICE_KIND, payload: notice },
          status: "completed",
          presentation: {
            label: {
              pending: "OMP notification",
              completed: "OMP notification",
            },
            icon: { glyph },
            title: `OMP ${label}: First line Full second line`,
            detail: "First line Full second line",
            badge: {
              glyph,
              label,
              hint: `OMP ${severity} notification`,
              tone,
            },
          },
        },
      ]);
      const delta = deltas[0];
      if (delta?.kind !== "item.close" || delta.item.type !== "extension") {
        throw new Error("Expected a completed extension item");
      }
      expect(ompNoticeSchema.parse(delta.item.payload)).toEqual(notice);
    },
  );

  it("accepts a default-normalized informational notification", () => {
    const notice = ompNoticeSchema.parse({ message: "Default notification" });
    expect(notice.severity).toBe("info");
    expect(noticeDeltas(notice)).toMatchObject([
      {
        item: { payload: { severity: "info", message: "Default notification" } },
        presentation: { badge: { label: "Info" } },
      },
    ]);
    expect(noticeDeltas(notice, false)).toEqual([
      {
        kind: "provider.warning",
        category: "general",
        summary: "OMP Info: Default notification",
        details: "Default notification",
      },
    ]);
  });

  it("strips terminal styling and hyperlinks without flattening the full message", () => {
    const notice = {
      severity: "warning" as const,
      message:
        "\u001b[2K\u001b[31mFirst\u001b[0m\n\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007",
    };
    expect(noticeDeltas(notice)).toMatchObject([
      {
        item: { payload: { severity: "warning", message: "First\nlink" } },
        presentation: {
          title: "OMP Warning: First link",
          detail: "First link",
        },
      },
    ]);
    expect(noticeDeltas(notice, false)).toEqual([
      {
        kind: "provider.warning",
        category: "general",
        summary: "OMP Warning: First link",
        details: "First\nlink",
      },
    ]);
  });

  it("bounds title and detail while preserving the complete payload", () => {
    const message = "😀".repeat(1_000);
    const [delta] = noticeDeltas({ severity: "info", message });
    if (delta?.kind !== "item.close" || delta.item.type !== "extension") {
      throw new Error("Expected a completed extension item");
    }
    expect(delta.item.payload).toEqual({ severity: "info", message });
    expect(delta.presentation?.title?.length).toBeLessThanOrEqual(200);
    expect(delta.presentation?.detail?.length).toBeLessThanOrEqual(280);
    expect(delta.presentation?.title).toMatch(/…$/u);
    expect(delta.presentation?.detail).toMatch(/…$/u);
    expect(delta.presentation?.title).not.toMatch(/[\ud800-\udbff]…$/u);
    expect(delta.presentation?.detail).not.toMatch(/[\ud800-\udbff]…$/u);
  });

  it("retains empty normalized messages", () => {
    expect(noticeDeltas(ompNoticeSchema.parse({ message: "" }))).toMatchObject([
      {
        item: { payload: { severity: "info", message: "" } },
        presentation: { title: "OMP Info", detail: "" },
      },
    ]);
  });

  it("derives stable distinct provider item keys from opaque notice IDs", () => {
    const notice = { severity: "info" as const, message: "Same text" };
    const ids = ["notice-1", "notice-2", "", "notice\u001f1", "notice\\u001f1"];
    const keys = ids.map((id) => {
      const [delta] = noticeDeltas(notice, true, id);
      const [repeated] = noticeDeltas(notice, true, id);
      if (delta?.kind !== "item.close" || repeated?.kind !== "item.close") {
        throw new Error("Expected completed extension items");
      }
      expect(repeated.key).toEqual(delta.key);
      return delta.key.providerItemId;
    });
    expect(new Set(keys).size).toBe(ids.length);
  });

  it.each(severities)(
    "preserves idle $severity notices on the native warning surface",
    ({ severity, label }) => {
      const message = "Notice before or after an OMP turn\nFull details";
      const deltas = noticeDeltas({ severity, message }, false);
      expect(deltas).toEqual([
        {
          kind: "provider.warning",
          category: "general",
          summary: `OMP ${label}: Notice before or after an OMP turn Full details`,
          details: message,
        },
      ]);
      const assembler = createAssembler();
      const events = assembler.assemble({ threadId: THREAD_ID, deltas });
      expect(events).toEqual([
        expect.objectContaining({
          type: "provider/warning",
          scope: { kind: "thread" },
          summary: `OMP ${label}: Notice before or after an OMP turn Full details`,
          details: message,
        }),
      ]);
      expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
    },
  );

  it.each(severities)(
    "preserves the entire oversized $severity message with severity text",
    ({ severity, label }) => {
      const message = `First line\n${"large details ".repeat(10_000)}\nLast line`;
      const [delta] = noticeDeltas({ severity, message });
      expect(delta).toMatchObject({
        kind: "provider.warning",
        category: "general",
        details: message,
      });
      if (delta?.kind !== "provider.warning") {
        throw new Error("Expected native warning fallback");
      }
      expect(delta.summary).toMatch(new RegExp(`^OMP ${label}: First line`));
      expect(delta.summary?.length).toBeLessThanOrEqual(200);
      expect(delta.details).toBe(message);
    },
  );

  it("uses the serialized UTF-8 payload size and accepts exactly 64 KiB", () => {
    const severity = "info" as const;
    const overhead = Buffer.byteLength(JSON.stringify({ severity, message: "" }));
    const message = "x".repeat(PAYLOAD_MAX_BYTES - overhead);
    const [atLimit] = noticeDeltas({ severity, message });
    expect(atLimit?.kind).toBe("item.close");
    if (atLimit?.kind !== "item.close" || atLimit.item.type !== "extension") {
      throw new Error("Expected an extension payload at the exact size limit");
    }
    expect(Buffer.byteLength(JSON.stringify(atLimit.item.payload))).toBe(
      PAYLOAD_MAX_BYTES,
    );
    const [overLimit] = noticeDeltas({ severity, message: `${message}x` });
    expect(overLimit).toMatchObject({
      kind: "provider.warning",
      details: `${message}x`,
    });
  });

  it.each(["界".repeat(22_000), '"'.repeat(33_000)])(
    "falls back when UTF-8 or JSON escaping exceeds the payload cap",
    (message) => {
      expect(message.length).toBeLessThan(PAYLOAD_MAX_BYTES);
      expect(noticeDeltas({ severity: "info", message })).toEqual([
        expect.objectContaining({ kind: "provider.warning", details: message }),
      ]);
    },
  );

  it("measures the plain payload after ANSI removal", () => {
    const message = `${"\u001b[31m\u001b[0m".repeat(10_000)}Visible text`;
    expect(noticeDeltas({ severity: "info", message })).toMatchObject([
      { kind: "item.close", item: { payload: { message: "Visible text" } } },
    ]);
  });

  it.each(severities)(
    "attaches an active $severity extension item without opening or settling a turn",
    ({ severity }) => {
      const assembler = createAssembler();
      assembler.assemble({
        threadId: THREAD_ID,
        deltas: [{ kind: "turn.open" }],
      });
      const turnId = assembler.getOpenTurnId(THREAD_ID);
      const notice = { severity, message: "An active-turn notice" };
      const events = assembler.assemble({
        threadId: THREAD_ID,
        deltas: noticeDeltas(notice),
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: "item/completed",
          scope: { kind: "turn", turnId },
          item: expect.objectContaining({
            type: "extension",
            kind: OMP_NOTICE_KIND,
            payload: notice,
            status: "completed",
          }),
        }),
      ]);
      expect(assembler.getOpenTurnId(THREAD_ID)).toBe(turnId);
    },
  );

  it.each(["completed", "failed"] as const)(
    "keeps lifecycle notifications updatable through %s completion",
    (status) => {
      const assembler = createAssembler();
      assembler.assemble({ threadId: THREAD_ID, deltas: [{ kind: "turn.open" }] });
      const start = createOmpNoticeDeltas({
        severity: "warning",
        message: "\u0000".repeat(PAYLOAD_MAX_BYTES),
      }, { activeTurn: true, id: "retry-1", status: "inProgress" });
      start.forEach((delta) => expect(threadDeltaSchema.parse(delta)).toEqual(delta));
      const [opened] = assembler.assemble({ threadId: THREAD_ID, deltas: start });
      expect(opened).toMatchObject({
        type: "item/started",
        item: { type: "extension", kind: OMP_NOTICE_KIND, status: "pending" },
      });
      if (opened?.type !== "item/started" || opened.item.type !== "extension") {
        throw new Error("Expected lifecycle notice");
      }
      expect(Buffer.byteLength(JSON.stringify(opened.item.payload), "utf8")).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
      const end = createOmpNoticeDeltas({
        severity: status === "completed" ? "info" : "error",
        message: status === "completed" ? "Recovered" : "Retry cancelled",
      }, { activeTurn: true, id: "retry-1", status });
      end.forEach((delta) => expect(threadDeltaSchema.parse(delta)).toEqual(delta));
      expect(assembler.assemble({ threadId: THREAD_ID, deltas: end })).toEqual([
        expect.objectContaining({
          type: "item/completed",
          item: expect.objectContaining({
            id: opened.item.id,
            type: "extension",
            kind: OMP_NOTICE_KIND,
            status,
            payload: {
              severity: status === "completed" ? "info" : "error",
              message: status === "completed" ? "Recovered" : "Retry cancelled",
            },
          }),
        }),
      ]);
    },
  );

  it("does not fabricate a turn or reopen the last turn for a late notice", () => {
    const assembler = createAssembler();
    assembler.assemble({
      threadId: THREAD_ID,
      deltas: [{ kind: "turn.open" }, { kind: "turn.boundary", status: "completed" }],
    });
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
    const events = assembler.assemble({
      threadId: THREAD_ID,
      deltas: noticeDeltas({ severity: "info", message: "Late notice" }, false),
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider/warning",
        scope: { kind: "thread" },
        summary: "OMP Info: Late notice",
        details: "Late notice",
      }),
    ]);
    expect(assembler.getOpenTurnId(THREAD_ID)).toBeUndefined();
  });
});
