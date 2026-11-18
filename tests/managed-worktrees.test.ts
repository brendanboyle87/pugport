import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath, lstat, symlink, unlink } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from '../src/server/platform/test-process.ts';
import {
  ManagedWorktrees,
  isGitDirectory,
  createDetachedCheckout,
  removeDetachedCheckout,
} from '../src/server/managed-worktrees.ts';
import type { ManagedWorktree } from '../src/shared/managed-worktrees.ts';

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (
    await run(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, windowsHide: true },
    )
  ).stdout.trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-managed-worktrees-')));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep));
    assert.match(root, /pugport-managed-worktrees-/);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  const parent = join(root, 'parent'),
    storage = join(root, 'managed');
  await mkdir(parent);
  await git(parent, 'init');
  await writeFile(join(parent, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n');
  await writeFile(join(parent, 'b.txt'), 'original b\n');
  await writeFile(join(parent, '.gitignore'), 'ignored/\n');
  await git(parent, 'add', '.');
  await git(parent, 'commit', '-m', 'Synthetic baseline');
  const manager = new ManagedWorktrees(storage);
  const prepare = (id = 'child', sourceDirectory = parent) =>
    manager.prepare({ id, projectId: 'project', ownerWorkflowId: id, parentWorkflowId: 'parent', sourceDirectory });
  return { root, parent, storage, manager, prepare };
}

test('detached judge checkout has the requested commit, is clean and is removed', async (t) => {
  const f = await fixture(t);
  const sha = await git(f.parent, 'rev-parse', 'HEAD');
  const checkout = join(f.root, 'judge-checkout');
  await createDetachedCheckout(f.parent, sha, checkout);
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), sha);
  await assert.rejects(git(checkout, 'symbolic-ref', '-q', 'HEAD'));
  assert.equal(await git(checkout, 'status', '--porcelain'), '');
  await removeDetachedCheckout(f.parent, checkout);
  assert.ok(!(await git(f.parent, 'worktree', 'list', '--porcelain')).includes(checkout.replaceAll('\\', '/')));
});

