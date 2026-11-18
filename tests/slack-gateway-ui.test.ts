import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SlackGatewayView } from '../src/shared/slack-gateway.ts';
import type { DevicesView } from '../src/shared/devices.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('tests/helpers/confirmation-fixture.ts');

const button = (tree: unknown, label: string) => {
  const found = findNode(
    tree,
    (node) => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label),
  );
  assert.ok(found, `Missing button ${label}`);
  return found;
};
const field = (tree: unknown, label: string) => {
  const found = findNode(tree, (node) => node.type === 'label' && text(node).startsWith(label));
  assert.ok(found, `Missing field ${label}`);
  return findNode(found, (node) => node.type === 'input')!;
};
const toggle = (tree: unknown) => findNode(tree, (node) => node.props?.['aria-label'] === '连接 Slack')!;
const manifest = (tree: unknown) =>
  JSON.parse(findNode(tree, (node) => node.type === 'textarea')!.props.value as string);

const empty: SlackGatewayView = { enabled: false, status: 'off', users: [], activeTasks: 0 };
const saved: SlackGatewayView = { ...empty, appTokenHint: '…AAAA', botTokenHint: '…BBBB' };
const connected: SlackGatewayView = {
  ...saved,
  enabled: true,
  status: 'connected',
  workspace: 'Synthetic Team',
  botName: 'pugport',
};

test('first-load failures describe the read and offer retry, including unknown failures', async () => {
  for (const reason of [new Error('Synthetic offline'), undefined]) {
    const harness = uiHarness(await bundle, { Error });
    let failed = true;
    const props = {
      notify() {},
      api: async () => {
        if (failed) throw reason;
        return empty;
      },
    };
    let tree = await settle(harness, props);
    assert.match(text(tree), /读不到 Slack 设置：/);
    assert.ok(text(tree).includes(reason?.message ?? '未知原因'));
    assert.doesNotMatch(text(tree), /设置没有保存/);
    assert.equal(
      findNode(tree, (node) => node.type?.name === 'SettingsRow'),
      undefined,
    );
    failed = false;
    button(tree, '重试').props.onClick();
    await nextTurn();
    tree = harness.render('SlackGateway', props);
    assert.equal(
      findNode(tree, (node) => node.props.role === 'alert'),
      undefined,
    );
    assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsRow')!.props.defaultExpanded, undefined);
    harness.unmount();
  }
});

test('Slack dots distinguish setup and errors from intentional disconnection and another host', async () => {
  for (const [view, tone] of [
    [empty, undefined],
    [saved, undefined],
    [{ ...empty, hostedBy: 'Synthetic host' }, undefined],
    [{ ...connected, hostedBy: 'Synthetic host' }, undefined],
    [{ ...connected, status: 'connecting' }, undefined],
    [connected, undefined],
    [{ ...connected, status: 'error' }, 'danger'],
  ] as const) {
    const harness = uiHarness(await bundle);
    const tree = await settle(harness, backend(view).props);
    assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsRow')!.props.tone, tone);
    harness.unmount();
  }
});

function backend(initial: SlackGatewayView, initialDevices: DevicesView = { devices: [], slackHost: null }) {
  let view = initial;
  let devices = initialDevices;
  const writes: { path: string; body: unknown; method: string }[] = [];
  const notices: { tone: string; message: string }[] = [];
  return {
    writes,
    notices,
    set(next: SlackGatewayView) {
      view = next;
    },
    props: {
      notify: (notice: { tone: string; message: string }) => notices.push(notice),
      api: async (path: string, body: unknown, method = 'POST') => {
        if (path === '/api/devices') return devices;
        if (method === 'GET') return view;
        writes.push({ path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), method });
        if (path === '/api/devices/slack-host') {
          devices = { ...devices, slackHost: (body as { deviceId: string | null }).deviceId };
          return devices;
        }
        if (path === '/api/slack/tokens') view = saved;
        else if (path === '/api/slack') view = (body as { enabled: boolean }).enabled ? connected : saved;
        else if (path === '/api/slack/pairing') {
          view = { ...view, pairingExpiresAt: '2026-10-10T12:10:00.000Z' };
          return { code: 'K7Q2MZ', expiresAt: view.pairingExpiresAt };
        } else if (path.startsWith('/api/slack/users/')) view = { ...view, users: [] };
        return view;
      },
    },
  };
}

