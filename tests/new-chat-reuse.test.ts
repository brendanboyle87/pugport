import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Studio.tsx', true);
});
const stamp = '2026-10-25T12:00:00Z';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
function fixture() {
  const projects: any[] = ['p', 'q', 'chat'].map((id) => ({
    id,
    name: id,
    scope: id === 'chat' ? 'chat' : 'project',
    path: 'C:/Synthetic',
    createdAt: stamp,
    updatedAt: stamp,
  }));
  const old: any = { id: 'old', projectId: 'p', title: 'Empty old chat', createdAt: stamp, updatedAt: stamp };
  const state: any = {
    app: { version: 'fixture' },
    projects,
    conversations: [old],
    conversationMessages: [],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    settings: {},
  };
  const calls: any[] = [],
    saved = new Map<string, any>();
  let post: ReturnType<typeof deferred<any>> | undefined, read: ReturnType<typeof deferred<any>> | undefined;
  let createError = false,
    readError = false;
  const listeners = new Map<string, Set<(event: any) => void>>();
  const api = async (path: string, body?: any, method = 'POST') => {
    calls.push({ path, body, method });
    if (path === '/api/modes') return { catalog: [], installed: [] };
    if (path === '/api/conversations' && method === 'POST') {
      if (createError) {
        createError = false;
        throw Error('Synthetic create failure');
      }
      const id = `new-${calls.filter((call) => call.path === path).length}`;
      const conversation = {
        id,
        projectId: body.projectId ?? 'chat',
        title: 'A deliberately renamed empty chat',
        createdAt: stamp,
        updatedAt: stamp,
        ...(body.incognito ? { incognito: true } : {}),
      };
      const result = post ? await post.promise : conversation;
      saved.set(result.id, { conversation: result, messages: [], workflows: [] });
      return result;
    }
    const id = path.split('/')[3];
    if (method === 'GET' && saved.has(id)) {
      if (readError) {
        readError = false;
        throw Error('Synthetic read failure');
      }
      return read ? await read.promise : saved.get(id);
    }
    if (method === 'PATCH' && saved.has(id)) {
      Object.assign(saved.get(id).conversation, body);
      return saved.get(id).conversation;
    }
    throw Error(`Unexpected API ${method} ${path}`);
  };
  const h = uiHarness(code, {
    __backend: { state, api, reload: async () => {}, connection: 'connected' },
    localStorage: {
      getItem: (key: string) =>
        key === 'agent-studio-conversation' ? 'old' : key === 'agent-studio-project' ? 'p' : null,
      setItem() {},
    },
    window: {
      addEventListener(name: string, fn: any) {
        let set = listeners.get(name);
        if (!set) listeners.set(name, (set = new Set()));
        set.add(fn);
      },
      removeEventListener(name: string, fn: any) {
        listeners.get(name)?.delete(fn);
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  const render = () => h.render('default');
  const workspace = () => {
    const tree = render();
    const split = findNode(tree, (node) => node.type?.name === 'SplitView');
    return split
      ? split.props.children(split.props.ids[0], 0)
      : findNode(tree, (node) => node.type?.name === 'ConversationWorkspace');
  };
  const session = () => workspace()!.props.composerSession;
  const button = (kind = 'ordinary') => {
    const tree = render();
    if (kind === 'ordinary') return findNode(tree, (node) => node.props.className === 'new-conversation-button')!;
    if (kind === 'private') return findNode(tree, (node) => node.props['aria-label'] === '新建隐身对话')!;
    return findNode(
      findNode(tree, (node) => node.props.className?.includes('sidebar-project') && node.key === kind),
      (node) => node.props.className?.includes('project-new'),
    )!;
  };
  const click = async (kind = 'ordinary') => {
    button(kind).props.onClick();
    await nextTurn();
  };
  const key = async (key: string) => {
    for (const fn of [...(listeners.get('keydown') ?? [])])
      fn({
        key,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: { tagName: 'DIV' },
        preventDefault() {},
      });
    await nextTurn();
  };
  const posts = () => calls.filter((call) => call.path === '/api/conversations').length;
  return {
    h,
    state,
    old,
    saved,
    calls,
    render,
    workspace,
    session,
    button,
    click,
    key,
    posts,
    holdPost: () => (post = deferred<any>()),
    holdRead: () => (read = deferred<any>()),
    releaseRead: () => (read = undefined),
    failCreate: () => (createError = true),
    failRead: () => (readError = true),
  };
}

test('repeated pending and confirmed New actions reuse only the current newly created blank chat', async () => {
  const f = fixture();
  const pending = f.holdPost();
  const button = f.button();
  button.props.onClick();
  button.props.onClick();
  await nextTurn();
  assert.equal(f.posts(), 1);
  const created = {
    id: 'new-1',
    projectId: 'chat',
    title: 'Renamed independently',
    createdAt: stamp,
    updatedAt: stamp,
    appliedSkills: ['skill'],
    routingRule: { mode: 'manual' },
  };
  pending.resolve(created);
  await nextTurn();
  // The old callback runs again before a React render: the synchronous selected ref still owns this chat.
  button.props.onClick();
  await nextTurn();
  assert.equal(f.posts(), 1);
  assert.equal(f.workspace()!.props.conversation.id, 'new-1');
  assert.deepEqual(JSON.parse(JSON.stringify(f.workspace()!.props.conversation.appliedSkills)), ['skill']);
  await f.key('n');
  await f.key('k');
  const palette = findNode(f.render(), (node) => node.type?.name === 'CommandPalette')!;
  palette.props.entries.find((entry: any) => entry.id === 'new').run();
  await nextTurn();
  assert.equal(f.posts(), 1, 'keyboard and command palette share the same reuse guard');
  assert.equal(f.calls.filter((call) => call.method === 'DELETE' || call.path.includes('/messages')).length, 0);
  f.h.unmount();
});

test('project, ordinary and private entry points retain separate context', async () => {
  const f = fixture();
  await f.click('p');
  await f.click('p');
  assert.equal(f.posts(), 1);
  await f.click('q');
  assert.equal(f.posts(), 2);
  assert.equal(f.workspace()!.props.conversation.projectId, 'q');
  await f.click();
  assert.equal(f.posts(), 3);
  assert.equal(f.workspace()!.props.conversation.projectId, 'chat');
  await f.click('private');
  assert.equal(f.posts(), 4);
  await f.click('private');
  assert.equal(f.posts(), 4);
  assert.equal(
    f.calls.some((call) => call.path.endsWith('/close-incognito')),
    false,
    'reopening the same empty private chat does not leave or delete it',
  );
  f.h.unmount();
});

test('text, attachment, quote, writer and saved-draft aliases preserve their original chat', async () => {
  for (const patch of [
    { content: 'Keep my text' },
    { attachments: [{ id: 'file', name: 'fixture.txt' }] },
    { quotes: [{ id: 'quote', text: 'Quoted' }] },
    { writer: { runtimeId: 'r', label: 'Writer' } },
    { content: 'Aliased settings draft', alias: true },
  ]) {
    const f = fixture();
    await f.click();
    const session = f.session();
    const scope = 'alias' in patch ? 'new:chat' : 'conversation:new-1';
    session.changeDraft(scope, (draft: any) => ({
      ...draft,
      ...patch,
      ...('alias' in patch ? { createdConversation: f.saved.get('new-1').conversation } : {}),
    }));
    const before = JSON.stringify(session.getSnapshot());
    await f.click();
    assert.equal(f.posts(), 2, JSON.stringify(patch));
    assert.equal(JSON.stringify(session.getSnapshot()), before);
    f.h.unmount();
  }
  const f = fixture();
  await f.click();
  f.session().changeDraft('conversation:unrelated', (draft: any) => ({ ...draft, content: 'Other chat' }));
  await f.click();
  assert.equal(f.posts(), 1, 'unrelated hidden drafts never block this current blank chat');
  f.h.unmount();
});

test('pending sends remain nonempty even with an error, ACK or only a created-conversation alias', async () => {
  for (const extra of [
    { error: 'retry me' },
    { messageId: 'acked' },
    { scope: 'new:chat', conversationId: undefined, alias: true },
  ]) {
    const f = fixture();
    await f.click();
    const session = f.session();
    session.changePending(() => [
      {
        id: 'send',
        scope: 'conversation:new-1',
        conversationId: 'new-1',
        content: 'Pending',
        images: [],
        quotes: [],
        sentAt: stamp,
        snapshot: {
          content: 'Pending',
          attachments: [],
          ...('alias' in extra ? { createdConversation: f.saved.get('new-1').conversation } : {}),
        },
        ...extra,
      },
    ]);
    const before = JSON.stringify(session.getSnapshot());
    await f.click();
    assert.equal(f.posts(), 2);
    assert.equal(JSON.stringify(session.getSnapshot()), before);
    f.h.unmount();
  }
});

test('durable history, workflow history, Mod work and changed lifecycle flags never qualify as blank', async () => {
  for (const mutate of [
    (value: any) => value.messages.push({ id: 'message' }),
    (value: any) => value.workflows.push({ id: 'workflow' }),
    ...[
      { workflowHistoryRevision: 1 },
      { modeBinding: { modeId: 'notes', version: '1', instanceId: 'i' } },
      { pendingModeBinding: { binding: null } },
      { archivedAt: stamp },
      { closedAt: stamp },
      { swarm: true },
    ].map((patch) => (value: any) => Object.assign(value.conversation, patch)),
  ]) {
    const f = fixture();
    await f.click();
    mutate(f.saved.get('new-1'));
    await f.click();
    assert.equal(f.posts(), 2);
    f.h.unmount();
  }
});

test('late empty proofs cannot steal navigation, write after unmount or overlook a new draft', async () => {
  const f = fixture();
  await f.click();
  const held = f.holdRead();
  f.button().props.onClick();
  f.button().props.onClick();
  await nextTurn();
  assert.equal(f.calls.filter((call) => call.method === 'GET').length, 1);
  const other = findNode(
    f.render(),
    (node) => node.props.className?.startsWith('conversation-link') && node.props.title?.startsWith('Empty old chat'),
  )!;
  await other.props.onClick({});
  held.resolve(f.saved.get('new-1'));
  await nextTurn();
  assert.equal(f.workspace()!.props.conversation.id, 'old');
  assert.equal(f.posts(), 1);
  f.h.unmount();
  const gone = fixture();
  await gone.click();
  const delayed = gone.holdRead();
  gone.button().props.onClick();
  await nextTurn();
  gone.h.unmount();
  delayed.resolve(gone.saved.get('new-1'));
  await nextTurn();
  assert.equal(gone.posts(), 1);
  const draft = fixture();
  await draft.click();
  const pending = draft.holdRead();
  draft.button().props.onClick();
  await nextTurn();
  draft.session().changeDraft('conversation:new-1', (value: any) => ({ ...value, content: 'Entered during proof' }));
  pending.resolve(draft.saved.get('new-1'));
  await nextTurn();
  assert.equal(draft.posts(), 2);
  assert.equal(draft.session().getSnapshot().drafts['conversation:new-1'].content, 'Entered during proof');
  draft.h.unmount();
});

test('failed creation releases its lock and a failed empty proof does not create a duplicate', async () => {
  const f = fixture();
  f.failCreate();
  await f.click();
  await f.click();
  assert.equal(f.posts(), 2);
  assert.equal(f.workspace()!.props.conversation.id, 'new-2');
  f.failRead();
  await f.click();
  assert.equal(f.posts(), 2);
  await f.click();
  assert.equal(f.posts(), 2);
  f.h.unmount();
});
