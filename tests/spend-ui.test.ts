import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpendOverview } from '../src/server/spend-ledger.ts';
import { spendFixture } from './helpers/spend-fixture.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/SpendLedger.tsx');
test('unknown billing heat uses runs and pay-per-use CLI keeps its transport label', async () => {
  const data = buildSpendOverview(spendFixture());
  const row = data.accounts[0]!;
  row.group = 'unknown';
  row.executionKind = 'cli';
  row.cells[0] = { runs: 4, tasks: 2, billedUsd: null, referenceUsd: null, missingCost: 4 };
  data.accounts = [row];
  const h = uiHarness(await bundle);
  const tree = h.render('SpendLedger', { data, onAccount() {}, onDay() {}, onInspect() {}, onPrefer: async () => {} });
  assert.ok(findNode(tree, (n) => n.props.className === 'spend-cell' && n.props.style['--heat'] > 0));
  const label = text(findNode(tree, (n) => n.props.className === 'spend-account-name'));
  assert.match(label, /CLI/);
  assert.doesNotMatch(label, /API/);
  h.unmount();
});

test('live usage refresh coalesces updates until 30 seconds and flushes on completion', async () => {
  const code = await uiBundle('src/ui/UsageSpend.tsx');
  let now = 100_000;
  let id = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const h = uiHarness(code, {
    Date: Clock,
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (key: number) => timers.delete(key),
  });
  const calls: string[] = [];
  const data = buildSpendOverview(spendFixture());
  const api = async (path: string) => {
    calls.push(path);
    return data;
  };
  const state = { targets: [], projects: [], runs: [{ status: 'running' }], usage: { generatedAt: '1' } };
  const render = () => h.render('UsageSpend', { state, api, onInspect() {} });
  render();
  await nextTurn();
  render();
  for (let n = 2; n <= 10; n++) {
    now += 1000;
    state.usage.generatedAt = String(n);
    render();
  }
  assert.equal(calls.length, 1);
  now = 130_000;
  for (const [key, timer] of [...timers])
    if (timer.at <= now) {
      timers.delete(key);
      timer.fn();
    }
  render();
  await nextTurn();
  render();
  assert.equal(calls.length, 2);
  state.usage.generatedAt = 'final';
  state.runs = [];
  render();
  await nextTurn();
  render();
  assert.equal(calls.length, 3);
  h.unmount();
});
test('Spend task cards open their workflow trace, and credit preference requires confirmation', async () => {
  const data = buildSpendOverview(spendFixture(), {});
  const opened: string[] = [],
    saved: string[] = [];
  const h = uiHarness(await bundle);
  const props = {
    data,
    onAccount() {},
    onDay() {},
    onInspect: (id: string) => opened.push(id),
    onPrefer: async (id: string) => {
      saved.push(id);
    },
  };
  const render = () => h.render('SpendLedger', props);
  let tree = render();
  findNode(tree, (n) => n.type === 'button' && text(n) === '打开轨迹 →')!.props.onClick();
  assert.deepEqual(opened, [data.insights.tasks[0]!.traceWorkflowId]);
  findNode(tree, (n) => n.type === 'button' && text(n) === '优先使用此赠金')!.props.onClick();
  tree = render();
  assert.deepEqual(saved, []);
  assert.ok(findNode(tree, (n) => n.props.role === 'dialog'));
  findNode(tree, (n) => n.type === 'button' && text(n) === '取消')!.props.onClick();
  tree = render();
  assert.equal(
    findNode(tree, (n) => n.props.role === 'dialog'),
    undefined,
  );
  findNode(tree, (n) => n.type === 'button' && text(n) === '优先使用此赠金')!.props.onClick();
  tree = render();
  findNode(tree, (n) => n.type === 'button' && text(n) === '确认')!.props.onClick();
  render();
  await nextTurn();
  tree = render();
  assert.deepEqual(saved, ['executor-3']);
  assert.equal(
    findNode(tree, (n) => n.props.role === 'dialog'),
    undefined,
  );
  h.unmount();
});

test('account and calendar buttons use immutable account keys and local days', async () => {
  const data = buildSpendOverview(spendFixture(), {});
  const accounts: string[] = [],
    days: string[][] = [];
  const h = uiHarness(await bundle);
  const tree = h.render('SpendLedger', {
    data,
    onAccount: (key: string) => accounts.push(key),
    onDay: (key: string, day: string) => days.push([key, day]),
    onInspect() {},
    onPrefer: async () => {},
  });
  findNode(tree, (n) => n.props.className === 'spend-account-name')!.props.onClick();
  findNode(tree, (n) => n.props.className === 'spend-cell')!.props.onClick();
  assert.deepEqual(accounts, [data.accounts[0]!.key]);
  assert.deepEqual(days, [[data.accounts[0]!.key, data.days[0]!]]);
  assert.equal(data.days.length, 56);
  // Filtering after focusing a lower account must retain a keyboard entry point.
  const last = data.accounts.at(-1)!;
  findNode(
    tree,
    (n) => n.props.className === 'spend-cell' && n.props['aria-label'].includes(last.label),
  )!.props.onFocus();
  const filtered = h.render('SpendLedger', {
    data: { ...data, accounts: [data.accounts[0]!] },
    onAccount() {},
    onDay() {},
    onInspect() {},
    onPrefer: async () => {},
  });
  assert.ok(findNode(filtered, (n) => n.props.className === 'spend-cell' && n.props.tabIndex === 0));
  h.unmount();
});
