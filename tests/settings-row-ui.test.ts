import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const rowCode = await uiBundle('src/ui/SettingsRow.tsx');
const slackCode = await uiBundle('src/ui/SlackGateway.tsx');

test('only the expand button toggles details; hidden content stays mounted and setup is decided once', () => {
  const h = uiHarness(rowCode);
  const props = {
    title: 'Synthetic',
    defaultExpanded: true,
    children: { type: 'button', props: { children: '移除' } },
  };
  const render = () => h.render('SettingsRow', props);
  const expand = () => findNode(render(), (node) => node.type === 'button' && 'aria-expanded' in node.props)!;
  const details = () => findNode(render(), (node) => node.props.className === 'settings-row-details')!;
  assert.equal(expand().props['aria-expanded'], true);
  assert.equal(details().props.hidden, false);
  assert.equal(render().props.onClick, undefined);
  expand().props.onClick();
  props.defaultExpanded = false;
  assert.equal(expand().props['aria-expanded'], false);
  assert.equal(details().props.hidden, true);
  assert.ok(findNode(details(), (node) => node.type === 'button' && node.props.children === '移除'));
  assert.equal(expand().props['aria-controls'], details().props.id);
  props.defaultExpanded = true;
  assert.equal(expand().props['aria-expanded'], false, 'a status change must not reopen the row');
  expand().props.onClick();
  assert.equal(details().props.hidden, false);
  props.defaultExpanded = false;
  assert.equal(expand().props['aria-expanded'], true, 'a status change must not close the row');
  h.unmount();
});

test('Slack stays one row before and after polling, with setup only in the sheet', async () => {
  let resolve!: (value: unknown) => void;
  let view: unknown;
  let poll!: () => void;
  const first = new Promise((done) => (resolve = done));
  const props = { api: () => (view ? Promise.resolve(view) : first), notify() {} };
  const h = uiHarness(slackCode, {
    setInterval: (callback: () => void) => {
      poll = callback;
      return 1;
    },
  });
  assert.equal(
    findNode(h.render('SlackGateway', props), (node) => node.type?.name === 'SettingsRow'),
    undefined,
  );
  resolve({ enabled: false, status: 'off', users: [], activeTasks: 0 });
  await nextTurn();
  let row = findNode(h.render('SlackGateway', props), (node) => node.type?.name === 'SettingsRow')!;
  assert.equal(row.props.defaultExpanded, undefined);
  const mounted = uiHarness(rowCode);
  let tree = mounted.render('SettingsRow', row.props);
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && 'aria-expanded' in node.props),
    undefined,
  );
  assert.equal(
    findNode(h.render('SlackGateway', props), (node) => node.type?.name === 'SideSheet'),
    undefined,
  );
  // A later server poll changes setup status without changing the row's identity.
  view = {
    enabled: true,
    status: 'connected',
    appTokenHint: 'fixture',
    botTokenHint: 'fixture',
    users: [],
    activeTasks: 0,
  };
  poll();
  await nextTurn();
  row = findNode(h.render('SlackGateway', props), (node) => node.type?.name === 'SettingsRow')!;
  assert.equal(row.props.defaultExpanded, undefined, 'connected but unpaired never expands the row');
  assert.equal(row.props.status, undefined);
  tree = mounted.render('SettingsRow', row.props);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'settings-row-details'),
    undefined,
  );
  mounted.unmount();
  h.unmount();
});
