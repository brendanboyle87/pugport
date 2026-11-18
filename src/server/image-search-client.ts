import { Worker } from 'node:worker_threads';
import type { Budget, Memory, Outcome, Params, Progress, Scope } from './image-search.ts';

type Job = {
  statusOnly?: boolean;
  appRoot: string;
  params?: Params;
  budget?: Budget;
  memory?: Memory;
  scope?: Scope;
};
type Reply = {
  id: number;
  outcome?: Outcome | number;
  memory?: Memory;
  error?: string;
  status?: { analyzed: number };
  progress?: Parameters<Progress>;
  heartbeat?: boolean;
};
type Pending = {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  progress?: Progress;
  timer: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
  cleanup: () => void;
};
let worker: Worker | undefined;
let stopping: Promise<unknown> | undefined;
let sequence = 0;
const pending = new Map<number, Pending>();
let analyzed = 0;
let statusRequested = false;
export function imageWorkerStatus(appRoot: string) {
  if (!statusRequested) {
    statusRequested = true;
    void runImageSearchWorker({ appRoot, statusOnly: true }).catch(() => {
      statusRequested = false;
    });
  }
  return analyzed;
}

function fail(current: Worker, error: Error) {
  if (worker !== current) return;
  worker = undefined;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    clearTimeout(job.deadline);
    clearInterval(job.poll);
    job.cleanup();
    job.reject(error);
  }
  pending.clear();
  stopping = current.terminate().finally(() => {
    stopping = undefined;
  });
}
export function stopImageSearchWorker() {
  if (worker) fail(worker, new Error('Image search stopped.'));
  analyzed = 0;
  statusRequested = false;
  return stopping;
}
export async function runImageSearchWorker(
  job: Job,
  signal?: AbortSignal,
  progress?: Progress,
  scope?: Scope,
): Promise<Reply> {
  await stopping;
  if (!worker) {
    const source = import.meta.filename.endsWith('.ts');
    const entry = new URL(source ? './image-search-worker.ts' : './image-search-worker.js', import.meta.url).href;
    const current = (worker = new Worker(
      `(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.source) { const { tsImport } = await import('tsx/esm/api'); await tsImport(workerData.entry, workerData.parent); }
      else await import(workerData.entry);
    })().catch(error => { throw error; });`,
      { eval: true, workerData: { source, entry, parent: import.meta.url } },
    ));
    current.on('error', (error) => fail(current, error instanceof Error ? error : new Error(String(error))));
    current.on('exit', () => fail(current, new Error('Image search worker exited.')));
    current.on('message', (reply: Reply) => {
      if (worker !== current) return;
      const request = pending.get(reply.id);
      if (!request) return;
      request.timer.refresh();
      if (reply.status) analyzed = reply.status.analyzed;
      if (reply.progress) {
        request.progress?.(...reply.progress);
        return;
      }
      if (reply.heartbeat) return;
      pending.delete(reply.id);
      clearTimeout(request.timer);
      clearTimeout(request.deadline);
      clearInterval(request.poll);
      request.cleanup();
      if (!pending.size) current.unref();
      if (reply.error) request.reject(new Error(reply.error));
      else request.resolve(reply);
    });
  }
  const current = worker;
  current.ref();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const abort = () => current.postMessage({ id, abort: true });
    const request: Pending = {
      resolve,
      reject,
      progress,
      timer: setTimeout(() => fail(current, new Error('Image search worker timed out.')), 30_000),
      deadline: setTimeout(() => fail(current, new Error('Image search exceeded its execution budget.')), 30 * 60_000),
      cleanup: () => signal?.removeEventListener('abort', abort),
    };
    pending.set(id, request);
    signal?.addEventListener('abort', abort, { once: true });
    if (scope) request.poll = setInterval(() => current.postMessage({ id, scope }), 100).unref();
    try {
      current.postMessage({ id, job, aborted: signal?.aborted });
    } catch (error) {
      fail(current, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
