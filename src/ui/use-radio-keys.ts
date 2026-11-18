import { useCallback, type KeyboardEvent } from 'react';

/** Arrow focus wraps within the group; only immediate choices also select. */
export function useRadioKeys(selectOnArrow = false) {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const index = radios.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const next = radios[(index + step + radios.length) % radios.length];
      next?.focus();
      if (selectOnArrow) next?.click();
    },
    [selectOnArrow],
  );
}
