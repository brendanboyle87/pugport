import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { LaneWorkspaceValidationError } from '../src/server/managed-worktrees.ts';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ManagedWorktrees } from '../src/server/managed-worktrees.ts';
import type { ManagedWorktree, PrepareManagedWorktree } from '../src/shared/managed-worktrees.ts';

const git = (cwd: string, args: string[], input?: string | Buffer): Promise<string> =>
  new Promise((done, reject) => {
    const child = execFile(
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
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}: ${stderr}`));
        else done(stdout.trim());
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-branch-workspaces-')));
  t.after(async () => {
    assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.match(root, /pugport-branch-workspaces-/);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const parent = join(root, 'parent'),
    storage = join(root, 'managed');
  await mkdir(parent);
  await git(parent, ['init']);
  await writeFile(join(parent, 'a.txt'), 'committed baseline\n');
  await git(parent, ['add', '.']);
  await git(parent, ['commit', '-m', 'Synthetic baseline']);
  const base = await git(parent, ['rev-parse', 'HEAD']);
  const manager = new ManagedWorktrees(storage);
  const input: PrepareManagedWorktree = {
    id: 'child',
    projectId: 'project',
    ownerWorkflowId: 'child',
    parentWorkflowId: 'parent',
    sourceDirectory: parent,
    mode: 'branch',
  };
  return { root, parent, storage, base, manager, input };
}

async function configureCommitIdentity(parent: string) {
  await git(parent, ['config', 'user.name', 'Branch Fixture Author']);
  await git(parent, ['config', 'user.email', 'branch-author@example.invalid']);
}

test('host branch commit uses configured identity, preserves unrelated staged work and parent state, and is idempotent', async (t) => {
  const f = await fixture(t);
  await configureCommitIdentity(f.parent);
  await writeFile(join(f.parent, 'a.txt'), 'parent staged work');
  await git(f.parent, ['add', 'a.txt']);
  const parentIndex = await readFile(join(f.parent, '.git/index'));
  const child = await f.manager.prepare(f.input);
  await writeFile(join(child.directory, 'a.txt'), 'child working change');
  await writeFile(join(child.directory, 'new.txt'), 'new child file');
  await writeFile(join(child.directory, 'other.txt'), 'unrelated staged version');
  await git(child.directory, ['add', 'other.txt']);
  await writeFile(join(child.directory, 'other.txt'), 'unrelated newer working version');
  const options = {
    message: '--message is literal\n\n$(not executed)',
    paths: ['a.txt', 'new.txt'],
    scope: ['a.txt', 'new.txt'],
  };
  const result = await f.manager.commitBranch(child.id, options);
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.changedPaths, ['a.txt', 'new.txt']);
  assert.equal(
    await git(child.directory, ['show', '-s', '--format=%an <%ae>', 'HEAD']),
    'Branch Fixture Author <branch-author@example.invalid>',
  );
  assert.equal(await git(child.directory, ['show', '-s', '--format=%B', 'HEAD']), options.message);
  assert.equal(await git(child.directory, ['show', 'HEAD:a.txt']), 'child working change');
  await assert.rejects(git(child.directory, ['show', 'HEAD:other.txt']));
  assert.equal(await git(child.directory, ['show', ':other.txt']), 'unrelated staged version');
  assert.equal(await readFile(join(child.directory, 'other.txt'), 'utf8'), 'unrelated newer working version');
  assert.equal(await git(f.parent, ['rev-parse', 'HEAD']), f.base);
  assert.deepEqual(await readFile(join(f.parent, '.git/index')), parentIndex);
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'parent staged work');
  assert.deepEqual(await f.manager.commitBranch(child.id, options), {
    ...result,
    status: 'unchanged',
    changedPaths: [],
  });
  const remainder = await f.manager.commitBranch(child.id, { message: 'Remaining working change' });
  assert.deepEqual(remainder.changedPaths, ['other.txt']);
  assert.equal(await git(child.directory, ['show', 'HEAD:other.txt']), 'unrelated newer working version');
  assert.equal(await git(child.directory, ['status', '--porcelain=v1']), '');
});

test('host branch commit rejects scope escapes, missing identity, active Git operations and cancellation without losing changes', async (t) => {
  const f = await fixture(t),
    child = await f.manager.prepare(f.input);
  await writeFile(join(child.directory, 'a.txt'), 'retained work');
  const index = await readFile(join(child.gitDirectory!, 'index'));
  for (const paths of [['../outside'], ['.git/config'], [':(glob)*'], ['C:/outside'], ['a.txt\0'], []])
    await assert.rejects(f.manager.commitBranch(child.id, { message: 'bad paths', paths }));
  await assert.rejects(
    f.manager.commitBranch(child.id, { message: 'scope', scope: ['other.txt'] }),
    /inherited file scope/,
  );
  await git(f.parent, ['config', 'user.name', '']);
  await git(f.parent, ['config', 'user.email', '']);
  await assert.rejects(f.manager.commitBranch(child.id, { message: 'No identity' }), /user.name and user.email/);
  await configureCommitIdentity(f.parent);
  await writeFile(join(child.gitDirectory!, 'MERGE_HEAD'), f.base);
  await assert.rejects(f.manager.commitBranch(child.id, { message: 'Merge pending' }), /existing Git operation/);
  await unlink(join(child.gitDirectory!, 'MERGE_HEAD'));
  await writeFile(join(child.gitDirectory!, 'index.lock'), 'another writer');
  await assert.rejects(f.manager.commitBranch(child.id, { message: 'Busy' }), /EEXIST/);
  assert.equal(await readFile(join(child.gitDirectory!, 'index.lock'), 'utf8'), 'another writer');
  await unlink(join(child.gitDirectory!, 'index.lock'));
  await assert.rejects(f.manager.commitBranch(child.id, { message: 'Cancelled' }, AbortSignal.abort()));
  assert.equal(await git(child.directory, ['rev-parse', 'HEAD']), f.base);
  assert.deepEqual(await readFile(join(child.gitDirectory!, 'index')), index);
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'retained work');
  await git(child.directory, ['checkout', '--detach']);
  await assert.rejects(f.manager.commitBranch(child.id, { message: 'Detached' }));
  const snapshot = await f.manager.prepare({ ...f.input, id: 'snapshot', mode: 'snapshot' });
  await assert.rejects(f.manager.commitBranch(snapshot.id, { message: 'Wrong mode' }), /Only an owned branch/);
});

test('host branch commit never executes hooks or filters and treats wildcard-like file names literally', async (t) => {
  const f = await fixture(t);
  await configureCommitIdentity(f.parent);
  await writeFile(join(f.parent, '.gitattributes'), '*.txt filter=trap\n');
  await git(f.parent, ['add', '.gitattributes']);
  await git(f.parent, ['commit', '-m', 'Attributes']);
  const child = await f.manager.prepare(f.input);
  const marker = join(f.root, 'executed').replaceAll('\\', '/');
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction'])
    await writeFile(join(f.parent, '.git/hooks', hook), `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o755 });
  for (const kind of ['clean', 'smudge', 'process'])
    await git(f.parent, ['config', `filter.trap.${kind}`, `sh -c "printf bad > '${marker}'; cat"`]);
  await git(f.parent, ['config', 'filter.trap.required', 'true']);
  await writeFile(join(child.directory, '[a].txt'), 'literal file');
  await writeFile(join(child.directory, 'a.txt'), 'must remain uncommitted');
  const result = await f.manager.commitBranch(child.id, { message: 'Literal file', paths: ['[a].txt'] });
  assert.deepEqual(result.changedPaths, ['[a].txt']);
  assert.equal(await git(child.directory, ['show', 'HEAD:[a].txt']), 'literal file');
  assert.equal(await git(child.directory, ['show', 'HEAD:a.txt']), 'committed baseline');
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('host branch commit refuses a concurrent ref change and preserves the index and working files', async (t) => {
  const f = await fixture(t);
  await configureCommitIdentity(f.parent);
  const child = await f.manager.prepare(f.input);
  await writeFile(join(child.directory, 'a.txt'), 'local work');
  const index = await readFile(join(child.gitDirectory!, 'index'));
  const other = await git(child.directory, ['commit-tree', child.baseTree!, '-p', f.base, '-m', 'Concurrent commit']);
  const internal = f.manager as unknown as { verify(record: ManagedWorktree, signal?: AbortSignal): Promise<unknown> };
  const verify = internal.verify.bind(f.manager);
  let checks = 0;
  internal.verify = async (...args) => {
    const result = await verify(...args);
    if (++checks === 3) await git(child.directory, ['update-ref', `refs/heads/${child.branch}`, other, f.base]);
    return result;
  };
  await assert.rejects(f.manager.commitBranch(child.id, { message: 'Losing race' }), /update-ref failed/);
  internal.verify = verify;
  assert.equal(await git(child.directory, ['rev-parse', 'HEAD']), other);
  assert.deepEqual(await readFile(join(child.gitDirectory!, 'index')), index);
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'local work');
  assert.equal(await git(f.parent, ['rev-parse', 'HEAD']), f.base);
});

