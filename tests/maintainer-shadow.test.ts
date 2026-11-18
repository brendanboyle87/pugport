import assert from 'node:assert/strict';
import test from 'node:test';
import { hostFixture } from './helpers/maintainer-host.ts';
import { mayWrite, type WriteKind } from '../src/server/maintainer/pipeline.ts';
import { recordOutcome, score, type VerdictRecord } from '../src/server/maintainer/shadow-score.ts';
import { readHostFlag, writeHostFlag } from '../src/server/maintainer/config.ts';

test('mayWrite complete mode/kind/author/App/pause/issue table re-reads flag and lease', async (t) => {
  const f = await hostFixture(t);
  for (const mode of ['live', 'shadow', 'off'] as const)
    for (const kind of ['comment', 'judge-status', 'review', 'label', 'label-create'] as WriteKind[])
      for (const author of ['owner', 'other'])
        for (const app of [false, true])
          for (const writesPaused of [false, true])
            for (const issue of [false, true]) {
              const expected =
                app &&
                !writesPaused &&
                (mode === 'live' ||
                  (mode === 'shadow' && author === 'owner' && !issue && ['comment', 'judge-status'].includes(kind)));
              assert.equal(
                mayWrite({
                  mode,
                  kind,
                  author,
                  repoOwner: 'owner',
                  app,
                  writesPaused,
                  issue,
                  flagFile: f.flagFile,
                  now: f.now(),
                }),
                expected,
              );
            }
  const input = {
    mode: 'live' as const,
    kind: 'comment' as const,
    author: 'owner',
    repoOwner: 'owner',
    app: true,
    writesPaused: false,
    flagFile: f.flagFile,
    now: f.now(),
  };
  writeHostFlag(f.flagFile, { ...readHostFlag(f.flagFile), leaseUntil: new Date(f.now()).toISOString() });
  assert.equal(mayWrite(input), false);
  f.enable();
  assert.equal(mayWrite(input), true);
  writeHostFlag(f.flagFile, { host: false, stage: 0 });
  assert.equal(mayWrite(input), false);
});
test('shadow owner writes comment + statuses only, collaborator and issues zero writes', async (t) => {
  const f = await hostFixture(t);
  f.data.private = true;
  f.addPr(1, 'owner');
  f.addPr(2);
  f.addIssue();
  await f.poll();
  assert.ok(f.writes.length >= 3);
  assert.ok(
    f.writes.every(
      (c) =>
        c.args[0] === 'api' &&
        (c.args[3] === 'repos/o/r/issues/1/comments' || c.args[3] === `repos/o/r/statuses/${f.record().sha}`),
    ),
  );
  assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
  assert.ok(f.audit.recent(200).some((a) => a.result === 'shadow-only'));
  assert.ok(f.dispatches.every((d) => d.title.includes(' · shadow · ')));
  assert.ok(!f.reads.some((c) => c.args[0] === 'label'));
});
for (const privateRepo of [false, true])
  test(`no App makes zero write calls, private=${privateRepo}`, async (t) => {
    const f = await hostFixture(t);
    f.data.private = privateRepo;
    f.data.token = false;
    f.addPr(1, 'owner');
    f.addIssue();
    await f.poll();
    assert.equal(f.writes.length, 0);
    assert.equal(f.record().phase, 'write-pending');
  });
