import type { powerSaveBlocker } from 'electron';

/** One blocker shared by independent reasons; removing one never cancels another. */
export function createKeepAwake(blocker: Pick<typeof powerSaveBlocker, 'start' | 'stop'>) {
  const reasons = new Map<string, 'system' | 'display'>();
  let id: number | undefined;
  let currentLevel: 'system' | 'display' | undefined;
  return {
    set(reason: string, wanted: boolean, level: 'system' | 'display' = 'system') {
      if (wanted) reasons.set(reason, level);
      else reasons.delete(reason);
      const nextLevel = reasons.size ? ([...reasons.values()].includes('display') ? 'display' : 'system') : undefined;
      if (nextLevel && (id === undefined || nextLevel !== currentLevel)) {
        const nextId = blocker.start(nextLevel === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension');
        if (id !== undefined) blocker.stop(id);
        id = nextId;
        currentLevel = nextLevel;
      } else if (!nextLevel && id !== undefined) {
        blocker.stop(id);
        id = undefined;
        currentLevel = undefined;
      }
    },
  };
}
