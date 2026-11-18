import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AppState, Conversation, Project, RunRecord, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const stamp = '2026-10-20T12:00:00Z';
const project = { id: 'project', name: 'Fixture', path: 'C:/Fixture', createdAt: stamp, updatedAt: stamp } as Project;
const conversation = {
  id: 'chat',
  projectId: project.id,
  title: 'Fixture',
  createdAt: stamp,
  updatedAt: stamp,
} as Conversation;
const task = (patch: Partial<Workflow> = {}): Workflow => ({
  id: 'parent',
  conversationId: conversation.id,
  projectId: project.id,
  userMessageId: 'user',
  input: { content: 'Synthetic task', mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
  status: 'running',
  phase: 'execute',
  plan: [],
  runIds: ['run'],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const run: RunRecord = {
  id: 'run',
  workflowId: 'parent',
  kind: 'general',
  prompt: 'Synthetic prompt',
  projectPath: 'C:/Fixture',
  status: 'running',
  route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
  startedAt: stamp,
  output: '',
  events: [],
};
const view = (workflows: Workflow[], runs = [run]): AppState =>
  ({
    app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [project],
    conversations: [conversation],
    targets: [],
    runtimes: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    settings: {},
    workflows,
    runs,
    conversationMessages: workflows.map((workflow) => ({
      id: workflow.userMessageId,
      conversationId: workflow.conversationId,
      workflowId: workflow.id,
      role: 'user',
      content: workflow.input.content,
      createdAt: workflow.createdAt,
    })),
  }) as unknown as AppState;
const actions = { api: async <T>() => ({ messages: [] }) as T, notify() {}, onInspect() {} };
const props = (state: AppState) => ({
  ...actions,
  state,
  project,
  conversation,
  onConversation() {},
  onAddProject() {},
  onMemory() {},
});
let code: string, queueCode: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
  queueCode = await uiBundle('src/ui/ConversationQueue.tsx');
});
function card(workflow: Workflow, extra = {}) {
  const harness = uiHarness(code);
  const tree = harness.render('WorkflowTrace', { ...actions, workflow, state: view([workflow]), ...extra });
  harness.unmount();
  return tree;
}
function nodes(tree: unknown, check: (node: UiNode) => boolean): UiNode[] {
  const found: UiNode[] = [];
  findNode(tree, (node) => {
    if (check(node)) found.push(node);
    return false;
  });
  return found;
}
const stopControl = (tree: unknown) => findNode(tree, (node) => node.props['aria-label'] === '停止最近进行中的任务');
const button = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.type === 'button' && text(node) === label);
const outcome = (tree: unknown) => findNode(tree, (node) => node.props.className === 'workflow-outcome');

test('one composer stop per executing chat and no card stop controls', () => {
  for (const status of ['planning', 'running', 'waiting-approval'] as const) {
    const harness = uiHarness(code);
    const tree = harness.render('ConversationWorkspace', props(view([task({ status })])));
    assert.equal(nodes(tree, (node) => node.props['aria-label'] === '停止最近进行中的任务').length, 1);
    const stop = stopControl(tree)!;
    assert.equal(stop.props.className, 'icon-button composer-stop');
    assert.equal(stop.props.title, '停止最近进行中的任务');
    assert.ok(findNode(stop, (node) => node.props.fill === 'currentColor'));
    const trace = card(task({ status }));
    assert.equal(
      findNode(trace, (node) => node.props.className?.includes?.('stream-stop')),
      undefined,
    );
    for (const label of ['停止', '停止工作流', '取消排队', '取消']) assert.equal(button(trace, label), undefined);
    harness.unmount();
  }
});

test('queued-only chat has a queue panel and no composer stop or task card', () => {
  const harness = uiHarness(code);
  const state = view([task({ status: 'queued', runIds: [] })], []);
  const tree = harness.render('ConversationWorkspace', props(state));
  assert.equal(stopControl(tree), undefined);
  assert.equal(
    findNode(tree, (node) => node.props['aria-label'] === '取消最近排队的任务'),
    undefined,
  );
  const queue = findNode(tree, (node) => node.type?.name === 'ConversationQueue');
  assert.ok(queue);
  const queueHarness = uiHarness(queueCode);
  assert.ok(
    findNode(
      queueHarness.render('ConversationQueue', queue.props),
      (node) => node.props.className === 'conversation-queue',
    ),
  );
  // conversation-timeline.test.ts covers the timeline rule; here no task card reaches the chat either.
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'WorkflowTrace'),
    undefined,
  );
  queueHarness.unmount();
  harness.unmount();
});

