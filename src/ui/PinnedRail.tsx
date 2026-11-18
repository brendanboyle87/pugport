import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Pin, PinOff } from 'lucide-react';
import {
  pinAgeLabel,
  pinnedMessageCard,
  pinnedMessageStatus,
  pinRailLayout,
  pinsNewestFirst,
} from '../shared/pinned-messages';
import type { BackgroundTask, ConversationMessage, ConversationMessagePin, Workflow } from '../shared/types';

/**
 * Free space left of the message column, measured from the real layout (window size, side panes, list width), so
 * the rail only appears when it does not cover the conversation.
 */
export function useMessageGutter(scrollRef: RefObject<HTMLElement | null>, key: unknown) {
  const [gutter, setGutter] = useState(0);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return setGutter(0);
    const measure = () => {
      const list = scroller.querySelector<HTMLElement>('.message-list');
      const outer = scroller.getBoundingClientRect();
      if (!list) return setGutter(0);
      const padding = parseFloat(getComputedStyle(list).paddingLeft) || 0;
      setGutter(Math.round(list.getBoundingClientRect().left + padding - outer.left));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const list = scroller.querySelector('.message-list');
    if (list) observer.observe(list);
    return () => observer.disconnect();
  }, [scrollRef, key]);
  return gutter;
}

/** Cards in the empty left gutter. Opening one never moves the history; the window shows the message instead. */
export function PinnedRail({
  pins,
  messages,
  workflows,
  backgroundTasks = [],
  gutter,
  incognito,
  openId,
  recentId,
  lastId,
  pending,
  onOpen,
  onUnpin,
}: {
  pins: readonly ConversationMessagePin[];
  messages: readonly ConversationMessage[];
  workflows: readonly Workflow[];
  backgroundTasks?: readonly BackgroundTask[];
  gutter: number;
  incognito?: boolean;
  openId?: string;
  /** Just minimized: looks selected for a moment so the eye finds where it went. */
  recentId?: string;
  lastId?: string;
  pending: boolean;
  onOpen: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const layout = pinRailLayout(gutter, pins.length);
  const focus = openId ?? lastId;
  useEffect(() => {
    // Keep the open or last opened row in view by scrolling the list itself, never an outer scroller.
    const box = list.current;
    const row = focus && box?.querySelector<HTMLElement>(`[data-pin-id="${CSS.escape(focus)}"]`);
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [focus, layout.compact]);
  if (!layout.rail) return null;
  const messageById = new Map(messages.map((message) => [message.id, message]));
  return (
    <nav
      className={`pinned-rail${layout.compact ? ' compact' : ''}`}
      style={{ width: layout.width }}
      aria-label="置顶消息"
    >
      {layout.compact && (
        <div className="pinned-rail-header">
          <Pin size={12} aria-hidden="true" />
          置顶 {pins.length}
        </div>
      )}
      <ul ref={list} className="pinned-rail-list">
        {pinsNewestFirst(pins).map((pin) => {
          const message = messageById.get(pin.messageId);
          const card = pinnedMessageCard(pin, message, incognito);
          const status = pinnedMessageStatus(pin, message, workflows, backgroundTasks);
          const task = status.source === 'auto';
          const title = card.title || (message ? '附件消息' : '原消息不可用');
          const state = [
            openId === pin.messageId ? 'selected' : '',
            recentId === pin.messageId ? 'recent' : '',
            card.pending ? 'pending' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={pin.messageId} data-pin-id={pin.messageId} className={`pinned-card ${state}`}>
              <button
                type="button"
                className="pinned-card-open"
                aria-pressed={openId === pin.messageId}
                title={layout.compact ? `${title}\n${card.description}` : undefined}
                onClick={() => onOpen(pin.messageId)}
              >
                <span className="pinned-card-title" translate={card.title ? 'no' : undefined}>
                  {layout.compact && (
                    <i className={`pinned-card-dot ${task ? status.tone : 'none'}`} aria-hidden="true" />
                  )}
                  <span className="pinned-card-text">{title}</span>
                </span>
                {!layout.compact && (
                  <>
                    {card.description &&
                      (card.pending ? (
                        <span className="pinned-card-description">{card.description}</span>
                      ) : (
                        <span className="pinned-card-description" translate="no">
                          {card.description}
                        </span>
                      ))}
                    <span className="pinned-card-meta">
                      <span>{message?.role === 'user' ? '我的消息' : '回答'}</span>
                      <span>{pinAgeLabel(message?.createdAt ?? pin.pinnedAt)}</span>
                      {task && (
                        <span className={`pinned-card-status ${status.tone}`}>
                          <i className={`pinned-card-dot ${status.tone}`} aria-hidden="true" />
                          {status.label}
                        </span>
                      )}
                    </span>
                  </>
                )}
              </button>
              <button
                type="button"
                className="icon-button pinned-card-unpin"
                aria-label="取消置顶"
                title="取消置顶"
                disabled={pending}
                onClick={() => onUnpin(pin.messageId)}
              >
                <PinOff size={12} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
