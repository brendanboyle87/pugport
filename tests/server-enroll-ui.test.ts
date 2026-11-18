import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceView } from '../src/shared/devices.ts';
import { RemoteServerCard } from '../src/ui/RemoteServers.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const server = { name: 'box', ssh: 'fixture-box', purpose: 'Synthetic purpose' };
const device = {
  id: 'fixture-id',
  name: 'box',
  address: '127.0.0.1',
  pairedAt: '',
  tunnel: { ssh: 'fixture-box', remotePort: 4318 },
  executors: [],
};

test('enrollment shows purpose, stages, command, copy and retry with synthetic responses', async () => {
  const code = await uiBundle('src/ui/ServerEnroll.tsx');
  const copied: string[] = [];
  let attempts = 0;
  const checks: unknown[] = [];
  const api = async (path: string, _body?: unknown, method?: string) => {
    if (path === '/api/remote-servers/enrollments') {
      attempts++;
      return {
        enrollment:
          attempts === 1
            ? { id: 'job', status: 'needs-command', stage: 'preflight', log: 'fake failure', command: 'sudo fixture' }
            : { id: 'job2', status: 'completed', stage: 'done', log: '', device },
      };
    }
    if (path === '/api/devices/fixture-id/check') {
      checks.push(method);
      return { device: { ...device, executors: [{ label: 'Fixture CLI', status: 'ready' }] } };
    }
    throw new Error('Unexpected request: ' + path);
  };
  const h = uiHarness(code, {
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
  });
  let closed: unknown;
  const props = {
    api,
    server,
    onClose: (value: unknown) => {
      closed = value;
    },
  };
  const render = () => h.render('ServerEnroll', props);
  const button = (label: string) => findNode(render(), (node) => node.type === 'button' && text(node) === label)!;
  assert.match(text(render()), /Synthetic purpose/);
  button('接入').props.onClick();
  await nextTurn();
  assert.match(text(render()), /sudo fixture/);
  assert.match(text(render()), /检查服务器/);
  button('复制').props.onClick();
  await nextTurn();
  assert.deepEqual(copied, ['sudo fixture']);
  button('重新检查').props.onClick();
  await nextTurn();
  assert.match(text(render()), /已接入，但它上面还没登录任何 CLI/);
  assert.match(text(render()), /ssh fixture-box/);
  button('重新检查').props.onClick();
  await nextTurn();
  assert.match(text(render()), /Fixture CLI/);
  assert.deepEqual(checks, ['POST']);
  button('关闭').props.onClick();
  assert.equal((closed as typeof device).id, device.id);
  h.unmount();
});

test('usage entry opens card and disconnect confirms purge then offers retry', async () => {
  const code = await uiBundle('src/ui/RemoteServers.tsx');
  const calls: any[] = [];
  let uninstalls = 0;
  const api = async (path: string, body?: unknown) => {
    if (path.startsWith('/api/remote-servers?') || path === '/api/remote-servers') return { servers: [server] };
    if (path === '/api/remote-servers/disconnect') {
      calls.push(body);
      uninstalls++;
      return { devices: [], ...(uninstalls === 1 ? { note: 'synthetic uninstall failure' } : {}) };
    }
    throw new Error('Unexpected request: ' + path);
  };
  const h = uiHarness(code);
  let reloads = 0;
  const props = {
    api,
    now: 0,
    devices: [device],
    onOpen() {},
    reload: async () => {
      reloads++;
    },
  };
  const render = () => h.render('RemoteServers', props);
  render();
  await nextTurn();
  let cards = findNode(render(), (node) => node.type?.name === 'RemoteServerCards')!;
  cards.props.onConnect(server);
  assert.ok(findNode(render(), (node) => node.type?.name === 'ServerEnroll'));
  findNode(render(), (node) => node.type?.name === 'ServerEnroll')!.props.onClose();
  await nextTurn();
  assert.equal(reloads, 1);
  cards = findNode(render(), (node) => node.type?.name === 'RemoteServerCards')!;
  cards.props.onDisconnect(server);
  let confirm = findNode(render(), (node) => node.type?.name === 'ConfirmDialog')!;
  const checkbox = findNode(confirm, (node) => node.type === 'input' && node.props.type === 'checkbox')!;
  checkbox.props.onChange({ currentTarget: { checked: true } });
  confirm = findNode(render(), (node) => node.type?.name === 'ConfirmDialog')!;
  confirm.props.onAnswer(true);
  await nextTurn();
  cards = findNode(render(), (node) => node.type?.name === 'RemoteServerCards')!;
  assert.equal(cards.props.retry.box.message, 'synthetic uninstall failure');
  cards.props.onRetry(server);
  await nextTurn();
  assert.equal(reloads, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { name: 'box', purge: true },
    { name: 'box', purge: true },
  ]);
  assert.equal(findNode(render(), (node) => node.type?.name === 'RemoteServerCards')!.props.retry.box, undefined);
  h.unmount();
});

