import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { hasUsableAccount } from '../src/shared/runtime-readiness.ts';
import { SettingsPage } from '../src/ui/App.tsx';
import { ExecutorsPage } from '../src/ui/Executors.tsx';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const targets: RuntimeTarget[] = ['codex', 'claude', 'grok', 'cursor'].map((provider) => ({
  id: `${provider}-native`,
  provider: provider as RuntimeTarget['provider'],
  label: provider,
  environment: 'native',
  enabled: true,
  command: 'unused',
}));
function runtime(target = targets[0]!, status: RuntimeSnapshot['status'] = 'missing'): RuntimeSnapshot {
  return {
    ...target,
    installed: status !== 'missing',
    status,
    authMode: target.provider === 'codex' ? 'chatgpt' : undefined,
    models: status === 'ready' ? [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['high'] }] : [],
    capabilities: { execute: status === 'ready', resume: true, cancel: true, approvals: true },
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    refreshedAt: '2026-10-11T00:00:00Z',
  };
}
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets,
  runtimes: targets.map((target) => runtime(target)),
  runs: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    preferNative: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 0,
  },
};
const actions = {
  api: async <T>() => ({ accounts: [], providers: [] }) as T,
  reload: async () => {},
  notify() {},
  refresh: async () => {},
  refreshing: false,
};
const executorsBundle = uiBundle('src/ui/Executors.tsx');
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as UiNode).props?.children) : '';
}
const button = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.type === 'button' && text(node) === label)!;

test('no usable account has one connect entry and four compact uninstalled CLI rows', () => {
  const html = renderToStaticMarkup(createElement(ExecutorsPage, { ...actions, state }));
  assert.equal((html.match(/>连接账号<\/button>/g) ?? []).length, 1);
  assert.equal((html.match(/>未安装<\/span>/g) ?? []).length, 4);
  assert.equal((html.match(/>安装<\/a>/g) ?? []).length, 4);
  assert.doesNotMatch(html, /exec-row|exec-toggle|关闭执行器|连接测试模型/);
});

test('a ready unknown-quota CLI works with a stale refreshing snapshot and is never hidden by account metadata', () => {
  const usable = { ...state, refreshing: true, runtimes: [runtime(targets[0], 'ready')] };
  assert.equal(hasUsableAccount(usable), true);
  assert.equal(hasUsableAccount({ ...usable, targets: [{ ...targets[0]!, gateway: 'magpie' }] }), false);
  const html = renderToStaticMarkup(createElement(ExecutorsPage, { ...actions, state: usable }));
  assert.doesNotMatch(html, />连接账号<\/button>/);
  assert.match(html, /exec-row/);
  const unchecked = renderToStaticMarkup(
    createElement(ExecutorsPage, { ...actions, state: { ...state, runtimes: [] } }),
  );
  assert.equal(
    (unchecked.match(/class="exec-row/g) ?? []).length,
    4,
    'an absent snapshot does not prove uninstallation',
  );
});

test('connect actions offer only install, login or metadata check, without a model request', async () => {
  const harness = uiHarness(`${await executorsBundle}\nmodule.exports.CliConnectionAction = CliConnectionAction;`);
  const calls: string[] = [];
  const props = {
    ...actions,
    state,
    target: targets[1]!,
    snapshot: runtime(targets[1], 'missing'),
    api: async (path: string) => {
      calls.push(path);
      return {};
    },
  };
  let tree = harness.render('CliConnectionAction', props);
  assert.equal(tree.type, 'a');
  assert.equal(text(tree), '安装');
  tree = harness.render('CliConnectionAction', { ...props, snapshot: runtime(targets[1], 'auth-required') });
  assert.equal(text(tree), '登录');
  tree = harness.render('CliConnectionAction', { ...props, snapshot: undefined });
  assert.equal(text(tree), '检查');
  tree.props.onClick();
  tree.props.onClick();
  await nextTurn();
  assert.deepEqual(calls, ['/api/refresh']);
  harness.unmount();
});

test('default CLI login creates and logs into only the new managed profile', async () => {
  const harness = uiHarness(`${await executorsBundle}\nmodule.exports.CliConnectionAction = CliConnectionAction;`);
  const calls: Array<{ path: string; body: unknown }> = [];
  const props = {
    ...actions,
    state,
    target: targets[1]!,
    snapshot: runtime(targets[1], 'auth-required'),
    api: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { accounts: [{ runtimeId: 'new-claude', managed: true, provider: 'claude' }] };
    },
  };
  const tree = harness.render('CliConnectionAction', props);
  tree.props.onClick();
  await nextTurn();
  assert.deepEqual(
    calls.map((item) => item.path),
    ['/api/accounts', '/api/accounts/new-claude/login'],
  );
  assert.deepEqual(structuredClone(calls[0]!.body), { provider: 'claude', label: 'claude 账号' });
  harness.unmount();
});

test('Add opens a menu that selects the native subscription form', async () => {
  const harness = uiHarness(await executorsBundle);
  let tree = harness.render('ExecutorsPage', { ...actions, state });
  button(tree, '添加').props.onClick();
  tree = harness.render('ExecutorsPage', { ...actions, state });
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'AddDialog'),
    undefined,
  );
  button(tree, '原生 CLI').props.onClick();
  tree = harness.render('ExecutorsPage', { ...actions, state });
  assert.equal(findNode(tree, (node) => node.type?.name === 'AddDialog')!.props.initialKind, 'cli');
  assert.equal(
    findNode(tree, (node) => node.props.role === 'menu'),
    undefined,
  );
  harness.unmount();
  const dialog = uiHarness(`${await executorsBundle}\nmodule.exports.AddDialog = AddDialog;`);
  const defaultTab = findNode(
    dialog.render('AddDialog', { ...actions, state, onClose() {} }),
    (node) => node.props.role === 'tab' && node.props.children === '订阅账号',
  )!;
  assert.equal(defaultTab.props['aria-selected'], true);
  dialog.unmount();
});

