import { currentLocale } from './i18n';
import { needsContinuation, workflowContinuation, type ConversationActivity } from '../shared/conversation-activity.ts';
export {
  workflowFollowUp,
  workflowContinuation,
  workflowNeedsUser,
  needsContinuation,
  conversationActivity,
  type ConversationActivity,
} from '../shared/conversation-activity.ts';
import type { RunRecord, TaskSchedule, Workflow } from '../shared/types';
import { verificationLimitedChecks } from '../shared/verification-limited.ts';

export const workflowStatusLabels: Record<Workflow['status'], string> = {
  queued: '排队中',
  'waiting-resource': '等待资源',
  planning: '正在拆解',
  running: '正在执行',
  'waiting-confirmation': '等待确认方案',
  'waiting-approval': '等待审批',
  blocked: '需要处理',
  completed: '已结束',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

export function workflowDisplayStatus(workflow: Workflow, runs: RunRecord[]): { label: string; verified: boolean } {
  if (workflow.machineLoadChoice === 'cancelled' && workflow.status === 'cancelled')
    return { label: '已取消（电脑繁忙时未执行）', verified: false };
  if (['pending', 'wait'].includes(workflow.machineLoadChoice ?? '') && workflow.status === 'waiting-resource')
    return { label: '排队中', verified: false };
  if (workflow.status === 'cancelled' && workflow.followUp?.kind === 'message' && workflow.runIds.length === 0)
    return { label: '已作为插话送达', verified: false };
  const followUp = workflowContinuation(workflow);
  if (followUp)
    return {
      label: '已创建续接任务',
      verified: false,
    };
  if (workflow.status === 'blocked' && workflow.waitingOn) return { label: '等后台比对', verified: false };
  if (workflow.status !== 'completed' && workflow.error?.startsWith('结果未确认：'))
    return { label: '结果未确认', verified: false };
  if (workflow.status !== 'completed') return { label: workflowStatusLabels[workflow.status], verified: false };
  if (verificationLimitedChecks(workflow, runs).length) return { label: '已完成 · 验证受限', verified: false };
  if (workflow.input.mode === 'chat') return { label: '回复结束', verified: false };
  const steps = workflow.plan.filter((step) => step.status !== 'skipped');
  const byId = new Map(runs.map((run) => [run.id, run]));
  // Model reports and planning calls are not independent evidence that execution passed acceptance.
  const verified =
    workflow.input.mode === 'build' &&
    steps.length > 0 &&
    steps.every(
      (step) =>
        step.status === 'completed' &&
        step.runIds.length > 0 &&
        step.runIds.every((id) => {
          const run = byId.get(id);
          return (
            run?.status === 'completed' &&
            (!run.workflowId || run.workflowId === workflow.id) &&
            (!run.stepId || run.stepId === step.id) &&
            run.verification?.status === 'passed'
          );
        }),
    );
  if (verified) return { label: '已验收', verified };
  // Only a check that actually ran and failed is worth flagging; no check at all simply reads as done.
  const failedCheck = steps.some((step) => step.runIds.some((id) => byId.get(id)?.verification?.status === 'failed'));
  return { label: failedCheck ? '验收未通过' : '已完成', verified: false };
}
export const isWaitingWorkflow = (workflow: Workflow) =>
  !workflow.deletedAt && ['queued', 'waiting-resource', 'waiting-confirmation'].includes(workflow.status);
export const isExecutingWorkflow = (workflow: Workflow) =>
  !workflow.deletedAt && ['planning', 'running', 'waiting-approval'].includes(workflow.status);
export const isActiveWorkflow = (workflow: Workflow) => isWaitingWorkflow(workflow) || isExecutingWorkflow(workflow);
export const conversationActivityLabels: Record<ConversationActivity, string> = {
  running: '正在执行',
  attention: '等你处理',
  queued: '排队中',
};
/** Unfinished work the user still has to deal with. */
/** A task only waiting for a background job continues by itself, so it is not counted as needing the user. */
const waitingOnBackground = (workflow: Workflow) => workflow.status === 'blocked' && !!workflow.waitingOn;
/** A task the user stopped after it started can also be resumed, but it does not count as pending. */
export const canContinueWorkflow = (workflow: Workflow) =>
  needsContinuation(workflow) ||
  (!workflow.deletedAt &&
    !workflowContinuation(workflow) &&
    workflow.status === 'completed' &&
    !!workflow.fileChangeNotice) ||
  (!workflow.deletedAt && !workflowContinuation(workflow) && waitingOnBackground(workflow)) ||
  (!workflow.deletedAt && !workflowContinuation(workflow) && workflow.status === 'cancelled' && !!workflow.stopped);
export const canCancelWorkflow = (workflow: Workflow) =>
  !workflow.deletedAt && (isActiveWorkflow(workflow) || ['blocked', 'interrupted', 'failed'].includes(workflow.status));
export const canDeleteWorkflow = (workflow: Workflow) => !workflow.deletedAt && !isActiveWorkflow(workflow);
export const isPendingWorkflow = (workflow: Workflow) =>
  isActiveWorkflow(workflow) ||
  needsContinuation(workflow) ||
  (!workflow.deletedAt && !workflowContinuation(workflow) && waitingOnBackground(workflow));
export type QueueStatusFilter = 'pending' | 'all' | Workflow['status'];
export type QueueSort = 'progress' | 'deadline' | 'created';

const dateValue = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.POSITIVE_INFINITY;
const progressRank = (workflow: Workflow) =>
  isExecutingWorkflow(workflow) ? 0 : isWaitingWorkflow(workflow) ? 1 : needsContinuation(workflow) ? 2 : 3;
export const queueOrderValue = (workflow: Workflow) =>
  Number.isFinite(workflow.queueOrder) ? workflow.queueOrder! : dateValue(workflow.createdAt);
export const compareMessageQueue = (left: Workflow, right: Workflow) =>
  queueOrderValue(left) - queueOrderValue(right) ||
  left.createdAt.localeCompare(right.createdAt) ||
  left.id.localeCompare(right.id);
export function selectQueue(
  workflows: Workflow[],
  projectId: string,
  status: QueueStatusFilter,
  sort: QueueSort,
): Workflow[] {
  return workflows
    .filter(
      (workflow) =>
        !workflow.deletedAt &&
        (!projectId || workflow.projectId === projectId) &&
        (status === 'all' || (status === 'pending' ? isPendingWorkflow(workflow) : workflow.status === status)),
    )
    .sort((left, right) => {
      if (sort === 'progress') {
        const rank = progressRank(left) - progressRank(right);
        if (rank) return rank;
      }
      if (sort !== 'created') {
        const leftDeadline = dateValue(left.input.schedule?.deadlineAt),
          rightDeadline = dateValue(right.input.schedule?.deadlineAt);
        if (leftDeadline !== rightDeadline) return leftDeadline < rightDeadline ? -1 : 1;
        const priority =
          Number(right.input.schedule?.priority === 'high') - Number(left.input.schedule?.priority === 'high');
        if (priority) return priority;
      }
      return compareMessageQueue(left, right);
    });
}

export function scheduleFromLocalInput(
  deadline: string,
  notBefore: string,
  priority: 'normal' | 'high',
  preferExpiringQuota: boolean,
): TaskSchedule {
  function iso(value: string, label: string) {
    if (!value) return undefined;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`请选择有效的${label}。`);
    // datetime-local is interpreted in the user's local timezone, then sent as an absolute instant.
    return date.toISOString();
  }
  const deadlineAt = iso(deadline, '任务期限');
  const start = iso(notBefore, '最早开始时间');
  if (deadlineAt && start && Date.parse(start) >= Date.parse(deadlineAt))
    throw new Error('最早开始时间需要早于任务期限。');
  return {
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(start ? { notBefore: start } : {}),
    priority,
    preferExpiringQuota,
  };
}

/** Default composer options must not turn an ordinary message into a scheduled task. */
export function composerMessageSchedule(
  deadline: string,
  notBefore: string,
  priority: 'normal' | 'high',
  preferExpiringQuota: boolean,
): TaskSchedule | undefined {
  if (!deadline && !notBefore && priority === 'normal' && preferExpiringQuota) return;
  return scheduleFromLocalInput(deadline, notBefore, priority, preferExpiringQuota);
}

export function queueDate(value?: string): string {
  if (!value) return '未设置';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return date.toLocaleString(currentLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
export function estimatedDuration(workflow: Workflow): string {
  const minutes = workflow.scheduling?.estimatedMinutes ?? workflow.input.schedule?.estimatedMinutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
    ? `约 ${Math.ceil(minutes)} 分钟（估计）`
    : '尚未估计';
}
export function deadlineRiskLabel(workflow: Workflow, now: number): string | undefined {
  if (!isPendingWorkflow(workflow)) return undefined;
  if (dateValue(workflow.input.schedule?.deadlineAt) <= now) return '已超过期限';
  return workflow.scheduling?.deadlineRisk ? '有超期风险' : undefined;
}
