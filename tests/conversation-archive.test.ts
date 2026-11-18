import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, input } from './helpers/session-workspace.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import { searchConversations } from '../src/server/search-routes.ts';
import type { Conversation, Project } from '../src/shared/types.ts';

test('archive hides state and MCP entries but preserves search, memory sources and pins; unarchive reverses it', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id, 'Synthetic needle');
  workspace.pinConversation(conversation.id, true);
  workspace.store.addMessage(conversation.id, 'user', 'needle memory');
  const archived = workspace.archiveConversation(conversation.id, true);
  assert.ok(archived.archivedAt);
  assert.equal(workspace.state().conversations?.length, 0);
  assert.equal(new ExternalTasks(workspace).conversations().total, 0);
  assert.equal(workspace.store.conversations()[0].id, conversation.id);
  assert.equal(workspace.store.archivedConversations()[0].id, conversation.id);
  assert.equal(workspace.conversation(conversation.id).conversation.archivedAt, archived.archivedAt);
  assert.equal(searchConversations(workspace.store, 'needle')[0].archivedAt, archived.archivedAt);
  const next = workspace.createConversation(project.id);
  const anchor = workspace.store.addMessage(next.id, 'user', 'needle');
  assert.ok(
    workspace.store
      .searchMemory(project.id, next.id, anchor.id, ['needle'])
      .some((hit) => hit.conversationId === conversation.id),
  );
  assert.ok(workspace.archiveConversation(conversation.id, false).pinnedAt);
  assert.equal(workspace.store.archivedConversations().length, 0);
  assert.equal(workspace.state().conversations?.length, 2);
});

test('all active statuses refuse archive and delete; batch skips busy chats and publishes once', async (t) => {
  const { workspace, directory, controller } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  for (const status of [
    'queued',
    'waiting-resource',
    'planning',
    'running',
    'waiting-approval',
    'waiting-confirmation',
  ]) {
    workspace.store.save('workflow', 'busy', conversation.id, {
      id: 'busy',
      projectId: project.id,
      conversationId: conversation.id,
      status,
      input,
      runIds: [],
      updatedAt: '',
    });
    assert.throws(() => workspace.archiveConversation(conversation.id, true), /请先结束或取消/);
    assert.throws(() => workspace.deleteConversation(conversation.id), /请先结束或取消/);
  }
  const ready = workspace.createConversation(project.id);
  const deleted = workspace.createConversation(project.id);
  workspace.deleteConversation(deleted.id);
  const side = workspace.createConversation(project.id);
  workspace.store.save('conversation', side.id, project.id, { ...side, sideChat: { parentConversationId: ready.id } });
  assert.throws(() => workspace.archiveConversation(side.id, true), /侧聊不能归档/);
  assert.equal(workspace.conversation(side.id).conversation.archivedAt, undefined);
  const publish = t.mock.method(controller, 'broadcast', () => {});
  const transaction = t.mock.method(workspace.store, 'transaction');
  assert.deepEqual(workspace.archiveProjectConversations(project.id), { archived: 1, skipped: 1 });
  assert.equal(publish.mock.callCount(), 1);
  assert.equal(transaction.mock.callCount(), 1);
  assert.equal(workspace.store.archivedConversations()[0].id, ready.id);
  assert.deepEqual(workspace.archiveProjectConversations(project.id), { archived: 0, skipped: 1 });
});

test('sending a new message automatically unarchives the conversation', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  workspace.archiveConversation(conversation.id, true);
  // Keep this test local: accepting a queued message does not launch an executor.
  t.mock.method(workspace as any, 'wake', () => {});
  await workspace.send(conversation.id, { ...input, queue: true });
  assert.equal(workspace.conversation(conversation.id).conversation.archivedAt, undefined);
  assert.equal(workspace.state().conversations?.[0].id, conversation.id);
});

test('a rejected send leaves the conversation archived and creates no message', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  workspace.archiveConversation(conversation.id, true);
  t.mock.method(workspace.attachments, 'resolve', () => {
    throw Error('Synthetic missing attachment');
  });
  await assert.rejects(workspace.send(conversation.id, { ...input, queue: true }), /Synthetic missing attachment/);
  assert.ok(workspace.conversation(conversation.id).conversation.archivedAt);
  assert.equal(workspace.store.allMessages(conversation.id).length, 0);
});

test('recent deletion restores user chats and memories, excluding side chats, Grok shells and removed projects', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const main = workspace.createConversation(project.id);
  workspace.store.addMessage(main.id, 'user', 'retained history');
  workspace.deleteConversation(main.id);
  assert.equal(workspace.store.deletedConversations()[0].id, main.id);
  const refresh = t.mock.method(workspace as any, 'refreshMemories', () => {});
  const restored = workspace.restoreConversation(main.id);
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.deletedByUser, undefined);
  assert.equal(workspace.store.allMessages(main.id)[0].content, 'retained history');
  assert.equal(refresh.mock.calls[0].arguments[0], project.id);
  for (const kind of ['side', 'grok']) {
    const value = workspace.createConversation(project.id);
    workspace.store.save('conversation', value.id, project.id, {
      ...value,
      ...(kind === 'side' ? { sideChat: { parentConversationId: main.id } } : { deletedAt: new Date().toISOString() }),
    });
    if (kind === 'side') workspace.deleteConversation(value.id);
    // Repeating deletion cannot relabel a hidden import shell as a user delete.
    workspace.store.deleteConversation(value.id);
    assert.equal(workspace.store.deletedConversations().length, 0);
    assert.throws(() => workspace.restoreConversation(value.id), /不能从最近删除/);
  }
  const userDeleted = workspace.createConversation(project.id);
  workspace.deleteConversation(userDeleted.id);
  workspace.removeProject(project.id);
  assert.equal(workspace.store.deletedConversations().length, 0);
  for (const id of [main.id, userDeleted.id]) assert.throws(() => workspace.restoreConversation(id), /请先恢复.*项目/);
  workspace.restoreProject(project.id);
  assert.equal(workspace.store.deletedConversations()[0].id, userDeleted.id);
  assert.equal(workspace.store.get<Project>('project', project.id)?.removedAt, undefined);
});

test('30-day listing boundary only hides old deletions; it never purges them', async (t) => {
  const { workspace, directory } = fixture(t);
  const project = await workspace.createProject(directory);
  const now = Date.parse('2026-10-14T12:00:00Z');
  for (const [id, age] of [
    ['edge', 30 * 86400000],
    ['old', 30 * 86400000 + 1],
  ] as const) {
    workspace.store.save('conversation', id, project.id, {
      id,
      projectId: project.id,
      title: id,
      deletedByUser: true,
      deletedAt: new Date(now - age).toISOString(),
    });
  }
  assert.deepEqual(
    workspace.store.deletedConversations(now).map((value) => value.id),
    ['edge'],
  );
  assert.ok(workspace.store.get<Conversation>('conversation', 'old')?.deletedAt);
  assert.equal(workspace.restoreConversation('old').deletedAt, undefined);
});
