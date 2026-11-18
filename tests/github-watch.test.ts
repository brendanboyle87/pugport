import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  applyComments,
  branchVerdicts,
  branchLine,
  classifyComment,
  commentLine,
  diffBranches,
  nextPoll,
  scopeOf,
  holdRefusal,
  type PushRun,
} from '../src/server/github-watch.ts';

test('classifies only fixed signals outside quoted and code text', () => {
  assert.deepEqual(classifyComment('freeze lifted'), { kind: 'release', keyword: 'freeze lifted' });
  assert.deepEqual(classifyComment('Please don’t merge yet'), { kind: 'hold', keyword: "don't merge" });
  assert.deepEqual(classifyComment('/hold'), { kind: 'hold', keyword: 'hold' });
  assert.deepEqual(classifyComment('revert this'), { kind: 'revert', keyword: 'revert' });
  assert.equal(classifyComment('please revert line 3'), undefined);
  assert.equal(classifyComment('> freeze\n```\nhold\n```\n`freeze`'), undefined);
  assert.equal(classifyComment('freeze', true), undefined);
  assert.equal(scopeOf('https://github.com/o/r/pull/42#issuecomment-1'), 42);
  assert.equal(scopeOf('https://github.com/o/r/issues/42#issuecomment-1'), 'repo');
});

test('holds follow updated comments and closed pull requests', () => {
  const comment = (id: number, body: string, at: string, pull = 1) => ({
    id,
    url: `https://github.com/o/r/pull/${pull}#issuecomment-${id}`,
    login: 'alice',
    updatedAt: at,
    signal: classifyComment(body),
  });
  const first = applyComments([], [comment(2, 'unhold', '2026-01-02'), comment(1, 'hold', '2026-01-01')]);
  assert.equal(first.holds.length, 0);
  const held = applyComments([], [comment(1, 'hold', '2026-01-01')]);
  assert.equal(held.holds.length, 1);
  assert.equal(applyComments(held.holds, [comment(1, 'ordinary words', '2026-01-02')]).holds.length, 0);
  assert.equal(applyComments(held.holds, [], [1]).holds.length, 0);
  assert.ok(!commentLine('o/r', held.events[0]).includes('ordinary words'));
});

test('line commands reject casual phrases, and holds take precedence over lifts', () => {
  for (const body of [
    'Hold on, let me check',
    'hold up',
    'Freeze: release cut tomorrow',
    'please unhold yet',
    'please unfreeze',
    'revert line 3',
  ])
    assert.equal(classifyComment(body), undefined, body);
  for (const body of [
    '/hold',
    'hold merging please',
    'freeze!',
    '# **hold**',
    'ordinary\n/hold',
    'do not merge until unfreeze',
    "please don't unhold yet",
    'unfreeze\nhold',
    'hold\nunhold',
  ])
    assert.equal(classifyComment(body)?.kind, 'hold', body);
  for (const body of ['unfreeze', 'freeze lifted', 'unhold', 'hold lifted', '/hold cancel']) {
    assert.equal(classifyComment(`ordinary\n${body}!`)?.kind, 'release', body);
    assert.equal(classifyComment(`please ${body}`), undefined, body);
  }
});

