import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, RunRecord, Workflow } from '../src/shared/types.ts';
import {
  canCancelWorkflow,
  canContinueWorkflow,
  canDeleteWorkflow,
  conversationActivity,
  deadlineRiskLabel,
  isActiveWorkflow,
  isPendingWorkflow,
  selectQueue,
  workflowDisplayStatus,
} from '../src/ui/queue-utils.ts';
import { ConversationHistory, WorkflowTrace } from '../src/ui/Workspace.tsx';
import { QueueItem, TaskQueue } from '../src/ui/TaskQueue.tsx';

const stamp = '2026-09-30T12:00:00.000Z';
const workflow = (patch: Partial<Workflow> = {}): Workflow => ({
  id: 'workflow',
  conversationId: 'conversation',
  projectId: 'project',
  userMessageId: 'message',
  input: { content: 'Fixture task', mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'summarize',
  plan: ['a', 'b'].map((id) => ({
    id,
    title: `Fixture step ${id}`,
    instruction: 'Fixture instruction',
    kind: 'general',
    transport: 'cli',
    dependsOn: [],
    status: 'completed',
    runIds: [`run-${id}`],
  })),
  runIds: ['run-a', 'run-b'],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const run = (id: string, patch: Partial<RunRecord> = {}): RunRecord => ({
  id: `run-${id}`,
  workflowId: 'workflow',
  stepId: id,
  prompt: 'Fixture prompt',
  projectPath: 'C:/Fixture',
  kind: 'general',
  status: 'completed',
  route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
  startedAt: stamp,
  output: 'Fixture reply',
  events: [],
  verification: { command: 'fixture-check', status: 'passed', exitCode: 0, output: 'Fixture acceptance' },
  ...patch,
});
const actions = {
  api: async <T>() => ({}) as T,
  notify() {},
  onConversation() {},
  onInspect() {},
};
const appState = (workflows: Workflow[], runs: RunRecord[] = []): AppState =>
  ({ targets: [], runtimes: [], runs, workflows, settings: {} }) as unknown as AppState;

test('a single completed chat has a collapsed record with status, duration and the existing trace link', () => {
  const task = workflow({ runIds: ['run-a'], plan: workflow().plan.slice(0, 1) });
  task.input.mode = 'chat';
  const recorded = run('a', {
    account: { id: 'codex-b', label: 'Codex B', provider: 'codex' },
    effectiveModel: { model: 'gpt-5.6-terra', effort: 'high', source: 'fixture' },
    endedAt: '2026-09-30T12:00:12.000Z',
  });
  const html = renderToStaticMarkup(
    createElement(WorkflowTrace, { ...actions, workflow: task, state: appState([task], [recorded]), onTrace() {} }),
  );
  assert.match(html, /<details><summary>/);
  const summary = html.match(/<summary>(.*?)<\/summary>/s)![1]!;
  assert.match(summary, /回复结束.*12秒/);
  assert.doesNotMatch(summary, /Codex B|gpt-5.6-terra|high|个步骤/);
  assert.match(html, /Fixture step a/);
  assert.match(html, /class="button tiny quiet trace-link"[^>]*>查看轨迹/);
});

test("single-run records keep status without repeating effort or borrowing another workflow's identity", () => {
  const task = workflow({ runIds: ['run-a'], plan: [] });
  task.input.mode = 'chat';
  const render = (runs: RunRecord[]) =>
    renderToStaticMarkup(
      createElement(WorkflowTrace, { ...actions, workflow: task, state: appState([task], runs), onTrace() {} }),
    );
  const html = render([run('a')]);
  assert.match(html, /<details><summary>[\s\S]*回复结束/);
  assert.doesNotMatch(html, /reply-identity|强度未报告/);
  for (const runs of [
    [],
    [run('a', { workflowId: 'foreign', account: { id: 'foreign', label: 'Foreign executor', provider: 'codex' } })],
  ]) {
    const unloaded = render(runs);
    assert.match(unloaded, /<details><summary>/);
    assert.match(unloaded, /查看轨迹/);
    assert.doesNotMatch(unloaded, /Foreign executor/);
  }
});

test('only the latest ended run exposes one native-denied notice and approval rerun button', () => {
  const denied = run('b', {
    events: [
      { at: stamp, type: 'status', data: { kind: 'native-denied', reason: 'First request' } },
      { at: stamp, type: 'status', data: { kind: 'native-denied', reason: 'Synthetic network permission' } },
    ],
  });
  const render = (task: Workflow, runs: RunRecord[]) =>
    renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, workflow: task, state: appState([task], runs) }));
  const html = render(workflow(), [run('a'), denied]);
  assert.match(html, /Codex 自动模式拒绝了额外权限：Synthetic network permission/);
  assert.equal(html.split('按逐次确认重跑').length - 1, 1);
  assert.doesNotMatch(html, /First request/);
  for (const status of [
    'queued',
    'planning',
    'running',
    'waiting-approval',
    'waiting-resource',
    'waiting-confirmation',
  ] as const) {
    assert.doesNotMatch(render(workflow({ status }), [denied]), /Codex 自动模式拒绝了额外权限|按逐次确认重跑/);
  }
  for (const runs of [
    [],
    [run('a'), run('b')],
    [{ ...denied, id: 'run-a' }, run('b')],
    [{ ...denied, id: 'run-a' }],
    [{ ...denied, status: 'running' as const }],
  ]) {
    assert.doesNotMatch(render(workflow(), runs), /Codex 自动模式拒绝了额外权限|按逐次确认重跑/);
  }
});

