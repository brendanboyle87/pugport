import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAY,
  applyCommand,
  claimStatus,
  needsFindingReminder,
  parseCommand,
  readClaim,
  referencedIssues,
  runLifecycle,
  type Api,
  type Claim,
  type Comment,
  type Issue,
} from '../scripts/issue-lifecycle.mjs';

const repo = 'pugport/pugport';
process.env.LIFECYCLE_MAINTAINER = 'Yutong43';
const at = '2026-10-01T00:00:00Z';
const start = Date.parse(at);
const empty = (): Claim => ({ claimer: null, renewedAt: null, releaseLogins: [], lastCommentId: 0 });
const held = (): Claim => ({ ...empty(), claimer: 'alice', renewedAt: at });
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const userComment = (id: number, login: string, body: string, time = at): Comment => ({
  id,
  user: { login, type: 'User' },
  body,
  created_at: time,
});
const record = (claim: Claim, id = 100): Comment => ({
  id,
  user: bot,
  body: `<!-- pugport-claim-v1 ${JSON.stringify(claim)} -->`,
  created_at: at,
});
const issue = (overrides: Partial<Issue> = {}): Issue => ({
  number: 1,
  state: 'open',
  created_at: at,
  labels: [],
  assignees: [],
  ...overrides,
});

test('only standalone claim commands are accepted; text is never evaluated', () => {
  assert.equal(parseCommand(' /claim\n'), 'claim');
  assert.equal(parseCommand('/unclaim'), 'unclaim');
  assert.equal(parseCommand('/renew'), 'renew');
  for (const text of ['/claim && curl example.com', 'please /claim', '`/claim`', '/claim\n/renew', '/CLAIM']) {
    assert.equal(parseCommand(text), null);
  }
});

test('claims refuse competing users, renew explicitly, and restrict release', () => {
  const first = applyCommand(empty(), 'claim', 'alice', 'Yutong43', at, false);
  assert.equal(first.claim.claimer, 'alice');
  assert.match(first.message, /confirmed/);
  assert.equal(applyCommand(first.claim, 'claim', 'bob', 'Yutong43', at, false).claim, first.claim);
  assert.match(applyCommand(first.claim, 'unclaim', 'bob', 'Yutong43', at, false).message, /refused/);
  assert.match(applyCommand(first.claim, 'renew', 'bob', 'Yutong43', at, false).message, /refused/);
  const renewal = new Date(start + 5 * DAY).toISOString();
  assert.equal(applyCommand(first.claim, 'renew', 'alice', 'Yutong43', renewal, false).claim.renewedAt, renewal);
  for (const actor of ['alice', 'yutong43']) {
    const release = applyCommand(first.claim, 'unclaim', actor, 'Yutong43', at, false).claim;
    assert.equal(release.claimer, null);
    assert.deepEqual(release.releaseLogins, ['alice']);
  }
  assert.equal(applyCommand(first.claim, 'claim', 'alice', 'Yutong43', renewal, false).claim.renewedAt, at);
});

test('lease warns at six days, expires at seven, and an open PR preserves it', () => {
  assert.equal(claimStatus(held(), start + 6 * DAY - 1, false), 'keep');
  assert.equal(claimStatus(held(), start + 6 * DAY, false), 'warn');
  assert.equal(claimStatus(held(), start + 7 * DAY, false), 'release');
  assert.equal(claimStatus(held(), start + 30 * DAY, true), 'keep');
  const expiredAt = new Date(start + 7 * DAY).toISOString();
  assert.equal(applyCommand(held(), 'claim', 'bob', 'Yutong43', expiredAt, false).claim.claimer, 'bob');
  assert.equal(applyCommand(held(), 'claim', 'bob', 'Yutong43', expiredAt, true).claim.claimer, 'alice');
  assert.match(applyCommand(held(), 'renew', 'alice', 'Yutong43', expiredAt, false).message, /refused/);
});

