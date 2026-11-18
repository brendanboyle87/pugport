import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MentionMenu, mentionItems } from '../src/ui/Mentions.tsx';
import { deviceStatus, executorLine } from '../src/ui/Devices.tsx';
import { externalPersona } from '../src/ui/ExternalAgents.tsx';
import { slackStatusText } from '../src/ui/SlackGateway.tsx';
import type { DeviceView, DevicesView } from '../src/shared/devices.ts';
import type { ConversationMessage } from '../src/shared/types.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

// In-memory rendering with fake APIs only.
const online: DeviceView = {
  id: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
  name: '家里的Ubuntu',
  address: '100.101.102.103',
  pairedAt: '2026-10-11T08:00:00Z',
  online: true,
  platform: 'linux',
  executors: [
    {
      label: 'Claude B',
      provider: 'claude',
      status: 'ready',
      windows: [
        { name: '5h', remaining: 80 },
        { name: '周', remaining: 62 },
      ],
      tightest: 62,
    },
    { label: 'Codex', provider: 'codex', status: 'auth-required', windows: [] },
  ],
  running: 1,
};
const offline: DeviceView = {
  id: '7f9619ff-8b86-4d11-b42d-00c04fc964ff',
  name: 'mac-mini',
  address: 'mac-mini',
  pairedAt: '2026-10-11T08:00:00Z',
  online: false,
  reason: '连不上设备。',
};

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

let cardCode: string;
before(async () => {
  cardCode = await uiBundle('tests/helpers/confirmation-fixture.ts');
});

for (const scenario of ['mixed', 'server-only', 'failed-list']) {
  test('Settings groups devices without a Slack host selector: ' + scenario, async () => {
    const server = { ...online, id: 'server', name: 'Node name', tunnel: { ssh: 'fixture-box', remotePort: 4318 } };
    const orphan = { ...server, id: 'old-box', name: 'old-box', tunnel: { ssh: 'old-box', remotePort: 4318 } };
    const devices = scenario === 'mixed' ? [online, server, orphan] : [server];
    const h = uiHarness(cardCode, { setInterval: () => 1 });
    const props = {
      api: async (path: string, _body: unknown, method: string) => {
        if (path === '/api/maintainer/status') return { configured: false, desk: { link: 'none' } };
        if (path === '/api/remote-servers') {
          if (scenario === 'failed-list') throw new Error('Synthetic list failure');
          return { servers: [{ name: 'Different card name', ssh: server.tunnel.ssh }], file: 'synthetic.json' };
        }
        assert.ok(path === '/api/devices' || path === '/api/devices?refresh=1');
        return { devices, slackHost: server.id };
      },
      notify() {},
    };
    const render = () => h.render('DevicesCard', props);
    render();
    await nextTurn();
    await nextTurn();
    const tree = render();
    const computers = findNode(tree, (node) => node.props.title === '已添加的设备');
    const servers = findNode(tree, (node) => node.props.title === '服务器');
    const row = (tree: unknown, id: string) => findNode(tree, (node) => node.props.itemId === id);
    assert.equal(!!computers, scenario === 'mixed');
    assert.equal(!!servers, scenario !== 'server-only');
    assert.equal(!!row(computers, online.id), scenario === 'mixed');
    assert.equal(!!row(computers, server.id), false);
    assert.equal(!!row(tree, server.id), scenario === 'failed-list');
    assert.equal(!!row(servers, orphan.id), scenario === 'mixed');
    if (scenario !== 'mixed') assert.match(text(tree), /还没有添加设备。/);
    if (servers) {
      assert.match(text(servers), /Claude B · 5h 80% · 周 62%/);
      assert.ok(findNode(servers, (node) => node.type === 'button' && text(node).includes('移除设备')));
    }
    assert.equal(
      findNode(tree, (node) => node.props['aria-label'] === 'Slack 由哪台运行'),
      undefined,
    );
    h.unmount();
  });
}

test('the @@ list offers devices that are not known to be offline, as their own kind', () => {
  const items = mentionItems(
    [],
    [],
    [],
    [online, offline, { ...offline, id: 'x', name: 'unchecked', online: undefined }],
  );
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.name]),
    [
      ['device', `device:${online.id}`, '家里的Ubuntu'],
      ['device', 'device:x', 'unchecked'],
    ],
  );
  const html = renderToStaticMarkup(
    createElement(MentionMenu, { items, active: 0, onHover() {}, onPick() {}, onCreate() {} }),
  );
  assert.match(html, /设备/);
  assert.match(html, /家里的Ubuntu/);
  assert.doesNotMatch(html, /mac-mini/);
  assert.doesNotMatch(items.find((item) => item.kind === 'device')!.description!, /只读/);
});

