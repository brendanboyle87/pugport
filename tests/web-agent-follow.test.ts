import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExternalReplyPanel, externalAgentStatus } from '../src/ui/ExternalAgents.tsx';
import { ExternalAgents, type ExternalAgentsOptions } from '../src/server/external-agents/service.ts';
import { ExternalAgentConfig, parseWebUsage } from '../src/server/external-agents/config.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { Conversation, ConversationMessage, MessageInput, Workflow } from '../src/shared/types.ts';
import type { WebAgentRequest, WebAgentResult } from '../src/shared/web-bridge.ts';

// In-memory storage and bridge only: exercise the real service without accounts, files or sites.
function fixture(
  t: TestContext,
  handler: (request: WebAgentRequest) => WebAgentResult | Promise<WebAgentResult>,
  options: ExternalAgentsOptions = {},
) {
  let clock = 0;
  const rows = new Map<string, unknown>();
  const saves: string[] = [];
  const calls: WebAgentRequest[] = [];
  const settings: Record<string, Record<string, unknown>> = {
    muse: {
      added: true,
      enabled: true,
      riskAcceptedAt: 'test',
      url: 'https://fixture.test/',
      usageUrl: 'https://fixture.test/usage',
    },
  };
  t.mock.method(ExternalAgentConfig.prototype, 'agent', (id: string) => settings[id] ?? { enabled: false });
  t.mock.method(ExternalAgentConfig.prototype, 'update', (id: string, patch: object) => {
    settings[id] = { ...settings[id], ...patch };
  });
  t.mock.method(ExternalAgentConfig.prototype, 'selectors', () => ({}));
  t.mock.method(ExternalAgentConfig.prototype, 'saveSelectors', () => {});
  const store = {
    get<T>(_kind: string, id: string): T | undefined {
      return structuredClone(rows.get(id)) as T | undefined;
    },
    save(_kind: string, id: string, _parent: string, value: unknown) {
      rows.set(id, structuredClone(value));
      saves.push(id);
    },
    addMessage(conversationId: string, role: string, content: string, workflowId?: string) {
      const message = {
        id: randomUUID(),
        conversationId,
        role,
        content,
        workflowId,
        createdAt: new Date(clock).toISOString(),
      };
      rows.set(message.id, message);
      return message;
    },
    allMessages(conversationId: string) {
      return [...rows.values()]
        .filter((row) => (row as { conversationId?: string; role?: string }).conversationId === conversationId)
        .filter((row) => (row as { role?: string }).role)
        .map((row) => structuredClone(row)) as ConversationMessage[];
    },
    db: {
      prepare: (sql: string) => ({
        all: () => {
          const db = new DatabaseSync(':memory:');
          try {
            db.exec('CREATE TABLE workspace_records (kind TEXT, value TEXT)');
            const insert = db.prepare('INSERT INTO workspace_records VALUES (?, ?)');
            for (const row of rows.values()) insert.run('message', JSON.stringify(row));
            return db.prepare(sql).all();
          } finally {
            db.close();
          }
        },
      }),
    },
  };
  const conversation = { id: randomUUID(), projectId: 'project', title: 'Test' } as Conversation;
  rows.set(conversation.id, conversation);
  const broadcast = t.mock.fn();
  const workspace = {
    store,
    controller: { targets: [], snapshots: [], broadcast },
    notifyConversationChanged() {},
  } as unknown as Workspace;
  const bridge = {
    available: () => true,
    request: async (request: WebAgentRequest) => {
      calls.push(request);
      return handler(request);
    },
  };
  const open = () =>
    new ExternalAgents(workspace, 'unused-fixture-config', {
      autoPoll: false,
      now: () => clock,
      bridge,
      webFollowPollMs: 10,
      webFollowSilenceMs: 100,
      webFollowMaxMs: 1000,
      ...options,
    });
  let agents = open();
  t.after(() => agents.close());
  const input: MessageInput = {
    content: 'Question',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  };
  return {
    get agents() {
      return agents;
    },
    calls,
    saves,
    broadcast,
    store,
    conversation,
    workspace,
    input,
    message: (id: string) => store.get<ConversationMessage>('message', id)!,
    send: () => agents.intercept(conversation.id, { ...input, externalAgentId: 'muse' })!.reply.id,
    async tick(ms = 10) {
      clock += ms;
      await agents.poll();
    },
    restart() {
      agents.close();
      agents = open();
    },
  };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
const initial = { ok: true, reply: 'Working on it.', trackerId: 'tracker-1' };

const usageReading = () => ({ ok: true, quota: parseWebUsage('Used 23%', 0) });
const usageCalls = (calls: WebAgentRequest[]) => calls.filter((r) => r.action === 'usage');

test('Muse sign-in resumes automatic usage without clearing the previous attempt or bypassing cadence', async (t) => {
  let authenticated = false;
  const f = fixture(t, (r) =>
    r.action === 'monitor' ? { ok: true, authenticated } : r.action === 'usage' ? usageReading() : { ok: false },
  );
  f.agents.config.update('muse', { usageSignedOut: true, usageAttemptedAt: new Date(0).toISOString() });
  await f.tick(1000);
  assert.equal(usageCalls(f.calls).length, 0);
  authenticated = true;
  await f.tick(1000);
  assert.equal(usageCalls(f.calls).length, 0);
  assert.equal(f.agents.config.agent('muse').usageSignedOut, false);
  assert.equal(f.agents.config.agent('muse').usageAttemptedAt, new Date(0).toISOString());
  assert.ok(f.calls.filter((r) => r.action === 'monitor').every((r) => r.usageSignedOut));
  await f.tick(12 * 3_600_000 - 2000);
  assert.equal(usageCalls(f.calls).length, 1);
  assert.equal(f.calls.filter((r) => r.action === 'monitor').at(-1)?.usageSignedOut, false);
  assert.ok(f.calls.every((r) => r.action === 'usage' || r.action === 'monitor'));
});

for (const afterReply of [false, true])
  test(`Muse repeated login failures stay bounded over an hour of five-second polls (afterReply=${afterReply})`, async (t) => {
    const attempts: number[] = [];
    const f = fixture(t, (r) => {
      if (r.action === 'monitor') return { ok: true, authenticated: true };
      if (r.action === 'usage') {
        attempts.push(Date.parse(f.agents.config.agent('muse').usageAttemptedAt!));
        return { ok: false, code: 'login' };
      }
      return { ok: false };
    });
    for (let poll = 0; poll < 720; poll++) {
      if (poll === 360) f.restart();
      await f.tick(poll === 0 ? 0 : 5000);
      if (afterReply) await f.agents.readUsage('muse', true, true);
    }
    assert.equal(attempts.length, afterReply ? 6 : 1);
    for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i]! - attempts[i - 1]! >= 600_000);
    assert.equal(Date.parse(f.agents.config.agent('muse').usageAttemptedAt!), attempts.at(-1));
  });

