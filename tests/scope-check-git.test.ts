import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from '../src/server/platform/test-process.ts';
import {
  headCommit,
  hasGitMetadata,
  committedBetween,
  freshlyChanged,
  dirtyFiles,
  changedBetween,
  headAdvanced,
} from '../src/server/scope-check.ts';

test('host git measures descendants, root commits and unchanged dirty files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(hasGitMetadata(dir), false);
  assert.equal(await headCommit(dir), undefined);
  assert.deepEqual(await committedBetween(dir, undefined, '1234567890123456789012345678901234567890'), []);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  assert.equal(hasGitMetadata(dir), true);
  assert.equal(hasGitMetadata(join(dir, 'nested')), true);
  writeFileSync(join(dir, 'a.txt'), 'one');
  git('add', 'a.txt');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'one');
  const first = (await headCommit(dir))!;
  assert.deepEqual(await committedBetween(dir, undefined, first), ['a.txt']);
  writeFileSync(join(dir, 'b.txt'), 'two');
  git('add', 'b.txt');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'two');
  const second = (await headCommit(dir))!;
  assert.notEqual(first, second);
  assert.deepEqual(await committedBetween(dir, first, second), ['b.txt']);
  assert.deepEqual(await committedBetween(dir, second, first), []);
  // A failed start read leaves no start commit: an ordinary commit is not provably this run's.
  assert.deepEqual(await committedBetween(dir, undefined, second), []);
  // A merge during the run is also measurable work.
  git('checkout', '-q', '-b', 'side', first);
  writeFileSync(join(dir, 'side.txt'), 'side');
  git('add', 'side.txt');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'side');
  git('checkout', '-q', '-');
  git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    'merge',
    '-q',
    '--no-ff',
    '-m',
    'merge',
    'side',
  );
  assert.deepEqual(await committedBetween(dir, second, (await headCommit(dir))!), ['side.txt']);
  const before = new Map([
    ['a.txt', Math.round(statSync(join(dir, 'a.txt')).mtimeMs)],
    ['missing.txt', 1],
    // Already missing at the start (-1) and still missing: not this run's change.
    ['ghost.txt', -1],
  ]);
  assert.deepEqual(await freshlyChanged(dir, ['a.txt', 'missing.txt', 'b.txt', 'ghost.txt'], before), [
    'missing.txt',
    'b.txt',
  ]);
});

test('subagent commits and working changes confirm without main-run file events', async (t) => {
  const { confirmFileOutcome } = await import('../src/server/task-file-outcome.ts');
  const dir = mkdtempSync(join(tmpdir(), 'subagent-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  const commit = (message: string) => {
    git('add', '.');
    git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', message);
  };
  git('init', '-q');
  writeFileSync(join(dir, 'base.txt'), 'base');
  commit('base');
  const before = (await dirtyFiles(dir))!;
  const beforeHead = (await headCommit(dir))!;
  const record: import('../src/shared/types.ts').RunRecord = {
    id: 'subagent',
    projectPath: dir,
    prompt: 'Implement files',
    kind: 'routine',
    status: 'completed',
    startedAt: '',
    output: 'Done',
    events: [],
    route: { runtimeId: 'mock', model: 'mock', kind: 'routine', reasons: [], warnings: [] },
    taskOutcome: { status: 'completed', source: 'executor-report' },
  };
  record.measuredFileChanges = {
    source: 'pugport-scope-snapshot',
    paths: changedBetween(before, (await dirtyFiles(dir))!),
  };
  assert.equal((await confirmFileOutcome(record)).status, 'unverified');
  writeFileSync(join(dir, 'child.txt'), 'subagent work');
  record.measuredFileChanges.paths = changedBetween(before, (await dirtyFiles(dir))!);
  assert.equal((await confirmFileOutcome(record)).status, 'completed');
  commit('subagent implementation');
  const afterHead = (await headCommit(dir))!;
  record.measuredFileChanges = {
    source: 'pugport-scope-snapshot',
    paths: await freshlyChanged(dir, await committedBetween(dir, beforeHead, afterHead), before),
    commits: { before: beforeHead, after: afterHead },
  };
  const outcome = await confirmFileOutcome(record);
  assert.equal(outcome.status, 'completed');
  assert.ok(outcome.summary?.includes(afterHead.slice(0, 7)));
  git('checkout', '-q', '-b', 'child', beforeHead);
  writeFileSync(join(dir, 'merged.txt'), 'child branch work');
  commit('child branch implementation');
  git('checkout', '-q', '-');
  git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    'merge',
    '-q',
    '--no-ff',
    '-m',
    'merge child',
    'child',
  );
  const mergedHead = (await headCommit(dir))!;
  record.measuredFileChanges = {
    source: 'pugport-scope-snapshot',
    paths: await committedBetween(dir, afterHead, mergedHead),
    commits: { before: afterHead, after: mergedHead },
  };
  const mergedOutcome = await confirmFileOutcome(record);
  assert.equal(mergedOutcome.status, 'completed');
  assert.ok(mergedOutcome.summary?.includes(mergedHead.slice(0, 7)));
  assert.equal(await headAdvanced(dir, mergedHead, mergedHead), false);
  assert.equal(await headAdvanced(dir, mergedHead, beforeHead), false);
  git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'empty',
  );
  const emptyHead = (await headCommit(dir))!;
  assert.equal(await headAdvanced(dir, mergedHead, emptyHead), true);
  writeFileSync(join(dir, 'transient.txt'), 'temporary');
  commit('temporary implementation');
  git('rm', '-q', 'transient.txt');
  commit('remove temporary implementation');
  const revertedHead = (await headCommit(dir))!;
  for (const after of [emptyHead, revertedHead]) {
    assert.equal(await headAdvanced(dir, mergedHead, after), true);
    const paths = await committedBetween(dir, mergedHead, after);
    assert.deepEqual(paths, []);
    record.measuredFileChanges = { source: 'pugport-scope-snapshot', paths, commits: { before: mergedHead, after } };
    const result = await confirmFileOutcome(record);
    assert.equal(result.status, 'completed');
    assert.ok(result.summary?.includes(after.slice(0, 7)));
    record.taskOutcome = {
      status: 'completed',
      source: 'executor-report',
      claims: [{ claim: 'outside change', files: ['../outside.txt'] }],
    };
    assert.equal((await confirmFileOutcome(record)).status, 'unverified');
    record.taskOutcome = { status: 'completed', source: 'executor-report' };
  }
});
