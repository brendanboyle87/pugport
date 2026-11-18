import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatFolders } from '../src/ui/ConversationFolders.tsx';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';
import type { AppState, Conversation } from '../src/shared/types.ts';
import type { ClassificationJob, ConversationFolder } from '../src/shared/conversation-folders.ts';
import type { Notice } from '../src/ui/Workspace.tsx';

const code = await uiBundle('src/ui/ConversationFolders.tsx');
const time = '2026-10-05T12:00:00Z';
const folder: ConversationFolder = { id: 'study', name: '学习', createdAt: time, updatedAt: time };
const chat = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  projectId: 'chat',
  title: `对话 ${id}`,
  createdAt: time,
  updatedAt: time,
  ...patch,
});
const state = {
  conversationFolders: [folder],
  targets: [
    { id: 'codex-b', label: 'Codex B', provider: 'codex', enabled: true },
    { id: 'disabled', label: 'Disabled CLI', provider: 'grok', enabled: false },
    { id: 'api', label: 'API', provider: 'pi', enabled: true },
  ],
} as AppState;
const job = (status: ClassificationJob['status'] = 'applied'): ClassificationJob => ({
  id: 'classify-fixture',
  status,
  total: 2,
  processed: status === 'running' ? 0 : 2,
  changed: status === 'applied' ? 2 : 0,
  renamed: status === 'applied' ? 1 : 0,
  createdFolders: status === 'applied' ? 1 : 0,
  skipped: 0,
  proposals:
    status === 'running'
      ? []
      : [
          { conversationId: 'a', title: '学英语', folderName: '学习' },
          { conversationId: 'b', title: '学习笔记', folderName: '学习' },
        ],
  runIds: ['run-fixture'],
  createdAt: time,
  updatedAt: time,
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('rendered folders escape user labels and keep project navigation outside the chat section', () => {
  const html = renderToStaticMarkup(
    createElement(ChatFolders, {
      chats: [chat('a')],
      state: { ...state, conversationFolders: [{ ...folder, name: '<img src=x onerror=alert(1)>' }] },
      row: (item) => createElement('button', { key: item.id, 'data-chat': item.id }, item.title),
      api: async <T>() => ({}) as T,
      reload: async () => {},
      notify() {},
      onVisibleOrder() {},
    }),
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /aria-label="新建对话分类"/);
  assert.match(html, /lucide-tag[\s"]/);
  assert.match(html, /lucide-tags[\s"]/);
  assert.ok(!html.includes('lucide-folder'));
  assert.ok(!html.includes('添加项目'));
});
function text(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text((tree as UiNode).props?.children);
  return '';
}
function button(tree: unknown, label: string): UiNode {
  const found = findNode(
    tree,
    (node) => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label),
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}
function fixture(
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>,
  storage = new Map<string, string>(),
) {
  const intervals = new Map<number, () => void>();
  const notices: Notice[] = [];
  let reloaded = 0,
    closed = 0,
    intervalId = 0;
  const h = uiHarness(code, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    setInterval: (fn: () => void) => {
      intervals.set(++intervalId, fn);
      return intervalId;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  const props = {
    state,
    chats: [chat('a'), chat('b')],
    row: () => null,
    onVisibleOrder() {},
    api,
    reload: async () => {
      reloaded++;
    },
    notify: (notice: Notice) => notices.push(notice),
    onClose: () => {
      closed++;
    },
  };
  return {
    h,
    props,
    storage,
    intervals,
    notices,
    render: () => h.render('ChatFolders', props),
    reloaded: () => reloaded,
    closed: () => closed,
  };
}

test('sidebar folder order is independent of pinning and collapsed groups update keyboard navigation', () => {
  const f = fixture(async () => ({}));
  const chats = [
    chat('unfiled'),
    chat('filed', { folderId: folder.id }),
    chat('pinned', { folderId: folder.id, pinnedAt: time }),
  ];
  let visible: string[] = [];
  const props = {
    ...f.props,
    chats,
    row: (item: Conversation) => ({ type: 'chat-row', props: { children: item.id } }),
    onVisibleOrder: (ids: string[]) => {
      visible = ids;
    },
  };
  let tree = f.h.render('ChatFolders', props);
  assert.deepEqual(plain(visible), ['filed', 'unfiled']);
  assert.ok(!findNode(tree, (node) => node.type === 'chat-row' && text(node) === 'pinned'));
  const toggle = findNode(tree, (node) => node.props.className === 'chat-folder-toggle')!;
  assert.equal(toggle.type, 'button', 'native buttons support Enter and Space');
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  tree = f.h.render('ChatFolders', props);
  assert.deepEqual(plain(visible), ['unfiled']);
  assert.equal(findNode(tree, (node) => node.props.className === 'chat-folder-toggle')!.props['aria-expanded'], false);
  assert.ok([...f.storage.values()].some((value) => value.includes('study')));
  f.h.unmount();
});

test('dragging files a general conversation but rejects project conversations', async () => {
  const calls: unknown[][] = [];
  const f = fixture(async (...args) => {
    calls.push(args);
    return {};
  });
  const props = { ...f.props, chats: [chat('general')], row: () => null, onVisibleOrder() {} };
  const tree = f.h.render('ChatFolders', props);
  const section = findNode(
    tree,
    (node) => node.type === 'section' && String(node.props.className).startsWith('chat-folder '),
  )!;
  const event = (id: string) => ({ dataTransfer: { getData: () => id }, preventDefault() {}, stopPropagation() {} });
  section.props.onDrop(event('project-chat'));
  await nextTurn();
  assert.equal(calls.length, 0);
  assert.equal(f.notices.length, 1);
  section.props.onDrop(event('general'));
  await nextTurn();
  assert.deepEqual(plain(calls[0]), ['/api/conversations/general/folder', { folderId: 'study' }, 'PATCH']);
  f.h.unmount();
});

test('folder move has a keyboard path and sends null when returning to unfiled', async () => {
  const calls: unknown[][] = [];
  const f = fixture(async (...args) => {
    calls.push(args);
    return {};
  });
  const props = { ...f.props, chat: chat('a', { folderId: 'study' }), folders: [folder] };
  let tree = f.h.render('FolderMoveDialog', props);
  const select = findNode(tree, (node) => node.type === 'select')!;
  assert.equal(select.props.autoFocus, true);
  select.props.onChange({ target: { value: '' } });
  tree = f.h.render('FolderMoveDialog', props);
  await findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(plain(calls[0]), ['/api/conversations/a/folder', { folderId: null }, 'PATCH']);
  assert.equal(f.reloaded(), 1);
  assert.equal(f.closed(), 1);
  f.h.unmount();
});

const clickOrganize = (tree: unknown) => button(tree, '整理对话').props.onClick({ shiftKey: false });
const contextMenu = (tree: unknown) => findNode(tree, (node) => Array.isArray(node.props.items))!;

test('organize immediately posts without a dialog and completion undo calls the undo route', async () => {
  const calls: unknown[][] = [];
  const f = fixture(async (path, ...args) => {
    calls.push([path, ...args]);
    return job(path.endsWith('/undo') ? 'undone' : 'applied');
  });
  let tree = f.render();
  assert.equal(calls.length, 0);
  clickOrganize(tree);
  assert.equal(calls.length, 1);
  await nextTurn();
  tree = f.render();
  assert.ok(!findNode(tree, (node) => node.props.role === 'dialog'));
  const [path, body] = plain(calls[0]);
  assert.equal(path, '/api/conversation-folders/classify');
  assert.deepEqual(Object.keys(body), []);
  assert.equal(f.reloaded(), 1);
  assert.equal(f.notices.at(-1)?.message, '已整理 2 个对话 · 已重命名 1 个 · 新建 1 个分类');
  assert.equal(f.notices.at(-1)?.action?.label, '撤销');
  assert.equal(f.storage.has('pugport-chat-organize-running'), false);
  assert.equal(f.storage.get('pugport-chat-classification-last-applied'), job().id);
  await f.notices.at(-1)?.action?.run();
  f.render();
  assert.equal(calls.at(-1)?.[0], '/api/conversation-folders/jobs/classify-fixture/undo');
  assert.equal(f.reloaded(), 2);
  assert.equal(f.storage.size, 0);
  assert.match(f.notices.at(-1)!.message, /保留之后的手动调整/);
  assert.ok(!calls.some(([path]) => String(path).endsWith('/apply')));
  f.h.unmount();
});

test('running clicks re-show the stop toast without starting another job, then polling reports completion once', async () => {
  const calls: Array<{ path: string; body: unknown; method?: string }> = [];
  const f = fixture(async (path, body, method) => {
    calls.push({ path, body, method });
    return job(path.endsWith('/classify') ? 'running' : 'applied');
  });
  clickOrganize(f.render());
  await nextTurn();
  let tree = f.render();
  assert.ok(findNode(tree, (node) => node.props.className === 'spinning'));
  assert.deepEqual(plain(f.notices[0]), {
    tone: 'info',
    message: '正在整理 {0} 个对话…',
    names: ['2'],
    action: { label: '停止' },
  });
  clickOrganize(tree);
  assert.equal(calls.length, 1);
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices.at(-1)?.tone, 'info');
  for (const tick of f.intervals.values()) tick();
  await nextTurn();
  tree = f.render();
  assert.equal(calls.at(-1)?.method, 'GET');
  assert.equal(calls.at(-1)?.body, undefined);
  assert.ok(!findNode(tree, (node) => node.props.className === 'spinning'));
  assert.equal(f.notices.filter((notice) => notice.tone === 'success').length, 1);
  assert.equal(f.intervals.size, 0);
  f.h.unmount();
});

test('right click and Shift click expose reorganize and applied-only undo', async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const f = fixture(async (path, body) => {
    calls.push({ path, body });
    return job(path.endsWith('/undo') ? 'undone' : 'applied');
  });
  let prevented = false;
  button(f.render(), '整理对话').props.onContextMenu({
    clientX: 15,
    clientY: 25,
    preventDefault() {
      prevented = true;
    },
  });
  let menu = contextMenu(f.render());
  assert.ok(prevented);
  assert.deepEqual(plain(menu.props.items.map((item: any) => item.label)), ['也整理已分类的对话', '撤销上次整理']);
  assert.equal(menu.props.items[1].disabled, true);
  menu.props.items[0].onSelect();
  await nextTurn();
  assert.equal(calls[0]?.body.includeFiled, true);
  menu = contextMenu(f.render());
  menu.props.onClose();
  button(f.render(), '整理对话').props.onClick({ shiftKey: true, clientX: 10, clientY: 20 });
  menu = contextMenu(f.render());
  assert.equal(menu.props.items[1].disabled, false);
  assert.equal(calls.length, 1, 'Shift click opens the menu without starting a run');
  menu.props.items[1].onSelect();
  await nextTurn();
  assert.equal(calls.at(-1)?.path, '/api/conversation-folders/jobs/classify-fixture/undo');
  assert.equal(contextMenu(f.render()).props.items[1].disabled, true);
  f.h.unmount();
});

test('running job survives reload and an applied job restores undo without repeating its result toast', async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  const storage = new Map<string, string>();
  let completed = false;
  const api = async (path: string, _body?: unknown, method?: string) => {
    calls.push({ path, method });
    return job(completed ? 'applied' : 'running');
  };
  const first = fixture(api, storage);
  clickOrganize(first.render());
  await nextTurn();
  first.render();
  assert.equal(storage.get('pugport-chat-organize-running'), job().id);
  first.h.unmount();
  assert.equal(first.intervals.size, 0);
  completed = true;
  const resumed = fixture(api, storage);
  resumed.render();
  await nextTurn();
  resumed.render();
  assert.equal(resumed.notices.length, 1);
  assert.equal(resumed.notices[0]?.action?.label, '撤销');
  assert.equal(storage.has('pugport-chat-organize-running'), false);
  // The toast was made while the reload's resume id was still set; its Undo must still work.
  await resumed.notices[0]?.action?.run();
  assert.ok(calls.some((call) => call.path.endsWith('/classify-fixture/undo')));
  completed = true;
  resumed.h.unmount();
  const reopened = fixture(api, storage);
  reopened.render();
  await nextTurn();
  button(reopened.render(), '整理对话').props.onContextMenu({ clientX: 0, clientY: 0, preventDefault() {} });
  assert.equal(contextMenu(reopened.render()).props.items[1].disabled, false);
  assert.equal(reopened.notices.length, 0);
  assert.equal(calls.filter((call) => call.path.endsWith('/classify')).length, 1);
  assert.ok(calls.slice(1).every((call) => call.method === 'GET' || call.path.endsWith('/undo')));
  reopened.h.unmount();
});

test('a stale poll cannot overwrite cancellation', async () => {
  let finishPoll: ((value: ClassificationJob) => void) | undefined;
  const f = fixture(async (path) => {
    if (path.endsWith('/classify')) return job('running');
    if (path.endsWith('/cancel')) return job('cancelled');
    return new Promise<ClassificationJob>((resolve) => {
      finishPoll = resolve;
    });
  });
  clickOrganize(f.render());
  await nextTurn();
  f.render();
  for (const tick of f.intervals.values()) tick();
  await nextTurn();
  assert.ok(finishPoll);
  await f.notices.at(-1)?.action?.run();
  f.render();
  assert.equal(f.notices.at(-1)?.message, '已停止整理。');
  finishPoll!(job('applied'));
  await nextTurn();
  const tree = f.render();
  assert.ok(!findNode(tree, (node) => node.props.className === 'spinning'));
  assert.equal(
    f.notices.some((notice) => notice.action?.label === '撤销'),
    false,
  );
  assert.equal(f.intervals.size, 0);
  assert.equal(f.storage.size, 0);
  f.h.unmount();
});

test('duplicate clicks during creation do not post twice and Stop cancels after the job id arrives', async () => {
  let finish: ((value: ClassificationJob) => void) | undefined;
  const calls: string[] = [];
  const f = fixture(async (path) => {
    calls.push(path);
    if (path.endsWith('/cancel')) return job('cancelled');
    return new Promise<ClassificationJob>((resolve) => {
      finish = resolve;
    });
  });
  clickOrganize(f.render());
  clickOrganize(f.render());
  assert.equal(calls.length, 1);
  assert.equal(f.notices.at(-1)?.tone, 'info');
  await f.notices.at(-1)?.action?.run();
  finish!(job('running'));
  await nextTurn();
  f.render();
  assert.deepEqual(calls, [
    '/api/conversation-folders/classify',
    '/api/conversation-folders/jobs/classify-fixture/cancel',
  ]);
  assert.equal(f.notices.at(-1)?.message, '已停止整理。');
  f.h.unmount();
});

test('empty results are informational and completion omits zero counts', async () => {
  let result = { ...job(), changed: 0, renamed: 0, createdFolders: 0 };
  const f = fixture(async () => result);
  clickOrganize(f.render());
  await nextTurn();
  assert.deepEqual(plain(f.notices.at(-1)), { tone: 'info', message: '对话已经很整齐了。' });
  // An organize that changed nothing never becomes the target of 撤销上次整理.
  assert.equal(f.storage.has('pugport-chat-classification-last-applied'), false);
  result = { ...job(), id: 'second', changed: 1, renamed: 1, createdFolders: 0 };
  clickOrganize(f.render());
  await nextTurn();
  assert.equal(f.notices.at(-1)?.message, '已整理 1 个对话 · 已重命名 1 个');
  result = { ...job(), id: 'third', changed: 2, renamed: 0, createdFolders: 0 };
  clickOrganize(f.render());
  await nextTurn();
  assert.equal(f.notices.at(-1)?.message, '已整理 2 个对话');
  f.h.unmount();
});

test('failure shows the server message and a lost create response is not resent on reload', async () => {
  const storage = new Map<string, string>();
  let requests = 0;
  const api = async () => {
    requests++;
    throw Error('服务器连接中断');
  };
  const f = fixture(api, storage);
  clickOrganize(f.render());
  await nextTurn();
  assert.deepEqual(plain(f.notices.at(-1)), { tone: 'error', message: '服务器连接中断' });
  assert.equal(storage.size, 0);
  f.h.unmount();
  const reopened = fixture(api, storage);
  reopened.render();
  await nextTurn();
  assert.equal(requests, 1);
  reopened.h.unmount();
  const failed = fixture(async () => ({ ...job('failed'), error: '模型返回格式无效' }));
  clickOrganize(failed.render());
  await nextTurn();
  assert.deepEqual(plain(failed.notices.at(-1)), { tone: 'error', message: '模型返回格式无效' });
  assert.equal(failed.storage.size, 0);
  failed.h.unmount();
});

test('a transient restore failure keeps polling the saved job without another classify request', async () => {
  const storage = new Map([['pugport-chat-organize-running', 'classify-fixture']]);
  const paths: string[] = [];
  let failed = true;
  const f = fixture(async (path) => {
    paths.push(path);
    if (failed) throw Error('Connection unavailable');
    return job('running');
  }, storage);
  f.render();
  await nextTurn();
  assert.equal(storage.size, 1);
  clickOrganize(f.render());
  assert.equal(paths.length, 1);
  assert.equal(f.notices.at(-1)?.tone, 'info');
  failed = false;
  for (const tick of f.intervals.values()) tick();
  await nextTurn();
  f.render();
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => path.endsWith('/jobs/classify-fixture')));
  assert.equal(f.notices.at(-1)?.action?.label, '停止');
  f.h.unmount();
});

test('opening the organize menu retries a transient last-applied restore failure', async () => {
  const storage = new Map([['pugport-chat-classification-last-applied', 'classify-fixture']]);
  let attempts = 0;
  const f = fixture(async (path) => {
    assert.equal(path, '/api/conversation-folders/jobs/classify-fixture');
    if (++attempts === 1) throw Error('Connection unavailable');
    return job('applied');
  }, storage);
  f.render();
  await nextTurn();
  assert.equal(storage.size, 1);
  button(f.render(), '整理对话').props.onContextMenu({ clientX: 0, clientY: 0, preventDefault() {} });
  await nextTurn();
  assert.equal(contextMenu(f.render()).props.items[1].disabled, false);
  assert.equal(attempts, 2);
  assert.equal(f.notices.length, 0);
  f.h.unmount();
});

test('an earlier undo cannot replace a pending or running organize job', async () => {
  const paths: string[] = [];
  let starts = 0;
  let finishStart: ((value: ClassificationJob) => void) | undefined;
  const nextJob = (status: ClassificationJob['status']) => ({ ...job(status), id: 'classify-second' });
  const f = fixture(async (path) => {
    paths.push(path);
    if (path.endsWith('/classify')) {
      if (++starts === 1) return job('applied');
      return new Promise<ClassificationJob>((resolve) => {
        finishStart = resolve;
      });
    }
    assert.equal(path, '/api/conversation-folders/jobs/classify-second');
    return nextJob('applied');
  });
  clickOrganize(f.render());
  await nextTurn();
  const earlierUndo = f.notices.at(-1)!.action!.run;
  clickOrganize(f.render());
  await earlierUndo();
  assert.equal(paths.length, 2, 'stale undo is ignored while the next job is being created');
  finishStart!(nextJob('running'));
  await nextTurn();
  button(f.render(), '整理对话').props.onContextMenu({ clientX: 0, clientY: 0, preventDefault() {} });
  const undoItem = contextMenu(f.render()).props.items[1];
  assert.equal(undoItem.disabled, true);
  await earlierUndo();
  undoItem.onSelect();
  await nextTurn();
  f.render();
  assert.equal(paths.length, 2, 'stale undo callbacks cannot send an undo request while a job runs');
  assert.equal(f.storage.get('pugport-chat-organize-running'), 'classify-second');
  assert.equal(f.intervals.size, 1);
  for (const tick of f.intervals.values()) tick();
  await nextTurn();
  f.render();
  assert.equal(f.storage.has('pugport-chat-organize-running'), false);
  assert.equal(f.storage.get('pugport-chat-classification-last-applied'), 'classify-second');
  assert.equal(f.notices.at(-1)?.action?.label, '撤销');
  assert.ok(!paths.some((path) => path.endsWith('/undo')));
  f.h.unmount();
});
