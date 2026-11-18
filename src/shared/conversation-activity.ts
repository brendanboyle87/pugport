import type { RunRecord, Workflow } from './types.ts';

export const workflowFollowUp = (workflow: Workflow) =>
  ['blocked', 'interrupted', 'failed'].includes(workflow.status) ||
  (workflow.status === 'cancelled' && workflow.stopped)
    ? workflow.followUp
    : undefined;

/** A later message preserves history; only an explicit continuation replaces unfinished work. */
export const workflowContinuation = (workflow: Workflow) => {
  const followUp = workflowFollowUp(workflow);
  return followUp?.kind === 'continue' ? followUp : undefined;
};

export type ConversationActivity = 'running' | 'attention' | 'queued';
/** Background waits resume themselves; only explicit continuations replace unfinished work. */
export const needsContinuation = (workflow: Workflow) =>
  !workflow.deletedAt &&
  !workflowContinuation(workflow) &&
  ['blocked', 'interrupted', 'failed'].includes(workflow.status) &&
  !(workflow.status === 'blocked' && workflow.waitingOn);

export type WorkflowAttention = { kind: 'question' | 'approval' | 'confirmation' | 'stopped'; text?: string };
export function workflowAttention(
  workflow: Workflow,
  lastRun?: RunRecord,
  now = Date.now(),
): WorkflowAttention | undefined {
  if (workflow.deletedAt || workflow.delegation || workflow.followUp?.kind === 'continue') return;
  if (workflow.userQuestion && !workflow.userQuestion.answeredMessageId)
    return { kind: 'question', text: workflow.userQuestion.text };
  if (workflow.status === 'waiting-approval') return { kind: 'approval' };
  if (workflow.status === 'waiting-confirmation') return { kind: 'confirmation' };
  const recent = Date.parse(workflow.updatedAt ?? workflow.createdAt) >= now - 14 * 24 * 60 * 60 * 1000;
  // Stopped work belongs to whoever asked for it: a dispatching agent, another device or an outside tool collects
  // its own results, so only work the owner started in PugPort waits for the owner.
  const ownWork = !['caller', 'external', 'device', 'parent'].includes(
    workflow.input?.permissionOrigin?.source ?? 'user',
  );
  if (needsContinuation(workflow) && ownWork && !workflow.supersededAt && !workflow.attentionDismissedAt && recent)
    return {
      kind: 'stopped',
      text: lastRun?.id === workflow.runIds?.at(-1) ? lastRun?.taskOutcome?.summary : undefined,
    };
}
export const workflowNeedsUser = (workflow: Workflow, now = Date.now()) =>
  !!workflowAttention(workflow, undefined, now);
/** Sidebar state of a conversation: a task is running, waits for the user, or only waits in the queue. */
export function conversationActivity(
  workflows: Workflow[],
  conversationId: string,
  now = Date.now(),
): ConversationActivity | undefined {
  const own = workflows.filter(
    (workflow) => workflow.conversationId === conversationId && !workflow.deletedAt && !workflowContinuation(workflow),
  );
  if (own.some((workflow) => ['planning', 'running'].includes(workflow.status))) return 'running';
  if (own.some((workflow) => workflowNeedsUser(workflow, now))) return 'attention';
  if (own.some((workflow) => ['queued', 'waiting-resource'].includes(workflow.status))) return 'queued';
  return undefined;
}
