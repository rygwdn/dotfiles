import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, symlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureProjectPaths } from '../lib/project-disk.ts';

test('nested checkouts, duplicate roots, hardlinks and symlinks do not double-charge file data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ballast-project-'));
  try {
    const nested = join(root, 'worktree');
    await mkdir(nested);
    const file = join(nested, 'data');
    await writeFile(file, Buffer.alloc(8192, 1));
    await link(file, join(root, 'shared'));
    await symlink(nested, join(root, 'alias'));
    const result = await measureProjectPaths([root, nested, root]);
    const expected = await Promise.all([root, nested, file, join(root, 'alias')].map(async path => (await lstat(path)).blocks * 512));
    assert.equal(result.reduce((sum, row) => sum + row.bytes, 0), expected.reduce((sum, value) => sum + value, 0));
    assert.deepEqual(result.map(row => row.path), [root, nested]);
    assert.ok(result.every(row => row.complete));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('entry budgets and missing checkouts are reported as partial, never complete zeroes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ballast-project-'));
  try {
    await writeFile(join(root, 'data'), Buffer.alloc(4096));
    const [limited] = await measureProjectPaths([root], { maxEntries: 1, maxMs: 5000 });
    assert.equal(limited.complete, false);
    assert.match(limited.notes.join(' '), /limit/);
    const [missing] = await measureProjectPaths([join(root, 'missing')]);
    assert.equal(missing.complete, false);
    assert.match(missing.notes.join(' '), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
