import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { passagesOf, ProjectVectors } from '../src/server/memory-vectors.ts';
import { fuseHits } from '../src/server/memory-retrieval.ts';
import { encode } from '../src/server/text-embedding.ts';
import type { MemorySearchHit } from '../src/server/workspace-store.ts';

const modelDir = join(resolve(import.meta.dirname, '..'), '.runtime', 'memory-search');

test('small vector caches survive a fresh load without reading unrelated Buffer pool bytes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'comborunner-vector-roundtrip-'));
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_VECTORS_DIR: root });
  try {
    for (const count of [1, 3, 8]) {
      const items = Array.from({ length: count }, (_, n) => ({ messageId: `m${n}`, offset: n * 600, hash: `h${n}` }));
      const vectors = items.map((_, n) => Int8Array.from({ length: 1024 }, (_, i) => ((i + n) % 255) - 128));
      const original = await ProjectVectors.open(`project-${count}`);
      original.replace(items, vectors);
      await original.save();
      const reloaded = await ProjectVectors.open(`project-${count}`);
      assert.deepEqual(reloaded.items, items);
      assert.deepEqual(reloaded.vectors, vectors);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'the bge-m3 tokenizer matches the reference ids',
  { skip: !existsSync(join(modelDir, 'tokenizer.json')) && 'model not set up' },
  () => {
    // Reference: Hugging Face tokenizers on Xenova/bge-m3's tokenizer.json.
    assert.deepEqual(
      encode(modelDir, '上次那个打包报错怎么解决的？'),
      [0, 6, 128509, 21169, 2554, 5702, 9001, 41782, 12082, 14183, 43, 32, 2],
    );
    assert.deepEqual(
      encode(modelDir, 'build 失败：npm run package:desktop'),
      [0, 45367, 6, 84706, 12, 19, 26822, 11675, 98169, 12, 133850, 13784, 2],
    );
    assert.equal(encode(modelDir, '很长的句子'.repeat(200), 64).length, 64);
  },
);

test('only what people wrote is embedded: tool output skipped, tool calls cut, wrappers removed', () => {
  assert.deepEqual(passagesOf('工具结果（历史记录）： exit 0\nfile list…'), []);
  const reply = passagesOf('先对一下时长和画面。 工具调用（历史记录，未执行）： ```json [{"id":"call-1"}]```');
  assert.deepEqual(reply, [{ offset: 0, text: '先对一下时长和画面。' }]);
  const wrapped =
    'The user sent a message while you were working: <user_query> 913 的文件不要动 </user_query> If the user…';
  const [passage] = passagesOf(wrapped);
  assert.equal(passage?.text, '913 的文件不要动');
  assert.equal(wrapped.slice(passage!.offset).trim().startsWith('913'), true, 'offsets point into the original');
  assert.deepEqual(passagesOf('好'), []);
  // Long messages contribute their first three passages.
  assert.equal(passagesOf('字'.repeat(10_000)).length, 3);
});

test('keyword and meaning hits are fused by rank, one per message', () => {
  const hit = (messageId: string): MemorySearchHit => ({
    messageId,
    conversationId: 'c',
    role: 'assistant',
    createdAt: '2026-01-01',
    excerpt: messageId,
    sourceOffset: 0,
    score: 1,
  });
  const fused = fuseHits([hit('a'), hit('b'), hit('c')], [hit('d'), hit('b')], 3);
  // "b" is in both lists, so it rises to the top; then the two first-ranked ones.
  assert.deepEqual(
    fused.map((item) => item.messageId),
    ['b', 'a', 'd'],
  );
});
