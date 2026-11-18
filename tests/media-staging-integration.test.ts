import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MediaAnalysisManager } from '../src/server/media-analysis.ts';
import { MediaReadContext } from '../src/server/media-read-context.ts';
import { withFrameSignatureCache } from '../src/server/media-frame-cache.ts';
import { LocalMediaStagingCache } from '../src/server/media-staging.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';

function frame(time: number, seed = ''): FrameSignature {
  return {
    time,
    hash: createHash('sha256').update(`${seed}:${time}`).digest('hex').slice(0, 16),
    texture: 60,
    colours: Array(12).fill(0.25),
  };
}
async function filesUnder(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) => (entry.isDirectory() ? filesUnder(join(root, entry.name)) : [join(root, entry.name)])),
      )
    ).flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-staging-integration-')));
  const sources = join(root, 'sources'),
    cacheRoot = join(root, 'ssd-cache');
  await mkdir(sources);
  await mkdir(cacheRoot);
  const paths = ['a.mp4', 'b.mp4', 'c.mp4'].map((name) => join(sources, name));
  const contents = paths.map((file) => `different encoding bytes:${basename(file)}`);
  await Promise.all(paths.map((file, index) => writeFile(file, contents[index]!)));
  const managers: MediaAnalysisManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    const actual = await realpath(root),
      temporary = await realpath(tmpdir());
    assert.equal(relative(temporary, actual), basename(actual));
    assert.ok(basename(actual).startsWith('pugport-staging-integration-'));
    await rm(actual, { recursive: true, force: true });
  });
  const untouched = async () => {
    for (const [index, file] of paths.entries()) assert.equal(await readFile(file, 'utf8'), contents[index]);
  };
  return { root, sources, paths, cacheRoot, managers, untouched };
}
function decoder(read: MediaDecoder['frame']): MediaDecoder {
  return {
    description: 'Synthetic staging integration; no real media',
    cacheIdentity: 'synthetic-staging-integration-v1',
    image: async () => frame(0),
    probe: async () => ({ duration: 120, hasAudio: true }),
    frame: read,
  };
}

test('adaptive verification reads private local copies while evidence and cache remain tied to originals', async (t) => {
  const f = await fixture(t);
  const stagedReads: string[] = [];
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    staging: { cacheRoot: f.cacheRoot, minFreeBytes: 0 },
    decoder: decoder(async (file, time, signal) => {
      signal.throwIfAborted();
      await access(file);
      if (!f.paths.includes(file)) {
        assert.ok(!relative(f.cacheRoot, file).startsWith('..'));
        assert.match(basename(file), /^asset-/);
        stagedReads.push(file);
      }
      return frame(time);
    }),
  });
  f.managers.push(manager);
  const start = await manager.start({
    folders: [f.sources],
    kind: 'videos',
    engine: 'legacy',
    retrievalMode: 'adaptive',
    topK: 2,
    ioConcurrency: 4,
  });
  const result = await manager.wait(start.id);
  assert.equal(result.status, 'completed');
  assert.ok(stagedReads.length > 0, 'fresh aligned positions physically read private copies');
  assert.ok(result.results.length > 0);
  for (const evidence of result.results) {
    assert.ok(f.paths.includes(evidence.a));
    assert.ok(f.paths.includes(evidence.b));
    assert.equal(evidence.deleteEligible, false);
  }
  assert.deepEqual(await filesUnder(f.cacheRoot), [], 'all private copies and ownership markers are removed');
  await f.untouched();
  stagedReads.length = 0;
  manager.resume(start.id);
  const resumed = await manager.wait(start.id);
  assert.equal(resumed.status, 'completed');
  assert.ok(resumed.results.every((evidence) => evidence.reusedFromCheckpoint));
  assert.equal(stagedReads.length, 0, 'positive checkpoint pairs do not recreate copies');
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
});

test('adaptive completed negative checks skip copying on resume and keep original files unchanged', async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths[2]!, 'ignored third file');
  let stagedReads = 0;
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    staging: { cacheRoot: f.cacheRoot, minFreeBytes: 0 },
    decoder: decoder(async (file, time) => {
      if (f.paths.includes(file)) return frame(time);
      stagedReads++;
      const content = await readFile(file, 'utf8');
      return frame(time, content);
    }),
  });
  f.managers.push(manager);
  const start = await manager.start({
    folders: [f.sources],
    kind: 'videos',
    engine: 'legacy',
    retrievalMode: 'adaptive',
    topK: 2,
    ioConcurrency: 4,
  });
  const first = await manager.wait(start.id);
  assert.equal(first.status, 'completed');
  assert.equal(first.counts.results, 0);
  assert.ok(stagedReads > 0);
  const db = (manager as unknown as { db: DatabaseSync }).db;
  const completed = db.prepare('SELECT COUNT(*) AS count FROM pair_checks WHERE job=?').get(start.id) as {
    count: number;
  };
  assert.ok(completed.count > 0);
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
  stagedReads = 0;
  manager.resume(start.id);
  const resumed = await manager.wait(start.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.counts.results, 0);
  assert.equal(stagedReads, 0, 'completed negative pairs consume plan references without copying');
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), 'different encoding bytes:a.mp4');
  assert.equal(await readFile(f.paths[1]!, 'utf8'), 'different encoding bytes:b.mp4');
});

