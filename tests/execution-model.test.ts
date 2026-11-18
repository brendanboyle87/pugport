import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionModel, replayModelSelection } from '../src/shared/execution-model.ts';
import type { EffectiveModelSelection, RunRecord } from '../src/shared/types.ts';

test('Cursor replay preserves confirmed thinking, fast and effort without changing canonical display metadata', () => {
  for (const thinking of [true, false]) {
    for (const fast of [true, false]) {
      const effectiveModel: EffectiveModelSelection = {
        model: 'claude-opus-5',
        effort: 'high',
        parameters: { thinking: String(thinking), fast: String(fast), reasoning: 'high' },
        source: 'fixture',
      };
      const before = structuredClone(effectiveModel);
      const replay = replayModelSelection('cursor', effectiveModel);
      assert.deepEqual(replay, {
        model: `claude-opus-5${thinking ? '-thinking' : ''}-high${fast ? '-fast' : ''}`,
        effort: 'high',
      });
      assert.deepEqual(effectiveModel, before);
      const run = { route: { model: 'requested-model' }, effectiveModel } as RunRecord;
      assert.equal(executionModel(run).model, 'claude-opus-5');
    }
  }
});

test('Cursor explicit false flags remove stale variant flags and normalize extra-high', () => {
  assert.deepEqual(
    replayModelSelection('cursor', {
      model: 'claude-opus-5-thinking-high-fast',
      effort: 'extra-high',
      parameters: { thinking: 'false', fast: 'false' },
    }),
    { model: 'claude-opus-5-xhigh', effort: 'xhigh' },
  );
});

test('unconfirmed selections and non-Cursor providers retain their original model choice', () => {
  assert.deepEqual(replayModelSelection('cursor', { model: 'claude-opus-5', effort: 'high' }), {
    model: 'claude-opus-5',
    effort: 'high',
  });
  assert.deepEqual(
    replayModelSelection('cursor', { model: 'claude-opus-5', effort: 'high', parameters: { fast: 'false' } }),
    { model: 'claude-opus-5', effort: 'high' },
    'Missing thinking metadata is not evidence that thinking was false.',
  );
  for (const provider of ['codex', 'claude', 'grok', undefined] as const)
    assert.deepEqual(
      replayModelSelection(provider, {
        model: 'native-model',
        effort: 'high',
        parameters: { thinking: 'true', fast: 'true' },
      }),
      { model: 'native-model', effort: 'high' },
    );
});
