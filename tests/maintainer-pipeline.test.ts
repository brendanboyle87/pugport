import assert from 'node:assert/strict';
import test from 'node:test';
import { hostFixture } from './helpers/maintainer-host.ts';

test('live trusted docs PASS green CI creates merge card without configured suite; overlap never judges twice', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  await f.poll();
  const card = f.outbox.open().find((c) => c.kind === 'merge');
  assert.ok(card);
  assert.equal(card.tier, 'docs');
  assert.equal(card.external, false);
  assert.equal(card.baseRef, 'main');
  assert.equal(card.judgedSha, f.record().sha);
  assert.equal(f.record().phase, 'carded');
  assert.equal(f.dispatches.length, 1);
  await f.poll();
  assert.equal(f.dispatches.length, 1);
  assert.ok(f.writes.some((c) => c.args.join(' ') === 'pr edit 1 --repo o/r --add-label tier:docs'));
  assert.ok(
    f.writes.some(
      (c) => c.args[3] === `repos/o/r/statuses/${f.record().sha}` && JSON.parse(c.input!).state === 'success',
    ),
  );
});
test('configured suite runs only trusted heads; passed result rechecks and raises merge', async (t) => {
  const f = await hostFixture(t);
  f.enable(true);
  f.addPr();
  await f.poll();
  assert.equal(f.record().phase, 'awaiting-suite');
  assert.equal(f.outbox.open().filter((c) => c.kind === 'merge').length, 0);
  const suite = f.outbox.open().find((c) => c.kind === 'suite')!;
  assert.ok(suite);
  assert.equal(await f.host.resolve(suite.id, { outcome: 'suite-started' }), true);
  assert.equal(f.record().suite?.state, 'running');
  assert.equal(await f.host.resolve(suite.id, { outcome: 'suite-result', suite: f.suiteResult(f.record().sha) }), true);
  assert.equal(f.record().suite?.state, 'passed');
  assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
});
test('suite failed posts exactly one inert comment and no merge; old sha result ignored', async (t) => {
  const f = await hostFixture(t);
  f.enable(true);
  const pr = f.addPr();
  await f.poll();
  const suite = f.outbox.open().find((c) => c.kind === 'suite')!;
  const result = { outcome: 'suite-result' as const, suite: f.suiteResult(f.record().sha, 'failed') };
  assert.equal(await f.host.resolve(suite.id, result), true);
  assert.equal(await f.host.resolve(suite.id, result), false);
  await f.poll();
  const comments = f.writes.filter((c) => c.input?.includes('Remote full suite at'));
  assert.equal(comments.length, 1);
  assert.match(JSON.parse(comments[0].input!).body, /````text/);
  assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
  pr.view.headRefOid = 'e'.repeat(40);
  await f.poll();
  const newSuite = f.outbox.open().find((c) => c.kind === 'suite')!;
  assert.equal(await f.host.resolve(newSuite.id, result), false);
  assert.equal(f.record().suite?.state, 'queued');
});
test('suite error stays awaiting suite and never becomes pass', async (t) => {
  const f = await hostFixture(t);
  f.enable(true);
  f.addPr();
  await f.poll();
  const suite = f.outbox.open().find((c) => c.kind === 'suite')!;
  await f.host.resolve(suite.id, { outcome: 'suite-result', suite: f.suiteResult(f.record().sha, 'error') });
  assert.equal(f.record().suite?.state, 'error');
  assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
});
for (const scenario of ['external', 'owner-tier', 'hold', 'size:large'] as const)
  test(`${scenario} PASS produces review, never merge`, async (t) => {
    const f = await hostFixture(t);
    f.enable(true);
    const pr = f.addPr(1, 'contributor', scenario === 'owner-tier' ? 'AGENTS.md' : 'README.md');
    if (scenario === 'external') f.data.permissions.set('contributor', 'read');
    if (scenario === 'hold' || scenario === 'size:large')
      pr.view.labels = [{ name: scenario }] as typeof pr.view.labels;
    await f.poll();
    assert.ok(f.outbox.open().some((c) => c.kind === 'review'));
    assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
    assert.equal(f.dispatches.length, 1);
    if (scenario === 'external') {
      assert.ok(!f.outbox.open().some((c) => c.kind === 'suite'));
      const statuses = f.writes.filter((c) => c.args[3]?.includes('/statuses/'));
      assert.equal(JSON.parse(statuses.at(-1)!.input!).state, 'pending');
      assert.equal(JSON.parse(statuses.at(-1)!.input!).description, 'Needs the maintainer');
    }
  });
