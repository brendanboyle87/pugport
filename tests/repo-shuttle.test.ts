import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from '../src/server/platform/test-process.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';

const run = promisify(execFile);
test('secret names include key stores and exclude environment examples', async () => {
  const { secretNamePattern } = await import('../src/server/devices/repo-shuttle.ts');
  for (const name of [
    '.env',
    '.env.',
    '.env.production',
    'folder/.key',
    'a.pem',
    'a.p12',
    'a.pfx',
    'a.jks',
    'a.keystore',
    '.npmrc',
    '.netrc',
    '.pypirc',
    'id_rsa',
    'id_ed25519.pub',
  ])
    assert.ok(secretNamePattern.test(name), name);
  for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'folder/env.txt', '.en[v]'])
    assert.equal(secretNamePattern.test(name), false, name);
});
async function git(cwd: string, ...args: string[]) {
  return (
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@x.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
  ).stdout.trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-shuttle-test-')));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(await realpath(tmpdir())) + sep));
    assert.match(root, /pugport-shuttle-test-/);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  const top = join(root, 'repo');
  await mkdir(top);
  await git(top, 'init', '-q');
  await writeFile(join(top, 'a.txt'), 'old\n');
  await writeFile(join(top, '.gitignore'), 'build/\n');
  await git(top, 'add', '.');
  await git(top, 'commit', '-qm', 'initial');
  return { root, top };
}
async function snapshot(t: TestContext, cwd: string, trip = 'test-trip') {
  trip = `${trip}-${randomUUID()}`;
  const api = await import('../src/server/devices/repo-shuttle.ts');
  const result = await api.snapshotRepository(cwd, trip);
  assert.equal(result.ok, true, JSON.stringify(result));
  t.after(async () => {
    // The fixture has already removed its synthetic repository; its refs go with it.
    await rm(result.bundle, { force: true });
  });
  return result;
}

test('snapshot includes local changes, excludes secrets and ignored files, preserves owner state', async (t) => {
  const { top } = await fixture(t);
  await writeFile(join(top, '.env.production'), 'tracked historical setting\n');
  await git(top, 'add', '.env.production');
  await git(top, 'commit', '-qm', 'tracked env');
  await writeFile(join(top, 'a.txt'), 'new content\n');
  await writeFile(join(top, 'new.txt'), 'new\n');
  await writeFile(join(top, '.env'), 'SECRET=value\n');
  await writeFile(join(top, 'notes.txt'), '-----BEGIN PRIVATE KEY-----\n');
  await mkdir(join(top, 'build'));
  await writeFile(join(top, 'build/x.txt'), 'ignored');
  const before = {
    status: await git(top, 'status', '--porcelain'),
    head: await git(top, 'rev-parse', 'HEAD'),
    branch: await git(top, 'symbolic-ref', 'HEAD'),
    index: await readFile(join(top, '.git/index')),
    bytes: await readFile(join(top, 'a.txt')),
  };
  const s = await snapshot(t, top);
  const paths = (await git(top, 'ls-tree', '-r', '--name-only', s.snapshot)).split('\n');
  assert.ok(paths.includes('new.txt'));
  assert.ok(paths.includes('.env.production'));
  for (const path of ['.env', 'notes.txt', 'build/x.txt']) assert.ok(!paths.includes(path), path);
  assert.equal(await git(top, 'show', `${s.snapshot}:a.txt`), 'new content');
  assert.deepEqual(s.leftOut.sort(), ['.env', 'notes.txt']);
  assert.equal(await git(top, 'status', '--porcelain'), before.status);
  assert.equal(await git(top, 'rev-parse', 'HEAD'), before.head);
  assert.equal(await git(top, 'symbolic-ref', 'HEAD'), before.branch);
  assert.deepEqual(await readFile(join(top, '.git/index')), before.index);
  assert.deepEqual(await readFile(join(top, 'a.txt')), before.bytes);
  assert.equal(await git(top, 'rev-parse', s.ref), s.snapshot);
  assert.match(await git(top, 'bundle', 'list-heads', s.bundle), new RegExp(s.ref));
});

test('snapshot enforces the 256 MiB cap before adding candidates', async (t) => {
  const { top } = await fixture(t);
  const api = await import('../src/server/devices/repo-shuttle.ts');
  for (const file of ['one.bin', 'two.bin']) {
    await writeFile(join(top, file), '');
    await truncate(join(top, file), 129 * 1024 ** 2);
  }
  const before = await git(top, 'count-objects', '-v');
  const result = await api.snapshotRepository(top, randomUUID());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /项目太大（258 MiB），没有带过去/);
  assert.equal(await git(top, 'count-objects', '-v'), before);
  await rm(join(top, 'one.bin'));
  await truncate(join(top, 'two.bin'), 257 * 1024 ** 2);
  const s = await snapshot(t, top, 'oversized-file');
  assert.deepEqual(s.leftOut, ['two.bin']);
  assert.equal(s.snapshot, s.head);
});