test('Muse defers a task-end usage read until the ten-minute minimum and retains the pending refresh', async (t) => {
  const f = fixture(t, (r) =>
    r.action === 'usage'
      ? usageReading()
      : r.action === 'send'
        ? { ok: true, reply: 'Synthetic answer' }
        : { ok: false, code: 'closed' },
  );
  await f.tick(0);
  f.send();
  await flush();
  await f.tick(3000);
  assert.equal(usageCalls(f.calls).length, 1);
  await f.tick(596_999);
  assert.equal(usageCalls(f.calls).length, 1);
  await f.tick(1);
  assert.equal(usageCalls(f.calls).length, 2);
  assert.equal(usageCalls(f.calls).at(-1)?.afterReply, true);
});

test('Muse invalid monitor readings still save learned routes, rules and redacted diagnostics without replacing quota', async (t) => {
  const previous = usageReading().quota;
  const signatures = [
    {
      method: 'GET' as const,
      origin: 'https://fixture.test',
      path: '/api/usage',
      windows: [{ id: 'weekly', label: 'Weekly', percent: { path: ['percent'], scale: 1 } }],
      balances: [],
    },
  ];
  let result: WebAgentResult;
  const f = fixture(t, (r) => (r.action === 'monitor' ? result : { ok: false, code: 'closed' }));
  f.agents.config.update('muse', { quota: previous, usageAttemptedAt: new Date(0).toISOString() });
  for (const reading of [
    { ok: false, quota: parseWebUsage('Used 99%', 1) },
    { ok: true, code: 'error' as const, quota: parseWebUsage('Used 99%', 1) },
    { ok: true, quota: parseWebUsage('Welcome', 1) },
    { ok: true, quota: { ...usageReading().quota, stale: true } },
  ]) {
    f.agents.config.update('muse', { usageUrl: '', usageSignatures: [], usageDiagnostics: [] });
    result = {
      ...reading,
      signatures,
      usageUrl: 'https://fixture.test/settings/usage',
      usageDiagnostics: ['PRIVATE_NAME private@example.test 免费版 每周限额 10月14日 CSRF_secret'],
    };
    await f.tick(5000);
    f.restart();
    const saved = f.agents.config.agent('muse');
    assert.equal(saved.usageUrl, result.usageUrl);
    assert.deepEqual(saved.usageSignatures, signatures);
    assert.deepEqual(saved.usageDiagnostics, ['免费版 · 每周限额 · 10月14日']);
    assert.deepEqual(saved.quota, previous);
  }
  assert.equal(usageCalls(f.calls).length, 0);
});

