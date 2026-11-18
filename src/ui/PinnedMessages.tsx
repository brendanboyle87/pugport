import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown, Pin, PinOff, RefreshCw } from 'lucide-react';
import { pinnedMessageCard, pinnedMessageStatus, pinnedMessageWorkflow } from '../shared/pinned-messages';
import type { BackgroundTask, ConversationMessage, ConversationMessagePin, Workflow } from '../shared/types';

export type PinUpdate = {
  pinned?: boolean;
  tracking?: 'task' | 'follow-up';
  followUpStatus?: 'todo' | 'waiting' | 'done';
};

/** The pin's summary title (or its extract); the two fallbacks are interface text. */
function preview(pin: ConversationMessagePin, message: ConversationMessage | undefined, incognito?: boolean) {
  const title = pinnedMessageCard(pin, message, incognito).title;
  return { text: title || (message ? '附件消息' : '原消息不可用'), translate: title ? ('no' as const) : undefined };
}

/** Outside the history scroller: summaries stay visible without changing the saved message order. */
export function PinnedMessages({
  conversationId,
  pins,
  messages,
  workflows,
  backgroundTasks = [],
  pending,
  incognito,
  onUpdate,
  onOpen,
  onTask,
  onRefresh,
}: {
  conversationId: string;
  pins: readonly ConversationMessagePin[];
  messages: readonly ConversationMessage[];
  workflows: readonly Workflow[];
  backgroundTasks?: readonly BackgroundTask[];
  pending: boolean;
  incognito?: boolean;
  onUpdate: (messageId: string, update: PinUpdate) => void;
  /** Opens the pinned message window; the history keeps its place. */
  onOpen: (messageId: string) => void;
  onTask: (workflowId: string) => void;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [conversationId]);
  if (!pins.length) return null;
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const first = pins[0];
  const firstMessage = messageById.get(first.messageId);
  const firstStatus = pinnedMessageStatus(first, firstMessage, workflows, backgroundTasks);
  const firstPreview = preview(first, firstMessage, incognito);
  return (
    <section className="pinned-messages" aria-label="置顶消息">
      <div className="pinned-messages-summary">
        <button
          type="button"
          className="pinned-messages-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? '收起置顶消息' : `展开 ${pins.length} 条置顶消息`}
          onClick={() => setExpanded(!expanded)}
        >
          <Pin size={14} aria-hidden="true" />
          <strong>置顶 {pins.length}</strong>
          <ChevronDown size={13} className={expanded ? 'expanded' : ''} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pinned-message-preview"
          title={firstPreview.text}
          translate={firstPreview.translate}
          onClick={() => onOpen(first.messageId)}
        >
          {firstPreview.text}
        </button>
        <span className={`pinned-message-status ${firstStatus.tone}`} aria-live="polite">
          {firstStatus.source === 'manual' ? '跟进 · ' : ''}
          {firstStatus.label}
        </span>
        <button
          type="button"
          className="icon-button pinned-refresh"
          aria-label="刷新置顶状态"
          title="读取最新本地状态"
          disabled={pending}
          onClick={onRefresh}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <ul className="pinned-messages-list">
          {pins.map((pin) => {
            const message = messageById.get(pin.messageId);
            const status = pinnedMessageStatus(pin, message, workflows, backgroundTasks);
            const workflow = message && pinnedMessageWorkflow(message, workflows);
            const shown = preview(pin, message, incognito);
            return (
              <li key={pin.messageId} className="pinned-message-row">
                <div className="pinned-message-main">
                  <button
                    type="button"
                    className="pinned-message-preview"
                    title={shown.text}
                    translate={shown.translate}
                    onClick={() => onOpen(pin.messageId)}
                  >
                    {shown.text}
                  </button>
                  <span className={`pinned-message-status ${status.tone}`} aria-live="polite">
                    {status.label}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="取消置顶"
                    title="取消置顶"
                    disabled={pending}
                    onClick={() => onUpdate(pin.messageId, { pinned: false })}
                  >
                    <PinOff size={13} aria-hidden="true" />
                  </button>
                </div>
                <div className="pinned-message-controls">
                  <small>{status.source === 'manual' ? '手动跟进' : '任务状态'}</small>
                  {status.source === 'manual' && message && (
                    <select
                      aria-label="跟进状态"
                      value={pin.followUpStatus ?? 'todo'}
                      disabled={pending}
                      onChange={(event) =>
                        onUpdate(pin.messageId, {
                          tracking: 'follow-up',
                          followUpStatus: event.target.value as 'todo' | 'waiting' | 'done',
                        })
                      }
                    >
                      <option value="todo">待跟进</option>
                      <option value="waiting">等待确认</option>
                      <option value="done">已完成</option>
                    </select>
                  )}
                  {workflow && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        onUpdate(pin.messageId, {
                          tracking: status.source === 'manual' ? 'task' : 'follow-up',
                        })
                      }
                    >
                      {status.source === 'manual' ? '追踪执行任务' : '改为跟进记录'}
                    </button>
                  )}
                  {status.workflowId && (
                    <button type="button" onClick={() => onTask(status.workflowId!)}>
                      查看任务 <ArrowUpRight size={11} aria-hidden="true" />
                    </button>
                  )}
                  {status.backgroundTask && (
                    <span className="pinned-background-progress">
                      {status.detail}
                      {status.backgroundTask.total > 0
                        ? ` · ${status.backgroundTask.done.toLocaleString()} / ${status.backgroundTask.total.toLocaleString()}`
                        : ''}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
