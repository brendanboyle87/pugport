import { localTaskJudgment } from '../src/server/task-judgment.ts';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AppState, ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import type { ConversationTraceProps } from '../src/ui/ConversationTrace.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const stamp = '2026-10-08T12:00:00.000Z';
function workflow(id: string, patch: Partial<Workflow> = {}): Workflow {
  return {
    id,
    conversationId: 'chat',
    projectId: 'project',
    userMessageId: `${id}-message`,
    input: { content: `Original ${id}`, mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    status: 'completed',
    phase: 'summarize',
    plan: [],
    runIds: [`${id}-run`],
    memoryRevision: 2,
    memoryExcerpt: '',
    createdAt: stamp,
    startedAt: stamp,
    updatedAt: '2026-10-08T12:01:00.000Z',
    ...patch,
  };
}
function run(id: string, workflowId: string, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    workflowId,
    prompt: 'Actual sent prompt',
    projectPath: 'C:/fixture',
    kind: 'routine',
    status: 'completed',
    route: { runtimeId: 'codex', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt: stamp,
    endedAt: '2026-10-08T12:01:00.000Z',
    output: 'Finished output',
    events: [],
    ...patch,
  };
}
function props(
  tasks = [workflow('one')],
  runs = tasks.flatMap((task) => task.runIds.map((id) => run(id, task.id))),
): ConversationTraceProps {
  return {
    conversation: { id: 'chat', title: 'Synthetic chat' },
    workflows: tasks,
    messages: [],
    state: { runs, targets: [], runtimes: [] } as unknown as AppState,
    api: async <T>(path: string) =>
      ({
        workflow: tasks.find((task) => path.includes(`/${task.id}/`))!,
        runs: runs.filter((item) => path.includes(`/${item.workflowId}/`)),
        relatedRuns: [],
      }) as T,
    notify() {},
    onClose() {},
    onInspect() {},
  };
}
const tab = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.props.role === 'tab' && text(node) === label)!;
const panel = (tree: unknown, id: string) =>
  findNode(tree, (node) => node.props.role === 'tabpanel' && String(node.props.id).endsWith(`-${id}-panel`))!;
function nodes(tree: unknown, check: (node: UiNode) => boolean): UiNode[] {
  const result: UiNode[] = [];
  findNode(tree, (node) => {
    if (check(node)) result.push(node);
    return false;
  });
  return result;
}
let code: string;
before(async () => {
  code = await uiBundle('src/ui/ConversationTrace.tsx');
});

test('the Context tab mounts on demand and receives the judgment, plan and memory it explains', async () => {
  const task = workflow('judged', {
    taskJudgment: localTaskJudgment('Explain caching', 'disabled'),
    handlingSource: 'laya',
  });
  task.input.routeDecision = { handling: 'reply', writes: false, plan: false, web: true };
  const fixture = props([task]);
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'TraceContext'),
    undefined,
    'Context data is not requested before its tab opens',
  );
  tab(tree, '上下文').props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  const context = findNode(tree, (node) => node.type?.name === 'TraceContext')!;
  assert.equal(context.props.workflow.handlingSource, 'laya');
  assert.equal(context.props.workflow.taskJudgment.reason, 'disabled');
  assert.equal(context.props.workflow.input.routeDecision.handling, 'reply');
  assert.equal(context.props.selectedRunId, 'judged-run');
  ui.unmount();
});

test('records keep creation order and one nesting level, with original text, status and live duration', () => {
  const parent = workflow('parent'),
    child = workflow('child', { parentWorkflowId: parent.id, createdAt: '2026-10-08T12:02:00Z' });
  const deep = workflow('deep', {
    delegation: { parentId: child.id, role: 'worker', requestId: 'fixture' },
    createdAt: '2026-10-08T12:03:00Z',
  });
  const later = workflow('later', { createdAt: '2026-10-08T12:04:00Z', status: 'running' });
  const fixture = props([later, deep, parent, child]);
  fixture.messages = [
    {
      id: parent.userMessageId,
      conversationId: 'chat',
      role: 'user',
      content: 'Keep this original text',
      createdAt: stamp,
    } as ConversationMessage,
  ];
  const ui = uiHarness(code),
    tree = ui.render('ConversationTrace', fixture);
  const rows = nodes(tree, (node) => node.props.role === 'option');
  assert.deepEqual(
    rows.map((row) => row.props['data-workflow-id']),
    ['parent', 'child', 'deep', 'later'],
  );
  assert.deepEqual(
    rows.map((row) => row.props['data-depth']),
    [0, 1, 1, 0],
  );
  assert.match(text(rows[0]), /Keep this original text/);
  assert.match(text(rows[3]), /正在执行/);
  assert.equal(findNode(rows[0], (node) => node.type?.name === 'WorkflowElapsed')?.props.workflow.id, 'parent');
  assert.equal(
    findNode(rows[0], (node) => node.props.className === 'conversation-trace-record-text')?.props.translate,
    'no',
  );
  ui.unmount();
});

