import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { QuotaCard, ProviderMark } from '../src/ui/App.tsx';
import { UsagePage } from '../src/ui/UsagePage.tsx';
import { ExecutorsPage } from '../src/ui/Executors.tsx';
import { WorkspaceExecutionFields } from '../src/ui/Workspace.tsx';
import { routeOptions } from '../src/ui/RoutePolicyEditor.tsx';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const now = Date.parse('2026-10-03T12:00:00Z');
const fingerprint = 'a'.repeat(64);
const target: RuntimeTarget = {
  id: 'cursor-native',
  provider: 'cursor',
  label: 'Cursor',
  command: 'cursor-agent',
  enabled: true,
  environment: 'native',
  commandDiscovery: 'auto',
};
const runtime: RuntimeSnapshot = {
  ...target,
  installed: true,
  status: 'ready',
  accountFingerprint: fingerprint,
  models: [{ id: 'auto', label: 'Auto', efforts: [] }],
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  refreshedAt: new Date(now).toISOString(),
  subscription: { label: 'Pro', source: 'Cursor CLI status', observedAt: new Date(now).toISOString() },
  accounting: { mode: 'subscription', source: 'Cursor CLI status' },
  quota: {
    status: 'unknown',
    windows: [],
    observedAt: null,
    source: 'Cursor CLI status',
    note: 'CLI 未报告个人余额。',
  },
};
/** The same card once cursor.com usage is read (Settings → read Cursor usage automatically). */
const live: RuntimeSnapshot = {
  ...runtime,
  quota: {
    status: 'known',
    source: 'Cursor 编辑器登录 · cursor.com 用量',
    observedAt: new Date(now).toISOString(),
    windows: [
      { id: 'cursor-auto', label: 'Cursor Models', usedPercent: 10, resetsAt: '2026-10-29T17:20:10.000Z' },
      { id: 'cursor-api', label: 'Other Models', usedPercent: 40, resetsAt: '2026-10-29T17:20:10.000Z' },
    ],
    note: '本账期 9/29 至 10/29。',
    cursorCredits: {
      accountUsd: 40,
      balanceUsd: 65,
      totalUsd: 65,
      usedUsd: 0,
      grants: [{ name: 'Event credits', remainingUsd: 25, totalUsd: 25, expiresAt: '2026-10-08T12:00:00.000Z' }],
      onDemand: { enabled: false, limitUsd: null, usedUsd: 0 },
    },
  },
};
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets: [target],
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
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
};

test('Cursor appears on usage/executors and in composer selection, without any manual balance records', () => {
  const card = renderToStaticMarkup(createElement(QuotaCard, { runtime, now, maxAge: 120 }));
  assert.match(card, /plan-badge">Pro/);
  assert.match(card, /额度未报告/);
  assert.doesNotMatch(card, /正在读取额度…/);
  assert.match(card, /CLI 未报告个人余额。/);
  // Nothing typed by hand: no manual overview, editor or reset-credit controls.
  assert.doesNotMatch(card, /手动记录|余额明细与编辑|cursor-quota-overview|官方重置卡|按累计用量统计|API 按量计费/);
  // The switch lives with the Cursor executor, and the card points there.
  assert.match(card, /“用量与连接”的 Cursor 一项里设置“自动读取用量和赠送额度”/);
  const common = {
    state,
    api: async <T>() => ({}) as T,
    now,
    refreshing: false,
    refresh: async () => {},
    reload: async () => {},
    notify() {},
    onInspect() {},
  };
  assert.doesNotMatch(renderToStaticMarkup(createElement(UsagePage, common)), /个已登录平台账号|运行中的额度变更/);
  const executors = renderToStaticMarkup(createElement(ExecutorsPage, common));
  assert.match(executors, /provider-cursor small/);
  assert.match(executors, /<strong translate="no">Cursor<\/strong>/);
  assert.match(executors, /<small>就绪<\/small>/);
  assert.doesNotMatch(executors, /未开启用量读取（展开可开启）/);
  const composer = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state,
      policy: 'cli-only',
      selection: 'cursor-native',
      model: 'auto',
      onSelection() {},
      onModel() {},
    }),
  );
  assert.match(composer, /<option value="cursor-native" selected="">Cursor<\/option>/);
  assert.match(composer, /<option value="auto" selected="">Auto<\/option>/);
  assert.deepEqual(routeOptions([target]), [{ key: 'cursor', label: 'Cursor' }]);
  assert.match(renderToStaticMarkup(createElement(ProviderMark, { provider: 'cursor' })), /aria-label="Cursor"/);
});