test('device files use the native picker, send only selected paths and display returned remote paths', async () => {
  const writes: any[] = [];
  const notices: any[] = [];
  let picked = ['C:/synthetic/notes.txt', 'C:/synthetic/spec.pdf'];
  let fail = false;
  const h = uiHarness(cardCode, {
    Error,
    window: { comboRunnerDesktop: { pickDirectory: async () => null, pickFiles: async () => picked } },
  });
  const props = {
    api: async (path: string, body: any) => {
      if (path.endsWith('/files')) {
        writes.push({ path, body });
        if (fail) throw new Error('Synthetic transfer failed');
        return { files: [{ path: '/home/test/Downloads/PugPort/notes.txt' }] };
      }
      return { devices: [online, offline], slackHost: null };
    },
    notify: (notice: any) => notices.push(notice),
  };
  const render = () => h.render('DevicesCard', props);
  render();
  await nextTurn();
  await nextTurn();
  const send = () => findNode(render(), (node) => node.type === 'button' && text(node).includes('发送文件'))!;
  assert.equal(send().props.disabled, false);
  await send().props.onClick();
  await nextTurn();
  assert.deepEqual(plain(writes), [{ path: `/api/devices/${online.id}/files`, body: { paths: picked } }]);
  assert.match(text(render()), /已保存到 家里的Ubuntu：.*\/home\/test\/Downloads\/PugPort\/notes.txt/);
  picked = [];
  await send().props.onClick();
  await nextTurn();
  assert.equal(writes.length, 1, 'Cancel does not send a request');
  picked = ['C:/synthetic/retry.txt'];
  fail = true;
  await send().props.onClick();
  await nextTurn();
  assert.match(notices.at(-1).message, /Synthetic transfer failed/);
  assert.equal(send().props.disabled, false, 'Failure releases the pending state');
  h.unmount();
});

test('device capability distinguishes enabled, disabled and unknown writes and web cannot open files', async () => {
  const h = uiHarness(cardCode);
  const props = {
    api: async () => ({
      devices: [
        { ...online, id: 'enabled', allowWrite: true },
        { ...online, id: 'disabled', allowWrite: false },
        { ...online, id: 'unknown' },
      ],
      slackHost: null,
    }),
    notify() {},
  };
  h.render('DevicesCard', props);
  await nextTurn();
  await nextTurn();
  const tree = h.render('DevicesCard', props);
  assert.match(text(tree), /设备写入已开启/);
  assert.match(text(tree), /设备写入已关闭/);
  assert.doesNotMatch(text(tree), /设备写入状态未知/);
  const send = findNode(tree, (node) => node.type === 'button' && text(node).includes('发送文件'))!;
  assert.equal(send.props.disabled, true);
  assert.match(send.props.title, /桌面应用/);
  h.unmount();
});

test('device lines in plain words, and replies labelled with the device and its executor', () => {
  assert.equal(deviceStatus(online), '在线 · Linux · 2 个执行器 · 1 个任务在运行');
  assert.equal(deviceStatus(offline), '连不上：连不上设备。');
  assert.equal(deviceStatus({ ...offline, online: undefined }), '正在检查…');
  assert.equal(executorLine(online.executors![0]!), 'Claude B · 5h 80% · 周 62%');
  assert.equal(executorLine(online.executors![1]!), 'Codex · 要先登录');
  const reply = (extra: Partial<ConversationMessage>): ConversationMessage => ({
    id: 'm',
    conversationId: 'c',
    role: 'assistant',
    content: 'x',
    createdAt: '2026-10-11T08:00:00Z',
    ...extra,
  });
  assert.equal(
    externalPersona(reply({ device: { id: 'd', name: '家里的Ubuntu', executor: 'Claude B' } })),
    '家里的Ubuntu · Claude B',
  );
  assert.equal(externalPersona(reply({ device: { id: 'd', name: '家里的Ubuntu' } })), '家里的Ubuntu');
  assert.equal(externalPersona(reply({})), undefined);
  assert.match(
    slackStatusText({ enabled: true, status: 'off', users: [], activeTasks: 0, hostedBy: '家里的Ubuntu' }),
    /由「家里的Ubuntu」运行.*可在下面更改/,
  );
});

