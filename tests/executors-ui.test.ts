import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { ExecutorsPage } from '../src/ui/Executors.tsx';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const target: RuntimeTarget = {
  id: 'codex-synthetic',
  provider: 'codex',
  label: 'Synthetic Codex',
  command: 'unused',
  environment: 'native',
  enabled: true,
};
const runtime: RuntimeSnapshot = {
  id: target.id,
  provider: target.provider,
  label: target.label,
  environment: 'native',
  installed: true,
  status: 'ready',
  version: '7.8.9-synthetic',
  models: [],
  quota: {
    status: 'known',
    source: 'synthetic',
    observedAt: '2026-10-29T12:00:00Z',
    windows: [{ id: 'daily', label: 'Daily', usedPercent: 67, resetsAt: null }],
  },
  capabilities: { execute: true, resume: false, cancel: true, approvals: false },
  refreshedAt: '2026-10-29T12:00:00Z',
};
const state = {
  app: { platform: 'win32' },
  settings: {},
  targets: [target, { ...target, id: 'api-synthetic', provider: 'openai', gateway: 'api' }],
  runtimes: [runtime],
  apiProviders: [
    {
      targetId: 'api-synthetic',
      preset: 'deepseek',
      label: 'Synthetic API',
      enabled: true,
      currency: 'USD',
      console: '',
      keyHint: 'fixture',
    },
  ],
} as unknown as AppState;
const props = {
  state,
  api: async <T>() => ({ accounts: [], agents: [] }) as T,
  reload: async () => {},
  refresh: async () => {},
  refreshing: false,
  notify() {},
};
const nestedButton = /<button[^>]*>(?:(?!<\/button>).)*<button/s;
const bundle = uiBundle('src/ui/Executors.tsx').then(
  (code) => `${code}\nObject.assign(module.exports, { CliRow, Row });`,
);

test('account cards render independent expand controls without nested buttons or a second add box', () => {
  const html = renderToStaticMarkup(createElement(ExecutorsPage, props));
  // The heading follows the interface language, which a test host may report as English.
  assert.match(html, /<h1>(?:连接|Connections)<\/h1>/);
  assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 1);
  assert.match(html, /aria-haspopup="menu"[^>]*>[\s\S]*?添加<\/button>/);
  assert.doesNotMatch(html, nestedButton);
  assert.equal((html.match(/class="icon-button exec-expand"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /exec-empty add|添加免费来源|即将推出|7\.8\.9-synthetic/);
  assert.match(html, /剩余 33%/);
  assert.doesNotMatch(html, /free-sources|免费模型/);
});

test('an empty account list offers one dashed API-key action', () => {
  const html = renderToStaticMarkup(
    createElement(ExecutorsPage, {
      ...props,
      state: { ...state, targets: [], runtimes: [], apiProviders: [] },
    }),
  );
  assert.equal((html.match(/class="exec-empty add"/g) ?? []).length, 1);
  assert.match(html, /添加 API 密钥/);
  assert.doesNotMatch(html, nestedButton);
});

test('the header Add menu opens each account form and restores focus to its stable trigger', async () => {
  for (const [label, kind] of [
    ['API 密钥', 'api'],
    ['免费来源', 'free'],
    ['原生 CLI', 'cli'],
  ]) {
    const harness = uiHarness(await bundle);
    let tree = harness.render('ExecutorsPage', props);
    const trigger = findNode(tree, (node) => node.props['aria-haspopup'] === 'menu')!;
    let focusReturns = 0;
    trigger.props.ref.current = { focus: () => focusReturns++ };
    assert.equal(trigger.props['aria-expanded'], false);
    trigger.props.onClick();
    tree = harness.render('ExecutorsPage', props);
    assert.equal(findNode(tree, (node) => node.props['aria-haspopup'] === 'menu')!.props['aria-expanded'], true);
    const menu = findNode(tree, (node) => node.props.role === 'menu')!;
    const item = findNode(menu, (node) => node.props.role === 'menuitem' && text(node) === label)!;
    item.props.onClick();
    assert.equal(focusReturns, 1, 'the stable Add trigger receives focus before the menu item unmounts');
    tree = harness.render('ExecutorsPage', props);
    assert.equal(
      findNode(tree, (node) => node.props.role === 'menu'),
      undefined,
    );
    const dialog = findNode(tree, (node) => node.props.initialKind === kind)!;
    assert.equal(dialog.props.initialKind, kind);
    dialog.props.onClose();
    tree = harness.render('ExecutorsPage', props);
    assert.equal(
      findNode(tree, (node) => node.props.initialKind === kind),
      undefined,
    );
    assert.equal(focusReturns, 2, 'closing the modal restores focus after it leaves the page');
    harness.unmount();
  }
});

test('either card disclosure opens details, while version and rename controls stay inside the expanded body', async () => {
  const cardHarness = uiHarness(await bundle);
  const rowHarness = uiHarness(await bundle);
  const card = cardHarness.render('CliRow', {
    ...props,
    target,
    snapshot: runtime,
    accounts: [],
    cursorUsage: { enabled: false, pending: false, change: async () => {} },
  });
  let tree = rowHarness.render('Row', card.props);
  const toggle = () => findNode(tree, (node) => node.props.className === 'exec-toggle')!;
  const expand = () => findNode(tree, (node) => node.props.className === 'icon-button exec-expand')!;
  assert.doesNotMatch(text(tree), /7\.8\.9-synthetic/);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'CardName'),
    undefined,
  );
  assert.equal(
    findNode(toggle().props.children, (node) => node.type === 'button'),
    undefined,
  );
  expand().props.onClick();
  tree = rowHarness.render('Row', card.props);
  assert.equal(expand().props['aria-expanded'], true);
  assert.match(text(findNode(tree, (node) => node.props.className === 'exec-body')), /v7\.8\.9-synthetic/);
  assert.ok(findNode(tree, (node) => node.type?.name === 'CardName'));
  assert.equal(
    toggle().props['aria-controls'],
    findNode(tree, (node) => node.props.className === 'exec-body')!.props.id,
  );
  toggle().props.onClick();
  tree = rowHarness.render('Row', card.props);
  assert.equal(expand().props['aria-expanded'], false);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'exec-body'),
    undefined,
  );
  cardHarness.unmount();
  rowHarness.unmount();
});

