import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
const bundle = uiBundle('src/ui/ChannelAdmissionSettings.tsx');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const find = (tree: unknown, label: string) => {
  const node = findNode(tree, (item) => item.props['aria-label'] === label);
  assert.ok(node, label);
  return node;
};
test('renders defaults, saves a sender class, resets, removes sender override and tolerates absent digest backend', async () => {
  const harness = uiHarness(await bundle);
  let stored = { version: 1, rules: [{ source: 'slack', scope: 'channel-mention', senderId: 'U1', level: 'L2' }] };
  const calls: unknown[] = [];
  const notices: unknown[] = [];
  const props = {
    source: 'slack',
    endpoint: '/api/slack/admission',
    scopes: harness.exports.slackAdmissionScopes,
    notify: (notice: unknown) => notices.push(notice),
    api: async (path: string, body: any, method: string) => {
      if (path.includes('digest')) throw Error('404');
      if (method === 'PUT') {
        calls.push(plain(body));
        stored = plain(body);
      }
      return stored;
    },
  };
  const render = () => harness.render('ChannelAdmissionSettings', props);
  render();
  await nextTurn();
  let tree = render();
  assert.match(text(tree), /谁能让 PugPort 做事/);
  assert.equal(find(tree, 'Slack 私信 · 我').props.value, 'L1');
  assert.equal(find(tree, 'Slack 私信 · 其他人').props.disabled, true);
  assert.equal(find(tree, '每日摘要时间').props.disabled, true);
  assert.match(text(tree), /暂不可用/);
  find(tree, 'Slack 频道 @PugPort · 配对的人').props.onChange({ target: { value: 'L3' } });
  await nextTurn();
  tree = render();
  assert.deepEqual((calls[0] as any).rules[1], {
    source: 'slack',
    scope: 'channel-mention',
    senderClass: 'trusted',
    level: 'L3',
  });
  assert.equal(find(tree, 'Slack 频道 @PugPort · 配对的人').props.value, 'L3');
  findNode(tree, (node) => node.type === 'button' && text(node) === '恢复默认')!.props.onClick();
  await nextTurn();
  tree = render();
  assert.equal(find(tree, 'Slack 频道 @PugPort · 配对的人').props.value, 'L2');
  find(tree, '移除 U1 的覆盖').props.onClick();
  await nextTurn();
  tree = render();
  assert.doesNotMatch(text(tree), /按发送者的覆盖/);
  assert.deepEqual(stored.rules, []);
  assert.deepEqual(notices, []);
  harness.unmount();
});
test('digest controls PUT the configured time and destination', async () => {
  const harness = uiHarness(await bundle);
  let digest = { time: '09:00', destination: 'pugport-slack' };
  const calls: unknown[] = [];
  const props = {
    source: 'slack',
    endpoint: '/api/slack/admission',
    scopes: harness.exports.slackAdmissionScopes,
    notify() {},
    api: async (path: string, body: any, method: string) => {
      if (path.includes('digest')) {
        assert.equal(path, '/api/external-digest/settings');
        if (method === 'PUT') {
          calls.push(plain(body));
          digest = plain(body);
        }
        return digest;
      }
      return { version: 1, rules: [] };
    },
  };
  const render = () => harness.render('ChannelAdmissionSettings', props);
  render();
  await nextTurn();
  let tree = render();
  find(tree, '每日摘要时间').props.onChange({ target: { value: '11:30' } });
  await nextTurn();
  tree = render();
  find(tree, '摘要目的地').props.onChange({ target: { value: 'pugport' } });
  await nextTurn();
  render();
  assert.deepEqual(calls, [
    { time: '11:30', destination: 'pugport-slack' },
    { time: '11:30', destination: 'pugport' },
  ]);
  harness.unmount();
});
test('resetting one class preserves older scope preferences for the other classes', async () => {
  const harness = uiHarness(await bundle);
  let stored: any = { version: 1, rules: [{ source: 'slack', scope: 'channel-mention', level: 'L4' }] };
  const props = {
    source: 'slack',
    endpoint: '/api/slack/admission',
    scopes: harness.exports.slackAdmissionScopes,
    notify() {},
    api: async (path: string, body: any, method: string) => {
      if (path.includes('digest')) throw Error('404');
      if (method === 'PUT') stored = plain(body);
      return stored;
    },
  };
  const render = () => harness.render('ChannelAdmissionSettings', props);
  render();
  await nextTurn();
  let tree = render();
  const row = findNode(
    tree,
    (node) =>
      node.props.className === 'channel-admission-row' &&
      !!findNode(node, (child) => child.props['aria-label'] === 'Slack 频道 @PugPort · 我'),
  )!;
  findNode(row, (node) => node.type === 'button')!.props.onClick();
  await nextTurn();
  tree = render();
  assert.equal(find(tree, 'Slack 频道 @PugPort · 我').props.value, 'L1');
  assert.equal(find(tree, 'Slack 频道 @PugPort · 配对的人').props.value, 'L4');
  assert.equal(find(tree, 'Slack 频道 @PugPort · 其他人').props.value, 'L4');
  harness.unmount();
});
test('paired owner marker uses the owner API and renders the returned unique owner', async () => {
  const harness = uiHarness(await uiBundle('src/ui/SlackGateway.tsx'));
  let view = {
    enabled: true,
    appTokenHint: 'synthetic',
    botTokenHint: 'synthetic',
    status: 'connected',
    activeTasks: 0,
    users: [
      { id: 'A', name: 'Alice', pairedAt: '2026-01-01', isOwner: true },
      { id: 'B', name: 'Bob', pairedAt: '2026-01-01', isOwner: false },
    ],
  };
  const calls: any[] = [];
  const props = {
    notify() {},
    api: async (path: string, body: any, method: string) => {
      if (path === '/api/devices') return { devices: [] };
      if (method === 'PATCH') {
        calls.push({ path, body: plain(body) });
        view = { ...view, users: view.users.map((user) => ({ ...user, isOwner: user.id === 'B' })) };
      }
      return view;
    },
  };
  const render = () => harness.render('SlackGateway', props);
  render();
  await nextTurn();
  let tree = render();
  findNode(tree, (node) => node.type === 'button' && text(node) === '管理')!.props.onClick();
  tree = render();
  assert.equal(find(tree, '这是我：Alice').props.checked, true);
  find(tree, '这是我：Bob').props.onChange({ target: { checked: true } });
  await nextTurn();
  tree = render();
  assert.equal(find(tree, '这是我：Alice').props.checked, false);
  assert.equal(find(tree, '这是我：Bob').props.checked, true);
  assert.deepEqual(calls, [{ path: '/api/slack/users/B', body: { isOwner: true } }]);
  harness.unmount();
});
