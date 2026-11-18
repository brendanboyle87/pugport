import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';
import {
  isAllowedMsixMediaCacheMapping,
  LocalMediaStagingCache,
  MediaStagingChangedError,
} from '../src/server/media-staging.ts';
import { MediaWorkQueue } from '../src/server/media-work-queue.ts';

const availableSpace = async () => 100 * 1024 * 1024;
const signal = () => new AbortController().signal;

test('MSIX media cache mappings accept only the exact same private cache suffix under one local package', () => {
  const local = 'C:\\Users\\Test\\AppData\\Local';
  const logical = `${local}\\PugPort\\Cache\\media-verification`;
  const canonical = `${local}\\Packages\\OpenAI.Codex_abc123\\LocalCache\\Local\\PugPort\\Cache\\media-verification`;
  for (const [root, mapped, appData] of [
    [logical, canonical, local],
    [`${logical}\\job-123`, `${canonical}\\job-123`, local],
    [`${logical}\\`, `${canonical}\\`, `${local}\\`],
    [logical.toUpperCase(), canonical.toLowerCase(), local.toLowerCase()],
    [`${logical}/JOB-123`, `${canonical.replaceAll('\\', '/')}/job-123`, local.replaceAll('\\', '/')],
  ])
    assert.equal(
      isAllowedMsixMediaCacheMapping(root!, mapped!, appData!),
      true,
      'legitimate MSIX local-cache redirects are accepted',
    );
});

test('MSIX media cache mapping rejects different users, drives, suffixes, package nesting and similar prefixes', () => {
  const local = 'C:\\Users\\Test\\AppData\\Local';
  const logical = `${local}\\PugPort\\Cache\\media-verification\\job-123`;
  const canonical = `${local}\\Packages\\OpenAI.Codex_abc123\\LocalCache\\Local\\PugPort\\Cache\\media-verification\\job-123`;
  for (const [root, mapped, appData] of [
    [
      logical.replace('media-verification', 'media-verification-evil'),
      canonical.replace('media-verification', 'media-verification-evil'),
      local,
    ],
    [logical.replace('PugPort', 'OtherApp'), canonical.replace('PugPort', 'OtherApp'), local],
    [
      logical.replace('\\Cache\\media-verification', '\\Documents'),
      canonical.replace('\\Cache\\media-verification', '\\Documents'),
      local,
    ],
    [logical, canonical.replace('job-123', 'job-456'), local],
    [logical, canonical.replace('\\Test\\', '\\OtherUser\\'), local],
    [logical.replace('\\Test\\', '\\OtherUser\\'), canonical.replace('\\Test\\', '\\OtherUser\\'), local],
    [logical, canonical.replace('C:', 'D:'), local],
    [logical.replace('C:', 'D:'), canonical.replace('C:', 'D:'), local],
    [logical, canonical.replace('OpenAI.Codex_abc123', 'OpenAI.Codex_abc123\\extra'), local],
    [logical, canonical.replace('\\LocalCache\\Local\\', '\\LocalCache\\Local\\extra\\'), local],
    [logical, canonical.replace('\\Packages\\', '\\SomeOtherFolder\\'), local],
    [logical, canonical.replace('\\LocalCache\\Local\\', '\\LocalState\\'), local],
    [logical, `${local}\\arbitrary-junction-target\\job-123`, local],
    [logical, logical, local],
    ['PugPort\\Cache\\media-verification\\job-123', canonical, local],
    [logical, 'Packages\\OpenAI.Codex_abc123\\LocalCache\\Local\\PugPort\\Cache\\media-verification\\job-123', local],
    [logical, canonical, 'AppData\\Local'],
  ])
    assert.equal(
      isAllowedMsixMediaCacheMapping(root!, mapped!, appData!),
      false,
      'unrelated redirects must not gain permission from MSIX normalization',
    );
});

