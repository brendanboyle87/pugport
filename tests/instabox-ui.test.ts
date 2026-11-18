import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemoteServerCards } from '../src/ui/RemoteServers.tsx';
import type { InstaboxMachineView, RemoteServersView } from '../src/shared/remote-servers.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const now = Date.parse('2026-10-29T06:00:00Z');
const machine: InstaboxMachineView = {
  source: 'instabox',
  machineId: 'm_fixture1',
  name: 'Fixture',
  state: 'running',
  checkedAt: '2026-10-29T05:57:00Z',
  spec: { vcpus: 4, memMiB: 8192, persistentDiskGiB: 20 },
  template: 'agent-browser',
  free: true,
  autoSuspendAfterSeconds: 1800,
  runStartedAt: '2026-10-29T05:00:00Z',
  maxRunMinutes: 480,
};
const cards = (value: InstaboxMachineView, error?: string) =>
  renderToStaticMarkup(
    createElement(RemoteServerCards, {
      view: { servers: [], file: 'fixture', instabox: { machines: [value], error } },
      api: async () => undefined as never,
      notify() {},
      onOpen() {},
      now,
    }),
  );

test('instabox cards show state, idle policy, configured specs and estimated max run without SSH controls', () => {
  const html = cards(machine);
  assert.match(html, /quota-card compact-quota-card remote-server-card unknown/);
  for (const text of [
    '运行中',
    '闲置 30 分钟后暂停',
    '4 vCPU · 8 GiB · 持久盘 20 GiB',
    'agent-browser',
    '免费方案',
    '3 分钟前检查',
    '最长运行时间',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /没有 SSH|到期日|device-resource|发送文件|上次活动/);
  assert.match(html, /预计最晚 \d\d:\d\d 暂停/);
});

test('instabox cards omit invalid estimates, preserve unknown states and distinguish stale readings', () => {
  for (const patch of [
    { runStartedAt: 'invalid' },
    { maxRunMinutes: -1 },
    { maxRunMinutes: 0 },
    { maxRunMinutes: undefined },
    { state: 'paused' },
  ])
    assert.doesNotMatch(cards({ ...machine, ...patch }), /预计最晚/);
  const html = cards({ ...machine, state: 'future-state', stale: true, autoSuspendAfterSeconds: 0 }, 'failed');
  for (const text of ['future-state', '状态待更新', '无法连接 instabox', '闲置时不暂停', '3 分钟前检查'])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /离线|不可达|预计最晚/);
  for (const state of ['constructor', 'toString', '__proto__'])
    assert.ok(cards({ ...machine, state }).includes(`translate="no">${state}</span>`));
  assert.match(cards({ ...machine, pendingAction: 'pause' }), /正在暂停…/);
  assert.match(cards({ ...machine, state: 'paused', pendingAction: 'resume' }), /正在恢复…/);
  assert.equal(
    renderToStaticMarkup(
      createElement(RemoteServerCards, { api: async () => undefined as never, notify() {}, onOpen() {}, now }),
    ),
    '',
  );
});

test('instabox actions require a click, block duplicates and old reads, then share manual refresh loader', async () => {
  let tick!: () => void;
  const h = uiHarness(await uiBundle('src/ui/RemoteServers.tsx'), {
    document: { visibilityState: 'visible' },
    // The server list refreshes every minute; the enrollment progress poll has its own timer.
    setInterval: (fn: () => void, ms: number) => {
      if (ms === 60_000) tick = fn;
      return 1;
    },
  });
  const view: RemoteServersView = { servers: [], file: 'fixture', instabox: { machines: [machine] } };
  let answer = view;
  let resolveOld: ((value: RemoteServersView) => void) | undefined;
  let resolveAction!: (value: RemoteServersView) => void;
  let holdRead = false;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const props = {
    now,
    devices: [],
    notify() {},
    reload: async () => {},
    onOpen() {},
    refreshRevision: 0,
    api: async (path: string, body: unknown, method: string) => {
      if (path === '/api/remote-servers/enrollments') return { enrollments: [] };
      calls.push({ path, body, method });
      if (method === 'POST')
        return new Promise<RemoteServersView>((resolve) => {
          resolveAction = resolve;
        });
      if (holdRead)
        return new Promise<RemoteServersView>((resolve) => {
          resolveOld = resolve;
        });
      return answer;
    },
  };
  const shown = () => findNode(h.render('RemoteServers', props), (node) => node.type?.name === 'RemoteServerCards')!;
  shown();
  await nextTurn();
  await nextTurn();
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  holdRead = true;
  tick();
  await nextTurn();
  const click = shown().props.onInstaboxAction;
  click(machine, 'pause');
  click(machine, 'pause');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
    path: '/api/remote-servers/instabox/action',
    body: { machineId: machine.machineId, action: 'pause' },
    method: 'POST',
  });
  assert.equal(shown().props.busy, machine.machineId);
  answer = { ...view, instabox: { machines: [{ ...machine, state: 'paused' }] } };
  resolveAction(answer);
  await nextTurn();
  assert.equal(shown().props.view.instabox.machines[0].state, 'paused');
  holdRead = false;
  resolveOld!(view);
  await nextTurn();
  await nextTurn();
  assert.equal(shown().props.view.instabox.machines[0].state, 'paused');
  const before = calls.length;
  props.refreshRevision++;
  shown();
  await nextTurn();
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)?.path, '/api/remote-servers?refresh=1');
  h.unmount();
});
