import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { cliReadiness } from '../src/shared/runtime-readiness.ts';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const target: RuntimeTarget = {
  id: 'synthetic-codex',
  provider: 'codex',
  label: 'Synthetic Codex',
  command: 'unused',
  environment: 'native',
  enabled: true,
};
function runtime(status: RuntimeSnapshot['status'] = 'auth-required'): RuntimeSnapshot {
  return {
    ...target,
    installed: status !== 'missing',
    status,
    models: status === 'ready' ? [{ id: 'synthetic-model', label: 'Synthetic', efforts: [] }] : [],
    capabilities: { execute: status === 'ready', resume: true, cancel: true, approvals: true },
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    refreshedAt: '2026-10-29T00:00:00Z',
  };
}
const bundle = uiBundle('src/ui/StartChecklist.tsx');
async function fixture(targets = [target], runtimes = [runtime()]) {
  const h = uiHarness(await bundle);
  let opened = 0;
  const props = {
    state: { targets, runtimes, refreshing: false } as AppState,
    api: async <T>() => ({}) as T,
    reload: async () => {},
    notify() {},
    onOpenAccounts: () => {
      opened++;
    },
  };
  return { h, props, render: () => h.render('StartChecklist', props), opened: () => opened };
}

test('cliReadiness preserves connected, missing, disabled, authentication and unchecked statuses', () => {
  assert.deepEqual(cliReadiness(target, runtime('ready')), { usable: true, label: '已连接' });
  assert.equal(cliReadiness(target, runtime('missing')).label, '未安装');
  assert.equal(cliReadiness(target, runtime()).label, '未登录');
  assert.equal(cliReadiness(target).label, '待检查');
  const auth = {
    ...runtime('ready'),
    availability: { reason: 'authentication' as const, observedAt: '2026-10-29T00:00:00Z' },
  };
  assert.equal(cliReadiness(target, auth).label, '未登录');
  assert.equal(cliReadiness({ ...target, enabled: false }, runtime('ready')).usable, false);
});

test('checklist renders only detected native CLI rows and reuses the connection action', async () => {
  const absent = { ...target, id: 'absent', label: 'Absent CLI' };
  const pending = { ...target, id: 'pending', label: 'Pending CLI' };
  const remote = { ...target, id: 'remote', label: 'WSL CLI', environment: 'wsl' as const };
  const f = await fixture(
    [target, absent, pending, remote],
    [runtime(), { ...runtime('missing'), id: absent.id }, { ...runtime(), id: remote.id }],
  );
  const tree = f.render();
  assert.match(text(tree), /Synthetic Codex未登录/);
  assert.doesNotMatch(text(tree), /Absent CLI|Pending CLI|WSL CLI|安装一个 CLI/);
  const action = findNode(tree, (node) => node.type?.name === 'CliConnectionAction');
  assert.equal(action?.props.target.id, target.id);
  assert.equal(action?.props.snapshot.status, 'auth-required');
  assert.equal(findNode(tree, (node) => node.type === 'li')?.key, target.id);
  assert.doesNotMatch(text(tree), /关联项目文件夹/);
  f.h.unmount();
});

test('no detected CLI has one Accounts action', async () => {
  const f = await fixture([target], [runtime('missing')]);
  const tree = f.render();
  assert.match(text(tree), /尚未发现 CLI。/);
  assert.equal(
    findNode(tree, (node) => node.type === 'li'),
    undefined,
  );
  findNode(tree, (node) => node.type === 'button' && text(node) === '安装一个 CLI')!.props.onClick();
  assert.equal(f.opened(), 1);
  f.h.unmount();
});

test('usable account hides the checklist', async () => {
  const f = await fixture([target], [runtime('ready')]);
  const tree = f.render();
  assert.equal(tree, null);
  f.h.unmount();
});

test('Accounts action also uses the Studio context without additional Workspace props', async () => {
  const f = await fixture([], []);
  let opened = 0;
  f.h.exports.StartChecklistAccountsContext.value = () => {
    opened++;
  };
  const tree = f.h.render('StartChecklist', { ...f.props, onOpenAccounts: undefined });
  findNode(tree, (node) => node.type === 'button' && text(node) === '安装一个 CLI')!.props.onClick();
  assert.equal(opened, 1);
  f.h.unmount();
});

test('checklist reports actual visibility and releases it on usable account or unmount', async () => {
  const f = await fixture();
  const reports: Array<[string, boolean]> = [];
  f.h.exports.StartChecklistVisibilityContext.value = (id: string, shown: boolean) => reports.push([id, shown]);
  f.render();
  assert.equal(reports.at(-1)?.[1], true);
  const id = reports.at(-1)![0];
  f.h.render('StartChecklist', { ...f.props, visible: false });
  assert.deepEqual(reports.at(-1), [id, false], 'main-view Mod hides the checklist without unmounting it');
  f.render();
  assert.deepEqual(reports.at(-1), [id, true]);
  f.props.state.runtimes = [runtime('ready')];
  f.render();
  assert.deepEqual(reports.at(-1), [id, false]);
  f.props.state.runtimes = [runtime()];
  f.render();
  assert.deepEqual(reports.at(-1), [id, true]);
  f.h.unmount();
  assert.deepEqual(reports.at(-1), [id, false]);
});
