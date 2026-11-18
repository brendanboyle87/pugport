import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiProviderView } from '../src/shared/api-providers.ts';
import type { AppState, QuotaUtilization } from '../src/shared/types.ts';
import type { UsageRun } from '../src/shared/usage.ts';
import { findNode, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

// Synthetic accounts, credits and runs only.
const bundle = uiBundle('src/ui/Savings.tsx');
const local = (month: number, date: number, hours = 0) => new Date(2026, month - 1, date, hours).getTime();
const now = local(10, 10, 12);

/** The card's parts hold no state, so they are expanded in place to read the whole card. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object' || !('props' in node)) return node;
  const element = node as UiNode;
  if (typeof element.type === 'function') return expand(element.type(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props?.children) } };
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as UiNode).props?.children) : '';
}
/** One line per figure, as the card shows them. */
function lines(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const child of node) lines(child, out);
  else if (node && typeof node === 'object') {
    const element = node as UiNode;
    if (['dt', 'dd', 'small', 'p', 'h2'].includes(element.type)) out.push(text(element));
    else lines(element.props?.children, out);
  }
  return out;
}
async function card(state: Partial<AppState>) {
  const harness = uiHarness(await bundle);
  return expand(harness.render('Savings', { state: { runtimes: [], targets: [], runs: [], ...state }, now }));
}
const credit = (label: string, spentUsd: number, expiresAt: number | undefined, expired = false): ApiProviderView => ({
  targetId: `api/${label}`,
  preset: 'anthropic',
  label,
  enabled: true,
  console: 'https://console.example.invalid',
  currency: 'USD',
  budget: {
    policy: {
      limitUsd: 200,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      perRunUsd: 1,
      maxConcurrentRuns: 1,
      burstConcurrentRuns: 4,
      preferExpiring: true,
      startedAt: new Date(local(9, 1)).toISOString(),
    },
    spentUsd,
    reservedUsd: 0,
    remainingUsd: Math.max(0, 200 - spentUsd),
    unreportedRuns: 0,
    phase: expired ? 'expired' : 'normal',
    maxConcurrentRuns: 1,
  },
});
const run = (startedAt: number, accountingMode: UsageRun['accountingMode'], estimatedCostUsd: number | null) =>
  ({
    runId: `run-${startedAt}-${accountingMode}`,
    startedAt: new Date(startedAt).toISOString(),
    accountingMode,
    estimatedCostUsd,
  }) as UsageRun;
const utilization: QuotaUtilization = {
  basis: 'ended',
  percent: 92,
  accounts: 3,
  periods: 9,
  partial: false,
  byProvider: [
    { provider: 'codex', basis: 'ended', percent: 95, accounts: 2, periods: 6, partial: false },
    { provider: 'claude', basis: 'ended', percent: 88, accounts: 1, periods: 3, partial: false },
    { provider: 'grok', basis: 'current', percent: 52, accounts: 1, periods: 0, partial: false },
  ],
  since: new Date(local(10, 3)).toISOString(),
};

test('with nothing known the card is one quiet line', async () => {
  const tree = await card({});
  assert.equal((tree as UiNode).type, 'p');
  assert.match(text(tree), /记录到订阅额度和任务后/);
  const unused = await card({
    apiProviders: [{ ...credit('Unbudgeted', 0, undefined), budget: undefined }],
    usage: { perRun: [run(local(9, 30), 'subscription', null)] } as AppState['usage'],
  });
  assert.equal((unused as UiNode).type, 'p', 'no credit and only last month’s runs: still nothing to show');
});

test('shows two concise monthly cards with credit totals left to the API cards', async () => {
  const tree = await card({
    quotaUtilization: utilization,
    apiProviders: [
      credit('Anthropic', 12, local(11, 4)),
      credit('OpenAI', 180, local(10, 4), true),
      credit('Old', 50, local(9, 28), true),
      credit('Stored', 30, undefined),
    ],
    usage: {
      perRun: [
        run(local(10, 2), 'subscription', 1.2),
        run(local(10, 5), 'subscription', null),
        run(local(10, 9), 'subscription', null),
        run(local(10, 9), 'usage', 0.5),
        run(local(10, 9), 'usage', null),
        run(local(9, 30), 'usage', 9),
      ],
    } as AppState['usage'],
  });
  assert.deepEqual(lines(tree), [
    '这个月',
    '订阅额度利用率',
    '92%',
    '近 30 天 · 9 个周期',
    '任务分配',
    '5 次执行',
    '订阅 3 次 · 按量 2 次',
  ]);
});

test('a period still in progress is not presented as a final utilization; thin coverage is said plainly', async () => {
  const tree = await card({
    quotaUtilization: {
      ...utilization,
      basis: 'current',
      percent: 61,
      periods: 0,
      byProvider: [{ provider: 'codex', basis: 'current', percent: 61, accounts: 1, periods: 0, partial: false }],
    },
  });
  assert.deepEqual(lines(tree), ['这个月', '订阅额度（本周期进行中）', '已用 61%', '本周期进行中']);
  const partial = await card({
    quotaUtilization: { ...utilization, partial: true },
    usage: { perRun: [run(local(10, 9), 'usage', null)] } as AppState['usage'],
  });
  const shown = lines(partial);
  assert.ok(!shown.includes('有些周期 PugPort 没有全程看到，实际用得可能更多'));
  assert.ok(findNode(partial, (node) => node.props?.title?.includes('有些周期 PugPort 没有全程看到')));
  assert.ok(findNode(partial, (node) => node.props?.title?.includes('Codex 95% · Claude 88%')));
  assert.ok(
    findNode(partial, (node) => node.props?.title?.includes('1 次走 API，费用未报告')),
    'no cost reported is not shown as $0',
  );
});