test('PR references are local, deduplicated, and safe integers', () => {
  assert.deepEqual(
    referencedIssues(
      'Closes #12; #12 #13 other/repo#99 abc#88 https://github.com/pugport/pugport/issues/14 ' +
        'https://github.com/other/repo/issues/15 #999999999999999999999',
      repo,
    ),
    [12, 13, 14],
  );
  assert.deepEqual(referencedIssues(null, repo), []);
});

test('claim state trusts only bot records and rejects corrupted state', () => {
  assert.equal(readClaim([{ ...record(held()), user: { login: 'eve', type: 'User' } }]).claim.claimer, null);
  assert.equal(readClaim([record(held())]).claim.claimer, 'alice');
  assert.throws(() => readClaim([{ ...record(held()), body: '<!-- pugport-claim-v1 {} -->' }]), /Invalid/);
  assert.throws(() => readClaim([record({ ...held(), renewedAt: 'invalid' })]), /Invalid/);
});

test('finding reminders wait 14 days, repeat weekly, and never target claimed or closed issues', () => {
  const finding = issue({ labels: [{ name: 'finding' }] });
  assert.equal(needsFindingReminder(finding, empty(), start + 14 * DAY - 1), false);
  assert.equal(needsFindingReminder(finding, empty(), start + 14 * DAY), true);
  assert.equal(needsFindingReminder(finding, held(), start + 20 * DAY), false);
  assert.equal(needsFindingReminder({ ...finding, state: 'closed' }, empty(), start + 20 * DAY), false);
  assert.equal(
    needsFindingReminder({ ...finding, labels: [...finding.labels, { name: 'claimed' }] }, empty(), start + 20 * DAY),
    false,
  );
  assert.equal(
    needsFindingReminder(finding, empty(), start + 20 * DAY, new Date(start + 14 * DAY).toISOString()),
    false,
  );
  assert.equal(
    needsFindingReminder(finding, empty(), start + 21 * DAY, new Date(start + 14 * DAY).toISOString()),
    true,
  );
});

class FakeGitHub implements Api {
  repo = repo;
  issues: Issue[] = [issue()];
  comments: Comment[] = [];
  prs: { number: number; title: string; body: string }[] = [];
  writes: { method: string; path: string; body: any }[] = [];
  nextId = 1000;
  failAssignment = false;
  failNotice = false;
  async list(path: string): Promise<any[]> {
    if (path.startsWith('/pulls?')) return structuredClone(this.prs);
    if (path.startsWith('/issues?')) return structuredClone(this.issues);
    if (path === '/issues/1/comments') return structuredClone(this.comments);
    throw new Error(`Unexpected list ${path}`);
  }
  async request(method: string, path: string, body: any): Promise<any> {
    this.writes.push({ method, path, body });
    if (path === '/issues/1/comments') {
      if (this.failNotice && body.body.includes('pugport-notice:')) {
        this.failNotice = false;
        throw new Error('Synthetic notice failure');
      }
      const comment = { id: this.nextId++, user: bot, body: body.body, created_at: new Date(this.now).toISOString() };
      this.comments.push(comment);
      return structuredClone(comment);
    }
    if (path.startsWith('/issues/comments/')) {
      const target = this.comments.find((comment) => comment.id === Number(path.split('/').at(-1)))!;
      target.body = body.body;
      return structuredClone(target);
    }
    const current = this.issues[0];
    if (path === '/issues/1/labels') {
      for (const name of body.labels)
        if (!current.labels.some((label) => label.name === name)) current.labels.push({ name });
      return current.labels;
    }
    if (path.startsWith('/issues/1/labels/')) {
      const name = decodeURIComponent(path.split('/').at(-1)!);
      current.labels = current.labels.filter((label) => label.name !== name);
      return;
    }
    if (path === '/issues/1/assignees') {
      if (this.failAssignment) {
        this.failAssignment = false;
        throw new Error('Synthetic assignment failure');
      }
      if (method === 'DELETE')
        current.assignees = current.assignees.filter((user) => !body.assignees.includes(user.login));
      else
        for (const login of body.assignees)
          if (!current.assignees.some((user) => user.login === login)) current.assignees.push({ login });
      return structuredClone(current);
    }
    throw new Error(`Unexpected mutation ${method} ${path}`);
  }
  now = start;
  async run(now = this.now) {
    this.now = now;
    await runLifecycle(this, { repository: { full_name: repo } }, now);
  }
}