test('host branch commit cannot follow a raced symbolic child ref into the parent branch', async (t) => {
  const f = await fixture(t);
  await configureCommitIdentity(f.parent);
  const parentRef = await git(f.parent, ['symbolic-ref', 'HEAD']);
  const parentIndex = await readFile(join(f.parent, '.git/index'));
  const child = await f.manager.prepare(f.input);
  await writeFile(join(child.directory, 'a.txt'), 'child change must never move parent ref');
  const internal = f.manager as unknown as { verify(record: ManagedWorktree, signal?: AbortSignal): Promise<unknown> };
  const verify = internal.verify.bind(f.manager);
  let checks = 0;
  internal.verify = async (...args) => {
    const value = await verify(...args);
    if (++checks === 3) await git(child.directory, ['symbolic-ref', `refs/heads/${child.branch}`, parentRef]);
    return value;
  };
  const result = await f.manager.commitBranch(child.id, { message: 'Bounded ref update' }).catch(() => undefined);
  internal.verify = verify;
  assert.equal(checks, 3, 'the ref changes only after the final ownership check');
  assert.equal(await git(f.parent, ['rev-parse', parentRef]), f.base);
  assert.deepEqual(await readFile(join(f.parent, '.git/index')), parentIndex);
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'committed baseline\n');
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'child change must never move parent ref');
  if (result) {
    assert.equal(result.status, 'committed');
    assert.equal(await git(child.directory, ['rev-parse', `refs/heads/${child.branch}`]), result.commit);
    await assert.rejects(git(child.directory, ['symbolic-ref', `refs/heads/${child.branch}`]));
  }
});

