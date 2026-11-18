import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AppState, ConversationMessage, Workflow } from '../src/shared/types.ts';
import { findNode, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const stamp = '2026-10-29T00:00:00.000Z';
const workflow = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'chat',
  projectId: 'project',
  userMessageId: 'user',
  input: { content: 'Synthetic request', mode: 'build', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'summarize',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const message = (id: string, workflowId?: string, role: 'user' | 'assistant' = 'assistant'): ConversationMessage => ({
  id,
  conversationId: 'chat',
  workflowId,
  role,
  content: `Synthetic ${id}`,
  createdAt: stamp,
});
const props = (workflows: Workflow[], messages: ConversationMessage[]) => ({
  workflows,
  messages,
  state: { workflows, targets: [], runtimes: [], runs: [], settings: {} } as unknown as AppState,
  api: async <T>() => ({}) as T,
  notify() {},
  onInspect() {},
});
const nodes = (tree: unknown, check: (node: UiNode) => boolean): UiNode[] => {
  const result: UiNode[] = [];
  findNode(tree, (node) => {
    if (check(node)) result.push(node);
    return false;
  });
  return result;
};
const cards = (tree: unknown) =>
  nodes(tree, (node) => node.type?.name === 'WorkflowTrace').map((node) => node.props.workflow.id);
const messagesIn = (tree: unknown) =>
  nodes(tree, (node) => node.type?.name === 'Message').map((node) => node.props.message.id);
let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});

test('resend replaces the old attempt card and its notices without hiding unrelated messages or delegated work', () => {
  const old = workflow('old', { status: 'failed', supersededBy: 'latest', error: 'Synthetic old failure' });
  const latest = workflow('latest', { status: 'running', attempt: 2 });
  const child = workflow('child', {
    userMessageId: 'child-user',
    delegation: { parentId: old.id, role: 'worker', requestId: 'synthetic-child' },
  });
  const source = [
    message('user', latest.id, 'user'),
    { ...message('old-notice', old.id), systemNotice: { text: 'Synthetic old failure' } },
    message('unrelated-notice'),
    message('child-user', child.id, 'user'),
    message('child-reply', child.id),
  ];
  const ui = uiHarness(code);
  const tree = ui.render('ConversationHistory', props([old, child, latest], source));
  assert.deepEqual(
    cards(tree).filter((id) => id !== child.id),
    [latest.id],
  );
  assert.deepEqual(messagesIn(tree), ['user', 'unrelated-notice']);
  assert.ok(
    findNode(tree, (node) => node.type?.name === 'DelegatedMessage' && node.props.message.id === 'child-reply'),
  );
  assert.equal(source.length, 5, 'presentation never deletes saved messages');
  ui.unmount();
});

test('completed replies switch in place; unsuccessful attempts are not reply versions', () => {
  const first = workflow('first', { finalMessageId: 'first-reply', supersededBy: 'failed' });
  const failed = workflow('failed', { status: 'failed', attempt: 2, supersededBy: 'last' });
  const last = workflow('last', { attempt: 3, finalMessageId: 'last-reply' });
  const fixture = props(
    [last, failed, first],
    [
      message('user', last.id, 'user'),
      message('first-reply', first.id),
      { ...message('failure-notice', failed.id), systemNotice: { text: 'Synthetic failure notice' } },
      message('last-reply', last.id),
    ],
  );
  const ui = uiHarness(code);
  let tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(cards(tree), [last.id]);
  assert.deepEqual(messagesIn(tree), ['user', 'last-reply']);
  assert.match(text(tree), /2\/2/);
  const previous = findNode(tree, (node) => node.type === 'button' && node.props.title === '上一个版本');
  assert.ok(previous, 'completed replies expose the previous version control');
  previous.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(cards(tree), [first.id]);
  assert.deepEqual(messagesIn(tree), ['user', 'first-reply']);
  assert.match(text(tree), /1\/2/);
  findNode(tree, (node) => node.type === 'button' && node.props.title === '下一个版本')!.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(messagesIn(tree), ['user', 'last-reply']);
  ui.unmount();
});

test('a new attempt becomes current while completed versions remain reachable and failed attempts stay unnumbered', () => {
  const first = workflow('first', { finalMessageId: 'first-reply', supersededBy: 'second' });
  const second = workflow('second', { attempt: 2, finalMessageId: 'second-reply' });
  let fixture = props(
    [first, second],
    [message('user', second.id, 'user'), message('first-reply', first.id), message('second-reply', second.id)],
  );
  const ui = uiHarness(code);
  let tree = ui.render('ConversationHistory', fixture);
  findNode(tree, (node) => node.type === 'button' && node.props.title === '上一个版本')!.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(messagesIn(tree), ['user', 'first-reply']);
  const third = workflow('third', { attempt: 3, status: 'failed', error: 'Synthetic current failure' });
  fixture = props(
    [first, { ...second, supersededBy: third.id }, third],
    [
      { ...fixture.messages[0]!, workflowId: third.id },
      ...fixture.messages.slice(1),
      { ...message('third-notice', third.id), systemNotice: { text: 'Synthetic current failure' } },
    ],
  );
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(cards(tree), [third.id]);
  assert.deepEqual(messagesIn(tree), ['user', 'third-notice']);
  assert.doesNotMatch(text(tree), /3\/3/);
  findNode(tree, (node) => node.type === 'button' && node.props.title === '上一个版本')!.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(messagesIn(tree), ['user', 'second-reply']);
  findNode(tree, (node) => node.type === 'button' && node.props.title === '返回最新执行')!.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(cards(tree), [third.id]);
  ui.unmount();
});

