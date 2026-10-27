import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributeThreads } from '../lib/attribution.ts';
import { classify, processName, groupConsumers, groupByThread } from '../lib/procs.ts';

const row = (pid, ppid, command, threadId = null) => ({ pid, ppid, command, threadId,
  name: processName(command), kind: classify(command, processName(command)),
  rssBytes: 1024, ageSeconds: 300, cpuPercent: 0, user: 'test', port: null });
const a = 'thr_abcdefgh', b = 'thr_ijklmnop';

test('service BB stays separate from OMP agents and their descendants', () => {
  const rows = [row(10, 1, 'node /home/u/.local/share/bb-service/node_modules/bb-app/dist/bb-app.js start'),
    row(11, 10, 'omp acp'), row(12, 10, 'omp acp'), row(13, 11, 'node worker.js'), row(14, 12, 'node worker.js')];
  const attributed = attributeThreads(rows, [], new Map([[11, a], [12, b]]));
  assert.deepEqual(attributed.map(r => r.threadId), [null, a, b, a, b]);
  assert.equal(attributed[0].kind, 'bb');
  assert.equal(attributed[1].kind, 'agent');
  const threads = groupByThread(groupConsumers(attributed, new Map(), { minBytes: 0 }), new Map());
  assert.deepEqual(threads.map(t => [t.threadId, t.bytes, t.pids]), [[a, 2048, [11, 13]], [b, 2048, [12, 14]]]);
});

test('shared checkout and path prefixes do not invent ownership', () => {
  const paths = [{ threadId: a, path: '/repo/app' }, { threadId: b, path: '/repo/app' }];
  assert.equal(attributeThreads([row(1, 0, 'node /repo/app/main.js')], paths, new Map())[0].threadId, null);
  assert.equal(attributeThreads([row(1, 0, 'node /repo/apple/main.js')], paths.slice(0, 1), new Map())[0].threadId, null);
  assert.equal(attributeThreads([row(1, 0, 'node /repo/app/main.js')], paths.slice(0, 1), new Map())[0].threadId, a);
});

test('explicit child identity wins and cycles terminate without attribution', () => {
  const rows = [row(1, 2, 'omp acp'), row(2, 1, 'node worker.js', b)];
  assert.deepEqual(attributeThreads(rows, [], new Map([[1, a]])).map(r => r.threadId), [a, b]);
  assert.deepEqual(attributeThreads(rows.map(r => ({...r, threadId: null})), [], new Map()).map(r => r.threadId), [null, null]);
});

test('different thread identities never collapse into one process consumer', () => {
  const rows = [row(1, 0, 'node parent.js', a), row(2, 1, 'node child.js', b)];
  assert.equal(groupConsumers(rows, new Map(), { minBytes: 0 }).length, 2);
});

const BB_SERVICE = '/opt/homebrew/bin/node /Users/x/.local/share/bb-service/node_modules/bb-app/dist/bb-app.js start --data-dir /Users/x/.bb --server-port 38886 --host-daemon-port 38887';
const BB_HOST_WORKER = '/opt/homebrew/bin/node /Users/x/.local/share/bb-service/node_modules/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs /Users/x/.bb/plugin-host-artifacts/bb--provider-acp-next/host.mjs';
const BB_DAEMON = '/opt/homebrew/bin/node /Users/x/.local/share/bb-service/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs';
const BB_SERVER_PROCESS = '/opt/homebrew/bin/node /Users/x/.local/share/bb-service/node_modules/bb-app/server/dist/index.js';
const BB_SHARED_HOST_WORKER =
  '/opt/homebrew/bin/node /Users/x/.local/share/bb-service/node_modules/bb-app/host-daemon/dist/bb-plugin-host-worker.mjs /Users/x/.bb/plugin-host-artifacts/bb--provider-acp-next/host.mjs bb--provider-acp-next 1afdf18c /Users/x/.bb/plugins/bb--provider-acp-next/host-data /tmp/bb-host';

test("BB's own service processes are BB, whatever their flags say", () => {
  // Regression: the launcher carries `--host-daemon-port`, which the generic
  // daemon pattern matched, so BB's own processes classified as a tool
  // service and merged into one unattributed blob instead of `bb`.
  const kindOf = (command) => classify(command, processName(command));
  assert.equal(kindOf(BB_SERVICE), 'bb');
  assert.equal(kindOf(BB_HOST_WORKER), 'bb');
  assert.equal(kindOf(BB_DAEMON), 'bb');
  // A genuine tool service is still not a build step.
  assert.equal(kindOf('/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.25.0 --ping'), 'other');
});

test('session infrastructure inherits the thread of the agent it hosts', () => {
  const rows = [row(1, 0, BB_SERVICE), row(2, 1, BB_DAEMON), row(3, 2, BB_HOST_WORKER),
    row(4, 3, 'omp acp'), row(5, 4, 'node worker.js')];
  const attributed = attributeThreads(rows, [], new Map([[4, a]]));
  // The bridge worker belongs to the session it hosts; the shared daemon does not.
  assert.deepEqual(attributed.map(r => r.threadId), [null, null, a, a, a]);
});

test('a shared parent of several sessions is charged to none of them', () => {
  const rows = [row(1, 0, BB_SERVICE), row(2, 1, BB_DAEMON),
    row(3, 2, BB_HOST_WORKER), row(4, 3, 'omp acp'),
    row(5, 2, BB_HOST_WORKER), row(6, 5, 'omp acp')];
  const attributed = attributeThreads(rows, [], new Map([[4, a], [6, b]]));
  assert.deepEqual(attributed.map(r => r.threadId), [null, null, a, a, b, b]);
});

test("BB's shared infrastructure is never charged to a thread", () => {
  // The server, the launcher and the plugin host worker serve every thread.
  // With one session live, a looser rule would hand all of BB to it.
  const rows = [row(1, 0, BB_SERVICE), row(2, 1, BB_SHARED_HOST_WORKER), row(3, 2, 'omp acp')];
  const attributed = attributeThreads(rows, [], new Map([[3, a]]));
  assert.deepEqual(attributed.map(r => r.threadId), [null, null, a]);
});

test("BB's own bundler is not attributed to the thread that happens to be live", () => {
  const rows = [row(1, 0, BB_SERVER_PROCESS), row(2, 1, '/repo/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.28.1 --ping')];
  const attributed = attributeThreads(rows, [], new Map());
  assert.deepEqual(attributed.map(r => r.threadId), [null, null]);
});
