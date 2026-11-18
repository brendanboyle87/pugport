import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState, RunRecord, Workflow, ConversationMessage } from '../src/shared/types.ts';
import { executorTasks, executorStatus } from '../src/ui/executor-activity.ts';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';

const stamp = '2026-10-28T12:00:00Z';
const run = (id: string, runtimeId: string, status: RunRecord['status'] = 'running') =>
  ({ id, route: { runtimeId }, status, startedAt: stamp, workflowId: id }) as RunRecord;
const flow = (id: string, status: Workflow['status'], runtimeId?: string) =>
  ({ id, conversationId: id, status, phase: 'plan', input: { runtimeId }, runIds: [id], createdAt: stamp }) as Workflow;
const state = (extra: Partial<AppState> = {}) =>
  ({ runs: [], workflows: [], conversationMessages: [], conversations: [], ...extra }) as AppState;

test('CLI, managed account and same-provider API cards use exact routed identities, never labels or provider names', () => {
  const runs = [
    run('local', 'codex'),
    run('work', 'codex-work'),
    run('api', 'api-anthropic'),
    run('api2', 'api-anthropic-2'),
  ];
  runs[1]!.account = { id: 'different-account-id', label: 'Codex', provider: 'codex' };
  runs[2]!.apiProvider = 'anthropic';
  const tasks = executorTasks(state({ runs, workflows: [flow('local', 'planning')] }));
  for (const [id, expected] of [
    ['codex', 'local'],
    ['codex-work', 'work'],
    ['api-anthropic', 'api'],
    ['api-anthropic-2', 'api2'],
  ]) {
    assert.deepEqual(
      tasks.get(id!)?.map((task) => task.id),
      [expected],
    );
    assert.deepEqual(executorStatus(tasks.get(id!)), { status: 'running', count: 1 });
  }
  assert.equal(tasks.get('codex')![0]!.phase, '正在拆解');
  assert.equal(tasks.has('anthropic'), false);
  assert.equal(tasks.has('different-account-id'), false);
});

test('running wins over waiting, errors win over both, settled runs never count', () => {
  const tasks = executorTasks(
    state({
      runs: [
        run('r', 'a'),
        run('w', 'a', 'waiting-approval'),
        run('q', 'a', 'queued'),
        ...(['completed', 'failed', 'cancelled', 'interrupted'] as const).map((s) => run(s, 'a', s)),
      ],
    }),
  ).get('a')!;
  assert.deepEqual(executorStatus(tasks), { status: 'running', count: 1 });
  assert.deepEqual(executorStatus(tasks.filter((t) => t.status === 'waiting')), { status: 'waiting', count: 2 });
  assert.deepEqual(executorStatus(tasks, '需要登录'), { status: 'error', count: 0 });
  assert.deepEqual(executorStatus([]), { status: 'ready', count: 0 });
});

test('only assigned queued/quota/approval workflows count, without duplicating their live runs', () => {
  const workflows = [
    flow('queue', 'queued', 'codex'),
    flow('quota', 'waiting-resource', 'codex'),
    flow('approve', 'waiting-approval', 'codex'),
    flow('auto', 'queued'),
    flow('done', 'completed', 'codex'),
    { ...flow('deleted', 'queued', 'codex'), deletedAt: stamp },
  ];
  const tasks = executorTasks(state({ workflows, runs: [run('approve', 'codex', 'waiting-approval')] }));
  assert.deepEqual(executorStatus(tasks.get('codex')), { status: 'waiting', count: 3 });
  assert.equal([...tasks.values()].flat().length, 3);
});

test('external agents use message agentId and exclude done, failed and passive following', () => {
  const message = (id: string, agentId: string, status: string, following?: object) =>
    ({
      id,
      conversationId: 'chat',
      createdAt: stamp,
      externalAgent: { agentId, name: 'Same label', status, following },
    }) as ConversationMessage;
  const tasks = executorTasks(
    state({
      conversationMessages: [
        message('g', 'grok-bot', 'working'),
        message('m', 'muse', 'queued'),
        message('u', 'muse', 'needs-user'),
        message('d', 'muse', 'done'),
        message('f', 'muse', 'failed'),
        message('p', 'muse', 'working', { trackerId: 'passive' }),
      ],
    }),
  );
  assert.deepEqual(executorStatus(tasks.get('grok-bot')), { status: 'running', count: 1 });
  assert.deepEqual(executorStatus(tasks.get('muse')), { status: 'waiting', count: 2 });
  assert.equal(tasks.get('grok-bot')![0]!.conversationId, 'chat');
});

test('live external tasks survive the recent-message window without duplicating or retaining settled tasks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new WorkspaceStore(db, { recoverInterrupted: false });
    for (const status of ['working', 'queued', 'needs-user', 'done', 'failed']) {
      const message = {
        id: status,
        conversationId: 'chat',
        createdAt: stamp,
        externalAgent: { agentId: 'muse', status },
      };
      store.save('message', status, 'chat', message);
    }
    store.save('message', 'following', 'chat', {
      id: 'following',
      createdAt: stamp,
      externalAgent: { status: 'working', following: { trackerId: 'passive' } },
    });
    db.exec("UPDATE workspace_records SET updated_at='2000-01-01' WHERE kind='message'");
    for (let i = 0; i < 105; i++) store.save('message', `new-${i}`, 'chat', { id: `new-${i}`, createdAt: stamp });
    let messages = store.recentMessages();
    assert.equal(messages.length, 103);
    assert.equal(new Set(messages.map((m) => m.id)).size, 103);
    assert.deepEqual(
      messages
        .filter((m) => m.externalAgent)
        .map((m) => m.id)
        .sort(),
      ['needs-user', 'queued', 'working'],
    );
    store.save('message', 'working', 'chat', {
      id: 'working',
      createdAt: stamp,
      externalAgent: { agentId: 'muse', status: 'working' },
    });
    messages = store.recentMessages();
    assert.equal(messages.filter((m) => m.id === 'working').length, 1);
    store.save('message', 'queued', 'chat', {
      id: 'queued',
      createdAt: stamp,
      externalAgent: { agentId: 'muse', status: 'done' },
    });
    db.exec("UPDATE workspace_records SET updated_at='2000-01-01' WHERE id='queued'");
    assert.equal(
      store.recentMessages().some((m) => m.id === 'queued'),
      false,
    );
  } finally {
    db.close();
  }
});
