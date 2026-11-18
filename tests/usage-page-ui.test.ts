import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AppState, RuntimeSnapshot } from '../src/shared/types.ts';
import type { DeviceView } from '../src/shared/devices.ts';
import { findNode, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

import { buildSpendOverview, buildSpendDetails } from '../src/server/spend-ledger.ts';
import { spendFixture } from './helpers/spend-fixture.ts';

const now = Date.parse('2026-10-29T12:00:00Z');
const runtime: RuntimeSnapshot = {
  id: 'claude',
  label: 'Synthetic account',
  provider: 'claude',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [],
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: new Date(now).toISOString(),
  accounting: { mode: 'subscription', source: 'fixture' },
  quota: { status: 'unknown', source: 'fixture', windows: [], observedAt: null },
};
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets: [],
  runtimes: [runtime],
  runs: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'allow',
    defaultProjectPath: 'C:/Synthetic',
    maxConcurrentRuns: 1,
  },
};
const props = {
  state,
  now,
  refreshing: false,
  refresh: async () => {},
  reload: async () => {},
  notify() {},
  onInspect() {},
  api: async () => new Promise(() => {}),
};
const usageBundle = uiBundle('src/ui/UsagePage.tsx');
const spendBundle = uiBundle('src/ui/UsageSpend.tsx');
const accountsBundle = uiBundle('src/ui/Executors.tsx');
const devicesBundle = uiBundle('src/ui/DeviceUsage.tsx');

test('Spend retains compact detail tables and expands token reporting details', async () => {
  const input = spendFixture();
  const h = uiHarness(await spendBundle);
  const view = {
    ...props,
    api: async (path: string) => {
      const url = new URL(path, 'http://fixture');
      return path.includes('/details')
        ? buildSpendDetails(input, { group: url.searchParams.get('group') as 'task' | 'project' | 'run', limit: 20 })
        : buildSpendOverview(input, {});
    },
  };
  const render = () => h.render('UsageSpend', view);
  render();
  await new Promise((r) => setTimeout(r, 0));
  let tree = render();
  findNode(tree, (n) => n.type === 'details')!.props.onToggle({ currentTarget: { open: true } });
  render();
  await new Promise((r) => setTimeout(r, 0));
  tree = render();
  for (const group of ['按任务', '按项目', '每次调用']) {
    findNode(tree, (n) => n.type === 'button' && text(n) === group)!.props.onClick();
    render();
    await new Promise((r) => setTimeout(r, 0));
    tree = render();
    const table = findNode(tree, (n) => ['TaskCostTable', 'AggregateTable', 'RunUsageTable'].includes(n.type?.name))!;
    assert.match(text(table.type(table.props)), /总词元.*参考费用/);
    assert.doesNotMatch(text(table.type(table.props)), /缓存读取|缓存写入|推理输出/);
  }
  findNode(tree, (n) => n.type === 'button' && text(n) === '详情')!.props.onClick();
  tree = render();
  const table = findNode(tree, (n) => n.type?.name === 'RunUsageTable')!;
  assert.match(text(table.type(table.props)), /缓存读取.*缓存写入.*推理输出/);
  h.unmount();
});

function expandResources(tree: any): any {
  if (Array.isArray(tree)) return tree.map(expandResources);
  if (!tree || typeof tree !== 'object' || !tree.props) return tree;
  if (['DeviceResources', 'Capacity', 'DeviceQuotaChips'].includes(tree.type?.name))
    return expandResources(tree.type(tree.props));
  return { ...tree, props: { ...tree.props, children: expandResources(tree.props.children) } };
}

test('Usage and Connections headings match their outer management tabs', async () => {
  for (const [bundle, component, title] of [
    [usageBundle, 'UsagePage', '用量'],
    [accountsBundle, 'ExecutorsPage', '连接'],
  ] as const) {
    const h = uiHarness(await bundle);
    const tree = h.render(component, props);
    assert.equal(text(findNode(tree, (node) => node.type === 'h1')), title);
    assert.doesNotMatch(text(tree), /用量与连接/);
    h.unmount();
  }
});

