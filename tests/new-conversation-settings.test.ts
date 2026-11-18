import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const stamp = '2026-10-24T12:00:00Z';
const project = (id = 'project') => ({ id, name: id, path: 'C:/Synthetic', createdAt: stamp, updatedAt: stamp });
const conversation = (id = 'created', projectId = 'project') => ({
  id,
  projectId,
  title: id,
  createdAt: stamp,
  updatedAt: stamp,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function mount(api: any, selectedProject: any = project(), selectedConversation: any = undefined) {
  const composerSession = new ComposerSession();
  const harness = uiHarness(code);
  const notices: unknown[] = [],
    selected: any[] = [];
  let memoryCalls = 0;
  const props = {
    api,
    composerSession,
    project: selectedProject,
    conversation: selectedConversation,
    state: {
      app: { version: 'fixture' },
      projects: [project(), project('other')],
      conversations: selectedConversation ? [selectedConversation] : [],
      conversationMessages: [],
      workflows: [],
      runs: [],
      targets: [],
      runtimes: [],
      approvals: [],
      plugins: [],
      settings: {},
    },
    notify: (notice: unknown) => notices.push(notice),
    onConversation: (value: unknown) => selected.push(value),
    onMemory: () => memoryCalls++,
    onAddProject() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  const settings = () => findNode(render(), (node) => node.props['aria-label'] === '对话设置')!;
  const panel = () => findNode(render(), (node) => node.type?.name === 'ConversationPanel');
  const input = () => findNode(render(), (node) => node.type === 'textarea' && node.props.id === 'conversation-input')!;
  return {
    props,
    harness,
    composerSession,
    notices,
    selected,
    render,
    settings,
    panel,
    input,
    memoryCalls: () => memoryCalls,
    type: (value: string) => input().props.onChange({ target: { value } }),
    submit: () =>
      findNode(
        render(),
        (node) => node.type === 'form' && node.props.className.includes('conversation-composer'),
      )!.props.onSubmit({ preventDefault() {} }),
  };
}
const read = { messages: [], workflows: [] };

test('new-chat settings create once, retain edited drafts and reuse that conversation for the first message', async () => {
  const create = deferred<any>(),
    calls: any[] = [];
  const view = mount(async (path: string, body: any, method = 'POST') => {
    calls.push({ path, body, method });
    if (path === '/api/conversations') return create.promise;
    if (path.endsWith('/messages'))
      return {
        message: { id: 'message', conversationId: 'created', role: 'user', content: body.content, createdAt: stamp },
      };
    return read;
  });
  view.type('Draft before opening');
  view.settings().props.onClick();
  view.settings().props.onClick();
  view.settings().props.onClick();
  assert.equal(calls.filter((item) => item.path === '/api/conversations').length, 1);
  assert.equal(view.memoryCalls(), 0, 'empty chats use the same settings panel as existing chats');
  view.type('Edited while creating');
  create.resolve(conversation());
  await nextTurn();
  assert.equal(view.panel()?.props.tab, 'routing');
  assert.equal(view.panel()?.props.conversation.id, 'created');
  assert.equal(view.input().props.value, 'Edited while creating');
  assert.equal(view.settings().props['aria-pressed'], true);
  assert.match(text(view.render()), /路由规则、Skills 和项目记忆/);
  view.settings().props.onClick();
  assert.equal(view.panel(), undefined);
  view.settings().props.onClick();
  assert.equal(view.panel()?.props.conversation.id, 'created');
  view.submit();
  await nextTurn();
  assert.equal(calls.filter((item) => item.path === '/api/conversations').length, 1);
  assert.equal(
    calls.find((item) => item.path === '/api/conversations/created/messages')?.body.content,
    'Edited while creating',
  );
  assert.equal(view.selected[0]?.id, 'created');
  view.harness.unmount();
});

test('sending while new-chat settings are creating waits for and uses the same saved conversation', async () => {
  const create = deferred<any>(),
    writes: string[] = [];
  const view = mount(async (path: string, body: any, method = 'POST') => {
    if (method !== 'GET') writes.push(path);
    if (path === '/api/conversations') return create.promise;
    if (path.endsWith('/messages'))
      return {
        message: { id: 'message', conversationId: 'created', role: 'user', content: body.content, createdAt: stamp },
      };
    return read;
  });
  view.type('Keep this first message');
  view.settings().props.onClick();
  view.submit();
  await nextTurn();
  assert.deepEqual(writes, ['/api/conversations']);
  create.resolve(conversation());
  await nextTurn();
  assert.deepEqual(writes, ['/api/conversations', '/api/conversations/created/messages']);
  assert.equal(view.selected[0]?.id, 'created');
  view.harness.unmount();
});

test('project changes isolate pending settings creation and do not discard either project draft', async () => {
  const first = deferred<any>(),
    second = deferred<any>(),
    creates: any[] = [];
  const view = mount(async (path: string, body: any) => {
    if (path !== '/api/conversations') return read;
    creates.push(body);
    return body.projectId === 'project' ? first.promise : second.promise;
  });
  view.type('First project draft');
  view.settings().props.onClick();
  view.props.project = project('other');
  view.type('Other project draft');
  view.settings().props.onClick();
  first.resolve(conversation('first'));
  await nextTurn();
  assert.equal(view.panel(), undefined, 'the first project response cannot open the other project panel');
  second.resolve(conversation('second', 'other'));
  await nextTurn();
  assert.equal(view.panel()?.props.conversation.id, 'second');
  assert.equal(view.input().props.value, 'Other project draft');
  view.props.project = project();
  assert.equal(view.panel(), undefined, 'navigation closes the previous settings panel');
  assert.equal(view.input().props.value, 'First project draft');
  view.settings().props.onClick();
  assert.equal(view.panel()?.props.conversation.id, 'first');
  assert.equal(creates.length, 2);
  assert.equal(view.notices.length, 0);
  view.harness.unmount();
});

test('leaving and returning before creation resolves does not reopen an abandoned settings request', async () => {
  const create = deferred<any>();
  const view = mount(async (path: string) => (path === '/api/conversations' ? create.promise : read));
  view.settings().props.onClick();
  view.props.project = project('other');
  view.render();
  view.props.project = project();
  view.render();
  create.resolve(conversation());
  await nextTurn();
  assert.equal(view.panel(), undefined);
  view.settings().props.onClick();
  assert.equal(view.panel()?.props.conversation.id, 'created');
  view.harness.unmount();
});

test('unmount preserves an in-flight settings-created chat in the window draft without opening or notifying', async () => {
  const create = deferred<any>();
  let creates = 0;
  const view = mount(async (path: string) => {
    if (path !== '/api/conversations') return read;
    creates++;
    return create.promise;
  });
  view.type('Retain across pane replacement');
  view.settings().props.onClick();
  view.harness.unmount();
  create.resolve(conversation());
  await nextTurn();
  assert.equal(view.composerSession.getSnapshot().drafts['new:project']?.createdConversation?.id, 'created');
  assert.equal(view.composerSession.getSnapshot().drafts['new:project']?.content, 'Retain across pane replacement');
  assert.equal(view.notices.length, 0);
  view.harness.remount();
  assert.equal(view.panel(), undefined);
  view.settings().props.onClick();
  assert.equal(view.panel()?.props.conversation.id, 'created');
  assert.equal(creates, 1);
  view.harness.unmount();
});

test('remounting a pane before creation resolves shares its pending request and cannot replace the saved chat', async () => {
  const create = deferred<any>();
  let creates = 0;
  const view = mount(async (path: string) => {
    if (path !== '/api/conversations') return read;
    creates++;
    return create.promise;
  });
  view.type('Original pane draft');
  view.settings().props.onClick();
  view.harness.remount();
  view.type('Edited in replacement pane');
  view.settings().props.onClick();
  view.settings().props.onClick();
  assert.equal(creates, 1, 'the window draft owns the pending creation across pane mounts');
  create.resolve(conversation('shared-created'));
  await nextTurn();
  assert.equal(view.panel()?.props.conversation.id, 'shared-created');
  assert.equal(view.composerSession.getSnapshot().drafts['new:project']?.createdConversation?.id, 'shared-created');
  assert.equal(view.input().props.value, 'Edited in replacement pane');
  assert.equal(view.notices.length, 0);
  view.harness.unmount();
});

test('new standalone settings failures retain the draft and can retry, while existing-chat toggles create nothing', async () => {
  let attempts = 0;
  const view = mount(async (path: string) => {
    if (path !== '/api/conversations') return read;
    if (++attempts === 1) throw new Error('Synthetic create failure');
    return conversation('standalone', 'chat');
  }, undefined);
  view.props.project = undefined;
  view.type('Do not lose this draft');
  view.settings().props.onClick();
  await nextTurn();
  assert.equal(view.panel(), undefined);
  assert.equal(view.notices.length, 1);
  assert.equal(view.input().props.value, 'Do not lose this draft');
  view.settings().props.onClick();
  await nextTurn();
  assert.equal(view.panel()?.props.conversation.id, 'standalone');
  assert.equal(attempts, 2);
  assert.match(text(view.render()), /路由规则、Skills 和对话记忆/);
  view.props.conversation = conversation('existing');
  view.render();
  assert.equal(view.panel(), undefined);
  view.settings().props.onClick();
  assert.equal(view.panel()?.props.conversation.id, 'existing');
  view.panel()?.props.onTab('memory');
  assert.equal(view.panel()?.props.tab, 'memory');
  view.settings().props.onClick();
  assert.equal(view.panel(), undefined);
  assert.equal(attempts, 2, 'existing chats never create a new draft conversation');
  view.harness.unmount();
});