test('selecting a record requests it once; switching attempts and streaming reuse its snapshot', async () => {
  const task = workflow('one', { runIds: ['attempt-1', 'attempt-2'] });
  const runs = [run('attempt-1', task.id), run('attempt-2', task.id, { status: 'running', endedAt: undefined })];
  const fixture = props([task], runs),
    requests: string[] = [];
  const api = fixture.api;
  fixture.api = async <T>(path: string) => {
    requests.push(path);
    return api<T>(path);
  };
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  assert.equal(requests.length, 1);
  findNode(
    tree,
    (node) => node.props.className === 'conversation-trace-run' && text(node).includes('尝试 1'),
  )!.props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(requests.length, 1);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')?.props.run.id, 'attempt-1');
  findNode(
    tree,
    (node) => node.props.className === 'conversation-trace-run' && text(node).includes('尝试 2'),
  )!.props.onClick();
  fixture.state = {
    ...fixture.state,
    runs: [
      runs[0]!,
      {
        ...runs[1]!,
        reasoning: 'Live thinking',
        output: 'Live text',
        events: [{ at: stamp, type: 'text', text: 'Live text', seq: 1 }],
      },
    ],
  };
  tree = ui.render('ConversationTrace', fixture);
  const calls = findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!;
  assert.equal(calls.props.hideContextRows, true);
  assert.equal(calls.props.run.reasoning, 'Live thinking');
  assert.equal(calls.props.run.events.length, 1);
  assert.equal(requests.length, 1);
  fixture.state = {
    ...fixture.state,
    runs: [runs[0]!, { ...fixture.state.runs[1]!, status: 'completed', endedAt: '2026-10-08T12:03:00Z' }],
  };
  ui.render('ConversationTrace', fixture);
  assert.equal(requests.length, 2);
  ui.unmount();
});

test('records without runs send no request and retain overview and original message', () => {
  const fixture = props([workflow('queued', { runIds: [], status: 'queued' })]);
  let requests = 0;
  fixture.api = async <T>() => {
    requests++;
    return {} as T;
  };
  const ui = uiHarness(code);
  let tree = ui.render('ConversationTrace', fixture);
  assert.equal(requests, 0);
  assert.deepEqual(nodes(tree, (node) => node.props.role === 'tab').map(text), ['概览', '上下文', '过程', '结果']);
  assert.match(text(tree), /Original queued/);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'TrajectoryPanel'),
    undefined,
  );
  tab(tree, '上下文').props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  assert.match(text(tree), /还没有发送任何内容/);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'TraceContext'),
    undefined,
  );
  assert.equal(requests, 0);
  ui.unmount();
});

test('four sub-pages render as tabs; only the selected panel is visible and arrows move between tabs', async () => {
  const fixture = props();
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  const tabs = nodes(tree, (node) => node.props.role === 'tab');
  assert.deepEqual(tabs.map(text), ['概览', '上下文', '过程', '结果']);
  assert.deepEqual(
    tabs.map((node) => node.props['aria-selected']),
    [true, false, false, false],
  );
  const panels = () => nodes(tree, (node) => node.props.role === 'tabpanel');
  assert.deepEqual(
    panels().map((node) => node.props.hidden),
    [false, true, true, true],
  );
  assert.ok(
    findNode(tree, (node) => node.type?.name === 'TrajectoryPanel'),
    'Calls keep their live record mounted',
  );
  const list = findNode(tree, (node) => node.props.role === 'tablist')!;
  list.props.onKeyDown({
    key: 'ArrowLeft',
    preventDefault() {},
    currentTarget: { querySelectorAll: () => [] },
  });
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(tab(tree, '结果').props['aria-selected'], true);
  assert.deepEqual(
    panels().map((node) => node.props.hidden),
    [true, true, true, false],
  );
  assert.match(text(findNode(tree, (node) => node.props.className === 'conversation-trace-result')), /Finished output/);
  ui.unmount();
  const opened = uiHarness(code);
  tree = opened.render('ConversationTrace', { ...fixture, initialTab: 'context' });
  assert.ok(
    findNode(tree, (node) => node.type?.name === 'TraceContext'),
    'Usage › Spend can open Context first',
  );
  opened.unmount();
});

