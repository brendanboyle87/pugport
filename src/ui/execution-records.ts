import type { ConversationMessage, RunRecord, Workflow } from '../shared/types';

export type WorkflowExecutionRecord = {
  workflow: Workflow;
  userInput?: string;
  finalOutput?: string;
  runs: RunRecord[];
  relatedRuns: RunRecord[];
  relatedWorkflows?: Workflow[];
  messages?: ConversationMessage[];
};
export type ExecutionRecordRequestState = {
  workflowId: string;
  selectedRunId: string;
  status: 'loading' | 'ready' | 'failed';
  record?: WorkflowExecutionRecord;
  error?: string;
};

/** One durable workflow read, with identity checks and cancellation before committing any response. */
export function requestExecutionRecord(
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>,
  workflowId: string,
  selectedRunId: string,
  update: (state: ExecutionRecordRequestState) => void,
) {
  let cancelled = false;
  update({ workflowId, selectedRunId, status: 'loading' });
  const promise = api<WorkflowExecutionRecord>(
    `/api/workflows/${encodeURIComponent(workflowId)}/execution-record`,
    undefined,
    'GET',
  )
    .then((record) => {
      if (cancelled) return;
      if (
        record.workflow.id !== workflowId ||
        !record.runs.some((run) => run.id === selectedRunId && run.workflowId === workflowId) ||
        record.runs.some((run) => run.workflowId !== workflowId)
      )
        throw new Error('返回的任务执行记录与所选任务不一致。');
      update({ workflowId, selectedRunId, status: 'ready', record });
    })
    .catch((error: unknown) => {
      if (!cancelled)
        update({
          workflowId,
          selectedRunId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
    });
  return {
    promise,
    cancel: () => {
      cancelled = true;
    },
  };
}

/** Resolve descendants recursively, retaining unassociated children rather than silently dropping their trace. */
export function executionChildTree(
  mainRuns: readonly RunRecord[],
  relatedRuns: readonly RunRecord[],
  workflows: readonly Workflow[] = [],
) {
  const all = new Map([...mainRuns, ...relatedRuns].map((run) => [run.id, run]));
  const related = new Map(relatedRuns.map((run) => [run.id, run]));
  const tasks = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const children = new Map<string, RunRecord[]>();
  const workflowChildren = new Map<string, RunRecord[]>();
  const unassociated: RunRecord[] = [];
  for (const run of related.values()) {
    const caller = run.parentRunId;
    const fatherWorkflow = run.workflowId ? tasks.get(run.workflowId)?.delegation?.parentId : undefined;
    if (!caller && fatherWorkflow) {
      workflowChildren.set(fatherWorkflow, [...(workflowChildren.get(fatherWorkflow) ?? []), run]);
      continue;
    }
    // Cycles or a missing caller remain visible as roots, never recurse forever.
    let ancestor = caller;
    const seen = new Set([run.id]);
    let cyclic = false;
    while (ancestor && related.has(ancestor)) {
      if (seen.has(ancestor)) {
        cyclic = true;
        break;
      }
      seen.add(ancestor);
      ancestor = related.get(ancestor)?.parentRunId;
    }
    if (!caller || !all.has(caller) || cyclic) unassociated.push(run);
    else children.set(caller, [...(children.get(caller) ?? []), run]);
  }
  return { children, workflowChildren, unassociated };
}

/** Only a persisted user message or an explicitly supplied original is trusted. */
export function executionUserInput(
  run: Pick<RunRecord, 'prompt'> & { userInput?: string },
  original?: string,
): string | undefined {
  return original ?? run.userInput;
}

/** Keep each attempt, including failed relays; never merge event identities across runs. */
export function executionWorkflowRuns(selected: RunRecord, runs: readonly RunRecord[] = []): RunRecord[] {
  const records = new Map<string, RunRecord>();
  for (const run of runs) {
    if (selected.workflowId && run.workflowId === selected.workflowId) records.set(run.id, run);
  }
  records.set(selected.id, selected);
  return [...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

/** Each user task owns one row; attempts and delegated children stay inside its trace. */
export function executionRecordRows(
  runs: readonly RunRecord[],
  workflows: readonly Workflow[] = [],
  selectedRunId?: string,
): RunRecord[] {
  const tasks = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const rows = new Map<string, RunRecord>();
  for (const run of [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))) {
    const workflow = run.workflowId ? tasks.get(run.workflowId) : undefined;
    if (workflow?.delegation && run.id !== selectedRunId) continue;
    const key = run.workflowId ?? run.id;
    if (!rows.has(key)) rows.set(key, run);
  }
  return [...rows.values()];
}

/** Newest-first tasks and sections: open chats, one archived/deleted group, and one non-chat group. */
export function executionRecordGroups(
  rows: readonly RunRecord[],
  workflows: readonly Pick<Workflow, 'id' | 'conversationId'>[],
  isOpenChat: (conversationId: string) => boolean,
) {
  const tasks = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const groups = new Map<
    string,
    { key: string; kind: 'chat' | 'archived' | 'other'; conversationId: string; runs: RunRecord[] }
  >();
  // Rows arrive newest first, so each group's position is set by its latest task.
  for (const run of rows) {
    const conversationId = (run.workflowId && tasks.get(run.workflowId)?.conversationId) || '';
    const kind = conversationId ? (isOpenChat(conversationId) ? 'chat' : 'archived') : 'other';
    const key = kind === 'chat' ? conversationId : kind;
    const group = groups.get(key) ?? { key, kind, conversationId: kind === 'chat' ? conversationId : '', runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }
  return [...groups.values()];
}
