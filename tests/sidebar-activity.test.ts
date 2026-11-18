import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, Project, Workflow } from '../src/shared/types.ts';
import {
  matchesActivity,
  nextNeedingMe,
  sidebarActivity,
  sidebarConversationOrder,
  sidebarScope,
} from '../src/ui/sidebar-activity.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-14T12:00:00Z';
const chat = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title: id,
  projectId: 'project',
  createdAt: stamp,
  updatedAt: stamp,
  ...extra,
});
const flow = (conversationId: string, status: Workflow['status'], extra: Partial<Workflow> = {}) =>
  ({ conversationId, status, createdAt: stamp, updatedAt: stamp, ...extra }) as Workflow;
const project = { id: 'project', name: 'Fixture', path: 'C:/Fixture', createdAt: stamp, updatedAt: stamp } as Project;

test('one snapshot counts conversations, not workflows, with independent running/waiting/unread flags', () => {
  const conversations = ['run', 'plan', 'approve', 'confirm', 'load', 'queue', 'idle'].map((id) => chat(id));
  let reads = 0;
  const { byId, counts } = sidebarActivity(
    conversations,
    [
      flow('run', 'running'),
      flow('run', 'running'),
      flow('plan', 'planning'),
      flow('approve', 'waiting-approval'),
      flow('confirm', 'waiting-confirmation'),
      flow('load', 'waiting-resource', { machineLoadChoice: 'pending' }),
      flow('queue', 'queued'),
      flow('idle', 'running', { deletedAt: stamp }),
      flow('idle', 'completed'),
    ],
    (item) => {
      reads++;
      return item.id === 'idle' || item.id === 'approve';
    },
  );
  assert.equal(reads, conversations.length);
  assert.deepEqual(counts, { all: 7, running: 2, waiting: 2, unread: 2 });
  assert.deepEqual(byId.get('queue'), { running: false, waiting: false, unread: false });
});

test('a swarm lead running and a member waiting counts in both filters', () => {
  const { byId, counts } = sidebarActivity(
    [chat('swarm', { swarm: true })],
    [flow('swarm', 'running'), flow('swarm', 'waiting-approval'), flow('swarm', 'waiting-confirmation')],
    () => false,
  );
  assert.deepEqual(counts, { all: 1, running: 1, waiting: 1, unread: 0 });
  assert.equal(matchesActivity('swarm', byId, 'running', ''), true);
});

test('a cancelled task with a pending load choice no longer needs the user', () => {
  const { byId, counts } = sidebarActivity(
    [chat('cancelled')],
    [flow('cancelled', 'cancelled', { machineLoadChoice: 'pending' })],
    () => false,
  );
  assert.equal(counts.waiting, 0);
  assert.equal(byId.get('cancelled')?.waiting, false);
  assert.equal(nextNeedingMe([chat('cancelled')], byId, ''), undefined);
});

test('archived, deleted and side chats never enter counts, filters or jump order, even when selected', () => {
  const conversations = [
    chat('archived', { archivedAt: stamp }),
    chat('deleted', { deletedAt: stamp }),
    chat('side', { sideChat: { parentConversationId: 'main' } as Conversation['sideChat'] }),
    chat('main'),
  ];
  const { byId, counts } = sidebarActivity(conversations, [flow('archived', 'waiting-approval')], () => true);
  assert.deepEqual(counts, { all: 1, running: 0, waiting: 0, unread: 1 });
  assert.equal(matchesActivity('archived', byId, 'all', 'archived'), false);
  assert.deepEqual(
    sidebarConversationOrder(conversations, [project], []).map((item) => item.id),
    ['main'],
  );
});

test('selected conversation stays visible after its activity clears without inflating counts', () => {
  const { byId, counts } = sidebarActivity([chat('selected'), chat('other')], [], () => false);
  for (const filter of ['running', 'unread'] as const) {
    assert.equal(matchesActivity('selected', byId, filter, 'selected'), true);
    assert.equal(matchesActivity('other', byId, filter, 'selected'), false);
    assert.equal(counts[filter], 0);
  }
});

