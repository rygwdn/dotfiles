import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OMP_BRIDGE_ARGS_ENV } from "./rpc-child.js";
import { type FakeOmpBridgeHarness, fakeOmpPath, startFakeOmpBridge } from "./test-support.js";

const commandListSchema = z.object({ commands: z.array(z.record(z.string(), z.unknown())) });
const launchSchema = z.object({ args: z.array(z.string()) });
const NATIVE_COMMANDS = [
  { name: "rename", description: "Rename the session", input: { hint: "<title>" }, subcommands: [{ name: "show" }] },
  { name: "todo", input: { hint: "<subcommand>" }, subcommands: [{ name: "edit" }, { name: "done" }] },
  { name: "btw", description: "Native shadow of a bridge command" },
  { name: "session-info" },
];

describe("commands/list through the bb bridge", () => {
  let harness: FakeOmpBridgeHarness;
  let launchLog: string;
  let initializeResult: unknown;
  let nextId = 20_000;

  beforeEach(async () => {
    harness = await startFakeOmpBridge({ prefix: "bb-omp-list-commands-", initialize: false });
    launchLog = join(harness.workspaceDir, "launch.jsonl");
    vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLog);
    vi.stubEnv("FAKE_OMP_AVAILABLE_COMMANDS_JSON", JSON.stringify(NATIVE_COMMANDS));
    const response = await harness.request(++nextId, "initialize", {
      protocolVersion: 2,
      client: { name: "list-commands-test", version: "0" },
      grammarVersions: [3, 3],
    });
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    initializeResult = response.result;
  }, 90_000);

  afterEach(async () => {
    await harness.teardown();
  }, 90_000);

  function launches(): string[][] {
    if (!existsSync(launchLog)) return [];
    return readFileSync(launchLog, "utf8").split("\n").filter(Boolean)
      .map((line) => launchSchema.parse(JSON.parse(line)).args);
  }

  function listCommands(cwd = harness.workspaceDir) {
    return harness.request(++nextId, "commands/list", { cwd });
  }

  it("advertises commands.list in initialize", () => {
    expect(initializeResult).toMatchObject({ capabilities: { commands: { list: true } } });
  });

  it("lists the commands a live session would publish from one sessionless omp child", async () => {
    const response = await listCommands();
    expect(response.error, JSON.stringify(response)).toBeUndefined();
    const listed = commandListSchema.parse(response.result).commands;
    // No thread exists yet: one catalog child, nothing written to the session dir.
    expect(launches()).toEqual([expect.arrayContaining(["--mode", "rpc", "--no-session"])]);
    expect(existsSync(harness.sessionDir) ? readdirSync(harness.sessionDir) : []).toEqual([]);
    expect(listed.filter((command) => command.name === "btw")).toEqual([
      expect.objectContaining({ description: "Ask an OMP side question without interrupting the main run" }),
    ]);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "omp-agent" }),
      { name: "rename", description: "Rename the session", inputHint: "<title> (show)" },
      { name: "todo", description: "", inputHint: "<subcommand> (edit|done)" },
      { name: "session-info", description: "" },
    ]));

    // A warm cwd is answered by the same child.
    expect(commandListSchema.parse((await listCommands()).result).commands).toEqual(listed);
    expect(launches()).toHaveLength(1);

    const threadId = "thr_list_commands_parity";
    const started = await harness.startThread(threadId);
    expect(started.error, JSON.stringify(started)).toBeUndefined();
    const published = harness.deltasOf(threadId).filter((delta) =>
      delta.kind === "extension.state" && delta.extensionKind === "bb/provider-commands",
    ).at(-1);
    expect(published?.payload).toEqual({ commands: listed });
  }, 90_000);

  it("returns an error when omp cannot list commands and recovers on the next request", async () => {
    vi.stubEnv(OMP_BRIDGE_ARGS_ENV, JSON.stringify([fakeOmpPath, "--not-an-omp-flag"]));
    const failedSpawn = await listCommands();
    expect(failedSpawn.result).toBeUndefined();
    expect(failedSpawn.error).toMatchObject({ code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR });

    // The failed child is not cached: a healthy omp answers the next request.
    vi.stubEnv(OMP_BRIDGE_ARGS_ENV, JSON.stringify([fakeOmpPath]));
    const recovered = await listCommands();
    expect(recovered.error, JSON.stringify(recovered)).toBeUndefined();
    expect(commandListSchema.parse(recovered.result).commands).toContainEqual(
      expect.objectContaining({ name: "session-info" }),
    );

    const otherCwd = join(harness.workspaceDir, "other");
    mkdirSync(otherCwd);
    vi.stubEnv("FAKE_OMP_AVAILABLE_COMMANDS_ERROR", "extension registry unavailable");
    const failedRpc = await listCommands(otherCwd);
    expect(failedRpc.error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      message: expect.stringContaining("extension registry unavailable"),
    });

    // A thread started after the failures still works.
    vi.stubEnv("FAKE_OMP_AVAILABLE_COMMANDS_ERROR", "");
    const started = await harness.startThread("thr_list_commands_after_failure");
    expect(started.error, JSON.stringify(started)).toBeUndefined();
  }, 90_000);
});
