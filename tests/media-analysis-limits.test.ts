import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MediaAnalysisManager, RankedMediaCandidates } from '../src/server/media-analysis.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';

const signature = (time = 0): FrameSignature => ({
  time,
  hash: '0123456789abcdef',
  texture: 0,
  colours: Array(12).fill(0.25),
});
function decoder(overrides: Partial<MediaDecoder> = {}): MediaDecoder {
  return {
    description: 'Synthetic limits fixtures',
    image: async () => signature(),
    probe: async () => ({ duration: 120 }),
    frame: async (_path, time) => signature(time),
    compareImages: async () => ({ geometricInliers: 0 }),
    ...overrides,
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-limits-')));
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
    add: (name: string, text = `encoded:${name}`) => writeFile(join(folder, name), text),
  };
}

test('a bounded queue gives later files their first candidate before early files get extra candidates', () => {
  const candidates = new RankedMediaCandidates<{ file: number; rank: number }>(4);
  for (let file = 0; file < 4; file++) for (let rank = 0; rank < 3; rank++) candidates.add(rank, { file, rank });
  assert.equal(candidates.length, 4);
  assert.deepEqual(
    candidates.values(),
    [0, 1, 2, 3].map((file) => ({ file, rank: 0 })),
  );
  assert.equal(candidates.pruned, true);
});

test('a pause arriving during the final file-stat check cannot publish late evidence', async (t) => {
  const f = await fixture(t);
  await f.add('first.jpg', 'first encoded bytes');
  await f.add('second.jpg', 'other encoded bytes of a different size');
  const manager = new MediaAnalysisManager(join(f.root, 'data'), {
    decoder: decoder(),
  });
  f.managers.push(manager);
  const completed = await manager.wait((await manager.start({ folders: [f.folder], engine: 'legacy' })).id);
  const internal = manager as unknown as {
    db: DatabaseSync;
    record(
      id: string,
      a: unknown,
      b: unknown,
      evidence: object,
      roots: string[],
      signal: AbortSignal,
    ): Promise<boolean>;
  };
  const [a, b] = internal.db.prepare('SELECT * FROM files WHERE job=? ORDER BY id').all(completed.id);
  assert.ok(a && b);
  const stopped = new AbortController();
  const pending = internal.record(
    completed.id,
    a,
    b,
    { classification: 'image-candidate', explanation: 'Synthetic late evidence' },
    [f.folder],
    stopped.signal,
  );
  stopped.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(manager.status(completed.id).counts.results, completed.counts.results);
});

test('file truncation is persisted and explicit; resume does not pretend to advance beyond the same scope cap', async (t) => {
  const f = await fixture(t);
  await f.add('one.jpg');
  await f.add('two.jpg');
  await f.add('three.jpg');
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder() });
  f.managers.push(manager);
  const job = await manager.start({ folders: [f.folder], engine: 'legacy', maxFiles: 2 });
  const completed = await manager.wait(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.scope.status, 'partial');
  assert.equal(completed.scope.listedFiles, 2);
  assert.deepEqual(completed.scope.remainingDirectories, [f.folder]);
  assert.ok(completed.limits.some((item) => item.code === 'file-limit' && item.limit === 2));
  assert.match(completed.summary, /本批目录未覆盖完整范围/);
  assert.match(completed.summary, /同参数续跑.*不能自动补齐/);
  assert.match(completed.summary, /跨批/);
  assert.match(completed.summary, /不得称为全盘完成/);
  const oldFiles = completed.results;
  manager.resume(job.id);
  const resumed = await manager.wait(job.id);
  assert.equal(resumed.scope.status, 'partial');
  assert.equal(resumed.counts.files, 2);
  assert.deepEqual(resumed.results, oldFiles);
  await manager.close();
  const reopened = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder() });
  f.managers.push(reopened);
  assert.deepEqual(reopened.status(job.id).scope, resumed.scope);
  assert.deepEqual(reopened.status(job.id).limits, resumed.limits);
});

test('a scope with exactly the file limit is complete, and old unaudited records stay unknown', async (t) => {
  const f = await fixture(t);
  await f.add('one.jpg');
  await f.add('two.jpg');
  await f.add('readme.txt');
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder() });
  f.managers.push(manager);
  const report = await manager.wait((await manager.start({ folders: [f.folder], engine: 'legacy', maxFiles: 2 })).id);
  assert.equal(report.scope.status, 'complete');
  assert.equal(report.limits.length, 0);
  const db = (manager as unknown as { db: DatabaseSync }).db;
  db.prepare("UPDATE jobs SET audit='{}' WHERE id=?").run(report.id);
  const historical = manager.status(report.id);
  assert.equal(historical.scope.status, 'pending');
  assert.equal(historical.execution.actualEngine, undefined);
  assert.match(historical.summary, /目录范围尚未枚举完成/);
});

test('saved Gemma workflow executes with fingerprints and leaves a one-line compatibility note', async (t) => {
  const f = await fixture(t);
  await f.add('one.jpg');
  await f.add('two.jpg');
  const manager = new MediaAnalysisManager(join(f.root, 'data'), { decoder: decoder() });
  f.managers.push(manager);
  const report = await manager.wait(
    (await manager.start({ folders: [f.folder], engine: 'gemma', retrievalMode: 'adaptive' })).id,
  );
  assert.equal(report.status, 'completed');
  assert.equal(report.execution.requestedEngine, 'gemma');
  assert.equal(report.execution.actualEngine, 'legacy');
  assert.match(JSON.stringify(report), /Gemma 引擎已移除，本次使用本地指纹引擎/);
});
