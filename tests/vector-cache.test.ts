import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { closeVectorCache, vectorCacheFile } from '../src/server/vector-cache.ts';
import { BackendActivity, EventLoopLag } from '../src/server/backend-activity.ts';

test('five cold vector cache reads and writes run with live event-loop samples', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-cache-worker-'));
  t.after(async () => {
    await closeVectorCache();
    await rm(directory, { recursive: true, force: true });
  });
  const value = {
    items: Array.from({ length: 3000 }, (_, n) => ({ messageId: `synthetic-${n}`, text: 'a'.repeat(200) })),
  };
  const files = Array.from({ length: 5 }, (_, n) => join(directory, `${n}.json`));
  const lag = new EventLoopLag(
    new BackendActivity(),
    () => {},
    () => performance.now(),
    10,
  );
  lag.start();
  try {
    await Promise.all(files.map((file) => vectorCacheFile(file, { value })));
    const rows = await Promise.all(files.map((file) => vectorCacheFile<typeof value>(file)));
    assert.ok(rows.every((row) => row.items.length === 3000 && row.items.at(-1)?.messageId === 'synthetic-2999'));
    assert.equal(JSON.parse(await readFile(files[0]!, 'utf8')).items.length, 3000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(lag.samples >= 2);
    assert.ok(lag.maxLagMs < 250, `cache IO max lag ${lag.maxLagMs.toFixed(1)}ms`);
    t.diagnostic(JSON.stringify({ cacheReads: 5, cacheWrites: 5, maxLagMs: lag.maxLagMs, samples: lag.samples }));
  } finally {
    lag.close();
  }
});

test('malformed cache rejects only that request and a closed worker can restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-cache-errors-'));
  t.after(async () => {
    await closeVectorCache();
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'cache.json');
  await writeFile(file, '{invalid');
  await assert.rejects(vectorCacheFile(file));
  await assert.rejects(vectorCacheFile(join(directory, 'missing')));
  await vectorCacheFile(file, { value: { valid: true } });
  await assert.rejects(vectorCacheFile(file, { value: { overwritten: true }, exclusive: true }));
  assert.deepEqual(await vectorCacheFile(file), { valid: true });
  await assert.rejects(vectorCacheFile(file, { value: () => 'uncloneable' }));
  await closeVectorCache();
  assert.deepEqual(await vectorCacheFile(file), { valid: true });
});

test('a stuck cache request times out, rejects other requests, and the worker restarts', async (t) => {
  await closeVectorCache();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const post = t.mock.method(Worker.prototype, 'postMessage', () => {});
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  const first = assert.rejects(vectorCacheFile('synthetic-stuck'), /timed out/);
  t.mock.timers.tick(1000);
  const second = assert.rejects(vectorCacheFile('synthetic-pending'), /timed out/);
  t.mock.timers.tick(28999);
  assert.equal(terminate.mock.callCount(), 0);
  t.mock.timers.tick(1);
  await Promise.all([first, second]);
  assert.equal(terminate.mock.callCount(), 1);
  await terminate.mock.calls[0].result;
  post.mock.restore();
  t.mock.timers.reset();
  const directory = await mkdtemp(join(tmpdir(), 'pugport-cache-restart-'));
  t.after(async () => {
    await closeVectorCache();
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'cache.json');
  await vectorCacheFile(file, { value: { recovered: true } });
  assert.deepEqual(await vectorCacheFile(file), { recovered: true });
});
