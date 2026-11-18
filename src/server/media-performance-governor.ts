import { cpus, freemem, totalmem } from 'node:os';
import { availableMemory } from './platform/system-stats.ts';

const GIB = 1024 ** 3;
export type MediaStagingPressure = {
  copying: boolean;
  pendingPairs: number;
  activePairs: number;
  usedBytes: number;
  maxBytes: number;
  copyBytes?: number;
  copyMilliseconds?: number;
};
export type MediaPerformanceSnapshot = {
  observedAt: string;
  cpuPercent?: number;
  memoryPercent: number;
  freeMemoryBytes: number;
  assistBudget: number;
  maxAssistants: number;
  activeFrameReadLimit: number;
  activeAssistedChecks: number;
  reason:
    | 'warming-up'
    | 'balanced'
    | 'cpu-pressure'
    | 'memory-pressure'
    | 'staging-pressure'
    | 'throughput-regression'
    | 'calibrating';
  freshCompleted: number;
  freshChecksPerMinute?: number;
  throughputComparable: boolean;
  staging?: MediaStagingPressure & { copyMegabytesPerSecond?: number };
};
export type MediaResourceSample = { cpuPercent?: number; freeMemoryBytes: number; totalMemoryBytes: number };
export type MediaPerformanceOptions = {
  enabled?: boolean;
  sample?: () => MediaResourceSample;
  now?: () => number;
  intervalMs?: number;
  autoSample?: boolean;
  initialBudget?: number;
};

/** Node's CPU counters include the whole machine; sampling once every five seconds does not start helpers. */
export function nodeMediaResourceSampler(): () => MediaResourceSample {
  let previous: { idle: number; total: number } | undefined;
  return () => {
    const current = cpus().reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0),
      }),
      { idle: 0, total: 0 },
    );
    const elapsed = previous ? current.total - previous.total : 0;
    const cpuPercent =
      previous && elapsed > 0
        ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / elapsed)))
        : undefined;
    previous = current;
    return {
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
      // Windows: os.freemem(); macOS and Linux: what can be handed out without swapping.
      freeMemoryBytes: availableMemory() ?? freemem(),
      totalMemoryBytes: totalmem(),
    };
  };
}
type Window = { started: number; budget: number; counts: Map<string, number>; healthy: boolean; finished?: number };
type Waiter = {
  signal: AbortSignal;
  empty: () => boolean;
  resolve: (permit: (() => void) | undefined) => void;
  reject: (reason: unknown) => void;
  abort: () => void;
};

