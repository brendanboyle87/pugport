import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { archiveConversation, restoreConversation } from '../src/ui/ConversationArchive.tsx';
import { SearchResults } from '../src/ui/SearchDialog.tsx';
import type { Api, Notice } from '../src/ui/Workspace.tsx';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const item = {
  id: 'c',
  projectId: 'p',
  title: 'Synthetic archive',
  createdAt: '',
  updatedAt: '',
  archivedAt: '2026-10-14T12:00:00Z',
};
test('archive toast undo unarchives; restore uses POST; errors show an error toast', async () => {
  const calls: unknown[] = [];
  const api = (async (...args: unknown[]) => {
    calls.push(args);
    return {};
  }) as Api;
  const notices: Notice[] = [];
  const notify = (notice: Notice) => notices.push(notice);
  assert.equal(await archiveConversation(api, notify, item, true), true);
  assert.equal(notices[0].message, '已归档');
  await notices[0].action!.run();
  assert.deepEqual(calls, [
    ['/api/conversations/c', { archived: true }, 'PATCH'],
    ['/api/conversations/c', { archived: false }, 'PATCH'],
  ]);
  assert.equal(await restoreConversation(api, notify, item), true);
  assert.deepEqual(calls[2], ['/api/conversations/c/restore', {}]);
  assert.equal(
    await archiveConversation(
      async () => {
        throw Error('busy');
      },
      notify,
      item,
      true,
    ),
    false,
  );
  assert.equal(notices.at(-1)?.tone, 'error');
});

test('list loads on mount and removes a restored row only after successful API completion', async () => {
  const h = uiHarness(await uiBundle('src/ui/ConversationArchive.tsx'));
  const calls: string[] = [];
  const props = {
    kind: 'archived',
    api: async (url: string, body?: unknown) => {
      calls.push(url);
      return body ? {} : [item];
    },
    notify() {},
    projects: [{ id: 'p', name: 'Fixture' }],
    onClose() {},
  };
  try {
    h.render('ConversationArchive', props);
    await nextTurn();
    let tree = h.render('ConversationArchive', props);
    assert.deepEqual(calls, ['/api/archived-conversations']);
    const button = findNode(tree, (node) => node.type === 'button' && node.props.children === '取消归档')!;
    assert.ok(button);
    button.props.onClick();
    await nextTurn();
    tree = h.render('ConversationArchive', props);
    assert.equal(calls[1], '/api/conversations/c');
    assert.ok(findNode(tree, (node) => node.type === 'p' && node.props.children === '暂无对话'));
  } finally {
    h.unmount();
  }
});

test('each sheet shows only its own bulk action and disables it until the list is loaded', async () => {
  const bundle = await uiBundle('src/ui/ConversationArchive.tsx');
  for (const [kind, label, state] of [
    ['archived', '全部删除', 'danger'],
    ['deleted', '清空', 'secondary danger'],
  ] as const) {
    const h = uiHarness(bundle);
    try {
      const props = {
        kind,
        api: async () => [{ ...item, deletedAt: '2026-10-14T12:00:00Z' }],
        notify() {},
        projects: [],
        onClose() {},
      };
      let tree = h.render('ConversationArchive', props);
      const bulk = () => findNode(tree, (node) => node.type === 'button' && node.props.children === label)!;
      assert.match(bulk().props.className, new RegExp(state));
      assert.equal(bulk().props.disabled, true, 'disabled while loading');
      await nextTurn();
      tree = h.render('ConversationArchive', props);
      assert.equal(bulk().props.disabled, false);
      assert.equal(
        findNode(
          tree,
          (node) =>
            node.type === 'button' &&
            ['全部删除', '清空'].includes(node.props.children) &&
            node.props.children !== label,
        ),
        undefined,
        'the other sheet’s action is not offered',
      );
    } finally {
      h.unmount();
    }
  }
});

test('search marks archived hits', () => {
  const html = renderToStaticMarkup(
    createElement(SearchResults, {
      results: [{ ...item, conversationId: item.id, messageId: null, snippet: [] }],
      active: 0,
      onSelect() {},
      onActive() {},
    }),
  );
  assert.match(html, /已归档/);
});

