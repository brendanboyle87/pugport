import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { executionSelectionLabel } from '../src/ui/executor-selection.ts';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

let code: string;
let traceCode: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
  traceCode = await uiBundle('src/ui/ConversationTrace.tsx');
});
const stamp = '2026-10-09T12:00:00Z';
const conversation = { id: 'chat', projectId: 'project', title: 'Fixture', createdAt: stamp, updatedAt: stamp };
const task = {
  id: 'task',
  conversationId: 'chat',
  projectId: 'project',
  userMessageId: 'message',
  input: {
    content: 'Fixture',
    runtimeId: 'old',
    mode: 'auto',
    permissionMode: 'read-only',
    executionPolicy: 'cli-first',
  },
  status: 'running',
  phase: 'execute',
  plan: [],
  runIds: ['run'],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
};
const state = {
  app: { version: 'test' },
  projects: [],
  conversations: [conversation],
  workflows: [task],
  runs: [],
  conversationMessages: [],
  approvals: [],
  plugins: [],
  targets: ['old', 'new'].map((id) => ({
    id,
    provider: 'grok',
    label: id === 'new' ? 'Grok' : 'Old',
    enabled: true,
    command: 'fixture',
    environment: 'native',
  })),
  runtimes: ['old', 'new'].map((id) => ({
    id,
    provider: 'grok',
    label: id === 'new' ? 'Grok' : 'Old',
    status: 'ready',
    models: [{ id: 'grok-4.7', label: 'Grok 4.7', efforts: ['high', 'max'] }],
  })),
  settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
};
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as UiNode).props?.children) : '';
}
function mount(api: any) {
  const session = new ComposerSession();
  session.changeDraft('conversation:chat', (draft) => ({
    ...draft,
    content: 'Unsent user draft',
    attachments: [{ id: 'attachment', file: { name: 'Fixture.txt', size: 12, type: 'text/plain' } } as any],
  }));
  const saved = new Map([
    ['comborunner.composer-selection.v2:chat', JSON.stringify({ runtimeId: 'old', model: 'grok-4.7', effort: 'high' })],
  ]);
  const harness = uiHarness(code, {
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  const props: any = {
    state: structuredClone(state),
    api,
    conversation,
    composerSession: session,
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  findNode(render(), (node) => node.props['aria-label'] === '调度选项')!.props.onClick();
  const fields = () => findNode(render(), (node) => node.type?.name === 'WorkspaceExecutionFields')!;
  const advanced = () =>
    findNode(
      findNode(render(), (node) => node.props['aria-label'] === '执行器与任务选项'),
      (node) => node.type === 'button' && text(node) === '高级',
    )!;
  const status = () =>
    text(findNode(render(), (node) => node.props.className === 'queue-note executor-selection-status'));
  return {
    harness,
    session,
    props,
    render,
    fields,
    advanced,
    status,
    close() {
      harness.unmount();
      session.dispose();
    },
  };
}

test('saved model and effort remain primary options before and after Advanced opens', () => {
  const view = mount(async () => ({ messages: [] }));
  assert.equal(view.advanced().props['aria-expanded'], false);
  assert.equal(
    findNode(view.render(), (node) => node.props.className === 'composer-advanced'),
    undefined,
  );
  assert.equal(view.fields().props.model, 'grok-4.7');
  assert.equal(findNode(view.render(), (node) => node.type?.name === 'EffortSlider')!.props.value, 'high');
  view.advanced().props.onClick();
  assert.equal(view.advanced().props['aria-expanded'], true);
  const advanced = findNode(view.render(), (node) => node.props.className === 'composer-advanced')!;
  assert.ok(findNode(advanced, (node) => node.props.ariaLabel === '任务理解方式'));
  assert.equal(
    findNode(advanced, (node) => node.type?.name === 'WorkspaceExecutionFields'),
    undefined,
  );
  assert.equal(
    findNode(advanced, (node) => node.type?.name === 'EffortSlider'),
    undefined,
  );
  const effort = findNode(view.render(), (node) => node.type?.name === 'EffortSlider')!;
  assert.equal(effort.props.value, 'high');
  view.close();
});

test('a pinned executor exposes automatic-model effort and executor/model changes reset it', () => {
  const view = mount(async () => ({ messages: [] }));
  const slider = () => findNode(view.render(), (node) => node.type?.name === 'EffortSlider');
  view.fields().props.onModel('');
  assert.equal(slider()!.props.value, '');
  assert.deepEqual([...slider()!.props.levels], ['high', 'max']);
  slider()!.props.onChange('max');
  assert.equal(slider()!.props.value, 'max');
  view.props.conversation = { ...conversation, id: 'other' };
  assert.equal(slider(), undefined);
  view.props.conversation = conversation;
  assert.equal(view.fields().props.model, '');
  assert.equal(slider()!.props.value, 'max', 'Automatic-model effort survives conversation restoration');
  view.fields().props.onModel('grok-4.7');
  assert.equal(slider()!.props.value, '');
  slider()!.props.onChange('high');
  view.fields().props.onSelection('new');
  assert.equal(slider()!.props.value, '');
  view.fields().props.onSelection('');
  assert.equal(slider(), undefined);
  view.close();
});

test('a selected model without adjustable effort hides the slider', () => {
  const view = mount(async () => ({ messages: [] }));
  view.props.state.runtimes[0].models[0].efforts = [];
  assert.equal(
    findNode(view.render(), (node) => node.type?.name === 'EffortSlider'),
    undefined,
  );
  view.fields().props.onModel('');
  assert.equal(
    findNode(view.render(), (node) => node.type?.name === 'EffortSlider'),
    undefined,
  );
  view.close();
});

test('automatic model uses proposal/default levels and only falls back to a union with a tooltip', () => {
  const view = mount(async () => ({ messages: [] }));
  const runtime = view.props.state.runtimes[0];
  runtime.defaultModel = 'grok-4.7';
  runtime.models.push({ id: 'grok-other', label: 'Other', efforts: ['off', 'low', 'medium'] });
  view.fields().props.onModel('');
  const slider = () => findNode(view.render(), (node) => node.type?.name === 'EffortSlider')!;
  assert.deepEqual([...slider().props.levels], ['high', 'max']);
  const workflow = view.props.state.workflows[0];
  workflow.status = 'waiting-confirmation';
  workflow.input.content = 'Unsent user draft';
  workflow.routingReview = {
    original: { runtimeId: 'old' },
    proposal: { runtimeId: 'old', model: 'grok-other' },
  };
  assert.deepEqual([...slider().props.levels], ['off', 'low', 'medium']);
  workflow.input.content = 'A different task';
  assert.deepEqual([...slider().props.levels], ['high', 'max']);
  runtime.defaultModel = undefined;
  assert.deepEqual([...slider().props.levels], ['off', 'low', 'medium', 'high', 'max']);
  assert.match(slider().props.title, /最近强度/);
  view.close();
});

test('fixed-to-auto only changes this composer and preserves the running task and draft', async () => {
  const calls: string[] = [];
  const view = mount(async (path: string) => {
    if (path.endsWith('/executor-selection')) calls.push(path);
    return { messages: [] };
  });
  const original = structuredClone(view.props.state.workflows[0]);
  view.fields().props.onSelection('');
  await nextTurn();
  assert.deepEqual(calls, []);
  assert.equal(view.fields().props.selection, '');
  assert.deepEqual(view.props.state.workflows[0], original);
  assert.equal(view.session.getSnapshot().drafts['conversation:chat']?.content, 'Unsent user draft');
  assert.equal(view.session.getSnapshot().drafts['conversation:chat']?.attachments.length, 1);
  assert.equal(view.status(), '');
  view.close();
});

test('fixed executor changes are immediately local and never switch the live task', async () => {
  let calls = 0;
  const view = mount(async (path: string) => {
    if (path.endsWith('/executor-selection')) calls++;
    return { messages: [] };
  });
  view.fields().props.onSelection('new');
  assert.equal(view.fields().props.selection, 'new');
  assert.equal(view.fields().props.disabled, undefined);
  view.fields().props.onSelection('old');
  assert.equal(view.fields().props.selection, 'old');
  assert.equal(view.props.state.workflows[0].input.runtimeId, 'old');
  assert.equal(view.props.state.workflows[0].selectionSwitch, undefined);
  assert.equal(calls, 0);
  view.close();
});

test('model and effort changes stay in the conversation without a task-migration request', async () => {
  const calls: string[] = [];
  const view = mount(async (path: string) => {
    if (path.endsWith('/executor-selection')) calls.push(path);
    return { messages: [] };
  });
  view.advanced().props.onClick();
  assert.equal(view.advanced().props['aria-expanded'], true);
  view.props.state.runtimes[0].models.push({ id: 'grok-other', label: 'Other', efforts: [] });
  view.fields().props.onModel('grok-other');
  assert.equal(view.fields().props.model, 'grok-other');
  view.fields().props.onModel('grok-4.7');
  findNode(view.render(), (node) => node.type?.name === 'EffortSlider')!.props.onChange('max');
  assert.equal(findNode(view.render(), (node) => node.type?.name === 'EffortSlider')!.props.value, 'max');
  assert.deepEqual(calls, []);
  assert.equal(view.props.state.workflows[0].input.model, undefined);
  view.close();
});

test('switching conversations restores each override and new composers reset to automatic', () => {
  const view = mount(async () => ({ messages: [] }));
  view.fields().props.onSelection('new');
  view.props.conversation = { ...conversation, id: 'other' };
  assert.equal(view.fields().props.selection, '');
  view.fields().props.onSelection('old');
  view.props.conversation = conversation;
  assert.equal(view.fields().props.selection, 'new');
  view.props.conversation = undefined;
  assert.equal(view.fields().props.selection, '');
  assert.equal(view.status(), '');
  view.close();
});

test('effective effort wins and unconfirmed effort is labeled as a request', () => {
  const route: any = { model: 'grok-4.7', effort: 'high' };
  assert.equal(executionSelectionLabel({ route }), 'grok-4.7 · 请求强度 high');
  assert.equal(
    executionSelectionLabel({ route, effectiveModel: { model: 'grok-4.7', effort: 'max', source: 'native' } }),
    'grok-4.7 · max',
  );
});

test('the running card links to confirmed model effort in the Trace overview', async () => {
  const harness = uiHarness(code);
  const run: any = {
    id: 'run',
    workflowId: 'task',
    status: 'running',
    route: { runtimeId: 'new', model: 'grok-4.7', effort: 'high', reasons: [], warnings: [] },
    effectiveModel: { model: 'grok-4.7', effort: 'max', source: 'native' },
    events: [],
    output: '',
    prompt: 'Synthetic task',
    projectPath: 'C:/Fixture',
    kind: 'general',
    startedAt: stamp,
  };
  const view = mount(async (path: string) =>
    path.endsWith('/execution-record') ? { workflow: task, runs: [run], relatedRuns: [] } : { messages: [] },
  );
  view.props.state.runs = [run];
  const traced: unknown[] = [];
  const tree = harness.render('WorkflowTrace', {
    state: view.props.state,
    workflow: task,
    api: async () => ({}),
    notify() {},
    onInspect() {},
    onTrace: () => traced.push(task.id),
  });
  assert.doesNotMatch(text(tree), /Grok · grok-4.7|请求强度 high/);
  const link = findNode(tree, (node) => node.type === 'button' && text(node) === '查看轨迹')!;
  assert.ok(link, 'the card keeps its record reachable in the Trace');
  link.props.onClick();
  assert.deepEqual(traced, [task.id]);
  // The overlay opened on this record shows the confirmed model and effort.
  const trace = {
    props: {
      conversation: { id: task.conversationId, title: 'Fixture' },
      workflows: [task],
      messages: [],
      state: view.props.state,
      api: view.props.api,
      notify() {},
      initialWorkflowId: task.id,
      initialRunId: run.id,
      onClose() {},
      onInspect() {},
    },
  };
  const traceHarness = uiHarness(traceCode);
  traceHarness.render('ConversationTrace', trace.props);
  await nextTurn();
  const traceTree = traceHarness.render('ConversationTrace', trace.props);
  const overview = findNode(traceTree, (node) => node.props.className === 'conversation-trace-overview')!;
  assert.match(text(overview), /Grok · grok-4.7 · max/);
  assert.doesNotMatch(text(overview), /请求强度 high/);
  traceHarness.unmount();
  harness.unmount();
  view.close();
});

test('record browsing uses persisted user text and sends only the final assistant message to output', async () => {
  const exactInput = `  Original exact user message\n${'Long user text preserved. '.repeat(8)}  `;
  const run = {
    id: 'run',
    workflowId: 'task',
    status: 'completed',
    prompt: 'Internal orchestration instructions',
    userInput: 'Persisted user request',
    projectPath: 'C:/Fixture',
    startedAt: stamp,
    route: { model: 'grok-4.7', effort: 'high' },
    events: [],
    output: 'Intermediate tool discussion',
  };
  const backend = {
    state: {
      ...state,
      runs: [run, { ...run, id: 'relay', startedAt: '2026-10-09T12:01:00Z' }],
      workflows: [{ ...task, status: 'completed', finalMessageId: 'final' }],
      conversationMessages: [
        {
          id: 'message',
          conversationId: 'chat',
          role: 'user',
          content: exactInput,
          createdAt: stamp,
        },
        { id: 'final', conversationId: 'chat', role: 'assistant', content: 'Final answer only', createdAt: stamp },
      ],
    },
    api: async () => ({}),
    reload: async () => {},
    connection: 'connected',
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), { __backend: backend });
  const render = () => harness.render('default');
  findNode(render(), (node) => node.type === 'button' && text(node) === '任务列表')!.props.onClick();
  findNode(render(), (node) => node.type === 'button' && text(node) === '执行记录')!.props.onClick();
  const record = findNode(render(), (node) => node.props.className === 'run-record-item ')!;
  assert.match(text(record), /Original exact user message/);
  assert.doesNotMatch(text(record), /Internal orchestration/);
  assert.equal(text(record.props.children[0]), exactInput, 'CSS clamps the preview while retaining the whole original');
  assert.equal(
    findNode(record, (node) => node.type === 'code'),
    undefined,
  );
  assert.ok(findNode(record, (node) => node.type?.name === 'StatusPill'));
  assert.ok(findNode(record, (node) => node.type === 'time'));
  const list = findNode(render(), (node) => node.props['aria-label'] === '执行记录列表')!;
  const [chat] = list.props.children[0];
  assert.equal(chat.props.children[1].length, 1, 'both run attempts belong to one user task row');
  record.props.onClick();
  const output = findNode(render(), (node) => node.type?.name === 'RunOutput')!;
  assert.equal(output.props.userInput, exactInput);
  assert.equal(output.props.initialTab, 'trajectory');
  assert.equal(output.props.finalOutput, 'Final answer only');
  assert.equal(output.props.workflowRuns.length, 2);
  findNode(render(), (node) => node.props['aria-label'] === '搜索执行记录')!.props.onChange({
    target: { value: 'Internal orchestration' },
  });
  assert.match(text(render()), /暂无匹配记录/);
  harness.unmount();
});

test('model selection clears a draft writer and labels the saved model before Advanced', () => {
  const view = mount(async () => ({ messages: [] }));
  view.session.changeDraft('conversation:chat', (draft) => ({
    ...draft,
    writer: { label: 'Synthetic writer', runtimeId: 'old', model: 'grok-4.7', effort: 'high' },
  }));
  view.props.state.runtimes[0].models.push({ id: 'grok-next', label: 'Grok Next', efforts: [] });
  view.fields().props.onModel('grok-next');
  assert.equal(view.fields().props.model, 'grok-next');
  assert.match(text(findNode(view.render(), (node) => node.props['aria-label'] === '调度选项')), /Old · Grok Next/);
  assert.equal(view.session.getSnapshot().drafts['conversation:chat'].writer, undefined);
  view.close();
});

test('model fallback waits for a ready nonempty catalog and preserves exact and Cursor variant pins', () => {
  for (const scenario of ['empty', 'refreshing', 'offline', 'exact', 'variant', 'media', 'missing', 'writer']) {
    const view = mount(async () => ({ messages: [] }));
    const runtime = view.props.state.runtimes[0];
    if (scenario === 'empty') runtime.models = [];
    if (scenario === 'refreshing') view.props.state.refreshing = true;
    if (scenario === 'offline') runtime.status = 'missing';
    if (scenario === 'variant') runtime.provider = 'cursor';
    if (scenario === 'media') runtime.mediaModels = [{ id: 'image-model', label: 'Image Model', modality: 'image' }];
    const pin =
      scenario === 'exact'
        ? 'grok-4.7'
        : scenario === 'variant'
          ? 'grok-4.7-high'
          : scenario === 'media'
            ? 'image-model'
            : 'removed-model';
    if (scenario === 'writer') {
      view.session.changeDraft('conversation:chat', (draft) => ({
        ...draft,
        writer: { label: 'Synthetic writer', runtimeId: 'new', model: pin, effort: 'high' },
      }));
    } else view.fields().props.onModel(pin);
    view.render();
    assert.equal(view.fields().props.model, scenario === 'missing' ? '' : pin, scenario);
    assert.equal(text(view.render()).includes('所选模型已不可用，已改为自动。'), scenario === 'missing', scenario);
    if (scenario === 'writer') {
      assert.equal(view.session.getSnapshot().drafts['conversation:chat'].writer?.model, pin);
      view.session.changeDraft('conversation:chat', ({ writer, ...draft }) => draft);
      assert.equal(view.fields().props.selection, 'old');
      assert.equal(view.fields().props.model, 'grok-4.7');
    }
    view.close();
  }
});

test('legacy cloud settings keep the manual executor pin without restoring the retired hint', () => {
  for (const setup of [
    undefined,
    { settings: { ...state.settings, taskJudgment: 'jev' } },
    {
      settings: { ...state.settings, taskJudgment: 'jev', memoryEvidence: 'jev' },
      jev: { configured: true, enabled: true, status: 'configured-unverified', note: '' },
    },
  ]) {
    const view = mount(async () => ({ messages: [] }));
    Object.assign(view.props.state, setup);
    assert.equal(view.advanced().props['aria-expanded'], false);
    assert.equal(
      findNode(view.render(), (node) => node.props.className === 'composer-option-hint'),
      undefined,
    );
    view.advanced().props.onClick();
    assert.equal(view.advanced().props['aria-expanded'], true);
    const advanced = findNode(view.render(), (node) => node.props.className === 'composer-advanced')!;
    const value = text(findNode(advanced, (node) => node.props.className === 'composer-option-hint'));
    assert.match(value, /^直接交给所选执行器；/);
    assert.match(value, /继续携带对话上下文并检查文件权限与额度/);
    assert.doesNotMatch(value, /Jev|Laya|远程分类/);
    assert.equal(view.fields().props.selection, 'old');
    assert.equal(view.fields().props.model, 'grok-4.7');
    assert.equal(findNode(view.render(), (node) => node.type?.name === 'EffortSlider')!.props.value, 'high');
    view.close();
  }
});