test('opening Calls from Context selects the attempt and filters to tools once per request', async () => {
  const task = workflow('one', { runIds: ['first', 'second'] });
  const fixture = props([task], [run('first', task.id), run('second', task.id)]);
  const ui = uiHarness(code);
  ui.render('ConversationTrace', { ...fixture, initialTab: 'context' });
  await nextTurn();
  let tree = ui.render('ConversationTrace', { ...fixture, initialTab: 'context' });
  findNode(tree, (node) => node.type?.name === 'TraceContext')!.props.onOpenCalls('first');
  tree = ui.render('ConversationTrace', { ...fixture, initialTab: 'context' });
  assert.equal(tab(tree, '过程').props['aria-selected'], true);
  const calls = findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!;
  assert.equal(calls.props.run.id, 'first');
  assert.equal(JSON.stringify(calls.props.filterRequest), JSON.stringify({ filter: 'tools', id: 1 }));
  tab(tree, '上下文').props.onClick();
  tree = ui.render('ConversationTrace', { ...fixture, initialTab: 'context' });
  findNode(tree, (node) => node.type?.name === 'TraceContext')!.props.onSelectAttempt('second');
  findNode(tree, (node) => node.type?.name === 'TraceContext')!.props.onOpenCalls('second');
  tree = ui.render('ConversationTrace', { ...fixture, initialTab: 'context' });
  assert.equal(
    JSON.stringify(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.filterRequest),
    JSON.stringify({ filter: 'tools', id: 2 }),
  );
  ui.unmount();
});

test('complete short results need no full-output button; truncated results retain it', () => {
  for (const length of [500, 501]) {
    const fixture = props();
    const output = `${'Safe fixture output. '.repeat(30).slice(0, length - 1)}!`;
    fixture.state.runs[0]!.output = output;
    const ui = uiHarness(code);
    let tree = ui.render('ConversationTrace', fixture);
    const result = findNode(tree, (node) => node.props.className === 'conversation-trace-result')!;
    const action = findNode(result, (node) => node.type === 'button');
    assert.equal(Boolean(action), length > 500);
    if (action) {
      action.props.onClick();
      tree = ui.render('ConversationTrace', fixture);
      assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')?.props.text, output);
    }
    ui.unmount();
  }
});

test('step run chips use selector attempt and executor labels and select the matching run', () => {
  const task = workflow('one', {
    runIds: ['run-old', 'run-done'],
    plan: [
      {
        id: 'step',
        title: 'Inspect',
        instruction: 'Inspect the fixture',
        kind: 'routine',
        transport: 'auto',
        dependsOn: [],
        status: 'completed',
        runIds: ['run-old', 'run-done', 'unavailable-run'],
      },
    ],
  });
  const fixture = props([task], [run('run-old', task.id), run('run-done', task.id)]);
  const ui = uiHarness(code);
  let tree = ui.render('ConversationTrace', fixture);
  const chips = findNode(tree, (node) => node.props.className === 'conversation-trace-run-chips')!;
  const buttons = nodes(chips, (node) => node.type === 'button');
  assert.deepEqual(buttons.map(text), ['尝试 1 · codex', '尝试 2 · codex']);
  assert.doesNotMatch(text(chips), /run-old|run-done|unavailable-run/);
  assert.equal(text(findNode(buttons[0], (node) => node.props.translate === 'no')), ' · codex');
  buttons[0]!.props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')?.props.run.id, 'run-old');
  assert.equal(
    findNode(tree, (node) => node.props.className === 'conversation-trace-run' && node.props['aria-pressed'])?.key,
    'run-old',
  );
  ui.unmount();
});

test('result follows the selected attempt and the plan marks planning calls', async () => {
  const task = workflow('one', {
    runIds: ['old', 'new'],
    plan: [
      {
        id: 'step',
        title: 'Step',
        instruction: 'Test',
        kind: 'routine',
        transport: 'auto',
        dependsOn: [],
        status: 'completed',
        runIds: ['new'],
      },
    ],
  });
  const runs = [
    run('old', task.id, { output: 'Earlier failed output', status: 'failed' }),
    run('new', task.id, { output: 'Latest output', stepId: 'step' }),
  ];
  const fixture = props([task], runs);
  fixture.api = async <T>() => ({ workflow: task, runs, relatedRuns: [], finalOutput: 'Task final reply' }) as T;
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  assert.match(text(tree), /规划调用/);
  findNode(
    tree,
    (node) => node.props.className === 'conversation-trace-run' && text(node).includes('尝试 1'),
  )!.props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  assert.match(
    text(findNode(tree, (node) => node.props.className === 'conversation-trace-result')),
    /Earlier failed output/,
  );
  assert.doesNotMatch(
    text(findNode(tree, (node) => node.props.className === 'conversation-trace-result')),
    /Task final reply/,
  );
  ui.unmount();
});

