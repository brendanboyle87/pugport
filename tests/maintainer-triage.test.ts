import assert from 'node:assert/strict';
import test from 'node:test';
import { hostFixture } from './helpers/maintainer-host.ts';
import { fakeGh } from './helpers/maintainer.ts';
import { parseTriage, findDuplicates, renderSecurityComment } from '../src/server/maintainer/issue-triage.ts';
import { allowedLabels } from '../src/server/maintainer/labels.ts';

const triage = {
  type: 'bug',
  labels: ['bug'],
  keywords: ['widget'],
  missingInfo: ['version'],
  looksLikeSecurity: false,
};
test('strict JSON triage parser supports wrappers and braces inside strings, rejects extras/enums/caps', () => {
  for (const text of [
    JSON.stringify(triage),
    '```json\n' + JSON.stringify(triage) + '\n```',
    'prose ' + JSON.stringify(triage) + ' tail',
  ])
    assert.deepEqual(parseTriage(text), triage);
  assert.equal(parseTriage(JSON.stringify({ ...triage, type: 'evil' })), undefined);
  assert.equal(parseTriage(JSON.stringify({ ...triage, extra: true })), undefined);
  assert.equal(parseTriage(JSON.stringify({ ...triage, labels: Array(5).fill('bug') })), undefined);
  assert.equal(parseTriage('{bad}'), undefined);
  assert.equal(parseTriage(JSON.stringify({ ...triage, missingInfo: ['} quote "'] }))?.missingInfo[0], '} quote "');
  assert.deepEqual(allowedLabels(['bug', 'duplicate', 'Wontfix', 'good first issue', 'evil', 'BUG']), [
    'bug',
    'good first issue',
  ]);
});
test('duplicate query allows only safe keywords, filters repository, self, top three; titles inert', async () => {
  const fake = fakeGh(() => [
    { number: 1, title: 'self', state: 'OPEN', url: 'https://github.com/o/r/issues/1' },
    { number: 2, title: 'other', state: 'OPEN', url: 'https://github.com/other/private/issues/2' },
    ...[3, 4, 5, 6].map((number) => ({
      number,
      title: '@someone [evil](https://evil.invalid) #1',
      state: 'OPEN',
      url: `https://github.com/o/r/issues/${number}`,
    })),
  ]);
  const result = await findDuplicates(fake.gh, 'o/r', 1, [
    'widget',
    'repo:other/private',
    'bad\nquery',
    'xy-z',
    'x'.repeat(41),
  ]);
  assert.deepEqual(
    result.map((r) => r.number),
    [3, 4, 5],
  );
  assert.deepEqual(fake.calls[0].args, [
    'issue',
    'list',
    '--repo',
    'o/r',
    '--state',
    'all',
    '--search',
    'widget xy-z in:title',
    '--limit',
    '6',
    '--json',
    'number,title,state,url',
  ]);
  await findDuplicates(fake.gh, 'o/r', 1, ['repo:other/private']);
  assert.equal(fake.calls.length, 1);
});
test('security uses fixed comment, no labels or duplicates, and security card', async (t) => {
  const f = await hostFixture(t);
  f.addIssue();
  f.data.triage = JSON.stringify({ ...triage, looksLikeSecurity: true });
  await f.poll();
  assert.equal(f.dispatches.length, 1);
  assert.ok(f.outbox.open().some((c) => c.kind === 'security'));
  assert.equal(f.writes.filter((c) => c.args[0] === 'issue').length, 0);
  assert.equal(f.reads.filter((c) => c.args.includes('number,title,state,url')).length, 0);
  const body = JSON.parse(f.writes.find((c) => c.args[3]?.includes('/comments'))!.input!).body;
  assert.equal(body, renderSecurityComment(f.issueRecord().runId!));
});
test('normal triage labels + inert comment, close card for open duplicate or hint; shadow writes none', async (t) => {
  for (const shadow of [false, true]) {
    const f = await hostFixture(t);
    f.data.private = shadow;
    f.addIssue();
    f.data.duplicates = [
      { number: 12, title: '@owner ``` #9', state: 'OPEN', url: 'https://github.com/o/r/issues/12' },
    ];
    await f.poll();
    assert.ok(f.outbox.open().some((c) => c.kind === 'close'));
    if (shadow) assert.equal(f.writes.length, 0);
    else {
      assert.deepEqual(f.writes[0].args, ['issue', 'edit', '10', '--repo', 'o/r', '--add-label', 'bug']);
      assert.match(JSON.parse(f.writes[1].input!).body, /````text\n#12 \(@owner ''' #9\)/);
    }
  }
});
test('owner, bot, process label and own marker skip; forged marker does not', async (t) => {
  const f = await hostFixture(t);
  f.addIssue(10, 'owner');
  f.addIssue(11, 'robot[bot]');
  f.addIssue(12).labels = [{ name: 'claimed' }];
  f.addIssue(13);
  f.addIssue(14);
  const marker = '<!-- pugport-maintainer run=it-20261028-12345678 -->';
  f.data.comments.set(13, [{ id: 1, body: marker, user: { login: 'synthetic[bot]' } }]);
  f.data.comments.set(14, [{ id: 2, body: marker, user: { login: 'attacker' } }]);
  await f.poll();
  assert.equal(f.dispatches.length, 1);
  assert.ok(f.dispatches[0].title.endsWith('#14'));
});
test('triage retries exactly once with JSON instruction then records invalid without write', async (t) => {
  const f = await hostFixture(t);
  f.addIssue();
  f.data.triage = 'not JSON';
  await f.poll();
  assert.equal(f.dispatches.length, 2);
  assert.ok(f.dispatches[1].prompt.endsWith('Return only the JSON object.'));
  assert.equal(f.writes.length, 0);
  assert.equal(f.issueRecord().phase, 'done');
  assert.ok(f.audit.recent().some((a) => a.detail === 'invalid triage'));
});
test('triage hourly and per-author daily budgets queue overflow, one daily summary', async (t) => {
  const f = await hostFixture(t);
  for (let n = 10; n < 18; n++) f.addIssue(n, n < 13 ? 'same' : `user-${n}`);
  await f.poll();
  assert.equal(f.dispatches.length, 6);
  assert.equal(f.issueRecord(12).phase, 'queued');
  assert.equal(f.outbox.open().filter((c) => c.title.startsWith('Daily maintenance')).length, 1);
  f.advance(3600_001);
  await f.poll();
  assert.equal(f.dispatches.length, 7);
  assert.equal(f.issueRecord(12).phase, 'queued');
});
test('queued triage refreshes human process labels before retrying', async (t) => {
  const f = await hostFixture(t);
  f.data.ready = false;
  const issue = f.addIssue();
  await f.poll();
  issue.labels = [{ name: 'owner-ruled' }];
  f.data.ready = true;
  await f.poll();
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.writes.length, 0);
});
test('triage daily cap thirty persists despite hourly room', async (t) => {
  const f = await hostFixture(t);
  for (let n = 10; n < 41; n++) f.addIssue(n, `reporter-${n}`);
  for (let hour = 0; hour < 6; hour++) {
    f.enable();
    await f.poll();
    f.advance(3600_001);
  }
  assert.equal(f.dispatches.length, 30);
  assert.equal(f.issueRecord(40).phase, 'queued');
});
test('outbound model secrets are withheld and audit contains only hashes, never bodies', async (t) => {
  const f = await hostFixture(t);
  f.addIssue();
  const secret = 'ghp_' + 'x'.repeat(30);
  f.data.triage = JSON.stringify({ ...triage, missingInfo: [secret] });
  await f.poll();
  assert.ok(f.writes.every((c) => !c.input?.includes(secret)));
  const lines = f.audit.recent(100);
  assert.ok(lines.some((a) => a.detail?.startsWith('body sha256=')));
  assert.ok(!JSON.stringify(lines).includes(secret));
  assert.ok(!JSON.stringify(lines).includes('Thanks for the report'));
});

