import { largeFileId, mockFileIds } from './helpers/file-identity.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MediaAnalysisManager, type MediaAnalysisReport } from '../src/server/media-analysis.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';

const signature: FrameSignature = { time: 0, hash: '1234567890abcdef', texture: 0, colours: Array(12).fill(0.25) };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function decoder(image: MediaDecoder['image']): MediaDecoder {
  return {
    description: 'synthetic resume fixture without visual candidates',
    image,
    probe: async () => ({ duration: 23 }),
    frame: async (_path, time) => ({ ...signature, time }),
  };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-resume-')));
  const media = join(root, 'media');
  await mkdir(media);
  return { root, media, close: () => rm(root, { recursive: true, force: true }) };
}
function state(manager: MediaAnalysisManager) {
  return manager as unknown as { db: DatabaseSync; lastUpdate: Map<string, number> };
}

test('analysis invalidates high-bit replacements but reuses legacy numeric stamps on resume', async (t) => {
  const f = await fixture();
  let reads = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'state'), {
    decoder: decoder(async () => {
      reads++;
      return signature;
    }),
  });
  try {
    const image = join(f.media, 'synthetic.jpg');
    await writeFile(image, 'synthetic image input');
    const ids = mockFileIds(t, [[image, largeFileId]]);
    const job = await manager.start({ folders: [f.media], engine: 'legacy', ioConcurrency: 1 });
    await manager.wait(job.id);
    const db = state(manager).db;
    const saved = () =>
      JSON.parse(
        (db.prepare('SELECT stamp FROM files WHERE job=? AND path=?').get(job.id, image) as { stamp: string }).stamp,
      );
    assert.equal(saved().ino, String(largeFileId));
    manager.resume(job.id);
    await manager.wait(job.id);
    assert.equal(reads, 1);
    ids.set(image, largeFileId + 1n);
    manager.resume(job.id);
    await manager.wait(job.id);
    assert.equal(reads, 2);
    const legacy = { ...saved(), ino: Number(largeFileId + 1n) };
    db.prepare('UPDATE files SET stamp=? WHERE job=? AND path=?').run(JSON.stringify(legacy), job.id, image);
    manager.resume(job.id);
    await manager.wait(job.id);
    assert.equal(reads, 2);
    assert.deepEqual(saved(), legacy);
  } finally {
    await manager.close();
    await f.close();
  }
});

for (const ino of [42n, largeFileId]) {
  test(`legacy numeric stamps keep pair-cache hits after restart (inode ${ino})`, async (t) => {
    const f = await fixture();
    let reads = 0,
      checks = 0;
    const mock = {
      ...decoder(async () => {
        reads++;
        return { ...signature, texture: 30 };
      }),
      compareImages: async () => {
        checks++;
        return { geometricInliers: 30 };
      },
    };
    const first = new MediaAnalysisManager(join(f.root, 'state'), { decoder: mock });
    let restored: MediaAnalysisManager | undefined;
    try {
      const a = join(f.media, 'a.jpg'),
        b = join(f.media, 'b.jpg');
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
      await writeFile(a, bytes);
      bytes[1024 * 1024] = 2;
      await writeFile(b, bytes);
      mockFileIds(t, [
        [a, ino],
        [b, ino + 1n],
      ]);
      const job = await first.start({ folders: [f.media], engine: 'legacy', ioConcurrency: 1 });
      assert.equal((await first.wait(job.id)).counts.results, 1);
      assert.equal(reads, 2);
      assert.equal(checks, 1);
      const db = state(first).db;
      const rows = db.prepare('SELECT id,stamp,feature FROM files WHERE job=? ORDER BY id').all(job.id) as {
        id: number;
        stamp: string;
        feature: string;
      }[];
      // Recreate the byte-for-byte numeric stamps and cache key an older version persisted.
      for (const row of rows) {
        const stamp = JSON.parse(row.stamp);
        row.stamp = JSON.stringify({ ...stamp, ino: Number(stamp.ino) });
        db.prepare('UPDATE files SET stamp=? WHERE id=?').run(row.stamp, row.id);
      }
      const key = createHash('sha256')
        .update(`${rows[0]!.stamp}\n${rows[1]!.stamp}\n${rows[0]!.feature}\n${rows[1]!.feature}`)
        .digest('hex');
      assert.equal(db.prepare('UPDATE pair_cache SET key=? WHERE job=?').run(key, job.id).changes, 1);
      await first.close();
      const createReadStream = fs.createReadStream;
      t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
        assert.ok(args[0] !== a && args[0] !== b, 'unchanged same-size files must not be fully hashed again');
        return createReadStream(...args);
      });
      syncBuiltinESMExports();
      restored = new MediaAnalysisManager(join(f.root, 'state'), { decoder: mock });
      restored.resume(job.id);
      const report = await restored.wait(job.id);
      assert.equal(report.status, 'completed');
      assert.equal(report.results[0]?.reusedFromCheckpoint, true);
      assert.equal(reads, 2, 'unchanged images are not decoded again');
      assert.equal(checks, 1, 'the stored pair cache avoids another comparison');
      assert.deepEqual(
        state(restored).db.prepare('SELECT id,stamp,feature FROM files WHERE job=? ORDER BY id').all(job.id),
        rows,
      );
    } finally {
      await first.close();
      await restored?.close();
      await f.close();
    }
  });
}

