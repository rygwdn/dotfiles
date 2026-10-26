import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BridgeJsonRpcObject } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { OmpPermissionPolicy } from "../session-params.js";
import { ompProviderDeclaration } from "../declaration.js";
import { DEFAULT_OMP_MODEL_FILTER } from "../model-curation.js";
import { handleLine } from "./bridge.js";
import { findNewestOmpSessionFile } from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakeOmpBridgeHarness,
  startFakeOmpBridge,
} from "./test-support.js";

const ACCEPT_EDITS_OPTIONS = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
} as const;
const TIMEOUT_MS = 60_000;
const identitySchema = z.object({ providerThreadId: z.string() });
const launchSchema = z.object({ args: z.array(z.string()), threadId: z.string().nullable() });
const overlaySchema = z.object({
  memory: z.object({ backend: z.literal("off") }),
  autolearn: z.object({ autoContinue: z.literal(false) }),
  tools: z.object({ approvalMode: z.enum(["yolo", "write"]) }).optional(),
  skills: z.object({ customDirectories: z.array(z.string()) }).optional(),
  modelRoles: z.record(z.string(), z.string().nullable()).optional(),
  defaultThinkingLevel: z.string().optional(),
});
const rpcSchema = z.object({ type: z.string(), message: z.string().optional() });
const uiResponseSchema = z.object({
  id: z.string(),
  cancelled: z.boolean().optional(),
  value: z.string().optional(),
});
const approvalParamsSchema = z.object({
  threadId: z.string(),
  payload: z.object({ kind: z.literal("approval") }),
});

let harness: FakeOmpBridgeHarness;
let configPath: string;
let launchLog: string;
let overlayLog: string;
let rpcLog: string;
let uiLog: string;

