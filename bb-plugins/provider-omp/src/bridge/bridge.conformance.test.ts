import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import { type FakeOmpBridgeHarness, startFakeOmpBridge } from "./test-support.js";

const CONFORMANCE_WAIT_TIMEOUT_MS = 30_000;

let harness: FakeOmpBridgeHarness;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-conformance-ws-",
    initialize: false,
  });
  vi.stubEnv("FAKE_OMP_RPC_LOG", join(harness.workspaceDir, "rpc.jsonl"));
  vi.stubEnv("FAKE_OMP_EVENT_LOG", join(harness.workspaceDir, "events.jsonl"));
});

afterEach(async () => {
  await harness.teardown();
});

it("passes the canonical protocol suite against a native OMP wire child", async () => {
  const report = await runBridgeConformance({
    transport: { send: handleLine, takeMessages: harness.takeMessages },
    providerId: "omp",
    session: {
      cwd: harness.workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "/hold", mentions: [] }],
    },
    timeoutMs: CONFORMANCE_WAIT_TIMEOUT_MS,
  });

  console.info(`omp bridge conformance:\n${formatConformanceReport(report)}`);

  const statusById = Object.fromEntries(
    report.results.map((result) => [result.id, result.status]),
  );
  expect(statusById).toMatchObject({
    "rpc/unknown-method": "pass",
    "rpc/invalid-params": "pass",
    "rpc/non-json-ignored": "pass",
    "rpc/response-not-request": "pass",
    "handshake/initialize": "pass",
    "session/start-identity": "pass",
    "session/start-identity-announced": "pass",
    "turn/lifecycle": "pass",
    "events/schema-valid": "pass",
    "item/opens-before-delta": "pass",
    "stop/release-not-interrupted": "pass",
    "session/resume-identity": "pass",
    "session/resume-id-uniqueness": "pass",
    "session/fork-identity": "pass",
    "session/fork-identity-announced": "pass",
    "session/threads-independent": "pass",
    "stop/interrupt-settles-before-result": "pass",
  });
  expect(
    report.results
      .filter((result) => result.status !== "pass")
      .map((r) => r.id),
  ).toEqual([]);
  const commands = readFileSync(join(harness.workspaceDir, "rpc.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const events = readFileSync(join(harness.workspaceDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(commands[0]).toMatchObject({
    type: "negotiate_protocol",
    protocolVersion: 2,
  });
  expect(events[0]).toMatchObject({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
  });
  const prompts = commands.filter((command) => command.type === "prompt");
  const results = events.filter((event) => event.type === "prompt_result");
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(prompts.some((prompt) => prompt.id === result.id)).toBe(true);
  }
  expect(events.some((event) => event.type === "session_settled")).toBe(true);
  expect(events.some((event) => event.type === "agent_settled")).toBe(false);
  for (const event of events.filter((event) => event.type === "agent_end")) {
    expect(event.messages).toBeUndefined();
    expect(event.willRetry).toBeUndefined();
    expect(event.messageCount).toBeGreaterThan(0);
  }
}, 60_000);
