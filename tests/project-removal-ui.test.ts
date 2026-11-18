import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  confirmProjectRemoval,
  projectManagementItems,
  MissingProjectFolder,
  RemovedProjects,
} from '../src/ui/ProjectManagement.tsx';
import { confirmationStore } from '../src/ui/confirm-dialog.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { ComposerSession } from '../src/ui/composer-session.ts';

test('remove is next to rename and asks with the in-app confirmation including the files promise', async () => {
  let renamed = 0,
    removed = 0;
  const items = projectManagementItems(
    () => {
      renamed++;
    },
    () => {
      removed++;
    },
  );
  assert.deepEqual(
    items.map((item) => (typeof item === 'string' ? item : item.label)),
    ['重命名', '从列表移除'],
  );
  for (const item of items) if (typeof item !== 'string') item.onSelect();
  assert.equal(renamed, 1);
  assert.equal(removed, 1);
  for (const answer of [false, true]) {
    const pending = confirmProjectRemoval();
    const dialog = confirmationStore.snapshot()!;
    assert.equal(dialog.options.title, '从 PugPort 移除这个项目？硬盘上的文件不会被删除。');
    assert.equal(dialog.options.action, '从列表移除');
    confirmationStore.resolve(dialog.id, answer);
    assert.equal(await pending, answer);
  }
});

test('missing-folder and removed-project controls render compact labels and restore actions', () => {
  const missing = renderToStaticMarkup(createElement(MissingProjectFolder, { onRemove() {} }));
  assert.match(missing, /文件夹已不存在/);
  assert.match(missing, /从列表移除/);
  assert.doesNotMatch(missing, /移到对话/);
  const movable = renderToStaticMarkup(createElement(MissingProjectFolder, { onRemove() {}, onMoveToChats() {} }));
  assert.match(movable, /移到对话/);
  assert.ok(movable.indexOf('移到对话') < movable.indexOf('从列表移除'));
  const project = {
    id: 'removed',
    name: 'Synthetic',
    path: '/synthetic',
    createdAt: '',
    updatedAt: '',
    removedAt: 'now',
  };
  const controls = { api: async <T>() => ({}) as T, reload: async () => {}, notify() {} };
  const removed = renderToStaticMarkup(createElement(RemovedProjects, { projects: [project], ...controls }));
  assert.match(removed, /已移除的项目/);
  assert.match(removed, /恢复/);
  assert.match(renderToStaticMarkup(createElement(RemovedProjects, { projects: [], ...controls })), /没有已移除的项目/);
});

test('sidebar exposes the project menu, missing-folder shortcut and restore API', async () => {
  const project = { id: 'p', name: 'Synthetic', path: '/synthetic', folderMissing: true, createdAt: '', updatedAt: '' };
  const calls: string[] = [];
  let rejectMove = false;
  let finishMove: (() => void) | undefined;
  const backend = {
    state: {
      projects: [project],
      removedProjects: [{ ...project, id: 'removed', removedAt: 'now' }],
      conversations: [
        { id: 'chat', projectId: 'p', title: 'Synthetic chat', pinnedAt: 'now', createdAt: '', updatedAt: '' },
      ],
      workflows: [],
      runs: [],
      runtimes: [],
      targets: [],
      approvals: [],
      app: { version: 'test' },
      settings: {},
    },
    api: async (path: string) => {
      calls.push(path);
      if (rejectMove && path.endsWith('/move-to-chats')) throw Error('文件夹还在，不需要移到对话。');
      if (path.endsWith('/move-to-chats'))
        await new Promise<void>((done) => {
          finishMove = done;
        });
      return {};
    },
    reload: async () => {},
    connection: 'connected',
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), { __backend: backend });
  try {
    let tree = harness.render('default');
    const menuButton = findNode(tree, (node) => node.props['aria-label'] === '项目 Synthetic 的更多操作')!;
    assert.ok(menuButton);
    menuButton.props.onClick({ preventDefault() {}, clientX: 1, clientY: 1 });
    tree = harness.render('default');
    const menu = findNode(tree, (node) => node.type?.name === 'ContextMenu')!;
    assert.ok(menu.props.items.some((item: any) => item.label === '从列表移除'));
    findNode(tree, (node) => node.props.className?.includes('conversation-link') && node.props.onClick)!.props.onClick(
      {},
    );
    tree = harness.render('default');
    const missing = findNode(tree, (node) => node.type?.name === 'MissingProjectFolder')!;
    assert.ok(missing);
    assert.equal(typeof missing.props.onMoveToChats, 'function', 'pinned chats must still offer Move to Chats');
    const moving = missing.props.onMoveToChats();
    tree = harness.render('default');
    assert.equal(findNode(tree, (node) => node.type?.name === 'MissingProjectFolder')!.props.movingToChats, true);
    finishMove!();
    await moving;
    assert.deepEqual(calls, ['/api/projects/p/move-to-chats']);
    tree = harness.render('default');
    assert.equal(findNode(tree, (node) => node.type?.name === 'NoticeToast')!.props.notice.message, '已移到对话。');
    rejectMove = true;
    await findNode(tree, (node) => node.type?.name === 'MissingProjectFolder')!.props.onMoveToChats();
    tree = harness.render('default');
    const error = findNode(tree, (node) => node.type?.name === 'NoticeToast')!.props.notice;
    assert.equal(error.tone, 'error');
    assert.match(error.message, /文件夹还在，不需要移到对话。/);
    backend.state.conversations = [];
    tree = harness.render('default');
    assert.equal(findNode(tree, (node) => node.type?.name === 'MissingProjectFolder')?.props.onMoveToChats, undefined);
    assert.equal(
      findNode(tree, (node) => node.type?.name === 'RemovedProjects'),
      undefined,
      'removed projects no longer appear in the sidebar',
    );
    findNode(tree, (node) => node.props.className?.includes('nav-item') && text(node) === '设置')!.props.onClick();
    tree = harness.render('default');
    findNode(tree, (node) => node.type?.name === 'SettingsShell')!.props.onCategory('conversation');
    tree = harness.render('default');
    assert.equal(
      findNode(tree, (node) => node.type?.name === 'RemovedProjectsSheet'),
      undefined,
    );
    findNode(tree, (node) => node.props['aria-label'] === '管理已移除的项目')!.props.onClick();
    tree = harness.render('default');
    const removed = findNode(tree, (node) => node.type?.name === 'RemovedProjectsSheet')!;
    assert.equal(removed.props.projects[0].id, 'removed');
    assert.equal(typeof removed.props.api, 'function');
    backend.state.projects = [];
    tree = harness.render('default');
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === '项目 Synthetic 的更多操作'),
      undefined,
    );
  } finally {
    harness.unmount();
  }
});

