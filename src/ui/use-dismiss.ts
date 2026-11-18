import { useEffect, useRef, type RefObject } from 'react';

/**
 * Closes a popover on Escape or on a press anywhere outside it. Its own toggle button should stop the
 * mousedown from reaching the document, so pressing the button again closes it instead of reopening it.
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
  returnFocus?: () => HTMLElement | null,
) {
  const latest = useRef({ close, returnFocus });
  latest.current = { close, returnFocus };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ('key' in event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        latest.current.close();
        latest.current.returnFocus?.()?.focus?.();
      } else if (!ref.current?.contains(event.target as Node)) latest.current.close();
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [open, ref]);
}
