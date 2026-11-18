import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';
let code: string;
before(async () => {
  code = await uiBundle('tests/helpers/studio-confirmation-fixture.ts', true);
});
const stamp = '2026-10-25T12:00:00Z';
const binding = { instanceId: 'saved-instance', modeId: 'fixture.notes', version: '1.0.0' };
const notes = {
  schemaVersion: 1,
  id: binding.modeId,
  version: binding.version,
  title: 'Synthetic notes',
  description: 'Synthetic',
  icon: 'book-open',
  compatible: true,
};
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: unknown) => void;
  return {
    promise: new Promise<any>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve,
    reject,
  };
}
function fixture(
  options: { queued?: boolean; pendingOnly?: boolean; incognito?: boolean; reloadFailure?: boolean } = {},
) {
  const project = {
    id: 'p',
    name: 'Project',
    scope: 'project',
    path: 'C:/Synthetic',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const conversation: any = {
    id: 'a',
    projectId: 'p',
    title: 'Parent A',
    ...(options.incognito ? { incognito: true } : {}),
    modeBinding: options.pendingOnly ? undefined : binding,
    ...(options.pendingOnly ? { pendingModeBinding: { binding, afterWorkflowId: 'run', requestedAt: stamp } } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  };
  const other: any = {
    ...conversation,
    id: 'b',
    title: 'Parent B',
    modeBinding: undefined,
    pendingModeBinding: undefined,
  };
  const state: any = {
    app: { version: 'fixture' },
    projects: [project],
    conversations: [conversation, other],
    conversationMessages: [{ id: 'message', conversationId: 'a', content: 'Saved message' }],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    settings: {},
  };
  const saved = { id: 'saved-instance', state: { note: 'Saved content' } };
  const calls: any[] = [];
  let reloads = 0,
    held: ReturnType<typeof deferred> | undefined,
    firstReload: ReturnType<typeof deferred> | undefined,
    failing = false;
  const api = async (path: string, body?: any, method = 'POST') => {
    calls.push({ path, body, method });
    if (path === '/api/modes')
      return { catalog: [notes], installed: [{ modeId: notes.id, version: notes.version, installedAt: stamp }] };
    assert.equal(path, '/api/conversations/a/mode');
    assert.equal(method, 'PUT');
    if (failing) throw Error('Synthetic remove failure');
    if (held) return held.promise;
    if (body.modeId === null) {
      assert.equal(body.expectedInstanceId, binding.instanceId);
      if (options.queued)
        conversation.pendingModeBinding = { binding: null, afterWorkflowId: 'running', requestedAt: stamp };
      else {
        delete conversation.modeBinding;
        delete conversation.pendingModeBinding;
      }
    } else {
      assert.equal(body.modeId, binding.modeId);
      assert.equal(body.version, binding.version);
      assert.equal(body.restoreInstanceId, binding.instanceId);
      conversation.modeBinding = binding;
      delete conversation.pendingModeBinding;
    }
    return {
      binding: conversation.modeBinding ?? null,
      pending: conversation.pendingModeBinding ?? null,
      instance: saved,
      manifest: null,
      installed: true,
    };
  };
  const h = uiHarness(code, {
    __backend: {
      state,
      api,
      reload: async () => {
        reloads++;
        if (firstReload && reloads === 1) await firstReload.promise;
        if (options.reloadFailure && reloads === 1) throw new Error('Synthetic list refresh failure');
      },
      connection: 'connected',
    },
    localStorage: { getItem: (key: string) => (key === 'agent-studio-conversation' ? 'a' : null), setItem() {} },
  });
  const render = () => h.render('default');
  const row = () =>
    findNode(
      render(),
      (node) =>
        node.props.className === 'conversation-row' &&
        !!findNode(node, (child) => child.props['data-conversation-id'] === 'a'),
    )!;
  const menu = () => findNode(render(), (node) => node.type?.name === 'ContextMenu')!;
  const workspace = () => {
    const split = findNode(render(), (node) => node.type?.name === 'SplitView')!;
    return split.props.children(split.props.ids[0], 0);
  };
  const open = () => {
    let prevented = false;
    row().props.onContextMenu({
      type: 'contextmenu',
      clientX: 40,
      clientY: 60,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    return menu().props.items.find((item: any) => item.label === '从此对话移除 Mod');
  };
  const parent = async (id: string) => {
    await findNode(render(), (node) => node.props['data-conversation-id'] === id)!.props.onClick({});
  };
  return {
    h,
    render,
    row,
    menu,
    workspace,
    open,
    parent,
    conversation,
    state,
    saved,
    calls,
    store: h.exports.confirmationStore,
    notice: () => findNode(render(), (node) => node.type?.name === 'NoticeToast')?.props.notice,
    reloads: () => reloads,
    hold: () => (held = deferred()),
    holdReload: () => (firstReload = deferred()),
    fail: (value = true) => {
      failing = value;
    },
  };
}

test('sidebar remove acts immediately without confirmation and Undo restores the exact saved Mod', async () => {
  const f = fixture();
  const item = f.open();
  assert.ok(item);
  item.onSelect();
  item.onSelect();
  assert.equal(f.store.snapshot(), undefined);
  await nextTurn();
  const writes = f.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(structuredClone(writes[0].body), { modeId: null, expectedInstanceId: binding.instanceId });
  assert.equal(f.conversation.modeBinding, undefined);
  assert.equal(f.workspace().props.conversation.id, 'a');
  assert.equal(f.saved.state.note, 'Saved content');
  assert.equal(f.state.conversationMessages[0].content, 'Saved message');
  assert.equal(f.notice().action.label, '撤销');
  const undo = f.notice().action.run;
  await undo();
  await undo();
  assert.equal(f.conversation.modeBinding, binding);
  assert.equal(f.calls.filter((call) => call.method === 'PUT').length, 2, 'Undo is single use');
  assert.equal(f.reloads(), 2);
  f.h.unmount();
});

test('panel removal callback shares the immediate remove and Undo path', async () => {
  const f = fixture();
  assert.equal(typeof f.workspace().props.onRemoveMod, 'function');
  f.workspace().props.onRemoveMod();
  await nextTurn();
  assert.equal(f.store.snapshot(), undefined);
  assert.equal(f.conversation.modeBinding, undefined);
  await f.notice().action.run();
  assert.equal(f.conversation.modeBinding, binding);
  f.h.unmount();
});

test('queued removal preserves the binding until the task barrier and can be undone', async () => {
  const f = fixture({ queued: true });
  f.open().onSelect();
  await nextTurn();
  assert.equal(f.conversation.modeBinding, binding);
  assert.equal(f.conversation.pendingModeBinding.binding, null);
  assert.match(f.notice().message, /当前任务结束后/);
  await f.notice().action.run();
  assert.equal(f.conversation.modeBinding, binding);
  assert.equal(f.conversation.pendingModeBinding, undefined);
  f.h.unmount();
});

test('pending-only attachment can be removed and its exact version restored', async () => {
  const f = fixture({ pendingOnly: true });
  f.open().onSelect();
  await nextTurn();
  assert.equal(f.conversation.pendingModeBinding, undefined);
  assert.equal(f.conversation.modeBinding, undefined);
  await f.notice().action.run();
  assert.equal(f.conversation.modeBinding, binding);
  f.h.unmount();
});

test('row keyboard menu exposes the same remove action', () => {
  const f = fixture();
  let prevented = false,
    stopped = false;
  f.row().props.onKeyDown({
    key: 'ContextMenu',
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    target: { getBoundingClientRect: () => ({ left: 10, bottom: 30 }) },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.ok(f.menu().props.items.find((item: any) => item.label === '从此对话移除 Mod'));
  f.h.unmount();
});

test('late removal responses never navigate away from a newer selection', async () => {
  const f = fixture();
  const held = f.hold();
  f.open().onSelect();
  await f.parent('b');
  held.resolve({ binding: null, pending: null, instance: null, manifest: null, installed: false });
  await nextTurn();
  assert.equal(f.workspace().props.conversation.id, 'b');
  f.h.unmount();
});

test('failed removal keeps the Mod, allows retry, and unmount suppresses a late toast', async () => {
  const f = fixture();
  f.fail();
  f.open().onSelect();
  await nextTurn();
  assert.equal(f.conversation.modeBinding, binding);
  assert.equal(f.notice().message, '没能完成，请重试。');
  f.fail(false);
  f.open().onSelect();
  await nextTurn();
  assert.equal(f.conversation.modeBinding, undefined);
  f.h.unmount();
  const gone = fixture();
  const held = gone.hold();
  gone.open().onSelect();
  gone.h.unmount();
  held.resolve({ binding: null, pending: null, instance: null, manifest: null, installed: false });
  await nextTurn();
  assert.equal(gone.reloads(), 0);
});

test('an attached project incognito chat has immediate sidebar removal and Undo without confirmation', async () => {
  const f = fixture({ incognito: true });
  const item = f.open();
  assert.ok(item, 'incognito row retains the Mod removal action');
  item.onSelect();
  assert.equal(f.store.snapshot(), undefined);
  await nextTurn();
  assert.equal(f.conversation.modeBinding, undefined);
  assert.equal(f.conversation.incognito, true);
  assert.equal(f.state.conversationMessages[0].content, 'Saved message');
  assert.equal(f.notice().action.label, '撤销');
  await f.notice().action.run();
  assert.equal(f.conversation.modeBinding, binding);
  assert.equal(f.saved.state.note, 'Saved content');
  assert.equal(f.calls.filter((call) => call.method === 'PUT').length, 2);
  assert.equal(f.store.snapshot(), undefined);
  f.h.unmount();
});

test('a failed list refresh after removal preserves the Undo action', async () => {
  const f = fixture({ reloadFailure: true });
  f.open().onSelect();
  await nextTurn();
  assert.equal(f.conversation.modeBinding, undefined, 'the binding write already succeeded');
  assert.equal(f.reloads(), 1);
  assert.equal(f.notice().action?.label, '撤销', 'refresh failure must not replace the removal toast');
  await f.notice().action.run();
  assert.equal(f.conversation.modeBinding, binding);
  assert.equal(f.reloads(), 2);
  assert.equal(f.saved.state.note, 'Saved content');
  assert.equal(f.state.conversationMessages[0].content, 'Saved message');
  f.h.unmount();
});

test('a late initial refresh failure cannot overwrite successful Undo', async () => {
  const f = fixture();
  try {
    const refresh = f.holdReload();
    f.open().onSelect();
    await nextTurn();
    await f.notice().action.run();
    const restoredNotice = f.notice();
    assert.equal(f.conversation.modeBinding, binding);
    assert.equal(restoredNotice.action, undefined);
    refresh.reject(new Error('Late synthetic refresh failure'));
    await nextTurn();
    assert.equal(f.notice(), restoredNotice);
    assert.equal(f.conversation.modeBinding, binding);
  } finally {
    f.h.unmount();
  }
});