test('composer missing-folder notice is informational and leaves sending enabled', async () => {
  const project = { id: 'p', name: 'Synthetic', path: '/synthetic', folderMissing: true, createdAt: '', updatedAt: '' };
  const chat = { id: 'chat', projectId: project.id, title: 'Synthetic', createdAt: '', updatedAt: '' };
  const state = {
    app: { platform: 'win32' },
    projects: [project],
    conversations: [chat],
    workflows: [],
    conversationMessages: [],
    runs: [],
    targets: [],
    runtimes: [],
    approvals: [],
    settings: {},
  };
  const session = new ComposerSession();
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
  const props = {
    state,
    project,
    conversation: chat,
    composerSession: session,
    api: async () => ({ messages: [] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  try {
    let tree = render();
    findNode(tree, (n) => n.type === 'textarea' && n.props.id === 'conversation-input')!.props.onChange({
      target: { value: 'Keep my draft' },
    });
    tree = render();
    const row = findNode(tree, (n) => n.props.className?.includes('composer-missing-folder'))!;
    assert.ok(row);
    assert.equal(row.props.role, 'status');
    assert.equal(
      findNode(row, (n) => n.type === 'button'),
      undefined,
    );
    const send = findNode(tree, (n) => n.type === 'button' && n.props.type === 'submit')!;
    assert.ok(send);
    assert.ok(!send.props.disabled);
    project.folderMissing = false;
    tree = render();
    assert.equal(
      findNode(tree, (n) => n.props.className?.includes('composer-missing-folder')),
      undefined,
    );
    assert.equal(
      findNode(tree, (n) => n.type === 'textarea' && n.props.id === 'conversation-input')!.props.value,
      'Keep my draft',
    );
    await nextTurn();
  } finally {
    harness.unmount();
  }
});

test('sidebar move button is disabled during the shared request', () => {
  const markup = renderToStaticMarkup(
    createElement(MissingProjectFolder, {
      onRemove() {},
      onMoveToChats() {},
      movingToChats: true,
    }),
  );
  assert.match(markup, /<button[^>]*disabled=""[^>]*>移到对话/);
});

test('Clear list confirms the count, prevents duplicate requests and recovers from failure', async () => {
  const h = uiHarness(await uiBundle('tests/helpers/project-management-fixture.ts'));
  const confirmations = h.exports.confirmationStore;
  const calls: { path: string; body?: unknown }[] = [];
  const notices: any[] = [];
  let fail = true,
    closed = 0,
    reloaded = 0;
  const props = {
    projects: [{ id: 'a' }, { id: 'retry', purgePending: true }],
    api: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      if (fail) throw Error('Synthetic failure');
      return { cleared: true };
    },
    notify: (notice: any) => notices.push(notice),
    reload: async () => {
      reloaded++;
    },
    onClose: () => {
      closed++;
    },
  };
  const render = () => h.render('RemovedProjectsSheet', props);
  const button = () => findNode(render(), (node) => node.type === 'button' && node.props.children === '清空列表')!;
  const answer = async (value: boolean) => {
    const confirmation = confirmations.snapshot();
    assert.ok(confirmation);
    confirmations.resolve(confirmation.id, value);
    await nextTurn();
  };
  try {
    const click = button().props.onClick;
    click();
    click();
    assert.equal(button().props.disabled, true);
    assert.equal(confirmations.snapshot().options.tone, undefined);
    assert.deepEqual(Array.from(confirmations.snapshot().options.names), ['2']);
    assert.match(confirmations.snapshot().options.summary, /未完成清空的项目会保留/);
    await answer(false);
    assert.equal(confirmations.snapshot(), undefined);
    assert.equal(calls.length, 0);
    assert.equal(button().props.disabled, false);
    button().props.onClick();
    await answer(true);
    assert.equal(notices.at(-1).tone, 'error');
    assert.equal(closed, 0);
    assert.equal(reloaded, 0);
    assert.equal(button().props.disabled, false);
    fail = false;
    button().props.onClick();
    await answer(true);
    assert.deepEqual(
      calls.map(({ path }) => path),
      ['/api/removed-projects/clear', '/api/removed-projects/clear'],
    );
    assert.equal(JSON.stringify(calls.at(-1)?.body), '{}');
    assert.equal(reloaded, 1);
    assert.equal(closed, 1);
    assert.equal(notices.at(-1).message, '已清空列表。');
  } finally {
    h.unmount();
  }
});