test('failed reads show retry; removed records read the newest 20 retained runs directly', async () => {
  const fixture = props();
  let count = 0;
  fixture.api = async <T>() => {
    count++;
    if (count === 1) throw new Error('Synthetic read failure');
    return { workflow: fixture.workflows[0], runs: fixture.state.runs, relatedRuns: [] } as T;
  };
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  assert.match(text(tree), /记录加载失败/);
  findNode(tree, (node) => node.type === 'button' && text(node) === '重试')!.props.onClick();
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(count, 2);
  assert.doesNotMatch(text(tree), /Synthetic read failure/);
  ui.unmount();
  const removed = workflow('removed', {
    deletedAt: stamp,
    runIds: Array.from({ length: 25 }, (_, index) => `run-${index}`),
  });
  const deletedFixture = props([removed]),
    paths: string[] = [];
  deletedFixture.api = async <T>(path: string) => {
    paths.push(path);
    return run(path.split('/').at(-1)!, removed.id) as T;
  };
  const deletedUi = uiHarness(code);
  deletedUi.render('ConversationTrace', deletedFixture);
  await nextTurn();
  tree = deletedUi.render('ConversationTrace', deletedFixture);
  assert.equal(paths.length, 20);
  assert.equal(paths[0], '/api/runs/run-5');
  assert.ok(paths.every((path) => path.startsWith('/api/runs/')));
  assert.match(text(tree), /这条任务已移除；消息保留/);
  deletedUi.unmount();
});

test('list Home/End and arrows select; Escape closes only outside an open detail dialog', async () => {
  const fixture = props([workflow('first'), workflow('last', { createdAt: '2026-10-08T13:00:00Z' })]);
  const output = 'A longer safe output paragraph. '.repeat(20).trimEnd();
  for (const run of fixture.state.runs) run.output = output;
  let closed = 0;
  fixture.onClose = () => closed++;
  const ui = uiHarness(code);
  let tree = ui.render('ConversationTrace', fixture);
  const key = (name: string) => ({
    key: name,
    preventDefault() {},
    stopPropagation() {},
    currentTarget: { querySelectorAll: () => [] },
  });
  findNode(tree, (node) => node.props.role === 'listbox')!.props.onKeyDown(key('Home'));
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.props['aria-selected'] === true)?.props['data-workflow-id'], 'first');
  findNode(tree, (node) => node.props.role === 'listbox')!.props.onKeyDown(key('ArrowDown'));
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.props['aria-selected'] === true)?.props['data-workflow-id'], 'last');
  findNode(tree, (node) => node.props.role === 'listbox')!.props.onKeyDown(key('End'));
  tree = ui.render('ConversationTrace', fixture);
  const result = findNode(tree, (node) => node.props.className === 'conversation-trace-result')!;
  findNode(result, (node) => node.type === 'button' && text(node) === '查看完整输出')!.props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')?.props.text, output);
  tree.props.onKeyDown(key('Escape'));
  assert.equal(closed, 0);
  findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!.props.onClose();
  tree = ui.render('ConversationTrace', fixture);
  tree.props.onKeyDown(key('Escape'));
  assert.equal(closed, 1);
  ui.unmount();
});

test('empty chats have an honest empty state', () => {
  const fixture = props([]),
    ui = uiHarness(code);
  assert.match(text(ui.render('ConversationTrace', fixture)), /这条对话还没有任务/);
  ui.unmount();
});

test('a card can select its workflow without runs or its exact attempt instead of the latest record', () => {
  const empty = workflow('waiting', { status: 'queued', runIds: [] });
  const earlier = workflow('earlier', { runIds: ['first-attempt', 'last-attempt'] });
  const fixture = props([empty, earlier, workflow('latest')]);
  fixture.initialWorkflowId = empty.id;
  let ui = uiHarness(code);
  let tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.props['aria-selected'] === true)?.props['data-workflow-id'], empty.id);
  ui.unmount();
  fixture.initialWorkflowId = earlier.id;
  fixture.initialRunId = 'first-attempt';
  ui = uiHarness(code);
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.props['aria-selected'] === true)?.props['data-workflow-id'], earlier.id);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')?.props.run.id, 'first-attempt');
  ui.unmount();
});

