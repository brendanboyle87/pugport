import type { RunRecord, Workflow } from '../shared/types';

/** Prefer this conversation's main task; child runs remain reachable inside its trajectory. */
export function conversationTrajectoryRunId(
  conversationId: string | undefined,
  workflows: readonly Workflow[],
  runs: readonly RunRecord[],
): string | undefined {
  if (!conversationId) return;
  const own = workflows.filter(
    (workflow) => workflow.conversationId === conversationId && !workflow.deletedAt && workflow.runIds.length,
  );
  const main = own.filter((workflow) => !workflow.delegation && !workflow.parentWorkflowId);
  const records = new Map(runs.map((run) => [run.id, run]));
  const candidates = (main.length ? main : own).map((workflow) => {
    // runIds is the task's saved execution order. An omitted old run must not replace its latest run.
    const id = workflow.runIds.at(-1)!;
    return {
      id,
      // Older details can be absent from the bounded state. The inspector fetches them by ID.
      at: records.get(id)?.startedAt ?? workflow.updatedAt,
    };
  });
  candidates.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return candidates[0]?.id;
}
