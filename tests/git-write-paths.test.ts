import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from '../src/server/platform/test-process.ts';
import { gitCommitPaths, inspectGitWritePaths } from '../src/server/managed-worktrees.ts';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await run(
      'git',
      ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd, windowsHide: true },
    )
  ).stdout.trim();

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-git-paths-')));
  t.after(async () => {
    assert.match(basename(root), /^pugport-git-paths-/);
    await rm(root, { recursive: true, force: true });
  });
  const main = join(root, 'main');
  await mkdir(main);
  await git(main, 'init');
  await writeFile(join(main, 'a.txt'), 'one\n');
  await git(main, 'add', '.');
  await git(main, 'commit', '-m', 'Synthetic baseline');
  const lane = join(root, 'lane');
  await git(main, 'worktree', 'add', '-b', 'lane', lane);
  const common = join(main, '.git');
  return { root, main, lane, common };
}

test('a linked worktree gets its Git directory plus shared objects, refs and logs; never the common directory', async (t) => {
  const f = await fixture(t);
  const paths = (await inspectGitWritePaths(f.lane)).paths;
  assert.deepEqual(paths, [
    join(f.common, 'worktrees', 'lane'),
    join(f.common, 'objects'),
    join(f.common, 'refs'),
    join(f.common, 'logs'),
  ]);
  for (const forbidden of ['config', 'hooks', 'info', 'packed-refs'])
    assert.ok(!paths.some((path) => path.endsWith(`${sep}${forbidden}`)));
  assert.ok(!paths.includes(f.common));
});

test('logs are optional; a missing required folder or a link yields no paths', async (t) => {
  const f = await fixture(t);
  await rm(join(f.common, 'logs'), { recursive: true });
  assert.equal((await inspectGitWritePaths(f.lane)).paths.length, 3);
  await rm(join(f.common, 'refs'), { recursive: true });
  assert.deepEqual((await inspectGitWritePaths(f.lane)).paths, []);
  const target = join(f.root, 'elsewhere');
  await mkdir(target);
  await symlink(target, join(f.common, 'refs'), 'junction');
  assert.deepEqual((await inspectGitWritePaths(f.lane)).paths, []);
});

test('a linked worktree whose logs folder is a link only gets three paths', async (t) => {
  const f = await fixture(t);
  await rm(join(f.common, 'logs'), { recursive: true });
  const target = join(f.root, 'elsewhere');
  await mkdir(target);
  await symlink(target, join(f.common, 'logs'), 'junction');
  assert.equal((await inspectGitWritePaths(f.lane)).paths.length, 3);
});

test('a main checkout and a non-repository get none; the main checkout is reported', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await inspectGitWritePaths(f.main), { paths: [], mainCheckout: true });
  assert.deepEqual(await inspectGitWritePaths(f.root), { paths: [], mainCheckout: false });
  assert.deepEqual(await inspectGitWritePaths(join(f.root, 'missing')), { paths: [], mainCheckout: false });
});

test('a relative common directory from main/sub still identifies the main checkout', async (t) => {
  const f = await fixture(t);
  const sub = join(f.main, 'sub');
  await mkdir(sub);
  assert.equal(await git(sub, 'rev-parse', '--git-common-dir'), '../.git');
  assert.deepEqual(await inspectGitWritePaths(sub), { paths: [], mainCheckout: true });
});

test('known branch-lane Git folders are checked without running Git', async (t) => {
  const f = await fixture(t);
  const gitDirectory = join(f.common, 'worktrees', 'lane');
  assert.equal((await gitCommitPaths(gitDirectory, f.common)).length, 4);
  assert.deepEqual(await gitCommitPaths(join(f.common, 'worktrees', 'absent'), f.common), []);
});

test('a rewritten commondir cannot grant another repository metadata', async (t) => {
  const f = await fixture(t);
  const other = join(f.root, 'other');
  await mkdir(other);
  await git(other, 'init');
  await writeFile(join(f.common, 'worktrees', 'lane', 'commondir'), join(other, '.git'));
  assert.deepEqual((await inspectGitWritePaths(f.lane)).paths, []);
});

test('a forged git file cannot register arbitrary Git storage as a writable root', async (t) => {
  const f = await fixture(t);
  const forged = join(f.root, 'forged');
  const fakeGit = join(f.root, 'fake-git');
  await mkdir(forged);
  await mkdir(fakeGit);
  await writeFile(join(forged, '.git'), `gitdir: ${fakeGit}\n`);
  await writeFile(join(fakeGit, 'HEAD'), 'ref: refs/heads/lane\n');
  await writeFile(join(fakeGit, 'commondir'), f.common);
  await writeFile(join(fakeGit, 'gitdir'), join(forged, '.git'));
  assert.deepEqual((await inspectGitWritePaths(forged)).paths, []);
});

test('a forged git file pointing at another checkout registration is refused', async (t) => {
  const f = await fixture(t);
  const forged = join(f.root, 'forged');
  await mkdir(forged);
  await writeFile(join(forged, '.git'), `gitdir: ${join(f.common, 'worktrees', 'lane')}\n`);
  assert.deepEqual((await inspectGitWritePaths(forged)).paths, []);
});

test('a linked worktree root resolves its layout without starting Git', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-git-paths-')));
  t.after(async () => {
    assert.match(basename(root), /^pugport-git-paths-/);
    await rm(root, { recursive: true, force: true });
  });
  const common = join(root, 'common');
  const gitDirectory = join(common, 'worktrees', 'lane');
  const lane = join(root, 'lane');
  await mkdir(join(common, 'objects'), { recursive: true });
  await mkdir(join(common, 'refs'), { recursive: true });
  await mkdir(join(common, 'logs'), { recursive: true });
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(lane);
  const slash = (value: string) => value.replaceAll('\\', '/');
  await writeFile(join(lane, '.git'), `gitdir: ${slash(gitDirectory)}\n`);
  await writeFile(join(gitDirectory, 'commondir'), '../..\n');
  await writeFile(join(gitDirectory, 'gitdir'), `${slash(join(lane, '.git'))}\n`);
  const laneKey = process.platform === 'win32' ? resolve(lane).toLowerCase() : resolve(lane);
  let started = 0;
  const original = childProcess.execFile;
  const mock = t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
    const cwd = (args[2] as { cwd?: string } | undefined)?.cwd;
    const key = cwd ? (process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)) : '';
    if (key === laneKey) {
      started += 1;
      throw new Error('git must not start');
    }
    return Reflect.apply(original, childProcess, args);
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  try {
    assert.deepEqual((await inspectGitWritePaths(lane)).paths, [
      gitDirectory,
      join(common, 'objects'),
      join(common, 'refs'),
      join(common, 'logs'),
    ]);
    assert.equal(started, 0);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a linked worktree subdirectory retains its checkout registration', async (t) => {
  const f = await fixture(t);
  const sub = join(f.lane, 'sub');
  await mkdir(sub);
  assert.equal((await inspectGitWritePaths(sub)).paths.length, 4);
});