test('Trace retains every technical field removed from the card, including model, account and handoff', () => {
  const task = workflow('one', {
    input: { content: 'Synthetic request', mode: 'build', permissionMode: 'read-only', executionPolicy: 'api-only' },
    memoryRevision: 17,
    planning: { strategy: 'model', reason: 'Synthetic planning reason' },
    memoryRetrieval: { status: 'found', excerpts: 3, verifiedPaths: ['C:/fixture/evidence'], elapsedMs: 42 },
    plan: [
      {
        id: 'step',
        title: 'Synthetic step',
        instruction: 'Check',
        kind: 'routine',
        transport: 'auto',
        dependsOn: [],
        status: 'completed',
        runIds: [],
      },
    ],
  });
  const attempt = run('one-run', task.id, {
    route: {
      runtimeId: 'fixture-api',
      model: 'deepseek/deepseek-chat',
      effort: 'high',
      kind: 'routine',
      reasons: ['Synthetic routing reason'],
      warnings: ['Synthetic routing warning'],
    },
    account: { id: 'synthetic', label: 'Synthetic account', provider: 'pi' },
    relay: { fromRunId: 'earlier', fromRuntimeId: 'codex', reason: 'quota' },
    toolless: true,
    prompt: '<<<PUGPORT_HANDOFF_NOTE>>>\nSynthetic handoff note\n<<<END_PUGPORT_HANDOFF_NOTE>>>',
  });
  const fixture = props([task], [attempt]);
  fixture.state.targets = [{ id: 'fixture-api', label: 'Synthetic executor' }] as AppState['targets'];
  const ui = uiHarness(code);
  let tree = ui.render('ConversationTrace', fixture);
  const overview = panel(tree, 'overview');
  for (const value of [
    '仅 API',
    '17',
    'deepseek/deepseek-chat',
    'high',
    'Synthetic executor',
    'Synthetic account',
    'quota',
    '规划调用',
  ])
    assert.ok(text(overview).includes(value), `Overview must retain ${value}`);
  tab(tree, '上下文').props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  const context = panel(tree, 'context');
  const trace = findNode(context, (node) => node.type?.name === 'TraceContext')!;
  // Planning, memory search and routing are explained by the Context tab's "Why this context" block.
  assert.equal(trace.props.workflow.planning.reason, 'Synthetic planning reason');
  assert.deepEqual(trace.props.workflow.memoryRetrieval.verifiedPaths, ['C:/fixture/evidence']);
  assert.equal(trace.props.runs[0].route.reasons[0], 'Synthetic routing reason');
  assert.match(text(context), /纯聊天（不读文件）/);
  assert.match(text(context), /执行器没有任何文件、搜索、命令、网页或扩展工具/);
  ui.unmount();
});

test('only the selected task completing refreshes its record and the loaded content stays visible', async () => {
  const parent = workflow('parent', { status: 'running' });
  const child = workflow('child', { parentWorkflowId: parent.id, status: 'running' });
  const active = run('parent-run', parent.id, {
    status: 'running',
    endedAt: undefined,
    summary: true,
    prompt: 'SUMMARY_PROMPT',
    events: [],
  });
  const childRun = run('child-run', child.id, { status: 'running', endedAt: undefined });
  const fixture = props([parent, child], [active, childRun]);
  fixture.initialRunId = active.id;
  let requests = 0;
  let finishRefresh: ((value: unknown) => void) | undefined;
  fixture.api = async <T>() => {
    requests++;
    if (requests > 1)
      return new Promise<T>((resolve) => {
        finishRefresh = (value) => resolve(value as T);
      });
    return {
      workflow: parent,
      relatedRuns: [],
      finalOutput: 'ARCHIVED_RESULT',
      runs: [
        {
          ...active,
          summary: false,
          prompt: 'ARCHIVED_PROMPT',
          events: [{ type: 'text', at: stamp, text: 'ARCHIVED_EVENT' }],
        },
      ],
    } as T;
  };
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  ui.render('ConversationTrace', fixture);
  fixture.state = { ...fixture.state, runs: [active, { ...childRun, status: 'completed', endedAt: stamp }] };
  ui.render('ConversationTrace', fixture);
  assert.equal(requests, 1, 'A child completing must not reload its parent');
  fixture.workflows = [{ ...parent, runIds: [...parent.runIds, 'parent-next'] }, child];
  fixture.state = {
    ...fixture.state,
    runs: [...fixture.state.runs, run('parent-next', parent.id, { status: 'running', endedAt: undefined })],
  };
  ui.render('ConversationTrace', fixture);
  assert.equal(requests, 1, 'Starting another attempt is merged live without a record reload');
  fixture.state = {
    ...fixture.state,
    runs: fixture.state.runs.map((item) =>
      item.id === 'parent-next' ? { ...item, status: 'completed', endedAt: stamp } : item,
    ),
  };
  let tree = ui.render('ConversationTrace', fixture);
  assert.equal(requests, 2);
  assert.match(text(tree), /正在加载记录/);
  const calls = findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!;
  assert.equal(calls.props.run.events[0].text, 'ARCHIVED_EVENT');
  assert.equal(calls.props.run.summary, false);
  finishRefresh!({
    workflow: fixture.workflows[0],
    runs: fixture.state.runs.filter((item) => item.workflowId === parent.id),
    relatedRuns: [],
  });
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  assert.doesNotMatch(text(tree), /正在加载记录/);
  ui.unmount();
});