test('chat read-only roles show the shared reason', () => {
  const task = workflow();
  task.input = {
    ...task.input,
    mode: 'chat',
    permissionMode: 'read-only',
    permissionOrigin: { mode: 'read-only', source: 'role' },
  };
  const html = renderToStaticMarkup(
    createElement(WorkflowTrace, { ...actions, workflow: task, state: appState([task]) }),
  );
  assert.match(html, /只读 · 你点名的只读角色/);
});

test('past cloud classification and history filtering cards stay hidden with legacy configuration', () => {
  const task = workflow({
    taskJudgment: {
      contractVersion: 'comborunner-task-judgment-v1',
      inputHash: 'fixture-hash',
      source: 'jev',
      status: 'accepted',
      intent: 'action',
      kind: 'design',
      complexity: 'standard',
      confidence: { intent: null, kind: null, complexity: null },
      observedAt: stamp,
      latencyMs: 10,
      reason: 'accepted',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
      requestAttempted: true,
    },
    memoryRetrieval: {
      evidence: {
        source: 'jev',
        status: 'accepted',
        reason: 'accepted',
        assessedAt: stamp,
        elapsedMs: 5,
        requestCount: 1,
        cachedCount: 0,
        usage: { inputTokens: 1, outputTokens: null, totalTokens: null },
        decisions: [],
      },
      status: 'found',
      excerpts: 1,
      verifiedPaths: [],
      elapsedMs: 5,
    },
  });
  // Saved route reasons are filtered by the server before they reach the app (tests/controller-core.test.ts).
  const runs = [run('a'), run('b')];
  const render = (state: AppState) =>
    renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, workflow: task, state }));
  const plain = render(appState([task], runs));
  assert.doesNotMatch(plain, /Jev/);
  const setUp = {
    ...appState([task], runs),
    settings: { taskJudgment: 'jev' },
    jev: { configured: true, enabled: true, status: 'configured-unverified', note: '' },
  } as unknown as AppState;
  for (const oldSettings of [{ taskJudgment: 'jev' }, { memoryEvidence: 'jev' }]) {
    const html = render({ ...setUp, settings: oldSettings } as unknown as AppState);
    assert.doesNotMatch(html, /Jev|Laya|任务判断记录|历史证据筛选/);
  }
  const localTask = {
    ...task,
    memoryRetrieval: {
      ...task.memoryRetrieval!,
      evidence: {
        ...task.memoryRetrieval!.evidence!,
        source: 'local' as const,
        status: 'local' as const,
        requestCount: 0,
      },
    },
  };
  const local = renderToStaticMarkup(
    createElement(WorkflowTrace, { ...actions, workflow: localTask, state: appState([localTask], runs) }),
  );
  assert.match(local, /历史证据筛选 · 本地筛选/);
  assert.doesNotMatch(local, /Jev|Laya/);
});

