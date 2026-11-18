import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type PowerState = { keepAwake: boolean; blackout: boolean; blackoutExitedAt?: number };

/** One main-process store shared by the tray and blackout controller. */
export function createPowerState(userData: string) {
  const file = join(userData, 'power-state.json');
  let state: PowerState = { keepAwake: false, blackout: false };
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') {
      state = {
        keepAwake: 'keepAwake' in saved && saved.keepAwake === true,
        blackout: 'blackout' in saved && saved.blackout === true,
        ...('blackoutExitedAt' in saved &&
        typeof saved.blackoutExitedAt === 'number' &&
        Number.isFinite(saved.blackoutExitedAt) &&
        saved.blackoutExitedAt >= 0
          ? { blackoutExitedAt: saved.blackoutExitedAt }
          : {}),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not read desktop power state:', error);
  }
  return {
    get: () => ({ ...state }),
    set(change: Partial<PowerState>) {
      state = { ...state, ...change };
      if ('blackout' in change) delete state.blackoutExitedAt;
      try {
        mkdirSync(userData, { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify(state));
        renameSync(file + '.tmp', file);
      } catch (error) {
        console.warn('Could not save desktop power state:', error);
      }
    },
  };
}
