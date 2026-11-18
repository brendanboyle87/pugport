import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Express, RequestHandler } from 'express';
import { Inbox } from '../src/server/inbox.ts';
import { StoreOutbox } from '../src/server/maintainer/outbox.ts';
import { MaintainerDesk, memoryHostLink, type HostLink } from '../src/server/maintainer/desktop.ts';
import { maintainerRoutes } from '../src/server/maintainer/routes.ts';
import { githubHostRequestSchema, githubOutboxSchema, githubResolveSchema } from '../src/server/node/peer-protocol.ts';
import { card, sha, blobSha, stamp, memoryStore, mergeFixture } from './helpers/maintainer.ts';
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = Date.parse(stamp);
  const now = () => clock;
  const store = memoryStore(),
    outbox = new StoreOutbox(store, now),
    inbox = new Inbox(db, () => {}, now);
  const f = mergeFixture();
  let current: HostLink | undefined = memoryHostLink(outbox);
  const deps = {
    inbox,
    store,
    config: async () => ({ repository: 'o/r', requiredChecks: ['ci'] }),
    link: () => current,
    gh: f.gh,
    audit: () => {},
    now,
  };
  const desk = new MaintainerDesk(deps);
  return {
    ...f,
    outbox,
    inbox,
    store,
    desk,
    deps,
    advance: (ms: number) => {
      clock += ms;
    },
    link: (link: HostLink | undefined) => {
      current = link;
    },
  };
}
test('memory host link isolates cards after repository switches and without a configured repository', async (t) => {
  const f = fixture(t);
  const first = f.outbox.raise(card());
  const second = f.outbox.raise(card({ url: 'https://github.com/o/other/pull/7' }));
  let repository: string | undefined = 'o/r';
  const link = memoryHostLink(f.outbox, async () => ({
    githubHost: true,
    mode: 'live',
    repository,
    ready: { gh: true, app: true, toolless: true },
    counts: { prs: 0, issues: 0, judges: 0, writes: 0 },
    score: { judged: 0, falsePasses: 0, falseFails: 0, pending: 0 },
    recent: [],
  }));
  assert.deepEqual(
    (await link.outbox()).map((item) => item.id),
    [first.id],
  );
  assert.equal((await link.card(first.id))?.id, first.id);
  repository = 'o/other';
  assert.deepEqual(
    (await link.outbox()).map((item) => item.id),
    [second.id],
  );
  assert.equal(await link.card(first.id), undefined);
  assert.equal(await link.resolve(first.id, { outcome: 'declined' }), false);
  assert.equal(await link.resolve(second.id, { outcome: 'suite-started' }), true);
  repository = undefined;
  assert.deepEqual(await link.outbox(), []);
  assert.equal(await link.card(second.id), undefined);
  assert.equal(await link.resolve(second.id, { outcome: 'declined' }), false);
  assert.equal(f.outbox.open().length, 2);
});

test('judge resume targets the selected local host and refuses absent or closed hosts', async (t) => {
  const f = fixture(t);
  let resumed = 0;
  f.link(undefined);
  assert.equal((await f.desk.resumeJudge()).status, 'refused');
  f.link(
    memoryHostLink(f.outbox, undefined, () => {
      resumed++;
    }),
  );
  assert.deepEqual(await f.desk.resumeJudge(), { status: 'resumed' });
  assert.equal(resumed, 1);
  await f.desk.close();
  assert.equal((await f.desk.resumeJudge()).status, 'refused');
  assert.equal(resumed, 1);
});

test('sync mirrors open cards once and a desktop restart reuses notices', async (t) => {
  const f = fixture(t);
  const merge = f.outbox.raise(card()),
    review = f.outbox.raise(card({ kind: 'review', suite: { state: 'not-run' } }));
  const external = f.outbox.raise(card({ number: 8, kind: 'review', external: true, suite: { state: 'not-run' } }));
  const ruling = f.outbox.raise(card({ kind: 'ruling' }));
  await f.desk.sync();
  const notices = f.inbox.list();
  assert.equal(notices.length, 4);
  assert.deepEqual(notices.find((n) => n.key === merge.id)?.action, { kind: 'github-merge', cardId: merge.id });
  assert.equal(notices.find((n) => n.key === review.id)?.action, undefined);
  assert.equal(notices.find((n) => n.key === external.id)?.action, undefined);
  assert.equal(notices.find((n) => n.key === ruling.id)?.severity, 'action');
  assert.equal(notices.find((n) => n.key === review.id)?.severity, 'info');
  await f.desk.sync();
  await new MaintainerDesk(f.deps).sync();
  assert.ok(f.inbox.list().every((n) => n.count === 1));
  assert.equal((await f.desk.status()).desk.lastSyncAt, stamp);
  f.inbox.reconcile([], []);
  assert.equal(f.inbox.list().length, 4, 'executor reconciliation must preserve GitHub cards');
  f.inbox.markRead();
  const before = f.inbox.list();
  const updates = t.mock.method(f.inbox, 'update');
  f.advance(60000);
  await f.desk.sync();
  assert.deepEqual(f.inbox.list(), before);
  assert.equal(updates.mock.callCount(), 0);
  assert.equal(f.inbox.list().length, 4, 'reading the inbox must preserve host-owned review cards and their actions');
});