test('pause during asynchronous staging preparation cannot republish running or leave active work', async (t) => {
  const f = await fixture(t);
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    staging: { cacheRoot: f.cacheRoot, minFreeBytes: 0 },
    decoder: decoder(async (_file, time) => frame(time)),
  });
  f.managers.push(manager);
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seam = manager as unknown as {
    prepareStaging: (...args: any[]) => Promise<LocalMediaStagingCache | undefined>;
  };
  const actualPrepare = seam.prepareStaging.bind(manager);
  seam.prepareStaging = async (...args) => {
    const cache = await actualPrepare(...args);
    entered();
    await held;
    return cache;
  };
  const start = await manager.start({
    folders: [f.sources],
    kind: 'videos',
    engine: 'legacy',
    retrievalMode: 'adaptive',
    topK: 2,
    ioConcurrency: 4,
  });
  await preparing;
  manager.pause(start.id);
  release();
  const paused = await manager.wait(start.id);
  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.counts.results, 0);
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
  await f.untouched();
});

test('pausing an adaptive comparison aborts readers, cleans copies, and leaves no completed negative checkpoint', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const stagedRead = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    staging: { cacheRoot: f.cacheRoot, minFreeBytes: 0 },
    decoder: decoder(async (file, time, signal) => {
      if (f.paths.includes(file)) return frame(time);
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return frame(time);
    }),
  });
  f.managers.push(manager);
  const start = await manager.start({
    folders: [f.sources],
    kind: 'videos',
    engine: 'legacy',
    retrievalMode: 'adaptive',
    topK: 2,
    ioConcurrency: 4,
  });
  await stagedRead;
  manager.pause(start.id);
  const result = await manager.wait(start.id);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.counts.results, 0);
  const db = (manager as unknown as { db: DatabaseSync }).db;
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM pair_checks WHERE job=?').get(start.id) as { count: number }).count,
    0,
  );
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
  await f.untouched();
});

test('trusted copy stamps reject a changed baseline before it can poison the original-key frame cache', async (t) => {
  const f = await fixture(t);
  const cache = new LocalMediaStagingCache({ cacheRoot: f.cacheRoot, minFreeBytes: 0 });
  const db = new DatabaseSync(':memory:');
  let physicalReads = 0;
  const context = new MediaReadContext();
  const cached = withFrameSignatureCache(
    context.decoder(
      decoder(async (_file, time) => {
        physicalReads++;
        return frame(time);
      }),
    ),
    db,
    (path) => context.expectedOriginalIdentity(path),
  );
  cache.plan([f.paths[0]!, f.paths[1]!]);
  try {
    await assert.rejects(
      cache.withPair([f.paths[0]!, f.paths[1]!], new AbortController().signal, async (local, trusted, original) => {
        await writeFile(local[0], 'changed before route baseline capture');
        return context.run(
          [f.paths[0]!, f.paths[1]!],
          local,
          () => cached.frame(f.paths[0]!, 7, new AbortController().signal),
          trusted,
          original,
        );
      }),
      /changed|stamp|identity/i,
    );
    assert.equal(physicalReads, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM frame_signatures').get() as { count: number }).count, 0);
    await f.untouched();
  } finally {
    await cache.close();
    db.close();
  }
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
});

test('changing an original during a staged comparison never caches its old copy under the new original stamp', async (t) => {
  const f = await fixture(t);
  const cache = new LocalMediaStagingCache({ cacheRoot: f.cacheRoot, minFreeBytes: 0 });
  const db = new DatabaseSync(':memory:');
  const context = new MediaReadContext();
  const cached = withFrameSignatureCache(context.decoder(decoder(async (_file, time) => frame(time))), db, (path) =>
    context.expectedOriginalIdentity(path),
  );
  cache.plan([f.paths[0]!, f.paths[1]!]);
  try {
    await assert.rejects(
      cache.withPair([f.paths[0]!, f.paths[1]!], new AbortController().signal, async (local, trusted, original) => {
        return context.run(
          [f.paths[0]!, f.paths[1]!],
          local,
          async () => {
            await writeFile(f.paths[0]!, 'new original bytes after the staged copy was validated');
            return cached.frame(f.paths[0]!, 7, new AbortController().signal);
          },
          trusted,
          original,
        );
      }),
      /changed|stamp|identity/i,
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM frame_signatures').get() as { count: number }).count, 0);
  } finally {
    await cache.close();
    db.close();
  }
  assert.deepEqual(await filesUnder(f.cacheRoot), []);
});
