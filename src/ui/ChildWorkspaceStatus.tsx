import type { Workflow } from '../shared/types';
import type { ManagedWorktree, ManagedWorktreeDelivery } from '../shared/managed-worktrees';
import { canContinueWorkflow } from './queue-utils';

const workspaceLabels: Record<ManagedWorktree['state'], string> = {
  preparing: '正在准备独立目录',
  ready: '独立目录可用',
  failed: '独立目录准备失败',
  'recovery-required': '工作目录需要恢复',
};
const deliveryLabels: Record<ManagedWorktreeDelivery['status'], string> = {
  applying: '正在交付改动',
  applied: '改动已交付',
  unchanged: '没有需要交付的改动',
  conflict: '交付冲突，改动仍保留',
  blocked: '交付受阻，改动仍保留',
  'recovery-required': '交付需要核对，改动仍保留',
};

export function ChildWorkspaceStatus({
  workflow,
  onContinue,
  onDeliver,
  pending = false,
}: {
  workflow: Workflow;
  onContinue?: () => void;
  onDeliver?: () => void;
  pending?: boolean;
}) {
  const workspace = workflow.executionWorkspace;
  const inherited = workflow.inheritedExecutionWorkspace === true || workflow.executionWorkspaceMode === 'inherited';
  const receipt = workspace?.delivery;
  const previousSuccess =
    (receipt?.status === 'applied' || receipt?.status === 'unchanged') &&
    workflow.executionDeliveryWorkflowId !== workflow.id;
  const delivery = inherited || previousSuccess ? undefined : receipt;
  const canDeliver =
    workflow.status === 'completed' &&
    !workflow.stopped &&
    !workflow.deletedAt &&
    Boolean(workflow.executionWorkspaceId) &&
    !inherited &&
    !['applying', 'applied', 'unchanged'].includes(delivery?.status ?? '');
  const recovery = workflow.recovery ?? workflow.delegation?.dependencyBlock;
  if (!workspace && !workflow.executionWorkspaceMode && !recovery && !workflow.deliveryPendingReason) return null;
  return (
    <section className="local-memory-settings" aria-label="子代理工作目录与交付">
      <strong>
        {inherited
          ? '沿用父任务工作目录（只读）'
          : workspace
            ? workspaceLabels[workspace.state]
            : workflow.executionWorkspaceMode === 'shared'
              ? '共享项目目录'
              : '独立目录尚未就绪'}
      </strong>
      {workspace?.directory && (
        <p>
          <code translate="no" style={{ overflowWrap: 'anywhere' }}>
            {workspace.directory}
          </code>
        </p>
      )}
      {workspace?.branch && (
        <p>
          分支：<code translate="no">{workspace.branch}</code>
        </p>
      )}
      {workspace?.error && <p role="status">{workspace.error}</p>}
      {!inherited && workspace && (
        <>
          <p role="status">
            {delivery
              ? deliveryLabels[delivery.status]
              : workflow.status === 'completed'
                ? '子任务已结束；改动尚未交付。'
                : '改动交付：等待子任务结束。'}
          </p>
          {delivery?.reason && <p>{delivery.reason}</p>}
          {!!delivery?.changedPaths.length && (
            <details>
              <summary>{`${delivery.changedPaths.length} 个文件`}</summary>
              <ul>
                {delivery.changedPaths.map((path) => (
                  <li key={path}>
                    <code translate="no" style={{ overflowWrap: 'anywhere' }}>
                      {path}
                    </code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {workflow.deliveryPendingReason && <p role="status">{workflow.deliveryPendingReason}</p>}
      {recovery && (
        <p role="status">
          {recovery.reason} {recovery.recoveryCondition}
        </p>
      )}
      {workflow.routingContext?.profile && <p>任务采用的路由：{workflow.routingContext.profile.name}</p>}
      {onContinue && canContinueWorkflow(workflow) && (
        <button type="button" className="button tiny secondary" disabled={pending} onClick={onContinue}>
          继续此成员
        </button>
      )}
      {onDeliver && canDeliver && (
        <button type="button" className="button tiny secondary" disabled={pending} onClick={onDeliver}>
          {delivery ? '重新尝试交付' : '交付改动'}
        </button>
      )}
    </section>
  );
}
