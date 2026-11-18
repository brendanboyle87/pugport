import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaAnalysisManager, samplingTimes } from '../src/server/media-analysis.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';
import { MediaWorkQueue } from '../src/server/media-work-queue.ts';

test('empty work queues remain exhausted regardless of claim direction', () => {
  const queue = new MediaWorkQueue<string>([]);
  assert.equal(queue.length, 0);
  assert.equal(queue.remaining, 0);
  assert.equal(queue.claim('front'), undefined);
  assert.equal(queue.claim('back'), undefined);
  assert.equal(queue.remaining, 0);
});

test('front and back claims meet once at the middle and preserve each item index', () => {
  const queue = new MediaWorkQueue(['a', 'b', 'c', 'd', 'e']);
  const directions = ['front', 'back', 'back', 'front', 'back'] as const;
  const expected = [0, 4, 3, 1, 2];
  for (const [at, direction] of directions.entries()) {
    const item = queue.claim(direction);
    assert.deepEqual(item, { index: expected[at], value: ['a', 'b', 'c', 'd', 'e'][expected[at]!] });
    assert.equal(queue.remaining, 4 - at);
  }
  assert.equal(queue.length, 5);
  assert.equal(queue.claim('front'), undefined);
  assert.equal(queue.claim('back'), undefined);
});

test('even queues cannot duplicate the last remaining item when both directions reach it', () => {
  const queue = new MediaWorkQueue([0, 1, 2, 3]);
  assert.equal(queue.claim('back')?.index, 3);
  assert.equal(queue.claim('front')?.index, 0);
  assert.equal(queue.claim('front')?.index, 1);
  assert.equal(queue.claim('back')?.index, 2);
  assert.equal(queue.remaining, 0);
  assert.equal(queue.claim('back'), undefined);
  assert.equal(queue.claim('front'), undefined);
});

test('asynchronously interleaved front and back workers each claim every item exactly once', async () => {
  const values = Array.from({ length: 53 }, (_, index) => ({ id: index }));
  const queue = new MediaWorkQueue(values);
  const counts = new Map<number, number>();
  await Promise.all(
    Array.from({ length: 7 }, async (_value, at) => {
      const direction = at % 2 === 0 ? 'front' : 'back';
      while (true) {
        const item = queue.claim(direction);
        if (!item) return;
        assert.equal(item.value, values[item.index]);
        counts.set(item.index, (counts.get(item.index) ?? 0) + 1);
        await delay(item.index % 3);
      }
    }),
  );
  assert.equal(counts.size, values.length);
  assert.ok([...counts.values()].every((count) => count === 1));
  assert.equal(queue.remaining, 0);
});

test('cached sources retrieve a distant pending pair while priority holes keep atomic direction claims intact', () => {
  const values = Array.from({ length: 80 }, (_, index) => ({
    source: index === 42 ? 'cached-long-video' : `cold-${index}`,
  }));
  const queue = new MediaWorkQueue(values, (value) => [value.source]);
  const hot = queue.claim('back', { preferredSources: ['cached-long-video'], lookahead: 2 });
  assert.equal(hot?.index, 42, 'cached input affinity reaches beyond the tail window');
  queue.complete(hot!.index);
  const seen = new Set([hot!.index]);
  let direction: 'front' | 'back' = 'front';
  for (;;) {
    const item = queue.claim(direction);
    if (!item) break;
    assert.ok(!seen.has(item.index));
    seen.add(item.index);
    queue.complete(item.index);
    direction = direction === 'front' ? 'back' : 'front';
  }
  assert.equal(seen.size, values.length);
  assert.equal(queue.remaining, 0);
});

test('priority scores choose cheap shared-source work and direction breaks equal-score ties', () => {
  const values = [{ cost: 8 }, { cost: 2 }, { cost: 2 }, { cost: 8 }];
  const score = (value: { cost: number }) => -value.cost;
  assert.equal(new MediaWorkQueue(values).claim('front', { score, lookahead: 4 })?.index, 1);
  assert.equal(new MediaWorkQueue(values).claim('back', { score, lookahead: 4 })?.index, 2);
  assert.equal(new MediaWorkQueue(values).claim('front', { score: () => NaN })?.index, 0);
  assert.equal(new MediaWorkQueue(values).claim('back', { score: () => 0 })?.index, 3);
});

