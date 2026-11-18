import type { RunRecord, Workflow } from '../shared/types.ts';

export type DelegationNode = { id: string; dependsOn: string[] };

/** Validate the entire graph before looking up agents or enqueuing any work. */
export function validateDelegationGraph(nodes: readonly DelegationNode[]) {
  const byId = new Map<string, DelegationNode>();
  for (const node of nodes) {
    if (!/^[\w.-]{1,80}$/.test(node.id))
      throw new Error('子任务 id 只能包含字母、数字、下划线、点和连字符，最多 80 字符。');
    if (byId.has(node.id)) throw new Error(`子任务 id 重复：${node.id}`);
    byId.set(node.id, node);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`子任务依赖成环：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`子任务 ${id} 依赖未知 id：${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

export type DependencyGate =
  | { state: 'ready' }
  | { state: 'waiting'; reason: string }
  | {
      state: 'blocked';
      code: 'dependency-failed' | 'dependency-unverified' | 'parent-closed' | 'dependency-missing';
      reason: string;
      recoveryCondition: string;
      dependencyId?: string;
    };

/** Claims in an executor's reply never substitute for host completion and verification records. */
export function delegationDependencyGate(
  workflow: Workflow,
  parent: Workflow | undefined,
  getWorkflow: (id: string) => Workflow | undefined,
  getRun: (id: string) => RunRecord | undefined,
): DependencyGate {
  const delegation = workflow.delegation;
  if (!delegation?.batchId) return { state: 'ready' };
  if (
    !parent ||
    parent.deletedAt ||
    ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(parent.status)
  )
    return {
      state: 'blocked',
      code: 'parent-closed',
      reason: '调用方已结束，依赖子任务没有启动。',
      recoveryCondition: '由用户继续父任务并重新安排剩余子任务。',
    };
  for (const id of delegation.dependsOn ?? []) {
    const dependency = getWorkflow(id);
    if (!dependency || dependency.deletedAt)
      return {
        state: 'blocked',
        code: 'dependency-missing',
        dependencyId: id,
        reason: `依赖任务不存在：${id}`,
        recoveryCondition: '恢复依赖记录，或在新批次中修正 depends_on。',
      };
    if (
      ['queued', 'waiting-resource', 'planning', 'running', 'waiting-confirmation', 'waiting-approval'].includes(
        dependency.status,
      )
    )
      return { state: 'waiting', reason: `等待依赖任务 ${dependency.delegation?.taskId ?? id} 成功并通过验收。` };
    if (dependency.status !== 'completed')
      return {
        state: 'blocked',
        code: 'dependency-failed',
        dependencyId: id,
        reason: `依赖任务 ${dependency.delegation?.taskId ?? id} 未完成（${dependency.status}）。`,
        recoveryCondition: '先解决该依赖的失败条件并完成依赖，再重新安排下游任务。',
      };
    if (
      dependency.executionWorkspaceId &&
      !dependency.inheritedExecutionWorkspace &&
      (dependency.executionDeliveryWorkflowId !== dependency.id ||
        !dependency.executionWorkspace?.delivery ||
        !['applied', 'unchanged'].includes(dependency.executionWorkspace.delivery.status))
    ) {
      if (
        dependency.delegation?.outOfScope?.length ||
        ['conflict', 'blocked', 'recovery-required'].includes(dependency.executionWorkspace?.delivery?.status ?? '')
      )
        return {
          state: 'blocked',
          code: 'dependency-unverified',
          dependencyId: id,
          reason: '依赖任务的文件尚未成功交付。',
          recoveryCondition: '核对并恢复文件交付后重新安排下游任务。',
        };
      return {
        state: 'waiting',
        reason: `等待依赖任务 ${dependency.delegation?.taskId ?? id} 的文件实际交付到父任务目录。`,
      };
    }
    const runs = dependency.runIds.map(getRun).filter((run): run is RunRecord => !!run && !run.visualAssistant);
    const run = runs.at(-1);
    if (
      !run ||
      run.status !== 'completed' ||
      (run.taskOutcome && run.taskOutcome.status !== 'completed') ||
      (run.verification && run.verification.status !== 'passed') ||
      (run.verification?.receipt &&
        ((run.verification.receipt.snapshot && !run.verification.receipt.stable) ||
          (run.verification.receipt.reused &&
            (!run.verification.receipt.snapshot || !run.verification.receipt.stable)) ||
          run.verification.receipt.source !== 'host-verification' ||
          run.verification.receipt.scope.command !== run.verification.command)) ||
      (dependency.delegation?.acceptance &&
        (run.verification?.status !== 'passed' ||
          run.verification.exitCode !== 0 ||
          (dependency.delegation.acceptance.command &&
            run.verification.command !== dependency.delegation.acceptance.command)))
    )
      return {
        state: 'blocked',
        code: 'dependency-unverified',
        dependencyId: id,
        reason: `依赖任务 ${dependency.delegation?.taskId ?? id} 缺少宿主确认的完成或验收证据。`,
        recoveryCondition: '补齐宿主通过的验收记录；partial、unverified 和 skipped 均不能释放依赖。',
      };
  }
  // Legacy host verifier records have no receipt; their passed status remains valid for dependency admission.
  return { state: 'ready' };
}
