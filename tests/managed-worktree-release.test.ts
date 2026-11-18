import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManagedWorktrees } from '../src/server/managed-worktrees.ts';

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  ).trim();
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pugport-release-'));
  const parent = join(root, 'parent');
  mkdirSync(parent);
  git(parent, 'init');
  writeFileSync(join(parent, 'source.txt'), 'synthetic source');
  writeFileSync(join(parent, '.gitignore'), 'ignored/\n');
  git(parent, 'add', '.');
  git(parent, 'commit', '-m', 'baseline');
  const manager = new ManagedWorktrees(join(root, 'managed'));
  const input = {
    id: 'lane',
    projectId: 'project',
    ownerWorkflowId: 'lane',
    parentWorkflowId: 'parent',
    sourceDirectory: parent,
    mode: 'branch' as const,
  };
  const child = await manager.prepare(input);
  return { root, parent, manager, child, input };
}
async function commit(f: Awaited<ReturnType<typeof fixture>>) {
  writeFileSync(join(f.child.directory, 'change.txt'), 'synthetic change');
  git(f.child.directory, 'add', 'change.txt');
  git(f.child.directory, 'commit', '-m', 'lane change');
}

test('merged locked worktree is released and ignored data is reported', async () => {
  const f = await fixture();
  await commit(f);
  git(f.parent, 'merge', '--ff-only', f.child.branch);
  mkdirSync(join(f.child.directory, 'ignored'));
  writeFileSync(join(f.child.directory, 'ignored', 'fixture.txt'), 'ignored');
  const result = await f.manager.release('lane', { stillWanted: () => true });
  assert.equal(result.status, 'removed');
  if (result.status === 'removed') {
    assert.equal(result.branchDeleted, true);
    assert.match(result.note ?? '', /忽略/);
  }
  assert.equal(existsSync(f.child.directory), false);
  assert.equal(git(f.parent, 'branch', '--list', f.child.branch), '');
  assert.equal(await f.manager.inspect('lane'), undefined);
  assert.equal(readFileSync(join(f.parent, 'source.txt'), 'utf8'), 'synthetic source');
});

test('dirty, unmerged and revoked worktrees stay intact', async () => {
  const f = await fixture();
  await commit(f);
  let result = await f.manager.release('lane', { stillWanted: () => true });
  assert.equal(result.status, 'kept');
  if (result.status === 'kept') assert.match(result.reason, /未推送\/未合并/);
  writeFileSync(join(f.child.directory, 'untracked.txt'), 'keep');
  result = await f.manager.release('lane', { stillWanted: () => true });
  assert.equal(result.status, 'kept');
  if (result.status === 'kept') assert.match(result.reason, /未跟踪/);
  git(f.child.directory, 'add', 'untracked.txt');
  git(f.child.directory, 'commit', '-m', 'second');
  git(f.parent, 'merge', '--ff-only', f.child.branch);
  result = await f.manager.release('lane', { stillWanted: () => false });
  assert.equal(result.status, 'kept');
  assert.equal(existsSync(f.child.directory), true);
  assert.equal(readFileSync(join(f.child.directory, 'untracked.txt'), 'utf8'), 'keep');
});

test('snapshot and tampered ownership records are retained', async () => {
  const f = await fixture();
  const file = join(f.root, 'managed', 'lane', 'workspace.json');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  value.mode = 'snapshot';
  writeFileSync(file, JSON.stringify(value));
  assert.equal((await f.manager.release('lane', { stillWanted: () => true })).status, 'kept');
  value.mode = 'branch';
  value.directory = f.parent;
  writeFileSync(file, JSON.stringify(value));
  await assert.rejects(f.manager.release('lane', { stillWanted: () => true }), /ownership record/);
  assert.equal(readFileSync(join(f.parent, 'source.txt'), 'utf8'), 'synthetic source');
});

test('release unlinks top-level and nested junctions without touching their targets', async () => {
  const f = await fixture();
  await commit(f);
  git(f.parent, 'merge', '--ff-only', f.child.branch);
  const target = join(f.root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'sentinel.txt'), 'synthetic sentinel');
  appendFileSync(join(f.parent, '.git', 'info', 'exclude'), '\n/top-link\n/nested/\n');
  mkdirSync(join(f.child.directory, 'nested'));
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(target, join(f.child.directory, 'top-link'), kind);
  symlinkSync(target, join(f.child.directory, 'nested', 'inner-link'), kind);
  const result = await f.manager.release('lane', { stillWanted: () => true });
  assert.equal(result.status, 'removed');
  if (result.status === 'removed') {
    assert.ok(result.unlinked.includes('top-link'));
    assert.ok(result.unlinked.includes(join('nested', 'inner-link')));
  }
  assert.equal(readFileSync(join(target, 'sentinel.txt'), 'utf8'), 'synthetic sentinel');
});

test('a tag with the lane branch name does not count as another branch containing the commit', async () => {
  const f = await fixture();
  await commit(f);
  git(f.parent, 'tag', f.child.branch, 'HEAD');
  const result = await f.manager.release('lane', { stillWanted: () => true });
  assert.equal(result.status, 'kept');
  if (result.status === 'kept') assert.match(result.reason, /未推送\/未合并/);
  assert.equal(existsSync(f.child.directory), true);
  assert.equal(git(f.parent, 'rev-parse', `refs/heads/${f.child.branch}`), git(f.child.directory, 'rev-parse', 'HEAD'));
});

test('a failed remove after Git deregisters the checkout reports detached', async (t) => {
  const f = await fixture();
  await commit(f);
  git(f.parent, 'merge', '--ff-only', f.child.branch);
  const original = childProcess.execFile;
  let intercepted = false;
  const mock = t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
    const argv = args[1] as string[];
    if (argv.includes('worktree') && argv.includes('remove')) {
      const callback = args[3] as (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
      args[3] = (error: Error | null, stdout: Buffer, stderr: Buffer) => {
        if (error) return callback(error, stdout, stderr);
        intercepted = true;
        callback(
          Object.assign(new Error('synthetic post-removal failure'), { code: 1 }),
          stdout,
          Buffer.from('synthetic failure'),
        );
      };
    }
    return Reflect.apply(original, childProcess, args);
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    const result = await f.manager.release('lane', { stillWanted: () => true });
    assert.equal(intercepted, true);
    assert.equal(result.status, 'kept');
    if (result.status === 'kept') {
      assert.equal(result.detached, true);
      assert.match(result.reason, /目录残留请手删/);
    }
    assert.ok(existsSync(join(f.root, 'managed', 'lane', 'workspace.json')));
    assert.equal(git(f.parent, 'rev-parse', `refs/heads/${f.child.branch}`), git(f.parent, 'rev-parse', 'HEAD'));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