test('FAIL collaborator requests changes live; owner does not; blocked labels ruling and still tiers paths', async (t) => {
  const f = await hostFixture(t);
  f.data.verdict = 'FAIL';
  f.addPr();
  await f.poll();
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/reviews')).length, 1);
  assert.equal(JSON.parse(f.writes.find((c) => c.args[3]?.endsWith('/reviews'))!.input!).event, 'REQUEST_CHANGES');
  const g = await hostFixture(t);
  g.data.verdict = 'FAIL';
  g.addPr(1, 'owner');
  await g.poll();
  assert.equal(g.writes.filter((c) => c.args[3]?.endsWith('/reviews')).length, 0);
  const b = await hostFixture(t);
  const pr = b.addPr(1, 'contributor', 'AGENTS.md');
  pr.files[0].additions = 6001;
  await b.poll();
  assert.equal(b.dispatches.length, 0);
  assert.equal(b.record().tier?.tier, 'owner');
  assert.equal(b.record().verdict, 'blocked');
  assert.ok(b.writes.some((c) => c.args.at(-1) === 'needs-owner-ruling'));
  assert.ok(b.outbox.open().some((c) => c.kind === 'ruling'));
});
test('CI pending rechecks unchanged updatedAt without another judge; required CLA waits first', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.view.statusCheckRollup[0].status = 'IN_PROGRESS';
  pr.view.statusCheckRollup[0].conclusion = '';
  await f.poll();
  assert.equal(f.record().phase, 'awaiting-ci');
  pr.view.statusCheckRollup[0].status = 'COMPLETED';
  pr.view.statusCheckRollup[0].conclusion = 'SUCCESS';
  await f.poll();
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.record().phase, 'carded');
  const g = await hostFixture(t);
  const cla = g.addPr();
  g.data.required = ['ci', 'CLA'];
  cla.view.statusCheckRollup.push({ name: 'CLA', status: 'IN_PROGRESS', conclusion: '' });
  await g.poll();
  assert.equal(g.dispatches.length, 0);
  assert.equal(g.record().phase, 'awaiting-cla');
  assert.ok(g.writes.some((c) => c.args.at(-1) === 'needs-cla'));
  cla.view.statusCheckRollup[1] = { name: 'CLA', status: 'COMPLETED', conclusion: 'SUCCESS' };
  await g.poll();
  assert.equal(g.dispatches.length, 1);
});
test('new push supersedes old cards; closed and reopened record judged again', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  await f.poll();
  const old = f.outbox.open()[0];
  pr.view.headRefOid = 'e'.repeat(40);
  await f.poll();
  assert.equal(f.dispatches.length, 2);
  assert.ok(!f.outbox.open().some((c) => c.id === old.id));
  pr.view.state = 'CLOSED';
  await f.poll();
  assert.equal(f.record().phase, 'closed');
  assert.equal(f.outbox.open().length, 0);
  pr.view.state = 'OPEN';
  await f.poll();
  assert.equal(f.dispatches.length, 3);
});
test('draft waits and bot raises review without judge', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.view.isDraft = true;
  f.addPr(2, 'dependabot[bot]');
  await f.poll();
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.record().phase, 'queued');
  assert.ok(f.outbox.open().some((c) => c.number === 2 && c.kind === 'review'));
  pr.view.isDraft = false;
  await f.poll();
  assert.equal(f.dispatches.length, 1);
});
test('declined and merged cards stay resolved on later polls until head changes', async (t) => {
  for (const outcome of ['declined', 'merged'] as const) {
    const f = await hostFixture(t);
    const pr = f.addPr();
    await f.poll();
    const card = f.outbox.open().find((c) => c.kind === 'merge')!;
    assert.equal(await f.host.resolve(card.id, { outcome }), true);
    await f.poll();
    assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
    assert.equal(f.record().phase, 'done');
    pr.view.headRefOid = 'f'.repeat(40);
    await f.poll();
    assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
  }
});
test('a merge card is withdrawn when CI fails or hold appears on the same head', async (t) => {
  for (const condition of ['ci', 'hold']) {
    const f = await hostFixture(t);
    const pr = f.addPr();
    await f.poll();
    assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
    if (condition === 'ci') pr.view.statusCheckRollup[0].conclusion = 'FAILURE';
    else pr.view.labels = [{ name: 'hold' }] as typeof pr.view.labels;
    await f.poll();
    assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
    assert.equal(f.dispatches.length, 1);
  }
});
test('suite resolution concurrent with review publishing cannot overwrite a passed result', async (t) => {
  const f = await hostFixture(t);
  f.enable(true);
  f.addPr();
  let release!: () => void;
  f.data.writeWait = async (args) => {
    if (args[3]?.endsWith('/comments'))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  await f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  const suite = f.outbox.open().find((c) => c.kind === 'suite')!;
  await f.host.resolve(suite.id, { outcome: 'suite-result', suite: f.suiteResult(f.record().sha) });
  release();
  await f.poll();
  assert.equal(f.record().suite?.state, 'passed');
  assert.ok(f.outbox.open().some((c) => c.kind === 'merge'));
});
test('bot review decision persists and a retargeted base requires a new judge', async (t) => {
  const f = await hostFixture(t);
  f.addPr(1, 'robot[bot]');
  await f.poll();
  const card = f.outbox.open()[0];
  await f.host.resolve(card.id, { outcome: 'declined' });
  await f.poll();
  assert.equal(f.outbox.open().length, 0);
  assert.equal(f.record().phase, 'done');
  const g = await hostFixture(t);
  const pr = g.addPr();
  await g.poll();
  const old = g.outbox.open()[0];
  pr.view.baseRefName = 'release';
  await g.poll();
  assert.equal(g.dispatches.length, 2);
  assert.ok(!g.outbox.open().some((c) => c.id === old.id));
  assert.ok(g.outbox.open().every((c) => c.baseRef === 'release'));
});
test('decline during required-check lookup cannot recreate a merge card', async (t) => {
  const f = await hostFixture(t);
  f.addPr();
  await f.poll();
  const card = f.outbox.open()[0];
  let release!: () => void;
  f.data.readWait = async (args) => {
    if (args[1]?.includes('/rules/branches/'))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  const polling = f.host.poll();
  for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  await f.host.resolve(card.id, { outcome: 'declined' });
  release();
  await polling;
  assert.equal(f.outbox.open().length, 0);
  assert.equal(f.record().phase, 'done');
});
test('concurrent poll and suite failure resolution post one comment and survive a moved head', async (t) => {
  for (const moved of [false, true]) {
    const f = await hostFixture(t);
    f.enable(true);
    const pr = f.addPr();
    await f.poll();
    const card = f.outbox.open().find((c) => c.kind === 'suite')!;
    let release!: () => void;
    let waits = 0;
    f.data.writeWait = async (args) => {
      if (args[3]?.endsWith('/comments')) {
        waits++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const resolving = f.host.resolve(card.id, {
      outcome: 'suite-result',
      suite: f.suiteResult(f.record().sha, 'failed'),
    });
    for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release);
    if (moved) {
      pr.view.headRefOid = 'e'.repeat(40);
      f.data.ready = false;
    }
    const polling = f.host.poll();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(waits, 1);
    release();
    await Promise.all([resolving, polling]);
    assert.equal(f.writes.filter((c) => c.input?.includes('Remote full suite at')).length, moved ? 0 : 1);
    assert.equal(f.record().sha, moved ? 'e'.repeat(40) : card.judgedSha);
    if (moved) assert.equal(f.record().phase, 'queued');
  }
});

test('a PR into a branch other than the default branch gets a review card, never a merge card', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.view = { ...pr.view, baseRefName: 'cla-signatures' };
  await f.poll();
  assert.ok(!f.outbox.open().some((c) => c.kind === 'merge'));
  assert.ok(f.outbox.open().some((c) => c.kind === 'review'));
});

test('replacing the tier label never removes a label outside the bot allow-list', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.view = { ...pr.view, labels: [{ name: 'tier:custom' }, { name: 'tier:code' }] };
  await f.poll();
  const edit = f.writes.find((c) => c.args[0] === 'pr' && c.args[1] === 'edit');
  assert.ok(edit);
  assert.ok(!edit.args.includes('tier:custom'));
  assert.ok(edit.args.join(' ').includes('--remove-label tier:code'));
});

test('a failing tier label retries five times without repeating comment, status or review, then raises one ruling', async (t) => {
  const f = await hostFixture(t);
  f.data.verdict = 'FAIL';
  f.addPr();
  let attempts = 0;
  f.data.writeWait = async (args) => {
    if (args[0] === 'pr' && args.includes('--add-label')) {
      attempts++;
      throw new Error('Synthetic label failure');
    }
  };
  for (let i = 0; i < 8; i++) await f.poll();
  assert.equal(attempts, 5);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/reviews')).length, 1);
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/comments')).length, 1);
  assert.equal(
    f.writes.filter((c) => c.args[3]?.includes('/statuses/') && JSON.parse(c.input!).state === 'failure').length,
    1,
  );
  assert.equal(
    f.outbox.open().filter((c) => c.kind === 'ruling' && c.reasons.includes('GitHub writes keep failing')).length,
    1,
  );
  assert.equal(f.record().writesStopped, true);
  f.data.writeWait = undefined;
  f.data.prs.get(1)!.view.headRefOid = 'e'.repeat(40);
  await f.poll();
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.record().writesStopped, undefined);
  assert.equal(f.record().writeAttempts, 1);
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/reviews')).length, 2);
});

