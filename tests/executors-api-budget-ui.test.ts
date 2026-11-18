import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiBudgetView, ApiProviderView } from '../src/shared/api-providers.ts';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/Executors.tsx').then(
  (code) => `${code}\nObject.assign(module.exports, { ApiBudgetSettings, ApiBudgetSummary, ApiRow, Row });`,
);
const provider: ApiProviderView = {
  targetId: 'api/deepseek',
  preset: 'deepseek',
  label: 'DeepSeek',
  enabled: true,
  console: 'https://platform.deepseek.com',
  currency: 'CNY',
  balance: { observedAt: '2026-10-09T12:00:00Z', amounts: [{ currency: 'CNY', total: 200 }] },
};
const configured: ApiProviderView = {
  ...provider,
  budget: {
    policy: {
      limitUsd: 20,
      expiresAt: '2026-10-10T15:30:27Z',
      perRunUsd: 0.5,
      maxConcurrentRuns: 1,
      burstConcurrentRuns: 4,
      preferExpiring: true,
      startedAt: '2026-10-01T12:00:00Z',
    },
    spentUsd: 5,
    reservedUsd: 1,
    remainingUsd: 14,
    unreportedRuns: 2,
    phase: 'sprint',
    maxConcurrentRuns: 4,
  },
};
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as UiNode).props?.children) : '';
}
const field = (tree: unknown, label: string) =>
  findNode(
    findNode(tree, (node) => node.type === 'label' && text(node).startsWith(label)),
    (node) => node.type === 'input',
  )!;
const submit = (tree: unknown) =>
  findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });

test('API budget saves local-time expiry as ISO with independent USD estimates and no client cycle timestamp', async () => {
  const harness = uiHarness(await bundle);
  const writes: unknown[] = [];
  const props = {
    provider,
    blocked: false,
    api: async (path: string, body: unknown, method: string) => {
      writes.push({ path, body: JSON.parse(JSON.stringify(body)), method });
      return {};
    },
    reload: async () => {},
    notify() {},
  };
  let tree = harness.render('ApiBudgetSettings', props);
  assert.match(text(tree), /额度（美元）/);
  assert.match(text(tree), /费用是本地估算，不是平台账单/);
  field(tree, '额度').props.onChange({ target: { value: '25.5' } });
  tree = harness.render('ApiBudgetSettings', props);
  field(tree, '到期日').props.onChange({ target: { value: '2026-10-20' } });
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.deepEqual(writes, [
    {
      path: '/api/api-providers/api%2Fdeepseek/budget',
      method: 'PUT',
      body: {
        limitUsd: 25.5,
        expiresAt: new Date('2026-10-20T00:00').toISOString(),
        perRunUsd: 1,
        maxConcurrentRuns: 1,
        burstConcurrentRuns: 4,
        preferExpiring: true,
      },
    },
  ]);
  harness.unmount();
});

test('editing budget preserves exact expiry and never resets counted spend implicitly', async () => {
  const harness = uiHarness(await bundle);
  const writes: any[] = [];
  const props = {
    provider: configured,
    blocked: false,
    api: async (_path: string, body: unknown) => {
      writes.push(JSON.parse(JSON.stringify(body)));
      return {};
    },
    reload: async () => {},
    notify() {},
  };
  let tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.equal(writes.length, 0, 'unchanged form does not save');
  field(tree, '额度').props.onChange({ target: { value: '21' } });
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.equal(writes[0].expiresAt, configured.budget!.policy.expiresAt);
  assert.equal(writes[0].startedAt, undefined);
  assert.equal(writes[0].reset, undefined);
  assert.equal(
    findNode(tree, (node) => node.type === 'input' && text(node).includes('从现在重新倒数')),
    undefined,
  );
  assert.ok(findNode(tree, (node) => node.type === 'button' && text(node) === '从现在重新倒数'));
  harness.unmount();
});

