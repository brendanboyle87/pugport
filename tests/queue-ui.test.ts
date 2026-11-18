import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, RunRecord, Workflow } from '../src/shared/types.ts';
import { QueueItem, TaskQueue } from '../src/ui/TaskQueue.tsx';
import { ScheduledTasks } from '../src/ui/ScheduledTasks.tsx';
import { ConversationWorkspace } from '../src/ui/Workspace.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import {
  deadlineRiskLabel,
  estimatedDuration,
  isActiveWorkflow,
  isExecutingWorkflow,
  scheduleFromLocalInput,
  selectQueue,
} from '../src/ui/queue-utils.ts';

const now = Date.parse('2026-09-26T12:00:00Z');
function workflow(id: string, status: Workflow['status'], changes: Partial<Workflow> = {}): Workflow {
  return {
    id,
    status,
    projectId: 'project-a',
    conversationId: 'conversation-a',
    userMessageId: `message-${id}`,
    input: { content: `Task ${id}`, mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
    phase: ['queued', 'waiting-resource'].includes(status) ? 'queue' : 'execute',
    plan: [],
    runIds: [],
    memoryRevision: 1,
    memoryExcerpt: '',
    createdAt: '2026-09-26T10:00:00Z',
    updatedAt: '2026-09-26T10:00:00Z',
    ...changes,
  };
}
function scheduled(id: string, status: Workflow['status'], deadlineAt?: string, projectId = 'project-a') {
  const result = workflow(id, status, { projectId });
  result.input.schedule = { ...(deadlineAt ? { deadlineAt } : {}), priority: 'normal', preferExpiringQuota: true };
  return result;
}
function appState(workflows: Workflow[]): AppState {
  return {
    app: { name: 'PugPort', version: 'test', platform: 'test', dataDir: 'test' },
    runtimes: [],
    targets: [],
    runs: [],
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
      defaultProjectPath: 'test',
      maxConcurrentRuns: 1,
    },
    projects: [
      {
        id: 'project-a',
        name: 'Project A',
        path: 'C:/Fixture/A',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ],
    conversations: [
      {
        id: 'conversation-a',
        projectId: 'project-a',
        title: 'Test conversation',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    ],
    workflows,
    conversationMessages: workflows.map((item) => ({
      id: item.userMessageId,
      workflowId: item.id,
      conversationId: item.conversationId,
      role: 'user' as const,
      content: item.input.content,
      createdAt: item.createdAt,
    })),
  };
}

test('queue progresses executing tasks first, then waiting by deadline, then attention; input array is unchanged', () => {
  const tasks = [
    scheduled('no-deadline', 'queued'),
    scheduled('later', 'waiting-resource', '2026-09-28T12:00:00Z'),
    workflow('blocked', 'blocked'),
    workflow('running', 'running'),
    scheduled('soon', 'queued', '2026-09-27T12:00:00Z'),
    workflow('done', 'completed'),
  ];
  const original = tasks.map((item) => item.id);
  assert.deepEqual(
    selectQueue(tasks, '', 'pending', 'progress').map((item) => item.id),
    ['running', 'soon', 'later', 'no-deadline', 'blocked'],
  );
  assert.deepEqual(
    tasks.map((item) => item.id),
    original,
  );
  assert.equal(isActiveWorkflow(tasks[0]), true);
  assert.equal(isExecutingWorkflow(tasks[0]), false);
});

test('project/status filters and deadline ordering preserve missing deadline semantics', () => {
  const tasks = [
    scheduled('undated', 'queued'),
    scheduled('later', 'waiting-resource', '2026-09-28T12:00:00Z'),
    scheduled('earlier-other-project', 'queued', '2026-09-27T12:00:00Z', 'project-b'),
    workflow('interrupted', 'interrupted'),
    workflow('done', 'completed'),
  ];
  assert.deepEqual(
    selectQueue(tasks, '', 'all', 'deadline')
      .slice(0, 2)
      .map((item) => item.id),
    ['earlier-other-project', 'later'],
  );
  assert.deepEqual(
    selectQueue(tasks, 'project-a', 'queued', 'progress').map((item) => item.id),
    ['undated'],
  );
  assert.ok(selectQueue(tasks, 'project-a', 'pending', 'progress').some((item) => item.id === 'interrupted'));
  assert.ok(!selectQueue(tasks, '', 'pending', 'progress').some((item) => item.id === 'done'));
});

test('schedule sends local wall time as ISO and includes quota preference without invented dates or duration', () => {
  assert.deepEqual(scheduleFromLocalInput('', '', 'normal', true), { priority: 'normal', preferExpiringQuota: true });
  assert.deepEqual(scheduleFromLocalInput('', '', 'normal', false), { priority: 'normal', preferExpiringQuota: false });
  const schedule = scheduleFromLocalInput('2026-09-28T14:15', '2026-09-27T09:30', 'high', true);
  assert.equal(schedule.deadlineAt, new Date(2026, 8, 28, 14, 15).toISOString());
  assert.equal(schedule.notBefore, new Date(2026, 8, 27, 9, 30).toISOString());
  assert.equal(schedule.priority, 'high');
  assert.equal('estimatedMinutes' in schedule, false);
  assert.throws(() => scheduleFromLocalInput('invalid', '', 'normal', true), /有效/);
  assert.throws(() => scheduleFromLocalInput('2026-09-27T09:30', '2026-09-27T09:30', 'normal', true), /早于/);
});

test('duration remains an estimate and finished tasks do not acquire overdue warnings', () => {
  const task = scheduled('wait', 'waiting-resource', '2026-09-26T11:00:00Z');
  assert.equal(estimatedDuration(task), '尚未估计');
  task.scheduling = {
    reason: '等待资源',
    estimatedMinutes: 12.5,
    lastEvaluatedAt: new Date(now).toISOString(),
    deadlineRisk: true,
  };
  assert.equal(estimatedDuration(task), '约 13 分钟（估计）');
  assert.equal(deadlineRiskLabel(task, now), '已超过期限');
  task.input.schedule!.deadlineAt = '2026-09-28T11:00:00Z';
  assert.equal(deadlineRiskLabel(task, now), '有超期风险');
  task.status = 'completed';
  assert.equal(deadlineRiskLabel(task, now), undefined);
});

test('queue renders waiting reasons, real next checks, cancel and continue without a running spinner', () => {
  const task = scheduled('wait', 'waiting-resource', '2026-09-28T11:00:00Z');
  task.scheduling = {
    reason: '等待 CLI 订阅窗口重置',
    estimatedMinutes: 15,
    lastEvaluatedAt: '2026-09-26T11:50:00Z',
    nextAttemptAt: '2026-09-26T13:00:00Z',
    deadlineRisk: true,
  };
  const state = appState([task, workflow('paused', 'interrupted')]);
  const html = renderToStaticMarkup(
    createElement(TaskQueue, {
      state,
      now,
      api: async <T>() => ({}) as T,
      notify() {},
      onConversation() {},
      onInspect() {},
    }),
  );
  assert.match(html, /等待 CLI 订阅窗口重置/);
  assert.match(html, /15 分钟（估计）/);
  assert.match(html, /下次调度检查/);
  assert.match(html, /有超期风险/);
  assert.match(html, /取消排队/);
  assert.match(html, />继续<\/button>/);
  assert.match(html, /打开对话/);
  assert.match(html, /任务尚未开始，暂无执行记录/);
  const waitingItem = html.split('data-workflow-id="wait"')[1].split('</details>')[0];
  assert.ok(!waitingItem.includes('spinning'));
  assert.ok(!waitingItem.includes('正在执行'));
});

test('task pages share the management heading and the queue omits manual refresh and filler', () => {
  const state = appState([workflow('active', 'running')]);
  const props = {
    state,
    now,
    api: async <T>() => ({}) as T,
    notify() {},
    onConversation() {},
    onInspect() {},
  };
  const queue = renderToStaticMarkup(createElement(TaskQueue, props));
  assert.match(queue, /class="management-heading"><h1>任务队列<\/h1>/);
  assert.doesNotMatch(queue, /重新检查队列|时间按此设备的时区显示|查看任务何时开始/);
  assert.doesNotMatch(queue, /任务已开始，可展开查看执行记录|尚未估计|class="queue-reason"|class="queue-brief"/);
  assert.match(queue, />停止<\/button>/);
  assert.doesNotMatch(queue, /停止任务/);

  const scheduled = renderToStaticMarkup(createElement(ScheduledTasks, props));
  assert.match(scheduled, /<header class="management-heading"><div><h1>定时任务<\/h1>/);
  assert.match(scheduled, /新建任务/);
});

test('conversation trace distinguishes queued work and composer exposes queue-aware submit and latest cancel', () => {
  const earlier = workflow('earlier', 'running');
  const later = workflow('later', 'queued', { createdAt: '2026-09-26T11:00:00Z' });
  const state = appState([earlier, later]);
  const html = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      state,
      api: async <T>() => ({}) as T,
      project: state.projects![0],
      conversation: state.conversations![0],
      notify() {},
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    }),
  );
  assert.match(html, /title="Enter：补充给当前任务 · Ctrl\+Enter：排在后面/);
  assert.doesNotMatch(html, /composer-shortcuts|composer-caption/);
  assert.match(html, /停止最近进行中的任务/);
  assert.doesNotMatch(html, /id="workflow-later"/);
  assert.match(html, /conversation-queue/);
  assert.match(html, /正在切换执行阶段，插话暂不可用；新消息会排队/);
});