test('returned affinity claims retry before fresh work and cannot be claimed by two workers', () => {
  const values = ['cold-a', 'cold-b', 'cached', 'cold-c'];
  const queue = new MediaWorkQueue(values, (source) => [source]);
  const hot = queue.claim('front', { preferredSources: ['cached'], lookahead: 1 })!;
  assert.equal(hot.index, 2);
  queue.release(hot.index);
  assert.equal(queue.remaining, 4);
  const retry = queue.claim('back', { score: () => -100 })!;
  assert.equal(retry.index, 2);
  assert.equal(queue.claim('back')!.index, 3);
  queue.complete(retry.index);
  assert.throws(() => queue.release(retry.index), /not claimed/);
  assert.throws(() => queue.complete(retry.index), /not claimed/);
});

test('priority bounds and scoring failures do not consume or orphan a pending claim', () => {
  const queue = new MediaWorkQueue([0, 1, 2]);
  for (const lookahead of [0, -1, 1.5, 1025]) assert.throws(() => queue.claim('front', { lookahead }), /lookahead/);
  assert.throws(
    () =>
      queue.claim('front', {
        score: () => {
          throw new Error('synthetic scoring failure');
        },
      }),
    /synthetic scoring failure/,
  );
  assert.equal(queue.remaining, 3);
  assert.equal(queue.claim('front')!.index, 0);
});

test('affinity scoring is bounded even when every source has many pending candidates', () => {
  const values = Array.from({ length: 5000 }, (_, index) => ({ index }));
  const queue = new MediaWorkQueue(values, () => ['common-source']);
  let scored = 0;
  const item = queue.claim('back', {
    preferredSources: ['common-source'],
    lookahead: 1,
    score: (value) => {
      scored++;
      return value.index;
    },
  });
  assert.equal(item?.index, 4999);
  assert.ok(scored <= 1024);
  assert.equal(queue.remaining, 4999);
});

