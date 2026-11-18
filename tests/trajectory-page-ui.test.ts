import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const studioBundle = uiBundle('src/ui/Studio.tsx', true);
const at = (time: string) => `2026-10-19T${time}:00Z`;
const project = { id: 'project', name: 'Fixture', path: 'C:/Fixture', createdAt: at('08:00'), updatedAt: at('08:00') };
const chat = (id: string, title: string) => ({
  id,
  projectId: project.id,
  title,
  createdAt: at('08:00'),
  updatedAt: at('08:00'),
});
const task = (id: string, conversationId: string, runId: string, extra: Record<string, unknown> = {}) => ({
  id,
  conversationId,
  projectId: project.id,
  userMessageId: `${id}-message`,
  status: 'completed',
  phase: 'summarize',
  plan: [],
  runIds: [runId],
  createdAt: at('08:00'),
  updatedAt: at('08:00'),
  ...extra,
});
const run = (id: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  prompt: 'Internal instructions',
  projectPath: 'C:/Fixture',
  kind: 'routine',
  status: 'completed',
  route: { runtimeId: 'fixture', model: 'fixture-model', kind: 'routine', reasons: [], warnings: [] },
  startedAt: at(startedAt),
  output: '',
  events: [],
  ...extra,
});
const message = (taskId: string, conversationId: string, content: string) => ({
  id: `${taskId}-message`,
  conversationId,
  role: 'user',
  content,
  createdAt: at('08:00'),
});
const state = {
  app: { version: 'test' },
  projects: [project],
  conversations: [chat('launch', 'Spring launch'), chat('budget', 'Budget review')],
  workflows: [
    task('draft', 'launch', 'draft-run'),
    task('timeline', 'launch', 'timeline-run'),
    task('helper', 'launch', 'helper-run', { delegation: { parentId: 'timeline', role: 'worker', requestId: 'r' } }),
    task('costs', 'budget', 'costs-run'),
    task('old', 'archived-chat', 'old-run'),
    task('deleted', 'deleted-chat', 'deleted-run'),
  ],
  runs: [
    run('draft-run', '10:00', { workflowId: 'draft' }),
    run('timeline-run', '10:30', { workflowId: 'timeline' }),
    run('helper-run', '10:35', { workflowId: 'helper', parentRunId: 'timeline-run' }),
    run('costs-run', '11:00', { workflowId: 'costs' }),
    run('old-run', '09:00', { workflowId: 'old' }),
    run('deleted-run', '10:45', { workflowId: 'deleted' }),
    run('probe-run', '08:30', { userInput: 'Standalone check' }),
  ],
  conversationMessages: [
    message('draft', 'launch', 'Draft the launch plan'),
    message('timeline', 'launch', 'Add a timeline'),
    message('costs', 'budget', 'Check the costs'),
    message('old', 'archived-chat', 'Earlier request'),
    message('deleted', 'deleted-chat', 'Deleted chat request'),
  ],
  runtimes: [],
  targets: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: { maxQuotaAgeSeconds: 120, reservePercent: 10, refreshSeconds: 60 },
};

async function openStudio(
  fixture = structuredClone(state),
  api: (path: string) => Promise<unknown> = async () => ({ messages: [], workflows: [] }),
) {
  return uiHarness(await studioBundle, {
    __backend: {
      state: fixture,
      api,
      reload: async () => {},
      connection: 'connected',
    },
    localStorage: { getItem: (key: string) => (key === 'agent-studio-conversation' ? 'launch' : null), setItem() {} },
  });
}
const list = (tree: unknown) => findNode(tree, (node) => node.props['aria-label'] === '执行记录列表')!;
// Copy out of the sandbox realm so deepStrictEqual compares plain arrays.
const groups = (tree: unknown): UiNode[] => [...list(tree).props.children[0]];
const records = (group: UiNode): UiNode[] => [...group.props.children[1]];
const heading = (group: UiNode) => findNode(group, (node) => node.type === 'h2')!;
const latestTime = (group: UiNode) => findNode(group.props.children[0], (node) => node.type === 'time')!.props.children;
const button = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.type === 'button' && text(node) === label)!;

