import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexOutput, codexItemLimit } from '../src/server/adapters/codex-output.ts';
import { runOutputLimit } from '../src/shared/run-output.ts';
import { parseTaskOutcome } from '../src/server/task-outcome.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import { syntheticCodex, type CodexScript } from './helpers/codex-rpc.ts';

test('output buffers and de-duplication metadata remain bounded across thousands of completed messages', () => {
  const output = new CodexOutput();
  for (let index = 0; index < 10_000; index++) {
    const text = `message-${index}:` + '界'.repeat(500);
    assert.equal(output.delta(String(index), text), true);
    assert.equal(output.complete(String(index), text), '');
    assert.equal(output.delta(String(index), 'duplicate'), false);
    assert.equal(output.complete(String(index), text), '');
    assert.ok(output.chars + 2 * (output.messages.size - 1) <= runOutputLimit);
    assert.ok(output.completedItems.size <= codexItemLimit);
    assert.equal(output.activeLengths.size, 0);
  }
  assert.ok(output.output().endsWith('界'.repeat(500)));
});

test('huge streamed message emits only its completion suffix and preserves the final result marker', () => {
  const output = new CodexOutput();
  const chunk = '界'.repeat(200_000);
  for (let index = 0; index < 60; index++) output.delta('long', chunk);
  const marker = '\nFinal reply.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Synthetic result"}';
  assert.equal(output.complete('long', chunk.repeat(60) + marker), marker);
  assert.equal(output.output().length, runOutputLimit);
  assert.equal(parseTaskOutcome(output.output()).outcome.status, 'completed');
  assert.ok(parseTaskOutcome(output.output()).output.endsWith('Final reply.'));
});

test('real Codex adapter processes a huge synthetic RPC run and returns its bounded final reply', async () => {
  const prefix: NonNullable<CodexScript['prefix']> = Array.from({ length: 100 }, (_, index) => ({
    method: 'item/completed',
    params: { item: { id: `message-${index}`, type: 'agentMessage', text: '界'.repeat(40_000) } },
  }));
  prefix.push({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'x'.repeat(2_000_000) } });
  const final = '\nFinal reply\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Synthetic run"}';
  let emitted = 0;
  const ctx: ExecuteContext = {
    target: {
      id: 'memory-fixture',
      provider: 'codex',
      label: 'Synthetic',
      command: 'unused',
      environment: 'native',
      enabled: true,
    },
    input: { prompt: 'Synthetic', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: 'memory-fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: (event) => {
      if (event.type === 'text') emitted += event.text?.length ?? 0;
    },
    approve: async () => false,
  };
  const result = await syntheticCodex({ prefix, result: 'x'.repeat(2_000_000) + final }).execute(ctx);
  assert.equal(result.output.length, runOutputLimit);
  assert.equal(emitted, 6_000_000 + final.length);
  assert.equal(parseTaskOutcome(result.output).outcome.status, 'completed');
  assert.ok(parseTaskOutcome(result.output).output.endsWith('Final reply'));
});

test('completed diffs are released, pending approval details have a byte budget, and small diffs are preserved', async () => {
  const change = (id: string, diff: string) => ({
    method: 'item/started',
    params: {
      item: { id, type: 'fileChange', changes: [{ path: 'synthetic.txt', diff }] },
    },
  });
  for (const mode of ['completed', 'evicted', 'small'] as const) {
    const prefix: NonNullable<CodexScript['prefix']> = [change('old', '+SYNTHETIC_DIFF')];
    if (mode === 'completed')
      prefix.push({ method: 'item/completed', params: { item: { id: 'old', type: 'fileChange' } } });
    if (mode === 'evicted') {
      for (let index = 0; index < 100; index++) prefix.push(change(`new-${index}`, 'x'.repeat(100_000)));
    }
    let description = '';
    const ctx: ExecuteContext = {
      target: {
        id: 'diff-fixture',
        provider: 'codex',
        label: 'Synthetic',
        command: 'unused',
        environment: 'native',
        enabled: true,
      },
      input: { prompt: 'Synthetic', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
      route: { runtimeId: 'diff-fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
      signal: new AbortController().signal,
      emit: () => {},
      approve: async (_tool, detail) => {
        description = detail;
        return false;
      },
    };
    await syntheticCodex({ prefix, approval: true, approvalItemId: 'old' }).execute(ctx);
    if (mode === 'small') assert.match(description, /SYNTHETIC_DIFF/);
    else assert.doesNotMatch(description, /SYNTHETIC_DIFF/);
  }
});

test('active streaming offsets also have a fixed capacity', () => {
  const output = new CodexOutput();
  for (let index = 0; index < 10_000; index++) output.delta(`active-${index}`, 'text');
  assert.equal(output.activeLengths.size, codexItemLimit);
  assert.ok(output.messages.size <= codexItemLimit);
});