test('Muse schedules at exactly twelve hours since each attempt, including manual reads and failures', async (t) => {
  let fail = false;
  const f = fixture(t, (r) =>
    r.action === 'usage'
      ? fail
        ? { ok: false, code: 'load-failed', message: 'do not show this error' }
        : usageReading()
      : { ok: false, code: 'closed' },
  );
  await f.tick(0);
  assert.equal(usageCalls(f.calls).length, 1);
  await f.tick(12 * 3_600_000 - 1);
  assert.equal(usageCalls(f.calls).length, 1);
  await f.tick(1);
  assert.equal(usageCalls(f.calls).length, 2);
  await f.agents.readUsage('muse');
  assert.equal(usageCalls(f.calls).length, 3);
  assert.equal(usageCalls(f.calls).at(-1)?.background, undefined, 'manual request unchanged');
  fail = true;
  const previous = f.agents.config.agent('muse').quota;
  const broadcasts = f.broadcast.mock.callCount();
  await f.tick(12 * 3_600_000);
  assert.equal(usageCalls(f.calls).length, 4);
  assert.deepEqual(f.agents.config.agent('muse').quota, previous);
  assert.equal(f.broadcast.mock.callCount(), broadcasts);
  await f.tick(12 * 3_600_000 - 1);
  assert.equal(usageCalls(f.calls).length, 4);
  await f.tick(1);
  assert.equal(usageCalls(f.calls).length, 5);
  assert.ok(f.calls.every((r) => r.action === 'usage' || r.action === 'monitor'));
});

for (const failure of ['login', 'human-check', 'timeout', 'parse', 'throw'] as const) {
  test(`Muse automatic ${failure} preserves data and timestamp without broadcasting an error`, async (t) => {
    const f = fixture(t, (r) => {
      if (r.action !== 'usage') return { ok: false, code: 'closed' };
      if (failure === 'throw') throw new Error('synthetic network error');
      return failure === 'parse'
        ? { ok: true, quota: parseWebUsage('Welcome', 1) }
        : { ok: false, code: failure, message: 'must stay quiet' };
    });
    const previous = usageReading().quota;
    f.agents.config.update('muse', { quota: previous });
    const broadcasts = f.broadcast.mock.callCount();
    const result = await f.agents.readUsage('muse', true);
    assert.equal(result.ok, false);
    assert.equal(result.message, '');
    assert.deepEqual(f.agents.config.agent('muse').quota, previous);
    assert.equal(f.broadcast.mock.callCount(), broadcasts);
    await f.tick(12 * 3_600_000);
    assert.equal(usageCalls(f.calls).length, failure === 'login' || failure === 'human-check' ? 1 : 2);
    assert.ok(f.calls.every((r) => r.action === 'usage' || r.action === 'monitor'));
  });
}

for (const outcome of ['success', 'failure', 'cancel'] as const) {
  test(`Muse ${outcome} task bursts produce exactly one debounced background usage read`, async (t) => {
    const f = fixture(t, (r) =>
      r.action === 'send'
        ? outcome === 'failure'
          ? { ok: false, code: 'error' }
          : outcome === 'cancel'
            ? initial
            : { ok: true, reply: 'Synthetic answer' }
        : r.action === 'usage'
          ? usageReading()
          : { ok: false, code: 'closed' },
    );
    for (let i = 0; i < 3; i++) {
      const id = f.send();
      await flush();
      if (outcome === 'cancel') {
        f.agents.stopFollowing(id);
        await flush();
      }
    }
    assert.equal(usageCalls(f.calls).length, 0);
    await f.tick(2999);
    assert.equal(usageCalls(f.calls).length, 0);
    await f.tick(1);
    assert.equal(usageCalls(f.calls).length, 1);
    assert.equal(usageCalls(f.calls)[0]?.background, true);
    await f.tick(5000);
    assert.equal(usageCalls(f.calls).length, 1);
    assert.equal(f.calls.filter((r) => r.action === 'send').length, 3, 'usage never sends a prompt');
  });
}

