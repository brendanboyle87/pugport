import { ProgressEstimateTracker } from '../shared/progress-estimate';
import type { BackgroundTask } from '../shared/types';

/** A manyfold range is still an unknown speed, for example while resumed cached work is reused. */
function displayable(task: BackgroundTask): BackgroundTask {
  const usable = (range: BackgroundTask['remainingRange']) =>
    !range || range.maxSeconds <= 120 || (range.minSeconds > 0 && range.maxSeconds / range.minSeconds <= 4);
  if (usable(task.remainingRange) && task.steps?.every((step) => usable(step.remainingRange)) !== false) return task;
  return {
    ...task,
    ...(!usable(task.remainingRange)
      ? { remainingSeconds: undefined, remainingRange: undefined, totalRemainingRange: undefined }
      : {}),
    steps: task.steps?.map((step) =>
      usable(step.remainingRange)
        ? step
        : {
            ...step,
            remainingSeconds: undefined,
            remainingRange: undefined,
          },
    ),
  };
}

/** A live UI fallback also works while an older backend finishes its existing job. */
export class BackgroundTaskEstimates {
  private readonly trackers = new Map<string, { tracker: ProgressEstimateTracker; paused: boolean }>();

  update(tasks: readonly BackgroundTask[], now: number): BackgroundTask[] {
    const present = new Set(tasks.map((task) => task.id));
    for (const id of this.trackers.keys()) if (!present.has(id)) this.trackers.delete(id);
    return tasks.map((task) => {
      if (task.state === 'paused') {
        const existing = this.trackers.get(task.id);
        existing?.tracker.pause(now);
        if (existing) existing.paused = true;
        return {
          ...task,
          remainingSeconds: undefined,
          remainingRange: undefined,
          totalRemainingRange: undefined,
          estimateScope: undefined,
          estimateNote: undefined,
          steps: task.steps?.map((step) => ({
            ...step,
            remainingSeconds: undefined,
            remainingRange: undefined,
            estimateNote: undefined,
            ...(step.state === 'running' ? { estimateState: 'paused' as const } : {}),
          })),
        };
      }
      const current = task.steps?.findIndex((step) => step.state === 'running') ?? -1;
      const step = current < 0 ? undefined : task.steps![current]!;
      // Cached checks advance the queue, but cannot predict how long an unread video will take.
      // A cache hit reduces the fresh-work total and resets the sampling window; a fresh completion
      // increases both done counts, leaving that total stable. Keep the visible queue count unchanged.
      const freshComparison = task.kind === 'media-analysis' && step?.key === 'compare';
      if (freshComparison && !task.performance) {
        return {
          ...task,
          remainingSeconds: undefined,
          remainingRange: undefined,
          totalRemainingRange: undefined,
          estimateScope: undefined,
          steps: task.steps?.map((item) =>
            item === step ? { ...item, remainingSeconds: undefined, remainingRange: undefined } : item,
          ),
        };
      }
      if (!freshComparison && (task.remainingRange || task.steps?.some((item) => item.estimateState)))
        return displayable(task);
      let entry = this.trackers.get(task.id);
      if (!entry) {
        entry = { tracker: new ProgressEstimateTracker(), paused: false };
        this.trackers.set(task.id, entry);
      }
      if (entry.paused) {
        entry.tracker.resume(now);
        entry.paused = false;
      }
      const key = freshComparison ? 'fresh-compare' : current < 0 ? 'current' : (step!.key ?? `step-${current}`);
      const freshDone = task.performance?.freshCompleted ?? 0;
      const done = freshComparison ? freshDone : (step?.done ?? task.done);
      const total = freshComparison
        ? step!.total === null
          ? null
          : freshDone + Math.max(0, step!.total - step!.done)
        : (step?.total ?? (task.total || null));
      entry.tracker.observe(key, done, total, now);
      const estimate = entry.tracker.estimate(key, now);
      const steps = task.steps?.map((item, index) =>
        index === current ? { ...item, remainingSeconds: undefined, remainingRange: undefined, ...estimate } : item,
      );
      const whole = !freshComparison && current >= 0 && current === task.steps!.length - 1;
      return displayable({
        ...task,
        ...(steps ? { steps } : {}),
        remainingSeconds: estimate.remainingSeconds,
        remainingRange: estimate.remainingRange,
        totalRemainingRange: undefined,
        estimateScope: undefined,
        ...(estimate.remainingRange
          ? {
              totalRemainingRange: {
                minSeconds: estimate.remainingRange.minSeconds,
                ...(whole ? { maxSeconds: estimate.remainingRange.maxSeconds } : {}),
              },
              estimateScope: whole ? ('whole-task' as const) : ('current-step' as const),
            }
          : {}),
        estimateNote: estimate.estimateNote,
      });
    });
  }
}
