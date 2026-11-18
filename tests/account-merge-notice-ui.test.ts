import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AccountView } from '../src/shared/account-ui.ts';
import { findNode, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const signedIn: AccountView = {
  configured: true,
  auth: { phase: 'signed-in', email: 'synthetic.person@example.test' },
  sync: 'off',
  setup: 'loading',
  sessionId: 'synthetic-session',
  devices: [],
  missingProviders: [],
};
const zero = { chats: 0, folders: 0, projects: 0, memories: 0 };
const waiting = (accountChange = false): AccountView => ({
  ...signedIn,
  setup: 'merge',
  merge: { local: { ...zero, chats: 2 }, cloud: { ...zero, chats: 5 }, accountChange },
});
function stateFixture(account: AccountView) {
  return {
    app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [],
    conversations: [],
    conversationMessages: [],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    settings: { maxQuotaAgeSeconds: 120, reservePercent: 10, refreshSeconds: 60 },
    account,
  };
}
let studioCode: string;
before(async () => {
  studioCode = await uiBundle('src/ui/Studio.tsx', true);
});
function studio(account: AccountView) {
  const backend = {
    state: stateFixture(account),
    api: async () => ({}),
    reload: async () => {},
    connection: 'connected',
  };
  const harness = uiHarness(studioCode, { __backend: backend });
  return {
    harness,
    render(next?: AccountView) {
      if (next) backend.state = { ...backend.state, account: next };
      return harness.render('default');
    },
  };
}
const named = (name: string) => (node: UiNode) => typeof node.type === 'function' && node.type.name === name;
const toast = (tree: unknown) => findNode(tree, named('NoticeToast'));

test('a merge that needs confirmation shows one main-window notice that opens the merge section', () => {
  const app = studio(signedIn);
  let tree = app.render();
  assert.equal(toast(tree), undefined);
  tree = app.render(waiting());
  const notice = toast(tree);
  assert.ok(notice, 'The notice appears right after sign-in, outside Settings');
  assert.equal(notice.props.notice.tone, 'info');
  assert.equal(notice.props.notice.message, '同步正在等待你确认合并这台电脑的数据。');
  assert.equal(notice.props.notice.action.label, '查看');
  const pill = findNode(tree, named('AccountSyncPill'));
  assert.ok(pill);
  pill.props.onOpen();
  tree = app.render();
  let shell = findNode(tree, named('SettingsShell'));
  assert.equal(shell?.props.category, 'account');
  assert.equal(shell?.props.target?.id, 'account-merge', 'The sidebar status lands on the merge section');

  // Closing and then following the notice lands on the merge section as well.
  notice.props.onClose();
  notice.props.notice.action.run();
  tree = app.render();
  shell = findNode(tree, named('SettingsShell'));
  assert.equal(shell?.props.target?.id, 'account-merge');
  assert.equal(toast(tree), undefined);
  // A later broadcast of the same session does not repeat it.
  tree = app.render(waiting());
  assert.equal(toast(tree), undefined);
  app.harness.unmount();
});

test('the account-change notice reuses the consent text and clears once the merge is confirmed', () => {
  const app = studio(signedIn);
  app.render();
  let tree = app.render(waiting(true));
  assert.equal(toast(tree)?.props.notice.message, '这台电脑曾同步到另一个账号。请确认是否合并本地数据。');
  tree = app.render({ ...signedIn, setup: 'ready', sync: 'syncing' });
  assert.equal(toast(tree), undefined, 'A confirmed merge removes the waiting notice');
  app.harness.unmount();
});

test('an automatic first sync shows no merge notice', () => {
  const app = studio(signedIn);
  app.render();
  const tree = app.render({ ...signedIn, setup: 'ready', sync: 'syncing' });
  assert.equal(toast(tree), undefined);
  app.harness.unmount();
});