test('Muse cancellation during send and while queued also schedules only one read after the burst', async (t) => {
  let finish!: (result: WebAgentResult) => void;
  const f = fixture(t, (r) =>
    r.action === 'send'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : r.action === 'usage'
        ? usageReading()
        : { ok: false, code: 'closed' },
  );
  const controllers = [new AbortController(), new AbortController()];
  const runs = controllers.map((controller) =>
    f.agents.run(
      {
        id: randomUUID(),
        conversationId: f.conversation.id,
        input: f.input,
        delegation: { agent: { externalAgentId: 'muse' } },
      } as Workflow,
      controller.signal,
      () => {},
    ),
  );
  await flush();
  const rejected = runs.map((run) => assert.rejects(run, /cancelled/));
  for (const controller of controllers) controller.abort(new Error('cancelled'));
  await Promise.all(rejected);
  finish({ ok: false, code: 'error' });
  await flush();
  await f.tick(3000);
  assert.equal(usageCalls(f.calls).length, 1);
  assert.equal(f.calls.filter((r) => r.action === 'send').length, 1);
});

test('Muse task-end triggers during an in-flight usage read are coalesced without a second read', async (t) => {
  let finish!: (result: WebAgentResult) => void;
  const f = fixture(t, (r) =>
    r.action === 'usage'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : r.action === 'send'
        ? { ok: true, reply: 'Synthetic answer' }
        : { ok: false, code: 'closed' },
  );
  const pending = f.agents.readUsage('muse', true);
  f.send();
  await flush();
  f.send();
  await flush();
  await f.agents.readUsage('muse', true, true);
  finish(usageReading());
  await pending;
  await f.tick(5000);
  assert.equal(usageCalls(f.calls).length, 1);
});

test('interim reply and later answer update one untrusted message; identical redraw does not patch or extend silence', async (t) => {
  let text = initial.reply;
  const f = fixture(t, (request) =>
    request.action === 'send' ? initial : request.action === 'peek' ? { ok: true, reply: text } : { ok: true },
  );
  const id = f.send();
  await flush();
  assert.equal(f.message(id).externalAgent!.status, 'done');
  assert.ok(f.message(id).externalAgent!.following);
  const count = f.saves.filter((saved) => saved === id).length;
  await f.tick(50);
  assert.equal(f.saves.filter((saved) => saved === id).length, count);
  text += '\n\nHere is the real answer.';
  await f.tick(10);
  assert.equal(f.message(id).content, text);
  assert.equal(f.message(id).externalAgent!.untrusted, true);
  await f.tick(90);
  assert.ok(f.message(id).externalAgent!.following);
  await f.tick(10);
  assert.equal(f.message(id).externalAgent!.status, 'done');
  assert.equal(f.message(id).content, text);
  assert.equal(f.message(id).externalAgent!.following, undefined);
  assert.ok(f.calls.some((r) => r.action === 'stop' && r.trackerId === 'tracker-1'));
});

test('a new send never waits for an old peek and its late result cannot overwrite either message', async (t) => {
  let release!: (value: WebAgentResult) => void;
  let sends = 0;
  const f = fixture(t, (r) =>
    r.action === 'send'
      ? { ...initial, reply: `Answer ${++sends}`, trackerId: `tracker-${sends}` }
      : r.action === 'peek'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { ok: true },
  );
  const first = f.send();
  await flush();
  const poll = f.tick();
  await flush();
  const second = f.send();
  await flush();
  assert.equal(sends, 2);
  assert.equal(f.message(first).externalAgent!.status, 'done');
  release({ ok: true, reply: 'STALE RESULT' });
  await poll;
  assert.equal(f.message(first).content, 'Answer 1');
  assert.equal(f.message(second).content, 'Answer 2');
  assert.equal(f.message(second).externalAgent!.following?.trackerId, 'tracker-2');
});

