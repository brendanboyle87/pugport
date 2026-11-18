import { useLayoutEffect, useRef, type RefObject } from 'react';

export function useMenuKeys(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    items()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        // Resume native Tab order from the trigger before the menu unmounts.
        previous?.focus?.();
        latest.current();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = items();
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, ref]);
  // Replacing menu items can remove the focused node without reopening the menu.
  useLayoutEffect(() => {
    if (open && document.activeElement === document.body)
      ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  });
}