function renderItem(task: Workflow, runs: RunRecord[] = [], at = now) {
  return renderToStaticMarkup(
    createElement(QueueItem, {
      workflow: task,
      state: { ...appState([task]), runs },
      now: at,
      api: async <T>() => ({}) as T,
      notify() {},
      onConversation() {},
      onInspect() {},
    }),
  );
}
const reasonText = (html: string) => html.match(/<p class="queue-reason">([^<]*)<\/p>/)![1];
function execution(task: Workflow, changes: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'native-run',
    workflowId: task.id,
    status: 'running',
    startedAt: new Date(now - 62_000).toISOString(),
    projectPath: 'C:/Fixture/A',
    kind: 'general',
    prompt: task.input.content,
    output: '',
    events: [],
    route: { runtimeId: 'codex', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    ...changes,
  };
}

test('attention and terminal queue reasons cannot be overwritten by stale scheduling text', () => {
  for (const status of ['blocked', 'interrupted', 'failed', 'cancelled', 'completed'] as const) {
    const task = workflow(status, status, {
      stopped: status === 'cancelled',
      error: `当前 ${status} 原因`,
      scheduling: {
        reason: '准备启动；执行器已启动',
        estimatedMinutes: 5,
        lastEvaluatedAt: new Date(now).toISOString(),
      },
    });
    assert.equal(reasonText(renderItem(task)), `当前 ${status} 原因`);
    task.error = undefined;
    const reason = reasonText(renderItem(task));
    assert.doesNotMatch(reason, /准备启动|执行器已启动/);
    if (status === 'interrupted') assert.match(reason, /已中断/);
    if (status === 'blocked') assert.match(reason, /需要处理/);
    if (status === 'failed') assert.match(reason, /执行失败/);
  }
});

