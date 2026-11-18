import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

// A name people chose reaches the window translator protected: in an attribute filled in with withNames on an element
// marked data-names, or as text inside translate="no". Otherwise the English window turns a name such as 设置 into
// "Settings" (protected-text-english-renderer.test.ts checks that in Electron). In-memory rendering, synthetic names.
const name = '甲乙丙';
const attributes = ['title', 'aria-label', 'placeholder', 'alt'];
const isElement = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(isElement) : !!value && typeof value === 'object' && 'props' in value;
/**
 * Where the rendered tree shows the name unprotected. The two places the window keeps as written by style (a sidebar
 * conversation's and a project's name span) count as protected.
 */
function exposed(tree: unknown, kept = false, parent = ''): string[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => exposed(child, kept, parent));
  if (typeof tree === 'string') return !kept && tree.includes(name) ? [`text: ${tree}`] : [];
  if (!tree || typeof tree !== 'object') return [];
  const { type, props = {} } = tree as UiNode;
  const host = typeof type === 'string';
  const styled = type === 'span' && !props.className && /\b(conversation-link|project-name)\b/.test(parent);
  const inside = kept || props.translate === 'no' || styled;
  const found =
    host && !inside && !('data-names' in props)
      ? attributes.filter((key) => String(props[key] ?? '').includes(name)).map((key) => `${key}: ${props[key]}`)
      : [];
  const below = host ? String(props.className ?? '') : parent;
  return [
    ...found,
    ...Object.entries(props).flatMap(([key, value]) =>
      key === 'children' || isElement(value) ? exposed(value, inside, below) : [],
    ),
  ];
}
const stamp = '2026-10-20T12:00:00Z';
const base = {
  state: { app: { platform: 'win32' }, settings: {}, targets: [], runtimes: [] },
  api: async () => ({}),
  reload: async () => {},
  notify() {},
};
const rows = ['ApiRow', 'CliRow', 'ApiBudgetSettings', 'ApiBudgetSummary', 'FreeSourceRow', 'ConnectAccounts'];
const executors = uiBundle('tests/helpers/confirmation-fixture.ts').then(
  (code) => `${code}\n${rows.map((row) => `module.exports.${row} = ${row};`).join('\n')}`,
);

test('executor accounts and API sources keep their names as written in labels, tooltips and warnings', async () => {
  const harness = uiHarness(await executors);
  const account = (runtimeId: string, label: string, fields = {}) => ({
    runtimeId,
    id: runtimeId,
    label,
    provider: 'codex',
    home: 'fixture',
    enabled: true,
    managed: true,
    status: 'ready',
    modelCount: 0,
    quota: [],
    ...fields,
  });
  // An account that turned out to be the same login as one named 甲乙丙, being cleared for good.
  const same = account('codex-a', name);
  const cleared = account('codex-b', name, { duplicateOf: 'codex-a' });
  const cliProps = {
    ...base,
    target: { id: 'codex-b', provider: 'codex', label: name, command: 'fixture', environment: 'native', enabled: true },
    account: cleared,
    accounts: [same, cleared],
    cursorUsage: {},
  };
  findNode(harness.render('CliRow', cliProps), (node) => node.props['aria-expanded'] === false)!.props.onClick();
  const cli = harness.render('CliRow', cliProps);
  assert.ok(findNode(cli, (node) => node.props.className === 'purge-confirm'));
  assert.deepEqual(exposed(cli), []);
  harness.unmount();

  const provider = {
    targetId: 'api-1',
    preset: 'anthropic',
    label: name,
    enabled: true,
    console: '',
    currency: 'USD',
    keyHint: '…1234',
    budget: {
      policy: { limitUsd: 200, startedAt: stamp, perRunUsd: 1, maxConcurrentRuns: 2, burstConcurrentRuns: 2 },
      spentUsd: 20,
      remainingUsd: 180,
      reservedUsd: 0,
      unreportedRuns: 0,
      phase: 'priority',
      maxConcurrentRuns: 2,
    },
  };
  for (const [component, props] of [
    ['ApiRow', { ...base, provider, target: { id: 'api-1', provider: 'pi' } }],
    ['ApiBudgetSummary', { provider }],
    ['FreeSourceRow', { ...base, provider: { ...provider, preset: 'ollama' } }],
  ] as const) {
    const row = uiHarness(await executors);
    const tree = row.render(component, props);
    assert.ok(
      JSON.stringify(tree, (key, value) =>
        key === 'type' && typeof value === 'function' ? value.name : value,
      ).includes(name),
      component,
    );
    assert.deepEqual(exposed(tree), [], component);
    row.unmount();
  }

  // The account list and a CLI that is not installed.
  const missing = {
    id: 'claude-b',
    provider: 'claude',
    label: name,
    command: 'fixture',
    environment: 'native',
    enabled: true,
  };
  const state = {
    ...base.state,
    targets: [missing],
    runtimes: [
      { id: 'claude-b', label: name, provider: 'claude', status: 'missing', installed: false, models: [], quota: {} },
    ],
  };
  const page = uiHarness(await executors);
  const pageProps = { ...base, state, refresh: async () => {}, refreshing: false };
  page.render('ExecutorsPage', pageProps);
  await nextTurn();
  assert.deepEqual(exposed(page.render('ExecutorsPage', pageProps)), []);
  page.unmount();
  const connect = uiHarness(await executors);
  const connectProps = {
    ...base,
    state,
    api: async (path: string) => (path === '/api/accounts' ? { accounts: [], providers: [] } : {}),
    onClose() {},
  };
  connect.render('ConnectAccounts', connectProps);
  await nextTurn();
  const list = connect.render('ConnectAccounts', connectProps);
  assert.ok(findNode(list, (node) => node.props.className === 'setting-label'));
  assert.deepEqual(exposed(list), []);
  connect.unmount();
});