test('MSIX media cache mapping refuses UNC and Windows device paths even when their suffixes agree', () => {
  const local = 'C:\\Users\\Test\\AppData\\Local';
  const logical = `${local}\\PugPort\\Cache\\media-verification\\job-123`;
  const canonical = `${local}\\Packages\\OpenAI.Codex_abc123\\LocalCache\\Local\\PugPort\\Cache\\media-verification\\job-123`;
  for (const prefix of ['\\\\?\\', '\\\\.\\', '\\??\\']) {
    assert.equal(isAllowedMsixMediaCacheMapping(prefix + logical, prefix + canonical, prefix + local), false);
    assert.equal(isAllowedMsixMediaCacheMapping(logical, prefix + canonical, local), false);
  }
  const network = '\\\\server\\share\\Users\\Test\\AppData\\Local';
  assert.equal(
    isAllowedMsixMediaCacheMapping(logical.replace(local, network), canonical.replace(local, network), network),
    false,
  );
  assert.equal(
    isAllowedMsixMediaCacheMapping('//server/share/PugPort/Cache/media-verification/job-123', canonical, local),
    false,
  );
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-staging-test-')));
  const sourceRoot = join(root, 'sources'),
    cacheRoot = join(root, 'cache');
  await mkdir(sourceRoot);
  await mkdir(cacheRoot);
  const paths = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'].map((name) => join(sourceRoot, name));
  const content = paths.map((_path, at) => Buffer.alloc(48 + at * 16, 65 + at));
  await Promise.all(paths.map((path, at) => writeFile(path, content[at]!)));
  const caches: LocalMediaStagingCache[] = [];
  t.after(async () => {
    for (const cache of caches) await cache.close();
    const resolved = await realpath(root),
      temporary = await realpath(tmpdir());
    assert.equal(relative(temporary, resolved), basename(resolved));
    assert.ok(basename(resolved).startsWith('pugport-media-staging-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return {
    root,
    sourceRoot,
    cacheRoot,
    paths,
    content,
    make: (options: Partial<ConstructorParameters<typeof LocalMediaStagingCache>[0]> = {}) => {
      const cache = new LocalMediaStagingCache({
        cacheRoot,
        minFreeBytes: 0,
        spaceAvailable: availableSpace,
        ...options,
      });
      caches.push(cache);
      return cache;
    },
    assertSourcesUntouched: async () => {
      assert.deepEqual((await readdir(sourceRoot)).sort(), paths.map((path) => basename(path)).sort());
      for (const [at, path] of paths.entries()) assert.deepEqual(await readFile(path), content[at]);
    },
  };
}
async function namespace(cacheRoot: string) {
  const dirs = (await readdir(cacheRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('pugport-media-'),
  );
  assert.equal(dirs.length, 1);
  const directory = join(cacheRoot, dirs[0]!.name),
    marker = join(directory, '.pugport-media-staging.json');
  return { directory, marker, metadata: JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown> };
}

/** Observe actual copy attempts; synthetic fixtures never depend on source-drive timing. */
function copyAttempts(cache: LocalMediaStagingCache) {
  const internals = cache as unknown as {
    copy: (...args: unknown[]) => Promise<unknown>;
    options: { copyTimeoutMs: number };
    successfulCopyRates: number[];
  };
  const original = internals.copy.bind(cache);
  let attempts = 0;
  internals.copy = (...args) => {
    attempts++;
    return original(...args);
  };
  return { internals, count: () => attempts };
}

test('successful streaming measurements reject cold copies at the deadline headroom boundary but reuse ready copies', async (t) => {
  const f = await fixture(t);
  const [a, b, c] = f.paths as [string, string, string];
  await writeFile(a, Buffer.alloc(1024 * 1024, 65));
  const cache = f.make();
  const copies = copyAttempts(cache);
  cache.plan([a, b, a, b, a, c]);
  let ready: [string, string] | undefined;
  await cache.withPair([a, b], signal(), async (local) => {
    ready = local;
    assert.notEqual(local[0], a);
    assert.notEqual(local[1], b);
  });
  assert.equal(copies.count(), 2);
  assert.equal(
    copies.internals.successfulCopyRates.length,
    1,
    'only the completed substantial stream trains admission',
  );
  assert.ok(Number.isFinite(copies.internals.successfulCopyRates[0]) && copies.internals.successfulCopyRates[0]! > 0);
  // Calibrate the measured rate to an exact unit to test equality without timer or rounding noise.
  const rate = 1;
  copies.internals.successfulCopyRates[0] = rate;
  copies.internals.successfulCopyRates.push(10_000);
  const cSize = (await stat(c)).size;
  copies.internals.options.copyTimeoutMs = cSize / rate / 0.75;
  await cache.withPair([a, b], signal(), async (local) => assert.deepEqual(local, ready));
  assert.equal(copies.count(), 2, 'a ready pair bypasses cost admission even under a tiny deadline');
  const result = await cache.withPair([a, c], signal(), async (local) => {
    assert.equal(local[0], ready![0]);
    assert.equal(local[1], c, 'the cold source uses original verification rather than an incomplete copy');
    return await readFile(local[1]);
  });
  assert.deepEqual(result, f.content[2]);
  assert.equal(copies.count(), 2, 'cost rejection happens before opening a new copy');
});

test('cold copies below estimated headroom still stream normally', async (t) => {
  const f = await fixture(t);
  const [a, b, c] = f.paths as [string, string, string];
  await writeFile(a, Buffer.alloc(1024 * 1024, 65));
  const cache = f.make();
  const copies = copyAttempts(cache);
  cache.plan([a, b, a, c]);
  await cache.withPair([a, b], signal(), async () => undefined);
  assert.equal(copies.internals.successfulCopyRates.length, 1);
  // The boundary permits this small cold source, while allowing real I/O ample completion time.
  copies.internals.options.copyTimeoutMs = 120_000;
  await cache.withPair([a, c], signal(), async (local) => {
    assert.notEqual(local[1], c);
    assert.deepEqual(await readFile(local[1]), f.content[2]);
  });
  assert.equal(copies.count(), 3);
});

test('an exact source identity that timed out is not copied again until its stamp changes', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths as [string, string, string];
  const cache = f.make({ copyTimeoutMs: 0 });
  const copies = copyAttempts(cache);
  cache.plan([a, b, a, b, a, b]);
  await cache.withPair([a, b], signal(), async (local) => {
    assert.deepEqual(local, [a, b]);
    assert.deepEqual(await readFile(local[0]), f.content[0]);
  });
  assert.equal(copies.count(), 2);
  // A later larger deadline must not retry the proven timeout for this exact unchanged stamp.
  copies.internals.options.copyTimeoutMs = 120_000;
  await cache.withPair([a, b], signal(), async (local) => assert.deepEqual(local, [a, b]));
  assert.equal(copies.count(), 2);
  await writeFile(a, Buffer.alloc(49, 65));
  await cache.withPair([a, b], signal(), async (local) => {
    assert.notEqual(local[0], a, 'a changed source has a fresh opportunity to stage');
    assert.equal(local[1], b, 'the unchanged other source retains its timeout decision');
    assert.deepEqual(await readFile(local[0]), Buffer.alloc(49, 65));
  });
  assert.equal(copies.count(), 3);
  assert.equal(cache.performanceSnapshot().usedBytes, 0);
});

test('user cancellation as a copy deadline expires does not memoize a timeout or train successful throughput', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths as [string, string, string];
  const cache = f.make({ copyTimeoutMs: 0 });
  const copies = copyAttempts(cache);
  const controller = new AbortController();
  const ordinaryCopy = copies.internals.copy;
  let cancelOnce = true;
  copies.internals.copy = (...args) => {
    if (cancelOnce) {
      cancelOnce = false;
      controller.abort(new Error('synthetic user pause'));
    }
    return ordinaryCopy(...args);
  };
  cache.plan([a, b, a, b]);
  await assert.rejects(
    cache.withPair([a, b], controller.signal, async () => undefined),
    /synthetic user pause/,
  );
  assert.equal(copies.count(), 1);
  assert.equal(copies.internals.successfulCopyRates.length, 0);
  copies.internals.options.copyTimeoutMs = 120_000;
  await cache.withPair([a, b], signal(), async (local) => {
    assert.notEqual(local[0], a, 'cancellation leaves the source eligible for an ordinary later attempt');
    assert.notEqual(local[1], b);
    assert.deepEqual(await readFile(local[0]), f.content[0]);
  });
  assert.equal(copies.count(), 3);
  assert.equal(cache.performanceSnapshot().usedBytes, 0);
  await f.assertSourcesUntouched();
});

test('staged sources are reused until their last planned pair and original files stay untouched', async (t) => {
  const f = await fixture(t);
  const [a, b, c] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!, a!, c!]);
  let stagedA = '',
    stagedB = '',
    stagedC = '';
  const value = await cache.withPair([a!, b!], signal(), async ([localA, localB]) => {
    stagedA = localA;
    stagedB = localB;
    assert.notEqual(localA, a);
    assert.notEqual(localB, b);
    assert.ok(!relative(f.cacheRoot, localA).startsWith('..'));
    assert.deepEqual(await readFile(localA), f.content[0]);
    assert.deepEqual(await readFile(localB), f.content[1]);
    return 'checked first pair';
  });
  assert.equal(value, 'checked first pair');
  assert.equal(await exists(stagedA), true, 'the source needed by another pair remains staged');
  assert.equal(await exists(stagedB), false, 'the last reference releases this private copy');
  await cache.withPair([a!, c!], signal(), async ([localA, localC]) => {
    assert.equal(localA, stagedA, 'the shared source uses the same complete copy');
    stagedC = localC;
    assert.deepEqual(await readFile(localC), f.content[2]);
  });
  assert.equal(await exists(stagedA), false);
  assert.equal(await exists(stagedC), false);
  await f.assertSourcesUntouched();
});

test('finishPair consumes references for skipped checkpoints without deleting another pending pair source', async (t) => {
  const f = await fixture(t);
  const [a, b, c] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!, a!, c!]);
  let stagedA = '';
  await cache.withPair([a!, b!], signal(), async ([localA]) => {
    stagedA = localA;
  });
  assert.equal(await exists(stagedA), true);
  await cache.finishPair([a!, c!]);
  assert.equal(await exists(stagedA), false, 'a checkpoint skip releases its own remaining references');
  await f.assertSourcesUntouched();
});

