import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ExternalEvents } from '../src/server/external-events.ts';
import { AdmissionRules, admit, textPreference, type SenderClass } from '../src/server/external-admission.ts';
import { SlackGateway } from '../src/server/slack-gateway.ts';
import { Inbox } from '../src/server/inbox.ts';
import type { SlackConfigStore } from '../src/server/slack-config.ts';

test('Slack default table and overrides preserve hard admission boundaries', () => {
  const classes: SenderClass[] = ['owner', 'trusted', 'other', 'bot', 'system'];
  for (const scope of ['dm', 'channel-mention'] as const)
    assert.deepEqual(
      classes.map((senderClass) => admit({ source: 'slack', scope, senderId: 'U1', senderClass }).level),
      scope === 'dm' ? ['L1', 'L2', 'ignore', 'ignore', 'ignore'] : ['L1', 'L2', 'L3', 'ignore', 'ignore'],
    );
  const input = {
    source: 'slack' as const,
    scope: 'channel-mention' as const,
    senderId: 'U1',
    senderClass: 'other' as const,
  };
  assert.equal(
    admit(input, {
      version: 1,
      rules: [
        { source: 'slack', scope: input.scope, level: 'L4' },
        { source: 'slack', scope: input.scope, senderId: 'U1', level: 'L2' },
      ],
    }).level,
    'L2',
  );
  assert.equal(admit({ ...input, rateLimited: true }).reason, '太频繁');
  assert.deepEqual(
    ['L1', 'L2', 'L3', 'L4', 'ignore'].map(
      (level) =>
        admit(input, { version: 1, rules: [{ source: 'slack', scope: input.scope, level: level as any }] }).verdict,
    ),
    ['do-now', 'do-now', 'ask-owner', 'digest', 'ignore'],
  );
});
test('classifier is a bounded preference, not authority', async () => {
  for (const level of ['L3', 'L4', 'ignore'] as const)
    assert.equal(
      await textPreference(level, async () => {
        throw Error('must not call');
      }),
      'task',
    );
  assert.equal(await textPreference('L1', async () => 'chit-chat'), 'reply');
  assert.equal(await textPreference('L2', () => new Promise(() => {}), 1), 'task');
});
test('sender class preferences are isolated, validated and subordinate to sender overrides', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const rules = new AdmissionRules(new WorkspaceStore(db, { recoverInterrupted: false }));
    const input = {
      source: 'slack' as const,
      scope: 'channel-mention' as const,
      senderId: 'U1',
      senderClass: 'owner' as const,
    };
    const legacy = { source: 'slack' as const, scope: input.scope, level: 'L4' as const };
    const owner = { ...legacy, senderClass: 'owner' as const, level: 'L3' as const };
    const trusted = { ...legacy, senderClass: 'trusted' as const, level: 'L2' as const };
    const settings = rules.write({ version: 1, rules: [legacy, owner, trusted] });
    assert.equal(admit(input, settings).level, 'L3');
    assert.equal(admit({ ...input, senderClass: 'trusted' }, settings).level, 'L2');
    assert.equal(admit({ ...input, senderClass: 'other' }, settings).level, 'L4');
    rules.trust(input.scope, 'U1');
    assert.equal(admit(input, rules.read()).level, 'L2');
    assert.throws(() => rules.write({ version: 1, rules: [owner, owner] }), /重复/);
    assert.throws(() => rules.write({ version: 1, rules: [{ ...owner, senderId: 'U1' }] }));
    assert.throws(() => rules.write({ version: 1, rules: [{ ...owner, senderClass: 'unknown' }] }));
    for (const senderClass of ['bot', 'system', 'other'] as const) {
      const scope = senderClass === 'other' ? 'dm' : input.scope;
      const preferences = rules.write({ version: 1, rules: [{ ...legacy, scope, senderClass, level: 'L1' }] });
      assert.equal(admit({ ...input, scope, senderClass }, preferences).level, 'ignore');
    }
    const reset = rules.write({ version: 1, rules: [] });
    assert.equal(admit(input, reset).level, 'L1');
  } finally {
    db.close();
  }
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let now = Date.now();
  const events = new ExternalEvents(store, () => now);
  const inbox = new Inbox(db);
  const config = {
    enabled: true,
    version: 1,
    botToken: 'xoxb-synthetic-only',
    users: [
      { id: 'UOWNER', name: 'Owner', pairedAt: '2026-01-01', isOwner: true },
      { id: 'UTRUST', pairedAt: '2026-01-01' },
    ],
  };
  const configStore = {
    read: async () => config,
    update: async (fn: any) => {
      fn(config);
      return config;
    },
    threadsFile: 'synthetic-unused',
  } as unknown as SlackConfigStore;
  const calls: Array<{ method: string; args: any }> = [];
  const dispatched: any[] = [];
  let failUpdate = false;
  let fromOthers = false;
  const gateway = new SlackGateway({
    store: configStore,
    events,
    inbox,
    now: () => now,
    tasks: {
      dispatch: async (input) => {
        dispatched.push(input);
        return { taskId: 'task-' + dispatched.length, conversationId: 'conv-' + dispatched.length };
      },
      result: async () => ({ status: 'completed', result: 'Synthetic result' }),
    },
    fetch: async (url, init) => {
      const method = String(url).split('/').pop()!;
      const args = Object.fromEntries(new URLSearchParams(init?.body as any));
      calls.push({ method, args });
      if (method === 'chat.update' && failUpdate)
        return new Response(JSON.stringify({ ok: false, error: 'synthetic_failure' }));
      return new Response(
        JSON.stringify({
          ok: true,
          ts: 'receipt-' + calls.length,
          messages: fromOthers ? [{ user: 'UOTHER', text: 'untrusted quote', ts: '1' }] : [],
          user: { profile: { display_name: args.user } },
          channel: { name: 'synthetic' },
        }),
      );
    },
  });
  Object.assign(gateway, {
    session: new AbortController(),
    status: 'connected',
    threadStore: { get: async () => undefined, set: async () => {}, flush: async () => {} },
  });
  const send = async (user = 'UOWNER', ts = '100', channel = 'DTEST', text = 'please do a task') => {
    await (gateway as any).event({
      event_id: 'envelope-' + ts,
      event: {
        type: channel.startsWith('D') ? 'message' : 'app_mention',
        user,
        channel,
        ts,
        text,
        channel_type: channel.startsWith('D') ? 'im' : 'channel',
      },
    });
  };
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setImmediate(r));
      if (!(gateway as any).active.size) break;
    }
  };
  return {
    db,
    store,
    events,
    inbox,
    gateway,
    calls,
    dispatched,
    send,
    settle,
    setNow: (n: number) => (now = n),
    now: () => now,
    fail: (v: boolean) => (failUpdate = v),
    others: () => (fromOthers = true),
  };
}
test('events survive reconstruction, edits dedupe, ignored entries expire at seven days', () => {
  const f = fixture();
  const input = {
    source: 'slack' as const,
    scope: 'dm' as const,
    senderId: 'UBOT',
    senderClass: 'bot' as const,
    eventId: 'evt',
    senderName: 'bot',
    channel: 'DTEST',
    ts: '1',
    text: 'one',
    level: 'ignore' as const,
    verdict: 'ignore' as const,
    reason: 'bot',
  };
  const first = f.events.record(input);
  assert.equal(first.fresh, true);
  assert.equal(new ExternalEvents(f.store).record({ ...input, text: 'edit' }).fresh, false);
  assert.equal(f.events.get(first.event.id)?.text, 'edit');
  f.setNow(f.now() + 7 * 86400000 + 1);
  f.events.prune();
  assert.equal(f.events.list().length, 0);
  const rules = new AdmissionRules(f.store);
  assert.throws(() => rules.write({ version: 2, rules: [] }));
  rules.trust('channel-mention', 'UTRUST');
  assert.equal(new AdmissionRules(f.store).read().rules[0]?.level, 'L2');
  f.db.close();
});
test('owner has write request, other users read-only, receipts edit one message; edits never dispatch twice', async () => {
  const f = fixture();
  await f.send();
  await f.settle();
  assert.equal(f.dispatched[0].readOnly, false);
  assert.equal(f.dispatched[0].owner, true);
  assert.equal(f.calls.filter((c) => c.method === 'chat.postMessage').length, 1);
  assert.ok(f.calls.some((c) => c.method === 'chat.update' && c.args.text === '处理中…'));
  assert.equal(f.events.list()[0]?.receipt?.state, 'done');
  await (f.gateway as any).event({
    event: { subtype: 'message_changed', channel: 'DTEST', message: { ts: '100', user: 'UOWNER', text: 'edited' } },
  });
  await f.send('UOWNER', '100');
  assert.equal(f.dispatched.length, 1);
  await f.send('UTRUST', '101');
  await f.settle();
  assert.equal(f.dispatched[1].readOnly, true);
  f.db.close();
});
test('quoted third party content remains tool-less even for owner', async () => {
  const f = fixture();
  f.others();
  await f.send();
  await f.settle();
  assert.equal(f.dispatched[0].untrusted, true);
  assert.equal(f.dispatched[0].readOnly, true);
  f.db.close();
});
test('L3 approval, rejection, always and duplicate clicks persist without premature dispatch', async () => {
  const f = fixture();
  await f.send('UOTHER', '101', 'CTEST');
  assert.equal(f.dispatched.length, 0);
  const id = f.events.list()[0]!.id;
  await Promise.all([f.gateway.resolveRequest(id, 'approve'), f.gateway.resolveRequest(id, 'approve')]);
  await f.settle();
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].readOnly, true);
  await f.send('UOTHER', '102', 'CTEST');
  const second = f.events.list().find((e) => e.ts === '102')!;
  await f.gateway.resolveRequest(second.id, 'approve');
  await f.settle();
  await f.send('UOTHER', '103', 'CTEST');
  const third = f.events.list().find((e) => e.ts === '103')!;
  assert.equal(f.inbox.list().find((n) => n.key === third.id)?.externalRequest?.suggestAlways, true);
  await f.gateway.resolveRequest(third.id, 'always');
  await f.settle();
  assert.equal(f.gateway.rules().read().rules[0]?.level, 'L2');
  await f.send('UNEW', '104', 'CTEST');
  const rejected = f.events.list().find((e) => e.ts === '104')!;
  await f.gateway.resolveRequest(rejected.id, 'reject');
  assert.equal(f.events.get(rejected.id)?.receipt?.text, '主人这次没有接这个请求');
  assert.equal(f.dispatched.length, 3);
  f.db.close();
});
test('rate limit records L4 and eyes without a task; failed edits retry existing message after reconstruction', async () => {
  const f = fixture();
  (f.gateway as any).active.set('UOWNER', 3);
  await f.send();
  assert.equal(f.events.list()[0]?.level, 'L4');
  assert.equal(f.dispatched.length, 0);
  assert.ok(f.calls.some((c) => c.method === 'reactions.add'));
  (f.gateway as any).active.clear();
  f.fail(true);
  await f.send('UOWNER', '102');
  await f.settle();
  const e = f.events.list().find((e) => e.ts === '102')!;
  assert.ok(e.receipt!.nextAttempt > f.now());
  const posts = f.calls.filter((c) => c.method === 'chat.postMessage').length;
  f.fail(false);
  f.setNow(f.now() + 65000);
  (f.gateway as any).options.events = new ExternalEvents(f.store, () => f.now());
  await (f.gateway as any).recoverEvents();
  assert.equal(f.calls.filter((c) => c.method === 'chat.postMessage').length, posts);
  assert.equal(f.events.get(e.id)?.receipt?.delivered, 'done:Synthetic result');
  f.db.close();
});

