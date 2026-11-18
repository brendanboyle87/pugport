import { ExecutorActivityContext } from '../src/ui/ExecutorActivity.tsx';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuotaCard } from '../src/ui/App.tsx';
import { ApiQuotaCard, CompactQuotaCard } from '../src/ui/UsageQuota.tsx';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { quotaLines, quotaReadingPending } from '../src/shared/quota-summary.ts';
import { trayPopupHtml } from '../src/electron/tray-popup.ts';
import { UsagePage } from '../src/ui/UsagePage.tsx';
import { availableCoreTargets } from '../src/ui/core-runtime.ts';
import { accountSnapshot } from '../src/server/accounting.ts';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

const epoch = Date.parse('2026-09-27T20:00:00Z');
const target: RuntimeTarget = {
  id: 'grok-test',
  provider: 'grok',
  label: 'Grok',
  command: 'unused',
  enabled: true,
  environment: 'native',
};
const snapshot: RuntimeSnapshot = {
  ...target,
  installed: true,
  status: 'ready',
  models: [],
  refreshedAt: new Date(epoch).toISOString(),
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  accounting: { mode: 'usage', source: 'token events' },
  quota: {
    status: 'known',
    source: 'Grok CLI _x.ai/billing',
    observedAt: new Date(epoch).toISOString(),
    windows: [{ id: 'weekly', label: '每周额度', usedPercent: 55, resetsAt: new Date(epoch + 60000).toISOString() }],
  },
};
const render = (value: RuntimeSnapshot) =>
  renderToStaticMarkup(createElement(QuotaCard, { runtime: value, now: epoch, maxAge: 120 }));

const resetAccount = (): RuntimeSnapshot => ({
  ...snapshot,
  provider: 'codex',
  label: 'Codex 测试账号',
  authMode: 'chatgpt',
  accountFingerprint: 'synthetic-reset-account',
  quota: {
    ...snapshot.quota,
    windows: [{ ...snapshot.quota.windows[0]!, usedPercent: 90 }],
    resetCredits: {
      availableCount: 1,
      observedAt: new Date(epoch).toISOString(),
      source: 'synthetic',
      details: [
        {
          key: 'a'.repeat(64),
          kind: 'full',
          status: 'available',
          grantedAt: null,
          expiresAt: new Date(epoch + 20 * 3_600_000).toISOString(),
        },
      ],
    },
  },
});

test('Codex account card renders the low-quota suggestion beside its existing manual redemption details', () => {
  const value = resetAccount();
  const before = structuredClone(value);
  const html = render(value);
  const body = html.split('<footer')[0]!;
  assert.match(body, /额度快用完了，有 1 张重置卡（20 小时后到期），可以在详情里用一张/);
  assert.match(html, /使用重置/);
  assert.match(html, /不自动使用/);
  assert.doesNotMatch(html, /确认使用/);
  assert.deepEqual(value, before);
  for (const change of [
    'not-low',
    'no-card',
    'expired-card',
    'consumed-card',
    'reset-window',
    'unknown',
    'other-provider',
  ]) {
    const account = resetAccount();
    if (change === 'not-low') account.quota.windows[0]!.usedPercent = 85;
    if (change === 'no-card') account.quota.resetCredits = undefined;
    if (change === 'expired-card') account.quota.resetCredits!.details![0]!.expiresAt = new Date(epoch).toISOString();
    if (change === 'consumed-card') {
      account.quota.resetCredits!.availableCount = 0;
      account.quota.resetCredits!.details![0]!.status = 'consumed';
    }
    if (change === 'reset-window') account.quota.windows[0]!.resetsAt = new Date(epoch).toISOString();
    if (change === 'unknown') account.quota.status = 'unknown';
    if (change === 'other-provider') account.provider = 'claude';
    assert.doesNotMatch(render(account), /额度快用完了，有/, change);
  }
});

test('automatic-use records stay visible on the account card when the switch is turned off', () => {
  const value = resetAccount();
  value.autoResetNotes = ['已自动用掉 1 张重置卡（原本 20 小时后到期）'];
  for (const autoUseResetCards of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(QuotaCard, { runtime: value, now: epoch, maxAge: 120, autoUseResetCards }),
    );
    assert.match(html.split('<footer')[0]!, /已自动用掉 1 张重置卡（原本 20 小时后到期）/);
    assert.match(html, autoUseResetCards ? /已开启按条件自动使用/ : /不自动使用/);
    assert.match(html, /使用重置/);
  }
});

