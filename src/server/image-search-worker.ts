import { parentPort } from 'node:worker_threads';
import {
  executeImageSearch,
  executeImageBackground,
  imageIndexStatus,
  type Memory,
  type Scope,
} from './image-search.ts';

type Request = {
  id: number;
  job: {
    appRoot: string;
    statusOnly?: boolean;
    params?: Parameters<typeof executeImageSearch>[1];
    budget?: Parameters<typeof executeImageSearch>[2];
    memory?: Memory;
    scope?: Scope;
  };
  aborted?: boolean;
};
const jobs = new Map<number, { abort: AbortController; scope: Scope }>();
let queue = Promise.resolve();
parentPort!.on('message', (message: Request | { id: number; abort?: boolean; scope?: Scope }) => {
  if (!('job' in message)) {
    const state = jobs.get(message.id);
    if (message.abort) state?.abort.abort();
    if (message.scope && state) Object.assign(state.scope, message.scope);
    return;
  }
  const { id, job } = message;
  const queuedAt = Date.now();
  const state = {
    abort: new AbortController(),
    scope: job.scope ?? { folders: job.params?.folders ?? [], version: 0 },
  };
  if (message.aborted) state.abort.abort();
  jobs.set(id, state);
  // Queued requests share this worker's index; unchanged pictures are never decoded twice.
  const heartbeat = setInterval(() => parentPort!.postMessage({ id, heartbeat: true }), 5_000);
  queue = queue.then(async () => {
    try {
      if (state.abort.signal.aborted) throw new Error('Image search cancelled.');
      if (job.budget) {
        const waiting = Date.now() - queuedAt;
        job.budget.analyzeUntil += waiting;
        if (job.budget.readUntil !== undefined) job.budget.readUntil += waiting;
      }
      const outcome = job.statusOnly
        ? undefined
        : job.params && job.budget
          ? await executeImageSearch(
              job.appRoot,
              job.params,
              job.budget,
              state.abort.signal,
              (...progress) => parentPort!.postMessage({ id, progress }),
              state.scope,
              job.memory,
            )
          : await executeImageBackground(job.appRoot, state.abort.signal, (...progress) =>
              parentPort!.postMessage({ id, progress }),
            );
      parentPort!.postMessage({ id, outcome, memory: job.memory, status: imageIndexStatus(job.appRoot) });
    } catch (error) {
      parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(heartbeat);
      jobs.delete(id);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