test('the sidebar keeps conversation and project names as written in tooltips and button labels', async () => {
  const project = { id: 'project', name, path: 'C:/Fixture', createdAt: stamp, updatedAt: stamp };
  const chat = { id: 'chat', projectId: 'project', title: name, createdAt: stamp, updatedAt: stamp };
  const state = {
    app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [project],
    conversations: [chat],
    workflows: [],
    conversationMessages: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    settings: { maxQuotaAgeSeconds: 120, reservePercent: 10, refreshSeconds: 60 },
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
  });
  const tree = harness.render('default');
  assert.ok(findNode(tree, (node) => node.props.className?.includes?.('conversation-link')));
  assert.ok(findNode(tree, (node) => node.props.className === 'project-collapse'));
  assert.deepEqual(exposed(tree), []);
  harness.unmount();
});

test('the composer and sent messages keep called names, attachment names and the conversation title as written', async () => {
  const chat = { id: 'chat', projectId: 'project', title: name, createdAt: stamp, updatedAt: stamp };
  const project = { id: 'project', name: 'Fixture', path: 'C:/Fixture', createdAt: stamp, updatedAt: stamp };
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
    settings: {
      agentPresets: [
        { id: 'my-role', name, description: '', instructions: 'Fixture', mode: 'auto', permissionMode: 'read-only' },
      ],
    },
  };
  const session = new ComposerSession();
  // A role, an account and a device named 甲乙丙; attached: a file named 甲乙丙; a taste-test writer.
  session.changeDraft('conversation:chat', (draft) => ({
    ...draft,
    content: `@${name} 看看`,
    agentPresetId: 'my-role',
    called: [
      { kind: 'executor', id: 'named', name },
      { kind: 'device', id: 'device:named', name },
    ],
    attachments: [{ id: 'file', file: new File(['x'], name) }],
    writer: { runtimeId: 'named', model: 'gpt-5.5', effort: 'high', label: `${name} · gpt-5.5 · high` },
  }));
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
  const tree = harness.render('ConversationWorkspace', {
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
  });
  assert.ok(findNode(tree, (node) => node.props.className === 'composer-tag mention'));
  assert.ok(findNode(tree, (node) => node.props.className === 'composer-once-writer'));
  assert.ok(findNode(tree, (node) => node.props.className === 'composer-tag'));
  assert.deepEqual(exposed(tree), []);
  harness.unmount();
  const sent = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
  const attachments = sent.render('MessageAttachments', {
    conversationId: 'chat',
    attachments: [
      { id: 'image', kind: 'image', name, mimeType: 'image/png', size: 1024 },
      { id: 'file', kind: 'file', name, mimeType: 'text/plain', size: 2048 },
    ],
  });
  assert.deepEqual(exposed(attachments), []);
  sent.unmount();
  const zoom = uiHarness(await uiBundle('src/ui/UsagePage.tsx'));
  assert.deepEqual(exposed(zoom.render('QuotaZoom', { from: {}, label: name, onClose() {}, children: null })), []);
  zoom.unmount();
  session.dispose();
});