test('concurrent admission reserves capacity before receipt delivery and recovery never queues it twice', async () => {
  const f = fixture();
  const original = (f.gateway as any).fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (f.gateway as any).fetch = async (url: any, init: any) => {
    if (String(url).endsWith('chat.postMessage')) await gate;
    return original(url, init);
  };
  const pending = [1, 2, 3, 4].map((n) => f.send('UOWNER', String(n), 'DTEST'));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(f.events.list().filter((e) => e.verdict === 'do-now').length, 3);
  assert.equal(f.events.list().filter((e) => e.verdict === 'digest').length, 1);
  await (f.gateway as any).recoverEvents();
  assert.equal(f.dispatched.length, 0);
  release();
  await Promise.all(pending);
  await f.settle();
  assert.equal(f.dispatched.length, 3);
  f.db.close();
});
test('receipt reconciliation scans pages and preserves newer event state while a post is in flight', async () => {
  const f = fixture();
  const input = {
    source: 'slack' as const,
    scope: 'dm' as const,
    senderId: 'UOWNER',
    senderClass: 'owner' as const,
    eventId: 'race',
    senderName: 'Owner',
    channel: 'DTEST',
    ts: '1',
    text: 'task',
    level: 'L1' as const,
    verdict: 'do-now' as const,
    reason: 'default',
  };
  const e = f.events.record(input).event;
  f.events.receipt(e.id, 'received', 'received');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let clientId = '';
  const original = (f.gateway as any).fetch;
  (f.gateway as any).fetch = async (url: any, init: any) => {
    if (String(url).endsWith('chat.postMessage')) {
      clientId = new URLSearchParams(init.body).get('client_msg_id')!;
      await gate;
    }
    return original(url, init);
  };
  const flushing = (f.gateway as any).flushReceipt(e.id);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  f.events.receipt(e.id, 'done', 'new result');
  const current = f.events.get(e.id)!;
  current.workflowId = 'task-saved';
  f.events.save(current);
  release();
  await flushing;
  assert.equal(f.events.get(e.id)?.workflowId, 'task-saved');
  assert.equal(f.events.get(e.id)?.receipt?.state, 'done');
  const retry = f.events.get(e.id)!;
  retry.receipt!.messages = [];
  retry.receipt!.delivered = undefined;
  f.events.save(retry);
  let pages = 0;
  let posts = 0;
  (f.gateway as any).fetch = async (url: any, init: any) => {
    if (String(url).endsWith('conversations.replies')) {
      pages++;
      return new Response(
        JSON.stringify({
          ok: true,
          messages: pages === 2 ? [{ ts: 'found', client_msg_id: clientId }] : [],
          response_metadata: { next_cursor: pages === 1 ? 'page2' : '' },
        }),
      );
    }
    if (String(url).endsWith('chat.postMessage')) posts++;
    return original(url, init);
  };
  await (f.gateway as any).flushReceipt(e.id);
  assert.equal(pages, 2);
  assert.equal(posts, 0);
  assert.equal(f.events.get(e.id)?.receipt?.messages[0], 'found');
  f.db.close();
});
test('owner identity is explicit; first paired user stays trusted until local owner API updates it', async () => {
  const f = fixture();
  assert.equal((await f.gateway.view()).users.find((u) => u.id === 'UTRUST')?.isOwner, undefined);
  await f.gateway.setOwner('UTRUST', true);
  assert.equal((await f.gateway.view()).users.find((u) => u.id === 'UTRUST')?.isOwner, true);
  assert.equal((await f.gateway.view()).users.filter((u) => u.isOwner).length, 1);
  assert.equal((await f.gateway.view()).users.find((u) => u.id === 'UOWNER')?.isOwner, false);
  await f.gateway.setOwner('UOWNER', true);
  assert.equal((await f.gateway.view()).users.find((u) => u.id === 'UTRUST')?.isOwner, false);
  assert.equal((await f.gateway.view()).users.filter((u) => u.isOwner).length, 1);
  await f.gateway.setOwner('UTRUST', false);
  await assert.rejects(() => f.gateway.setOwner('UMISSING', true));
  await f.send('UTRUST');
  await f.settle();
  assert.equal(f.dispatched[0].readOnly, true);
  f.db.close();
});

