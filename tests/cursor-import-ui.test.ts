import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const project = { id: 'p', name: 'Synthetic', path: '/synthetic', createdAt: '', updatedAt: '' };
const chats = [
  { composerId: 'new', name: 'New notes', updatedAt: '2026-10-14T12:00:00Z' },
  { composerId: 'old', name: 'Previous notes', updatedAt: '2026-10-13T12:00:00Z', conversationId: 'c' },
];
const text = (tree: unknown) => JSON.stringify(tree);

test('project menu keeps Cursor import beside Claude import, with New chat on the project row', async () => {
  const backend = {
    state: {
      projects: [project],
      conversations: [],
      workflows: [],
      runs: [],
      runtimes: [],
      targets: [],
      approvals: [],
      app: { version: 'test' },
      settings: {},
    },
    api: async () => ({}),
    reload: async () => {},
    connection: 'connected',
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), { __backend: backend });
  try {
    let tree = harness.render('default');
    findNode(tree, (node) => node.props['aria-label'] === '项目 Synthetic 的更多操作')!.props.onClick({
      preventDefault() {},
      clientX: 1,
      clientY: 1,
    });
    tree = harness.render('default');
    const menu = findNode(tree, (node) => node.type?.name === 'ContextMenu')!;
    const item = menu.props.items.find((item: any) => item.label === '从 Cursor 导入对话…');
    assert.ok(item);
    assert.equal(menu.props.items[menu.props.items.indexOf(item) + 1].label, '迁入 Claude 旧记录');
    assert.equal(
      menu.props.items.some((entry: any) => entry.label === '新建对话'),
      false,
    );
    const create = findNode(tree, (node) => node.props['aria-label'] === '在 Synthetic 新建对话')!;
    assert.equal(create.type, 'button');
    assert.equal(create.props.disabled, false);
    assert.equal(typeof create.props.onClick, 'function');
    item.onSelect();
    const dialog = findNode(harness.render('default'), (node) => node.type?.name === 'CursorImportDialog')!;
    assert.ok(dialog);
    assert.equal(dialog.props.project.id, project.id);
  } finally {
    harness.unmount();
  }
});

test('dialog list, missing Cursor, no match and safe error; opening does not import, busy blocks duplicate clicks', async () => {
  const code = await uiBundle('src/ui/CursorImportDialog.tsx');
  for (const state of ['list', 'missing', 'empty', 'error']) {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    let opened = 0,
      closed = 0;
    const api = async (path: string) => {
      calls.push(path);
      if (path.endsWith('/cursor-chats')) {
        if (state === 'error') throw Error('读不到这条 Cursor 对话：数据库不可读、格式不支持或对话为空');
        return { installed: state !== 'missing', chats: state === 'list' ? chats : [] };
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { id: 'c' };
    };
    const props = {
      project,
      api,
      onOpen: async (id: string, imported?: { id: string }) => {
        assert.equal(id, 'c');
        assert.equal(imported?.id, opened ? 'c' : undefined);
        opened++;
        return true;
      },
      onClose: () => {
        closed++;
      },
    };
    const harness = uiHarness(code);
    try {
      harness.render('CursorImportDialog', props);
      await nextTurn();
      let tree = harness.render('CursorImportDialog', props);
      if (state === 'list') {
        assert.match(text(tree), /已导入/);
        assert.match(text(tree), /New notes/);
        const open = findNode(tree, (node) => node.type === 'button' && node.props.children === '打开')!;
        open.props.onClick();
        open.props.onClick();
        assert.equal(calls.length, 1);
        await nextTurn();
        assert.equal(opened, 1);
        assert.equal(closed, 1);
        tree = harness.render('CursorImportDialog', props);
        findNode(tree, (node) => node.type === 'button' && node.props.children === '导入')!.props.onClick();
        findNode(tree, (node) => node.type === 'button' && node.props.className === 'button')!.props.onClick();
        tree = harness.render('CursorImportDialog', props);
        assert.equal(
          findNode(tree, (node) => node.type === 'button' && node.props.className === 'button')!.props.disabled,
          true,
        );
        assert.equal(calls.at(-1), '/api/projects/p/cursor-chats/import');
        assert.equal(calls.length, 2);
        release!();
        await nextTurn();
        assert.equal(opened, 2);
        assert.equal(closed, 2);
      } else
        assert.match(
          text(tree),
          state === 'missing'
            ? /这台电脑上没找到 Cursor/
            : state === 'empty'
              ? /没有找到这个项目的 Cursor 对话/
              : /读不到这条 Cursor 对话/,
        );
    } finally {
      harness.unmount();
    }
  }
});

test('Cursor import keeps branch action but does not offer editing or resending the import notice', async () => {
  const harness = uiHarness(await uiBundle('src/ui/MessageBranchActions.tsx'));
  try {
    const tree = harness.render('MessageBranchActions', {
      message: { id: 'm', conversationId: 'c', role: 'user', importedFrom: { provider: 'cursor', composerId: 'chat' } },
      api: async () => {},
      notify() {},
      onConversation() {},
      onEdit() {},
      lastUserMessage: true,
    });
    assert.ok(findNode(tree, (node) => node.props['aria-label'] === '从这里分叉'));
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === '编辑'),
      undefined,
    );
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === '重新发送'),
      undefined,
    );
  } finally {
    harness.unmount();
  }
});
