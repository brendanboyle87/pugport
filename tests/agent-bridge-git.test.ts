import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, stat, utimes, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runGit, captureGit } from '../src/server/git.ts';
import { readBridge } from './helpers/read-bridge.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-git-bridge-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.match(dir, /pugport-git-bridge-/);
    await rm(dir, { recursive: true, force: true });
  });
  const git = async (...args: string[]) => {
    const result = await runGit(
      dir,
      ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args],
      { timeoutMs: 10_000 },
    );
    assert.notEqual(result, undefined, args.join(' '));
    return result!;
  };
  await git('init');
  await writeFile(join(dir, 'f'), 'x synthetic fixture\n');
  await git('add', 'f');
  await git('commit', '-m', 'Synthetic fixture commit');
  const bridge = readBridge(t, dir);
  return { ...bridge, dir, git, command: (command: string) => bridge.call('git', { command }) };
}
const output = (result: any) => result.content.map((item: any) => item.text ?? '').join('\n');

test('read-only bridge offers Git, reads history and records builtin audit events', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.list()).tools.find((tool: any) => tool.name === 'git').annotations.readOnlyHint, true);
  const result = await f.command('git log --oneline');
  assert.ok(!result.isError);
  assert.match(output(result), /exit code 0[\s\S]*Synthetic fixture commit/);
  assert.ok(f.events.some((event) => event.data?.handler === 'builtin' && event.data.tool === 'git'));
});
test('unsafe output and shell syntax are tool errors and create no file', async (t) => {
  const f = await fixture(t);
  for (const command of [
    'git log --output=x',
    'git log -S -- --output=x',
    'git grep -e -- --open-files-in-pager=synthetic',
    'git log; echo',
  ]) {
    const result = await f.command(command);
    assert.equal(result.isError, true);
    assert.match(output(result), /option|operators/);
    assert.equal(existsSync(join(f.dir, 'x')), false);
  }
});
test('stash show flags follow both words; shortlog defaults to HEAD', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'f'), 'x changed fixture\n');
  await f.git('stash', 'push', '-m', 'synthetic stash');
  const stash = await f.command('git stash show -p stash@{0}');
  assert.ok(!stash.isError, output(stash));
  assert.match(output(stash), /changed fixture/);
  const shortlog = await f.command('git shortlog -sn');
  assert.ok(!shortlog.isError);
  assert.match(output(shortlog), /1\s+Synthetic/);
  for (const command of ['git shortlog --group=author -s', 'git shortlog -sn -- f', 'git shortlog -sn HEAD']) {
    const result = await f.command(command);
    assert.ok(!result.isError, output(result));
    assert.match(output(result), /1\s+Synthetic/);
  }
});
test('blame, log and grep never run a configured textconv driver', async (t) => {
  const f = await fixture(t);
  const marker = join(f.dir, 'marker');
  const script = join(f.dir, 'driver.cjs');
  await writeFile(
    script,
    "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran'); process.stdout.write('x converted');",
  );
  const command = '"' + process.execPath.replaceAll('\\', '/') + '" "' + script.replaceAll('\\', '/') + '"';
  await writeFile(join(f.dir, '.gitattributes'), 'f diff=fixture\n');
  await f.git('config', 'diff.fixture.textconv', command);
  await f.git('add', '.gitattributes');
  await f.git('commit', '-m', 'Synthetic attributes');
  await writeFile(join(f.dir, 'f'), 'x changed fixture\n');
  await f.git('stash', 'push', '-m', 'synthetic stash');
  for (const command of ['git blame f', 'git log -p', 'git grep x', 'git stash list -p', 'git stash show -p']) {
    const result = await f.command(command);
    assert.ok(!result.isError, output(result));
    assert.match(output(result), /x synthetic fixture/);
    assert.equal(existsSync(marker), false);
  }
});
test('remote credentials are redacted before replies and audit events', async (t) => {
  const f = await fixture(t);
  await f.git('remote', 'add', 'origin', 'https://user:SECRET@example.invalid/r.git');
  const result = await f.command('git remote -v');
  assert.match(output(result), /https:\/\/\*\*\*@example.invalid/);
  assert.doesNotMatch(output(result), /SECRET/);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET/);
});
for (const command of ['git status', 'git diff'])
  test(command + ' leaves index bytes and mtime unchanged', async (t) => {
    const f = await fixture(t);
    const index = join(f.dir, '.git', 'index');
    const before = await readFile(index),
      beforeStat = await stat(index);
    const changed = new Date(Date.now() + 3000);
    await utimes(join(f.dir, 'f'), changed, changed);
    const result = await f.command(command);
    assert.ok(!result.isError, output(result));
    assert.deepEqual(await readFile(index), before);
    assert.equal((await stat(index)).mtimeMs, beforeStat.mtimeMs);
  });

