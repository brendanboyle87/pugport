import { ScheduledTasks } from '../src/server/scheduled-tasks.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ExternalEvents, type ExternalEvent } from '../src/server/external-events.ts';
import { Inbox } from '../src/server/inbox.ts';
import { ExternalDigests, buildDigest, digestTitle, externalDigestRoutes } from '../src/server/external-digests.ts';
import { SlackGateway } from '../src/server/slack-gateway.ts';
import type { SlackConfigStore } from '../src/server/slack-config.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let now = new Date(2026, 10, 2, 9, 0);
  const events = new ExternalEvents(store, () => +now),
    inbox = new Inbox(
      db,
      () => {},
      () => +now,
    );
  const sent: string[] = [];
  let fail = false,
    connected = true;
  const slack = {
    deliverDigest: async (id: string) => {
      if (fail) throw Error('synthetic');
      if (!connected) return false;
      sent.push(id);
      return true;
    },
  };
  const service = () => new ExternalDigests(events, inbox, slack, () => now);
  const add = (level: ExternalEvent['level'], id: string, at = new Date(2026, 10, 1, 12)) => {
    const e: ExternalEvent = {
      id,
      eventId: id,
      source: 'slack',
      scope: 'dm',
      senderClass: 'trusted',
      senderId: 'USYNTH',
      senderName: 'Synthetic',
      channel: 'DTEST',
      ts: '1',
      text: 'Synthetic ' + id,
      scopeLabel: '#synthetic',
      permalink: 'https://example.slack.com/archives/DTEST/p1',
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      level,
      verdict: level === 'L3' ? 'ask-owner' : level === 'L4' ? 'digest' : 'do-now',
      reason: 'synthetic',
    };
    if (level === 'L2')
      e.receipt = {
        state: 'done',
        text: 'Finished ' + id,
        messages: [],
        attempts: 0,
        nextAttempt: 0,
        history: [{ state: 'done', at: at.toISOString() }],
      };
    store.save('external-event', id, 'slack', e);
    return e;
  };
  return {
    db,
    store,
    events,
    inbox,
    sent,
    service,
    add,
    setNow: (d: Date) => (now = d),
    setFail: (v: boolean) => (fail = v),
    setConnected: (v: boolean) => (connected = v),
  };
}
test('empty day is silent; one immutable day id survives restart and concurrent ticks', async () => {
  const f = fixture();
  try {
    await f.service().tick();
    assert.equal(f.inbox.list().length, 0);
    assert.equal(f.sent.length, 0);
    f.add('L4', 'late');
    await f.service().tick();
    assert.equal(f.inbox.list().length, 0);
    f.setNow(new Date(2026, 10, 3, 10));
    f.add('L4', 'new', new Date(2026, 10, 2, 12));
    const s = f.service();
    await Promise.all([s.tick(), s.tick(), f.service().tick()]);
    assert.equal(f.inbox.list().length, 1);
    assert.deepEqual(f.sent, ['2026-11-03']);
    await f.service().tick();
    assert.equal(f.inbox.list().length, 1);
  } finally {
    f.db.close();
  }
});
test('counts, sections, stable grouping, 20-note limit, yesterday completion time and open backlog', () => {
  const f = fixture();
  try {
    f.add('L3', 'pending', new Date(2026, 9, 1));
    f.add('L3', 'today', new Date(2026, 10, 2, 8));
    const rejected = f.add('L3', 'rejected');
    rejected.decision = 'reject';
    f.store.save('external-event', rejected.id, 'slack', rejected);
    f.add('L2', 'done');
    f.add('L2', 'old-result', new Date(2026, 9, 1));
    for (let i = 0; i < 24; i++) f.add('L4', 'note-' + i);
    const d = buildDigest(f.events.list(), new Date(2026, 10, 2, 9))!;
    assert.equal(digestTitle(d), '昨天：做了 1 件 · 等你确认 2 件 · 记下 24 条');
    assert.deepEqual(
      d.pending.map((i) => i.id),
      ['pending', 'today'],
    );
    assert.equal(d.done[0].text, 'Finished done');
    assert.equal(d.noted.length, 20);
    assert.equal(d.remaining, 4);
    assert.deepEqual(buildDigest(f.events.list().reverse(), new Date(2026, 10, 2, 9)), d);
    assert.equal(digestTitle({ ...d, done: [], pending: [] }), '昨天：记下 24 条');
  } finally {
    f.db.close();
  }
});
test('failed delivery retries after restart, disconnected Slack still gets exactly one Inbox card', async () => {
  const f = fixture();
  try {
    f.add('L4', 'note');
    f.setConnected(false);
    await f.service().tick();
    assert.equal(f.inbox.list().length, 1);
    assert.equal(f.sent.length, 0);
    f.setConnected(true);
    f.setFail(true);
    f.setNow(new Date(2026, 10, 2, 9, 2));
    await f.service().tick();
    assert.equal(f.inbox.list().length, 1);
    f.setFail(false);
    f.setNow(new Date(2026, 10, 2, 9, 4));
    await f.service().tick();
    assert.equal(f.sent.length, 1);
    f.inbox.markRead();
    assert.equal(f.inbox.list().length, 1);
  } finally {
    f.db.close();
  }
});
test('settings default, persistence, validation and routes; pre-9 restart waits, post-9 catches up', async () => {
  const f = fixture();
  try {
    const s = f.service();
    assert.deepEqual(s.settings(), { time: '09:00', destination: 'pugport-slack' });
    const routes = new Map<string, any>();
    externalDigestRoutes(
      {
        get: (p: string, h: any) => routes.set('GET ' + p, h),
        put: (p: string, h: any) => routes.set('PUT ' + p, h),
      } as any,
      s,
    );
    let response: any;
    routes.get('PUT /api/external-digest/settings')(
      { body: { time: '10:00', destination: 'pugport' } },
      { json: (v: any) => (response = v) },
    );
    assert.equal(response.time, '10:00');
    assert.equal(f.service().settings().time, '10:00');
    assert.throws(() => s.configure({ time: '25:00', destination: 'pugport' }));
    assert.throws(() => s.configure({ time: '09:00', destination: 'anywhere' }));
    f.add('L3', 'pending');
    await s.tick();
    assert.equal(f.inbox.list().length, 0);
    f.setNow(new Date(2026, 10, 2, 11));
    await f.service().tick();
    assert.equal(f.inbox.list().length, 1);
    assert.equal(f.sent.length, 0);
    const e = f.events.get('pending')!;
    e.decision = 'approve';
    f.events.save(e);
    await s.tick();
    assert.equal(f.inbox.list()[0].externalDigest?.pending[0].status, 'approved');
  } finally {
    f.db.close();
  }
});
test('Inbox failure rolls back daily id and retries without duplicating a card', async () => {
  const f = fixture();
  try {
    f.add('L4', 'note');
    const raise = f.inbox.raise.bind(f.inbox);
    let first = true;
    f.inbox.raise = (input) => {
      const n = raise(input);
      if (first) {
        first = false;
        throw Error('synthetic persistence failure');
      }
      return n;
    };
    await assert.rejects(f.service().tick());
    assert.equal(f.store.get('external-digest', '2026-11-02'), undefined);
    assert.equal(f.inbox.list().length, 0);
    await f.service().tick();
    assert.equal(f.inbox.list().length, 1);
  } finally {
    f.db.close();
  }
});
test('New York local days cover DST spring/fall and nextRunAt stays at 9 wall time', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `
 import assert from 'node:assert/strict';
 import {nextRunAt} from './src/server/scheduled-tasks.ts';
 import {buildDigest} from './src/server/external-digests.ts';
 for(const [date,hours,expected] of [['2026-03-09',23,'2026-03-09T13:00:00.000Z'],['2026-11-02',25,'2026-11-02T14:00:00.000Z']]){
 const today=new Date(date+'T09:00:00');const start=new Date(today.getFullYear(),today.getMonth(),today.getDate());const prior=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1);assert.equal((+start-+prior)/3600000,hours);
 assert.equal(nextRunAt({type:'daily',time:'09:00'},new Date(+start-1)),expected);
 const base={source:'slack',scope:'dm',senderId:'U',senderClass:'trusted',text:'note',level:'L4',verdict:'digest'};
 const events=[{...base,id:'start',createdAt:prior.toISOString()},{...base,id:'last',createdAt:new Date(+start-1).toISOString()},{...base,id:'outside',createdAt:start.toISOString()}];
 assert.deepEqual(buildDigest(events,today).noted.map(i=>i.id),['start','last']);
 }
 `,
    ],
    { cwd: process.cwd(), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
test('Slack owner-only DM persists receipts and reconciles ambiguous post after restart with fake transport', async () => {
  const f = fixture();
  try {
    const config = {
      version: 1,
      enabled: true,
      botToken: 'xoxb-synthetic',
      users: [{ id: 'UOWNER', isOwner: true, pairedAt: 'synthetic' }],
    };
    const calls: { method: string; args: any }[] = [];
    let ambiguous = true;
    let posted: any;
    const fakeFetch = async (url: any, init: any) => {
      const method = String(url).split('/').at(-1)!;
      const args = Object.fromEntries(new URLSearchParams(init.body));
      calls.push({ method, args });
      if (method === 'chat.postMessage') {
        posted = { ts: '123.1', client_msg_id: args.client_msg_id };
        if (ambiguous) {
          ambiguous = false;
          throw Error('synthetic response lost');
        }
      }
      return new Response(
        JSON.stringify({ ok: true, channel: { id: 'DSYNTH' }, ts: '123.1', messages: posted ? [posted] : [] }),
      );
    };
    const gateway = () => {
      const g = new SlackGateway({
        events: f.events,
        store: { read: async () => config, threadsFile: 'synthetic-unused' } as unknown as SlackConfigStore,
        fetch: fakeFetch,
      });
      Object.assign(g, { status: 'connected' });
      return g;
    };
    const g = gateway();
    Object.assign(g, { status: 'off' });
    assert.equal(await g.deliverDigest('day', 'hello'), false);
    assert.equal(calls.length, 0);
    Object.assign(g, { status: 'connected' });
    config.users[0].isOwner = false;
    assert.equal(await g.deliverDigest('day', 'hello'), false);
    assert.equal(calls.length, 0);
    config.users[0].isOwner = true;
    await assert.rejects(g.deliverDigest('day', 'hello'));
    assert.equal(await gateway().deliverDigest('day', 'hello'), true);
    assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 1);
    assert.equal(calls.filter((c) => c.method === 'chat.update').length, 1);
    assert.equal(await gateway().deliverDigest('day', 'hello'), true);
    assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 1);
  } finally {
    f.db.close();
  }
});

test('existing ScheduledTasks tick invokes digest without a second timer', async () => {
  const f = fixture();
  try {
    f.add('L4', 'scheduled');
    const tasks = new ScheduledTasks({ store: f.store } as any);
    tasks.backgroundTick = () => f.service().tick();
    await tasks.tick();
    assert.equal(f.inbox.list().length, 1);
    await tasks.close();
    await tasks.tick();
    assert.equal(f.sent.length, 1);
  } finally {
    f.db.close();
  }
});
test('changing destination stops a pending Slack retry and repository grouping stays deterministic', async () => {
  const f = fixture();
  try {
    const e = f.add('L4', 'repo');
    e.repository = 'example/repo';
    f.store.save('external-event', e.id, 'slack', e);
    f.setConnected(false);
    await f.service().tick();
    assert.equal(f.inbox.list()[0].externalDigest?.noted[0].group, 'example/repo');
    f.service().configure({ time: '09:00', destination: 'pugport' });
    f.setConnected(true);
    f.setNow(new Date(2026, 10, 2, 10));
    await f.service().tick();
    assert.equal(f.sent.length, 0);
  } finally {
    f.db.close();
  }
});