test('cached-source affinity cuts measured source-copy bytes for alternating shared-video candidates', async (t) => {
  const f = await fixture(t);
  for (const [index, file] of f.paths.entries()) {
    f.content[index] = Buffer.alloc(index < 2 ? 80 : 16, 65 + index);
    await writeFile(file, f.content[index]!);
  }
  const [a, b, c, d] = f.paths as [string, string, string, string];
  const pairs: Array<[string, string]> = [
    [a, c],
    [b, c],
    [a, d],
    [b, d],
  ];
  const sizes = new Map(f.paths.map((file, index) => [file, f.content[index]!.length]));
  const run = async (affinity: boolean) => {
    const cache = f.make({ maxBytes: 112 });
    cache.plan(pairs.flat());
    const queue = new MediaWorkQueue(pairs, (pair) => pair);
    const checked: number[] = [];
    while (queue.remaining) {
      const ready = cache.cachedPaths();
      const item = queue.claim(
        checked.length === 0 ? 'front' : 'back',
        affinity
          ? {
              preferredSources: ready,
              lookahead: 1,
              score: (pair) => pair.reduce((sum, file) => sum + (ready.has(file) ? sizes.get(file)! : 0), 0),
            }
          : undefined,
      )!;
      await cache.withPair(item.value, signal(), async (local) => {
        for (const [index, original] of item.value.entries())
          assert.deepEqual(await readFile(local[index]!), await readFile(original));
      });
      queue.complete(item.index);
      checked.push(item.index);
    }
    const bytes = cache.performanceSnapshot().copyBytes;
    assert.equal(new Set(checked).size, pairs.length, 'ordering never omits or repeats a candidate');
    await cache.close();
    return { bytes, checked };
  };
  const baseline = await run(false);
  const affinity = await run(true);
  assert.deepEqual(baseline.checked, [0, 3, 2, 1]);
  assert.deepEqual(affinity.checked, [0, 2, 3, 1]);
  assert.equal(baseline.bytes, 368);
  assert.equal(affinity.bytes, 192, 'each shared video and small peer is copied only once');
  assert.ok(affinity.bytes < baseline.bytes * 0.6, 'copy reduction is measured through actual fixture streams');
  await f.assertSourcesUntouched();
});

