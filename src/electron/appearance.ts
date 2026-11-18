import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAppearanceTheme, presetZoom, type AppearanceTheme } from '../shared/appearance.ts';

/** Read before creating windows so the splash and native frame use the saved theme. */
export function createAppearance(userData: string, nativeTheme: { themeSource: AppearanceTheme }) {
  const file = join(userData, 'appearance.json');
  let state: { zoom: number; theme: AppearanceTheme } = { zoom: 1, theme: 'system' };
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') {
      state = {
        zoom: presetZoom('zoom' in saved ? saved.zoom : undefined),
        theme: 'theme' in saved && isAppearanceTheme(saved.theme) ? saved.theme : 'system',
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not read desktop appearance:', error);
  }
  nativeTheme.themeSource = state.theme;
  function save() {
    try {
      mkdirSync(userData, { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(state));
      renameSync(file + '.tmp', file);
    } catch (error) {
      console.warn('Could not save desktop appearance:', error);
    }
  }
  return {
    get: () => ({ ...state }),
    setZoom(value: unknown) {
      const zoom = presetZoom(value);
      if (state.zoom !== zoom) {
        state.zoom = zoom;
        save();
      }
      return zoom;
    },
    setTheme(value: unknown) {
      if (!isAppearanceTheme(value)) return;
      if (state.theme !== value) {
        state.theme = value;
        save();
      }
      nativeTheme.themeSource = value;
    },
  };
}