test('a collapsed account row offers remove from its ⋯ menu, with the same actions as the expanded body', async () => {
  const harness = uiHarness(await bundle);
  const row = (overrides: object) =>
    harness.render('CliRow', {
      ...props,
      target,
      snapshot: runtime,
      accounts: [],
      cursorUsage: { enabled: false, pending: false, change: async () => {} },
      ...overrides,
    });
  const labels = (tree: ReturnType<typeof row>) =>
    tree.props.menu.map((item: { label: string }) => item.label).join(',');
  assert.equal(labels(row({})), '');
  assert.equal(labels(row({ target: { ...target, id: 'codex-native' } })), '移除');
  const managed = row({ account: { managed: true, inUse: false, loginPending: false } });
  assert.equal(labels(managed), '移除账号');
  assert.equal(row({ account: { managed: true, inUse: true } }).props.menu[0].disabled, true);
  harness.unmount();

  const rowHarness = uiHarness(await bundle);
  let selected = 0;
  const rowProps = { ...managed.props, menu: [{ label: '移除账号', onSelect: () => selected++ }] };
  let tree = rowHarness.render('Row', rowProps);
  const more = () => findNode(tree, (node) => node.props.className === 'icon-button exec-expand exec-more')!;
  let focused = 0;
  more().props.ref.current = { focus: () => focused++ };
  more().props.onClick();
  tree = rowHarness.render('Row', rowProps);
  assert.equal(more().props['aria-expanded'], true);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'exec-body'),
    undefined,
    'the menu works without expanding the row',
  );
  findNode(tree, (node) => node.props.role === 'menuitem' && text(node) === '移除账号')!.props.onClick();
  assert.deepEqual([selected, focused], [1, 1]);
  tree = rowHarness.render('Row', rowProps);
  assert.equal(
    findNode(tree, (node) => node.props.role === 'menu'),
    undefined,
  );
  rowHarness.unmount();
});
