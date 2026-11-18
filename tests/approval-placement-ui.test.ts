import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { Approval, Conversation, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const stamp = '2026-10-28T12:00:00Z';
const conversation: Conversation = {
  id: 'own-chat',
  projectId: 'fixture-project',
  title: 'Fixture chat',
  createdAt: stamp,
  updatedAt: stamp,
};
const sideChat: Conversation = {
  ...conversation,
  id: 'side-chat',
  sideChat: {
    parentConversationId: conversation.id,
    context: 'Fixture context',
    selection: { executionPolicy: 'cli-first' },
  },
};
function workflow(conversationId: string): Workflow {
  return {
    id: `workflow-${conversationId}`,
    projectId: conversation.projectId,
    conversationId,
    userMessageId: `message-${conversationId}`,
    input: { content: 'Fixture task', mode: 'auto', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
    status: 'waiting-approval',
    phase: 'execute',
    plan: [],
    runIds: [`run-${conversationId}`],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: stamp,
    updatedAt: stamp,
  };
}
function approval(runId: string): Approval {
  return { id: `approval-${runId}`, runId, tool: 'Bash', description: 'echo fixture', createdAt: stamp };
}
function stateFixture() {
  return {
    app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [],
    conversations: [conversation, { ...conversation, id: 'other-chat', title: 'Other fixture chat' }, sideChat],
    conversationMessages: [],
    workflows: [workflow('own-chat'), workflow('side-chat')],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [approval('run-own-chat'), approval('run-side-chat'), approval('run-without-workflow')],
    plugins: [],
    refreshing: false,
    settings: { maxQuotaAgeSeconds: 120, reservePercent: 10, refreshSeconds: 60 },
  };
}
let workspaceCode: string, studioCode: string, cardCode: string;
before(async () => {
  workspaceCode = await uiBundle('src/ui/Workspace.tsx');
  studioCode = await uiBundle('src/ui/Studio.tsx', true);
  cardCode = await uiBundle('src/ui/App.tsx');
});
const api = async () => ({ messages: [], workflows: [] });
const workspaceProps = (state = stateFixture(), chat = conversation) => ({
  state,
  conversation: chat,
  api,
  notify() {},
  onConversation() {},
  onAddProject() {},
  onMemory() {},
  onInspect() {},
});
const approvalNode = (tree: unknown, runId: string) => findNode(tree, (node) => node.props.approval?.runId === runId);
const compactNotice = (tree: unknown, chatId: string) =>
  findNode(tree, (node) => node.props.className === 'approval-notice' && node.props['data-conversation-id'] === chatId);
const studioHarness = (state = stateFixture()) =>
  uiHarness(studioCode, {
    __backend: { state, api, reload: async () => {}, connection: 'connected' },
    localStorage: {
      getItem: (key: string) => (key === 'agent-studio-conversation' ? conversation.id : null),
      setItem() {},
    },
  });

test('a chat approval stays above its queue panel and shows a readable title without run metadata', async () => {
  const harness = uiHarness(workspaceCode);
  const props = workspaceProps();
  let tree = harness.render('ConversationWorkspace', props);
  await nextTurn();
  tree = harness.render('ConversationWorkspace', props);
  const approvals = findNode(tree, (node) => node.props.className === 'conversation-approvals');
  assert.ok(approvals);
  const card = approvalNode(approvals, 'run-own-chat');
  assert.ok(card);
  assert.equal(approvalNode(tree, 'run-side-chat'), undefined);
  assert.equal(approvalNode(tree, 'run-without-workflow'), undefined);
  const wrap = findNode(tree, (node) => node.props.className === 'conversation-composer-wrap');
  assert.ok(wrap);
  const children = [wrap.props.children].flat(Infinity) as UiNode[];
  const approvalIndex = children.findIndex((node) => node?.props?.className === 'conversation-approvals');
  const queueIndex = children.findIndex((node) => node?.type?.name === 'ConversationQueue');
  assert.ok(approvalIndex >= 0 && queueIndex > approvalIndex, 'approval stays immediately above the queue');
  assert.equal(queueIndex, approvalIndex + 1);
  const rendered = uiHarness(cardCode).render('ApprovalCard', card.props);
  assert.match(text(rendered), /运行命令/);
  assert.doesNotMatch(text(rendered), /任务 run-|2026-10-28/);
  harness.unmount();
});

test('a different main chat has no approval card for the original chat', async () => {
  const harness = uiHarness(workspaceCode);
  const props = workspaceProps(stateFixture(), { ...conversation, id: 'other-chat' });
  harness.render('ConversationWorkspace', props);
  await nextTurn();
  const tree = harness.render('ConversationWorkspace', props);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'conversation-approvals'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => Boolean(node.props.approval)),
    undefined,
  );
  harness.unmount();
});