test('branch mode uses the selected committed baseline and never snapshots or delivers dirty parent files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.parent, 'a.txt'), 'second committed version\n');
  await git(f.parent, ['add', '.']);
  await git(f.parent, ['commit', '-m', 'Second baseline']);
  await writeFile(join(f.parent, 'a.txt'), 'staged parent work\n');
  await git(f.parent, ['add', '.']);
  await writeFile(join(f.parent, 'a.txt'), 'unstaged parent work\n');
  await writeFile(join(f.parent, 'private.txt'), 'untracked parent work');
  const index = await readFile(join(f.parent, '.git/index'));
  const head = await git(f.parent, ['rev-parse', 'HEAD']);
  const branch = await f.manager.prepare({ ...f.input, baseCommit: f.base, branch: 'codex/feature-test' });
  assert.equal(branch.baseCommit, f.base);
  assert.equal(await readFile(join(branch.directory, 'a.txt'), 'utf8'), 'committed baseline\n');
  await assert.rejects(readFile(join(branch.directory, 'private.txt')), /ENOENT/);
  assert.equal(await git(branch.directory, ['status', '--porcelain=v1']), '');
  assert.equal(await git(branch.directory, ['branch', '--show-current']), 'codex/feature-test');
  assert.equal(
    (await readdir(join(f.storage, branch.id))).some((name) => name.startsWith('snapshot')),
    false,
  );
  await writeFile(join(branch.directory, 'a.txt'), 'independent child work');
  await assert.rejects(f.manager.apply(branch.id, { parentDirectory: f.parent }), /do not deliver/);
  assert.equal((await f.manager.inspect(branch.id))?.delivery, undefined);
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'unstaged parent work\n');
  assert.deepEqual(await readFile(join(f.parent, '.git/index')), index);
  assert.equal(await git(f.parent, ['rev-parse', 'HEAD']), head);
  const current = await f.manager.prepare({ ...f.input, id: 'current', ownerWorkflowId: 'current' });
  assert.equal(current.baseCommit, head);
  assert.equal(await readFile(join(current.directory, 'a.txt'), 'utf8'), 'second committed version\n');
});

