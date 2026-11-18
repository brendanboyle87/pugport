import { ExecutorActivityContext } from '../src/ui/ExecutorActivity.tsx';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, QuotaWindow, RuntimeSnapshot } from '../src/shared/types.ts';
import type { ApiProviderView, ApiBudgetView } from '../src/shared/api-providers.ts';
import type { ExternalAgentView } from '../src/shared/external-agents.ts';
import { QuotaCard } from '../src/ui/App.tsx';
import { CompactQuotaCard } from '../src/ui/UsageQuota.tsx';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const now = Date.parse('2026-10-11T12:00:00Z');
const day = 86_400_000;
const at = (days: number) => new Date(now + days * day).toISOString();
const window = (id: string, minutes: number, usedPercent: number, days: number): QuotaWindow => ({
  id,
  label: id,
  durationMinutes: minutes,
  usedPercent,
  resetsAt: at(days),
});
const short = window('5 小时额度', 300, 20, 0.1);
const week = window('每周额度', 10080, 40, 6);
const fable = { ...window('Fable · 每周额度', 10080, 99, 3), modelFamily: 'fable' as const };
const claude: RuntimeSnapshot = {
  id: 'claude',
  label: 'Claude',
  provider: 'claude',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [],
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: at(0),
  subscription: { label: 'Max', source: 'fixture', observedAt: at(0) },
  accounting: { mode: 'subscription', source: 'fixture' },
  quota: { status: 'known', observedAt: at(0), source: 'fixture', windows: [short, week, fable] },
};
const budget: ApiBudgetView = {
  policy: {
    limitUsd: 200,
    expiresAt: at(6),
    startedAt: at(-10),
    perRunUsd: 1,
    maxConcurrentRuns: 2,
    burstConcurrentRuns: 2,
    preferExpiring: true,
  },
  spentUsd: 20,
  remainingUsd: 180,
  reservedUsd: 0,
  unreportedRuns: 0,
  phase: 'priority',
  maxConcurrentRuns: 2,
};
const anthropic: ApiProviderView = {
  targetId: 'api-anthropic',
  preset: 'anthropic',
  label: 'Anthropic',
  enabled: true,
  console: 'fixture',
  currency: 'USD',
};
const deepseek: ApiProviderView = {
  targetId: 'api-deepseek',
  preset: 'deepseek',
  label: 'DeepSeek',
  enabled: true,
  console: 'fixture',
  currency: 'CNY',
};
const apiRuntime = (provider: ApiProviderView, apiBudgetState?: ApiBudgetView): RuntimeSnapshot => ({
  ...claude,
  id: provider.targetId,
  label: provider.label,
  provider: 'pi',
  apiProvider: provider.preset,
  gateway: 'api',
  subscription: undefined,
  authMode: 'apiKey',
  accounting: { mode: 'usage', source: 'fixture' },
  apiBudgetState,
  quota: { status: 'unknown', source: 'fixture', windows: [], observedAt: null },
});
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets: [],
  runtimes: [
    claude,
    apiRuntime(anthropic, budget),
    apiRuntime(deepseek, {
      ...budget,
      policy: { ...budget.policy, limitUsd: undefined, expiresAt: undefined },
      spentUsd: 12.34,
      remainingUsd: undefined,
    }),
  ],
  apiProviders: [anthropic, deepseek],
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
    defaultProjectPath: 'fixture',
    maxConcurrentRuns: 1,
  },
};
const props = {
  state,
  now,
  refreshing: false,
  refresh: async () => {},
  notify() {},
  onInspect() {},
  api: async <T>() => ({}) as T,
};
const pageBundle = uiBundle('src/ui/UsagePage.tsx');
const quotaBundle = uiBundle('src/ui/UsageQuota.tsx');
const webBundle = uiBundle('src/ui/ExternalAgents.tsx');

