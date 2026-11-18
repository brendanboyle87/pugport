import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { hostFixture } from './helpers/maintainer-host.ts';
import { readHostFlag, writeHostFlag } from '../src/server/maintainer/config.ts';
import { pullFields, pullWritesPending } from '../src/server/maintainer/pipeline.ts';

test('no flag and expired lease make no gh calls; only set renews an expired host', async (t) => {
  const f = await hostFixture(t);
  await rm(f.flagFile);
  await f.poll();
  assert.deepEqual(f.reads, []);
  f.enable();
  f.advance(6 * 3600_000 + 1);
  await f.poll();
  assert.deepEqual(f.reads, []);
  f.enable();
  await f.poll();
  assert.deepEqual(f.reads, []);
  await f.host.set({ host: true, repository: 'o/r', stage: 0, hostedBy: 'desk', leaseMinutes: 360 });
  await f.poll();
  assert.ok(f.reads.length);
  assert.equal((await f.host.status()).githubHost, true);
});
test('first poll queues open PRs, skips old issues, overlaps dedupe and stores overflow before cursor', async (t) => {
  const f = await hostFixture(t);
  f.data.ready = false;
  for (let n = 1; n <= 25; n++) f.addPr(n);
  const old = f.addIssue();
  old.updatedAt = new Date(f.now() - 86400_000).toISOString();
  await f.poll();
  assert.equal(f.store.list('maintainer-pr', 'o/r', 100).length, 25);
  assert.equal(f.store.list('maintainer-issue', 'o/r').length, 0);
  assert.equal(f.reads.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view').length, 20);
  assert.equal(f.record(25).phase, 'queued');
  assert.deepEqual(f.reads[0].args, [
    'api',
    'rate_limit',
    '--jq',
    '{remaining:.resources.core.remaining,reset:.resources.core.reset}',
  ]);
  assert.deepEqual(f.reads[1].args, ['api', 'repos/o/r']);
  assert.deepEqual(f.reads[2].args, ['label', 'list', '--repo', 'o/r', '--json', 'name', '--limit', '200']);
  assert.deepEqual(f.reads[3].args, [
    'pr',
    'list',
    '--repo',
    'o/r',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    pullFields,
  ]);
  f.advance(120_000);
  f.reads.length = 0;
  await f.poll();
  assert.equal(f.store.list('maintainer-pr', 'o/r', 100).length, 25);
  const views = f.reads.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view');
  assert.deepEqual(
    views.slice(0, 5).map((c) => c.args[2]),
    ['21', '22', '23', '24', '25'],
  );
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.audit.recent(200).filter((a) => a.detail === 'noToollessExecutor').length, 2);
});

test('unchanged hosting renews the lease without cancelling an active judge', async (t) => {
  const f = await hostFixture(t);
  const request = {
    host: true as const,
    repository: 'o/r',
    stage: 0,
    hostedBy: 'desk',
    leaseMinutes: 360,
    gates: undefined,
  };
  await f.host.set(request);
  await f.poll();
  f.addPr();
  let release!: () => void;
  f.data.wait = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  const expiry = Date.parse(readHostFlag(f.flagFile).leaseUntil!);
  f.advance(30 * 60_000);
  await f.host.set(request);
  assert.equal(f.cancelled.length, 0);
  assert.equal(f.record().phase, 'judging');
  assert.equal(Date.parse(readHostFlag(f.flagFile).leaseUntil!), expiry + 30 * 60_000);
  release();
  await f.poll();
});

