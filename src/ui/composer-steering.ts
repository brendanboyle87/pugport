import type { AppState, RunRecord, Workflow } from '../shared/types';
import type { Api } from './Workspace';
import { isActiveWorkflow, isExecutingWorkflow } from './queue-utils';
import { conversationQueuedMessages } from './message-queue';

export type ComposerSteering = {
  active?: Workflow;
  currentRun?: RunRecord;
  steeringRun?: RunRecord;
  caption?: string;
};

/** Follow the executing task in this conversation, even when newer messages are already queued. */
export function resolveComposerSteering(
  state: Pick<AppState, 'workflows' | 'runs' | 'settings'>,
  conversationId?: string,
): ComposerSteering {
  if (!conversationId) return {};
  const own = (state.workflows ?? [])
    .filter((workflow) => workflow.conversationId === conversationId && isActiveWorkflow(workflow))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const active = own.find(isExecutingWorkflow) ?? own[0];
  if (!active) return {};
  if (!isExecutingWorkflow(active)) {
    const waiting =
      active.status === 'waiting-resource'
        ? '任务正在等待资源'
        : active.status === 'waiting-confirmation'
          ? '任务正在等待确认方案'
          : '任务正在排队';
    return { active, caption: `${waiting}；新消息会加入队列。` };
  }
  const currentRun = state.runs
    .filter((run) => run.workflowId === active.id && ['running', 'waiting-approval', 'queued'].includes(run.status))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const result: ComposerSteering = { active, currentRun };
  if (active.status === 'waiting-approval' || currentRun?.status === 'waiting-approval')
    return { ...result, caption: '任务正在等待审批；插话暂不可用，新消息会排队。' };
  if (active.status === 'planning' || active.phase === 'plan' || (currentRun && !currentRun.stepId))
    return { ...result, caption: '正在理解与拆解任务；插话通道将在执行阶段连接，新消息会排队。' };
  const approvalMode = active.input.toolApprovalMode ?? state.settings.toolApprovalMode ?? 'auto';
  if (currentRun?.toolApprovalMode && currentRun.toolApprovalMode !== approvalMode)
    return { ...result, caption: '审批设置已更改；新消息会作为下一任务。' };
  if (currentRun?.status === 'running' && currentRun.steerAvailable && currentRun.toolApprovalMode === approvalMode) {
    return {
      ...result,
      steeringRun: currentRun,
    };
  }
  const status = currentRun?.steeringStatus?.state;
  const caption =
    status === 'finishing' || ['verify', 'summarize'].includes(active.phase)
      ? '本轮正在收尾，后续消息会继续任务。'
      : status === 'starting' || (!currentRun && active.phase === 'route') || currentRun?.status === 'queued'
        ? '执行器正在启动，插话通道尚在连接；新消息会排队。'
        : status === 'waiting' || !currentRun
          ? '正在切换执行阶段，插话暂不可用；新消息会排队。'
          : status === 'unsupported'
            ? '当前执行器协议未提供插话通道；新消息会排队。'
            : '插话通道尚未就绪；新消息会排队。';
  return { ...result, caption };
}

export function queuedSteeringRun(
  state: Pick<AppState, 'workflows' | 'runs' | 'settings'>,
  workflow: Workflow,
): RunRecord | undefined {
  if (
    workflow.deletedAt ||
    workflow.followUp ||
    workflow.startedAt ||
    workflow.runIds.length > 0 ||
    workflow.parentWorkflowId ||
    workflow.delegation ||
    !['queued', 'waiting-resource'].includes(workflow.status)
  )
    return;
  const target = resolveComposerSteering(state, workflow.conversationId).steeringRun;
  if (
    workflow.pendingSteer &&
    (workflow.pendingSteer.runId !== target?.id || workflow.pendingSteer.workflowId !== target?.workflowId)
  )
    return;
  return target;
}

const queuedSteers = new WeakMap<Api, Map<string, Promise<void>>>();
export function steerQueuedWorkflow(api: Api, workflowId: string): Promise<void> {
  let pending = queuedSteers.get(api);
  if (!pending) queuedSteers.set(api, (pending = new Map()));
  const existing = pending.get(workflowId);
  if (existing) return existing;
  const delivery = Promise.resolve().then(async () => {
    await api(`/api/workflows/${encodeURIComponent(workflowId)}/steer`, {}, 'POST');
  });
  pending.set(workflowId, delivery);
  void delivery.finally(() => pending.delete(workflowId)).catch(() => undefined);
  return delivery;
}

/** Enter on an empty draft uses the first visible queued message and never falls through to a new task. */
export async function steerFirstQueuedMessage(
  api: Api,
  state: Pick<AppState, 'workflows' | 'runs' | 'settings'>,
  conversationId?: string,
): Promise<boolean> {
  if (!conversationId || !resolveComposerSteering(state, conversationId).steeringRun) return false;
  const first = conversationQueuedMessages(state.workflows ?? [], conversationId)[0];
  if (!first) return false;
  if (!queuedSteeringRun(state, first)) throw new Error('首条排队消息不能插入当前执行阶段；消息与排队顺序已保留。');
  await steerQueuedWorkflow(api, first.id);
  return true;
}
