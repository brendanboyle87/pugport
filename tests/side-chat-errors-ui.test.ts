import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState, Conversation } from '../src/shared/types.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import type { SideChatLaunch } from '../src/ui/side-chat.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const launch: SideChatLaunch = {
  requestId: 'fixture-errors',
  parentConversationId: 'main',
  selection: { executionPolicy: 'cli-first' },
};
const conversation: Conversation = {
  id: 'side',
  projectId: 'fixture-project',
  title: 'Fixture side chat',
  createdAt: '2026-10-28T12:00:00Z',
  updatedAt: '2026-10-28T12:00:00Z',
  sideChat: { parentConversationId: 'main', context: '', selection: launch.selection },
};
const state = {
  conversations: [],
  projects: [],
  targets: [],
  runs: [],
  workflows: [],
  settings: {},
} as unknown as AppState;
const bundle = uiBundle('src/ui/SideChatPanel.tsx');

test('side chat connection errors appear once inline without a notification', async () => {
  const notices: unknown[] = [];
  const api: Api = async () => {
    throw new Error('Fixture connection failure');
  };
  const harness = uiHarness(await bundle);
  const props = { state, api, launch, notify: (notice: unknown) => notices.push(notice), onClose() {} };
  try {
    harness.render('SideChatPanel', props);
    await nextTurn();
    const tree = harness.render('SideChatPanel', props);
    const error = findNode(tree, (node) => node.props.className === 'side-chat-error');
    assert.ok(error);
    assert.match(text(error), /Fixture connection failure/);
    assert.equal(text(tree).split('Fixture connection failure').length - 1, 1);
    assert.deepEqual(notices, []);
  } finally {
    harness.unmount();
  }
});

test('side chat send failures retain the draft and appear once inline without a notification', async () => {
  const notices: unknown[] = [];
  const api: Api = async <T>(path: string) => {
    if (path.endsWith('/side-chat')) return conversation as T;
    if (path.endsWith('/messages')) throw new Error('Fixture delivery failure');
    return { messages: [] } as T;
  };
  const harness = uiHarness(await bundle);
  const props = { state, api, launch, notify: (notice: unknown) => notices.push(notice), onClose() {} };
  try {
    harness.render('SideChatPanel', props);
    await nextTurn();
    let tree = harness.render('SideChatPanel', props);
    findNode(tree, (node) => node.type === 'textarea')!.props.onChange({ target: { value: 'Keep this draft' } });
    tree = harness.render('SideChatPanel', props);
    findNode(tree, (node) => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
    await nextTurn();
    tree = harness.render('SideChatPanel', props);
    assert.equal(findNode(tree, (node) => node.type === 'textarea')!.props.value, 'Keep this draft');
    const error = findNode(tree, (node) => node.props.className === 'side-chat-error');
    assert.ok(error);
    assert.match(text(error), /Fixture delivery failure/);
    assert.equal(text(tree).split('Fixture delivery failure').length - 1, 1);
    assert.deepEqual(notices, []);
  } finally {
    harness.unmount();
  }
});