test('CLA waiting with the label present never adds it or repeats its waiting audit', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.view.labels = [{ name: 'needs-cla' }];
  f.data.required = ['CLA'];
  for (let i = 0; i < 3; i++) await f.poll();
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.writes.filter((c) => c.args.includes('needs-cla')).length, 0);
  assert.equal(f.audit.recent(100).filter((a) => a.detail === 'CLA required').length, 1);
});

test('exhausted judge budget waits before fetching PR material; draft waiting is audited once', async (t) => {
  const f = await hostFixture(t);
  for (let n = 1; n <= 5; n++) f.addPr(n);
  f.data.prs.get(5)!.view.isDraft = true;
  await f.poll();
  await f.poll();
  assert.equal(f.dispatches.length, 3);
  assert.ok(
    !f.reads.some((c) => c.args[1]?.includes('/compare/') && c.args[1].endsWith(f.data.prs.get(4)!.view.headRefOid)),
  );
  assert.equal(f.audit.recent(100).filter((a) => a.number === 5 && a.detail === 'draft').length, 1);
});

test('shadow never requests a suite; going live requests it for the trusted head', async (t) => {
  const f = await hostFixture(t);
  f.enable(true);
  f.data.private = true;
  f.addPr();
  await f.poll();
  assert.equal(f.outbox.open().filter((c) => c.kind === 'suite').length, 0);
  assert.equal(f.record().suite, undefined);
  f.data.private = false;
  await f.poll();
  assert.equal(f.outbox.open().filter((c) => c.kind === 'suite').length, 1);
});

