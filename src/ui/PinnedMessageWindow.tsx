import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ArrowUpRight, Check, Copy, Crosshair, Minus, PinOff, RefreshCw, X } from 'lucide-react';
import { pinnedMessageCard, pinnedMessageStatus, pinnedMessageWorkflow } from '../shared/pinned-messages';
import type { BackgroundTask, ConversationMessage, ConversationMessagePin, Workflow } from '../shared/types';
import type { PinUpdate } from './PinnedMessages';

type Box = { x: number; y: number; width: number; height: number };
const storageKey = 'pugport.pinnedWindow';
const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const MARGIN = 12;

function savedBox(): Partial<Box> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<Box>;
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item)),
    ) as Partial<Box>;
  } catch {
    return {};
  }
}
function saveBox(box: Box) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(box));
  } catch {
    // Storage may be full or blocked; the window still works at its default place.
  }
}

/** Keeps the window inside the conversation area whatever was saved or however the area shrank. */
export function fitPinnedWindow(box: Box, area: { width: number; height: number }): Box {
  const width = Math.max(Math.min(box.width, area.width - MARGIN * 2), Math.min(MIN_WIDTH, area.width));
  const height = Math.max(Math.min(box.height, area.height - MARGIN * 2), Math.min(MIN_HEIGHT, area.height));
  return {
    width,
    height,
    x: Math.min(Math.max(box.x, 0), Math.max(0, area.width - width)),
    y: Math.min(Math.max(box.y, 0), Math.max(0, area.height - height)),
  };
}

/**
 * One floating, non-modal window over the conversation. Opening, moving or closing it never scrolls the history;
 * only 「在对话中定位」 does, on request.
 */
export function PinnedMessageWindow({
  pin,
  message,
  workflows,
  backgroundTasks = [],
  incognito,
  anchorX,
  pending,
  body,
  onMinimize,
  onClose,
  onLocate,
  onUpdate,
  onTask,
  onRefresh,
}: {
  pin: ConversationMessagePin;
  message: ConversationMessage | undefined;
  workflows: readonly Workflow[];
  backgroundTasks?: readonly BackgroundTask[];
  incognito?: boolean;
  /** Default left edge: just right of the rail, or centred when there is none. */
  anchorX?: number;
  pending: boolean;
  /** The message rendered exactly as in the chat (Markdown and attachments). */
  body: ReactNode;
  onMinimize: () => void;
  onClose: () => void;
  onLocate: () => void;
  onUpdate: (update: PinUpdate) => void;
  onTask: (workflowId: string) => void;
  onRefresh: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState<Partial<Box>>(savedBox);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setArea({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [pin.messageId]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const width = box.width ?? 560;
  const placed = fitPinnedWindow(
    {
      width,
      height: box.height ?? Math.round(window.innerHeight * 0.7),
      x: box.x ?? anchorX ?? (area.width - width) / 2,
      y: box.y ?? 16,
    },
    area,
  );
  function drag(event: ReactPointerEvent, mode: 'move' | 'resize') {
    if (event.button !== 0 || (mode === 'move' && (event.target as Element).closest('button'))) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, box: placed };
    const target = event.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the drag still follows moves over the handle.
    }
    let last = placed;
    const move = (next: PointerEvent) => {
      const dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      last = fitPinnedWindow(
        mode === 'move'
          ? { ...start.box, x: start.box.x + dx, y: start.box.y + dy }
          : { ...start.box, width: start.box.width + dx, height: start.box.height + dy },
        area,
      );
      setBox(last);
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      saveBox(last);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
  const card = pinnedMessageCard(pin, message, incognito);
  const title = card.title || (message ? '附件消息' : '原消息不可用');
  const status = pinnedMessageStatus(pin, message, workflows, backgroundTasks);
  const workflow = message && pinnedMessageWorkflow(message, workflows);
  return (
    <section
      ref={ref}
      className="pinned-window"
      role="dialog"
      aria-modal="false"
      aria-label={title}
      tabIndex={-1}
      style={{ left: placed.x, top: placed.y, width: placed.width, height: placed.height }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onMinimize();
      }}
    >
      <header className="pinned-window-header" onPointerDown={(event) => drag(event, 'move')}>
        <strong translate={card.title ? 'no' : undefined}>{title}</strong>
        <button type="button" className="icon-button" aria-label="缩小" title="缩小" onClick={onMinimize}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="pinned-window-meta">
        <span className={`pinned-message-status ${status.tone}`} aria-live="polite">
          {status.source === 'manual' ? '跟进 · ' : ''}
          {status.label}
        </span>
        {status.source === 'manual' && message && (
          <select
            aria-label="跟进状态"
            value={pin.followUpStatus ?? 'todo'}
            disabled={pending}
            onChange={(event) =>
              onUpdate({ tracking: 'follow-up', followUpStatus: event.target.value as 'todo' | 'waiting' | 'done' })
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
            onClick={() => onUpdate({ tracking: status.source === 'manual' ? 'task' : 'follow-up' })}
          >
            {status.source === 'manual' ? '追踪执行任务' : '改为跟进记录'}
          </button>
        )}
        {status.workflowId && (
          <button type="button" onClick={() => onTask(status.workflowId!)}>
            查看任务 <ArrowUpRight size={11} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="icon-button pinned-refresh"
          aria-label="刷新置顶状态"
          title="读取最新本地状态"
          disabled={pending}
          onClick={onRefresh}
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="pinned-window-body">
        {message ? body : <p className="pinned-window-missing">原消息暂未载入，请刷新置顶状态。</p>}
      </div>
      <footer className="pinned-window-footer">
        <button type="button" disabled={!message} onClick={onLocate}>
          <Crosshair size={13} aria-hidden="true" />
          在对话中定位
        </button>
        <button
          type="button"
          disabled={!message?.content}
          onClick={() => {
            if (!message?.content) return;
            void navigator.clipboard
              ?.writeText(message.content)
              .then(() => {
                setCopied(true);
                clearTimeout(copiedTimer.current);
                copiedTimer.current = setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? '已复制' : '复制'}
        </button>
        <button type="button" disabled={pending} onClick={() => onUpdate({ pinned: false })}>
          <PinOff size={13} aria-hidden="true" />
          取消置顶
        </button>
      </footer>
      <span className="pinned-window-resize" aria-hidden="true" onPointerDown={(event) => drag(event, 'resize')} />
    </section>
  );
}
