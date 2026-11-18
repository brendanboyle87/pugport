import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState, RuntimeTarget } from '../src/shared/types.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/Executors.tsx');
const botBundle = uiBundle('tests/helpers/confirmation-fixture.ts');
const cursor: RuntimeTarget = {
  id: 'cursor-native',
  provider: 'cursor',
  label: 'Cursor',
  command: 'unused',
  environment: 'native',
  enabled: true,
};
const state = {
  app: { platform: 'darwin' },
  targets: [cursor, { ...cursor, id: 'cursor-second', label: 'Cursor 2' }],
  runtimes: [],
  settings: { cursorFallback: true },
} as unknown as AppState;

const botAgents = () => [
  { id: 'muse', name: 'Muse', kind: 'web', added: false, enabled: false, url: 'https://muse.ai/' },
  { id: 'grok-bot', name: 'Grok Bot', kind: 'handoff', added: false, enabled: false },
];

test('adding Muse requires risk acceptance, cancels without writes, and never opens a login', async () => {
  const harness = uiHarness(await botBundle);
  const store = harness.exports.confirmationStore;
  const calls: Array<{ path: string; body?: unknown; method?: string }> = [];
  const notices: Array<{ message: string }> = [];
  let added = 0,
    closed = 0,
    reloads = 0;
  const props = {
    state,
    initialKind: 'bot',
    api: async (path: string, body?: unknown, method?: string) => {
      calls.push({ path, body: body && JSON.parse(JSON.stringify(body)), method });
      return { agents: botAgents().map((agent) => ({ ...agent, added: method === 'PATCH' && agent.id === 'muse' })) };
    },
    reload: async () => {
      reloads++;
    },
    notify: (notice: { message: string }) => notices.push(notice),
    onBotAdded: () => {
      added++;
    },
    onClose: () => {
      closed++;
    },
  };
  let tree = harness.render('AddDialog', props);
  const primary = () => findNode(tree, (node) => node.props.className === 'button primary')!;
  assert.equal(primary().props.disabled, true, 'adding waits for the saved Bot list');
  await nextTurn();
  tree = harness.render('AddDialog', props);
  assert.equal(
    findNode(tree, (node) => node.type === 'input' && node.props.maxLength === 60),
    undefined,
  );
  const address = () => findNode(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'Muse 网址')!;
  assert.equal(address().props.value, 'https://muse.ai/');
  address().props.onChange({ target: { value: 'https://user:secret@synthetic.invalid/' } });
  tree = harness.render('AddDialog', props);
  primary().props.onClick();
  await nextTurn();
  assert.equal(store.snapshot(), undefined, 'an invalid address does not ask to accept risk');
  assert.equal(calls.length, 1);
  assert.match(notices.at(-1)!.message, /网址/);
  address().props.onChange({ target: { value: 'https://synthetic.invalid/muse' } });
  tree = harness.render('AddDialog', props);
  primary().props.onClick();
  primary().props.onClick();
  let question = store.snapshot();
  assert.equal(question.options.title, '添加 Muse？');
  assert.equal(question.options.points.length, 4);
  assert.equal(calls.length, 1, 'confirmation is pending: no write');
  store.resolve(question.id, false);
  await nextTurn();
  assert.equal(store.snapshot(), undefined, 'a rapid second click cannot queue another confirmation');
  assert.equal(calls.length, 1, 'cancelled: no write');
  assert.equal(closed, 0);
  tree = harness.render('AddDialog', props);
  primary().props.onClick();
  question = store.snapshot();
  store.resolve(question.id, true);
  await nextTurn();
  assert.deepEqual(calls, [
    { path: '/api/external-agents', body: undefined, method: 'GET' },
    {
      path: '/api/external-agents/muse',
      body: { added: true, enabled: true, url: 'https://synthetic.invalid/muse', acceptRisk: true },
      method: 'PATCH',
    },
  ]);
  assert.equal(added, 1);
  assert.equal(closed, 1);
  assert.equal(reloads, 0, 'the Bot card refreshes without a native-account or model refresh');
  assert.equal(notices.at(-1)!.message, 'Muse 已添加。');
  harness.unmount();
});