test('native billing windows remain visible alongside cumulative usage, including source and reset', () => {
  const html = render(snapshot);
  assert.match(html, /45%/);
  assert.match(html, /Grok CLI _x.ai\/billing/);
  assert.match(html, /每周额度/);
  assert.match(html, /累计消耗/);
  assert.doesNotMatch(html, /按累计用量统计/);
});
test('native quota read errors do not disappear behind a usage card or imply full balance', () => {
  for (const provider of ['grok', 'claude', 'codex'] as const) {
    const html = render({
      ...snapshot,
      provider,
      quota: {
        status: 'error',
        source: 'official quota probe',
        observedAt: null,
        windows: [],
        note: '额度查询超时，请稍后刷新。',
      },
    });
    assert.match(html, /额度读取失败/);
    assert.match(html, /official quota probe/);
    assert.match(html, /额度查询超时/);
    assert.doesNotMatch(html, /100%|按累计用量统计/);
  }
});
test('an unknown percentage still shows its independently reported reset date and countdown', () => {
  const reset = '2026-09-27T20:01:00.000Z';
  const html = render({
    ...snapshot,
    label: 'Grok B',
    quota: {
      ...snapshot.quota,
      status: 'unknown',
      windows: [{ id: 'weekly', label: '每周额度', usedPercent: null, resetsAt: reset }],
    },
  });
  assert.match(html, /未知/);
  assert.match(html, /1 分钟后重置/);
  assert.match(html, /class="reset-time"[^>]*title="[^"]+"[^>]*>[\s\S]*?1 分钟后重置<\/time>/);
  assert.match(html, /dateTime="2026-09-27T20:01:00.000Z"/);
  assert.doesNotMatch(html, /预计重置：|quota-reset-date/);
  assert.doesNotMatch(html, /100%|按累计用量统计|role="progressbar"/);
});
test('aged quota keeps its reported balance with a quiet timestamp and explains freshness in details', () => {
  const html = render({
    ...snapshot,
    quota: { ...snapshot.quota, observedAt: new Date(epoch - 121_000).toISOString() },
  });
  const footer = html.split('<footer')[1]!;
  const summary = footer.split('<details')[0]!;
  const details = footer.split('<details')[1]!;
  assert.match(html, /45%/);
  assert.doesNotMatch(summary, /更新于/);
  assert.doesNotMatch(summary, /已过期|待刷新|上次报告|class="stale"/);
  assert.match(details, /当前显示上次报告的额度，刷新后核对/);
  assert.doesNotMatch(html, /已过期/);
});

test('running quota cards keep a short counted status without stale warnings or changing balance', () => {
  const value = { ...snapshot, quota: { ...snapshot.quota, observedAt: new Date(epoch - 31_000).toISOString() } };
  for (const now of [epoch, epoch + 15_000]) {
    for (const count of [1, 2, 4]) {
      const tasks = Array.from({ length: count }, (_, index) => ({
        id: String(index),
        status: 'running' as const,
        phase: '正在执行',
        startedAt: new Date(epoch).toISOString(),
      }));
      for (const card of [
        createElement(QuotaCard, { runtime: value, now, maxAge: 120 }),
        createElement(CompactQuotaCard, { runtime: value, now, maxAge: 120, onOpen() {} }),
      ]) {
        const html = renderToStaticMarkup(
          createElement(
            ExecutorActivityContext.Provider,
            { value: { tasks: new Map([[value.id, tasks]]), conversations: [], now } },
            card,
          ),
        );
        assert.ok(html.includes(`运行中 · ${count}`));
        assert.match(html, /45%/);
        assert.doesNotMatch(html, /\d+ 秒前更新|\d+ 分钟前更新|已过期|当前显示上次报告的额度/);
        assert.equal((html.match(/executor-activity/g) ?? []).length, 1);
      }
    }
  }
});

