import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { interactionRequestPayloadSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
  OMP_EXTENSION_UI_KIND,
  OMP_EDITOR_TEXT_STATE_KIND,
  OMP_NOTICE_KIND,
  OMP_STATUS_LIMITS,
  OMP_STATUS_STATE_KIND,
  ompExtensionUiPayloadDataSchema,
  ompExtensionUiRequestSchema,
  ompNoticeSchema,
  ompStatusStateSchema,
  stripOmpAnsi,
  type InteractionUiRequest,
  type OmpEditorText,
  type OmpExtensionUiResponseFields,
  type OmpExtensionUiState,
  type OmpNotice,
  type OmpStatusState,
} from "../extension-ui-contract.js";
import { handleLine } from "./bridge.js";
import { createExtensionUiCoordinator } from "./extension-ui.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const interactionSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  method: z.literal("interaction/request"),
  params: z.object({
    providerThreadId: z.string(),
    threadId: z.string(),
    turnId: z.null(),
    payload: z.object({
      kind: z.literal(OMP_EXTENSION_UI_KIND),
      title: z.string(),
      data: ompExtensionUiPayloadDataSchema,
    }),
  }),
});

const askQuestions = [
  {
    id: "language",
    question: "Which language?",
    header: "Language",
    options: [
      { label: "TypeScript", description: "Typed JavaScript", preview: "const n: number = 1;" },
      { label: "Rust" },
    ],
    recommended: 0,
  },
  {
    id: "targets",
    question: "Which targets?",
    options: [{ label: "Web" }, { label: "CLI" }],
    multi: true,
  },
];

function coordinatorHarness() {
  const interactions: InteractionUiRequest[] = [];
  const states: Array<OmpExtensionUiState & {
    scope: object;
    threadId: string;
    providerThreadId: string;
  }> = [];
  const statusStates: Array<OmpStatusState & {
    scope: object;
    threadId: string;
    providerThreadId: string;
  }> = [];
  const notices: Array<OmpNotice & {
    scope: object;
    threadId: string;
    providerThreadId: string;
  }> = [];
  const editorRequests: Array<OmpEditorText & {
    scope: object;
    threadId: string;
    providerThreadId: string;
  }> = [];
  const respond = vi.fn<(id: string | number, fields: OmpExtensionUiResponseFields) => void>();
  const scope = {};
  const coordinator = createExtensionUiCoordinator({
    sendInteractionRequest: (request) => { interactions.push(request); },
    onStateChanged: (state) => { states.push(state); },
    onStatusChanged: (state) => { statusStates.push(state); },
    onNotice: (notice) => { notices.push(notice); },
    onEditorText: (request) => { editorRequests.push(request); },
  });
  const handle = (request: Record<string, unknown>, requestScope = scope, reply = respond) => {
    coordinator.handle({
      scope: requestScope,
      request,
      threadId: "thr_ui",
      providerThreadId: "omp_ui",
      respond: reply,
    });
  };
  return { coordinator, interactions, states, statusStates, notices, editorRequests, respond, scope, handle };
}

