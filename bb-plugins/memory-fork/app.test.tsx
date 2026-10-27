// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

const memory = {
  id: "mem_1",
  scope: "project",
  projectId: "proj_1",
  name: "validation",
  summary: "Run focused tests.",
  details: "Use the repository test command.",
  kind: "procedure",
  tags: ["testing"],
  importance: 60,
  pinned: false,
  version: 1,
  updatedAt: 1_700_000_000_000,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("memory settings", () => {
  it("lists all memories and saves an inline edit", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          listMemories: () => ({ memories: [memory] }),
          updateMemory: () => ({
            memory: {
              ...memory,
              summary: "Run all focused tests.",
              version: 2,
            },
          }),
        },
      },
    );

    expect(await slot.findByText("validation")).toBeTruthy();
    expect(slot.getByText("project")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Memory summary"), {
      target: { value: "Run all focused tests." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "updateMemory",
        input: expect.objectContaining({
          id: memory.id,
          expectedVersion: 1,
          summary: "Run all focused tests.",
        }),
      }),
    );
    await slot.findByText("Run all focused tests.");
  });

  it("confirms and deletes a memory", async () => {
    const confirm = vi
      .fn<(message: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          listMemories: () => ({ memories: [memory] }),
          deleteMemory: () => ({ deleted: { id: memory.id, version: 2 } }),
        },
      },
    );

    expect(await slot.findByText("validation")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Delete memory “validation”?");
    expect(
      slot.rpcCalls.filter((call) => call.method === "deleteMemory"),
    ).toEqual([]);
    expect(slot.getByText("validation")).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "deleteMemory",
        input: { id: memory.id, expectedVersion: 1 },
      }),
    );
    await waitFor(() => expect(slot.queryByText("validation")).toBeNull());
  });
});

describe("agent correction review", () => {
  it("distinguishes a wrong-only report and opens its linked canonical source without approving", async () => {
    const proposal = {
      id: "prop_report", action: "retire", targetIds: [memory.id],
      payload: { memoryId: memory.id, expectedVersion: memory.version },
      evidence: { source: "agent-correction", intent: "wrong-only-report",
        verification: "agent-proposed", reason: "The test command has changed",
        sourceMemory: { id: memory.id, version: memory.version } },
      status: "pending", runId: null, createdAt: 1_700_000_000_000,
      decidedAt: null, decisionReason: null, appliedVersion: null, appliedSnapshot: null,
    };
    const slot = renderSlot(app.settingsSections[1]!, {}, {
      rpc: {
        listProposals: () => ({ proposals: [proposal] }),
        dreamsStatus: () => ({ lastRun: null, proposalCounts: { pending: 1 }, pending: 1 }),
        listMemories: () => ({ memories: [memory] }),
        decideProposal: () => ({ proposal: { ...proposal, status: "rejected" } }),
      },
    });
    await slot.findByText(/Wrong-only report: no replacement supplied/);
    expect(slot.getByText("Agent-proposed correction · requires review")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: `View source ${memory.id} v1` }));
    await slot.findByText(memory.details);
    expect(slot.getByText("validation · current v1 · project")).toBeTruthy();
    expect(slot.rpcCalls.some(call => call.method === "decideProposal")).toBe(false);
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    expect(slot.getByRole("alert").textContent).toContain("reason is required");
    expect(slot.rpcCalls.some(call => call.method === "decideProposal")).toBe(false);
    fireEvent.change(slot.getByLabelText("Decision reason"), { target: { value: "Report does not establish incorrectness" } });
    fireEvent.click(slot.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "decideProposal", input: {
      id: proposal.id, decision: "rejected", reason: "Report does not establish incorrectness",
    } }));
  });
});
