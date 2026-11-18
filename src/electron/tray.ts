import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  screen,
  type NativeImage,
  type Tray,
} from 'electron';
import { existsSync } from 'node:fs';
import { backendRequest } from './session-header.ts';
import { join } from 'node:path';
import { trayPopupHtml, type TrayData } from './tray-popup.ts';
import { trayPopupMeasurementScript, trayPopupUpdateScript } from './tray-dom.ts';
import { fitTrayPopup, trayPopupBounds } from './tray-position.ts';
import { createSystemMonitor } from './system-monitor.ts';
import { localeVersion, t, translateHtml } from './locale.ts';
import { createKeepAwake } from './keep-awake.ts';
import type { createPowerState } from './power-state.ts';

/** Start PugPort when the user signs in; used by the settings page. */
export function launchAtLogin(value?: boolean): boolean {
  const options = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
  if (typeof value === 'boolean') app.setLoginItemSettings({ ...options, openAtLogin: value });
  return app.getLoginItemSettings(options).openAtLogin;
}

/** Whether the taskbar (not the app's own theme) is dark, so the tray glyph contrasts with it. */
function darkTaskbar() {
  return process.platform === 'win32'
    ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
    : nativeTheme.shouldUseDarkColors;
}

/**
 * The tray bone from assets/icons (with its @2x variant) for the current taskbar theme; the running frame adds
 * the green dot. Undefined when assets are missing.
 */