test('the 设备 card: add with address and code, remove after confirming, and no Slack settings', async () => {
  const calls: Array<{ path: string; body?: any; method?: string }> = [];
  let view: DevicesView = { devices: [online, offline], slackHost: null };
  const api = async (path: string, body?: any, method?: string) => {
    calls.push({ path, body, method });
    if (method === 'DELETE') view = { ...view, devices: view.devices.filter((device) => !path.endsWith(device.id)) };
    return view;
  };
  const notices: any[] = [];
  const h = uiHarness(cardCode);
  const store = h.exports.confirmationStore;
  const props = { api, notify: (notice: unknown) => notices.push(notice) };
  h.render('DevicesCard', props);
  await nextTurn();
  await nextTurn();
  let tree = h.render('DevicesCard', props);
  assert.match(text(tree), /家里的Ubuntu/);
  assert.match(text(tree), /Claude B · 5h 80% · 周 62%/);
  assert.match(text(tree), /连不上：连不上设备。/);
  assert.ok(findNode(tree, (node) => node.props.itemId === online.id));
  // The saved list first, then a look at each device.
  assert.deepEqual(
    calls
      .filter((call) => call.path.startsWith('/api/devices'))
      .slice(0, 2)
      .map((call) => call.path),
    ['/api/devices', '/api/devices?refresh=1'],
  );

  // Adding.
  findNode(tree, (node) => node.type === 'button' && text(node).includes('添加设备'))!.props.onClick();
  tree = h.render('DevicesCard', props);
  findNode(tree, (node) => node.props['aria-label'] === '设备地址')!.props.onChange({
    target: { value: ' 100.1.2.3 ' },
  });
  findNode(h.render('DevicesCard', props), (node) => node.props['aria-label'] === '配对码')!.props.onChange({
    target: { value: 'ABCD-EFGH' },
  });
  tree = h.render('DevicesCard', props);
  await findNode(tree, (node) => node.type === 'button' && text(node).includes('配对'))!.props.onClick();
  await nextTurn();
  const writes = () => calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(plain(writes()), [{ path: '/api/devices', body: { address: '100.1.2.3', code: 'ABCD-EFGH' } }]);

  // Removing asks first.
  tree = h.render('DevicesCard', props);
  findNode(tree, (node) => node.props['aria-label'] === '移除 mac-mini')!.props.onClick();
  // The device's name is filled in as written, never translated with the sentence.
  assert.equal(store.snapshot().options.title, '移除设备「{0}」？');
  assert.deepEqual(plain(store.snapshot().options.names), ['mac-mini']);
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
  store.resolve(store.snapshot().id, false);
  await nextTurn();
  const removal = findNode(
    h.render('DevicesCard', props),
    (node) => node.props['aria-label'] === '移除 mac-mini',
  )!.props.onClick();
  store.resolve(store.snapshot().id, true);
  await removal;
  await nextTurn();
  assert.deepEqual(plain(writes().at(-1)), { path: `/api/devices/${offline.id}`, method: 'DELETE' });

  tree = h.render('DevicesCard', props);
  assert.equal(
    findNode(tree, (node) => node.props['aria-label'] === 'Slack 由哪台运行'),
    undefined,
  );
  assert.equal(
    calls.some((call) => call.path === '/api/devices/slack-host'),
    false,
  );
  h.unmount();
});

import { DeviceUsageCards, DeviceQuotaCard, deviceBytes } from '../src/ui/DeviceUsage.tsx';
import { dateLabel } from '../src/ui/App.tsx';

