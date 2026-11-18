import type { Workflow } from '../shared/types';

export type ReplyAttempts = { latest: Workflow; completed: Workflow[] };

/** Only explicit reruns share a reply slot; delegation and older continuation records keep their own rows. */
export function replyAttempts(workflows: readonly Workflow[]): Map<string, ReplyAttempts> {
  const groups = new Map<string, Workflow[]>();
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  // A bare 继续 (nothing added) answers the same message as the task it continues, so a later resend replaces it too.
  const anchor = (workflow: Workflow): Workflow => {
    const seen = new Set<string>();
    let current = workflow;
    while (current.parentWorkflowId && current.continuation && !current.continuation.supplements?.length) {
      const parent = byId.get(current.parentWorkflowId);
      if (!parent || seen.has(parent.id) || parent.conversationId !== current.conversationId) break;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  for (const workflow of workflows) {
    if (workflow.deletedAt || workflow.delegation) continue;
    const key = `${workflow.conversationId}:${anchor(workflow).userMessageId}`;
    const group = groups.get(key) ?? [];
    group.push(workflow);
    groups.set(key, group);
  }
  const result = new Map<string, ReplyAttempts>();
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((item) => item.supersededBy || (item.attempt ?? 1) > 1)) continue;
    group.sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1) || a.createdAt.localeCompare(b.createdAt));
    const ids = new Set(group.map((item) => item.id));
    const latest = group.filter((item) => !item.supersededBy || !ids.has(item.supersededBy)).at(-1) ?? group.at(-1)!;
    const value = { latest, completed: group.filter((item) => item.status === 'completed') };
    for (const item of group) result.set(item.id, value);
  }
  return result;
}

export function selectedReplyAttempt(group: ReplyAttempts, selections: Readonly<Record<string, string>>): Workflow {
  return group.completed.find((item) => item.id === selections[group.latest.id]) ?? group.latest;
}