test('failed, interrupted, blocked and stopped cards offer one outside-fold Continue without duplicate notices', () => {
  for (const workflow of [
    task({ status: 'failed' }),
    task({ status: 'interrupted' }),
    task({ status: 'blocked' }),
    task({ status: 'cancelled', stopped: true }),
  ]) {
    const tree = card(workflow);
    assert.equal(
      Boolean(findNode(tree, (node) => node.props.className === 'workflow-status-failed')),
      workflow.status !== 'cancelled',
    );
    const children = [tree.props.children].flat(Infinity) as UiNode[];
    const foldIndex = children.findIndex((node) => node?.type === 'details');
    const outcomeIndex = children.findIndex((node) => node?.props?.className === 'workflow-outcome');
    assert.ok(foldIndex >= 0);
    assert.ok(outcomeIndex > foldIndex, 'Continue remains outside and after the fold');
    assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '继续').length, 1);
    assert.equal(button(children[foldIndex], '继续'), undefined);
    const reports = nodes(tree, (node) => node.type?.name === 'ReportProblemAction');
    assert.equal(reports.length, workflow.status === 'failed' ? 1 : 0);
    if (reports.length) {
      assert.equal(reports[0]!.props.taskId, workflow.id);
      const action = reports[0]!.type(reports[0]!.props);
      assert.match(action.props.className, /\bquiet\b/);
      assert.equal(text(action), '报告问题');
    }
    assert.ok(findNode(outcome(tree), (node) => node.type === 'p' && Boolean(text(node))));
    if (workflow.status === 'cancelled') {
      assert.equal(text(findNode(outcome(tree), (node) => node.type === 'p')), '本轮已停止，可继续未完成的工作。');
    }
    for (const label of ['取消任务', '停止工作流', '继续未完成的工作']) assert.equal(button(tree, label), undefined);
    assert.ok(button(children[foldIndex], '删除任务'));
    const withNotice = card(workflow, { hasSystemNotice: true });
    assert.equal(
      findNode(outcome(withNotice), (node) => node.type === 'p'),
      undefined,
    );
    assert.ok(button(outcome(withNotice), '继续'));
  }
  assert.equal(outcome(card(task({ status: 'cancelled' }))), undefined);
  assert.equal(
    outcome(card(task({ status: 'failed', followUp: { workflowId: 'next', kind: 'continue', at: stamp } }))),
    undefined,
  );
});

test('card hides executor and model lines but links to its trace without offering child creation', () => {
  let opened = 0;
  const workflow = task({ status: 'completed', planning: { strategy: 'direct', reason: 'Synthetic route reason' } });
  const tree = card(workflow, { onTrace: () => opened++ });
  for (const className of ['trace-context', 'execution-chip', 'planning-run', 'route-details'])
    assert.equal(
      findNode(tree, (node) => node.props.className === className),
      undefined,
    );
  assert.doesNotMatch(text(tree), /Synthetic route reason|审查或委派/);
  button(tree, '查看轨迹')!.props.onClick();
  assert.equal(opened, 1);
});

test('route options show the permission chip and keep task and planning choices inside Advanced', () => {
  const harness = uiHarness(code);
  const input = props(view([]));
  const render = () => harness.render('ConversationWorkspace', input);
  findNode(render(), (node) => node.props['aria-label'] === '调度选项')!.props.onClick();
  assert.equal(
    findNode(render(), (node) => node.props.ariaLabel === '任务理解方式'),
    undefined,
  );
  assert.equal(
    findNode(render(), (node) => node.props['aria-label'] === '先计划'),
    undefined,
  );
  button(render(), '高级')!.props.onClick();
  const tree = render();
  assert.ok(findNode(tree, (node) => node.props.ariaLabel === '任务理解方式'));
  assert.ok(findNode(tree, (node) => node.props['aria-label'] === '先计划'));
  assert.equal(
    nodes(tree, (node) => node.props['aria-label'] === '文件权限' || node.props.ariaLabel === '文件权限').length,
    1,
  );
  assert.equal(
    findNode(tree, (node) => node.props['aria-label'] === '消息排队开关'),
    undefined,
  );
  harness.unmount();
});