test('full jump order includes folded folders and projects, follows sidebar groups and wraps', () => {
  const conversations = [
    chat('project-last'),
    chat('unfiled', { projectId: 'chat' }),
    chat('filed', { projectId: 'chat', folderId: 'folder' }),
    chat('pinned', { pinnedAt: stamp }),
    chat('archived', { archivedAt: stamp }),
  ];
  const order = sidebarConversationOrder(
    conversations,
    [project, { ...project, id: 'chat', scope: 'chat' }],
    [{ id: 'folder', name: 'Folder', createdAt: stamp, updatedAt: stamp }],
  );
  assert.deepEqual(
    order.map((item) => item.id),
    ['pinned', 'filed', 'unfiled', 'project-last'],
  );
  const { byId } = sidebarActivity(
    conversations,
    [flow('project-last', 'waiting-approval')],
    (item) => item.id === 'filed' || item.id === 'pinned',
  );
  assert.equal(nextNeedingMe(order, byId, 'filed')?.id, 'project-last');
  assert.equal(nextNeedingMe(order, byId, 'project-last')?.id, 'pinned');
  assert.equal(nextNeedingMe(order, byId, 'missing')?.id, 'pinned');
  assert.equal(nextNeedingMe([], byId, ''), undefined);
  assert.equal(nextNeedingMe(order, sidebarActivity(conversations, [], () => false).byId, ''), undefined);
});

test('agent chats stay out of sidebar lists and counts unless the switch is on or they wait for the owner', () => {
  const conversations = [
    chat('owner', { projectId: 'empty-host' }),
    chat('agent', { projectId: 'external-only' }),
    chat('mixed-owner', { projectId: 'mixed' }),
    chat('mixed-agent', { projectId: 'mixed' }),
  ];
  const projects = [
    { ...project, id: 'empty' },
    { ...project, id: 'external-only', name: 'External' },
    { ...project, id: 'mixed', name: 'Mixed' },
  ];
  const hidden = ['agent', 'mixed-agent'];
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  const running = [flow('agent', 'running'), flow('mixed-agent', 'running'), flow('owner', 'running')];
  const closed = sidebarScope(conversations, projects, running, hidden, false);
  assert.deepEqual(ids(closed.conversations), ['owner', 'mixed-owner']);
  assert.deepEqual(ids(closed.projects), ['empty', 'mixed']);
  assert.deepEqual(
    sidebarActivity(closed.conversations, running, (item) => item.id === 'agent' || item.id === 'mixed-owner').counts,
    { all: 2, running: 1, waiting: 0, unread: 1 },
  );

  const approval = [flow('agent', 'waiting-approval'), flow('mixed-agent', 'running')];
  const asking = sidebarScope(conversations, projects, approval, hidden, false);
  assert.deepEqual(ids(asking.conversations), ['owner', 'agent', 'mixed-owner'], 'a chat waiting for approval shows');
  assert.deepEqual(ids(asking.projects), ['empty', 'external-only', 'mixed']);
  assert.deepEqual(sidebarActivity(asking.conversations, approval, () => false).counts, {
    all: 3,
    running: 0,
    waiting: 1,
    unread: 0,
  });
  const confirmed = [flow('agent', 'waiting-confirmation')];
  assert.deepEqual(ids(sidebarScope(conversations, projects, confirmed, hidden, false).conversations), [
    'owner',
    'agent',
    'mixed-owner',
  ]);
  const handled = [flow('agent', 'completed'), flow('mixed-agent', 'running')];
  assert.deepEqual(
    ids(sidebarScope(conversations, projects, handled, hidden, false).conversations),
    ['owner', 'mixed-owner'],
    'once handled it is hidden again',
  );

  const open = sidebarScope(conversations, projects, running, hidden, true);
  assert.deepEqual(ids(open.conversations), ['owner', 'agent', 'mixed-owner', 'mixed-agent']);
  assert.deepEqual(ids(open.projects), ['empty', 'external-only', 'mixed']);
  assert.deepEqual(sidebarActivity(open.conversations, approval, () => false).counts, {
    all: 4,
    running: 1,
    waiting: 1,
    unread: 0,
  });
});

