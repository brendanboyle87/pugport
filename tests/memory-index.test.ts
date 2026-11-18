import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { ProjectMemoryIndex, tokenizeMemory } from '../src/server/memory-index.ts';
import type { Conversation } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const project = {
    id: 'index-project',
    name: 'Index',
    path: '/index-project',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const conversation = {
    id: 'index-conversation',
    projectId: project.id,
    title: 'Index',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  store.save('project', project.id, '', project);
  store.save('conversation', conversation.id, project.id, conversation);
  t.after(() => db.close());
  const index = new ProjectMemoryIndex(store, project.id);
  const scope = () => {
    const anchor = store.addMessage(conversation.id, 'user', '测试检索');
    return { conversationId: conversation.id, userMessageId: anchor.id };
  };
  return { db, store, project, conversation, index, scope };
}

test('MiniSearch index preserves two-character Chinese subjects and evidence in the middle of long messages', (t) => {
  const { store, conversation, index, scope } = fixture(t);
  const source = store.addMessage(
    conversation.id,
    'assistant',
    '背景'.repeat(15000) + '\n迅雷实际路径 D:\\迅雷下载\n' + '背景'.repeat(15000),
  );
  const hits = index.search(scope(), ['迅雷']);
  assert.ok(
    hits.some((hit) => hit.messageId === source.id && hit.sourceOffset > 10000 && hit.excerpt.includes('D:\\迅雷下载')),
  );
  assert.ok(tokenizeMemory('查迅雷记录').includes('迅雷'));
  assert.equal(tokenizeMemory('abc abc abc').filter((token) => token === 'abc').length, 1);
});

test('warm queries reuse the index and later updates read changed rows rather than rebuilding old history', (t) => {
  const { db, store, conversation, index, scope } = fixture(t);
  for (let row = 0; row < 200; row++) {
    const message = store.addMessage(conversation.id, 'assistant', `旧的迁移记录 schema${row}`);
    db.prepare("UPDATE workspace_records SET updated_at=? WHERE kind='message' AND id=?").run(
      `2026-01-01T00:00:00.${String(row).padStart(3, '0')}Z`,
      message.id,
    );
  }
  const rowCounts: number[] = [];
  const iterate = store.iterateMemoryIndexRows.bind(store);
  const probe = t.mock.method(store, 'iterateMemoryIndexRows', function* (...args: Parameters<typeof iterate>) {
    const call = rowCounts.length;
    rowCounts.push(0);
    for (const row of iterate(...args)) {
      rowCounts[call]++;
      yield row;
    }
  });
  const first = scope();
  index.search(first, ['迁移']);
  assert.equal(probe.mock.callCount(), 1);
  assert.ok(rowCounts[0]! >= 200);
  index.search(first, ['schema199']);
  assert.equal(probe.mock.callCount(), 1);
  const added = store.addMessage(conversation.id, 'assistant', '迁移增量新证据 UNIQUE_NEW_EVIDENCE');
  const second = scope();
  const fresh = index.search(second, ['unique_new_evidence']);
  assert.ok(fresh.some((hit) => hit.messageId === added.id));
  assert.equal(probe.mock.callCount(), 2);
  assert.ok(rowCounts[1]! < 10);
});

test('changed message content and deleted conversations cannot leak stale cached evidence', (t) => {
  const { store, conversation, index, scope } = fixture(t);
  const message = store.addMessage(conversation.id, 'assistant', '旧线索 BLUESOURCE');
  const first = scope();
  assert.ok(index.search(first, ['bluesource']).length);
  message.content = '新线索 GREENSOURCE';
  store.save('message', message.id, conversation.id, message);
  assert.equal(index.search(first, ['bluesource']).length, 0);
  assert.ok(index.search(first, ['greensource']).length);
  store.save('conversation', conversation.id, conversation.projectId, {
    ...conversation,
    deletedAt: new Date().toISOString(),
  });
  assert.equal(index.search(first, ['greensource']).length, 0);
});

test('background warming completes once and retains the same anchored scope on subsequent queries', async (t) => {
  const { store, conversation, index, scope } = fixture(t);
  const old = store.addMessage(conversation.id, 'assistant', '迅雷 D:\\迅雷下载');
  const anchor = scope();
  const future = store.addMessage(conversation.id, 'user', '迅雷 FUTURE_REQUEST');
  assert.equal(index.isReady, false);
  const warm = index.warm();
  assert.equal(index.warm(), warm);
  await warm;
  assert.equal(index.isReady, true);
  const hits = index.search(anchor, ['迅雷']);
  assert.ok(hits.some((hit) => hit.messageId === old.id));
  assert.ok(!hits.some((hit) => hit.messageId === future.id));
});

test('Grok history consolidation refreshes warmed chunk ownership when an unchanged message moves out of a deleted shell', (t) => {
  const { db, store, project, conversation, index, scope } = fixture(t);
  const old = { ...conversation, id: 'import-shell' };
  store.save('conversation', old.id, project.id, old);
  const imported = store.addMessage(old.id, 'assistant', '迅雷下载的路径 D:\\迅雷下载');
  imported.importedFrom = { provider: 'grok', sessionId: 'local-private-session', line: 1, timestampKind: 'exact' };
  store.save('message', imported.id, old.id, imported);
  const first = scope();
  assert.ok(index.search(first, ['迅雷']).some((hit) => hit.conversationId === old.id));
  imported.conversationId = conversation.id;
  store.save('message', imported.id, conversation.id, imported);
  db.prepare("DELETE FROM workspace_records WHERE kind='conversation' AND id=?").run(old.id);
  const hits = index.search(scope(), ['迅雷']);
  assert.ok(hits.some((hit) => hit.messageId === imported.id && hit.conversationId === conversation.id));
  assert.ok(!hits.some((hit) => hit.conversationId === old.id));
});

test('moving an individual message to another project prunes its warm postings while the original conversation remains visible', (t) => {
  const { store, project, conversation, index, scope } = fixture(t);
  const message = store.addMessage(conversation.id, 'assistant', '迅雷下载 D:\\迅雷下载 PRIVATE_MOVED_EVIDENCE');
  const anchor = scope();
  assert.ok(index.search(anchor, ['private_moved_evidence']).length);
  const foreignProject = { ...project, id: 'foreign-project' };
  const foreignConversation = { ...conversation, id: 'foreign-conversation', projectId: foreignProject.id };
  store.save('project', foreignProject.id, '', foreignProject);
  store.save('conversation', foreignConversation.id, foreignProject.id, foreignConversation);
  message.conversationId = foreignConversation.id;
  store.save('message', message.id, foreignConversation.id, message);
  assert.equal(
    store.conversations(project.id).some((row) => row.id === conversation.id),
    true,
  );
  assert.deepEqual(index.search(anchor, ['private_moved_evidence']), []);
  assert.ok(!index.pathSources(anchor).some((row) => row.messageId === message.id));
});

test('hard-deleting a warmed message removes it from search and referenced paths', (t) => {
  const { db, store, conversation, index, scope } = fixture(t);
  const message = store.addMessage(conversation.id, 'assistant', '迅雷下载 D:\\迅雷下载 PRIVATE_DELETED_EVIDENCE');
  const anchor = scope();
  assert.ok(index.search(anchor, ['private_deleted_evidence']).length);
  db.prepare("DELETE FROM workspace_records WHERE kind='message' AND id=?").run(message.id);
  assert.deepEqual(index.search(anchor, ['private_deleted_evidence']), []);
  assert.ok(!index.pathSources(anchor).some((row) => row.messageId === message.id));
});

test('marking a previously indexed answer removes its warm search postings and paths', (t) => {
  const { store, conversation, index, scope } = fixture(t);
  const message = store.addMessage(conversation.id, 'assistant', 'DERIVED_REPLY_MARK D:\\injected-file');
  const anchor = scope();
  assert.ok(index.search(anchor, ['derived_reply_mark']).some((hit) => hit.messageId === message.id));
  assert.ok(index.pathSources(anchor).some((hit) => hit.messageId === message.id));
  message.untrustedContent = true;
  store.save('message', message.id, conversation.id, message);
  assert.deepEqual(index.search(anchor, ['derived_reply_mark']), []);
  assert.ok(!index.pathSources(anchor).some((hit) => hit.messageId === message.id));
});

test('a warm index isolates side chats in both directions while retaining their own memory', (t) => {
  const { store, project, conversation, index, scope } = fixture(t);
  const side: Conversation = {
    ...conversation,
    id: 'side-one',
    sideChat: { parentConversationId: conversation.id, context: '', selection: { executionPolicy: 'cli-only' } },
  };
  const sibling = { ...side, id: 'side-two' };
  for (const value of [side, sibling]) store.save('conversation', value.id, project.id, value);
  const mainRecord = store.addMessage(conversation.id, 'assistant', 'EVIDENCE_MAIN D:\\main');
  const sideRecord = store.addMessage(side.id, 'assistant', 'EVIDENCE_SIDE D:\\side-one');
  const siblingRecord = store.addMessage(sibling.id, 'assistant', 'EVIDENCE_SIBLING D:\\side-two');
  const mainAnchor = scope();
  assert.ok(index.search(mainAnchor, ['evidence_main']).some((hit) => hit.messageId === mainRecord.id));
  assert.deepEqual(index.search(mainAnchor, ['evidence_side', 'evidence_sibling']), []);
  assert.deepEqual(
    index.pathSources(mainAnchor).map((hit) => hit.messageId),
    [mainRecord.id],
  );
  const sideAnchor = store.addMessage(side.id, 'user', 'Find evidence');
  const sideScope = { conversationId: side.id, userMessageId: sideAnchor.id };
  const sideHits = index.search(sideScope, ['evidence_main', 'evidence_side', 'evidence_sibling']);
  assert.ok(sideHits.some((hit) => hit.messageId === mainRecord.id));
  assert.ok(sideHits.some((hit) => hit.messageId === sideRecord.id));
  assert.ok(!sideHits.some((hit) => hit.messageId === siblingRecord.id));
  assert.ok(!index.pathSources(sideScope).some((hit) => hit.messageId === siblingRecord.id));
});

test('changing a conversation into a side chat removes its warmed evidence without rewriting or deleting it', (t) => {
  const { store, project, conversation, index, scope } = fixture(t);
  const converted: Conversation = { ...conversation, id: 'converted-side' };
  store.save('conversation', converted.id, project.id, converted);
  const source = store.addMessage(converted.id, 'assistant', 'CONVERTED_EVIDENCE D:\\converted');
  const anchor = scope();
  assert.ok(index.search(anchor, ['converted_evidence']).some((hit) => hit.messageId === source.id));
  converted.sideChat = {
    parentConversationId: conversation.id,
    context: '',
    selection: { executionPolicy: 'cli-only' },
  };
  store.save('conversation', converted.id, project.id, converted);
  assert.deepEqual(index.search(anchor, ['converted_evidence']), []);
  assert.ok(!index.pathSources(anchor).some((hit) => hit.messageId === source.id));
  assert.equal(store.allMessages(converted.id)[0]?.id, source.id);
  delete converted.sideChat;
  store.save('conversation', converted.id, project.id, converted);
  assert.ok(index.search(anchor, ['converted_evidence']).some((hit) => hit.messageId === source.id));
});