for (const reason of [
  'closed',
  'replaced',
  'lost',
  'human-check',
  'login',
  'limit',
  'stop',
  'restart',
  'archive',
  'delete',
  'cap',
] as const) {
  test(`ending for ${reason} retains the reply`, async (t) => {
    const f = fixture(t, (r) =>
      r.action === 'send'
        ? initial
        : r.action === 'peek'
          ? reason === 'limit'
            ? { ok: false, limit: { reason: 'quota', observedAt: new Date(0).toISOString(), resetsAt: null } }
            : { ok: false, code: reason as WebAgentResult['code'] }
          : { ok: true },
    );
    const id = f.send();
    await flush();
    if (reason === 'stop') f.agents.stopFollowing(id);
    else if (reason === 'restart') f.restart();
    else {
      if (reason === 'archive' || reason === 'delete')
        f.store.save('conversation', f.conversation.id, 'project', {
          ...f.conversation,
          [reason === 'archive' ? 'archivedAt' : 'deletedAt']: 'now',
        });
      await f.tick(reason === 'cap' ? 1000 : 10);
    }
    assert.equal(f.message(id).content, initial.reply);
    assert.equal(f.message(id).externalAgent!.status, 'done');
    assert.equal(f.message(id).externalAgent!.following, undefined);
    if (reason === 'restart') assert.equal(f.message(id).externalAgent!.note, '跟进已中断，可到它的窗口查看后续');
    assert.ok(f.calls.some((r) => r.action === 'stop'));
  });
}

test('restart between interim and final answer recovers the final answer read-only without resending', async (t) => {
  let finalReply = initial.reply;
  const f = fixture(t, (r) => {
    if (r.action === 'send') return initial;
    if (r.action === 'recapture') return { ok: true, sent: true, reply: finalReply, trackerId: 'recovered-1' };
    return { ok: true };
  });
  const id = f.send();
  await flush();
  assert.equal(f.message(id).content, initial.reply);
  f.restart();
  assert.equal(f.message(id).externalAgent!.note, '跟进已中断，可到它的窗口查看后续');
  finalReply = 'Working on it.\n\nComplete answer after restart';
  await f.tick();
  assert.equal(f.message(id).content, finalReply);
  assert.equal(f.message(id).externalAgent!.note, undefined);
  assert.equal(f.calls.filter((r) => r.action === 'send').length, 1);
  assert.equal(
    f.calls.some((r) => r.action === 'recapture'),
    true,
  );
});

test('usage and re-detect cannot take a following window; automatic usage waits until following ends', async (t) => {
  const f = fixture(t, (r) => (r.action === 'send' ? initial : { ok: true, reply: initial.reply }));
  const id = f.send();
  await flush();
  for (const automatic of [false, true]) {
    assert.equal((await f.agents.readUsage('muse', automatic, true)).ok, false);
  }
  await assert.rejects(f.agents.detect('muse'), /Muse 还在跟进上一条回复，先点「停止跟进」再重新识别/);
  await f.tick();
  assert.equal(
    f.calls.filter((r) => ['usage', 'detect', 'monitor'].includes(r.action) && r.agentId === 'muse').length,
    0,
  );
  f.agents.stopFollowing(id);
  await flush();
  await f.tick(3000);
  assert.equal(f.calls.filter((r) => r.action === 'usage').length, 1);
});

test('partial timeouts follow and preserve the end of a long reply', async (t) => {
  const text = 'a'.repeat(100_100) + 'LAST ANSWER';
  const f = fixture(t, (r) => (r.action === 'send' ? { ...initial, partial: true } : { ok: true, reply: text }));
  const id = f.send();
  await flush();
  assert.match(f.message(id).externalAgent!.note!, /回复可能不完整/);
  assert.equal(f.message(id).externalAgent!.truncated, undefined);
  await f.tick();
  assert.equal(f.message(id).content, text.slice(-100_000));
  assert.equal(f.message(id).externalAgent!.note, undefined);
  assert.equal(f.message(id).externalAgent!.truncated, true);
  assert.ok(f.message(id).externalAgent!.following);
  const html = renderToStaticMarkup(
    createElement(ExternalReplyPanel, {
      message: f.message(id),
      api: async () => ({ ok: true }) as any,
      notify() {},
    }),
  );
  assert.match(html, /回复太长，这里只显示最后一部分/);
});