test('external usage results and new API callbacks never refetch or recreate the single poller', async () => {
  let requests = 0;
  let resolve: (value: unknown) => void = () => {};
  const timers = new Set<() => void>();
  const h = uiHarness(await webBundle, {
    setInterval(fn: () => void) {
      timers.add(fn);
      return fn;
    },
    clearInterval(fn: () => void) {
      timers.delete(fn);
    },
  });
  const api = () => {
    requests++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  h.render('WebAgentQuotas', { api, now });
  assert.equal(requests, 1);
  assert.equal(timers.size, 1);
  for (const poll of timers) poll();
  assert.equal(requests, 1, 'an unfinished reading cannot overlap');
  resolve({ agents: [] });
  await nextTurn();
  for (let i = 0; i < 5; i++) h.render('WebAgentQuotas', { api: () => api(), now });
  assert.equal(requests, 1, 'receiving a fresh array and rendering must not fetch');
  assert.equal(timers.size, 1);
  for (const poll of timers) poll();
  assert.equal(requests, 2);
  resolve({ agents: [] });
  await nextTurn();
  h.unmount();
  assert.equal(timers.size, 0);
});

// These leaf components have no hooks; expand them so assertions inspect bars/chips, not component names.
function leaves(tree: any): any {
  if (Array.isArray(tree)) return tree.map(leaves);
  if (!tree || typeof tree !== 'object' || !tree.props) return tree;
  if (['UsageBar', 'QuotaAttention', 'ExpiryChip', 'CompactQuotaSlots'].includes(tree.type?.name))
    return leaves(tree.type(tree.props));
  return { ...tree, props: { ...tree.props, children: leaves(tree.props.children) } };
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  return tree && typeof tree === 'object'
    ? text(tree.props?.children)
    : tree === null || tree === undefined || typeof tree === 'boolean'
      ? ''
      : String(tree);
}
function all(tree: any, check: (node: UiNode) => boolean): UiNode[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => all(child, check));
  return tree && typeof tree === 'object' && tree.props
    ? [...(check(tree) ? [tree] : []), ...all(tree.props.children, check)]
    : [];
}
const bars = (tree: any) => all(leaves(tree), (node) => node.props.role === 'progressbar');
const button = (tree: any, label: string) =>
  findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === label)!;
const slot = (tree: any, name: string) =>
  findNode(tree, (node) => node.props.className?.split(' ').includes(`compact-slot-${name}`))!;
function assertCompactSlots(tree: any) {
  const slots = findNode(leaves(tree), (node) => node.props.className === 'compact-quota-slots')!;
  assert.deepEqual(
    Array.from(slots.props.children, (child: UiNode) =>
      child.props.className.split(' ').find((name: string) => name.startsWith('compact-slot-')),
    ),
    [
      'compact-slot-header',
      'compact-slot-activity',
      'compact-slot-main',
      'compact-slot-bars',
      'compact-slot-reset',
      'compact-slot-chips',
    ],
  );
}

test('account grid ignores the retired view preference and opens only the clicked account', async () => {
  const saved = new Map<string, string>([['pugport-usage-view', 'compact']]);
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  };
  const harness = uiHarness(await pageBundle, { localStorage: storage });
  let tree = harness.render('UsagePage', props);
  assert.equal(button(tree, '展开'), undefined);
  assert.equal(button(tree, '紧凑'), undefined);
  assert.equal(saved.get('pugport-usage-view'), 'compact');
  assert.equal(findNode(tree, (node) => node.type?.name === 'WebAgentQuotas')!.props.compact, undefined);
  const grid = () => findNode(tree, (node) => node.type?.name === 'EvenCards')!;
  grid().props.onOpen('claude', { width: 230, height: 120 });
  tree = harness.render('UsagePage', props);
  const zoom = findNode(tree, (node) => node.type?.name === 'QuotaZoom')!;
  assert.equal(zoom.props.label, 'Claude');
  assert.equal(zoom.props.children.props.runtime.id, 'claude');
  zoom.props.onClose();
  tree = harness.render('UsagePage', props);
  grid().props.onOpen(anthropic.targetId, {});
  tree = harness.render('UsagePage', props);
  assert.equal(findNode(tree, (node) => node.type?.name === 'QuotaZoom')!.props.label, 'Anthropic');
  harness.unmount();
  const remount = uiHarness(await pageBundle, { localStorage: storage });
  tree = remount.render('UsagePage', props);
  assert.equal(button(tree, '紧凑'), undefined);
  assert.equal(findNode(tree, (node) => node.type?.name === 'EvenCards') !== undefined, true);
  assert.equal(findNode(tree, (node) => node.type?.name === 'WebAgentQuotas')!.props.compact, undefined);
  assert.equal(saved.get('pugport-usage-view'), 'compact', 'the obsolete preference is no longer written');
  remount.unmount();
  const unavailable = uiHarness(await pageBundle, {
    localStorage: {
      getItem() {
        throw Error('disabled');
      },
      setItem() {
        throw Error('disabled');
      },
    },
  });
  tree = unavailable.render('UsagePage', props);
  assert.equal(findNode(tree, (node) => node.type?.name === 'EvenCards') !== undefined, true);
  assert.equal(button(tree, '紧凑'), undefined);
  unavailable.unmount();
});

