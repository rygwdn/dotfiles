/**
 * What gets graded `safe`.
 *
 * `safe` is the tier the guard is allowed to act on without asking, so the
 * question each of these pins is the one that decides it: is anything still
 * waiting on this process? Nothing here may depend on a port number, a
 * directory, or any other local convention — an earlier version graded dev
 * servers by port against a shipped default list, which worked on exactly one
 * machine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { userInfo } from "node:os";
import { buildPlan } from "../lib/relieve.ts";

const ME = userInfo().username;

const config = {
  protectedPorts: new Set(),
  exemptPatterns: [],
  idleSeconds: 600,
  protectedThreadIds: new Set(),
};

const consumer = (over = {}) => ({
  id: "pid:100",
  label: "thing",
  detail: "cmd",
  kind: "browser-automation",
  bytes: 1024 ** 3,
  processCount: 1,
  rootPid: 100,
  parentPid: 900,
  pids: [100],
  ageSeconds: 3600,
  cpuPercent: 0,
  threadId: null,
  threadTitle: null,
  port: null,
  ...over,
});

const row = (over = {}) => ({
  pid: 100,
  ppid: 900,
  rssBytes: 1024 ** 3,
  ageSeconds: 3600,
  cpuPercent: 0,
  command: "cmd",
  name: "cmd",
  user: ME,
  kind: "browser-automation",
  threadId: null,
  port: null,
  ...over,
});

const planFor = (over = {}, rowOver = {}) =>
  buildPlan({
    consumers: [consumer(over)],
    threadConsumers: [],
    rows: [row({ kind: over.kind ?? "browser-automation", ...rowOver })],
    config,
    selfPids: new Set(),
    steerLimit: 0,
  });

const riskOf = (plan) => plan.candidates[0]?.risk ?? null;

test("an idle headless browser is safe, a busy one is not", () => {
  assert.equal(riskOf(planFor({ cpuPercent: 0, ageSeconds: 3600 })), "safe");
  // Mid-assertion: killing this fails somebody's test run.
  assert.equal(riskOf(planFor({ cpuPercent: 30, ageSeconds: 3600 })), "disruptive");
  // Idle, but not for long enough to call it abandoned.
  assert.equal(riskOf(planFor({ cpuPercent: 0, ageSeconds: 120 })), "disruptive");
});

test("an orphan is safe whatever it is doing, because nothing can be waiting on it", () => {
  const orphan = { parentPid: 1, cpuPercent: 80, ageSeconds: 120 };
  assert.equal(riskOf(planFor(orphan, { ppid: 1 })), "safe");
});

test("an idle dev server is NOT safe — idle is a server's resting state", () => {
  const idleServer = { kind: "dev-server", cpuPercent: 0, ageSeconds: 7200, port: 5173 };
  assert.equal(riskOf(planFor(idleServer, { kind: "dev-server" })), "disruptive");

  // Orphaned is different: whatever started it is gone.
  const orphanServer = { ...idleServer, parentPid: 1 };
  assert.equal(riskOf(planFor(orphanServer, { kind: "dev-server", ppid: 1 })), "safe");
});

test("an orphaned test runner is safe; an idle one with a live parent is not", () => {
  const orphan = { kind: "test-runner", cpuPercent: 0, ageSeconds: 3600, parentPid: 1 };
  assert.equal(riskOf(planFor(orphan, { kind: "test-runner", ppid: 1 })), "safe");

  // Idle with a live parent means something is awaiting its exit code.
  const idle = { kind: "test-runner", cpuPercent: 0, ageSeconds: 3600 };
  assert.equal(riskOf(planFor(idle, { kind: "test-runner" })), "disruptive");
});

test("an idle build tool with a live parent is NOT safe", () => {
  // Regression, and the worst bug this plugin has had. Grading "idle build
  // tool" as safe made Ballast terminate BB's own `esbuild --service`, which
  // sits at 0% CPU between requests by design. Every plugin install after that
  // failed with "The service is no longer running" until BB was restarted.
  const idleTool = { kind: "toolchain", cpuPercent: 0, ageSeconds: 7200 };
  assert.equal(riskOf(planFor(idleTool, { kind: "toolchain" })), "disruptive");

  const orphanTool = { kind: "toolchain", cpuPercent: 0, ageSeconds: 7200, parentPid: 1 };
  assert.equal(riskOf(planFor(orphanTool, { kind: "toolchain", ppid: 1 })), "safe");
});

test("safeBytes counts only the safe terminate candidates", () => {
  const plan = buildPlan({
    consumers: [
      consumer({ id: "a", rootPid: 100, pids: [100], bytes: 1024 ** 3 }),
      consumer({ id: "b", rootPid: 101, pids: [101], bytes: 2 * 1024 ** 3, cpuPercent: 50 }),
    ],
    threadConsumers: [],
    rows: [row({ pid: 100 }), row({ pid: 101 })],
    config,
    selfPids: new Set(),
    steerLimit: 0,
  });
  assert.equal(plan.safeBytes, 1024 ** 3);
  assert.equal(plan.disruptiveBytes, 2 * 1024 ** 3);
});

test("steering a thread is always disruptive and never counted as freed bytes", () => {
  const plan = buildPlan({
    consumers: [],
    threadConsumers: [
      consumer({ id: "t", threadId: "thr_abc", label: "Some thread", bytes: 3 * 1024 ** 3 }),
    ],
    rows: [],
    config,
    selfPids: new Set(),
    steerLimit: 3,
  });
  const steer = plan.candidates.find((row) => row.action === "steer");
  assert.ok(steer);
  assert.equal(steer.risk, "disruptive");
  // Asking a thread to release memory frees nothing by itself, so it must not
  // inflate the total the panel offers to free.
  assert.equal(plan.safeBytes, 0);
  assert.equal(plan.disruptiveBytes, 0);
});

test("a plan with nothing but refusals has no actionable candidate", () => {
  // Regression: the guard escalated twice with "0 B safe to reclaim" and no
  // thread to ask, spawning an agent whose only possible move was to ask the
  // user a question — the one thing an unattended escalation must not do.
  // `escalate` now checks for exactly this emptiness before spawning.
  const plan = buildPlan({
    consumers: [consumer({ kind: "agent", bytes: 4 * 1024 ** 3 })],
    threadConsumers: [],
    rows: [row({ kind: "agent" })],
    config,
    selfPids: new Set(),
    steerLimit: 3,
  });
  const actionable = plan.candidates.filter((c) => c.risk !== "protected");
  assert.equal(actionable.length, 0);
  assert.equal(plan.safeBytes, 0);
});

test("steer candidates exist only when a thread is actually holding memory", () => {
  const plan = buildPlan({
    consumers: [],
    threadConsumers: [consumer({ id: "t", threadId: "thr_x", bytes: 2 * 1024 ** 3 })],
    rows: [],
    config,
    selfPids: new Set(),
    steerLimit: 3,
  });
  const actionable = plan.candidates.filter((c) => c.risk !== "protected");
  assert.equal(actionable.length, 1);
  assert.equal(actionable[0].action, "steer");
});