test('current approvals, execution and follow-up reasons take precedence while waiting keeps resource reasons', () => {
  const task = workflow('task', 'waiting-confirmation', {
    scheduling: { reason: '准备启动', estimatedMinutes: 5, lastEvaluatedAt: new Date(now).toISOString() },
  });
  assert.match(reasonText(renderItem(task)), /审核执行器/);
  task.status = 'waiting-approval';
  assert.match(reasonText(renderItem(task)), /审批卡片/);
  task.status = 'running';
  assert.doesNotMatch(renderItem(task), /queue-reason|准备启动|任务已开始/);
  task.error = '当前执行需要关注';
  assert.equal(reasonText(renderItem(task)), task.error);
  task.error = undefined;
  task.status = 'waiting-resource';
  task.scheduling!.reason = '等待订阅额度重置';
  assert.equal(reasonText(renderItem(task)), '等待订阅额度重置');
  task.status = 'failed';
  task.error = '原运行失败';
  task.followUp = { workflowId: 'successor', kind: 'continue', at: new Date(now).toISOString() };
  assert.equal(reasonText(renderItem(task)), '原执行记录和错误保留，后续进展见新任务。');
});

test('queue attention uses the latest native error when the workflow has no error', () => {
  const task = workflow('failed', 'failed', {
    runIds: ['native-run'],
    scheduling: { reason: '执行器已启动', estimatedMinutes: 5, lastEvaluatedAt: new Date(now).toISOString() },
  });
  const run = execution(task, { status: 'failed', error: '本次连接已断开' });
  assert.equal(reasonText(renderItem(task, [run])), '本次连接已断开');
});

