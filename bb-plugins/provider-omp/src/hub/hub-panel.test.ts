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
import type { JsonValue, PluginBrowserBbSdk, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import {
  OMP_AGENTS_STATE_KIND,
  OMP_HUB_PANEL_ACTION_ID,
  type OmpHubAgent,
  type OmpHubRpcContract,
  type OmpService,
} from "../hub-contract.js";

const app = await loadPluginApp(() => import("../../app"));
const panel = app.threadPanelActions.find((action) => action.id === OMP_HUB_PANEL_ACTION_ID)!;

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

function host(threadId: string, initialAgents: OmpHubAgent[]) {
  let agents = initialAgents;
  const listeners: Subscription[] = [];
  const get = vi.fn<PluginBrowserBbSdk["threads"]["get"]>()
    .mockResolvedValue(makeThreadResponse({ id: threadId, providerId: "omp" }));
  const details = vi.fn<PluginBrowserBbSdk["threads"]["timelineTurnSummaryDetails"]>()
    .mockResolvedValue({ rows: [] });
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
      data: { providerThreadId: "omp_test", kind: OMP_AGENTS_STATE_KIND, payload: { agents } },
    }];
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
      events: { list },
      timelineTurnSummaryDetails: details,
      tabs: { get: async () => ({ revision: 1, tabs: [] }) },
    },
  };
  return {
    sdk,
    get,
    details,
    setAgents(next: OmpHubAgent[]) { agents = next; },
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
  return renderSlot<PluginThreadPanelProps, OmpHubRpcContract>(panel, { threadId, params }, {
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
    expect(view.queryByRole("textbox")).toBeNull();
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
