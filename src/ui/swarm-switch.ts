import type { Workflow } from '../shared/types';
import { isActiveWorkflow } from './queue-utils';
import { confirmDialog } from './confirm-dialog';
import type { Confirmation } from '../shared/confirmation';

type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

/** Swarm tasks of this conversation that are still working or waiting to start. */
export function runningSwarmMembers(workflows: readonly Workflow[] | undefined, conversationId: string): Workflow[] {
  return (workflows ?? []).filter(
    (workflow) =>
      workflow.conversationId === conversationId &&
      workflow.input.swarm &&
      !workflow.deletedAt &&
      isActiveWorkflow(workflow),
  );
}

/**
 * Turning swarm mode off only changes new messages; members already at work keep going and keep using quota.
 * So ask once whether to stop them as well, then switch the mode off. Returns the notice to show.
 */
export async function leaveSwarm(
  api: Api,
  conversationId: string,
  workflows: readonly Workflow[] | undefined,
  ask: (options: Confirmation) => boolean | Promise<boolean> = confirmDialog,
): Promise<string> {
  const running = runningSwarmMembers(workflows, conversationId);
  const stop =
    running.length > 0 &&
    (await ask({
      title: '关闭蜂群模式？',
      summary: `还有 ${running.length} 个蜂群成员在跑。`,
      points: ['停止成员后关闭蜂群模式。', '点取消则只关闭蜂群模式，让成员继续做完（仍会使用额度）。'],
      action: '停止成员并关闭',
      tone: 'danger',
    }));
  if (stop) {
    const ids = new Set(running.map((workflow) => workflow.id));
    // Stopping a task also stops the members it recruited, so only the top-most ones need a request.
    for (const workflow of running.filter((item) => !item.delegation || !ids.has(item.delegation.parentId)))
      await api(`/api/workflows/${encodeURIComponent(workflow.id)}/cancel`, {}).catch(() => undefined);
  }
  await api(`/api/conversations/${encodeURIComponent(conversationId)}`, { swarm: false }, 'PATCH');
  if (!running.length) return '已关闭蜂群模式。';
  return stop
    ? `已关闭蜂群模式，正在跑的 ${running.length} 个成员已停下。`
    : `已关闭蜂群模式；还在跑的 ${running.length} 个成员会继续做完。`;
}
