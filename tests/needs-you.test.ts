import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, RunRecord, Workflow } from '../src/shared/types.ts';
import { needsContinuation, workflowAttention, workflowNeedsUser } from '../src/shared/conversation-activity.ts';
import { activityFilters, sidebarActivity, sidebarScope } from '../src/ui/sidebar-activity.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = new Date().toISOString();
const chat = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  projectId: 'project',
  createdAt: stamp,
  updatedAt: stamp,
  ...extra,
});
const flow = (id: string, status: Workflow['status'], extra: Partial<Workflow> = {}): Workflow =>
  ({ id, conversationId: id, status, createdAt: stamp, runIds: [], ...extra }) as Workflow;
const question = { text: 'Which branch?', askedAt: stamp, options: [] };

test('workflowAttention derives all four kinds with question priority and structured last-run text only', () => {
  assert.deepEqual(workflowAttention(flow('q', 'waiting-approval', { userQuestion: question })), {
    kind: 'question',
    text: question.text,
  });
  assert.deepEqual(workflowAttention(flow('a', 'waiting-approval')), { kind: 'approval' });
  assert.deepEqual(workflowAttention(flow('c', 'waiting-confirmation')), { kind: 'confirmation' });
  for (const status of ['blocked', 'interrupted', 'failed'] as const) {
    const workflow = flow('s', status, { runIds: ['older', 'last'] });
    assert.deepEqual(
      workflowAttention(workflow, { id: 'last', taskOutcome: { summary: 'Missing fixture' } } as RunRecord),
      { kind: 'stopped', text: 'Missing fixture' },
    );
    assert.equal(
      workflowAttention(workflow, { id: 'older', taskOutcome: { summary: 'Old result' } } as RunRecord)?.text,
      undefined,
    );
    assert.equal(workflowAttention(workflow, { id: 'last', output: 'Blocked prose' } as RunRecord)?.text, undefined);
    assert.equal(workflowNeedsUser(workflow), true);
  }
  assert.equal(
    workflowAttention(flow('q', 'completed', { userQuestion: { ...question, answeredMessageId: 'answer' } })),
    undefined,
  );
  assert.equal(
    workflowAttention(flow('s', 'blocked', { waitingOn: { kind: 'media-analysis', jobId: 'job', done: 0, total: 1 } })),
    undefined,
  );
  assert.equal(workflowAttention(flow('s', 'cancelled', { stopped: true })), undefined);
});

test('continued, deleted and delegated tasks never need attention; dismissal only hides stopped attention', () => {
  for (const extra of [
    { deletedAt: stamp },
    { followUp: { kind: 'continue', workflowId: 'next', at: stamp } },
    { delegation: { parentId: 'parent' } },
  ] as Partial<Workflow>[]) {
    for (const status of ['completed', 'blocked', 'waiting-approval', 'waiting-confirmation'] as const) {
      const workflow = flow('q', status, { userQuestion: question, ...extra });
      assert.equal(workflowAttention(workflow), undefined);
      assert.equal(workflowNeedsUser(workflow), false);
    }
  }
  const dismissed = flow('s', 'failed', { attentionDismissedAt: stamp });
  assert.equal(workflowAttention(dismissed), undefined);
  assert.equal(needsContinuation(dismissed), true);
  assert.equal(workflowAttention({ ...dismissed, userQuestion: question })?.kind, 'question');
  assert.equal(workflowAttention({ ...dismissed, status: 'waiting-approval' })?.kind, 'approval');
  assert.equal(
    workflowAttention(flow('s', 'blocked', { followUp: { kind: 'message', workflowId: 'other', at: stamp } }))?.kind,
    'stopped',
  );
});

test('stopped work from a dispatching agent, device or outside tool stays with whoever asked for it', () => {
  for (const source of ['caller', 'external', 'device', 'parent'] as const) {
    const stopped = flow('s', 'blocked');
    stopped.input = { ...stopped.input, permissionOrigin: { mode: 'workspace-write', source } };
    assert.equal(workflowAttention(stopped), undefined, source);
    // A question or an approval still needs the owner: only they can answer it in PugPort.
    assert.equal(workflowAttention({ ...stopped, userQuestion: question })?.kind, 'question', source);
    assert.equal(workflowAttention({ ...stopped, status: 'waiting-approval' })?.kind, 'approval', source);
  }
  for (const source of ['user', 'text'] as const) {
    const own = flow('s', 'failed');
    own.input = { ...own.input, permissionOrigin: { mode: 'workspace-write', source } };
    assert.equal(workflowAttention(own)?.kind, 'stopped', source);
  }
});

test('sidebar attention counts and hidden conversation visibility follow the selector', () => {
  const conversations = [
    chat('q'),
    chat('s'),
    chat('dismissed'),
    chat('child'),
    chat('archived', { archivedAt: stamp }),
    chat('deleted', { deletedAt: stamp }),
  ];
  const workflows = [
    flow('q', 'completed', { userQuestion: question }),
    flow('s', 'failed'),
    flow('dismissed', 'failed', { attentionDismissedAt: stamp }),
    flow('child', 'waiting-approval', { delegation: { parentId: 'p' } as Workflow['delegation'] }),
    flow('archived', 'waiting-approval'),
    flow('deleted', 'waiting-confirmation'),
  ];
  assert.equal(sidebarActivity(conversations, workflows, () => false).counts.waiting, 2);
  assert.deepEqual(
    sidebarScope(conversations.slice(0, 4), [], workflows, ['q', 's', 'dismissed', 'child'], false).conversations.map(
      (item) => item.id,
    ),
    ['q', 's'],
  );
  assert.deepEqual(
    activityFilters.map(([key]) => key),
    ['all', 'running', 'unread'],
  );
});

