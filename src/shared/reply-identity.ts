import type { ConversationMessage, ReplyExecutionIdentity, RunRecord, Workflow } from './types';

export function automaticallyRouted(workflow: Workflow): boolean {
  if (workflow.replyRouting) return workflow.replyRouting === 'auto';
  const selected = workflow.ownSelection ?? workflow.input;
  return !selected.runtimeId && !selected.provider && !selected.model;
}

/** Use only the runs whose output was included, never a planner, reviewer or the last global run. */
export function captureReplyIdentity(
  workflow: Workflow,
  runs: RunRecord[],
  kind: ReplyExecutionIdentity['kind'] = 'model',
): ReplyExecutionIdentity {
  return {
    automatic: automaticallyRouted(workflow),
    kind,
    runs:
      kind === 'system'
        ? []
        : runs.map((run) => {
            const selection = run.effectiveModel ?? run.route;
            return {
              runId: run.id,
              runtimeId: run.route.runtimeId,
              ...(run.account?.label ? { accountLabel: run.account.label } : {}),
              model: selection.model,
              ...(selection.effort ? { effort: selection.effort } : {}),
              confirmed: !!run.effectiveModel,
            };
          }),
  };
}

/** Legacy replies require a unique owned output match; trimmed output also needs the saved final-message link. */
export function replyIdentity(
  message: ConversationMessage,
  workflow: Workflow | undefined,
  runs: RunRecord[],
): ReplyExecutionIdentity | undefined {
  if (message.role !== 'assistant') return;
  if (message.replyIdentity) return message.replyIdentity;
  if (!workflow || workflow.conversationId !== message.conversationId || workflow.id !== message.workflowId) return;
  const candidates = runs.filter(
    (run) =>
      run.workflowId === workflow.id &&
      workflow.runIds.includes(run.id) &&
      run.stepId &&
      run.status === 'completed' &&
      run.output &&
      ((!run.summary && run.output === message.content) ||
        (run.summary && workflow.finalMessageId === message.id && message.content.endsWith(run.output))) &&
      !!run.endedAt &&
      run.endedAt <= message.createdAt,
  );
  if (candidates.length === 1 && workflow.plan.length <= 1) return captureReplyIdentity(workflow, candidates);
  // Knowing a workflow was automatic is not enough to attribute its old output to any particular run.
  return { automatic: automaticallyRouted(workflow), kind: 'model', runs: [] };
}

/** API cards and other runs without an account label show the card's name instead of its internal id. */
export function namedIdentity(
  identity: ReplyExecutionIdentity | undefined,
  targets: ReadonlyArray<{ id: string; label: string }>,
): ReplyExecutionIdentity | undefined {
  if (!identity) return;
  return {
    ...identity,
    runs: identity.runs.map((run) => {
      const label = run.accountLabel ?? targets.find((target) => target.id === run.runtimeId)?.label;
      return label ? { ...run, accountLabel: label } : run;
    }),
  };
}
