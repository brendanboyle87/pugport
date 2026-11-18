import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaAnalysisManager } from '../src/server/media-analysis.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';

const signature: FrameSignature = { time: 0, hash: '1234567890abcdef', texture: 60, colours: Array(12).fill(0.25) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-timing-')));
  const media = join(root, 'media');
  await mkdir(media);
  return { root, media, close: () => rm(root, { recursive: true, force: true }) };
}
const decoder = (extra: Partial<MediaDecoder> = {}): MediaDecoder => ({
  description: 'synthetic timing fixture',
  image: async () => signature,
  probe: async () => ({ duration: 23 }),
  frame: async (_path, time) => ({ ...signature, time }),
  ...extra,
});

test('current-step report ranges are generated for coarse work and disappear while paused, with elapsed frozen', async () => {
  const f = await fixture();
  const reached = deferred<void>(),
    release = deferred<void>();
  let clock = 0,
    reads = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    now: () => clock,
    decoder: decoder({
      image: async (_path, signal) => {
        clock += 5_000;
        if (++reads === 21) {
          reached.resolve();
          await release.promise;
          signal.throwIfAborted();
        }
        return signature;
      },
    }),
  });
  try {
    for (let index = 0; index < 100; index++) await writeFile(join(f.media, `${index}.jpg`), 'x'.repeat(index + 1));
    const started = await manager.start({ folders: [f.media], engine: 'legacy', ioConcurrency: 1 });
    await reached.promise;
    const running = manager.status(started.id);
    const current = running.steps!.find((step) => step.state === 'running')!;
    assert.equal(current.key, 'coarse');
    assert.equal(current.done, 20);
    assert.ok(current.elapsedSeconds! >= 100);
    assert.ok(current.remainingRange);
    assert.equal(running.estimateScope, 'current-step');
    assert.ok(running.totalRemainingRange!.minSeconds >= 0);
    assert.equal(running.totalRemainingRange!.maxSeconds, undefined, 'later stages never receive guessed costs');
    const paused = manager.pause(started.id);
    assert.equal(paused.remainingRange, undefined);
    assert.equal(paused.remainingSeconds, undefined);
    assert.equal(paused.steps!.find((step) => step.key === 'coarse')!.estimateState, 'paused');
    const elapsed = paused.steps!.find((step) => step.key === 'coarse')!.elapsedSeconds;
    clock += 3_600_000;
    assert.equal(manager.status(started.id).steps!.find((step) => step.key === 'coarse')!.elapsedSeconds, elapsed);
  } finally {
    release.resolve();
    await manager.close();
    await f.close();
  }
});

test('cancel followed immediately by app close preserves cancelled status and already recorded evidence', async () => {
  const f = await fixture();
  const reached = deferred<void>(),
    release = deferred<void>();
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder({
      compareImages: async () => {
        reached.resolve();
        await release.promise;
        return { geometricInliers: 20 };
      },
    }),
  });
  let restored: MediaAnalysisManager | undefined;
  try {
    await writeFile(join(f.media, 'a.jpg'), 'identical-fixture');
    await copyFile(join(f.media, 'a.jpg'), join(f.media, 'b.jpg'));
    await writeFile(join(f.media, 'c.jpg'), 'different bytes with same synthetic image');
    const started = await manager.start({ folders: [f.media], engine: 'legacy', ioConcurrency: 1 });
    await reached.promise;
    const before = manager.status(started.id);
    assert.equal(before.counts.results, 1);
    assert.equal(before.results[0]!.classification, 'exact-bytes');
    assert.equal(manager.cancel(started.id).status, 'cancelled');
    const closing = manager.close();
    release.resolve();
    await closing;
    restored = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder() });
    const report = restored.status(started.id);
    assert.equal(report.status, 'cancelled');
    assert.equal(report.phase, 'closed');
    assert.equal(report.counts.results, 1);
    assert.deepEqual(report.results, before.results);
    assert.equal(
      restored.list().some((job) => job.id === started.id),
      false,
      'closed tasks do not reappear as paused',
    );
  } finally {
    release.resolve();
    await manager.close();
    await restored?.close();
    await f.close();
  }
});