test('expanded and compact cards show one activity control with error priority', () => {
  for (const compact of [false, true]) {
    const card = (runtime: RuntimeSnapshot) =>
      compact
        ? createElement(CompactQuotaCard, { runtime, now, maxAge: 120, onOpen() {} })
        : createElement(QuotaCard, { runtime, now, maxAge: 120 });
    const render = (runtime: RuntimeSnapshot) =>
      renderToStaticMarkup(
        createElement(
          ExecutorActivityContext.Provider,
          {
            value: {
              tasks: new Map([
                [runtime.id, [{ id: 'run', status: 'running' as const, phase: '正在执行', startedAt: at(0) }]],
              ]),
              conversations: [],
              now,
            },
          },
          card(runtime),
        ),
      );
    const html = render(claude);
    assert.match(html, /运行中 · 1/);
    assert.equal((html.match(/class="quota-status executor-activity/g) ?? []).length, 1);
    assert.match(html, /aria-haspopup="menu"/);
    const failed = render({ ...claude, status: 'auth-required', note: 'authentication-required' });
    assert.doesNotMatch(failed, /运行中 · 1/);
    assert.match(failed, /executor-activity error/);
  }
});

test('compact bars match tray selection, hide Fable, and pair resets with the selected window', async () => {
  const harness = uiHarness(await quotaBundle);
  const render = (runtime: RuntimeSnapshot) =>
    leaves(harness.render('CompactQuotaCard', { runtime, now, maxAge: 120, onOpen() {} }));
  let tree = render(claude);
  assert.deepEqual(
    bars(tree).map((node) => node.props['aria-valuenow']),
    [60],
  );
  assert.match(text(tree), /每周额度.*6 天后重置/);
  assert.doesNotMatch(text(tree), /Fable|5 小时|fixture/);
  for (const [used, expected] of [
    [85, 60],
    [86, 14],
    [90, 10],
  ]) {
    tree = render({ ...claude, quota: { ...claude.quota, windows: [{ ...short, usedPercent: used }, week, fable] } });
    assert.deepEqual(
      bars(tree).map((node) => node.props['aria-valuenow']),
      [expected],
    );
    assert.match(text(tree), used > 85 ? /5 小时额度/ : /每周额度/);
    if (used > 85) assert.doesNotMatch(text(tree), /6 天后重置/);
  }
  tree = render({
    ...claude,
    provider: 'cursor',
    label: 'Cursor',
    quota: {
      ...claude.quota,
      windows: [
        { ...week, id: 'cursor', label: 'Cursor Models', modelPool: 'cursor', usedPercent: 10 },
        { ...week, id: 'other', label: 'Other Models', modelPool: 'other', usedPercent: 40 },
      ],
    },
  });
  assert.deepEqual(
    bars(tree).map((node) => node.props['aria-valuenow']),
    [90, 60],
  );
  assert.match(text(tree), /Cursor.*其他模型/);
  assertCompactSlots(tree);
  assert.equal(slot(tree, 'main').props.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  assert.equal(slot(tree, 'bars').props.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
  assert.equal(bars(slot(tree, 'bars')).length, 2);
  assert.equal(bars(slot(tree, 'main')).length, 0);
  const expanded = renderToStaticMarkup(createElement(QuotaCard, { runtime: claude, now, maxAge: 120 }));
  assert.match(expanded, /Fable · 每周额度/);
  assert.equal((expanded.match(/role="progressbar"/g) ?? []).length, 3);
});

test('compact stale/error readings remain visible, and tile supports keyboard and pointer activation', async () => {
  const harness = uiHarness(await quotaBundle);
  let opened = 0;
  const tree = leaves(
    harness.render('CompactQuotaCard', {
      runtime: {
        ...claude,
        quota: { ...claude.quota, status: 'error', windows: [], note: '读取失败' },
        lastKnownQuota: claude.quota,
      },
      now,
      maxAge: 120,
      onOpen: () => opened++,
    }),
  );
  assert.deepEqual(
    bars(tree).map((node) => node.props['aria-valuenow']),
    [60],
  );
  assert.match(text(tree), /读取失败/);
  assert.ok(findNode(tree, (node) => node.props.title === '上次读数'));
  assert.doesNotMatch(text(tree), /上次读数/);
  const currentTarget = { getBoundingClientRect: () => ({}) };
  tree.props.onClick({ currentTarget });
  for (const key of ['Enter', ' '])
    tree.props.onKeyDown({ key, currentTarget, target: currentTarget, preventDefault() {} });
  tree.props.onKeyDown({ key: 'Enter', currentTarget, target: {}, preventDefault() {} });
  assert.equal(opened, 3);
  const blocked = leaves(
    harness.render('CompactQuotaCard', {
      runtime: { ...claude, availability: { reason: 'quota', observedAt: at(0), retryAt: at(0.1) } },
      now,
      maxAge: 120,
      onOpen() {},
    }),
  );
  assert.match(text(blocked), /请求额度受限/);
});

for (const compact of [false, true]) {
  test(`uncapped PAYG APIs and redundant account counts are hidden in ${compact ? 'compact' : 'expanded'} view`, async () => {
    const harness = uiHarness(await pageBundle, {
      localStorage: { getItem: () => (compact ? 'compact' : 'expanded'), setItem() {} },
    });
    const tree = harness.render('UsagePage', props);
    const summary = findNode(tree, (node) => node.props.className === 'resource-summary')!;
    assert.equal(summary, undefined);
    assert.doesNotMatch(text(tree), /运行中的额度变更|秒周期检查|个已登录平台账号|个已报告额度来源|个按用量统计/);
    const cards = all(tree, (node) => node.type?.name === 'ApiQuotaCard');
    assert.deepEqual(
      cards.map((card) => card.props.provider.targetId),
      [anthropic.targetId],
    );
    const quota = uiHarness(await quotaBundle);
    const capped = leaves(quota.render('ApiQuotaCard', { ...cards[0]!.props, compact }));
    assert.match(
      text(capped),
      compact
        ? /Anthropic.*API 额度.*已用 \$20.00 \/ \$200.00.*6 天后到期/
        : /Anthropic.*API 额度.*已用\s*\$20.00 \/ \$200.00.*6 天后到期/,
    );
    assert.doesNotMatch(text(capped), /剩余 \$|剩余 90%/);
    if (compact) {
      assertCompactSlots(capped);
      assert.equal(text(slot(capped, 'main')), '已用 $20.00 / $200.00');
      assert.equal(bars(slot(capped, 'bars')).length, 1);
      assert.equal(text(slot(capped, 'bars')), '');
      assert.equal(text(slot(capped, 'reset')), '');
      assert.match(text(slot(capped, 'chips')), /6 天后到期/);
      assert.doesNotMatch(text(capped), /剩余 \$|剩余 90%/);
    }
    assert.deepEqual(
      bars(capped).map((node) => node.props['aria-valuenow']),
      [90],
    );
    assert.ok(findNode(capped, (node) => node.props.className?.includes('expiry-warning')));
    harness.unmount();
  });

  test(`a recurring credit measures against the monthly grant and names its linked account in ${compact ? 'compact' : 'expanded'} view`, async () => {
    const quota = uiHarness(await quotaBundle);
    const monthly: ApiBudgetView = {
      ...budget,
      spentUsd: 0,
      reservedUsd: 0,
      remainingUsd: 84,
      policy: { ...budget.policy, limitUsd: 84, monthlyUsd: 200, linkedAccountId: claude.id },
    };
    const card = leaves(
      quota.render('ApiQuotaCard', {
        provider: anthropic,
        runtime: apiRuntime(anthropic, monthly),
        now,
        compact,
        linkedRuntime: (id: string) => (id === claude.id ? claude : undefined),
      }),
    );
    assert.match(text(card), /本月剩余\s*\$84.00 \/ \$200.00/);
    assert.deepEqual(
      bars(card).map((node) => node.props['aria-valuenow']),
      [42],
    );
    assert.match(text(card), new RegExp(`${claude.label} 会员赠金`));
  });

  test(`API cap or expiry changes update visibility in ${compact ? 'compact' : 'expanded'} view`, async () => {
    const harness = uiHarness(await pageBundle, {
      localStorage: { getItem: () => (compact ? 'compact' : 'expanded'), setItem() {} },
    });
    const paygBudget = state.runtimes.find((runtime) => runtime.id === deepseek.targetId)!.apiBudgetState!;
    const render = (runtimeBudget?: ApiBudgetView, cachedBudget?: ApiBudgetView) =>
      harness.render('UsagePage', {
        ...props,
        state: {
          ...state,
          runtimes: [claude, apiRuntime(anthropic, budget), apiRuntime(deepseek, runtimeBudget)],
          apiProviders: [
            anthropic,
            {
              ...deepseek,
              budget: cachedBudget,
              balance: { amounts: [{ currency: 'CNY', total: 50 }], observedAt: at(0) },
            },
          ],
        },
      });
    for (const [policy, shown] of [
      [{ ...paygBudget.policy, limitUsd: 200 }, true],
      [{ ...paygBudget.policy, expiresAt: at(6) }, true],
      // A one-time credit that has already expired has nothing left to show.
      [{ ...paygBudget.policy, expiresAt: at(-1) }, false],
    ] as const) {
      const watchedBudget = { ...paygBudget, policy };
      for (const [live, cached] of [
        [watchedBudget, undefined],
        [undefined, watchedBudget],
      ]) {
        let tree = render(live, cached);
        assert.deepEqual(
          all(tree, (node) => node.type?.name === 'ApiQuotaCard').map((card) => card.props.provider.targetId),
          shown ? [anthropic.targetId, deepseek.targetId] : [anthropic.targetId],
        );
        assert.equal(
          findNode(tree, (node) => node.props.className === 'resource-summary'),
          undefined,
        );
        // Live PAYG state supersedes a cached cap/expiry; balances alone do not make an account visible.
        tree = render(paygBudget, watchedBudget);
        assert.equal(all(tree, (node) => node.type?.name === 'ApiQuotaCard').length, 1);
        assert.equal(
          findNode(tree, (node) => node.props.className === 'resource-summary'),
          undefined,
        );
      }
    }
    harness.unmount();
  });
}

test('API budgets prefer live runtime state, retain fallback state, and never show expired credit as spendable', async () => {
  const harness = uiHarness(await quotaBundle);
  const cached = { ...anthropic, budget: { ...budget, spentUsd: 99, remainingUsd: 101 } };
  let tree = leaves(harness.render('ApiQuotaCard', { provider: cached, runtime: apiRuntime(anthropic, budget), now }));
  assert.match(text(tree), /已用\s*\$20.00/);
  tree = leaves(harness.render('ApiQuotaCard', { provider: cached, now }));
  assert.match(text(tree), /已用\s*\$99.00/);
  tree = leaves(
    harness.render('ApiQuotaCard', {
      provider: anthropic,
      runtime: apiRuntime(anthropic, { ...budget, policy: { ...budget.policy, expiresAt: at(-1) }, phase: 'normal' }),
      now,
    }),
  );
  assert.deepEqual(
    bars(tree).map((node) => node.props['aria-valuenow']),
    [0],
  );
  assert.match(text(tree), /已到期/);
  tree = leaves(harness.render('ApiQuotaCard', { provider: deepseek, now, compact: true }));
  assert.match(text(tree), /本期消耗 未报告/);
  assert.equal(bars(tree).length, 0);
});

test('expiry chips highlight Cursor grants, API credits, and Codex reset cards only below seven days', async () => {
  const harness = uiHarness(await quotaBundle);
  for (const days of [6, 7, 8, 0.25]) {
    const tree = harness.render('ExpiryChip', { at: at(days), now, label: '赠金', amount: 17.74 });
    assert.equal(tree.props.className.includes('expiry-warning'), days < 7);
    assert.match(text(tree), /\$17.74/);
  }
  for (const at of [null, 'invalid'])
    assert.equal(harness.render('ExpiryChip', { at, now, label: '重置卡', urgentOnly: true }), null);
  const runtime: RuntimeSnapshot = {
    ...claude,
    provider: 'codex',
    quota: {
      ...claude.quota,
      resetCredits: {
        availableCount: 3,
        source: 'fixture',
        observedAt: at(0),
        details: [
          { kind: 'full', status: 'available', expiresAt: at(6), grantedAt: null },
          { kind: 'full', status: 'available', expiresAt: at(-1), grantedAt: null },
          { kind: 'full', status: 'consumed', expiresAt: at(1), grantedAt: null },
        ],
      },
      cursorCredits: {
        balanceUsd: 17.74,
        totalUsd: 20,
        usedUsd: 2.26,
        onDemand: null,
        grants: [{ name: 'Event credits', remainingUsd: 17.74, totalUsd: 20, expiresAt: at(6) }],
      },
    },
  };
  for (const compact of [false, true]) {
    const tree = leaves(harness.render('QuotaAttention', { runtime, now, compact }));
    assert.equal(all(tree, (node) => node.props.className?.includes('expiry-warning')).length, 2);
    assert.match(text(tree), /活动赠金 6 天后到期.*重置卡 6 天后到期/);
    assert.equal(text(tree).includes('$17.74'), compact);
    if (compact) assert.match(text(tree), /重置卡 2/);
  }
  const html = renderToStaticMarkup(createElement(QuotaCard, { runtime, now, maxAge: 120 }));
  assert.match(html, /usage-chip expiry-warning[^>]*>重置卡/);
});

test('web agents share quota bars and slots without nested cards or stale chips', async () => {
  const harness = uiHarness(await webBundle);
  const agents = ['Grok Bot', 'Muse'].map((name, index) => ({
    id: String(index),
    name,
    kind: 'web',
    enabled: true,
    available: true,
    quota: {
      ...claude.quota,
      windows: [week],
      balances:
        name === 'Muse'
          ? [{ id: 'extra', label: '额外额度', usedPercent: 0, remainingTokens: 25.9e9, observedAt: at(0) }]
          : [],
    },
  })) as ExternalAgentView[];
  for (const compact of [false, true]) {
    const tree = leaves(harness.render('WebAgentQuotaRows', { agents, now, compact, onRead() {} }));
    assert.equal(tree.props['aria-label'], '外部智能体');
    assert.match(text(tree), /Grok Bot.*Muse/);
    const details = all(tree, (node) => node.type === 'details');
    assert.equal(details.length, compact ? 0 : 2);
    if (compact) {
      const tiles = all(tree, (node) => node.props.className?.includes('web-compact-card'));
      assert.equal(tiles.length, 2);
      for (const tile of tiles) {
        assertCompactSlots(tile);
        assert.equal(bars(slot(tile, 'bars')).length, 1);
        if (text(tile).includes('Muse')) assert.match(tile.props.title, /剩余 259 亿词元 · 从不过期/);
        assert.match(text(slot(tile, 'reset')), /6 天后重置/);
      }
      assert.equal(all(tree, (node) => node.type === 'button').length, 0);
    } else {
      assert.equal(all(tree, (node) => node.type === 'button').length, 0);
      assert.match(text(tree), /剩余 259 亿词元 · 从不过期/);
      assert.equal(bars(tree).length, 2);
    }
  }
  const unread = leaves(
    harness.render('WebAgentQuotaRows', { agents: [{ ...agents[0], quota: undefined }], now, compact: true }),
  );
  assertCompactSlots(unread);
  assert.equal(bars(slot(unread, 'bars')).length, 0);
  assert.equal(text(slot(unread, 'reset')), '');
  assert.ok(findNode(unread, (node) => node.type === 'footer'));
  const stale = leaves(
    harness.render('WebAgentQuotaRows', {
      agents: [{ ...agents[1], quota: { ...agents[1]!.quota!, stale: true } }],
      now,
      compact: true,
    }),
  );
  assert.ok(findNode(stale, (node) => node.props.style?.opacity === 0.55));
  assert.equal(all(stale, (node) => node.props.className?.split(' ').includes('usage-chip')).length, 0);
});

test('compact slots reserve empty rows and retain full names and labels in tooltips', async () => {
  const harness = uiHarness(await quotaBundle);
  const label = 'A very long account name that should stay on one line';
  const plan = 'A very long subscription plan';
  const tree = leaves(
    harness.render('CompactQuotaCard', {
      runtime: { ...claude, label, subscription: { ...claude.subscription!, label: plan } },
      now,
      maxAge: 120,
      onOpen() {},
    }),
  );
  assertCompactSlots(tree);
  assert.equal(findNode(tree, (node) => node.type === 'h3')!.props.title, label);
  assert.equal(findNode(tree, (node) => node.props.className === 'plan-badge')!.props.title, plan);
  assert.equal(text(slot(tree, 'chips')), '');
  const unlimited = leaves(
    harness.render('CompactQuotaCard', {
      runtime: { ...claude, quota: { ...claude.quota, unlimited: true } },
      now,
      maxAge: 120,
      onOpen() {},
    }),
  );
  assertCompactSlots(unlimited);
  assert.equal(text(slot(unlimited, 'main')), '不限量');
  assert.equal(bars(slot(unlimited, 'bars')).length, 0);
});

test('compact reset rows show countdowns with absolute dates only in titles', async () => {
  const harness = uiHarness(await quotaBundle);
  for (const resetsAt of [at(6), at(-1), null, 'invalid']) {
    const tree = leaves(
      harness.render('CompactQuotaCard', {
        runtime: { ...claude, quota: { ...claude.quota, windows: [{ ...week, resetsAt }] } },
        now,
        maxAge: 120,
        onOpen() {},
      }),
    );
    const rows = all(slot(tree, 'reset'), (node) => node.type === 'span');
    assert.equal(rows.length, 1);
    if (resetsAt && resetsAt !== 'invalid') {
      assert.ok(rows[0].props.title);
      assert.doesNotMatch(text(rows[0]), / · /);
      assert.match(text(rows[0]), resetsAt === at(6) ? /6 天后重置/ : /已到重置时间，待刷新/);
    } else assert.equal(text(rows[0]), '重置时间未知');
  }
});

test('Cursor shares its reported plan across expanded and compact cards and uses short pool labels', async () => {
  const harness = uiHarness(await quotaBundle);
  const runtime: RuntimeSnapshot = {
    ...claude,
    provider: 'cursor',
    label: 'Cursor',
    subscription: undefined,
    quota: {
      ...claude.quota,
      subscription: { label: 'Pro', source: 'fixture', observedAt: at(0) },
      windows: [
        { ...week, id: 'cursor', label: 'Cursor Models', modelPool: 'cursor' },
        { ...week, id: 'other', label: 'Other Models', modelPool: 'other' },
      ],
    },
  };
  const tree = leaves(harness.render('CompactQuotaCard', { runtime, now, maxAge: 120, onOpen() {} }));
  assert.equal(text(findNode(tree, (node) => node.props.className === 'plan-badge')), 'Pro');
  assert.deepEqual(all(slot(tree, 'main'), (node) => node.type === 'span').map(text), ['Cursor', '其他模型']);
  assert.doesNotMatch(text(slot(tree, 'main')), /剩余|Models/);
  assert.match(
    renderToStaticMarkup(createElement(QuotaCard, { runtime, now, maxAge: 120 })),
    /class="plan-badge">Pro</,
  );
});

test('expanded subscription, API and web cards stretch rows and pin the same footer skeleton', async () => {
  const css = readFileSync('src/ui/studio.css', 'utf8');
  assert.match(
    css,
    /\.resource-grid\s*\{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(270px, 1fr\)\)[^}]*gap: 16px;[^}]*align-items: stretch;/,
  );
  assert.match(css, /\.quota-card\s*\{[^}]*display: flex;[^}]*flex-direction: column;/);
  assert.match(css, /\.quota-footer\s*\{[^}]*margin-top: auto;/);
  const native = uiHarness(await uiBundle('src/ui/App.tsx')).render('QuotaCard', { runtime: claude, now, maxAge: 120 });
  const api = uiHarness(await quotaBundle).render('ApiQuotaCard', {
    provider: anthropic,
    runtime: apiRuntime(anthropic, budget),
    now,
  });
  const web = uiHarness(await webBundle).render('WebAgentQuotaRows', {
    agents: [
      { id: 'muse', name: 'Muse', kind: 'web', enabled: true, available: true, description: '', quota: claude.quota },
    ],
    now,
  });
  for (const tree of [native, api, web]) {
    const card = findNode(tree, (node) => node.type === 'article')!;
    const children = all(card, (node) =>
      ['quota-heading', 'quota-body', 'quota-footer'].includes(node.props.className),
    );
    assert.deepEqual(
      children.map((node) => node.props.className),
      ['quota-heading', 'quota-body', 'quota-footer'],
    );
    assert.equal(children[2]!.type, 'footer');
    if (tree !== api) assert.ok(findNode(children[2], (node) => node.props.className === 'quota-footer-line'));
  }
});

test('Cursor timeout reference has exactly one amber header status and compact grants get a full line', async () => {
  const cursor: RuntimeSnapshot = {
    ...claude,
    provider: 'cursor',
    label: 'Cursor',
    status: 'error',
    note: 'runtime-timeout',
    accountFingerprint: 'synthetic',
    cursorVerifiedIdentity: { fingerprint: 'synthetic', emailHash: 'synthetic', observedAt: at(0) },
    quota: { status: 'unknown', windows: [], source: 'fixture', observedAt: null },
    lastKnownQuota: {
      ...claude.quota,
      cursorCredits: {
        balanceUsd: 10,
        totalUsd: 10,
        usedUsd: 0,
        onDemand: { enabled: false, limitUsd: null, usedUsd: 0 },
        grants: [{ name: 'fixture', remainingUsd: 10, totalUsd: 10, expiresAt: at(6) }],
      },
    },
  };
  const html = renderToStaticMarkup(createElement(QuotaCard, { runtime: cursor, now, maxAge: 120 }));
  assert.equal((html.match(/检查超时/g) ?? []).length, 1);
  assert.match(html, /executor-activity error request-limited[\s\S]*检查超时 · 显示上次读数/);
  assert.doesNotMatch(html, /上次报告 · 正在等待|quota-connection-note|runtime-timeout/);
  const h = uiHarness(await quotaBundle);
  const compact = leaves(h.render('CompactQuotaCard', { runtime: cursor, now, maxAge: 120, onOpen() {} }));
  assert.match(text(compact), /检查超时/);
  assert.doesNotMatch(text(compact), /runtime-|上次读数/);
  assert.ok(findNode(compact, (node) => node.props.className?.includes('grant-chip')));
  const css = readFileSync('src/ui/studio.css', 'utf8');
  assert.match(
    css,
    /\.compact-quota-slots \.usage-chip\.grant-chip\s*\{[^}]*flex-basis: 100%;[^}]*white-space: normal;/,
  );
  for (const code of [
    'runtime-network-error',
    'runtime-protocol-incompatible',
    'runtime-request-failed',
    'runtime-process-closed',
    'runtime-not-found',
    'runtime-unrecognized',
  ]) {
    const tree = leaves(
      h.render('CompactQuotaCard', {
        runtime: { ...cursor, note: code, quota: { ...cursor.quota, status: 'error', note: code } },
        now,
        maxAge: 120,
        onOpen() {},
      }),
    );
    assert.doesNotMatch(text(tree), /runtime-/);
  }
});

test('web cards share percentage, plan, reset and timestamp formatting', async () => {
  const observedAt = new Date(now).toISOString();
  const agent: ExternalAgentView = {
    id: 'muse',
    name: 'Muse',
    kind: 'web',
    description: '',
    enabled: true,
    available: true,
    quota: {
      ...claude.quota,
      observedAt,
      subscription: { label: '免费版', source: 'fixture', observedAt },
      windows: [window('每周额度', 10080, 87, 2)],
    },
  };
  const h = uiHarness(await webBundle);
  const tree = leaves(h.render('WebAgentQuotaRows', { agents: [agent], now }));
  assert.equal(all(tree, (node) => node.type === 'article').length, 1);
  assert.doesNotMatch(text(tree), /dot|网页|每 10 分钟自动刷新|打开设置时刷新用量/);
  assert.match(text(tree), /免费版/);
  const percentage = findNode(tree, (node) => node.type === 'strong')!;
  assert.equal(text(percentage), '剩余 13%');
  assert.equal(percentage.props.translate, 'no');
  assert.equal(
    findNode(percentage, (node) => node.type === 'small'),
    undefined,
  );
  const reset = findNode(tree, (node) => node.props.className === 'reset-time')!;
  assert.equal(text(reset), '2 天后重置');
  assert.ok(reset.props.title);
  assert.equal(
    findNode(tree, (node) => node.type === 'time'),
    undefined,
  );
  const old = leaves(h.render('WebAgentQuotaRows', { agents: [agent], now: now + 10 * 60_000 }));
  assert.ok(findNode(old, (node) => node.props.title === '上次读数' && node.props.style?.opacity === 0.55));
  const noPlan = leaves(
    h.render('WebAgentQuotaRows', {
      agents: [
        {
          ...agent,
          id: 'grok-bot',
          name: 'Grok Bot',
          kind: 'handoff',
          quota: {
            ...agent.quota!,
            subscription: undefined,
            windows: [{ ...week, resetsAt: null, resetNotReported: true }],
          },
        },
      ],
      now,
    }),
  );
  assert.equal(
    findNode(noPlan, (node) => node.props.className === 'plan-badge'),
    undefined,
  );
  assert.equal(text(findNode(noPlan, (node) => node.props.className === 'reset-time')), 'Cursor 没有提供重置时间');
});

test('Grok extra credits show an amount only when enabled or nonzero', () => {
  for (const [extraUsd, autoTopup] of [
    [0, false],
    [0, true],
    [2.5, false],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(QuotaCard, {
        runtime: { ...claude, provider: 'grok', quota: { ...claude.quota, grokCredits: { extraUsd, autoTopup } } },
        now,
        maxAge: 120,
      }),
    );
    const line = html.match(/<p class="quota-note">额外积分[^<]*<\/p>/)?.[0]!;
    assert.ok(line);
    assert.equal(line.includes('$'), autoTopup || extraUsd > 0);
    assert.doesNotMatch(html, /额外使用积分 \/ 自动充值/);
  }
});

test('retired cloud classification usage is hidden even when old settings and usage remain', async () => {
  const harness = uiHarness(await pageBundle);
  const usage = { calls: 2, attemptedCalls: 1, inputTokens: 5, outputTokens: 1, totalTokens: 6, costUsd: null };
  const legacy = {
    ...state,
    settings: { ...state.settings, taskJudgment: 'jev', memoryEvidence: 'jev' },
    jev: { configured: true, enabled: true, status: 'configured-unverified', note: '' },
    judgmentUsage: { ...usage, byProject: [] },
  } as unknown as AppState;
  for (const saved of [state, legacy]) {
    const view = { ...props, state: saved, view: 'usage' };
    const tree = harness.render('UsagePage', view);
    assert.equal(
      findNode(tree, (node) => node.type?.name === 'TaskJudgmentUsage'),
      undefined,
    );
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === '任务判断用量'),
      undefined,
    );
  }
  harness.unmount();
});

test('API cards show linear planned spend and a priority badge only while behind and usable', async () => {
  const harness = uiHarness(await quotaBundle);
  for (const compact of [false, true]) {
    for (const spentUsd of [20, 125, 140]) {
      const view = { ...budget, spentUsd, remainingUsd: 200 - spentUsd };
      const tree = leaves(
        harness.render('ApiQuotaCard', { provider: anthropic, runtime: apiRuntime(anthropic, view), now, compact }),
      );
      assert.ok(text(tree).includes(`按计划应已用 $114.29，实际 $${spentUsd.toFixed(2)}`));
      assert.equal(text(tree).includes('正在优先用掉'), spentUsd < 114.29);
    }
    for (const policy of [
      { ...budget.policy, expiresAt: undefined },
      { ...budget.policy, expiresAt: at(-1) },
      { ...budget.policy, preferExpiring: false },
    ]) {
      const tree = leaves(
        harness.render('ApiQuotaCard', {
          provider: anthropic,
          runtime: apiRuntime(anthropic, { ...budget, policy }),
          now,
          compact,
        }),
      );
      assert.ok(!text(tree).includes('正在优先用掉'));
    }
  }
  harness.unmount();
});
