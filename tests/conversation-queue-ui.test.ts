import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Conversation, ConversationMessage, Workflow } from '../src/shared/types.ts';
import {
  ConversationQueue,
  conversationQueuedMessages,
  deleteQueuedMessage,
  editQueuedMessage,
  isMessageQueueItem,
  moveQueuedMessage,
  reorderConversationQueue,
  setConversationQueueing,
} from '../src/ui/ConversationQueue.tsx';
import { composerMessageSchedule, selectQueue } from '../src/ui/queue-utils.ts';
import { conversationTimeline } from '../src/ui/conversation-timeline.ts';
import { representedQueueHeadId } from '../src/ui/message-queue.ts';
import { ConversationWorkspace, type Api } from '../src/ui/Workspace.tsx';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-09-30T12:00:00.000Z';
const workflow = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'conversation',
  projectId: 'project',
  userMessageId: `message-${id}`,
  input: { content: `Fixture ${id}`, mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
  status: 'queued',
  phase: 'queue',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const conversation: Conversation = {
  id: 'conversation',
  projectId: 'project',
  title: 'Fixture conversation',
  createdAt: stamp,
  updatedAt: stamp,
};
const view = (workflows: Workflow[]): AppState => ({ workflows, runs: [], settings: {} }) as unknown as AppState;
const render = (workflows: Workflow[], queueingEnabled?: boolean, representedHeadId?: string) =>
  renderToStaticMarkup(
    createElement(ConversationQueue, {
      state: view(workflows),
      conversation: { ...conversation, queueingEnabled },
      api: async <T>() => ({}) as T,
      notify() {},
      onSideChat() {},
      representedHeadId,
    }),
  );
const messages = (workflows: Workflow[]): ConversationMessage[] =>
  workflows.map((item) => ({
    id: item.userMessageId,
    workflowId: item.id,
    conversationId: item.conversationId,
    role: 'user',
    content: item.input.content,
    createdAt: item.createdAt,
  }));

test('a quietly waiting or legacy pending queue head with a visible timeline card is represented outside the queue', () => {
  const head = workflow('a', { status: 'waiting-resource', machineLoadChoice: 'pending' });
  const later = workflow('b', { status: 'waiting-resource' });
  const queued = conversationQueuedMessages([later, head], conversation.id);
  const timeline = conversationTimeline(messages(queued), queued);
  assert.equal(representedQueueHeadId(queued, timeline), head.id);
  assert.equal(representedQueueHeadId(queued, []), undefined, 'Unloaded origins must keep their queue controls');
  assert.equal(
    representedQueueHeadId(
      queued,
      timeline.filter((row) => row.kind !== 'workflow'),
    ),
    undefined,
    'A hidden card cannot replace the queue',
  );
  assert.equal(representedQueueHeadId([], timeline), undefined);
  assert.equal(representedQueueHeadId([workflow('a')], timeline), undefined);
  assert.equal(representedQueueHeadId([{ ...head, machineLoadChoice: 'wait' }], timeline), head.id);
  assert.equal(
    representedQueueHeadId([{ ...head, pendingSteer: { workflowId: 'active', runId: 'run' } }], timeline),
    undefined,
    'Pending steer still needs queue actions',
  );
  assert.deepEqual(
    queued.map((item) => item.id),
    ['a', 'b'],
    'Display selection keeps the canonical queue intact',
  );
});

test('queue hides its represented head while preserving every later message action', () => {
  const head = workflow('a', { status: 'waiting-resource', machineLoadChoice: 'pending' });
  assert.equal(render([head], undefined, head.id), '');
  const html = render([head, workflow('b'), workflow('c')], false, head.id);
  assert.doesNotMatch(html, /data-workflow-id="a"/);
  assert.match(html, /消息队列 · 2/);
  assert.match(html, /data-workflow-id="b"/);
  assert.match(html, /data-workflow-id="c"/);
  assert.equal((html.match(/aria-label="更多操作"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /上移第|下移第|>删除</);
  assert.match(render([head, workflow('b')], undefined, 'b'), /data-workflow-id="b"/, 'Only the head may be hidden');
  assert.equal(
    render([{ ...head, machineLoadChoice: 'wait' }], undefined, head.id),
    '',
    'A quiet memory wait keeps its status in the timeline card',
  );
  assert.match(
    render([{ ...head, machineLoadChoice: undefined }], undefined, head.id),
    /data-workflow-id="a"/,
    'A stale represented head cannot hide a normal waiting message',
  );
});

test('conversation workspace shows a waiting task once while keeping its user message and later queue', () => {
  const head = workflow('a', { status: 'waiting-resource', machineLoadChoice: 'pending' });
  const queued = [head, workflow('b')];
  const state = {
    ...view(queued),
    app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'C:/Fixture' },
    targets: [],
    runtimes: [],
    approvals: [],
    plugins: [],
    conversationMessages: messages(queued),
  } as AppState;
  const html = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      state,
      project: {
        id: 'project',
        name: 'Fixture',
        path: 'C:/Fixture',
        scope: 'chat',
        createdAt: stamp,
        updatedAt: stamp,
      },
      conversation,
      api: async <T>() => ({}) as T,
      notify() {},
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    }),
  );
  assert.match(html, /data-message-id="message-a"/);
  assert.equal((html.match(/id="workflow-a"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /电脑负载选择|立即运行|等空闲时自动运行|等待选择/);
  assert.match(html, /spinning/);
  assert.match(html, /排队中/);
  assert.doesNotMatch(html, /data-workflow-id="a"/);
  assert.match(html, /消息队列 · 1/);
  assert.match(html, /data-workflow-id="b"/);
});

test('reordering visible follow-ups sends the complete queue and leaves its represented head first', async () => {
  const h = uiHarness(await uiBundle('src/ui/ConversationQueue.tsx'));
  const calls: unknown[][] = [];
  const props = {
    state: view([
      workflow('a', { status: 'waiting-resource', machineLoadChoice: 'pending' }),
      workflow('b'),
      workflow('c'),
    ]),
    conversation,
    representedHeadId: 'a',
    api: async <T>(...args: [string, unknown?, string?]) => {
      calls.push(args);
      return {} as T;
    },
    notify() {},
  };
  try {
    const tree = h.render('ConversationQueue', props);
    const more = findNode(tree, (node) => node.props['aria-label'] === '更多操作');
    assert.ok(more);
    let focused = false;
    more.props.onClick({
      currentTarget: {
        getBoundingClientRect: () => ({ left: 20, bottom: 40 }),
        focus: () => {
          focused = true;
        },
      },
    });
    const menu = findNode(h.render('ConversationQueue', props), (node) => Array.isArray(node.props.items));
    assert.ok(menu);
    assert.deepEqual(
      Array.from(menu.props.items, (item: { label: string }) => item.label),
      ['编辑', '在侧边对话打开', '上移', '下移', '移出队列'],
    );
    assert.equal(menu.props.items.find((item: { label: string }) => item.label === '移出队列').danger, true);
    assert.equal(menu.props.items.find((item: { label: string }) => item.label === '上移').disabled, true);
    const down = menu.props.items.find((item: { label: string }) => item.label === '下移');
    assert.equal(down.disabled, false);
    menu.props.onClose();
    down.onSelect();
    await nextTurn();
    assert.deepEqual(structuredClone(calls), [
      ['/api/conversations/conversation/queue/order', { workflowIds: ['a', 'c', 'b'] }, 'POST'],
    ]);
    const reordered = h.render('ConversationQueue', props);
    assert.equal(focused, true);
    assert.equal(
      findNode(reordered, (node) => node.props['data-workflow-id'] === 'a'),
      undefined,
    );
    assert.equal(
      findNode(reordered, (node) => /^上移第|^下移第/.test(node.props['aria-label'] ?? '')),
      undefined,
    );
  } finally {
    h.unmount();
  }
});

test('message queue excludes executing, removed, foreign, delegated and time-planned tasks', () => {
  const ordinary = workflow('ordinary');
  const legacy = workflow('legacy');
  legacy.input.schedule = { priority: 'normal', preferExpiringQuota: true };
  const pending = workflow('pending', {
    status: 'waiting-resource',
    pendingSteer: { workflowId: 'active', runId: 'run' },
  });
  const excluded = [
    workflow('foreign', { conversationId: 'other' }),
    workflow('removed', { deletedAt: stamp }),
    workflow('executing', { status: 'running' }),
    workflow('accepted', { status: 'completed' }),
    workflow('confirmation', { status: 'waiting-confirmation' }),
    workflow('started', { startedAt: stamp }),
    workflow('has-run', { runIds: ['run'] }),
    workflow('continued', { parentWorkflowId: 'parent' }),
    workflow('replaced', { followUp: { workflowId: 'later', kind: 'message', at: stamp } }),
    workflow('delegated', { delegation: { parentId: 'parent', role: 'worker', requestId: 'fixture' } }),
  ];
  for (const schedule of [
    { deadlineAt: stamp },
    { notBefore: stamp },
    { priority: 'high' as const },
    { preferExpiringQuota: false },
  ]) {
    const scheduled = workflow('scheduled');
    scheduled.input.schedule = schedule;
    excluded.push(scheduled);
    assert.equal(isMessageQueueItem(scheduled), false);
  }
  assert.deepEqual(
    conversationQueuedMessages([...excluded, ordinary, legacy, pending], conversation.id).map((item) => item.id),
    ['legacy', 'ordinary', 'pending'],
  );
});

test('user queue order overrides creation time, with legacy creation timestamps as fallback', () => {
  const later = workflow('later', { createdAt: '2026-09-30T13:00:00.000Z', queueOrder: Date.parse(stamp) - 10 });
  const legacy = workflow('legacy');
  const postponed = workflow('postponed', { queueOrder: Date.parse(stamp) + 10 });
  const input = [postponed, legacy, later];
  assert.deepEqual(
    conversationQueuedMessages(input, conversation.id).map((item) => item.id),
    ['later', 'legacy', 'postponed'],
  );
  assert.deepEqual(
    selectQueue(input, '', 'pending', 'created').map((item) => item.id),
    ['later', 'legacy', 'postponed'],
  );
  assert.deepEqual(
    input.map((item) => item.id),
    ['postponed', 'legacy', 'later'],
  );
  const html = render(input);
  assert.ok(html.indexOf('data-workflow-id="later"') < html.indexOf('data-workflow-id="legacy"'));
  assert.ok(html.indexOf('data-workflow-id="legacy"') < html.indexOf('data-workflow-id="postponed"'));
});

test('dragging before and after rows supports both directions without losing queue entries', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moveQueuedMessage(ids, 'c', 'a', 'before'), ['c', 'a', 'b']);
  assert.deepEqual(moveQueuedMessage(ids, 'a', 'c', 'after'), ['b', 'c', 'a']);
  assert.deepEqual(moveQueuedMessage(ids, 'c', 'a', 'after'), ['a', 'c', 'b']);
  assert.deepEqual(moveQueuedMessage(ids, 'a', 'c', 'before'), ['b', 'a', 'c']);
  for (const [moved, target] of [
    ['a', 'a'],
    ['missing', 'a'],
    ['a', 'missing'],
  ])
    assert.deepEqual(moveQueuedMessage(ids, moved, target, 'before'), ids);
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('queue panel shows drag handles and one actions menu per row without duplicate action buttons', () => {
  const html = render([workflow('a'), workflow('b', { pendingSteer: { workflowId: 'active', runId: 'run' } })]);
  assert.match(html, /消息队列 · 2/);
  assert.match(html, /拖动消息可改变发送顺序/);
  assert.equal((html.match(/draggable="true"/g) ?? []).length, 2);
  assert.ok(html.includes('等待插入当前任务'));
  assert.doesNotMatch(html, /关闭排队|开启排队/);
  assert.equal((html.match(/aria-label="更多操作"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /上移第|下移第|>编辑<|>删除<|>在侧边对话打开</);
  assert.doesNotMatch(html, /插入当前任务（steer）/);
  assert.equal(render([]), '');
  assert.match(render([], false), /排队已关闭/);
  assert.equal(render([workflow('active', { status: 'running' })]), '');
  assert.match(render([workflow('active', { status: 'running' })], false), /开启排队/);
});

test('only a disabled queue exposes one re-enable link, including an empty queue', async () => {
  const h = uiHarness(await uiBundle('src/ui/ConversationQueue.tsx'));
  const calls: unknown[][] = [];
  const props = {
    state: view([]),
    conversation: { ...conversation, queueingEnabled: false },
    api: async <T>(...args: [string, unknown?, string?]) => {
      calls.push(args);
      return {} as T;
    },
    notify() {},
  };
  try {
    const tree = h.render('ConversationQueue', props);
    const hint = findNode(tree, (node) => node.props.className === 'conversation-queue-hint');
    const link = findNode(hint, (node) => node.type === 'button');
    assert.ok(link);
    link.props.onClick();
    await nextTurn();
    assert.deepEqual(structuredClone(calls), [
      ['/api/conversations/conversation/queueing', { enabled: true }, 'PATCH'],
    ]);
    props.conversation.queueingEnabled = true;
    assert.equal(h.render('ConversationQueue', props), null);
  } finally {
    h.unmount();
  }
});

test('queue requests use explicit edit/order/toggle contracts and cancel before soft deletion', async () => {
  const calls: unknown[][] = [];
  const api: Api = async <T>(...args: [string, unknown?, string?]) => {
    calls.push(args);
    return { ok: true } as T;
  };
  await reorderConversationQueue(api, 'conversation/id', ['b', 'a']);
  await editQueuedMessage(api, 'workflow/id', '  revised fixture  ');
  await deleteQueuedMessage(api, 'workflow/id');
  await setConversationQueueing(api, 'conversation/id', false);
  assert.deepEqual(calls, [
    ['/api/conversations/conversation%2Fid/queue/order', { workflowIds: ['b', 'a'] }, 'POST'],
    ['/api/workflows/workflow%2Fid/input', { content: 'revised fixture' }, 'PATCH'],
    ['/api/workflows/workflow%2Fid/cancel', {}, 'POST'],
    ['/api/workflows/workflow%2Fid', undefined, 'DELETE'],
    ['/api/conversations/conversation%2Fid/queueing', { enabled: false }, 'PATCH'],
  ]);
  await assert.rejects(editQueuedMessage(api, 'workflow', '   '), /不能为空/);
  assert.equal(calls.length, 5);
  const failedCalls: string[] = [];
  const failed: Api = async (path) => {
    failedCalls.push(path);
    throw new Error('Fixture: task already started');
  };
  await assert.rejects(deleteQueuedMessage(failed, 'started'), /already started/);
  assert.deepEqual(failedCalls, ['/api/workflows/started/cancel']);
});

test('ordinary composer messages omit a schedule so they can enter the live steer channel', () => {
  assert.equal(composerMessageSchedule('', '', 'normal', true), undefined);
  assert.deepEqual(composerMessageSchedule('', '', 'high', true), { priority: 'high', preferExpiringQuota: true });
  assert.deepEqual(composerMessageSchedule('', '', 'normal', false), {
    priority: 'normal',
    preferExpiringQuota: false,
  });
  assert.equal(
    composerMessageSchedule('2026-10-01T13:30', '', 'normal', true)?.deadlineAt,
    new Date('2026-10-01T13:30').toISOString(),
  );
  assert.throws(() => composerMessageSchedule('invalid', '', 'normal', true), /有效/);
});
