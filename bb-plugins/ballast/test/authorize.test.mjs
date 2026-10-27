/**
 * The gate.
 *
 * Every test here is a refusal that must hold. If one of these ever goes green
 * by accident, Ballast kills something it should not have — so they are written
 * as "this is refused, and here is the reason", not as "this returns false".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { userInfo } from "node:os";
import { authorize } from "../lib/relieve.ts";
import { DEFAULT_THRESHOLDS, evaluatePressure, worst } from "../lib/pressure.ts";

const ME = userInfo().username;

const config = {
  protectedPorts: new Set([3000]),
  exemptPatterns: ["do-not-touch"],
  idleSeconds: 600,
  protectedThreadIds: new Set(["thr_protected"]),
};

const row = (over = {}) => ({
  pid: 100,
  ppid: 1,
  rssBytes: 1024 ** 3,
  ageSeconds: 3600,
  cpuPercent: 0,
  command: "chrome-headless-shell --headless",
  name: "chrome-headless-shell",
  user: ME,
  kind: "browser-automation",
  threadId: null,
  port: null,
  ...over,
});

const consumer = (over = {}) => ({
  id: "pid:100",
  label: "Headless browser",
  detail: "chrome-headless-shell --headless",
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

test("a genuinely idle headless browser is authorized", () => {
  const result = authorize(consumer(), [row()], config, new Set());
  assert.equal(result.ok, true);
});

test("every kind outside the killable four is refused", () => {
  for (const kind of ["agent", "bb", "editor", "browser", "container", "system", "other"]) {
    const result = authorize(consumer({ kind }), [row({ kind })], config, new Set());
    assert.equal(result.ok, false, `${kind} must be refused`);
    assert.match(result.refusal, /never terminated/);
  }
});

test("Ballast's own process tree is refused even when it looks killable", () => {
  const result = authorize(consumer(), [row()], config, new Set([100]));
  assert.equal(result.ok, false);
  assert.match(result.refusal, /own process tree/);
});

test("a process on a protected port is refused", () => {
  const dev = { kind: "dev-server", port: 3000 };
  const result = authorize(consumer(dev), [row(dev)], config, new Set());
  assert.equal(result.ok, false);
  assert.match(result.refusal, /protected port/);

  // A port nobody protected is not, by itself, a reason to stop anything —
  // it only means the port list has no opinion. Disposability decides.
  const other = { kind: "dev-server", port: 4899 };
  assert.equal(authorize(consumer(other), [row(other)], config, new Set()).ok, true);
});

test("the default configuration protects no ports at all", () => {
  // Regression: shipping a default port list encoded one machine's
  // conventions as everyone's, and the panel explained a refusal with a port
  // number the user had never configured.
  const bare = { ...config, protectedPorts: new Set() };
  const dev = { kind: "dev-server", port: 3000 };
  assert.equal(authorize(consumer(dev), [row(dev)], bare, new Set()).ok, true);
});

test("another user's process is refused", () => {
  const result = authorize(consumer(), [row({ user: "root" })], config, new Set());
  assert.equal(result.ok, false);
  assert.match(result.refusal, /not the current user/);
});

test("anything younger than a minute is refused — it is probably what just started", () => {
  const result = authorize(consumer({ ageSeconds: 12 }), [row({ ageSeconds: 12 })], config, new Set());
  assert.equal(result.ok, false);
  assert.match(result.refusal, /started/);
});

test("an exempt pattern anywhere in the command line refuses the whole tree", () => {
  const command = "chrome-headless-shell --user-data-dir=/tmp/do-not-touch";
  const result = authorize(consumer(), [row({ command })], config, new Set());
  assert.equal(result.ok, false);
  assert.match(result.refusal, /exempt pattern/);
});

test("a protected thread's processes are refused", () => {
  const over = { threadId: "thr_protected" };
  const result = authorize(consumer(over), [row(over)], config, new Set());
  assert.equal(result.ok, false);
  assert.match(result.refusal, /protected thread/);
});

test("a refusal on any member refuses the tree, not just that member", () => {
  const rows = [row({ pid: 100 }), row({ pid: 101, user: "root" })];
  const result = authorize(consumer({ pids: [100, 101] }), rows, config, new Set());
  assert.equal(result.ok, false);
});

/* ---------------- grading ---------------- */

const sample = (over = {}) => ({
  atMs: Date.now(),
  totalBytes: 24 * 1024 ** 3,
  freeBytes: 1024 ** 3,
  appBytes: 10 * 1024 ** 3,
  wiredBytes: 3 * 1024 ** 3,
  compressedBytes: 2 * 1024 ** 3,
  cachedFileBytes: 6 * 1024 ** 3,
  purgeableBytes: 0,
  headroomBytes: 7 * 1024 ** 3,
  usedBytes: 15 * 1024 ** 3,
  swapTotalBytes: 6 * 1024 ** 3,
  swapUsedBytes: 0,
  swapInRate: 0,
  swapOutRate: 0,
  compressionRatio: 3,
  kernelPressure: "normal",
  ...over,
});

test("a machine with plenty of headroom grades ok, however full it looks", () => {
  const pressure = evaluatePressure(sample(), DEFAULT_THRESHOLDS);
  assert.equal(pressure.level, "ok");
});

test("headroom is graded in absolute terms, not as a percentage", () => {
  // 62% used — a percentage-only rule would call this healthy — but only
  // 700 MB of headroom left.
  const pressure = evaluatePressure(
    sample({ headroomBytes: 0.7 * 1024 ** 3 }),
    DEFAULT_THRESHOLDS,
  );
  assert.equal(pressure.level, "critical");
  assert.match(pressure.reason, /headroom/);
});

test("paging in grades on the rate, and resident swap alone never does", () => {
  const parked = evaluatePressure(
    sample({ swapUsedBytes: 5 * 1024 ** 3 }),
    DEFAULT_THRESHOLDS,
  );
  assert.equal(parked.level, "ok", "swap sitting there is not a problem");

  const thrashing = evaluatePressure(
    sample({ swapInRate: (700 * 1024 ** 2) / 60 }),
    DEFAULT_THRESHOLDS,
  );
  assert.equal(thrashing.level, "critical");
  assert.match(thrashing.reason, /paging in/);
});

test("the kernel's own verdict outranks our arithmetic", () => {
  const pressure = evaluatePressure(sample({ kernelPressure: "critical" }), DEFAULT_THRESHOLDS);
  assert.equal(pressure.level, "critical");
  assert.match(pressure.reason, /kernel/);
});

test("the reason names the signal that decided, and every signal is listed", () => {
  const pressure = evaluatePressure(
    sample({ headroomBytes: 0.5 * 1024 ** 3, usedBytes: 23 * 1024 ** 3 }),
    DEFAULT_THRESHOLDS,
  );
  assert.equal(pressure.level, "critical");
  assert.ok(pressure.signals.length >= 2);
  assert.equal(pressure.signals[0].level, "critical");
});

test("worst() orders the ladder", () => {
  assert.equal(worst("ok", "watch"), "watch");
  assert.equal(worst("critical", "warn"), "critical");
  assert.equal(worst("warn", "warn"), "warn");
});