test('renewing the saved flag after restart starts polling', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await hostFixture(t);
  writeHostFlag(f.flagFile, { ...readHostFlag(f.flagFile), hostedBy: 'desk' });
  let polls = 0;
  t.mock.method(f.host, 'poll', async () => {
    polls++;
  });
  await f.host.set({
    host: true,
    repository: 'o/r',
    stage: 0,
    hostedBy: 'desk',
    leaseMinutes: 360,
    requiredChecks: ['ci'],
    suiteConfigured: false,
  });
  assert.equal(polls, 1);
  t.mock.timers.tick(120_000);
  assert.equal(polls, 2);
});
test('rate 499 calls only rate_limit, backs off until reset', async (t) => {
  const f = await hostFixture(t);
  f.data.rate = 499;
  await f.poll();
  await f.poll();
  assert.equal(f.reads.length, 1);
  assert.ok((await f.host.status()).backoffUntil);
  f.advance(60_001);
  f.data.rate = 5000;
  await f.poll();
  assert.ok(f.reads.length > 1);
});
test('slow judge does not block polling; host false aborts and forbids later writes', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  let release!: () => void;
  f.data.wait = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  f.advance(120_000);
  await f.host.poll();
  const before = f.writes.length;
  await f.host.set({ host: false });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, before);
  assert.ok(f.cancelled.length);
  assert.equal(f.record().phase, 'queued');
});
test('judge budget fourth waits, newest head wins, budget summary is one per day', async (t) => {
  const f = await hostFixture(t);
  for (let n = 1; n <= 5; n++) f.addPr(n);
  await f.poll();
  assert.equal(f.dispatches.length, 3);
  assert.equal(f.record(4).phase, 'queued');
  assert.equal(f.outbox.open().filter((c) => c.title.startsWith('Daily maintenance')).length, 1);
  const fourth = f.data.prs.get(4)!;
  fourth.view.headRefOid = 'e'.repeat(40);
  await f.poll();
  fourth.view.headRefOid = 'f'.repeat(40);
  await f.poll();
  assert.equal(f.dispatches.length, 3);
  f.advance(3600_001);
  await f.poll();
  assert.equal(f.record(4).sha, 'f'.repeat(40));
  assert.equal(f.record(4).verdict, 'pass');
  assert.equal(f.dispatches.filter((d) => d.title.endsWith('PR #4')).length, 1);
});
test('three invalid judges pause once; only resumeJudge clears pause', async (t) => {
  const f = await hostFixture(t);
  f.data.verdict = 'INVALID';
  for (let n = 1; n <= 4; n++) f.addPr(n);
  await f.poll();
  assert.equal(f.dispatches.length, 3);
  assert.equal((await f.host.status()).judgingPaused, true);
  const pause = f.outbox.open().find((c) => c.title.startsWith('Judging paused'))!;
  assert.ok(pause);
  await f.host.resolve(pause.id, { outcome: 'declined' });
  f.advance(3600_001);
  await f.poll();
  assert.equal(f.dispatches.length, 3);
  f.host.resumeJudge();
  f.data.verdict = 'PASS';
  await f.poll();
  assert.equal(f.dispatches.length, 4);
});
test('unknown visibility retains mode and prevents writes, including active judge', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  await f.poll();
  const count = f.writes.length;
  f.data.private = undefined;
  await f.poll();
  assert.equal((await f.host.status()).mode, 'live');
  assert.equal(f.writes.length, count);
});
test('two 403 pause writes for an hour, replay verifies head and drops moved head', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  f.data.forbidden = 2;
  await f.poll();
  assert.equal(f.record().phase, 'write-pending');
  assert.match((await f.host.status()).ready.problem!, /Writes paused/);
  const before = f.writes.length;
  await f.poll();
  assert.equal(f.writes.length, before);
  f.advance(3600_001);
  await f.poll();
  assert.equal(pullWritesPending(f.record()), false);
  assert.equal(f.dispatches.length, 1);
  const g = await hostFixture(t);
  const pr = g.addPr();
  g.data.token = false;
  await g.poll();
  assert.equal(g.record().phase, 'write-pending');
  pr.view.headRefOid = 'e'.repeat(40);
  g.data.token = true;
  await g.poll();
  assert.equal(g.dispatches.length, 2);
  assert.equal(g.record().sha, 'e'.repeat(40));
  assert.ok(g.writes.filter((c) => c.input?.includes('## PugPort')).every((c) => c.input!.includes('eeeeeee')));
});
test('transient repository read failure does not cancel a slow judge', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  let release!: () => void;
  f.data.wait = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  f.data.repoError = true;
  const before = f.writes.length;
  await f.host.poll();
  release();
  await f.poll();
  assert.ok(f.writes.length > before);
  assert.equal(f.cancelled.length, 0);
});
test('full discovery page grows persisted fetch window; row 101 is eventually saved', async (t) => {
  const f = await hostFixture(t);
  f.data.ready = false;
  for (let n = 1; n <= 105; n++) f.addPr(n);
  await f.poll();
  assert.equal(f.store.list('maintainer-pr', 'o/r', 200).length, 100);
  f.advance(120_000);
  await f.poll();
  assert.equal(f.store.list('maintainer-pr', 'o/r', 200).length, 105);
  assert.ok(f.reads.some((c) => c.args[0] === 'pr' && c.args[1] === 'list' && c.args.includes('200')));
});
test('judge daily budget stops at twenty even with hourly room and survives host state', async (t) => {
  const f = await hostFixture(t);
  for (let n = 1; n <= 22; n++) f.addPr(n);
  for (let hour = 0; hour < 8; hour++) {
    f.enable();
    await f.poll();
    f.advance(3600_001);
  }
  assert.equal(f.dispatches.length, 20);
  assert.equal(Array.from({ length: 22 }, (_, i) => f.record(i + 1)).filter((r) => r.phase === 'queued').length, 2);
  assert.equal(f.store.get<{ judgeStarts: number[] }>('maintainer-state', 'o/r')!.judgeStarts.length, 20);
});
test('one failed queued status never replaces the published final status on the next poll', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  f.data.forbidden = 1;
  await f.poll();
  const statuses = () => f.writes.filter((c) => c.args[3]?.includes('/statuses/'));
  assert.equal(JSON.parse(statuses().at(-1)!.input!).state, 'success');
  const count = statuses().length;
  await f.poll();
  assert.equal(statuses().length, count);
});
test('close aborts triage and no comment is written after cancellation', async (t) => {
  const f = await hostFixture(t);
  f.addIssue();
  let release!: () => void;
  f.data.wait = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  await f.host.close();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, 0);
  assert.ok(f.cancelled.length);
});
test('polling during an active judge does not retry a failed queued status or overwrite the result', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  f.data.forbidden = 1;
  let release!: () => void;
  f.data.wait = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  const count = f.writes.length;
  await f.host.poll();
  assert.equal(f.writes.length, count);
  release();
  await f.poll();
  assert.equal(f.record().verdict, 'pass');
  assert.equal(JSON.parse(f.writes.filter((c) => c.args[3]?.includes('/statuses/')).at(-1)!.input!).state, 'success');
});
test('write-pending replay needs no executor and trust lookup is cached for one hour', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  f.data.token = false;
  await f.poll();
  f.data.token = true;
  f.data.ready = false;
  await f.poll();
  assert.equal(pullWritesPending(f.record()), false);
  assert.equal(f.dispatches.length, 1);
  f.data.ready = true;
  const second = f.addPr(2);
  await f.poll();
  const permissionCalls = () => f.reads.filter((c) => c.args[1] === 'repos/o/r/collaborators/contributor/permission');
  assert.equal(permissionCalls().length, 1);
  f.advance(3600_001);
  second.view.headRefOid = 'e'.repeat(40);
  await f.poll();
  assert.equal(permissionCalls().length, 2);
  assert.deepEqual(permissionCalls()[0].args, [
    'api',
    'repos/o/r/collaborators/contributor/permission',
    '--jq',
    '.permission',
  ]);
});
test('rate backoff leaves a running triage alive', async (t) => {
  const f = await hostFixture(t);
  f.addIssue();
  let release!: () => void;
  f.data.wait = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  f.data.rate = 499;
  const before = f.reads.length;
  await f.host.poll();
  release();
  await f.poll();
  assert.ok(f.reads.length > before + 1);
  assert.ok(f.writes.some((c) => c.args[3]?.endsWith('/comments')));
  assert.equal(f.cancelled.length, 0);
});

