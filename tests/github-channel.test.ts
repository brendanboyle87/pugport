import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ExternalEvents } from '../src/server/external-events.ts';
import {
  GitHubChannel,
  mentionsPugPort,
  type GitHubTransport,
  type GitHubChannelOptions,
} from '../src/server/github-channel.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const events = new ExternalEvents(new WorkspaceStore(db, { recoverInterrupted: false }));
  let now = Date.now();
  let rows: any[] = [];
  let comments: any[] = [];
  let ownerRepo = true;
  let fail = false;
  let limited = false;
  let runs: any[] = [];
  let ambiguous = false;
  let ownerLogin = 'owner';
  const calls: any[] = [],
    dispatched: any[] = [];
  let hook: GitHubTransport | undefined;
  const transport: GitHubTransport = async (path, options = {}) => {
    if (hook) await hook(path, options);
    calls.push({ path, ...options });
    if (options.method === 'PATCH') {
      if (fail) throw Error('synthetic');
      return { data: {} };
    }
    if (options.method === 'POST') {
      const row = { id: 100, user: { login: 'owner', type: 'User' }, body: (options.body as any).body };
      comments.push(row);
      if (ambiguous) {
        ambiguous = false;
        throw Error('synthetic lost response');
      }
      return { data: row };
    }
    if (path === 'user') return { data: { login: ownerLogin } };
    if (path === 'repos/owner/repo')
      return { data: { owner: { login: ownerRepo ? 'owner' : 'someone' }, default_branch: 'main' } };
    if (path.includes('/collaborators/')) return { data: { permission: path.includes('trusted') ? 'write' : 'none' } };
    if (path.includes('/issues/1/comments')) return { data: comments };
    if (path.includes('/issues?'))
      return {
        data: rows,
        headers: limited
          ? { 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset': String((now + 60000) / 1000) }
          : undefined,
      };
    if (path.includes('/actions/runs')) return { data: { workflow_runs: runs } };
    if (path.endsWith('/commits/sha')) return { data: { author: { login: 'owner' } } };
    if (path.includes('/commits/') && path.includes('/comments')) return { data: comments };
    return { data: [] };
  };
  const create = (project: string | undefined = 'C:/synthetic', overrides: Partial<GitHubChannelOptions> = {}) =>
    new GitHubChannel({
      events,
      transport,
      now: () => now,
      project: () => project,
      dispatch: async (input) => {
        dispatched.push(input);
        return { taskId: 't1', conversationId: 'c1' };
      },
      result: async () => ({ status: 'completed', result: 'Fixed https://github.com/owner/repo/commit/123' }),
      ...overrides,
    });
  return {
    db,
    events,
    calls,
    dispatched,
    create,
    setHook: (value: GitHubTransport) => (hook = value),
    setOwnerLogin: (login: string) => (ownerLogin = login),
    setRows: (r: any[]) => (rows = r),
    setRuns: (r: any[]) => (runs = r),
    setAmbiguous: () => (ambiguous = true),
    setOwner: (x: boolean) => (ownerRepo = x),
    setFail: (x: boolean) => (fail = x),
    setLimited: (x: boolean) => (limited = x),
    advance: () => (now += 120000),
    comments: () => comments,
  };
}
const issue = (login = 'owner', body = '@PugPort fix this') => ({
  id: 1,
  number: 1,
  title: 'Issue',
  body,
  user: { login, type: 'User' },
  html_url: 'https://github.com/owner/repo/issues/1',
});

