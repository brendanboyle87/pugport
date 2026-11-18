import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranslator } from '../src/shared/i18n/index.ts';
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-14T12:00:00Z';
const project = { id: 'project', name: 'Fixture', path: 'C:/Fixture', createdAt: stamp, updatedAt: stamp };
const conversation = {
  id: 'chat_1-2',
  projectId: project.id,
  title: 'Fixture chat',
  createdAt: stamp,
  updatedAt: stamp,
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

async function studio(fixture: Record<string, unknown> = state, request: (...args: any[]) => Promise<unknown> = api) {
  const storage = new Map([['agent-studio-conversation', conversation.id]]);
  const listeners = new Set<(event: unknown) => void>();
  const pinned: boolean[] = [];
  const copied: string[] = [];
  const harness = uiHarness(await uiBundle('tests/helpers/studio-confirmation-fixture.ts', true), {
    __backend: { state: fixture, api: request, reload: async () => {}, connection: 'connected' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    navigator: {
      language: 'zh-CN',
      languages: ['zh-CN'],
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    },
    window: {
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === 'keydown') listeners.add(listener);
      },
      removeEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === 'keydown') listeners.delete(listener);
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        pinWindow: async (value: boolean) => {
          pinned.push(value);
          return value;
        },
      },
    },
  });
  return {
    harness,
    storage,
    pinned,
    copied,
    render: () => harness.render('default'),
    key(key: string) {
      let prevented = false;
      for (const listener of listeners)
        listener({
          key,
          ctrlKey: true,
          target: { tagName: 'TEXTAREA' },
          preventDefault() {
            prevented = true;
          },
        });
      assert.ok(prevented);
    },
  };
}

test('Ctrl+B and sidebar buttons toggle, persist and restore; mobile navigation still opens', async () => {
  const ui = await studio();
  const sidebar = (tree: unknown) => findNode(tree, (node) => node.type === 'aside')!;
  assert.doesNotMatch(sidebar(ui.render()).props.className, /sidebar-collapsed/);
  ui.key('b');
  let tree = ui.render();
  assert.match(sidebar(tree).props.className, /sidebar-collapsed/);
  assert.equal(ui.storage.get('pugport-sidebar-collapsed'), 'true');
  ui.harness.remount();
  tree = ui.render();
  assert.match(sidebar(tree).props.className, /sidebar-collapsed/);
  findNode(tree, (node) => node.props['aria-label'] === '展开侧边栏')!.props.onClick();
  tree = ui.render();
  assert.doesNotMatch(sidebar(tree).props.className, /sidebar-collapsed/);
  assert.equal(ui.storage.get('pugport-sidebar-collapsed'), 'false');
  findNode(tree, (node) => node.props['aria-label'] === '折叠侧边栏')!.props.onClick();
  tree = ui.render();
  findNode(tree, (node) => node.props.className === 'icon-button mobile-menu')!.props.onClick();
  tree = ui.render();
  assert.match(sidebar(tree).props.className, /mobile-open/);
  findNode(tree, (node) => node.props.className === 'sidebar-overlay')!.props.onClick();
  assert.doesNotMatch(sidebar(ui.render()).props.className, /mobile-open/);
  ui.key('b');
  assert.doesNotMatch(sidebar(ui.render()).props.className, /sidebar-collapsed/);
  ui.harness.unmount();
});

test('the palette pins and unpins the main window through pinWindow', async () => {
  const ui = await studio();
  ui.render();
  ui.key('k');
  const pin = () =>
    findNode(ui.render(), (node) => node.type?.name === 'CommandPalette')!.props.entries.find(
      (entry: { id: string }) => entry.id === 'pin-window',
    );
  assert.equal(pin().label, '窗口保持在最前');
  pin().run();
  await nextTurn();
  assert.equal(pin().label, '取消置顶窗口');
  pin().run();
  await nextTurn();
  assert.deepEqual(ui.pinned, [true, false]);
  assert.equal(pin().label, '窗口保持在最前');
  ui.harness.unmount();
});