test('host false is durable before close waits for active work', async (t) => {
  const f = await hostFixture(t);
  let release!: () => void;
  f.host.close = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const stopping = f.host.set({ host: false });
  assert.equal(readHostFlag(f.flagFile).host, false);
  assert.ok(release);
  release();
  await stopping;
  // Restore a nonblocking close for fixture cleanup.
  f.host.close = async () => {};
});

test('one unreadable PR is audited once while later PRs and issues proceed and cursors use remote dates', async (t) => {
  const f = await hostFixture(t);
  const first = f.addPr(1),
    second = f.addPr(2);
  const issue = f.addIssue();
  first.updatedAt = new Date(f.now() - 5 * 60_000).toISOString();
  second.updatedAt = new Date(f.now() - 3 * 60_000).toISOString();
  f.data.readWait = async (args) => {
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '1') throw new Error('Synthetic read failure');
  };
  await f.poll();
  assert.equal(f.record(2).verdict, 'pass');
  assert.equal(f.issueRecord(issue.number).done?.comment, true);
  assert.equal(f.store.get<any>('maintainer-state', 'o/r').cursor, second.updatedAt);
  f.advance(120_000);
  await f.poll();
  const search = `updated:>=${new Date(Date.parse(second.updatedAt) - 600_000).toISOString()}`;
  assert.ok(f.reads.some((c) => c.args[0] === 'pr' && c.args.includes(search)));
  assert.equal(
    f.audit.recent(200).filter((a) => a.number === 1 && a.detail?.startsWith('PR processing failed')).length,
    1,
  );
  f.data.prs.clear();
  await f.poll();
  assert.equal(f.store.get<any>('maintainer-state', 'o/r').cursor, second.updatedAt);
});