test('a live Cursor card shows both pools, each credit grant with its expiry, and the on-demand state', () => {
  const card = renderToStaticMarkup(createElement(QuotaCard, { runtime: live, now, maxAge: 120 }));
  assert.match(card, /Cursor 模型[\s\S]*90%[\s\S]*其他模型[\s\S]*60%/);
  assert.match(card, /账户余额<strong>\$40\.00<\/strong>[\s\S]*活动赠金<strong>\$25\.00<\/strong>/);
  // Five days left: flagged.
  assert.match(card, /usage-chip expiry-warning[^>]*>活动赠金 5 天后到期/);
  assert.equal((card.match(/5 天后到期/g) ?? []).length, 1);
  assert.doesNotMatch(card, /Event credits|到期（还有/);
  assert.doesNotMatch(card.split('<footer')[0]!, /赠送额度合计剩余|超额按量付费/);
  assert.match(card, /赠送额度合计剩余 \$65\.00（共 \$65\.00）/);
  assert.match(card, /超额按量付费：已关闭/);
  assert.doesNotMatch(card, /手动记录|余额明细与编辑/);
  const charging = renderToStaticMarkup(
    createElement(QuotaCard, {
      runtime: {
        ...live,
        quota: {
          ...live.quota,
          cursorCredits: { ...live.quota.cursorCredits!, onDemand: { enabled: true, limitUsd: 200, usedUsd: 1.5 } },
        },
      },
      now,
      maxAge: 120,
    }),
  );
  assert.match(charging, /cursor-expiry-notice[^>]*>超额按量付费：已开启（上限 \$200\.00，本期已用 \$1\.50）/);
});

test('Cursor shows the connection failure on the card while retaining independently verified usage', () => {
  const card = renderToStaticMarkup(
    createElement(QuotaCard, {
      runtime: { ...live, status: 'error', note: 'runtime-timeout' },
      now,
      maxAge: 120,
    }),
  );
  const body = card.split('<footer')[0]!;
  assert.match(body, /Cursor 连接检查超时，会自动重试/);
  assert.match(body, /Cursor 模型[\s\S]*其他模型/);
  assert.match(body, /\$40\.00[\s\S]*\$25\.00/);
  assert.doesNotMatch(body, /需要重新登录/);
  const failed = renderToStaticMarkup(
    createElement(QuotaCard, {
      runtime: { ...runtime, status: 'error', note: 'runtime-protocol-incompatible' },
      now,
      maxAge: 120,
    }),
  );
  assert.match(failed.split('<footer')[0]!, /Cursor CLI 返回的协议与当前适配器不兼容/);
  assert.match(failed, /连接检查/);
  assert.doesNotMatch(failed, /观测 尚未观测/);
});

test('Cursor balances survive an unreported quota window; unlimited requires an explicit report', () => {
  const render = (quota: RuntimeSnapshot['quota']) =>
    renderToStaticMarkup(createElement(QuotaCard, { runtime: { ...live, quota }, now, maxAge: 120 }));
  const unknown = render({ ...live.quota, status: 'unknown', windows: [], note: '额度格式未识别。' });
  assert.match(unknown, /额度未报告[\s\S]*额度格式未识别[\s\S]*账户余额<strong>\$40\.00/);
  assert.match(unknown, /活动赠金<strong>\$25\.00/);
  assert.doesNotMatch(unknown, /role="progressbar"|不限量/);
  const unlimited = render({ ...live.quota, unlimited: true, windows: [], note: '当前套餐不限量。' });
  assert.match(unlimited, /不限量[\s\S]*账户余额<strong>\$40\.00/);
  assert.doesNotMatch(unlimited, /额度未报告|unknown-track|role="progressbar"/);
  assert.doesNotMatch(render({ ...live.quota, windows: [] }), /不限量/);
});

