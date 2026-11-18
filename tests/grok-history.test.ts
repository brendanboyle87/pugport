import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { grokHistoryMessages, grokMessageContentHash } from '../src/server/grok-history.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
test('history projection keeps user, assistant and tool records without executing or exposing encrypted reasoning', () => {
  const input =
    [
      { type: 'system', content: 'internal' },
      { type: 'user', content: [{ type: 'text', text: 'Synthetic request' }] },
      { type: 'assistant', content: 'Synthetic answer', tool_calls: [{ name: 'never-execute' }] },
      { type: 'tool_result', content: 'Synthetic tool result' },
      { type: 'reasoning', encrypted_content: 'private-reasoning' },
      { type: 'user', content: 'synthetic system context', synthetic_reason: 'environment' },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n{"partial":';
  const result = grokHistoryMessages(input);
  assert.equal(result.messages.length, 3);
  assert.equal(result.incompleteLines, 1);
  assert.equal(result.messages[0]?.line, 1);
  assert.match(result.messages[1]!.content, /never-execute/);
  assert.doesNotMatch(JSON.stringify(result), /private-reasoning|synthetic system context/);
});

function jsonl(...rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

function update(timestamp: number, kind: string, payload: Record<string, unknown> = {}, method = 'session/update') {
  return { timestamp, method, params: { sessionId: 'fixture-session', update: { sessionUpdate: kind, ...payload } } };
}

function at(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

test('visible streamed chunks and native tool IDs recover observed timestamps in source order', () => {
  const history = jsonl(
    { type: 'user', content: 'Hello' },
    {
      type: 'assistant',
      content: [
        { type: 'text', text: 'First answer.' },
        { type: 'reasoning', text: 'private block' },
      ],
    },
    {
      type: 'assistant',
      content: '',
      tool_calls: [{ id: 'fixture-tool', name: 'read', arguments: { path: 'fixture' } }],
    },
    { type: 'tool_result', tool_call_id: 'fixture-tool', content: 'native output' },
    { type: 'assistant', content: 'Done.' },
  );
  const updates = jsonl(
    update(1000, 'user_message_chunk', { content: { type: 'text', text: 'Hello' } }),
    update(1001, 'agent_message_chunk', { content: { type: 'text', text: 'First ' } }),
    update(1001.5, 'agent_thought_chunk', {
      content: { type: 'text', text: 'private thought' },
      encrypted_content: 'private cipher',
    }),
    update(1002, 'agent_message_chunk', { content: { type: 'text', text: 'answer.' } }, '_x.ai/session/update'),
    update(1003, 'tool_call', { toolCallId: 'fixture-tool', status: 'pending' }),
    update(1004, 'tool_call_update', {
      toolCallId: 'fixture-tool',
      status: 'in_progress',
      rawOutput: 'partial output',
    }),
    update(1005, 'tool_call_update', { toolCallId: 'fixture-tool', status: 'completed', rawOutput: 'updated output' }),
    update(1006, 'agent_message_chunk', { content: { type: 'text', text: 'Done.' } }),
    update(1007, 'turn_completed'),
  );
  const result = grokHistoryMessages(history, { updates });
  assert.deepEqual(
    result.messages.map((message) => message.createdAt),
    [1000, 1001, 1003, 1005, 1006].map(at),
  );
  assert.deepEqual(
    result.messages.map((message) => message.timestampKind),
    Array(5).fill('exact'),
  );
  assert.deepEqual(
    result.messages.map((message) => message.line),
    [0, 1, 2, 3, 4],
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private block|private thought|private cipher|partial output|updated output/,
  );
});

test('repeated visible content matches distinct latest occurrences after compaction', () => {
  const history = jsonl(
    { type: 'user', content: 'Yes' },
    { type: 'assistant', content: 'Acknowledged' },
    { type: 'user', content: 'Yes' },
    { type: 'assistant', content: 'Acknowledged' },
  );
  const updates = jsonl(
    ...[100, 200, 300].flatMap((timestamp) => [
      update(timestamp, 'user_message_chunk', { content: { type: 'text', text: 'Yes' } }),
      update(timestamp + 1, 'agent_message_chunk', { content: { type: 'text', text: 'Acknowledged' } }),
      update(timestamp + 2, 'turn_completed'),
    ]),
  );
  const result = grokHistoryMessages(history, { updates });
  assert.deepEqual(
    result.messages.map((message) => message.createdAt),
    [200, 201, 300, 301].map(at),
  );
  assert.deepEqual(
    result.messages.map((message) => message.occurrence),
    [0, 0, 1, 1],
  );
  assert.equal(result.messages[0]!.contentHash, result.messages[2]!.contentHash);
  assert.notEqual(result.messages[0]!.sourceKey, result.messages[2]!.sourceKey);
  assert.equal(result.messages[0]!.contentHash, grokMessageContentHash('user', 'Yes'));
  const compacted = grokHistoryMessages(
    jsonl({ type: 'user', content: 'Yes' }, { type: 'assistant', content: 'Acknowledged' }),
    { updates },
  );
  assert.deepEqual(
    compacted.messages.map((message) => message.createdAt),
    [300, 301].map(at),
  );
  assert.equal(compacted.messages[0]!.sourceKey, result.messages[0]!.sourceKey);
});

test('a repeated history row cannot reuse one matching update observation', () => {
  const result = grokHistoryMessages(jsonl({ type: 'user', content: 'Yes' }, { type: 'user', content: 'Yes' }), {
    updates: jsonl(update(10, 'user_message_chunk', { content: { type: 'text', text: 'Yes' } })),
  });
  assert.deepEqual(
    result.messages.map((message) => message.timestampKind),
    ['fallback', 'exact'],
  );
  assert.equal(result.messages[0]!.createdAt, at(10));
  assert.equal(result.messages[1]!.createdAt, at(10));
  assert.notEqual(result.messages[0]!.sourceKey, result.messages[1]!.sourceKey);
});

test('compaction checkpoints and reset turn counts do not date messages by native row index', () => {
  const history = jsonl({ type: 'user', content: 'new request' }, { type: 'assistant', content: 'new reply' });
  const result = grokHistoryMessages(history, {
    updates: jsonl(
      { ts: at(10), type: 'turn_started', conversation_message_count: 0 },
      update(10, 'user_message_chunk', { content: { type: 'text', text: 'old request' } }),
      update(11, 'agent_message_chunk', { content: { type: 'text', text: 'old reply' } }),
      update(12, 'turn_completed'),
      update(20, 'compaction_checkpoint', {
        conversation_message_count: 0,
        content: { type: 'text', text: 'private compaction' },
      }),
      { ts: at(30), type: 'turn_started', conversation_message_count: 0 },
      update(30, 'user_message_chunk', { content: { type: 'text', text: 'new request' } }),
      update(31, 'agent_message_chunk', { content: { type: 'text', text: 'new reply' } }),
      update(32, 'turn_completed'),
    ),
  });
  assert.deepEqual(
    result.messages.map((message) => message.createdAt),
    [30, 31].map(at),
  );
  assert.deepEqual(
    result.messages.map((message) => message.timestampKind),
    ['exact', 'exact'],
  );
  assert.doesNotMatch(JSON.stringify(result), /old request|old reply|private compaction/);
});

test('unobserved content uses labeled chronology bounds without inventing exact wall times', () => {
  const history = jsonl(
    { type: 'user', content: 'unobserved old message' },
    { type: 'assistant', content: 'observed answer' },
    { type: 'user', content: 'unobserved later message' },
  );
  const result = grokHistoryMessages(history, {
    updates: jsonl(update(20, 'agent_message_chunk', { content: { type: 'text', text: 'observed answer' } })),
    sessionCreatedAt: at(10),
    sessionUpdatedAt: at(30),
  });
  assert.deepEqual(
    result.messages.map((message) => message.createdAt),
    [10, 20, 20].map(at),
  );
  assert.deepEqual(
    result.messages.map((message) => message.timestampKind),
    ['fallback', 'exact', 'fallback'],
  );
  assert.equal(grokHistoryMessages(history).messages[0]!.createdAt, undefined);
  assert.equal(grokHistoryMessages(history).messages[0]!.timestampKind, 'unknown');
  const nearMatch = grokHistoryMessages(jsonl({ type: 'user', content: 'Exact text ' }), {
    updates: jsonl(update(10, 'user_message_chunk', { content: { type: 'text', text: 'Exact text' } })),
  });
  assert.equal(nearMatch.messages[0]!.timestampKind, 'unknown');
});

test('source identity survives line changes and incomplete history or update tails remain counted', () => {
  const row = { type: 'user', content: 'Synthetic request' };
  const original = grokHistoryMessages(jsonl(row), {
    updates: jsonl(update(100, 'user_message_chunk', { content: { type: 'text', text: 'Synthetic request' } })),
  });
  const changed = grokHistoryMessages('\n' + jsonl({ type: 'system', content: 'context' }, row) + '\n{"partial":', {
    updates:
      jsonl(update(200, 'user_message_chunk', { content: { type: 'text', text: 'Synthetic request' } })) +
      '\n{"timestamp":',
  });
  assert.equal(changed.incompleteLines, 1);
  assert.equal(changed.incompleteUpdateLines, 1);
  assert.equal(changed.messages[0]!.line, 2);
  assert.equal(changed.messages[0]!.sourceKey, original.messages[0]!.sourceKey);
  assert.notEqual(changed.messages[0]!.createdAt, original.messages[0]!.createdAt);
});

test('nested tool metadata excludes private reasoning and malformed content blocks', () => {
  const history = jsonl({
    type: 'assistant',
    content: [null, { type: 'text', text: 'Visible answer' }, { type: 'thought', text: 'private block' }],
    tool_calls: [
      {
        id: 'fixture-tool',
        name: 'read',
        encrypted_content: 'private cipher',
        reasoning: 'private reasoning',
        content: [
          { type: 'text', text: 'visible tool metadata' },
          { type: 'reasoning', text: 'private tool block' },
        ],
      },
    ],
  });
  const result = grokHistoryMessages(history, {
    updates: jsonl(update(10, 'agent_thought_chunk', { content: { type: 'text', text: 'Visible answer' } })),
  });
  assert.equal(result.messages[0]!.timestampKind, 'unknown');
  assert.match(result.messages[0]!.content, /Visible answer|visible tool metadata/);
  assert.doesNotMatch(JSON.stringify(result), /private block|private cipher|private reasoning|private tool block/);
});

test('selected conversation can load older messages beyond the recent global and previous 300-message windows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs(id TEXT,value TEXT)');
  const store = new WorkspaceStore(db);
  try {
    for (let i = 0; i < 1100; i++)
      store.save('message', 'fixture-' + i, 'conversation', {
        id: 'fixture-' + i,
        conversationId: 'conversation',
        role: 'user',
        content: 'Synthetic ' + i,
        createdAt: new Date(1000000 + i).toISOString(),
      });
    assert.equal(store.messages().length, 1000);
    assert.equal(store.messages('conversation').length, 300);
    assert.equal(store.allMessages('conversation').length, 1100);
    assert.equal(store.allMessages('conversation')[0]?.content, 'Synthetic 0');
  } finally {
    db.close();
  }
});