test('inbox renders only active owner conversations, expands newest-first, and uses workflow actions', async () => {
  const calls: unknown[] = [],
    selected: string[] = [],
    notices: unknown[] = [];
  const harness = uiHarness(await uiBundle('src/ui/NeedsYou.tsx'));
  const props = {
    conversations: ['q', 'a', 'c', 's', 'fifth', 'sixth'].map((id) => chat(id)),
    workflows: [
      flow('q', 'completed', { userQuestion: question }),
      flow('a', 'waiting-approval'),
      flow('c', 'waiting-confirmation'),
      flow('s', 'failed', { runIds: ['last'] }),
      flow('fifth', 'blocked'),
      flow('sixth', 'interrupted'),
    ].map((item, i) => ({ ...item, createdAt: new Date(Date.parse(stamp) - i * 86_400_000).toISOString() })),
    runs: [{ id: 'last', taskOutcome: { summary: 'Missing fixture' } } as RunRecord],
    api: async (...args: unknown[]) => {
      calls.push(args);
    },
    notify: (notice: unknown) => notices.push(notice),
    onSelect: (conversation: Conversation, workflow: Workflow) => selected.push(`${conversation.id}/${workflow.id}`),
  };
  const render = () => harness.render('NeedsYou', props);
  assert.equal(harness.render('NeedsYou', { ...props, workflows: [] }), null);
  let tree = render();
  for (const reason of ['Which branch?', '等你批准', '等你确认方案', '停下了', 'Missing fixture'])
    assert.ok(text(tree).includes(reason));
  assert.ok(text(tree).includes('还有 1 项'));
  assert.ok(!text(tree).includes('sixth'));
  findNode(tree, (node) => node.props.className === 'conversation-link needs-you-link')!.props.onClick();
  assert.deepEqual(selected, ['q/q']);
  findNode(tree, (node) => node.props['aria-label'] === '继续')!.props.onClick();
  await nextTurn();
  findNode(render(), (node) => node.props['aria-label'] === '忽略')!.props.onClick();
  await nextTurn();
  assert.deepEqual(structuredClone(calls), [
    ['/api/workflows/s/continue', { uiLocale: 'zh-CN' }, 'POST'],
    ['/api/workflows/s/dismiss-attention', {}, 'POST'],
  ]);
  assert.deepEqual(notices, []);
  findNode(tree, (node) => node.props.className === 'needs-you-more')!.props.onClick();
  tree = render();
  assert.ok(text(tree).includes('sixth'));
  assert.equal(
    findNode(tree, (node) => node.props.className === 'needs-you-more'),
    undefined,
  );
  assert.equal(
    harness.render('NeedsYou', {
      ...props,
      conversations: props.conversations.map((item) => ({ ...item, archivedAt: stamp })),
    }),
    null,
  );
  assert.equal(
    harness.render('NeedsYou', {
      ...props,
      conversations: props.conversations.map((item) => ({ ...item, deletedAt: stamp })),
    }),
    null,
  );
});

test('old waiting filter falls back to all and the filter row has no retired button', async () => {
  const storage = new Map([['pugport-activity-filter', 'waiting']]);
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: { state: undefined, api: async () => ({}), reload: async () => {}, connection: 'connecting' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const tree = harness.render('default');
  assert.equal(findNode(tree, (node) => node.type === 'button' && node.key === 'all')!.props['aria-pressed'], true);
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && node.key === 'waiting'),
    undefined,
  );
  assert.ok(
    !text(findNode(tree, (node) => node.props.className === 'sidebar-activity-filter sidebar-filters')).includes(
      '等我处理',
    ),
  );
  assert.equal(storage.get('pugport-activity-filter'), 'all');
});

test('stopped attention expires after 14 days and superseding preserves continuation and live questions', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const recent = flow('latest', 'failed', { createdAt: new Date(now).toISOString() });
  assert.equal(workflowAttention(recent, undefined, now)?.kind, 'stopped');
  const superseded = { ...recent, supersededAt: stamp };
  assert.equal(workflowAttention(superseded, undefined, now), undefined);
  assert.equal(needsContinuation(superseded), true);
  const boundary = { ...recent, updatedAt: new Date(now - 14 * 86_400_000).toISOString() };
  assert.equal(workflowAttention(boundary, undefined, now)?.kind, 'stopped');
  const old = { ...boundary, updatedAt: new Date(now - 14 * 86_400_000 - 1).toISOString() };
  assert.equal(workflowAttention(old, undefined, now), undefined);
  assert.equal(needsContinuation(old), true);
  assert.equal(workflowAttention({ ...old, updatedAt: recent.createdAt }, undefined, now)?.kind, 'stopped');
  assert.equal(
    workflowAttention({ ...old, supersededAt: stamp, userQuestion: question }, undefined, now)?.kind,
    'question',
  );
  for (const status of ['waiting-approval', 'waiting-confirmation'] as const)
    assert.ok(workflowAttention({ ...old, supersededAt: stamp, status }, undefined, now));
});