test('Cursor pools keep independent unknown values, and stale reports are marked', () => {
  const card = renderToStaticMarkup(
    createElement(QuotaCard, {
      runtime: {
        ...live,
        quota: { ...live.quota, windows: [live.quota.windows[0]!, { ...live.quota.windows[1]!, usedPercent: null }] },
      },
      now: now + 121_000,
      maxAge: 120,
    }),
  );
  assert.equal((card.match(/role="progressbar"/g) ?? []).length, 1);
  assert.match(card, /Cursor 模型[\s\S]*90%[\s\S]*其他模型<\/span><strong>未知/);
  assert.doesNotMatch(card, /更新于/);
  assert.match(card, /当前显示上次报告的额度，刷新后核对/);
  assert.doesNotMatch(card, /class="stale"|已过期/);
  assert.doesNotMatch(card, /NaN|100%/);
});

test('expired grants remain historical amounts and unknown expiry stays unknown', () => {
  const card = renderToStaticMarkup(
    createElement(QuotaCard, {
      runtime: {
        ...live,
        quota: {
          ...live.quota,
          cursorCredits: {
            ...live.quota.cursorCredits!,
            grants: [
              { ...live.quota.cursorCredits!.grants[0]!, expiresAt: new Date(now).toISOString() },
              { name: 'Undated grant', remainingUsd: null, totalUsd: null, expiresAt: null },
            ],
          },
        },
      },
      now,
      maxAge: 120,
    }),
  );
  assert.match(card, /cursor-credit-expired[\s\S]*活动赠金<strong>\$25\.00<\/strong><small>到期前报告/);
  assert.match(card, /活动赠金 已到期/);
  assert.doesNotMatch(card, /Undated grant · .*到期/);
  assert.match(card, /最近报告的赠送额度余额 \$65\.00[\s\S]*含已到期记录/);
  assert.doesNotMatch(card, /还有 0 天|赠送额度合计剩余|NaN/);
});