test('explicit large SSD caches remain capped at 64 GiB and preserve at least 32 GiB free', async (t) => {
  const f = await fixture(t);
  const cache = f.make({
    maxBytes: 128 * 1024 ** 3,
    minFreeBytes: 0,
    spaceAvailable: async () => 31 * 1024 ** 3,
  });
  assert.equal(cache.performanceSnapshot().maxBytes, 64 * 1024 ** 3);
  const [a, b] = f.paths as [string, string];
  cache.plan([a, b]);
  await cache.withPair([a, b], signal(), async (local) => {
    assert.deepEqual(local, [a, b], 'low available space falls back instead of consuming the reserved free space');
  });
  assert.equal(cache.performanceSnapshot().copyBytes, 0);
  assert.equal(cache.performanceSnapshot().usedBytes, 0);
  await f.assertSourcesUntouched();
});

test('cached path hints are isolated snapshots and disappear after the cache closes', async (t) => {
  const f = await fixture(t);
  const cache = f.make();
  const [a, b, c] = f.paths as [string, string, string];
  cache.plan([a, b, a, c]);
  await cache.withPair([a, b], signal(), async () => undefined);
  const hints = cache.cachedPaths();
  assert.deepEqual([...hints], [a]);
  (hints as Set<string>).clear();
  assert.deepEqual([...cache.cachedPaths()], [a], 'a caller cannot mutate cache ownership through its hint set');
  await cache.close();
  assert.equal(cache.cachedPaths().size, 0);
});