test('a peek started before the silence deadline retains text returned after it', async (t) => {
  let release!: (value: WebAgentResult) => void;
  const f = fixture(t, (r) =>
    r.action === 'send'
      ? initial
      : r.action === 'peek'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { ok: true },
  );
  const id = f.send();
  await flush();
  const pending = f.tick(90);
  await flush();
  await f.tick(20);
  release({ ok: true, reply: 'Late real answer' });
  await pending;
  assert.equal(f.message(id).content, 'Late real answer');
  await f.tick(100);
  assert.equal(f.message(id).externalAgent!.following, undefined);
});

for (const queuedBeforeReply of [false, true])
  test(`partial reply note survives a new send queued before reply: ${queuedBeforeReply}`, async (t) => {
    let release!: (value: WebAgentResult) => void;
    let sends = 0;
    const f = fixture(t, (r) =>
      r.action === 'send' && ++sends === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { ok: true, reply: initial.reply },
    );
    const id = f.send();
    await flush();
    if (queuedBeforeReply) f.send();
    release({ ...initial, partial: true });
    await flush();
    if (!queuedBeforeReply) {
      await f.tick();
      assert.match(f.message(id).externalAgent!.note!, /回复可能不完整/);
      f.send();
      await flush();
    }
    assert.equal(f.message(id).externalAgent!.following, undefined);
    assert.match(f.message(id).externalAgent!.note!, /回复可能不完整/);
    assert.equal(f.message(id).content, initial.reply);
  });

for (const cancel of [false, true])
  test(`coordinated waiter ${cancel ? 'cancels following' : 'waits until following ends'}`, async (t) => {
    const f = fixture(t, (r) => (r.action === 'send' ? initial : { ok: true, reply: initial.reply }));
    const controller = new AbortController();
    const workflow = {
      id: randomUUID(),
      conversationId: f.conversation.id,
      input: f.input,
      delegation: { agent: { externalAgentId: 'muse' } },
    } as Workflow;
    let finished = false;
    const run = f.agents
      .run(workflow, controller.signal, () => {})
      .finally(() => {
        finished = true;
      });
    await flush();
    assert.equal(finished, false);
    if (cancel) {
      const rejected = assert.rejects(run, /cancelled/);
      controller.abort(new Error('cancelled'));
      await rejected;
    } else {
      await f.tick(100);
      assert.equal((await run).ok, true);
    }
    const messageId = f.saves.find((id) => f.store.get<ConversationMessage>('message', id)?.externalAgent)!;
    assert.equal(f.message(messageId).content, initial.reply);
    assert.equal(f.message(messageId).externalAgent!.status, 'done');
    assert.equal(f.message(messageId).externalAgent!.following, undefined);
  });

test('a legacy single reply without a tracker still finishes immediately', async (t) => {
  const f = fixture(t, () => ({ ok: true, reply: 'One bubble' }));
  const id = f.send();
  await flush();
  assert.equal(f.message(id).externalAgent!.status, 'done');
  assert.equal(f.message(id).content, 'One bubble');
});

test('a tracked single bubble is done without a spinner, quietly followed for the default two minutes', async (t) => {
  const f = fixture(
    t,
    (r) => (r.action === 'send' ? { ...initial, reply: 'One bubble' } : { ok: true, reply: 'One bubble' }),
    {
      webFollowSilenceMs: undefined,
      webFollowMaxMs: undefined,
    },
  );
  const id = f.send();
  await flush();
  const panel = () =>
    renderToStaticMarkup(
      createElement(ExternalReplyPanel, {
        message: f.message(id),
        api: async () => ({ ok: true }) as any,
        notify() {},
      }),
    );
  assert.equal(f.message(id).externalAgent!.status, 'done');
  assert.deepEqual(f.message(id).externalAgent!.following, { trackerId: 'tracker-1' });
  assert.equal(f.agents.view('muse').queued, 0);
  assert.doesNotMatch(externalAgentStatus(f.agents.view('muse')), /正在处理/);
  assert.match(panel(), /class="external-reply done"/);
  assert.match(panel(), /class="external-reply-note"[^>]*>.*正在留意 Muse 的后续回复/);
  assert.match(panel(), /停止跟进/);
  assert.doesNotMatch(panel(), /spinning|处理中/);
  await f.tick(119_999);
  assert.ok(f.message(id).externalAgent!.following);
  await f.tick(1);
  assert.equal(f.message(id).externalAgent!.following, undefined);
  assert.equal(f.message(id).content, 'One bubble');
  assert.equal(f.message(id).externalAgent!.note, undefined);
  assert.doesNotMatch(panel(), /正在留意|停止跟进|spinning/);
});

