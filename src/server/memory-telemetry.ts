import { backendActivity } from './backend-activity.ts';
import { isMainThread, parentPort, threadId, type Worker } from 'node:worker_threads';

export const memoryJobs = [
  'memory-distillation-check',
  'memory-distillation-run',
  'grok-history-sync',
  'local-memory-index',
  'memory-retrieval',
  'embedding-model-load',
  'embedding-model-unload',
  'image-match',
] as const;
export type MemoryJobName = (typeof memoryJobs)[number];
type Sample = { at: number; rss: number; heapUsed: number; external: number; arrayBuffers: number };
type Job = { name: MemoryJobName; durationMs: number; rssBefore: number; rssAfter: number; rssPeak: number };

/** Process RSS includes workers; heap/external counters describe the sampling isolate only. Peaks are sampled. */
export class MemoryTelemetry {
  private samples: Sample[] = [];
  private jobs: Job[] = [];
  private active = new Map<string, { name: MemoryJobName; at: number; rss: number; peak: number }>();
  private previousRss = 0;
  private timer?: NodeJS.Timeout;
  private peakTimer?: NodeJS.Timeout;
  constructor(
    private log: (line: string) => void = console.log,
    private usage: () => NodeJS.MemoryUsage = process.memoryUsage,
  ) {}
  sample(record = true) {
    const { rss, heapUsed, external, arrayBuffers } = this.usage();
    const value = { at: Date.now(), rss, heapUsed, external, arrayBuffers };
    if (record) {
      this.samples.push(value);
      if (this.samples.length > 120) this.samples.shift();
    }
    backendActivity.stack(); // Expire stale breadcrumbs, even when only the sampler is running.
    for (const [id, active] of this.active) {
      if (value.at - active.at > 10 * 60_000) this.discard(id);
      else active.peak = Math.max(active.peak, rss);
    }
    for (const threshold of [1.5 * 1024 ** 3, 3 * 1024 ** 3])
      if (this.previousRss < threshold && rss >= threshold) this.log(`[memory] ${JSON.stringify({ threshold, rss })}`);
    this.previousRss = rss;
    return value;
  }
  begin(id: string, name: MemoryJobName) {
    backendActivity.begin(id, name);
    const { rss, at } = this.sample();
    this.active.set(id, { name, at, rss, peak: rss });
    // Keep crashed-worker bookkeeping bounded. Completed jobs remain a separate ring.
    if (this.active.size > 128) this.discard(this.active.keys().next().value!);
    this.peakTimer ??= setInterval(() => this.sample(false), 1000).unref();
  }
  end(id: string) {
    backendActivity.end(id);
    const after = this.sample();
    const before = this.active.get(id);
    if (!before) return;
    this.active.delete(id);
    if (!this.active.size) {
      clearInterval(this.peakTimer);
      this.peakTimer = undefined;
    }
    const job = {
      name: before.name,
      durationMs: Math.max(0, after.at - before.at),
      rssBefore: before.rss,
      rssAfter: after.rss,
      rssPeak: before.peak,
    };
    this.jobs.push(job);
    if (this.jobs.length > 50) this.jobs.shift();
    this.log(`[memory] ${JSON.stringify(job)}`);
  }
  discard(id: string) {
    backendActivity.discard(id);
    this.active.delete(id);
    if (!this.active.size) {
      clearInterval(this.peakTimer);
      this.peakTimer = undefined;
    }
  }
  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), 60_000).unref();
  }
  close() {
    clearInterval(this.timer);
    clearInterval(this.peakTimer);
    this.timer = undefined;
    this.peakTimer = undefined;
  }
  view() {
    return { samples: this.samples.map((value) => ({ ...value })), jobs: this.jobs.map((value) => ({ ...value })) };
  }
}

export const memoryTelemetry = new MemoryTelemetry();
type TelemetryMessage = { telemetry: true; type: 'start' | 'end' | 'discard'; id: string; name?: MemoryJobName };
export function isMemoryTelemetry(value: unknown): value is TelemetryMessage {
  const data = value as TelemetryMessage | undefined;
  return (
    data?.telemetry === true &&
    typeof data.id === 'string' &&
    /^[\d:]+$/.test(data.id) &&
    ['start', 'end', 'discard'].includes(data.type) &&
    (data.type !== 'start' || memoryJobs.includes(data.name!))
  );
}
function report(message: TelemetryMessage) {
  if (!isMainThread) parentPort?.postMessage(message);
  else if (message.type === 'start') memoryTelemetry.begin(message.id, message.name!);
  else if (message.type === 'end') memoryTelemetry.end(message.id);
  else memoryTelemetry.discard(message.id);
}
/** Route through the owning worker's ordered port, including descendants. Exit cannot race a broadcast. */
export function watchMemoryWorker(worker: Worker) {
  const owner = worker.threadId;
  const jobs = new Set<string>();
  let closed = false;
  worker.on('message', (message: unknown) => {
    if (closed || !isMemoryTelemetry(message)) return;
    const id = `${owner}:${message.id}`;
    if (message.type === 'start') {
      jobs.add(id);
      if (jobs.size > 128) {
        const oldest = jobs.values().next().value!;
        jobs.delete(oldest);
        report({ telemetry: true, type: 'discard', id: oldest });
      }
    } else jobs.delete(id);
    report({ ...message, id });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    for (const id of jobs) report({ telemetry: true, type: 'discard', id });
    jobs.clear();
  };
  worker.once('error', close);
  worker.once('exit', close);
}
let sequence = 0;
/** Only fixed job names cross the channel; no arguments, errors, prompts or paths are recorded. */
export function track(name: MemoryJobName): () => void {
  const id = `${threadId}:${++sequence}`;
  report({ telemetry: true, type: 'start', id, name });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    report({ telemetry: true, type: 'end', id });
  };
}