export function trayIcon(iconsDir: string, running = false): NativeImage | undefined {
  const file = join(iconsDir, `tray-${darkTaskbar() ? 'dark' : 'light'}${running ? '-run' : ''}.png`);
  if (!existsSync(file)) return undefined;
  const image = nativeImage.createFromPath(file);
  // Menu-bar contrast follows the wallpaper/Space, independently of the app's light/dark theme.
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

/** Preserve the theme-aware bone and both DPI representations; recolor only its existing activity dot. */
export function localTrayIcon(running: NativeImage | undefined): NativeImage | undefined {
  if (!running) return undefined;
  const image = nativeImage.createEmpty();
  const size = running.getSize();
  for (const scaleFactor of running.getScaleFactors()) {
    const width = Math.round(size.width * scaleFactor);
    const height = Math.round(size.height * scaleFactor);
    const bitmap = Buffer.from(running.toBitmap({ scaleFactor }));
    if (bitmap.length !== width * height * 4) continue;
    // Windows native bitmap channels are premultiplied BGRA. The glyph is neutral, the dot green.
    for (let pixel = 0; pixel < bitmap.length; pixel += 4) {
      const blue = bitmap[pixel]!,
        green = bitmap[pixel + 1]!,
        red = bitmap[pixel + 2]!,
        alpha = bitmap[pixel + 3]!;
      if (green > red * 1.3 && green > blue * 1.05) {
        bitmap[pixel] = Math.round((246 * alpha) / 255);
        bitmap[pixel + 1] = Math.round((130 * alpha) / 255);
        bitmap[pixel + 2] = Math.round((59 * alpha) / 255);
      }
    }
    image.addRepresentation({ width, height, scaleFactor, buffer: bitmap });
  }
  if (image.isEmpty()) return undefined;
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

/**
 * Tray behaviour: the green dot blinks while tasks run; a single click shows the quota card, a double click
 * opens the main window, and the context menu offers the common actions.
 */
export function attachTray(options: {
  tray: Tray;
  iconsDir: string;
  origin: string;
  open: () => void;
  quit: () => void;
  reportProblem?: () => void;
  onActivity?: (data: TrayData, lit: boolean) => void;
  blackout?: () => void;
  awake?: ReturnType<typeof createKeepAwake>;
  state: ReturnType<typeof createPowerState>;
}) {
  const { tray, origin } = options;
  const awake = options.awake ?? createKeepAwake(powerSaveBlocker);
  awake.set('manual', options.state.get().keepAwake, 'system');
  // Swapped when the taskbar switches between light and dark.
  let idle = trayIcon(options.iconsDir);
  let dotted = trayIcon(options.iconsDir, true);
  let localDotted = localTrayIcon(dotted);
  let data: TrayData = { running: 0, lines: [], totals: [] };
  let indicator = '';
  let clickTimer: NodeJS.Timeout | undefined;
  let blurTimer: NodeJS.Timeout | undefined;
  let layoutTimer: NodeJS.Timeout | undefined;
  let popup: BrowserWindow | undefined;
  let disposed = false;
  /** The card currently loaded, when it was loaded, and when the card last hid itself on losing focus. */
  let rendered = '';
  let renderedAt = 0;
  let hiddenAt = 0;
  let lastMouseUpAt = 0;
  let showRequest = 0;
  let renderTask: Promise<void> | undefined;
  let manuallyPlaced = false;
  const resources = createSystemMonitor({
    onUpdate: () => {
      if (!disposed && popup?.isVisible()) void render();
    },
  });
  const hidePopup = () => {
    showRequest++;
    clearTimeout(blurTimer);
    clearTimeout(layoutTimer);
    blurTimer = undefined;
    resources.stop();
    manuallyPlaced = false;
    if (popup && !popup.isDestroyed()) popup.hide();
  };

  const fetchState = async () => {
    try {
      const response = await backendRequest(`${origin}/api/tray`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const next = (await response.json()) as TrayData;
        if (!disposed) data = next;
      }
    } catch {
      /* The backend may be starting or stopping; keep the last known state. */
    }
  };
  const menu = () =>
    Menu.buildFromTemplate([
      { label: t('打开 PugPort'), click: options.open },
      {
        label: t(
          data.running + (data.localRunning ?? 0)
            ? `${data.running + (data.localRunning ?? 0)} 个任务运行中`
            : '当前没有运行中的任务',
        ),
        enabled: false,
      },
      { type: 'separator' },
      ...(options.blackout ? [{ label: t('立即黑屏'), click: options.blackout }] : []),
      {
        label: t('不休眠'),
        type: 'checkbox',
        checked: options.state.get().keepAwake,
        click: (item) => {
          if (disposed) return;
          options.state.set({ keepAwake: item.checked });
          awake.set('manual', item.checked, 'system');
          updateContextMenu();
        },
      },
      { type: 'separator' },
      ...(options.reportProblem ? [{ label: t('报告问题…'), click: options.reportProblem }] : []),
      { label: t('退出 PugPort'), click: options.quit },
    ]);
  const updateContextMenu = () => {
    // macOS opens an attached native menu on a left click too, competing with our quota card.
    // Keep its menu explicit on right-click; Windows/Linux retain their native menu handling.
    if (process.platform !== 'darwin') tray.setContextMenu(menu());
  };
  const update = () => {
    if (disposed || tray.isDestroyed()) return;
    const agent = data.running ? t(`${data.running} 个 Agent 任务运行中`) : '';
    const local = data.localRunning ? (data.localTitle ? t(data.localTitle) : t('本地任务处理中')) : '';
    tray.setToolTip(
      agent || local
        ? `PugPort · ${[agent, local, data.localRunning && data.localPhase ? t(data.localPhase) : ''].filter(Boolean).join(' · ')}`
        : t('PugPort · 空闲'),
    );
    const nextIndicator = data.running ? 'agent' : data.localRunning ? 'local' : 'idle';
    if (nextIndicator !== indicator) {
      indicator = nextIndicator;
      const image = nextIndicator === 'agent' ? dotted : nextIndicator === 'local' ? localDotted : idle;
      if (image) tray.setImage(image);
    }
    // Native dots stay steady; the visible card provides the reduced-motion-aware breathing animation.
    options.onActivity?.(data, true);
  };
  let lastRunning = '';
  let lastLocale = -1;
  // Like the Codex app's "prevent sleep while running": the PC stays awake only while tasks run.
  const keepAwake = () => {
    const wanted = (data.running > 0 || (data.localRunning ?? 0) > 0) && data.keepAwake !== false;
    awake.set('tasks', wanted);
  };
  const poll = async () => {
    if (disposed) return;
    await fetchState();
    if (disposed || tray.isDestroyed()) return;
    update();
    keepAwake();
    const activity = JSON.stringify([data.running, data.localRunning, data.localTitle, data.localPhase]);
    if (activity !== lastRunning || localeVersion() !== lastLocale) {
      lastRunning = activity;
      lastLocale = localeVersion();
      updateContextMenu();
    }
    // The card stays ready while hidden (refreshed every half minute), so a click shows it at once.
    if (popup?.isVisible() || Date.now() - renderedAt > 30_000) await render();
  };
  const refresh = async () => {
    try {
      await backendRequest(`${origin}/api/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      /* A failed refresh keeps the last readings; their times show how old they are. */
    }
    await poll();
  };
  const render = async (forceLayout = false): Promise<void> => {
    // Polling, resources, refresh and a click can all request a render. Serialize their DOM updates.
    if (renderTask) {
      await renderTask;
      return render(forceLayout);
    }
    if (disposed || !popup || popup.isDestroyed()) return;
    const card = popup;
    const html = translateHtml(trayPopupHtml(data, Date.now(), resources.snapshot()));
    if (html === rendered && !forceLayout) return;
    const task = (async () => {
      try {
        let measured: unknown;
        if (rendered)
          measured = await card.webContents.executeJavaScript(
            html === rendered ? trayPopupMeasurementScript : trayPopupUpdateScript(html),
          );
        if (disposed || card.isDestroyed() || card !== popup || tray.isDestroyed()) return;
        // Navigate only for the first load or when the renderer lost its expected DOM.
        if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) {
          await card.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          if (disposed || card.isDestroyed() || card !== popup || tray.isDestroyed()) return;
          measured = await card.webContents.executeJavaScript(trayPopupMeasurementScript).catch(() => 260);
        }
        if (disposed || card.isDestroyed() || card !== popup || tray.isDestroyed()) return;
        rendered = html;
        renderedAt = Date.now();
        // Measure the natural card before fitting the native window. Keep CSS and Electron coordinates
        // in DIP and update size/position together when crossing monitors with different DPI.
        const content = Math.ceil(typeof measured === 'number' && Number.isFinite(measured) ? measured : 260);
        place(content);
      } catch {
        // Closing the card can abort navigation. A later click retries loading it.
        if (card === popup) rendered = '';
      }
    })();
    renderTask = task;
    try {
      await task;
    } finally {
      if (renderTask === task) renderTask = undefined;
    }
  };
  const place = (contentHeight?: number) => {
    if (disposed || !popup || popup.isDestroyed() || tray.isDestroyed()) return;
    const current = popup.getBounds();
    const height = contentHeight ?? current.height;
    const next =
      manuallyPlaced && popup.isVisible()
        ? fitTrayPopup({ ...current, height }, screen.getDisplayMatching(current).workArea)
        : trayPopupBounds(tray.getBounds(), screen.getDisplayMatching(tray.getBounds()), { width: 340, height });
    if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height)
      popup.setBounds(next);
  };
  const create = () => {
    if (!popup || popup.isDestroyed()) {
      rendered = '';
      popup = new BrowserWindow({
        width: 340,
        height: 260,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
      });
      const card = popup;
      const settleLayout = () => {
        if (disposed || card !== popup || card.isDestroyed()) return;
        clearTimeout(layoutTimer);
        // On Windows a cross-monitor move changes CSS metrics after native bounds change. Recheck the
        // settled renderer even when the quota/resource HTML is unchanged, eliminating transparent gaps.
        layoutTimer = setTimeout(() => {
          layoutTimer = undefined;
          if (!disposed && card === popup && !card.isDestroyed()) void render(true);
        }, 125);
      };
      card.on('move', settleLayout);
      card.on('resize', settleLayout);
      card.on('will-move', () => {
        // Electron emits this only for a user's native drag, not our setBounds calls.
        if (!disposed && card === popup && !card.isDestroyed() && card.isVisible()) manuallyPlaced = true;
      });
      card.on('blur', () => {
        // Hidden prewarming and Windows' tray-to-window focus handoff can emit blur too. Neither means
        // that the user dismissed the newly requested card. Check the settled focus, not the stale event.
        if (disposed || card !== popup || card.isDestroyed() || !card.isVisible()) return;
        clearTimeout(blurTimer);
        blurTimer = setTimeout(() => {
          blurTimer = undefined;
          if (
            disposed ||
            tray.isDestroyed() ||
            card !== popup ||
            card.isDestroyed() ||
            !card.isVisible() ||
            card.isFocused()
          )
            return;
          const point = screen.getCursorScreenPoint();
          const bounds = tray.getBounds();
          const overIcon =
            point.x >= bounds.x &&
            point.x <= bounds.x + bounds.width &&
            point.y >= bounds.y &&
            point.y <= bounds.y + bounds.height;
          hiddenAt = overIcon ? Date.now() : 0;
          hidePopup();
        }, 75);
      });
      card.webContents.on('render-process-gone', () => {
        if (disposed || card !== popup) return;
        hidePopup();
        popup = undefined;
        rendered = '';
        renderedAt = 0;
        hiddenAt = 0;
        renderTask = undefined;
        if (!card.isDestroyed()) card.destroy();
      });
      card.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        if (url === 'combo://open') {
          hidePopup();
          options.open();
        } else if (url === 'combo://refresh') void refresh();
      });
    }
    return popup;
  };
  const showPopup = async () => {
    if (disposed) return;
    const request = ++showRequest;
    manuallyPlaced = false;
    const card = create();
    await render();
    if (disposed || request !== showRequest || card.isDestroyed() || card !== popup) return;
    // Show what is ready now; fresh numbers follow a moment later.
    place();
    card.show();
    card.focus();
    resources.start();
    await fetchState();
    if (disposed || request !== showRequest || card.isDestroyed() || card !== popup) return;
    await render();
  };
  const togglePopup = () => {
    if (disposed || tray.isDestroyed()) return;
    clearTimeout(clickTimer);
    // Clicking the icon first takes focus from an open card, which hides it: that click means "close".
    if (popup?.isVisible() || Date.now() - hiddenAt < 400) {
      hidePopup();
      hiddenAt = 0;
      return;
    }
    void showPopup();
  };
  const onMouseUp = () => {
    lastMouseUpAt = Date.now();
    togglePopup();
  };
  const onClick = () => {
    // Some Mac input devices emit mouse-up without Electron's click-count-based click event.
    // Use mouse-up there; keep click for accessibility activation, deduplicating the usual pair.
    if (process.platform === 'darwin' && Date.now() - lastMouseUpAt < 100) return;
    togglePopup();
  };
  const onDoubleClick = () => {
    if (disposed || tray.isDestroyed()) return;
    clearTimeout(clickTimer);
    hidePopup();
    options.open();
  };
  const onRightClick = () => {
    if (disposed || tray.isDestroyed()) return;
    clearTimeout(clickTimer);
    hiddenAt = 0;
    // Cancel pending navigation as well as an already visible card before opening the native menu.
    hidePopup();
    if (process.platform === 'darwin') tray.popUpContextMenu(menu());
  };
  tray.on('click', onClick);
  if (process.platform === 'darwin') tray.on('mouse-up', onMouseUp);
  tray.on('double-click', onDoubleClick);
  tray.on('right-click', onRightClick);
  updateContextMenu();
  if (idle) tray.setImage(idle);
  // Build the card shortly after start, off the critical path, so the first click is already instant.
  clickTimer = setTimeout(() => {
    create();
    void render();
  }, 3000);
  const retheme = () => {
    if (disposed || tray.isDestroyed()) return;
    idle = trayIcon(options.iconsDir);
    dotted = trayIcon(options.iconsDir, true);
    localDotted = localTrayIcon(dotted);
    const image = data.running ? dotted : data.localRunning ? localDotted : idle;
    if (image) tray.setImage(image);
  };
  nativeTheme.on('updated', retheme);
  void poll();
  const timer = setInterval(() => void poll(), 4000);
  return {
    dispose() {
      disposed = true;
      resources.dispose();
      nativeTheme.off('updated', retheme);
      showRequest++;
      clearInterval(timer);
      clearTimeout(clickTimer);
      clearTimeout(blurTimer);
      clearTimeout(layoutTimer);
      tray.off('click', onClick);
      tray.off('mouse-up', onMouseUp);
      tray.off('double-click', onDoubleClick);
      tray.off('right-click', onRightClick);
      awake.set('tasks', false);
      awake.set('manual', false);
      if (popup && !popup.isDestroyed()) popup.destroy();
    },
  };
}
