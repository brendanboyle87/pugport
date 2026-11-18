import type { BrowserWindow, BrowserWindowConstructorOptions, Display, globalShortcut, screen } from 'electron';
import type { createKeepAwake } from './keep-awake.ts';
import type { createPowerState } from './power-state.ts';

export const DEFAULT_BLACKOUT_SHORTCUT = 'Ctrl+Alt+B';
export const blackoutHtml =
  '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>*{cursor:none!important}html,body{margin:0;width:100%;height:100%;background:#000;cursor:none;overflow:hidden}</style></head><body></body></html>';

/** Electron display bounds and window bounds are both DIPs, including negative origins and portrait displays. */
export const blackoutRect = (display: Pick<Display, 'bounds'>) => ({ ...display.bounds });

export function createBlackout(options: {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  screen: Pick<typeof screen, 'getAllDisplays' | 'getPrimaryDisplay' | 'on' | 'off'>;
  shortcuts: Pick<typeof globalShortcut, 'register' | 'unregister'>;
  awake: ReturnType<typeof createKeepAwake>;
  state: ReturnType<typeof createPowerState>;
  notice: () => void;
}) {
  let active = false;
  let disposed = false;
  let shortcut = '';
  let keyRestoredAt = -Infinity;
  let focusTimer: ReturnType<typeof setInterval> | undefined;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const windows = new Map<number, BrowserWindow>();
  const rebuilds = new Map<number, number[]>();

  const focus = () => {
    if (!active || !windows.size) return;
    try {
      const primary = windows.get(options.screen.getPrimaryDisplay()?.id) ?? windows.values().next().value;
      if (primary && !primary.isDestroyed() && !primary.isFocused()) primary.focus();
    } catch {
      /* Display discovery can be temporarily unavailable during sleep/hot-plug. */
    }
  };
  const stop = () => {
    if (!active) return;
    active = false;
    clearTimeout(blurTimer);
    clearInterval(focusTimer);
    for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
    windows.clear();
    options.awake.set('blackout', false);
  };
  const restore = () => {
    options.state.set({ blackout: false });
    stop();
  };
  const syncDisplays = () => {
    if (!active) return;
    try {
      const displays = options.screen.getAllDisplays();
      for (const [id, window] of windows) {
        if (displays.some((display) => display.id === id)) continue;
        windows.delete(id);
        if (!window.isDestroyed()) window.destroy();
      }
      for (const display of displays) {
        const existing = windows.get(display.id);
        if (existing) {
          existing.setBounds(blackoutRect(display));
          continue;
        }
        const window = options.createWindow({
          ...blackoutRect(display),
          frame: false,
          fullscreen: true,
          show: false,
          skipTaskbar: true,
          hasShadow: false,
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          enableLargerThanScreen: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        windows.set(display.id, window);
        try {
          window.setAlwaysOnTop(true, 'screen-saver');
          window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          window.webContents.on('before-input-event', (event, input) => {
            event.preventDefault();
            if (input.type === 'keyDown' && active && windows.get(display.id) === window) {
              keyRestoredAt = Date.now();
              restore();
            }
          });
          // Consume clicks/wheel too; they never restore or navigate the overlay.
          window.webContents.on('before-mouse-event', (event, mouse) => {
            // Moves must reach the page so its `cursor: none` applies; clicks and the wheel are swallowed.
            if (!['mouseMove', 'mouseEnter', 'mouseLeave'].includes(mouse.type)) event.preventDefault();
          });
          const failed = () => {
            if (!active || windows.get(display.id) !== window) return;
            const recent = (rebuilds.get(display.id) ?? []).filter((at) => Date.now() - at < 60_000);
            // Giving up ends this blackout for good, so a restart must not loop back into it.
            if (recent.length >= 3) return restore();
            rebuilds.set(display.id, [...recent, Date.now()]);
            windows.delete(display.id);
            if (!window.isDestroyed()) window.destroy();
            syncDisplays();
          };
          window.webContents.on('render-process-gone', failed);
          window.on('closed', failed);
          window.on('blur', () => {
            if (!active) return;
            clearTimeout(blurTimer);
            blurTimer = setTimeout(focus, 100);
          });
          void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(blackoutHtml)}`).catch(failed);
          window.show();
        } catch (error) {
          windows.delete(display.id);
          if (!window.isDestroyed()) window.destroy();
          throw error;
        }
      }
      focus();
    } catch {
      /* Keep the blocker and intent; the timer or a later display event retries discovery. */
    }
  };
  const toggle = () => {
    if (disposed) return;
    if (active) return restore();
    active = true;
    rebuilds.clear();
    options.awake.set('blackout', true, 'display');
    syncDisplays();
    if (!active) return;
    options.state.set({ blackout: true });
    focusTimer = setInterval(() => (windows.size ? focus() : syncDisplays()), 1000);
  };
  const setShortcut = (value: string) => {
    if (disposed) return false;
    if (value === shortcut) return true;
    let registered = false;
    try {
      registered =
        !!value.trim() &&
        options.shortcuts.register(value, () => {
          // A modifier key can restore before the OS dispatches the rest of this shortcut.
          if (!active && Date.now() - keyRestoredAt < 500) return;
          toggle();
        });
    } catch {
      /* Invalid Electron accelerators follow the same path as conflicts. */
    }
    if (!registered) {
      options.notice();
      return false;
    }
    if (shortcut) options.shortcuts.unregister(shortcut);
    shortcut = value;
    return true;
  };
  options.screen.on('display-added', syncDisplays);
  options.screen.on('display-removed', syncDisplays);
  options.screen.on('display-metrics-changed', syncDisplays);
  const saved = options.state.get();
  if (saved.blackout) {
    options.state.set({ blackout: false });
    const elapsed = Date.now() - (saved.blackoutExitedAt ?? -Infinity);
    if (elapsed >= 0 && elapsed < 10 * 60_000) toggle();
  }
  return {
    toggle,
    setShortcut,
    get shortcut() {
      return shortcut;
    },
    get active() {
      return active;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) options.state.set({ blackoutExitedAt: Date.now() });
      stop();
      if (shortcut) options.shortcuts.unregister(shortcut);
      options.screen.off('display-added', syncDisplays);
      options.screen.off('display-removed', syncDisplays);
      options.screen.off('display-metrics-changed', syncDisplays);
    },
  };
}
