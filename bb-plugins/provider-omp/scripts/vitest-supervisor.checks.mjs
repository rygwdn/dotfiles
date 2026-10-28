import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunTree, signalOwned, parseSnapshot, resolveVitest, OVERLOAD_EXIT } from './vitest-supervisor.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const row = (pid, ppid, start = `start-${pid}`, rss = 0, cpu = 0) => ({ pid, ppid, start, rss, cpu });
const snap = (...rows) => new Map(rows.map(value => [value.pid, value]));

test('dry-run signals only newly owned identities, never siblings, unrelated or pre-existing children', async () => {
  const root = row(10, 1), child = row(11, 10), grandchild = row(12, 11);
  const sibling = row(20, 1), unrelated = row(30, 99), preexisting = row(40, 10);
  const tree = new RunTree(10, snap(sibling, unrelated, preexisting));
  const current = snap(root, child, grandchild, sibling, unrelated, preexisting);
  tree.observe(current, 0);
  const sent = [];
  await signalOwned(tree, 'SIGTERM', async () => current, (pid, signal) => sent.push([pid, signal]));
  assert.deepEqual(sent, [[10, 'SIGTERM'], [11, 'SIGTERM'], [12, 'SIGTERM']]);
  assert.equal(OVERLOAD_EXIT, 75);
});

test('dry-run revalidates each signal and rejects PID reuse, changed parents and disappearance', async () => {
  const root = row(10, 1), child = row(11, 10), other = row(12, 10);
  const initial = snap(root, child, other);
  const tree = new RunTree(10, snap());
  tree.observe(initial, 0);
  let reads = 0;
  const sent = [];
  await signalOwned(tree, 'SIGKILL', async () => {
    reads++;
    return reads === 1 ? initial : snap(row(10, 1, 'reused'), row(11, 99));
  }, pid => sent.push(pid));
  assert.deepEqual(sent, []);
});

test('root TERM is first; cleanup can retain known descendants after root exits but refuses reparented ones', async () => {
  const root = row(10, 1), child = row(11, 10);
  const tree = new RunTree(10, snap());
  tree.observe(snap(root, child), 0);
  const sent = [];
  await signalOwned(tree, 'SIGTERM', async () => snap(root, child), pid => sent.push(pid), true);
  await signalOwned(tree, 'SIGKILL', async () => snap(row(11, 1)), pid => sent.push(pid));
  assert.deepEqual(sent, [10]);
});

test('clock-driven process and RSS limits require ten continuous seconds and reset on recovery', () => {
  const tree = new RunTree(10, snap(), { cpuCount: 1, memory: 1000 });
  const high = snap(row(10, 1, 'root', 260), ...Array.from({ length: 32 }, (_, i) => row(11 + i, 10)));
  assert.deepEqual(tree.observe(high, 0).abort, []);
  assert.deepEqual(tree.observe(high, 9999).abort, []);
  assert.deepEqual(tree.observe(high, 10000).abort, ['processes', 'rss']);
  tree.observe(snap(row(10, 1, 'root')), 10001);
  assert.deepEqual(tree.observe(high, 20000).abort, []);
  assert.deepEqual(tree.observe(high, 30000).abort, ['processes', 'rss']);
});

test('RSS warning and CPU load do not abort; process floor scales with CPUs', () => {
  const tree = new RunTree(10, snap(), { cpuCount: 10, memory: 1000 });
  assert.equal(tree.processMax, 40);
  const highCpu = snap(row(10, 1, 'root', 160, 1001));
  assert.equal(tree.observe(highCpu, 0).warnRss, true);
  const later = tree.observe(highCpu, 100000);
  assert.equal(later.warnCpu, true);
  assert.deepEqual(later.abort, []);
});

test('malformed and duplicate snapshots fail closed without signals', async () => {
  const text = '10 1 Wed Oct 28 12:34:56 2026 123 1.5';
  assert.equal(parseSnapshot(text).get(10).rss, 123 * 1024);
  assert.throws(() => parseSnapshot(`${text}\n${text}`), /Ambiguous/);
  assert.throws(() => parseSnapshot('not a process'), /Ambiguous/);
  const tree = new RunTree(10, snap());
  tree.observe(snap(row(10, 1)), 0);
  const sent = [];
  await assert.rejects(signalOwned(tree, 'SIGKILL', async () => { throw new Error('snapshot failed'); }, pid => sent.push(pid)));
  assert.deepEqual(sent, []);
});

test('Vitest resolves directly inside checkout and refuses outside symlinks', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'supervisor-test-')));
  try {
    const checkout = join(fixture, 'checkout');
    const local = join(checkout, 'node_modules', 'vitest');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(checkout, 'package.json'), '{}');
    writeFileSync(join(local, 'package.json'), '{"name":"vitest","exports":{"./package.json":"./package.json"}}');
    writeFileSync(join(local, 'vitest.mjs'), '');
    assert.equal(resolveVitest(checkout), join(local, 'vitest.mjs'));
    rmSync(local, { recursive: true });
    const outside = join(fixture, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'package.json'), '{"name":"vitest","exports":{"./package.json":"./package.json"}}');
    writeFileSync(join(outside, 'vitest.mjs'), '');
    symlinkSync(outside, local, 'dir');
    assert.throws(() => resolveVitest(checkout), /inside this checkout/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
