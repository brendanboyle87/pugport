import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TaskJudge, localTaskJudgment } from '../src/server/task-judgment.ts';
import { TASK_JUDGMENT_CONTRACT_VERSION } from '../src/shared/task-judgment.ts';

test('local task judgment preserves the content hash, no adopted labels and no service usage', () => {
  const content = 'Synthetic task content';
  const result = localTaskJudgment(content, 'manual-selection');
  assert.equal(result.contractVersion, TASK_JUDGMENT_CONTRACT_VERSION);
  assert.equal(result.inputHash, createHash('sha256').update(content).digest('hex'));
  assert.equal(result.source, 'local');
  assert.equal(result.status, 'skipped');
  assert.equal(result.intent, 'uncertain');
  assert.equal(result.kind, undefined);
  assert.equal(result.complexity, undefined);
  assert.equal(result.reason, 'manual-selection');
  assert.equal(result.requestAttempted, false);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
});

test('retired task judge ignores credential and transport injection for every input', async (t) => {
  let reads = 0,
    calls = 0,
    attempts = 0;
  const transport: typeof fetch = async () => {
    calls++;
    throw new Error('Synthetic request must never leave the process');
  };
  const globalFetch = t.mock.method(globalThis, 'fetch', transport);
  const judge = new TaskJudge({
    credential: () => {
      reads++;
      return 'synthetic-old-key';
    },
    fetch: transport,
    timeoutMs: 1,
  });
  for (const content of ['', 'Explain a topic.', 'Create a page.', 'x'.repeat(12001)]) {
    const result = await judge.judge(content, {
      onAttempt: () => {
        attempts++;
      },
    });
    assert.equal(result.source, 'local');
    assert.equal(result.requestAttempted, false);
    assert.equal(result.reason, content ? 'disabled' : 'empty-input');
    assert.ok(!JSON.stringify(result).includes('synthetic-old-key'));
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.equal(attempts, 0);
  assert.equal(globalFetch.mock.callCount(), 0);
});

test('an already cancelled local task judgment rejects without invoking callbacks', async () => {
  const abort = new AbortController();
  abort.abort();
  const judge = new TaskJudge({
    credential: () => {
      throw new Error('must not read');
    },
  });
  await assert.rejects(judge.judge('Synthetic task', { signal: abort.signal }), { name: 'AbortError' });
});
