import type { DatabaseSync } from 'node:sqlite';
import type { BackgroundTask, RunRecord, Workflow } from '../shared/types.ts';
import { localActivity } from '../shared/background-activity.ts';
import { isUnstartedQueueItem, queueTime } from './task-queue.ts';

export type QuitInspection = {
  active: number;
  queued: number;
  waitingApproval: number;
  scheduled: number;
  incognito?: string[];
};

/** Inspect the complete durable queue, not the UI's paginated history. */
export function inspectQuitWork(
  db: DatabaseSync,
  liveRuns: Iterable<RunRecord> = [],
  pendingApprovals = 0,
  now = Date.now(),
  localTasks: readonly BackgroundTask[] = [],
): QuitInspection {
  const result: QuitInspection = { active: 0, queued: 0, waitingApproval: pendingApprovals, scheduled: 0 };
  const active = new Set<string>(),
    approvalRuns = new Set<string>();
  let confirmationCount = 0;
  const workflows = db
    .prepare(
      `SELECT value FROM workspace_records WHERE kind='workflow' AND json_extract(value,'$.status') IN ('queued','waiting-resource','planning','running','waiting-approval','waiting-confirmation')`,
    )
    .all() as { value: string }[];
  for (const row of workflows) {
    const workflow = JSON.parse(row.value) as Workflow;
    if (workflow.status === 'waiting-confirmation') {
      confirmationCount++;
      result.queued++;
      continue;
    }
    if (isUnstartedQueueItem(workflow)) {
      if ((queueTime(workflow.input.schedule?.notBefore) ?? 0) > now) result.scheduled++;
      else result.queued++;
    } else active.add(`workflow:${workflow.id}`);
  }
  const stored = db
    .prepare(`SELECT value FROM runs WHERE json_extract(value,'$.status') IN ('queued','running','waiting-approval')`)
    .all() as { value: string }[];
  const runs = new Map(
    stored.map((row) => {
      const run = JSON.parse(row.value) as RunRecord;
      return [run.id, run] as const;
    }),
  );
  // Live entries include the post-run resource refresh until its ownership is released.
  for (const run of liveRuns) runs.set(run.id, run);
  for (const run of runs.values()) {
    active.add(run.workflowId ? `workflow:${run.workflowId}` : `run:${run.id}`);
    if (run.status === 'waiting-approval') approvalRuns.add(run.id);
  }
  // Local task sources omit finished work and expose ready-queued jobs as running.
  result.active = active.size + localActivity(localTasks).localRunning;
  result.waitingApproval = Math.max(pendingApprovals, approvalRuns.size) + confirmationCount;
  const incognito = db
    .prepare(
      "SELECT json_extract(value,'$.id') AS id FROM workspace_records WHERE kind='conversation' AND json_extract(value,'$.incognito')=1 AND json_extract(value,'$.closedAt') IS NULL",
    )
    .all() as { id: string }[];
  if (incognito.length) result.incognito = incognito.map((row) => row.id);
  return result;
}