test('sent follow-ups add the language note once in Context and stay out of subtasks', async () => {
  const fixture = props();
  const steering = (id: string, phase: string, text?: string) => ({
    type: 'status' as const,
    at: stamp,
    data: {
      source: 'pugport',
      kind: 'communication',
      steeringId: id,
      steeringPhase: phase,
      detail: { messageId: id, text },
    },
  });
  fixture.state.runs[0]!.events = [
    steering('one', 'sending', '主对话最新本地上下文：\nMAIN_CONTEXT\n用户当前侧聊补充：\nCheck tests'),
    steering('one', 'received'),
    steering('two', 'sending', 'Retry request password=fixture-secret'),
    steering('two', 'failed'),
  ];
  fixture.messages = [
    {
      id: 'unsent',
      conversationId: 'chat',
      role: 'user',
      content: 'UNSENT_USER_FALLBACK',
      createdAt: stamp,
      steering: { runId: 'one-run', status: 'pending' },
    } as ConversationMessage,
  ];
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  assert.doesNotMatch(text(tree), /UNSENT_USER_FALLBACK|fixture-secret/);
  assert.equal(text(panel(tree, 'context')).split('PugPort 还会附加回复语言要求。').length - 1, 1);
  const subtasks = findNode(tree, (node) => node.props.className === 'conversation-trace-subtasks')!;
  assert.match(text(subtasks), /没有子任务/);
  assert.doesNotMatch(text(subtasks), /MAIN_CONTEXT/);
  fixture.state = {
    ...fixture.state,
    runs: [
      {
        ...fixture.state.runs[0]!,
        events: [
          ...fixture.state.runs[0]!.events,
          {
            type: 'status',
            at: stamp,
            data: { source: 'pugport', kind: 'routing', detail: { toWorkflowId: 'child', note: 'Actual assignment' } },
          },
          {
            type: 'status',
            at: stamp,
            data: {
              source: 'pugport',
              kind: 'communication',
              steeringPhase: 'sending',
              detail: { source: 'agent', text: 'Internal bridge password=bridge-secret' },
            },
          },
        ],
      },
    ],
  };
  tree = ui.render('ConversationTrace', fixture);
  assert.match(text(tree), /Actual assignment/);
  assert.match(text(tree), /Internal bridge/);
  assert.doesNotMatch(text(tree), /bridge-secret/);
  const size = findNode(tree, (node) => node.props.className === 'conversation-trace-size')!;
  assert.match(text(size), /\d+ 字/);
  ui.unmount();
});

test('archive details preserve full plan instructions and make older children and their messages selectable', async () => {
  const archived = workflow('parent', {
    plan: [
      {
        id: 'step',
        title: 'Inspect',
        kind: 'routine',
        transport: 'auto',
        instruction: 'FULL_ARCHIVED_INSTRUCTION',
        dependsOn: [],
        status: 'running',
        runIds: ['parent-run'],
      },
    ],
  });
  const summary = {
    ...archived,
    plan: archived.plan.map((step) => ({ ...step, instruction: '', status: 'completed' as const })),
  };
  const child = workflow('child', { parentWorkflowId: 'parent', createdAt: '2026-10-08T12:00:01Z' });
  const fixture = props([summary]);
  fixture.api = async <T>(path: string) =>
    ({
      workflow: path.includes('/child/') ? child : archived,
      runs: [run(path.includes('/child/') ? 'child-run' : 'parent-run', path.includes('/child/') ? 'child' : 'parent')],
      relatedRuns: [],
      relatedWorkflows: [child],
      messages: [
        {
          id: child.userMessageId,
          conversationId: 'chat',
          role: 'user',
          content: 'Archived child original',
          createdAt: stamp,
        },
      ],
    }) as T;
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  const step = findNode(tree, (node) => node.key === 'step' && node.props.className === 'conversation-trace-payload')!;
  assert.equal(
    findNode(step, (node) => node.type === 'button'),
    undefined,
  );
  const preview = findNode(step, (node) => node.type === 'pre')!;
  assert.match(text(preview), /FULL_ARCHIVED_INSTRUCTION/);
  assert.match(text(preview), /completed/);
  const childRow = findNode(tree, (node) => node.props['data-workflow-id'] === 'child')!;
  assert.match(text(childRow), /Archived child original/);
  assert.equal(childRow.props['data-depth'], 1);
  childRow.props.onClick();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.props['aria-selected'] === true)?.props['data-workflow-id'], 'child');
  ui.unmount();
});

test('a late record response cannot replace a newly selected task', async () => {
  const first = workflow('first'),
    last = workflow('last');
  const fixture = props([first, last]);
  fixture.initialRunId = 'first-run';
  const pending = new Map<string, (value: unknown) => void>();
  fixture.api = <T>(path: string) => new Promise<T>((resolve) => pending.set(path, (value) => resolve(value as T)));
  const ui = uiHarness(code);
  let tree = ui.render('ConversationTrace', fixture);
  findNode(tree, (node) => node.props['data-workflow-id'] === 'last')!.props.onClick();
  ui.render('ConversationTrace', fixture);
  pending.get('/api/workflows/first/execution-record')!({
    workflow: first,
    runs: [run('first-run', 'first', { output: 'STALE_OUTPUT' })],
    relatedRuns: [],
  });
  pending.get('/api/workflows/last/execution-record')!({
    workflow: last,
    runs: [run('last-run', 'last', { output: 'CURRENT_OUTPUT' })],
    relatedRuns: [],
  });
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')?.props.run.id, 'last-run');
  assert.doesNotMatch(text(tree), /STALE_OUTPUT/);
  ui.unmount();
});