test('branch dependencies are linked from tracked ignored packages and safely released after restart', async (t) => {
  const f = await fixture(t);
  const packages = ['', 'sub2api/frontend', 'missing', 'not-ignored', 'existing'];
  for (const path of packages) {
    await mkdir(join(f.parent, path), { recursive: true });
    await writeFile(join(f.parent, path, 'package.json'), '{}');
  }
  await writeFile(join(f.parent, '.gitignore'), 'node_modules/\n!not-ignored/node_modules/\n!existing/node_modules/\n');
  await mkdir(join(f.parent, 'existing/node_modules'), { recursive: true });
  await writeFile(join(f.parent, 'existing/node_modules/tracked'), 'keep');
  await git(f.parent, 'add', '.');
  await git(f.parent, 'commit', '-m', 'Synthetic packages');
  for (const path of ['', 'sub2api/frontend', 'untracked-package', 'not-ignored']) {
    await mkdir(join(f.parent, path, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(f.parent, path, 'node_modules/pkg/marker'), 'source dependency');
  }
  await writeFile(join(f.parent, 'untracked-package/package.json'), '{}');
  const child = await f.manager.prepare({
    id: 'deps',
    projectId: 'project',
    ownerWorkflowId: 'deps',
    parentWorkflowId: 'parent',
    sourceDirectory: f.parent,
    mode: 'branch',
  });
  assert.deepEqual(child.linkedDependencyPaths, ['node_modules/pkg', 'sub2api/frontend/node_modules/pkg']);
  for (const path of child.linkedDependencyPaths!) {
    assert.equal((await lstat(join(child.directory, path))).isSymbolicLink(), true);
    assert.equal(await realpath(join(child.directory, path)), await realpath(join(f.parent, path)));
  }
  for (const path of ['missing', 'untracked-package', 'not-ignored'])
    await assert.rejects(lstat(join(child.directory, path, 'node_modules')), /ENOENT/);
  assert.equal(await readFile(join(child.directory, 'existing/node_modules/tracked'), 'utf8'), 'keep');
  const restarted = new ManagedWorktrees(f.storage);
  await writeFile(join(f.storage, child.id, 'workspace.json'), JSON.stringify({ ...child, state: 'preparing' }));
  assert.deepEqual((await restarted.recover(child.id)).linkedDependencyPaths, child.linkedDependencyPaths);
  const removed = await restarted.release(child.id, { stillWanted: () => true });
  assert.equal(removed.status, 'removed', JSON.stringify(removed));
  await assert.rejects(lstat(child.directory), /ENOENT/);
  for (const path of child.linkedDependencyPaths!)
    assert.equal(await readFile(join(f.parent, path, 'marker'), 'utf8'), 'source dependency');
});

for (const operation of ['entries', 'root', 'containers', 'install'] as const) {
  test(`lane dependency ${operation} operations preserve source packages`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.parent, 'package.json'), '{}');
    await writeFile(join(f.parent, '.gitignore'), 'node_modules/\n');
    await git(f.parent, 'add', '.');
    await git(f.parent, 'commit', '-m', 'Synthetic dependencies');
    const source = join(f.parent, 'node_modules');
    const packages = ['ordinary', '@scope/pkg', '.pnpm/pkg@1.0.0'];
    for (const path of packages) {
      await mkdir(join(source, path), { recursive: true });
      await writeFile(join(source, path, 'marker'), path);
    }
    await symlink(
      join(source, '.pnpm/pkg@1.0.0'),
      join(source, 'pkg'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(source, '.modules.yaml'), 'source metadata');
    const child = await f.manager.prepare({
      id: 'safe-deps',
      projectId: 'p',
      ownerWorkflowId: 'o',
      parentWorkflowId: 'p',
      sourceDirectory: f.parent,
      mode: 'branch',
    });
    const lane = join(child.directory, 'node_modules');
    if (operation === 'entries') {
      for (const entry of await readdir(lane)) await rm(join(lane, entry), { recursive: true, force: true });
    } else if (operation === 'root') {
      await rm(lane, { recursive: true, force: true });
    } else if (operation === 'containers') {
      for (const container of ['@scope', '.pnpm'])
        for (const entry of await readdir(join(lane, container)))
          await rm(join(lane, container, entry), { recursive: true, force: true });
    } else {
      await mkdir(join(lane, 'new-package'));
      await writeFile(join(lane, 'new-package/marker'), 'lane only');
      await assert.rejects(lstat(join(source, 'new-package')), /ENOENT/);
      assert.equal((await lstat(join(lane, 'new-package'))).isSymbolicLink(), false);
      for (const path of ['', '@scope', '.pnpm']) assert.equal((await lstat(join(lane, path))).isSymbolicLink(), false);
      assert.deepEqual(
        child.linkedDependencyPaths?.sort(),
        [...packages, 'pkg'].map((path) => `node_modules/${path}`).sort(),
      );
      for (const path of [...packages, 'pkg']) {
        assert.equal((await lstat(join(lane, path))).isSymbolicLink(), true);
        assert.equal(await realpath(join(lane, path)), await realpath(join(source, path)));
      }
      await unlink(join(source, 'pkg'));
      await symlink(join(source, 'ordinary'), join(source, 'pkg'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(await realpath(join(lane, 'pkg')), await realpath(join(source, '.pnpm/pkg@1.0.0')));
      assert.equal((await lstat(join(lane, '.modules.yaml'))).isSymbolicLink(), false);
      await writeFile(join(lane, '.modules.yaml'), 'lane metadata');
    }
    for (const path of packages) assert.equal(await readFile(join(source, path, 'marker'), 'utf8'), path);
    assert.equal(await readFile(join(source, '.modules.yaml'), 'utf8'), 'source metadata');
  });
}

for (const phase of ['copy', 'link'] as const) {
  test(`interrupted dependency ${phase} preparation cannot recover as ready`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.parent, 'package.json'), '{}');
    await writeFile(join(f.parent, '.gitignore'), 'node_modules/\n');
    await git(f.parent, 'add', '.');
    await git(f.parent, 'commit', '-m', 'Synthetic dependencies');
    for (const pkg of ['first', 'second']) {
      await mkdir(join(f.parent, 'node_modules', pkg), { recursive: true });
      await writeFile(join(f.parent, 'node_modules', pkg, 'marker'), 'source');
    }
    await writeFile(join(f.parent, 'node_modules/.modules.yaml'), 'metadata');
    const abort = new AbortController();
    const method = phase === 'copy' ? 'writeFile' : 'symlink';
    const original = fsPromises[method];
    const mock = t.mock.method(fsPromises, method, (async (...args: unknown[]) => {
      const result = await Reflect.apply(original, fsPromises, args);
      const path = String(args[phase === 'copy' ? 0 : 1]);
      if (path.startsWith(f.storage) && path.includes('node_modules')) abort.abort(new Error('synthetic interruption'));
      return result;
    }) as typeof original);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        f.manager.prepare(
          {
            id: 'interrupted-deps',
            projectId: 'p',
            ownerWorkflowId: 'o',
            parentWorkflowId: 'p',
            sourceDirectory: f.parent,
            mode: 'branch',
          },
          abort.signal,
        ),
        /synthetic interruption/,
      );
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    const recordPath = join(f.storage, 'interrupted-deps/workspace.json');
    const before = JSON.parse(await readFile(recordPath, 'utf8')) as ManagedWorktree;
    assert.equal(before.dependencyPreparationPath, 'node_modules');
    assert.equal(before.state, 'failed');
    await assert.rejects(new ManagedWorktrees(f.storage).recover(before.id), /Dependency preparation incomplete/);
    assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), before);
    assert.equal(await readFile(join(f.parent, 'node_modules/first/marker'), 'utf8'), 'source');
    assert.equal((await f.manager.release(before.id, { stillWanted: () => true })).status, 'removed');
    assert.equal(await readFile(join(f.parent, 'node_modules/second/marker'), 'utf8'), 'source');
  });
}