test('Usage keeps its account grid and has no view toggle or empty introduction', async () => {
  const h = uiHarness(await usageBundle, {
    localStorage: { getItem: () => 'compact' },
  });
  const tree = h.render('UsagePage', props);
  assert.ok(findNode(tree, (node) => node.type?.name === 'EvenCards'));
  assert.equal(
    findNode(tree, (node) => node.props.className === 'usage-view-switch'),
    undefined,
  );
  for (const label of ['额度视图', '展开', '紧凑'])
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === label),
      undefined,
    );
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'Savings'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props.role === 'tab'),
    undefined,
  );
  assert.ok(findNode(h.render('UsagePage', { ...props, view: 'usage' }), (node) => node.type?.name === 'UsageSpend'));
  h.unmount();
});

test('Usage hides a one-time API credit once it expires or runs out, but keeps a monthly one', async () => {
  const credit = (id: string, phase: string, extra: Record<string, unknown> = {}) => ({
    targetId: id,
    label: id,
    preset: 'openai',
    budget: {
      phase,
      spentUsd: 10,
      reservedUsd: 0,
      unreportedRuns: 0,
      policy: { limitUsd: 20, startedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', ...extra },
    },
  });
  const apiProviders = [
    credit('Live credit', 'normal'),
    credit('Expired credit', 'expired'),
    credit('Spent credit', 'exhausted'),
    credit('Past date credit', 'normal', { expiresAt: '2026-10-28T00:00:00Z' }),
    credit('Monthly credit', 'exhausted', { monthlyUsd: 20 }),
  ];
  const h = uiHarness(await usageBundle);
  const tree = h.render('UsagePage', { ...props, state: { ...state, apiProviders } as unknown as AppState });
  const shown: string[] = [];
  findNode(tree, (node) => {
    if (node.type?.name === 'ApiQuotaCard') shown.push(node.props.provider.label);
    return false;
  });
  assert.deepEqual(shown, ['Live credit', 'Monthly credit']);
  h.unmount();
});

test('retired compact session preferences preserve the tab and filters in the account grid', async () => {
  const saved = new Map([
    ['pugport-usage-selection', JSON.stringify(['usage', 'compact', 'C:/Synthetic', 'claude', 'month', 'model'])],
  ]);
  const h = uiHarness(await spendBundle, {
    sessionStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  const tree = h.render('UsageSpend', props);
  assert.ok(findNode(tree, (node) => node.props.role === 'tabpanel' && node.props['aria-label'] === '累计消耗'));
  assert.equal(findNode(tree, (node) => node.props['aria-label'] === '用量项目范围')!.props.value, 'C:/Synthetic');
  assert.deepEqual(JSON.parse(saved.get('pugport-usage-selection')!), [
    'usage',
    'expanded',
    'C:/Synthetic',
    'claude',
    '30d',
    'task',
    'all',
    'all',
    '',
  ]);
  h.unmount();
});

test('Usage shows the latest reading timestamp once next to Refresh', async () => {
  const h = uiHarness(await usageBundle);
  const render = (value: RuntimeSnapshot) =>
    h.render('UsagePage', { ...props, state: { ...state, runtimes: [value] } });
  const unobserved = render(runtime);
  assert.ok(findNode(unobserved, (node) => node.props.className === 'usage-accounts'));
  const card = (tree: UiNode) => findNode(tree, (node) => node.type?.name === 'QuotaCard')!;
  const first = card(unobserved);
  const time = findNode(first.type(first.props), (node) => node.type === 'time');
  assert.equal(time?.props.dateTime, undefined);
  const observedAt = new Date(now).toISOString();
  const observedTree = render({ ...runtime, quota: { ...runtime.quota, status: 'known', observedAt } });
  const observed = card(observedTree);
  assert.equal(
    findNode(observed.type(observed.props), (node) => node.type === 'time'),
    undefined,
  );
  assert.equal(findNode(observedTree, (node) => node.type === 'time')!.props.dateTime, observedAt);
  const css = readFileSync(new URL('../src/ui/studio.css', import.meta.url), 'utf8');
  assert.match(css, /\.usage-accounts\s+\.quota-footer\s+time:not\(\[datetime\]\)\s*\{\s*display:\s*none;/);
  h.unmount();
});

test('unreported device resource rows collapse to one waiting line', async () => {
  const h = uiHarness(await devicesBundle);
  const device: DeviceView = {
    id: 'synthetic-device',
    name: 'Synthetic device',
    address: 'fixture',
    pairedAt: new Date(now).toISOString(),
    online: true,
  };
  for (const compact of [false, true]) {
    const tree = expandResources(h.render('DeviceQuotaCard', { device, now, compact }));
    assert.equal((text(tree).match(/等待设备上报/g) ?? []).length, 1);
    assert.equal(
      findNode(tree, (node) => node.props.className === 'device-resource'),
      undefined,
    );
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === '磁盘'),
      undefined,
    );
    assert.doesNotMatch(text(tree), /读取中|尚未读到设备信息|这台设备还没有账号|剩余额度/);
  }
  h.unmount();
});

test('partial device readings show only reported resource rows, including zero', async () => {
  const h = uiHarness(await devicesBundle);
  const device: DeviceView = {
    id: 'synthetic-device',
    name: 'Synthetic device',
    address: 'fixture',
    online: true,
    pairedAt: new Date(now).toISOString(),
    resources: { cpuPercent: 0, observedAt: new Date(now).toISOString() },
  };
  const tree = expandResources(h.render('DeviceQuotaCard', { device, now, compact: true }));
  const cpu = findNode(tree, (node) => node.props['data-resource'] === 'cpu');
  assert.ok(cpu);
  assert.equal(text(cpu), 'CPU0%');
  assert.equal(
    findNode(tree, (node) => node.props['data-resource'] === 'gpu'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props['data-resource'] === 'memory'),
    undefined,
  );
  assert.doesNotMatch(text(tree), /等待设备上报|读取中/);
  h.unmount();
});

test('Connections folds a switched-off card whose one-time credit ended, and keeps a re-enabled one in the list', async () => {
  const credit = (id: string, enabled: boolean) => ({
    targetId: id,
    label: id,
    preset: 'openai',
    enabled,
    budget: {
      phase: 'expired',
      spentUsd: 20,
      reservedUsd: 0,
      unreportedRuns: 0,
      policy: { limitUsd: 20, startedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-28T00:00:00Z' },
    },
  });
  const target = (id: string, enabled: boolean) => ({
    id,
    provider: 'pi',
    gateway: 'api',
    label: id,
    environment: 'native',
    enabled,
    command: 'never-spawn',
  });
  const h = uiHarness(await accountsBundle);
  const tree = h.render('ExecutorsPage', {
    ...props,
    state: {
      ...state,
      targets: [target('Ended card', false), target('Back on', true)],
      apiProviders: [credit('Ended card', false), credit('Back on', true)],
    } as unknown as AppState,
  });
  const folded = findNode(tree, (node) => node.props.className === 'exec-ended')!;
  assert.match(text(findNode(folded, (node) => node.type === 'summary')!), /已结束的赠金 · 1/);
  const rows = (root: UiNode) => {
    const ids: string[] = [];
    findNode(root, (node) => {
      if (node.type?.name === 'ApiRow') ids.push(node.props.provider.targetId);
      return false;
    });
    return ids;
  };
  assert.deepEqual(rows(folded), ['Ended card']);
  assert.deepEqual(rows(tree), ['Back on', 'Ended card']);
  h.unmount();
});