test('pause and restart retain saved progress while rechecking inventory, then validate changed and new files', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  const completedPaths: string[] = [];
  let reads = 0;
  const first = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder(async (path, signal) => {
      if (++reads === 120) {
        reached.resolve();
        await release.promise;
        signal.throwIfAborted();
      }
      completedPaths.push(path);
      return signature;
    }),
  });
  let second: MediaAnalysisManager | undefined, third: MediaAnalysisManager | undefined;
  try {
    for (let index = 0; index < 150; index++)
      await writeFile(join(f.media, `${String(index).padStart(3, '0')}.jpg`), 'x'.repeat(index + 1));
    const started = await first.start({ folders: [f.media], engine: 'legacy', ioConcurrency: 1 });
    assert.equal(started.resume, undefined, 'a new task is not labelled as a resumed checklist');
    await reached.promise;
    first.pause(started.id);
    release.resolve();
    const paused = await first.wait(started.id);
    assert.equal(paused.counts.files, 150);
    assert.equal(paused.counts.fingerprinted, 119);
    assert.equal(paused.resume, undefined);
    await first.close();

    let checking: MediaAnalysisReport | undefined;
    let actualPresent = 0;
    second = new MediaAnalysisManager(join(f.root, 'data'), {
      decoder: decoder(async () => {
        assert.fail('paused during inventory; decoding must not have started');
      }),
      onUpdate: (report) => {
        // Allow deterministic progress observation in this small fixture without waiting a real second.
        state(second!).lastUpdate.delete(report.id);
        if (!checking && report.status === 'running' && report.resume?.checkedFiles === 100) {
          checking = report;
          actualPresent = (
            state(second!).db.prepare('SELECT COUNT(*) AS n FROM files WHERE job=? AND present=1').get(report.id) as {
              n: number;
            }
          ).n;
          second!.pause(report.id);
        }
      },
    });
    const continued = second.resume(started.id);
    assert.equal(continued.resume?.savedFiles, 150);
    assert.equal(continued.resume?.savedFingerprints, 119);
    await second.wait(started.id);
    assert.ok(checking);
    assert.equal(actualPresent, 100, 'membership is genuinely being re-enumerated');
    assert.equal(checking.counts.files, 150, 'saved progress does not collapse to the partial inventory');
    assert.equal(checking.counts.fingerprinted, 119);
    assert.equal(checking.resume!.checkedFiles, 100, 'current validation stays separate from saved records');
    assert.equal(checking.scope.status, 'pending', 'saved totals do not mark the current scope complete');
    assert.equal(checking.scope.listedFiles, 100);
    assert.equal(checking.steps!.find((step) => step.key === 'scan')!.label, '核对已保存的文件清单');
    assert.match(checking.progress, /继续比对|核对清单/);
    assert.match(checking.summary, /保存记录仍需核对文件是否变化/);
    await second.close();

    // A saved feature does not authorize its reuse: one cached file changes, another disappears, and a new one arrives.
    const changed = completedPaths[0]!,
      removed = completedPaths[1]!,
      added = join(f.media, 'new.jpg');
    await writeFile(changed, 'changed'.repeat(80));
    await rm(removed);
    await writeFile(added, 'new'.repeat(200));
    const decoded: string[] = [];
    third = new MediaAnalysisManager(join(f.root, 'data'), {
      decoder: decoder(async (path) => {
        decoded.push(path);
        return signature;
      }),
    });
    const persisted = third.status(started.id);
    assert.equal(persisted.resume!.checkingFiles, true, 'inventory marker survives process restart in the audit');
    assert.equal(persisted.resume!.checkedFiles, 100);
    assert.equal(persisted.counts.files, 150);
    assert.equal(persisted.counts.fingerprinted, 119);
    const restarted = third.resume(started.id);
    assert.equal(restarted.resume!.savedFiles, 150, 'another resume during inventory retains the original full base');
    assert.equal(restarted.resume!.savedFingerprints, 119);
    const done = await third.wait(started.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.resume!.checkingFiles, false);
    assert.equal(done.resume!.checkedFiles, 150);
    assert.equal(done.scope.status, 'complete');
    assert.equal(done.counts.files, 150, 'deleted and new files are reflected in the fresh inventory');
    assert.equal(done.counts.fingerprinted, 150);
    assert.ok(decoded.includes(changed), 'a changed stamp invalidates the saved image fingerprint');
    assert.ok(decoded.includes(added), 'new files are fully analysed');
    assert.ok(!decoded.includes(removed), 'removed files do not re-enter the analysis');
    const unchanged = new Set(completedPaths.filter((path) => path !== changed && path !== removed));
    assert.ok(
      decoded.every((path) => !unchanged.has(path)),
      'every unchanged completed feature is reused',
    );
    assert.equal(decoded.length, 33, 'only unfinished, changed and newly added files are decoded');

    decoded.length = 0;
    third.resume(started.id);
    const repeated = await third.wait(started.id);
    assert.equal(repeated.status, 'completed');
    assert.equal(repeated.resume!.savedFingerprints, 150);
    assert.equal(repeated.resume!.checkingFiles, false);
    assert.deepEqual(repeated.counts, done.counts);
    assert.deepEqual(decoded, [], 'resuming a completed job revalidates membership and stamps without re-decoding');
  } finally {
    release.resolve();
    await first.close();
    await second?.close();
    await third?.close();
    await f.close();
  }
});

