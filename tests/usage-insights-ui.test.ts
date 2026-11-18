import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InsightsDashboard } from '../src/ui/UsageSpend.tsx';
import { Sparkline, TimeChart } from '../src/ui/charts/UsageCharts.tsx';
import { insightFixture } from './helpers/usage-insights-fixture.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

import { buildSpendOverview, buildSpendDetails } from '../src/server/spend-ledger.ts';
import { spendFixture } from './helpers/spend-fixture.ts';

const bundle = uiBundle('src/ui/UsageSpend.tsx');
const state = { targets: [], projects: [], runs: [] };
test('filtered spend legend retains the selected executor and unknown costs', async () => {
  const data = insightFixture();
  data.runtimes = Array.from({ length: 7 }, (_, i) => ({ id: `executor-${i}`, label: `Executor ${i}` }));
  data.executors = [{ ...data.executors[0]!, runtimeId: 'executor-6', executionKinds: ['cli'] }];
  data.buckets[0]!.spendByRuntime = { 'executor-6': null };
  data.buckets[1]!.spendByRuntime = {};
  const h = uiHarness(await bundle);
  const tree = h.render('InsightsDashboard', { data, onFailure() {} });
  const chart = findNode(tree, (n) => n.type?.name === 'TimeChart')!;
  assert.equal(chart.props.series.length, 1);
  assert.equal(chart.props.series[0].id, 'executor-6');
  assert.equal(chart.props.series[0].dashed, true);
  assert.equal(chart.props.series[0].values[0], null);
  assert.equal(chart.props.series[0].values[1], 0);
  h.unmount();
});
test('cumulative values are focusable and included in tooltips and hidden data tables', () => {
  const html = renderToStaticMarkup(
    createElement(TimeChart, {
      labels: ['First', 'Second'],
      series: [],
      overlay: [3, null],
    }),
  );
  assert.match(html, /<circle[^>]+tabindex="0"[^>]+aria-label="First · 累计: 3"/);
  assert.match(html, /<th>累计<\/th>/);
  assert.match(html, /<td>3<\/td>/);
  assert.match(html, /<td>—<\/td>/);
  assert.equal((html.match(/<circle/g) ?? []).length, 1);
});
test('an unknown spend bucket does not expose a reported zero total', () => {
  const html = renderToStaticMarkup(
    createElement(TimeChart, {
      labels: ['Unknown'],
      mode: 'bar',
      series: [{ id: 'executor', label: 'Executor', color: '#287ab8', values: [null] }],
      overlay: [1],
    }),
  );
  assert.match(html, /合计: —/);
  assert.doesNotMatch(html, /合计: 0/);
});
test('sparklines leave unknown samples as gaps instead of reported zeroes', () => {
  const html = renderToStaticMarkup(createElement(Sparkline, { values: [1, 2, null, 4, 5] }));
  assert.equal((html.match(/<polyline/g) ?? []).length, 2);
  assert.doesNotMatch(html, /50,22/);
});
test('insights renders five tiles, all chart sections, keyboard points and accessible data tables', () => {
  const html = renderToStaticMarkup(createElement(InsightsDashboard, { data: insightFixture(), onFailure() {} }));
  assert.equal((html.match(/class="insight-kpi"/g) ?? []).length, 5);
  for (const title of ['费用趋势', '词元与缓存', '可靠性', '运行速度', '执行器与模型', '首段文本时间'])
    assert.ok(html.includes(title));
  assert.match(html, /缓存复用率/);
  assert.match(html, /不含首次写入缓存的部分/);
  assert.doesNotMatch(html, /缓存命中/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /class="sr-only"/);
  assert.match(html, /部分数据/);
  assert.match(html, /订阅参考费用/);
});
test('empty range preserves tiles and filters and presents explicit chart empty states', () => {
  const html = renderToStaticMarkup(
    createElement(InsightsDashboard, { data: insightFixture(undefined, true), onFailure() {} }),
  );
  assert.equal((html.match(/class="insight-kpi"/g) ?? []).length, 5);
  assert.equal((html.match(/此时间范围内没有运行记录/g) ?? []).length, 5);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
test('spend filters use one shared parameter set and billing is independent of execution kind', async () => {
  const calls: string[] = [];
  const input = spendFixture();
  const h = uiHarness(await bundle, { sessionStorage: { getItem: () => null, setItem() {} } });
  const props = {
    state,
    api: async (path: string) => {
      calls.push(path);
      return buildSpendOverview(input, {});
    },
    onInspect() {},
  };
  const render = () => h.render('UsageSpend', props);
  render();
  await nextTurn();
  let tree = render();
  assert.equal(calls[0], '/api/usage/spend?range=7d&kind=all&billing=all');
  findNode(tree, (n) => n.type === 'button' && text(n) === '24h')!.props.onClick();
  render();
  await nextTurn();
  tree = render();
  findNode(tree, (n) => n.type === 'button' && text(n) === '按次计费')!.props.onClick();
  render();
  await nextTurn();
  tree = render();
  findNode(tree, (n) => n.props['aria-label'] === '用量项目范围')!.props.onChange({
    target: { value: 'C:/Synthetic/atlas-web' },
  });
  render();
  await nextTurn();
  tree = render();
  findNode(tree, (n) => n.props['aria-label'] === '用量执行器范围')!.props.onChange({
    target: { value: 'executor-2' },
  });
  render();
  await nextTurn();
  assert.deepEqual(Object.fromEntries(new URL(calls.at(-1)!, 'http://fixture').searchParams), {
    range: '24h',
    kind: 'all',
    billing: 'usage',
    project: 'C:/Synthetic/atlas-web',
    runtime: 'executor-2',
  });
  h.unmount();
});
test('failure drilldown requests a bounded server page instead of transmitting run IDs', async () => {
  const calls: string[] = [];
  const input = spendFixture();
  const h = uiHarness(await bundle, { sessionStorage: { getItem: () => null, setItem() {} } });
  const props = {
    state,
    api: async (path: string) => {
      calls.push(path);
      return path.includes('/details')
        ? buildSpendDetails(input, { group: 'run', failure: 'rate-limit', limit: 20 })
        : buildSpendOverview(input, {});
    },
    onInspect() {},
  };
  h.render('UsageSpend', props);
  await nextTurn();
  let tree = h.render('UsageSpend', props);
  findNode(tree, (n) => n.type?.name === 'InsightsDashboard')!.props.onFailure('rate-limit', []);
  h.render('UsageSpend', props);
  await nextTurn();
  tree = h.render('UsageSpend', props);
  assert.ok(calls.at(-1)?.includes('failure=rate-limit'));
  assert.ok(calls.at(-1)?.includes('limit=20'));
  assert.ok(findNode(tree, (n) => n.type?.name === 'RunUsageTable'));
  h.unmount();
});

test('all detail tables reveal twenty rows, preserve order and reset for changed rows', async () => {
  const compiled = await uiBundle('src/ui/UsagePage.tsx');
  const data = insightFixture();
  for (const component of ['RunUsageTable', 'TaskCostTable', 'AggregateTable']) {
    const h = uiHarness(compiled);
    const rows = Array.from({ length: 45 }, (_, i) => ({
      ...data.report.perRun[0]!,
      ...data.tasks[0]!,
      runId: 'run-' + i,
      taskId: 'task-' + i,
      key: 'project-' + i,
      label: 'Project ' + i,
    }));
    const props = (items: typeof rows) => ({
      report: { ...data.report, perRun: items },
      tasks: items,
      rows: items,
      state,
      details: false,
      title: '项目',
      onInspect() {},
      onOpen() {},
    });
    const render = (items = rows) => h.render(component, props(items));
    const keys = (tree: any) => findNode(tree, (n) => n.type === 'tbody')!.props.children.map((n: any) => n.key);
    const more = (tree: any) => findNode(tree, (n) => n.type === 'button' && text(n) === '再显示 20 条');
    let tree = render();
    const prefix = component === 'RunUsageTable' ? 'run-' : component === 'TaskCostTable' ? 'task-' : 'project-';
    for (const count of [20, 40, 45]) {
      assert.deepEqual(
        Array.from(keys(tree)),
        Array.from({ length: count }, (_, i) => prefix + i),
      );
      if (count < 45) {
        more(tree)!.props.onClick();
        tree = render();
      }
    }
    assert.equal(more(tree), undefined);
    const reversed = [...rows].reverse();
    render(reversed);
    tree = render(reversed);
    assert.deepEqual(
      Array.from(keys(tree)),
      Array.from({ length: 20 }, (_, i) => prefix + (44 - i)),
    );
    h.unmount();
  }
});

test('details expose total count while loading only the selected group page', async () => {
  const input = spendFixture();
  const calls: string[] = [];
  const h = uiHarness(await bundle, { sessionStorage: { getItem: () => null, setItem() {} } });
  const props = {
    state,
    api: async (path: string) => {
      calls.push(path);
      return path.includes('/details')
        ? buildSpendDetails(input, { group: 'task', range: 'all', limit: 20 })
        : buildSpendOverview(input, { range: 'all' });
    },
    onInspect() {},
  };
  h.render('UsageSpend', props);
  await nextTurn();
  let tree = h.render('UsageSpend', props);
  assert.equal(calls.length, 1);
  findNode(tree, (n) => n.type === 'details')!.props.onToggle({ currentTarget: { open: true } });
  h.render('UsageSpend', props);
  await nextTurn();
  tree = h.render('UsageSpend', props);
  const table = findNode(tree, (n) => n.type?.name === 'TaskCostTable')!;
  assert.equal(table.props.tasks.length, 20);
  assert.match(text(tree), /1–20 \/ 80/);
  h.unmount();
});

test('chart axes use a nice maximum just above the data and ratios never pass 100 %', async () => {
  const { niceAxis } = await import('../src/ui/charts/UsageCharts');
  assert.deepEqual(niceAxis(0.16, [4, 2], { cap: 1 }), { max: 0.2, intervals: 4 });
  assert.equal(niceAxis(1.4, [4, 2], { cap: 1 }).max, 1);
  assert.equal(niceAxis(0.97, [4, 2], { cap: 1 }).max, 1);
  assert.equal(niceAxis(10, [4, 2], { integer: true }).max, 10);
  assert.equal(Number.isInteger(niceAxis(3, [4, 2], { integer: true }).max), true);
  assert.equal(niceAxis(0, [2]).max, 1);
});