test('sidebar toggles expose expanded state and hand focus to the other button', async () => {
  const ui = await studio();
  const toggle = findNode(ui.render(), (node) => node.props['aria-label'] === '折叠侧边栏')!;
  assert.equal(toggle.props['aria-expanded'], true);
  let toggleFocus = 0;
  let restoreFocus = 0;
  toggle.props.ref.current = { focus: () => toggleFocus++ };
  toggle.props.onClick();
  const restore = findNode(ui.render(), (node) => node.props['aria-label'] === '展开侧边栏')!;
  assert.equal(restore.props['aria-expanded'], false);
  restore.props.ref.current = { focus: () => restoreFocus++ };
  restore.props.onClick();
  ui.render();
  assert.equal(toggleFocus, 1);
  toggle.props.onClick();
  ui.render();
  assert.equal(restoreFocus, 1);
  ui.harness.unmount();
});

test('copy conversation link follows copy project path and writes the exact deep link', async () => {
  const ui = await studio();
  const split = findNode(ui.render(), (node) => node.type?.name === 'SplitView')!;
  split.props.children(conversation.id, 0).props.onConversationMenu({ preventDefault() {}, clientX: 10, clientY: 20 });
  const items = findNode(ui.render(), (node) => node.type?.name === 'ContextMenu')!.props.items;
  assert.equal(
    items.findIndex((item: { label?: string }) => item.label === '复制标题'),
    -1,
  );
  assert.ok(items.some((item: { label?: string }) => item.label === '导出'));
  const archive = items.findIndex((item: { label?: string }) => item.label === '归档');
  assert.equal(items[archive + 1], 'separator');
  assert.equal(items[archive + 2].label, '删除');
  const at = items.findIndex((item: { label?: string }) => item.label === '复制项目路径');
  assert.equal(items[at + 1].label, '复制链接');
  items[at + 1].onSelect();
  assert.deepEqual(ui.copied, [`pugport://conversation/${conversation.id}`]);
  ui.harness.unmount();
});

function chatMenu(ui: Awaited<ReturnType<typeof studio>>) {
  const split = findNode(ui.render(), (node) => node.type?.name === 'SplitView')!;
  split.props.children(conversation.id, 0).props.onConversationMenu({ preventDefault() {}, clientX: 10, clientY: 20 });
  return findNode(ui.render(), (node) => node.type?.name === 'ContextMenu')!.props.items;
}

test('chat deletion asks once, cancel makes no request, and confirmed ordinary deletion keeps undo', async () => {
  const calls: unknown[][] = [];
  const ui = await studio(state, async (...args) => {
    calls.push(args.slice(0, 3));
    return {};
  });
  const remove = chatMenu(ui).find((item: { label?: string }) => item.label === '删除');
  const store = ui.harness.exports.confirmationStore;
  remove.onSelect();
  const first = store.snapshot();
  assert.equal(first.options.title, '删除对话');
  assert.equal(first.options.tone, 'danger');
  assert.equal(first.options.action, '删除');
  assert.match(first.options.summary, /本地历史备份和项目文件保留/);
  remove.onSelect();
  assert.equal(store.snapshot().id, first.id, 'duplicate clicks reuse the pending question');
  store.resolve(first.id, false);
  await nextTurn();
  assert.equal(store.snapshot(), undefined);
  assert.equal(calls.filter((call) => call[2] === 'DELETE').length, 0);
  remove.onSelect();
  store.resolve(store.snapshot().id, true);
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call[2] === 'DELETE'))), [
    ['/api/conversations/chat_1-2', {}, 'DELETE'],
  ]);
  const notice = findNode(ui.render(), (node) => node.type?.name === 'NoticeToast')!.props.notice;
  assert.equal(notice.message, '已删除');
  assert.equal(notice.action.label, '撤销');
  await notice.action.run();
  assert.equal(calls.at(-1)?.[0], '/api/conversations/chat_1-2/restore');
  ui.harness.unmount();
});

test('incognito deletion warns about permanence and offers no undo; failed deletion preserves the chat', async () => {
  for (const fails of [false, true]) {
    const ui = await studio(
      { ...state, conversations: [{ ...conversation, incognito: true }] },
      async (_url, _body, method) => {
        if (method === 'DELETE' && fails) throw new Error('Synthetic active task');
        return { deleted: true };
      },
    );
    chatMenu(ui)
      .find((item: { label?: string }) => item.label === '删除')
      .onSelect();
    const store = ui.harness.exports.confirmationStore;
    assert.equal(store.snapshot().options.summary, '永久删除，不能撤销');
    store.resolve(store.snapshot().id, true);
    await nextTurn();
    const tree = ui.render();
    const notice = findNode(tree, (node) => node.type?.name === 'NoticeToast')!.props.notice;
    assert.equal(notice.tone, fails ? 'error' : 'success');
    assert.equal(notice.action, undefined);
    if (fails) {
      assert.match(notice.message, /Synthetic active task/);
      const split = findNode(tree, (node) => node.type?.name === 'SplitView')!;
      assert.equal(split.props.children(conversation.id, 0).props.conversation.id, conversation.id);
    }
    ui.harness.unmount();
  }
});

