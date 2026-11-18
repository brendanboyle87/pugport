import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgressEstimateTracker } from '../src/shared/progress-estimate.ts';

function progress(
  tracker: ProgressEstimateTracker,
  key: string,
  start: number,
  total: number,
  from = 0,
  rate = 10,
  seconds = 60,
) {
  tracker.observe(key, start, total, from);
  for (let at = 5; at <= seconds; at += 5) tracker.observe(key, start + at * rate, total, from + at * 1000);
  return tracker.estimate(key, from + seconds * 1000);
}

test('a few long videos cannot extrapolate a mixed drive to hundreds of hours', () => {
  const tracker = new ProgressEstimateTracker();
  tracker.observe('coarse', 0, 12958, 0);
  for (let index = 1; index <= 5; index++) tracker.observe('coarse', index, 12958, index * 186_000);
  const value = tracker.estimate('coarse', 930_000);
  assert.equal(value.estimateState, 'learning');
  assert.equal(value.remainingSeconds, undefined);
  assert.equal(value.remainingRange, undefined);
});

test('a representative recent coarse window supplies a bounded range and midpoint after one minute', () => {
  const estimate = progress(new ProgressEstimateTracker(), 'coarse', 0, 12958);
  assert.equal(estimate.elapsedSeconds, 60);
  assert.equal(estimate.estimateState, 'stable');
  assert.equal(estimate.remainingSeconds, 1236);
  assert.deepEqual(estimate.remainingRange, { minSeconds: 1029, maxSeconds: 1545 });
});

test('opening a progress view midway uses cumulative coverage and twenty new samples, not another 3% of the library', () => {
  const estimate = progress(new ProgressEstimateTracker(), 'coarse', 1055, 12948, 0, 1);
  assert.equal(estimate.estimateState, 'stable');
  assert.ok(estimate.remainingRange);
  assert.equal(estimate.remainingSeconds, 11833);
});

test('variable batches widen the estimate rather than displaying the first file pace as a precise deadline', () => {
  const tracker = new ProgressEstimateTracker();
  tracker.observe('coarse', 0, 1000, 0);
  for (let at = 5; at <= 60; at += 5) tracker.observe('coarse', Math.floor(at / 10) * 100, 1000, at * 1000);
  const estimate = tracker.estimate('coarse', 60_000);
  assert.equal(estimate.estimateState, 'variable');
  assert.ok(estimate.remainingRange!.maxSeconds > estimate.remainingRange!.minSeconds * 3);
  assert.match(estimate.estimateNote!, /差异较大/);
});

test('unknown totals and not-yet-started stages never receive invented remaining time', () => {
  const tracker = new ProgressEstimateTracker();
  tracker.observe('scan', 100, null, 0);
  tracker.observe('scan', 300, null, 60_000);
  assert.equal(tracker.estimate('scan', 60_000).estimateState, 'unknown');
  assert.equal(tracker.estimate('scan', 60_000).remainingRange, undefined);
  assert.deepEqual(tracker.estimate('compare', 60_000), { elapsedSeconds: 0, estimateState: 'unknown' });
});

test('paused elapsed time freezes, then resume retains elapsed while learning a fresh speed window', () => {
  const tracker = new ProgressEstimateTracker();
  progress(tracker, 'coarse', 500, 12948, 0, 1);
  tracker.pause(60_000);
  const paused = tracker.estimate('coarse', 3_600_000);
  assert.equal(paused.estimateState, 'paused');
  assert.equal(paused.elapsedSeconds, 60);
  assert.equal(paused.remainingRange, undefined);
  tracker.resume(3_600_000);
  assert.equal(tracker.estimate('coarse', 3_600_000).estimateState, 'learning');
  tracker.observe('coarse', 565, 12948, 3_605_000);
  assert.equal(tracker.estimate('coarse', 3_605_000).remainingRange, undefined);
  for (let at = 10; at <= 60; at += 5) tracker.observe('coarse', 560 + at, 12948, 3_600_000 + at * 1000);
  const resumed = tracker.estimate('coarse', 3_660_000);
  assert.equal(resumed.elapsedSeconds, 120);
  assert.equal(resumed.estimateState, 'stable');
});

test('stage changes and completed stages freeze their own duration and clear ETA', () => {
  const tracker = new ProgressEstimateTracker();
  tracker.observe('scan', 0, null, 0);
  tracker.observe('scan', 200, null, 10_000);
  tracker.observe('hash', 0, 50, 10_000);
  tracker.observe('hash', 50, 50, 30_000);
  tracker.observe('coarse', 0, 200, 30_000);
  tracker.observe('coarse', 100, 200, 60_000);
  assert.deepEqual(tracker.estimate('scan', 1_000_000), { elapsedSeconds: 10, estimateState: 'done' });
  assert.deepEqual(tracker.estimate('hash', 1_000_000), { elapsedSeconds: 20, estimateState: 'done' });
  tracker.finish(60_000);
  assert.deepEqual(tracker.estimate('coarse', 1_000_000), { elapsedSeconds: 30, estimateState: 'done' });
  tracker.observe('coarse', 100, 200, 1_000_000);
  assert.equal(tracker.estimate('coarse', 1_005_000).elapsedSeconds, 35);
  assert.equal(tracker.estimate('coarse', 1_005_000).estimateState, 'learning');
});

test('recent-window throughput adapts after old slow samples leave the window', () => {
  const tracker = new ProgressEstimateTracker();
  progress(tracker, 'coarse', 500, 20000, 0, 1, 180);
  const slow = tracker.estimate('coarse', 180_000).remainingSeconds!;
  for (let at = 5; at <= 190; at += 5) tracker.observe('coarse', 680 + at * 10, 20000, 180_000 + at * 1000);
  const fast = tracker.estimate('coarse', 370_000);
  assert.equal(fast.estimateState, 'stable');
  assert.ok(fast.remainingSeconds! < slow / 5);
});

test('stalled progress withdraws the countdown, and regressed progress resets the speed window', () => {
  const tracker = new ProgressEstimateTracker();
  progress(tracker, 'coarse', 500, 12948, 0, 1);
  assert.equal(tracker.estimate('coarse', 121_000).remainingRange, undefined);
  assert.equal(tracker.estimate('coarse', 121_000).estimateState, 'variable');
  tracker.observe('coarse', 200, 12948, 122_000);
  assert.equal(tracker.estimate('coarse', 122_000).remainingRange, undefined);
  assert.equal(tracker.estimate('coarse', 122_000).estimateState, 'learning');
  tracker.reset();
  assert.deepEqual(tracker.estimate('coarse', 122_000), { elapsedSeconds: 0, estimateState: 'unknown' });
});