test('detached cleanup removes the registration when its checkout is already missing', async (t) => {
  const f = await fixture(t);
  const checkout = join(f.root, 'missing-checkout');
  await createDetachedCheckout(f.parent, await git(f.parent, 'rev-parse', 'HEAD'), checkout);
  await rm(checkout, { recursive: true, force: true });
  await removeDetachedCheckout(f.parent, checkout);
  assert.ok(!(await git(f.parent, 'worktree', 'list', '--porcelain')).includes('missing-checkout'));
});

test('checkout cleanup preserves tracked mode-120000 links before Git removal', async (t) => {
  const f = await fixture(t);
  const checkout = join(f.root, 'tracked-link-checkout');
  await createDetachedCheckout(f.parent, await git(f.parent, 'rev-parse', 'HEAD'), checkout);
  const target = join(f.root, 'tracked-target');
  await mkdir(target);
  await writeFile(join(target, 'marker'), 'keep');
  await mkdir(join(checkout, 'nested'));
  const link = join(checkout, 'nested/tracked');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const oid = await git(checkout, 'hash-object', '-w', 'a.txt');
  await git(checkout, 'update-index', '--add', '--cacheinfo', `120000,${oid},nested/tracked`);
  await symlink(target, join(checkout, 'untracked'), process.platform === 'win32' ? 'junction' : 'dir');
  const original = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', ((...args: Parameters<typeof childProcess.execFile>) => {
    if ((args[1] as string[]).includes('remove')) throw new Error('synthetic stop before Git removal');
    return Reflect.apply(original, childProcess, args);
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(removeDetachedCheckout(f.parent, checkout), /synthetic stop/);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await assert.rejects(lstat(join(checkout, 'untracked')), /ENOENT/);
  assert.equal(await readFile(join(target, 'marker'), 'utf8'), 'keep');
});

