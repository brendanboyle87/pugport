import { Fragment, useRef, useState, type DragEvent, type ReactNode } from 'react';

/*
 * Side-by-side conversations, like Chrome's split view: drag a conversation from the sidebar onto the left
 * or right part of a pane to open it beside that pane, or onto its middle to replace it. Up to four panes;
 * the dividers between panes can be dragged, and double-clicked to make all panes equal.
 */

export const conversationDragType = 'application/x-comborunner-conversation';
export const maxPanes = 4;
export type DropTarget = { index: number; mode: 'before' | 'after' | 'replace' };

/** The pane layout after dropping `id` at `target` (the id moves if it is already open). */
export function dropIntoPanes(ids: string[], id: string, target: DropTarget): string[] {
  const anchor = ids[target.index];
  const rest = ids.filter((value) => value !== id && value);
  let at = anchor && anchor !== id ? rest.indexOf(anchor) : Math.min(target.index, rest.length);
  if (at < 0) at = rest.length;
  if (target.mode === 'replace' || rest.length >= maxPanes) {
    const next = [...rest];
    next.splice(Math.min(at, next.length), anchor && anchor !== id ? 1 : 0, id);
    return next.slice(0, maxPanes);
  }
  const next = [...rest];
  next.splice(target.mode === 'after' ? at + 1 : at, 0, id);
  return next;
}

/** Moves the divider between pane `index` and `index + 1` by `delta` (in the same units as sizes). */
export function resizePanes(sizes: number[], index: number, delta: number, minimum = 0.12): number[] {
  const total = sizes.reduce((sum, value) => sum + value, 0);
  const floor = total * minimum;
  const pair = sizes[index]! + sizes[index + 1]!;
  const left = Math.max(floor, Math.min(pair - floor, sizes[index]! + delta));
  const next = [...sizes];
  next[index] = left;
  next[index + 1] = pair - left;
  return next;
}

const hasConversation = (event: DragEvent) => event.dataTransfer.types.includes(conversationDragType);

export function SplitView({
  ids,
  sizes,
  onSizes,
  onDrop,
  adoptedDraftId,
  children,
}: {
  ids: string[];
  sizes: number[];
  onSizes: (next: number[]) => void;
  onDrop: (id: string, target: DropTarget) => void;
  /** Only the first successful send may adopt the draft pane; ordinary navigation still resets its view. */
  adoptedDraftId?: string;
  children: (id: string, index: number) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previousPanes = useRef<Array<{ id: string; key: string }>>([]);
  const nextPaneKey = useRef(0);
  const consumedAdoption = useRef<string | undefined>(undefined);
  const keyedPanes = ids.map((id, index) => {
    const existing = previousPanes.current.find((pane) => pane.id === id)?.key;
    const adopting =
      id === adoptedDraftId && id !== consumedAdoption.current && previousPanes.current[index]?.id === '';
    if (id === adoptedDraftId) consumedAdoption.current = id;
    return { id, key: existing ?? (adopting ? previousPanes.current[index]!.key : `pane:${nextPaneKey.current++}`) };
  });
  previousPanes.current = keyedPanes;
  const [hint, setHint] = useState<DropTarget & { left: number; width: number }>();
  const panes = () => [...(root.current?.querySelectorAll<HTMLElement>(':scope > .split-pane') ?? [])];
  const targetAt = (x: number) => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return undefined;
    const rects = panes().map((pane) => pane.getBoundingClientRect());
    const index = Math.max(
      0,
      rects.findIndex((rect) => x < rect.right),
    );
    const rect = rects[index] ?? rects.at(-1);
    if (!rect) return undefined;
    const ratio = (x - rect.left) / rect.width;
    const full = ids.filter(Boolean).length >= maxPanes;
    const mode: DropTarget['mode'] =
      full || (ratio >= 0.3 && ratio <= 0.7) ? 'replace' : ratio < 0.3 ? 'before' : 'after';
    const half = rect.width / 2;
    return {
      index: rects[index] ? index : rects.length - 1,
      mode,
      left: rect.left - box.left + (mode === 'after' ? half : 0),
      width: mode === 'replace' ? rect.width : half,
    };
  };
  const sizesFor = sizes.length === ids.length ? sizes : ids.map(() => 1);
  function startResize(index: number, event: React.PointerEvent<HTMLDivElement>) {
    const start = event.clientX;
    const initial = sizesFor;
    const width = panes().reduce((sum, pane) => sum + pane.getBoundingClientRect().width, 0) || 1;
    const units = initial.reduce((sum, value) => sum + value, 0);
    event.preventDefault();
    // Window listeners keep the drag going when the pointer races ahead of the thin divider.
    document.body.classList.add('resizing-panes');
    const move = (moveEvent: PointerEvent) =>
      onSizes(resizePanes(initial, index, ((moveEvent.clientX - start) / width) * units));
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-panes');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  return (
    <div
      ref={root}
      className="split-view"
      style={{ gridTemplateColumns: sizesFor.map((size) => `minmax(0, ${size}fr)`).join(' 5px ') }}
      onDragOver={(event) => {
        if (!hasConversation(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setHint(targetAt(event.clientX));
      }}
      onDragLeave={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node)) setHint(undefined);
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(conversationDragType);
        const target = targetAt(event.clientX);
        setHint(undefined);
        if (!id || !target) return;
        event.preventDefault();
        onDrop(id, { index: target.index, mode: target.mode });
      }}
    >
      {ids.map((id, index) => (
        <Fragment key={keyedPanes[index]!.key}>
          {index > 0 && (
            <div
              className="split-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整宽度，双击平分"
              title="拖动调整宽度，双击平分"
              onPointerDown={(event) => startResize(index - 1, event)}
              onDoubleClick={() => onSizes(ids.map(() => 1))}
            />
          )}
          <section className="split-pane">{children(id, index)}</section>
        </Fragment>
      ))}
      {hint && (
        <div className={`split-drop-hint ${hint.mode}`} style={{ left: hint.left, width: hint.width }}>
          <span>{hint.mode === 'replace' ? '在这里打开' : '分屏打开'}</span>
        </div>
      )}
    </div>
  );
}