test('verification-limited completion shows a neutral collapsible check list', () => {
  const task = workflow();
  const checks = [{ id: 'exec-test', command: 'synthetic-test', reason: 'listen EACCES' }];
  const runs = [
    run('a'),
    run('b', {
      taskOutcome: { status: 'completed', source: 'file-receipts', verificationLimited: true, limitedChecks: checks },
    }),
  ];
  assert.deepEqual(workflowDisplayStatus(task, runs), { label: '已完成 · 验证受限', verified: false });
  const html = renderToStaticMarkup(
    createElement(WorkflowTrace, { ...actions, workflow: task, state: appState([task], runs) }),
  );
  assert.match(html, /workflow-verification-limited" role="status"/);
  assert.match(html, /有 1 项检查在沙箱里没法运行/);
  assert.match(html, /<details><summary>查看受限检查<\/summary>/);
  assert.match(html, /synthetic-test/);
  assert.match(html, /listen EACCES/);
  assert.doesNotMatch(html, /role="alert"|workflow-failed|workflow-blocked|error-banner/);
  assert.equal(isPendingWorkflow(task), false);
});

test('a completed reply is labelled as ended, even if a run has an acceptance result', () => {
  const task = workflow();
  task.input.mode = 'chat';
  assert.deepEqual(workflowDisplayStatus(task, [run('a'), run('b')]), { label: '回复结束', verified: false });
  assert.deepEqual(workflowDisplayStatus({ ...task, status: 'blocked' }, []), { label: '需要处理', verified: false });
});

test('every executed step needs recorded passing acceptance; planning calls do not count', () => {
  const task = workflow({ runIds: ['planner', 'run-a', 'run-b'] });
  const planning = run('planner', { id: 'planner', stepId: undefined, verification: undefined });
  assert.deepEqual(workflowDisplayStatus(task, [planning, run('a'), run('b')]), { label: '已验收', verified: true });
  for (const runs of [
    [run('a')],
    [run('a'), run('b', { verification: undefined })],
    [run('a'), run('b', { status: 'failed' })],
    [run('a'), run('b', { workflowId: 'other-workflow' })],
    [run('a'), run('b', { stepId: 'other-step' })],
  ]) {
    assert.deepEqual(workflowDisplayStatus(task, runs), { label: '已完成', verified: false });
  }
  // A check that ran and failed is the one case worth flagging.
  assert.deepEqual(
    workflowDisplayStatus(task, [
      run('a'),
      run('b', { verification: { ...run('b').verification!, status: 'failed' } }),
    ]),
    { label: '验收未通过', verified: false },
  );
});

test('old records, empty plans, and model completion reports cannot imply independent acceptance', () => {
  const selfReported = Object.assign(run('a', { verification: undefined }), {
    taskOutcome: { status: 'completed', source: 'model' },
  });
  assert.equal(workflowDisplayStatus(workflow(), [selfReported, run('b')]).verified, false);
  assert.equal(workflowDisplayStatus(workflow({ plan: [] }), [run('a'), run('b')]).verified, false);
  const task = workflow();
  task.plan[0]!.runIds = [];
  assert.equal(workflowDisplayStatus(task, [run('a'), run('b')]).verified, false);
  const retried = workflow();
  retried.plan[0]!.runIds.unshift('failed-attempt');
  assert.equal(
    workflowDisplayStatus(retried, [run('a'), run('b'), run('a', { id: 'failed-attempt', status: 'failed' })]).verified,
    false,
  );
  const skipped = workflow();
  skipped.plan[0]!.status = 'skipped';
  skipped.plan[0]!.runIds = [];
  assert.equal(workflowDisplayStatus(skipped, [run('b')]).verified, true);
  const legacy = workflow();
  legacy.input.mode = 'auto';
  assert.deepEqual(workflowDisplayStatus(legacy, [run('a'), run('b')]), {
    label: '已完成',
    verified: false,
  });
});

test('workflow cards and queue cards show the same outcome and only verified work uses a check icon', () => {
  for (const scenario of [
    { mode: 'chat' as const, runs: [run('a'), run('b')], label: '回复结束', verified: false },
    { mode: 'build' as const, runs: [run('a'), run('b')], label: '已验收', verified: true },
    {
      mode: 'build' as const,
      runs: [run('a', { verification: undefined }), run('b')],
      label: '已完成',
      verified: false,
    },
    { mode: 'build' as const, runs: [], label: '已完成', verified: false },
  ]) {
    const task = workflow();
    task.input.mode = scenario.mode;
    const state = { targets: [], runtimes: [], runs: scenario.runs, settings: {} } as unknown as AppState;
    const trace = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task }));
    const queue = renderToStaticMarkup(
      createElement(QueueItem, { ...actions, state, workflow: task, now: Date.parse(stamp) }),
    );
    for (const html of [trace, queue]) {
      assert.ok(html.includes(scenario.label), scenario.label);
      if (scenario.verified) assert.match(html, /lucide-check(?:\s|")/);
      else assert.doesNotMatch(html, /lucide-check(?:\s|")/);
    }
  }
});

test('superseded error tasks stay in history but leave pending, attention and deadline-risk counts', () => {
  const successor = workflow({ id: 'next', status: 'queued' });
  for (const status of ['blocked', 'failed', 'interrupted'] as const) {
    const task = workflow({ status, followUp: { workflowId: successor.id, kind: 'continue', at: stamp } });
    task.input.schedule = { deadlineAt: '2026-09-01T00:00:00.000Z' };
    assert.deepEqual(workflowDisplayStatus(task, []), {
      label: '已创建续接任务',
      verified: false,
    });
    assert.equal(canContinueWorkflow(task), false);
    assert.equal(isPendingWorkflow(task), false);
    assert.equal(deadlineRiskLabel(task, Date.parse(stamp)), undefined);
    assert.equal(conversationActivity([task], task.conversationId), undefined);
    assert.equal(conversationActivity([task, successor], task.conversationId), 'queued');
    assert.deepEqual(
      selectQueue([task, successor], '', 'pending', 'progress').map((item) => item.id),
      ['next'],
    );
    assert.equal(selectQueue([task], '', 'all', 'progress').length, 1);
    assert.equal(canCancelWorkflow(task), true);
    assert.equal(canDeleteWorkflow(task), true);
  }
});

test('superseded cards collapse, preserve their error and link to a real successor instead of offering Continue', () => {
  const successor = workflow({ id: 'next', status: 'queued' });
  const task = workflow({
    status: 'blocked',
    error: 'Fixture original error',
    followUp: { workflowId: successor.id, kind: 'continue', at: stamp },
  });
  const state = appState([task, successor]);
  const trace = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task }));
  const queue = renderToStaticMarkup(
    createElement(QueueItem, { ...actions, state, workflow: task, now: Date.parse(stamp) }),
  );
  const label = '已创建续接任务';
  for (const html of [trace, queue]) {
    assert.ok(html.includes(label));
    assert.match(html, /Fixture original error/);
    if (html === queue) assert.match(html, /取消任务/);
    else assert.doesNotMatch(html, /取消任务/);
    assert.match(html, /删除任务/);
    assert.doesNotMatch(html, /需要处理|继续未完成的工作|继续任务|>继续<\/button>|已完成|已验收/);
    assert.doesNotMatch(html, /lucide-check(?:\s|")/);
    assert.doesNotMatch(html.match(/<details[^>]*>/)?.[0] ?? '', /\bopen\b/);
  }
  assert.match(trace, /href="#workflow-next"/);
  const nextTrace = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: successor }));
  assert.match(nextTrace, /id="workflow-next"/);
  const overview = renderToStaticMarkup(createElement(TaskQueue, { ...actions, state, now: Date.parse(stamp) }));
  assert.match(overview, /<strong>0<\/strong> 需要处理/);
  assert.doesNotMatch(overview, /data-workflow-id="workflow"/);
  assert.match(overview, /data-workflow-id="next"/);
});

