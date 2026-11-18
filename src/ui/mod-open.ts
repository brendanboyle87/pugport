import type { Conversation } from '../shared/types';
import { canAttachMod, type ConversationModeView } from '../shared/conversation-modes';
import type { Api } from './Workspace';

/** Old bindings use instance creation time; new attachments record order without changing saved instances. */
export async function openModConversation(
  api: Api,
  conversations: readonly Conversation[],
  mode: { id: string; version: string; title: string },
  current: () => boolean = () => true,
): Promise<Conversation | undefined> {
  const candidates = conversations.filter(
    (item) =>
      canAttachMod(item) &&
      !item.incognito &&
      !item.removedWithProject &&
      item.modeBinding?.modeId === mode.id &&
      !item.pendingModeBinding,
  );
  let target: Conversation | undefined;
  let attachedAt = '';
  for (const candidate of candidates) {
    if (!current()) return;
    const view = await api<ConversationModeView>(
      `/api/conversations/${encodeURIComponent(candidate.id)}/mode`,
      undefined,
      'GET',
    );
    const at = view.binding?.attachedAt ?? view.instance?.createdAt ?? '';
    if (view.installed && view.binding?.modeId === mode.id && view.instance && !view.pending && at > attachedAt) {
      attachedAt = at;
      target = { ...candidate, modeBinding: view.binding };
    }
  }
  if (!current()) return;
  if (!target) {
    target = await api<Conversation>('/api/conversations', { title: mode.title });
    if (!current()) return;
    const view = await api<ConversationModeView>(
      `/api/conversations/${encodeURIComponent(target.id)}/mode`,
      {
        modeId: mode.id,
        version: mode.version,
      },
      'PUT',
    );
    target = { ...target, modeBinding: view.binding ?? undefined };
  }
  if (!current()) return;
  return api<Conversation>(
    `/api/conversations/${encodeURIComponent(target.id)}/mode/visibility`,
    { hidden: false, expectedInstanceId: target.modeBinding?.instanceId },
    'PUT',
  );
}
