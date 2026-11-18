import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import {
  claudeHistoryLimits,
  importClaudeHistory,
  previewClaudeHistory,
  type ClaudeHistoryInput,
} from '../src/server/claude-history-import.ts';
import type { Conversation, Project } from '../src/shared/types.ts';

const first = '2026-01-01T00:00:00.000Z',
  second = '2026-01-01T00:01:00.000Z';
const exported = (
  chat: unknown = {
    uuid: 'chat-1',
    name: 'Synthetic design',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'Design a list', created_at: first },
      { uuid: 'm2', sender: 'assistant', content: [{ type: 'text', text: 'Use stable keys.' }], created_at: second },
    ],
  },
): ClaudeHistoryInput => ({ name: 'conversations.json', text: JSON.stringify([chat]) });
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const project = { id: 'project', name: 'Synthetic', path: 'synthetic-unused', createdAt: first } as Project;
  store.save('project', project.id, project.id, project);
  const input = exported();
  const preview = previewClaudeHistory(input);
  return {
    store,
    project,
    input: { ...input, fingerprint: preview.fingerprint, conversationId: preview.conversations[0]!.id },
  };
}

test('web export previews only explicit text; excludes tools, thinking, attachments and redacts known credentials', (t) => {
  const { store, project } = fixture(t);
  const input = exported({
    uuid: 'chat',
    name: 'token=secret_title',
    chat_messages: [
      {
        sender: 'human',
        text: 'Bearer synthetic-secret',
        created_at: first,
        attachments: [{ extracted_content: 'FILE_SECRET' }],
      },
      {
        sender: 'assistant',
        content: [
          { type: 'text', text: 'Visible' },
          { type: 'thinking', thinking: 'HIDDEN_REASONING' },
          { type: 'tool_use', input: { command: 'EXECUTE_TOOL' } },
        ],
        created_at: second,
      },
      { sender: 'system', text: 'SYSTEM_SECRET' },
      { sender: 'assistant', content: [{ type: 'tool_result', content: 'TOOL_SECRET' }] },
    ],
  });
  const preview = previewClaudeHistory(input);
  assert.equal(preview.conversations[0]?.messageCount, 2);
  assert.equal(preview.skippedRecords, 2);
  assert.equal(preview.conversations[0]?.title, 'token=[redacted]');
  const result = importClaudeHistory(
    { store },
    project.id,
    { ...input, fingerprint: preview.fingerprint, conversationId: 'chat' },
    () => {},
  );
  const messages = store.allMessages(result.conversation.id);
  assert.deepEqual(
    messages.map((message) => message.content),
    ['[redacted]', 'Visible'],
  );
  assert.ok(
    !JSON.stringify(store.list('message')).match(
      /FILE_SECRET|HIDDEN_REASONING|EXECUTE_TOOL|SYSTEM_SECRET|TOOL_SECRET|synthetic-secret/,
    ),
  );
});

test('Code JSONL groups sessions and deduplicates repeated messages; native sessions never become runs', (t) => {
  const { store, project } = fixture(t);
  const user = {
    type: 'user',
    sessionId: 'session1',
    uuid: 'one',
    timestamp: first,
    message: { role: 'user', content: 'A question' },
  };
  const input = {
    name: 'session.jsonl',
    text: [
      user,
      user,
      {
        type: 'assistant',
        sessionId: 'session1',
        uuid: 'two',
        timestamp: second,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Answer' },
            { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'NEVER_RUN' } },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'session1',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'NEVER_IMPORT' }] },
      },
      { type: 'system', content: 'native state' },
      { type: 'user', sessionId: 'session2', message: { role: 'user', content: 'Other chat' } },
    ]
      .map((item) => JSON.stringify(item))
      .join('\n'),
  };
  const preview = previewClaudeHistory(input);
  assert.equal(preview.source, 'claude-code');
  assert.deepEqual(
    preview.conversations.map((chat) => chat.messageCount),
    [2, 1],
  );
  assert.equal(preview.skippedRecords, 3);
  const result = importClaudeHistory(
    { store },
    project.id,
    { ...input, fingerprint: preview.fingerprint, conversationId: 'session1' },
    () => {},
  );
  assert.deepEqual(
    store.allMessages(result.conversation.id).map((message) => message.role),
    ['user', 'assistant'],
  );
  assert.equal(store.list('workflow').length, 0);
  assert.equal(store.list('session').length, 0);
  assert.throws(
    () =>
      previewClaudeHistory({
        ...input,
        text: [user, { ...user, message: { role: 'user', content: 'Changed' } }]
          .map((item) => JSON.stringify(item))
          .join('\n'),
      }),
    /相同消息/,
  );
});