test('callback failure releases its copies and preserves the original error', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!]);
  const failure = new Error('synthetic comparison failed');
  let copies: string[] = [];
  await assert.rejects(
    cache.withPair([a!, b!], signal(), async (local) => {
      copies = [...local];
      throw failure;
    }),
    (error) => error === failure,
  );
  for (const copy of copies) assert.equal(await exists(copy), false);
  await f.assertSourcesUntouched();
});

test('active copies cannot be evicted to make room for a concurrent pair', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b, c, d] = f.paths;
  const notes: string[] = [];
  const cache = f.make({ maxBytes: 112, note: (text) => notes.push(text) });
  cache.plan([a!, b!, c!, d!]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let firstCopies: string[] = [];
  const first = cache.withPair([a!, b!], signal(), async (local) => {
    firstCopies = [...local];
    assert.notEqual(local[0], a);
    assert.notEqual(local[1], b);
    entered();
    await gate;
    assert.deepEqual(await readFile(local[0]), f.content[0]);
    assert.deepEqual(await readFile(local[1]), f.content[1]);
  });
  try {
    await active;
    await cache.withPair([c!, d!], signal(), async (local) => {
      assert.deepEqual(local, [c, d], 'a full budget falls back to originals rather than removing active copies');
      for (const copy of firstCopies) assert.equal(await exists(copy), true);
    });
    assert.ok(notes.length > 0);
    release();
    await first;
  } finally {
    release();
    await first.catch(() => {});
  }
  for (const copy of firstCopies) assert.equal(await exists(copy), false);
  await f.assertSourcesUntouched();
});

test(
  'changing a shared source cannot unlink a copy that another comparison is still reading',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const [a, b, c] = f.paths;
    const cache = f.make();
    cache.plan([a!, b!, a!, c!]);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let firstCopy = '';
    const first = cache.withPair([a!, b!], signal(), async ([localA]) => {
      firstCopy = localA;
      assert.notEqual(localA, a);
      entered();
      await gate;
      assert.deepEqual(
        await readFile(localA),
        f.content[0],
        'the old active copy remains readable until its comparison ends',
      );
      return 'old evidence must not be published';
    });
    const rejected = assert.rejects(first, MediaStagingChangedError);
    try {
      await active;
      const replacement = Buffer.from('synthetic changed shared source with a new file size and contents');
      await writeFile(a!, replacement);
      await cache.withPair([a!, c!], signal(), async ([localA]) => {
        assert.equal(
          await exists(firstCopy),
          true,
          'selecting a changed source must not evict the first active reader',
        );
        assert.deepEqual(await readFile(firstCopy), f.content[0]);
        assert.deepEqual(await readFile(localA), replacement, 'the later comparison uses the current source contents');
      });
      release();
      await rejected;
      assert.equal(await exists(firstCopy), false);
      assert.deepEqual(await readFile(a!), replacement);
      assert.deepEqual(await readFile(b!), f.content[1]);
      assert.deepEqual(await readFile(c!), f.content[2]);
    } finally {
      release();
      await rejected;
    }
  },
);

