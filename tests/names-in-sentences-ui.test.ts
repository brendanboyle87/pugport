import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

// A name the user chose (here 设置, "Settings" in English) goes into a confirmation or notice separately, as
// Confirmation.names / Notice.names, so the sentence translates and the name stays as written.
// In-memory rendering with fake APIs and synthetic names.
const executors = uiBundle('tests/helpers/confirmation-fixture.ts').then(
  (code) => `${code}\nmodule.exports.ApiRow = ApiRow;\nmodule.exports.CliRow = CliRow;`,
);
const stamp = '2026-10-20T12:00:00Z';
const name = '设置';
const base = (notices: unknown[]) => ({
  state: { app: { platform: 'win32' }, settings: {}, targets: [], runtimes: [] },
  api: async () => ({}),
  reload: async () => {},
  notify: (notice: unknown) => notices.push(notice),
});
// Values made inside the in-memory renderer, compared as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('removing an account or an API provider asks with the name kept apart from the sentence', async () => {
  const harness = uiHarness(await executors);
  const store = harness.exports.confirmationStore;
  const account = {
    runtimeId: 'codex-b',
    id: 'codex-b',
    label: name,
    provider: 'codex',
    home: 'fixture',
    enabled: true,
    managed: true,
    status: 'ready',
    modelCount: 0,
    quota: [],
  };
  const cli = harness.render('CliRow', {
    ...base([]),
    target: { id: 'codex-b', provider: 'codex', label: name, command: 'fixture', environment: 'native', enabled: true },
    account,
    accounts: [account],
    cursorUsage: {},
  });
  findNode(cli, (node) => node.type === 'button' && /danger-text/.test(node.props.className ?? ''))!.props.onClick();
  assert.equal(store.snapshot().options.title, '移除 {0}？');
  assert.deepEqual(plain(store.snapshot().options.names), [name]);
  store.resolve(store.snapshot().id, false);
  await nextTurn();
  const api = harness.render('ApiRow', {
    ...base([]),
    provider: { targetId: 'api-1', preset: 'deepseek', label: name, enabled: true, console: '', currency: 'USD' },
    target: { id: 'api-1', provider: 'pi' },
  });
  findNode(api, (node) => node.type === 'button' && /danger-text/.test(node.props.className ?? ''))!.props.onClick();
  assert.equal(store.snapshot().options.title, '移除 {0}？');
  assert.deepEqual(plain(store.snapshot().options.names), [name]);
  store.resolve(store.snapshot().id, false);
  await nextTurn();
  harness.unmount();
});

test('adding an API provider or a CLI account names it apart from the notice sentence', async () => {
  const harness = uiHarness(await executors);
  const notices: any[] = [];
  const props = {
    ...base(notices),
    initialKind: 'api',
    accounts: { accounts: [], providers: [{ id: 'codex', supported: true }] },
    api: async (path: string, body?: { label?: string }) =>
      path === '/api/accounts'
        ? { accounts: [{ runtimeId: 'codex-2', provider: 'codex', managed: true, label: body?.label }] }
        : {},
    onClose: () => {},
  };
  const fill = (tree: unknown, value: string) =>
    findNode(tree, (node) => node.type === 'input' && node.props.maxLength === 60)!.props.onChange({
      target: { value },
    });
  const submit = (tree: unknown) =>
    findNode(tree, (node) => node.props.className === 'button primary')!.props.onClick();
  const tree = harness.render('AddDialog', props);
  findNode(tree, (node) => node.type === 'input' && node.props.type === 'password')!.props.onChange({
    target: { value: 'synthetic-key-not-a-secret' },
  });
  fill(harness.render('AddDialog', props), name);
  submit(harness.render('AddDialog', props));
  await nextTurn();
  assert.deepEqual(plain(notices.at(-1)), { tone: 'success', message: '{0} 已添加。', names: [name] });
  harness.unmount();

  const cli = uiHarness(await executors);
  const cliProps = { ...props, initialKind: 'cli' };
  fill(cli.render('AddDialog', cliProps), name);
  submit(cli.render('AddDialog', cliProps));
  // Create the account, then open its sign-in.
  for (let turn = 0; turn < 3; turn++) await nextTurn();
  assert.match(notices.at(-1).message, /^已创建 \{0\}，/);
  assert.deepEqual(plain(notices.at(-1).names), [name]);
  cli.unmount();
});

test('saving a launch configuration names the executor apart from the notice sentence', async () => {
  const harness = uiHarness(await uiBundle('src/ui/App.tsx'));
  const notices: any[] = [];
  const target = {
    id: 'codex-b',
    provider: 'codex',
    label: name,
    command: 'fixture',
    environment: 'native',
    enabled: true,
  };
  const tree = harness.render('TargetEditor', { ...base(notices), target });
  findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  assert.deepEqual(plain(notices.at(-1)), { tone: 'success', message: '{0} 的启动配置已保存。', names: [name] });
  harness.unmount();
});

test('using a taste test winner names it apart from the notice sentence', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Workspace.tsx'));
  const notices: any[] = [];
  const conversation = { id: 'chat', projectId: 'project', title: 'Fixture', createdAt: stamp, updatedAt: stamp };
  const candidate = {
    key: 'A',
    provider: 'codex',
    runtimeId: 'codex-b',
    model: 'gpt-5.5',
    label: `${name} · gpt-5.5 · high`,
    status: 'done',
  };
  const state = {
    app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [],
    conversations: [conversation],
    runs: [],
    workflows: [],
    conversationMessages: [],
    targets: [],
    runtimes: [],
    approvals: [],
    plugins: [],
    settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
    tasteTests: [
      {
        id: 'taste',
        projectId: 'project',
        conversationId: 'chat',
        topic: 'fiction',
        brief: 'Synthetic brief',
        status: 'ready',
        candidates: [candidate],
        chosen: 'A',
        verdict: 'good',
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
  };
  const tree = harness.render('ConversationWorkspace', {
    state,
    api: async () => ({ messages: [] }),
    conversation,
    notify: (notice: unknown) => notices.push(notice),
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  });
  findNode(tree, (node) => node.type?.name === 'TasteTestCard')!.props.onUseWriter(candidate);
  assert.deepEqual(plain(notices.at(-1)), {
    tone: 'success',
    message: '下一条消息会交给 {0}。',
    names: [candidate.label],
  });
  harness.unmount();
});
