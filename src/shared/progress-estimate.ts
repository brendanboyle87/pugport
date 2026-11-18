export type ProgressRemainingRange = { minSeconds: number; maxSeconds: number };
export type ProgressEstimateState = 'learning' | 'stable' | 'variable' | 'unknown' | 'paused' | 'done';
export type ProgressEstimate = {
  elapsedSeconds: number;
  remainingSeconds?: number;
  remainingRange?: ProgressRemainingRange;
  estimateState: ProgressEstimateState;
  estimateNote?: string;
};

type Point = { at: number; done: number };
type Entry = {
  done: number;
  total: number | null;
  accumulatedMs: number;
  startedAt?: number;
  windowStartedAt: number;
  baselineDone: number;
  lastProgressAt: number;
  samples: Point[];
  paused: boolean;
  finished: boolean;
};

const minimumWindowMs = 60_000;
const sampleIntervalMs = 5_000;
const recentWindowMs = 180_000;
const quantile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]!;

/** Browser/server shared timing; callers supply monotonic-ish timestamps and their actual progress. */
export class ProgressEstimateTracker {
  private readonly entries = new Map<string, Entry>();
  private activeKey?: string;

  observe(key: string, done: number, total: number | null, now: number): void {
    if (
      !key ||
      !Number.isFinite(now) ||
      !Number.isFinite(done) ||
      done < 0 ||
      (total !== null && (!Number.isFinite(total) || total < 0))
    )
      return;
    let entry = this.entries.get(key);
    if (this.activeKey !== key || entry?.finished) {
      this.finish(now);
      this.activeKey = key;
      if (!entry) {
        entry = {
          done,
          total,
          accumulatedMs: 0,
          windowStartedAt: now,
          baselineDone: done,
          lastProgressAt: now,
          samples: [{ at: now, done }],
          paused: false,
          finished: false,
        };
        this.entries.set(key, entry);
      }
      entry.startedAt = now;
      entry.finished = false;
      entry.paused = false;
      this.resetWindow(entry, done, now);
    }
    if (!entry) return;
    if (entry.paused) this.resume(now);
    if (done < entry.done || now < entry.windowStartedAt || (entry.total !== null && entry.total !== total))
      this.resetWindow(entry, done, now);
    if (done > entry.done) entry.lastProgressAt = now;
    entry.done = done;
    entry.total = total;
    if (now - entry.samples.at(-1)!.at >= sampleIntervalMs) entry.samples.push({ at: now, done });
    while (entry.samples.length > 2 && entry.samples[1]!.at < now - recentWindowMs) entry.samples.shift();
  }

  estimate(key: string, now: number): ProgressEstimate {
    const entry = this.entries.get(key);
    if (!entry) return { elapsedSeconds: 0, estimateState: 'unknown' };
    const elapsedSeconds = Math.max(
      0,
      Math.round(
        (entry.accumulatedMs + (entry.startedAt === undefined ? 0 : Math.max(0, now - entry.startedAt))) / 1000,
      ),
    );
    const base = { elapsedSeconds };
    if (entry.finished) return { ...base, estimateState: 'done' };
    if (entry.paused) return { ...base, estimateState: 'paused' };
    if (!entry.total) return { ...base, estimateState: 'unknown', estimateNote: '范围尚未确定，暂不估算剩余时间。' };
    const progressed = entry.done - entry.baselineDone;
    if (now - entry.windowStartedAt < minimumWindowMs || progressed < 20 || entry.done / entry.total < 0.03)
      return { ...base, estimateState: 'learning', estimateNote: '正在采样估速，积累足够进度后显示时间范围。' };
    if (now - entry.lastProgressAt > 60_000)
      return { ...base, estimateState: 'variable', estimateNote: '当前项目耗时较长，等待更多进度后重新估算。' };
    const points = [...entry.samples];
    if (points.at(-1)!.at < now) points.push({ at: now, done: entry.done });
    const rates: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const seconds = (points[i]!.at - points[i - 1]!.at) / 1000;
      if (seconds >= sampleIntervalMs / 1000)
        rates.push(Math.max(0, (points[i]!.done - points[i - 1]!.done) / seconds));
    }
    const windowSeconds = (points.at(-1)!.at - points[0]!.at) / 1000;
    const windowItems = points.at(-1)!.done - points[0]!.done;
    if (rates.length < 4 || windowSeconds < 45 || windowItems < 20)
      return { ...base, estimateState: 'learning', estimateNote: '正在采样估速，积累足够进度后显示时间范围。' };
    const rate = windowItems / windowSeconds;
    if (!Number.isFinite(rate) || rate <= 0) return { ...base, estimateState: 'unknown' };
    const slow = quantile(rates, 0.2),
      fast = quantile(rates, 0.8);
    const variance = rates.reduce((sum, value) => sum + (value - rate) ** 2, 0) / rates.length;
    const variable = slow <= 0 || fast / slow > 2.5 || Math.sqrt(variance) / rate > 0.8;
    // A bounded range communicates local variation; zero-progress intervals widen it rather than implying infinity.
    const lowRate = variable ? Math.min(slow > 0 ? slow : rate * 0.2, rate * 0.65) : Math.min(slow, rate * 0.8);
    const highRate = variable ? Math.max(fast, rate * 1.5) : Math.max(fast, rate * 1.2);
    const left = Math.max(0, entry.total - entry.done);
    return {
      ...base,
      remainingSeconds: Math.max(0, Math.round(left / rate)),
      remainingRange: {
        minSeconds: Math.max(0, Math.floor(left / highRate)),
        maxSeconds: Math.max(0, Math.ceil(left / lowRate)),
      },
      estimateState: variable ? 'variable' : 'stable',
      ...(variable ? { estimateNote: '近期文件耗时差异较大，时间范围会随进度调整。' } : {}),
    };
  }

  pause(now: number): void {
    const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
    if (!entry || entry.finished || entry.paused) return;
    this.freeze(entry, now);
    entry.paused = true;
  }
  resume(now: number): void {
    const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
    if (!entry || entry.finished || !entry.paused) return;
    entry.paused = false;
    entry.startedAt = now;
    this.resetWindow(entry, entry.done, now);
  }
  finish(now: number): void {
    const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
    if (!entry || entry.finished) return;
    this.freeze(entry, now);
    entry.finished = true;
    entry.paused = false;
  }
  reset(): void {
    this.entries.clear();
    this.activeKey = undefined;
  }
  private resetWindow(entry: Entry, done: number, now: number) {
    entry.windowStartedAt = now;
    entry.baselineDone = done;
    entry.lastProgressAt = now;
    entry.samples = [{ at: now, done }];
  }
  private freeze(entry: Entry, now: number) {
    if (entry.startedAt !== undefined) entry.accumulatedMs += Math.max(0, now - entry.startedAt);
    entry.startedAt = undefined;
  }
}
