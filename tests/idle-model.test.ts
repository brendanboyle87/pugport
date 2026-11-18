import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdleModel } from '../src/server/idle-model.ts';

test('concurrent requests share one lazy model and idle expiration disposes it exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let loads = 0,
    releases = 0;
  const model = new IdleModel<{ id: number }>(async () => {
    releases++;
  });
  const load = async () => ({ id: ++loads });
  assert.equal(loads, 0);
  assert.deepEqual(
    await Promise.all(Array.from({ length: 10 }, () => model.use('cpu', load, async (value) => value.id))),
    Array(10).fill(1),
  );
  t.mock.timers.tick(299999);
  await Promise.resolve();
  assert.equal(releases, 0);
  t.mock.timers.tick(1);
  await model.close();
  assert.equal(releases, 1);
  assert.equal(await model.use('cpu', load, async (value) => value.id), 2);
  await model.close();
  assert.equal(releases, 2);
  t.diagnostic('synthetic model: 10 concurrent requests -> 1 load; idle 299999 ms: 0 releases; 300000 ms: 1 release');
});

test('inference pins the session, device changes release the old copy, and failed loads can retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  let live = 0,
    peak = 0;
  const model = new IdleModel<number>(async () => {
    live--;
  });
  const load = async () => {
    peak = Math.max(peak, ++live);
    return live;
  };
  const first = model.use(
    'cpu',
    load,
    async () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  for (let n = 0; n < 5; n++) await Promise.resolve();
  t.mock.timers.tick(600000);
  assert.equal(live, 1);
  const second = model.use('gpu', load, async (value) => value);
  release();
  await first;
  await second;
  assert.equal(peak, 1);
  await model.close();
  await assert.rejects(
    model.use(
      'failed',
      async () => {
        throw Error('synthetic');
      },
      async (value) => value,
    ),
  );
  assert.equal(await model.use('retry', load, async (value) => value), 1);
  await model.close();
});
