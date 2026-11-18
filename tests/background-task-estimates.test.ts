import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundTaskEstimates } from '../src/ui/background-task-estimates.ts';
import type { BackgroundTask } from '../src/shared/types.ts';

const task = (id: string, done: number): BackgroundTask => ({
  id,
  kind: 'media-analysis',
  conversationId: 'fixture',
  title: 'Test',
  detail: '',
  state: 'running',
  done,
  total: 10000,
  startedAt: '2026-10-07T12:00:00Z',
  steps: [
    { key: 'coarse', label: '指纹', state: 'running', done, total: 10000 },
    { key: 'compare', label: '核验', state: 'pending', done: 0, total: null },
  ],
});

test('old backends get independent live estimates without borrowing a future step cost', () => {
  const model = new BackgroundTaskEstimates();
  let result: BackgroundTask[] = [];
  for (let seconds = 0; seconds <= 60; seconds += 5)
    result = model.update([task('a', 1000 + seconds * 2), task('b', 1000 + seconds)], seconds * 1000);
  assert.ok(result[0]!.remainingRange);
  assert.ok(result[1]!.remainingRange);
  assert.ok(result[0]!.remainingRange!.maxSeconds < result[1]!.remainingRange!.maxSeconds);
  assert.equal(result[0]!.estimateScope, 'current-step');
  assert.equal(result[0]!.totalRemainingRange?.maxSeconds, undefined);
  assert.equal(result[0]!.steps![1]!.remainingRange, undefined);
});

test('paused tasks clear backend ranges too, and resumed fallback starts a new speed window', () => {
  const model = new BackgroundTaskEstimates();
  for (let seconds = 0; seconds <= 60; seconds += 5) model.update([task('a', 1000 + seconds)], seconds * 1000);
  const known = {
    ...task('a', 1060),
    state: 'paused' as const,
    remainingRange: { minSeconds: 10, maxSeconds: 20 },
    steps: task('a', 1060).steps!.map((step) => ({
      ...step,
      estimateState: 'stable' as const,
      remainingRange: { minSeconds: 10, maxSeconds: 20 },
    })),
  };
  const paused = model.update([known], 3600000)[0]!;
  assert.equal(paused.remainingRange, undefined);
  assert.equal(paused.steps![0]!.remainingRange, undefined);
  assert.equal(model.update([task('a', 1061)], 3605000)[0]!.remainingRange, undefined);
});

test('unknown and newly entered phases never inherit the prior estimate; authoritative backend timing is kept', () => {
  const model = new BackgroundTaskEstimates();
  assert.equal(model.update([task('a', 1000)], 0)[0]!.remainingRange, undefined);
  assert.equal(model.update([{ ...task('a', 1000), remainingSeconds: 669 * 3600 }], 0)[0]!.remainingSeconds, undefined);
  for (let seconds = 5; seconds <= 60; seconds += 5) model.update([task('a', 1000 + seconds)], seconds * 1000);
  const phase: BackgroundTask = {
    ...task('a', 1060),
    steps: [
      { key: 'coarse', label: '指纹', state: 'done', done: 10000, total: 10000 },
      { key: 'compare', label: '核验', state: 'running', done: 0, total: 100 },
    ],
  };
  assert.equal(model.update([phase], 65000)[0]!.remainingRange, undefined);
  const fromServer = {
    ...phase,
    remainingRange: { minSeconds: 30, maxSeconds: 40 },
    estimateScope: 'whole-task' as const,
  };
  assert.equal(
    model.update([fromServer], 70000)[0]!.remainingRange,
    undefined,
    'a media comparison cannot trust a cache-inflated server ETA without fresh-work measurements',
  );
  const coarseServer = { ...task('a', 2000), remainingRange: fromServer.remainingRange };
  assert.equal(model.update([coarseServer], 71000)[0], coarseServer);
  model.update([], 75000);
  assert.equal(model.update([task('a', 1000)], 80000)[0]!.remainingRange, undefined);
});

function comparison(done: number, fresh: number): BackgroundTask {
  return {
    ...task('fresh', done),
    total: 1000,
    remainingSeconds: 25,
    remainingRange: { minSeconds: 20, maxSeconds: 30 },
    totalRemainingRange: { minSeconds: 20, maxSeconds: 30 },
    performance: {
      observedAt: '2026-10-08T04:00:00Z',
      memoryPercent: 90,
      freeMemoryBytes: 3 * 1024 ** 3,
      assistBudget: 1,
      maxAssistants: 2,
      activeAssistedChecks: 1,
      activeFrameReadLimit: 5,
      reason: 'balanced',
      freshCompleted: fresh,
      throughputComparable: false,
    },
    steps: [
      {
        key: 'compare',
        label: '核验',
        state: 'running',
        done,
        total: 1000,
        estimateState: 'stable',
        remainingRange: { minSeconds: 20, maxSeconds: 30 },
      },
    ],
  };
}

test('cached pair replay advances visible progress without creating a comparison ETA', () => {
  const model = new BackgroundTaskEstimates();
  let result: BackgroundTask | undefined;
  for (let seconds = 0; seconds <= 120; seconds += 5)
    result = model.update([comparison(300 + seconds, 0)], seconds * 1000)[0];
  assert.equal(result!.done, 420);
  assert.equal(result!.remainingSeconds, undefined);
  assert.equal(result!.remainingRange, undefined);
  assert.equal(result!.totalRemainingRange, undefined);
  assert.equal(result!.steps![0]!.remainingRange, undefined);
});

test('only fresh checks estimate comparison cost and later cache reuse resets that sample', () => {
  const model = new BackgroundTaskEstimates();
  let result: BackgroundTask | undefined;
  for (let seconds = 0; seconds <= 120; seconds += 5)
    result = model.update([comparison(300 + seconds, seconds)], seconds * 1000)[0];
  assert.ok(result!.remainingRange);
  assert.ok(result!.remainingRange!.minSeconds > 300, 'must ignore the supplied 20–30 second cached ETA');
  assert.equal(result!.estimateScope, 'current-step', 'pair verification is not all classification/recycling');
  assert.equal(model.update([comparison(620, 120)], 125000)[0]!.remainingRange, undefined);
});

test('wildly variable resumed cache speed hides a misleading hours-wide range until it becomes useful', () => {
  const model = new BackgroundTaskEstimates();
  const range = { minSeconds: 500, maxSeconds: 17369 };
  const input = {
    ...task('a', 2088),
    remainingRange: range,
    remainingSeconds: 2000,
    steps: task('a', 2088).steps!.map((step) =>
      step.state === 'running' ? { ...step, estimateState: 'variable' as const, remainingRange: range } : step,
    ),
  };
  const output = model.update([input], 180000)[0]!;
  assert.equal(output.remainingRange, undefined);
  assert.equal(output.remainingSeconds, undefined);
  assert.equal(output.steps![0]!.remainingRange, undefined);
  const stable = { ...input, remainingRange: { minSeconds: 8000, maxSeconds: 12000 }, steps: undefined };
  assert.equal(model.update([stable], 240000)[0]!.remainingRange, stable.remainingRange);
});