test('project draft keeps its connection banner and typed draft while the connection dialog opens', async () => {
  const project = {
    id: 'synthetic-project',
    name: 'Synthetic',
    path: '/synthetic/project',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
  };
  const backend = {
    state: { ...state, projects: [project] },
    api: actions.api,
    reload: actions.reload,
    connection: 'connected',
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: backend,
    localStorage: { getItem: (key: string) => (key === 'agent-studio-project' ? project.id : null), setItem() {} },
  });
  let tree = harness.render('default');
  const workspace = () => {
    const split = findNode(tree, (node) => node.type?.name === 'SplitView')!;
    return split.props.children(split.props.ids[0], 0);
  };
  const session = workspace().props.composerSession;
  session.changeDraft('new', (draft: any) => ({ ...draft, content: '先写好的消息' }));
  button(tree, '连接账号').props.onClick();
  tree = harness.render('default');
  assert.ok(findNode(tree, (node) => node.type?.name === 'ConnectAccounts'));
  assert.equal(workspace().props.composerSession, session);
  findNode(tree, (node) => node.type?.name === 'ConnectAccounts')!.props.onClose();
  backend.state = { ...state, projects: [project], runtimes: [runtime(targets[0], 'ready')] };
  tree = harness.render('default');
  assert.equal(session.getSnapshot().drafts.new.content, '先写好的消息');
  assert.equal(button(tree, '连接账号'), undefined);
  harness.unmount();
});

test('banner is hidden only while a checklist is shown, including selected empty chats and multiple panes', async () => {
  const stamp = '2026-10-29T00:00:00Z';
  const project = {
    id: 'chat',
    name: 'Synthetic',
    path: '/synthetic',
    scope: 'chat' as const,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const conversation = { id: 'empty-chat', projectId: project.id, title: 'Empty', createdAt: stamp, updatedAt: stamp };
  const backend = {
    state: { ...state, projects: [project], conversations: [conversation] },
    api: actions.api,
    reload: actions.reload,
    connection: 'connected',
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: backend,
    localStorage: {
      getItem: (key: string) =>
        key === 'agent-studio-project' ? project.id : key === 'agent-studio-conversation' ? conversation.id : null,
      setItem() {},
    },
  });
  let tree = harness.render('default');
  assert.ok(button(tree, '连接账号'));
  const visibility = findNode(
    tree,
    (node) =>
      node.type === 'context-provider' &&
      node.props.children?.type === 'context-provider' &&
      typeof node.props.value === 'function',
  )!.props.value;
  visibility('pane-a', true);
  tree = harness.render('default');
  assert.equal(button(tree, '连接账号'), undefined);
  visibility('pane-b', true);
  visibility('pane-a', false);
  tree = harness.render('default');
  assert.equal(button(tree, '连接账号'), undefined, 'another pane still shows its checklist');
  visibility('pane-b', false);
  tree = harness.render('default');
  assert.ok(button(tree, '连接账号'), 'history, pending sends or a main-view Mod hide the checklist');
  harness.unmount();
});

