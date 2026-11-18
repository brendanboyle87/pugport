import type { AppState } from '../shared/types';
import { workflowContinuation, workflowStatusLabels } from './queue-utils';

export type ExecutorTask = {
  id: string;
  conversationId?: string;
  status: 'running' | 'waiting';
  phase: string;
  startedAt: string;
};

export function executorTasks(state: Pick<AppState, 'runs' | 'workflows' | 'conversationMessages'>) {
  const byExecutor = new Map<string, ExecutorTask[]>();
  const workflows = new Map((state.workflows ?? []).map((workflow) => [workflow.id, workflow]));
  const activeWorkflows = new Set<string>();
  const add = (id: string, task: ExecutorTask) => {
    const tasks = byExecutor.get(id) ?? [];
    tasks.push(task);
    byExecutor.set(id, tasks);
  };
  for (const run of state.runs) {
    if (!['running', 'waiting-approval', 'queued'].includes(run.status)) continue;
    const workflow = workflows.get(run.workflowId ?? '');
    if (workflow) activeWorkflows.add(workflow.id);
    add(run.route.runtimeId, {
      id: run.id,
      conversationId: workflow?.conversationId,
      status: run.status === 'running' ? 'running' : 'waiting',
      phase: run.status === 'running' && workflow?.phase === 'plan' ? '正在拆解' : workflowStatusLabels[run.status],
      startedAt: run.startedAt,
    });
  }
  for (const workflow of workflows.values()) {
    if (workflow.deletedAt || workflowContinuation(workflow) || activeWorkflows.has(workflow.id)) continue;
    if (!['queued', 'waiting-resource', 'waiting-confirmation', 'waiting-approval'].includes(workflow.status)) continue;
    // An automatic queued task has no account yet; never assign it to an old failed route or a provider label.
    const id = workflow.input?.runtimeId ?? workflow.delegation?.agent?.runtimeId;
    if (!id) continue;
    add(id, {
      id: workflow.id,
      conversationId: workflow.conversationId,
      status: 'waiting',
      phase: workflowStatusLabels[workflow.status],
      startedAt: workflow.updatedAt ?? workflow.createdAt,
    });
  }
  for (const message of state.conversationMessages ?? []) {
    const agent = message.externalAgent;
    if (!agent || agent.following || !['working', 'queued', 'needs-user'].includes(agent.status)) continue;
    add(agent.agentId, {
      id: message.id,
      conversationId: message.conversationId,
      status: agent.status === 'working' ? 'running' : 'waiting',
      phase: agent.status === 'working' ? '正在执行' : agent.status === 'queued' ? '排队中' : '需要处理',
      startedAt: message.createdAt,
    });
  }
  return byExecutor;
}

export function executorStatus(tasks: readonly ExecutorTask[] = [], error?: string) {
  if (error) return { status: 'error', count: 0 } as const;
  const running = tasks.filter((task) => task.status === 'running').length;
  return running
    ? ({ status: 'running', count: running } as const)
    : tasks.length
      ? ({ status: 'waiting', count: tasks.length } as const)
      : ({ status: 'ready', count: 0 } as const);
}
