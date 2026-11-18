import type { Workflow } from '../shared/types';
import { compareMessageQueue } from './queue-utils';
import type { ConversationTimelineRow } from './conversation-timeline';

export function isMessageQueueItem(workflow: Workflow): boolean {
  const schedule = workflow.input.schedule;
  return (
    !workflow.deletedAt &&
    !workflow.followUp &&
    !workflow.startedAt &&
    workflow.runIds.length === 0 &&
    !workflow.parentWorkflowId &&
    !workflow.delegation &&
    ['queued', 'waiting-resource'].includes(workflow.status) &&
    !schedule?.deadlineAt &&
    !schedule?.notBefore &&
    schedule?.priority !== 'high' &&
    schedule?.preferExpiringQuota !== false
  );
}

export function conversationQueuedMessages(workflows: Workflow[], conversationId: string): Workflow[] {
  return workflows
    .filter((workflow) => workflow.conversationId === conversationId && isMessageQueueItem(workflow))
    .sort(compareMessageQueue);
}

/** The quietly waiting head stays in its timeline card; later messages still need queue actions. */
export function representedQueueHeadId(
  queued: readonly Workflow[],
  timeline: readonly ConversationTimelineRow[],
): string | undefined {
  const head = queued[0];
  if (!head || !['pending', 'wait'].includes(head.machineLoadChoice ?? '') || head.pendingSteer) return;
  return timeline.some((row) => row.kind === 'workflow' && row.workflow.id === head.id) ? head.id : undefined;
}