beforeEach(async () => {
  harness = await startFakeOmpBridge({
    prefix: "bb-omp-permissions-",
    initialize: true,
    processLog: true,
  });
  const agentDir = join(harness.workspaceDir, "agent");
  mkdirSync(agentDir);
  configPath = join(agentDir, "config.yml");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CONFIG_FILES", undefined);
  launchLog = join(harness.workspaceDir, "launches.jsonl");
  overlayLog = join(harness.workspaceDir, "overlays.jsonl");
  rpcLog = join(harness.workspaceDir, "rpc.jsonl");
  uiLog = join(harness.workspaceDir, "ui.jsonl");
  vi.stubEnv("FAKE_OMP_LAUNCH_LOG", launchLog);
  vi.stubEnv("FAKE_OMP_CONFIG_LOG", overlayLog);
  vi.stubEnv("FAKE_OMP_RPC_LOG", rpcLog);
  vi.stubEnv("FAKE_OMP_UI_LOG", uiLog);
  await harness.request(99, "skills/configure", { roots: [] });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function lines(path: string): unknown[] {
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown)
    : [];
}

function launches(threadId: string) {
  return lines(launchLog).map((line) => launchSchema.parse(line))
    .filter((launch) => launch.threadId === threadId && launch.args[1] === "rpc-ui");
}

function overlays() {
  return lines(overlayLog).map((line) => overlaySchema.parse(line));
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function startThread(threadId: string, policy: OmpPermissionPolicy, options: BridgeJsonRpcObject = {}) {
  const response = await harness.startThread(threadId, { options: { ...policy, ...options } });
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  return identitySchema.parse(response.result).providerThreadId;
}

function turn(
  id: number,
  method: "turn/start" | "turn/steer",
  threadId: string,
  providerThreadId: string,
  policy: OmpPermissionPolicy,
  text: string,
  options: BridgeJsonRpcObject = {},
) {
  return harness.request(id, method, {
    threadId,
    providerThreadId,
    clientRequestId: `creq_abcdefghi${"23456789"[id % 8] ?? "2"}`,
    ...(method === "turn/steer" ? { expectedTurnId: "turn-1" } : {}),
    input: [{ type: "text", text, mentions: [] }],
    options: { ...policy, ...options },
  });
}

function replacementMessages(threadId: string) {
  return harness.messages.filter((message) => message.method === "session/replaced")
    .map((message) => z.object({
      threadId: z.string(),
      providerThreadId: z.string(),
      reason: z.string(),
      contextLost: z.boolean(),
    }).parse(message.params))
    .filter((replacement) => replacement.threadId === threadId);
}

it("advertises human approvals and full access without promising automatic review", () => {
  expect(ompProviderDeclaration(DEFAULT_OMP_MODEL_FILTER).capabilities?.permissionModes).toEqual(["full", "accept-edits"]);
});

it.each([
  { policy: FULL_PERMISSION_OPTIONS, approvalMode: "yolo" },
  { policy: ACCEPT_EDITS_OPTIONS, approvalMode: "write" },
  { policy: { ...ACCEPT_EDITS_OPTIONS, permissionEscalation: "deny" } as const, approvalMode: "write" },
])("launches $policy.permissionMode/$policy.permissionEscalation with a private $approvalMode overlay", async ({ policy, approvalMode }) => {
  const originalConfig = JSON.stringify({
    tools: { approvalMode: "always-ask", approval: { bash: "prompt", write: "deny" } },
  });
  writeFileSync(configPath, originalConfig);
  const threadId = "thr_permission_start";
  await startThread(threadId, policy);
  const [launch] = launches(threadId);
  expect(launch).toBeDefined();
  expect(launch!.args.filter((arg) => arg === "--config")).toHaveLength(1);
  expect(launch!.args).not.toContain("--yolo");
  expect(launch!.args).not.toContain("--auto-approve");
  expect(launch!.args).not.toContain("--approval-mode");
  expect(overlays()).toEqual([{ memory: { backend: "off" }, tools: { approvalMode }, autolearn: { autoContinue: false } }]);
  const overlayPath = flag(launch!.args, "--config")!;
  expect(overlayPath).not.toBe(configPath);
  expect(JSON.parse(readFileSync(overlayPath, "utf8"))).toEqual({ memory: { backend: "off" }, tools: { approvalMode }, autolearn: { autoContinue: false } });
  expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
}, TIMEOUT_MS);

it.each([
  { policy: FULL_PERMISSION_OPTIONS, approvalMode: "yolo" },
  { policy: ACCEPT_EDITS_OPTIONS, approvalMode: "write" },
])("merges $approvalMode approvals with skill paths and the selected preset", async ({ policy, approvalMode }) => {
  const modelRoles = { default: "fake-provider/fake-mini", task: "fake-provider/fake-model" };
  const originalConfig = JSON.stringify({
    skills: { customDirectories: ["user-skills"] },
    modelRoles: { default: "fake-provider/fake-model", advisor: "fake-provider/fake-model" },
    modelPresets: { selected: { modelRoles, defaultThinkingLevel: "low" } },
  });
  writeFileSync(configPath, originalConfig);
  const bbRoot = join(harness.workspaceDir, "bb-skills");
  await harness.request(1, "skills/configure", { roots: [{ id: "bb", path: bbRoot, skills: [] }] });
  const threadId = "thr_permission_composed";
  await startThread(threadId, policy, { model: "preset:selected" });
  expect(launches(threadId)[0]!.args.filter((arg) => arg === "--config")).toHaveLength(1);
  expect(overlays()).toEqual([{
    memory: { backend: "off" },
    tools: { approvalMode },
    autolearn: { autoContinue: false },
    skills: { customDirectories: [join(harness.workspaceDir, "user-skills"), bbRoot] },
    modelRoles: { ...modelRoles, advisor: null },
    defaultThinkingLevel: "low",
  }]);
  expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
}, TIMEOUT_MS);

it("uses the requested policy on resume and fork rather than inheriting the source policy", async () => {
  const threadId = "thr_permission_resume";
  const providerThreadId = await startThread(threadId, FULL_PERMISSION_OPTIONS);
  expect((await turn(1, "turn/start", threadId, providerThreadId, FULL_PERMISSION_OPTIONS, "saved history")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  await harness.request(2, "thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  const resumed = await harness.request(3, "thread/resume", {
    threadId,
    providerThreadId,
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: ACCEPT_EDITS_OPTIONS,
  });
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined();
  expect(resumed.result).toMatchObject({ providerThreadId });
  expect(overlays().map((overlay) => overlay.tools?.approvalMode)).toEqual(["yolo", "write"]);
  const forkId = "thr_permission_fork";
  const forked = await harness.request(4, "thread/fork", {
    threadId: forkId,
    sourceProviderThreadId: providerThreadId,
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(forked.error, JSON.stringify(forked)).toBeUndefined();
  expect(launches(forkId)).toHaveLength(1);
  // The fork spawn itself carries only the memory-off overlay (BI-13); its policy
  // applies on the forked thread's own rpc-ui launch.
  expect(overlays().filter((overlay) => overlay.tools).map((overlay) => overlay.tools!.approvalMode)).toEqual(["yolo", "write", "yolo"]);
}, TIMEOUT_MS);

it.each([
  { initial: FULL_PERMISSION_OPTIONS, next: ACCEPT_EDITS_OPTIONS, modes: ["yolo", "write"] },
  { initial: ACCEPT_EDITS_OPTIONS, next: FULL_PERMISSION_OPTIONS, modes: ["write", "yolo"] },
])("rebuilds once between turns when $initial.permissionMode changes to $next.permissionMode and keeps history", async ({ initial, next, modes }) => {
  const threadId = "thr_permission_change";
  const providerThreadId = await startThread(threadId, initial);
  const originalLaunch = launches(threadId)[0]!;
  const originalDir = flag(originalLaunch.args, "--session-dir")!;
  const originalOverlay = flag(originalLaunch.args, "--config")!;
  expect((await turn(1, "turn/start", threadId, providerThreadId, initial, "persisted policy sentinel")).error).toBeUndefined();
  let seen = await harness.waitForTurnBoundary(threadId);
  const originalFile = findNewestOmpSessionFile(originalDir)!;
  const history = readFileSync(originalFile, "utf8");
  const oldPid = harness.readProcessLog().spawned.at(-1)!;
  expect((await turn(2, "turn/start", threadId, providerThreadId, next, "continued after policy change")).error).toBeUndefined();
  seen = await harness.waitForTurnBoundary(threadId, seen);
  const newLaunch = launches(threadId)[1]!;
  expect(launches(threadId)).toHaveLength(2);
  expect(flag(newLaunch.args, "--session-dir")).toBe(originalDir);
  expect(newLaunch.args).toContain("--continue");
  expect(findNewestOmpSessionFile(originalDir)).toBe(originalFile);
  expect(readFileSync(originalFile, "utf8").startsWith(history)).toBe(true);
  expect(readFileSync(originalFile, "utf8")).toContain("continued after policy change");
  expect(existsSync(originalOverlay)).toBe(false);
  expect(overlays().map((overlay) => overlay.tools?.approvalMode)).toEqual(modes);
  expect(replacementMessages(threadId)).toEqual([{
    threadId,
    providerThreadId,
    reason: "Permission mode changed; the OMP session was restarted to apply it.",
    contextLost: false,
  }]);
  const newPid = harness.readProcessLog().spawned.at(-1)!;
  const processSteps = readFileSync(join(harness.workspaceDir, "process.log"), "utf8").split("\n");
  const exitedAt = processSteps.findIndex((step) => step.startsWith(`exit:${oldPid}:`));
  const spawnedAt = processSteps.findIndex((step) => step.startsWith(`spawn:${newPid}:`));
  expect(exitedAt).toBeGreaterThanOrEqual(0);
  expect(spawnedAt).toBeGreaterThan(exitedAt);
  expect((await turn(3, "turn/start", threadId, providerThreadId, next, "same policy snapshot")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  expect(launches(threadId)).toHaveLength(2);
  expect(replacementMessages(threadId)).toHaveLength(1);
}, TIMEOUT_MS);

it("stops a pending approval before applying an active steer policy and ignores the old reply", async () => {
  const threadId = "thr_permission_steer";
  const providerThreadId = await startThread(threadId, FULL_PERMISSION_OPTIONS);
  const spec = {
    id: "policy-approval",
    method: "select",
    title: "Allow tool: bash\nCommand: harmless",
    options: ["Approve", "Approve bash for this session", "Deny"],
  };
  expect((await turn(1, "turn/start", threadId, providerThreadId, FULL_PERMISSION_OPTIONS, `/ui ${JSON.stringify(spec)}`)).error).toBeUndefined();
  const approval = await harness.waitForMessage((message) => {
    if (message.method !== "interaction/request") return false;
    const parsed = approvalParamsSchema.safeParse(message.params);
    return parsed.success && parsed.data.threadId === threadId;
  }, "the native approval");
  const seen = harness.deltasOf(threadId).length;
  expect((await turn(2, "turn/steer", threadId, providerThreadId, ACCEPT_EDITS_OPTIONS, "continue with restrictive approval policy")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId, seen);
  expect(overlays().map((overlay) => overlay.tools?.approvalMode)).toEqual(["yolo", "write"]);
  expect(lines(uiLog).map((line) => uiResponseSchema.parse(line))).toEqual([{ id: spec.id, cancelled: true }]);
  const sent = lines(rpcLog).map((line) => rpcSchema.parse(line));
  expect(sent.filter((command) => command.type === "steer")).toEqual([]);
  expect(sent).toContainEqual({ type: "prompt", message: "continue with restrictive approval policy" });

  expect((await turn(3, "turn/start", threadId, providerThreadId, ACCEPT_EDITS_OPTIONS, `/ui ${JSON.stringify(spec)}`)).error).toBeUndefined();
  const newApproval = await harness.waitForMessage((message) => {
    if (message.method !== "interaction/request" || message.id === approval.id) return false;
    const parsed = approvalParamsSchema.safeParse(message.params);
    return parsed.success && parsed.data.threadId === threadId;
  }, "the replacement child's approval with the reused OMP id");
  handleLine(JSON.stringify({
    jsonrpc: "2.0",
    id: approval.id,
    result: { decision: "allow_once", grantedPermissions: null },
  }));
  handleLine(JSON.stringify({ jsonrpc: "2.0", id: newApproval.id, result: { decision: "deny" } }));
  await harness.waitForTurnBoundary(threadId, harness.deltasOf(threadId).length);
  expect(lines(uiLog).map((line) => uiResponseSchema.parse(line))).toEqual([
    { id: spec.id, cancelled: true },
    { id: spec.id, value: "Deny" },
  ]);
}, TIMEOUT_MS);

it.each([
  { method: "turn/start", text: "/goal show" },
  { method: "turn/start", text: "/login" },
  { method: "turn/steer", text: "/goal show" },
  { method: "turn/steer", text: "/login" },
] as const)("applies a changed permission policy before the $method $text fast path", async ({ method, text }) => {
  const threadId = "thr_permission_local";
  const providerThreadId = await startThread(threadId, FULL_PERMISSION_OPTIONS);
  if (method === "turn/steer") {
    expect((await turn(1, "turn/start", threadId, providerThreadId, FULL_PERMISSION_OPTIONS, "/hold")).error).toBeUndefined();
    await harness.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
  }
  const since = harness.deltasOf(threadId).length;
  expect((await turn(2, method, threadId, providerThreadId, ACCEPT_EDITS_OPTIONS, text)).error).toBeUndefined();
  expect(launches(threadId)).toHaveLength(2);
  expect(overlays().map((overlay) => overlay.tools?.approvalMode)).toEqual(["yolo", "write"]);
  await harness.waitForTurnBoundary(threadId, since);
  expect(replacementMessages(threadId)).toHaveLength(1);
}, TIMEOUT_MS);

it("waits for an EOF- and SIGTERM-resistant old child to exit before policy replacement", async () => {
  vi.stubEnv("FAKE_OMP_HANG_ON_CLOSE", "1");
  const threadId = "thr_permission_exit_fence";
  const providerThreadId = await startThread(threadId, FULL_PERMISSION_OPTIONS);
  const oldPid = harness.readProcessLog().spawned.at(-1)!;
  const oldOverlay = flag(launches(threadId)[0]!.args, "--config")!;
  vi.stubEnv("FAKE_OMP_HANG_ON_CLOSE", undefined);
  expect((await turn(1, "turn/start", threadId, providerThreadId, ACCEPT_EDITS_OPTIONS, "after forced shutdown")).error).toBeUndefined();
  await harness.waitForTurnBoundary(threadId);
  expect(launches(threadId)).toHaveLength(2);
  expect(harness.runningChildPids()).not.toContain(oldPid);
  expect(existsSync(oldOverlay)).toBe(false);
  expect(overlays().at(-1)?.tools?.approvalMode).toBe("write");
}, TIMEOUT_MS);

it("does not restore the old permissive child when the restrictive replacement fails", async () => {
  const threadId = "thr_permission_failed_rebuild";
  const providerThreadId = await startThread(threadId, FULL_PERMISSION_OPTIONS);
  const oldPid = harness.readProcessLog().spawned.at(-1)!;
  vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", "1");
  const failed = await turn(1, "turn/start", threadId, providerThreadId, ACCEPT_EDITS_OPTIONS, "must not reach the old child");
  vi.stubEnv("FAKE_OMP_EXIT_BEFORE_FIRST_RESPONSE", undefined);
  expect(failed.error).toMatchObject({ code: -32000 });
  expect(harness.runningChildPids()).not.toContain(oldPid);
  const retry = await turn(2, "turn/start", threadId, providerThreadId, ACCEPT_EDITS_OPTIONS, "still unavailable");
  expect(retry.error).toMatchObject({ message: "No active omp session" });
  expect(replacementMessages(threadId)).toEqual([]);
}, TIMEOUT_MS);
