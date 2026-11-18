import { Worker } from 'node:worker_threads';

type Client = {
  worker: Worker;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  idle?: NodeJS.Timeout;
};
let client: Client | undefined;
let sequence = 0;

/** One shared IO/JSON worker; no model, provider or user script is loaded here. */
export async function vectorCacheFile<T>(file: string, write?: { value: unknown; exclusive?: boolean }): Promise<T> {
  // The worker does the parsing; waiting for it is not main-thread work, so no busy breadcrumb.
  if (!client) {
    const source = import.meta.filename.endsWith('.ts');
    const entry = new URL(source ? './vector-cache-worker.ts' : './vector-cache-worker.js', import.meta.url).href;
    const worker = new Worker(
      `(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.source) {
        const { tsImport } = await import('tsx/esm/api');
        await tsImport(workerData.entry, workerData.parent);
      } else await import(workerData.entry);
    })().catch(error => { throw error; });`,
      {
        eval: true,
        workerData: { source, entry, parent: import.meta.url },
      },
    );
    const current = (client = { worker, pending: new Map() } as Client);
    worker.on('error', (error: Error) => fail(current, error));
    worker.on('exit', () => fail(current, new Error('Vector cache worker stopped.')));
    worker.on('message', (reply: { id: number; value?: unknown; error?: string }) => {
      const job = current.pending.get(reply.id);
      if (!job) return;
      clearTimeout(job.timer);
      current.pending.delete(reply.id);
      if (reply.error) job.reject(new Error(reply.error));
      else job.resolve(reply.value);
      armIdle(current);
    });
  }
  const current = client;
  clearTimeout(current.idle);
  current.worker.ref();
  const id = ++sequence;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      fail(current, new Error('Vector cache worker request timed out.'));
      void current.worker.terminate();
    }, 30_000);
    current.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      current.worker.postMessage({ id, file, ...(write ? { ...write, write: true } : {}) });
    } catch (error) {
      clearTimeout(timer);
      current.pending.delete(id);
      armIdle(current);
      reject(error);
    }
  });
}

function fail(current: Client, error: Error) {
  if (client === current) client = undefined;
  clearTimeout(current.idle);
  for (const job of current.pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  current.pending.clear();
}

function armIdle(current: Client) {
  if (current.pending.size) return;
  current.worker.unref();
  clearTimeout(current.idle);
  current.idle = setTimeout(() => {
    if (client === current) client = undefined;
    void current.worker.terminate();
  }, 60_000).unref();
}

export async function closeVectorCache() {
  const current = client;
  client = undefined;
  clearTimeout(current?.idle);
  await current?.worker.terminate();
}

/** Keep the two parallel arrays aligned when memory eligibility changes. */
export function survivingMemoryVectors<T extends { messageId: string }, V>(
  items: T[],
  vectors: V[],
  live: Set<string>,
) {
  const keep = items.map((item, index) => (live.has(item.messageId) ? index : -1)).filter((index) => index >= 0);
  if (keep.length === items.length) return undefined;
  return { items: keep.map((index) => items[index]!), vectors: keep.map((index) => vectors[index]!) };
}