test('connected accounts, quotes, pins, image searches, swarm members and categories keep what was written', async () => {
  // A connected account named 甲乙丙 (its owner's name too): the list, its menu, the disconnect question, the picker.
  const account = {
    id: 'account',
    provider: 'google',
    alias: name,
    email: '',
    displayName: name,
    capabilities: ['mail_read'],
    status: 'connected',
    enabled: true,
    connectedAt: stamp,
    updatedAt: stamp,
  };
  const connectorsApi = async (path: string) =>
    path === '/api/connectors/connect'
      ? {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',
          expiresAt: '2099-01-01T00:00:00Z',
        }
      : { accounts: [account], providers: [] };
  const connectors = uiHarness(await uiBundle('src/ui/Connectors.tsx'));
  const page = { api: connectorsApi, notify() {} };
  connectors.render('ConnectorsPage', page);
  await nextTurn();
  const listed = connectors.render('ConnectorsPage', page);
  assert.ok(findNode(listed, (node) => node.props.className === 'connector-account-title'));
  assert.deepEqual(exposed(listed), []);
  findNode(listed, (node) => String(node.props.className).includes('connector-disconnect'))!.props.onClick();
  const removing = connectors.render('ConnectorsPage', page);
  assert.ok(findNode(removing, (node) => node.props.className === 'connector-remove'));
  assert.deepEqual(exposed(removing), []);
  findNode(
    removing,
    (node) => node.type === 'button' && text(node.props.children).includes('重新授权'),
  )!.props.onClick();
  await nextTurn();
  const authorizing = connectors.render('ConnectorsPage', page);
  assert.ok(findNode(authorizing, (node) => node.props.className === 'connector-authorization'));
  assert.deepEqual(exposed(authorizing), []);
  connectors.unmount();
  const picker = uiHarness(await uiBundle('src/ui/Connectors.tsx'));
  const pickerProps = { api: connectorsApi, value: [], onChange() {}, inline: true };
  picker.render('ConnectorPicker', pickerProps);
  await nextTurn();
  const choices = picker.render('ConnectorPicker', pickerProps);
  assert.ok(findNode(choices, (node) => node.props.className === 'connector-picker-option'));
  assert.deepEqual(exposed(choices), []);
  picker.unmount();

  // A quote and its note; a pinned message; an image search described as 甲乙丙.
  const quotes = uiHarness(await uiBundle('src/ui/Quotes.tsx'));
  const noop = () => {};
  const editor = quotes.render('QuoteEditor', { text: name, note: '', left: 0, top: 0, onSave: noop, onCancel: noop });
  assert.ok(findNode(editor, (node) => node.type === 'blockquote'));
  assert.deepEqual(exposed(editor), []);
  quotes.unmount();
  const chips = uiHarness(await uiBundle('src/ui/Quotes.tsx'));
  const quote = { id: 'quote', text: name, note: name };
  assert.deepEqual(exposed(chips.render('QuoteChips', { quotes: [quote], onEdit: noop, onRemove: noop })), []);
  chips.unmount();
  const pins = uiHarness(await uiBundle('src/ui/PinnedMessages.tsx'));
  const pinned = pins.render('PinnedMessages', {
    conversationId: 'chat',
    pins: [{ messageId: 'pinned', pinnedAt: stamp }],
    messages: [{ id: 'pinned', conversationId: 'chat', role: 'user', content: name, createdAt: stamp }],
    workflows: [],
    pending: false,
    onUpdate: noop,
    onJump: noop,
    onTask: noop,
    onRefresh: noop,
  });
  assert.ok(findNode(pinned, (node) => node.props.className === 'pinned-message-preview'));
  assert.deepEqual(exposed(pinned), []);
  pins.unmount();
  const background = uiHarness(await uiBundle('src/ui/BackgroundTasks.tsx'));
  const search = {
    id: 'search',
    conversationId: 'chat',
    title: `后台找图：${name}`,
    detail: '准备中',
    done: 0,
    total: 0,
  };
  const searching = background.render('BackgroundTasks', {
    tasks: [{ ...search, startedAt: stamp, state: 'running' }],
    conversationId: 'chat',
    onPause: noop,
    onResume: noop,
    onClose: noop,
  });
  assert.ok(findNode(searching, (node) => node.props.className === 'background-task-title'));
  assert.deepEqual(exposed(searching), []);
  background.unmount();

  // A swarm member in a role named 甲乙丙: its avatar, sheet, task list, messages and the box to write to it.
  const swarm = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const task = (id: string, fields = {}) => ({
    id,
    conversationId: 'chat',
    projectId: 'project',
    status: 'running',
    phase: 'execute',
    input: { content: name, mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: stamp,
    updatedAt: stamp,
    ...fields,
  });
  const members = swarm.exports.swarmMembers(
    [
      task('root'),
      task('member', {
        agentPreset: { id: 'my-role', name },
        delegation: { parentId: 'root', role: 'worker', requestId: 'member' },
      }),
    ],
    [],
    [],
  );
  const plan = { rows: [{ id: 'item', title: name, kind: 'read', state: 'running', who: name }], done: 0 };
  const view = swarm.render('SwarmWorkspaceView', {
    members,
    selectedId: 'member',
    loading: false,
    sending: false,
    draft: '',
    messages: [{ id: 'reply', conversationId: 'chat', role: 'assistant', content: name, createdAt: stamp }],
    communications: [{ id: 'peer', from: 'root', to: 'member', text: name, at: stamp, runId: 'run' }],
    plan,
    onSelect: noop,
    onDraft: noop,
    onSend: noop,
    onInspect: noop,
  });
  assert.ok(findNode(view, (node) => node.props.className?.includes?.('swarm-member-sheet')));
  assert.deepEqual(exposed(view), []);
  assert.deepEqual(exposed(swarm.render('SwarmPlanPanel', { plan })), []);
  swarm.unmount();

  // Deleting a category named 甲乙丙 and moving a chat titled 甲乙丙 into it.
  const common = { api: async () => ({}), reload: async () => {}, notify: noop, onClose: noop };
  const chat = { id: 'chat', projectId: 'project', title: name, createdAt: stamp, updatedAt: stamp };
  const folder = { id: 'folder', name, createdAt: stamp, updatedAt: stamp };
  const sidebar = uiHarness(await uiBundle('src/ui/ConversationFolders.tsx'));
  const sidebarProps = {
    ...common,
    chats: [],
    state: { ...base.state, conversationFolders: [folder] },
    row: () => null,
    onVisibleOrder: noop,
  };
  const actions = findNode(sidebar.render('ChatFolders', sidebarProps), (node) => 'data-names' in node.props);
  actions!.props.onClick({ clientX: 0, clientY: 0 });
  const menu = findNode(sidebar.render('ChatFolders', sidebarProps), (node) => Array.isArray(node.props.items));
  menu!.props.items.at(-1).onSelect();
  const deleting = sidebar.render('ChatFolders', sidebarProps);
  assert.ok(findNode(deleting, (node) => node.props.className === 'modal folder-dialog'));
  assert.deepEqual(exposed(deleting), []);
  sidebar.unmount();
  const folders = uiHarness(await uiBundle('src/ui/ConversationFolders.tsx'));
  const move = folders.render('FolderMoveDialog', { ...common, chat, folders: [folder] });
  assert.ok(findNode(move, (node) => node.props.className === 'folder-move-title'));
  assert.deepEqual(exposed(move), []);
  folders.unmount();
});