test('twelve failing issue labels cannot starve comments and each issue stops after five attempts', async (t) => {
  const f = await hostFixture(t);
  for (let n = 10; n < 22; n++) f.addIssue(n, `reporter-${n}`);
  const attempts = new Map<number, number>();
  f.data.writeWait = async (args) => {
    if (args[0] === 'issue' && args[1] === 'edit') {
      const number = Number(args[2]);
      attempts.set(number, (attempts.get(number) ?? 0) + 1);
      throw new Error('Synthetic label failure');
    }
  };
  await f.poll();
  f.advance(3600_001);
  await f.poll();
  await f.poll();
  assert.equal(f.dispatches.length, 12);
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/comments')).length, 12);
  for (let i = 0; i < 10; i++) await f.poll();
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/comments')).length, 12);
  for (let n = 10; n < 22; n++) {
    assert.equal(attempts.get(n), 5);
    assert.equal(f.issueRecord(n).phase, 'done');
  }
  assert.equal(
    f.audit.recent(200).filter((a) => a.detail === 'GitHub writes keep failing; issue retries exhausted').length,
    12,
  );
});

test('triage skips missing labels and shares the repository label cache for one hour', async (t) => {
  const f = await hostFixture(t);
  f.data.labels = f.data.labels.filter((name) => name !== 'bug');
  f.addIssue(10, 'reporter-a');
  f.addIssue(11, 'reporter-b');
  await f.poll();
  assert.equal(f.writes.filter((c) => c.args[0] === 'issue').length, 0);
  assert.equal(f.writes.filter((c) => c.args[3]?.endsWith('/comments')).length, 2);
  assert.equal(f.reads.filter((c) => c.args[0] === 'label' && c.args[1] === 'list').length, 1);
  f.advance(3600_001);
  f.addIssue(12, 'reporter-c');
  await f.poll();
  assert.equal(f.reads.filter((c) => c.args[0] === 'label' && c.args[1] === 'list').length, 2);
});
