import { Worker } from 'node:worker_threads';

export type MemoryVectorJob = {
  databasePath: string;
  appRoot: string;
  projectId: string;
  vectorDirectory: string;
  until: number;
};

let queue: Promise<unknown> = Promise.resolve();

/** A single indexing job owns the model and cache writes; readers continue using the previous cache. */
export function runMemoryVectorWorker(
  job: MemoryVectorJob,
  signal?: AbortSignal,
  timeoutMs = 6 * 60_000,
): Promise<number> {
  const next = queue
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      const source = import.meta.filename.endsWith('.ts');
      const entry = new URL(source ? './memory-vector-worker.ts' : './memory-vector-worker.js', import.meta.url).href;
      const worker = new Worker(
        `(async () => {
        const { workerData } = require('node:worker_threads');
        if (workerData.source) {
          const { tsImport } = await import('tsx/esm/api');
          await tsImport(workerData.entry, workerData.parent);
        } else await import(workerData.entry);
      })().catch(error => { throw error; });`,
        { eval: true, workerData: { source, entry, parent: import.meta.url, job } },
      );
      let timer: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      try {
        return await new Promise<number>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Memory vector indexing timed out.')), timeoutMs);
          abort = () => reject(signal?.reason ?? new Error('Memory vector indexing cancelled.'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          worker.once('error', reject);
          worker.once('exit', () => reject(new Error('Memory vector indexing stopped.')));
          worker.on('message', (reply: { remaining?: number; error?: string }) => {
            if (reply.error) reject(new Error(reply.error));
            else if (typeof reply.remaining === 'number') resolve(reply.remaining);
          });
        });
      } finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
        // Do not allow cleanup or the next writer to race a terminating worker.
        await worker.terminate();
      }
    });
  queue = next;
  return next;
}
