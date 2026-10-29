// @vitest-environment jsdom
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
  type PluginSdkTestFakes,
} from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalThreadActionTabProps, JsonValue, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import {
  OMP_AGENTS_STATE_KIND,
  OMP_CONTEXT_NOTES_STATE_KIND,
  OMP_HUB_PANEL_ACTION_ID,
  type OmpHubAgent,
  type OmpHubRpcContract,
  type OmpService,
} from "../hub-contract.js";

const app = await loadPluginApp(() => import("../../app"));
type ThreadActionTab = Extract<
  (typeof app.tabs)[number],
  { context: { kind: "thread" }; availability: "action" }
>;
const panel = app.tabs.find((tab): tab is ThreadActionTab =>
  tab.id === OMP_HUB_PANEL_ACTION_ID &&
  tab.context.kind === "thread" &&
  tab.availability === "action"
)!;

const hubHeaderAction = app.threadHeaderActions.find((action) => action.id === OMP_HUB_PANEL_ACTION_ID)!;

function agent(id: string, overrides: Partial<OmpHubAgent> = {}): OmpHubAgent {
  return {
    id,
    agent: "task",
    status: "running",
    detached: false,
    lastUpdate: 10,
    ...overrides,
  };
}

/** bb stores delegations under its own item id, not the provider key. */
function bbItemId(agent: OmpHubAgent): string {
  return `turn_test-item-${agent.id}`;
}

type Subscription = Parameters<PluginBrowserBbSdk["subscribe"]>[0];

