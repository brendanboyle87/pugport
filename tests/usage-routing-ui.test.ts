import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageRouting, RoutingBars } from '../src/ui/UsageRouting.tsx';
import { InsightsDashboard } from '../src/ui/UsageSpend.tsx';
import { insightFixture } from './helpers/usage-insights-fixture.ts';
import { findNode, uiBundle, uiHarness, text } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/UsageRouting.tsx');

test('routing section renders three honest tiles, outcomes, classification charts and disabled execution controls', () => {
  const data = insightFixture().routing;
  const html = renderToStaticMarkup(createElement(UsageRouting, { data }));
  assert.equal((html.match(/class="insight-routing-tile"/g) ?? []).length, 3);
  for (const title of [
    '由 Laya 决定',
    'Laya 可用率',
    'Laya 响应 p50 / p95',
    'Laya 判断结果',
    '成功判断延迟 p50 / p95',
    '回复或任务',
    '任务类型',
    '难度分布',
  ])
    assert.ok(html.includes(title), title);
  assert.match(html, /成功 · 本地 GPU/);
  assert.match(html, /成功 · 云端/);
  assert.match(html, /已跳过 · 隐私/);
  assert.match(html, /隐私跳过不算失败/);
  assert.match(html, /执行方式与执行器筛选不适用/);
  assert.equal((html.match(/<button[^>]+disabled=""/g) ?? []).length, 3);
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /class="sr-only"/);
  assert.match(html, /64 条已判断消息中有 4 条未报告处理来源/);
  assert.doesNotMatch(html, /部分数据/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('routing stays after reliability and before speed without changing the five spend KPI cards', () => {
  const html = renderToStaticMarkup(createElement(InsightsDashboard, { data: insightFixture(), onFailure() {} }));
  assert.ok(html.indexOf('id="reliability-title"') < html.indexOf('id="routing-title"'));
  assert.ok(html.indexOf('id="routing-title"') < html.indexOf('id="speed-title"'));
  assert.equal((html.match(/class="insight-kpi"/g) ?? []).length, 5);
});

test('routing empty range keeps tiles and filter explanation without manufacturing zero latency', () => {
  const html = renderToStaticMarkup(createElement(UsageRouting, { data: insightFixture(undefined, true).routing }));
  assert.equal((html.match(/class="insight-routing-tile"/g) ?? []).length, 3);
  assert.match(html, /此时间范围内没有路由判断/);
  assert.match(html, /沿用时间与项目筛选/);
  assert.match(html, /—/);
  assert.doesNotMatch(html, /NaN|Infinity|<svg/);
});

test('latest judgement table is collapsed, caps at 50, clips excerpts and links each conversation', () => {
  const data = insightFixture().routing;
  const first = data.recent[0]!;
  data.recent = Array.from({ length: 53 }, (_, index) => ({
    ...first,
    workflowId: `judgment-${index}`,
    conversationId: `conversation ${index}`,
    excerpt: '😀'.repeat(65),
    failed: index === 0 ? true : index === 1 ? false : null,
  }));
  const html = renderToStaticMarkup(createElement(UsageRouting, { data }));
  assert.match(html, /<details class="insight-routing-recent">/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.equal((html.match(/href="#conversation=/g) ?? []).length, 50);
  assert.match(html, /href="#conversation=conversation%200"/);
  assert.ok(html.includes('😀'.repeat(60)));
  assert.ok(!html.includes('😀'.repeat(61)));
  assert.match(html, /后续运行失败/);
  assert.match(html, /<td>是<\/td>/);
  assert.match(html, /<td>否<\/td>/);
  assert.match(html, /<td>未报告<\/td>/);
});

test('ranked bars provide the same tooltip on keyboard focus and pointer hover', async () => {
  const h = uiHarness(await bundle);
  const props = {
    title: '任务类型',
    rows: [
      { key: 'coding', label: '编程', count: 3 },
      { key: 'writing', label: '写作', count: 1 },
    ],
  };
  let tree = h.render('RoutingBars', props);
  let point = findNode(tree, (node) => node.props.className === 'insight-routing-bar')!;
  const tip = point.props['aria-label'];
  point.props.onFocus();
  tree = h.render('RoutingBars', props);
  assert.equal(text(findNode(tree, (node) => node.props.role === 'status')!), tip);
  point = findNode(tree, (node) => node.props.className === 'insight-routing-bar')!;
  point.props.onKeyDown({ key: 'Escape' });
  tree = h.render('RoutingBars', props);
  assert.notEqual(text(findNode(tree, (node) => node.props.role === 'status')!), tip);
  findNode(tree, (node) => node.props.className === 'insight-routing-bar')!.props.onMouseEnter();
  tree = h.render('RoutingBars', props);
  assert.equal(text(findNode(tree, (node) => node.props.role === 'status')!), tip);
  h.unmount();
});

test('synthetic routing fixture includes all outcomes and is independent of CLI/API selection', () => {
  const all = insightFixture();
  const api = insightFixture({ range: '7d', kind: 'api', runtime: 'executor-3' });
  assert.equal(api.routing.judged, all.routing.judged);
  assert.equal(api.routing.attempted, all.routing.attempted);
  const outcomes = Object.keys(all.routing.buckets[0]!.outcomes);
  for (const key of outcomes)
    assert.ok(
      all.routing.buckets.some((bucket) => bucket.outcomes[key as keyof typeof bucket.outcomes] > 0),
      key,
    );
  assert.ok(all.routing.latency.n < all.routing.available);
  assert.ok(all.routing.localSamples > 0 && all.routing.cloudSamples > 0);
  assert.ok(all.routing.recent.every((row) => row.workflowId !== 'synthetic-delegated-child'));
});

test('judgement links invoke conversation navigation and prevent inert hash navigation', async () => {
  const h = uiHarness(await bundle);
  const data = insightFixture().routing;
  const calls: string[] = [];
  const tree = h.render('UsageRouting', { data, onConversation: (id: string) => calls.push(id) });
  const link = findNode(tree, (node) => node.type === 'a')!;
  let prevented = false;
  link.props.onClick({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.deepEqual(calls, [data.recent[0]!.conversationId]);
  h.unmount();
});