test('trajectory from a conversation scopes history to that chat and All runs preserves the selection', async () => {
  const harness = await openStudio();
  let tree = harness.render('default');
  const workspace = findNode(tree, (node) => node.type?.name === 'SplitView')!.props.children('launch', 0);
  // An older task's run chip inside the chat, not just the toolbar's latest-task entry.
  workspace.props.onInspect('draft-run');
  tree = harness.render('default');
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'SplitView'),
    undefined,
    'the chat view is replaced',
  );
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'SideSheet'),
    undefined,
  );
  const output = findNode(tree, (node) => node.type?.name === 'RunOutput')!;
  assert.equal(output.props.run.id, 'draft-run');
  assert.equal(output.props.initialTab, 'trajectory');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Spring launch'],
  );
  const launch = groups(tree).find((group) => text(heading(group)) === 'Spring launch')!;
  const selected = records(launch).filter((record) => record.props.className === 'run-record-item selected');
  assert.deepEqual(
    selected.map((record) => text(record.props.children[0])),
    ['Draft the launch plan'],
  );

  // The selected record scrolls into view whenever a jump lands on the page.
  const scrolled: unknown[] = [];
  selected[0]!.props.ref.current = { scrollIntoView: (options: unknown) => scrolled.push(options) };
  button(tree, '全部记录').props.onClick();
  tree = harness.render('default');
  assert.equal(groups(tree).length, 4);
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.run.id, 'draft-run');
  assert.equal(
    records(groups(tree)[2]!).find((record) => record.props.className.includes('selected'))?.props.children[0].props
      .children,
    'Draft the launch plan',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(scrolled)), [{ block: 'nearest' }]);
  assert.equal(button(tree, '返回对话'), undefined);
  findNode(tree, (node) => node.props.className === 'studio-brand')!.props.onClick();
  tree = harness.render('default');
  assert.equal(findNode(tree, (node) => node.type?.name === 'SplitView')!.props.ids[0], 'launch');
  findNode(tree, (node) => node.type?.name === 'SplitView')!
    .props.children('launch', 0)
    .props.onInspect('timeline-run');
  tree = harness.render('default');
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.run.id, 'timeline-run');
  assert.deepEqual(JSON.parse(JSON.stringify(scrolled)), [{ block: 'nearest' }, { block: 'nearest' }]);
  button(tree, '执行记录').props.onClick();
  tree = harness.render('default');
  assert.equal(groups(tree).length, 4, 'clicking the active history tab clears the chat scope');
  assert.equal(button(tree, '全部记录'), undefined);
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.run.id, 'timeline-run');
  findNode(tree, (node) => node.props.className === 'studio-brand')!.props.onClick();
  button(harness.render('default'), '任务列表').props.onClick();
  button(harness.render('default'), '执行记录').props.onClick();
  tree = harness.render('default');
  assert.equal(groups(tree).length, 4, 'leaving history clears the chat scope');
  assert.equal(button(tree, '全部记录'), undefined);
  harness.unmount();
});

test('run history lists sections and tasks newest first, merging archived and deleted chats in date order', async () => {
  const harness = await openStudio();
  button(harness.render('default'), '任务列表').props.onClick();
  button(harness.render('default'), '执行记录').props.onClick();
  let tree = harness.render('default');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Budget review', '已归档或已删除的对话', 'Spring launch', '其他执行记录'],
  );
  assert.deepEqual(groups(tree).map(latestTime), [at('11:00'), at('10:45'), at('10:30'), at('08:30')]);
  assert.deepEqual(
    records(groups(tree)[1]!).map((record) => text(record.props.children[0])),
    ['Deleted chat request', 'Earlier request'],
  );
  const launch = groups(tree)[2]!;
  assert.equal(latestTime(launch), at('10:30'), 'header shows latest time');
  // Chat titles are the user's own words; only the fallback labels are interface text.
  assert.equal(heading(launch).props.translate, 'no');
  assert.equal(heading(groups(tree)[3]!).props.translate, undefined);
  assert.deepEqual(
    records(launch).map((record) => text(record.props.children[0])),
    ['Add a timeline', 'Draft the launch plan'],
    'newest first; the delegated helper stays inside its parent task',
  );
  assert.deepEqual(
    records(groups(tree)[3]!).map((record) => text(record.props.children[0])),
    ['Standalone check'],
  );

  // Searching a chat's title keeps that whole section.
  findNode(tree, (node) => node.props['aria-label'] === '搜索执行记录')!.props.onChange({
    target: { value: 'spring' },
  });
  tree = harness.render('default');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Spring launch'],
  );
  assert.equal(records(groups(tree)[0]!).length, 2);
  // A search narrowing a chat to older tasks still dates the section by its latest task.
  findNode(tree, (node) => node.props['aria-label'] === '搜索执行记录')!.props.onChange({
    target: { value: 'draft the launch' },
  });
  tree = harness.render('default');
  assert.equal(records(groups(tree)[0]!).length, 1);
  assert.equal(latestTime(groups(tree)[0]!), at('10:30'));
  harness.unmount();
});

