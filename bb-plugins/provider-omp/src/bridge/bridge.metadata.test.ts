import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  findNewestOmpSessionFile,
  resolveOmpThreadSessionDir,
} from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const objectSchema = z.record(z.string(), z.unknown());
const commandListSchema = z.object({ commands: z.array(objectSchema) });
const providerThreadSchema = z.object({ providerThreadId: z.string() });
const OMP_AGENT_COMMAND = {
  name: "omp-agent",
  description: "Cancel or message a running OMP subagent",
  inputHint: "cancel <id> | steer <id> <message>",
};
const REQUIRED_BRIDGE_COMMAND_NAMES = ["omp-agent", "btw", "login", "logout", "export-html", "goal"];
const INITIAL_OMP_COMMANDS = [
  {
    name: "rename",
    description: "Rename the current OMP session",
    input: { hint: "<title>" },
    aliases: ["name"],
    subcommands: [{ name: "show", description: "Show the current name" }],
    source: "extension",
  },
  { name: "session-info" },
  { name: "old-command", description: "An old extension command", input: {} },
  { name: "empty-hint", input: { hint: "" } },
  { name: "toggle", input: { hint: "[on|off]" }, subcommands: [{ name: "on" }, { name: "off" }] },
  { name: "todo", input: { hint: "<subcommand>" }, subcommands: [{ name: "edit" }, { name: "done" }] },
  { name: "memory", subcommands: [{ name: "view" }, { name: "mm list" }, { name: "mm show" }] },
];
const UPDATED_OMP_COMMANDS = [
  {
    name: "rename",
    description: "Set the updated session name",
    input: { hint: "<new-title>" },
  },
  { name: "refresh-commands", description: "Reload extension commands" },
];

function readJsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => objectSchema.parse(JSON.parse(line)));
}