test('older completed replies remain selectable without restoring superseded system notices', () => {
  const first = workflow('first', { finalMessageId: 'first-reply', supersededBy: 'last' });
  const last = workflow('last', { attempt: 2, finalMessageId: 'last-reply' });
  const source = [
    message('user', last.id, 'user'),
    { ...message('old-notice', first.id), systemNotice: { text: 'Synthetic old notice' } },
    { ...message('old-system-message', first.id), replyIdentity: { automatic: true, kind: 'system', runs: [] } },
    message('first-reply', first.id),
    { ...message('unrelated-notice'), systemNotice: { text: 'Synthetic unrelated notice' } },
    message('last-reply', last.id),
  ] satisfies ConversationMessage[];
  const original = structuredClone(source);
  const fixture = props([first, last], source);
  const ui = uiHarness(code);
  let tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(messagesIn(tree), ['user', 'unrelated-notice', 'last-reply']);
  findNode(tree, (node) => node.type === 'button' && node.props.title === '上一个版本')!.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(messagesIn(tree), ['user', 'first-reply', 'unrelated-notice']);
  assert.deepEqual(cards(tree), [first.id]);
  assert.match(text(tree), /1\/2/);
  findNode(tree, (node) => node.type === 'button' && node.props.title === '下一个版本')!.props.onClick();
  tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(messagesIn(tree), ['user', 'unrelated-notice', 'last-reply']);
  assert.deepEqual(source, original, 'version selection never removes saved notices');
  ui.unmount();
});

test('all unfinished outcomes are replaced and a legacy final reply without workflowId follows its owning attempt', () => {
  const statuses = ['failed', 'interrupted', 'blocked', 'cancelled'] as const;
  const earlier = statuses.map((status, index) =>
    workflow(`old-${status}`, {
      status,
      attempt: index + 1,
      supersededBy: index + 1 < statuses.length ? `old-${statuses[index + 1]}` : 'latest',
      finalMessageId: `notice-${status}`,
    }),
  );
  const latest = workflow('latest', { attempt: 5, finalMessageId: 'latest-reply' });
  const fixture = props(
    [...earlier, latest],
    [
      message('user', latest.id, 'user'),
      ...earlier.map((item) => ({
        ...message(item.finalMessageId!),
        systemNotice: { text: `Synthetic ${item.status}` },
      })),
      message('latest-reply', latest.id),
    ],
  );
  const ui = uiHarness(code);
  const tree = ui.render('ConversationHistory', fixture);
  assert.deepEqual(cards(tree), [latest.id]);
  assert.deepEqual(messagesIn(tree), ['user', 'latest-reply']);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'reply-versions'),
    undefined,
  );
  ui.unmount();
});

test('ordinary continuation records with the same user ID and unrelated queued messages keep existing behavior', () => {
  const first = workflow('first', { status: 'failed', finalMessageId: 'first-notice' });
  const continuation = workflow('continuation', { status: 'running' });
  const queued = workflow('queued', { userMessageId: 'queued-user', status: 'queued', phase: 'queue' });
  const fixture = props(
    [first, continuation, queued],
    [
      message('user', first.id, 'user'),
      { ...message('first-notice', first.id), systemNotice: { text: 'Synthetic failure' } },
      message('queued-user', queued.id, 'user'),
    ],
  );
  const ui = uiHarness(code);
  const tree = ui.render('ConversationHistory', fixture);
  assert.ok(messagesIn(tree).includes('first-notice'));
  assert.ok(messagesIn(tree).includes('queued-user'));
  assert.equal(
    findNode(tree, (node) => node.props.className === 'reply-versions'),
    undefined,
  );
  ui.unmount();
});

test('resending a steering follow-up gives that same message its own visible first attempt without losing the original task', () => {
  const original = workflow('original', {
    userMessageId: 'original-user',
    status: 'blocked',
    runIds: ['original-run'],
  });
  const rerun = workflow('rerun', { userMessageId: 'follow-up', attempt: 1, status: 'running' });
  const followUp: ConversationMessage = {
    ...message('follow-up', rerun.id, 'user'),
    steering: { runId: 'original-run', status: 'accepted', acceptedAt: stamp },
  };
  const ui = uiHarness(code);
  const tree = ui.render(
    'ConversationHistory',
    props([original, rerun], [message('original-user', original.id, 'user'), followUp]),
  );
  assert.deepEqual(cards(tree), [original.id, rerun.id]);
  assert.deepEqual(messagesIn(tree), ['original-user', 'follow-up']);
  assert.equal(followUp.steering?.runId, 'original-run');
  ui.unmount();
});

test('a resend still running counts as the newest version: 2/2, never a dash', () => {
  const first = workflow('first', { finalMessageId: 'first-reply', supersededBy: 'second' });
  const second = workflow('second', { attempt: 2, status: 'running' });
  const fixture = props([first, second], [message('user', second.id, 'user'), message('first-reply', first.id)]);
  const ui = uiHarness(code);
  const tree = ui.render('ConversationHistory', fixture);
  const versions = findNode(tree, (node) => node.props.className === 'reply-versions');
  assert.ok(versions);
  assert.match(text(versions), /2\/2/);
  assert.doesNotMatch(text(versions), /–/);
  ui.unmount();
});
