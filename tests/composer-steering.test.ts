import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Conversation, Project, RunRecord, Workflow } from '../src/shared/types.ts';
import { queuedSteeringRun, resolveComposerSteering, steerQueuedWorkflow } from '../src/ui/composer-steering.ts';
import { ConversationWorkspace, WorkflowTrace, type Api } from '../src/ui/Workspace.tsx';
import { QueueItem } from '../src/ui/TaskQueue.tsx';

const stamp = '2026-09-30T12:00:00.000Z';
const workflow = (patch: Partial<Workflow> = {}): Workflow => ({
  id: 'executing',
  conversationId: 'conversation',
  projectId: 'project',
  userMessageId: 'message',
  input: { content: 'Fixture task', mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
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
const run = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run',
  workflowId: 'executing',
  stepId: 'step',
  prompt: 'Fixture prompt',
  projectPath: 'C:/Fixture',
  kind: 'general',
  status: 'running',
  route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
  toolApprovalMode: 'auto',
  steerAvailable: true,
  startedAt: stamp,
  output: 'Fixture reply',
  events: [],
  ...patch,
});
const state = (workflows: Workflow[], runs: RunRecord[] = []): AppState => ({
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets: [],
  runtimes: [],
  runs,
  workflows,
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
});
test('a task approval override keeps its native steering channel available', () => {
  const task = workflow();
  task.input.toolApprovalMode = 'ask';
  const current = run({ toolApprovalMode: 'ask' });
  const view = state([task], [current]);
  view.settings.toolApprovalMode = 'auto';
  assert.equal(resolveComposerSteering(view, task.conversationId).steeringRun?.id, current.id);
  assert.equal(view.settings.toolApprovalMode, 'auto');
});

const project: Project = {
  id: 'project',
  name: 'Fixture project',
  path: 'C:/Fixture',
  scope: 'chat',
  createdAt: stamp,
  updatedAt: stamp,
};
const conversation: Conversation = {
  id: 'conversation',
  projectId: project.id,
  title: 'Fixture conversation',
  createdAt: stamp,
  updatedAt: stamp,
};
const render = (view: AppState) =>
  renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      state: view,
      project,
      conversation,
      api: async <T>() => ({}) as T,
      notify() {},
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    }),
  );

test('newer queued messages cannot hide this conversation’s executing steer channel', () => {
  const executing = workflow();
  const nativeRun = run();
  for (const status of ['queued', 'waiting-resource', 'waiting-confirmation'] as const) {
    const newer = workflow({ id: 'newer', status, createdAt: '2026-09-30T13:00:00.000Z' });
    const view = state([newer, executing], [nativeRun]);
    const selected = resolveComposerSteering(view, conversation.id);
    assert.equal(selected.active, executing);
    assert.equal(selected.currentRun, nativeRun);
    assert.equal(selected.steeringRun, nativeRun);
    const html = render(view);
    assert.match(html, /title="Enter：补充给当前任务 · Ctrl\+Enter：排在后面/);
    assert.doesNotMatch(html, /composer-shortcuts|composer-caption/);
    assert.doesNotMatch(html, /aria-label="排在后面"/);
    assert.match(html, /aria-label="文件权限"|>可写入<\/button>/);
    assert.match(html, /aria-label="停止最近进行中的任务"/);
    assert.doesNotMatch(html, /当前输入通道尚不能 steer|有任务在运行；/);
  }
});

test('a running card reports confirmed steer progress without treating old text as new thinking', () => {
  const executing = workflow();
  const native = run({ reasoning: 'Thinking before the correction\nPrivate body', output: 'Earlier answer' });
  const trace = () =>
    renderToStaticMarkup(
      createElement(WorkflowTrace, {
        workflow: executing,
        state: state([executing], [native]),
        api: async <T>() => ({}) as T,
        notify() {},
        onInspect() {},
      }),
    );
  assert.doesNotMatch(trace(), /已开始处理补充|执行器已接收补充/);
  native.steeringProgress = { id: 'steer', phase: 'sending', mode: 'interrupt', at: stamp };
  assert.match(trace(), /正在切换到补充消息/);
  assert.doesNotMatch(trace(), /已开始处理补充/);
  native.steeringProgress = { id: 'steer', phase: 'received', mode: 'append', at: stamp };
  const received = trace();
  assert.match(received, /执行器已接收补充，等待后续输出/);
  assert.match(received, /Thinking before the correction/);
  assert.match(received, /Earlier answer/);
  assert.doesNotMatch(received, /已开始处理补充/);
  native.steeringProgress = { id: 'steer', phase: 'resuming', mode: 'interrupt', at: stamp };
  assert.match(trace(), /已开始处理补充，后续输出会继续显示/);
  // A summary preserves only the explicit protocol receipt; missing events do not imply another phase.
  native.summary = true;
  native.events = [];
  native.steeringProgress = { id: 'steer', phase: 'received', mode: 'append', at: stamp };
  assert.doesNotMatch(trace(), /已开始处理补充/);
  native.steeringProgress = { id: 'steer', phase: 'failed', mode: 'interrupt', at: stamp };
  assert.match(trace(), /role="alert">补充投递失败/);
});

test('foreign, deleted and ended workflows and runs cannot advertise a live channel', () => {
  const view = state(
    [
      workflow({ conversationId: 'other' }),
      workflow({ id: 'deleted', deletedAt: stamp }),
      workflow({ id: 'completed', status: 'completed' }),
    ],
    [run(), run({ workflowId: 'deleted' })],
  );
  assert.deepEqual(resolveComposerSteering(view, conversation.id), {});
  assert.deepEqual(resolveComposerSteering(state([workflow()], [run()]), undefined), {});
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
    const selected = resolveComposerSteering(state([workflow()], [run({ status })]), conversation.id);
    assert.equal(selected.steeringRun, undefined);
  }
});

