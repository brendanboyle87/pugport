import type { TaskSchedule, Workflow } from '../shared/types.ts';

/** Older composers emitted the default preference object even for ordinary text. */
export function hasExplicitSchedule(schedule?: TaskSchedule): boolean {
  return !!(
    schedule?.deadlineAt ||
    schedule?.notBefore ||
    schedule?.priority === 'high' ||
    schedule?.preferExpiringQuota === false
  );
}

export function queueTime(value?: string): number | undefined {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Stable sorting retains insertion order when two submissions share a timestamp. */
export function compareQueuedWorkflows(a: Workflow, b: Workflow): number {
  const deadlineA = queueTime(a.input.schedule?.deadlineAt) ?? Infinity;
  const deadlineB = queueTime(b.input.schedule?.deadlineAt) ?? Infinity;
  if (deadlineA !== deadlineB) return deadlineA < deadlineB ? -1 : 1;
  const priority = Number(b.input.schedule?.priority === 'high') - Number(a.input.schedule?.priority === 'high');
  const orderA = a.queueOrder ?? queueTime(a.createdAt) ?? 0;
  const orderB = b.queueOrder ?? queueTime(b.createdAt) ?? 0;
  return priority || orderA - orderB;
}

export function isUnstartedQueueItem(workflow: Workflow): boolean {
  return (
    ['queued', 'waiting-resource'].includes(workflow.status) && !workflow.startedAt && workflow.runIds.length === 0
  );
}