test('shared toast closes before undo and exposes errors as alerts', async () => {
  const h = uiHarness(await uiBundle('src/ui/Studio.tsx', true));
  const calls: string[] = [];
  const props = {
    notice: { tone: 'success', message: 'Synthetic notice', action: { label: 'Undo', run: () => calls.push('undo') } },
    onClose: () => calls.push('close'),
  };
  try {
    let tree = h.render('NoticeToast', props);
    assert.equal(tree.props.role, 'status');
    findNode(tree, (node) => node.type === 'button' && node.props.children === 'Undo')!.props.onClick();
    assert.deepEqual(calls, ['close', 'undo']);
    tree = h.render('NoticeToast', { ...props, notice: { tone: 'error', message: 'Synthetic error' } });
    assert.equal(tree.props.role, 'alert');
    findNode(tree, (node) => node.props['aria-label'] === '关闭提示')!.props.onClick();
    assert.deepEqual(calls, ['close', 'undo', 'close']);
  } finally {
    h.unmount();
  }
});

test('opening an archived search hit does not put it back into the sidebar or palette', async () => {
  const backend = {
    state: {
      projects: [{ id: 'p', name: 'Fixture', path: '/synthetic' }],
      conversations: [],
      workflows: [],
      runs: [],
      runtimes: [],
      targets: [],
      approvals: [],
      app: { version: 'test' },
      settings: {},
    },
    api: async () => ({ conversation: item }),
    reload: async () => {},
    connection: 'connected',
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const h = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: backend,
    window: {
      addEventListener: (name: string, run: (event: unknown) => void) => listeners.set(name, run),
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  try {
    let tree = h.render('default');
    listeners.get('keydown')!({ key: 'f', ctrlKey: true, shiftKey: true, preventDefault() {}, target: {} });
    tree = h.render('default');
    const dialog = findNode(tree, (node) => node.type?.name === 'SearchDialog')!;
    await dialog.props.onSelect({ conversationId: item.id });
    tree = h.render('default');
    const split = findNode(tree, (node) => node.type?.name === 'SplitView')!;
    assert.equal(split.props.children('c', 0).props.conversation.archivedAt, item.archivedAt);
    assert.equal(
      findNode(tree, (node) => node.props.className?.split?.(' ').includes('conversation-link')),
      undefined,
    );
    // Pinning an archived search hit must keep its open pane.
    backend.api = async () => ({ ...item, pinnedAt: item.archivedAt }) as any;
    await split.props.children('c', 0).props.api('/api/conversations/c', { pinned: true }, 'PATCH');
    tree = h.render('default');
    assert.equal(findNode(tree, (node) => node.type?.name === 'SplitView')!.props.ids[0], 'c');
    // Sending brings it into broadcast state. A later archive must not revive the cached search hit.
    backend.state.conversations = [{ ...item, archivedAt: undefined }] as any;
    h.render('default');
    backend.state.conversations = [];
    tree = h.render('default');
    assert.equal(findNode(tree, (node) => node.type?.name === 'SplitView')!.props.ids[0], '');
  } finally {
    h.unmount();
  }
});

test('archived bulk action confirms counts, cancels safely, blocks restores and reports skipped chats', async () => {
  const h = uiHarness(await uiBundle('tests/helpers/project-management-fixture.ts'));
  const store = h.exports.confirmationStore;
  const calls: { path: string; body?: unknown; method?: string }[] = [];
  const notices: Notice[] = [];
  let values = [item, { ...item, id: 'c2' }];
  let complete!: (value: unknown) => void;
  let changed = 0;
  const props = {
    kind: 'archived',
    api: async (path: string, body?: unknown, method?: string) => {
      calls.push({ path, body, method });
      if (method === 'GET') return values;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    notify: (notice: Notice) => notices.push(notice),
    projects: [],
    onClose() {},
    onChanged: () => changed++,
  };
  const render = () => h.render('ConversationArchive', props);
  const button = (label: string) =>
    findNode(render(), (node) => node.type === 'button' && node.props.children === label)!;
  try {
    render();
    await nextTurn();
    const click = button('全部删除').props.onClick;
    click();
    click();
    assert.deepEqual(Array.from(store.snapshot().options.names), ['2']);
    assert.equal(store.snapshot().options.tone, 'danger');
    assert.equal(button('取消归档').props.disabled, true);
    store.resolve(store.snapshot().id, false);
    await nextTurn();
    assert.equal(store.snapshot(), undefined, 'double clicks must not queue a second confirmation');
    assert.equal(calls.length, 1, 'cancel does not mutate');
    assert.equal(button('全部删除').props.disabled, false);

    button('全部删除').props.onClick();
    store.resolve(store.snapshot().id, true);
    await nextTurn();
    assert.equal(button('取消归档').props.disabled, true);
    button('取消归档').props.onClick();
    assert.equal(calls.length, 2, 'restoring cannot race the batch');
    assert.equal(calls[1].path, '/api/archived-conversations/delete-all');
    assert.equal(JSON.stringify(calls[1].body), '{}');
    values = [values[1]];
    complete({ deleted: 1, skipped: 1 });
    await nextTurn();
    render();
    await nextTurn();
    assert.equal(changed, 1);
    assert.equal(notices.at(-1)?.message, '已删除 1 个对话。 有 1 个对话仍在运行，已跳过。');
    assert.equal(button('全部删除').props.disabled, false);
    assert.equal(
      findNode(render(), (node) => node.type === 'div' && node.key === 'c'),
      undefined,
    );
  } finally {
    h.unmount();
  }
});

for (const olderCount of [0, 200]) {
  test(`empty confirms both counts including ${olderCount} older chats, sends the token and explains every skip`, async () => {
    const h = uiHarness(await uiBundle('tests/helpers/project-management-fixture.ts'));
    const store = h.exports.confirmationStore;
    const calls: { path: string; body?: unknown; method?: string }[] = [];
    const notices: Notice[] = [];
    const token = 'a'.repeat(64);
    let complete!: (value: unknown) => void;
    let changed = 0;
    const props = {
      kind: 'deleted',
      api: async (path: string, body?: unknown, method?: string) => {
        calls.push({ path, body, method });
        if (path === '/api/conversation-history') return { purge: { count: 4, olderCount, token } };
        if (method === 'GET') return [{ ...item, deletedAt: item.archivedAt }];
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
      notify: (notice: Notice) => notices.push(notice),
      projects: [],
      onClose() {},
      onChanged: () => changed++,
    };
    const render = () => h.render('ConversationArchive', props);
    const button = (label: string) =>
      findNode(render(), (node) => node.type === 'button' && node.props.children === label)!;
    try {
      render();
      await nextTurn();
      button('清空').props.onClick();
      await nextTurn();
      assert.deepEqual(Array.from(store.snapshot().options.names), olderCount ? ['4', String(olderCount)] : ['4']);
      assert.equal(store.snapshot().options.title.includes('{1}'), olderCount > 0);
      assert.match(store.snapshot().options.summary, /PugPort.*AI/);
      assert.equal(button('恢复').props.disabled, true);
      store.resolve(store.snapshot().id, false);
      await nextTurn();
      assert.equal(
        calls.some((call) => call.path.endsWith('/empty')),
        false,
      );

      button('清空').props.onClick();
      await nextTurn();
      store.resolve(store.snapshot().id, true);
      await nextTurn();
      assert.equal(button('恢复').props.disabled, true);
      button('恢复').props.onClick();
      assert.equal(
        calls.some((call) => call.path.endsWith('/restore')),
        false,
      );
      assert.equal(JSON.stringify(calls.at(-1)?.body), JSON.stringify({ token }));
      complete({ deleted: olderCount + 1, skipped: 1, kept: 1, unsafe: 1 });
      await nextTurn();
      assert.equal(changed, 1);
      assert.equal(notices.at(-1)?.tone, 'info');
      assert.equal(
        notices.at(-1)?.message,
        `已删除 ${olderCount + 1} 个对话。 有 1 个对话仍在运行，已跳过。 有 1 个对话带有工作副本，已保留。 有 1 个对话未能安全检查，已保留。`,
      );
      assert.equal(button('恢复').props.disabled, false);
    } finally {
      h.unmount();
    }
  });
}

for (const failureAt of ['preview', 'empty', 'delete-all']) {
  test(`a ${failureAt} failure keeps the list and releases the bulk action`, async () => {
    const h = uiHarness(await uiBundle('tests/helpers/project-management-fixture.ts'));
    const store = h.exports.confirmationStore;
    const notices: Notice[] = [];
    let changed = 0;
    const props = {
      kind: failureAt === 'delete-all' ? 'archived' : 'deleted',
      api: async (path: string, _body?: unknown, method?: string) => {
        if (path === '/api/conversation-history') {
          if (failureAt === 'preview') throw Error('Synthetic preview failure');
          return { purge: { count: 1, olderCount: 0, token: 'b'.repeat(64) } };
        }
        if (method === 'GET') return [{ ...item, deletedAt: item.archivedAt }];
        throw Error('The list changed. Review it again.');
      },
      notify: (notice: Notice) => notices.push(notice),
      projects: [],
      onClose() {},
      onChanged: () => changed++,
    };
    const render = () => h.render('ConversationArchive', props);
    const button = (label: string) =>
      findNode(render(), (node) => node.type === 'button' && node.props.children === label)!;
    try {
      render();
      await nextTurn();
      const label = failureAt === 'delete-all' ? '全部删除' : '清空';
      button(label).props.onClick();
      await nextTurn();
      if (failureAt !== 'preview') {
        store.resolve(store.snapshot().id, true);
        await nextTurn();
      }
      assert.equal(store.snapshot(), undefined);
      assert.equal(notices.at(-1)?.tone, 'error');
      assert.equal(changed, failureAt === 'preview' ? 0 : 1);
      assert.equal(button(label).props.disabled, false);
      assert.ok(findNode(render(), (node) => node.type === 'strong' && node.props.children === item.title));
    } finally {
      h.unmount();
    }
  });
}

test('empty list disables bulk actions unless older chats or pending cleanup remain', async () => {
  const bundle = await uiBundle('src/ui/ConversationArchive.tsx');
  for (const [kind, olderCount, pendingCount, disabled] of [
    ['archived', 0, 0, true],
    ['deleted', 0, 0, true],
    ['deleted', 1, 0, false],
    ['deleted', 0, 1, false],
  ] as const) {
    const h = uiHarness(bundle);
    const props = {
      kind,
      projects: [],
      notify() {},
      onClose() {},
      api: async (path: string) =>
        path === '/api/conversation-history' ? { purge: { olderCount, pendingCount } } : [],
    };
    try {
      h.render('ConversationArchive', props);
      await nextTurn();
      await nextTurn();
      const tree = h.render('ConversationArchive', props);
      const button = findNode(
        tree,
        (node) => node.type === 'button' && node.props.children === (kind === 'archived' ? '全部删除' : '清空'),
      )!;
      assert.equal(button.props.disabled, disabled);
    } finally {
      h.unmount();
    }
  }
});

test('restoring the last listed chat still offers cleanup for older chats', async () => {
  const h = uiHarness(await uiBundle('src/ui/ConversationArchive.tsx'));
  let restored = false;
  const props = {
    kind: 'deleted',
    projects: [],
    notify() {},
    onClose() {},
    api: async (path: string, _body?: unknown, method?: string) => {
      if (path === '/api/conversation-history') return { purge: { olderCount: 1, pendingCount: 0 } };
      if (method === 'GET') return restored ? [] : [{ ...item, deletedAt: item.archivedAt }];
      restored = true;
      return {};
    },
  };
  try {
    h.render('ConversationArchive', props);
    await nextTurn();
    let tree = h.render('ConversationArchive', props);
    findNode(tree, (node) => node.type === 'button' && node.props.children === '恢复')!.props.onClick();
    await nextTurn();
    h.render('ConversationArchive', props);
    await nextTurn();
    await nextTurn();
    tree = h.render('ConversationArchive', props);
    assert.equal(
      findNode(tree, (node) => node.type === 'button' && node.props.children === '清空')!.props.disabled,
      false,
    );
  } finally {
    h.unmount();
  }
});