const usageNow = Date.parse('2026-10-21T00:00:00Z');
const hardwareDevice: DeviceView = {
  ...online,
  version: '0.0.test',
  arch: 'x64',
  checkedAt: '2026-10-21T06:40:00Z',
  lastSeenAt: '2026-10-20T05:00:00Z',
  resources: {
    cpuPercent: 39,
    gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    gpuPercent: 12,
    memoryUsed: 6.1 * 1024 ** 3,
    memoryTotal: 8 * 1024 ** 3,
    vram: { usedMiB: 2048, totalMiB: 8192 },
    observedAt: '2026-10-21T06:40:00Z',
  },
  hardware: {
    os: 'Ubuntu 26.04',
    cpu: 'Fixture CPU',
    gpu: 'Intel UHD 620',
    gpuOthers: ['NVIDIA GeForce RTX 4060 Laptop GPU'],
    cores: 4,
    threads: 8,
    memoryTotal: 16 * 1024 ** 3,
    memoryAvailable: 9.2 * 1024 ** 3,
    diskTotal: 512 * 1024 ** 3,
    diskFree: 120 * 1024 ** 3,
    readAt: '2026-10-19T01:00:00Z',
  },
};
const fullCard = (device: DeviceView) =>
  renderToStaticMarkup(createElement(DeviceQuotaCard, { device, now: usageNow }));
const smallCards = (devices: DeviceView[]) =>
  renderToStaticMarkup(createElement(DeviceUsageCards, { devices, now: usageNow, onOpen() {} }));

test('small device cards have three resource cells, model details and no account rows, disk, plans or resets', () => {
  assert.equal(smallCards([]), '');
  const tunnel = {
    ...hardwareDevice,
    id: 'server-fixture',
    name: 'fixture-vps',
    tunnel: { ssh: 'fixture-vps', remotePort: 4318 },
  };
  assert.equal(smallCards([tunnel]), '');
  const html = smallCards([hardwareDevice, tunnel]);
  assert.doesNotMatch(html, /fixture-vps|server-fixture/);
  assert.equal((html.match(/class="device-resource"/g) ?? []).length, 3);
  assert.equal((html.match(/class="device-resource-label quota-window-heading"/g) ?? []).length, 3);
  for (const detail of ['Fixture · 4 核 8 线程', 'RTX 4060 Laptop', '6.1 / 8 GiB'])
    assert.ok(html.includes(`<small title="${detail}" translate="no">${detail}</small>`));
  assert.match(
    html,
    /data-runtime-id="6f9619ff-8b86-4d11-b42d-00c04fc964ff" tabindex="0" role="button" aria-haspopup="dialog"/,
  );
  assert.match(html, /translate="no">家里的Ubuntu/);
  assert.match(html, /Ubuntu 26.04 · x86_64/);
  assert.match(html, /CPU<\/span><strong>39%/);
  assert.match(html, /GPU<\/span><strong>12%/);
  assert.match(html, /内存<\/span><strong>76%/);
  assert.match(html, /Fixture · 4 核 8 线程/);
  assert.match(html, /RTX 4060 Laptop/);
  assert.doesNotMatch(html, /UHD 620/);
  assert.match(html, /6.1 \/ 8 GiB/);
  assert.match(html, /PugPort 0.0.test/);
  assert.doesNotMatch(html, /device-account|磁盘|reset-time/);
  assert.equal(deviceBytes(16 * 1024 ** 3), '16 GB');
  assert.equal(deviceBytes(512 * 1024 ** 2), '512 MB');
});