test('reconciliation serializes competing claims and replay does not duplicate confirmations', async () => {
  const api = new FakeGitHub();
  api.comments = [userComment(2, 'bob', '/claim'), userComment(1, 'alice', '/claim')];
  await api.run();
  assert.equal(readClaim(api.comments).claim.claimer, 'alice');
  assert.deepEqual(api.issues[0].assignees, [{ login: 'alice' }]);
  assert.ok(api.issues[0].labels.some((label) => label.name === 'claimed'));
  assert.ok(api.comments.some((comment) => comment.body.includes('Claim refused: @alice')));
  const count = api.comments.length;
  await api.run();
  assert.equal(api.comments.length, count);
});

test('warnings deduplicate, renewal resets expiry, and automatic release preserves unrelated assignees', async () => {
  const api = new FakeGitHub();
  api.comments = [userComment(1, 'alice', '/claim')];
  api.issues[0].assignees = [{ login: 'reviewer' }];
  await api.run();
  await api.run(start + 6 * DAY);
  await api.run(start + 6 * DAY + 1000);
  assert.equal(api.comments.filter((comment) => comment.body.includes('pugport-notice:warn-')).length, 1);
  api.comments.push(userComment(2000, 'alice', '/renew', new Date(start + 6 * DAY).toISOString()));
  await api.run(start + 7 * DAY);
  assert.equal(readClaim(api.comments).claim.claimer, 'alice');
  await api.run(start + 13 * DAY);
  assert.equal(readClaim(api.comments).claim.claimer, null);
  assert.ok(!api.issues[0].labels.some((label) => label.name === 'claimed'));
  assert.deepEqual(api.issues[0].assignees, [{ login: 'reviewer' }]);
});

test('closed issues do not expire an existing claim', async () => {
  const api = new FakeGitHub();
  api.issues[0] = issue({ state: 'closed', labels: [{ name: 'claimed' }], assignees: [{ login: 'alice' }] });
  api.comments = [record(held())];
  await api.run(start + 8 * DAY);
  assert.equal(readClaim(api.comments).claim.claimer, 'alice');
  assert.deepEqual(api.issues[0].assignees, [{ login: 'alice' }]);
  assert.equal(api.comments.filter((comment) => comment.body.includes('pugport-notice:release-')).length, 0);
});

test('failed confirmations and expiry notices are retried on the next run', async () => {
  for (const expiry of [false, true]) {
    const api = new FakeGitHub();
    api.comments = expiry ? [record(held())] : [userComment(1, 'alice', '/claim')];
    if (expiry) {
      api.issues[0].labels = [{ name: 'claimed' }];
      api.issues[0].assignees = [{ login: 'alice' }];
    }
    api.failNotice = true;
    const now = expiry ? start + 8 * DAY : start;
    await assert.rejects(api.run(now), /Synthetic notice failure/);
    await api.run(now);
    const marker = expiry ? 'pugport-notice:release-' : 'pugport-notice:command-1';
    assert.equal(api.comments.filter((comment) => comment.body.includes(marker)).length, 1);
  }
});

test('a broken issue does not prevent later issues from being reconciled', async () => {
  const api = new FakeGitHub();
  api.issues = [issue(), issue({ number: 2 })];
  api.comments = [userComment(1, 'alice', '/claim')];
  const list = api.list.bind(api);
  api.list = async (path) => {
    if (path.startsWith('/issues?')) return [...api.issues].reverse();
    if (path === '/issues/2/comments') throw new Error('Synthetic issue failure');
    return list(path);
  };
  await assert.rejects(api.run(), /Synthetic issue failure/);
  assert.ok(api.comments.some((comment) => comment.body.includes('pugport-notice:command-1')));
});

