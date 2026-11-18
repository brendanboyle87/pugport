import assert from 'node:assert/strict';
import test from 'node:test';
import { flushThenExit } from '../src/electron/keyring-exit.ts';

test('session data is flushed before the early exit, even when one flush fails', async () => {
  const order: string[] = [];
  await flushThenExit({
    flush: [
      () => order.push('storage'),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('cookies');
      },
      () => Promise.reject(new Error('flush failed')),
    ],
    exit: () => order.push('exit'),
  });
  assert.deepEqual(order, ['storage', 'cookies', 'exit']);
});

test('a flush that never finishes cannot hold the exit', async () => {
  let exited = false;
  const started = Date.now();
  await flushThenExit({ flush: [() => new Promise(() => {})], exit: () => (exited = true), timeoutMs: 30 });
  assert.equal(exited, true);
  assert.ok(Date.now() - started < 1000);
});