test('an approval for an earlier attempt still belongs to the chat that owns its workflow', () => {
  const state = stateFixture();
  state.workflows[0]!.runIds.push('run-new-attempt');
  const harness = uiHarness(workspaceCode);
  const tree = harness.render('ConversationWorkspace', workspaceProps(state));
  const approvals = findNode(tree, (node) => node.props.className === 'conversation-approvals');
  assert.ok(approvalNode(approvals, 'run-own-chat'));
  harness.unmount();
});

test('side chats and orphan runs keep full approval cards while hidden main chats use compact notices', () => {
  const state = stateFixture();
  state.workflows.push(workflow('other-chat'));
  state.approvals.push(approval('run-other-chat'));
  const harness = studioHarness(state);
  const tree = harness.render('default');
  const stack = findNode(tree, (node) => node.props.className === 'approval-stack');
  assert.ok(stack);
  assert.ok(approvalNode(stack, 'run-side-chat'), 'SideChatPanel has no approval mount');
  assert.ok(approvalNode(stack, 'run-without-workflow'));
  assert.equal(approvalNode(stack, 'run-own-chat'), undefined);
  assert.equal(approvalNode(stack, 'run-other-chat'), undefined, 'another main chat must not float a full card');
  assert.equal(compactNotice(stack, 'own-chat'), undefined);
  const compact = compactNotice(stack, 'other-chat');
  assert.ok(compact);
  assert.match(text(compact), /需要你的确认/);
  assert.equal(findNode(compact, (node) => node.props.className === 'approval-notice-chat')?.props.translate, 'no');
  assert.match(text(compact), /Other fixture chat/);
  assert.equal(
    findNode(compact, (node) => node.props.approval),
    undefined,
  );
  harness.unmount();
});

test('opening settings keeps the current chat approval reachable in the fixed stack', () => {
  const harness = studioHarness();
  let tree = harness.render('default');
  assert.equal(
    approvalNode(
      findNode(tree, (node) => node.props.className === 'approval-stack'),
      'run-own-chat',
    ),
    undefined,
  );
  const settings = findNode(tree, (node) => node.type === 'button' && text(node) === '设置');
  assert.ok(settings);
  settings.props.onClick();
  tree = harness.render('default');
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'SplitView'),
    undefined,
  );
  const stack = findNode(tree, (node) => node.props.className === 'approval-stack');
  assert.ok(compactNotice(stack, 'own-chat'), 'settings unmounts the current chat workspace');
  assert.equal(approvalNode(stack, 'run-own-chat'), undefined);
  harness.unmount();
});

test('an approval in a visible split pane is removed from the fixed stack', async () => {
  const state = stateFixture();
  state.workflows.push(workflow('other-chat'));
  state.approvals.push(approval('run-other-chat'));
  const harness = studioHarness(state);
  let tree = harness.render('default');
  const split = findNode(tree, (node) => node.type?.name === 'SplitView');
  assert.ok(split);
  split.props.onDrop('other-chat', { index: 0, mode: 'after' });
  await nextTurn();
  tree = harness.render('default');
  const visible = findNode(tree, (node) => node.type?.name === 'SplitView');
  assert.equal(JSON.stringify(visible?.props.ids), JSON.stringify(['own-chat', 'other-chat']));
  const stack = findNode(tree, (node) => node.props.className === 'approval-stack');
  assert.equal(approvalNode(stack, 'run-own-chat'), undefined);
  assert.equal(approvalNode(stack, 'run-other-chat'), undefined);
  assert.equal(compactNotice(stack, 'own-chat'), undefined);
  assert.equal(compactNotice(stack, 'other-chat'), undefined);
  assert.ok(approvalNode(stack, 'run-side-chat'));
  harness.unmount();
});

test('Open on a compact approval notice opens its chat and removes the notice', async () => {
  const state = stateFixture();
  state.workflows.push(workflow('other-chat'));
  state.approvals.push(approval('run-other-chat'));
  const harness = studioHarness(state);
  const compact = compactNotice(harness.render('default'), 'other-chat');
  assert.ok(compact);
  const open = findNode(compact, (node) => node.type === 'button' && text(node) === '打开');
  assert.ok(open);
  open.props.onClick();
  await nextTurn();
  const tree = harness.render('default');
  const split = findNode(tree, (node) => node.type?.name === 'SplitView');
  assert.equal(JSON.stringify(split?.props.ids), JSON.stringify(['other-chat']));
  assert.equal(compactNotice(tree, 'other-chat'), undefined);
  assert.ok(compactNotice(tree, 'own-chat'));
  assert.equal(state.approvals.length, 4, 'opening a chat does not answer or remove its approval');
  harness.unmount();
});