test('multiple open PRs preserve in-flight and claim until the last reference disappears', async () => {
  const api = new FakeGitHub();
  api.comments = [record(held())];
  api.issues[0].labels = [{ name: 'claimed' }];
  api.issues[0].assignees = [{ login: 'alice' }];
  api.prs = [
    { number: 2, title: 'Fix #1', body: '' },
    { number: 3, title: 'Fix', body: 'Closes #1' },
  ];
  await api.run(start + 10 * DAY);
  assert.ok(api.issues[0].labels.some((label) => label.name === 'in-flight'));
  api.prs.pop();
  await api.run(start + 11 * DAY);
  assert.ok(api.issues[0].labels.some((label) => label.name === 'in-flight'));
  api.prs[0].title = 'Reference removed';
  await api.run(start + 12 * DAY);
  assert.ok(!api.issues[0].labels.some((label) => label.name === 'in-flight'));
  assert.equal(readClaim(api.comments).claim.claimer, null);
});

test('batched transfers clean every previous claimer and partial assignment failures recover', async () => {
  const api = new FakeGitHub();
  api.comments = [userComment(1, 'alice', '/claim')];
  await api.run();
  api.comments.push(
    userComment(2001, 'Yutong43', '/unclaim'),
    userComment(2002, 'bob', '/claim'),
    userComment(2003, 'bob', '/unclaim'),
    userComment(2004, 'carol', '/claim'),
  );
  api.failAssignment = true;
  await assert.rejects(api.run(), /Synthetic assignment failure/);
  assert.ok(!api.comments.some((comment) => comment.body.includes('Claim confirmed for @carol')));
  await api.run();
  assert.equal(readClaim(api.comments).claim.claimer, 'carol');
  assert.deepEqual(api.issues[0].assignees, [{ login: 'carol' }]);
});

test('old findings remind weekly without closing, and closed issues clear stale in-flight', async () => {
  const api = new FakeGitHub();
  api.issues[0].labels = [{ name: 'finding' }];
  await api.run(start + 14 * DAY);
  await api.run(start + 15 * DAY);
  assert.equal(api.comments.filter((comment) => comment.body.includes('finding-reminder-')).length, 1);
  await api.run(start + 21 * DAY);
  assert.equal(api.comments.filter((comment) => comment.body.includes('finding-reminder-')).length, 2);
  assert.equal(api.issues[0].state, 'open');
  api.issues[0].state = 'closed';
  api.issues[0].labels.push({ name: 'in-flight' });
  await api.run(start + 22 * DAY);
  assert.ok(!api.issues[0].labels.some((label) => label.name === 'in-flight'));
  assert.ok(!api.writes.some((write) => write.body?.state === 'closed'));
});

test('untrusted bot-like records, bot commands, and other repositories cannot claim', async () => {
  const api = new FakeGitHub();
  api.comments = [
    { ...record(held(), 1), user: { login: 'eve', type: 'User' } },
    { ...userComment(2, 'another-bot[bot]', '/claim'), user: { login: 'another-bot[bot]', type: 'Bot' } },
  ];
  await api.run();
  assert.deepEqual(api.issues[0].assignees, []);
  await assert.rejects(runLifecycle(api, { repository: { full_name: 'other/repo' } }), /Unexpected repository/);
});

test('closed issues refuse new work but permit the owner to release a claim', async () => {
  const api = new FakeGitHub();
  api.issues[0].state = 'closed';
  api.issues[0].labels = [{ name: 'claimed' }];
  api.issues[0].assignees = [{ login: 'alice' }];
  api.comments = [record(held()), userComment(101, 'bob', '/claim'), userComment(102, 'Yutong43', '/unclaim')];
  await api.run();
  assert.equal(readClaim(api.comments).claim.claimer, null);
  assert.deepEqual(api.issues[0].assignees, []);
  assert.ok(api.comments.some((comment) => comment.body.includes('issue is closed')));
});
