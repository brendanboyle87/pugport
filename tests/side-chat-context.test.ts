import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { sideChatParentContext, sideChatSteeringInput } from '../src/server/side-chat-context.ts';
import type { Conversation, RunRecord, Workflow } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  t.after(() => db.close());
  const main: Conversation = {
    id: 'main',
    projectId: 'project',
    title: 'Main',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
  };
  const side: Conversation = {
    ...main,
    id: 'side',
    title: 'Side',
    sideChat: {
      parentConversationId: main.id,
      context: 'Stale opening snapshot.',
      selection: { executionPolicy: 'cli-only' },
    },
  };
  store.save('conversation', main.id, main.projectId, main);
  store.save('conversation', side.id, side.projectId, side);
  return { store, main, side };
}

test('side source context refreshes newer parent messages and excludes sibling conversations', (t) => {
  const { store, main, side } = fixture(t);
  store.addMessage(main.id, 'assistant', 'Latest synthetic main evidence.');
  store.addMessage('sibling', 'assistant', 'Foreign synthetic side information.');
  const context = sideChatParentContext(store, side.id);
  assert.match(context, /Latest synthetic main evidence/);
  assert.doesNotMatch(context, /Foreign synthetic side information|Stale opening snapshot/);
  store.addMessage(main.id, 'assistant', 'Newer evidence after first question.');
  assert.match(sideChatParentContext(store, side.id), /Newer evidence after first question/);
  assert.equal(sideChatParentContext(store, main.id), '');
});

test('live main output is bounded, unverified and never carries another run or native session ID', (t) => {
  const { store, side } = fixture(t);
  store.save('workflow', 'main-workflow', 'main', {
    id: 'main-workflow',
    conversationId: 'main',
    projectId: 'project',
  } as Workflow);
  store.save('workflow', 'other-workflow', 'other', {
    id: 'other-workflow',
    conversationId: 'other',
    projectId: 'project',
  } as Workflow);
  const active = {
    id: 'main-run',
    workflowId: 'main-workflow',
    status: 'running',
    startedAt: '2026-10-01T10:00:00Z',
    nativeSessionId: 'private-main-native-id',
    output: 'x'.repeat(100_000) + 'Newest main stream.',
  } as RunRecord;
  const context = sideChatParentContext(store, side.id, [
    active,
    {
      ...active,
      id: 'other-run',
      workflowId: 'other-workflow',
      output: 'Foreign stream.',
    },
  ]);
  assert.match(context, /Newest main stream/);
  assert.match(context, /未完成、未经核验/);
  assert.doesNotMatch(context, /Foreign stream|private-main-native-id/);
  assert.ok(context.length < 4000);
});

test('live tool-less output stays out of side-chat context, including a combined step of a trusted workflow', (t) => {
  const { store, side } = fixture(t);
  const workflow = {
    id: 'main-workflow',
    conversationId: 'main',
    projectId: 'project',
    input: { untrustedContent: true },
  } as Workflow;
  store.save('workflow', workflow.id, 'main', workflow);
  const active = {
    id: 'main-run',
    workflowId: workflow.id,
    status: 'running',
    startedAt: '2026-10-01T10:00:00Z',
    output: 'LIVE_DERIVED_REPLY',
  } as RunRecord;
  assert.doesNotMatch(sideChatParentContext(store, side.id, [active]), /LIVE_DERIVED_REPLY/);
  delete workflow.input.untrustedContent;
  store.save('workflow', workflow.id, 'main', workflow);
  assert.doesNotMatch(sideChatParentContext(store, side.id, [{ ...active, toolless: true }]), /LIVE_DERIVED_REPLY/);
  assert.match(sideChatParentContext(store, side.id, [active]), /LIVE_DERIVED_REPLY/);
});

test('explicit and legacy selected quotes remain available without using a stale whole snapshot', (t) => {
  const { store, side } = fixture(t);
  side.sideChat!.context =
    'Old background.\n用户选中的引用（参考内容）：\n<quoted_text>\nLegacy selected evidence.\n</quoted_text>';
  store.save('conversation', side.id, side.projectId, side);
  assert.match(sideChatParentContext(store, side.id), /Legacy selected evidence/);
  assert.doesNotMatch(sideChatParentContext(store, side.id), /Old background/);
  side.sideChat!.quote = 'Explicit selected evidence.';
  store.save('conversation', side.id, side.projectId, side);
  assert.match(sideChatParentContext(store, side.id), /Explicit selected evidence/);
  assert.doesNotMatch(sideChatParentContext(store, side.id), /Legacy selected evidence/);
});

test('deleted or moved parent never exposes stale data or another project', (t) => {
  const { store, main, side } = fixture(t);
  store.addMessage(main.id, 'assistant', 'Main data must disappear after relationship changes.');
  for (const changed of [
    { ...main, deletedAt: 'now' },
    { ...main, projectId: 'other-project' },
  ]) {
    store.save('conversation', main.id, changed.projectId, changed);
    const context = sideChatParentContext(store, side.id);
    assert.match(context, /主对话已不可用/);
    assert.doesNotMatch(context, /Main data|Stale opening snapshot/);
  }
});

test('large archives stay bounded and near-limit steering preserves the complete user input', (t) => {
  const { store, main, side } = fixture(t);
  for (let i = 0; i < 20; i++) store.addMessage(main.id, 'assistant', 'Long prefix'.repeat(5000) + ` Main tail ${i}.`);
  assert.ok(sideChatParentContext(store, side.id).length < 14_000);
  assert.match(sideChatParentContext(store, side.id), /Main tail 19/);
  assert.doesNotMatch(sideChatParentContext(store, side.id), /Main tail 0\./);
  const full = 'z'.repeat(50_000);
  assert.equal(sideChatSteeringInput(store, side.id, full, []), full);
  const normal = sideChatSteeringInput(store, side.id, 'Explain the current state.', []);
  assert.match(normal, /Main tail 19/);
  assert.ok(normal.endsWith('用户当前侧聊补充：\nExplain the current state.'));
  assert.equal(sideChatSteeringInput(store, main.id, 'Ordinary steer.', []), 'Ordinary steer.');
});
