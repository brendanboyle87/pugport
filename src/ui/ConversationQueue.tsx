import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { AppState, Conversation, Workflow } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { conversationQueuedMessages } from './message-queue';
import { queuedSteeringRun, steerQueuedWorkflow } from './composer-steering';
import { ContextMenu, type MenuItem } from './DesktopFeatures';

export { conversationQueuedMessages, isMessageQueueItem } from './message-queue';

export function moveQueuedMessage(
  ids: string[],
  movedId: string,
  targetId: string,
  side: 'before' | 'after',
): string[] {
  if (movedId === targetId || !ids.includes(movedId) || !ids.includes(targetId)) return [...ids];
  const reordered = ids.filter((id) => id !== movedId);
  const index = reordered.indexOf(targetId) + Number(side === 'after');
  reordered.splice(index, 0, movedId);
  return reordered;
}

export async function reorderConversationQueue(api: Api, conversationId: string, workflowIds: string[]): Promise<void> {
  await api(`/api/conversations/${encodeURIComponent(conversationId)}/queue/order`, { workflowIds }, 'POST');
}

export async function editQueuedMessage(api: Api, workflowId: string, content: string): Promise<void> {
  if (!content.trim()) throw new Error('排队消息不能为空。');
  await api(`/api/workflows/${encodeURIComponent(workflowId)}/input`, { content: content.trim() }, 'PATCH');
}

export async function deleteQueuedMessage(api: Api, workflowId: string): Promise<void> {
  await api(`/api/workflows/${encodeURIComponent(workflowId)}/cancel`, {}, 'POST');
  await api(`/api/workflows/${encodeURIComponent(workflowId)}`, undefined, 'DELETE');
}

export async function setConversationQueueing(api: Api, conversationId: string, enabled: boolean): Promise<void> {
  await api(`/api/conversations/${encodeURIComponent(conversationId)}/queueing`, { enabled }, 'PATCH');
}