test('branch metadata grants only its own Git administration and ref paths; recovery retains commits and dirty work', async (t) => {
  const f = await fixture(t);
  const child = await f.manager.prepare(f.input);
  const common = await realpath(join(f.parent, '.git'));
  assert.ok(child.gitDirectory!.startsWith(join(common, 'worktrees') + sep));
  assert.deepEqual(child.gitWritePaths, [
    child.gitDirectory,
    join(common, 'objects'),
    join(common, 'refs/heads/codex/managed-child'),
    join(common, 'refs/heads/codex/managed-child.lock'),
    join(common, 'logs/refs/heads/codex/managed-child'),
    join(common, 'logs/refs/heads/codex/managed-child.lock'),
  ]);
  assert.ok(!child.gitWritePaths?.includes(common));
  assert.ok(!child.gitWritePaths?.includes(f.parent));
  await writeFile(join(child.directory, 'a.txt'), 'child commit');
  await git(child.directory, ['add', '.']);
  await git(child.directory, ['commit', '-m', 'Independent commit']);
  const committed = await git(child.directory, ['rev-parse', 'HEAD']);
  await writeFile(join(child.directory, 'a.txt'), 'uncommitted continuation');
  const restarted = new ManagedWorktrees(f.storage);
  assert.equal((await restarted.recover(child.id)).state, 'ready');
  assert.equal(await git(child.directory, ['rev-parse', 'HEAD']), committed);
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'uncommitted continuation');
  const nested = await restarted.prepare({
    ...f.input,
    id: 'nested',
    ownerWorkflowId: 'nested',
    parentWorkflowId: 'child',
    sourceDirectory: child.directory,
  });
  assert.equal(nested.baseCommit, committed);
  assert.equal(await readFile(join(nested.directory, 'a.txt'), 'utf8'), 'child commit');
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'committed baseline\n');
  await git(child.directory, ['checkout', '--detach']);
  assert.equal((await restarted.inspect(child.id))?.state, 'recovery-required');
  await assert.rejects(restarted.recover(child.id));
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'uncommitted continuation');
});

test('branch preparation rejects injected revisions, existing refs and identifier rebinding without changing their work', async (t) => {
  const f = await fixture(t);
  for (const baseCommit of ['HEAD', '--help', `${f.base};whoami`, 'a'.repeat(40)])
    await assert.rejects(f.manager.prepare({ ...f.input, baseCommit }));
  for (const branch of [
    '--force',
    'codex/x;whoami',
    'codex/../other',
    'refs/x.lock',
    'HEAD',
    'codex//x',
    'codex/x@{1}',
  ])
    await assert.rejects(f.manager.prepare({ ...f.input, branch }));
  await git(f.parent, ['branch', 'codex/existing']);
  await assert.rejects(f.manager.prepare({ ...f.input, id: 'collision', branch: 'codex/existing' }), /already exists/);
  assert.equal(await git(f.parent, ['rev-parse', 'codex/existing']), f.base);
  await assert.rejects(readFile(join(f.storage, 'collision/checkout/a.txt')), /ENOENT/);
  const child = await f.manager.prepare({ ...f.input, id: 'valid' });
  await assert.rejects(f.manager.prepare({ ...f.input, id: 'valid', mode: 'snapshot' }), /different task or parent/);
  await assert.rejects(
    f.manager.prepare({ ...f.input, id: 'valid', ownerWorkflowId: 'foreign' }),
    /different task or parent/,
  );
  assert.equal((await f.manager.inspect(child.id))?.state, 'ready');
  assert.equal(await git(f.parent, ['status', '--porcelain=v1']), '');
});