test('atomic idempotent import preserves verified dates and all untrusted context/memory boundaries', (t) => {
  const { store, project, input } = fixture(t);
  let published = 0;
  const one = importClaudeHistory({ store }, project.id, input, () => {
    published++;
  });
  const two = importClaudeHistory({ store }, project.id, { ...input, name: 'renamed.json' }, () => {
    throw Error('lost notification');
  });
  assert.equal(two.conversation.id, one.conversation.id);
  assert.equal(two.reused, true);
  assert.equal(published, 1);
  assert.equal(store.list('conversation').length, 1);
  assert.equal(store.untrustedConversation(one.conversation.id), true);
  const messages = store.allMessages(one.conversation.id);
  assert.deepEqual(
    messages.map((message) => message.createdAt),
    [first, second],
  );
  assert.ok(
    messages.every(
      (message) => message.untrustedContent && !message.workflowId && !message.steering && !message.attachments,
    ),
  );
  assert.deepEqual(store.contextMessages(one.conversation.id, messages[1]!.id), []);
  assert.deepEqual(store.memoryIndexRows(project.id), []);
  assert.deepEqual(store.memoryIndexMembership(project.id), []);
  assert.equal(one.conversation.memory, 'off');
  const metadata = messages[0]?.importedFrom;
  assert.equal(metadata?.provider, 'claude');
  if (metadata?.provider === 'claude') assert.equal(metadata.sourceCreatedAt, first);
});

test('missing and backwards timestamps retain source order and honest original provenance', (t) => {
  const { store, project } = fixture(t);
  const input = exported({
    name: 'Ordered',
    chat_messages: [
      { sender: 'human', text: 'One' },
      { sender: 'assistant', text: 'Two', created_at: second },
      { sender: 'human', text: 'Three', created_at: first },
    ],
  });
  const preview = previewClaudeHistory(input);
  const result = importClaudeHistory(
    { store },
    project.id,
    { ...input, fingerprint: preview.fingerprint, conversationId: preview.conversations[0]!.id },
    () => {},
  );
  const messages = store.allMessages(result.conversation.id);
  assert.deepEqual(
    messages.map((message) => message.content),
    ['One', 'Two', 'Three'],
  );
  assert.ok(messages.every((message) => message.createdAt === second));
  assert.equal(messages[0]?.importedFrom?.provider === 'claude' && messages[0].importedFrom.timestampKind, 'imported');
  assert.equal(messages[2]?.importedFrom?.provider === 'claude' && messages[2].importedFrom.sourceCreatedAt, first);
});

test('unknown, oversize, deep, excessive and malformed records fail without leaking input', () => {
  for (const input of [
    { name: 'private.json', text: '{"secret":"do-not-echo" invalid' },
    { name: 'wrong.txt', text: '[]' },
    { name: 'deep.json', text: '['.repeat(33) + '0' + ']'.repeat(33) },
    { name: 'big.json', text: ' '.repeat(claudeHistoryLimits.bytes + 1) },
    { name: 'fields.json', text: JSON.stringify(Array(100001).fill(0)) },
    { name: 'many.jsonl', text: (JSON.stringify({ type: 'system' }) + '\n').repeat(10001) },
    exported({ chat_messages: [{ sender: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }] }] }),
    { name: 'unknown.json', text: JSON.stringify({ messages: [{ role: 'system', content: 'secret' }] }) },
  ])
    assert.throws(
      () => previewClaudeHistory(input),
      (error) =>
        error instanceof Error &&
        error.message.startsWith('无法导入 Claude 历史：') &&
        !error.message.includes('do-not-echo'),
    );
});

test('selection/fingerprint/project guard precedes writes; failed storage rolls back all messages', (t) => {
  const { store, project, input } = fixture(t);
  for (const [id, payload] of [
    ['absent', input],
    [project.id, { ...input, fingerprint: 'wrong' }],
    [project.id, { ...input, conversationId: 'absent' }],
  ] as const)
    assert.throws(() => importClaudeHistory({ store }, id, payload, () => {}));
  const save = store.save.bind(store);
  t.mock.method(store, 'save', (kind: string, ...args: [string, string, unknown]) => {
    if (kind === 'message') throw Error('SECRET_DB_DIAGNOSTIC');
    return save(kind, ...args);
  });
  assert.throws(() => importClaudeHistory({ store }, project.id, input, () => {}), /保存失败/);
  assert.deepEqual(store.list('conversation'), []);
  assert.deepEqual(store.list('message'), []);
  assert.deepEqual(store.list('claude-history-import'), []);
});

test('archive/deletion cannot silently create another copy; another project gets a separate receipt', (t) => {
  const { store, project, input } = fixture(t);
  const result = importClaudeHistory({ store }, project.id, input, () => {});
  for (const field of ['archivedAt', 'deletedAt', 'closedAt'] as const) {
    store.save('conversation', result.conversation.id, project.id, { ...result.conversation, [field]: second });
    assert.throws(() => importClaudeHistory({ store }, project.id, input, () => {}), /此前已导入/);
  }
  store.save('project', 'other', 'other', { ...project, id: 'other' });
  const other = importClaudeHistory({ store }, 'other', input, () => {});
  assert.notEqual(other.conversation.id, result.conversation.id);
  assert.equal(store.list<Conversation>('conversation').length, 2);
});

test('pending project purge and incognito chat cannot import persistent history', (t) => {
  const { store, project, input } = fixture(t);
  store.save('project-purge', project.id, project.id, { pending: true });
  assert.throws(() => importClaudeHistory({ store }, project.id, input, () => {}), /项目不存在/);
  store.db.prepare("DELETE FROM workspace_records WHERE kind='project-purge'").run();
  store.save('project', project.id, project.id, { ...project, scope: 'chat' });
  store.save('conversation', 'private', project.id, {
    id: 'private',
    projectId: project.id,
    incognito: true,
    closedAt: first,
  });
  assert.throws(() => importClaudeHistory({ store }, project.id, input, () => {}), /隐身对话/);
  assert.deepEqual(store.list('message'), []);
});
