import { track, watchMemoryWorker, isMemoryTelemetry } from './memory-telemetry.ts';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import type { GrokHistorySyncResult } from './grok-history-sync.ts';

export type GrokHistorySyncJob = {
  projectId: string;
  dataDir: string;
  appRoot: string;
  grokHomes?: string[];
  now?: string;
  force?: boolean;
};
export type GrokHistoryWorkerMessage = GrokHistorySyncJob & { id: string };
export type GrokHistoryWorkerReply = { id: string; result?: GrokHistorySyncResult; error?: string };
type Pending = {
  end?: () => void;
  id: string;
  key: string;
  job: GrokHistorySyncJob;
  promise: Promise<GrokHistorySyncResult>;
  resolve: (value: GrokHistorySyncResult) => void;
  reject: (error: Error) => void;
};

/** Heavy native log parsing never runs on the HTTP/event loop. One worker serializes SQLite imports. */
export class GrokHistorySyncWorker {
  private worker?: Worker;
  private active?: Pending;
  private queue: Pending[] = [];
  private pending = new Map<string, Pending>();
  private timer?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private closing = false;
  private restarting?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(private options: { timeoutMs?: number } = {}) {}

  execute(job: GrokHistorySyncJob): Promise<GrokHistorySyncResult> {
    if (this.closing) return Promise.reject(new Error('Grok 历史后台已关闭。'));
    const key = JSON.stringify([resolve(job.dataDir), job.projectId]);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let finish!: Pending['resolve'];
    let fail!: Pending['reject'];
    const promise = new Promise<GrokHistorySyncResult>((resolveResult, reject) => {
      finish = resolveResult;
      fail = reject;
    });
    const item = { id: randomUUID(), key, job, promise, resolve: finish, reject: fail };
    this.pending.set(key, item);
    this.queue.push(item);
    this.dispatch();
    return promise;
  }

  private createWorker(job: GrokHistorySyncJob): Worker {
    const source = import.meta.filename.endsWith('.ts');
    const entry = source
      ? new URL('./grok-history-worker.ts', import.meta.url).href
      : pathToFileURL(join(job.appRoot, 'dist', 'server', 'grok-history-worker.js')).href;
    // This is an installed PugPort module. No project-local scripts are loaded.
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.source) {
          const { tsImport } = await import('tsx/esm/api');
          await tsImport(workerData.entry, workerData.parent);
        } else await import(workerData.entry);
      })().catch(error => { throw error; });`,
      { eval: true, workerData: { source, entry, parent: import.meta.url } },
    );
    watchMemoryWorker(worker);
    worker.on('message', (reply: GrokHistoryWorkerReply) => {
      if (isMemoryTelemetry(reply)) return;
      if (worker !== this.worker || reply.id !== this.active?.id) return;
      this.finish(
        reply.error ? new Error(reply.error) : reply.result ? undefined : new Error('Grok 历史后台返回无效结果。'),
        reply.result,
      );
    });
    worker.on('error', () => {
      if (worker === this.worker) this.restart(worker, new Error('Grok 历史后台异常退出；已有记录仍保留。'));
    });
    worker.on('exit', (code) => {
      if (worker === this.worker) this.restart(worker, new Error(`Grok 历史后台已退出（${code}）；已有记录仍保留。`));
    });
    return worker;
  }

  private dispatch() {
    if (this.closing || this.active || this.restarting) return;
    clearTimeout(this.idle);
    const next = this.queue.shift();
    if (!next) {
      this.worker?.unref();
      if (this.worker)
        this.idle = setTimeout(() => {
          const worker = this.worker;
          this.worker = undefined;
          this.restarting = worker
            ?.terminate()
            .then(() => undefined)
            .finally(() => {
              this.restarting = undefined;
              this.dispatch();
            });
        }, 60_000).unref();
      return;
    }
    this.active = next;
    next.end = track('grok-history-sync');
    try {
      this.worker ??= this.createWorker(next.job);
      const worker = this.worker;
      worker.ref();
      this.timer = setTimeout(
        () => this.restart(worker, new Error('Grok 历史同步超时；已有记录仍保留，请稍后重试。')),
        Math.max(1, Math.min(this.options.timeoutMs ?? 30_000, 30_000)),
      );
      worker.postMessage({ ...next.job, id: next.id } satisfies GrokHistoryWorkerMessage);
    } catch {
      this.finish(new Error('无法启动 Grok 历史后台；已有记录仍保留。'));
    }
  }

  private finish(error?: Error, result?: GrokHistorySyncResult) {
    const item = this.active;
    this.active = undefined;
    clearTimeout(this.timer);
    if (item) {
      item.end?.();
      this.pending.delete(item.key);
      if (error) item.reject(error);
      else item.resolve(result!);
    }
    this.dispatch();
  }

  private restart(worker: Worker, error: Error) {
    if (worker !== this.worker) return;
    this.worker = undefined;
    this.restarting = worker.terminate().then(() => undefined);
    this.finish(error);
    void this.restarting.finally(() => {
      this.restarting = undefined;
      this.dispatch();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearTimeout(this.idle);
    clearTimeout(this.timer);
    const error = new Error('Grok 历史后台已关闭；已有记录仍保留。');
    this.finish(error);
    for (const item of this.queue) item.reject(error);
    this.queue = [];
    this.pending.clear();
    const worker = this.worker;
    this.worker = undefined;
    this.closePromise = Promise.all([worker?.terminate(), this.restarting]).then(() => undefined);
    return this.closePromise;
  }
}
