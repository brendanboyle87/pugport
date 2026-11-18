import assert from 'node:assert/strict';
import test from 'node:test';
import { withinContextBudget } from '../src/server/optional-context.ts';

test('optional context stages share one deadline and keep completed evidence', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const options = { signal: new AbortController().signal, deadline: 100 };
  const local = await withinContextBudget(
    async () => {
      now = 80;
      return 'verified local evidence';
    },
    '',
    options,
  );
  const enriched = await withinContextBudget(
    async () => {
      now = 101;
      return 'late enrichment';
    },
    local,
    options,
  );
  let laterCalls = 0;
  assert.equal(
    await withinContextBudget(
      async () => {
        laterCalls++;
        return 'should not run';
      },
      enriched,
      options,
    ),
    local,
  );
  assert.equal(laterCalls, 0);
});

test('stalled optional context is cancelled at its stage cap and cannot overwrite another request', async () => {
  let release!: (result: string) => void;
  let stageSignal!: AbortSignal;
  const options = { signal: new AbortController().signal, deadline: performance.now() + 5000, stageMs: 10 };
  const result = await withinContextBudget(
    (signal) => {
      stageSignal = signal;
      return new Promise<string>((resolve) => (release = resolve));
    },
    'retained evidence',
    options,
  );
  assert.equal(result, 'retained evidence');
  assert.equal(stageSignal.aborted, true);
  const next = await withinContextBudget(async () => 'next request', '', { ...options, stageMs: 1000 });
  release('late result');
  assert.equal(next, 'next request');
  assert.equal(result, 'retained evidence');
});

test('a late timer cannot accept a stage result past its own cap or consume the next stage budget', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const options = { signal: new AbortController().signal, deadline: 100 };
  assert.equal(
    await withinContextBudget(
      async () => {
        now = 20;
        return 'late semantic result';
      },
      '',
      { ...options, stageMs: 10 },
    ),
    '',
  );
  assert.equal(await withinContextBudget(async () => 'local history', '', options), 'local history');
});

test('caller cancellation and non-timeout errors are never treated as optional fallbacks', async () => {
  const abort = new AbortController();
  const options = { signal: abort.signal, deadline: performance.now() + 5000 };
  const pending = withinContextBudget(
    async (signal) => {
      abort.abort(new Error('user-cancelled'));
      signal.throwIfAborted();
      return 'unexpected';
    },
    'fallback',
    options,
  );
  await assert.rejects(pending, /user-cancelled/);
  let calls = 0;
  await assert.rejects(
    withinContextBudget(
      async () => {
        calls++;
        return '';
      },
      '',
      options,
    ),
    /user-cancelled/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    withinContextBudget(
      async () => {
        throw new Error('unexpected-error');
      },
      '',
      { ...options, signal: new AbortController().signal },
    ),
    /unexpected-error/,
  );
});