test('merge reads current project gates after the card was created', async (t) => {
  const f = fixture(t);
  const item = f.outbox.raise(card());
  let reads = 0;
  const desk = new MaintainerDesk({
    ...f.deps,
    gates: async () => {
      reads++;
      return { version: 1, windows: { noMerge: { from: '11:00', to: '13:00', tz: 'UTC' } } };
    },
  });
  const result = await desk.merge(item.id);
  assert.equal(reads, 1);
  assert.equal(result.status, 'refused');
  assert.ok(!f.calls.some((call) => call.args[0] === 'pr' && call.args[1] === 'merge'));
});

test('late startup after shutdown cannot restart desk synchronization', async (t) => {
  const f = fixture(t);
  await f.desk.close();
  const timer = t.mock.method(globalThis, 'setInterval');
  f.desk.start();
  assert.equal(timer.mock.callCount(), 0);
});
test('changed notice fields update once, then preserve read state', async (t) => {
  const f = fixture(t);
  const item = f.outbox.raise(card());
  await f.desk.sync();
  f.inbox.markRead();
  const updates = t.mock.method(f.inbox, 'update');
  f.store.save('maintainer-card', `o/r#${item.number}:${item.id}`, 'maintainer:open', {
    ...item,
    kind: 'review',
    title: 'Updated PR',
  });
  await f.desk.sync();
  assert.equal(updates.mock.callCount(), 1);
  const notice = f.inbox.list()[0];
  assert.equal(notice.title, 'PR #7 等你看');
  assert.match(notice.body!, /Updated PR/);
  assert.equal(notice.severity, 'info');
  assert.equal(notice.action, undefined);
  assert.equal(notice.readAt, undefined);
  f.inbox.markRead();
  const before = f.inbox.list();
  await f.desk.sync();
  assert.equal(updates.mock.callCount(), 1);
  assert.deepEqual(f.inbox.list(), before);
});
test('dismissal declines on host, supersede/expiry resolve local notices', async (t) => {
  const f = fixture(t);
  const item = f.outbox.raise(card());
  await f.desk.sync();
  f.inbox.dismiss(f.inbox.list()[0].id);
  await f.desk.sync();
  assert.equal(f.outbox.open().length, 0);
  assert.equal(f.store.get<any>('maintainer-card', `o/r#${item.number}:${item.id}`).resolution.outcome, 'declined');
  const next = f.outbox.raise(card({ judgedSha: blobSha }));
  await f.desk.sync();
  f.outbox.supersede(7, sha);
  await f.desk.sync();
  assert.ok(f.inbox.list({ all: true }).find((n) => n.key === next.id)?.resolvedAt);
  f.outbox.raise(card());
  await f.desk.sync();
  f.advance(15 * 86400000);
  await f.desk.sync();
  assert.equal(f.outbox.open().length, 0);
  assert.equal(f.inbox.list().length, 0);
});
test('offline HostLink leaves existing notices untouched and retains link status', async (t) => {
  const f = fixture(t);
  f.outbox.raise(card());
  await f.desk.sync();
  const before = f.inbox.list({ all: true });
  f.link({
    outbox: async () => {
      throw new Error('synthetic host offline');
    },
    card: async () => {
      throw new Error('offline');
    },
    resolve: async () => false,
  });
  await f.desk.sync();
  assert.deepEqual(f.inbox.list({ all: true }), before);
  assert.equal((await f.desk.status()).desk.link, 'local');
  assert.match((await f.desk.status()).desk.problem!, /offline/);
});
test('merge resolves host and inbox, repeated clicks share one operation', async (t) => {
  const f = fixture(t);
  const item = f.outbox.raise(card());
  await f.desk.sync();
  const results = await Promise.all([f.desk.merge(item.id), f.desk.merge(item.id)]);
  assert.ok(results.every((r) => r.status === 'merged'));
  assert.equal(f.calls.filter((c) => c.args[1] === 'merge').length, 1);
  assert.equal(f.store.get<any>('maintainer-card', `o/r#${item.number}:${item.id}`).resolution.outcome, 'merged');
  assert.equal(f.inbox.list().length, 0);
});
test('head movement updates refusal notice and never invokes merge', async (t) => {
  const f = fixture(t);
  const item = f.outbox.raise(card());
  await f.desk.sync();
  f.data.view.headRefOid = blobSha;
  assert.equal((await f.desk.merge(item.id)).status, 'refused');
  assert.match(f.inbox.list()[0].body!, /head moved/);
  f.inbox.markRead();
  const before = f.inbox.list();
  const updates = t.mock.method(f.inbox, 'update');
  f.advance(60000);
  await f.desk.sync();
  await new MaintainerDesk(f.deps).sync();
  assert.deepEqual(f.inbox.list(), before);
  assert.equal(updates.mock.callCount(), 0);
  assert.match(
    f.store.get<{ refusals: Record<string, string> }>('maintainer-desk-state', 'singleton')!.refusals[item.id],
    /head moved/,
  );
  f.outbox.resolve(item.id, { outcome: 'declined', at: stamp });
  await f.desk.sync();
  assert.deepEqual(
    f.store.get<{ refusals: Record<string, string> }>('maintainer-desk-state', 'singleton')!.refusals,
    {},
  );
  assert.ok(!f.calls.some((c) => c.args[1] === 'merge'));
});
test('review cards have no full-suite action and suites require a configured runner', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.outbox.raise(card({ kind: 'suite', external: true })), /External PRs/);
  const external = f.outbox.raise(card({ kind: 'review', external: true, suite: { state: 'not-run' } }));
  const trusted = f.outbox.raise(card({ kind: 'review', number: 9, suite: { state: 'not-run' } }));
  const suite = f.outbox.raise(card({ kind: 'suite', number: 10 }));
  await f.desk.sync();
  for (const item of [external, trusted])
    assert.equal(f.inbox.list().find((notice) => notice.key === item.id)?.action, undefined);
  assert.ok(f.outbox.open().some((item) => item.id === suite.id));
  assert.equal(f.calls.length, 0);
});