describe("native OMP extension UI coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { request: { method: "select", title: "Pick", options: ["A", "B"] }, value: "B", fields: { value: "B" } },
    { request: { method: "confirm", title: "Continue?", message: "Proceed?" }, value: true, fields: { confirmed: true } },
    { request: { method: "confirm", title: "Continue?", message: "Proceed?" }, value: false, fields: { confirmed: false } },
    { request: { method: "input", title: "Name", placeholder: "Your name" }, value: "hello", fields: { value: "hello" } },
    { request: { method: "input", title: "Name" }, value: "", fields: { value: "" } },
    { request: { method: "editor", title: "Edit", prefill: "first", promptStyle: true }, value: "first\nsecond", fields: { value: "first\nsecond" } },
    { request: { method: "editor", title: "Edit" }, value: "", fields: { value: "" } },
    {
      request: { method: "ask", questions: askQuestions },
      value: { answers: [{ id: "language", selectedOptions: ["TypeScript"] }, { id: "targets", selectedOptions: ["Web", "CLI"], customInput: " Mobile " }] },
      fields: { answers: [{ id: "language", selectedOptions: ["TypeScript"] }, { id: "targets", selectedOptions: ["Web", "CLI"], customInput: "Mobile" }] },
    },
    {
      request: { method: "ask", questions: askQuestions },
      value: { answers: [{ id: "language", selectedOptions: [], customInput: "Ruby" }, { id: "targets", selectedOptions: [] }] },
      fields: { answers: [{ id: "language", selectedOptions: [], customInput: "Ruby" }, { id: "targets", selectedOptions: [] }] },
    },
  ])("resolves $request.method with its native response shape", ({ request, value, fields }) => {
    const harness = coordinatorHarness();
    harness.handle({ type: "extension_ui_request", id: "native-ui", ...request });
    expect(harness.interactions).toHaveLength(1);
    expect(harness.coordinator.handleRuntimeResponse({
      id: harness.interactions[0]!.id,
      result: { kind: "request_answer", value },
    })).toBe(true);
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("native-ui", fields);
  });

  it("preserves select descriptions, prompt-style editing, and absolute dialog deadlines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = coordinatorHarness();
    harness.handle({ id: "select", method: "select", title: "Pick", options: ["A", "B"], optionDetails: [{}, { description: "Second" }], timeout: 250 });
    harness.handle({ id: "editor", method: "editor", title: "Edit", prefill: "draft", promptStyle: true });
    harness.handle({ id: "ask", method: "ask", questions: askQuestions, timeout: 500 });
    const coordinatorId = harness.states[0]!.coordinatorId;
    expect(harness.interactions[0]!.params.payload.data).toEqual({
      requestId: "omp-ui-1",
      lifecycle: { coordinatorId, sequence: 1 },
      method: "select",
      options: ["A", "B"],
      optionDetails: [{}, { description: "Second" }],
      timeout: 250,
      expiresAt: 1_250,
    });
    expect(harness.interactions[1]!.params.payload.data).toEqual({
      requestId: "omp-ui-2",
      lifecycle: { coordinatorId, sequence: 2 },
      method: "editor",
      prefill: "draft",
      promptStyle: true,
    });
    expect(harness.interactions[2]!.params.payload).toMatchObject({
      title: "Questions",
      data: {
        requestId: "omp-ui-3",
        lifecycle: { coordinatorId, sequence: 3 },
        method: "ask",
        questions: askQuestions,
        expiresAt: 1_500,
      },
    });
  });

  it.each([
    { method: "select", options: ["Approve", "Deny"] },
    { method: "confirm", message: "Proceed?" },
    { method: "input", placeholder: "Answer" },
    { method: "editor", prefill: "Draft" },
  ])("preserves a long multiline $method title in the body and accepts its bounded envelope", (request) => {
    const harness = coordinatorHarness();
    const title = "Full approval details\n".repeat(50).slice(0, 1_000);
    harness.handle({ id: "long-title", title, ...request });
    expect(harness.respond).not.toHaveBeenCalled();
    expect(harness.interactions).toHaveLength(1);
    const payload = harness.interactions[0]!.params.payload;
    expect(payload.title.length).toBeLessThanOrEqual(160);
    expect(payload.data.detail).toBe(title);
    expect(interactionRequestPayloadSchema.safeParse(payload).success).toBe(true);
  });

  const largeText = "😀\\\"\n".repeat(20_000);
  it.each([
    { method: "select", title: "Pick", options: ["Approve", "Deny"], optionDetails: [{ description: largeText }, { description: largeText }] },
    { method: "confirm", title: "Confirm", message: largeText },
    { method: "input", title: "Answer", placeholder: largeText },
    { method: "editor", title: "Edit", prefill: largeText },
    { method: "ask", questions: askQuestions.map((question) => ({
      ...question,
      header: "Long question header ".repeat(50),
      options: question.options.map((option) => ({ ...option, description: largeText, preview: largeText })),
    })) },
  ])("bounds the complete serialized UTF-8 $method data, retaining response identities and visible truncation", (request) => {
    const harness = coordinatorHarness();
    harness.handle({ id: "oversize", timeout: 1_000, ...request });
    expect(harness.respond).not.toHaveBeenCalled();
    expect(harness.interactions).toHaveLength(1);
    const payload = harness.interactions[0]!.params.payload;
    const serialized = JSON.stringify(payload.data);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(payload.data.lifecycle).toBeDefined();
    expect(payload.data.truncated).toBe(true);
    expect(serialized).toContain("truncated to fit bb");
    expect(payload.title.length).toBeLessThanOrEqual(160);
    expect(interactionRequestPayloadSchema.safeParse(payload).success).toBe(true);
    if (payload.data.method === "select") {
      expect(payload.data.options).toEqual(["Approve", "Deny"]);
      harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, result: { kind: "request_answer", value: "Approve" } });
      expect(harness.respond).toHaveBeenCalledWith("oversize", { value: "Approve" });
    } else if (payload.data.method === "ask") {
      expect(payload.data.questions.map((question) => question.id)).toEqual(["language", "targets"]);
      expect(payload.data.questions[0]!.options[0]!.label).toBe("TypeScript");
    }
  });

  it("rejects oversized stored dialog data rather than exposing an invalid bb payload", () => {
    expect(ompExtensionUiPayloadDataSchema.safeParse({
      requestId: "oversize",
      method: "editor",
      prefill: largeText,
    }).success).toBe(false);
  });

  it("publishes distinct thread-scoped editor replacements without answering fire-and-forget frames", () => {
    const harness = coordinatorHarness();
    harness.handle({ id: "editor", method: "set_editor_text", text: "first" });
    harness.handle({ id: "editor", method: "set_editor_text", text: "" });
    expect(harness.editorRequests).toHaveLength(2);
    expect(harness.editorRequests[0]).toMatchObject({ threadId: "thr_ui", providerThreadId: "omp_ui", scope: harness.scope, text: "first" });
    expect(harness.editorRequests[1]!.text).toBe("");
    expect(harness.editorRequests[0]!.requestId).not.toBe(harness.editorRequests[1]!.requestId);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it("publishes the full sign-in URL, short copy target, and instructions as a notice", () => {
    const harness = coordinatorHarness();
    const request = { method: "open_url", url: "https://auth.example.com/?state=full&code=abc", launchUrl: "http://127.0.0.1:1234/", instructions: "Sign in, then paste the returned code." };
    harness.handle({ id: "login-url", ...request });
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toMatchObject({ severity: "info", url: request.url, launchUrl: request.launchUrl, instructions: request.instructions });
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it.each([
    { method: "notify", message: "Notice" },
    { method: "setStatus", statusKey: "working", statusText: "Working" },
    { method: "setWidget", widgetKey: "summary", widgetLines: ["Hello"] },
    { method: "setTitle", title: "New title" },
    { method: "set_editor_text", text: "draft" },
    { method: "open_url", url: "https://example.com", launchUrl: "http://127.0.0.1:1234/" },
    { method: "future_notification" },
  ])("never responds to $method", (request) => {
    const harness = coordinatorHarness();
    harness.handle({ type: "extension_ui_request", id: "notice", ...request });
    expect(harness.interactions).toEqual([]);
    expect(harness.respond).not.toHaveBeenCalled();
    expect(harness.states).toEqual([]);
  });

  it("dismisses only the matching native request in the cancellation scope without answering either frame", () => {
    const harness = coordinatorHarness();
    const otherScope = {};
    const otherRespond = vi.fn();
    harness.handle({ id: "target", method: "input", title: "First" });
    harness.handle({ id: "target", method: "input", title: "Second" }, otherScope, otherRespond);
    const [first, second] = harness.interactions;
    harness.handle({ id: "cancellation", method: "cancel", targetId: "target" });
    expect(harness.interactions).toHaveLength(2);
    expect(harness.respond).not.toHaveBeenCalled();
    expect(otherRespond).not.toHaveBeenCalled();
    expect(harness.coordinator.handleRuntimeResponse({ id: first!.id, result: { kind: "request_answer", value: "late" } })).toBe(false);
    expect(harness.coordinator.handleRuntimeResponse({ id: second!.id, result: { kind: "request_answer", value: "current" } })).toBe(true);
    expect(otherRespond).toHaveBeenCalledExactlyOnceWith("target", { value: "current" });
  });

  it("publishes watermarked per-thread pending state across retiring and replacement scopes", () => {
    const harness = coordinatorHarness();
    const replacement = {};
    harness.handle({ id: "reused-native-id", method: "input", title: "Original" });
    harness.handle({ id: "reused-native-id", method: "input", title: "Replacement" }, replacement);
    harness.coordinator.handle({
      scope: replacement,
      request: { id: "other-thread", method: "input", title: "Other" },
      threadId: "thr_other",
      providerThreadId: "omp_other",
      respond: harness.respond,
    });
    const coordinatorId = harness.states[0]!.coordinatorId;
    expect(harness.states[0]).toMatchObject({
      threadId: "thr_ui",
      coordinatorId,
      issuedThrough: 1,
      pendingRequestIds: ["omp-ui-1"],
    });
    expect(harness.states[1]).toMatchObject({
      threadId: "thr_ui",
      coordinatorId,
      issuedThrough: 2,
      pendingRequestIds: ["omp-ui-1", "omp-ui-2"],
    });
    expect(harness.states[2]).toMatchObject({
      threadId: "thr_other",
      coordinatorId,
      issuedThrough: 3,
      pendingRequestIds: ["omp-ui-3"],
    });
    harness.coordinator.cancelPendingForScope(harness.scope);
    expect(harness.states.at(-1)).toMatchObject({
      scope: harness.scope,
      threadId: "thr_ui",
      coordinatorId,
      issuedThrough: 3,
      pendingRequestIds: ["omp-ui-2"],
    });
    harness.handle({ id: "cancel-new", method: "cancel", targetId: "reused-native-id" }, replacement);
    expect(harness.states.at(-1)).toMatchObject({
      scope: replacement,
      threadId: "thr_ui",
      coordinatorId,
      issuedThrough: 3,
      pendingRequestIds: [],
    });
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("reused-native-id", { cancelled: true });
  });

  it("ignores unknown or malformed native cancellation targets", () => {
    const harness = coordinatorHarness();
    harness.handle({ id: "input", method: "input", title: "Value" });
    harness.handle({ id: "cancel-1", method: "cancel", targetId: "unknown" });
    harness.handle({ id: "cancel-2", method: "cancel", targetId: 42 });
    expect(harness.respond).not.toHaveBeenCalled();
    harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, result: { kind: "request_answer", value: "kept" } });
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("input", { value: "kept" });
  });

  it("drops a timed-out native dialog on its cancel frame and ignores a late answer", () => {
    const harness = coordinatorHarness();
    harness.handle({ id: "timed", method: "ask", questions: askQuestions, timeout: 1 });
    harness.handle({ id: "timeout-cancel", method: "cancel", targetId: "timed" });
    expect(harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, result: { kind: "request_answer", value: { answers: [] } } })).toBe(false);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it.each([null, { cancelled: true }, { cancelled: true, timedOut: true }])("maps dismissal %j to a native cancellation", (value) => {
    const harness = coordinatorHarness();
    harness.handle({ id: "input", method: "input", title: "Value" });
    harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, result: { kind: "request_answer", value } });
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("input", value && "timedOut" in value ? { cancelled: true, timedOut: true } : { cancelled: true });
  });

  it.each([
    { answers: [] },
    { answers: [{ id: "targets", selectedOptions: [] }, { id: "language", selectedOptions: ["TypeScript"] }] },
    { answers: [{ id: "language", selectedOptions: ["0"] }, { id: "targets", selectedOptions: [] }] },
    { answers: [{ id: "language", selectedOptions: ["TypeScript", "Rust"] }, { id: "targets", selectedOptions: [] }] },
    { answers: [{ id: "language", selectedOptions: ["TypeScript"], customInput: "Ruby" }, { id: "targets", selectedOptions: [] }] },
    { answers: [{ id: "language", selectedOptions: ["TypeScript"] }, { id: "targets", selectedOptions: ["Web", "Web"] }] },
    { answers: [{ id: "language", selectedOptions: "TypeScript" }, { id: "targets", selectedOptions: [] }] },
    { answers: [{ id: "language", selectedOptions: ["TypeScript"] }, { id: "targets", selectedOptions: [], customInput: 42 }] },
  ])("cancels invalid ask answers instead of forwarding an invalid native frame: %j", (value) => {
    const harness = coordinatorHarness();
    harness.handle({ id: "ask", method: "ask", questions: askQuestions });
    harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, result: { kind: "request_answer", value } });
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("ask", { cancelled: true });
  });

  it.each([
    { method: "select", title: "Pick" },
    { method: "select", title: "Pick", options: [] },
    { method: "confirm", title: "Continue?" },
    { method: "input", title: " " },
    { method: "editor", title: "Edit", promptStyle: "yes" },
    { method: "ask", questions: [] },
    { method: "ask", questions: [askQuestions[0], askQuestions[0]] },
  ])("cancels malformed interactive requests: %j", (request) => {
    const harness = coordinatorHarness();
    harness.handle({ id: "invalid", ...request });
    expect(harness.interactions).toEqual([]);
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("invalid", { cancelled: true });
  });

  it("requires native string ids and validates stored renderer payloads using the same dialog schemas", () => {
    expect(ompExtensionUiRequestSchema.safeParse({ id: 1, method: "input", title: "Value" }).success).toBe(false);
    expect(ompExtensionUiRequestSchema.safeParse({ id: "ask", method: "ask", questions: askQuestions }).success).toBe(true);
    expect(ompExtensionUiPayloadDataSchema.safeParse({ requestId: "select", method: "select", options: [] }).success).toBe(false);
    expect(ompExtensionUiPayloadDataSchema.safeParse({ requestId: "ask", method: "ask", questions: askQuestions }).success).toBe(true);
  });

  it("answers runtime errors and invalid resolutions as cancelled", () => {
    const harness = coordinatorHarness();
    harness.handle({ id: "first", method: "input", title: "First" });
    harness.handle({ id: "second", method: "input", title: "Second" });
    harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, error: { message: "cancelled" } });
    harness.coordinator.handleRuntimeResponse({ id: harness.interactions[1]!.id, result: { kind: "other", value: "ignored" } });
    expect(harness.respond.mock.calls).toEqual([["first", { cancelled: true }], ["second", { cancelled: true }]]);
  });

  it("cancels all pending dialogs only for the closing scope", () => {
    const harness = coordinatorHarness();
    const otherScope = {};
    harness.handle({ id: "first", method: "input", title: "First" });
    harness.handle({ id: "second", method: "editor", title: "Second" });
    harness.handle({ id: "third", method: "input", title: "Third" }, otherScope);
    harness.coordinator.cancelPendingForScope(harness.scope);
    expect(harness.respond.mock.calls).toEqual([["first", { cancelled: true }], ["second", { cancelled: true }]]);
    expect(harness.coordinator.handleRuntimeResponse({ id: harness.interactions[0]!.id, result: { kind: "request_answer", value: "late" } })).toBe(false);
    expect(harness.coordinator.handleRuntimeResponse({ id: harness.interactions[2]!.id, result: { kind: "request_answer", value: "current" } })).toBe(true);
    expect(harness.respond).toHaveBeenLastCalledWith("third", { value: "current" });
  });

  it("cancels the native dialog when sending the runtime request fails", () => {
    const respond = vi.fn();
    const coordinator = createExtensionUiCoordinator({ sendInteractionRequest: () => { throw new Error("disconnected"); } });
    coordinator.handle({ scope: {}, request: { id: "input", method: "input", title: "Value" }, threadId: "thr_ui", providerThreadId: "omp_ui", respond });
    expect(respond).toHaveBeenCalledExactlyOnceWith("input", { cancelled: true });
    expect(coordinator.handleRuntimeResponse({ id: "omp-ui-1", result: { kind: "request_answer", value: "late" } })).toBe(false);
  });
});