test('chat rename uses shared button styles and saves the trimmed title', async () => {
  const calls: unknown[][] = [];
  const ui = await studio(state, async (...args) => {
    calls.push(args.slice(0, 3));
    return {};
  });
  chatMenu(ui)
    .find((item: { label?: string }) => item.label === '重命名')
    .onSelect();
  let dialog = findNode(ui.render(), (node) => node.props['aria-label'] === '重命名对话')!;
  assert.equal(
    findNode(dialog, (node) => node.type === 'button' && text(node) === '取消')!.props.className,
    'button secondary',
  );
  assert.equal(findNode(dialog, (node) => node.props.type === 'submit')!.props.className, 'button primary');
  findNode(dialog, (node) => node.type === 'input')!.props.onChange({ target: { value: '  Renamed chat  ' } });
  dialog = findNode(ui.render(), (node) => node.props['aria-label'] === '重命名对话')!;
  dialog.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find((call) => call[2] === 'PATCH'))), [
    '/api/conversations/chat_1-2',
    { title: 'Renamed chat' },
    'PATCH',
  ]);
  assert.equal(
    findNode(ui.render(), (node) => node.props['aria-label'] === '重命名对话'),
    undefined,
  );
  ui.harness.unmount();
});

test('sidebar search opens history search and narrow header has no refresh', async () => {
  const ui = await studio();
  let tree = ui.render();
  const row = findNode(tree, (node) => node.props.className === 'new-conversation-row')!;
  findNode(row, (node) => node.props['aria-label'] === '搜索对话')!.props.onClick();
  tree = ui.render();
  assert.ok(findNode(tree, (node) => node.type?.name === 'SearchDialog'));
  const header = findNode(tree, (node) => node.props.className === 'studio-topbar')!;
  assert.equal(
    findNode(header, (node) => node.props['aria-label'] === '刷新执行器与额度'),
    undefined,
  );
  // The single refresh entry lives on the Usage & connections page (the settings rework removed the sidebar one).
  assert.equal(
    findNode(tree, (node) => String(node.props.className ?? '').includes('sidebar-refresh')),
    undefined,
  );
  ui.harness.unmount();
});

test('project menu keeps one create entry on the row and opens Claude history import', async () => {
  const ui = await studio();
  let tree = ui.render();
  assert.ok(findNode(tree, (node) => node.props.className === 'project-new icon-button'));
  findNode(tree, (node) => node.props.className?.startsWith('project-line '))!.props.onContextMenu({
    preventDefault() {},
    clientX: 10,
    clientY: 20,
  });
  const items = findNode(ui.render(), (node) => node.type?.name === 'ContextMenu')!.props.items;
  assert.equal(
    items.find((item: { label?: string }) => item.label === '新建对话'),
    undefined,
  );
  const cursor = items.findIndex((item: { label?: string }) => item.label === '从 Cursor 导入对话…');
  assert.equal(items[cursor + 1].label, '迁入 Claude 旧记录');
  items[cursor + 1].onSelect();
  const importer = findNode(ui.render(), (node) => node.type?.name === 'ClaudeHistoryImport')!;
  assert.equal(importer.props.project.id, project.id);
  const imported = { ...conversation, id: 'imported', title: 'Imported chat' };
  assert.equal(await importer.props.onOpen(imported.id, imported), true);
  importer.props.onClose();
  tree = ui.render();
  const split = findNode(tree, (node) => node.type?.name === 'SplitView')!;
  assert.equal(split.props.children(imported.id, 0).props.conversation.id, imported.id);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'ClaudeHistoryImport'),
    undefined,
  );
  ui.harness.unmount();
});