export function ConversationQueue({
  conversation,
  state,
  api,
  notify,
  onSideChat,
  onBusyChange,
  externalPending = false,
  representedHeadId,
}: {
  conversation: Conversation;
  state: AppState;
  api: Api;
  notify: (notice: Notice) => void;
  onSideChat?: (workflow: Workflow) => void;
  onBusyChange?: (busy: boolean) => void;
  externalPending?: boolean;
  representedHeadId?: string;
}) {
  const queued = conversationQueuedMessages(state.workflows ?? [], conversation.id);
  const sourceIds = queued.map((workflow) => workflow.id);
  const [optimisticOrder, setOptimisticOrder] = useState<string[]>();
  const optimisticOrderRef = useRef<string[] | undefined>(undefined);
  const [editingId, setEditingId] = useState<string>();
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const busy = pending || externalPending;
  const busyRef = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const [draggingId, setDraggingId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' }>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLButtonElement }>();
  const menuFocus = useRef<HTMLButtonElement | undefined>(undefined);
  useEffect(() => {
    // Reordering disables the trigger until its request settles; focus it only after it is enabled again.
    if (!menu && !busy) {
      menuFocus.current?.focus();
      menuFocus.current = undefined;
    }
  }, [menu, busy]);
  const queueingEnabled = conversation.queueingEnabled !== false;
  useEffect(() => {
    if (
      optimisticOrder &&
      (sourceIds.join('|') === optimisticOrder.join('|') ||
        sourceIds.length !== optimisticOrder.length ||
        sourceIds.some((id) => !optimisticOrder.includes(id)))
    ) {
      optimisticOrderRef.current = undefined;
      setOptimisticOrder(undefined);
      busyCallback.current?.(busyRef.current);
    }
  }, [sourceIds.join('|'), optimisticOrder]);
  useEffect(() => () => busyCallback.current?.(false), []);
  const ordered = optimisticOrder
    ? [...queued].sort((left, right) => optimisticOrder.indexOf(left.id) - optimisticOrder.indexOf(right.id))
    : queued;
  const hiddenHeadId =
    queued[0]?.id === representedHeadId && ['pending', 'wait'].includes(queued[0]?.machineLoadChoice ?? '')
      ? representedHeadId
      : undefined;
  const items = ordered.filter((workflow) => workflow.id !== hiddenHeadId);
  const menuIndex = items.findIndex((workflow) => workflow.id === menu?.id);
  const menuWorkflow = items[menuIndex];
  const menuItems: MenuItem[] = menuWorkflow
    ? [
        {
          label: '编辑',
          icon: <Pencil size={12} />,
          disabled: busy || Boolean(editingId),
          onSelect: () => {
            setEditingId(menuWorkflow.id);
            setContent(menuWorkflow.input.content);
          },
        },
        {
          label: '在侧边对话打开',
          disabled: busy || !onSideChat || Boolean(editingId),
          onSelect: () => onSideChat?.(menuWorkflow),
        },
        {
          label: '上移',
          icon: <ArrowUp size={12} />,
          disabled: busy || Boolean(editingId) || menuIndex === 0,
          onSelect: () => reorder(menuWorkflow.id, items[menuIndex - 1]!.id, 'before'),
        },
        {
          label: '下移',
          icon: <ArrowDown size={12} />,
          disabled: busy || Boolean(editingId) || menuIndex === items.length - 1,
          onSelect: () => reorder(menuWorkflow.id, items[menuIndex + 1]!.id, 'after'),
        },
        {
          label: '移出队列',
          icon: <Trash2 size={12} />,
          danger: true,
          disabled: busy || Boolean(editingId),
          onSelect: () =>
            void action(() => deleteQueuedMessage(api, menuWorkflow.id), '排队任务已移除，消息与执行记录保留。'),
        },
      ]
    : [];

  async function action(operation: () => Promise<void>, success: string) {
    if (busyRef.current || externalPending) return;
    busyRef.current = true;
    busyCallback.current?.(true);
    setPending(true);
    try {
      await operation();
      if (success) notify({ tone: 'success', message: success });
    } catch (error) {
      setOptimisticOrder(undefined);
      optimisticOrderRef.current = undefined;
      notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      busyCallback.current?.(Boolean(optimisticOrderRef.current));
      setPending(false);
    }
  }

  function reorder(movedId: string, targetId: string, side: 'before' | 'after') {
    if (busyRef.current || externalPending || editingId) return;
    // The endpoint validates the whole queue, including the head displayed in the timeline.
    const ids = ordered.map((workflow) => workflow.id);
    const changed = moveQueuedMessage(ids, movedId, targetId, side);
    setDraggingId(undefined);
    setDropTarget(undefined);
    if (ids.join('|') === changed.join('|')) return;
    optimisticOrderRef.current = changed;
    setOptimisticOrder(changed);
    void action(() => reorderConversationQueue(api, conversation.id, changed), '排队顺序已更新。');
  }

  if (!items.length && queueingEnabled) return null;
  return (
    <section className="conversation-queue" aria-label="等待发送的消息">
      {items.length > 0 && (
        <div className="conversation-queue-heading">
          <strong>消息队列 · {items.length}</strong>
        </div>
      )}
      {!queueingEnabled && (
        <p className="conversation-queue-hint">
          排队已关闭；当前任务暂不能接收插话时，输入会保留。
          <button
            type="button"
            className="button tiny quiet"
            disabled={busy}
            onClick={() => void action(() => setConversationQueueing(api, conversation.id, true), '已开启消息排队。')}
          >
            开启排队
          </button>
        </p>
      )}
      {items.length > 1 && <p className="conversation-queue-hint">拖动消息可改变发送顺序。</p>}
      <ol className="conversation-queue-list">
        {items.map((workflow, index) => (
          <li
            key={workflow.id}
            className={`conversation-queue-message ${dropTarget?.id === workflow.id ? `drop-${dropTarget.side}` : ''}`}
            data-workflow-id={workflow.id}
            onDragOver={(event) => {
              if (!draggingId || busy || editingId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const rect = event.currentTarget.getBoundingClientRect();
              setDropTarget({ id: workflow.id, side: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' });
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggingId && dropTarget?.id === workflow.id) reorder(draggingId, workflow.id, dropTarget.side);
            }}
          >
            <button
              type="button"
              className="conversation-queue-grip icon-button"
              draggable={!busy && !editingId}
              disabled={busy || Boolean(editingId)}
              aria-label={`拖动第 ${index + 1} 条排队消息`}
              onDragStart={(event) => {
                setDraggingId(workflow.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', workflow.id);
              }}
              onDragEnd={() => {
                setDraggingId(undefined);
                setDropTarget(undefined);
              }}
            >
              <GripVertical size={14} />
            </button>
            <div className="conversation-queue-body">
              {editingId === workflow.id ? (
                <form
                  className="conversation-queue-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      await editQueuedMessage(api, workflow.id, content);
                      setEditingId(undefined);
                    }, '排队消息已更新。');
                  }}
                >
                  <textarea
                    aria-label="编辑排队消息"
                    autoFocus
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    disabled={busy}
                  />
                  <div className="conversation-queue-actions">
                    <button type="submit" className="button tiny" disabled={busy || !content.trim()}>
                      保存
                    </button>
                    <button
                      type="button"
                      className="button tiny quiet"
                      disabled={busy}
                      onClick={() => setEditingId(undefined)}
                    >
                      取消编辑
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="conversation-queue-copy">
                    <p className="conversation-queue-content" translate="no">
                      {workflow.input.content}
                    </p>
                    <span className="conversation-queue-status">
                      {workflow.pendingSteer ? '等待插入当前任务' : '等待发送'}
                    </span>
                  </div>
                  <div className="conversation-queue-actions">
                    {queuedSteeringRun(state, workflow) && (
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy || Boolean(editingId)}
                        aria-label="插入当前任务（steer）"
                        title="插入当前任务（steer）"
                        onClick={() =>
                          void action(() => steerQueuedWorkflow(api, workflow.id), '已插入当前任务，消息记录保留。')
                        }
                      >
                        {busy ? <Loader2 size={12} className="spinning" /> : <ArrowUp size={12} />}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy || Boolean(editingId)}
                      aria-label="更多操作"
                      title="更多操作"
                      aria-haspopup="menu"
                      aria-expanded={menu?.id === workflow.id}
                      onMouseDown={(event) => {
                        if (menu?.id === workflow.id) event.stopPropagation();
                      }}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu(
                          menu?.id === workflow.id
                            ? undefined
                            : { id: workflow.id, x: rect.left, y: rect.bottom, trigger: event.currentTarget },
                        );
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {menu && menuWorkflow && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => {
            menuFocus.current = menu.trigger;
            setMenu(undefined);
          }}
        />
      )}
    </section>
  );
}