test('a later message keeps the original failed task visible and resumable without claiming it was continued', () => {
  const successor = workflow({ id: 'next', status: 'queued' });
  for (const status of ['blocked', 'failed', 'interrupted'] as const) {
    const task = workflow({
      status,
      error: 'Fixture original error',
      followUp: { workflowId: successor.id, kind: 'message', at: stamp },
    });
    assert.equal(canContinueWorkflow(task), true);
    assert.equal(isPendingWorkflow(task), true);
    assert.notEqual(workflowDisplayStatus(task, []).label, '已由后续消息接替');
    const state = appState([task, successor]);
    const trace = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task }));
    const queue = renderToStaticMarkup(
      createElement(QueueItem, { ...actions, state, workflow: task, now: Date.parse(stamp) }),
    );
    for (const html of [trace, queue]) {
      assert.match(html, /Fixture original error/);
      assert.match(html, /继续(?:未完成的工作|任务)?<\/button>/);
      assert.doesNotMatch(html, /已由后续消息接替|已创建续接任务/);
    }
    assert.match(trace, /href="#workflow-next"/, 'the later message remains reachable as history');
    assert.doesNotMatch(trace.match(/<details[^>]*>/)?.[0] ?? '', /\bopen\b/, 'process details start folded');
    assert.deepEqual(
      selectQueue([task, successor], '', 'pending', 'progress').map((item) => item.id),
      ['next', 'workflow'],
    );
  }
});