test('explicit full-audit reads retain complete output and audit metadata; late reads cannot switch runs', async () => {
  const fixture = props(
    [workflow('one', { runIds: ['old', 'new'] })],
    [run('old', 'one'), run('new', 'one', { output: 'tail', summary: true, eventsDropped: 8, auditVersion: 1 })],
  );
  let resolveAudit: ((value: unknown) => void) | undefined;
  const api = fixture.api;
  fixture.api = <T>(path: string) =>
    path.startsWith('/api/runs/')
      ? new Promise<T>((resolve) => {
          resolveAudit = (value) => resolve(value as T);
        })
      : api<T>(path);
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.onLoadFullAudit();
  resolveAudit!(
    run('new', 'one', {
      output: 'FULL_AUDIT_OUTPUT',
      reasoning: 'Full reasoning',
      auditVersion: 1,
      auditEventsMissing: 0,
      eventsDropped: 8,
    }),
  );
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  const full = findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.run;
  assert.equal(full.output, 'FULL_AUDIT_OUTPUT');
  assert.equal(full.reasoning, 'Full reasoning');
  assert.equal(full.auditEventsMissing, 0);
  assert.equal(full.summary, false);
  findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.onLoadFullAudit();
  findNode(
    tree,
    (node) => node.props.className === 'conversation-trace-run' && text(node).includes('尝试 1'),
  )!.props.onClick();
  ui.render('ConversationTrace', fixture);
  resolveAudit!(run('new', 'one', { output: 'LATE_AUDIT_OUTPUT' }));
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.run.id, 'old');
  assert.doesNotMatch(text(tree), /LATE_AUDIT_OUTPUT/);
  ui.unmount();
});

test('an active audit never rolls back completion and recovered usage contributes to result totals', async () => {
  const task = workflow('one', { status: 'running' });
  const active = run('one-run', 'one', {
    status: 'running',
    endedAt: undefined,
    output: 'part',
    events: [],
    eventsDropped: 2,
    auditVersion: 1,
  });
  const fixture = props([task], [active]);
  const api = fixture.api;
  fixture.api = async <T>(path: string) =>
    path.startsWith('/api/runs/')
      ? ({
          ...active,
          auditEventsMissing: 0,
          events: [{ type: 'usage', at: stamp, seq: 1, data: { inputTokens: 100 } }],
        } as T)
      : api<T>(path);
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  let tree = ui.render('ConversationTrace', fixture);
  findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.onLoadFullAudit();
  await nextTurn();
  tree = ui.render('ConversationTrace', fixture);
  assert.match(text(findNode(tree, (node) => node.props.className === 'conversation-trace-usage')), /100/);
  fixture.state = {
    ...fixture.state,
    runs: [
      {
        ...active,
        status: 'completed',
        endedAt: '2026-10-08T12:02:00Z',
        output: 'The full completed output',
        reasoning: 'Final reasoning',
      },
    ],
  };
  tree = ui.render('ConversationTrace', fixture);
  const final = findNode(tree, (node) => node.type?.name === 'TrajectoryPanel')!.props.run;
  assert.equal(final.status, 'completed');
  assert.equal(final.endedAt, '2026-10-08T12:02:00Z');
  assert.equal(final.output, 'The full completed output');
  assert.equal(final.reasoning, 'Final reasoning');
  assert.match(text(findNode(tree, (node) => node.props.className === 'conversation-trace-usage')), /100/);
  ui.unmount();
});