/** Two logical owners share a measured permit budget. Lowering it never aborts an in-flight fixed check. */
export class MediaPerformanceGovernor {
  private readonly clock: () => number;
  private readonly sampleResources: () => MediaResourceSample;
  private readonly enabled: boolean;
  private readonly waiters: Waiter[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private active = 0;
  private closed = false;
  private budget: number;
  private stableHealthy = 0;
  private stagingPressureSamples = 0;
  private changedAt: number;
  private blockedUntil = 0;
  private smoothedCpu?: number;
  private latest!: MediaPerformanceSnapshot;
  private freshCompleted = 0;
  private window: Window;
  private reference?: Window;
  private regressions = 0;
  private lastComparable = false;
  private previousStaging?: MediaStagingPressure;
  constructor(
    private readonly configuration: {
      baseFrameReaders: number;
      maxAssistants: number;
      pressure?: () => MediaStagingPressure | undefined;
      onChange?: () => void;
    } & MediaPerformanceOptions,
  ) {
    this.clock = configuration.now ?? Date.now;
    this.sampleResources = configuration.sample ?? nodeMediaResourceSampler();
    this.enabled = configuration.enabled !== false;
    this.budget = Math.max(
      0,
      Math.min(
        configuration.maxAssistants,
        configuration.initialBudget ?? (this.enabled ? 1 : configuration.maxAssistants),
      ),
    );
    this.changedAt = this.clock();
    this.window = { started: this.clock(), budget: this.budget, counts: new Map(), healthy: true };
    this.sampleNow();
    if (this.enabled && configuration.autoSample !== false) {
      this.timer = setInterval(() => this.sampleNow(), configuration.intervalMs ?? 5000);
      this.timer.unref();
    }
  }
  snapshot(): MediaPerformanceSnapshot {
    return {
      ...this.latest,
      activeAssistedChecks: this.active,
      ...(this.latest.staging ? { staging: { ...this.latest.staging } } : {}),
    };
  }
  recordFreshCompletion(bucket: string): void {
    this.freshCompleted++;
    this.window.counts.set(bucket, (this.window.counts.get(bucket) ?? 0) + 1);
    this.latest.freshCompleted = this.freshCompleted;
  }
  sampleNow(): void {
    if (this.closed) return;
    const at = this.clock(),
      sample = this.sampleResources(),
      pressure = this.configuration.pressure?.();
    const memoryPercent = Math.max(
      0,
      Math.min(100, 100 * (1 - sample.freeMemoryBytes / Math.max(1, sample.totalMemoryBytes))),
    );
    const rawCpu = sample.cpuPercent;
    if (rawCpu !== undefined)
      this.smoothedCpu = this.smoothedCpu === undefined ? rawCpu : this.smoothedCpu * 0.5 + rawCpu * 0.5;
    let reason: MediaPerformanceSnapshot['reason'] = rawCpu === undefined ? 'warming-up' : 'balanced';
    const memoryCritical = sample.freeMemoryBytes < 768 * 1024 ** 2 || memoryPercent > 98;
    const cpuPressure = rawCpu !== undefined && rawCpu > 92;
    const healthy =
      !memoryCritical &&
      rawCpu !== undefined &&
      rawCpu <= 85 &&
      (this.smoothedCpu ?? rawCpu) <= 85 &&
      sample.freeMemoryBytes >= GIB;
    this.stableHealthy = healthy ? this.stableHealthy + 1 : 0;
    this.stagingPressureSamples = pressure?.copying && pressure.pendingPairs >= 3 ? this.stagingPressureSamples + 1 : 0;
    if (this.enabled) {
      if (memoryCritical) {
        this.changeBudget(0, at);
        reason = 'memory-pressure';
        this.blockedUntil = Math.max(this.blockedUntil, at + 20_000);
      } else if (cpuPressure) {
        this.changeBudget(Math.max(0, this.budget - 1), at);
        reason = 'cpu-pressure';
        this.blockedUntil = Math.max(this.blockedUntil, at + 20_000);
      } else if (this.stagingPressureSamples >= 2 && this.budget > 1) {
        this.changeBudget(1, at);
        reason = 'staging-pressure';
        this.blockedUntil = Math.max(this.blockedUntil, at + 20_000);
      } else if (
        this.stableHealthy >= 3 &&
        at >= this.blockedUntil &&
        at - this.changedAt >= 20_000 &&
        this.budget < this.configuration.maxAssistants
      ) {
        this.changeBudget(this.budget + 1, at);
        reason = 'calibrating';
      }
      if (this.budget === 0 && !memoryCritical && !cpuPressure && !healthy) reason = 'calibrating';
      if (at < this.blockedUntil && (reason === 'balanced' || reason === 'warming-up')) reason = 'calibrating';
    }
    this.window.healthy &&= !memoryCritical && !cpuPressure && this.stagingPressureSamples < 2;
    let comparable = false,
      checksPerMinute: number | undefined;
    const elapsed = at - this.window.started;
    if (elapsed >= 30_000) {
      const current = this.window;
      const count = [...current.counts.values()].reduce((sum, value) => sum + value, 0);
      if (count >= 6) checksPerMinute = (count * 60_000) / elapsed;
      if (this.reference && current.budget > this.reference.budget && current.healthy && this.reference.healthy) {
        const common = [...current.counts.keys()].filter(
          (key) => (current.counts.get(key) ?? 0) >= 6 && (this.reference!.counts.get(key) ?? 0) >= 6,
        );
        if (common.length) {
          const currentCount = common.reduce((sum, key) => sum + current.counts.get(key)!, 0);
          const priorCount = common.reduce((sum, key) => sum + this.reference!.counts.get(key)!, 0);
          const priorTotal = [...this.reference.counts.values()].reduce((sum, value) => sum + value, 0);
          const compositionDifference = common.reduce(
            (sum, key) =>
              sum + Math.abs(current.counts.get(key)! / count - this.reference!.counts.get(key)! / priorTotal),
            0,
          );
          // Whole-window rates are comparable only when almost all work and its mix match.
          // Otherwise unrelated large/slow inputs could create an artificial regression.
          comparable = currentCount / count >= 0.9 && priorCount / priorTotal >= 0.9 && compositionDifference <= 0.2;
          if (comparable) {
            const priorElapsed = this.reference.finished! - this.reference.started;
            if (currentCount / elapsed < (priorCount / priorElapsed) * 0.75) this.regressions++;
            else this.regressions = 0;
            if (this.enabled && this.regressions >= 2) {
              this.changeBudget(this.reference.budget, at);
              this.blockedUntil = at + 90_000;
              reason = 'throughput-regression';
              this.regressions = 0;
            }
          }
        }
      }
      this.lastComparable = comparable;
      if (!comparable) this.regressions = 0;
      if (current.healthy && count >= 6 && (!this.reference || current.budget <= this.reference.budget))
        this.reference = { ...current, counts: new Map(current.counts), finished: at };
      this.window = { started: at, budget: this.budget, counts: new Map(), healthy: true };
    }
    let copyMegabytesPerSecond: number | undefined;
    if (
      pressure &&
      this.previousStaging &&
      pressure.copyBytes !== undefined &&
      pressure.copyMilliseconds !== undefined &&
      this.previousStaging.copyBytes !== undefined &&
      this.previousStaging.copyMilliseconds !== undefined
    ) {
      const bytes = pressure.copyBytes - this.previousStaging.copyBytes,
        milliseconds = pressure.copyMilliseconds - this.previousStaging.copyMilliseconds;
      if (bytes >= 0 && milliseconds > 0) copyMegabytesPerSecond = bytes / 1024 ** 2 / (milliseconds / 1000);
    }
    this.previousStaging = pressure;
    this.latest = {
      observedAt: new Date(at).toISOString(),
      ...(this.smoothedCpu === undefined ? {} : { cpuPercent: Math.round(this.smoothedCpu) }),
      memoryPercent,
      freeMemoryBytes: sample.freeMemoryBytes,
      assistBudget: this.budget,
      maxAssistants: this.configuration.maxAssistants,
      activeFrameReadLimit: this.configuration.baseFrameReaders + this.budget,
      reason,
      freshCompleted: this.freshCompleted,
      activeAssistedChecks: this.active,
      ...(checksPerMinute === undefined
        ? this.latest?.freshChecksPerMinute === undefined
          ? {}
          : { freshChecksPerMinute: this.latest.freshChecksPerMinute }
        : { freshChecksPerMinute: checksPerMinute }),
      throughputComparable: this.lastComparable,
      ...(pressure
        ? { staging: { ...pressure, ...(copyMegabytesPerSecond === undefined ? {} : { copyMegabytesPerSecond }) } }
        : {}),
    };
    this.notifyQueueChanged();
    this.configuration.onChange?.();
  }
  private changeBudget(budget: number, at: number): void {
    if (budget === this.budget) return;
    // Retain a completed comparable low-lane window when an experiment begins.
    if (
      at - this.window.started >= 15_000 &&
      this.window.healthy &&
      [...this.window.counts.values()].some((count) => count >= 6)
    )
      this.reference = { ...this.window, counts: new Map(this.window.counts), finished: at };
    this.budget = budget;
    this.changedAt = at;
    this.window = { started: at, budget, counts: new Map(), healthy: true };
  }
  acquire(signal: AbortSignal, empty: () => boolean): Promise<(() => void) | undefined> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('Media performance governor closed.'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        empty,
        resolve,
        reject,
        abort: () => {
          const at = this.waiters.indexOf(waiter);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.notifyQueueChanged();
    });
  }
  notifyQueueChanged(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.signal.aborted || waiter.empty() || this.active < this.budget) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.signal.removeEventListener('abort', waiter.abort);
        if (waiter.signal.aborted) waiter.reject(waiter.signal.reason);
        else if (waiter.empty()) waiter.resolve(undefined);
        else {
          this.active++;
          let released = false;
          waiter.resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.notifyQueueChanged();
          });
        }
      }
    }
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new Error('Media performance governor closed.'));
    }
  }
}
