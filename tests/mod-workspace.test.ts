import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const workspaceCode = await uiBundle('src/ui/Workspace.tsx');
const panelCode = await uiBundle('src/ui/mods/ModPanel.tsx');
const formCode = await uiBundle('src/ui/ConversationModeView.tsx');
const toolbarCode = await uiBundle('src/ui/mods/ModToolbarButton.tsx');
const stamp = '2026-10-27T00:00:00Z';
const project = {
  id: 'synthetic-project',
  name: 'Synthetic project',
  path: 'C:/Synthetic',
  createdAt: stamp,
  updatedAt: stamp,
};
const binding = { instanceId: 'synthetic-instance', modeId: 'synthetic.notes', version: '1.0.0' };
const mode = {
  binding,
  pending: null,
  installed: true,
  manifest: {
    schemaVersion: 2,
    id: binding.modeId,
    version: binding.version,
    title: 'Synthetic notes',
    description: 'Test fixture',
    contributions: {
      rightPanel: { kind: 'form', form: { fields: [{ id: 'note', label: 'Note', type: 'textarea' }], actions: [] } },
    },
  },
  instance: {
    id: binding.instanceId,
    conversationId: 'chat',
    modeId: binding.modeId,
    version: binding.version,
    schemaVersion: 1,
    revision: 0,
    state: { note: 'saved value' },
    createdAt: stamp,
    updatedAt: stamp,
  },
};
const component = (tree: unknown, name: string) => findNode(tree, (node) => node.type?.name === name);
function mount(hidden = false, modeView: any = mode) {
  // The composer focuses on the next frame; the Node harness has no animation frames.
  const harness = uiHarness(workspaceCode, { requestAnimationFrame: (run: () => void) => setTimeout(run, 0) });
  let stored = {
    id: 'chat',
    projectId: project.id,
    title: 'Synthetic chat',
    createdAt: stamp,
    updatedAt: stamp,
    modeBinding: binding,
    ...(hidden ? { modeHidden: true as const } : {}),
  };
  const calls: { path: string; body: any; method?: string }[] = [];
  const notices: any[] = [];
  let reloads = 0,
    removals = 0;
  const props: any = {
    state: {
      app: { version: 'test' },
      projects: [project],
      conversations: [stored],
      conversationMessages: [],
      workflows: [],
      runs: [],
      runtimes: [],
      targets: [],
      approvals: [],
      plugins: [],
      settings: {},
    },
    project,
    conversation: structuredClone(stored),
    api: async (path: string, body?: any, method?: string) => {
      calls.push({ path, body: structuredClone(body), method });
      if (path === '/api/conversations/chat/mode/visibility') {
        assert.equal(method, 'PUT');
        stored = { ...stored, modeHidden: body.hidden ? true : undefined };
        return structuredClone(stored);
      }
      if (path === '/api/conversations/chat/mode') return structuredClone(modeView);
      if (path === '/api/modes')
        return {
          catalog: [{ ...mode.manifest, compatible: true }],
          installed: [{ modeId: binding.modeId, version: binding.version, installedAt: stamp }],
        };
      return { messages: [], workflows: [] };
    },
    reload: async () => {
      reloads++;
      props.conversation = structuredClone(stored);
      props.state = { ...props.state, conversations: [props.conversation] };
    },
    notify: (notice: unknown) => notices.push(notice),
    onRemoveMod: () => {
      removals++;
    },
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  return { harness, props, calls, notices, render, reloads: () => reloads, removals: () => removals };
}
async function ready(f: ReturnType<typeof mount>) {
  f.render();
  await nextTurn();
  return f.render();
}
function expectChat(tree: UiNode) {
  assert.ok(
    findNode(tree, (node) => node.type === 'section' && node.props.className.includes('conversation-workspace')),
  );
  assert.ok(findNode(tree, (node) => node.type === 'textarea' && node.props.id === 'conversation-input'));
}

test('workspace toggles visibility through PUT and reload without replacing the Mod panel or chat composer', async () => {
  const f = mount();
  try {
    let tree = await ready(f);
    const first = component(tree, 'ModPanel')!;
    assert.ok(first);
    assert.equal(first.props.hidden, false);
    expectChat(tree);
    component(tree, 'ModToolbarButton')!.props.onToggle();
    assert.equal(
      component(f.render(), 'ModPanel')!.props.hidden,
      false,
      'the conversation field is the only visibility source',
    );
    await nextTurn();
    tree = f.render();
    assert.equal(f.reloads(), 1);
    assert.equal(f.props.conversation.modeHidden, true);
    assert.equal(component(tree, 'ModPanel')!.props.hidden, true);
    assert.equal(component(tree, 'ModPanel')!.key, first.key);
    assert.deepEqual(
      f.calls.filter((call) => call.path.endsWith('/visibility')).map((call) => [call.method, call.body.hidden]),
      [['PUT', true]],
    );
    expectChat(tree);
    component(tree, 'ModToolbarButton')!.props.onToggle();
    await nextTurn();
    tree = f.render();
    assert.equal(f.props.conversation.modeHidden, undefined);
    assert.equal(component(tree, 'ModPanel')!.props.hidden, false);
    assert.equal(component(tree, 'ModPanel')!.key, first.key);
    component(tree, 'ModPanel')!.props.onRemove();
    assert.equal(f.removals(), 1, 'panel removal reaches the shared conversation callback');
    assert.equal(f.notices.length, 0);
  } finally {
    f.harness.unmount();
  }
});

test('side chat yields and restores the Mod column while retaining the original hidden preference', async () => {
  for (const hidden of [false, true]) {
    const f = mount(hidden);
    try {
      let tree = await ready(f);
      const key = component(tree, 'ModPanel')!.key;
      findNode(tree, (node) => node.props['aria-label'] === '新侧聊')!.props.onClick();
      tree = f.render();
      assert.ok(component(tree, 'SideChatPanel'));
      assert.equal(component(tree, 'ModPanel')!.props.hidden, true);
      assert.equal(component(tree, 'ModPanel')!.key, key);
      expectChat(tree);
      component(tree, 'SideChatPanel')!.props.onClose();
      tree = f.render();
      assert.equal(component(tree, 'ModPanel')!.props.hidden, hidden);
      assert.equal(component(tree, 'ModPanel')!.key, key);
      assert.equal(
        f.calls.filter((call) => call.path.endsWith('/visibility')).length,
        0,
        'side chat does not alter persisted visibility',
      );
    } finally {
      f.harness.unmount();
    }
  }
});

test('secondary panes do not mount Mod surfaces and a fresh pane restores persisted hidden state', async () => {
  const f = mount(true);
  try {
    let tree = await ready(f);
    assert.equal(component(tree, 'ModPanel')!.props.hidden, true);
    f.props.modSurfaces = false;
    tree = f.render();
    assert.equal(component(tree, 'ModPanel'), undefined);
    assert.equal(component(tree, 'ModToolbarButton'), undefined);
    expectChat(tree);
    f.harness.remount();
    f.props.modSurfaces = true;
    tree = await ready(f);
    assert.equal(component(tree, 'ModPanel')!.props.hidden, true);
  } finally {
    f.harness.unmount();
  }
});

test('panel keeps its form child while hidden and the menu invokes removal immediately', () => {
  const h = uiHarness(panelCode);
  let removed = 0;
  const props = {
    view: mode,
    hidden: false,
    busy: false,
    onRemove: () => {
      removed++;
    },
    onSave: async () => {},
    onCompose() {},
    onStore() {},
  };
  try {
    let tree = h.render('ModPanel', props);
    const first = component(tree, 'ModFormView')!;
    assert.ok(first);
    tree = h.render('ModPanel', { ...props, hidden: true });
    assert.equal(tree.props.hidden, true);
    assert.equal(component(tree, 'ModFormView')!.key, first.key);
    tree = h.render('ModPanel', props);
    findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'Mod 菜单')!.props.onClick();
    tree = h.render('ModPanel', props);
    findNode(tree, (node) => node.props.role === 'menuitem')!.props.onClick();
    assert.equal(removed, 1);
    assert.equal(
      findNode(h.render('ModPanel', props), (node) => node.props.role === 'dialog'),
      undefined,
    );
  } finally {
    h.unmount();
  }
});