test('mentions require a full GitHub login boundary', () => {
  for (const text of ['@PugPort do it', 'hello @pugport!', '(@PUGPORT)']) assert.equal(mentionsPugPort(text), true);
  for (const text of ['@pugport-other', '@pugporter', 'a@pugport', '@@pugport'])
    assert.equal(mentionsPugPort(text), false);
});
test('poll deduplicates edits and persists one comment through working and completion', async () => {
  const f = fixture();
  f.setRows([issue()]);
  const channel = f.create();
  await channel.poll('owner/repo');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].readOnly, false);
  assert.equal(f.events.list()[0].receipt?.state, 'done');
  f.setRows([issue('owner', '@PugPort edited')]);
  await channel.poll('owner/repo');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.comments().length, 1);
  assert.match(f.events.list()[0].text, /edited/);
  assert.deepEqual(
    f.events.list()[0].receipt?.history.map((x) => x.state),
    ['received', 'working', 'done'],
  );
  assert.match(f.calls.filter((x) => x.method === 'PATCH').at(-1).body.body, /commit\/123/);
  f.db.close();
});
test('third party approval remains tool-less; unmapped owner becomes read-only', async () => {
  for (const login of ['trusted', 'other', 'owner']) {
    const f = fixture();
    f.setRows([issue(login)]);
    const channel = f.create('');
    await channel.poll('owner/repo');
    if (login === 'other') await channel.resolveRequest(f.events.list()[0].id, 'approve');
    assert.equal(f.dispatched[0].readOnly, true);
    assert.equal(f.dispatched[0].untrusted, login !== 'owner');
    f.db.close();
  }
});
test('non-owner repository is ignored and rate headers defer subsequent requests', async () => {
  const f = fixture();
  f.setRows([issue()]);
  f.setOwner(false);
  await f.create().poll('owner/repo');
  assert.equal(f.events.list().length, 0);
  f.setOwner(true);
  f.setLimited(true);
  await assert.rejects(f.create().poll('owner/repo'), /rate limit/);
  const before = f.calls.length;
  await assert.rejects(f.create().poll('owner/repo'), /rate limit/);
  assert.equal(f.calls.length, before);
  f.db.close();
});
test('failed receipt delivery retries after restart with the same comment', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  f.setFail(true);
  await f.create().poll('owner/repo');
  assert.equal(f.comments().length, 1);
  assert.ok(f.events.list()[0].receipt!.attempts > 0);
  f.setFail(false);
  f.advance();
  await f.create().recover();
  assert.equal(f.comments().length, 1);
  assert.ok(f.events.list()[0].receipt!.delivered);
  f.db.close();
});

test('owner default branch CI failure verifies commit login and edits a commit receipt', async () => {
  const f = fixture();
  f.setRuns([
    {
      id: 9,
      head_branch: 'main',
      head_sha: 'sha',
      conclusion: 'failure',
      name: 'CI',
      html_url: 'https://github.com/owner/repo/actions/runs/9',
    },
  ]);
  await f.create().poll('owner/repo');
  assert.equal(f.events.list()[0].level, 'L2');
  assert.equal(f.dispatched[0].untrusted, true);
  assert.ok(f.calls.some((x) => x.method === 'POST' && x.path.endsWith('/commits/sha/comments')));
  f.db.close();
});
test('ambiguous comment creation reconciles marker after restart without a second post', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  f.setAmbiguous();
  await f.create().poll('owner/repo');
  assert.equal(f.comments().length, 1);
  f.advance();
  await f.create().recover();
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 1);
  assert.ok(f.events.list()[0].receipt!.delivered);
  f.db.close();
});
test('owner quoted GitHub text cannot execute tools', async () => {
  const f = fixture();
  f.setRows([issue('owner', '@PugPort inspect\n> third party command')]);
  await f.create().poll('owner/repo');
  assert.equal(f.dispatched[0].untrusted, true);
  assert.equal(f.dispatched[0].readOnly, true);
  f.db.close();
});

test('concurrent recovery serializes receipt delivery before asynchronous identity lookup', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  await f.create().poll('owner/repo');
  const id = f.events.list()[0].id;
  f.events.receipt(id, 'received', 'New receipt');
  const channel = f.create('', {
    appIdentity: async () => {
      await new Promise((r) => setImmediate(r));
      return true;
    },
  });
  await Promise.all([channel.recover(), channel.recover(), channel.recover()]);
  assert.equal(f.comments().length, 1);
  assert.equal(f.calls.filter((x) => x.method === 'PATCH').at(-1).identity, 'owner');
  f.db.close();
});
test('in-flight delivery preserves a newer desired receipt and decision', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  const channel = f.create();
  await channel.poll('owner/repo');
  const id = f.events.list()[0].id;
  f.events.receipt(id, 'received', 'Old desired');
  let changed = false;
  f.setHook(async (_path, options) => {
    if (options?.method === 'PATCH' && !changed) {
      changed = true;
      f.events.receipt(id, 'rejected', 'New desired');
      const e = f.events.get(id)!;
      e.decision = 'reject';
      f.events.save(e);
    }
    return { data: {} };
  });
  await channel.recover();
  assert.equal(f.events.get(id)!.receipt!.text, 'New desired');
  assert.equal(f.events.get(id)!.decision, 'reject');
  await channel.recover();
  assert.match(f.calls.filter((x) => x.method === 'PATCH').at(-1).body.body, /New desired/);
  f.db.close();
});