test('ended error tasks cancel only in task management; deletion still requires an inactive task', () => {
  for (const status of ['blocked', 'failed', 'interrupted', 'completed', 'cancelled'] as const) {
    const task = workflow({ status });
    const state = appState([task]);
    assert.equal(canDeleteWorkflow(task), true);
    assert.equal(canCancelWorkflow(task), ['blocked', 'failed', 'interrupted'].includes(status));
    const trace = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task }));
    const queue = renderToStaticMarkup(
      createElement(QueueItem, { ...actions, state, workflow: task, now: Date.parse(stamp) }),
    );
    assert.match(trace, /删除任务/);
    assert.doesNotMatch(trace, /取消任务/);
    assert.match(queue, /删除任务/);
    if (canCancelWorkflow(task)) assert.match(queue, /取消任务/);
    else assert.doesNotMatch(queue, /取消任务/);
  }
  for (const status of [
    'running',
    'planning',
    'queued',
    'waiting-resource',
    'waiting-approval',
    'waiting-confirmation',
  ] as const) {
    const task = workflow({ status });
    const state = appState([task]);
    assert.equal(canCancelWorkflow(task), true);
    assert.equal(canDeleteWorkflow(task), false);
    for (const html of [
      renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task })),
      renderToStaticMarkup(createElement(QueueItem, { ...actions, state, workflow: task, now: Date.parse(stamp) })),
    ])
      assert.doesNotMatch(html, /删除任务/);
  }
});

test('deleting a task hides its cards and counts while chat messages and execution records remain', () => {
  const task = workflow({ status: 'blocked', deletedAt: stamp, error: 'Fixture removed card error' });
  const state = appState([task], [run('a')]);
  assert.equal(canContinueWorkflow(task), false);
  assert.equal(canCancelWorkflow(task), false);
  assert.equal(canDeleteWorkflow(task), false);
  assert.equal(isPendingWorkflow(task), false);
  assert.deepEqual(selectQueue([task], '', 'all', 'created'), []);
  assert.equal(
    conversationActivity([workflow({ status: 'waiting-approval', deletedAt: stamp })], task.conversationId),
    undefined,
  );
  assert.equal(isActiveWorkflow(workflow({ status: 'running', deletedAt: stamp })), false);
  assert.equal(renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task })), '');
  assert.equal(
    renderToStaticMarkup(createElement(QueueItem, { ...actions, state, workflow: task, now: Date.parse(stamp) })),
    '',
  );
  const messages = [
    {
      id: 'message',
      conversationId: task.conversationId,
      workflowId: task.id,
      role: 'user' as const,
      content: 'Fixture user message retained',
      createdAt: stamp,
    },
    {
      id: 'reply',
      conversationId: task.conversationId,
      workflowId: task.id,
      role: 'assistant' as const,
      content: 'Fixture assistant reply retained',
      createdAt: stamp,
    },
  ];
  const history = renderToStaticMarkup(
    createElement(ConversationHistory, { ...actions, state, workflows: [task], messages }),
  );
  assert.match(history, /Fixture user message retained/);
  assert.match(history, /Fixture assistant reply retained/);
  assert.doesNotMatch(history, /workflow-trace|Fixture removed card error/);
  const queue = renderToStaticMarkup(createElement(TaskQueue, { ...actions, state, now: Date.parse(stamp) }));
  assert.doesNotMatch(queue, /data-workflow-id="workflow"/);
  assert.match(queue, /<strong>0<\/strong> 需要处理/);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0]!.output, 'Fixture reply');
});

