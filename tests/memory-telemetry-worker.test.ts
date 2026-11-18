import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { backendActivity } from '../src/server/backend-activity.ts';
import { memoryTelemetry, watchMemoryWorker } from '../src/server/memory-telemetry.ts';

for (const mode of ['exit', 'error', 'terminate'] as const) {
  test(`worker ${mode} clears only its own open jobs`, async () => {
    const make = () => {
      const worker = new Worker(
        `const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (mode) => {
          if (mode === 'exit') process.exit(0);
          if (mode === 'error') throw Error('synthetic');
        });
        parentPort.postMessage({ telemetry: true, type: 'start', id: '1:1', name: 'embedding-model-unload' });
        parentPort.postMessage('ready');`,
        { eval: true },
      );
      watchMemoryWorker(worker);
      const ready = new Promise<void>((resolve) =>
        worker.on('message', (value) => {
          if (value === 'ready') resolve();
        }),
      );
      worker.on('error', () => {});
      return { worker, ready };
    };
    const first = make(),
      second = make();
    try {
      await Promise.all([first.ready, second.ready]);
      assert.equal(backendActivity.stack().filter((name) => name === 'embedding-model-unload').length, 2);
      const exited = new Promise<void>((resolve) => first.worker.once('exit', () => resolve()));
      if (mode === 'terminate') await first.worker.terminate();
      else first.worker.postMessage(mode);
      await exited;
      assert.equal(backendActivity.stack().filter((name) => name === 'embedding-model-unload').length, 1);
      await second.worker.terminate();
      assert.equal(backendActivity.lagStack().includes('embedding-model-unload'), false);
      assert.equal(
        memoryTelemetry.view().jobs.some((job) => job.name === 'embedding-model-unload'),
        false,
      );
    } finally {
      await Promise.all([first.worker.terminate(), second.worker.terminate()]);
    }
  });
}

test('normal end is processed before exit and remains a completed measurement', async () => {
  const worker = new Worker(
    `const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ telemetry: true, type: 'start', id: '1:1', name: 'embedding-model-load' });
    parentPort.postMessage({ telemetry: true, type: 'end', id: '1:1' });`,
    { eval: true },
  );
  watchMemoryWorker(worker);
  await once(worker, 'exit');
  assert.equal(backendActivity.stack().includes('embedding-model-load'), false);
  assert.equal(memoryTelemetry.view().jobs.at(-1)?.name, 'embedding-model-load');
});