test('a draft is audited once and never attempts a judge-status write', async (t) => {
  const f = await hostFixture(t);
  f.data.token = false;
  f.addPr().view.isDraft = true;
  for (let i = 0; i < 4; i++) await f.poll();
  assert.equal(f.audit.recent(200).filter((a) => a.detail === 'judge-status write refused').length, 0);
  assert.equal(f.audit.recent(200).filter((a) => a.detail === 'draft').length, 1);
  assert.equal(f.dispatches.length, 0);
});

test('malformed list rows are skipped individually without losing healthy PRs or issues', async (t) => {
  const f = await hostFixture(t);
  f.addPr(1).view.author = null as never;
  const good = f.addPr(2);
  f.addIssue(10).author = null as never;
  f.addIssue(11);
  for (let i = 0; i < 2; i++) await f.poll();
  assert.equal(f.record(1), undefined);
  assert.equal(f.issueRecord(10), undefined);
  assert.equal(f.record(2).verdict, 'pass');
  assert.equal(f.issueRecord(11).done?.comment, true);
  assert.equal(f.store.get<any>('maintainer-state', 'o/r').cursor, good.updatedAt);
  assert.equal(f.audit.recent(200).filter((a) => a.number === 1 && a.action === 'error').length, 1);
  assert.equal(f.audit.recent(200).filter((a) => a.number === 10 && a.action === 'error').length, 1);
});

test('an hourly sweep picks up a PR the search index returned late, without moving the cursor', async (t) => {
  const f = await hostFixture(t);
  f.data.honorSearch = true;
  f.addPr(1);
  await f.poll();
  f.advance(5 * 60_000);
  const late = f.addPr(2);
  late.updatedAt = new Date(f.now() - 30 * 60_000).toISOString();
  await f.poll();
  assert.equal(f.store.get('maintainer-pr', 'o/r#2'), undefined);
  f.advance(61 * 60_000);
  await f.poll();
  assert.ok(f.store.get('maintainer-pr', 'o/r#2'));
  const lists = f.reads.filter((c) => c.args[0] === 'pr' && c.args[1] === 'list');
  assert.ok(!lists.at(-1)!.args.includes('--search'));
});