for (const botId of ['', 'synthetic-bot_1']) {
  test(`Grok Bot adds ${botId ? 'a specific ID' : 'without an ID'}, then prevents a duplicate addition`, async () => {
    const harness = uiHarness(await botBundle);
    const agents = botAgents();
    agents[0]!.added = true;
    const writes: unknown[] = [];
    const props = {
      state,
      initialKind: 'bot',
      api: async (path: string, body?: unknown, method?: string) => {
        if (method === 'PATCH') {
          writes.push({ path, body: JSON.parse(JSON.stringify(body)), method });
          agents[1]!.added = true;
        }
        return { agents: structuredClone(agents) };
      },
      reload: async () => {},
      notify: () => {},
      onClose: () => {},
    };
    harness.render('AddDialog', props);
    await nextTurn();
    let tree = harness.render('AddDialog', props);
    assert.equal(findNode(tree, (node) => node.props['aria-label'] === 'Bot 平台')!.props.value, 'grok-bot');
    assert.equal(findNode(tree, (node) => node.type === 'option' && node.props.value === 'muse')!.props.disabled, true);
    assert.match(text(tree), /Muse（已添加）/);
    assert.equal(
      findNode(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'Muse 网址'),
      undefined,
    );
    findNode(tree, (node) => node.props['aria-label'] === 'Bot ID（可选）')!.props.onChange({
      target: { value: botId },
    });
    tree = harness.render('AddDialog', props);
    const submit = findNode(tree, (node) => node.props.className === 'button primary')!;
    assert.equal(text(submit), '添加');
    submit.props.onClick();
    submit.props.onClick();
    await nextTurn();
    assert.equal(harness.exports.confirmationStore.snapshot(), undefined);
    assert.deepEqual(writes, [
      {
        path: '/api/external-agents/grok-bot',
        body: { added: true, enabled: true, botId },
        method: 'PATCH',
      },
    ]);
    harness.remount();
    harness.render('AddDialog', props);
    await nextTurn();
    tree = harness.render('AddDialog', props);
    assert.equal(findNode(tree, (node) => node.props.className === 'button primary')!.props.disabled, true);
    assert.match(text(tree), /已添加的 Bot 可在下方 Bot 列表里管理/);
    findNode(tree, (node) => node.props.className === 'button primary')!.props.onClick();
    await nextTurn();
    assert.equal(writes.length, 1);
    harness.unmount();
  });
}

test('a failed Bot list read offers retry and keeps additions blocked until it succeeds', async () => {
  const harness = uiHarness(await bundle);
  let reads = 0;
  const props = {
    state,
    initialKind: 'bot',
    api: async (_path: string, _body: unknown, method: string) => {
      assert.equal(method, 'GET');
      if (++reads === 1) throw new Error('Synthetic unavailable');
      return { agents: botAgents() };
    },
    reload: async () => {},
    notify: () => {},
    onClose: () => {},
  };
  harness.render('AddDialog', props);
  await nextTurn();
  let tree = harness.render('AddDialog', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /Synthetic unavailable/);
  assert.equal(findNode(tree, (node) => node.props.className === 'button primary')!.props.disabled, true);
  findNode(tree, (node) => node.type === 'button' && text(node) === '重试')!.props.onClick();
  harness.render('AddDialog', props);
  await nextTurn();
  tree = harness.render('AddDialog', props);
  assert.equal(
    findNode(tree, (node) => node.props.role === 'alert'),
    undefined,
  );
  assert.equal(findNode(tree, (node) => node.props.className === 'button primary')!.props.disabled, false);
  assert.equal(reads, 2);
  harness.unmount();
});

test('Cursor fallback serializes shared row writes and preserves a committed change when reload fails', async () => {
  const harness = uiHarness(await bundle);
  let finish!: () => void;
  const writes: unknown[] = [],
    notices: Array<{ message: string }> = [];
  const props = {
    state,
    api: async (path: string, body?: unknown, method?: string) => {
      if (path === '/api/accounts') return { accounts: [] };
      writes.push({ path, body: JSON.parse(JSON.stringify(body)), method });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {};
    },
    reload: async () => {
      throw new Error('reload failed');
    },
    refresh: async () => {},
    refreshing: false,
    notify: (notice: { message: string }) => notices.push(notice),
  };
  let tree = harness.render('ExecutorsPage', props);
  const control = (id: string) => findNode(tree, (node) => node.props.target?.id === id)!.props.cursorFallback;
  const pending = control(cursor.id).change(false);
  await control('cursor-second').change(true);
  tree = harness.render('ExecutorsPage', props);
  assert.deepEqual(writes, [{ path: '/api/settings', body: { cursorFallback: false }, method: 'PATCH' }]);
  assert.equal(control(cursor.id).pending, true);
  assert.equal(control('cursor-second').enabled, false);
  finish();
  await pending;
  tree = harness.render('ExecutorsPage', props);
  assert.equal(control(cursor.id).pending, false);
  assert.equal(control(cursor.id).enabled, false);
  assert.equal(control('cursor-second').enabled, false);
  assert.match(notices.at(-1)!.message, /设置已保存，但刷新失败/);
  harness.unmount();
});

