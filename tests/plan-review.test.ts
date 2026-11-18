import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Workflow } from '../src/shared/types.ts';
import { WorkflowTrace } from '../src/ui/Workspace.tsx';
import { QueueItem } from '../src/ui/TaskQueue.tsx';
import { conversationActivity } from '../src/ui/queue-utils.ts';
import { progressText } from '../src/cli/ask.ts';
import { replyView } from '../src/cli/conversation-view.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-14T12:00:00Z';
const workflow: Workflow = {
  id: 'plan-fixture',
  conversationId: 'chat',
  projectId: 'project',
  userMessageId: 'message',
  input: {
    content: 'Inspect the project',
    mode: 'build',
    planFirst: true,
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  },
  status: 'waiting-confirmation',
  phase: 'plan',
  planReview: 'pending',
  runIds: [],
  plan: ['First', 'Second'].map((title, index) => ({
    id: `step${index + 1}`,
    title,
    instruction: `Inspect ${title}`,
    kind: 'general',
    transport: 'auto',
    dependsOn: index ? ['step1'] : [],
    status: 'pending',
    runIds: [],
  })),
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
};
let code: string;
before(async () => {
  code = await uiBundle('src/ui/PlanReview.tsx');
});
function mount(api: any = async () => ({})) {
  const harness = uiHarness(code, { Error });
  const notices: any[] = [];
  const render = () => harness.render('PlanReview', { workflow, api, notify: (notice: any) => notices.push(notice) });
  const node = (check: Parameters<typeof findNode>[1]) => {
    const found = findNode(render(), check);
    assert.ok(found);
    return found;
  };
  const button = (text: string) => node((n) => n.type === 'button' && n.props.children === text);
  return { harness, notices, render, node, button };
}

test('the plan card edits inline, preserves a remaining dependent step, and enforces 1-6 steps', async () => {
  const writes: any[] = [];
  const view = mount(async (path: string, body: unknown) => {
    writes.push({ path, body: structuredClone(body) });
  });
  view.button('删除步骤').props.onClick();
  assert.equal(view.node((n) => n.type === 'input').props.value, 'Second');
  assert.equal(view.button('删除步骤').props.disabled, true);
  view.node((n) => n.type === 'input').props.onChange({ target: { value: 'Edited title' } });
  view.node((n) => n.type === 'textarea').props.onChange({ target: { value: 'Edited instruction' } });
  assert.equal(view.button('批准并执行').props.disabled, false);
  view.button('批准并执行').props.onClick();
  await nextTurn();
  assert.deepEqual(writes, [
    {
      path: '/api/workflows/plan-fixture/approve-plan',
      body: { steps: [{ title: 'Edited title', instruction: 'Edited instruction' }] },
    },
  ]);
  for (let i = 1; i < 6; i++) view.button('添加步骤').props.onClick();
  assert.equal(view.button('添加步骤').props.disabled, true);
  assert.equal(view.button('批准并执行').props.disabled, true);
  view.harness.unmount();
});

test('plan actions block repeated submissions and show errors without discarding edits', async () => {
  let reject!: (reason: Error) => void;
  let calls = 0;
  const view = mount(() => {
    calls++;
    return new Promise((_, fail) => {
      reject = fail;
    });
  });
  view.node((n) => n.type === 'input').props.onChange({ target: { value: 'Keep my edit' } });
  const approve = view.button('批准并执行');
  approve.props.onClick();
  approve.props.onClick();
  assert.equal(calls, 1);
  assert.equal(view.button('取消').props.disabled, true);
  assert.equal(view.node((n) => n.type === 'textarea').props.disabled, true);
  reject(new Error('Fixture error'));
  await nextTurn();
  assert.equal(view.notices[0].message, 'Fixture error');
  assert.equal(view.node((n) => n.type === 'input').props.value, 'Keep my edit');
  assert.equal(view.button('批准并执行').props.disabled, false);
  view.node((n) => n.type === 'input').props.onChange({ target: { value: ' ' } });
  assert.equal(view.button('批准并执行').props.disabled, true);
  view.harness.unmount();
});

test('plan cancel uses the existing workflow cancellation endpoint', async () => {
  const writes: any[] = [];
  const view = mount(async (path: string, body: unknown) => {
    writes.push({ path, body: structuredClone(body) });
  });
  view.button('取消').props.onClick();
  await nextTurn();
  assert.deepEqual(writes, [{ path: '/api/workflows/plan-fixture/cancel', body: {} }]);
  view.harness.unmount();
});

test('read-only plans explain that approval keeps file access read-only', () => {
  const view = mount();
  assert.equal(
    view.node((n) => n.type === 'p' && n.props.className === 'route-policy-hint').props.children,
    '当前只读：批准后也不会改文件',
  );
  const writable = view.harness.render('PlanReview', {
    workflow: { ...workflow, input: { ...workflow.input, permissionMode: 'workspace-write' } },
    api: async () => ({}),
    notify() {},
  });
  assert.equal(
    findNode(writable, (n) => n.props.className === 'route-policy-hint'),
    undefined,
  );
  view.harness.unmount();
});

test('the plan card accepts a fallback instruction at the message limit', async () => {
  const writes: any[] = [];
  const view = mount(async (_path: string, body: unknown) => writes.push(body));
  const instruction = 'x'.repeat(50000);
  const textarea = view.node((node) => node.type === 'textarea');
  assert.equal(textarea.props.maxLength, instruction.length);
  textarea.props.onChange({ target: { value: instruction } });
  assert.equal(view.button('批准并执行').props.disabled, false);
  view.button('批准并执行').props.onClick();
  await nextTurn();
  assert.equal(writes[0].steps[0].instruction, instruction);
  view.harness.unmount();
});

test('CLI waiting text distinguishes plan approval from account confirmation', () => {
  for (const planReview of ['pending', undefined] as const) {
    const task = { ...workflow, planReview };
    const expected = planReview ? /批准计划/ : /确认用哪个账号/;
    assert.match(progressText({ taskId: task.id, status: task.status, planReview }), expected);
    assert.match(replyView({ workflow: task, runs: [], live: new Map(), targets: [] }).activity, expected);
  }
});

test('approved route cards stay hidden during plan review in both the conversation and queue', () => {
  const task: Workflow = {
    ...workflow,
    routingReview: {
      id: 'route',
      status: 'approved',
      proposal: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
      proposedAt: stamp,
      original: {},
    },
  };
  const state = { targets: [], runtimes: [], runs: [], workflows: [task], settings: {} } as unknown as AppState;
  const actions = { api: async <T>() => ({}) as T, notify() {}, onInspect() {}, onConversation() {} };
  const trace = () => renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, workflow: task, state }));
  const queue = () =>
    renderToStaticMarkup(createElement(QueueItem, { ...actions, workflow: task, state, now: Date.parse(stamp) }));
  assert.match(trace(), /批准并执行/);
  assert.doesNotMatch(trace(), /运行前确认|确认并运行/);
  assert.doesNotMatch(queue(), /确认此方案/);
  assert.match(queue(), /请打开对话，检查并批准计划后执行/);
  assert.equal(conversationActivity([task], 'chat'), 'attention');
  task.routingReview!.status = 'pending';
  delete task.planReview;
  assert.match(trace(), /运行前确认/);
  assert.match(queue(), /确认此方案/);
});
