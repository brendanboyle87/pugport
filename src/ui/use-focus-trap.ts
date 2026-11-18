import { useEffect, useRef, type RefObject } from 'react';

export function useFocusTrap(open: boolean, ref: RefObject<HTMLElement | null>) {
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    previous.current =
      document.activeElement === document.body || ref.current?.contains(document.activeElement)
        ? null
        : (document.activeElement as HTMLElement | null);
    const controls = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]') ?? []),
      ].filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length);
    if (!ref.current?.contains(document.activeElement)) controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (
        !ref.current?.contains(document.activeElement) ||
        (event.shiftKey ? document.activeElement === first : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, ref]);
  return previous;
}