const imageHash = '0123456789abcdef';
const signature = (hash: string, time = 0): FrameSignature => ({
  hash,
  time,
  texture: 60,
  colours: Array(12).fill(0.25),
});
const duration = 120;
const coarseTimes = [0, 5, 9, 14, 18, 23].map((index) => samplingTimes(duration)[index]!);
function videoFrame(path: string, time: number): FrameSignature {
  const coarse = coarseTimes.some((known) => Math.abs(known - time) < 0.00001);
  const hash = coarse
    ? createHash('sha256')
        .update(`queue-coarse:${Math.round(time * 10_000)}`)
        .digest('hex')
        .slice(0, 16)
    : basename(path).startsWith('a-')
      ? '0000000000000000'
      : 'ffffffffffffffff';
  return signature(hash, time);
}
function decoder(overrides: Partial<MediaDecoder>): MediaDecoder {
  return {
    description: 'Synthetic work queue fixtures; no real media',
    image: async () => signature(imageHash),
    probe: async () => ({ duration }),
    frame: async (path, time) => videoFrame(path, time),
    compareImages: async () => ({ geometricInliers: 30 }),
    ...overrides,
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }, includeVideos = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-work-queue-')));
  const folder = join(root, 'media');
  await mkdir(folder);
  const names = Array.from({ length: 12 }, (_, at) => `${String(at).padStart(3, '0')}.jpg`);
  if (includeVideos) names.push('a-video.mp4', 'b-video.mp4');
  await Promise.all(
    names.map((name, at) => writeFile(join(folder, name), `synthetic queue fixture:${name}:${'x'.repeat(at * 17)}`)),
  );
  const managers: MediaAnalysisManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    folder,
    make: (mock: MediaDecoder) => {
      const manager = new MediaAnalysisManager(join(root, 'data'), { decoder: mock });
      managers.push(manager);
      return manager;
    },
  };
}
const options = (folder: string) => ({
  folders: [folder],
  engine: 'legacy' as const,
  retrievalMode: 'adaptive' as const,
  topK: 1,
  ioConcurrency: 4,
});
const dbOf = (manager: MediaAnalysisManager) => (manager as unknown as { db: DatabaseSync }).db;
const pairLabel = (a: string, b: string) => [basename(a), basename(b)].sort().join(':');
async function holdUntilReleased(release: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(new Error('synthetic queue stopped'));
      signal.addEventListener('abort', abort, { once: true });
      void release.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

test(
  'adaptive two-worker checking begins at opposite ends and checks all pairs only once',
  {
    timeout: 10_000,
    skip: availableParallelism() < 6 ? 'the local media worker bound permits only one worker' : false,
  },
  async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const bothRunning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: string[] = [];
    let images = 0,
      inFlight = 0,
      peak = 0;
    const manager = f.make(
      decoder({
        image: async () => {
          images++;
          return signature(imageHash);
        },
        compareImages: async (a, b, signal) => {
          calls.push(pairLabel(a, b));
          inFlight++;
          peak = Math.max(peak, inFlight);
          try {
            if (calls.length <= 2) {
              if (calls.length === 2) entered();
              await holdUntilReleased(gate, signal);
            }
            return { geometricInliers: 30 };
          } finally {
            inFlight--;
          }
        },
      }),
    );
    const job = await manager.start(options(f.folder));
    try {
      await bothRunning;
      const rows = dbOf(manager)
        .prepare('SELECT path FROM files WHERE job=? AND kind=? ORDER BY id')
        .all(job.id, 'image') as Array<{ path: string }>;
      assert.equal(calls.length, 2);
      assert.deepEqual(
        new Set(calls),
        new Set([pairLabel(rows[0]!.path, rows[1]!.path), pairLabel(rows[0]!.path, rows.at(-1)!.path)]),
        'both the earliest and latest candidate are in flight before either is released',
      );
      assert.equal(inFlight, 2);
      release();
      const report = await manager.wait(job.id);
      assert.equal(report.status, 'completed');
      assert.equal(images, 12);
      assert.equal(calls.length, 11);
      assert.equal(new Set(calls).size, 11);
      assert.equal(report.counts.results, 11);
      assert.equal(peak, 2);
      assert.equal(inFlight, 0);
      assert.match(report.steps!.find((step) => step.key === 'compare')!.note!, /前向.*尾向/);
    } finally {
      release();
    }
  },
);

test('bidirectional resume skips both positive and completed negative checkpoints without new decoding', async (t) => {
  const f = await fixture(t, true);
  const counts = { images: 0, pairs: 0, frames: 0 };
  const calls = new Set<string>();
  const mock = decoder({
    image: async () => {
      counts.images++;
      return signature(imageHash);
    },
    compareImages: async (a, b) => {
      counts.pairs++;
      const key = pairLabel(a, b);
      assert.ok(!calls.has(key), 'an image pair is never checked twice');
      calls.add(key);
      return { geometricInliers: 30 };
    },
    frame: async (path, time) => {
      counts.frames++;
      return videoFrame(path, time);
    },
  });
  const first = f.make(mock);
  const job = await first.start(options(f.folder));
  const report = await first.wait(job.id);
  assert.equal(report.status, 'completed');
  assert.equal(counts.images, 12);
  assert.equal(counts.pairs, 11);
  assert.ok(
    counts.frames > 12 && counts.frames < 36,
    'video candidates are checked with reusable signatures and sound early rejection',
  );
  assert.equal(report.counts.results, 11);
  const db = dbOf(first);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM pair_cache WHERE job=?').get(job.id) as { count: number }).count,
    11,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM pair_checks WHERE job=?').get(job.id) as { count: number }).count,
    1,
  );
  const completedCounts = { ...counts };
  await first.close();
  const restored = f.make(mock);
  restored.resume(job.id);
  const resumed = await restored.wait(job.id);
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(counts, completedCounts);
  assert.equal(resumed.counts.results, 11);
  assert.ok(resumed.results.every((item) => item.reusedFromCheckpoint === true));
  assert.equal(resumed.steps!.find((step) => step.key === 'compare')!.done, 12);
});