test('only a current running execution step with matching approval settings advertises steer', () => {
  const older = run({ id: 'old', status: 'completed', startedAt: '2026-09-30T11:00:00.000Z' });
  const current = run();
  const view = state([workflow()], [older, current]);
  assert.equal(resolveComposerSteering(view, conversation.id).steeringRun, current);
  view.settings.toolApprovalMode = 'ask';
  const changed = resolveComposerSteering(view, conversation.id);
  assert.equal(changed.steeringRun, undefined);
  assert.match(changed.caption!, /审批设置已更改/);
  const legacy = resolveComposerSteering(state([workflow()], [run({ toolApprovalMode: undefined })]), conversation.id);
  assert.equal(legacy.steeringRun, undefined);
  assert.match(legacy.caption!, /尚未就绪/);
  assert.doesNotMatch(legacy.caption!, /设置已更改|未提供/);
});

test('approval waits and planning runs explain the stage without claiming unsupported steer', () => {
  const approval = resolveComposerSteering(
    state([workflow()], [run({ status: 'waiting-approval', steeringStatus: { state: 'ready' } })]),
    conversation.id,
  );
  assert.equal(approval.steeringRun, undefined);
  assert.match(approval.caption!, /等待审批/);
  for (const task of [workflow(), workflow({ status: 'planning', phase: 'plan' })]) {
    const planning = resolveComposerSteering(state([task], [run({ stepId: undefined })]), conversation.id);
    assert.equal(planning.steeringRun, undefined);
    assert.match(planning.caption!, /理解与拆解/);
    assert.doesNotMatch(planning.caption!, /未提供|不能 steer/);
  }
});