test('Needs you includes lane roots and selects their conversation with the final-message jump target', async () => {
  const lane = { ...conversation, id: 'lane', lane: { parentConversationId: conversation.id } };
  const workflow = {
    id: 'lane-work',
    conversationId: lane.id,
    projectId: project.id,
    status: 'completed',
    userQuestion: { text: 'Which branch?', options: [], askedAt: stamp },
    finalMessageId: 'final',
    runIds: [],
    input: { mode: 'chat' },
    plan: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  const ui = await studio({ ...state, conversations: [conversation, lane], workflows: [workflow] });
  const inbox = findNode(ui.render(), (node) => node.type?.name === 'NeedsYou')!;
  assert.ok(inbox.props.conversations.some((item: { id: string }) => item.id === lane.id));
  await inbox.props.onSelect(lane, workflow);
  const tree = ui.render();
  assert.equal(ui.storage.get('agent-studio-conversation'), lane.id);
  const pane = findNode(tree, (node) => node.type?.name === 'SplitView')!.props.children(lane.id, 0);
  assert.equal(pane.props.conversation?.id, lane.id);
  const target = pane.props.searchTarget;
  assert.equal(target?.conversationId, lane.id);
  assert.equal(typeof target?.requestId, 'number');
  ui.harness.unmount();
});

test('activity filters show only positive counts and chat rows choose one priority dot', async () => {
  const active = { ...conversation, id: 'active' };
  const unread = { ...conversation, id: 'unread' };
  const workflow = {
    id: 'running',
    projectId: project.id,
    conversationId: active.id,
    status: 'running',
    createdAt: stamp,
    updatedAt: stamp,
    input: { text: 'Synthetic', mode: 'chat' },
    plan: [],
    runIds: [],
  };
  const fixture = {
    ...state,
    conversations: [conversation, active, unread],
    workflows: [workflow, { ...workflow, id: 'waiting', status: 'waiting-approval' }],
  };
  const ui = await studio(fixture);
  ui.storage.set('comborunner.seen', JSON.stringify({ [active.id]: '', [unread.id]: '' }));
  ui.harness.remount();
  const filter = (key: string) => findNode(ui.render(), (node) => node.type === 'button' && node.key === key)!;
  const translate = createTranslator(english);
  const filters = [
    ['all', '全部', 'All', 3],
    ['running', '运行中', 'Running', 1],
    ['unread', '未读', 'Unread', 2],
  ] as const;
  for (const [key, label, englishLabel, count] of filters) {
    const button = filter(key);
    assert.equal(button.props['aria-label'], `${label} · ${count}`);
    assert.equal(translate(button.props['aria-label']), `${englishLabel} · ${count}`);
    assert.equal(translate(button.props.title), englishLabel);
    assert.equal(button.props.type, 'button');
    assert.notEqual(button.props.tabIndex, -1);
    assert.ok(!button.props.disabled);
    assert.equal(text(findNode(button, (node) => node.props.className === 'filter-label')), label);
    assert.equal(findNode(button, (node) => node.props.className === 'filter-icon')!.props['aria-hidden'], true);
    const badge = findNode(button, (node) => node.props.className === 'filter-count');
    if (key !== 'all') {
      assert.equal(text(badge), String(count));
      assert.equal(badge!.props['aria-hidden'], true);
    }
    button.props.onClick();
    for (const [otherKey] of filters) assert.equal(filter(otherKey).props['aria-pressed'], otherKey === key);
  }
  filter('all').props.onClick();
  assert.equal(
    findNode(filter('all'), (node) => node.props.className === 'filter-count'),
    undefined,
  );
  assert.equal(text(findNode(filter('running'), (node) => node.props.className === 'filter-count')), '1');
  const row = (id: string) =>
    findNode(ui.render(), (node) => node.props.className === 'conversation-with-mode' && node.key === id)!;
  assert.equal(findNode(row(active.id), (node) => node.type?.name === 'ActivityDot')!.props.activity, 'attention');
  assert.equal(
    findNode(row(active.id), (node) => node.props.className === 'unread-dot'),
    undefined,
  );
  fixture.workflows.pop();
  assert.equal(filter('waiting'), undefined);
  assert.equal(findNode(row(active.id), (node) => node.type?.name === 'ActivityDot')!.props.activity, 'running');
  assert.equal(
    findNode(row(active.id), (node) => node.props.className === 'unread-dot'),
    undefined,
  );
  assert.ok(findNode(row(unread.id), (node) => node.props.className === 'unread-dot'));
  const section = findNode(ui.render(), (node) => node.props.className === 'sidebar-chat-section')!;
  section.props.onContextMenu({ target: { closest: () => true }, preventDefault() {}, clientX: 10, clientY: 20 });
  const menu = findNode(ui.render(), (node) => node.type?.name === 'ContextMenu')!;
  assert.equal(menu.props.items[0].label, '全部标为已读');
  menu.props.items[0].onSelect();
  assert.equal(translate(filter('unread').props['aria-label']), 'Unread · 0');
  assert.equal(
    findNode(row(unread.id), (node) => node.props.className === 'unread-dot'),
    undefined,
  );
  assert.equal(
    findNode(filter('unread'), (node) => node.props.className === 'filter-count'),
    undefined,
  );
  ui.harness.unmount();
});

for (const activation of ['pointer', 'keyboard click', 'ContextMenu', 'Shift+F10']) {
  test(`Chats heading actions are reachable by ${activation} and mark chats as read`, async () => {
    const unread = { ...conversation, id: 'unread' };
    const ui = await studio({ ...state, conversations: [conversation, unread] });
    ui.storage.set('comborunner.seen', JSON.stringify({ [unread.id]: '' }));
    ui.harness.remount();
    const folderProps = findNode(ui.render(), (node) => node.type?.name === 'ChatFolders')!.props;
    const folders = uiHarness(await uiBundle('src/ui/ConversationFolders.tsx'));
    const trigger = findNode(
      folders.render('ChatFolders', folderProps),
      (node) => node.props['aria-label'] === '对话列表操作',
    )!;
    assert.equal(trigger.type, 'button');
    assert.equal(trigger.props.type, 'button');
    assert.equal(trigger.props['aria-haspopup'], 'menu');
    assert.notEqual(trigger.props.tabIndex, -1);
    assert.ok(!trigger.props.disabled);
    const unreadRow = () =>
      findNode(ui.render(), (node) => node.props.className === 'conversation-with-mode' && node.key === unread.id)!;
    assert.ok(findNode(unreadRow(), (node) => node.props.className === 'unread-dot'));
    let prevented = false;
    const target = {
      closest: () => true,
      getBoundingClientRect: () => ({ left: 40, bottom: 60 }),
    };
    const event = {
      target,
      currentTarget: target,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    };
    if (activation === 'pointer' || activation === 'keyboard click') {
      // Native buttons synthesize a detail=0 click for Enter and Space.
      trigger.props.onClick({
        ...event,
        type: 'click',
        detail: activation === 'pointer' ? 1 : 0,
        clientX: 10,
        clientY: 20,
      });
    } else {
      const section = findNode(ui.render(), (node) => node.props.className === 'sidebar-chat-section')!;
      section.props.onKeyDown({
        ...event,
        key: activation === 'ContextMenu' ? 'ContextMenu' : 'F10',
        shiftKey: activation === 'Shift+F10',
      });
    }
    assert.ok(prevented);
    const menu = findNode(ui.render(), (node) => node.type?.name === 'ContextMenu')!;
    assert.equal(menu.props.x, activation === 'pointer' ? 10 : 40);
    assert.equal(menu.props.y, activation === 'pointer' ? 20 : 60);
    assert.equal(menu.props.items[0].label, '全部标为已读');
    menu.props.items[0].onSelect();
    assert.equal(
      findNode(unreadRow(), (node) => node.props.className === 'unread-dot'),
      undefined,
    );
    folders.unmount();
    ui.harness.unmount();
  });
}

test('path context menu delegates editor actions to its ReplyPaths ref', async () => {
  const opened: unknown[][] = [];
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'), {
    window: {
      addEventListener() {},
      removeEventListener() {},
      comboRunnerDesktop: { pickDirectory: async () => null, openEditor: async () => 'ok' },
    },
  });
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
  };
  let tree = harness.render('ConversationWorkspace', props);
  findNode(tree, (node) => node.type?.name === 'ReplyPaths')!.props.ref.current = async (...args: unknown[]) => {
    opened.push(args);
  };
  const path = {};
  let prevented = false;
  findNode(tree, (node) => node.props.className === 'conversation-scroll')!.props.onContextMenu({
    target: { closest: (selector: string) => (selector.includes('data-local-path') ? path : null) },
    clientX: 10,
    clientY: 20,
    preventDefault() {
      prevented = true;
    },
  });
  tree = harness.render('ConversationWorkspace', props);
  const items = findNode(tree, (node) => node.type?.name === 'ContextMenu')!.props.items;
  assert.ok(prevented);
  assert.deepEqual(
    Array.from(items, (item: { label: string }) => item.label),
    ['用 VS Code 打开', '用 Cursor 打开'],
  );
  items[0].onSelect();
  items[1].onSelect();
  assert.deepEqual(opened, [
    [path, 'vscode'],
    [path, 'cursor'],
  ]);
  harness.unmount();
});
