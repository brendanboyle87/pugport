import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/AccountSettings.tsx');
const base = {
  configured: true,
  auth: { phase: 'signed-in', email: 'synthetic@example.test' },
  sync: 'off',
  setup: 'ready',
  devices: [],
  missingProviders: [],
};

test('account-change merge does not call backend while consent is unanswered', async () => {
  let merges = 0;
  const h = uiHarness(code, { Error });
  const props = {
    view: {
      ...base,
      setup: 'merge',
      merge: {
        local: { chats: 1, folders: 0, projects: 0, memories: 0 },
        cloud: { chats: 2, folders: 0, projects: 0, memories: 0 },
        accountChange: true,
      },
    },
    busy: false,
    state: { targets: [], runtimes: [] },
    action: async () => {
      merges++;
      return {};
    },
    notify() {},
  };
  findNode(h.render('AccountSettings', props), (n) => 'data-account-merge' in n.props)!.props.onClick();
  await nextTurn();
  assert.equal(merges, 0);
  h.unmount();
});

test('account state follows broadcasts without installing a polling timer', async () => {
  let calls = 0,
    intervals = 0;
  const h = uiHarness(code, {
    setInterval: () => {
      intervals++;
      return 1;
    },
  });
  h.exports.AccountHook = (props: any) => h.exports.useAccount(props.api, true, props.view);
  const props = {
    api: async () => {
      calls++;
      return base;
    },
    view: { ...base, setup: 'ready', sync: 'idle' },
  };
  const read = () => h.render('AccountHook', props) as any;
  assert.equal(read().view?.sync, 'idle');
  await nextTurn();
  assert.equal(intervals, 0);
  assert.equal(calls, 0);
  props.view = { ...props.view, sync: 'offline' };
  assert.equal(read().view.sync, 'offline');
  h.unmount();
});
