import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { subscriptionPlan } from '../src/server/subscription-plan.ts';
import { grokBillingQuota } from '../src/server/grok-quota.ts';
import { quotaPeriodLabel } from '../src/shared/quota-label.ts';
import { SubscriptionSummary } from '../src/ui/SubscriptionSummary.tsx';
const at = '2026-09-28T12:00:00.000Z';
test('billing tier is read from official response root, independently of missing percentage', () => {
  const quota = grokBillingQuota(
    {
      subscription_tier: 'SuperGrok',
      config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: at } },
      email: 'secret@example.test',
    },
    at,
  );
  assert.equal(quota.subscription?.label, 'SuperGrok');
  assert.equal(quota.subscription?.observedAt, at);
  assert.equal(quota.status, 'unknown');
  assert.equal(grokBillingQuota({ config: { creditUsagePercent: 50 } }, at).subscription, undefined);
  assert.doesNotMatch(JSON.stringify(quota), /secret@example/);
});
test('plan normalization does not guess an absent plan or forward account objects', () => {
  for (const value of [null, {}, '', 'unknown', 'secret@example.test'])
    assert.equal(subscriptionPlan(value, 'probe', at), undefined);
  assert.equal(subscriptionPlan('max', 'probe', at)?.label, 'Max');
});
test('period duration does not depend on reset countdown and retains model bucket names', () => {
  const window = {
    id: 'codex:primary',
    label: 'codex · 10080 min',
    durationMinutes: 10080,
    usedPercent: 91,
    resetsAt: at,
  };
  assert.equal(quotaPeriodLabel(window), '每周额度（7 天）');
  assert.equal(quotaPeriodLabel({ ...window, label: 'codex · 300 min', durationMinutes: 300 }), '5 小时额度');
  assert.equal(quotaPeriodLabel({ ...window, label: 'Spark · 10080 min' }), 'Spark · 每周额度（7 天）');
  assert.equal(quotaPeriodLabel({ ...window, label: 'Week' }), '每周额度');
  assert.equal(quotaPeriodLabel({ ...window, label: '5 hour', durationMinutes: 300 }), '5 小时额度');
  assert.equal(quotaPeriodLabel({ ...window, label: 'Custom weekly bucket' }), 'Custom weekly bucket');
  assert.equal(
    quotaPeriodLabel({ ...window, label: 'codex · secondary', durationMinutes: null }),
    'codex · 周期未报告',
  );
});
test('API authentication supersedes old plan and unknown stays unknown', () => {
  const plan = subscriptionPlan('plus', 'CLI account/read', at);
  const render = (usage: boolean) => renderToStaticMarkup(createElement(SubscriptionSummary, { plan, usage }));
  assert.match(render(false), /Plus/);
  assert.match(render(false), /不同套餐不可直接比较/);
  assert.match(render(true), /API 按量计费/);
  assert.doesNotMatch(render(true), /Plus/);
  assert.match(renderToStaticMarkup(createElement(SubscriptionSummary, {})), /未报告/);
});