function host(threadId: string, initialAgents: OmpHubAgent[], initialContextNotes?: string) {
  let agents = initialAgents;
  let contextNotes = initialContextNotes;
  const listeners: Subscription[] = [];
  const get = vi.fn<PluginBrowserBbSdk["threads"]["get"]>()
    .mockResolvedValue(makeThreadResponse({ id: threadId, providerId: "omp" }));
  const details = vi.fn<PluginBrowserBbSdk["threads"]["timelineTurnSummaryDetails"]>()
    .mockResolvedValue({ rows: [] });
  const send = vi.fn<PluginBrowserBbSdk["threads"]["send"]>()
    .mockResolvedValue({ ok: true, delivery: "sent" });
  const list = vi.fn<PluginBrowserBbSdk["threads"]["events"]["list"]>().mockImplementation(async ({ types }) => {
    if (types?.includes("item/started")) {
      return agents.map((item, index) => ({
        id: `started-${index}`,
        seq: 20 + index,
        createdAt: 20 + index,
        threadId,
        scope: { kind: "turn" as const, turnId: "turn_test" },
        type: "item/started" as const,
        data: {
          providerThreadId: "omp_test",
          item: {
            type: "delegation" as const,
            id: bbItemId(item),
            childRef: item.id,
            label: item.id,
            status: "pending" as const,
            background: false,
          },
        },
      }));
    }
    return [{
      id: "roster",
      seq: 100,
      createdAt: 100,
      threadId,
      scope: { kind: "thread" as const },
      type: "thread/extensionState/updated" as const,
      data: { providerThreadId: "omp_test", kind: OMP_AGENTS_STATE_KIND as `${string}/${string}`, payload: { agents } as JsonValue },
    }, ...(contextNotes === undefined ? [] : [{
      id: "context-notes",
      seq: 101,
      createdAt: 101,
      threadId,
      scope: { kind: "thread" as const },
      type: "thread/extensionState/updated" as const,
      data: { providerThreadId: "omp_test", kind: OMP_CONTEXT_NOTES_STATE_KIND as `${string}/${string}`, payload: { text: contextNotes } as JsonValue },
    }])];
  });
  const sdk: PluginSdkTestFakes = {
    subscribe: (subscription) => {
      listeners.push(subscription);
      return () => {
        const index = listeners.indexOf(subscription);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    threads: {
      get,
      send,
      events: { list },
      timelineTurnSummaryDetails: details,
      tabs: { get: async () => ({ revision: 1, tabs: [] }) },
    },
  };
  return {
    sdk,
    get,
    details,
    send,
    setAgents(next: OmpHubAgent[]) { agents = next; },
    setContextNotes(text: string) { contextNotes = text; },
    changed() {
      for (const listener of [...listeners]) {
        if (listener.event === "thread:changed") {
          listener.callback({ type: "changed", entity: "thread", id: threadId, changes: ["events-appended"] });
        }
      }
    },
  };
}

const noServices: PluginRpcTestHandlers<OmpHubRpcContract> = {
  listServices: () => ({ available: true, hostIsLocal: true, projectDir: "/project", services: [] }),
  serviceLogs: () => ({ text: "" }),
  controlService: () => ({ ok: true }),
};

function renderHub(
  threadId: string,
  sdk: PluginSdkTestFakes,
  params: JsonValue | null = null,
  rpc: PluginRpcTestHandlers<OmpHubRpcContract> = noServices,
) {
  return renderSlot<ExperimentalThreadActionTabProps, OmpHubRpcContract>(panel, { threadId, params }, {
    pluginId: "provider-omp",
    sdk,
    rpc,
  });
}

function transcript(agent: OmpHubAgent, threadId: string, messages: { id: string; text: string }[]) {
  return [{
    id: `delegation-${agent.id}`,
    kind: "work" as const,
    workKind: "delegation" as const,
    callId: bbItemId(agent),
    toolName: "task",
    childRef: agent.id,
    background: false,
    subagentType: "task",
    description: null,
    output: "",
    completedAt: null,
    status: "pending" as const,
    sourceSeqStart: 20,
    sourceSeqEnd: 100,
    createdAt: 20,
    startedAt: 20,
    threadId,
    turnId: "turn_test",
    childRows: messages.map(({ id, text }) => ({
      id,
      kind: "conversation" as const,
      role: "assistant" as const,
      text,
      attachments: null,
      messageSeq: 22,
      sourceSeqStart: 22,
      sourceSeqEnd: 23,
      createdAt: 22,
      startedAt: 22,
      threadId,
      turnId: "turn_test",
      turnRequest: null,
    })),
  }];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("omp Hub", () => {
  it("renders context notes as read-only Markdown and refreshes their latest state", async () => {
    const text = "**Keep this decision.**\n<experimental-context-notes>literal closing tag: </experimental-context-notes>\n<script>not executable</script>";
    const fixture = host("hub-context-notes", [], text);
    const view = renderHub("hub-context-notes", fixture.sdk);
    const section = await view.findByRole("region", { name: "Context notes" });
    await vi.waitFor(() => expect(within(section).getByTestId("bb-markdown").textContent).toBe(text));
    expect(section.querySelector("script")).toBeNull();
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(within(section).queryByRole("button")).toBeNull();

    fixture.setContextNotes("Updated notebook");
    await act(async () => fixture.changed());
    await within(section).findByText("Updated notebook");
    expect(section.textContent).not.toContain(text);

    fixture.setContextNotes("");
    await act(async () => fixture.changed());
    await vi.waitFor(() => expect(within(section).getByRole("status").textContent).toBe("No context notes in this session."));
    expect(section.textContent).not.toContain("Updated notebook");
  });

  it("shows compact Hub availability indicators and opens its sidebar", async () => {
    const fixture = host("hub-header-action", [
      agent("complete-one", { status: "completed" }),
      agent("complete-two", { status: "completed" }),
    ], "Keep the active decision.");
    const view = renderSlot(hubHeaderAction, {
      threadId: "hub-header-action",
      projectId: "project_test",
      isCompactViewport: false,
    }, { sdk: fixture.sdk });
    const button = await view.findByRole("button", { name: "omp Hub: 0 active jobs, active context note" });
    expect(button.textContent).toBe("0");
    expect(button.querySelector(".text-foreground")).not.toBeNull();

    fixture.setContextNotes("");
    await act(async () => fixture.changed());
    const inactiveButton = await view.findByRole("button", { name: "omp Hub: 0 active jobs, no active context note" });
    expect(inactiveButton.querySelector(".text-muted-foreground.grayscale")).not.toBeNull();

    fireEvent.click(button);

    expect(view.inspection.navigateCalls).toEqual([{
      method: "openThreadPanel",
      options: { actionId: OMP_HUB_PANEL_ACTION_ID, title: "omp Hub" },
    }]);
  });

  it.each([undefined, ""])("shows an accessible empty state for context notes %s", async (text) => {
    const fixture = host("hub-context-notes-empty", [], text);
    const view = renderHub("hub-context-notes-empty", fixture.sdk);
    const section = await view.findByRole("region", { name: "Context notes" });
    expect(within(section).getByRole("heading", { name: "Context notes" })).toBeDefined();
    expect(within(section).getByRole("status").textContent).toBe("No context notes in this session.");
  });

  it("renders the latest agents as a parent tree with live counts and usage", async () => {
    const parent = agent("Parent", {
      description: "Coordinate the change",
      model: "gpt-6.1",
      modelRole: "default",
      cost: 0.1234,
      tokens: 1234,
      toolCount: 7,
      durationMs: 65000,
      currentTool: "read",
      intent: "Inspecting source",
    });
    const child = agent("Child", { parentId: "Parent", status: "completed", description: "Review source" });
    const failed = agent("Failure", { status: "failed", error: "Provider unavailable", retry: { attempt: 2, maxAttempts: 3 } });
    const fixture = host("hub-roster", [child, parent, failed]);
    const view = renderHub("hub-roster", fixture.sdk);
    const parentButton = await view.findByRole("button", { name: "View agent Parent" });
    const parentBranch = parentButton.closest("li")!;
    expect(within(parentBranch).getByRole("button", { name: "View agent Child" })).toBeDefined();
    expect(view.getByLabelText("Agent counts").textContent).toContain("1 running · 1 finished · 1 failed");
    expect(view.getByText("gpt-6.1 (default) · task")).toBeDefined();
    expect(view.getByText("$0.1234")).toBeDefined();
    expect(view.getByText("1,234 tokens")).toBeDefined();
    expect(view.getByText("7 tools")).toBeDefined();
    expect(view.getByText("1m 5s")).toBeDefined();
    expect(view.getByText("Inspecting source", { exact: false })).toBeDefined();
    expect(view.getByText("Provider unavailable")).toBeDefined();
    expect(view.getByText("Retry 2/3")).toBeDefined();

    fixture.setAgents([{ ...parent, status: "completed" }, child, failed]);
    await act(async () => fixture.changed());
    await vi.waitFor(() => expect(view.getByLabelText("Agent counts").textContent).toContain("0 running · 2 finished · 1 failed"));
    expect(view.queryByText("Inspecting source", { exact: false })).toBeNull();
  });

  it("selects params.agentId and pages only that agent’s read-only persisted conversation", async () => {
    const selected = agent("Selected");
    const other = agent("Other");
    const fixture = host("hub-params", [selected, other]);
    let latestText = "Newest captured reply";
    fixture.details.mockImplementation(async ({ beforeCursor }) => ({
      rows: [
        ...transcript(selected, "hub-params", beforeCursor
          ? [{ id: "older", text: "Earlier captured reply" }]
          : [{ id: "latest", text: latestText }]),
        ...transcript(other, "hub-params", [{ id: "unrelated", text: "Another agent’s private transcript" }]),
      ],
      olderCursor: beforeCursor ? null : "older-page",
    }));
    const view = renderHub("hub-params", fixture.sdk, { agentId: selected.id });
    await view.findByText("Newest captured reply");
    expect(view.getByText("Read-only conversation")).toBeDefined();
    expect(view.getByRole("textbox", { name: "Message to agent Selected" })).toBeDefined();
    expect(view.queryByText("Another agent’s private transcript")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Load earlier messages" }));
    await view.findByText("Earlier captured reply");
    expect(view.getByText("Newest captured reply")).toBeDefined();

    latestText = "Live captured reply";
    await act(async () => fixture.changed());
    await view.findByText("Live captured reply");
    expect(view.getByText("Earlier captured reply")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "All agents" }));
    expect(view.getByRole("button", { name: "View agent Other" })).toBeDefined();
  });

  it.each(["roster", "conversation"] as const)("shows controls only for running agents in the %s", async (surface) => {
    const running = agent("Running");
    const finished = [
      agent("Completed", { status: "completed" }),
      agent("Failed", { status: "failed" }),
      agent("Aborted", { status: "aborted" }),
      agent("Pending", { status: "pending" }),
    ];
    const threadId = `hub-agent-visibility-${surface}`;
    const fixture = host(threadId, [running, ...finished]);
    const view = renderHub(threadId, fixture.sdk, surface === "conversation" ? { agentId: running.id } : null);
    await view.findByRole("group", { name: "Controls for agent Running" });
    expect(view.getByRole("button", { name: "Cancel agent Running" })).toBeDefined();
    expect(view.getByRole("textbox", { name: "Message to agent Running" })).toBeDefined();
    expect(view.getByRole("button", { name: "Steer agent Running" })).toBeDefined();
    for (const item of finished) {
      expect(view.queryByRole("group", { name: `Controls for agent ${item.id}` })).toBeNull();
    }
    if (surface === "roster") {
      const summary = view.getByRole("button", { name: "View agent Running" });
      expect(summary.querySelector("button, input")).toBeNull();
    }

    fixture.setAgents([{ ...running, status: "completed" }, ...finished]);
    await act(async () => fixture.changed());
    await vi.waitFor(() => expect(view.queryByRole("group", { name: "Controls for agent Running" })).toBeNull());
    expect(view.queryByRole("button", { name: "Cancel agent Running" })).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each(["pending", "completed", "failed", "aborted"] as const)("does not offer controls in a %s agent conversation", async (status) => {
    const selected = agent("Finished", { status });
    const threadId = `hub-agent-hidden-${status}`;
    const fixture = host(threadId, [selected]);
    const view = renderHub(threadId, fixture.sdk, { agentId: selected.id });
    await view.findByText("Read-only conversation");
    expect(view.queryByRole("group", { name: "Controls for agent Finished" })).toBeNull();
    expect(view.queryByRole("button", { name: "Cancel agent Finished" })).toBeNull();
    expect(view.queryByRole("button", { name: "Steer agent Finished" })).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
  });

  it.each(["roster", "conversation"] as const)("sends exact cancel and steer commands through the parent thread from the %s", async (surface) => {
    const selected = agent("Worker.Child");
    const threadId = `hub-agent-commands-${surface}`;
    const fixture = host(threadId, [selected]);
    const view = renderHub(threadId, fixture.sdk, surface === "conversation" ? { agentId: selected.id } : null);
    const cancel = await view.findByRole("button", { name: "Cancel agent Worker.Child" });
    await act(async () => { fireEvent.click(cancel); });
    expect(fixture.send).toHaveBeenNthCalledWith(1, {
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text: "/omp-agent cancel Worker.Child", mentions: [] }],
    });
    // Sending a command is not proof that the agent has stopped.
    expect(view.getByRole("group", { name: "Controls for agent Worker.Child" })).toBeDefined();
    const message = view.getByRole("textbox", { name: "Message to agent Worker.Child" }) as HTMLInputElement;
    const steer = view.getByRole("button", { name: "Steer agent Worker.Child" }) as HTMLButtonElement;
    expect(steer.disabled).toBe(true);
    fireEvent.change(message, { target: { value: "   " } });
    fireEvent.submit(view.getByRole("form", { name: "Steer agent Worker.Child" }));
    expect(steer.disabled).toBe(true);
    expect(fixture.send).toHaveBeenCalledTimes(1);

    fireEvent.change(message, { target: { value: "  Focus on the cancellation path  " } });
    await act(async () => { fireEvent.click(steer); });
    expect(fixture.send).toHaveBeenNthCalledWith(2, {
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text: "/omp-agent steer Worker.Child Focus on the cancellation path", mentions: [] }],
    });
    expect(message.value).toBe("");
    expect(steer.disabled).toBe(true);
    if (surface === "roster") {
      expect(view.getByRole("button", { name: "View agent Worker.Child" })).toBeDefined();
    }
  });

  it.each(["cancel", "steer"] as const)("shows SDK %s errors without discarding the message or hiding the controls", async (action) => {
    const selected = agent("Worker");
    const threadId = `hub-agent-error-${action}`;
    const fixture = host(threadId, [selected]);
    fixture.send.mockRejectedValueOnce(new Error("Parent thread unavailable"));
    const view = renderHub(threadId, fixture.sdk, { agentId: selected.id });
    const message = await view.findByRole("textbox", { name: "Message to agent Worker" }) as HTMLInputElement;
    fireEvent.change(message, { target: { value: "Keep this instruction" } });
    const button = view.getByRole("button", { name: action === "cancel" ? "Cancel agent Worker" : "Steer agent Worker" }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(button); });
    expect(view.getByRole("alert").textContent).toBe("Parent thread unavailable");
    expect(message.value).toBe("Keep this instruction");
    expect(button.disabled).toBe(false);
    expect(view.getByRole("group", { name: "Controls for agent Worker" })).toBeDefined();

    await act(async () => { fireEvent.click(button); });
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(view.queryByRole("alert")).toBeNull();
    expect(message.value).toBe(action === "steer" ? "" : "Keep this instruction");
  });

  it("disables both commands while a send is pending", async () => {
    const threadId = "hub-agent-pending-send";
    const fixture = host(threadId, [agent("Worker")]);
    const pendingSend = Promise.withResolvers<{ ok: true; delivery: "sent" }>();
    fixture.send.mockReturnValueOnce(pendingSend.promise);
    const view = renderHub(threadId, fixture.sdk);
    const message = await view.findByRole("textbox", { name: "Message to agent Worker" }) as HTMLInputElement;
    const cancel = view.getByRole("button", { name: "Cancel agent Worker" }) as HTMLButtonElement;
    const steer = view.getByRole("button", { name: "Steer agent Worker" }) as HTMLButtonElement;
    fireEvent.change(message, { target: { value: "A new instruction" } });
    fireEvent.click(steer);
    expect(message.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(steer.disabled).toBe(true);
    fireEvent.submit(view.getByRole("form", { name: "Steer agent Worker" }));
    expect(fixture.send).toHaveBeenCalledTimes(1);
    await act(async () => { pendingSend.resolve({ ok: true, delivery: "sent" }); });
    expect(cancel.disabled).toBe(false);
    expect(message.disabled).toBe(false);
    expect(message.value).toBe("");
  });

  it("hides internal services, opens local URLs, reads logs, and confirms killing", async () => {
    const fixture = host("hub-services", []);
    let services: OmpService[] = [
      { name: "web", state: "ready", pid: 123, port: 4321, url: "http://localhost:4321", startedAt: Date.now() - 65000, internal: false },
      { name: "omp.helper", state: "ready", internal: true },
    ];
    const control = vi.fn(async ({ action }: { action: string }) => {
      services = services.map((service) => service.name === "web" ? { ...service, state: action === "kill" ? "exited" : "ready" } : service);
      return { ok: true as const };
    });
    const view = renderHub("hub-services", fixture.sdk, null, {
      listServices: () => ({ available: true, hostIsLocal: true, projectDir: "/project", services }),
      serviceLogs: () => ({ text: "web listening on port 4321" }),
      controlService: control,
    });
    await view.findByRole("heading", { name: "web" });
    expect(view.queryByRole("heading", { name: "omp.helper" })).toBeNull();
    expect(view.getByText("PID 123")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "http://localhost:4321" }));
    expect(view.inspection.navigateCalls).toContainEqual({ method: "openUrl", url: "http://localhost:4321" });
    fireEvent.click(view.getByRole("button", { name: "Logs" }));
    await view.findByText("web listening on port 4321");
    fireEvent.click(view.getByRole("button", { name: "Kill" }));
    expect(view.getByRole("alertdialog", { name: "Kill web?" })).toBeDefined();
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Kill service" }));
    await view.findByText("exited");
    expect(view.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(view.getByRole("checkbox", { name: "Show omp internals" }));
    expect(view.getByRole("heading", { name: "omp.helper" })).toBeDefined();
  });

  it("shows the service availability reason and explains remote ports without opening loopback URLs", async () => {
    const fixture = host("hub-unavailable", []);
    let available = false;
    const view = renderHub("hub-unavailable", fixture.sdk, null, {
      ...noServices,
      listServices: () => available
        ? { available: true, hostIsLocal: false, projectDir: "/remote", services: [{ name: "remote-web", state: "ready", port: 3000, url: "http://localhost:3000", internal: false }] }
        : { available: false, reason: "The thread’s host is offline." },
    });
    await view.findByText("The thread’s host is offline.");
    available = true;
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await view.findByText("Port 3000 on the thread’s host");
    expect(view.queryByRole("button", { name: "http://localhost:3000" })).toBeNull();
  });

  it("keeps other providers out of the Hub without fetching their services", async () => {
    const fixture = host("hub-other-provider", []);
    fixture.get.mockResolvedValue(makeThreadResponse({ id: "hub-other-provider", providerId: "codex" }));
    const view = renderHub("hub-other-provider", fixture.sdk);
    await view.findByText("omp Hub is available for omp-provider threads.");
    expect(view.inspection.rpcCalls).toEqual([]);
  });

  it("retargets an already-open Hub from a Details directive instead of adding another tab", async () => {
    const first = agent("First");
    const second = agent("Second");
    const fixture = host("hub-details", [first, second]);
    fixture.details.mockImplementation(async ({ itemId }) => ({
      rows: transcript(itemId === bbItemId(first) ? first : second, "hub-details", [{ id: "reply", text: itemId === bbItemId(first) ? "First agent reply" : "Second agent reply" }]),
    }));
    const view = renderHub("hub-details", fixture.sdk, { agentId: first.id });
    await view.findByText("First agent reply");
    const directive = renderSlot(app.messageDirectives[0]!, {
      attributes: { id: second.id },
      source: '::omp-agent-details{id="Second"}',
      message: { id: "message", threadId: "hub-details", turnId: "turn_test", projectId: null },
      openWorkspaceFile: null,
    }, { pluginId: "provider-omp", sdk: fixture.sdk });
    fireEvent.click(directive.getByRole("button", { name: "View agent Second details" }));
    await view.findByText("Second agent reply");
    expect(view.queryByText("First agent reply")).toBeNull();
    expect(directive.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: OMP_HUB_PANEL_ACTION_ID, title: "omp Hub", params: { agentId: first.id } },
    });
  });
});