test('composer plus enables read-only and its small chip restores writing with a persistent permission label', () => {
  const h = uiHarness(code);
  const input = props(view([]));
  const render = () => h.render('ConversationWorkspace', input);
  const permission = () => findNode(render(), (node) => node.props['aria-label'] === '文件权限');
  const caption = () => findNode(render(), (node) => node.props.className === 'composer-caption');
  try {
    assert.equal(text(permission()), '可写入');
    assert.equal(caption(), undefined);
    findNode(render(), (node) => node.props['aria-label'] === '添加和更多')!.props.onClick();
    const toggle = findNode(render(), (node) => node.props.role === 'menuitemcheckbox' && text(node) === '只读')!;
    assert.equal(toggle.props['aria-checked'], false);
    toggle.props.onClick();
    assert.equal(text(permission()), '只读');
    assert.equal(text(caption()), '只读：这次不会改文件');
    permission()!.props.onClick();
    assert.equal(text(permission()), '可写入');
    assert.equal(caption(), undefined);
  } finally {
    h.unmount();
  }
});

test('composer caption only shows confirm or read-only guidance and shortcuts stay in the send tooltip', () => {
  for (const running of [false, true]) {
    for (const confirm of [false, true]) {
      const h = uiHarness(code);
      const state = view(running ? [task()] : [], running ? [run] : []);
      state.settings.decisionMode = confirm ? 'confirm' : 'auto';
      try {
        const tree = h.render('ConversationWorkspace', props(state));
        const caption = findNode(tree, (node) => node.props.className === 'composer-caption');
        assert.equal(text(caption), confirm ? '运行前先确认执行方案' : '');
        const send = findNode(tree, (node) => node.props.className === 'send-button')!;
        assert.match(send.props.title, /Enter/);
        assert.match(send.props.title, /Shift\+Enter/);
        assert.doesNotMatch(send.props.title, /回车/);
        if (running) assert.match(send.props.title, /补充给当前任务.*排在后面/);
      } finally {
        h.unmount();
      }
    }
  }
});

test('disabled empty queue exposes exactly one re-enable link and enabled empty queue disappears', async () => {
  const harness = uiHarness(queueCode);
  const calls: unknown[] = [];
  const input = {
    conversation: { ...conversation, queueingEnabled: false },
    workflows: [],
    state: view([]),
    notify() {},
    api: async <T>(...args: unknown[]) => {
      calls.push(args);
      return {} as T;
    },
  };
  const render = () => harness.render('ConversationQueue', input);
  const tree = render();
  assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '开启排队').length, 1);
  assert.equal(button(tree, '关闭排队'), undefined);
  button(tree, '开启排队')!.props.onClick();
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['/api/conversations/chat/queueing', { enabled: true }, 'PATCH'],
  ]);
  input.conversation.queueingEnabled = true;
  assert.equal(render(), null);
  harness.unmount();
});

test('waiting and background-blocked cards retain Cancel inside their task actions', () => {
  for (const workflow of [
    task({ status: 'waiting-confirmation' }),
    task({ status: 'waiting-resource' }),
    task({ status: 'blocked', waitingOn: { kind: 'media-analysis', jobId: 'job', done: 1, total: 2 } }),
  ]) {
    const tree = card(workflow);
    const controls = findNode(tree, (node) => node.props.className === 'trace-actions');
    assert.ok(button(controls, '取消'));
    assert.equal(nodes(tree, (node) => node.type === 'button' && text(node) === '取消').length, 1);
    assert.equal(outcome(tree), undefined);
  }
});

test('permission line appears only when it is not the user’s own choice', () => {
  const own = card(task());
  assert.equal(
    findNode(own, (node) => node.props.className === 'workflow-read-only'),
    undefined,
  );
  assert.doesNotMatch(text(own), /你的选择/);
  const workflow = task();
  workflow.input.permissionOrigin = { mode: 'read-only', source: 'text', note: 'Synthetic scope' };
  const permission = findNode(card(workflow), (node) => node.props.className === 'workflow-read-only');
  assert.ok(permission);
  assert.match(text(permission), /Synthetic scope/);
});

