import { useEffect, useRef } from 'react';

const blockers = new Set<() => boolean>();

/** Keep unsaved content in memory; never serialize files or private conversations for an update. */
export function registerUiUpdateBlocker(check: () => boolean): () => void {
  blockers.add(check);
  return () => {
    blockers.delete(check);
  };
}

export function uiUpdateBlocked(): boolean {
  for (const check of blockers) {
    try {
      if (check()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Protect the complete operation, including token negotiation and response parsing. */
export function holdUiUpdate(): () => void {
  return registerUiUpdateBlocker(() => true);
}

export function useUiUpdateBlocker(check: () => boolean, _label?: string): void {
  const current = useRef(check);
  current.current = check;
  useEffect(() => registerUiUpdateBlocker(() => current.current()), []);
}
