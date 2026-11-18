import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withFrameSignatureCache } from '../src/server/media-frame-cache.ts';
import type { FrameSignature, MediaDecoder } from '../src/server/media-decoder.ts';

const signature = (time: number): FrameSignature => ({
  time,
  hash: '123456789abcdef0',
  colours: Array(12).fill(0.2),
  texture: 30,
});
async function fixture(run: (path: string, db: DatabaseSync, folder: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'pugport-frame-cache-'));
  const path = join(folder, 'synthetic.mp4');
  await writeFile(path, 'fixture');
  const db = new DatabaseSync(join(folder, 'cache.sqlite'));
  try {
    await run(path, db, folder);
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
}
function decoder(frame: MediaDecoder['frame'], description = 'synthetic decoder v1'): MediaDecoder {
  return { frame, description, image: async () => signature(0), probe: async () => ({ duration: 120 }) };
}

async function waiting(signal: AbortSignal) {
  const deadline = Date.now() + 3000;
  while (getEventListeners(signal, 'abort').length === 0) {
    if (Date.now() >= deadline) throw new Error('Caller did not join the existing frame flight.');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('different-signal concurrent reads share the owner decode without replacing its flight', async () =>
  fixture(async (path, db) => {
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const cached = withFrameSignatureCache(
      decoder(async (_path, time) => {
        calls++;
        started.resolve();
        await gate.promise;
        return signature(time);
      }),
      db,
    );
    const owner = cached.frame(path, 12, new AbortController().signal);
    await started.promise;
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const waiters = controllers.map(({ signal }) => cached.frame(path, 12, signal));
    await Promise.all(controllers.map(({ signal }) => waiting(signal)));
    assert.equal(calls, 1);
    gate.resolve();
    assert.deepEqual(await Promise.all([owner, ...waiters]), Array(4).fill(signature(12)));
    assert.equal(calls, 1);
  }));

test('cancelling a waiter promptly rejects only its wait while the owner continues', async () =>
  fixture(async (path, db) => {
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const ownerController = new AbortController();
    const waiterController = new AbortController();
    const cached = withFrameSignatureCache(
      decoder(async (_path, time) => {
        calls++;
        started.resolve();
        await gate.promise;
        return signature(time);
      }),
      db,
    );
    const owner = cached.frame(path, 12, ownerController.signal);
    await started.promise;
    const waiter = cached.frame(path, 12, waiterController.signal);
    const rejected = assert.rejects(waiter, /waiter cancelled/);
    await waiting(waiterController.signal);
    waiterController.abort(new Error('waiter cancelled'));
    await rejected;
    assert.equal(ownerController.signal.aborted, false);
    assert.equal(getEventListeners(waiterController.signal, 'abort').length, 0);
    gate.resolve();
    assert.deepEqual(await owner, signature(12));
    assert.deepEqual(await cached.frame(path, 12, new AbortController().signal), signature(12));
    assert.equal(calls, 1);
  }));

for (const failure of ['cancel', 'error'] as const) {
  test(`owner ${failure} lets three independent waiters retry with one new decoder owner`, async () =>
    fixture(async (path, db) => {
      const firstGate = deferred();
      const retryGate = deferred();
      const started = deferred();
      const retryStarted = deferred();
      const ownerController = new AbortController();
      let calls = 0;
      let ownerFinished = false;
      const cached = withFrameSignatureCache(
        decoder(async (_path, time, signal) => {
          const call = ++calls;
          if (call === 1) {
            started.resolve();
            await firstGate.promise;
            signal.throwIfAborted();
            throw new Error('owner failed');
          }
          retryStarted.resolve();
          await retryGate.promise;
          return signature(time);
        }),
        db,
      );
      const owner = cached.frame(path, 12, ownerController.signal);
      const ownerRejected = assert
        .rejects(owner, failure === 'cancel' ? /owner cancelled/ : /owner failed/)
        .then(() => {
          ownerFinished = true;
        });
      await started.promise;
      const controllers = Array.from({ length: 3 }, () => new AbortController());
      const waiters = controllers.map(({ signal }) => cached.frame(path, 12, signal));
      await Promise.all(controllers.map(({ signal }) => waiting(signal)));
      if (failure === 'cancel') ownerController.abort(new Error('owner cancelled'));
      assert.equal(ownerFinished, false, 'owner still joins its decoder completion');
      assert.equal(calls, 1);
      firstGate.resolve();
      await ownerRejected;
      await retryStarted.promise;
      // Admission must stay serialized while the replacement decoder is pending.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      retryGate.resolve();
      assert.deepEqual(await Promise.all(waiters), Array(3).fill(signature(12)));
      assert.equal(calls, 2);
      for (const { signal } of controllers) assert.equal(getEventListeners(signal, 'abort').length, 0);
    }));
}

test('waiters revalidate the trusted original after its owner settles', async () =>
  fixture(async (path, db) => {
    const original = await stat(path, { bigint: true });
    const trusted = [original.dev, original.ino, original.size, original.mtimeNs, original.ctimeNs].join(':');
    const gate = deferred();
    const started = deferred();
    let calls = 0;
    const cached = withFrameSignatureCache(
      decoder(async (_path, time) => {
        calls++;
        started.resolve();
        await gate.promise;
        return signature(time);
      }),
      db,
      () => trusted,
    );
    const owner = cached.frame(path, 12, new AbortController().signal);
    const ownerRejected = assert.rejects(owner, /Original media changed/);
    await started.promise;
    const waiterController = new AbortController();
    const waiter = cached.frame(path, 12, waiterController.signal);
    const waiterRejected = assert.rejects(waiter, /Original media changed/);
    await waiting(waiterController.signal);
    await writeFile(path, 'changed while both callers are pending');
    gate.resolve();
    await Promise.all([ownerRejected, waiterRejected]);
    assert.equal(calls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_signatures').get()!.n, 0);
  }));

test('persisted signatures survive reopening the database without decoding', async () =>
  fixture(async (path, db, folder) => {
    let calls = 0;
    const signal = new AbortController().signal;
    const cached = withFrameSignatureCache(
      decoder(async (_path, time) => {
        calls++;
        return signature(time);
      }),
      db,
    );
    await cached.frame(path, 12, signal);
    assert.equal(calls, 1);
    const reopened = new DatabaseSync(join(folder, 'cache.sqlite'));
    try {
      const again = withFrameSignatureCache(
        decoder(async () => {
          throw new Error('must not decode');
        }),
        reopened,
      );
      assert.deepEqual(await again.frame(path, 12, signal), signature(12));
    } finally {
      reopened.close();
    }
  }));

test('same-signal concurrent reads share one decoder but exact times stay distinct', async () =>
  fixture(async (path, db) => {
    let calls = 0;
    const cached = withFrameSignatureCache(
      decoder(async (_path, time) => {
        calls++;
        await new Promise((done) => setTimeout(done, 5));
        return signature(time);
      }),
      db,
    );
    const signal = new AbortController().signal;
    const values = await Promise.all([
      cached.frame(path, 1.00001, signal),
      cached.frame(path, 1.00001, signal),
      cached.frame(path, 1.00002, signal),
    ]);
    assert.equal(calls, 2);
    assert.deepEqual(
      values.map((item) => item.time),
      [1.00001, 1.00001, 1.00002],
    );
  }));

test('file change and decoder identity invalidate saved signatures', async () =>
  fixture(async (path, db) => {
    let calls = 0;
    const make = (description: string) =>
      withFrameSignatureCache(
        decoder(async (_path, time) => {
          calls++;
          return signature(time);
        }, description),
        db,
      );
    const signal = new AbortController().signal;
    const cached = make('synthetic v1');
    await cached.frame(path, 0, signal);
    await writeFile(path, 'changed fixture');
    await cached.frame(path, 0, signal);
    await make('synthetic v2').frame(path, 0, signal);
    assert.equal(calls, 3);
  }));

test('errors, cancellation, and input changes during decoding do not cache results', async () =>
  fixture(async (path, db) => {
    const signal = new AbortController().signal;
    const failure = withFrameSignatureCache(
      decoder(async () => {
        throw new Error('decode failed');
      }),
      db,
    );
    await assert.rejects(failure.frame(path, 0, signal), /decode failed/);
    const cancel = new AbortController();
    const aborting = withFrameSignatureCache(
      decoder(async (_path, time) => {
        cancel.abort();
        return signature(time);
      }),
      db,
    );
    await assert.rejects(aborting.frame(path, 0, cancel.signal));
    const changed = withFrameSignatureCache(
      decoder(async (_path, time) => {
        await writeFile(path, 'changed while reading');
        return signature(time);
      }),
      db,
    );
    await changed.frame(path, 0, signal);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frame_signatures').get()!.n, 0);
  }));

test('malformed saved signature falls back to real decoding', async () =>
  fixture(async (path, db) => {
    let calls = 0;
    const cached = withFrameSignatureCache(
      decoder(async (_path, time) => {
        calls++;
        return signature(time);
      }),
      db,
    );
    const signal = new AbortController().signal;
    await cached.frame(path, 0, signal);
    db.prepare('UPDATE frame_signatures SET data=?').run('{bad json');
    await cached.frame(path, 0, signal);
    assert.equal(calls, 2);
  }));

test('class decoder methods retain their original instance and optional methods', async () =>
  fixture(async (path, db) => {
    class ClassDecoder implements MediaDecoder {
      description = 'class synthetic decoder';
      duration = 42;
      async image() {
        return signature(this.duration);
      }
      async probe() {
        return { duration: this.duration };
      }
      async frame(_path: string, time: number) {
        return { ...signature(time), texture: this.duration };
      }
      async compareImages() {
        return { geometricInliers: this.duration };
      }
    }
    const cached = withFrameSignatureCache(new ClassDecoder(), db);
    const signal = new AbortController().signal;
    assert.equal((await cached.image(path, signal)).time, 42);
    assert.equal((await cached.probe(path, signal)).duration, 42);
    assert.equal((await cached.frame(path, 0, signal)).texture, 42);
    assert.equal((await cached.compareImages!(path, path, signal)).geometricInliers, 42);
  }));
