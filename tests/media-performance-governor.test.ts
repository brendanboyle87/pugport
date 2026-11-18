import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MediaPerformanceGovernor,
  type MediaResourceSample,
  type MediaStagingPressure,
} from '../src/server/media-performance-governor.ts';

const GIB = 1024 ** 3;
function fixture(
  t: { after(callback: () => void): void },
  options: { initialBudget?: number; initialSample?: MediaResourceSample } = {},
) {
  let time = 1_000_000;
  let resources: MediaResourceSample = options.initialSample ?? {
    cpuPercent: 60,
    freeMemoryBytes: 1.3 * GIB,
    totalMemoryBytes: 32 * GIB,
  };
  let pressure: MediaStagingPressure | undefined;
  const governor = new MediaPerformanceGovernor({
    baseFrameReaders: 4,
    maxAssistants: 2,
    autoSample: false,
    initialBudget: options.initialBudget,
    sample: () => resources,
    now: () => time,
    pressure: () => pressure,
  });
  t.after(() => governor.close());
  return {
    governor,
    tick(milliseconds = 5000) {
      time += milliseconds;
      governor.sampleNow();
    },
    resources(next: MediaResourceSample) {
      resources = next;
    },
    pressure(next: MediaStagingPressure) {
      pressure = next;
    },
  };
}

test('healthy but 96% memory usage starts one assistant and cautiously expands after stable samples', (t) => {
  const f = fixture(t);
  assert.equal(f.governor.snapshot().assistBudget, 1);
  assert.ok(f.governor.snapshot().memoryPercent > 95);
  for (let i = 0; i < 3; i++) f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 1, 'cooldown prevents immediate expansion');
  f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 2);
  assert.equal(f.governor.snapshot().activeFrameReadLimit, 6);
});

test('pressure reduces future permits without aborting active work and recovers with hysteresis', async (t) => {
  const f = fixture(t, { initialBudget: 2 });
  const signal = new AbortController().signal;
  const one = await f.governor.acquire(signal, () => false),
    two = await f.governor.acquire(signal, () => false);
  assert.ok(one && two);
  f.resources({ cpuPercent: 96, freeMemoryBytes: 1.3 * GIB, totalMemoryBytes: 32 * GIB });
  f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 1);
  let nextStarted = false;
  const next = f.governor
    .acquire(signal, () => false)
    .then((permit) => {
      nextStarted = true;
      return permit;
    });
  one!();
  await Promise.resolve();
  assert.equal(nextStarted, false, 'existing second permit remains valid despite the lower budget');
  two!();
  const third = await next;
  assert.ok(third);
  third!();
  f.resources({ cpuPercent: 65, freeMemoryBytes: 1.3 * GIB, totalMemoryBytes: 32 * GIB });
  for (let i = 0; i < 3; i++) f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 1);
  f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 2);
});

test('critical free memory parks helpers; empty queues and cancellation wake them without timer polling', async (t) => {
  const f = fixture(t, {
    initialSample: { cpuPercent: 65, freeMemoryBytes: 512 * 1024 ** 2, totalMemoryBytes: 32 * GIB },
  });
  assert.equal(f.governor.snapshot().assistBudget, 0);
  let empty = false;
  const first = f.governor.acquire(new AbortController().signal, () => empty);
  empty = true;
  f.governor.notifyQueueChanged();
  assert.equal(await first, undefined);
  const abort = new AbortController();
  const cancelled = f.governor.acquire(abort.signal, () => false);
  abort.abort(new Error('stop parked helper'));
  await assert.rejects(cancelled, /stop parked helper/);
});

test('persistently queued SSD copies cap assistance while brief single-copy traffic does not flap it', (t) => {
  const f = fixture(t, { initialBudget: 2 });
  f.pressure({
    copying: true,
    pendingPairs: 3,
    activePairs: 4,
    usedBytes: GIB,
    maxBytes: 8 * GIB,
    copyBytes: 0,
    copyMilliseconds: 0,
  });
  f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 2);
  f.pressure({
    copying: true,
    pendingPairs: 3,
    activePairs: 4,
    usedBytes: 2 * GIB,
    maxBytes: 8 * GIB,
    copyBytes: 512 * 1024 ** 2,
    copyMilliseconds: 5000,
  });
  f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 1);
  assert.equal(f.governor.snapshot().reason, 'staging-pressure');
  assert.ok(Math.abs(f.governor.snapshot().staging!.copyMegabytesPerSecond! - 102.4) < 0.0001);
});

test('only enough matching fresh work can detect consecutive throughput regression and lower an experiment', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.governor.recordFreshCompletion('video:long:large:three-offsets');
  f.tick(5000);
  f.tick(5000);
  f.tick(10000);
  assert.equal(f.governor.snapshot().assistBudget, 2);
  for (let i = 0; i < 6; i++) f.governor.recordFreshCompletion('video:long:large:three-offsets');
  f.tick(30000);
  assert.equal(f.governor.snapshot().assistBudget, 2, 'one noisy window is not enough');
  assert.equal(f.governor.snapshot().throughputComparable, true);
  for (let i = 0; i < 6; i++) f.governor.recordFreshCompletion('video:long:large:three-offsets');
  f.tick(30000);
  assert.equal(f.governor.snapshot().assistBudget, 1);
  assert.equal(f.governor.snapshot().reason, 'throughput-regression');
  for (let i = 0; i < 10; i++) f.tick();
  assert.equal(f.governor.snapshot().assistBudget, 1, 'throughput cooldown prevents repeated increase/decrease');
});

test('different work buckets and sparse samples cannot claim throughput regression', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.governor.recordFreshCompletion('images:small');
  f.tick(5000);
  f.tick(5000);
  f.tick(10000);
  for (let i = 0; i < 6; i++) f.governor.recordFreshCompletion('video:large');
  f.tick(30000);
  for (let i = 0; i < 2; i++) f.governor.recordFreshCompletion('images:small');
  f.tick(30000);
  assert.equal(f.governor.snapshot().assistBudget, 2);
  assert.equal(f.governor.snapshot().throughputComparable, false);
});

test('common image buckets mixed with expensive different work cannot falsely claim throughput regression', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.governor.recordFreshCompletion('images:small');
  f.tick(5000);
  f.tick(5000);
  f.tick(10000);
  for (let window = 0; window < 2; window++) {
    for (let i = 0; i < 6; i++) f.governor.recordFreshCompletion('images:small');
    for (let i = 0; i < 20; i++) f.governor.recordFreshCompletion('video:long:large');
    f.tick(120000);
    assert.equal(f.governor.snapshot().throughputComparable, false);
  }
  assert.equal(f.governor.snapshot().assistBudget, 2);
});