test('the second split pane scopes history to its own chat and related runs keep that scope', async () => {
  const fixture = structuredClone(state);
  fixture.runs.push(run('old-retry', '09:30', { workflowId: 'old' }));
  const harness = await openStudio(fixture);
  let tree = harness.render('default');
  findNode(tree, (node) => node.type?.name === 'SplitView')!
    .props.children('budget', 1)
    .props.onInspect('costs-run');
  tree = harness.render('default');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Budget review'],
  );
  findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.onInspectRun('old-run');
  tree = harness.render('default');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Budget review', '已归档或已删除的对话'],
  );
  assert.equal(records(groups(tree)[1]!)[0]!.props.className, 'run-record-item selected');
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.run.id, 'old-run');
  harness.unmount();
});

test('a selected run outside the loaded window appears in scoped history after inspection', async () => {
  const fixture = structuredClone(state);
  fixture.runs = fixture.runs.filter((record) => !['draft-run', 'timeline-run', 'helper-run'].includes(record.id));
  const calls: string[] = [];
  const harness = await openStudio(fixture, async (path) => {
    calls.push(path);
    assert.equal(path, '/api/runs/draft-run');
    return run('draft-run', '10:00', { workflowId: 'draft' });
  });
  let tree = harness.render('default');
  findNode(tree, (node) => node.type?.name === 'SplitView')!
    .props.children('launch', 0)
    .props.onInspect('draft-run');
  tree = harness.render('default');
  assert.equal(groups(tree).length, 0);
  assert.match(text(list(tree)), /暂无匹配记录/);
  await nextTurn();
  tree = harness.render('default');
  assert.deepEqual(calls, ['/api/runs/draft-run']);
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Spring launch'],
  );
  const selected = records(groups(tree)[0]!).find((record) => record.props.className.includes('selected'))!;
  assert.equal(text(selected.props.children[0]), 'Draft the launch plan');
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.run.id, 'draft-run');
  harness.unmount();
});

test('a selected run whose task is outside the loaded window stays in the scoped chat section', async () => {
  const fixture = structuredClone(state);
  fixture.runs = fixture.runs.filter((record) => record.id !== 'draft-run');
  fixture.workflows = fixture.workflows.filter((workflow) => workflow.id !== 'draft');
  const harness = await openStudio(fixture, async (path) => {
    assert.equal(path, '/api/runs/draft-run');
    return run('draft-run', '10:00', { workflowId: 'draft', userInput: 'Older launch request' });
  });
  findNode(harness.render('default'), (node) => node.type?.name === 'SplitView')!
    .props.children('launch', 0)
    .props.onInspect('draft-run');
  harness.render('default');
  await nextTurn();
  const tree = harness.render('default');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['Spring launch'],
  );
  const selected = records(groups(tree)[0]!).find((record) => record.props.className.includes('selected'))!;
  assert.equal(text(selected.props.children[0]), 'Older launch request');
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')!.props.run.id, 'draft-run');
  harness.unmount();
});

test('archiving a scoped chat retains its tasks', async () => {
  const fixture = structuredClone(state);
  const harness = await openStudio(fixture);
  let tree = harness.render('default');
  findNode(tree, (node) => node.type?.name === 'SplitView')!
    .props.children('launch', 0)
    .props.onInspect('draft-run');
  fixture.conversations = fixture.conversations.filter((chat) => chat.id !== 'launch');
  tree = harness.render('default');
  assert.deepEqual(
    groups(tree).map((group) => text(heading(group))),
    ['已归档或已删除的对话'],
  );
  assert.deepEqual(
    records(groups(tree)[0]!).map((record) => text(record.props.children[0])),
    ['Add a timeline', 'Draft the launch plan'],
  );
  harness.unmount();
});