describe("native OMP extension status and notices", () => {
  it("exports bounded snapshot schemas and a default informational notice", () => {
    expect(OMP_STATUS_STATE_KIND).toBe("provider-omp/status");
    expect(OMP_NOTICE_KIND).toBe("provider-omp/notice");
    expect(ompStatusStateSchema.parse({ statuses: [], widgets: [] })).toEqual({ statuses: [], widgets: [] });
    expect(ompNoticeSchema.parse({ message: "Hello" })).toEqual({ severity: "info", message: "Hello" });
    expect(ompStatusStateSchema.safeParse({
      statuses: Array.from({ length: OMP_STATUS_LIMITS.statusKeys + 1 }, () => ({ key: "", text: "" })),
      widgets: [],
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: [{ key: "k".repeat(OMP_STATUS_LIMITS.keyLength + 1), text: "" }],
      widgets: [],
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: [{ key: "", text: "x".repeat(OMP_STATUS_LIMITS.statusLength + 1) }],
      widgets: [],
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: [],
      widgets: [{ key: "", lines: [], placement: "floating" }],
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: [],
      widgets: Array.from({ length: OMP_STATUS_LIMITS.widgetKeys + 1 }, () => ({ key: "", lines: [], placement: "aboveEditor" })),
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: [],
      widgets: [{ key: "", lines: Array.from({ length: OMP_STATUS_LIMITS.widgetLines + 1 }, () => ""), placement: "aboveEditor" }],
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: [],
      widgets: [{ key: "", lines: ["x".repeat(OMP_STATUS_LIMITS.lineLength + 1)], placement: "aboveEditor" }],
    }).success).toBe(false);
    expect(ompStatusStateSchema.safeParse({
      statuses: Array.from({ length: OMP_STATUS_LIMITS.statusKeys }, (_, index) => ({ key: String(index), text: "\u0000".repeat(OMP_STATUS_LIMITS.statusLength) })),
      widgets: [],
    }).success).toBe(false);
  });

  it("replaces keyed statuses in insertion order and only clears omitted text", () => {
    const harness = coordinatorHarness();
    harness.handle({ method: "setStatus", statusKey: "first", statusText: "One" });
    harness.handle({ method: "setStatus", statusKey: "second", statusText: "Two" });
    harness.handle({ method: "setStatus", statusKey: "third", statusText: "Three" });
    harness.handle({ method: "setStatus", statusKey: "first", statusText: "Updated" });
    expect(harness.statusStates.at(-1)).toMatchObject({
      statuses: [
        { key: "first", text: "Updated" },
        { key: "second", text: "Two" },
        { key: "third", text: "Three" },
      ],
      widgets: [],
    });
    harness.handle({ method: "setStatus", statusKey: "second" });
    harness.handle({ method: "setStatus", statusKey: "second", statusText: "" });
    harness.handle({ method: "setStatus", statusKey: "", statusText: "" });
    expect(harness.statusStates.at(-1)!.statuses).toEqual([
      { key: "first", text: "Updated" },
      { key: "third", text: "Three" },
      { key: "second", text: "" },
      { key: "", text: "" },
    ]);
    const count = harness.statusStates.length;
    harness.handle({ method: "setStatus", statusKey: "missing" });
    expect(harness.statusStates).toHaveLength(count);
    expect(harness.states).toEqual([]);
    expect(harness.interactions).toEqual([]);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it("retains empty widgets, defaults their placement, and keeps keyed replacement order", () => {
    const harness = coordinatorHarness();
    harness.handle({ method: "setWidget", widgetKey: "first", widgetLines: ["One"] });
    harness.handle({ method: "setWidget", widgetKey: "second", widgetLines: ["Two"], widgetPlacement: "belowEditor" });
    harness.handle({ method: "setWidget", widgetKey: "first", widgetLines: [] });
    expect(harness.statusStates.at(-1)!.widgets).toEqual([
      { key: "first", lines: [], placement: "aboveEditor" },
      { key: "second", lines: ["Two"], placement: "belowEditor" },
    ]);
    harness.handle({ method: "setWidget", widgetKey: "first" });
    harness.handle({ method: "setWidget", widgetKey: "first", widgetLines: ["Restored"], widgetPlacement: "belowEditor" });
    expect(harness.statusStates.at(-1)!.widgets).toEqual([
      { key: "second", lines: ["Two"], placement: "belowEditor" },
      { key: "first", lines: ["Restored"], placement: "belowEditor" },
    ]);
    const count = harness.statusStates.length;
    harness.handle({ method: "setWidget", widgetKey: "missing" });
    expect(harness.statusStates).toHaveLength(count);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it("initially clears stale state and deduplicates identical snapshots across resets", () => {
    const harness = coordinatorHarness();
    const context = { scope: harness.scope, threadId: "thr_ui", providerThreadId: "omp_ui" };
    harness.coordinator.resetStatus(context);
    expect(harness.statusStates).toEqual([{ ...context, statuses: [], widgets: [] }]);
    harness.coordinator.resetStatus(context);
    harness.handle({ method: "setStatus", statusKey: "unknown" });
    harness.handle({ method: "setWidget", widgetKey: "unknown" });
    expect(harness.statusStates).toHaveLength(1);
    harness.handle({ method: "setStatus", statusKey: "work", statusText: "Working" });
    harness.handle({ method: "setStatus", statusKey: "work", statusText: "\u001b[32mWorking\u001b[0m" });
    expect(harness.statusStates).toHaveLength(2);
    const replacement = {};
    harness.coordinator.resetStatus({ ...context, scope: replacement });
    harness.coordinator.resetStatus({ ...context, scope: replacement });
    expect(harness.statusStates).toHaveLength(3);
    expect(harness.statusStates.at(-1)).toEqual({ ...context, scope: replacement, statuses: [], widgets: [] });
    harness.coordinator.clearStatusForScope(replacement);
    harness.coordinator.clearStatusForScope(replacement);
    harness.coordinator.resetStatus({ ...context, scope: {} });
    expect(harness.statusStates).toHaveLength(3);
  });

  it("isolates thread state, rejects retired scopes, and never clears a replacement scope", () => {
    const harness = coordinatorHarness();
    const otherScope = {};
    const replacement = {};
    harness.coordinator.resetStatus({ scope: harness.scope, threadId: "thr_ui", providerThreadId: "omp_ui" });
    harness.handle({ method: "setStatus", statusKey: "same", statusText: "Original" });
    harness.coordinator.resetStatus({ scope: otherScope, threadId: "thr_other", providerThreadId: "omp_other" });
    harness.coordinator.handle({
      scope: otherScope,
      threadId: "thr_other",
      providerThreadId: "omp_other",
      request: { method: "setWidget", widgetKey: "same", widgetLines: ["Other"] },
      respond: harness.respond,
    });
    harness.coordinator.resetStatus({ scope: replacement, threadId: "thr_ui", providerThreadId: "omp_ui" });
    harness.handle({ method: "setStatus", statusKey: "same", statusText: "Replacement" }, replacement);
    const count = harness.statusStates.length;
    harness.handle({ method: "setStatus", statusKey: "stale", statusText: "Ignored" });
    harness.handle({ method: "setWidget", widgetKey: "stale", widgetLines: ["Ignored"] });
    harness.handle({ method: "notify", message: "Ignored" });
    harness.coordinator.handle({
      scope: replacement,
      threadId: "thr_ui",
      providerThreadId: "wrong-provider",
      request: { method: "setStatus", statusKey: "wrong", statusText: "Ignored" },
      respond: harness.respond,
    });
    harness.coordinator.clearStatusForScope(harness.scope);
    expect(harness.statusStates).toHaveLength(count);
    expect(harness.statusStates.at(-1)!.statuses).toEqual([{ key: "same", text: "Replacement" }]);
    expect(harness.notices).toEqual([]);
    harness.coordinator.clearStatusForScope(otherScope);
    expect(harness.statusStates.at(-1)).toEqual({
      scope: otherScope,
      threadId: "thr_other",
      providerThreadId: "omp_other",
      statuses: [],
      widgets: [],
    });
    expect(harness.statusStates.filter((state) => state.threadId === "thr_ui").at(-1)!.statuses).toEqual([{ key: "same", text: "Replacement" }]);
    harness.coordinator.handle({
      scope: otherScope,
      threadId: "thr_other",
      providerThreadId: "omp_other",
      request: { method: "setStatus", statusKey: "late", statusText: "Ignored" },
      respond: harness.respond,
    });
    expect(harness.statusStates).toHaveLength(count + 1);
    harness.coordinator.resetStatus({ scope: otherScope, threadId: "thr_other", providerThreadId: "omp_other" });
    harness.coordinator.handle({
      scope: otherScope,
      threadId: "thr_other",
      providerThreadId: "omp_other",
      request: { method: "setStatus", statusKey: "same", statusText: "Reactivated" },
      respond: harness.respond,
    });
    expect(harness.statusStates.at(-1)!.statuses).toEqual([{ key: "same", text: "Reactivated" }]);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it("keeps status resets and clears independent from interactive dialog lifecycles", () => {
    const harness = coordinatorHarness();
    const context = { scope: harness.scope, threadId: "thr_ui", providerThreadId: "omp_ui" };
    harness.handle({ method: "setStatus", statusKey: "work", statusText: "Working" });
    harness.handle({ id: "input", method: "input", title: "Value" });
    harness.coordinator.resetStatus(context);
    harness.coordinator.clearStatusForScope(harness.scope);
    expect(harness.respond).not.toHaveBeenCalled();
    expect(harness.coordinator.handleRuntimeResponse({
      id: harness.interactions[0]!.id,
      result: { kind: "request_answer", value: "Answer" },
    })).toBe(true);
    expect(harness.respond).toHaveBeenCalledExactlyOnceWith("input", { value: "Answer" });
    harness.coordinator.resetStatus(context);
    harness.handle({ method: "setStatus", statusKey: "work", statusText: "Still working" });
    harness.handle({ id: "editor", method: "editor", title: "Value" });
    const count = harness.statusStates.length;
    harness.coordinator.cancelPendingForScope(harness.scope);
    expect(harness.statusStates).toHaveLength(count);
    expect(harness.statusStates.at(-1)!.statuses).toEqual([{ key: "work", text: "Still working" }]);
    expect(harness.respond).toHaveBeenLastCalledWith("editor", { cancelled: true });
  });

  it.each([
    ["\u001b[31mRed\u001b[0m", "Red"],
    ["Before\u001b[2J\u001b[1;1HAfter", "BeforeAfter"],
    ["\u001b]8;;https://example.com\u0007Link\u001b]8;;\u0007", "Link"],
    ["\u001b]8;;https://example.com\u001b\\Link\u001b]8;;\u001b\\", "Link"],
    ["\u009b32mGreen\u009b0m\u009d0;Title\u009c", "Green"],
    ["Before\u001b]0;Unterminated", "Before"],
    ["Before\u001b[31", "Before"],
    ["\u001b(BPlain\n\u0000😀", "Plain\n\u0000😀"],
  ])("strips ANSI text %j without depending on Node APIs", (input, expected) => {
    expect(stripOmpAnsi(input)).toBe(expected);
  });

  it("strips status and widget formatting before applying display limits", () => {
    const harness = coordinatorHarness();
    harness.handle({
      method: "setStatus",
      statusKey: "\u001b[31mwork\u001b[0m",
      statusText: "\u001b[32mReady\u001b[0m",
    });
    harness.handle({
      method: "setWidget",
      widgetKey: "\u001b]0;Title\u0007summary",
      widgetLines: ["\u001b[1mFirst\u001b[0m", "\u001b]8;;url\u001b\\Second\u001b]8;;\u001b\\"],
    });
    expect(ompStatusStateSchema.parse(harness.statusStates.at(-1))).toEqual({
      statuses: [{ key: "work", text: "Ready" }],
      widgets: [{ key: "summary", lines: ["First", "Second"], placement: "aboveEditor" }],
    });
  });

  it("retains raw-key identity when oversized status and widget keys share a displayed prefix", () => {
    const harness = coordinatorHarness();
    const prefix = "k".repeat(OMP_STATUS_LIMITS.keyLength);
    const first = `${prefix}\ud800`;
    const second = `${prefix}\ud801`;
    for (const [key, value] of [[first, "First"], [second, "Second"]]) {
      harness.handle({ method: "setStatus", statusKey: key, statusText: value });
      harness.handle({ method: "setWidget", widgetKey: key, widgetLines: [value] });
    }
    harness.handle({ method: "setStatus", statusKey: first, statusText: "Replaced" });
    harness.handle({ method: "setWidget", widgetKey: first, widgetLines: [] });
    expect(harness.statusStates.at(-1)!.statuses).toEqual([
      { key: prefix, text: "Replaced" },
      { key: prefix, text: "Second" },
    ]);
    expect(harness.statusStates.at(-1)!.widgets).toEqual([
      { key: prefix, lines: [], placement: "aboveEditor" },
      { key: prefix, lines: ["Second"], placement: "aboveEditor" },
    ]);
    harness.handle({ method: "setStatus", statusKey: first });
    harness.handle({ method: "setWidget", widgetKey: first });
    expect(harness.statusStates.at(-1)).toMatchObject({
      statuses: [{ key: prefix, text: "Second" }],
      widgets: [{ key: prefix, lines: ["Second"], placement: "aboveEditor" }],
      truncated: true,
    });
  });

  it("bounds text and widget lines, and removes clipping markers after an unclipped replacement", () => {
    const harness = coordinatorHarness();
    harness.handle({
      method: "setStatus",
      statusKey: "long",
      statusText: "x".repeat(OMP_STATUS_LIMITS.statusLength + 1),
    });
    expect(harness.statusStates.at(-1)).toMatchObject({
      statuses: [{ key: "long", text: "x".repeat(OMP_STATUS_LIMITS.statusLength) }],
      truncated: true,
    });
    harness.handle({ method: "setStatus", statusKey: "long", statusText: "Short" });
    expect(harness.statusStates.at(-1)).not.toHaveProperty("truncated");
    harness.handle({
      method: "setWidget",
      widgetKey: "long",
      widgetLines: Array.from({ length: OMP_STATUS_LIMITS.widgetLines + 1 }, () => "x".repeat(OMP_STATUS_LIMITS.lineLength + 1)),
    });
    expect(harness.statusStates.at(-1)!.widgets).toEqual([{
      key: "long",
      lines: Array.from({ length: OMP_STATUS_LIMITS.widgetLines }, () => "x".repeat(OMP_STATUS_LIMITS.lineLength)),
      placement: "aboveEditor",
    }]);
    expect(harness.statusStates.at(-1)!.truncated).toBe(true);
    harness.handle({ method: "setWidget", widgetKey: "long", widgetLines: [] });
    expect(harness.statusStates.at(-1)).not.toHaveProperty("truncated");
  });

  it("does not split valid surrogate pairs at key, status, or widget-line limits", () => {
    const harness = coordinatorHarness();
    const keyPrefix = "k".repeat(OMP_STATUS_LIMITS.keyLength - 1);
    const textPrefix = "x".repeat(OMP_STATUS_LIMITS.statusLength - 1);
    const linePrefix = "x".repeat(OMP_STATUS_LIMITS.lineLength - 1);
    harness.handle({ method: "setStatus", statusKey: `${keyPrefix}😀`, statusText: `${textPrefix}😀` });
    harness.handle({ method: "setWidget", widgetKey: `${keyPrefix}😀`, widgetLines: [`${linePrefix}😀`] });
    expect(harness.statusStates.at(-1)).toMatchObject({
      statuses: [{ key: keyPrefix, text: textPrefix }],
      widgets: [{ key: keyPrefix, lines: [linePrefix], placement: "aboveEditor" }],
      truncated: true,
    });
  });

  it("caps retained key counts, permits replacement at capacity, and resets omission markers", () => {
    const harness = coordinatorHarness();
    for (let index = 0; index <= OMP_STATUS_LIMITS.statusKeys; index += 1) {
      harness.handle({ method: "setStatus", statusKey: `s${index}`, statusText: String(index) });
    }
    for (let index = 0; index <= OMP_STATUS_LIMITS.widgetKeys; index += 1) {
      harness.handle({ method: "setWidget", widgetKey: `w${index}`, widgetLines: [] });
    }
    expect(harness.statusStates.at(-1)!.statuses.map((entry) => entry.key)).toEqual(Array.from({ length: OMP_STATUS_LIMITS.statusKeys }, (_, index) => `s${index}`));
    expect(harness.statusStates.at(-1)!.widgets.map((entry) => entry.key)).toEqual(Array.from({ length: OMP_STATUS_LIMITS.widgetKeys }, (_, index) => `w${index}`));
    expect(harness.statusStates.at(-1)!.truncated).toBe(true);
    harness.handle({ method: "setStatus", statusKey: "s0", statusText: "Replaced" });
    harness.handle({ method: "setWidget", widgetKey: "w0", widgetLines: ["Replaced"] });
    expect(harness.statusStates.at(-1)!.statuses[0]).toEqual({ key: "s0", text: "Replaced" });
    expect(harness.statusStates.at(-1)!.widgets[0]!.lines).toEqual(["Replaced"]);
    harness.handle({ method: "setStatus", statusKey: "s0" });
    harness.handle({ method: "setWidget", widgetKey: "w0" });
    harness.handle({ method: "setStatus", statusKey: "extra", statusText: "" });
    harness.handle({ method: "setWidget", widgetKey: "extra", widgetLines: [] });
    expect(harness.statusStates.at(-1)!.statuses).toHaveLength(OMP_STATUS_LIMITS.statusKeys);
    expect(harness.statusStates.at(-1)!.statuses.at(-1)).toEqual({ key: "extra", text: "" });
    expect(harness.statusStates.at(-1)!.widgets).toHaveLength(OMP_STATUS_LIMITS.widgetKeys);
    expect(harness.statusStates.at(-1)!.widgets.at(-1)!.key).toBe("extra");
    harness.coordinator.resetStatus({ scope: harness.scope, threadId: "thr_ui", providerThreadId: "omp_ui" });
    expect(ompStatusStateSchema.parse(harness.statusStates.at(-1))).toEqual({ statuses: [], widgets: [] });
  });

  it.each(["\u0000", "\u0001", "\ud800", "\udfff", "\"\\", "😀", "\u0800"])(
    "bounds every serialized UTF-8 snapshot with worst-case content %j",
    (unit) => {
      const harness = coordinatorHarness();
      const text = unit.repeat(OMP_STATUS_LIMITS.statusLength);
      const keyPrefix = unit.repeat(OMP_STATUS_LIMITS.keyLength);
      for (let index = 0; index < OMP_STATUS_LIMITS.statusKeys; index += 1) {
        harness.handle({ method: "setStatus", statusKey: `${keyPrefix}${index}`, statusText: text });
      }
      for (let index = 0; index < OMP_STATUS_LIMITS.widgetKeys; index += 1) {
        harness.handle({
          method: "setWidget",
          widgetKey: `${keyPrefix}${index}`,
          widgetLines: Array.from({ length: OMP_STATUS_LIMITS.widgetLines }, () => text),
        });
      }
      for (const update of harness.statusStates) {
        const { scope, threadId, providerThreadId, ...state } = update;
        expect(scope).toBe(harness.scope);
        expect(threadId).toBe("thr_ui");
        expect(providerThreadId).toBe("omp_ui");
        expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(OMP_STATUS_LIMITS.stateBytes);
        expect(ompStatusStateSchema.safeParse(state).success).toBe(true);
      }
      expect(harness.statusStates.at(-1)!.truncated).toBe(true);
      expect(harness.respond).not.toHaveBeenCalled();
    },
  );

  it("makes byte-omitted widgets visible again when retained statuses are cleared", () => {
    const harness = coordinatorHarness();
    for (let index = 0; index < OMP_STATUS_LIMITS.statusKeys; index += 1) {
      harness.handle({ method: "setStatus", statusKey: String(index), statusText: "x".repeat(OMP_STATUS_LIMITS.statusLength) });
    }
    const lines = Array.from({ length: OMP_STATUS_LIMITS.widgetLines - 1 }, () => "\u0800".repeat(OMP_STATUS_LIMITS.lineLength));
    harness.handle({ method: "setWidget", widgetKey: "large", widgetLines: lines });
    expect(harness.statusStates.at(-1)!.widgets).toEqual([]);
    expect(harness.statusStates.at(-1)!.truncated).toBe(true);
    for (let index = 0; index < OMP_STATUS_LIMITS.statusKeys; index += 1) {
      harness.handle({ method: "setStatus", statusKey: String(index) });
    }
    expect(harness.statusStates.at(-1)!.widgets).toEqual([{ key: "large", lines, placement: "aboveEditor" }]);
    expect(harness.statusStates.at(-1)).not.toHaveProperty("truncated");
  });

  it.each([
    { notifyType: undefined, severity: "info" },
    { notifyType: "info", severity: "info" },
    { notifyType: "warning", severity: "warning" },
    { notifyType: "error", severity: "error" },
  ])("emits $severity notices without answering or changing status/dialog state", ({ notifyType, severity }) => {
    const harness = coordinatorHarness();
    harness.handle({ id: "notice", method: "notify", message: "\u001b[31mFull\nmessage\u001b[0m", notifyType });
    expect(harness.notices).toEqual([{
      scope: harness.scope,
      threadId: "thr_ui",
      providerThreadId: "omp_ui",
      severity,
      message: "Full\nmessage",
    }]);
    expect(harness.statusStates).toEqual([]);
    expect(harness.states).toEqual([]);
    expect(harness.interactions).toEqual([]);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it("preserves full notice messages, empty notices, and repeated one-shot delivery", () => {
    const harness = coordinatorHarness();
    const message = "Notice\n".repeat(16_384);
    harness.handle({ method: "notify", message });
    harness.handle({ method: "notify", message });
    harness.handle({ method: "notify", message: "" });
    expect(harness.notices.map((notice) => notice.message)).toEqual([message, message, ""]);
    expect(harness.respond).not.toHaveBeenCalled();
  });

  it.each([
    { method: "setStatus" },
    { method: "setStatus", statusKey: 1, statusText: "Invalid" },
    { method: "setStatus", statusKey: "key", statusText: null },
    { method: "setStatus", statusKey: "key", statusText: {} },
    { method: "setWidget", widgetLines: [] },
    { method: "setWidget", widgetKey: 1, widgetLines: [] },
    { method: "setWidget", widgetKey: "key", widgetLines: null },
    { method: "setWidget", widgetKey: "key", widgetLines: "Invalid" },
    { method: "setWidget", widgetKey: "key", widgetLines: ["Valid", 1] },
    { method: "setWidget", widgetKey: "key", widgetLines: [...Array.from({ length: OMP_STATUS_LIMITS.widgetLines }, () => ""), null] },
    { method: "setWidget", widgetKey: "key", widgetLines: Array(1) },
    { method: "setWidget", widgetKey: "key", widgetLines: [], widgetPlacement: null },
    { method: "setWidget", widgetKey: "key", widgetPlacement: "floating" },
    { method: "notify" },
    { method: "notify", message: null },
    { method: "notify", message: 1 },
    { method: "notify", message: "Invalid", notifyType: "debug" },
    { method: "notify", message: "Invalid", notifyType: null },
    { method: "setTitle", title: {} },
  ])("ignores malformed fire-and-forget requests without answering: %j", (request) => {
    const harness = coordinatorHarness();
    harness.handle({ id: "malformed", ...request });
    expect(harness.statusStates).toEqual([]);
    expect(harness.notices).toEqual([]);
    expect(harness.states).toEqual([]);
    expect(harness.interactions).toEqual([]);
    expect(harness.respond).not.toHaveBeenCalled();
    const validScope = {};
    harness.handle({ method: "setStatus", statusKey: "valid", statusText: "Accepted" }, validScope);
    expect(harness.statusStates.at(-1)).toMatchObject({
      scope: validScope,
      statuses: [{ key: "valid", text: "Accepted" }],
    });
  });
});

describe("native OMP extension UI bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let nextId = 2000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-ext-ui-", initialize: true, processLog: true });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  async function startThread(threadId: string): Promise<string> {
    const started = await harness.startThread(threadId);
    const { providerThreadId } = z.object({ providerThreadId: z.string() }).parse(started.result);
    expect(providerThreadId).toMatch(/^omp_[0-9a-f-]{36}$/u);
    return providerThreadId;
  }

  function turnStart(threadId: string, providerThreadId: string, request: Record<string, unknown>): void {
    handleLine(JSON.stringify({ jsonrpc: "2.0", id: (nextId += 1), method: "turn/start", params: {
      threadId, providerThreadId, clientRequestId: "creq_ui23456789", input: [{ type: "text", text: `/ui ${JSON.stringify(request)}`, mentions: [] }], options: FULL_PERMISSION_OPTIONS,
    } }));
  }

  async function waitForInteractionRequest(threadId: string): Promise<InteractionUiRequest> {
    const message = await harness.waitForMessage(
      (message) =>
        message.method === "interaction/request" &&
        JSON.stringify(message.params ?? {}).includes(threadId),
      `the interaction/request for ${threadId}`,
    );
    return interactionSchema.parse(message);
  }

  function resolveInteraction(id: string, value: unknown): void {
    handleLine(JSON.stringify({ jsonrpc: "2.0", id, result: { kind: "request_answer", value } }));
  }

  async function extensionUiReplyOf(threadId: string): Promise<string> {
    await harness.waitForTurnBoundary(threadId);
    return harness.deltasOf(threadId).filter((delta) => delta.kind === "item.textDelta").map((delta) => String(delta.text)).join("");
  }

  it("forwards native select labels and descriptions and returns the selected label", async () => {
    const threadId = "thr_ui_select";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "select", title: "Allow access?", options: ["Allow once", "Deny"], optionDetails: [{ description: "Only this time" }, {}] });
    const interaction = await waitForInteractionRequest(threadId);
    expect(interaction.params.payload).toMatchObject({ kind: "provider-omp/extension-ui", title: "Allow access?", data: { method: "select", options: ["Allow once", "Deny"], optionDetails: [{ description: "Only this time" }, {}] } });
    resolveInteraction(interaction.id, "Allow once");
    expect(await extensionUiReplyOf(threadId)).toContain('"value":"Allow once"');
  }, 90_000);

  it("round-trips an approval with a 1,000-character multiline title through a valid bb interaction", async () => {
    const threadId = "thr_ui_long_approval";
    const providerThreadId = await startThread(threadId);
    const title = "Tool approval full details\n".repeat(50).slice(0, 1_000);
    turnStart(threadId, providerThreadId, { method: "select", title, options: ["Approve", "Deny"] });
    const interaction = await waitForInteractionRequest(threadId);
    expect(interactionRequestPayloadSchema.safeParse(interaction.params.payload).success).toBe(true);
    expect(interaction.params.payload.title.length).toBeLessThanOrEqual(160);
    expect(interaction.params.payload.data.detail).toBe(title);
    resolveInteraction(interaction.id, "Approve");
    expect(await extensionUiReplyOf(threadId)).toContain('"value":"Approve"');
  }, 90_000);

  it("maps a boolean answer to confirmed for a native confirm dialog", async () => {
    const threadId = "thr_ui_confirm";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "confirm", title: "Run command?", message: "This modifies files." });
    const interaction = await waitForInteractionRequest(threadId);
    expect(interaction.params.payload.data).toMatchObject({ method: "confirm", message: "This modifies files." });
    resolveInteraction(interaction.id, true);
    expect(await extensionUiReplyOf(threadId)).toContain('"confirmed":true');
  }, 90_000);

  it.each([
    { method: "input", title: "Value", placeholder: "Type here" },
    { method: "editor", title: "Draft", prefill: "first", promptStyle: true },
  ])("returns edited text for $method", async (request) => {
    const threadId = `thr_ui_${request.method}`;
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, request);
    const interaction = await waitForInteractionRequest(threadId);
    expect(interaction.params.payload.data).toMatchObject(request.method === "editor" ? { method: "editor", prefill: "first", promptStyle: true } : { method: "input", placeholder: "Type here" });
    resolveInteraction(interaction.id, "first\nsecond");
    expect(await extensionUiReplyOf(threadId)).toContain('"value":"first\\nsecond"');
  }, 90_000);

  it("returns one ordered native ask answer per question using labels, not indices", async () => {
    const threadId = "thr_ui_ask";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "ask", questions: askQuestions });
    const interaction = await waitForInteractionRequest(threadId);
    expect(interaction.params.payload.data).toMatchObject({ method: "ask", questions: askQuestions });
    resolveInteraction(interaction.id, { answers: [{ id: "language", selectedOptions: ["TypeScript"] }, { id: "targets", selectedOptions: ["Web", "CLI"], customInput: "Mobile" }] });
    expect(await extensionUiReplyOf(threadId)).toContain('"answers":[{"id":"language","selectedOptions":["TypeScript"]},{"id":"targets","selectedOptions":["Web","CLI"],"customInput":"Mobile"}]');
  }, 90_000);

  it.each([42, "not-an-option", null])("answers invalid or cancelled select value %j as cancelled", async (value) => {
    const threadId = "thr_ui_badvalue";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "select", title: "Pick", options: ["A", "B"] });
    const interaction = await waitForInteractionRequest(threadId);
    resolveInteraction(interaction.id, value);
    expect(await extensionUiReplyOf(threadId)).toContain('"cancelled":true');
  }, 90_000);

  it("answers an interaction error as cancelled", async () => {
    const threadId = "thr_ui_error";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "input", title: "Enter a value" });
    const interaction = await waitForInteractionRequest(threadId);
    handleLine(JSON.stringify({ jsonrpc: "2.0", id: interaction.id, error: { code: -32000, message: "interaction cancelled" } }));
    expect(await extensionUiReplyOf(threadId)).toContain('"cancelled":true');
  }, 90_000);

  it("cancels a pending native dialog when the thread is stopped mid-prompt", async () => {
    const threadId = "thr_ui_stop";
    const uiLogPath = join(harness.workspaceDir, "ui.log");
    vi.stubEnv("FAKE_OMP_UI_LOG", uiLogPath);
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "select", title: "Pick", options: ["A", "B"] });
    const interaction = await waitForInteractionRequest(threadId);
    const stopResponse = await harness.request((nextId += 1), "thread/stop", { threadId, providerThreadId, intent: "interrupt", activeTurnId: null });
    expect(stopResponse.result).toMatchObject({ ok: true });
    const response = z.object({
      type: z.literal("extension_ui_response"),
      id: z.string(),
      cancelled: z.literal(true),
    }).parse(JSON.parse(readFileSync(uiLogPath, "utf8").trim().split("\n").at(-1)!));
    expect(response).toMatchObject({
      type: "extension_ui_response",
      id: expect.any(String),
      cancelled: true,
    });
    expect(response.id).not.toBe(interaction.params.payload.data.requestId);
  }, 90_000);

  it("cancels an invalid native dialog request instead of forwarding it", async () => {
    const threadId = "thr_ui_invalid";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "select", title: "Pick" });
    expect(await extensionUiReplyOf(threadId)).toContain('"cancelled":true');
    expect(harness.messages.some((message) => message.method === "interaction/request" && JSON.stringify(message.params ?? {}).includes(threadId))).toBe(false);
  }, 90_000);

  it("publishes native editor text to the frontend as a scoped one-shot state request", async () => {
    const threadId = "thr_ui_editor_text";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method: "set_editor_text", text: "Replacement draft" });
    await harness.waitForTurnBoundary(threadId);
    expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
      kind: "extension.state",
      extensionKind: OMP_EDITOR_TEXT_STATE_KIND,
      payload: { requestId: expect.any(String), text: "Replacement draft" },
    }));
  }, 90_000);

  it("preserves native OAuth link metadata in the notice renderer payload", async () => {
    const threadId = "thr_ui_login_url";
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, {
      method: "open_url",
      url: "https://auth.example.com/oauth?state=full",
      launchUrl: "http://127.0.0.1:1234/",
      instructions: "Sign in, then return here.",
    });
    await harness.waitForTurnBoundary(threadId);
    expect(harness.deltasOf(threadId)).toContainEqual(expect.objectContaining({
      kind: "item.close",
      item: expect.objectContaining({
        type: "extension",
        kind: OMP_NOTICE_KIND,
        payload: expect.objectContaining({
          url: "https://auth.example.com/oauth?state=full",
          launchUrl: "http://127.0.0.1:1234/",
          instructions: "Sign in, then return here.",
        }),
      }),
    }));
  }, 90_000);

  it.each(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "cancel"])("never answers native fire-and-forget %s", async (method) => {
    const threadId = "thr_ui_notice";
    const uiLogPath = join(harness.workspaceDir, "ui.log");
    vi.stubEnv("FAKE_OMP_UI_LOG", uiLogPath);
    const providerThreadId = await startThread(threadId);
    turnStart(threadId, providerThreadId, { method, message: "Ignored", title: "Ignored", url: "https://example.com", targetId: "unknown" });
    await harness.waitForTurnBoundary(threadId);
    expect(harness.messages.some((message) => message.method === "interaction/request" && JSON.stringify(message.params ?? {}).includes(threadId))).toBe(false);
    expect(existsSync(uiLogPath)).toBe(false);
  }, 90_000);
});
