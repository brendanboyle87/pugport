import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type BusyJob = { name: string; startedAt: string; pid: number };

/** Fixed labels only: never persist job arguments, paths or user content. */
export class BackendActivity {
  private file?: string;
  private persisted?: string;
  private jobs = new Map<string, BusyJob>();
  private completed: Array<{ id: string; job: BusyJob }> = [];
  constructor(
    private now: () => number = Date.now,
    private log: (line: string) => void = console.log,
  ) {}
  configure(dataDir: string) {
    try {
      const directory = join(dataDir, 'logs');
      mkdirSync(directory, { recursive: true });
      this.file = join(directory, 'backend-busy.json');
      this.persisted = undefined;
      this.persist();
    } catch {
      /* Diagnostics must not break work. */
    }
  }
  begin(id: string, name: string) {
    this.expire();
    this.jobs.set(id, { name, startedAt: new Date(this.now()).toISOString(), pid: process.pid });
    if (this.jobs.size > 128) this.jobs.delete(this.jobs.keys().next().value!);
    this.persist();
  }
  end(id: string) {
    if (!this.jobs.has(id)) return;
    this.expire();
    if (this.now() - Date.parse(this.jobs.get(id)?.startedAt ?? '') >= 100) {
      const stack = [...this.jobs].slice(-16).map(([id, job]) => ({ id, job }));
      if (stack.length >= this.completed.length) this.completed = stack;
    }
    this.jobs.delete(id);
    this.persist();
  }
  stack() {
    this.expire();
    return [...this.jobs.values()].slice(-16).map((job) => job.name);
  }
  /** Abandoned work must not be attributed to the next lag sample. */
  discard(id: string) {
    this.jobs.delete(id);
    this.completed = this.completed.filter((entry) => entry.id !== id);
    this.persist();
  }
  private expire() {
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (this.now() - Date.parse(job.startedAt) <= 10 * 60_000) continue;
      this.jobs.delete(id);
      this.completed = this.completed.filter((entry) => entry.id !== id);
      this.log(`[busy] dropped stale ${job.name}`);
      changed = true;
    }
    if (changed) this.persist();
  }
  lagStack() {
    const stack = this.stack();
    const recent = this.completed.map(({ job }) => job.name);
    this.completed = [];
    return recent.length > stack.length ? recent : stack;
  }
  private persist() {
    if (!this.file) return;
    const stack = [...this.jobs.values()].slice(-16);
    const content = JSON.stringify(stack.length ? { ...stack.at(-1), stack } : { idle: true });
    if (content === this.persisted) return;
    try {
      writeFileSync(this.file, content);
      this.persisted = content;
    } catch {
      /* A full/unavailable disk must not interrupt the job. */
    }
  }
}

export class EventLoopLag {
  private timer?: NodeJS.Timeout;
  private previous: number;
  private lastLog = -Infinity;
  maxLagMs = 0;
  worstStack: string[] = [];
  samples = 0;
  constructor(
    private activity: BackendActivity,
    private log: (line: string) => void = console.log,
    private now: () => number = () => performance.now(),
    private intervalMs = 1000,
  ) {
    this.previous = now();
  }
  tick() {
    const now = this.now();
    const lag = now - this.previous - this.intervalMs;
    const worst = lag > this.maxLagMs;
    this.maxLagMs = Math.max(this.maxLagMs, lag);
    this.samples++;
    this.previous = now;
    const stack = this.activity.lagStack();
    if (worst) this.worstStack = stack;
    if (lag > 2000 && now - this.lastLog >= 30_000) {
      this.lastLog = now;
      this.log(`[lag] ${Math.round(lag)}ms during ${JSON.stringify(stack)}`);
    }
  }
  start() {
    if (this.timer) return;
    this.previous = this.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs).unref();
  }
  close() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export const backendActivity = new BackendActivity();
export const eventLoopLag = new EventLoopLag(backendActivity);
let sequence = 0;
export type BusyName =
  | 'task-outcome-confirmation'
  | 'git-scope-snapshot'
  | 'git-scope-diff'
  | 'image-index'
  | 'workflow-finalisation'
  | 'workspace-send'
  | 'workspace-queue'
  | 'task-intent'
  | 'task-routing'
  | 'prompt-assembly'
  | 'controller-start'
  | 'adapter-start'
  | 'memory-vector-search'
  | 'embedding-installation-check';
export function trackBusy(name: BusyName) {
  const id = `busy:${++sequence}`;
  backendActivity.begin(id, name);
  return () => backendActivity.end(id);
}

export function busyStep<T>(name: BusyName, work: () => T): T {
  const end = trackBusy(name);
  try {
    return work();
  } finally {
    end();
  }
}

export async function busyAsyncStep<T>(name: BusyName, work: () => Promise<T>): Promise<T> {
  const end = trackBusy(name);
  try {
    return await work();
  } finally {
    end();
  }
}

/** A timer boundary, unlike a resolved promise, lets HTTP and lag probes run between batches. */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
