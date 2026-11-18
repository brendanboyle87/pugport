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

const signature = (hash = '0123456789abcdef', time = 0): FrameSignature => ({
  time,
  hash,
  texture: 60,
  colours: Array(12).fill(0.25),
});
function decoder(overrides: Partial<MediaDecoder> = {}): MediaDecoder {
  return {
    description: 'Synthetic adaptive fixtures; no real media',
    image: async () => signature(),
    probe: async () => ({ duration: 120 }),
    frame: async (_path, time) => signature(undefined, time),
    compareImages: async () => ({ geometricInliers: 30 }),
    ...overrides,
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-adaptive-')));
  const folder = join(root, 'media');
  await mkdir(folder);
  const managers: MediaAnalysisManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    folder,
    managers,
    add: (name: string) => writeFile(join(folder, name), `different encoded bytes:${name}`),
  };
}
function hamming(a: string, b: string) {
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`),
    count = 0;
  while (bits) {
    bits &= bits - 1n;
    count++;
  }
  return count;
}
/** Unrelated signatures cannot enter a shared coarse band or pass the visual-distance threshold. */
function unrelatedHashes(count: number) {
  const hashes: string[] = [];
  const bands = Array.from({ length: 4 }, () => new Set<string>());
  for (let seed = 0; hashes.length < count; seed++) {
    const hash = createHash('sha256').update(`unrelated-media:${seed}`).digest('hex').slice(0, 16);
    if (bands.some((values, i) => values.has(hash.slice(i * 4, i * 4 + 4)))) continue;
    if (hashes.some((other) => hamming(hash, other) <= 8)) continue;
    hashes.push(hash);
    bands.forEach((values, i) => values.add(hash.slice(i * 4, i * 4 + 4)));
  }
  return hashes;
}

test('adaptive retrieval fingerprints unrelated images without spending inference on the entire directory', async (t) => {
  const f = await fixture(t);
  const hashes = unrelatedHashes(100);
  await Promise.all(hashes.map((_hash, i) => f.add(`${String(i).padStart(3, '0')}.jpg`)));
  let inspected = 0,
    fineChecks = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      image: async (path) => {
        inspected++;
        return signature(hashes[Number(basename(path).slice(0, 3))]!);
      },
      compareImages: async () => {
        fineChecks++;
        return { geometricInliers: 0 };
      },
    }),
  });
  f.managers.push(manager);
  const report = await manager.wait(
    (await manager.start({ folders: [f.folder], engine: 'gemma', retrievalMode: 'adaptive' })).id,
  );
  assert.equal(report.status, 'completed');
  assert.equal(report.scope.status, 'complete');
  assert.equal(report.counts.files, 100);
  assert.equal(report.counts.fingerprinted, 100);
  assert.equal(inspected, 100);
  assert.equal(fineChecks, 0);
  assert.equal(report.counts.results, 0);
  assert.equal(report.execution.retrievalMode, 'adaptive');
});

test('adaptive cross-duration anchors locate a short clip in a long video and never authorize its deletion', async (t) => {
  const f = await fixture(t);
  await f.add('a-long.mp4');
  await f.add('b-clip.mp4');
  const clipStart = samplingTimes(120)[5]!;
  const start = (path: string) => (basename(path).startsWith('b-') ? clipStart : 0);
  const scene = (path: string, time: number) =>
    signature(
      createHash('sha256')
        .update(`world-time:${Math.round((time + start(path)) * 10_000)}`)
        .digest('hex')
        .slice(0, 16),
      time,
    );
  let decoding = 0,
    decodePeak = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      probe: async (path) => ({ duration: start(path) ? 40 : 120, hasAudio: true }),
      frame: async (path, time, signal) => {
        decoding++;
        decodePeak = Math.max(decodePeak, decoding);
        try {
          await delay(2, undefined, { signal });
          return scene(path, time);
        } finally {
          decoding--;
        }
      },
    }),
  });
  f.managers.push(manager);
  const report = await manager.wait(
    (
      await manager.start({
        folders: [f.folder],
        engine: 'gemma',
        retrievalMode: 'adaptive',
        topK: 1,
        ioConcurrency: 1,
      })
    ).id,
  );
  assert.equal(report.status, 'completed');
  assert.equal(report.counts.results, 1);
  const evidence = report.results[0]!;
  assert.equal(evidence.classification, 'partial-overlap');
  assert.equal(evidence.deleteEligible, false);
  assert.ok(Math.abs(evidence.visual!.offsetSeconds + clipStart) < 0.001);
  assert.equal(evidence.visual!.matches, 12);
  assert.equal(evidence.visual!.sampledContainment?.kind, 'sampled-contained');
  assert.equal(evidence.visual!.sampledContainment?.contained, 'b');
  assert.equal(evidence.visual!.sampledContainment?.containedSpan[0], 0);
  assert.ok(Math.abs(evidence.visual!.sampledContainment!.containedSpan[1] - 39.9) < 0.0001);
  assert.equal(report.counts.sampledContained, 1);
  assert.match(report.summary, /短片整段抽样匹配 1 组、局部重叠 0 组/);
  assert.match(evidence.explanation, /整段抽样包含.*逐帧.*音轨.*字幕.*画质/);
  assert.match(report.summary, /音轨/);
  assert.equal(decodePeak, 1, 'disk concurrency one decodes the two sources of a video pair sequentially');
  assert.equal(decoding, 0);
});

test('resuming an older full-index video fills missing coarse positions before reusing a clean checkpoint', async (t) => {
  const f = await fixture(t);
  await f.add('single.mp4');
  const decoded: number[] = [];
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      frame: async (_path, time) => {
        decoded.push(time);
        return signature(undefined, time);
      },
    }),
  });
  f.managers.push(manager);
  const original = await manager.wait(
    (await manager.start({ folders: [f.folder], engine: 'gemma', videoSampleSeconds: 120 })).id,
  );
  assert.equal(original.status, 'completed');
  assert.equal(original.execution.retrievalMode ?? 'full-index', 'full-index');
  const db = (manager as unknown as { db: DatabaseSync }).db;
  const old = db.prepare('SELECT feature FROM files WHERE job=?').get(original.id) as { feature: string };
  const feature = JSON.parse(old.feature);
  feature.frames = [signature(undefined, 0), signature(undefined, samplingTimes(120).at(-1)!)];
  db.prepare('UPDATE files SET feature=? WHERE job=?').run(JSON.stringify(feature), original.id);
  decoded.length = 0;
  const job = db.prepare('SELECT options FROM jobs WHERE id=?').get(original.id) as { options: string };
  assert.equal(JSON.parse(job.options).retrievalMode, 'full-index');
  db.prepare('UPDATE jobs SET options=? WHERE id=?').run(
    JSON.stringify({ ...JSON.parse(job.options), retrievalMode: 'adaptive' }),
    original.id,
  );
  // A model-only historical run has no program frame cache.
  db.exec('DELETE FROM frame_signatures');
  manager.resume(original.id);
  const resumed = await manager.wait(original.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.execution.retrievalMode, 'adaptive');
  const row = db.prepare('SELECT feature FROM files WHERE job=?').get(original.id) as { feature: string };
  const saved = JSON.parse(row.feature) as { frames: FrameSignature[] };
  const required = [0, 5, 9, 14, 18, 23].map((i) => samplingTimes(120)[i]!);
  assert.ok(required.every((time) => saved.frames.some((frame) => frame.time === time)));
  assert.deepEqual(
    decoded.sort((a, b) => a - b),
    required.filter((time) => time !== 0 && time !== samplingTimes(120).at(-1)),
  );
});

test('adaptive fixed checks run concurrently within the local worker bound', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.add(`${String(i).padStart(3, '0')}.jpg`)));
  let inFlight = 0,
    peak = 0,
    checks = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      compareImages: async (_a, _b, signal) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          await delay(10, undefined, { signal });
          checks++;
          return { geometricInliers: 30 };
        } finally {
          inFlight--;
        }
      },
    }),
  });
  f.managers.push(manager);
  const report = await manager.wait(
    (await manager.start({ folders: [f.folder], engine: 'legacy', retrievalMode: 'adaptive', topK: 1 })).id,
  );
  const bound = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3)));
  assert.equal(report.status, 'completed');
  assert.equal(peak, bound);
  assert.equal(inFlight, 0);
  assert.equal(checks, 11);
  assert.equal(report.counts.results, checks);
});

test('adaptive disk concurrency bounds fingerprint reads and pair verification separately', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.add(`${String(i).padStart(3, '0')}.jpg`)));
  let reading = 0,
    readPeak = 0,
    inspecting = 0,
    checkPeak = 0,
    readCount = 0,
    checkCount = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      image: async (_path, signal) => {
        reading++;
        readPeak = Math.max(readPeak, reading);
        try {
          await delay(10, undefined, { signal });
          readCount++;
          return signature();
        } finally {
          reading--;
        }
      },
      compareImages: async (_a, _b, signal) => {
        inspecting++;
        checkPeak = Math.max(checkPeak, inspecting);
        try {
          await delay(10, undefined, { signal });
          checkCount++;
          return { geometricInliers: 30 };
        } finally {
          inspecting--;
        }
      },
    }),
  });
  f.managers.push(manager);
  const report = await manager.wait(
    (
      await manager.start({
        folders: [f.folder],
        engine: 'legacy',
        retrievalMode: 'adaptive',
        topK: 1,
        ioConcurrency: 2,
      })
    ).id,
  );
  assert.equal(report.status, 'completed');
  assert.equal(report.execution.ioConcurrency, 2);
  assert.ok(readPeak >= 1 && readPeak <= 2, 'no more than the chosen number of simultaneous file reads');
  assert.equal(readCount, 12);
  assert.equal(checkPeak, 1, 'a pair needs two source files, so disk concurrency two admits one pair');
  assert.equal(checkCount, 11);
  assert.equal(reading, 0);
  assert.equal(inspecting, 0);
});

test('media disk concurrency accepts one through eight and rejects non-integer or out-of-range values', async (t) => {
  const f = await fixture(t);
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder() });
  f.managers.push(manager);
  for (const ioConcurrency of [1, 8]) {
    const report = await manager.wait(
      (await manager.start({ folders: [f.folder], engine: 'legacy', retrievalMode: 'adaptive', ioConcurrency })).id,
    );
    assert.equal(report.status, 'completed');
    assert.equal(report.execution.ioConcurrency, ioConcurrency);
  }
  for (const ioConcurrency of [0, 9, 1.5, NaN])
    await assert.rejects(
      manager.start({ folders: [f.folder], engine: 'legacy', retrievalMode: 'adaptive', ioConcurrency }),
      /concurrency|并发/i,
    );
});

test('pausing adaptive fixed checks waits for every running decoder to settle', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.add(`${String(i).padStart(3, '0')}.jpg`)));
  const bound = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3)));
  let inFlight = 0,
    calls = 0,
    settled = 0;
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      compareImages: async (_a, _b, signal) => {
        signal.throwIfAborted();
        inFlight++;
        calls++;
        if (inFlight === bound) entered();
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                // Delayed child shutdown exposes implementations that return before all workers finish.
                void delay(15).then(() => reject(new Error('synthetic decoder stopped')));
              },
              { once: true },
            );
          });
          return { geometricInliers: 30 };
        } finally {
          inFlight--;
          settled++;
        }
      },
    }),
  });
  f.managers.push(manager);
  const job = await manager.start({ folders: [f.folder], engine: 'legacy', retrievalMode: 'adaptive', topK: 1 });
  try {
    await reached;
    assert.equal(inFlight, bound);
    manager.pause(job.id);
    const interrupted = await manager.wait(job.id);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(inFlight, 0);
    assert.equal(settled, calls);
    assert.equal(calls, bound, 'no remaining candidate launches after the pause');
    assert.equal(interrupted.counts.results, 0);
  } finally {
    manager.pause(job.id);
  }
});
