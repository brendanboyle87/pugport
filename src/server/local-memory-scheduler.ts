import { track, watchMemoryWorker, isMemoryTelemetry } from './memory-telemetry.ts';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export type MemoryJob = {
  id: string;
  projectId: string;
  dataDir: string;
  appRoot: string;
  all: boolean;
  conversationIds: string[];
  configure: boolean;
};
export type MemoryResult = { projectId: string; warnings: string[]; files: string[]; cliInstalled?: boolean };
type Pending = {
  due: number;
  all: boolean;
  conversations: Set<string>;
  configure: boolean;
  waiters: ((result: MemoryResult) => void)[];
};
type Executor = { execute(job: MemoryJob): Promise<MemoryResult>; close(): Promise<void>; settle?(): Promise<void> };

class MemoryWorker implements Executor {
  private worker?: Worker;
  private active?: { id: string; resolve: (value: MemoryResult) => void; projectId: string };
  private timeout?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private stopping?: Promise<unknown>;
  async execute(job: MemoryJob): Promise<MemoryResult> {
    clearTimeout(this.idle);
    await this.stopping;
    if (!this.worker) {
      const source = import.meta.filename.endsWith('.ts');
      const entry = source
        ? new URL('./local-memory-worker.ts', import.meta.url).href
        : pathToFileURL(join(job.appRoot, 'dist', 'server', 'local-memory-worker.js')).href;
      // The entry is our installed application module, never a project-local helper.
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
      this.worker = worker;
      worker.on('message', (value: (MemoryResult & { id: string }) | { type: 'closed' }) => {
        if (isMemoryTelemetry(value) || 'type' in value) return;
        if (value.id !== this.active?.id) return;
        this.finish(value);
      });
      worker.on('error', (error) => {
        if (this.worker === worker) this.fail(error instanceof Error ? error.message : String(error));
      });
      worker.on('exit', (code) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        if (this.active) this.fail(`本地记忆后台已退出（${code}）。`);
      });
    }
    this.worker.ref();
    return new Promise((resolve) => {
      this.active = { id: job.id, resolve, projectId: job.projectId };
      this.timeout = setTimeout(() => {
        const stalled = this.worker;
        this.worker = undefined;
        this.stopping = stalled?.terminate().finally(() => {
          this.stopping = undefined;
        });
        this.fail('本地记忆后台导出超时；数据库记录仍保留。');
      }, 30_000);
      this.worker!.postMessage(job);
    });
  }
  private finish(value: MemoryResult) {
    const active = this.active;
    this.active = undefined;
    clearTimeout(this.timeout);
    this.worker?.unref();
    active?.resolve(value);
    if (this.worker)
      this.idle = setTimeout(() => {
        const worker = this.worker;
        this.worker = undefined;
        this.stopping = worker?.terminate().finally(() => {
          this.stopping = undefined;
        });
      }, 60_000).unref();
  }
  private fail(message: string) {
    if (this.active) this.finish({ projectId: this.active.projectId, files: [], warnings: [message] });
  }
  async settle() {
    await this.stopping;
  }
  async close() {
    clearTimeout(this.timeout);
    this.fail('本地记忆后台已关闭；未导出的数据仍保存在数据库。');
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = undefined;
    if (worker instanceof Worker) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let closed = false;
        const onMessage = (msg: unknown) => {
          if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'closed') {
            closed = true;
            done();
          }
        };
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!closed) console.warn('Local memory worker did not acknowledge close before termination.');
          worker.off('message', onMessage);
          worker.off('exit', done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        timer.unref?.();
        worker.once('exit', done);
        worker.on('message', onMessage);
        try {
          worker.postMessage({ type: 'close' });
        } catch {
          done();
        }
      });
    }
    await worker?.terminate();
    await this.stopping;
  }
}

