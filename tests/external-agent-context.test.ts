import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packExternalContext } from '../src/server/external-agents/context-pack.ts';
import type { ConversationMessage } from '../src/shared/types.ts';
const message = (id: string, role: 'user' | 'assistant', content: string): ConversationMessage => ({
  id,
  role,
  content,
  conversationId: 'c',
  createdAt: id,
});
test('packing preserves order, skips current request and invisible records', () => {
  const rows = [
    message('1', 'user', 'old question'),
    message('2', 'assistant', 'old answer'),
    { ...message('3', 'assistant', 'secret'), replacedBy: '4' },
    { ...message('4', 'assistant', 'deleted'), deletedAt: 'now' },
    message('5', 'assistant', '排队中…'),
    message('6', 'user', 'current'),
    message('7', 'assistant', 'working'),
  ];
  assert.equal(
    packExternalContext(rows, '7', 'current'),
    '下面是这段对话前面的内容，只作背景：\n用户：old question\n助手：old answer\n\n这次的消息：\ncurrent',
  );
  assert.equal(packExternalContext(rows.slice(-2), '7', 'current'), 'current');
});
test('packing bounds history and keeps newest messages', () => {
  const rows = Array.from({ length: 20 }, (_, i) => message(String(i), 'assistant', String(i) + 'x'.repeat(2000)));
  rows.push(message('u', 'user', 'now'), message('a', 'assistant', 'waiting'));
  const packed = packExternalContext(rows, 'a', 'now');
  assert.ok(packed.length < 8100);
  assert.match(packed, /更早的内容已省略/);
  assert.match(packed, /已截断/);
  assert.match(packed, /19xxx/);
  assert.ok(!packed.includes('助手：0xxx'));
});