test('markAllRead persists every conversation, preserves other markers, and later changes become unread', async () => {
  const conversations = [chat('a'), chat('b')];
  const storage = new Map([['comborunner.seen', JSON.stringify({ a: '', b: '', archived: 'keep' })]]);
  const harness = uiHarness(await uiBundle('src/ui/DesktopFeatures.tsx'), {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  harness.exports.Probe = () => harness.exports.useUnread(conversations, []);
  const render = () =>
    harness.render('Probe') as unknown as {
      unread: (item: Conversation) => boolean;
      markAllRead: () => void;
    };
  assert.ok(render().unread(conversations[0]!));
  render().markAllRead();
  assert.ok(conversations.every((item) => !render().unread(item)));
  assert.deepEqual(JSON.parse(storage.get('comborunner.seen')!), { a: stamp, b: stamp, archived: 'keep' });
  harness.remount();
  assert.equal(render().unread(conversations[1]!), false);
  const menuAction = render().markAllRead;
  conversations[1] = chat('b', { updatedAt: '2026-10-14T13:00:00Z' });
  assert.equal(render().unread(conversations[1]!), true);
  menuAction();
  assert.equal(render().unread(conversations[1]!), false, 'an already open menu reads the latest timestamps');
});

test('sidebar filtering persists, hides empty projects, keeps selection, and shortcut expands a folded project', async () => {
  const storage = new Map([['agent-studio-conversation', 'selected']]);
  const listeners = new Set<(event: unknown) => void>();
  const state = {
    app: { version: 'test' },
    projects: [project, { ...project, id: 'empty', name: 'Empty' }],
    conversations: [chat('selected'), chat('waiting'), chat('archived', { archivedAt: stamp })],
    workflows: [flow('waiting', 'waiting-approval', { id: 'approval' }), flow('waiting', 'running', { id: 'running' })],
    conversationMessages: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    settings: { maxQuotaAgeSeconds: 120, reservePercent: 10, refreshSeconds: 60 },
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
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
  const label = (tree: unknown, value: string) => findNode(tree, (node) => node.props['aria-label'] === value);
  const filter = (value: string) => findNode(render(), (node) => node.type === 'button' && node.key === value)!;
  filter('running').props.onClick();
  let tree = render();
  assert.equal(storage.get('pugport-activity-filter'), 'running');
  const waitingRow = findNode(
    tree,
    (node) =>
      node.props.className?.includes('conversation-link') &&
      node.props.children?.some?.((child: any) => child?.props?.children === 'waiting'),
  )!;
  assert.ok(findNode(waitingRow, (node) => node.props.activity === 'attention'));
  assert.ok(findNode(tree, (node) => node.props.className?.includes('conversation-link selected')));
  assert.equal(label(tree, '展开 Empty'), undefined);
  assert.equal(label(tree, '收起 Empty'), undefined);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'empty-conversation-link'),
    undefined,
  );
  filter('all').props.onClick();
  label(render(), '收起 Fixture')!.props.onClick();
  assert.ok(label(render(), '展开 Fixture'));
  let prevented = false;
  for (const listener of listeners)
    listener({
      key: 'j',
      ctrlKey: true,
      shiftKey: true,
      target: { tagName: 'TEXTAREA' },
      preventDefault() {
        prevented = true;
      },
    });
  tree = render();
  assert.equal(prevented, true);
  assert.equal(storage.get('agent-studio-conversation'), 'waiting');
  assert.ok(label(tree, '收起 Fixture'));
  filter('unread').props.onClick();
  render();
  harness.remount();
  assert.equal(filter('unread').props['aria-pressed'], true);
  storage.set('agent-studio-conversation', '');
  harness.remount();
  tree = render();
  assert.ok(findNode(tree, (node) => node.props.className === 'sidebar-activity-empty'));
  assert.equal(
    findNode(tree, (node) => node.props.className === 'sidebar-project'),
    undefined,
  );
  filter('all').props.onClick();
  state.conversations.push(chat('pinned', { pinnedAt: stamp }));
  state.workflows.push(flow('pinned', 'waiting-confirmation', { id: 'confirmation' }));
  label(render(), '收起 Fixture')!.props.onClick();
  filter('running').props.onClick();
  assert.ok(label(render(), '展开 Fixture'));
  for (const listener of listeners)
    listener({ key: 'j', ctrlKey: true, shiftKey: true, target: { tagName: 'TEXTAREA' }, preventDefault() {} });
  assert.ok(label(render(), '展开 Fixture'), 'jumping to a pinned conversation keeps its project collapsed');
  assert.equal(storage.get('agent-studio-conversation'), 'pinned');
  state.conversations = [];
  state.workflows = [];
  filter('all').props.onClick();
  assert.equal(
    findNode(render(), (node) => node.props.className === 'sidebar-activity-empty'),
    undefined,
  );
  filter('running').props.onClick();
  assert.ok(findNode(render(), (node) => node.props.className === 'sidebar-activity-empty'));
});

test('all mode shows no filter-empty message while state is loading', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: { state: undefined, api: async () => ({}), reload: async () => {}, connection: 'connecting' },
  });
  assert.equal(
    findNode(harness.render('default'), (node) => node.props.className === 'sidebar-activity-empty'),
    undefined,
  );
});