async function settle(harness: ReturnType<typeof uiHarness>, props: unknown) {
  harness.render('SlackGateway', props);
  await nextTurn();
  await nextTurn();
  return harness.render('SlackGateway', props);
}

function openSheet(harness: ReturnType<typeof uiHarness>, props: unknown) {
  const tree = harness.render('SlackGateway', props);
  const setup = findNode(tree, (node) => node.type === 'button' && ['开始设置', '管理'].includes(text(node)))!;
  setup.props.onClick();
  return harness.render('SlackGateway', props);
}

test('Slack sheet preserves done states, current step and mounted step panels', async () => {
  for (const [view, done, current] of [
    [empty, [false, false, false], 0],
    [{ ...empty, appTokenHint: 'synthetic' }, [false, false, false], 0],
    [saved, [true, false, false], 1],
    [{ ...saved, users: [{ id: 'synthetic', pairedAt: '2026-10-15' }] }, [true, false, true], 1],
    [connected, [true, true, false], 2],
    [{ ...connected, status: 'error', error: 'Synthetic offline' }, [true, true, false], 2],
    [{ ...connected, users: [{ id: 'synthetic', name: 'Alice', pairedAt: '2026-10-15' }] }, [true, true, true], -1],
  ] satisfies [SlackGatewayView, boolean[], number][]) {
    const harness = uiHarness(await bundle);
    const server = backend(view);
    let tree = await settle(harness, server.props);
    assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsRow')!.props.defaultExpanded, undefined);
    assert.equal(
      findNode(tree, (node) => node.type?.name === 'SideSheet'),
      undefined,
    );
    button(tree, view.appTokenHint && view.botTokenHint ? '管理' : '开始设置');
    tree = openSheet(harness, server.props);
    assert.equal(findNode(tree, (node) => node.type?.name === 'SideSheet')!.props.title, 'Slack');
    const steps = findNode(tree, (node) => node.props.className === 'slack-steps')!.props.children;
    assert.deepEqual(
      Array.from(steps, (step: any) => step.props['data-done']),
      done,
    );
    for (const [index, step] of steps.entries()) {
      assert.equal(step.props['aria-current'], index === current ? 'step' : undefined);
      const panel = step.props.children[1];
      assert.equal(panel.props.hidden, index !== current);
      assert.ok(panel.props.children, 'collapsed content stays mounted');
      if (current >= 0 && index > current) {
        assert.equal(
          findNode(step.props.children[0], (node) => node.type === 'button'),
          undefined,
        );
      }
    }
    if (current === -1) {
      button(tree, '生成配对码');
      button(tree, '移除 Alice');
      assert.match(text(tree), /已设置好/);
      button(tree, '查看步骤').props.onClick();
      tree = harness.render('SlackGateway', server.props);
      const firstPanel = () =>
        findNode(tree, (node) => node.props.className === 'slack-steps')!.props.children[0].props.children[1];
      assert.equal(firstPanel().props.hidden, false);
      assert.match(text(tree), /3 步都已完成/);
      assert.doesNotMatch(text(tree), /第 3 步，共 3 步/);
      assert.equal(button(tree, '修改：创建 Slack 应用并填入 Token').props['aria-expanded'], true);
      button(tree, '收起').props.onClick();
      tree = harness.render('SlackGateway', server.props);
      assert.equal(firstPanel().props.hidden, true);
      assert.match(text(tree), /已设置好/);
    }
    if (current === 1) {
      button(tree, '连接').props.onClick();
      await nextTurn();
      assert.deepEqual(server.writes.at(-1), { path: '/api/slack', body: { enabled: true }, method: 'PATCH' });
    }
    harness.unmount();
  }
});

test('Slack hosted elsewhere has a status line and no setup guide', async () => {
  const harness = uiHarness(await bundle);
  const server = backend({ ...empty, hostedBy: 'Synthetic Mac' });
  await settle(harness, server.props);
  const tree = openSheet(harness, server.props);
  assert.match(text(tree), /由「Synthetic Mac」运行/);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'slack-guide'),
    undefined,
  );
  harness.unmount();
});