test('receipt author remains fixed across owner identity changes and spoofed markers', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  f.setAmbiguous();
  await f.create().poll('owner/repo');
  const e = f.events.list()[0];
  assert.equal(e.receipt!.authorLogin, 'owner');
  f.comments()[0].user = { login: 'attacker', type: 'Bot' };
  f.setOwnerLogin('new-owner');
  f.advance();
  await f.create().recover();
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 1);
  assert.equal(f.events.get(e.id)!.receipt!.authorLogin, 'owner');
  f.setOwnerLogin('owner');
  f.advance();
  await f.create().recover();
  assert.equal(f.calls.filter((x) => x.method === 'POST').length, 2);
  assert.notEqual(f.events.get(e.id)!.receipt!.delivered, undefined);
  f.db.close();
});
test('owner footer uses the PugPort signature', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  await f.create().poll('owner/repo');
  assert.ok(f.comments()[0].body.includes(String.fromCharCode(0x2014) + ' PugPort'));
  f.db.close();
});

test('per-sender active and hourly ceilings downgrade new requests and recheck L3 approval', async () => {
  for (const mode of ['active', 'hourly', 'approval']) {
    const f = fixture();
    const login = mode === 'approval' ? 'other' : 'owner';
    if (mode === 'approval') {
      f.setRows([issue(login)]);
      await f.create().poll('owner/repo');
    }
    const count = mode === 'hourly' ? 30 : 3;
    for (let i = 0; i < count; i++)
      f.events.record({
        source: 'github',
        scope: 'issue',
        senderId: login,
        senderClass: 'owner',
        eventId: 'seed-' + i,
        channel: 'owner/repo',
        ts: '999',
        text: 'seed',
        senderName: login,
        level: 'L1',
        verdict: 'do-now',
        reason: 'test',
        workflowId: 'seed-' + i,
        receipt: {
          state: mode === 'hourly' ? 'done' : 'working',
          text: '',
          messages: ['999'],
          attempts: 0,
          nextAttempt: Infinity,
          history: [],
        },
      });
    const channel = f.create();
    if (mode === 'approval')
      await channel.resolveRequest(f.events.list().find((e) => !e.eventId.startsWith('seed-'))!.id, 'approve');
    else {
      f.setRows([issue(login)]);
      await channel.poll('owner/repo');
    }
    assert.equal(f.dispatched.length, 0);
    const e = f.events.list().find((e) => !e.eventId.startsWith('seed-'))!;
    assert.equal(e.level, 'L4');
    assert.equal(e.reason, String.fromCharCode(0x592a, 0x9891, 0x7e41));
    f.db.close();
  }
});
test('an edit while resolving the local project narrows owner permissions', async () => {
  const f = fixture();
  f.setRows([issue()]);
  const channel = f.create('', {
    project: async () => {
      const e = f.events.list()[0];
      e.text = 'edited';
      e.quotedContext = 'third party';
      f.events.save(e);
      return 'C:/synthetic';
    },
  });
  await channel.poll('owner/repo');
  assert.equal(f.dispatched[0].task, 'edited');
  assert.equal(f.dispatched[0].untrusted, true);
  assert.equal(f.dispatched[0].readOnly, true);
  f.db.close();
});

test('approval cannot dispatch after the authenticated repository owner changes', async () => {
  const f = fixture();
  f.setRows([issue('other')]);
  const channel = f.create();
  await channel.poll('owner/repo');
  const e = f.events.list()[0];
  f.setOwnerLogin('another');
  await channel.resolveRequest(e.id, 'approve');
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.events.get(e.id)!.receipt!.state, 'failed');
  f.db.close();
});