test(
  'close waits for an active callback before deleting its copies and cancels its unpublished result',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const [a, b] = f.paths;
    const cache = f.make();
    cache.plan([a!, b!]);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let copies: string[] = [];
    const comparison = cache.withPair([a!, b!], signal(), async (local) => {
      copies = [...local];
      entered();
      await gate;
      assert.deepEqual(await readFile(local[0]), f.content[0]);
      assert.deepEqual(await readFile(local[1]), f.content[1]);
      return 'must not publish after shutdown';
    });
    const rejected = assert.rejects(comparison, /staging closed|abort|cancel/i);
    await active;
    const owned = await namespace(f.cacheRoot);
    let closed = false;
    const closing = cache.close();
    void closing.then(() => {
      closed = true;
    });
    try {
      assert.equal(cache.close(), closing, 'concurrent close requests share one cleanup');
      await Promise.resolve();
      assert.equal(closed, false);
      for (const copy of copies) assert.equal(await exists(copy), true);
      release();
      await rejected;
      await closing;
      assert.equal(closed, true);
      for (const copy of copies) assert.equal(await exists(copy), false);
      assert.equal(await exists(owned.directory), false);
      await f.assertSourcesUntouched();
    } finally {
      release();
      await rejected;
      await closing;
    }
  },
);

test('oversized inputs fall back to original paths without blocking comparison', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const notes: string[] = [];
  const cache = f.make({ maxBytes: 1, note: (text) => notes.push(text) });
  cache.plan([a!, b!]);
  const result = await cache.withPair([a!, b!], signal(), async (local) => {
    assert.deepEqual(local, [a, b]);
    return 42;
  });
  assert.equal(result, 42);
  assert.ok(notes.length > 0);
  await f.assertSourcesUntouched();
});

test('low free space falls back to originals and leaves no partial copy', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const notes: string[] = [];
  const cache = f.make({ minFreeBytes: 1000, spaceAvailable: async () => 999, note: (text) => notes.push(text) });
  cache.plan([a!, b!]);
  await cache.withPair([a!, b!], signal(), async (local) => assert.deepEqual(local, [a, b]));
  assert.ok(notes.length > 0);
  await f.assertSourcesUntouched();
});

test('a zero copy timeout deterministically aborts copying and never exposes a partial file as a complete source', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const notes: string[] = [];
  const cache = f.make({ copyTimeoutMs: 0, note: (text) => notes.push(text) });
  cache.plan([a!, b!, a!, b!]);
  for (let attempt = 0; attempt < 2; attempt++)
    await cache.withPair([a!, b!], signal(), async (local) => {
      assert.deepEqual(local, [a, b], 'timed-out copies are never handed to the verifier');
      assert.deepEqual(await readFile(local[0]), f.content[0]);
      assert.deepEqual(await readFile(local[1]), f.content[1]);
    });
  assert.ok(notes.some((text) => /timeout|超时|复制|copy/i.test(text)));
  const owned = await namespace(f.cacheRoot);
  assert.deepEqual(await readdir(owned.directory), ['.pugport-media-staging.json']);
  await f.assertSourcesUntouched();
});

test('an already cancelled pair creates no copy and cannot leave references holding private files open', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!]);
  const controller = new AbortController(),
    reason = new Error('synthetic staging cancelled');
  controller.abort(reason);
  let called = false;
  await assert.rejects(
    cache.withPair([a!, b!], controller.signal, async () => {
      called = true;
    }),
    (error) => error === reason || (error instanceof Error && /abort|cancel|取消/i.test(error.message)),
  );
  assert.equal(called, false);
  await cache.close();
  await f.assertSourcesUntouched();
});

