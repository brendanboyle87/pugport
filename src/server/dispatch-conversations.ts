import type { CallerContext } from '../shared/caller-signals.ts';
import type { Conversation, Workflow } from '../shared/types.ts';
import type { CallerCeiling } from './caller-ceiling.ts';
import type { WorkspaceStore } from './workspace-store.ts';

/** Ownership and collection metadata stay separate from the conversation itself. */
export type ExternalConversation = {
  caller?: string;
  context?: CallerContext;
  ceiling?: CallerCeiling;
  deviceId?: string;
  deviceFolder?: string;
  write?: boolean;
  dispatched?: true;
  collectedTaskId?: string;
  collectedAt?: string;
};

export const settled = new Set<Workflow['status']>(['completed', 'blocked', 'failed', 'cancelled', 'interrupted']);

/** Owner-created lanes and jobs claim their root even when archived or disabled. */
export function dispatchConversationIds(store: WorkspaceStore, visible: Conversation[]) {
  const marked = new Set(
    (
      store.db
        .prepare(
          "SELECT id FROM workspace_records WHERE kind='external-conversation' AND json_extract(value,'$.dispatched')=1",
        )
        .all() as { id: string }[]
    ).map(({ id }) => id),
  );
  const humans = new Set(
    (
      store.db.prepare("SELECT DISTINCT owner AS id FROM workspace_records WHERE kind='human-message'").all() as {
        id: string;
      }[]
    ).map(({ id }) => id),
  );
  const claimed = new Set(
    (
      store.db
        .prepare(
          `SELECT owner AS id FROM workspace_records WHERE kind='conversation-job'
      UNION SELECT json_extract(value,'$.lane.parentConversationId') AS id FROM workspace_records
      WHERE kind='conversation' AND json_extract(value,'$.lane.parentConversationId') IS NOT NULL`,
        )
        .all() as { id: string }[]
    ).map(({ id }) => id),
  );
  return visible
    .filter(
      (conversation) =>
        !conversation.lane &&
        marked.has(conversation.id) &&
        !humans.has(conversation.id) &&
        !claimed.has(conversation.id),
    )
    .map(({ id }) => id);
}

export function noteCollected(store: WorkspaceStore, workflow: Workflow, at: string) {
  const owner = store.get<ExternalConversation>('external-conversation', workflow.conversationId);
  if (!owner?.dispatched) return false;
  store.save('external-conversation', workflow.conversationId, workflow.conversationId, {
    ...owner,
    collectedTaskId: workflow.id,
    collectedAt: at,
  });
  return true;
}

export function dispatchReadyToArchive(store: WorkspaceStore, conversation: Conversation, now: string) {
  if (
    conversation.archivedAt ||
    conversation.deletedAt ||
    conversation.incognito ||
    conversation.sideChat ||
    conversation.lane
  )
    return false;
  const owner = store.get<ExternalConversation>('external-conversation', conversation.id);
  if (!owner?.dispatched || store.list('human-message', conversation.id, 1).length) return false;
  if (
    store.db
      .prepare(
        "SELECT 1 FROM workspace_records WHERE kind='conversation' AND json_extract(value,'$.lane.parentConversationId')=? LIMIT 1",
      )
      .get(conversation.id)
  )
    return false;
  if (store.conversationBusy(conversation.id) || store.list('conversation-job', conversation.id, 1).length)
    return false;
  const workflows = store.conversationWorkflows(conversation.id).filter((workflow) => !workflow.deletedAt);
  if (workflows.some((workflow) => workflow.waitingOn || workflow.pendingSteer)) return false;
  const latest = workflows
    .filter((workflow) => !workflow.delegation)
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest || !settled.has(latest.status)) return false;
  const lastUpdate = Math.max(...workflows.map((workflow) => Date.parse(workflow.updatedAt)));
  return owner.collectedTaskId === latest.id || Date.parse(now) - lastUpdate >= 7 * 86400000;
}