test('outbox deduplication survives new StoreOutbox instances', () => {
  const store = memoryStore(),
    first = new StoreOutbox(store, () => Date.parse(stamp));
  const item = first.raise(card({ kind: 'ruling' }));
  const second = new StoreOutbox(store, () => Date.parse(stamp));
  assert.equal(second.raise(card({ kind: 'ruling' })).id, item.id);
  assert.equal(second.open().length, 1);
  const retargeted = second.raise(card({ kind: 'ruling', baseRef: 'release' }));
  assert.notEqual(retargeted.id, item.id);
  assert.equal(retargeted.baseRef, 'release');
});
test('GitHub protocol validates bounded cards and required-check configuration', () => {
  assert.deepEqual(
    githubHostRequestSchema.parse({ host: true, repository: 'o/r', hostedBy: 'desktop', requiredChecks: ['ci'] }).host,
    true,
  );
  assert.equal(githubOutboxSchema.safeParse({ items: [card({ title: 'x'.repeat(201) })] }).success, false);
  assert.equal(githubOutboxSchema.safeParse({ items: [card({ baseRef: 'x'.repeat(256) })] }).success, false);
  assert.equal(githubOutboxSchema.safeParse({ items: [card({ baseRef: 'x'.repeat(255) })] }).success, true);
  assert.equal(githubResolveSchema.safeParse({ outcome: 'merged', mergeCommit: 'bad' }).success, false);
});
test('routes require the injected executor guard before every owner action', async () => {
  const registered: { path: string; handlers: RequestHandler[] }[] = [];
  const app = {
    get: () => {},
    post: (path: string, ...handlers: RequestHandler[]) => {
      registered.push({ path, handlers });
    },
  };
  let calls = 0;
  const desk = {
    merge: async () => {
      calls++;
      return { status: 'refused', reason: 'stale' };
    },
    resumeJudge: async () => {
      calls++;
      return { status: 'resumed' };
    },
  };
  const guard: RequestHandler = (_req, res) => {
    res.status(403).json({ error: 'executor refused' });
  };
  maintainerRoutes(app as unknown as Express, desk as never, guard);
  assert.deepEqual(
    registered.map((route) => route.path),
    ['/api/maintainer/judge/resume', '/api/maintainer/cards/:id/merge'],
  );
  for (const route of registered) {
    assert.equal(route.handlers[0], guard);
    let status = 200;
    let response: any;
    const res = {
      status: (code: number) => {
        status = code;
        return res;
      },
      json: (value: unknown) => {
        response = value;
      },
    };
    await route.handlers[0]({} as never, res as never, () => {});
    assert.equal(status, 403);
    assert.equal(calls, 0);
    status = 200;
    await route.handlers[1]({ params: { id: card().id }, body: {} } as never, res as never, () => {});
    if (route.path.endsWith('/judge/resume')) {
      assert.equal(status, 200);
      assert.deepEqual(response, { ok: true });
    } else {
      assert.equal(status, 409);
      assert.equal(response.status, 'refused');
    }
    assert.equal(calls, 1);
    calls = 0;
  }
});

test('desk status distinguishes missing and unreadable configuration', async (t) => {
  const f = fixture(t);
  const missing = new MaintainerDesk({ ...f.deps, config: async () => undefined, link: () => undefined });
  assert.deepEqual(await missing.status(), {
    configured: false,
    host: undefined,
    desk: { lastSyncAt: undefined, link: 'none', problem: undefined },
  });
  const invalid = new MaintainerDesk({
    ...f.deps,
    config: async () => {
      throw new Error('Invalid maintainer.json');
    },
  });
  assert.equal((await invalid.status()).configured, false);
  assert.equal((await invalid.status()).desk.problem, 'Invalid maintainer.json');
});
