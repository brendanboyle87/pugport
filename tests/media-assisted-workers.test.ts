import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaAnalysisManager, samplingTimes } from '../src/server/media-analysis.ts';
import type { MediaDecoder } from '../src/server/media-decoder.ts';
import type { MediaPerformanceOptions } from '../src/server/media-performance-governor.ts';
import { MediaWorkQueue } from '../src/server/media-work-queue.ts';

const identity = () => ({
  workerId: randomUUID(),
  accountLabel: 'Grok B',
  runtimeId: 'grok-b',
  model: 'build-fast',
  effort: 'low',
});
const signature = { hash: '0123456789abcdef', time: 0, texture: 60, colours: Array(12).fill(0.25) };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function block(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
async function fixture(
  t: { after(callback: () => Promise<void>): void },
  compareImages: NonNullable<MediaDecoder['compareImages']>,
  ioConcurrency = 2,
  performance?: MediaPerformanceOptions,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-assisted-workers-')));
  const folder = join(root, 'media');
  await mkdir(folder);
  await Promise.all(
    Array.from({ length: 12 }, (_value, index) =>
      writeFile(join(folder, `${index.toString().padStart(2, '0')}.jpg`), `synthetic${'x'.repeat(index * 11)}`),
    ),
  );
  const manager = new MediaAnalysisManager(join(root, 'data'), {
    ...(performance ? { performance } : {}),
    decoder: {
      description: 'synthetic assisted worker fixture',
      image: async () => signature,
      frame: async (_path, time) => ({ ...signature, time }),
      probe: async () => ({ duration: 120 }),
      compareImages,
    },
  });
  t.after(async () => {
    await manager.close();
    assert.ok(basename(root).startsWith('pugport-assisted-workers-'));
    await rm(root, { recursive: true, force: true });
  });
  const started = await manager.start({
    folders: [folder],
    engine: 'legacy',
    retrievalMode: 'adaptive',
    topK: 1,
    ioConcurrency,
  });
  return { manager, id: started.id, root };
}
const label = (a: string, b: string) => [basename(a), basename(b)].sort().join(':');
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('fixture condition timed out');
}

test(
  'a resource-parked helper cannot block baseline completion when the shared queue becomes empty',
  { timeout: 10000 },
  async (t) => {
    const baseline = gate();
    t.after(async () => baseline.release());
    let calls = 0;
    const f = await fixture(
      t,
      async (_a, _b, signal) => {
        calls++;
        if (calls === 1) await block(baseline.promise, signal);
        return { geometricInliers: 30 };
      },
      2,
      {
        enabled: true,
        autoSample: false,
        sample: () => ({ cpuPercent: 60, freeMemoryBytes: 512 * 1024 ** 2, totalMemoryBytes: 32 * 1024 ** 3 }),
      },
    );
    await until(() => calls === 1);
    const worker = identity();
    f.manager.attachAssistedWorker(f.id, worker);
    assert.equal(f.manager.assistedWorkerStatus(f.id, worker.workerId).status, 'waiting');
    assert.equal(f.manager.status(f.id).performance?.assistBudget, 0);
    assert.equal(f.manager.status(f.id).performance?.activeAssistedChecks, 0);
    baseline.release();
    const report = await f.manager.wait(f.id);
    assert.equal(report.status, 'completed');
    assert.equal(report.assistance?.workers[0]?.checked, 0);
    assert.equal(report.assistance?.workers[0]?.status, 'completed');
    assert.equal(calls, 11, 'parked helper never claims or checks a duplicate pair');
  },
);

test(
  'parent pause promptly wakes resource-parked helpers without needing a sampling timer',
  { timeout: 10000 },
  async (t) => {
    const held = gate();
    t.after(async () => held.release());
    let entered = false;
    const f = await fixture(
      t,
      async (_a, _b, signal) => {
        entered = true;
        await block(held.promise, signal);
        return { geometricInliers: 30 };
      },
      2,
      {
        enabled: true,
        autoSample: false,
        sample: () => ({ cpuPercent: 60, freeMemoryBytes: 512 * 1024 ** 2, totalMemoryBytes: 32 * 1024 ** 3 }),
      },
    );
    await until(() => entered);
    const worker = identity();
    f.manager.attachAssistedWorker(f.id, worker);
    assert.equal(f.manager.assistedWorkerStatus(f.id, worker.workerId).status, 'waiting');
    f.manager.pause(f.id);
    const report = await f.manager.wait(f.id);
    assert.equal(report.status, 'interrupted');
    assert.equal(report.assistance?.workers[0]?.status, 'interrupted');
    assert.equal(report.assistance?.workers[0]?.checked, 0);
  },
);