test('collapsed status summary omits phase and tool metadata', () => {
  assert.equal(text(findNode(card(task()), (node) => node.props.className === 'trace-description')), '');
  const current = { ...run, events: [{ type: 'tool' as const, at: stamp, text: 'find_files' }] };
  const tree = card(task(), { state: view([task()], [current]) });
  assert.equal(
    findNode(tree, (node) => node.props.className === 'trace-description'),
    undefined,
  );
});

test('WorkflowTrace pauses thinking during approval without changing the steering-stage guard', () => {
  for (const status of ['running', 'waiting-approval'] as const) {
    const workflow = task({ status });
    const current = { ...run, status, reasoning: 'Synthetic thought' };
    const tree = card(workflow, { state: view([workflow], [current]) });
    const ticker = findNode(tree, (node) => node.type?.name === 'ReasoningTail');
    assert.ok(ticker);
    assert.equal(ticker.props.workflow.status, status);
  }
});

test('machine-load pending and wait keep their card and hide only the represented queue head', () => {
  for (const machineLoadChoice of ['pending', 'wait'] as const) {
    const workflow = task({ status: 'waiting-resource', runIds: [], machineLoadChoice });
    const state = view([workflow], []);
    const harness = uiHarness(code);
    const tree = harness.render('ConversationWorkspace', props(state));
    const queue = findNode(tree, (node) => node.type?.name === 'ConversationQueue');
    assert.ok(queue);
    assert.equal(queue.props.representedHeadId, workflow.id, 'timeline still represents the machine-load card');
    const queueHarness = uiHarness(queueCode);
    assert.equal(queueHarness.render('ConversationQueue', queue.props), null, 'no duplicate queue entry');
    queueHarness.unmount();
    harness.unmount();
  }
});

