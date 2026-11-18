import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { GrokHistorySyncWorker, type GrokHistorySyncJob } from '../src/server/grok-history-worker-client.ts';
import type { GrokHistorySyncResult } from '../src/server/grok-history-sync.ts';
import { LocalMemoryScheduler, type MemoryResult } from '../src/server/local-memory-scheduler.ts';

function fakeWorker() {
  let terminated = 0;
  const worker = Object.assign(new EventEmitter(), {
    ref() {},
    unref() {},
    async terminate() {
      terminated++;
      return 0;
    },
    postMessage(value: { id: string }) {
      queueMicrotask(() =>
        worker.emit('message', {
          id: value.id,
          result: {
            conversationId: 'synthetic',
            sessions: 1,
            addedMessages: 0,
            retainedMessages: 1,
            incompleteLines: 0,
            changed: false,
            warnings: [],
          },
        }),
      );
    },
  });
  return { worker: worker as unknown as Worker, terminated: () => terminated };
}

test('Grok worker is cleared at 60 seconds idle and is recreated for the next job', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new GrokHistorySyncWorker();
  const probe = client as unknown as {
    worker?: Worker;
    restarting?: Promise<void>;
    createWorker(job: GrokHistorySyncJob): Worker;
    finish(error?: Error, result?: GrokHistorySyncResult): void;
  };
  const created: ReturnType<typeof fakeWorker>[] = [];
  t.mock.method(probe, 'createWorker', () => {
    const next = fakeWorker();
    next.worker.on('message', (reply: { result: GrokHistorySyncResult }) => probe.finish(undefined, reply.result));
    created.push(next);
    return next.worker;
  });
  t.after(() => client.close());
  const job = { projectId: 'synthetic', dataDir: 'synthetic-data', appRoot: 'synthetic-app', grokHomes: [] };
  await client.execute(job);
  t.mock.timers.tick(59999);
  assert.equal(probe.worker, created[0]!.worker);
  t.mock.timers.tick(1);
  assert.equal(probe.worker, undefined);
  await probe.restarting;
  assert.equal(created[0]!.terminated(), 1);
  await client.execute(job);
  assert.equal(created.length, 2);
  assert.equal(probe.worker, created[1]!.worker);
  t.diagnostic('Grok idle timeout: 300000 -> 60000 ms; retained worker after 60000 ms: 1 -> 0');
});

test('local export worker is cleared at 60 seconds after completing its job', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduler = new LocalMemoryScheduler('synthetic-data', 'synthetic-app', () => {});
  const probe = (
    scheduler as unknown as {
      executor: {
        worker?: Worker;
        active?: { id: string; projectId: string; resolve(value: MemoryResult): void };
        stopping?: Promise<unknown>;
        finish(value: MemoryResult): void;
      };
    }
  ).executor;
  const { worker, terminated } = fakeWorker();
  probe.worker = worker;
  const completed = new Promise<MemoryResult>((resolve) => {
    probe.active = { id: 'synthetic-job', projectId: 'synthetic', resolve };
  });
  t.after(() => scheduler.close());
  const result = { projectId: 'synthetic', files: [], warnings: [] };
  probe.finish(result);
  assert.equal(await completed, result);
  t.mock.timers.tick(59999);
  assert.equal(probe.worker, worker);
  t.mock.timers.tick(1);
  assert.equal(probe.worker, undefined);
  await probe.stopping;
  assert.equal(terminated(), 1);
  t.diagnostic('export idle timeout: 300000 -> 60000 ms; retained worker after 60000 ms: 1 -> 0');
});
