import { useEffect, useState } from 'react';
import type { RunRecord, Workflow } from '../shared/types';

type TimedWorkflow = Pick<Workflow, 'id' | 'status' | 'startedAt' | 'updatedAt' | 'runIds' | 'deletedAt'>;
type TimedRun = Pick<RunRecord, 'id' | 'workflowId' | 'startedAt' | 'endedAt'>;
const runningStatuses = new Set<Workflow['status']>(['planning', 'running', 'waiting-approval']);
const waitingStatuses = new Set<Workflow['status']>(['queued', 'waiting-resource', 'waiting-confirmation']);

function timestamp(value?: string): number | undefined {
  if (!value) return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Wall time starts at launch, never at message creation or queue entry. */
export function workflowElapsed(workflow: TimedWorkflow, runs: readonly TimedRun[], now: number) {
  if (workflow.deletedAt || !Number.isFinite(now)) return;
  const runIds = new Set(workflow.runIds);
  const ownRuns = runs.filter((run) => runIds.has(run.id) && (!run.workflowId || run.workflowId === workflow.id));
  const runStarts = ownRuns.map((run) => timestamp(run.startedAt)).filter((at): at is number => at !== undefined);
  // Older workflows may lack their launch timestamp; an actual native run is still evidence of a start.
  const startedAt = timestamp(workflow.startedAt) ?? (runStarts.length ? Math.min(...runStarts) : undefined);
  if (startedAt === undefined) return;
  const active = runningStatuses.has(workflow.status);
  const paused = waitingStatuses.has(workflow.status);
  const validEnd = (at: number | undefined): at is number => at !== undefined && at >= startedAt && at <= now;
  const updatedAt = timestamp(workflow.updatedAt);
  const runEnds = ownRuns.map((run) => timestamp(run.endedAt)).filter(validEnd);
  const lastRunEnd = runEnds.length ? Math.max(...runEnds) : undefined;
  const allRunsEnded = ownRuns.length > 0 && ownRuns.length === runIds.size && runEnds.length === ownRuns.length;
  // A later cancel or metadata update can republish an already stopped workflow.
  // Its last native end is stable; measure launch-to-end wall time, including gaps between runs.
  const endedAt =
    !active && !paused && allRunsEnded ? lastRunEnd! : validEnd(updatedAt) ? updatedAt : (lastRunEnd ?? startedAt);
  return { startedAt, active, paused, elapsedMs: Math.max(0, (active ? now : endedAt) - startedAt) };
}

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.floor(Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) / 1000 : 0);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours) return `${hours}小时${String(minutes).padStart(2, '0')}分${String(seconds).padStart(2, '0')}秒`;
  if (minutes) return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
  return `${seconds}秒`;
}

export function formatConversationDuration(ms: number, locale: string) {
  const seconds = Math.floor(Number.isFinite(ms) ? Math.max(0, ms) / 1000 : 0);
  const parts = [
    [Math.floor(seconds / 3600), '小时', 'h'],
    [Math.floor(seconds / 60) % 60, '分', 'min'],
    [seconds % 60, '秒', 's'],
  ] as const;
  return parts
    .filter(([n], i) => n || i === 2)
    .map(([n, zh, en]) => `${n} ${locale === 'en' ? en : zh}`)
    .join(' ');
}
/** Only this small visible counter rerenders each second; finished history creates no timers. */
export function WorkflowElapsed({
  workflow,
  runs,
  className = 'workflow-elapsed',
  minimumMs = 0,
  formatDuration,
}: {
  workflow: TimedWorkflow;
  runs: readonly TimedRun[];
  className?: string;
  minimumMs?: number;
  formatDuration?: (elapsedMs: number) => string;
}) {
  const [, tick] = useState(0);
  const elapsed = workflowElapsed(workflow, runs, Date.now());
  const active = elapsed?.active ?? false;
  const startedAt = elapsed?.startedAt;
  useEffect(() => {
    if (!active) return;
    // Recalculate from Date.now(), so renderer throttling or sleep cannot make the counter drift.
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt, workflow.id]);
  if (!elapsed) return null;
  const caption = elapsed.active ? '已运行' : elapsed.paused ? '已用时' : '用时';
  const title = elapsed.active
    ? '从任务实际启动开始计算的总用时，包含执行期间的审批等待。'
    : elapsed.paused
      ? '任务正在等待，显示进入等待时的总用时。'
      : '任务已停止，显示停止时的总用时。';
  return (
    <span className={className} title={`${caption} · ${title}`}>
      {formatDuration ? (
        <span translate="no">{formatDuration(Math.max(minimumMs, elapsed.elapsedMs))}</span>
      ) : (
        formatElapsedDuration(Math.max(minimumMs, elapsed.elapsedMs))
      )}
    </span>
  );
}