test('first visit keeps setup in a sheet with three steps and manifest copy; connecting waits for both tokens', async () => {
  let copied = '';
  const harness = uiHarness(await bundle, {
    navigator: {
      language: 'zh-CN',
      languages: ['zh-CN'],
      clipboard: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    },
  });
  const server = backend(empty);
  let tree = await settle(harness, server.props);
  assert.equal(toggle(tree), undefined);
  assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsRow')!.props.children, undefined);
  assert.equal(
    findNode(tree, (node) => node.type === 'textarea'),
    undefined,
  );
  tree = openSheet(harness, server.props);
  assert.match(text(tree), /填好下面两个 Token 后就能连接/);
  assert.equal(findNode(tree, (node) => node.props.className === 'slack-steps')!.props.children.length, 3);
  assert.equal(findNode(tree, (node) => node.type === 'textarea')!.props.rows, 8);
  const basic = manifest(tree);
  button(tree, '复制 manifest').props.onClick();
  await nextTurn();
  assert.deepEqual(JSON.parse(copied), basic);
  assert.equal(basic.settings.socket_mode_enabled, true);
  assert.deepEqual(basic.settings.event_subscriptions.bot_events, [
    'app_mention',
    'message.im',
    'message.channels',
    'message.groups',
  ]);
  assert.match(text(tree), /Display Information 上传/);

  const assistant = findNode(
    tree,
    (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props['aria-label'],
  )!;
  assistant.props.onChange({ target: { checked: true } });
  tree = harness.render('SlackGateway', server.props);
  assert.ok(manifest(tree).oauth_config.scopes.bot.includes('assistant:write'));

  assert.equal(button(tree, '保存').props.disabled, true);
  field(tree, 'App-Level Token').props.onChange({ target: { value: ' xapp-1-synthetic ' } });
  tree = harness.render('SlackGateway', server.props);
  field(tree, 'Bot Token').props.onChange({ target: { value: 'xoxb-synthetic' } });
  tree = harness.render('SlackGateway', server.props);
  assert.equal(field(tree, 'Bot Token').props.type, 'password');
  findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  tree = await settle(harness, server.props);
  assert.deepEqual(server.writes, [
    { path: '/api/slack/tokens', body: { appToken: 'xapp-1-synthetic', botToken: 'xoxb-synthetic' }, method: 'PUT' },
  ]);
  assert.equal(field(tree, 'App-Level Token').props.value, '', 'typed tokens are cleared after saving');
  assert.equal(field(tree, 'App-Level Token').props.placeholder, '已保存 …AAAA，留空保留');
  assert.equal(field(tree, 'Bot Token').props.placeholder, '已保存 …BBBB，留空保留');
  assert.match(text(tree), /未连接/);
  assert.equal(toggle(tree).props.disabled, false);
  assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsRow')!.props.defaultExpanded, undefined);
  findNode(tree, (node) => node.type?.name === 'SideSheet')!.props.onClose();
  assert.equal(
    findNode(harness.render('SlackGateway', server.props), (node) => node.type === 'textarea'),
    undefined,
  );
  harness.unmount();
});

test('connecting, pairing code and removing a paired person', async () => {
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let intervalId = 0;
  const harness = uiHarness(await bundle, {
    setInterval: (callback: () => void, ms: number) => {
      intervals.set(++intervalId, { callback, ms });
      return intervalId;
    },
    clearInterval: (id: number) => intervals.delete(id),
  });
  const server = backend(saved);
  let tree = await settle(harness, server.props);
  tree = openSheet(harness, server.props);
  toggle(tree).props.onChange({ target: { checked: true } });
  await nextTurn();
  tree = await settle(harness, server.props);
  assert.deepEqual(server.writes.at(-1), { path: '/api/slack', body: { enabled: true }, method: 'PATCH' });
  assert.match(text(tree), /已连接（Synthetic Team）/);
  assert.match(text(tree), /还没有人配对/);

  button(tree, '生成配对码').props.onClick();
  await nextTurn();
  tree = await settle(harness, server.props);
  assert.match(text(tree), /K7Q2MZ/);
  assert.match(text(tree), /pair K7Q2MZ/);
  assert.match(text(tree), /10 分钟内有效，只能用一次/);
  button(tree, '换一个配对码');

  // The code was used: the person appears and the code goes away.
  server.set({
    ...connected,
    users: [{ id: 'UALICE', name: 'Alice', pairedAt: '2026-10-10T12:01:00Z' }],
  });
  // React preserves load's identity across renders. The server change reaches the UI on its polling interval.
  assert.equal(intervals.size, 1);
  const [poll] = [...intervals.values()];
  assert.equal(poll!.ms, 4000);
  poll!.callback();
  tree = await settle(harness, server.props);
  assert.doesNotMatch(text(tree), /K7Q2MZ/);
  button(tree, '生成配对码');
  assert.match(text(tree), /Alice/);
  button(tree, '移除 Alice').props.onClick();
  const store = harness.exports.confirmationStore;
  assert.equal(store.snapshot().options.tone, 'danger');
  assert.equal(
    server.writes.some((write) => write.method === 'DELETE'),
    false,
  );
  store.resolve(store.snapshot().id, false);
  await nextTurn();
  tree = await settle(harness, server.props);
  assert.match(text(tree), /Alice/);
  button(tree, '移除 Alice').props.onClick();
  store.resolve(store.snapshot().id, true);
  await nextTurn();
  tree = await settle(harness, server.props);
  assert.deepEqual(server.writes.at(-1), { path: '/api/slack/users/UALICE', body: undefined, method: 'DELETE' });
  assert.doesNotMatch(text(tree), /Alice/);
  harness.unmount();
  assert.equal(intervals.size, 0, 'unmount stops polling');
});

test('connection errors are shown in plain words and failed saves are reported', async () => {
  const harness = uiHarness(await bundle, { Error });
  const server = backend({ ...connected, status: 'error', error: 'Bot Token 无效或已撤销' });
  let tree = await settle(harness, server.props);
  tree = openSheet(harness, server.props);
  assert.match(text(tree), /出错：Bot Token 无效或已撤销/);
  const failing = {
    ...server.props,
    api: async (path: string, body: unknown, method?: string) => {
      if (method === 'PUT') throw new Error('Bot Token 应以 xoxb- 开头，请重新复制。');
      return server.props.api(path, body, method);
    },
  };
  tree = harness.render('SlackGateway', failing);
  field(tree, 'Bot Token').props.onChange({ target: { value: 'not-a-token' } });
  tree = harness.render('SlackGateway', failing);
  findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  await nextTurn();
  // Notices are built inside the component's sandbox, so compare plain copies.
  assert.deepEqual(JSON.parse(JSON.stringify(server.notices)), [
    { tone: 'error', message: 'Bot Token 应以 xoxb- 开头，请重新复制。' },
  ]);
  harness.unmount();
});

test('Slack host selector only appears inside the sheet when devices exist and saves either host', async () => {
  for (const hasDevices of [false, true]) {
    const harness = uiHarness(await bundle);
    const device = {
      id: 'synthetic-host',
      name: 'Synthetic host',
      address: 'synthetic.invalid',
      pairedAt: '2026-10-28',
    };
    const server = backend(empty, { devices: hasDevices ? [device] : [], slackHost: null });
    let tree = await settle(harness, server.props);
    const selector = (tree: unknown) =>
      findNode(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'Slack 由哪台运行');
    assert.equal(selector(tree), undefined);
    openSheet(harness, server.props);
    tree = await settle(harness, server.props);
    assert.equal(!!selector(tree), hasDevices);
    if (hasDevices) {
      const sheet = findNode(tree, (node) => node.type?.name === 'SideSheet')!;
      assert.ok(selector(sheet));
      for (const value of [device.id, '']) {
        selector(tree)!.props.onChange({ target: { value } });
        tree = await settle(harness, server.props);
        assert.deepEqual(server.writes.at(-1), {
          path: '/api/devices/slack-host',
          body: { deviceId: value || null },
          method: 'PUT',
        });
        assert.equal(selector(tree)!.props.value, value);
      }
    }
    harness.unmount();
  }
});