test('mounted Mod form preserves unsaved values through same-instance rerenders', () => {
  const h = uiHarness(formCode);
  const props = { view: mode, busy: false, onSave: async () => {}, onCompose() {}, onStore() {} };
  try {
    let tree = h.render('ModFormView', props);
    findNode(tree, (node) => node.type === 'textarea')!.props.onChange({
      target: { value: 'unsaved synthetic input' },
    });
    for (let i = 0; i < 4; i++) {
      tree = h.render('ModFormView', { ...props, view: structuredClone(mode) });
      assert.equal(findNode(tree, (node) => node.type === 'textarea')!.props.value, 'unsaved synthetic input');
    }
  } finally {
    h.unmount();
  }
});

test('panel disables removal when a removal is queued', () => {
  const h = uiHarness(panelCode);
  try {
    const props = {
      view: { ...mode, pending: { binding: null, afterWorkflowId: 'run', requestedAt: stamp } },
      hidden: false,
      busy: false,
      onRemove() {},
      onSave: async () => {},
      onCompose() {},
      onStore() {},
    };
    let tree = h.render('ModPanel', props);
    findNode(tree, (node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu')!.props.onClick();
    tree = h.render('ModPanel', props);
    assert.equal(findNode(tree, (node) => node.props.role === 'menuitem')!.props.disabled, true);
  } finally {
    h.unmount();
  }
});

test('workspace exposes a failed Mod read and retries it through the toolbar', async () => {
  const f = mount();
  const originalApi = f.props.api;
  let reads = 0;
  f.props.api = async (path: string, body?: unknown, method?: string) => {
    if (path === '/api/conversations/chat/mode' && ++reads === 1) throw new Error('Synthetic read failure');
    return originalApi(path, body, method);
  };
  try {
    let tree = await ready(f);
    assert.match(component(tree, 'ModToolbarButton')!.props.error, /Synthetic read failure/);
    component(tree, 'ModToolbarButton')!.props.onRetry();
    await nextTurn();
    tree = f.render();
    assert.equal(reads, 2);
    assert.ok(component(tree, 'ModPanel'));
    assert.equal(component(tree, 'ModToolbarButton')!.props.error, undefined);
  } finally {
    f.harness.unmount();
  }
});

const webMode = () => ({
  ...structuredClone(mode),
  manifest: {
    ...mode.manifest,
    state: { keys: [{ id: 'note' }] },
    permissions: ['chat:read', 'composer:draft'],
    ui: {
      entries: {
        main: { html: '<p>Main</p>' },
        right: { html: '<textarea></textarea>' },
        sidebar: { html: '<p>Sidebar</p>' },
      },
    },
    contributions: {
      mainView: { kind: 'web', entry: 'main' },
      rightPanel: { kind: 'web', entry: 'right' },
      sidebarPanel: { kind: 'web', entry: 'sidebar' },
    },
  },
});

test('Web main keeps chat in a nonmodal region and preserves frame keys when hidden', async () => {
  const f = mount(false, webMode());
  try {
    let tree = await ready(f);
    const frame = component(tree, 'ModFrame')!;
    assert.ok(frame);
    assert.equal(frame.props.slot, 'mainView');
    assert.equal(frame.props.hidden, false);
    assert.ok(component(tree, 'ModPanel')!.props.web);
    const drawer = (value: unknown) =>
      findNode(value, (n) => n.type === 'section' && n.props.className.includes('conversation-workspace'))!;
    assert.equal(drawer(tree).props.hidden, true);
    assert.equal(drawer(tree).props.role, 'region');
    assert.equal(findNode(tree, (n) => n.props.className === 'mod-workspace-surface')!.props.inert, undefined);
    assert.equal(findNode(tree, (n) => n.props.className === 'conversation-scroll')!.props.inert, false);
    expectChat(tree);
    component(tree, 'ModWorkspaceBar')!.props.onChat();
    tree = f.render();
    assert.equal(drawer(tree).props.hidden, false);
    assert.equal(drawer(tree).props.role, 'region');
    assert.equal(findNode(tree, (n) => n.props.className === 'mod-workspace-surface')!.props.inert, undefined);
    component(tree, 'ModToolbarButton')!.props.onToggle();
    await nextTurn();
    tree = f.render();
    assert.equal(component(tree, 'ModFrame')!.key, frame.key);
    assert.equal(component(tree, 'ModFrame')!.props.hidden, true);
    assert.equal(drawer(tree).props.hidden, false);
    assert.equal(drawer(tree).props.role, undefined);
    expectChat(tree);
    f.props.modSurfaces = false;
    tree = f.render();
    assert.equal(component(tree, 'ModFrame'), undefined);
    assert.equal(component(tree, 'ModPanel'), undefined);
    expectChat(tree);
  } finally {
    f.harness.unmount();
  }
});

test('Web bridge inserts append/replace into the current draft, never sends, and revokes on a conversation switch', async () => {
  const f = mount(false, webMode());
  try {
    let tree = await ready(f);
    const host = component(tree, 'ModPanel')!.props.web.host;
    host.insert('one', 'replace');
    tree = f.render();
    assert.equal(findNode(tree, (n) => n.props.id === 'conversation-input')!.props.value, 'one');
    host.insert('two', 'append');
    tree = f.render();
    assert.equal(findNode(tree, (n) => n.props.id === 'conversation-input')!.props.value, 'one\n\ntwo');
    host.insert('three', 'replace');
    tree = f.render();
    assert.equal(findNode(tree, (n) => n.props.id === 'conversation-input')!.props.value, 'three');
    host.notify('<img src=x>', '<script>plain text</script>');
    assert.deepEqual(JSON.parse(JSON.stringify(f.notices.at(-1))), {
      tone: 'info',
      message: '{0} · {1}',
      names: ['<img src=x>', '<script>plain text</script>'],
    });
    assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
    f.props.conversation = { ...f.props.conversation, id: 'other', modeBinding: undefined };
    f.render();
    assert.equal(host.isCurrent(), false);
    assert.throws(() => host.insert('stale', 'replace'), { code: 'E_UNAVAILABLE' });
  } finally {
    f.harness.unmount();
  }
});

test('Web panel delegates to one iframe and keeps it mounted while side chat hides it', () => {
  const h = uiHarness(panelCode);
  const props: any = {
    view: webMode(),
    hidden: false,
    busy: false,
    onRemove() {},
    onSave: async () => {},
    onCompose() {},
    onStore() {},
    web: { host: {}, running: false, messages: { count: 0 } },
  };
  try {
    let tree = h.render('ModPanel', props);
    const frame = component(tree, 'ModFrame')!;
    assert.ok(frame);
    assert.equal(frame.props.slot, 'rightPanel');
    assert.equal(component(tree, 'ModFormView'), undefined);
    tree = h.render('ModPanel', { ...props, hidden: true });
    assert.equal(component(tree, 'ModFrame')!.key, frame.key);
    assert.equal(component(tree, 'ModFrame')!.props.hidden, true);
  } finally {
    h.unmount();
  }
});
