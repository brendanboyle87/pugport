import type { Workflow } from '../shared/types.ts';
import { usageMetricKeys, type TaskCost, type UsageMeasures, type UsageRun } from '../shared/usage.ts';

/*
 * What a whole task cost, not one run: the task itself, the subtasks it handed out, its automatic reviews,
 * the fixes they asked for, and every retry, added up. The cheapest price per token is not the cheapest
 * finished task; this is where that shows.
 */

/** The task a workflow belongs to: up through the subtask's caller and the fix's original, to the first message. */
function rootOf(workflow: Workflow, byId: Map<string, Workflow>): Workflow {
  let current = workflow;
  for (let depth = 0; depth < 50; depth++) {
    const up = current.delegation?.parentId ?? current.parentWorkflowId;
    const next = up ? byId.get(up) : undefined;
    if (!next) return current;
    current = next;
  }
  return current;
}

export function taskCosts(workflows: Workflow[], runs: UsageRun[], limit = 60): TaskCost[] {
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const groups = new Map<string, Workflow[]>();
  for (const workflow of workflows) {
    if (workflow.deletedAt) continue;
    const root = rootOf(workflow, byId);
    groups.set(root.id, [...(groups.get(root.id) ?? []), workflow]);
  }
  const runsByWorkflow = new Map<string, UsageRun[]>();
  for (const run of runs)
    if (run.workflowId) runsByWorkflow.set(run.workflowId, [...(runsByWorkflow.get(run.workflowId) ?? []), run]);
  const out: TaskCost[] = [];
  for (const [rootId, members] of groups) {
    const root = byId.get(rootId)!;
    const memberRuns = members.flatMap((member) => runsByWorkflow.get(member.id) ?? []);
    if (!memberRuns.length) continue;
    const measures = Object.fromEntries(
      usageMetricKeys.map((key) => {
        const reported = memberRuns.map((run) => run[key]).filter((value): value is number => value !== null);
        return [key, reported.length ? reported.reduce((sum, value) => sum + value, 0) : null];
      }),
    ) as UsageMeasures;
    // The latest workflow of the chain tells how the task ended (a fix supersedes what it fixed).
    const last =
      [...members].filter((member) => !member.delegation).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      root;
    // Retries: runs beyond one per step in a workflow.
    const retries = members.reduce((sum, member) => {
      const own = runsByWorkflow.get(member.id)?.length ?? 0;
      return sum + Math.max(0, own - Math.max(1, member.plan?.length ?? 1));
    }, 0);
    out.push({
      ...measures,
      taskId: rootId,
      conversationId: root.conversationId,
      title: root.input.content.replace(/\s+/g, ' ').trim().slice(0, 80),
      startedAt: root.createdAt,
      status: last.status,
      runs: memberRuns.length,
      subtasks: members.filter((member) => member.delegation && member.delegation.role !== 'reviewer').length,
      reviews: members.filter((member) => member.delegation?.role === 'reviewer').length,
      fixes: members.filter((member) => !member.delegation && member.id !== rootId).length,
      retries,
      executors: [...new Set(memberRuns.map((run) => run.runtimeLabel))],
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}