test('queue measures actual launch time separately from estimates and never measures unstarted queue time', () => {
  const task = workflow('running', 'running', {
    runIds: ['native-run'],
    scheduling: { reason: '执行器已启动', estimatedMinutes: 15, lastEvaluatedAt: new Date(now).toISOString() },
  });
  const run = execution(task);
  const brief = (html: string) => html.split('<div class="queue-brief">')[1].split('</div>')[0];
  assert.match(brief(renderItem(task, [run])), /已运行：1分02秒/);
  assert.match(brief(renderItem(task, [run])), /预计耗时：约 15 分钟（估计）/);
  task.status = 'interrupted';
  task.updatedAt = new Date(now).toISOString();
  run.status = 'interrupted';
  run.endedAt = new Date(now - 42_000).toISOString();
  assert.match(brief(renderItem(task, [run], now + 3600_000)), /实际用时：20秒/);
  task.status = 'waiting-resource';
  task.updatedAt = new Date(now - 52_000).toISOString();
  assert.match(brief(renderItem(task, [run], now + 3600_000)), /实际用时：10秒/);
  const unstarted = workflow('unstarted', 'queued');
  const waiting = renderItem(unstarted);
  assert.doesNotMatch(waiting, /queue-brief|预计耗时|耗时估计|尚未估计/);
  assert.doesNotMatch(waiting, /已运行|实际用时/);
});

test('archived task keeps Open chat and passes its conversation id', async () => {
  const task = workflow('archived-task', 'completed');
  const state = appState([task]);
  state.conversations = [];
  let opened: unknown;
  const harness = uiHarness(await uiBundle('src/ui/TaskQueue.tsx'));
  const tree = harness.render('QueueItem', {
    workflow: task,
    state,
    now,
    api: async () => ({}),
    notify() {},
    onConversation: (id: unknown) => {
      opened = id;
    },
    onInspect() {},
  });
  const button = findNode(tree, (node) => node.type === 'button' && text(node).includes('打开对话'));
  assert.ok(button, 'archived conversations retain Open chat');
  button.props.onClick();
  assert.equal(opened, task.conversationId);
});

async function studioFixture(state: AppState, selected = '') {
  const storage = new Map([['agent-studio-conversation', selected]]);
  const listeners = new Set<(event: unknown) => void>();
  const archived = { ...appState([]).conversations![0]!, archivedAt: new Date(now).toISOString() };
  const requests: string[] = [];
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: {
      state,
      api: async (path: string) => {
        requests.push(path);
        return path.includes('?recordOnly=1') ? { conversation: archived } : {};
      },
      reload: async () => {},
      connection: 'connected',
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    window: {
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === 'keydown') listeners.add(listener);
      },
      removeEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === 'keydown') listeners.delete(listener);
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  const render = () => harness.render('default');
  const palette = () => {
    render();
    for (const listener of listeners)
      listener({ key: 'k', ctrlKey: true, target: { tagName: 'DIV' }, preventDefault() {} });
    return findNode(render(), (node) => Array.isArray(node.props.entries))!;
  };
  const currentChat = () => {
    const pane = findNode(
      render(),
      (node) => Array.isArray(node.props.ids) && typeof node.props.children === 'function',
    );
    return pane?.props.children(pane.props.ids[0], 0).props.conversation;
  };
  return { render, palette, currentChat, archived, requests, storage };
}

test('command palette uses the sidebar scope and restores agent chats with the existing setting', async () => {
  const state = appState([]);
  state.agentConversationIds = ['conversation-a'];
  const fixture = await studioFixture(state);
  assert.equal(
    fixture.palette().props.entries.some((entry: { id: string }) => entry.id === 'c-conversation-a'),
    false,
  );
  fixture.palette();
  state.settings.showAgentConversations = true;
  assert.equal(
    fixture.palette().props.entries.some((entry: { id: string }) => entry.id === 'c-conversation-a'),
    true,
  );
});

test('Tasks opens archived conversations by id', async () => {
  const state = appState([workflow('archived-task', 'completed')]);
  state.conversations = [];
  const fixture = await studioFixture(state);
  fixture
    .palette()
    .props.entries.find((entry: { id: string }) => entry.id === 'page-queue')
    .run();
  const queue = findNode(fixture.render(), (node) => node.type?.name === 'TaskQueue')!;
  await queue.props.onConversation('conversation-a');
  await nextTurn();
  assert.equal(fixture.currentChat()?.id, 'conversation-a');
  assert.equal(fixture.currentChat()?.archivedAt, fixture.archived.archivedAt);
  assert.ok(fixture.requests.includes('/api/conversations/conversation-a?recordOnly=1'));
});

test('a selected conversation stays open after automatic archiving', async () => {
  const state = appState([]);
  const fixture = await studioFixture(state, 'conversation-a');
  assert.equal(fixture.currentChat()?.id, 'conversation-a');
  state.conversations = [];
  fixture.render();
  await nextTurn();
  assert.equal(fixture.currentChat()?.id, 'conversation-a');
  assert.equal(fixture.currentChat()?.archivedAt, fixture.archived.archivedAt);
});