test('installed executors report their actual status rather than claiming none are logged in', async () => {
  const code = await uiBundle('src/ui/ServerEnroll.tsx');
  for (const executors of [
    [{ label: 'Fixture CLI', status: 'unavailable' }],
    [{ label: 'Fixture CLI', status: 'auth-required' }],
    [
      { label: 'Fixture CLI', status: 'ready' },
      { label: 'Other CLI', status: 'limited' },
    ],
  ]) {
    const api = async () => ({
      enrollment: { id: 'job', status: 'completed', stage: 'done', log: '', device: { ...device, executors } },
    });
    const h = uiHarness(code);
    const props = { api, server: { ...server, name: 'CI Runner' }, onClose() {} };
    const render = () => h.render('ServerEnroll', props);
    const button = findNode(render(), (node) => node.type === 'button' && text(node) === '\u63a5\u5165')!;
    button.props.onClick();
    await nextTurn();
    const output = text(render());
    assert.match(output, /CI Runner/);
    for (const executor of executors) {
      assert.ok(output.includes(executor.label));
      if (executor.status !== 'ready')
        assert.ok(
          output.includes(
            executor.status === 'auth-required' ? '\u8981\u5148\u767b\u5f55' : '\u6682\u4e0d\u53ef\u7528',
          ),
        );
    }
    assert.ok(
      !output.includes('\u5df2\u63a5\u5165\uff0c\u4f46\u5b83\u4e0a\u9762\u8fd8\u6ca1\u767b\u5f55\u4efb\u4f55 CLI'),
    );
    h.unmount();
  }
});

test('failure displays only the final twelve log lines', async () => {
  const code = await uiBundle('src/ui/ServerEnroll.tsx');
  const log = Array.from({ length: 16 }, (_, index) => `synthetic line ${index + 1}`).join('\n');
  const api = async () => ({ enrollment: { id: 'job', status: 'failed', stage: 'runtime', log } });
  const h = uiHarness(code);
  const props = { api, server, onClose() {} };
  const render = () => h.render('ServerEnroll', props);
  findNode(render(), (node) => node.type === 'button' && text(node) === '\u63a5\u5165')!.props.onClick();
  await nextTurn();
  const output = text(findNode(render(), (node) => node.type === 'pre'));
  assert.deepEqual(output.split('\n'), log.split('\n').slice(-12));
  h.unmount();
});

