import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { shownName, withNames } from './i18n';

/** Equal-width cards stretch to the same height in each row. */
export function EvenCards({ children, onOpen }: { children: ReactNode; onOpen: (id: string, from: DOMRect) => void }) {
  // A click on a card (not on one of its buttons or links) opens it enlarged with every detail.
  const open = (event: React.MouseEvent | React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, label, summary')) return;
    const card = target.closest<HTMLElement>('.quota-card[data-runtime-id]');
    if (card) {
      card.focus({ preventScroll: true });
      onOpen(card.dataset.runtimeId!, card.getBoundingClientRect());
    }
  };
  return (
    <div
      className="resource-grid zoomable"
      onClick={open}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).matches('.quota-card')) {
          event.preventDefault();
          open(event);
        }
      }}
    >
      {children}
    </div>
  );
}

/**
 * A card grown smoothly from where it sat in the grid to a large panel with all its details open; Esc, the
 * close button or a click outside shrinks it back.
 */
export function QuotaZoom({
  from,
  label,
  onClose,
  children,
}: {
  from: DOMRect;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const closed = useRef(false);
  const animation = useRef<Animation | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onClosed = useRef(onClose);
  onClosed.current = onClose;
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // From the card's place and size to the panel's: one transform, so the motion stays smooth.
  const offset = () => {
    const to = panel.current!.getBoundingClientRect();
    const scale = from.width / to.width;
    return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})`;
  };
  useLayoutEffect(() => {
    const element = panel.current;
    const modal = dialog.current;
    if (!element || !modal) return;
    closing.current = false;
    closed.current = false;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.showModal();
    for (const details of Array.from(element.querySelectorAll('details'))) details.open = true;
    element.querySelector<HTMLButtonElement>('.quota-zoom-close')?.focus({ preventScroll: true });
    if (!reduced)
      animation.current = element.animate(
        [
          { transform: offset(), opacity: 0.4 },
          { transform: 'none', opacity: 1 },
        ],
        {
          duration: 260,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        },
      );
    return () => {
      closed.current = true;
      clearTimeout(closeTimer.current);
      if (animation.current) animation.current.onfinish = null;
      animation.current?.cancel();
      if (modal.open) modal.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = () => {
    if (closed.current) return;
    closed.current = true;
    clearTimeout(closeTimer.current);
    onClosed.current();
  };
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const element = panel.current;
    if (!element || reduced) return finish();
    animation.current?.cancel();
    const motion = (animation.current = element.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: offset(), opacity: 0 },
      ],
      {
        duration: 200,
        easing: 'cubic-bezier(.4,0,1,1)',
        fill: 'forwards',
      },
    ));
    // A hidden window pauses animations; the panel still closes.
    closeTimer.current = setTimeout(finish, 300);
    motion.onfinish = finish;
  };
  return (
    <dialog
      className="quota-zoom-backdrop"
      ref={dialog}
      aria-label={withNames('{0} 详情', [shownName(label)])}
      data-names
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div className="quota-zoom" ref={panel}>
        <button type="button" className="icon-button quota-zoom-close" aria-label="关闭详情" onClick={close}>
          <X size={16} />
        </button>
        {children}
      </div>
    </dialog>
  );
}