test('released claims return once and completed claims cannot be released', () => {
  const queue = new MediaWorkQueue([0, 1, 2]);
  const tail = queue.claim('back')!;
  queue.release(tail.index);
  assert.throws(() => queue.release(tail.index), /not claimed/);
  assert.deepEqual(queue.claim('front'), tail);
  queue.complete(tail.index);
  assert.throws(() => queue.release(tail.index), /not claimed/);
  assert.equal(queue.remaining, 2);
});

test(
  'two real assisted tail workers share claims, finish exact progress, and await their in-flight evidence',
  { timeout: 10000 },
  async (t) => {
    const baseline = gate(),
      helper = gate();
    t.after(async () => {
      baseline.release();
      helper.release();
    });
    const calls: string[] = [];
    let inFlight = 0,
      peak = 0;
    const f = await fixture(t, async (a, b, signal) => {
      const at = calls.length;
      calls.push(label(a, b));
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        if (at < 3) await block(at === 0 ? baseline.promise : helper.promise, signal);
      } finally {
        inFlight--;
      }
      return { geometricInliers: 30 };
    });
    await until(() => calls.length === 1);
    const one = identity(),
      two = identity();
    assert.ok(['waiting', 'running'].includes(f.manager.attachAssistedWorker(f.id, one).status));
    assert.ok(['waiting', 'running'].includes(f.manager.attachAssistedWorker(f.id, two).status));
    assert.equal(f.manager.attachAssistedWorker(f.id, one).workerId, one.workerId, 'retry is idempotent');
    assert.throws(
      () => f.manager.attachAssistedWorker(f.id, { ...one, runtimeId: 'another-account' }),
      /cannot change/,
    );
    assert.throws(() => f.manager.attachAssistedWorker(f.id, identity()), /capacity/);
    await until(() => calls.length === 3);
    assert.equal(peak, 3);
    baseline.release();
    await until(() => calls.length === 11);
    assert.equal(
      f.manager.status(f.id).status,
      'running',
      'all queued claims being taken does not complete in-flight helpers',
    );
    assert.ok(f.manager.status(f.id).assistance!.workers.every((entry) => entry.status === 'running'));
    helper.release();
    const report = await f.manager.wait(f.id);
    assert.equal(report.status, 'completed');
    assert.equal(new Set(calls).size, 11);
    assert.equal(calls.length, 11);
    assert.equal(report.counts.results, 11);
    assert.equal(report.steps!.find((step) => step.key === 'compare')!.done, 11);
    assert.deepEqual(
      report.assistance?.workers.map((entry) => entry.status),
      ['completed', 'completed'],
    );
    assert.equal(
      report.assistance?.workers.reduce((sum, entry) => sum + entry.checked, 0),
      2,
    );
    assert.equal(report.assistance?.baseWorkers, 1);
    assert.equal(report.assistance?.maxFrameReaders, 4);
  },
);

test(
  'stopping only one helper returns its unfinished pair and baseline finishes it once without false progress',
  { timeout: 10000 },
  async (t) => {
    const baseline = gate(),
      helper = gate();
    t.after(async () => {
      baseline.release();
      helper.release();
    });
    const calls: string[] = [],
      completed: string[] = [];
    const f = await fixture(t, async (a, b, signal) => {
      const pair = label(a, b),
        at = calls.length;
      calls.push(pair);
      if (at === 0) await block(baseline.promise, signal);
      if (at === 1) await block(helper.promise, signal);
      completed.push(pair);
      return { geometricInliers: 30 };
    });
    await until(() => calls.length === 1);
    const worker = identity();
    f.manager.attachAssistedWorker(f.id, worker);
    await until(() => calls.length === 2);
    f.manager.stopAssistedWorker(f.id, worker.workerId);
    await until(() => f.manager.assistedWorkerStatus(f.id, worker.workerId)?.status === 'stopped');
    assert.equal(f.manager.status(f.id).status, 'running');
    assert.equal(f.manager.assistedWorkerStatus(f.id, worker.workerId)?.checked, 0);
    baseline.release();
    const report = await f.manager.wait(f.id);
    assert.equal(report.status, 'completed');
    assert.equal(completed.length, 11);
    assert.equal(new Set(completed).size, 11);
    assert.equal(calls.length, 12, 'only the helper-aborted attempt is retried');
    assert.equal(report.steps!.find((step) => step.key === 'compare')!.done, 11);
    assert.equal(report.assistance?.workers[0]?.status, 'stopped');
  },
);

