import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SwarmPlanRow, SwarmPlanView } from '../src/ui/SwarmWorkspace.tsx';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/SwarmWorkspace.tsx');
const storageKey = 'pugport-hidden-swarm-plan-rows';
const row = (id: string, state: SwarmPlanRow['state']): SwarmPlanRow => ({ id, title: id, kind: 'read', state });
const plan = (
  scope = 'chat-a/owner-a',
  rows = [row('finished', 'done'), row('failed', 'failed'), row('live', 'running')],
): SwarmPlanView => ({
  scope,
  rows,
  done: rows.filter((item) => item.state === 'done').length,
});
const hideButton = (tree: unknown, title: string) =>
  findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === `隐藏任务：${title}`);
const restoreButton = (tree: unknown) =>
  findNode(tree, (node) => node.type === 'button' && node.props.className === 'inline-link swarm-plan-restore');
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

test('finished rows hide and restore through their buttons without changing the plan or active tasks', async () => {
  const localStorage = storage();
  const harness = uiHarness(await bundle, { localStorage });
  const original = plan();
  const before = structuredClone(original);
  const render = () => harness.render('SwarmPlanPanel', { plan: original });
  let tree = render();
  assert.match(text(tree), /1\/3 完成/);
  assert.equal(hideButton(tree, 'live'), undefined);
  assert.equal(hideButton(tree, 'finished')!.props.title, '从任务清单隐藏，历史记录保留');
  hideButton(tree, 'finished')!.props.onClick();
  tree = render();
  assert.equal(hideButton(tree, 'finished'), undefined);
  assert.match(text(tree), /0\/2 完成/);
  assert.match(text(tree), /failed/);
  assert.match(text(tree), /live/);
  assert.match(text(restoreButton(tree)), /\(1\)/);
  hideButton(tree, 'failed')!.props.onClick();
  tree = render();
  assert.match(text(tree), /0\/1 完成/);
  assert.equal(hideButton(tree, 'failed'), undefined);
  restoreButton(tree)!.props.onClick();
  tree = render();
  assert.ok(hideButton(tree, 'finished'));
  assert.ok(hideButton(tree, 'failed'));
  assert.equal(restoreButton(tree), undefined);
  assert.deepEqual(original, before, 'hiding is a local view preference, never a workflow mutation');
});

test('hidden rows persist on remount and the same task id stays visible in another chat or plan owner', async () => {
  const localStorage = storage();
  const code = await bundle;
  const first = uiHarness(code, { localStorage });
  const original = plan('chat-a/owner-a', [row('same-id', 'failed')]);
  hideButton(first.render('SwarmPlanPanel', { plan: original }), 'same-id')!.props.onClick();
  const compact = first.render('SwarmPlanPanel', { plan: original });
  assert.equal(
    findNode(compact, (node) => node.type === 'ol'),
    undefined,
    'all hidden leaves one compact restore action',
  );
  assert.equal(compact.props.className, 'swarm-plan swarm-plan-hidden');
  first.unmount();
  const remount = uiHarness(code, { localStorage });
  assert.equal(hideButton(remount.render('SwarmPlanPanel', { plan: original }), 'same-id'), undefined);
  for (const scope of ['chat-b/owner-a', 'chat-a/owner-b'])
    assert.ok(hideButton(remount.render('SwarmPlanPanel', { plan: plan(scope, original.rows) }), 'same-id'));
  const tree = remount.render('SwarmPlanPanel', { plan: original });
  restoreButton(tree)!.props.onClick();
  assert.ok(hideButton(remount.render('SwarmPlanPanel', { plan: original }), 'same-id'));
});

test('a hidden task appears when it runs again and remains visible when that run finishes', async () => {
  const localStorage = storage();
  const harness = uiHarness(await bundle, { localStorage });
  const original = plan('rerun', [row('same-id', 'failed')]);
  hideButton(harness.render('SwarmPlanPanel', { plan: original }), 'same-id')!.props.onClick();
  assert.equal(hideButton(harness.render('SwarmPlanPanel', { plan: original }), 'same-id'), undefined);
  const running = plan('rerun', [row('same-id', 'running')]);
  const tree = harness.render('SwarmPlanPanel', { plan: running });
  assert.match(text(tree), /same-id/);
  assert.equal(restoreButton(tree), undefined);
  assert.equal(hideButton(tree, 'same-id'), undefined);
  assert.ok(hideButton(harness.render('SwarmPlanPanel', { plan: plan('rerun', [row('same-id', 'done')]) }), 'same-id'));
  assert.equal(localStorage.values.get(storageKey), '[]');
});

test('damaged and unavailable device storage still allow hiding and restoring in memory', async () => {
  const code = await bundle;
  for (const stored of ['broken json', '{"wrong":true}', '[null,1,{},"irrelevant"]', null]) {
    const harness = uiHarness(code, {
      localStorage: {
        getItem() {
          if (stored === null) throw new Error('storage disabled');
          return stored;
        },
        setItem() {
          throw new Error('storage full');
        },
      },
    });
    const original = plan('unavailable', [row('finished', 'done')]);
    hideButton(harness.render('SwarmPlanPanel', { plan: original }), 'finished')!.props.onClick();
    harness.remount();
    const tree = harness.render('SwarmPlanPanel', { plan: original });
    assert.equal(hideButton(tree, 'finished'), undefined);
    restoreButton(tree)!.props.onClick();
    assert.ok(hideButton(harness.render('SwarmPlanPanel', { plan: original }), 'finished'));
  }
});

test('device storage retains at most 500 hidden task keys', async () => {
  const localStorage = storage();
  localStorage.values.set(storageKey, JSON.stringify(Array.from({ length: 510 }, (_, index) => `old-${index}`)));
  const harness = uiHarness(await bundle, { localStorage });
  const original = plan('bounded', [row('finished', 'done')]);
  hideButton(harness.render('SwarmPlanPanel', { plan: original }), 'finished')!.props.onClick();
  const saved = JSON.parse(localStorage.values.get(storageKey)!);
  assert.equal(saved.length, 500);
  assert.equal(saved[0], 'old-11');
  assert.equal(saved.at(-1), JSON.stringify(['bounded', 'finished']));
});