test('closing a queue menu restores its trigger focus and a second click closes without reopening', () => {
  const harness = uiHarness(queueCode);
  const input = { ...actions, conversation, state: view([task({ status: 'queued', runIds: [] })], []) };
  let focused = 0;
  const trigger = { getBoundingClientRect: () => ({ left: 20, bottom: 40 }), focus: () => focused++ };
  const render = () => harness.render('ConversationQueue', input);
  const more = () => findNode(render(), (node) => node.props['aria-label'] === '更多操作')!;
  const menu = () => findNode(render(), (node) => Array.isArray(node.props.items));
  more().props.onClick({ currentTarget: trigger });
  assert.ok(menu());
  menu()!.props.onClose();
  render();
  assert.equal(focused, 1);
  assert.equal(menu(), undefined);
  more().props.onClick({ currentTarget: trigger });
  let stopped = false;
  more().props.onMouseDown({
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert.equal(stopped, true, 'the window outside-click handler must not close the menu before click');
  more().props.onClick({ currentTarget: trigger });
  assert.equal(menu(), undefined);
  assert.equal(more().props['aria-expanded'], false);
  harness.unmount();
});

test('moving a queued message up or down restores focus and keeps the selected workflow', async () => {
  for (const label of ['上移', '下移']) {
    const harness = uiHarness(queueCode);
    const calls: unknown[] = [];
    let finish: (() => void) | undefined;
    const input = {
      ...actions,
      conversation,
      state: view(
        ['a', 'b', 'c'].map((id) => task({ id, userMessageId: `user-${id}`, status: 'queued', runIds: [] })),
        [],
      ),
      api: async <T>(...args: unknown[]) => {
        calls.push(args);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {} as T;
      },
    };
    const render = () => harness.render('ConversationQueue', input);
    const row = findNode(render(), (node) => node.props['data-workflow-id'] === 'b');
    const more = findNode(row, (node) => node.props['aria-label'] === '更多操作')!;
    let focused = 0;
    more.props.onClick({
      currentTarget: { getBoundingClientRect: () => ({ left: 20, bottom: 40 }), focus: () => focused++ },
    });
    const menu = findNode(render(), (node) => Array.isArray(node.props.items))!;
    const item = menu.props.items.find((candidate: { label: string }) => candidate.label === label);
    assert.equal(item.disabled, false);
    menu.props.onClose();
    item.onSelect();
    const pendingRow = findNode(render(), (node) => node.props['data-workflow-id'] === 'b');
    assert.equal(findNode(pendingRow, (node) => node.props['aria-label'] === '更多操作')?.props.disabled, true);
    assert.equal(focused, 0, 'do not focus a disabled trigger while reorder is pending');
    finish!();
    await nextTurn();
    const idleRow = findNode(render(), (node) => node.props['data-workflow-id'] === 'b');
    assert.equal(findNode(idleRow, (node) => node.props['aria-label'] === '更多操作')?.props.disabled, false);
    assert.equal(focused, 1);
    assert.equal(
      findNode(render(), (node) => Array.isArray(node.props.items)),
      undefined,
    );
    assert.deepEqual(structuredClone(calls), [
      [
        '/api/conversations/chat/queue/order',
        { workflowIds: label === '上移' ? ['b', 'a', 'c'] : ['a', 'c', 'b'] },
        'POST',
      ],
    ]);
    harness.unmount();
  }
});

test('parent and child both executing: composer Stop cancels latest parent and keeps busy spinner', async () => {
  const parent = task();
  const older = task({ id: 'older', createdAt: '2026-10-19T12:00:00Z' });
  const child = task({
    id: 'child',
    createdAt: '2026-10-21T12:00:00Z',
    delegation: { parentId: parent.id, role: 'worker', requestId: 'fixture-request' },
  });
  const harness = uiHarness(code);
  const calls: string[] = [];
  let finish: (() => void) | undefined;
  const input = {
    ...props(view([older, child, parent])),
    api: async <T>(path: string, body?: unknown) => {
      if (body !== undefined) {
        calls.push(path);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return { messages: [] } as T;
    },
  };
  const stop = () => stopControl(harness.render('ConversationWorkspace', input));
  assert.ok(stop());
  stop()!.props.onClick();
  assert.deepEqual(calls, ['/api/workflows/parent/cancel']);
  assert.equal(stop()!.props.disabled, true);
  assert.ok(findNode(stop(), (node) => node.props.className === 'spinning'));
  finish!();
  await nextTurn();
  assert.equal(stop()!.props.disabled, false);
  harness.unmount();
});

test('composer stop falls back to an executing delegated task and excludes other chats', () => {
  const child = task({ delegation: { parentId: 'missing', role: 'worker', requestId: 'fixture-request' } });
  const harness = uiHarness(code);
  assert.ok(stopControl(harness.render('ConversationWorkspace', props(view([child])))));
  harness.unmount();
  const foreignHarness = uiHarness(code);
  assert.equal(
    stopControl(foreignHarness.render('ConversationWorkspace', props(view([task({ conversationId: 'other' })])))),
    undefined,
  );
  foreignHarness.unmount();
});

test('outside-fold Continue calls the workflow endpoint once and does not claim work succeeded', async () => {
  const workflow = task({ status: 'failed' });
  const harness = uiHarness(code);
  const calls: unknown[] = [];
  const notices: unknown[] = [];
  let finish: (() => void) | undefined;
  const input = {
    ...actions,
    workflow,
    state: view([workflow]),
    api: async <T>(...args: unknown[]) => {
      calls.push(args);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { id: 'next', status: 'queued' } as T;
    },
    notify: (notice: unknown) => notices.push(notice),
  };
  const render = () => harness.render('WorkflowTrace', input);
  const continueButton = button(outcome(render()), '继续');
  assert.ok(continueButton);
  continueButton.props.onClick();
  continueButton.props.onClick();
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([['/api/workflows/parent/continue', { uiLocale: 'zh-CN' }, undefined]]),
  );
  assert.equal(button(outcome(render()), '继续')?.props.disabled, true);
  finish!();
  await nextTurn();
  const tree = render();
  assert.equal(button(outcome(tree), '继续')?.props.disabled, false);
  assert.deepEqual(notices, []);
  assert.equal(text(findNode(tree, (node) => node.props.className === 'workflow-status')), '执行失败');
  harness.unmount();
});