test('modifying a staged copy during comparison rejects its result', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!]);
  let changed = '';
  await assert.rejects(
    cache.withPair([a!, b!], signal(), async ([localA]) => {
      assert.notEqual(localA, a);
      changed = localA;
      await writeFile(localA, 'synthetic altered staged contents');
      return 'must not publish';
    }),
    MediaStagingChangedError,
  );
  assert.equal(await exists(changed), false);
  await f.assertSourcesUntouched();
});

test('modifying an original during staged comparison rejects evidence based on its old copy', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!]);
  let copies: string[] = [];
  const changed = Buffer.from('synthetic original replacement with different contents and size');
  await assert.rejects(
    cache.withPair([a!, b!], signal(), async (local) => {
      copies = [...local];
      assert.notEqual(local[0], a);
      await writeFile(a!, changed);
      return 'must not publish stale evidence';
    }),
    MediaStagingChangedError,
  );
  for (const copy of copies) assert.equal(await exists(copy), false);
  assert.deepEqual(await readFile(a!), changed);
  assert.deepEqual(await readFile(b!), f.content[1]);
});

test('close removes only the private namespace and never touches unrelated cache-root files', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const sentinel = join(f.cacheRoot, 'unrelated-user-file.txt');
  await writeFile(sentinel, 'keep this unrelated file');
  const cache = f.make();
  cache.plan([a!, b!, a!, b!]);
  await cache.withPair([a!, b!], signal(), async () => {});
  const owned = await namespace(f.cacheRoot);
  assert.equal(await exists(owned.directory), true);
  await cache.close();
  await cache.close();
  assert.equal(await exists(owned.directory), false);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep this unrelated file');
  await f.assertSourcesUntouched();
});

test('stale cleanup preserves a live owner and invalid foreign markers but removes a dead owned namespace', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!, a!, b!]);
  await cache.withPair([a!, b!], signal(), async () => {});
  const owned = await namespace(f.cacheRoot);
  assert.equal(owned.metadata.ownerPid, process.pid);
  const foreign = join(f.cacheRoot, 'pugport-media-not-an-owned-uuid');
  await mkdir(foreign);
  await writeFile(join(foreign, '.pugport-media-staging.json'), JSON.stringify({ ownerPid: 2_147_483_647 }));
  await writeFile(join(foreign, 'user-file.txt'), 'foreign cache content');
  await LocalMediaStagingCache.cleanupStale(f.cacheRoot);
  assert.equal(await exists(owned.directory), true, 'a live owner is never scavenged');
  await writeFile(owned.marker, JSON.stringify({ ...owned.metadata, ownerPid: 2_147_483_647 }));
  await LocalMediaStagingCache.cleanupStale(f.cacheRoot);
  assert.equal(await exists(owned.directory), false);
  assert.equal(await readFile(join(foreign, 'user-file.txt'), 'utf8'), 'foreign cache content');
  await f.assertSourcesUntouched();
});

test('stale cleanup never traverses a directory junction into another source directory', async (t) => {
  const f = await fixture(t);
  const [a, b] = f.paths;
  const cache = f.make();
  cache.plan([a!, b!, a!, b!]);
  await cache.withPair([a!, b!], signal(), async () => {});
  const owned = await namespace(f.cacheRoot),
    external = join(f.root, 'external');
  await mkdir(external);
  const sentinel = join(external, 'never-remove.txt');
  await writeFile(sentinel, 'outside private namespace');
  const link = join(owned.directory, 'unexpected-junction');
  try {
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return t.skip('directory links are unavailable');
    throw error;
  }
  await writeFile(owned.marker, JSON.stringify({ ...owned.metadata, ownerPid: 2_147_483_647 }));
  await LocalMediaStagingCache.cleanupStale(f.cacheRoot);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside private namespace');
  assert.equal((await stat(external)).isDirectory(), true);
  await f.assertSourcesUntouched();
});