test('a task only waiting for a background comparison reads as waiting with live progress, not as an error', () => {
  const task = workflow({
    status: 'blocked',
    error: '任务尚未完成：全库任务 9d0faf36 仍在运行。',
    waitingOn: { kind: 'media-analysis', jobId: 'job-1', done: 2827, total: 6414 },
  });
  const state = {
    ...appState([task]),
    backgroundTasks: [
      {
        id: 'job-1',
        kind: 'media-analysis',
        conversationId: 'conversation',
        title: '本地媒体比对',
        detail: '',
        done: 4010,
        total: 6414,
        startedAt: stamp,
        state: 'running',
      },
    ],
  } as unknown as AppState;
  const html = renderToStaticMarkup(createElement(WorkflowTrace, { ...actions, state, workflow: task }));
  assert.match(html, /等后台比对/);
  assert.match(html, /在等后台的本地媒体比对跑完（4,010 \/ 6,414）/, 'progress is read live from the background task');
  assert.doesNotMatch(html, /class="workflow-error"/);
  assert.equal(workflowDisplayStatus(task, []).label, '等后台比对');
  assert.equal(isPendingWorkflow(task), true, 'it stays in the pending list until it finishes');
  assert.equal(canContinueWorkflow(task), true, 'the user may still continue it by hand');
});

test('a multi-step background job shows its steps, the current step on the bar, and the time left in it', async () => {
  const { BackgroundTasks } = await import('../src/ui/BackgroundTasks.tsx');
  const html = renderToStaticMarkup(
    createElement(BackgroundTasks, {
      conversationId: 'conversation',
      onPause: () => {},
      onResume: () => {},
      onClose: () => {},
      tasks: [
        {
          id: 'job-1',
          kind: 'media-analysis',
          conversationId: 'conversation',
          title: '本地媒体比对',
          detail: '第 4/5 步：相似视频补齐抽样（24 帧）',
          done: 565,
          total: 1133,
          startedAt: stamp,
          state: 'running',
          remainingSeconds: 35 * 60,
          steps: [
            { label: '列出文件', state: 'done', done: 6414, total: null },
            { label: '按大小预筛相同文件', state: 'done', done: 120, total: 120 },
            { label: '粗筛：每个文件算指纹（视频抽 6 帧）', state: 'done', done: 6414, total: 6414 },
            {
              label: '相似视频补齐抽样（24 帧）',
              state: 'running',
              done: 565,
              total: 1133,
              estimateState: 'stable',
            },
            { label: '逐对精核相似候选', state: 'pending', done: 0, total: null },
          ],
        },
      ],
    }),
  );
  assert.match(html, /第 4\/5 步：相似视频补齐抽样/);
  assert.match(html, /565 \/ 1,133/);
  assert.match(html, /width:50%/, 'the bar follows the current step, not the finished coarse pass');
  assert.match(html, /这一步预计还要约 35 分钟/);
  assert.match(html, /class="background-task-steps"/);
  assert.equal((html.match(/<li class="done">/g) ?? []).length, 3);
  assert.match(html, /<li class="running">/);
  assert.match(html, /<li class="pending">/);
});

test('a completed soft file note offers Continue without becoming pending or failed', () => {
  const task = workflow({ fileChangeNotice: true });
  assert.equal(canContinueWorkflow(task), true);
  assert.equal(isPendingWorkflow(task), false);
  assert.equal(workflowDisplayStatus(task, []).label, '已完成');
  const html = renderToStaticMarkup(
    createElement(QueueItem, { ...actions, state: appState([task]), workflow: task, now: Date.parse(stamp) }),
  );
  assert.match(html, /继续/);
  assert.doesNotMatch(html, /已停止|本轮执行失败/);
  const trace = renderToStaticMarkup(
    createElement(WorkflowTrace, { ...actions, state: appState([task]), workflow: task }),
  );
  assert.match(trace, /<\/details><div class="workflow-outcome" role="status">/);
  assert.match(trace, /没有检测到文件改动/);
  assert.doesNotMatch(trace, /本轮执行失败/);
  assert.equal(canContinueWorkflow({ ...task, deletedAt: stamp }), false);
});