test('grep with no match keeps its empty stderr', async (t) => {
  const f = await fixture(t);
  const result = await f.command('git grep nomatch');
  assert.equal(result.isError, true);
  assert.match(output(result), /exit code 1/);
  assert.doesNotMatch(output(result), /failed or was cancelled/);
  const captured = await captureGit(f.dir, ['grep', 'nomatch'], { timeoutMs: 10_000 });
  assert.equal(captured.exitCode, 1);
  assert.equal(captured.stderr, '');
});

test('diff refuses outside files without leaking contents into replies or audit events', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'pugport-git-outside-'));
  t.after(async () => {
    assert.ok(resolve(outside).startsWith(resolve(tmpdir()) + sep));
    assert.match(outside, /pugport-git-outside-/);
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, 'outside'), 'SYNTHETIC_OUTSIDE_CONTENT');
  const result = await f.command(`git diff "../${outside.split(sep).at(-1)}/outside" f`);
  assert.equal(result.isError, true);
  assert.match(output(result), /stay inside the project/);
  assert.doesNotMatch(output(result), /SYNTHETIC_OUTSIDE_CONTENT/);
  assert.doesNotMatch(JSON.stringify(f.events), /SYNTHETIC_OUTSIDE_CONTENT/);
});
test('captureGit preserves partial output on maxBuffer and returns nonzero command results', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'large'), 'x'.repeat(400_000));
  await f.git('add', 'large');
  await f.git('commit', '-m', 'Large synthetic blob');
  const result = await captureGit(f.dir, ['show', 'HEAD:large'], { timeoutMs: 10_000, maxBuffer: 1024 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length > 0);
  assert.equal(await runGit(f.dir, ['show', 'HEAD:large'], { timeoutMs: 10_000, maxBuffer: 1024 }), undefined);
  const large = await f.command('git show HEAD:large');
  assert.ok(!large.isError, output(large));
  assert.match(output(large), /output truncated/);
  assert.ok(output(large).length < 101_000);
  const failed = await f.command('git show missing-ref');
  assert.equal(failed.isError, true);
  assert.match(output(failed), /exit code [1-9]/);
});
test('Git requires a project folder and a string command', async (t) => {
  const f = readBridge(t, '');
  assert.equal((await f.call('git', { command: 'git log' })).isError, true);
  f.caller.run.projectPath = process.cwd();
  assert.equal((await f.call('git', { command: 12 })).isError, true);
});
test('Git refuses a project junction that leads to a different synthetic repository', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'pugport-git-outside-'));
  const link = join(f.dir, 'linked');
  t.after(async () => {
    await rm(link, { force: true });
    assert.ok(resolve(outside).startsWith(resolve(tmpdir()) + sep));
    assert.match(outside, /pugport-git-outside-/);
    await rm(outside, { recursive: true, force: true });
  });
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.command('git -C linked log');
  assert.equal(result.isError, true);
  assert.match(output(result), /stay inside the project/);
});

test('Git refuses a junction into the synthetic repository metadata', async (t) => {
  const f = await fixture(t);
  const link = join(f.dir, 'linked');
  t.after(() => rm(link, { force: true }));
  await symlink(join(f.dir, '.git'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.command('git -C linked log');
  assert.equal(result.isError, true);
  assert.match(output(result), /stay inside the project/);
});
