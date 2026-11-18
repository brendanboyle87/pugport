import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { LocalMediaStagingCache } from '../src/server/media-staging.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temporary = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporary, 'pugport-ready-hit-test-')));
  const sourceRoot = join(root, 'sources');
  const cacheRoot = join(root, 'cache');
  await Promise.all([mkdir(sourceRoot), mkdir(cacheRoot)]);
  const paths = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'].map((name) => join(sourceRoot, name));
  const contents = paths.map((_file, index) => Buffer.alloc(64 + index, 65 + index));
  await Promise.all(paths.map((file, index) => writeFile(file, contents[index]!)));
  const entered = deferred();
  const released = deferred();
  let blocking = false;
  let availabilityCalls = 0;
  const cache = new LocalMediaStagingCache({
    cacheRoot,
    minFreeBytes: 0,
    spaceAvailable: async () => {
      availabilityCalls++;
      if (blocking) {
        entered.resolve();
        await released.promise;
      }
      return 100 * 1024 * 1024;
    },
  });
  t.after(async () => {
    released.resolve();
    await cache.close();
    const resolved = await realpath(root);
    assert.equal(relative(temporary, resolved), basename(resolved));
    assert.ok(basename(resolved).startsWith('pugport-ready-hit-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const [a, b, c, d] = paths as [string, string, string, string];
  cache.plan([a, b, a, b, a, b, c, d, c, d]);
  let originals: [string, string] | undefined;
  await cache.withPair([a, b], new AbortController().signal, async (local) => {
    originals = local;
  });
  assert.ok(originals);
  return {
    cache,
    paths: [a, b, c, d] as const,
    contents,
    copies: originals,
    entered,
    released,
    calls: () => availabilityCalls,
    block: () => {
      blocking = true;
    },
  };
}

test('valid ready pair decodes while an unrelated source-copy operation holds the serial gate', async (t) => {
  const f = await fixture(t);
  const [a, b, c, d] = f.paths;
  f.block();
  const cold = f.cache.withPair([c, d], new AbortController().signal, async () => undefined);
  await f.entered.promise;
  const callsBefore = f.calls();
  const hitEntered = deferred();
  const deadline = new AbortController();
  const hit = f.cache.withPair([a, b], new AbortController().signal, async (local, localIds, originalIds) => {
    assert.deepEqual(local, f.copies);
    assert.ok(localIds.every(Boolean) && originalIds.every(Boolean));
    assert.deepEqual(await readFile(local[0]), f.contents[0]);
    assert.deepEqual(await readFile(local[1]), f.contents[1]);
    hitEntered.resolve();
  });
  try {
    await Promise.race([
      hitEntered.promise,
      delay(3000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('The ready pair waited behind an unrelated source copy.');
      }),
    ]);
    assert.equal(f.calls(), callsBefore, 'a ready hit never reserves capacity or copies another source');
  } finally {
    deadline.abort();
    f.released.resolve();
    await Promise.all([cold, hit]);
  }
  for (const [index, original] of f.paths.entries()) assert.deepEqual(await readFile(original), f.contents[index]);
});

test('completed ready pairs publish and claim another pair before unrelated copying releases the gate', async (t) => {
  const f = await fixture(t);
  const [a, b, c, d] = f.paths;
  f.block();
  const cold = f.cache.withPair([c, d], new AbortController().signal, async () => undefined);
  await f.entered.promise;
  const deadline = new AbortController();
  let comparisons = 0;
  const verify = async () => {
    for (let index = 0; index < 2; index++) {
      const result = await f.cache.withPair([a, b], new AbortController().signal, async (local) => {
        assert.deepEqual(local, f.copies, 'each ready pair retains the active cached files');
        assert.deepEqual(await readFile(local[0]), f.contents[0]);
        comparisons++;
        return index;
      });
      assert.equal(result, index, 'verified output is available before queued cleanup can run');
    }
  };
  const hot = verify();
  try {
    await Promise.race([
      hot,
      delay(3000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error('Ready work completion waited behind an unrelated source copy.');
      }),
    ]);
    assert.equal(comparisons, 2);
    await assert.rejects(
      f.cache.withPair([a, b], new AbortController().signal, async () => undefined),
      /not included in the staging plan/,
      'references are consumed before deferred cleanup, preventing an unplanned extra use',
    );
    assert.deepEqual(await readFile(f.copies[0]), f.contents[0], 'queued cleanup preserves owned copies until safe');
  } finally {
    deadline.abort();
    f.released.resolve();
    await Promise.all([cold, hot]);
    await f.cache.close();
  }
  for (const copy of f.copies)
    await assert.rejects(readFile(copy), { code: 'ENOENT' }, 'close joins cleanup before resolving');
});

test('close joins deferred ready-pair cleanup and the active cold-copy operation', async (t) => {
  const f = await fixture(t);
  const [a, b, c, d] = f.paths;
  f.block();
  const cold = f.cache.withPair([c, d], new AbortController().signal, async () => undefined);
  // close intentionally aborts this pending selection; observe the rejection immediately.
  const observedCold = cold.catch(() => undefined);
  await f.entered.promise;
  await f.cache.withPair([a, b], new AbortController().signal, async () => undefined);
  let closed = false;
  const closing = f.cache.close().then(() => {
    closed = true;
  });
  try {
    await delay(25);
    assert.equal(closed, false, 'shutdown cannot finish while its copy/cleanup gate is still occupied');
    assert.deepEqual(await readFile(f.copies[0]), f.contents[0]);
  } finally {
    f.released.resolve();
    await Promise.all([observedCold, closing]);
  }
  assert.equal(closed, true);
  const stopped = f.cache.performanceSnapshot();
  assert.equal(stopped.copying, false);
  assert.equal(stopped.pendingPairs, 0);
  assert.equal(stopped.activePairs, 0, 'shutdown/abort cannot leave an active ownership counter behind');
  assert.equal(stopped.usedBytes, 0);
  for (const copy of f.copies) await assert.rejects(readFile(copy), { code: 'ENOENT' });
});

test('performance snapshots count queued, active and streamed work without filesystem sampling', async (t) => {
  const f = await fixture(t);
  const [a, b, c, d] = f.paths;
  const primedBytes = f.contents[0]!.length + f.contents[1]!.length;
  const initial = f.cache.performanceSnapshot();
  assert.equal(initial.copying, false);
  assert.equal(initial.pendingPairs, 0);
  assert.equal(initial.activePairs, 0);
  assert.equal(initial.usedBytes, primedBytes);
  assert.equal(initial.copyBytes, primedBytes);
  assert.equal(initial.maxBytes, 8 * 1024 ** 3);
  assert.ok(initial.copyMilliseconds > 0);
  f.block();
  const cold = f.cache.withPair([c, d], new AbortController().signal, async () => undefined);
  await f.entered.promise;
  const queued = f.cache.withPair([c, d], new AbortController().signal, async () => undefined);
  const hotEntered = deferred();
  const hotReleased = deferred();
  const hot = f.cache.withPair([a, b], new AbortController().signal, async () => {
    hotEntered.resolve();
    await hotReleased.promise;
  });
  await hotEntered.promise;
  try {
    const calls = f.calls();
    for (let index = 0; index < 10; index++) {
      const blocked = f.cache.performanceSnapshot();
      assert.equal(blocked.copying, false, 'metadata/space waits do not claim an active streaming copy');
      assert.equal(blocked.pendingPairs, 1, 'the currently selecting pair is not counted as queued');
      assert.equal(blocked.activePairs, 3, 'ready callbacks remain active alongside queued selections');
      assert.equal(blocked.copyBytes, primedBytes);
      assert.equal(blocked.copyMilliseconds, initial.copyMilliseconds);
      assert.equal(blocked.usedBytes, primedBytes);
    }
    assert.equal(f.calls(), calls, 'sampling has no filesystem/space callback side effects');
    hotReleased.resolve();
    await hot;
    assert.equal(f.cache.performanceSnapshot().activePairs, 2, 'completed ready work releases active ownership');
  } finally {
    hotReleased.resolve();
    f.released.resolve();
    await Promise.all([cold, queued, hot]);
    await f.cache.close();
  }
  const finished = f.cache.performanceSnapshot();
  assert.equal(finished.copying, false);
  assert.equal(finished.pendingPairs, 0);
  assert.equal(finished.activePairs, 0);
  assert.equal(finished.usedBytes, 0);
  assert.equal(
    finished.copyBytes,
    f.contents.reduce((sum, content) => sum + content.length, 0),
  );
  assert.ok(finished.copyMilliseconds >= initial.copyMilliseconds);
});

for (const changed of ['original', 'local'] as const)
  test(`a changed ${changed} cannot bypass copy serialization through an old ready snapshot`, async (t) => {
    const f = await fixture(t);
    const [a, b, c, d] = f.paths;
    const replacement = Buffer.from(`changed ${changed} input`);
    await writeFile(changed === 'original' ? a : f.copies[0], replacement);
    f.block();
    const cold = f.cache.withPair([c, d], new AbortController().signal, async () => undefined);
    await f.entered.promise;
    let routed = false;
    const stale = f.cache.withPair([a, b], new AbortController().signal, async (local) => {
      routed = true;
      assert.notEqual(local[0], f.copies[0], 'the changed snapshot is retired, not reused');
      assert.deepEqual(await readFile(local[0]), changed === 'original' ? replacement : f.contents[0]);
    });
    try {
      await delay(150);
      assert.equal(routed, false, 'invalid ready snapshots must wait for the serialized recheck');
    } finally {
      f.released.resolve();
      await Promise.all([cold, stale]);
    }
    assert.equal(routed, true);
  });