test('reset-card badge agrees with details after a reported card expires', () => {
  const card = renderToStaticMarkup(
    createElement(QuotaCard, {
      runtime: {
        ...runtime,
        provider: 'codex',
        quota: {
          ...runtime.quota,
          resetCredits: {
            availableCount: 2,
            source: 'fixture',
            observedAt: new Date(now - 1000).toISOString(),
            details: [{ kind: 'full', status: 'available', grantedAt: null, expiresAt: new Date(now).toISOString() }],
          },
        },
      },
      now,
      maxAge: 120,
    }),
  );
  assert.match(card, /plan-badge">重置卡 1/);
  assert.match(card, /1 次可用/);
  assert.doesNotMatch(card, /重置卡 2/);
});

test('enabling Cursor reads describes the setting, without claiming a successful observation', () => {
  const html = renderToStaticMarkup(
    createElement(ExecutorsPage, {
      state: { ...state, settings: { ...state.settings, cursorUsageFromEditor: true } },
      api: async <T>() => ({}) as T,
      reload: async () => {},
      refresh: async () => {},
      refreshing: false,
      notify() {},
    }),
  );
  assert.match(html, /<small>就绪<\/small>/);
  assert.doesNotMatch(html, /已自动读取用量/);
});

const appBundle = uiBundle('src/ui/App.tsx');
const executorBundle = uiBundle('src/ui/Executors.tsx');
const zoomBundle = uiBundle('src/ui/QuotaZoom.tsx');

test('instant settings stay editable during writes and preserve committed values when only reload fails', async () => {
  const harness = uiHarness(await appBundle);
  let rejectWrite!: (error: Error) => void;
  let writes = 0;
  const notices: Array<{ message: string }> = [];
  const props = {
    state,
    api: async () => {
      writes++;
      if (writes === 1)
        await new Promise((_, reject) => {
          rejectWrite = reject;
        });
      return {};
    },
    reload: async () => {
      throw Error('reload failed');
    },
    notify: (notice: { message: string }) => notices.push(notice),
  };
  const toggle = (tree: unknown) =>
    findNode(tree, (node) => node.type === 'input' && String(node.props.onChange).includes('keepAwake'))!;
  let tree = harness.render('SettingsPage', props);
  const first = toggle(tree);
  first.props.onChange({ target: { checked: false } });
  await nextTurn();
  tree = harness.render('SettingsPage', props);
  assert.equal(writes, 1);
  assert.equal(!!toggle(tree).props.disabled, false);
  assert.equal(toggle(tree).props['aria-busy'], true);
  assert.equal(toggle(tree).props.checked, false);
  rejectWrite(Error('write failed'));
  await nextTurn();
  tree = harness.render('SettingsPage', props);
  assert.equal(!!toggle(tree).props.disabled, false);
  assert.equal(toggle(tree).props['aria-busy'], false);
  assert.equal(toggle(tree).props.checked, true);
  toggle(tree).props.onChange({ target: { checked: false } });
  await nextTurn();
  tree = harness.render('SettingsPage', props);
  assert.equal(toggle(tree).props.checked, false, 'a saved switch must not roll back on a failed refresh');
  assert.equal(writes, 2);
  assert.match(notices.at(-1)!.message, /设置已保存，但刷新失败/);
  harness.unmount();
});

test('Cursor rows share one pending settings write and do not roll it back after a refresh failure', async () => {
  const harness = uiHarness(await executorBundle);
  let complete!: () => void;
  let writes = 0;
  const notices: Array<{ message: string }> = [];
  const props = {
    state: { ...state, targets: [target, { ...target, id: 'cursor-second', label: 'Cursor 2' }] },
    api: async (path: string) => {
      if (path === '/api/accounts') return { accounts: [] };
      writes++;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return {};
    },
    reload: async () => {
      throw Error('reload failed');
    },
    refresh: async () => {},
    refreshing: false,
    notify: (notice: { message: string }) => notices.push(notice),
  };
  let tree = harness.render('ExecutorsPage', props);
  const row = (id: string) => findNode(tree, (node) => node.props.target?.id === id && node.props.cursorUsage)!;
  const request = row(target.id).props.cursorUsage.change(true);
  void row('cursor-second').props.cursorUsage.change(false);
  tree = harness.render('ExecutorsPage', props);
  assert.equal(writes, 1);
  assert.equal(row(target.id).props.cursorUsage.pending, true);
  assert.equal(row('cursor-second').props.cursorUsage.pending, true);
  complete();
  await request;
  tree = harness.render('ExecutorsPage', props);
  assert.equal(row(target.id).props.cursorUsage.pending, false);
  assert.equal(row(target.id).props.cursorUsage.enabled, true);
  assert.match(notices.at(-1)!.message, /设置已保存，但刷新失败/);
  harness.unmount();
});

test('zoomable cards advertise a dialog and support Space as well as Enter', async () => {
  const html = renderToStaticMarkup(createElement(QuotaCard, { runtime: live, now, maxAge: 120, zoomable: true }));
  assert.match(html, /tabindex="0" role="button" aria-label="Cursor 额度详情" aria-haspopup="dialog"/);
  const harness = uiHarness(await zoomBundle);
  const opened: string[] = [];
  let focused = 0,
    prevented = 0;
  const card = {
    dataset: { runtimeId: runtime.id },
    focus: () => focused++,
    getBoundingClientRect: () => ({}),
    matches: () => true,
    closest: (selector: string) => (selector.startsWith('.quota-card') ? card : null),
  };
  const tree = harness.render('EvenCards', { children: null, onOpen: (id: string) => opened.push(id) });
  for (const key of [' ', 'Enter']) tree.props.onKeyDown({ key, target: card, preventDefault: () => prevented++ });
  assert.deepEqual(opened, [runtime.id, runtime.id]);
  assert.equal(focused, 2);
  assert.equal(prevented, 2);
  harness.unmount();
});

test('quota zoom uses a native modal and cancel closes once', async () => {
  const harness = uiHarness(await zoomBundle);
  let closed = 0,
    prevented = 0;
  const tree = harness.render('QuotaZoom', { from: {}, label: 'Cursor', onClose: () => closed++, children: null });
  assert.equal(tree.type, 'dialog');
  assert.equal(tree.props['aria-label'], 'Cursor 详情');
  tree.props.onCancel({ preventDefault: () => prevented++ });
  tree.props.onCancel({ preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.equal(closed, 1);
  harness.unmount();
});