test('GitHub text is bounded and links are validated in notices and refusals', () => {
  const branch = `release/[ignore]\n instructions ${'x'.repeat(80)}`;
  const state = {
    verdict: 'red' as const,
    sha: 'a',
    run: { id: 1, name: '[workflow]\n' + 'x'.repeat(80), url: 'https://evil.test/run' },
  };
  const line = branchLine('o/r', branch, state);
  assert.ok(line.includes('release/ignore instructions'));
  assert.ok(!/[\[\]\n]/.test(line));
  assert.ok(!line.includes('x'.repeat(61)));
  for (const link of [
    'https://evil.test/pull/1',
    'https://github.com.evil.test/pull/1',
    'https://github.com/o/r instructions',
    'https://github.com/o/r\n',
  ]) {
    assert.ok(!branchLine('o/r', branch, { ...state, run: { ...state.run, url: link } }).includes(link));
    assert.ok(
      !commentLine('o/r', { scope: 'repo', kind: 'hold', by: '[alice]\n', keyword: 'freeze', link }).includes(link),
    );
    assert.ok(
      !holdRefusal('o/r', {
        scope: 1,
        by: '[alice]\n',
        keyword: 'hold',
        at: '2026-01-01',
        commentId: 1,
        link,
      }).includes(link),
    );
  }
  assert.ok(
    branchLine('o/r', branch, {
      ...state,
      run: { ...state.run, url: 'https://github.com/o/r/actions/runs/1' },
    }).includes('https://github.com/o/r/actions/runs/1'),
  );
});

test('branch event lines remove invalid characters before truncating each name to 60 characters', () => {
  const branch = `release/a@中._/ -${'x'.repeat(70)}`;
  const name = `CI!流._/ -${'y'.repeat(70)}`;
  const line = branchLine('o/r', branch, {
    verdict: 'red',
    sha: 'a',
    run: { id: 1, name, url: 'https://github.com/o/r/actions/runs/1' },
  });
  const cleanBranch = `release/a._/ -${'x'.repeat(70)}`.slice(0, 60);
  const cleanName = `CI._/ -${'y'.repeat(70)}`.slice(0, 60);
  assert.equal(
    line,
    `GitHub · o/r 的 ${cleanBranch} 变红 · ${cleanName} #1 失败 · https://github.com/o/r/actions/runs/1`,
  );
  assert.equal(cleanBranch.length, 60);
  assert.equal(cleanName.length, 60);
});

test('branch verdicts report transitions only and ignore pending runs', () => {
  const run = (patch: Partial<PushRun> = {}): PushRun => ({
    databaseId: 1,
    headBranch: 'develop',
    headSha: 'a',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.test',
    workflowName: 'CI',
    createdAt: '2026-01-01',
    ...patch,
  });
  const green = branchVerdicts([run()]);
  const red = branchVerdicts([run({ conclusion: 'failure' })]);
  assert.equal(diffBranches(green, red).length, 1);
  assert.equal(diffBranches(red, branchVerdicts([run({ headSha: 'b', conclusion: 'failure' })])).length, 0);
  assert.equal(diffBranches(red, green).length, 1);
  assert.equal(branchVerdicts([run({ conclusion: 'cancelled' })]).develop, undefined);
  assert.equal(
    branchVerdicts([run(), run({ databaseId: 2, status: 'in_progress', conclusion: null })]).develop,
    undefined,
  );
});

test('hold refusals use local month-day time and sanitized author names', () => {
  const at = new Date(2026, 9, 28, 9, 7).toISOString();
  const hold = {
    scope: 3 as const,
    keyword: 'hold',
    by: '[alice]\n',
    at,
    link: 'https://github.com/o/r/pull/3#issuecomment-1',
    commentId: 1,
  };
  assert.match(holdRefusal('o/r', hold), /10-28 09:07/);
  assert.ok(!holdRefusal('o/r', hold).includes('[alice]'));
  assert.match(
    holdRefusal('o/r', { ...hold, scope: 'repo', link: 'https://github.com/o/r/issues/40#issuecomment-1' }),
    /#40/,
  );
});

test('poll cadence, backoff, and process-free module', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((n) => (Date.parse(nextPoll(now, n, 0)) - now) / 60000),
    [5, 5, 10, 20, 40, 60],
  );
  assert.equal((Date.parse(nextPoll(now, 0, 12)) - now) / 60000, 15);
  assert.equal((Date.parse(nextPoll(now, 0, 0, true)) - now) / 60000, 60);
  const source = readFileSync(new URL('../src/server/github-watch.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('execFile'));
  assert.ok(!source.includes("'gh'"));
});