test('a fresh primary report does not hide an older secondary quota window in details', () => {
  const html = render({
    ...snapshot,
    quota: {
      ...snapshot.quota,
      observedAt: new Date(epoch).toISOString(),
      windows: [
        { ...snapshot.quota.windows[0]!, observedAt: new Date(epoch).toISOString() },
        {
          id: 'secondary',
          label: 'Other Models',
          usedPercent: 25,
          resetsAt: null,
          observedAt: new Date(epoch - 121_000).toISOString(),
        },
      ],
    },
  });
  assert.match(html, /<strong>45%/);
  assert.match(html, /<strong>75%/);
  const footer = html.split('<footer')[1]!;
  assert.doesNotMatch(footer.split('<details')[0]!, /更新于/);
  assert.doesNotMatch(footer.split('<details')[0]!, /已过期|class="stale"/);
  assert.match(footer.split('<details')[1]!, /当前显示上次报告的额度，刷新后核对/);
});

test('a verified historical quota is labelled as reference without hiding current connection errors', () => {
  const observedAt = new Date(epoch - 600_000).toISOString();
  const failed: RuntimeSnapshot = {
    ...snapshot,
    provider: 'cursor',
    status: 'error',
    note: 'runtime-timeout',
    quota: { status: 'error', source: 'failed current query', observedAt: null, windows: [] },
    lastKnownQuota: { ...snapshot.quota, source: 'historical provider endpoint', observedAt },
  };
  const html = render(failed);
  assert.match(html, /<strong>45%/);
  assert.match(html, /上次报告 · 正在等待新的额度读数/);
  assert.match(html, /连接异常/);
  assert.match(html, /Cursor 连接检查超时，会自动重试/);
  assert.match(html, /当前显示上次报告的额度，刷新后核对/);
  assert.match(html, /historical provider endpoint/);
  assert.ok(html.includes(`title="${observedAt}"`), 'the reference keeps its original observation time');
  assert.doesNotMatch(html, /就绪|已过期/);

  const cleared = render({ ...failed, lastKnownQuota: undefined });
  assert.match(cleared, /额度读取失败/);
  assert.match(cleared, /连接异常/);
  assert.doesNotMatch(cleared, /45%|上次报告|historical provider endpoint|role="progressbar"/);

  const fresh = render({
    ...snapshot,
    lastKnownQuota: { ...snapshot.quota, windows: [{ ...snapshot.quota.windows[0]!, usedPercent: 1 }] },
  });
  assert.match(fresh, /<strong>45%/);
  assert.doesNotMatch(fresh, /<strong>99%|上次报告/);
});

test('a finished Claude quota failure shows its error and keeps an optional historical reading', () => {
  const failed: RuntimeSnapshot = {
    ...snapshot,
    provider: 'claude',
    status: 'ready',
    quota: {
      status: 'error',
      source: 'Claude CLI get_usage (experimental)',
      observedAt: new Date(epoch).toISOString(),
      windows: [],
      note: 'runtime-network-error',
    },
  };
  for (const historical of [false, true]) {
    const runtime = { ...failed, lastKnownQuota: historical ? snapshot.quota : undefined };
    const detail = render(runtime);
    const compact = renderToStaticMarkup(
      createElement(CompactQuotaCard, { runtime, now: epoch, maxAge: 120, onOpen: () => {} }),
    );
    assert.doesNotMatch(detail + compact, /正在读取额度/);
    assert.match(compact, /网络错误/);
    assert.equal(quotaLines([runtime], [{ ...target, id: runtime.id, provider: 'claude' }])[0]?.pending, undefined);
    if (historical) {
      assert.match(detail, /上次报告/);
      assert.match(detail + compact, /45%/);
    } else {
      assert.match(detail, /额度读取失败/);
      assert.doesNotMatch(detail + compact, /45%/);
    }
  }
});

for (const status of ['auth-required', 'error', 'missing', 'unknown'] as const)
  test(`a completed ${status} discovery does not leave native quota displays loading`, () => {
    const runtime: RuntimeSnapshot = {
      ...snapshot,
      provider: 'claude',
      status,
      quota: { status: 'unknown', source: 'Claude CLI identity consistency check', observedAt: null, windows: [] },
    };
    const before = structuredClone(runtime);
    const compact = renderToStaticMarkup(
      createElement(CompactQuotaCard, { runtime, now: epoch, maxAge: 120, onOpen: () => {} }),
    );
    const lines = quotaLines([runtime], [{ ...target, provider: 'claude' }]);
    const tray = trayPopupHtml({ running: 0, totals: [], lines }, epoch);
    assert.equal(quotaReadingPending(runtime), false);
    assert.doesNotMatch(render(runtime) + compact + tray, /正在读取额度/);
    assert.equal(lines[0]?.pending, undefined);
    assert.deepEqual(runtime, before, 'displaying a completed check must not invent quota evidence');
  });

