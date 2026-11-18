import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RuntimeSnapshot } from '../src/shared/types.ts';
import { QuotaCard } from '../src/ui/App.tsx';
import { quotaRequestConflict, accountExecutionStatus } from '../src/ui/AccountQuotaDiagnostics.tsx';

const now = Date.parse('2026-10-10T04:18:00Z');
const failure = {
  runId: 'failed-b-run',
  model: 'grok-4.7-build-fast',
  at: '2026-10-10T04:10:39Z',
  source: 'Grok Build ACP' as const,
  statusCode: 402 as const,
  errorCode: 'quota-or-rate-limit' as const,
  message: 'Build usage balance exhausted',
};
const runtime: RuntimeSnapshot = {
  id: 'grok-b',
  provider: 'grok',
  label: 'Grok B',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [],
  quota: {
    status: 'known',
    source: 'Grok 官方账单',
    observedAt: '2026-10-10T04:17:51Z',
    windows: [{ id: 'included', label: '每周额度', usedPercent: 0, resetsAt: '2026-10-16T03:23:56Z' }],
    grokBilling: { isUnifiedBillingUser: true, percentSource: 'implicit-zero' },
    grokCredits: { extraUsd: 0, autoTopup: false },
  },
  lastRequestFailure: failure,
  availability: { reason: 'quota', observedAt: failure.at, retryAt: '2026-10-10T04:25:39Z', billingFailure: failure },
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  refreshedAt: '2026-10-10T04:17:51Z',
};
const render = (value: RuntimeSnapshot, at = now) =>
  renderToStaticMarkup(createElement(QuotaCard, { runtime: value, now: at, maxAge: 300 }));

test('fresh official 100 percent and a real 402 remain visible together without claiming readiness', () => {
  const html = render(runtime);
  assert.match(html, /100%/);
  assert.match(html, /剩余（推算）/);
  assert.match(html, /比例按完整账单推算（接口未返回比例字段）/);
  assert.match(html, /共享周\/月额度/);
  assert.match(html, /账单额度与实际请求冲突/);
  assert.match(html, /最近请求失败：HTTP 402/);
  assert.match(html, /grok-4.7-build-fast/);
  assert.match(html, /Grok Build ACP/);
  assert.match(html, /Build usage balance exhausted/);
  assert.match(html, /执行记录：<code>failed-b-run/);
  assert.match(html, /账单来源：Grok 官方账单/);
  assert.match(html, /dateTime="2026-10-10T04:17:51Z"/);
  assert.match(html, /请求额度受限/);
  assert.match(html, /quota-window warning/);
  assert.doesNotMatch(html, /就绪|quota-window healthy/);
});

test('billing provenance stays visible even without any request failure', () => {
  const html = render({ ...runtime, availability: undefined, lastRequestFailure: undefined });
  assert.match(html, /100%/);
  assert.match(html, /比例按完整账单推算/);
  assert.doesNotMatch(html.split('<footer')[0]!, /账单来源|比例按完整账单推算|账单模式/);
  assert.match(html.split('<details')[1]!, /账单来源.*比例按完整账单推算/);
  assert.doesNotMatch(html, /请求错误详情|实际请求冲突|HTTP 402/);
  const explicit = render({
    ...runtime,
    availability: undefined,
    lastRequestFailure: undefined,
    quota: { ...runtime.quota, grokBilling: { isUnifiedBillingUser: null, percentSource: 'cli-reported' } },
  });
  assert.match(explicit, /比例由命令行明确报告/);
  assert.match(explicit, /账单模式：未报告/);
  assert.doesNotMatch(explicit, /推算|共享周\/月额度/);
});

test('cooldown expiration retains failure history and does not label a metadata refresh as request recovery', () => {
  const expired = { ...runtime, availability: undefined };
  const html = render(expired, Date.parse('2026-10-10T04:26:00Z'));
  assert.match(html, /最近请求失败 · 待复查/);
  assert.match(html, /账单刷新不能确认请求已恢复/);
  assert.match(html, /HTTP 402/);
  assert.doesNotMatch(html, /就绪|已暂时避开此账号/);
  assert.equal(quotaRequestConflict(expired), true);
  assert.equal(accountExecutionStatus(expired, now), '最近请求失败 · 待复查');
});

test('a later explicit same-model successful request acknowledges recovery while keeping the original error', () => {
  const passed = {
    ...runtime,
    availability: undefined,
    lastConnectionTest: { at: '2026-10-10T04:27:00Z', ok: true, model: failure.model },
  };
  const html = render(passed);
  assert.match(html, /之后同模型的实际测试已通过/);
  assert.match(html, /HTTP 402/);
  assert.doesNotMatch(html, /实际请求冲突|最近请求失败 · 待复查/);
  assert.equal(quotaRequestConflict(passed), false);
  assert.equal(
    quotaRequestConflict({ ...passed, lastConnectionTest: { ...passed.lastConnectionTest, model: 'other-model' } }),
    true,
  );
});

test('unknown or fully exhausted quota never creates a positive-balance conflict', () => {
  for (const quota of [
    { ...runtime.quota, status: 'unknown' as const },
    { ...runtime.quota, windows: [{ ...runtime.quota.windows[0]!, usedPercent: 100 }] },
    { ...runtime.quota, windows: [{ ...runtime.quota.windows[0]!, usedPercent: NaN }] },
  ]) {
    const value = { ...runtime, quota };
    assert.equal(quotaRequestConflict(value), false);
    assert.match(render(value), /HTTP 402/);
    assert.doesNotMatch(render(value), /账单额度与实际请求冲突/);
  }
});