describe("OMP thread metadata through the bb bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let rpcLog: string;
  let eventLog: string;
  let initializeResult: unknown;
  let nextId = 10_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({
      prefix: "bb-omp-metadata-",
      initialize: false,
    });
    rpcLog = join(harness.workspaceDir, "rpc.jsonl");
    eventLog = join(harness.workspaceDir, "events.jsonl");
    vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
    vi.stubEnv("FAKE_OMP_EVENT_LOG", eventLog);
    vi.stubEnv("FAKE_OMP_AVAILABLE_COMMANDS_JSON", JSON.stringify(INITIAL_OMP_COMMANDS));
    vi.stubEnv("FAKE_OMP_UPDATED_COMMANDS_JSON", JSON.stringify(UPDATED_OMP_COMMANDS));
    const response = await harness.request(++nextId, "initialize", {
      protocolVersion: 2,
      client: { name: "metadata-test", version: "0" },
      grammarVersions: [3, 3],
    });
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    initializeResult = response.result;
  }, 90_000);

  afterEach(async () => {
    await harness.teardown();
  }, 90_000);

  async function startThread(threadId: string): Promise<string> {
    const response = await harness.startThread(threadId);
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    return providerThreadSchema.parse(response.result).providerThreadId;
  }

  function providerCommands(threadId: string): Record<string, unknown>[] | undefined {
    const updates = harness.deltasOf(threadId).filter((delta) =>
      delta.kind === "extension.state" && delta.extensionKind === "bb/provider-commands",
    );
    const latest = updates.at(-1);
    return latest === undefined ? undefined : commandListSchema.parse(latest.payload).commands;
  }

  function expectPersistedTitle(providerThreadId: string, title: string): void {
    const directory = resolveOmpThreadSessionDir({ env: process.env, threadId: providerThreadId });
    const sessionFile = findNewestOmpSessionFile(directory);
    expect(sessionFile).toEqual(expect.any(String));
    expect(readJsonLines(sessionFile!)).toContainEqual(
      expect.objectContaining({ type: "title", title }),
    );
  }

  async function sendLocalCommand(
    threadId: string,
    providerThreadId: string,
    text: string,
  ): Promise<Record<string, unknown>[]> {
    const since = harness.deltasOf(threadId).length;
    const clientRequestId = `creq_${randomUUID().replace(/-/gu, "").replace(/[01]/gu, "a").slice(0, 10)}`;
    const response = await harness.request(++nextId, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId,
      input: [{ type: "text", text, mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    expect(response.result).toEqual({ threadId });
    await harness.waitForTurnBoundary(threadId, since);
    const deltas = harness.deltasOf(threadId).slice(since);
    expect(deltas).toContainEqual({ kind: "input.accepted", clientRequestId });
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toEqual([]);
    expect(readJsonLines(eventLog).filter((event) => event.type === "agent_start")).toEqual([]);
    expect(harness.messages.filter((message) =>
      message.method === "error" || message.method === "session/ended",
    )).toEqual([]);
    return deltas;
  }

  it("advertises thread rename support in initialize", () => {
    expect(initializeResult).toMatchObject({ capabilities: { threadRename: true } });
  });

  it("forwards a bb rename to set_session_name without echoing an agent rename", async () => {
    const threadId = "thr_metadata_bb_name";
    const providerThreadId = await startThread(threadId);
    const title = "Renamed session café";
    const since = harness.deltasOf(threadId).length;
    const response = await harness.request(++nextId, "thread/name/set", {
      threadId,
      providerThreadId,
      title,
    });
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    expect(response.result).toEqual({ ok: true });
    expect(readJsonLines(rpcLog).filter((command) => command.type === "set_session_name")).toEqual([
      { id: expect.any(String), type: "set_session_name", name: title },
    ]);
    expectPersistedTitle(providerThreadId, title);
    await sendLocalCommand(threadId, providerThreadId, "/session-info");
    expect(harness.deltasOf(threadId).slice(since).filter((delta) => delta.kind === "thread.name")).toEqual([]);
  }, 90_000);

  it.each(["   ", "\t \r\n"])("rejects a whitespace-only rename %j without sending a rename command", async (title) => {
    const threadId = "thr_metadata_empty_name";
    const providerThreadId = await startThread(threadId);
    const since = harness.deltasOf(threadId).length;
    const response = await harness.request(++nextId, "thread/name/set", {
      threadId,
      providerThreadId,
      title,
    });
    expect(response.error).toMatchObject({ code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS });
    expect(response.result).toBeUndefined();
    expect(readJsonLines(rpcLog).filter((command) => command.type === "set_session_name")).toEqual([]);
    expect(harness.deltasOf(threadId).slice(since).filter((delta) => delta.kind === "thread.name")).toEqual([]);
  }, 90_000);

  it("publishes an agent thread.name for a typed /rename command without invoking the agent", async () => {
    const threadId = "thr_metadata_agent_name";
    const providerThreadId = await startThread(threadId);
    const title = "Agent title café";
    const text = `/rename   ${title}   `;
    const deltas = await sendLocalCommand(threadId, providerThreadId, text);
    expect(deltas.filter((delta) => delta.kind === "thread.name")).toEqual([
      { kind: "thread.name", name: title, source: "agent" },
    ]);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "prompt")).toEqual([
      expect.objectContaining({ message: text }),
    ]);
    expect(readJsonLines(rpcLog).filter((command) => command.type === "set_session_name")).toEqual([]);
    expectPersistedTitle(providerThreadId, title);
  }, 90_000);

  it("ignores session_info_update without a title instead of clearing the existing name", async () => {
    const threadId = "thr_metadata_session_info";
    const providerThreadId = await startThread(threadId);
    await sendLocalCommand(threadId, providerThreadId, "/rename Existing session name");
    const deltas = await sendLocalCommand(threadId, providerThreadId, "/session-info");
    expect(readJsonLines(eventLog).filter((event) => event.type === "session_info_update")).toEqual([
      expect.objectContaining({ title: "Existing session name", sessionId: expect.any(String) }),
      { type: "session_info_update", sessionId: expect.any(String) },
    ]);
    expect(deltas.filter((delta) => delta.kind === "thread.name")).toEqual([]);
    expect(harness.deltasOf(threadId).filter((delta) => delta.kind === "thread.name")).toEqual([
      { kind: "thread.name", name: "Existing session name", source: "agent" },
    ]);
    expectPersistedTitle(providerThreadId, "Existing session name");
  }, 90_000);

  it("publishes initial native command metadata alongside the bridge-owned commands", async () => {
    const threadId = "thr_metadata_initial_commands";
    await startThread(threadId);
    const commands = providerCommands(threadId);
    expect(commands).toEqual(expect.arrayContaining(
      REQUIRED_BRIDGE_COMMAND_NAMES.map((name) => expect.objectContaining({ name })),
    ));
    expect(new Set(commands?.map((command) => command.name)).size).toBe(commands?.length);
    expect(commands).toEqual(expect.arrayContaining([
      OMP_AGENT_COMMAND,
      { name: "session-info", description: "" },
      { name: "old-command", description: "An old extension command" },
      { name: "empty-hint", description: "" },
    ]));
    const hintOf = (name: string) => commands?.find((command) => command.name === name)?.inputHint;
    // bb can't complete arguments, so subcommands a hint doesn't already name are listed in it.
    expect(hintOf("rename")).toBe("<title> (show)");
    expect(hintOf("todo")).toBe("<subcommand> (edit|done)");
    expect(hintOf("toggle")).toBe("[on|off]");
    expect(hintOf("memory")).toBe("view|mm");
  }, 90_000);

  it("caps the combined command catalog at 500 and prevents native commands from replacing bridge commands", async () => {
    const nativeCommands = Array.from({ length: 505 }, (_, index) => ({
      name: `command-${index}`,
      description: `Native command ${index}`,
    }));
    vi.stubEnv("FAKE_OMP_AVAILABLE_COMMANDS_JSON", JSON.stringify([
      ...REQUIRED_BRIDGE_COMMAND_NAMES.map((name) => ({
        name, description: `Native shadow of ${name}`,
      })),
      ...nativeCommands,
    ]));
    const threadId = "thr_metadata_bounded_commands";
    await startThread(threadId);
    const commands = providerCommands(threadId);
    expect(commands).toHaveLength(500);
    expect(commands?.filter((command) => command.name === "omp-agent")).toEqual([OMP_AGENT_COMMAND]);
    for (const name of REQUIRED_BRIDGE_COMMAND_NAMES) {
      const matches = commands?.filter((command) => command.name === name);
      expect(matches).toHaveLength(1);
      expect(matches?.[0]?.description).not.toBe(`Native shadow of ${name}`);
    }
    const nativeNames = new Set(nativeCommands.map((command) => command.name));
    const publishedNativeCommands = commands?.filter((command) => nativeNames.has(String(command.name)));
    const bridgeCommandCount = commands!.length - publishedNativeCommands!.length;
    expect(publishedNativeCommands).toEqual(nativeCommands.slice(0, 500 - bridgeCommandCount));
    expect(new Set(commands?.map((command) => command.name)).size).toBe(500);
  }, 90_000);

  it("replaces native command metadata on refresh, preserves bridge commands, and remains usable for another turn", async () => {
    const threadId = "thr_metadata_refresh_commands";
    const providerThreadId = await startThread(threadId);
    expect(providerCommands(threadId)).toContainEqual(expect.objectContaining({ name: "old-command" }));
    await sendLocalCommand(threadId, providerThreadId, "/refresh-commands");
    const commands = providerCommands(threadId);
    expect(commands).toEqual(expect.arrayContaining(
      REQUIRED_BRIDGE_COMMAND_NAMES.map((name) => expect.objectContaining({ name })),
    ));
    expect(commands).toEqual(expect.arrayContaining([
      OMP_AGENT_COMMAND,
      { name: "rename", description: "Set the updated session name", inputHint: "<new-title>" },
      { name: "refresh-commands", description: "Reload extension commands" },
    ]));
    expect(commands?.some((command) => command.name === "old-command" || command.name === "session-info")).toBe(false);
    expect(readJsonLines(eventLog)).toContainEqual({
      type: "available_commands_update",
      commands: UPDATED_OMP_COMMANDS,
    });

    const since = harness.deltasOf(threadId).length;
    const response = await harness.request(++nextId, "turn/start", {
      threadId,
      providerThreadId,
      clientRequestId: "creq_cd23456789",
      input: [{ type: "text", text: "continue after refreshing commands", mentions: [] }],
      options: FULL_PERMISSION_OPTIONS,
    });
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    expect(response.result).toEqual({ threadId });
    await harness.waitForTurnBoundary(threadId, since);
    const deltas = harness.deltasOf(threadId).slice(since);
    expect(deltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(1);
    expect(deltas.filter((delta) => delta.kind === "turn.boundary")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(deltas).toContainEqual(expect.objectContaining({
      kind: "item.textDelta",
      text: expect.stringContaining("Response to: continue after refreshing commands"),
    }));
    expect(harness.messages.filter((message) =>
      message.method === "error" || message.method === "session/ended",
    )).toEqual([]);
  }, 90_000);
});
