import type { Conversation } from '../shared/types';
import type { ConversationModeView } from '../shared/conversation-modes';
import type { Api, Notice, Notify } from './Workspace';
import { friendlyModError } from './mod-errors';

/** Detach and undo use the binding barrier; neither operation deletes saved instances. */
export async function removeConversationMod(
  api: Api,
  conversation: Conversation,
  notify: Notify,
  reload: () => Promise<void>,
  alive: () => boolean,
) {
  const binding = conversation.pendingModeBinding ? conversation.pendingModeBinding.binding : conversation.modeBinding;
  if (!binding) return;
  const path = `/api/conversations/${encodeURIComponent(conversation.id)}/mode`;
  const view = await api<ConversationModeView>(path, { modeId: null, expectedInstanceId: binding.instanceId }, 'PUT');
  if (!alive()) return;
  let undoing = false;
  let restored = false;
  const notice: Notice = {
    tone: 'success',
    message: view.pending ? '当前任务结束后会移除此对话的 Mod。' : 'Mod 已移除',
    action: {
      label: '撤销',
      run: async () => {
        if (undoing || restored || !alive()) return;
        undoing = true;
        try {
          await api(
            path,
            {
              modeId: binding.modeId,
              version: binding.version,
              restoreInstanceId: binding.instanceId,
              restoreFromInstanceId: view.binding?.instanceId ?? null,
            },
            'PUT',
          );
          restored = true;
          if (!alive()) return;
          notify({ tone: 'success', message: 'Mod 已恢复' });
          await reload();
        } catch (error) {
          if (alive()) notify({ tone: 'error', message: friendlyModError(error).text });
        } finally {
          undoing = false;
        }
      },
    },
  };
  notify(notice);
  try {
    await reload();
  } catch {
    if (alive() && !restored)
      notify({ ...notice, tone: 'error', message: 'Mod 已移除，但列表刷新失败。可撤销或刷新重试。' });
  }
}