test('Cursor fallback rolls back a failed PATCH to the current local value, not stale saved props', async () => {
  const harness = uiHarness(await bundle);
  let failedWrite = false;
  const notices: Array<{ message: string }> = [];
  const props = {
    state,
    api: async (path: string) => {
      if (path === '/api/accounts') return { accounts: [] };
      if (failedWrite) throw new Error('save failed');
      return {};
    },
    reload: async () => {
      throw new Error('reload failed');
    },
    refresh: async () => {},
    refreshing: false,
    notify: (notice: { message: string }) => notices.push(notice),
  };
  let tree = harness.render('ExecutorsPage', props);
  const control = () => findNode(tree, (node) => node.props.target?.id === cursor.id)!.props.cursorFallback;
  await control().change(false);
  tree = harness.render('ExecutorsPage', props);
  assert.equal(control().enabled, false);
  failedWrite = true;
  await control().change(true);
  tree = harness.render('ExecutorsPage', props);
  assert.equal(control().enabled, false);
  assert.equal(control().pending, false);
  assert.match(notices.at(-1)!.message, /save failed/);
  assert.doesNotMatch(notices.at(-1)!.message, /设置已保存/);
  harness.unmount();
});

test('a late Cursor fallback response does not notify after the page unmounts', async () => {
  const harness = uiHarness(await bundle);
  let finish!: () => void;
  const notices: unknown[] = [];
  const props = {
    state,
    api: async (path: string) => {
      if (path === '/api/accounts') return { accounts: [] };
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {};
    },
    reload: async () => {},
    refresh: async () => {},
    refreshing: false,
    notify: (notice: unknown) => notices.push(notice),
  };
  const tree = harness.render('ExecutorsPage', props);
  const control = findNode(tree, (node) => node.props.target?.id === cursor.id)!.props.cursorFallback;
  const pending = control.change(false);
  harness.unmount();
  finish();
  await pending;
  assert.deepEqual(notices, []);
});

for (const ambiguous of [false, true]) {
  test(`native account creation ${ambiguous ? 'rejects ambiguous new IDs' : 'logs in the new ID despite duplicate names'}`, async () => {
    // Expose only this private component in the isolated test bundle; the production exports stay unchanged.
    const harness = uiHarness(`${await bundle}\nmodule.exports.AddDialog = AddDialog;`);
    const old = { runtimeId: 'old-codex', provider: 'codex', label: 'Work', managed: true };
    const created = { ...old, runtimeId: 'new-codex' };
    const returned = [
      old,
      { ...created, provider: 'grok', runtimeId: 'new-grok' },
      created,
      ...(ambiguous ? [{ ...created, runtimeId: 'another-codex' }] : []),
    ];
    const calls: string[] = [],
      notices: Array<{ message: string }> = [];
    let closed = false;
    const props = {
      state: { ...state, targets: [{ ...cursor, id: old.runtimeId, provider: 'codex' }] },
      accounts: { providers: [{ id: 'codex', supported: true }], accounts: [old] },
      api: async (path: string) => {
        calls.push(path);
        return { accounts: returned };
      },
      reload: async () => {},
      notify: (notice: { message: string }) => notices.push(notice),
      onClose() {
        closed = true;
      },
    };
    let tree = harness.render('AddDialog', props);
    findNode(tree, (node) => node.props.role === 'tab' && node.props.children === '订阅账号')!.props.onClick();
    tree = harness.render('AddDialog', props);
    findNode(tree, (node) => node.type === 'input' && node.props.maxLength === 60)!.props.onChange({
      target: { value: 'Work' },
    });
    tree = harness.render('AddDialog', props);
    findNode(tree, (node) => node.type === 'button' && node.props.className === 'button primary')!.props.onClick();
    await nextTurn();
    assert.equal(calls[0], '/api/accounts');
    assert.equal(calls.includes('/api/accounts/old-codex/login'), false);
    assert.equal(calls.includes('/api/accounts/new-grok/login'), false);
    if (ambiguous) {
      assert.equal(calls.length, 1);
      assert.equal(closed, false);
      assert.match(notices.at(-1)!.message, /无法唯一确认新账号/);
    } else {
      assert.deepEqual(calls, ['/api/accounts', '/api/accounts/new-codex/login']);
      assert.equal(closed, true);
    }
    harness.unmount();
  });
}