test('small chips sum CLI headroom, keep web accounts separate and report running or idle', () => {
  const account = { label: 'Claude A', provider: 'claude', status: 'ready', tightest: 62, windows: [], plan: 'Max' };
  const device = {
    ...hardwareDevice,
    executors: [
      account,
      { ...account, label: 'Claude B', tightest: 12, stale: true },
      { ...account, label: 'Grok Bot', provider: 'web', tightest: 100 },
      { ...account, label: 'Other Bot', provider: 'web', tightest: undefined },
    ],
    running: 2,
  };
  const html = smallCards([device]);
  assert.equal((html.match(/class="device-quota-chip /g) ?? []).length, 3);
  assert.match(html, /Claude<\/span> 74%/);
  assert.match(html, /Grok Bot<\/span> 100%/);
  assert.match(html, /Other Bot<\/span> —/);
  assert.match(html, /2 个 Agent 任务运行中/);
  assert.match(html, /opacity:0.55/);
  assert.doesNotMatch(html, /Claude A|Claude B|Max|device-account/);
  assert.match(smallCards([{ ...device, running: 0 }]), /空闲/);
});

test('full accounts have every window bar and reset, full hardware, VRAM and disk', () => {
  const windows = [
    { name: '5h', remaining: 12, resetsAt: '2026-10-22T00:00:00Z' },
    { name: '周', remaining: 62, resetsAt: '2026-10-24T00:00:00Z' },
    { name: 'Fable 周', remaining: 27, resetsAt: '2026-10-25T00:00:00Z' },
  ];
  const html = fullCard({
    ...hardwareDevice,
    executors: [{ label: 'Claude', provider: 'claude', status: 'ready', windows, plan: 'Max', stale: true }],
  });
  assert.match(html, /Fixture CPU · 4 核 8 线程/);
  assert.match(html, /NVIDIA GeForce RTX 4060 Laptop GPU · 显存 2.0\/8.0 GB · Intel UHD 620/);
  assert.match(html, /Ubuntu 26.04 · x86_64 · PugPort 0.0.test/);
  assert.match(html, /aria-label="磁盘"/);
  assert.match(html, /plan-badge">Max/);
  assert.match(html, /opacity:0.55/);
  assert.equal((html.match(/class="reset-time"/g) ?? []).length, 3);
  for (const window of windows)
    assert.ok(
      html.includes(
        `aria-label="Claude ${window.name}剩余额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${window.remaining}"`,
      ),
    );
  assert.match(html, /<span>Fable 周<\/span>/);
  for (const window of windows) assert.ok(html.includes(`<strong translate="no">剩余 ${window.remaining}%</strong>`));
  for (const reset of ['1 天后重置', '3 天后重置', '4 天后重置']) assert.ok(html.includes(reset));
});

test('full card keeps unknown and not-ready accounts, family labels and missing readings honest', () => {
  const full = fullCard({
    ...online,
    executors: [
      { label: 'Claude', provider: 'claude', status: 'ready', windows: [{ name: 'Opus 日', remaining: 50 }] },
      { label: 'Empty', provider: 'codex', status: 'ready', windows: [] },
      { label: 'Unknown', provider: 'codex', status: 'ready', windows: [{ name: '5h' }] },
      { label: 'Auth', provider: 'codex', status: 'auth-required', windows: [] },
      { label: 'Error', provider: 'codex', status: 'error', windows: [] },
    ],
  });
  assert.match(full, /<span>Opus 日<\/span>/);
  assert.match(full, /<strong translate="no">未知<\/strong>/);
  for (const label of ['额度未知', '要先登录', '暂不可用', 'unknown-track']) assert.ok(full.includes(label));
});

test('offline and checking cards hide live percentages but keep dimmed inventory', () => {
  for (const online of [false, undefined])
    for (const compact of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(DeviceQuotaCard, { device: { ...hardwareDevice, online }, now: usageNow, compact }),
      );
      assert.equal((html.match(/device-resource-label[^"]*"><span>[^<]+<\/span><strong>—/g) ?? []).length, 3);
      assert.equal((html.match(/width:0%/g) ?? []).length, 3);
      assert.match(html, /opacity:0.55/);
      assert.match(html, /UHD 620/);
      assert.match(html, /6.8 \/ 16 GiB/);
    }
});

test('both card sizes preserve three online states, dim offline readings and show old-node and never-reached hints', () => {
  for (const render of [fullCard, (device: DeviceView) => smallCards([device])]) {
    assert.match(render(hardwareDevice), /device-status online">在线/);
    const off = render({ ...hardwareDevice, online: false });
    assert.match(off, /device-status ">离线/);
    assert.match(off, /class="quota-body" style="opacity:0.55"/);
    const checking = render({ ...hardwareDevice, online: undefined });
    assert.match(checking, /正在检查…/);
    assert.match(checking, /opacity:0.55/);
    assert.match(render({ ...hardwareDevice, hardware: undefined }), /更新这台设备上的 PugPort/);
    assert.match(render({ ...offline, online: undefined }), /等待设备上报/);
  }
});

test('footers show one checked or last-seen time, and hardware bars warn only at ten percent', () => {
  const observedAt = '2026-10-21T06:30:00Z';
  const device: DeviceView = {
    ...hardwareDevice,
    hardware: { ...hardwareDevice.hardware!, memoryTotal: 100, memoryAvailable: 11, diskTotal: 100, diskFree: 10 },
    executors: [
      { ...online.executors![0]!, observedAt },
      { ...online.executors![0]!, observedAt: hardwareDevice.lastSeenAt },
    ],
  };
  for (const render of [fullCard, (device: DeviceView) => smallCards([device])]) {
    const html = render(device);
    assert.ok(!html.includes(`更新于 ${dateLabel(device.checkedAt!)}`));
    assert.equal((html.match(/<time/g) ?? []).length, 0);
    assert.equal((html.match(/class="quota-footer-line"/g) ?? []).length, 1);
    assert.ok(!html.includes(`更新于 ${dateLabel(observedAt)}`));
    assert.ok(!html.includes(device.hardware!.readAt));
    assert.doesNotMatch(render({ ...device, online: undefined }), /<time/);
    assert.doesNotMatch(render(offline), /<time/);
    const off = render({ ...device, online: false });
    assert.ok(off.includes(`上次在线 ${dateLabel(device.lastSeenAt!)}`));
    assert.doesNotMatch(off, /<footer[^>]*title=/);
    assert.doesNotMatch(render(offline), /<footer[^>]*title=/);
    assert.equal((off.match(/<time/g) ?? []).length, 1);
    assert.equal((off.match(/class="quota-footer-line"/g) ?? []).length, 1);
  }
  const fallback = fullCard({ ...device, executors: [] });
  assert.equal((fallback.match(new RegExp(`dateTime="${device.checkedAt}"`, 'g')) ?? []).length, 0);
  assert.equal((fallback.match(/quota-window danger/g) ?? []).length, 1);
  assert.doesNotMatch(fallback, /quota-window (healthy|warning|unknown)/);
  assert.equal((fallback.match(/class="device-capacity-value"/g) ?? []).length, 1);
});

test('device usage loads cache then refreshes, skips hidden and pending ticks and preserves readings on failure', async () => {
  let tick!: () => void;
  let cleared = false;
  const document = { visibilityState: 'visible' };
  const h = uiHarness(await uiBundle('src/ui/DeviceUsage.tsx'), {
    document,
    setInterval: (fn: () => void, ms: number) => {
      assert.equal(ms, 5000);
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  const calls: string[] = [];
  let resolve!: (value: DevicesView) => void;
  const api = (path: string) => {
    calls.push(path);
    return path.endsWith('refresh=1')
      ? new Promise<DevicesView>((done) => {
          resolve = done;
        })
      : Promise.resolve({ devices: [online], slackHost: null });
  };
  const props = { api, now: Date.now() };
  h.render('DeviceUsage', props);
  await nextTurn();
  assert.deepEqual(calls, ['/api/devices', '/api/devices?refresh=1']);
  tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    plain(findNode(h.render('DeviceUsage', props), (node) => node.type?.name === 'DeviceUsageCards')!.props.devices),
    plain([online]),
  );
  resolve({ devices: [offline], slackHost: null });
  await nextTurn();
  document.visibilityState = 'hidden';
  tick();
  assert.equal(calls.length, 2);
  document.visibilityState = 'visible';
  tick();
  assert.equal(calls.length, 3);
  resolve({ devices: [offline], slackHost: null });
  await nextTurn();
  h.render('DeviceUsage', {
    ...props,
    api: async () => {
      throw new Error('offline');
    },
  });
  tick();
  await nextTurn();
  assert.deepEqual(
    plain(findNode(h.render('DeviceUsage', props), (node) => node.type?.name === 'DeviceUsageCards')!.props.devices),
    plain([offline]),
  );
  h.unmount();
  assert.equal(cleared, true);
});

test('server cards use the device usage zoom with the full device card', async () => {
  const server = { ...hardwareDevice, tunnel: { ssh: 'fixture-box', remotePort: 4318 } };
  const h = uiHarness(await uiBundle('src/ui/DeviceUsage.tsx'));
  const props = { now: usageNow, notify() {}, api: async () => ({ devices: [server], slackHost: null }) };
  const render = () => h.render('DeviceUsage', props);
  render();
  await nextTurn();
  const remote = findNode(render(), (node) => node.type?.name === 'RemoteServers')!;
  const servers = uiHarness(await uiBundle('src/ui/RemoteServers.tsx'));
  const remoteTree = servers.render('RemoteServers', remote.props);
  const cards = findNode(remoteTree, (node) => node.type?.name === 'RemoteServerCards')!;
  const grid = findNode(
    cards.type({ ...cards.props, view: { servers: [{ name: 'box', ssh: 'fixture-box' }] } }),
    (node) => node.type?.name === 'EvenCards',
  )!;
  const card = grid.props.children[0];
  assert.equal(card.props.device, server);
  assert.equal(card.props.notify, props.notify);
  assert.equal(card.props.api, props.api);
  const from = { width: 270, height: 200 };
  grid.props.onOpen(card.props.device.id, from);
  const zoom = findNode(render(), (node) => node.type?.name === 'QuotaZoom')!;
  assert.equal(zoom.props.from, from);
  assert.equal(zoom.props.children.type.name, 'DeviceQuotaCard');
  assert.equal(zoom.props.children.props.device, server);
  assert.equal(zoom.props.children.props.compact, undefined);
  servers.unmount();
  h.unmount();
});

test('device reload waits for an in-flight poll then fetches the changed device list', async () => {
  for (const fail of [false, true]) {
    let tick!: () => void;
    let finish!: () => void;
    let calls = 0;
    const h = uiHarness(await uiBundle('src/ui/DeviceUsage.tsx'), {
      document: { visibilityState: 'visible' },
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1;
      },
    });
    const props = {
      now: usageNow,
      api: () => {
        calls++;
        if (calls === 3)
          return new Promise<DevicesView>((resolve, reject) => {
            finish = () =>
              fail ? reject(new Error('synthetic poll failure')) : resolve({ devices: [online], slackHost: null });
          });
        return Promise.resolve({ devices: calls > 3 ? [] : [online], slackHost: null });
      },
    };
    const render = () => h.render('DeviceUsage', props);
    render();
    await nextTurn();
    tick();
    const reload = findNode(render(), (node) => node.type?.name === 'RemoteServers')!.props.reload();
    assert.equal(calls, 3);
    finish();
    await reload;
    assert.equal(calls, 4);
    assert.equal(findNode(render(), (node) => node.type?.name === 'RemoteServers')!.props.devices.length, 0);
    h.unmount();
  }
});

test('device zoom follows the latest device by id, closes on removal and never reopens on reappearance', async () => {
  let tick!: () => void;
  let devices = [hardwareDevice, offline];
  const h = uiHarness(await uiBundle('src/ui/DeviceUsage.tsx'), {
    document: { visibilityState: 'visible' },
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval() {},
  });
  const props = { now: usageNow, api: async () => ({ devices, slackHost: null }) };
  const render = () => h.render('DeviceUsage', props);
  const zoom = () => findNode(render(), (node) => node.type?.name === 'QuotaZoom');
  render();
  await nextTurn();
  await nextTurn();
  const from = { width: 270, height: 200 };
  findNode(render(), (node) => node.type?.name === 'DeviceUsageCards')!.props.onOpen(hardwareDevice.id, from);
  assert.equal(zoom()!.props.from, from);
  assert.equal(zoom()!.props.children.props.device.id, hardwareDevice.id);
  devices = [{ ...hardwareDevice, name: 'Renamed', online: false, executors: [] }, offline];
  tick();
  await nextTurn();
  assert.equal(zoom()!.props.label, 'Renamed');
  assert.equal(zoom()!.props.children.props.device.online, false);
  assert.equal(zoom()!.props.children.props.device.executors.length, 0);
  zoom()!.props.onClose();
  assert.equal(zoom(), undefined);
  findNode(render(), (node) => node.type?.name === 'DeviceUsageCards')!.props.onOpen(hardwareDevice.id, from);
  devices = [offline];
  tick();
  await nextTurn();
  assert.equal(zoom(), undefined);
  devices = [hardwareDevice, offline];
  tick();
  await nextTurn();
  assert.equal(zoom(), undefined);
  h.unmount();
});

test('old-node memory percent and detail use the same inventory values in both card sizes', () => {
  const device = {
    ...hardwareDevice,
    resources: undefined,
    hardware: { ...hardwareDevice.hardware!, memoryTotal: 8 * 1024 ** 3, memoryAvailable: 1.9 * 1024 ** 3 },
  };
  for (const render of [fullCard, (device: DeviceView) => smallCards([device])]) {
    const html = render(device);
    assert.match(html, /内存<\/span><strong>76%/);
    assert.match(html, /6.1 \/ 8 GiB/);
    assert.match(html, /UHD 620/);
    const offline = render({ ...device, online: false });
    assert.match(offline, /内存<\/span><strong>—/);
    assert.match(offline, /6.1 \/ 8 GiB/);
  }
});