test(
  'a replacement helper attached during the final join is awaited before job completion',
  { timeout: 10000 },
  async (t) => {
    const baseline = gate(),
      first = gate(),
      second = gate(),
      replacement = gate();
    t.after(async () => {
      baseline.release();
      first.release();
      second.release();
      replacement.release();
    });
    let calls = 0;
    const completed: string[] = [];
    let firstTail = '',
      secondTail = '';
    const attempts = new Map<string, number>();
    const f = await fixture(t, async (a, b, signal) => {
      const at = calls++;
      const pair = label(a, b),
        attempt = (attempts.get(pair) ?? 0) + 1;
      attempts.set(pair, attempt);
      if (at === 0) await block(baseline.promise, signal);
      else if (pair === firstTail) await block(attempt === 1 ? first.promise : replacement.promise, signal);
      else if (pair === secondTail) await block(second.promise, signal);
      completed.push(label(a, b));
      return { geometricInliers: 30 };
    });
    await until(() => calls === 1);
    const db = (f.manager as unknown as { db: DatabaseSync }).db;
    const rows = db.prepare('SELECT path FROM files WHERE job=? ORDER BY id').all(f.id) as Array<{ path: string }>;
    firstTail = label(rows[0]!.path, rows.at(-1)!.path);
    secondTail = label(rows[0]!.path, rows.at(-2)!.path);
    const one = identity(),
      two = identity(),
      three = identity();
    f.manager.attachAssistedWorker(f.id, one);
    f.manager.attachAssistedWorker(f.id, two);
    await until(() => calls === 3);
    baseline.release();
    await until(() => calls === 11);
    await until(() => f.manager.status(f.id).steps?.find((step) => step.key === 'compare')?.done === 9);
    f.manager.stopAssistedWorker(f.id, one.workerId);
    await until(() => f.manager.assistedWorkerStatus(f.id, one.workerId).status === 'stopped');
    f.manager.attachAssistedWorker(f.id, three);
    await until(() => calls === 12);
    second.release();
    await until(() => f.manager.assistedWorkerStatus(f.id, two.workerId).status === 'completed');
    await delay(10);
    assert.equal(f.manager.status(f.id).status, 'running', 'the late attached replacement is still in flight');
    replacement.release();
    const report = await f.manager.wait(f.id);
    assert.equal(report.status, 'completed');
    assert.equal(new Set(completed).size, 11);
    assert.equal(completed.length, 11);
    assert.equal(report.assistance?.workers[2]?.checked, 1);
  },
);

test(
  'parent pause interrupts all helpers without publishing checks and restores their durable interrupted status',
  { timeout: 10000 },
  async (t) => {
    const held = gate();
    t.after(async () => held.release());
    let calls = 0;
    const f = await fixture(t, async (_a, _b, signal) => {
      calls++;
      await block(held.promise, signal);
      return { geometricInliers: 30 };
    });
    await until(() => calls === 1);
    const worker = identity();
    f.manager.attachAssistedWorker(f.id, worker);
    await until(() => calls === 2);
    f.manager.pause(f.id);
    const report = await f.manager.wait(f.id);
    assert.equal(report.status, 'interrupted');
    assert.equal(report.counts.results, 0);
    assert.equal(report.assistance?.workers[0]?.status, 'interrupted');
    const db = (f.manager as unknown as { db: DatabaseSync }).db;
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM pair_checks WHERE job=?').get(f.id) as { count: number }).count,
      0,
    );
    assert.throws(() => f.manager.attachAssistedWorker(f.id, identity()), /not ready/);
    // Model a crash between the explicit pause write and the helper's final status write.
    const row = db.prepare('SELECT audit FROM jobs WHERE id=?').get(f.id) as { audit: string };
    const audit = JSON.parse(row.audit);
    audit.assistance.workers[0].status = 'running';
    audit.assistance.workers[0].activePair = 11;
    db.prepare('UPDATE jobs SET audit=? WHERE id=?').run(JSON.stringify(audit), f.id);
    await f.manager.close();
    const restored = new MediaAnalysisManager(join(f.root, 'data'), { staging: false });
    try {
      assert.equal(restored.assistedWorkerStatus(f.id, worker.workerId)?.status, 'interrupted');
      assert.equal(restored.assistedWorkerStatus(f.id, worker.workerId).activePair, undefined);
      assert.equal(restored.status(f.id).status, 'interrupted');
    } finally {
      await restored.close();
    }
  },
);