test('filtered folders hide empty sections and reveal the selected chat inside a collapsed folder', async () => {
  const harness = uiHarness(await uiBundle('src/ui/ConversationFolders.tsx'), {
    localStorage: { getItem: () => '["folder"]', setItem() {} },
  });
  const folders = ['folder', 'empty'].map((id) => ({ id, name: id, createdAt: stamp, updatedAt: stamp }));
  const props = {
    chats: [chat('filed', { folderId: 'folder' })],
    state: { conversationFolders: folders },
    filtering: true,
    selectedId: '',
    row: (item: Conversation) => ({ type: 'chat-row', props: { id: item.id } }),
    api: async () => ({}),
    reload: async () => {},
    notify() {},
    onVisibleOrder() {},
  };
  let tree = harness.render('ChatFolders', props);
  assert.equal(
    findNode(tree, (node) => node.type === 'chat-row'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.key === 'empty'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props.className === 'folder-empty'),
    undefined,
  );
  tree = harness.render('ChatFolders', { ...props, selectedId: 'filed' });
  tree = harness.render('ChatFolders', { ...props, selectedId: 'filed' });
  assert.ok(findNode(tree, (node) => node.type === 'chat-row' && node.props.id === 'filed'));
  assert.equal(findNode(tree, (node) => node.props.className === 'chat-folder-toggle')!.props['aria-expanded'], true);
  tree = harness.render('ChatFolders', { ...props, chats: [] });
  assert.equal(
    findNode(tree, (node) => node.type === 'section'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props.className === 'project-heading'),
    undefined,
  );
});

test('two hidden MCP-dispatch conversations keep the running filter at zero until made visible', () => {
  const conversations = [chat('owner'), chat('dispatch-a'), chat('dispatch-b')];
  const workflows = [flow('dispatch-a', 'running'), flow('dispatch-b', 'planning')];
  for (const show of [false, true]) {
    const scope = sidebarScope(conversations, [project], workflows, ['dispatch-a', 'dispatch-b'], show);
    const activity = sidebarActivity(scope.conversations, workflows, () => false);
    const filtered = scope.conversations.filter((item) => matchesActivity(item.id, activity.byId, 'running', ''));
    assert.equal(activity.counts.running, show ? 2 : 0);
    assert.equal(filtered.length, activity.counts.running);
  }
});

test('dispatch projects require an owner chat even when no hidden ids remain', () => {
  const projects: Project[] = [
    { ...project, id: 'normal-empty' },
    { ...project, id: 'dispatch-empty', origin: 'dispatch' },
    { ...project, id: 'dispatch-hidden', origin: 'dispatch' },
    { ...project, id: 'dispatch-owner', origin: 'dispatch' },
  ];
  const conversations = [
    chat('agent', { projectId: 'dispatch-hidden' }),
    chat('owner', { projectId: 'dispatch-owner' }),
  ];
  const ids = (items: { id: string }[]) => items.map((item) => item.id);
  assert.deepEqual(ids(sidebarScope(conversations, projects, [], ['agent'], false).projects), [
    'normal-empty',
    'dispatch-owner',
  ]);
  assert.deepEqual(ids(sidebarScope([], projects, [], [], false).projects), ['normal-empty']);
  assert.deepEqual(ids(sidebarScope([], projects, [], [], true).projects), ids(projects));
  assert.deepEqual(
    ids(sidebarScope(conversations, projects, [flow('agent', 'waiting-approval')], ['agent'], false).projects),
    ['normal-empty', 'dispatch-hidden', 'dispatch-owner'],
  );
});
