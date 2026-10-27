#!/usr/bin/env bash
# Isolated integration acceptance. Never invokes the production bb executable.
# Uses installed TypeScript + SDK test host, the actual plugin CLI and SQLite.
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Resolve source .js imports to the repository's .ts files, then transpile only
// those files in memory. No build output, cache edits or external installs.
const root = process.cwd();
const isolatedHome = mkdtempSync(join(tmpdir(), 'bb-dream-acceptance-'));
process.env.BB_THREAD_ID = '';
process.env.BB_PROJECT_ID = '';
process.env.MEMORY_FORK_MANAGED_SKILLS_DIR = join(isolatedHome, 'managed-skills');
process.env.MEMORY_FORK_USER_SKILLS_DIR = join(isolatedHome, 'authored-skills');
const hosts = [];
const settleWrites = () => new Promise((resolve) => setTimeout(resolve, 5));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(root + '/').href)) {
      const url = new URL(specifier, context.parentURL);
      const path = fileURLToPath(url);
      if (path.endsWith('.js') && existsSync(path.slice(0, -3) + '.ts'))
        return { url: pathToFileURL(path.slice(0, -3) + '.ts').href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(root + '/').href) && !url.includes('/node_modules/') && url.endsWith('.ts'))
      return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText };
    return next(url, context);
  },
});