test('connected server cards show device status and quota; only connected cards expose details', () => {
  const connected: DeviceView = {
    ...device,
    online: true,
    running: 0,
    version: '0.0.fixture',
    arch: 'x64',
    hardware: {
      os: 'Fixture Linux',
      cpu: 'Fixture CPU',
      gpu: 'Fixture GPU',
      diskTotal: 100 * 1024 ** 3,
      diskFree: 60 * 1024 ** 3,
      readAt: '',
    },
    executors: [
      {
        label: 'Codex',
        provider: 'codex',
        status: 'ready',
        tightest: 72,
        windows: [{ name: 'Weekly', remaining: 72 }],
      },
    ],
  };
  const markup = (value?: DeviceView) =>
    renderToStaticMarkup(
      createElement(RemoteServerCard, {
        api: async () => {
          throw new Error('Unexpected API request');
        },
        notify() {},
        server,
        now: 0,
        device: value,
        onConnect() {},
      }),
    );
  const html = markup(connected);
  assert.match(html, /已接入 · <span class="device-status online">在线<\/span>/);
  assert.match(html, /device-quota-chip [^"]+"><span translate="no">Codex<\/span> 72%/);
  assert.match(html, /data-runtime-id="fixture-id" tabindex="0" aria-label="box 详情"/);
  assert.doesNotMatch(html, /本机|device-account|Fixture GPU/);
  assert.match(
    markup({ ...connected, online: false, reason: '未连接（发任务时会自动连）' }),
    /已接入 · <span class="device-status ">未连接（发任务时会自动连）<\/span>/,
  );
  assert.match(markup({ ...connected, online: false }), /已接入 · <span class="device-status ">离线<\/span>/);
  assert.doesNotMatch(html, /role="button"|aria-haspopup/);
  assert.ok(html.indexOf('remote-server-live') < html.indexOf('device-quota-heading'));
  assert.match(markup({ ...connected, executors: [] }), /这台设备还没有账号/);
  const unconnected = markup();
  assert.match(unconnected, />接入<\/button>/);
  assert.doesNotMatch(unconnected, /data-runtime-id|role="button"|已接入/);
});

test('disconnect button is disabled while a disconnect is pending', async () => {
  const code = await uiBundle('src/ui/RemoteServers.tsx');
  const h = uiHarness(code);
  const tree = h.render('RemoteServerCard', {
    server,
    now: 0,
    device,
    onConnect() {},
    onDisconnect() {},
    disconnecting: true,
  });
  const button = findNode(tree, (node) => node.type === 'button' && text(node) === '\u65ad\u5f00');
  assert.equal(button?.props.disabled, true);
  h.unmount();
});

test('server file button follows device availability and sends through the shared flow with notices', async () => {
  const code = await uiBundle('src/ui/RemoteServers.tsx');
  const calls: unknown[] = [];
  const notices: any[] = [];
  let picked = ['C:/synthetic/notes.txt'];
  let finish!: (value: unknown) => void;
  let fail = false;
  const bridge: any = { pickDirectory: async () => null, pickFiles: async () => picked };
  const h = uiHarness(code, { Error, window: { comboRunnerDesktop: bridge } });
  const props = {
    api: async (path: string, body: unknown) => {
      calls.push({ path, body });
      if (fail) throw new Error('Synthetic transfer failed');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    notify: (notice: unknown) => notices.push(notice),
    server,
    now: 0,
    device: { ...device, name: 'Different device name', online: true },
    onConnect() {},
  };
  const render = (extra = {}) => h.render('RemoteServerCard', { ...props, ...extra });
  const send = (tree = render()) =>
    findNode(tree, (node) => node.type === 'button' && node.props['aria-label'] === '发送文件…');
  for (const value of [undefined, { ...device, online: false }, device])
    assert.equal(send(render({ device: value })), undefined);
  assert.equal(send()!.props.title, '发送文件…');
  assert.equal(send()!.props.className, 'icon-button tiny');
  assert.equal(text(send()), '');
  assert.equal(send()!.props.disabled, false);
  assert.equal(send(render({ disconnecting: true }))!.props.disabled, true);
  send()!.props.onClick();
  await nextTurn();
  assert.equal(send()!.props.disabled, true);
  assert.ok(findNode(send(), (node) => node.props.className === 'spinning'));
  assert.equal(findNode(render(), (node) => node.type === 'button' && text(node) === '断开')!.props.disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { path: '/api/devices/fixture-id/files', body: { paths: picked } },
  ]);
  finish({ files: [{ path: '/synthetic/saved/notes.txt' }, { path: '/synthetic/saved/copy.txt' }] });
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(notices)), [
    {
      tone: 'success',
      message: '已保存到「{0}」：{1}',
      names: ['box', '/synthetic/saved/notes.txt\n/synthetic/saved/copy.txt'],
    },
  ]);
  assert.equal(send()!.props.disabled, false);
  picked = [];
  send()!.props.onClick();
  await nextTurn();
  assert.equal(calls.length, 1);
  assert.equal(notices.length, 1);
  picked = ['C:/synthetic/retry.txt'];
  fail = true;
  send()!.props.onClick();
  await nextTurn();
  assert.equal(notices.at(-1).tone, 'error');
  assert.equal(notices.at(-1).message, 'Synthetic transfer failed');
  assert.equal(send()!.props.disabled, false);
  delete bridge.pickFiles;
  assert.equal(send()!.props.disabled, true);
  assert.equal(send()!.props.title, '请在桌面应用中选择要发送的文件。');
  h.unmount();
});