test('monthly credit defines the full bar; one-off credit keeps its entered limit', async () => {
  const harness = uiHarness(await bundle);
  for (const [monthlyUsd, percent] of [
    [200, 42],
    [undefined, 100],
  ] as const) {
    const budget = {
      ...configured.budget!,
      remainingUsd: 84,
      spentUsd: 0,
      reservedUsd: 0,
      policy: { ...configured.budget!.policy, limitUsd: 84, monthlyUsd, expiresAt: '2030-01-01T00:00:00Z' },
    };
    const tree = harness.render('ApiBudgetSummary', { provider: { ...configured, budget } });
    assert.equal(findNode(tree, (node) => node.props.role === 'progressbar')!.props['aria-valuenow'], percent);
    if (monthlyUsd) assert.match(text(tree), /\$84.00 剩余，本月共 \$200.00/);
  }
  harness.unmount();
});

test('configured API budgets are visible in collapsed Anthropic, custom and DeepSeek cards and follow live state', async () => {
  const date = new Date('2026-10-09T12:00:00Z');
  const FixedDate = class extends Date {
    static now() {
      return date.getTime();
    }
  };
  for (const preset of ['anthropic', 'custom-api', 'deepseek']) {
    const row = uiHarness(await bundle);
    const layout = uiHarness(await bundle);
    const summary = uiHarness(await bundle, { Date: FixedDate });
    const props = {
      provider: { ...configured, preset, label: `${preset} Work` },
      target: { id: configured.targetId, provider: 'pi' },
      state: { settings: {}, runs: [] },
      api: async () => {
        throw Error('No calls when reading local budgets');
      },
      reload: async () => {},
      notify() {},
    };
    const card = row.render('ApiRow', props);
    const collapsed = layout.render('Row', card.props);
    assert.equal(
      findNode(collapsed, (node) => node.props.className === 'exec-body'),
      undefined,
    );
    const visible = findNode(collapsed, (node) => node.type?.name === 'ApiBudgetSummary')!;
    assert.ok(visible, 'summary remains outside collapsed settings');
    let tree = summary.render('ApiBudgetSummary', visible.props);
    assert.match(text(tree), /本地额度 \$20\.00/);
    assert.doesNotMatch(text(tree), /已记录费用/);
    assert.match(text(card.props.metric), /已用 ¥35\.50/);
    assert.match(text(tree), /\$14\.00 剩余/);
    assert.match(text(tree), /本地估算，非平台余额.*已预留 \$1\.00.*2 次费用未知/);
    assert.match(text(tree), /2026.*到期/);
    assert.equal(findNode(tree, (node) => node.props.role === 'progressbar')!.props['aria-valuenow'], 70);
    props.provider = { ...props.provider, budget: { ...configured.budget!, spentUsd: 10, remainingUsd: 9 } };
    tree = summary.render('ApiBudgetSummary', { provider: props.provider });
    assert.equal(findNode(tree, (node) => node.props.role === 'progressbar')!.props['aria-valuenow'], 45);
    assert.match(text(tree), /\$9\.00 剩余/);
    row.unmount();
    layout.unmount();
    summary.unmount();
  }
});

test('budget expiry updates on a local clock tick even when no backend snapshot changes', async () => {
  let now = Date.parse('2026-10-10T15:30:00Z');
  let tick: (() => void) | undefined;
  let cleared = false;
  const harness = uiHarness(await bundle, {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setInterval(fn: () => void, delay: number) {
      assert.equal(delay, 30_000);
      tick = fn;
      return 1;
    },
    clearInterval() {
      cleared = true;
    },
  });
  let tree = harness.render('ApiBudgetSummary', { provider: configured });
  assert.match(text(tree), /不到 1 天/);
  now = Date.parse('2026-10-10T15:31:00Z');
  tick!();
  tree = harness.render('ApiBudgetSummary', { provider: configured });
  assert.match(text(tree), /已到期/);
  assert.match(text(tree), /\$0\.00 剩余/);
  assert.equal(findNode(tree, (node) => node.props.role === 'progressbar')!.props['aria-valuenow'], 0);
  assert.match(String(tree.props.className), /danger/);
  harness.unmount();
  assert.equal(cleared, true);
});