test('branch preparation rejects a checked-out branch even if its ref was removed', async (t) => {
  const f = await fixture(t);
  const branch = 'alice/occupied';
  const other = join(f.root, 'other');
  await git(f.parent, ['worktree', 'add', '-b', branch, other, f.base]);
  await writeFile(join(other, 'retained.txt'), 'existing work');
  await git(f.parent, ['update-ref', '-d', `refs/heads/${branch}`]);
  const before = await git(f.parent, ['worktree', 'list', '--porcelain']);
  await assert.rejects(f.manager.prepare({ ...f.input, branch }), /checked out/);
  assert.equal(await git(f.parent, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]), '');
  assert.equal(await git(f.parent, ['worktree', 'list', '--porcelain']), before);
  assert.equal(await readFile(join(other, 'retained.txt'), 'utf8'), 'existing work');
  await assert.rejects(readFile(join(f.storage, f.input.id, 'checkout', 'a.txt')), /ENOENT/);
});

test('branch preparation does not run repository hooks or clean/smudge filters', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.parent, '.gitattributes'), '*.txt filter=trap\n');
  await git(f.parent, ['add', '.gitattributes']);
  await git(f.parent, ['commit', '-m', 'Synthetic attributes']);
  const marker = join(f.root, 'executed').replaceAll('\\', '/');
  await writeFile(join(f.parent, '.git/hooks/post-checkout'), `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o755 });
  for (const kind of ['clean', 'smudge'])
    await git(f.parent, ['config', `filter.trap.${kind}`, `sh -c "printf bad > '${marker}'; cat"`]);
  await git(f.parent, ['config', 'filter.trap.required', 'true']);
  const child = await f.manager.prepare(f.input);
  assert.equal(await readFile(join(child.directory, 'a.txt'), 'utf8'), 'committed baseline\n');
  await assert.rejects(readFile(marker), /ENOENT/);
  await writeFile(join(f.storage, child.id, 'workspace.json'), JSON.stringify({ ...child, state: 'preparing' }));
  assert.equal((await f.manager.recover(child.id)).state, 'ready');
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('interrupted branch preparation recovers a clean checkout but never overwrites staged or untracked work', async (t) => {
  const f = await fixture(t),
    child = await f.manager.prepare(f.input);
  const record = join(f.storage, child.id, 'workspace.json');
  await writeFile(record, JSON.stringify({ ...child, state: 'preparing' }));
  assert.equal((await f.manager.recover(child.id)).state, 'ready');
  await writeFile(record, JSON.stringify({ ...child, state: 'preparing' }));
  await writeFile(join(child.directory, 'a.txt'), 'staged work');
  await git(child.directory, ['add', '.']);
  await writeFile(join(child.directory, 'new.txt'), 'untracked work');
  const index = await readFile(join(child.gitDirectory!, 'index'));
  await assert.rejects(f.manager.recover(child.id), /retained for inspection/);
  assert.deepEqual(await readFile(join(child.gitDirectory!, 'index')), index);
  assert.equal(await readFile(join(child.directory, 'new.txt'), 'utf8'), 'untracked work');
  assert.equal(await git(child.directory, ['show', ':a.txt']), 'staged work');
});

test('cancelled branch creation and relocated Git metadata remain retained and cannot grant foreign paths', async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  const persistence = f.manager as unknown as { save(record: ManagedWorktree): Promise<void> };
  const save = persistence.save.bind(f.manager);
  persistence.save = async (record) => {
    await save(record);
    if (record.baseTree) abort.abort();
  };
  await assert.rejects(f.manager.prepare(f.input, abort.signal));
  persistence.save = save;
  const child = await f.manager.recover(f.input.id);
  assert.equal(child.state, 'ready');
  const record = join(f.storage, child.id, 'workspace.json');
  await writeFile(record, JSON.stringify({ ...child, gitDirectory: join(f.root, 'foreign') }));
  assert.equal((await f.manager.inspect(child.id))?.state, 'recovery-required');
  await assert.rejects(f.manager.recover(child.id), /paths changed/);
  assert.equal(await readFile(join(f.parent, 'a.txt'), 'utf8'), 'committed baseline\n');
});

test('branch checkout preserves a tracked symbolic link instead of materializing its text', async (t) => {
  const f = await fixture(t);
  const link = join(f.parent, 'link.txt');
  try {
    await symlink('a.txt', link, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('OS does not permit creating file symlinks.');
    throw error;
  }
  await git(f.parent, ['config', 'core.symlinks', 'true']);
  await git(f.parent, ['add', 'link.txt']);
  await git(f.parent, ['commit', '-m', 'Tracked symlink']);
  const child = await f.manager.prepare(f.input);
  assert.equal(child.symlinkMode, 'native');
  assert.equal((await lstat(join(child.directory, 'link.txt'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(child.directory, 'link.txt')), 'a.txt');
  assert.equal(await readFile(join(child.directory, 'link.txt'), 'utf8'), 'committed baseline\n');
  await configureCommitIdentity(f.parent);
  await unlink(join(child.directory, 'link.txt'));
  await symlink('another-target.txt', join(child.directory, 'link.txt'), 'file');
  const committed = await f.manager.commitBranch(child.id, { message: 'Update tracked symlink', paths: ['link.txt'] });
  assert.deepEqual(committed.changedPaths, ['link.txt']);
  assert.match(await git(child.directory, ['ls-tree', 'HEAD', 'link.txt']), /^120000 blob /);
  assert.equal(await git(child.directory, ['show', 'HEAD:link.txt']), 'another-target.txt');
  await assert.rejects(
    f.manager.prepare({ ...f.input, id: 'snapshot', mode: 'snapshot' }),
    /symbolic links|Symbolic links/,
  );
});

test('Git placeholder mode checks out tracked symlinks without OS privileges and host commits preserve mode 120000', async (t) => {
  const f = await fixture(t);
  await configureCommitIdentity(f.parent);
  await git(f.parent, ['config', 'core.symlinks', 'false']);
  const link = await git(f.parent, ['hash-object', '-w', '--stdin'], 'a.txt');
  await git(f.parent, ['update-index', '--add', '--cacheinfo', '120000', link, 'link.txt']);
  await git(f.parent, ['commit', '-m', 'Synthetic tracked link without an OS symlink']);
  const parentHead = await git(f.parent, ['rev-parse', 'HEAD']);
  const parentIndex = await readFile(join(f.parent, '.git/index'));
  const child = await f.manager.prepare(f.input);
  assert.equal(child.symlinkMode, 'git-placeholder');
  assert.equal((await lstat(join(child.directory, 'link.txt'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(child.directory, 'link.txt'), 'utf8'), 'a.txt');
  assert.match(await git(child.directory, ['ls-files', '--stage', 'link.txt']), /^120000 /);
  await writeFile(join(child.directory, 'link.txt'), 'another-target.txt');
  const commit = await f.manager.commitBranch(child.id, {
    message: 'Update symbolic link target',
    paths: ['link.txt'],
  });
  assert.equal(commit.status, 'committed');
  assert.match(await git(child.directory, ['ls-tree', 'HEAD', 'link.txt']), /^120000 blob /);
  assert.equal(await git(child.directory, ['show', 'HEAD:link.txt']), 'another-target.txt');
  assert.equal((await new ManagedWorktrees(f.storage).recover(child.id)).symlinkMode, 'git-placeholder');
  assert.equal(await git(f.parent, ['rev-parse', 'HEAD']), parentHead);
  assert.deepEqual(await readFile(join(f.parent, '.git/index')), parentIndex);
  assert.equal(await git(f.parent, ['config', '--get', 'core.symlinks']), 'false');
});

test(
  'branch checkout supports committed repositories beyond snapshot file-count and byte limits',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    const small = await git(f.parent, ['hash-object', '-w', '--stdin'], 'small\n');
    const largePath = join(f.root, 'large-blob');
    await writeFile(largePath, Buffer.alloc(129 * 1024 * 1024, 65));
    const large = await git(f.parent, ['hash-object', '-w', '--no-filters', largePath]);
    await unlink(largePath);
    const lines = Array.from({ length: 20001 }, (_, i) => `100644 blob ${small}\tf${String(i).padStart(5, '0')}\n`);
    lines.push(`100644 blob ${large}\tlarge.bin\n`);
    const tree = await git(f.parent, ['mktree'], lines.join(''));
    const commit = await git(f.parent, ['commit-tree', tree, '-p', f.base, '-m', 'Synthetic large committed tree']);
    const child = await f.manager.prepare({ ...f.input, baseCommit: commit });
    assert.equal(child.state, 'ready');
    assert.equal((await readdir(child.directory)).length, 20003);
    assert.equal((await lstat(join(child.directory, 'large.bin'))).size, 129 * 1024 * 1024);
    assert.equal(await readFile(join(child.directory, 'f20000'), 'utf8'), 'small\n');
    assert.equal(await git(f.parent, ['rev-parse', 'HEAD']), f.base);
    assert.equal(await git(f.parent, ['status', '--porcelain=v1']), '');
  },
);

test('a late branch conflict forgets failed metadata without changing the owner branch', async (t) => {
  const f = await fixture(t);
  const branch = 'codex/owner-race';
  const ownerTip = await git(f.parent, ['commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'Owner branch']);
  const worktrees = await git(f.parent, ['worktree', 'list', '--porcelain']);
  const original = childProcess.execFile;
  let raced = false;
  const mock = t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
    const argv = args[1] as string[];
    if (!raced && argv.includes('worktree') && argv.includes('add') && argv.includes(branch)) {
      raced = true;
      childProcess.execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'branch', branch, ownerTip], {
        cwd: f.parent,
        windowsHide: true,
      });
    }
    return Reflect.apply(original, childProcess, args);
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.manager.prepare({ ...f.input, branch, baseCommit: f.base }),
      (error: unknown) => error instanceof LaneWorkspaceValidationError && /already exists/.test(error.message),
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(raced, true);
  assert.equal((await f.manager.inspect(f.input.id))?.state, 'failed');
  assert.equal(await f.manager.forgetFailedPreparation(f.input.id), true);
  assert.equal(await f.manager.inspect(f.input.id), undefined);
  assert.equal(await git(f.parent, ['rev-parse', `refs/heads/${branch}`]), ownerTip);
  assert.equal(await git(f.parent, ['worktree', 'list', '--porcelain']), worktrees);
});

test('forgetting failed preparation retains ready workspaces and failed records with an existing checkout', async (t) => {
  const f = await fixture(t);
  const child = await f.manager.prepare(f.input);
  assert.equal(await f.manager.forgetFailedPreparation(child.id), false);
  assert.equal((await f.manager.inspect(child.id))?.state, 'ready');
  await writeFile(join(child.directory, 'retained.txt'), 'owner work must survive');
  await writeFile(join(f.storage, child.id, 'workspace.json'), JSON.stringify({ ...child, state: 'failed' }));
  const worktrees = await git(f.parent, ['worktree', 'list', '--porcelain']);
  assert.equal(await f.manager.forgetFailedPreparation(child.id), false);
  assert.equal((await f.manager.inspect(child.id))?.state, 'failed');
  assert.equal(await readFile(join(child.directory, 'retained.txt'), 'utf8'), 'owner work must survive');
  assert.equal(await git(f.parent, ['rev-parse', `refs/heads/${child.branch}`]), f.base);
  assert.equal(await git(f.parent, ['worktree', 'list', '--porcelain']), worktrees);
});