test('dependency preparation does not duplicate a shared exclude overridden by the child', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.parent, 'package.json'), '{}');
  await writeFile(join(f.parent, '.gitignore'), '!node_modules\n');
  await git(f.parent, 'add', '.');
  await git(f.parent, 'commit', '-m', 'Synthetic old ignore rules');
  const baseCommit = await git(f.parent, 'rev-parse', 'HEAD');
  await writeFile(join(f.parent, '.gitignore'), 'node_modules/\n');
  await git(f.parent, 'add', '.');
  await git(f.parent, 'commit', '-m', 'Synthetic current ignore rules');
  await mkdir(join(f.parent, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(f.parent, 'node_modules/pkg/marker'), 'keep');
  const exclude = join(f.parent, '.git/info/exclude');
  const rules = '# existing\r\n/node_modules\r\n';
  await writeFile(exclude, rules);
  await f.manager.prepare({
    id: 'exclude',
    projectId: 'p',
    ownerWorkflowId: 'o',
    parentWorkflowId: 'p',
    sourceDirectory: f.parent,
    mode: 'branch',
    baseCommit,
  });
  assert.equal(await readFile(exclude, 'utf8'), rules);
});

test('dependency links remain ignored by native Git even when the selected base lacks source ignore rules', async (t) => {
  const f = await fixture(t);
  const baseCommit = await git(f.parent, 'rev-parse', 'HEAD');
  const packagePath = 'packages/ui[fixture]';
  await mkdir(join(f.parent, packagePath, 'node_modules'), { recursive: true });
  await writeFile(join(f.parent, packagePath, 'package.json'), '{}');
  await writeFile(join(f.parent, packagePath, 'node_modules/marker'), 'keep');
  await writeFile(join(f.parent, '.gitignore'), 'node_modules/\n');
  await git(f.parent, 'add', '.');
  await git(f.parent, 'commit', '-m', 'Synthetic dependencies');
  const excludes = join(f.parent, '.git/info/exclude');
  await writeFile(excludes, '# keep existing rules\nprivate-fixture\n');
  const child = await f.manager.prepare({
    id: 'old-base',
    projectId: 'p',
    ownerWorkflowId: 'o',
    parentWorkflowId: 'p',
    sourceDirectory: f.parent,
    mode: 'branch',
    baseCommit,
  });
  assert.equal(await git(child.directory, 'status', '--porcelain'), '');
  await git(child.directory, 'add', '.');
  assert.equal(await git(child.directory, 'diff', '--cached', '--name-only'), '');
  assert.ok((await readFile(excludes, 'utf8')).startsWith('# keep existing rules\nprivate-fixture\n'));
  const recordPath = join(f.storage, child.id, 'workspace.json');
  await writeFile(recordPath, JSON.stringify({ ...child, linkedDependencyPaths: ['../outside/node_modules'] }));
  await assert.rejects(
    new ManagedWorktrees(f.storage).release(child.id, { stillWanted: () => true }),
    /Unsupported workspace path/,
  );
  assert.equal(await readFile(join(f.parent, packagePath, 'node_modules/marker'), 'utf8'), 'keep');
  await writeFile(recordPath, JSON.stringify(child));
  assert.equal(
    (await new ManagedWorktrees(f.storage).release(child.id, { stillWanted: () => true })).status,
    'removed',
  );
  assert.equal(await readFile(join(f.parent, packagePath, 'node_modules/marker'), 'utf8'), 'keep');
});