test('missing limit creates no invented bar; unknown estimates stay unknown and expiry-only remains visible', async () => {
  const harness = uiHarness(await bundle);
  assert.equal(harness.render('ApiBudgetSummary', { provider }), null);
  const budget: ApiBudgetView = {
    ...configured.budget!,
    policy: { ...configured.budget!.policy, expiresAt: undefined, limitUsd: undefined },
  };
  assert.equal(harness.render('ApiBudgetSummary', { provider: { ...provider, budget } }), null);
  budget.policy.expiresAt = '2030-01-01T12:00:00Z';
  let tree = harness.render('ApiBudgetSummary', { provider: { ...provider, budget } });
  assert.match(text(tree), /2030.*到期/);
  assert.equal(
    findNode(tree, (node) => node.props.role === 'progressbar'),
    undefined,
  );
  tree = harness.render('ApiBudgetSummary', {
    provider: {
      ...provider,
      budget: {
        ...budget,
        remainingUsd: undefined,
        spentUsd: undefined,
        policy: { ...budget.policy, limitUsd: 20 },
      },
    },
  });
  assert.doesNotMatch(text(tree), /已记录费用/);
  assert.match(text(tree), /剩余额度未知/);
  const bar = findNode(tree, (node) => node.props.role === 'progressbar')!;
  assert.equal(bar.props['aria-valuenow'], undefined);
  assert.equal(
    findNode(bar, (node) => node.type === 'span'),
    undefined,
  );
  harness.unmount();
});

test('missing cumulative API prices are not displayed as zero while actual balances retain their currency', async () => {
  const harness = uiHarness(await bundle);
  const props = {
    provider,
    target: { id: provider.targetId },
    state: { settings: {} },
    api: async () => ({}),
    reload: async () => {},
    notify() {},
  };
  let tree = harness.render('ApiRow', { ...props, usage: { runs: 1, totalTokens: 20, estimatedCostUsd: null } });
  assert.match(text(tree.props.metric), /余额 ¥200\.00.*费用未知/);
  assert.doesNotMatch(text(tree.props.metric), /已用.*0\.00/);
  tree = harness.render('ApiRow', props);
  assert.match(text(tree.props.metric), /费用未知/);
  tree = harness.render('ApiRow', { ...props, usage: { runs: 1, totalTokens: 20, estimatedCostUsd: 2 } });
  assert.match(text(tree.props.metric), /已用 ¥14\.20/);
  harness.unmount();
});

test('only the matching active API blocks budget edits, keeps drafts and shows the precise server busy error inline', async () => {
  const harness = uiHarness(await bundle, { Error });
  const writes: unknown[] = [],
    notices: any[] = [];
  let failure = '请等这个 API 的运行结束后再修改预算。';
  const props = {
    provider: configured,
    blocked: false,
    state: { runs: [] as any[] },
    api: async (_path: string, body: unknown) => {
      writes.push(body);
      throw Error(failure);
    },
    reload: async () => {},
    notify: (notice: unknown) => notices.push(notice),
  };
  let tree = harness.render('ApiBudgetSettings', props);
  field(tree, '额度').props.onChange({ target: { value: '33' } });
  props.state.runs = [{ status: 'running', route: { runtimeId: provider.targetId } }];
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(findNode(tree, (node) => node.type === 'fieldset')!.props.disabled, true);
  assert.match(text(tree), /请等这个 API 的运行结束后再修改预算/);
  submit(tree);
  await nextTurn();
  assert.equal(writes.length, 0);
  props.state.runs[0].status = 'waiting-approval';
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(findNode(tree, (node) => node.type === 'fieldset')!.props.disabled, true);
  props.state.runs = [{ status: 'running', route: { runtimeId: 'another-api' } }];
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(findNode(tree, (node) => node.type === 'fieldset')!.props.disabled, false);
  assert.equal(field(tree, '额度').props.value, '33');
  submit(tree);
  await nextTurn();
  tree = harness.render('ApiBudgetSettings', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /请等这个 API 的运行结束后再修改预算/);
  failure = 'offline';
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(text(findNode(tree, (node) => node.props.role === 'alert')), 'offline');
  assert.deepEqual(notices, []);
  harness.unmount();
});

