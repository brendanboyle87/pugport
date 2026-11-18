import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agreeingMatches,
  openCv,
  orbFeatures,
  prepareQuery,
  matchQuery,
  releaseQuery,
  stopMatchWorker,
  modelProvider,
} from '../src/server/image-match.ts';
import { memoryTelemetry } from '../src/server/memory-telemetry.ts';

test('synthetic OpenCV work releases every algorithm instance', async (t) => {
  const cv = await openCv();
  let allocated = 0,
    released = 0;
  for (const name of ['ORB', 'BFMatcher'] as const) {
    const Original = cv[name];
    t.mock.method(cv, name, function (...args: unknown[]) {
      const value = Reflect.construct(Original, args) as { delete(): void };
      allocated++;
      const dispose = value.delete.bind(value);
      value.delete = () => {
        released++;
        dispose();
      };
      return value;
    } as unknown as typeof Original);
  }
  const before = process.memoryUsage();
  const data = Uint8Array.from({ length: 128 * 128 }, (_, index) => (index * 137 + (index % 17) * 29) % 256);
  for (let i = 0; i < 10; i++) {
    const first = await orbFeatures({ data, width: 128, height: 128 });
    const second = await orbFeatures({ data, width: 128, height: 128 });
    try {
      await agreeingMatches(first, second);
    } finally {
      first.release();
      second.release();
    }
  }
  t.diagnostic(
    JSON.stringify({
      iterations: 10,
      allocatedAlgorithms: allocated,
      releasedAlgorithms: released,
      retainedAlgorithms: allocated - released,
      rssGrowthMiB: (process.memoryUsage().rss - before.rss) / 1024 ** 2,
    }),
  );
  assert.equal(allocated, 30);
  assert.equal(released, allocated);
});

test('image worker stays alive for query leases and releases WASM after five idle minutes despite status polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => {
    await stopMatchWorker();
  });
  const grey = { data: new Uint8Array(128 * 128).fill(127), width: 128, height: 128 };
  await prepareQuery('synthetic-idle', grey);
  t.mock.timers.tick(300000);
  assert.equal(await matchQuery('synthetic-idle', grey), 0);
  await releaseQuery('synthetic-idle');
  const unloaded = () => memoryTelemetry.view().jobs.filter((job) => job.name === 'embedding-model-unload');
  const before = unloaded().length;
  t.mock.timers.tick(299999);
  await modelProvider();
  assert.equal(unloaded().length, before);
  t.mock.timers.tick(1);
  await stopMatchWorker();
  assert.equal(unloaded().length, before + 1);
  const job = unloaded().at(-1)!;
  t.diagnostic(
    JSON.stringify({ syntheticWorkerReleasedMiB: (job.rssBefore - job.rssAfter) / 1024 ** 2, idleMs: 300000 }),
  );
});
