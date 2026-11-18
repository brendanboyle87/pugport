import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Studio.tsx', true);
});
const stamp = '2026-10-25T12:00:00Z';
const binding = (modeId = 'fixture.notes', version = '1.0.0') => ({ instanceId: 'instance', modeId, version });
const notes = {
  schemaVersion: 1,
  id: 'fixture.notes',
  version: '1.0.0',
  title: 'Notes',
  description: 'Synthetic',
  icon: 'book-open',
  compatible: true,
};
const logoBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWMwTptpnDYTAAeZAmUGcC4NAAAAAElFTkSuQmCC',
  'base64',
);
logoBytes.writeUInt32BE(64, 16);
logoBytes.writeUInt32BE(64, 20);
logoBytes[25] = 6;
const logo = { src: 'data:image/png;base64,' + logoBytes.toString('base64'), alt: 'Synthetic logo' };
const board = { ...notes, id: 'fixture.board', title: 'Board', icon: 'list-checks' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
function fixture(
  api: (path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<any>,
  solo = false,
) {
  const conversation: any = { id: 'a', projectId: 'p', title: 'Synthetic chat', createdAt: stamp, updatedAt: stamp };
  const project: any = {
    id: 'p',
    name: 'Synthetic project',
    scope: 'project',
    path: 'C:/Synthetic',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const state = {
    app: { version: 'fixture' },
    projects: [project],
    conversations: [conversation],
    conversationMessages: [],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    settings: {},
  };
  const h = uiHarness(code, {
    __backend: { state, api, reload: async () => {}, connection: 'connected' },
    location: { search: solo ? '?view=conversation&id=a' : '' },
    localStorage: { getItem: (key: string) => (key === 'agent-studio-conversation' ? 'a' : null), setItem() {} },
  });
  const render = () => h.render('default');
  const row = () => {
    const tree = render();
    const matches = (node: any) => node.type === 'button' && node.props.title?.startsWith('Synthetic chat');
    const direct = findNode(tree, matches);
    if (direct) return direct;
    // The shallow harness leaves ChatFolders unmounted; exercise its supplied row renderer.
    const folders = findNode(tree, (node) => node.type?.name === 'ChatFolders');
    const ordinary = folders?.props.chats.find((chat: any) => chat.id === conversation.id);
    return ordinary ? findNode(folders!.props.row(ordinary), matches) : undefined;
  };
  const badge = () => findNode(row(), (node) => node.type?.name === 'ModBadge');
  return { h, state, conversation, project, render, row, badge };
}

test('normal and pinned rows show a badge before the title and never a Mod child', async () => {
  for (const pinned of [false, true]) {
    const request = deferred<any>();
    const f = fixture(async () => request.promise);
    f.conversation.modeBinding = binding();
    if (pinned) f.conversation.pinnedAt = stamp;
    assert.ok(f.badge(), 'attached Mod is badged even before metadata arrives');
    assert.equal(f.badge()!.props.mode, undefined);
    request.resolve({ catalog: [notes], installed: [] });
    await nextTurn();
    assert.equal(f.badge()!.props.mode.icon, 'book-open');
    const children = f.row()!.props.children.flat();
    assert.equal(f.row()!.props.title, 'Synthetic chat · Notes');
    assert.equal(
      children.filter((node: any) => ['Pin', 'GitBranch', 'MessageSquare'].includes(node?.type?.name)).length,
      0,
    );
    const badgeAt = children.findIndex((node: any) => node?.type?.name === 'ModBadge');
    const titleAt = children.findIndex((node: any) => node?.type === 'span' && text(node) === 'Synthetic chat');
    assert.ok(badgeAt >= 0 && titleAt > badgeAt);
    assert.equal(
      findNode(f.render(), (node) => node.props.className === 'conversation-mode-child'),
      undefined,
    );
    assert.equal(text(f.row()).includes(notes.title), false, 'badge has no extra text label');
    f.h.unmount();
  }
});

test('badge metadata uses the exact current version while another Mod is pending', async () => {
  let gets = 0;
  const f = fixture(async () => {
    gets++;
    return { catalog: [notes, board, { ...notes, version: '2.0.0', icon: 'code-xml' }], installed: [] };
  });
  f.conversation.modeBinding = binding();
  f.render();
  await nextTurn();
  assert.equal(f.badge()!.props.mode.icon, 'book-open');
  f.conversation.updatedAt = '2026-10-25T12:01:00Z';
  f.render();
  assert.equal(gets, 1);
  f.conversation.pendingModeBinding = { binding: binding(board.id), afterWorkflowId: 'task', requestedAt: stamp };
  f.render();
  await nextTurn();
  assert.equal(f.badge()!.props.mode.icon, 'book-open');
  delete f.conversation.modeBinding;
  f.render();
  await nextTurn();
  assert.equal(f.badge()!.props.mode.icon, 'list-checks');
  f.h.unmount();
});

test('stale metadata responses cannot replace a newer badge or borrow another version', async () => {
  const first = deferred<any>(),
    second = deferred<any>(),
    third = deferred<any>();
  const queue = [first, second, third],
    signals: AbortSignal[] = [];
  const f = fixture(async (_path, _body, _method, signal) => {
    signals.push(signal!);
    return queue.shift()!.promise;
  });
  f.conversation.modeBinding = binding(notes.id, '9.0.0');
  f.render();
  f.conversation.modeBinding = binding(board.id);
  f.render();
  assert.equal(signals[0]?.aborted, true);
  second.resolve({ catalog: [board], installed: [] });
  await nextTurn();
  assert.equal(f.badge()!.props.mode.icon, 'list-checks');
  first.resolve({ catalog: [notes], installed: [] });
  await nextTurn();
  assert.equal(f.badge()!.props.mode.icon, 'list-checks');
  f.conversation.modeBinding = binding(notes.id, '9.0.0');
  f.render();
  assert.equal(f.badge()!.props.mode, undefined);
  f.h.unmount();
  assert.equal(signals[2]?.aborted, true);
  third.resolve({ catalog: [notes], installed: [] });
  await nextTurn();
});

test('ordinary bound chats show a badge while side chats and closed chats do not', async () => {
  let gets = 0;
  const f = fixture(async () => {
    gets++;
    throw new Error('Synthetic unavailable');
  });
  f.render();
  assert.equal(gets, 0);
  assert.equal(f.badge(), undefined);
  f.project.scope = 'chat';
  f.conversation.modeBinding = binding();
  f.render();
  await nextTurn();
  assert.equal(gets, 1);
  assert.ok(f.badge());
  assert.equal(f.badge()!.props.mode, undefined);
  f.conversation.sideChat = { parentConversationId: 'parent' };
  f.render();
  assert.equal(f.badge(), undefined);
  delete f.conversation.sideChat;
  f.conversation.closedAt = stamp;
  f.render();
  assert.equal(f.badge(), undefined);
  f.h.unmount();
});

test('the first pane and pop-out retain Mod surfaces and conversation visibility', () => {
  const ordinary = fixture(async () => ({ catalog: [notes], installed: [] }));
  ordinary.conversation.modeBinding = binding();
  ordinary.conversation.modeHidden = true;
  const split = findNode(ordinary.render(), (node) => node.type?.name === 'SplitView')!;
  assert.equal(split.props.children('a', 0).props.modSurfaces, true);
  assert.equal(
    split.props.children('a', 1).props.modSurfaces,
    false,
    'duplicate pane never mounts another Mod surface',
  );
  assert.equal(split.props.children('a', 0).props.conversation.modeHidden, true);
  ordinary.h.unmount();
  const solo = fixture(async () => ({ catalog: [notes], installed: [] }), true);
  solo.conversation.modeBinding = binding();
  solo.conversation.modeHidden = true;
  const workspace = findNode(solo.render(), (node) => node.type?.name === 'ConversationWorkspace')!;
  assert.equal(workspace.props.modSurfaces, true);
  assert.equal(workspace.props.conversation.modeHidden, true);
  assert.equal(typeof workspace.props.onRemoveMod, 'function');
  solo.h.unmount();
});

test('badge announces the Mod title and falls back when metadata is unavailable', async () => {
  const h = uiHarness(await uiBundle('src/ui/mods/ModBadge.tsx'));
  try {
    const named = h.render('ModBadge', { mode: notes });
    assert.equal(named.props['aria-label'], 'Mod：Notes');
    assert.equal(named.props.title, 'Mod：Notes');
    const fallback = h.render('ModBadge', {});
    assert.equal(fallback.props['aria-label'], 'Mod');
    assert.equal(fallback.props.title, 'Mod');
  } finally {
    h.unmount();
  }
});

test('ordinary chat metadata preserves logo, schema version and permissions for the badge', async () => {
  const f = fixture(async () => ({
    catalog: [{ ...notes, schemaVersion: 2, logo, permissions: ['chat:read'] }],
    installed: [],
  }));
  f.project.scope = 'chat';
  f.conversation.modeBinding = binding();
  f.render();
  await nextTurn();
  const metadata = f.badge()!.props.mode;
  assert.equal(metadata.logo.src, logo.src);
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.permissions[0], 'chat:read');
  const badge = uiHarness(await uiBundle('src/ui/mods/ModBadge.tsx'));
  const icon = findNode(badge.render('ModBadge', { mode: metadata }), (node) => node.type?.name === 'ModeIcon')!;
  assert.equal(icon.props.mode.logo.src, logo.src);
  badge.unmount();
  f.h.unmount();
});

test('logo mask paints immediately, probes each source once and falls back after decode failure', async () => {
  const probes: { onerror?: () => void; src?: string }[] = [];
  class ImageProbe {
    onerror?: () => void;
    src?: string;
    constructor() {
      probes.push(this);
    }
  }
  const h = uiHarness(await uiBundle('src/ui/mods/mod-icons.ts'), { Image: ImageProbe });
  const props = { mode: { ...notes, logo }, size: 13 };
  let tree = h.render('ModeIcon', props);
  assert.equal(tree.type, 'span');
  assert.equal(tree.props.className, 'mod-logo');
  assert.equal(tree.props.style['--mod-logo'], `url("${logo.src}")`);
  assert.equal(tree.props.style.width, 13);
  assert.equal(probes.length, 1);
  h.render('ModeIcon', props);
  assert.equal(probes.length, 1);
  probes[0]!.onerror!();
  tree = h.render('ModeIcon', props);
  assert.notEqual(tree.type, 'span');
  h.render('ModeIcon', { mode: notes });
  h.render('ModeIcon', props);
  assert.equal(probes.length, 1);
  h.unmount();
});