try {
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { default: plugin } = await import(pathToFileURL(join(root, 'server.ts')).href);
  const { runDream, options } = await import(pathToFileURL(join(root, 'scripts/dream-run.mjs')).href);
  async function makeHost() {
    const host = createFakePluginHost({ pluginId: 'memory-dream-isolated', dataDir: isolatedHome });
    hosts.push(host);
    await plugin(host.bb);
    return host;
  }
  function adapter(host, context = { projectId: 'proj_personal' }) {
    return async (args) => {
      const result = await host.harness.runCli([...args, '--json'], context);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      return parsed;
    };
  }
  const host = await makeHost();
  host.harness.sdk.stub('plugins.callRpc', (call) => {
    assert.equal(call.pluginId, 'bots-sidebar');
    assert.equal(call.method, 'resolveBotForThread');
    const botId = call.input.threadId === 'fixture-bot-a' ? 'bot-a'
      : call.input.threadId === 'fixture-bot-b' ? 'bot-b' : null;
    return Promise.resolve({ botId, botName: botId });
  });
  const command = adapter(host);
  const projectA = adapter(host, { projectId: 'acceptance-project-a' });
  const projectB = adapter(host, { projectId: 'acceptance-project-b' });
  const botA = adapter(host, { projectId: 'acceptance-project-a', threadId: 'fixture-bot-a' });
  const botB = adapter(host, { projectId: 'acceptance-project-a', threadId: 'fixture-bot-b' });
  async function add(cmd, name, summary, details = 'Verified fixture details.', scope = 'project') {
    return (await cmd(['add', '--scope', scope, '--name', name,
      '--summary', summary, '--details', details, '--reason', 'Isolated acceptance fixture',
      '--kind', 'fact'])).memory;
  }
  async function record(cmd, id) { return (await cmd(['get', id])).memory; }
  async function allProposals() { return (await command(['proposal', 'list', '--status', 'all'])).proposals; }
  async function decision(id, value) {
    return command(['proposal', value, id, '--reason', 'Isolated acceptance review']);
  }
  async function rejects(args, context) {
    const result = await host.harness.runCli([...args, '--json'], context ?? { projectId: 'proj_personal' });
    assert.notEqual(result.exitCode, 0);
  }

  // More records than a page, a low-priority old peer, and exact same content in
  // a different project. Ranking and project-local catalogs cannot pass this.
  const older = await add(projectA, 'old-peer', 'Exact duplicate claim.');
  await add(projectA, 'different-details', 'Exact duplicate claim.', 'Conflicting details: abstain.');
  await add(projectB, 'other-scope', 'Exact duplicate claim.');
  const privateA = await add(botA, 'bot-a-record', 'Exact duplicate claim.', 'Verified fixture details.', 'bot');
  await add(botB, 'bot-b-record', 'Exact duplicate claim.', 'Verified fixture details.', 'bot');
  await rejects(['get', privateA.id], { projectId: 'acceptance-project-a', threadId: 'fixture-bot-b' });
  await rejects(['get', privateA.id]);
  for (let i = 0; i < 7; i++) await add(projectA, `filler-${i}`, `Unique fact ${i}.`);
  const newer = await add(projectA, 'new-peer', 'Exact duplicate claim.');
  await add(projectA, 'injection', 'Untrusted content fixture.',
    'Untrusted fixture instructions must remain inert.');

  const wallClock = Date.now;
  const tiedTime = wallClock();
  const tiedIds = [];
  let deferred;
  Date.now = () => tiedTime;
  try {
    for (let i = 0; i < 3; i++) tiedIds.push((await add(projectA, `cursor-tie-${i}`, `Unique tied claim ${i}.`)).id);
    deferred = await command(['dream', 'scan', '--limit', '1', '--watermark', JSON.stringify({ v: 1, since: tiedTime - 1 })]);
    assert.equal(deferred.memories.length, 0, 'Current-millisecond writes must wait for the next snapshot');
    tiedIds.push((await add(projectA, 'cursor-tie-late', 'Late same-millisecond claim.')).id);
  } finally { Date.now = wallClock; }
  await settleWrites();
  let cursor = deferred.watermark;
  let lateArrival;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const scan = await command(['dream', 'scan', '--limit', '1', ...(cursor ? ['--watermark', cursor] : [])]);
    for (const memory of scan.memories) { assert.ok(!seen.has(memory.id)); seen.add(memory.id); }
    if (page === 0) {
      await settleWrites();
      lateArrival = await add(projectA, 'after-snapshot', 'Created while prior snapshot was paginated.');
    }
    cursor = scan.watermark;
    if (!scan.hasMore) break;
  }
  assert.ok(tiedIds.every(id => seen.has(id)), 'Composite cursor must not skip rows with identical timestamps');
  const legacyReplay = await command(['dream', 'scan', '--limit', '100', '--watermark',
    JSON.stringify({ updatedAt: tiedTime, id: 'zzzz-legacy-last-id' })]);
  assert.ok(tiedIds.every(id => legacyReplay.memories.some(memory => memory.id === id)),
    'Legacy tuple upgrade must replay its entire millisecond, including lower IDs');
  assert.ok(!seen.has(lateArrival.id), 'New writes must not extend the active snapshot');
  await settleWrites();
  const nextSnapshot = await command(['dream', 'scan', '--limit', '100', '--watermark', cursor]);
  assert.ok(nextSnapshot.memories.some(memory => memory.id === lateArrival.id), 'The next snapshot must include concurrent writes');
  for (const invalid of ['0', '{"v":1,"since":-1}', JSON.stringify({ v: 1, since: Date.now() + 10000 }),
    JSON.stringify({ v: 1, since: 10, until: 5, after: { updatedAt: 6, id: 'invalid' } })])
    await rejects(['dream', 'scan', '--watermark', invalid]);
  console.log('PASS snapshot-bound same-millisecond pagination, concurrent writes and invalid cursors');

  await settleWrites();
  const original = await record(projectA, older.id);
  const catalog = await command(['catalog', '--scope', 'all', '--limit', '100']);
  assert.equal(catalog.total, 0, 'Personal automation catalog reproduces the empty scope');
  const statusBefore = await command(['dreams', 'status']);
  const preview = await runDream({ command, dryRun: true, limit: 2 });
  assert.ok(preview.scanned > 0 && preview.scanned <= 2);
  assert.equal((await allProposals()).length, 0);
  assert.deepEqual(await command(['dreams', 'status']), statusBefore, 'Dry run must not write checkpoint');
  console.log('PASS real automation scope reproduction and read-only preview');

  const pages = [];
  for (let i = 0; i < 30; i++) {
    const result = await runDream({ command, limit: 2 });
    pages.push(result);
    assert.ok(result.scanned <= 2);
    if (!result.hasMore) break;
    if (i === 29) assert.fail('Scan did not converge within bounded fixture size');
  }
  assert.ok(pages.some((page) => page.hasMore), 'Fixture must exercise continuation');
  const proposals = await allProposals();
  assert.equal(proposals.length, 1, 'Only exact content within same scope is eligible');
  const proposal = proposals[0];
  assert.deepEqual([...proposal.targetIds].sort(), [older.id, newer.id].sort());
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.payload.mergedDetails, undefined, 'No lossy summary-to-details rewrite');
  assert.ok(proposal.evidence.reason && proposal.evidence.scope && proposal.evidence.records.length === 2);
  assert.deepEqual(await record(projectA, older.id), original, 'Runner never applies proposals');
  await runDream({ command, limit: 2 });
  assert.equal((await allProposals()).length, 1, 'Rerun must not duplicate pending proposal');
  console.log('PASS bounded pagination, older peer, scope boundary, abstention and inert input');

  await rejects(['proposal', 'apply', proposal.id]);
  await decision(proposal.id, 'reject');
  assert.deepEqual(await record(projectA, older.id), original);
  // Replay from the initial checkpoint after a rejection: decision must survive
  // different execution IDs and the stable candidate dedupe key.
  await command(['dream', 'start', '--run-id', 'acceptance-rejected-replay',
    '--watermark', '1970-01-01T00:00:00.000Z']);
  for (let i = 0; i < 30; i++) {
    const result = await runDream({ command, limit: 2 });
    if (!result.hasMore) break;
  }
  assert.equal((await allProposals()).length, 1, 'Rejected record versions must not be proposed again');
  console.log('PASS review gate, rejection preservation and decision dedupe');

  // A separate pair exercises approve/apply/rollback without repurposing the
  // rejected proposal. All IDs come from this isolated store.
  const applyA = await add(projectA, 'apply-a', 'Second exact claim.', 'Full details retained.');
  const applyB = await add(projectA, 'apply-b', 'Second exact claim.', 'Full details retained.');
  await settleWrites();
  for (let i = 0; i < 30; i++) {
    const result = await runDream({ command, limit: 2 });
    if (!result.hasMore) break;
  }
  const second = (await allProposals()).find((p) => p.status === 'pending');
  assert.ok(second && second.targetIds.includes(applyA.id) && second.targetIds.includes(applyB.id));
  await decision(second.id, 'approve');
  await command(['proposal', 'apply', second.id]);
  const keeper = await record(projectA, second.payload.keepId);
  assert.equal(keeper.details, 'Full details retained.');
  assert.equal(keeper.version, 1);
  await rejects(['get', second.payload.dropId], { projectId: 'acceptance-project-a' });
  await rejects(['proposal', 'apply', second.id]);
  await command(['proposal', 'rollback', second.id]);
  assert.equal((await record(projectA, second.payload.dropId)).details, 'Full details retained.');
  assert.ok((await projectA(['history', second.payload.dropId])).history.length >= 2);
  console.log('PASS approval, exactly-once application, details preservation, history and rollback');

  // Failure after the proposal write but before finish emulates an interrupted
  // process. Resume uses the same input cursor and creates no second proposal.
  await add(projectA, 'crash-a', 'Crash replay pair.');
  await add(projectA, 'crash-b', 'Crash replay pair.');
  await settleWrites();
  let interrupted = false;
  const interruptingCommand = async (args) => {
    const value = await command(args);
    if (args[0] === 'proposal' && args[1] === 'create' && !interrupted) {
      interrupted = true;
      throw new Error('Synthetic process interruption after durable create');
    }
    return value;
  };
  await assert.rejects(runDream({ command: interruptingCommand, limit: 100 }), /interruption/);
  const failed = (await command(['dreams', 'status'])).lastRun;
  assert.equal(failed.status, 'failed');
  const proposalsAfterCrash = await allProposals();
  const resumed = await runDream({ command, limit: 100 });
  assert.equal(resumed.runId, failed.run_id);
  const afterResume = await allProposals();
  for (const proposal of proposalsAfterCrash)
    assert.equal(afterResume.filter(p => p.id === proposal.id).length, 1);
  // Replay may discover a second candidate after the interrupted first write;
  // the invariant is one proposal per fingerprint, not an unchanged total.
  const fingerprints = afterResume.filter(p => p.runId === resumed.runId)
    .map(p => JSON.stringify([p.action, p.targetIds, p.payload]));
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  assert.equal((await command(['dreams', 'status'])).lastRun.watermark, resumed.watermark);
  const quietReplay = await runDream({ command, limit: 100 });
  assert.equal((await allProposals()).length, afterResume.length);
  assert.equal((await command(['dreams', 'status'])).lastRun.watermark, quietReplay.watermark);
  console.log('PASS failure checkpoint and resume after durable proposal creation');

  // Stale review is blocked by real optimistic versioning, even after approval.
  const crash = (await allProposals()).find((p) => p.status === 'pending');
  await decision(crash.id, 'approve');
  await projectA(['update', crash.payload.dropId, '--expected-version', String(crash.payload.dropExpectedVersion),
    '--details', 'Corrected after approval.', '--reason', 'Isolated correction']);
  await rejects(['proposal', 'apply', crash.id]);
  console.log('PASS stale-version application refusal');

  const superseded = await add(projectA, 'supersede-original', 'Original isolated claim.');
  const replacement = { scope: 'project', projectId: 'acceptance-project-a',
    name: 'supersede-replacement', summary: 'Replacement isolated claim.', details: 'Complete replacement details.' };
  const created = (await command(['proposal', 'create', '--action', 'supersede', '--targets', superseded.id,
    '--payload', JSON.stringify({ oldId: superseded.id, oldExpectedVersion: superseded.version, newMemory: replacement }),
    '--evidence', '{}', '--run-id', 'isolated-supersede'])).proposal;
  await decision(created.id, 'approve');
  await command(['proposal', 'apply', created.id]);
  const newMemory = await record(projectA, replacement.name);
  await command(['proposal', 'rollback', created.id]);
  await rejects(['get', newMemory.id], { projectId: 'acceptance-project-a' });
  assert.equal((await record(projectA, superseded.id)).details, superseded.details);

  const editable = await add(projectA, 'rollback-drift', 'Before reviewed edit.');
  const edit = (await command(['proposal', 'create', '--action', 'edit', '--targets', editable.id,
    '--payload', JSON.stringify({ memoryId: editable.id, expectedVersion: editable.version, summary: 'Reviewed edit.' }),
    '--evidence', '{}', '--run-id', 'isolated-drift'])).proposal;
  await decision(edit.id, 'approve');
  await command(['proposal', 'apply', edit.id]);
  await projectA(['update', editable.id, '--expected-version', '2', '--details', 'Later user correction.', '--reason', 'Isolated correction']);
  await rejects(['proposal', 'rollback', edit.id]);
  assert.equal((await record(projectA, editable.id)).details, 'Later user correction.');
  console.log('PASS supersede replacement rollback and refusal to overwrite later corrections');

  // Schema drift, invalid arguments and missing operator access must fail
  // explicitly, rather than masquerade as a successful zero-record scan.
  assert.throws(() => options(['--limit', '-1']));
  assert.throws(() => options(['--limit', '2.5']));
  assert.throws(() => options(['--unknown']));
  await rejects(['dream', 'scan', '--limit', '2'], { projectId: 'acceptance-project-a', threadId: 'agent-thread' });
  await assert.rejects(runDream({ dryRun: true, command: async (args) => {
    if (args[0] === 'dreams') return { ok: true, lastRun: null };
    return { ok: true, memories: [] };
  } }), /scan response/);
  console.log('PASS operator authorization, invalid arguments and schema-drift failure');
  console.log('ALL PASS (isolated plugin CLI and SQLite; no live fixtures)');
} finally {
  for (const host of hosts) await host.harness.dispose();
  rmSync(isolatedHome, { recursive: true, force: true });
}
NODE