test('disabled Cursor usage and a completed Claude identity check show unknown quota without a fabricated timestamp', () => {
  for (const provider of ['cursor', 'claude'] as const) {
    const note =
      provider === 'cursor'
        ? 'Cursor 没有公开的余额查询；在“用量与连接”的 Cursor 一项里开启“自动读取用量和赠送额度”后，这里会自动显示。'
        : '查询期间无法确认同一 Claude 账号；未采用本次额度和套餐，请刷新后重试。';
    const runtime: RuntimeSnapshot = {
      ...snapshot,
      provider,
      quota: { status: 'unknown', source: 'synthetic completed check', observedAt: null, windows: [], note },
    };
    const compact = renderToStaticMarkup(
      createElement(CompactQuotaCard, { runtime, now: epoch, maxAge: 120, onOpen: () => {} }),
    );
    const lines = quotaLines([runtime], [{ ...target, provider }]);
    const tray = trayPopupHtml({ running: 0, totals: [], lines }, epoch);
    assert.equal(quotaReadingPending(runtime), false);
    assert.doesNotMatch(render(runtime) + compact + tray, /正在读取额度/);
    assert.match(render(runtime), /额度未报告/);
    assert.ok(render(runtime).includes(note));
    assert.equal(lines[0]?.pending, undefined);
    assert.equal(lines[0]?.observedAt, null);
    assert.deepEqual(runtime.quota.windows, []);
    assert.equal(runtime.lastKnownQuota, undefined);
  }
});

test('exhausted and unknown quota pools remain distinct and are never filled to 100 percent', () => {
  const exhausted = render({
    ...snapshot,
    quota: { ...snapshot.quota, windows: [{ ...snapshot.quota.windows[0]!, usedPercent: 100 }] },
  });
  assert.match(exhausted, /<strong>0%/);
  assert.match(exhausted, /aria-valuenow="0"/);
  assert.doesNotMatch(exhausted, /<strong>100%|未知/);
  const unknown = render({
    ...snapshot,
    quota: { ...snapshot.quota, windows: [{ ...snapshot.quota.windows[0]!, usedPercent: null }] },
  });
  assert.match(unknown, /<strong>未知/);
  assert.doesNotMatch(unknown, /role="progressbar"|<strong>100%|aria-valuenow="0"/);
});

test('a reset time alone does not refill quota, while a new provider report can increase it', () => {
  const oldWindow = { ...snapshot.quota.windows[0]!, usedPercent: 80, resetsAt: new Date(epoch - 1000).toISOString() };
  const before = render({ ...snapshot, quota: { ...snapshot.quota, windows: [oldWindow] } });
  assert.match(before, /<strong>20%/);
  assert.match(before, /已到重置时间，待刷新/);
  assert.doesNotMatch(before, /<strong>100%/);
  const after = render({
    ...snapshot,
    quota: {
      ...snapshot.quota,
      observedAt: new Date(epoch).toISOString(),
      windows: [{ ...oldWindow, usedPercent: 3, resetsAt: new Date(epoch + 7 * 86_400_000).toISOString() }],
    },
  });
  assert.match(after, /<strong>97%/);
  assert.match(after, /aria-valuenow="97"/);
  assert.doesNotMatch(after, /<strong>20%|已到重置时间/);
});

test('absence of a native quota is not evidence of usage billing, while an explicit API mode remains usage', () => {
  for (const provider of ['grok', 'claude'] as const) {
    const unknown = {
      ...snapshot,
      provider,
      accounting: undefined,
      quota: { status: 'unknown' as const, source: 'native', observedAt: null, windows: [] },
    };
    assert.equal(accountSnapshot(unknown, { ...target, provider }).accounting?.mode, 'unknown');
    assert.equal(
      accountSnapshot(
        { ...unknown, accounting: { mode: 'usage', source: 'CLI reports API authentication' } },
        { ...target, provider },
      ).accounting?.mode,
      'usage',
    );
  }
});

