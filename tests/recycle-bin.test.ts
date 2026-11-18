import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { recyclablePaths } from '../src/server/recycle-bin.ts';

test(
  'Windows separators, aliased project ancestors and drive roots finish without spinning',
  { skip: process.platform !== 'win32' },
  (t) => {
    const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-recycle-normalized-')));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const project = join(fixture, 'physical', 'project');
    const alias = join(fixture, 'alias');
    mkdirSync(project, { recursive: true });
    const file = join(project, 'file.txt');
    writeFileSync(file, 'synthetic');
    symlinkSync(join(fixture, 'physical'), alias, 'junction');
    const aliasedProject = join(alias, 'project');
    // A child-process deadline can stop a synchronous loop; a test timeout cannot.
    const script = `
    import assert from 'node:assert/strict';
    import { recyclablePaths } from './src/server/recycle-bin.ts';
    const file = ${JSON.stringify(file)};
    for (const [project, requested] of ${JSON.stringify([
      [project, [file.replaceAll('\\', '/'), file.replaceAll('\\', '\\\\')]],
      [aliasedProject, [join(aliasedProject, 'file.txt'), file, 'file.txt']],
      [parse(project).root, [file]],
    ])}) {
      const result = await recyclablePaths(project, requested);
      assert.deepEqual(result.paths, [file]);
      assert.deepEqual(result.failed, []);
    }
    const outside = await recyclablePaths(${JSON.stringify(project)}, [${JSON.stringify(parse(project).root)}]);
    assert.equal(outside.paths.length, 0);
    assert.equal(outside.failed.length, 1);
  `;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      timeout: 5000,
      windowsHide: true,
    });
  },
);

test('Git ancestors stay protected even when recycling from inside .git', async (t) => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-recycle-git-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const objects = join(repo, '.git', 'objects');
  mkdirSync(objects, { recursive: true });
  const checked = await recyclablePaths(join(repo, '.git'), [objects]);
  assert.deepEqual(checked.paths, []);
  assert.equal(checked.failed.length, 1);
  assert.match(checked.failed[0]!.reason, /Git/);
  assert.equal(existsSync(objects), true);
});

test('an account login folder below .data is eligible relative to its accounts root', async (t) => {
  const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-recycle-account-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const accounts = join(fixture, '.data', 'accounts');
  const account = join(accounts, 'synthetic-id');
  mkdirSync(account, { recursive: true });
  writeFileSync(join(account, 'auth.json'), '{"synthetic":true}');
  const checked = await recyclablePaths(accounts, [account]);
  assert.deepEqual(checked.paths, [account]);
  assert.deepEqual(checked.failed, []);
});

test('a dot-prefixed folder remains inside the project while actual parent paths remain blocked', async (t) => {
  const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-recycle-boundary-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const project = join(fixture, 'project');
  const ordinary = join(project, '..archive', 'ordinary.txt');
  const outside = join(fixture, 'outside.txt');
  mkdirSync(join(project, '..archive'), { recursive: true });
  writeFileSync(ordinary, 'synthetic local fixture');
  writeFileSync(outside, 'synthetic outside fixture');

  const checked = await recyclablePaths(project, [ordinary, '../outside.txt', '..', project]);
  assert.deepEqual(checked.paths, [ordinary]);
  assert.deepEqual(
    checked.failed.map((item) => item.reason),
    ['不在当前项目目录内', '不在当前项目目录内', '不能回收项目目录本身'],
  );
});

test('selecting a leaf directory link never resolves into recycling its unnamed target', async (t) => {
  const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-recycle-link-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const target = join(fixture, 'keep-contents');
  const leaf = join(fixture, 'shortcut');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'synthetic');
  symlinkSync(target, leaf, process.platform === 'win32' ? 'junction' : 'dir');

  const checked = await recyclablePaths(fixture, [leaf]);
  assert.deepEqual(checked.paths, []);
  assert.equal(checked.failed[0]!.path, leaf);
  assert.match(checked.failed[0]!.reason, /链接或目录联接/);
  assert.equal(existsSync(join(target, 'keep.txt')), true);

  const child = await recyclablePaths(fixture, [join(leaf, 'keep.txt')]);
  assert.deepEqual(child.paths, []);
  assert.match(child.failed[0]!.reason, /链接或目录联接/);
  const containing = join(fixture, 'containing');
  mkdirSync(containing);
  symlinkSync(target, join(containing, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  const folder = await recyclablePaths(fixture, [containing]);
  assert.deepEqual(folder.paths, []);
  assert.match(folder.failed[0]!.reason, /链接或目录联接/);
});

test('repo and worktree files are eligible while protected children are refused', async (t) => {
  const app = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-recycle-project-')));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const worktree = join(app, '.claude', 'worktrees', 'x');
  mkdirSync(worktree, { recursive: true });
  for (const project of [app, worktree]) {
    const file = join(project, 'ordinary.txt');
    writeFileSync(file, 'synthetic');
    for (const name of ['.data/accounts', '.git', 'containing/.git'])
      mkdirSync(join(project, name), { recursive: true });
    const checked = await recyclablePaths(project, [
      file,
      join(project, '.data'),
      join(project, '.git'),
      join(project, 'containing'),
    ]);
    assert.deepEqual(checked.paths, [file]);
    assert.equal(checked.failed.length, 3);
    assert.equal(existsSync(file), true);
  }
  const outside = await recyclablePaths(worktree, [join(app, 'ordinary.txt')]);
  assert.deepEqual(outside.paths, []);
  assert.match(outside.failed[0]!.reason, /不在当前项目目录内/);
});