test('resume clears inventory display floors when a previously saved file has been deleted', async () => {
  const f = await fixture();
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder(async () => signature) });
  try {
    const removed = join(f.media, 'removed.jpg');
    await writeFile(removed, 'one');
    await writeFile(join(f.media, 'kept.jpg'), 'different size');
    const started = await manager.start({ folders: [f.media], engine: 'legacy', ioConcurrency: 1 });
    await manager.wait(started.id);
    await rm(removed);
    assert.equal(manager.resume(started.id).counts.files, 2);
    const current = await manager.wait(started.id);
    assert.equal(current.resume!.savedFiles, 2);
    assert.equal(current.resume!.checkingFiles, false);
    assert.equal(current.counts.files, 1);
    assert.equal(current.counts.fingerprinted, 1);
    manager.resume(started.id);
    const next = await manager.wait(started.id);
    assert.equal(next.resume!.savedFiles, 1, 'historically removed records never inflate the next snapshot');
    assert.equal(next.counts.files, 1);
  } finally {
    await manager.close();
    await f.close();
  }
});

test('resumed checkpoint totals never turn a file-limited scope into complete coverage', async () => {
  const f = await fixture();
  let reads = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder(async () => {
      reads++;
      return signature;
    }),
  });
  try {
    for (let index = 0; index < 3; index++) await writeFile(join(f.media, `${index}.jpg`), 'x'.repeat(index + 1));
    const started = await manager.start({ folders: [f.media], engine: 'legacy', maxFiles: 2, ioConcurrency: 1 });
    const first = await manager.wait(started.id);
    assert.equal(first.scope.status, 'partial');
    manager.resume(started.id);
    const continued = await manager.wait(started.id);
    assert.equal(continued.resume!.savedFiles, 2);
    assert.equal(continued.resume!.checkingFiles, false);
    assert.equal(continued.scope.status, 'partial');
    assert.equal(continued.scope.listedFiles, 2);
    assert.ok(continued.limits.some((limit) => limit.code === 'file-limit'));
    assert.equal(reads, 2, 'records are reused without silently extending the permitted batch');
  } finally {
    await manager.close();
    await f.close();
  }
});
