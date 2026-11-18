import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-05T12:00:00Z';
const project = { id: 'project', name: 'Fixture', path: 'C:/Fixture', createdAt: stamp, updatedAt: stamp };
const conversation = {
  id: 'conversation',
  projectId: project.id,
  title: 'Fixture chat',
  createdAt: stamp,
  updatedAt: stamp,
  connectorIds: ['work-mail'],
};
const state = {
  app: { version: 'test' },
  projects: [project],
  conversations: [conversation],
  conversationMessages: [],
  workflows: [],
  runs: [],
  runtimes: [],
  targets: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: { maxQuotaAgeSeconds: 120, reservePercent: 10, refreshSeconds: 60 },
};
const api = async () => ({ messages: [], workflows: [] });

test('chat toolbar stays compact and hides dormant connector selection, including saved selections', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
  let menuCalls = 0;
  const props = {
    state,
    project,
    conversation,
    api,
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
    onConversationMenu() {
      menuCalls++;
    },
  };
  let tree = harness.render('ConversationWorkspace', props);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'VoiceButton'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props['aria-label'] === '语音输入'),
    undefined,
  );
  tree = harness.render('ConversationWorkspace', props);
  const toolbar = findNode(tree, (node) => node.props.className === 'conversation-toolbar')!;
  // Routing rules, skills and memory share one settings button.
  for (const label of ['新侧聊', '对话设置']) {
    assert.ok(
      findNode(toolbar, (node) => node.props['aria-label'] === label),
      label,
    );
  }
  assert.equal(
    findNode(toolbar, (node) => node.props['aria-label'] === '对话连接器'),
    undefined,
  );
  const controls = findNode(tree, (node) => node.props.className === 'composer-controls')!;
  // Saved account selections never bring dormant connector controls back.
  findNode(controls, (node) => node.props['aria-label'] === '添加和更多')!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  const menu = findNode(tree, (node) => node.props.className === 'composer-menu')!;
  assert.equal(
    findNode(menu, (node) => node.props['aria-label'] === '对话连接器'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props.className === 'composer-tag' && node.props.children?.includes?.('连接器')),
    undefined,
  );
  toolbar.props.onContextMenu({});
  findNode(tree, (node) => node.props.className === 'conversation-scroll')!.props.onContextMenu({
    target: { closest: () => null },
  });
  assert.equal(menuCalls, 2, 'title and unselected conversation background open the conversation menu');
  harness.unmount();
});

test('new-window action stays in the conversation context menu after removing its toolbar button', async () => {
  const opened: string[] = [];
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: { state, api, reload: async () => {}, connection: 'connected' },
    localStorage: {
      getItem: (key: string) => (key === 'agent-studio-conversation' ? conversation.id : null),
      setItem() {},
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        openWindow: async (id: string) => {
          opened.push(id);
        },
      },
    },
  });
  let tree = harness.render('default');
  const split = findNode(tree, (node) => node.type?.name === 'SplitView')!;
  const workspace = split.props.children(conversation.id, 0);
  assert.equal(
    findNode(workspace.props.paneActions, (node) => node.props['aria-label'] === '在新窗口打开'),
    undefined,
  );
  let prevented = false;
  workspace.props.onConversationMenu({
    preventDefault() {
      prevented = true;
    },
    clientX: 10,
    clientY: 20,
  });
  tree = harness.render('default');
  const menu = findNode(tree, (node) => node.type?.name === 'ContextMenu')!;
  const action = menu.props.items.find((item: { label?: string }) => item.label === '在新窗口打开');
  assert.ok(prevented);
  assert.equal(action.shortcut, 'Ctrl+Shift+O');
  await action.onSelect();
  assert.deepEqual(opened, [conversation.id]);
  harness.unmount();
});