test('settings mount only the selected category and preserve untouched saved values', async () => {
  const saved = {
    ...state.settings,
    preferCli: false,
    preferNative: false,
    maxConcurrentRuns: 6,
    maxRunsPerAccount: 2,
    decisionMode: 'confirm' as const,
    unknownQuotaPolicy: 'allow' as const,
  };
  const props = { ...actions, state: { ...state, settings: saved } };
  const normal = renderToStaticMarkup(createElement(SettingsPage, { ...props, category: 'general' }));
  const routing = renderToStaticMarkup(createElement(SettingsPage, { ...props, category: 'routing' }));
  const advanced = renderToStaticMarkup(createElement(SettingsPage, { ...props, category: 'advanced' }));
  assert.doesNotMatch(normal, /默认调度方式|账号使用顺序|同时运行的任务/);
  assert.match(routing, /value="confirm" selected/);
  assert.match(routing, /value="auto" selected="">按任务选择所有账号/);
  assert.match(advanced, /同时运行的任务/);
  for (const html of [normal, routing, advanced])
    assert.doesNotMatch(html, /优先使用本机运行环境|保存设置|本地工具|全盘搜索/);
  const writes: any[] = [];
  const h = uiHarness(await uiBundle('src/ui/App.tsx'));
  const callbacks = {
    ...props,
    api: async (_path: string, body: unknown) => {
      writes.push(body);
      return {};
    },
  };
  findNode(h.render('SettingsPage', callbacks), (node) => node.props['aria-label'] === '任务完成通知')!.props.onChange({
    target: { value: 'never' },
  });
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ notifyOnFinish: 'never' }]);
  h.unmount();
});

test('solo checklist opens the shared connection dialog and keeps the workspace and update notice', async () => {
  const stamp = '2026-10-29T00:00:00Z';
  const project = {
    id: 'synthetic-chat',
    name: 'Synthetic',
    path: '/synthetic/chat',
    scope: 'chat' as const,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const conversation = {
    id: 'synthetic-solo',
    projectId: project.id,
    title: 'Synthetic empty chat',
    createdAt: stamp,
    updatedAt: stamp,
  };
  const update = { version: '99.0.0', url: 'https://github.com/pugport/pugport/releases/tag/v99.0.0' };
  const backend = {
    state: { ...state, projects: [project], conversations: [conversation], appUpdate: update },
    api: actions.api,
    reload: actions.reload,
    connection: 'connected',
  };
  const harness = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: backend,
    location: { search: '?view=conversation&id=synthetic-solo' },
  });
  let tree = harness.render('default');
  const workspace = findNode(tree, (node) => node.type?.name === 'ConversationWorkspace')!;
  assert.equal(workspace.props.conversation.id, conversation.id);
  const context = findNode(
    tree,
    (node) => node.type === 'context-provider' && node.props.children?.type?.name === 'ConversationWorkspace',
  )!;
  assert.ok(context, 'the pop-out supplies the same Accounts navigation as the main workspace');
  context.props.value();
  tree = harness.render('default');
  const dialog = findNode(tree, (node) => node.type?.name === 'ConnectAccounts')!;
  assert.ok(dialog);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'ExecutorsPage'),
    undefined,
  );
  assert.equal(findNode(tree, (node) => node.type === 'main')?.props.className, 'workspace-main');
  assert.equal(findNode(tree, (node) => node.type?.name === 'AppUpdateNotice')?.props.update, update);
  dialog.props.onClose();
  tree = harness.render('default');
  assert.ok(findNode(tree, (node) => node.type?.name === 'ConversationWorkspace'));
  backend.state = { ...backend.state, settings: { ...backend.state.settings, updateCheck: false } };
  // Turning checks off disables the notice itself, so an update the desktop updater pushes stays hidden too.
  assert.equal(
    findNode(harness.render('default'), (node) => node.type?.name === 'AppUpdateNotice')?.props.enabled,
    false,
  );
  harness.unmount();
});
