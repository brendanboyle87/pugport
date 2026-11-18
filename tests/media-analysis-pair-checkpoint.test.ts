import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MediaAnalysisManager, samplingTimes } from '../src/server/media-analysis.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';
import { mediaPairCheckpointKey, mediaPairVerificationVersion } from '../src/server/media-pair-checkpoint.ts';

const duration = 120;
const coarseTimes = [0, 5, 9, 14, 18, 23].map((at) => samplingTimes(duration)[at]!);
const isCoarse = (time: number) => coarseTimes.some((known) => Math.abs(known - time) < 0.00001);
const signature = (hash: string, time: number): FrameSignature => ({
  hash,
  time,
  texture: 60,
  colours: Array(12).fill(0.25),
});
/** Shared coarse anchors admit a candidate, but only two endpoint frames match during independent checking. */
function unmatchedFrame(path: string, time: number): FrameSignature {
  const hash = isCoarse(time)
    ? createHash('sha256')
        .update(`checkpoint-coarse:${Math.round(time * 10_000)}`)
        .digest('hex')
        .slice(0, 16)
    : basename(path).startsWith('a-')
      ? '0000000000000000'
      : basename(path).startsWith('b-')
        ? 'ffffffffffffffff'
        : '5555555555555555';
  return signature(hash, time);
}
function matchedFrame(_path: string, time: number): FrameSignature {
  return signature(createHash('sha256').update(`checkpoint-scene:${time}`).digest('hex').slice(0, 16), time);
}
const identity = { modelId: 'synthetic-pair-checkpoint', revision: 'v1', dimensions: 8, preprocessVersion: 'v1' };
function decoder(overrides: Partial<MediaDecoder> = {}): MediaDecoder {
  return {
    description: 'Synthetic pair checkpoint verifier; no real media',
    image: async () => signature('0123456789abcdef', 0),
    probe: async () => ({ duration }),
    frame: async (path, time) => unmatchedFrame(path, time),
    ...overrides,
  };
}
function checkpointCount(
  manager: MediaAnalysisManager,
  id: string,
  table: 'pair_checks' | 'pair_cache' = 'pair_checks',
) {
  const db = (manager as unknown as { db: DatabaseSync }).db;
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE job=?`).get(id) as { count: number }).count;
}
async function fixture(t: { after(fn: () => Promise<void>): void }, names = ['a-video.mp4', 'b-video.mp4']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-pair-checkpoint-')));
  const folder = join(root, 'media');
  await mkdir(folder);
  await Promise.all(names.map((name, at) => writeFile(join(folder, name), `synthetic:${name}:${'x'.repeat(at * 17)}`)));
  const managers: MediaAnalysisManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    folder,
    make: (options: ConstructorParameters<typeof MediaAnalysisManager>[1]) => {
      const manager = new MediaAnalysisManager(join(root, 'data'), options);
      managers.push(manager);
      return manager;
    },
  };
}
const adaptiveOptions = (folder: string) => ({
  folders: [folder],
  engine: 'auto' as const,
  retrievalMode: 'adaptive' as const,
  ioConcurrency: 1,
});

test('completed-pair keys invalidate when the verifier, scope identity, sampling plan, or ordered anchors change', () => {
  const base: Parameters<typeof mediaPairCheckpointKey>[0] = {
    pair: 'stamps-and-features-a-b',
    mode: 'adaptive',
    decoder: 'synthetic-v1',
    videoSampleSeconds: 30,
    anchors: [
      { a: 0, b: 0, score: 1 },
      { a: 40, b: 40, score: 0.9 },
    ],
  };
  const key = mediaPairCheckpointKey(base);
  assert.equal(mediaPairCheckpointKey(structuredClone(base)), key);
  for (const changed of [
    { ...base, pair: 'changed-stamps-or-features' },
    { ...base, mode: 'full-index' as const },
    { ...base, decoder: 'synthetic-v2' },
    { ...base, videoSampleSeconds: 60 },
    { ...base, anchors: [{ a: 0, b: 5, score: 1 }, base.anchors[1]!] },
    { ...base, anchors: [{ ...base.anchors[0]!, score: 0.99 }, base.anchors[1]!] },
    { ...base, anchors: [...base.anchors].reverse() },
    { ...base, version: `${mediaPairVerificationVersion}-changed` },
  ])
    assert.notEqual(mediaPairCheckpointKey(changed), key);
});

test('adaptive completed negative verification with legacy numeric stamps survives close and reopen', async (t) => {
  const f = await fixture(t);
  let frames = 0;
  const mock = decoder({
    frame: async (path, time) => {
      frames++;
      return unmatchedFrame(path, time);
    },
  });
  const first = f.make({ decoder: mock });
  // Simulate an older version persisting numeric stamps before it creates pair_checks.
  const legacy = first as unknown as {
    inspect(...args: unknown[]): Promise<{ stamp: { ino: string | number } }>;
  };
  const inspect = legacy.inspect.bind(first);
  t.mock.method(legacy, 'inspect', async (...args: unknown[]) => {
    const result = await inspect(...args);
    result.stamp.ino = Number(result.stamp.ino);
    return result;
  });
  const job = await first.start(adaptiveOptions(f.folder));
  const report = await first.wait(job.id);
  assert.equal(report.status, 'completed');
  assert.equal(report.counts.results, 0, 'absence of a visual match is not positive duplicate evidence');
  assert.equal(checkpointCount(first, job.id), 1);
  assert.equal(checkpointCount(first, job.id, 'pair_cache'), 0);
  assert.ok(
    frames > 12 && frames < 36,
    'coarse frames and independent verification ran without exhausting impossible matches',
  );
  const completedFrames = frames;
  await first.close();
  const restored = f.make({ decoder: mock });
  restored.resume(job.id);
  const resumed = await restored.wait(job.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.counts.results, 0);
  assert.equal(
    frames,
    completedFrames,
    'unchanged coarse features and completed negative verification are both reused',
  );
  assert.match(resumed.coverage.join('\n'), /有界核验.*不证明|不证明.*内容完全不同/);
});

test(
  'closing a running task preserves completed negatives while unfinished pairs resume their full verification',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, ['a-video.mp4', 'b-video.mp4', 'c-video.mp4']);
    let frames = 0,
      block = true;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first!: MediaAnalysisManager;
    let id = '';
    const mock = decoder({
      frame: async (path, time, signal) => {
        signal.throwIfAborted();
        frames++;
        if (block && !isCoarse(time) && checkpointCount(first, id) === 1) {
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('synthetic shutdown')), { once: true }),
          );
        }
        return unmatchedFrame(path, time);
      },
    });
    first = f.make({ decoder: mock });
    const job = await first.start(adaptiveOptions(f.folder));
    id = job.id;
    await reached;
    assert.equal(first.status(id).status, 'running');
    assert.equal(checkpointCount(first, id), 1, 'one complete negative is durable before the next pair is interrupted');
    await first.close();
    block = false;
    const shutdownFrames = frames;
    const restored = f.make({ decoder: mock });
    assert.equal(restored.status(id).status, 'interrupted');
    assert.equal(checkpointCount(restored, id), 1);
    restored.resume(id);
    const report = await restored.wait(id);
    assert.equal(report.status, 'completed');
    assert.equal(report.counts.results, 0);
    assert.equal(checkpointCount(restored, id), 3);
    assert.ok(frames > shutdownFrames, 'unfinished pairs actually resume decoding uncached positions');
    assert.ok(frames - shutdownFrames < 48, 'completed checks and reusable frame signatures avoid a full restart');
    assert.match(report.coverage.join('\n'), /复用 1 组已完成/);
  },
);

test('a decode failure never checkpoints a negative result and healthy resume retries that pair', async (t) => {
  const f = await fixture(t);
  let fail = true,
    frames = 0;
  const manager = f.make({
    decoder: decoder({
      frame: async (path, time) => {
        frames++;
        if (fail && !isCoarse(time)) throw new Error('synthetic transient verification failure');
        return unmatchedFrame(path, time);
      },
    }),
  });
  const job = await manager.start(adaptiveOptions(f.folder));
  const first = await manager.wait(job.id);
  assert.equal(first.status, 'completed');
  assert.equal(first.counts.results, 0);
  assert.equal(checkpointCount(manager, job.id), 0);
  const failedFrames = frames;
  fail = false;
  manager.resume(job.id);
  const retried = await manager.wait(job.id);
  assert.equal(retried.status, 'completed');
  assert.equal(checkpointCount(manager, job.id), 1);
  assert.ok(
    frames > failedFrames && frames - failedFrames <= 24,
    'failed verification retries while successful frame signatures can survive',
  );
});

test(
  'pausing an unfinished pair never saves a negative result and resume verifies it afresh',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    let block = true,
      frames = 0;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = f.make({
      decoder: decoder({
        frame: async (path, time, signal) => {
          signal.throwIfAborted();
          frames++;
          if (block && !isCoarse(time)) {
            entered();
            await new Promise<void>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new Error('synthetic stop')), { once: true }),
            );
          }
          return unmatchedFrame(path, time);
        },
      }),
    });
    const job = await manager.start(adaptiveOptions(f.folder));
    await reached;
    manager.pause(job.id);
    assert.equal((await manager.wait(job.id)).status, 'interrupted');
    assert.equal(checkpointCount(manager, job.id), 0);
    const interruptedFrames = frames;
    block = false;
    manager.resume(job.id);
    assert.equal((await manager.wait(job.id)).status, 'completed');
    assert.equal(checkpointCount(manager, job.id), 1);
    assert.ok(
      frames > interruptedFrames && frames - interruptedFrames <= 24,
      'unfinished verification retries missing positions',
    );
  },
);

test('changing a source after its negative checkpoint invalidates that pair on resume', async (t) => {
  const f = await fixture(t);
  let frames = 0;
  const manager = f.make({
    decoder: decoder({
      frame: async (path, time) => {
        frames++;
        return unmatchedFrame(path, time);
      },
    }),
  });
  const job = await manager.start(adaptiveOptions(f.folder));
  assert.equal((await manager.wait(job.id)).status, 'completed');
  assert.equal(checkpointCount(manager, job.id), 1);
  await writeFile(
    join(f.folder, 'b-video.mp4'),
    'replacement synthetic media with a different file size, timestamp and content',
  );
  const beforeResume = frames;
  manager.resume(job.id);
  assert.equal((await manager.wait(job.id)).status, 'completed');
  assert.ok(
    frames > beforeResume && frames - beforeResume <= 30,
    'changed source fingerprints and pair verification rerun; unchanged source frames can be reused',
  );
  assert.equal(checkpointCount(manager, job.id), 1, 'the replacement result updates the checkpoint for this pair');
});

test('a source changed during verification cannot leave a reusable negative checkpoint', async (t) => {
  const f = await fixture(t);
  let mutate = true,
    frames = 0;
  const manager = f.make({
    decoder: decoder({
      frame: async (path, time) => {
        frames++;
        if (mutate && !isCoarse(time)) {
          mutate = false;
          await writeFile(
            join(f.folder, 'b-video.mp4'),
            'synthetic source changed while independent positions were read',
          );
        }
        return unmatchedFrame(path, time);
      },
    }),
  });
  const job = await manager.start(adaptiveOptions(f.folder));
  const first = await manager.wait(job.id);
  assert.equal(first.status, 'completed');
  assert.equal(first.counts.results, 0);
  assert.equal(checkpointCount(manager, job.id), 0);
  const changedFrames = frames;
  manager.resume(job.id);
  assert.equal((await manager.wait(job.id)).status, 'completed');
  assert.equal(checkpointCount(manager, job.id), 1);
  assert.ok(
    frames > changedFrames && frames - changedFrames <= 30,
    'changed source is rechecked rather than treating the previous bounded check as complete',
  );
});

test('positive cached evidence still reappears after restart without new decoding', async (t) => {
  const f = await fixture(t);
  let frames = 0;
  const mock = decoder({
    frame: async (path, time) => {
      frames++;
      return matchedFrame(path, time);
    },
  });
  const first = f.make({ decoder: mock });
  const job = await first.start(adaptiveOptions(f.folder));
  const report = await first.wait(job.id);
  assert.equal(report.status, 'completed');
  assert.equal(report.results[0]?.classification, 'sampled-full-span');
  assert.equal(checkpointCount(first, job.id), 0);
  assert.equal(checkpointCount(first, job.id, 'pair_cache'), 1);
  const verifiedFrames = frames;
  await first.close();
  const restored = f.make({ decoder: mock });
  restored.resume(job.id);
  const resumed = await restored.wait(job.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.counts.results, 1);
  assert.equal(resumed.results[0]?.reusedFromCheckpoint, true);
  assert.equal(resumed.results[0]?.deleteEligible, false);
  assert.equal(frames, verifiedFrames);
});

test('impossible minimum-match counts stop early and remain reusable completed negative checks', async (t) => {
  const f = await fixture(t);
  const decoded: Array<{ file: string; time: number }> = [];
  const manager = f.make({
    decoder: decoder({
      frame: async (path, time) => {
        decoded.push({ file: basename(path), time });
        return unmatchedFrame(path, time);
      },
    }),
  });
  const job = await manager.start(adaptiveOptions(f.folder));
  const first = await manager.wait(job.id);
  assert.equal(first.status, 'completed');
  assert.equal(first.counts.results, 0);
  assert.equal(
    checkpointCount(manager, job.id),
    1,
    'a mathematically exhausted matching plan is a completed bounded check',
  );
  const fineTime = (index: number) => ((duration - 0.1) * index) / 11;
  for (const file of ['a-video.mp4', 'b-video.mp4']) {
    assert.ok(
      decoded.some((item) => item.file === file && Math.abs(item.time - fineTime(9)) < 0.00001),
      'the verifier reaches the position where one match plus two remaining positions cannot make four',
    );
    assert.ok(
      !decoded.some((item) => item.file === file && Math.abs(item.time - fineTime(10)) < 0.00001),
      'the next independent position is skipped only after matching is impossible',
    );
  }
  const completedReads = decoded.length;
  manager.resume(job.id);
  const resumed = await manager.wait(job.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.counts.results, 0);
  assert.equal(decoded.length, completedReads);
});

test('third and fourth matches in the final two positions cannot be pruned when four remain attainable', async (t) => {
  const f = await fixture(t);
  const fineTimes = Array.from({ length: 12 }, (_value, index) => ((duration - 0.1) * index) / 11);
  const matchTimes = [0, 5, 10, 11].map((index) => fineTimes[index]!);
  const decoded: number[] = [];
  const manager = f.make({
    decoder: decoder({
      frame: async (path, time) => {
        decoded.push(time);
        if (isCoarse(time)) return unmatchedFrame(path, time);
        if (matchTimes.some((match) => Math.abs(match - time) < 0.00001))
          return signature(
            createHash('sha256')
              .update(`late-boundary-match:${Math.round(time * 10_000)}`)
              .digest('hex')
              .slice(0, 16),
            time,
          );
        return unmatchedFrame(path, time);
      },
    }),
  });
  const job = await manager.start(adaptiveOptions(f.folder));
  const report = await manager.wait(job.id);
  assert.equal(report.status, 'completed');
  assert.equal(report.counts.results, 1);
  assert.equal(report.results[0]?.classification, 'partial-overlap');
  assert.equal(report.results[0]?.deleteEligible, false);
  const visual = report.results[0]!.visual!;
  assert.equal(visual.matches, 4);
  assert.equal(visual.fineCheck?.planned, 12);
  assert.equal(visual.fineCheck?.decoded, 12);
  assert.equal(visual.fineCheck?.failed, 0);
  assert.ok(
    decoded.some((time) => Math.abs(time - fineTimes[10]!) < 0.00001),
    'the penultimate position is necessary to reach the minimum',
  );
  assert.ok(
    visual.positions.some((position) => Math.abs(position.a - fineTimes[11]!) < 0.00001),
    'the final position supplies the fourth match',
  );
  assert.equal(checkpointCount(manager, job.id), 0);
  assert.equal(checkpointCount(manager, job.id, 'pair_cache'), 1);
});
