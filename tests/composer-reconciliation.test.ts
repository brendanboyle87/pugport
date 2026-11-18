import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerMessageKey, mergePendingMessages, type PendingComposerSend } from '../src/ui/composer-session.ts';
import type { ConversationMessage } from '../src/shared/types.ts';
const stamp = '2026-10-05T12:00:00Z';
const pending = (id: string): PendingComposerSend => ({
  id,
  scope: 'conversation:chat',
  conversationId: 'chat',
  content: 'Same text',
  images: [],
  quotes: [{ text: 'Quoted text', note: 'My note' }],
  sentAt: stamp,
  snapshot: { content: 'Same text', attachments: [] },
});
const saved = (id: string, clientMessageId: string): ConversationMessage => ({
  id,
  clientMessageId,
  conversationId: 'chat',
  role: 'user',
  content: 'Same text',
  quotes: pending('x').quotes,
  createdAt: stamp,
});
test('SSE before ACK replaces only the exact optimistic request, even with identical text', () => {
  const first = pending('request-a'),
    second = pending('request-b'),
    real = saved('saved-a', 'request-a');
  const optimistic = mergePendingMessages([], [first])[0]!;
  const result = mergePendingMessages([real], [first, second]);
  assert.equal(result.length, 2);
  assert.equal(result[0], real);
  assert.equal(result[1]!.clientMessageId, 'request-b');
  assert.equal(composerMessageKey(optimistic), composerMessageKey(real));
  assert.deepEqual(result[0]!.quotes, first.quotes);
});
test('ACK before SSE keeps one confirmed message with the same stable key', () => {
  const item = pending('request'),
    real = saved('server', 'request');
  const before = mergePendingMessages([], [item])[0]!;
  item.messageId = real.id;
  item.confirmedMessage = real;
  assert.deepEqual(mergePendingMessages([], [item]), [real]);
  assert.deepEqual(mergePendingMessages([real], [item]), [real]);
  assert.equal(composerMessageKey(before), composerMessageKey(real));
});
test('a failed optimistic message remains recoverable and cannot swallow an unrelated identical message', () => {
  const item = { ...pending('failed'), error: 'Rejected' };
  const result = mergePendingMessages([saved('other', 'other-request')], [item]);
  assert.equal(result.length, 2);
  assert.equal(result[1]!.id, 'pending:failed');
  assert.equal(result[1]!.clientMessageId, 'failed');
});