test('channel lifecycle and legacy flag snapshots have distinct accurate hints', () => {
  for (const [channel, expected] of [
    ['starting', /执行器正在启动，插话通道尚在连接/],
    ['waiting', /正在切换执行阶段，插话暂不可用/],
    ['finishing', /本轮正在收尾，后续消息会继续任务/],
    ['unsupported', /当前执行器协议未提供插话通道/],
    ['ready', /插话通道尚未就绪/],
  ] as const) {
    const view = state([workflow()], [run({ steerAvailable: false, steeringStatus: { state: channel } })]);
    const selected = resolveComposerSteering(view, conversation.id);
    assert.equal(selected.steeringRun, undefined);
    assert.match(selected.caption!, expected);
    assert.match(render(view), expected);
  }
  for (const steerAvailable of [false, undefined]) {
    const legacy = resolveComposerSteering(state([workflow()], [run({ steerAvailable })]), conversation.id);
    assert.match(legacy.caption!, /尚未就绪/);
    assert.doesNotMatch(legacy.caption!, /未提供|不能 steer/);
  }
  const starting = resolveComposerSteering(state([workflow({ phase: 'route' })]), conversation.id);
  assert.match(starting.caption!, /执行器正在启动/);
  const switching = resolveComposerSteering(state([workflow()]), conversation.id);
  assert.match(switching.caption!, /正在切换执行阶段/);
  const finishing = resolveComposerSteering(state([workflow({ phase: 'verify' })]), conversation.id);
  assert.match(finishing.caption!, /本轮正在收尾/);
});

test('a conversation that only waits in the queue does not claim it has a running task', () => {
  for (const [status, expected] of [
    ['queued', /任务正在排队/],
    ['waiting-resource', /任务正在等待资源/],
    ['waiting-confirmation', /任务正在等待确认方案/],
  ] as const) {
    const view = state([workflow({ status })]);
    const selected = resolveComposerSteering(view, conversation.id);
    assert.equal(selected.steeringRun, undefined);
    assert.match(selected.caption!, expected);
    const html = render(view);
    assert.match(html, expected);
    assert.doesNotMatch(html, /composer-stop|aria-label="取消最近排队的任务"/);
    assert.doesNotMatch(html, /有任务在运行|插话通道尚未就绪|尚不能 steer/);
  }
});

test('queued cards offer an explicit steer action only for a running channel in the same conversation', () => {
  const actions = { api: async <T>() => ({}) as T, notify() {}, onConversation() {}, onInspect() {} };
  for (const status of ['queued', 'waiting-resource'] as const) {
    const queued = workflow({ id: 'queued', status, runIds: [], createdAt: '2026-09-30T13:00:00.000Z' });
    const view = state([workflow(), queued], [run()]);
    assert.equal(queuedSteeringRun(view, queued)?.id, 'run');
    const trace = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, workflow: queued, state: view }));
    const queue = renderToStaticMarkup(
      createElement(QueueItem, { ...actions, workflow: queued, state: view, now: Date.parse(stamp) }),
    );
    for (const html of [trace, queue]) assert.match(html, /插入当前任务（steer）/);
    // The conversation action remains visible when the compact trace is collapsed.
    assert.match(trace, /<\/details><div class="trace-actions"><button[^>]+>.*插入当前任务（steer）/);
    for (const changed of [
      { ...queued, conversationId: 'other' },
      { ...queued, deletedAt: stamp },
      { ...queued, startedAt: stamp },
      { ...queued, runIds: ['run'] },
      { ...queued, parentWorkflowId: 'parent' },
      { ...queued, pendingSteer: { workflowId: 'executing', runId: 'prior-native-turn' } },
      { ...queued, status: 'waiting-confirmation' as const },
      { ...queued, status: 'completed' as const },
    ]) {
      assert.equal(queuedSteeringRun(view, changed), undefined);
    }
    const unavailable = { ...view, runs: [run({ steerAvailable: false })] };
    assert.equal(queuedSteeringRun(unavailable, queued), undefined);
    assert.doesNotMatch(
      renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, workflow: queued, state: unavailable })),
      /插入当前任务（steer）/,
    );
  }
});

test('explicit queue steer reuses the queued input endpoint and exposes delivery errors to its caller', async () => {
  const calls: unknown[][] = [];
  const api: Api = async <T>(...args: [string, unknown?, string?]) => {
    calls.push(args);
    return { ok: true } as T;
  };
  await steerQueuedWorkflow(api, 'queued/id');
  assert.deepEqual(calls, [['/api/workflows/queued%2Fid/steer', {}, 'POST']]);
  const rejected: Api = async () => {
    throw new Error('Fixture: execution settings differ; the message remains queued.');
  };
  await assert.rejects(steerQueuedWorkflow(rejected, 'queued'), /execution settings differ/);
});
