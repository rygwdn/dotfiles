import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpathSync, mkdtempSync, openSync, writeSync, closeSync } from 'node:fs';
import { cpus, totalmem, tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const OVERLOAD_EXIT = 75;
const checkout = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = row => `${row.pid}:${row.start}`;

// ps start times have one-second resolution: revalidation narrows, but cannot
// eliminate, PID reuse between snapshot and kill(2). Never select by command.
export function parseSnapshot(text) {
  const rows = new Map();
  for (const line of text.trim().split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\d+)\s+([\d.]+)\s*$/.exec(line);
    if (!match) throw new Error('Ambiguous process snapshot');
    const [, pid, ppid, start, rss, cpu] = match;
    const row = { pid: Number(pid), ppid: Number(ppid), start: start.replace(/\s+/g, ' '), rss: Number(rss) * 1024, cpu: Number(cpu) };
    if (rows.has(row.pid) || row.pid <= 0 || !Number.isFinite(row.cpu)) throw new Error('Ambiguous process identity');
    rows.set(row.pid, row);
  }
  return rows;
}
export async function snapshot() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,lstart=,rss=,pcpu='], { timeout: 1500, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return parseSnapshot(stdout);
}

export class RunTree {
  constructor(rootPid, baseline, { cpuCount = cpus().length, memory = totalmem() } = {}) {
    this.rootPid = rootPid;
    this.baseline = new Set([...baseline.values()].map(identity));
    this.owned = new Map();
    this.processMax = Math.max(32, 4 * cpuCount);
    this.cpuCount = cpuCount;
    this.memory = memory;
    this.since = {};
  }
  observe(rows, now) {
    const root = rows.get(this.rootPid);
    if (!this.owned.size && root && !this.baseline.has(identity(root))) this.owned.set(root.pid, root);
    const live = new Map();
    // Existing identities must retain their parent as well as start time.
    for (const [pid, old] of this.owned) {
      const row = rows.get(pid);
      if (row && identity(row) === identity(old) && row.ppid === old.ppid) live.set(pid, row);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        if (!live.has(row.pid) && live.has(row.ppid) && !this.baseline.has(identity(row)) && !this.owned.has(row.pid)) {
          live.set(row.pid, row);
          this.owned.set(row.pid, row);
          changed = true;
        }
      }
    }
    const rss = [...live.values()].reduce((sum, row) => sum + row.rss, 0);
    const cpu = [...live.values()].reduce((sum, row) => sum + row.cpu, 0);
    const over = { processes: live.size > this.processMax, rss: rss > this.memory * .25 };
    for (const key of Object.keys(over)) {
      if (!over[key]) delete this.since[key];
      else this.since[key] ??= now;
    }
    return { count: live.size, rss, cpu, warnRss: rss > this.memory * .15, warnCpu: cpu > 100 * this.cpuCount, abort: Object.keys(over).filter(key => over[key] && now - this.since[key] >= 10_000) };
  }
  targets(rows) {
    return [...this.owned.values()].filter(old => {
      const row = rows.get(old.pid);
      return row && identity(row) === identity(old) && row.ppid === old.ppid && !this.baseline.has(identity(row));
    }).sort((a, b) => (a.pid === this.rootPid ? -1 : b.pid === this.rootPid ? 1 : 0));
  }
}

// A fresh full snapshot immediately precedes EACH signal. No process groups.
export async function signalOwned(tree, signal, takeSnapshot, send, rootOnly = false) {
  const candidates = tree.targets(await takeSnapshot());
  for (const candidate of candidates) {
    if (rootOnly && candidate.pid !== tree.rootPid) continue;
    const fresh = tree.targets(await takeSnapshot()).find(row => row.pid === candidate.pid && identity(row) === identity(candidate));
    if (!fresh) continue;
    try { send(fresh.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function resolveVitest(checkoutRoot = checkout) {
  const require = createRequire(join(checkoutRoot, 'package.json'));
  const manifest = realpathSync(require.resolve('vitest/package.json'));
  const entry = realpathSync(join(dirname(manifest), 'vitest.mjs'));
  const local = relative(checkoutRoot, entry);
  if (local.startsWith('..') || isAbsolute(local)) throw new Error('Vitest must resolve inside this checkout; install local dependencies');
  return entry;
}

export async function main(args = process.argv.slice(2)) {
  const entry = resolveVitest();
  const baseline = await snapshot();
  const logDir = mkdtempSync(join(tmpdir(), 'vitest-supervisor-'));
  const fd = openSync(join(logDir, 'samples.jsonl'), 'wx', 0o600);
  let bytes = 0;
  const log = value => {
    const line = JSON.stringify(value) + '\n';
    if (bytes + Buffer.byteLength(line) <= 1024 * 1024) { writeSync(fd, line); bytes += Buffer.byteLength(line); }
  };
  console.error(`Vitest supervisor log: ${join(logDir, 'samples.jsonl')}`);
  const child = spawn(process.execPath, [entry, 'run', '--config', join(checkout, 'vitest.config.ts'), ...args], { cwd: checkout, stdio: 'inherit', shell: false });
  let exited = false;
  const completion = new Promise(resolve => {
    child.once('exit', (code, signal) => { exited = true; resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
    child.once('error', error => { exited = true; console.error(error.message); resolve(1); });
  });
  const tree = new RunTree(child.pid, baseline);
  let stopping = false;
  let result;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!exited) {
      const sample = tree.observe(await snapshot(), performance.now());
      log(sample);
      if (sample.warnRss || sample.warnCpu) console.error('Vitest supervisor warning:', JSON.stringify(sample));
      if (sample.abort.length || stopping) {
        result = sample.abort.length ? OVERLOAD_EXIT : 130;
        log({ stopping: result, reasons: sample.abort });
        await signalOwned(tree, 'SIGTERM', snapshot, process.kill, true);
        await signalOwned(tree, 'SIGTERM', snapshot, process.kill);
        await sleep(1000);
        await signalOwned(tree, 'SIGKILL', snapshot, process.kill);
        break;
      }
      await Promise.race([sleep(2000), completion]);
    }
    return result ?? await completion;
  } catch (error) {
    // Missing/ambiguous observations prohibit signals, rather than broadening scope.
    console.error('Supervisor stopped monitoring without signalling:', error.message);
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    closeSync(fd);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