test('a size-blocked PR consumes no judge start', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.files[0].additions = 6001;
  await f.poll();
  assert.equal(f.record().verdict, 'blocked');
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.store.get<{ judgeStarts: number[] }>('maintainer-state', 'o/r')!.judgeStarts.length, 0);
});

test('write exhaustion adds its reason to the existing blocked ruling without another card', async (t) => {
  const f = await hostFixture(t);
  f.addPr().files[0].additions = 6001;
  f.data.writeWait = async (args) => {
    if (args[0] === 'pr') throw new Error('Synthetic label failure');
  };
  await f.poll();
  const original = f.outbox.open().find((card) => card.kind === 'ruling')!;
  for (let i = 0; i < 6; i++) await f.poll();
  const rulings = f.outbox.open().filter((card) => card.kind === 'ruling');
  assert.equal(rulings.length, 1);
  assert.equal(rulings[0].id, original.id);
  assert.ok(rulings[0].reasons.includes('GitHub writes keep failing'));
});

test('a draft or bot PR never gets a pending "Review queued" status; it appears when the draft is made ready', async (t) => {
  const f = await hostFixture(t);
  const pr = f.addPr();
  pr.view.isDraft = true;
  f.addPr(2, 'dependabot[bot]');
  await f.poll();
  const statuses = () => f.writes.filter((c) => c.args[3]?.includes('/statuses/'));
  assert.equal(statuses().length, 0);
  pr.view.isDraft = false;
  await f.poll();
  assert.ok(statuses().some((c) => JSON.parse(c.input!).context === 'pugport/judge'));
});