test(
  'stopping a staged video helper retries its pair without consuming other cache references',
  { timeout: 10000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-assisted-workers-video-')));
    const sources = join(root, 'media'),
      cacheRoot = join(root, 'cache');
    await mkdir(sources);
    await mkdir(cacheRoot);
    const files = Array.from({ length: 5 }, (_value, index) => join(sources, `${index}.mp4`));
    await Promise.all(files.map((file, index) => writeFile(file, `synthetic-video${'x'.repeat(index * 23)}`)));
    const held = gate(),
      baseline = gate();
    let manager!: MediaAnalysisManager;
    t.after(async () => {
      held.release();
      baseline.release();
      await manager?.close();
      assert.ok(basename(root).startsWith('pugport-assisted-workers-video-'));
      await rm(root, { recursive: true, force: true });
    });
    let alignedCalls = 0,
      baselineBlocked = 0,
      helperEntered = false;
    const duration = 120;
    const coarseTimes = [0, 5, 9, 14, 18, 23].map((index) => samplingTimes(duration)[index]!);
    manager = new MediaAnalysisManager(join(root, 'data'), {
      staging: { cacheRoot, minFreeBytes: 0 },
      decoder: {
        description: 'staged assistant abort integration',
        image: async () => signature,
        probe: async () => ({ duration }),
        frame: async (_file, time, signal) => {
          const coarse = coarseTimes.some((known) => Math.abs(known - time) < 0.000001);
          if (!coarse) {
            alignedCalls++;
            // The baseline reads both sources of a position in parallel. Its first aligned position completes:
            // a helper pair sharing a staged source then hits the frame cache there instead of joining the
            // baseline's blocked single-flight read, and reaches its own decoder call on its other source.
            if (alignedCalls > 2 && alignedCalls <= 4) {
              baselineBlocked++;
              await block(baseline.promise, signal);
            } else if (alignedCalls > 4 && !helperEntered) {
              helperEntered = true;
              await block(held.promise, signal);
            }
          }
          return { ...signature, time, hash: createHash('sha256').update(`${time}`).digest('hex').slice(0, 16) };
        },
      },
    });
    const started = await manager.start({
      folders: [sources],
      engine: 'legacy',
      retrievalMode: 'adaptive',
      topK: 1,
      ioConcurrency: 2,
    });
    await until(() => baselineBlocked === 2);
    const worker = identity();
    manager.attachAssistedWorker(started.id, worker);
    await until(() => helperEntered);
    manager.stopAssistedWorker(started.id, worker.workerId);
    await until(() => manager.assistedWorkerStatus(started.id, worker.workerId).status === 'stopped');
    baseline.release();
    const result = await manager.wait(started.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.assistance?.workers[0]?.checked, 0);
    assert.equal(result.steps!.find((step) => step.key === 'compare')!.done, 4);
    assert.equal(result.counts.results, 4, 'all the fixed checks complete despite one helper being stopped');
    assert.deepEqual(
      await readdir(join(cacheRoot, started.id)),
      [],
      'the shared staging owner waits for every verifier and cleans its namespace',
    );
    for (const [index, file] of files.entries())
      assert.equal(await readFile(file, 'utf8'), `synthetic-video${'x'.repeat(index * 23)}`);
  },
);

test(
  'eight existing frame readers leave no extra assisted reader capacity',
  { timeout: 10000, skip: availableParallelism() < 12 },
  async (t) => {
    const held = gate();
    t.after(async () => held.release());
    let calls = 0;
    const f = await fixture(
      t,
      async (_a, _b, signal) => {
        calls++;
        await block(held.promise, signal);
        return { geometricInliers: 30 };
      },
      8,
    );
    await until(() => calls === 4);
    assert.equal(f.manager.status(f.id).assistance?.maxWorkers, 0);
    assert.equal(f.manager.status(f.id).assistance?.maxFrameReaders, 8);
    assert.throws(() => f.manager.attachAssistedWorker(f.id, identity()), /capacity/);
    f.manager.pause(f.id);
    assert.equal((await f.manager.wait(f.id)).status, 'interrupted');
  },
);