test('shadow -> live requeues open heads, bootstraps only missing labels once', async (t) => {
  const f = await hostFixture(t);
  f.data.private = true;
  f.data.labels = ['tier:docs', 'tier:owner'];
  f.addPr(1, 'owner');
  await f.poll();
  assert.equal(f.dispatches.length, 1);
  f.data.private = false;
  await f.poll();
  assert.equal(f.dispatches.length, 2);
  assert.deepEqual(
    f.writes.filter((c) => c.args[0] === 'label').map((c) => c.args),
    [
      ['label', 'create', 'tier:code', '--repo', 'o/r', '--color', '1d76db', '--description', 'Code or UI text'],
      [
        'label',
        'create',
        'needs-cla',
        '--repo',
        'o/r',
        '--color',
        'fbca04',
        '--description',
        'Waiting for the CLA signature',
      ],
    ],
  );
  await f.poll();
  assert.equal(f.reads.filter((c) => c.args[0] === 'label').length, 1);
  assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
  assert.equal(f.audit.recent(200).filter((a) => a.event === 'repo').length, 2);
});
test('score false pass/fail, later sha superseded, blocked and invalid never counted', () => {
  const record = (number: number, verdict: VerdictRecord['verdict']): VerdictRecord => ({
    number,
    sha: 'a'.repeat(40),
    verdict,
    tier: 'docs',
    external: false,
    mode: 'shadow',
    judgedAt: '2026-10-28T12:00:00.000Z',
  });
  let records = [
    record(1, 'pass'),
    record(2, 'fail'),
    record(3, 'pass'),
    record(4, 'fail'),
    record(5, 'blocked'),
    record(6, 'invalid'),
  ];
  for (const [number, merged, headSha] of [
    [1, false, 'a'],
    [2, true, 'a'],
    [3, true, 'a'],
    [4, true, 'b'],
  ] as const)
    records = recordOutcome(records, {
      number,
      headSha: headSha.repeat(40),
      merged,
      closed: true,
      at: '2026-10-28T13:00:00.000Z',
    });
  assert.equal(records[3].outcome, 'superseded');
  assert.deepEqual(score(records), {
    judged: 4,
    falsePasses: 1,
    falseFails: 1,
    pending: 0,
    byTier: {
      docs: { judged: 4, falsePasses: 1 },
      code: { judged: 0, falsePasses: 0 },
      owner: { judged: 0, falsePasses: 0 },
    },
  });
});
test('host scores close/merge from poll, not desk merged resolution', async (t) => {
  const f = await hostFixture(t);
  f.data.private = true;
  const pr = f.addPr(1, 'owner');
  await f.poll();
  assert.equal((await f.host.status()).score.pending, 1);
  pr.view.state = 'CLOSED';
  await f.poll();
  assert.equal((await f.host.status()).score.falsePasses, 1);
  assert.equal(f.outbox.open().length, 0);
});
test('live to shadow withdraws existing merge cards immediately', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  await f.poll();
  assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
  f.data.private = true;
  await f.poll();
  assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
});
test('shadow author permission follows the repository API owner on every poll', async (t) => {
  const f = await hostFixture(t);
  f.data.private = true;
  f.addPr(1, 'owner');
  await f.poll();
  f.data.owner = 'new-owner';
  const oldOwner = f.addPr(2, 'owner');
  f.addPr(3, 'new-owner');
  f.writes.length = 0;
  await f.poll();
  assert.ok(f.writes.length > 0);
  assert.ok(
    f.writes.every(
      (c) =>
        !c.args.includes(`repos/o/r/statuses/${oldOwner.view.headRefOid}`) &&
        c.args[3] !== 'repos/o/r/issues/2/comments',
    ),
  );
  assert.equal(f.reads.filter((c) => c.args.join(' ') === 'api repos/o/r').length, 2);
});
test('shadow never requests a suite and live transition resets orphan queued suite', async (t) => {
  const f = await hostFixture(t);
  f.data.private = true;
  f.enable(true);
  f.addPr(1, 'owner');
  await f.poll();
  assert.ok(!f.outbox.open().some((c) => c.kind === 'suite'));
  const record = f.record();
  record.suite = { state: 'queued' };
  f.store.save('maintainer-pr', 'o/r#1', 'o/r', record);
  f.data.private = false;
  await f.poll();
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.outbox.open().filter((c) => c.kind === 'suite' && c.mode === 'live').length, 1);
});

test('shadow to live preserves a passed suite for the identical head', async (t) => {
  const f = await hostFixture(t);
  f.data.private = true;
  f.enable(true);
  f.addPr(1, 'owner');
  await f.poll();
  const record = f.record();
  record.suite = { state: 'passed' };
  f.store.save('maintainer-pr', 'o/r#1', 'o/r', record);
  f.data.private = false;
  await f.poll();
  assert.equal(f.record().suite?.state, 'passed');
  assert.ok(!f.outbox.open().some((c) => c.kind === 'suite'));
  assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
});