for (const code of ['error', 'timeout', 'rejection'] as const)
  test(`transient peek ${code} preserves following and the silence deadline`, async (t) => {
    let fail = true;
    const f = fixture(t, (r) => {
      if (r.action === 'send') return initial;
      if (r.action === 'peek' && fail) {
        if (code === 'rejection') throw new Error('temporary timeout');
        return { ok: false, code };
      }
      return { ok: true, reply: 'Later answer' };
    });
    const id = f.send();
    await flush();
    await f.tick();
    assert.ok(f.message(id).externalAgent!.following);
    assert.equal(f.message(id).content, initial.reply);
    fail = false;
    await f.tick();
    assert.equal(f.message(id).content, 'Later answer');
    fail = true;
    await f.tick(90);
    assert.ok(f.message(id).externalAgent!.following);
    await f.tick(10);
    assert.equal(f.message(id).externalAgent!.following, undefined);
    assert.equal(f.message(id).content, 'Later answer');
  });

test('a follow poll failure does not skip the same rounds Grok checks', async (t) => {
  const f = fixture(t, () => ({ ok: true }));
  const service = f.agents as any;
  const follows = t.mock.method(service, 'pollFollows', async () => {
    throw new Error('follow failed');
  });
  const login = t.mock.method(service, 'collectGrokLogin', async () => {});
  const grok = t.mock.method(service, 'readGrokUsage', async () => {});
  await f.tick();
  for (const call of [follows, login, grok]) assert.equal(call.mock.callCount(), 1);
});

test('the total cap ends following even when text keeps changing', async (t) => {
  let revision = 0;
  const f = fixture(t, (r) => (r.action === 'send' ? initial : { ok: true, reply: `Update ${++revision}` }), {
    webFollowMaxMs: 40,
  });
  const id = f.send();
  await flush();
  for (let i = 0; i < 3; i++) {
    await f.tick();
    assert.ok(f.message(id).externalAgent!.following);
  }
  const last = f.message(id).content;
  await f.tick();
  assert.equal(f.message(id).externalAgent!.status, 'done');
  assert.equal(f.message(id).content, last);
});

test('archive during a pending peek drops its result and retains the saved reply', async (t) => {
  let release!: (value: WebAgentResult) => void;
  const f = fixture(t, (r) =>
    r.action === 'send'
      ? initial
      : r.action === 'peek'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { ok: true },
  );
  const id = f.send();
  await flush();
  const pending = f.tick();
  await flush();
  f.store.save('conversation', f.conversation.id, 'project', { ...f.conversation, archivedAt: 'now' });
  release({ ok: true, reply: 'LATE' });
  await pending;
  assert.equal(f.message(id).content, initial.reply);
  assert.equal(f.message(id).externalAgent!.status, 'done');
});

test('queuing a second request in another conversation preserves and recaptures the first conversation final answer', async (t) => {
  let firstFinal = 'Working on it.';
  const f = fixture(t, (r) => {
    if (r.action === 'send') {
      if (r.conversationId === f.conversation.id) {
        return { ok: true, reply: firstFinal, trackerId: 'tracker-1', pageUrl: 'https://fixture.test/t/1' };
      }
      return {
        ok: true,
        reply: 'Second conversation answer',
        trackerId: 'tracker-2',
        pageUrl: 'https://fixture.test/t/2',
      };
    }
    if (r.action === 'recapture' && r.conversationId === f.conversation.id) {
      return { ok: true, reply: firstFinal, trackerId: 'tracker-1-recaptured' };
    }
    return { ok: true, reply: 'Second conversation answer' };
  });
  const secondConversation = { id: randomUUID(), projectId: 'project', title: 'Second' } as Conversation;
  f.store.save('conversation', secondConversation.id, 'project', secondConversation);

  const firstId = f.send();
  await flush();
  assert.equal(f.message(firstId).content, 'Working on it.');

  const secondId = f.agents.intercept(secondConversation.id, { ...f.input, externalAgentId: 'muse' })!.reply.id;
  await flush();
  assert.equal(f.message(secondId).content, 'Second conversation answer');

  firstFinal = 'Working on it.\n\nFinal answer for conversation 1';
  await f.tick();
  assert.equal(f.message(firstId).content, 'Working on it.\n\nFinal answer for conversation 1');
  assert.equal(f.message(secondId).content, 'Second conversation answer');
});