for (const kind of ['staged', 'only-secret', 'literal'] as const) {
  test(`snapshot secret exclusion: ${kind}`, async (t) => {
    const { top } = await fixture(t);
    await writeFile(join(top, '.env'), 'private');
    if (kind === 'staged') await git(top, 'add', '.env');
    if (kind === 'literal') await writeFile(join(top, '.en[v]'), 'safe');
    const s = await snapshot(t, top, kind);
    const paths = (await git(top, 'ls-tree', '-r', '--name-only', s.snapshot)).split('\n');
    assert.ok(!paths.includes('.env'));
    assert.ok(s.leftOut.includes('.env'));
    if (kind === 'literal') assert.ok(paths.includes('.en[v]'));
    else assert.equal(s.snapshot, s.head);
  });
}

test('snapshot honors autocrlf and global excludes without changing working bytes', async (t) => {
  const { top, root } = await fixture(t);
  const home = join(root, 'home');
  await mkdir(home);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  // The test process guard redirects global config to its synthetic config file.
  const guardedConfig = join(testDirectory(), 'git-config');
  const oldConfig = await readFile(guardedConfig);
  t.after(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await writeFile(guardedConfig, oldConfig);
  });
  const ignored = join(home, 'ignore');
  await writeFile(ignored, 'globally-ignored.txt\n');
  const config = `[core]\n autocrlf = true\n excludesFile = ${ignored.replaceAll('\\', '/')}\n`;
  await writeFile(join(home, '.gitconfig'), config);
  await writeFile(guardedConfig, config);
  await writeFile(join(top, 'a.txt'), 'a\r\nb\r\n');
  await writeFile(join(top, 'globally-ignored.txt'), 'do not ship');
  const s = await snapshot(t, top, 'autocrlf');
  const blob = (await run('git', ['show', `${s.snapshot}:a.txt`], { cwd: top, windowsHide: true })).stdout;
  assert.equal(blob, 'a\nb\n');
  assert.equal(await readFile(join(top, 'a.txt'), 'utf8'), 'a\r\nb\r\n');
  assert.doesNotMatch(await git(top, 'ls-tree', '-r', '--name-only', s.snapshot), /globally-ignored/);
  t.diagnostic(`platform=${process.platform}; autocrlf=true; blob=${JSON.stringify(blob)}; working="a\\r\\nb\\r\\n"`);
});

test('snapshot supports linked worktrees and subfolders and refuses shallow clones', async (t) => {
  const { top, root } = await fixture(t);
  const linked = join(root, 'linked');
  await git(top, 'worktree', 'add', '-b', 'linked', linked);
  await mkdir(join(linked, 'sub'));
  const s = await snapshot(t, join(linked, 'sub'), 'linked');
  assert.equal(s.subpath, 'sub');
  assert.equal(resolve(s.top), resolve(linked));
  const shallow = join(root, 'shallow');
  await git(root, 'clone', '--depth', '1', pathToFileURL(top).href, shallow);
  const api = await import('../src/server/devices/repo-shuttle.ts');
  assert.equal((await api.snapshotRepository(shallow, 'shallow')).ok, false);
});

test('land creates unique ASCII branches without touching checkout, index or FETCH_HEAD', async (t) => {
  const { top, root } = await fixture(t);
  await writeFile(join(top, 'a.txt'), 'uncommitted\n');
  const s = await snapshot(t, top, 'land');
  const api = await import('../src/server/devices/repo-shuttle.ts');
  const device = { id: '00000000-1234', name: '家里的Ubuntu' };
  assert.equal(api.deviceBranchSlug(device), '00000000');
  const clone = join(root, 'device');
  await mkdir(clone);
  await git(clone, 'init', '-q');
  await git(clone, 'fetch', s.bundle, s.ref);
  await git(clone, 'checkout', s.snapshot);
  await writeFile(join(clone, 'new.txt'), 'device');
  await git(clone, 'add', '.');
  await git(clone, 'commit', '-qm', 'device edit');
  const back = join(root, 'back.bundle');
  await git(clone, 'bundle', 'create', back, `^${s.snapshot}`, 'HEAD');
  const branchBefore = await git(top, 'symbolic-ref', 'HEAD');
  const statusBefore = await git(top, 'status', '--porcelain');
  await writeFile(join(top, '.git/FETCH_HEAD'), 'sentinel');
  const landed = await api.landDeviceBranch(top, back, s.snapshot, device);
  assert.match(landed.branch, /^device\/00000000\/[a-f0-9]{8}$/);
  assert.equal(landed.commits, 1);
  assert.equal(landed.files, 1);
  assert.equal((await api.landDeviceBranch(top, back, s.snapshot, device)).branch, landed.branch + '-2');
  assert.equal(await git(top, 'symbolic-ref', 'HEAD'), branchBefore);
  assert.equal(await git(top, 'status', '--porcelain'), statusBefore);
  assert.equal(await readFile(join(top, '.git/FETCH_HEAD'), 'utf8'), 'sentinel');
  const empty = join(root, 'missing-prerequisite');
  await mkdir(empty);
  await git(empty, 'init', '-q');
  await assert.rejects(api.landDeviceBranch(empty, back, s.snapshot, device));
  assert.equal(await git(empty, 'for-each-ref', 'refs/heads/device/'), '');
  assert.equal(
    api.mergeAdvice(landed.branch, s.snapshot.slice(0, 8), false),
    `套用改动（不动你未提交的修改）：\ngit diff --binary ${s.snapshot.slice(0, 8)} ${landed.branch} --output=pugport-device.patch\ngit apply pugport-device.patch`,
  );
});