test('budget writes serialize, live spending retains the draft, and refresh failure reports committed settings', async () => {
  const harness = uiHarness(await bundle, { Error });
  const writes: any[] = [],
    notices: Array<{ message: string }> = [];
  let finish!: () => void;
  const props = {
    provider: configured,
    blocked: false,
    api: async (_path: string, body: unknown) => {
      writes.push(JSON.parse(JSON.stringify(body)));
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {};
    },
    reload: async () => {
      throw Error('offline');
    },
    notify: (notice: { message: string }) => notices.push(notice),
  };
  let tree = harness.render('ApiBudgetSettings', props);
  field(tree, '额度').props.onChange({ target: { value: '30' } });
  tree = harness.render('ApiBudgetSettings', props);
  props.provider = { ...configured, budget: { ...configured.budget!, spentUsd: 6, remainingUsd: 13 } };
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(field(tree, '额度').props.value, '30');
  const staleField = field(tree, '额度');
  submit(tree);
  submit(tree);
  await nextTurn();
  staleField.props.onChange({ target: { value: '99' } });
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(writes.length, 1);
  assert.equal(findNode(tree, (node) => node.type === 'fieldset')!.props.disabled, false);
  assert.equal(field(tree, '额度').props.value, '99');
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && text(node) === '从现在重新倒数')!.props.disabled,
    false,
    'blur autosave must not swallow the following action click',
  );
  finish();
  await nextTurn();
  tree = harness.render('ApiBudgetSettings', props);
  assert.equal(field(tree, '额度').props.value, '99');
  assert.equal(findNode(tree, (node) => node.type === 'fieldset')!.props.disabled, false);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /额度已保存，但刷新失败.*offline/);
  field(tree, '额度').props.onChange({ target: { value: '30' } });
  harness.render('ApiBudgetSettings', props);
  harness.unmount();
});

test('invalid budget money and concurrency never reach the server; disabling sends literal null and ignores reset', async () => {
  const harness = uiHarness(await bundle, { Error });
  const writes: unknown[] = [],
    notices: Array<{ message: string }> = [];
  const props = {
    provider: configured,
    blocked: false,
    api: async (_path: string, body: unknown) => {
      writes.push(body);
      return {};
    },
    reload: async () => {},
    notify: (notice: { message: string }) => notices.push(notice),
  };
  let tree = harness.render('ApiBudgetSettings', props);
  field(tree, '额度').props.onChange({ target: { value: '-1' } });
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.equal(writes.length, 0);
  tree = harness.render('ApiBudgetSettings', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /大于 0/);
  field(tree, '额度').props.onChange({ target: { value: '' } });
  tree = harness.render('ApiBudgetSettings', props);
  field(tree, '平时同时跑几个').props.onChange({ target: { value: '17' } });
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.equal(writes.length, 0);
  tree = harness.render('ApiBudgetSettings', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /1～16/);
  field(tree, '平时同时跑几个').props.onChange({ target: { value: '5' } });
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.equal(writes.length, 0);
  tree = harness.render('ApiBudgetSettings', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /快到期时的并发不能低于平时/);
  field(tree, '平时同时跑几个').props.onChange({ target: { value: '1' } });
  tree = harness.render('ApiBudgetSettings', props);
  field(tree, '额度').props.onChange({ target: { value: '0.1' } });
  tree = harness.render('ApiBudgetSettings', props);
  submit(tree);
  await nextTurn();
  assert.equal(writes.length, 0);
  tree = harness.render('ApiBudgetSettings', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /每次预留不能大于整个额度/);
  tree = harness.render('ApiBudgetSettings', props);
  findNode(tree, (node) => node.type === 'button' && text(node) === '清除额度')!.props.onClick();
  await nextTurn();
  assert.equal(writes.length, 1);
  assert.equal(writes[0], null);
  harness.unmount();
});
