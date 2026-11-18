import { useEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquare, Quote } from 'lucide-react';
import { conversationSelection, type ConversationSelection } from './quotation';

export type SelectionActionsProps = {
  containerRef: RefObject<HTMLDivElement | null>;
  /** `at` is where the selection ends on screen, so the note box can open there. */
  onQuote: (text: string, anchorMessageId?: string, at?: { left: number; top: number }) => void;
  onSideChat?: (text: string, anchorMessageId?: string) => void;
};

export function SelectionActions({ containerRef, onQuote, onSideChat }: SelectionActionsProps) {
  const [selected, setSelected] = useState<ConversationSelection>();
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = (event: Event) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        setSelected(undefined);
        return;
      }
      const value = conversationSelection(container, container.ownerDocument.getSelection());
      setSelected(value);
    };
    const dismiss = () => setSelected(undefined);
    container.addEventListener('mouseup', update);
    container.addEventListener('keyup', update);
    container.addEventListener('scroll', dismiss, true);
    const outside = (event: MouseEvent) => {
      if (!container.contains(event.target as Node) && !toolbar.current?.contains(event.target as Node)) dismiss();
    };
    container.ownerDocument.addEventListener('mousedown', outside);
    const view = container.ownerDocument.defaultView;
    view?.addEventListener('resize', dismiss);
    view?.addEventListener('scroll', dismiss, true);
    return () => {
      container.removeEventListener('mouseup', update);
      container.removeEventListener('keyup', update);
      container.removeEventListener('scroll', dismiss, true);
      container.ownerDocument.removeEventListener('mousedown', outside);
      view?.removeEventListener('resize', dismiss);
      view?.removeEventListener('scroll', dismiss, true);
    };
  }, [containerRef]);

  if (!selected) return null;
  const view = containerRef.current?.ownerDocument.defaultView;
  // Stay inside the conversation area: below the selection's end, or above it when that would run into
  // the composer or off the bottom of the conversation.
  const bounds = containerRef.current?.getBoundingClientRect();
  const floor = Math.min(bounds?.bottom ?? view?.innerHeight ?? 800, (view?.innerHeight ?? 800) - 8);
  const left = Math.max(
    (bounds?.left ?? 0) + 80,
    Math.min(selected.left, (bounds?.right ?? view?.innerWidth ?? 1000) - 80),
  );
  const top =
    selected.top + 44 > floor && selected.above !== undefined
      ? Math.max((bounds?.top ?? 0) + 4, selected.above - 40)
      : Math.min(selected.top, floor - 44);
  function act(action: SelectionActionsProps['onQuote']) {
    if (!selected) return;
    action(selected.text, selected.anchorMessageId, { left: selected.left, top: selected.top });
    setSelected(undefined);
  }
  return (
    <div
      className="selection-actions"
      data-selection-actions="true"
      ref={toolbar}
      style={{ left, top }}
      role="toolbar"
      aria-label="选中文本操作"
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" onClick={() => act(onQuote)}>
        <Quote size={13} />
        引用
      </button>
      {onSideChat && (
        <button type="button" onClick={() => act(onSideChat)}>
          <MessageSquare size={13} />
          侧聊
        </button>
      )}
    </div>
  );
}