test('owner pairing transfers the sole owner identity to newly paired people', async () => {
  const f = fixture();
  try {
    for (const [index, id] of ['UNEW', 'UNEW2'].entries()) {
      const { code } = f.gateway.createPairingCode(true);
      await f.send(id, String(200 + index), 'DTEST', `pair ${code}`);
      const owners = (await f.gateway.view()).users.filter((user) => user.isOwner);
      assert.deepEqual(
        owners.map((user) => user.id),
        [id],
      );
    }
  } finally {
    f.db.close();
  }
});

test('node handover preserves explicit owner identity and rejects forged identity fields', async () => {
  const { slackHostRequestSchema } = await import('../src/server/node/peer-protocol.ts');
  const input = {
    host: true,
    appToken: 'synthetic',
    botToken: 'synthetic',
    users: [{ id: 'UOWNER', pairedAt: '2026-01-01', isOwner: true }],
  };
  assert.equal(slackHostRequestSchema.parse(input).host, true);
  assert.throws(() => slackHostRequestSchema.parse({ ...input, users: [{ ...input.users[0], isOwner: 'true' }] }));
});
test('task failures persist failed receipts and never announce completion', async () => {
  const f = fixture();
  (f.gateway as any).tasks.result = async () => ({
    status: 'failed',
    result: 'partial output',
    error: 'synthetic failure',
  });
  await f.send('UTRUST');
  await f.settle();
  const e = f.events.list()[0]!;
  assert.equal(e.receipt?.state, 'failed');
  assert.equal(f.inbox.list()[0]?.body, '未完成');
  f.db.close();
});