test('resource account cards and counts exclude Pi components while Pi stays available for execution', () => {
  const pi: RuntimeTarget = { ...target, id: 'pi-local', provider: 'pi', label: 'Pi component fixture' };
  const gateway: RuntimeTarget = { ...pi, id: 'pi-magpie', gateway: 'magpie', label: 'Pi gateway fixture' };
  const state: AppState = {
    app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
    targets: [target, pi, gateway],
    // Even a stale snapshot that wrongly labels Pi as a known quota must not add a platform account.
    runtimes: [snapshot, { ...snapshot, ...pi }, { ...snapshot, ...gateway }],
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
      defaultProjectPath: 'C:/Fixture',
      maxConcurrentRuns: 1,
    },
  };
  const html = renderToStaticMarkup(
    createElement(UsagePage, {
      state,
      api: async <T>() => ({}) as T,
      now: epoch,
      refreshing: false,
      refresh: async () => {},
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /45%/);
  assert.doesNotMatch(html, /个已登录平台账号|个已报告额度来源|个按用量统计|运行中的额度变更/);
  assert.doesNotMatch(html, /Pi component fixture|Pi gateway fixture/);
  assert.doesNotMatch(html, /API 的费用和余额见/);
  assert.deepEqual(
    availableCoreTargets(state.targets, 'api-only').map((value) => value.id),
    ['pi-local', 'pi-magpie'],
  );
  assert.equal(state.targets.length, 3, 'display filtering must not remove executable targets');
});

for (const provider of ['claude', 'codex', 'grok', 'cursor'] as const)
  test(`${provider} first quota observation has the same quiet wording on cards, compact tiles and tray`, () => {
    const runtime: RuntimeSnapshot = {
      ...snapshot,
      provider,
      accounting: { mode: 'subscription', source: 'synthetic' },
      quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    };
    const card = render(runtime);
    const compact = renderToStaticMarkup(
      createElement(CompactQuotaCard, { runtime, now: epoch, maxAge: 120, onOpen: () => {} }),
    );
    const tray = trayPopupHtml(
      { running: 0, totals: [], lines: quotaLines([runtime], [{ ...target, provider }]) },
      epoch,
    );
    for (const html of [card, compact, tray]) {
      assert.equal(html.replace(/<[^>]+>/g, '').split('正在读取额度…').length - 1, 1);
      assert.doesNotMatch(html, /额度未报告|此 CLI 没有提供订阅额度|尚未观测|额度未知/);
    }
    assert.equal(quotaReadingPending({ ...runtime, status: 'refreshing' }), true);
    assert.equal(quotaReadingPending({ ...runtime, quota: { ...runtime.quota, note: '  ' } }), true);
    assert.equal(quotaReadingPending({ ...runtime, lastKnownQuota: snapshot.quota }), false);
    const answered = render({
      ...runtime,
      quota: { ...runtime.quota, observedAt: new Date(epoch).toISOString(), note: '此 CLI 没有提供订阅额度。' },
    });
    assert.match(answered, /额度未报告/);
    assert.match(answered, /此 CLI 没有提供订阅额度/);
    assert.doesNotMatch(answered, /正在读取额度…/);
  });

test('a monthly API credit card counts down and names the renewal amount', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const policy = apiBudgetPolicy(
    { limitUsd: 84, expiresAt: new Date(2026, 10, 12).toISOString(), monthlyUsd: 200 },
    undefined,
    '2026-10-30T12:00:00Z',
  );
  const budget = apiBudgetView(policy, 0, 0, 0, now);
  const card = { targetId: 'api-openai-fixture', label: 'OpenAI', budget };
  const provider = card as never;
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(createElement(ApiQuotaCard, { provider, now, compact }));
    assert.match(html, /天后重置.*重置为 \$200\.00/);
    assert.doesNotMatch(html, /天后到期/);
  }
  // Paused (the linked account shows the free plan): say so, and that pinning does not bill per use.
  const paused = { ...card, budget: apiBudgetView(policy, 0, 0, 0, now, true) } as never;
  const html = renderToStaticMarkup(createElement(ApiQuotaCard, { provider: paused, now }));
  assert.match(html, /赠金暂停/);
  assert.match(html, /钉选时也不会按次计费/);
  assert.doesNotMatch(html, /按计划应已用/);
});