/** One persistent worker; each two-second burst coalesces by project and conversation. */
export class LocalMemoryScheduler {
  private pending = new Map<string, Pending>();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private activeProject?: string;
  private closing = false;
  private closed = false;
  private executor: Executor;
  constructor(
    private dataDir: string,
    private appRoot: string,
    private onResult: (result: MemoryResult, configured: boolean) => void,
    private options: { debounceMs?: number; executor?: Executor; closeTimeoutMs?: number } = {},
  ) {
    this.executor = options.executor ?? new MemoryWorker();
  }
  schedule(projectId: string, conversationId?: string) {
    if (this.closing || this.closed) return;
    const pending = this.pending.get(projectId) ?? {
      due: Date.now() + (this.options.debounceMs ?? 2000),
      all: false,
      conversations: new Set<string>(),
      configure: false,
      waiters: [],
    };
    if (!conversationId) pending.all = true;
    else pending.conversations.add(conversationId);
    this.pending.set(projectId, pending);
    this.arm();
  }
  flush(projectId: string, configure = false): Promise<MemoryResult> {
    if (this.closing || this.closed)
      return Promise.resolve({ projectId, files: [], warnings: ['本地记忆后台正在关闭或已关闭。'] });
    const pending = this.pending.get(projectId) ?? {
      due: 0,
      all: true,
      conversations: new Set<string>(),
      configure: false,
      waiters: [],
    };
    pending.due = 0;
    pending.configure ||= configure;
    if (configure) pending.all = true;
    this.pending.set(projectId, pending);
    const value = new Promise<MemoryResult>((resolve) => pending.waiters.push(resolve));
    this.arm();
    return value;
  }
  private arm() {
    clearTimeout(this.timer);
    if (this.active || this.closed || !this.pending.size) return;
    const due = Math.min(...[...this.pending.values()].map((value) => value.due));
    this.timer = setTimeout(() => this.dispatch(), Math.max(0, due - Date.now()));
    this.timer.unref();
  }
  private dispatch() {
    if (this.active || this.closed) return;
    const next = [...this.pending].sort((a, b) => a[1].due - b[1].due)[0];
    if (!next) return;
    const [projectId, value] = next;
    this.pending.delete(projectId);
    this.activeProject = projectId;
    const job: MemoryJob = {
      id: randomUUID(),
      projectId,
      dataDir: this.dataDir,
      appRoot: this.appRoot,
      all: value.all,
      conversationIds: [...value.conversations],
      configure: value.configure,
    };
    this.active = Promise.resolve()
      .then(async () => {
        const end = track('local-memory-index');
        try {
          return await this.executor.execute(job);
        } finally {
          end();
        }
      })
      .catch((error) => ({
        projectId,
        files: [],
        warnings: [error instanceof Error ? error.message : String(error)],
      }))
      .then((result) => {
        try {
          if (!this.closed) this.onResult(result, value.configure);
        } catch (error) {
          result.warnings.push(error instanceof Error ? error.message : String(error));
        }
        for (const waiter of value.waiters) waiter(result);
      })
      .finally(() => {
        this.active = undefined;
        this.activeProject = undefined;
        this.arm();
      });
  }
  /** Drop queued exports and wait for an already-running writer before removing its private copies. */
  async forgetProject(projectId: string) {
    const pending = this.pending.get(projectId);
    this.pending.delete(projectId);
    for (const waiter of pending?.waiters ?? [])
      waiter({ projectId, files: [], warnings: ['项目正在清空，已取消记忆导出。'] });
    if (this.activeProject === projectId) await this.active;
    await this.executor.settle?.();
    this.arm();
  }
  async close() {
    this.closing = true;
    for (const pending of this.pending.values()) pending.due = 0;
    this.arm();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      (async () => {
        while (this.active || this.pending.size) {
          this.dispatch();
          if (this.active) await this.active;
        }
      })(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.closeTimeoutMs ?? 5000);
      }),
    ]);
    clearTimeout(timeout);
    this.closed = true;
    clearTimeout(this.timer);
    for (const [projectId, value] of this.pending)
      for (const waiter of value.waiters)
        waiter({ projectId, files: [], warnings: ['关闭期间未完成记忆导出；数据库记录仍保留。'] });
    this.pending.clear();
    await this.executor.close();
  }
}