test('forced detached removal unlinks nested dependency junctions without traversing their targets', async (t) => {
  const f = await fixture(t);
  const checkout = join(f.root, 'judge-deps');
  await createDetachedCheckout(f.parent, await git(f.parent, 'rev-parse', 'HEAD'), checkout);
  await mkdir(join(f.parent, 'node_modules'));
  await writeFile(join(f.parent, 'node_modules/marker'), 'keep dependency');
  await mkdir(join(checkout, 'nested'));
  await symlink(
    join(f.parent, 'node_modules'),
    join(checkout, 'nested/node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await removeDetachedCheckout(f.parent, checkout);
  await assert.rejects(lstat(checkout), /ENOENT/);
  assert.equal(await readFile(join(f.parent, 'node_modules/marker'), 'utf8'), 'keep dependency');
});

test('detached judge checkout materializes mode-120000 entries as plain files', async (t) => {
  const f = await fixture(t);
  await git(f.parent, 'config', 'core.symlinks', 'true');
  const hashing = run('git', ['hash-object', '-w', '--stdin'], { cwd: f.parent, windowsHide: true });
  hashing.child.stdin!.end('a.txt');
  const oid = (await hashing).stdout.trim();
  await git(f.parent, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`);
  await git(f.parent, 'commit', '-m', 'Synthetic symlink entry');
  const sha = await git(f.parent, 'rev-parse', 'HEAD');
  const checkout = join(f.root, 'judge-link-checkout');
  await createDetachedCheckout(f.parent, sha, checkout);
  assert.equal((await lstat(join(checkout, 'link'))).isFile(), true);
  assert.equal((await lstat(join(checkout, 'link'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(checkout, 'link'), 'utf8'), 'a.txt');
  assert.equal(await git(checkout, '-c', 'core.symlinks=false', 'status', '--porcelain'), '');
  await removeDetachedCheckout(f.parent, checkout);
});

test('dirty tracked, staged, untracked and binary files form one immutable child snapshot without changing parent index', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.parent, 'a.txt'), 'staged version\n');
  await git(f.parent, 'add', 'a.txt');
  await writeFile(join(f.parent, 'a.txt'), 'unstaged version\n');
  await writeFile(join(f.parent, 'new.bin'), Buffer.from([0, 1, 255, 13, 10]));
  await writeFile(join(f.parent, 'empty'), '');
  await mkdir(join(f.parent, 'ignored'));
  await writeFile(join(f.parent, 'ignored', 'private'), 'omitted by ignore rule');
  const index = await readFile(join(f.parent, '.git/index'));
  const head = await git(f.parent, 'rev-parse', 'HEAD');
  const status = await git(f.parent, 'status', '--porcelain=v1');
  const child = await f.prepare();
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'unstaged version\n');
  assert.deepEqual(await readFile(join(child.directory, 'new.bin')), Buffer.from([0, 1, 255, 13, 10]));
  assert.equal((await readFile(join(child.directory, 'empty'))).length, 0);
  await assert.rejects(readFile(join(child.directory, 'ignored/private')), /ENOENT/);
  assert.deepEqual(await readFile(join(f.parent, '.git/index')), index);
  assert.equal(await git(f.parent, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(f.parent, 'status', '--porcelain=v1'), status);
  assert.equal(await git(child.directory, 'status', '--porcelain=v1'), '');
  assert.equal(child.state, 'ready');
  assert.equal((await readdir(join(f.storage, child.id))).filter((name) => name.startsWith('snapshot-')).length, 0);
});

test('concurrent prepare is idempotent across managers and rejects identifier rebinding', async (t) => {
  const f = await fixture(t);
  const input = {
    id: 'stable',
    projectId: 'project',
    ownerWorkflowId: 'owner',
    parentWorkflowId: 'parent',
    sourceDirectory: f.parent,
  };
  const [first, second] = await Promise.all([f.manager.prepare(input), new ManagedWorktrees(f.storage).prepare(input)]);
  assert.equal(first.directory, second.directory);
  assert.equal(first.baseCommit, second.baseCommit);
  assert.equal(first.branch, 'codex/managed-stable');
  await assert.rejects(f.manager.prepare({ ...input, ownerWorkflowId: 'different' }), /different task or parent/);
  await writeFile(join(first.directory, 'a.txt'), 'retained child edit');
  assert.equal((await f.manager.recover(first.id)).state, 'ready');
  assert.equal(await readFile(join(first.directory, 'a.txt'), 'utf8'), 'retained child edit');
});

test('delivery preserves unrelated parent changes and index, supports incremental continuations and never replays accepted edits', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  const index = await readFile(join(f.parent, '.git/index'));
  await writeFile(join(child.directory, 'a.txt'), 'child edit\n');
  await writeFile(join(f.parent, 'b.txt'), 'parent edit\n');
  let delivery = await f.manager.apply(child.id, { parentDirectory: f.parent });
  assert.equal(delivery.status, 'applied', delivery.reason ?? '');
  assert.deepEqual(delivery.changedPaths, ['a.txt']);
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'parent edit\n');
  assert.deepEqual(await readFile(join(f.parent, '.git/index')), index);
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent })).status, 'unchanged');
  await writeFile(join(child.directory, 'a.txt'), 'continued child edit\n');
  delivery = await f.manager.apply(child.id, { parentDirectory: f.parent });
  assert.equal(delivery.status, 'applied', delivery.reason ?? '');
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'continued child edit\n');
  await writeFile(join(f.parent, 'a.txt'), 'later parent edit\n');
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent })).status, 'blocked');
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'later parent edit\n');
});

test('same-file independent edits merge, overlapping edits conflict without applying other files', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  const original = await readFile(join(f.parent, 'a.txt'), 'utf8');
  await writeFile(join(f.parent, 'a.txt'), original.replace('one', 'parent one'));
  await writeFile(join(child.directory, 'a.txt'), original.replace('eight', 'child eight'));
  const applied = await f.manager.apply(child.id, { parentDirectory: f.parent });
  assert.equal(applied.status, 'applied', applied.reason ?? '');
  const combined = await readFile(join(f.parent, 'a.txt'), 'utf8');
  assert.match(combined, /parent one/);
  assert.match(combined, /child eight/);
  await writeFile(join(f.parent, 'a.txt'), combined.replace('child eight', 'parent eight'));
  await writeFile(join(child.directory, 'a.txt'), original.replace('eight', 'second child eight'));
  await writeFile(join(child.directory, 'b.txt'), 'should stay isolated');
  const conflict = await f.manager.apply(child.id, { parentDirectory: f.parent });
  assert.equal(conflict.status, 'conflict', conflict.reason ?? '');
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'original b\n');
  assert.match(await readFile(join(f.parent, 'a.txt'), 'utf8'), /parent eight/);
});

test('nested worktrees deliver only into their direct parent and detached sources remain unchanged', async (t) => {
  const f = await fixture(t);
  await git(f.parent, 'checkout', '--detach');
  const parent = await f.prepare('parent-child');
  await writeFile(join(parent.directory, 'b.txt'), 'parent local baseline');
  const child = await f.prepare('grandchild', parent.directory);
  assert.equal(await readFile(join(child.directory, 'b.txt'), 'utf8'), 'parent local baseline');
  await writeFile(join(child.directory, 'a.txt'), 'nested edit');
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent })).status, 'blocked');
  const applied = await f.manager.apply(child.id, { parentDirectory: parent.directory });
  assert.equal(applied.status, 'applied', applied.reason ?? '');
  assert.equal(await readFile(join(parent.directory, 'a.txt'), 'utf8'), 'nested edit');
  assert.notEqual(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'nested edit');
  await assert.rejects(git(f.parent, 'symbolic-ref', '--quiet', 'HEAD'));
});

test('scope rejection and pre-cancellation preserve both child work and parent files', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  await writeFile(join(child.directory, 'a.txt'), 'allowed edit');
  await writeFile(join(child.directory, 'b.txt'), 'out of scope edit');
  const blocked = await f.manager.apply(child.id, { parentDirectory: f.parent, scope: ['a.txt'] });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason!, /scope/);
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'original b\n');
  assert.notEqual(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'allowed edit');
  const abort = new AbortController();
  abort.abort();
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent }, abort.signal)).status, 'blocked');
  await assert.rejects(
    f.manager.prepare(
      {
        id: 'cancelled',
        projectId: 'project',
        ownerWorkflowId: 'owner',
        parentWorkflowId: 'parent',
        sourceDirectory: f.parent,
      },
      abort.signal,
    ),
  );
  assert.equal(await readFile(join(child.directory, 'b.txt'), 'utf8'), 'out of scope edit');
});

test('interrupted initial materialization recovers missing baseline files but retains conflicting work', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  const recordPath = join(f.storage, child.id, 'workspace.json');
  await writeFile(recordPath, JSON.stringify({ ...child, state: 'preparing' }));
  await unlink(join(child.directory, 'b.txt'));
  assert.equal((await f.manager.recover(child.id)).state, 'ready');
  assert.equal(await readFile(join(child.directory, 'b.txt'), 'utf8'), 'original b\n');
  await writeFile(recordPath, JSON.stringify({ ...child, state: 'preparing' }));
  await writeFile(join(child.directory, 'a.txt'), 'new work after interruption');
  await assert.rejects(f.manager.recover(child.id), /new work/);
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'new work after interruption');
  const baseline = await readFile(join(f.parent, 'a.txt'));
  await git(child.directory, 'add', 'a.txt');
  await writeFile(join(child.directory, 'a.txt'), baseline);
  const childIndex = resolve(child.directory, await git(child.directory, 'rev-parse', '--git-path', 'index'));
  const stagedIndex = await readFile(childIndex);
  await assert.rejects(f.manager.recover(child.id), /staged changes/);
  assert.deepEqual(await readFile(childIndex), stagedIndex);
  assert.equal(await git(child.directory, 'show', ':a.txt'), 'new work after interruption');
});

test('cancellation during durable delivery preparation prevents the first parent mutation', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  await writeFile(join(child.directory, 'b.txt'), 'child pending change');
  const abort = new AbortController();
  // Interrupt exactly after durable preparation, before any parent mutation, without a timing-dependent race.
  const persistence = f.manager as unknown as { save(record: ManagedWorktree): Promise<void> };
  const save = persistence.save.bind(f.manager);
  persistence.save = async (record) => {
    await save(record);
    if (record.delivery?.status === 'applying') abort.abort(new Error('cancelled before first write'));
  };
  const delivery = await f.manager.apply(child.id, { parentDirectory: f.parent }, abort.signal);
  assert.equal(delivery.status, 'recovery-required');
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'original b\n');
  assert.equal(await readFile(join(child.directory, 'b.txt'), 'utf8'), 'child pending change');
  persistence.save = save;
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent })).status, 'applied');
});

test('binary additions and tracked deletions are delivered without staging parent changes', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  await unlink(join(child.directory, 'a.txt'));
  await writeFile(join(child.directory, 'binary'), Buffer.from([0, 255, 127, 10]));
  const result = await f.manager.apply(child.id, { parentDirectory: f.parent });
  assert.equal(result.status, 'applied', result.reason ?? '');
  await assert.rejects(readFile(join(f.parent, 'a.txt')), /ENOENT/);
  assert.deepEqual(await readFile(join(f.parent, 'binary')), Buffer.from([0, 255, 127, 10]));
  assert.equal(await git(f.parent, 'diff', '--cached', '--name-only'), '');
});

test('Git detection distinguishes nonrepositories and rejects subdirectory roots or storage junctions', async (t) => {
  const f = await fixture(t);
  assert.equal(await isGitDirectory(f.parent), true);
  assert.equal(await isGitDirectory(f.root), false);
  const bare = join(f.root, 'bare');
  await git(f.root, 'init', '--bare', bare);
  await assert.rejects(isGitDirectory(bare), /no working tree/);
  await mkdir(join(f.parent, 'subdir'));
  await assert.rejects(f.prepare('subdir', join(f.parent, 'subdir')), /repository root/);
  const linked = join(f.root, 'linked');
  await mkdir(f.storage, { recursive: true });
  await symlink(f.storage, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    new ManagedWorktrees(linked).prepare({
      id: 'escape',
      projectId: 'p',
      ownerWorkflowId: 'c',
      parentWorkflowId: 'r',
      sourceDirectory: f.parent,
    }),
    /Linked path/,
  );
  assert.deepEqual(await readdir(f.storage), ['subdir']);
  await unlink(linked);
});

test('plain folders need no Git executable while repository markers still fail closed when Git is absent', async (t) => {
  const f = await fixture(t);
  const nested = join(f.parent, 'nested');
  await mkdir(nested);
  const bare = join(f.root, 'bare');
  await git(f.root, 'init', '--bare', bare);
  const malformed = join(f.root, 'malformed');
  await mkdir(malformed);
  await writeFile(join(malformed, '.git'), 'not a valid gitdir');
  await assert.rejects(isGitDirectory(malformed), /Cannot inspect Git workspace/);
  const mock = t.mock.method(childProcess, 'execFile', () => {
    throw Object.assign(new Error('Git executable unavailable'), { code: 'ENOENT' });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await isGitDirectory(f.root), false);
    assert.equal(mock.mock.callCount(), 0);
    for (const path of [f.parent, nested, bare, malformed])
      await assert.rejects(isGitDirectory(path), /Git executable unavailable/);
    assert.equal(mock.mock.callCount(), 4);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('interrupted delivery remains explicit, retains foreign parent work, and retries only the saved journal', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  await writeFile(join(child.directory, 'a.txt'), 'delivered a');
  await writeFile(join(child.directory, 'b.txt'), 'delivered b');
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent })).status, 'applied');
  const home = join(f.storage, child.id),
    recordPath = join(home, 'workspace.json'),
    journalPath = join(home, 'delivery.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  // Persist exactly the state of a crash between two writes: one destination applied, one still at baseline.
  await writeFile(
    recordPath,
    JSON.stringify({
      ...child,
      delivery: { status: 'applying', at: new Date().toISOString(), changedPaths: ['a.txt', 'b.txt'] },
    }),
  );
  await writeFile(journalPath, JSON.stringify({ ...journal, state: 'applying' }));
  await writeFile(join(f.parent, 'b.txt'), 'original b\n');
  const restarted = new ManagedWorktrees(f.storage);
  assert.equal((await restarted.recover(child.id)).delivery?.status, 'recovery-required');
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'original b\n');
  await writeFile(join(f.parent, 'b.txt'), 'human edit after crash');
  assert.equal((await restarted.apply(child.id, { parentDirectory: f.parent })).status, 'recovery-required');
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'human edit after crash');
  await writeFile(join(f.parent, 'b.txt'), 'original b\n');
  const recovered = await restarted.apply(child.id, { parentDirectory: f.parent });
  assert.equal(recovered.status, 'applied', recovered.reason ?? '');
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'delivered a');
  assert.equal(await readFile(join(f.parent, 'b.txt'), 'utf8'), 'delivered b');
  assert.equal((await restarted.apply(child.id, { parentDirectory: f.parent })).status, 'unchanged');
});

test('destination junctions and changed repository binding fail closed before any parent write', async (t) => {
  const f = await fixture(t),
    child = await f.prepare();
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await mkdir(join(child.directory, 'output'));
  await writeFile(join(child.directory, 'output/file'), 'child output');
  await symlink(outside, join(f.parent, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
  const blocked = await f.manager.apply(child.id, { parentDirectory: f.parent });
  assert.equal(blocked.status, 'blocked', blocked.reason ?? '');
  assert.deepEqual(await readdir(outside), []);
  await unlink(join(f.parent, 'output'));
  const recordPath = join(f.storage, child.id, 'workspace.json');
  await writeFile(recordPath, JSON.stringify({ ...child, repositoryCommonDirectory: outside }));
  assert.equal((await f.manager.inspect(child.id))?.state, 'recovery-required');
  assert.equal((await f.manager.apply(child.id, { parentDirectory: f.parent })).status, 'blocked');
});

test('repository hooks and filters are never executed while snapshotting or materializing', async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, 'hook-ran').replaceAll('\\', '/');
  await writeFile(join(f.parent, '.git/hooks/post-checkout'), `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o755 });
  await git(f.parent, 'config', 'filter.trap.clean', `sh -c "printf bad > '${marker}'; cat"`);
  await git(f.parent, 'config', 'filter.trap.smudge', `sh -c "printf bad > '${marker}'; cat"`);
  await writeFile(join(f.parent, '.gitattributes'), '*.txt filter=trap\n');
  const child = await f.prepare();
  assert.equal(child.state, 'ready');
  await assert.rejects(readFile(marker), /ENOENT/);
});
