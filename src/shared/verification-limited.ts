import type { RunRecord, Workflow } from './types.ts';

export function verificationLimitedChecks(workflow: Workflow, runs: readonly RunRecord[]) {
  if (workflow.status !== 'completed') return [];
  return runs
    .filter(
      (run) =>
        workflow.runIds.includes(run.id) &&
        (!run.workflowId || run.workflowId === workflow.id) &&
        !run.visualAssistant &&
        run.status === 'completed' &&
        run.taskOutcome?.source === 'file-receipts' &&
        run.taskOutcome.status === 'completed' &&
        run.taskOutcome?.verificationLimited,
    )
    .flatMap((run) => run.taskOutcome?.limitedChecks ?? []);
}