test('automatic enrollment progress, failure and opt-out are visible on server cards', () => {
  const markup = (enrollment: any, enrollmentDisabled = false) =>
    renderToStaticMarkup(
      createElement(RemoteServerCard, {
        api: async () => {
          throw new Error('Unexpected request');
        },
        notify() {},
        now: 0,
        server: { ...server, enrollmentDisabled },
        enrollment,
      }),
    );
  assert.match(markup({ id: 'auto', status: 'running', stage: 'service', log: '' }), /启动服务/);
  assert.match(
    markup({ id: 'auto', status: 'failed', stage: 'service', log: 'old line\nsynthetic failure' }),
    /synthetic failure/,
  );
  const optedOut = markup({ id: 'auto', status: 'failed', stage: 'service', log: 'stale failure' }, true);
  assert.match(optedOut, /已断开，不会自动接入/);
  assert.doesNotMatch(optedOut, /stale failure/);
});

test('background enrollment progress is fetched without starting enrollment', async () => {
  const code = await uiBundle('src/ui/RemoteServers.tsx');
  const calls: string[] = [];
  const api = async (path: string, _body?: unknown, method?: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/api/remote-servers/enrollments')
      return { enrollments: [{ id: 'auto', server: 'box', status: 'running', stage: 'service', log: '' }] };
    return { servers: [server] };
  };
  const h = uiHarness(code);
  const props = { api, notify() {}, now: 0, devices: [], reload: async () => {}, onOpen() {} };
  h.render('RemoteServers', props);
  await nextTurn();
  const cards = findNode(h.render('RemoteServers', props), (node) => node.type?.name === 'RemoteServerCards')!;
  assert.equal(cards.props.enrollments[0].id, 'auto');
  assert.ok(calls.includes('GET /api/remote-servers/enrollments'));
  assert.ok(calls.every((call) => call.startsWith('GET ')));
  h.unmount();
});

test('closing manual enrollment refreshes the synced opt-out shown on the card', async () => {
  const code = await uiBundle('src/ui/RemoteServers.tsx');
  let enrollmentDisabled = true;
  const api = async (path: string) =>
    path === '/api/remote-servers/enrollments' ? { enrollments: [] } : { servers: [{ ...server, enrollmentDisabled }] };
  const h = uiHarness(code);
  const props = { api, notify() {}, now: 0, devices: [], reload: async () => {}, onOpen() {} };
  const render = () => h.render('RemoteServers', props);
  render();
  await nextTurn();
  const cards = () => findNode(render(), (node) => node.type?.name === 'RemoteServerCards')!;
  assert.equal(cards().props.view.servers[0].enrollmentDisabled, true);
  cards().props.onConnect(server);
  enrollmentDisabled = false;
  findNode(render(), (node) => node.type?.name === 'ServerEnroll')!.props.onClose();
  await nextTurn();
  assert.equal(cards().props.view.servers[0].enrollmentDisabled, false);
  h.unmount();
});