const imageEvents = (path: string) => [
  {
    at: stamp,
    type: 'status' as const,
    data: {
      source: 'pugport',
      kind: 'image-request',
      detail: {
        model: 'gpt-image-2.5-flare',
        endpoint: 'images/generations',
        references: 0,
        edit: false,
        prompt: 'A pug',
      },
    },
  },
  {
    at: stamp,
    type: 'status' as const,
    data: {
      source: 'pugport',
      kind: 'image-attachments',
      detail: [
        { attachmentId: 'pug', executor: 'OpenAI临时', tool: 'api-images', imageModel: 'gpt-image-2.5-flare', path },
      ],
    },
  },
];
function imageFixture(withImages: boolean) {
  const path = 'C:/data/attachments/pug-1.png';
  const task = workflow('one');
  const item = run('one-run', 'one', {
    route: { runtimeId: 'api-temp', model: 'openai/gpt-6.1-sol', kind: 'routine', reasons: [], warnings: [] },
    output: '已生成图片。',
    ...(withImages
      ? {
          events: imageEvents(path),
          generatedImages: [
            {
              path: 'C:/staging/openai-1.png',
              mimeType: 'image/png' as const,
              executor: 'OpenAI临时',
              runtimeId: 'api-temp',
              tool: 'api-images' as const,
              imageModel: 'gpt-image-2.5-flare',
            },
          ],
        }
      : {}),
  });
  const fixture = props([task], [item]);
  const reply: ConversationMessage = {
    id: 'reply',
    conversationId: 'chat',
    role: 'assistant',
    content: '已生成图片。',
    workflowId: 'one',
    createdAt: stamp,
    ...(withImages
      ? {
          attachments: [{ id: 'pug', name: 'generated-pug.png', mimeType: 'image/png', size: 2048, kind: 'image' }],
          generatedImages: [
            {
              attachmentId: 'pug',
              executor: 'OpenAI临时',
              runtimeId: 'api-temp',
              tool: 'api-images',
              imageModel: 'gpt-image-2.5-flare',
              runId: 'one-run',
            },
          ],
        }
      : {}),
  } as ConversationMessage;
  fixture.messages = [reply];
  return { fixture, path };
}

test('Result shows the run’s images with the chat’s attachments, caption and a reveal action; absent otherwise', async () => {
  const revealed: unknown[] = [];
  const { fixture, path } = imageFixture(true);
  const api = fixture.api;
  fixture.api = (async (url: string, body?: unknown) => {
    if (url === '/api/reveal') {
      revealed.push(body);
      return {};
    }
    return api(url);
  }) as typeof fixture.api;
  const ui = uiHarness(code);
  ui.render('ConversationTrace', { ...fixture, initialTab: 'result' });
  await nextTurn();
  let tree = ui.render('ConversationTrace', { ...fixture, initialTab: 'result' });
  const result = panel(tree, 'result');
  const grid = findNode(result, (node) => node.type?.name === 'MessageAttachments');
  assert.ok(grid, 'the chat’s own attachment component renders the images');
  assert.equal(grid.props.conversationId, 'chat');
  assert.deepEqual(
    grid.props.attachments.map((item: { id: string }) => item.id),
    ['pug'],
  );
  const images = findNode(result, (node) => node.props.className === 'conversation-trace-images')!;
  const output = findNode(result, (node) => node.props.className === 'conversation-trace-result')!;
  const order = nodes(result, (node) => node === images || node === output);
  assert.deepEqual(order, [images, output], 'images come above the final reply');
  assert.match(text(images), /由 OpenAI临时 · gpt-image-2\.5-flare 生成/);
  const open = findNode(images, (node) => node.type === 'button' && /打开所在文件夹/.test(text(node)))!;
  open.props.onClick();
  await nextTurn();
  assert.equal(JSON.stringify(revealed), JSON.stringify([{ path }]), 'the saved attachment, not the staging file');
  ui.unmount();

  const plain = imageFixture(false).fixture;
  const other = uiHarness(code);
  other.render('ConversationTrace', { ...plain, initialTab: 'result' });
  await nextTurn();
  tree = other.render('ConversationTrace', { ...plain, initialTab: 'result' });
  assert.equal(
    findNode(tree, (node) => node.props.className === 'conversation-trace-images'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'MessageAttachments'),
    undefined,
  );
  other.unmount();
});

test('Overview states the image pipeline from the records and never credits the chat model', async () => {
  const { fixture, path } = imageFixture(true);
  const ui = uiHarness(code);
  ui.render('ConversationTrace', fixture);
  await nextTurn();
  const tree = ui.render('ConversationTrace', fixture);
  const overview = panel(tree, 'overview');
  const line = findNode(overview, (node) => node.props.className === 'conversation-trace-pipeline')!;
  assert.ok(line);
  assert.equal(
    text(line).replace(/\s+/g, ' '),
    'OpenAI临时→OpenAI Images API（gpt-image-2.5-flare · 生成）→保存到pug-1.png→放进回复',
  );
  assert.equal(findNode(line, (node) => node.props.className === 'conversation-trace-path')?.props.title, path);
  assert.equal(/gpt-6\.1-sol/.test(text(overview)), false, 'the routing chat model does not claim the work');
  ui.unmount();
  // An ordinary run has no pipeline line.
  const plain = uiHarness(code);
  plain.render('ConversationTrace', props());
  await nextTurn();
  assert.equal(
    findNode(
      plain.render('ConversationTrace', props()),
      (node) => node.props.className === 'conversation-trace-pipeline',
    ),
    undefined,
  );
  plain.unmount();
});
