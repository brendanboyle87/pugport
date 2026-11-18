import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  globalShortcut,
  powerSaveBlocker,
  screen,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
} from 'electron';
import {
  createDirectoryPicker,
  createFilesPicker,
  DIRECTORY_PICK_CHANNEL,
  FILES_PICK_CHANNEL,
} from './directory-picker.ts';
import {
  FOCUS_MAIN_CHANNEL,
  LOCALE_CHANNEL,
  ZOOM_GET_CHANNEL,
  ZOOM_SET_CHANNEL,
  ZOOM_CHANGED_CHANNEL,
  THEME_SET_CHANNEL,
  LOGIN_ITEM_CHANNEL,
  BLACKOUT_CHANNEL,
  BLACKOUT_SHORTCUT_CHANNEL,
  QUICK_CHAT_SETTINGS_CHANNEL,
  QUICK_CHAT_SEND_CHANNEL,
  QUICK_CHAT_CLOSE_CHANNEL,
  QUICK_CHAT_CONTEXT_CHANNEL,
  OPEN_WINDOW_CHANNEL,
  PIN_WINDOW_CHANNEL,
  REVEAL_PATH_CHANNEL,
  OPEN_LOG_FOLDER_CHANNEL,
  DIAGNOSTIC_INFO_CHANNEL,
  REPORT_PROBLEM_CHANNEL,
  REPORT_PROBLEM_CAPTURE_CHANNEL,
  TAKE_CRASH_RECORD_CHANNEL,
  CLEAR_CRASH_RECORD_CHANNEL,
  OPEN_EDITOR_CHANNEL,
  OPEN_LINK_CHANNEL,
  SELECT_CONVERSATION_CHANNEL,
} from './channels.ts';
import { DesktopQuitController, quitDescription, type QuitInspection, type QuitState } from './lifecycle.ts';
import { attachTray, launchAtLogin, trayIcon } from './tray.ts';
import { applyTaskbarIdentity } from './taskbar-identity.ts';
import { setMainLocale, t } from './locale.ts';
import { createWindowActivity } from './window-activity.ts';
import { createRendererConfirmation } from './renderer-confirmation.ts';
import { attachContextMenu } from './context-menu.ts';
import { isLocale } from '../shared/i18n/index.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createKeepAwake } from './keep-awake.ts';
import { createAppearance } from './appearance.ts';
import { stepZoom } from '../shared/appearance.ts';
import { createPowerState } from './power-state.ts';
import { createBlackout, DEFAULT_BLACKOUT_SHORTCUT } from './blackout.ts';
import { createQuickChat } from './quick-chat.ts';
import { createQuickChatClient } from './quick-chat-client.ts';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hostname } from 'node:os';
import { appNavigationAllowed } from './navigation.ts';
import { installModFrameGuard, isAppMainFrame } from './mod-frame-guard.ts';
import { createLogFolderHandler } from './log-folder.ts';
import type { DiagnosticInput } from '../shared/diagnostics.ts';
import type { CrashRecord } from './crash-record.ts';

// Explicit DNS hints bypass document CSP/meta, including links created by Mod JS.
// Apply Chromium's renderer setting before startup; preserve unrelated Blink settings.
// https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/third_party/blink/common/switches.cc
app.commandLine.appendSwitch(
  'blink-settings',
  [app.commandLine.getSwitchValue('blink-settings'), 'dnsPrefetchingEnabled=false'].filter(Boolean).join(','),
);

type Options = {
  origin: string;
  dataDir: string;
  diagnosticInfo: () => Promise<DiagnosticInput>;
  reportProblem: () => Promise<boolean | void>;
  takeCrashRecord: () => CrashRecord | undefined;
  clearCrashRecord?: () => void;
  preload: string;
  backend: { inspect: () => Promise<QuitInspection>; stop: () => Promise<unknown> };
  windowOptions?: BrowserWindowConstructorOptions;
  confirm?: (state: QuitState) => Promise<boolean>;
  pick?: (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  exit?: () => void;
  error?: (error: unknown) => void;
  /** assets/icons: window, taskbar and tray artwork. */
  iconsDir?: string;
  /** Disabled only by isolated package smoke: no visible window, tray or OS registration. */
  desktopIntegration?: boolean;
  /** Registers trusted app windows for window-owned terminal and browser sessions. */
  onWindowCreated?: (window: BrowserWindow) => void;
};

/**
 * The window icon for the current light/dark mode: its small frames (the title bar) are the bone, its large ones
 * (taskbar, Alt-Tab) the app icon. Falls back to the app icon when the themed files are missing.
 */
function windowIcon(iconsDir?: string): string | undefined {
  // macOS takes the window icon from the app bundle and cannot load .ico files.
  if (!iconsDir || process.platform === 'darwin') return undefined;
  for (const name of [`window-${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}.ico`, 'pugport.ico'])
    if (existsSync(join(iconsDir, name))) return join(iconsDir, name);
  return undefined;
}

/** Keeps a window's title bar icon matched to the light/dark mode as it changes. */
function followThemeIcon(window: BrowserWindow, iconsDir?: string) {
  const update = () => {
    if (window.isDestroyed()) return;
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#121316' : '#F3F3F5');
    const icon = windowIcon(iconsDir);
    if (icon && !window.isDestroyed()) window.setIcon(icon);
  };
  update();
  nativeTheme.on('updated', update);
  window.once('closed', () => nativeTheme.off('updated', update));
}

function trayImage() {
  const size = 32,
    pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const inside = x >= 2 && x < 30 && y >= 2 && y < 30;
      const letter =
        (x >= 9 && x <= 12 && y >= 9 && y <= 23) ||
        (x >= 10 && x <= 23 && ((y >= 8 && y <= 11) || (y >= 21 && y <= 24)));
      pixels[offset] = letter ? 241 : 47;
      pixels[offset + 1] = letter ? 248 : 131;
      pixels[offset + 2] = letter ? 248 : 126;
      pixels[offset + 3] = inside ? 255 : 0;
    }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

/** Native shell around the same Web document; hiding it never tears down the backend. */
export function createDesktopShell(options: Options) {
  const appearance = createAppearance(app.getPath('userData'), nativeTheme);
  const appWindows = new Set<BrowserWindow>();
  const setZoom = (value: number) => {
    const zoom = appearance.setZoom(value);
    for (const target of appWindows) {
      if (target.isDestroyed()) continue;
      target.webContents.setZoomFactor(zoom);
      target.webContents.send(ZOOM_CHANGED_CHANNEL, zoom);
    }
    return zoom;
  };
  let disposed = false;
  let sessionEnding = false;
  const awake = createKeepAwake(powerSaveBlocker);
  const powerState = createPowerState(app.getPath('userData'));
  const blackout =
    options.desktopIntegration === false
      ? undefined
      : createBlackout({
          createWindow: (settings) => new BrowserWindow(settings),
          screen,
          shortcuts: globalShortcut,
          awake,
          state: powerState,
          notice: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: 'PugPort',
              message: t('黑屏快捷键不可用，请换一个；原快捷键已保留。'),
            });
          },
        });
  const shortcutFile = join(app.getPath('userData'), 'blackout-shortcut.txt');
  if (blackout) {
    let saved = DEFAULT_BLACKOUT_SHORTCUT;
    try {
      saved = readFileSync(shortcutFile, 'utf8').trim() || saved;
    } catch {
      /* First launch. */
    }
    if (!blackout.setShortcut(saved) && saved !== DEFAULT_BLACKOUT_SHORTCUT)
      blackout.setShortcut(DEFAULT_BLACKOUT_SHORTCUT);
  }
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1000,
    minHeight: 700,
    title: 'PugPort',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121316' : '#F3F3F5',
    ...(windowIcon(options.iconsDir) ? { icon: windowIcon(options.iconsDir) } : {}),
    ...options.windowOptions,
    webPreferences: {
      ...options.windowOptions?.webPreferences,
      preload: options.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      additionalArguments: [`--combo-runner-origin=${options.origin}`],
    },
  });
  const show = () => {
    if (options.desktopIntegration === false) return;
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const rendererConfirmation = createRendererConfirmation(ipcMain, window, options.origin);
  const quickChatFile = join(app.getPath('userData'), 'quick-chat.json');
  const quickClient = createQuickChatClient(options.origin);
  const quickChat =
    options.desktopIntegration === false
      ? undefined
      : createQuickChat({
          createWindow: (settings) => new BrowserWindow(settings),
          screen,
          shortcuts: globalShortcut,
          preload: options.preload,
          read: () => JSON.parse(readFileSync(quickChatFile, 'utf8')),
          write: (settings) => writeFileSync(quickChatFile, JSON.stringify(settings)),
          send: quickClient.send,
          conversation: quickClient.conversation,
          open: (id) => {
            show();
            window.webContents.send(SELECT_CONVERSATION_CHANNEL, id);
          },
          translate: t,
          notice: (message) => {
            void dialog.showMessageBox({ type: 'info', title: 'PugPort', message: t(message) });
          },
        });
  const confirm =
    options.confirm ??
    (async (state: QuitState) => {
      show();
      const answer = rendererConfirmation.ask({
        title: '退出 PugPort？',
        incognito: state === 'unknown' ? undefined : state.incognito,
        points: quitDescription(state).split('\n').filter(Boolean),
        action: '退出 PugPort',
        tone: 'danger',
      });
      if (answer) return answer;
      const result = await dialog.showMessageBox({
        type: 'question',
        title: t('退出 PugPort'),
        message: t('确定退出 PugPort？'),
        detail: t(quitDescription(state)),
        buttons: [t('取消'), t('退出')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    });
  const quit = new DesktopQuitController({
    inspect: options.backend.inspect,
    confirm,
    stop: options.backend.stop,
    exit: (install) => {
      blackout?.dispose();
      if (install) {
        try {
          install();
        } catch (error) {
          // The backend has stopped; never leave a live window pointing at a stopped service.
          console.warn('PugPort update installation failed:', error);
        } finally {
          // The updater queues its own quit on success; failures must also close the stopped app.
          setImmediate(options.exit ?? (() => app.quit()));
        }
      } else (options.exit ?? (() => app.quit()))();
    },
    error:
      options.error ??
      ((error) =>
        dialog.showErrorBox(
          t('PugPort 无法退出'),
          error instanceof Error ? t(error.message) : t('后台清理失败，请重试。'),
        )),
  });
  const requestQuit = () => {
    quickChat?.hide();
    return quit.request(sessionEnding);
  };
  const activity = createWindowActivity({
    window,
    image: (bitmap) => nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 }),
    translate: t,
    canSetTitle: () => {
      try {
        return new URL(window.webContents.getURL()).origin === options.origin;
      } catch {
        return false;
      }
    },
    reducedMotion: () => systemPreferences.getAnimationSettings().prefersReducedMotion,
    windows: process.platform === 'win32' && options.desktopIntegration !== false,
  });
  // Page reloads must not erase the background status, while startup/error screens retain their own title.
  window.webContents.on('page-title-updated', (event) => {
    try {
      if (new URL(window.webContents.getURL()).origin !== options.origin) return;
    } catch {
      return;
    }
    event.preventDefault();
    activity.title();
  });
  window.webContents.on('did-finish-load', () => activity.title());
  const tray =
    options.desktopIntegration === false
      ? undefined
      : new Tray((options.iconsDir && trayIcon(options.iconsDir)) || trayImage());
  tray?.setToolTip('PugPort');
  const trayControl = tray
    ? attachTray({
        tray,
        iconsDir: options.iconsDir ?? '',
        origin: options.origin,
        open: show,
        quit: () => void requestQuit(),
        reportProblem: () => void options.reportProblem(),
        onActivity: (data) => activity.update(data),
        blackout: blackout?.toggle,
        awake,
        state: powerState,
      })
    : undefined;
  const updateApplicationMenu = () =>
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'PugPort',
          submenu: [
            { label: t('打开窗口'), click: show },
            ...(process.platform === 'darwin'
              ? ([
                  { type: 'separator' },
                  { role: 'hide' },
                  { role: 'hideOthers' },
                  { role: 'unhide' },
                  { type: 'separator' },
                ] as const)
              : []),
            {
              label: t('退出 PugPort'),
              ...(process.platform === 'darwin' ? { accelerator: 'Command+Q' } : {}),
              click: () => {
                void requestQuit();
              },
            },
          ],
        },
        {
          label: t('编辑'),
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: t('视图'),
          submenu: [
            {
              label: t('放大界面'),
              accelerator: 'CommandOrControl+Plus',
              click: () => setZoom(stepZoom(appearance.get().zoom, 1)),
            },
            {
              label: t('放大界面'),
              accelerator: 'CommandOrControl+=',
              visible: false,
              click: () => setZoom(stepZoom(appearance.get().zoom, 1)),
            },
            {
              label: t('缩小界面'),
              accelerator: 'CommandOrControl+-',
              click: () => setZoom(stepZoom(appearance.get().zoom, -1)),
            },
            { label: t('重置界面大小'), accelerator: 'CommandOrControl+0', click: () => setZoom(1) },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        { label: t('帮助'), submenu: [{ label: t('报告问题…'), click: () => void options.reportProblem() }] },
        ...(process.platform === 'darwin' ? ([{ role: 'windowMenu' }] as const) : []),
      ]),
    );
  updateApplicationMenu();
  window.on('close', (event) => {
    if (quit.mayCloseWindows || disposed) return;
    event.preventDefault();
    if (process.platform === 'darwin' && window.isFullScreen()) {
      window.once('leave-full-screen', () => {
        if (!window.isDestroyed()) window.hide();
      });
      window.setFullScreen(false);
    } else window.hide();
  });
  window.on('session-end', () => {
    sessionEnding = true;
    void quit.request(true);
  });
  // Links open in the default browser; the app's windows never navigate away from the app.
  const guard = (target: BrowserWindow) => {
    appWindows.add(target);
    target.once('closed', () => appWindows.delete(target));
    target.webContents.setZoomFactor(appearance.get().zoom);
    // Chromium restores zoom per host after leaving the startup data URL.
    target.webContents.on('did-navigate', (_event, destination: string) => {
      if (appNavigationAllowed(destination, options.origin)) target.webContents.setZoomFactor(appearance.get().zoom);
    });
    attachContextMenu(target.webContents);
    installModFrameGuard(target.webContents, options.origin, (url) => shell.openExternal(url));
  };
  guard(window);
  options.onWindowCreated?.(window);
  if (options.desktopIntegration !== false) applyTaskbarIdentity(window, options.iconsDir);
  followThemeIcon(window, options.iconsDir);
  const fromApp = (event: Electron.IpcMainInvokeEvent) => {
    return isAppMainFrame(event.sender, event.senderFrame, options.origin);
  };
  ipcMain.handle(
    OPEN_LOG_FOLDER_CHANNEL,
    createLogFolderHandler(options.dataDir, fromApp, (path) => shell.openPath(path)),
  );
  ipcMain.handle(DIAGNOSTIC_INFO_CHANNEL, (event) => (fromApp(event) ? options.diagnosticInfo() : undefined));
  ipcMain.handle(REPORT_PROBLEM_CHANNEL, (event) => (fromApp(event) ? options.reportProblem() : undefined));
  ipcMain.handle(REPORT_PROBLEM_CAPTURE_CHANNEL, async (event) => {
    if (!fromApp(event)) return undefined;
    const image = await event.sender.capturePage();
    const resized = image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image;
    for (const quality of [85, 70, 50, 30]) {
      const jpeg = resized.toJPEG(quality);
      if (jpeg.length <= 1024 * 1024) return 'data:image/jpeg;base64,' + jpeg.toString('base64');
    }
    throw Error('Screenshot exceeds 1 MB');
  });
  ipcMain.handle(TAKE_CRASH_RECORD_CHANNEL, (event) =>
    fromApp(event) && event.sender === window.webContents ? options.takeCrashRecord() : undefined,
  );
  ipcMain.handle(CLEAR_CRASH_RECORD_CHANNEL, (event) =>
    fromApp(event) && event.sender === window.webContents ? options.clearCrashRecord?.() : undefined,
  );
  const openLink = (event: Electron.IpcMainEvent, url: unknown) => {
    if (
      ![...appWindows].some((target) => target.webContents === event.sender) ||
      !isAppMainFrame(event.sender, event.senderFrame, options.origin) ||
      typeof url !== 'string' ||
      url.length > 16384 ||
      !/^https?:\/\//i.test(url)
    )
      return;
    void shell.openExternal(url);
  };
  ipcMain.on(OPEN_LINK_CHANNEL, openLink);
  ipcMain.handle(ZOOM_GET_CHANNEL, (event) => (fromApp(event) ? appearance.get().zoom : undefined));
  ipcMain.handle(ZOOM_SET_CHANNEL, (event, value: unknown) => {
    if (!fromApp(event) || typeof value !== 'number' || !Number.isFinite(value)) return;
    return setZoom(value);
  });
  ipcMain.handle(THEME_SET_CHANNEL, (event, value: unknown) => {
    if (fromApp(event)) appearance.setTheme(value);
  });
  // One extra window per conversation, like the Codex app's pop-out; closing it keeps the conversation.
  const conversationWindows = new Map<string, BrowserWindow>();
  ipcMain.handle(OPEN_WINDOW_CHANNEL, async (event, id: unknown) => {
    if (options.desktopIntegration === false) return;
    if (!fromApp(event) || typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) return;
    const existing = conversationWindows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
    const bounds = window.getBounds();
    const child = new BrowserWindow({
      width: 820,
      height: Math.min(bounds.height, 940),
      minWidth: 480,
      minHeight: 500,
      title: 'PugPort',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#121316' : '#F3F3F5',
      ...(windowIcon(options.iconsDir) ? { icon: windowIcon(options.iconsDir) } : {}),
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        additionalArguments: [`--combo-runner-origin=${options.origin}`],
      },
    });
    guard(child);
    options.onWindowCreated?.(child);
    applyTaskbarIdentity(child, options.iconsDir);
    followThemeIcon(child, options.iconsDir);
    conversationWindows.set(id, child);
    child.on('closed', () => conversationWindows.delete(id));
    await child.loadURL(`${options.origin}/?view=conversation&id=${encodeURIComponent(id)}`);
  });
  ipcMain.handle(LOCALE_CHANNEL, (event, value: unknown) => {
    if (fromApp(event) && isLocale(value)) {
      setMainLocale(value);
      updateApplicationMenu();
    }
  });
  ipcMain.handle(PIN_WINDOW_CHANNEL, (event, value: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!fromApp(event) || !target) return false;
    target.setAlwaysOnTop(value === true);
    return target.isAlwaysOnTop();
  });
  // Through the shell (the running Explorer opens the folder or selects the file) rather than starting a new
  // explorer.exe each time, which takes seconds. Files are only selected, never opened or run.
  ipcMain.handle(REVEAL_PATH_CHANNEL, async (event, value: unknown) => {
    if (!fromApp(event) || typeof value !== 'string' || !isAbsolute(value) || /[\0"]/.test(value)) return 'invalid';
    const host = value.match(/^[\\/]{2}(?:\?[\\/]UNC[\\/])?([^\\/]+)(?:[\\/]|$)/i)?.[1]?.toLowerCase();
    if (host && host !== 'localhost' && host !== hostname().toLowerCase()) {
      const result = await dialog.showMessageBox({
        type: 'question',
        title: 'PugPort',
        message: t('确定连接这台网络电脑？'),
        detail: `${value}\n${t('Windows 可能会向这台电脑发送你的登录凭据。')}`,
        buttons: [t('取消'), t('继续')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) return 'cancelled';
    }
    const info = await stat(value).catch(() => undefined);
    if (!info) return 'missing';
    if (info.isDirectory()) return (await shell.openPath(value)) ? 'failed' : 'ok';
    shell.showItemInFolder(value);
    return 'ok';
  });
  ipcMain.handle(FOCUS_MAIN_CHANNEL, (event, id: unknown, runId: unknown) => {
    if (!fromApp(event)) return;
    show();
    if (typeof id === 'string' && /^[\w-]{1,100}$/.test(id))
      window.webContents.send(
        SELECT_CONVERSATION_CHANNEL,
        id,
        typeof runId === 'string' && /^[\w-]{1,100}$/.test(runId) ? runId : undefined,
      );
  });
  ipcMain.handle(OPEN_EDITOR_CHANNEL, async (event, value: unknown) => {
    if (!fromApp(event) || !value || typeof value !== 'object') return 'invalid';
    const { editor, path } = value as { editor?: unknown; path?: unknown };
    if (
      (editor !== 'vscode' && editor !== 'cursor') ||
      typeof path !== 'string' ||
      !(process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : isAbsolute(path)) ||
      /[\0"']/.test(path) ||
      /^[\\/]{2}/.test(path)
    )
      return 'invalid';
    try {
      const encoded = path.replaceAll('\\', '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/');
      await shell.openExternal(`${editor}://file/${encoded}`);
      return 'ok';
    } catch {
      return 'failed';
    }
  });
  const picker = createDirectoryPicker(
    () => window,
    options.origin,
    options.pick ?? ((owner, settings) => dialog.showOpenDialog(owner, settings)),
  );
  ipcMain.handle(DIRECTORY_PICK_CHANNEL, picker);
  ipcMain.handle(
    FILES_PICK_CHANNEL,
    createFilesPicker(
      () => window,
      options.origin,
      options.pick ?? ((owner, settings) => dialog.showOpenDialog(owner, settings)),
    ),
  );
  ipcMain.handle(LOGIN_ITEM_CHANNEL, (event, value?: unknown) => {
    // Only the app's own page may change it.
    if (options.desktopIntegration === false || !fromApp(event)) return false;
    return launchAtLogin(typeof value === 'boolean' ? value : undefined);
  });
  ipcMain.handle(BLACKOUT_CHANNEL, (event) => {
    if (fromApp(event)) blackout?.toggle();
  });
  const fromOwnedApp = (event: Electron.IpcMainInvokeEvent) =>
    fromApp(event) &&
    event.senderFrame === event.sender.mainFrame &&
    (event.sender === window.webContents ||
      [...conversationWindows.values()].some((child) => child.webContents === event.sender));
  ipcMain.handle(QUICK_CHAT_SETTINGS_CHANNEL, (event, value?: unknown) => {
    if (!fromOwnedApp(event) || !quickChat) throw new Error('快捷聊天不可用。');
    return quickChat.configure(value);
  });
  ipcMain.handle(QUICK_CHAT_CONTEXT_CHANNEL, (event, value: unknown) => {
    if (fromOwnedApp(event)) quickChat?.remember(value);
  });
  ipcMain.handle(QUICK_CHAT_SEND_CHANNEL, async (event, value: unknown) => {
    if (!quickChat?.fromWindow(event)) throw new Error('快捷聊天不可用。');
    try {
      await quickChat.send(value);
    } catch (error) {
      throw new Error(t(error instanceof Error ? error.message : '发送失败，输入已保留，请重试。'));
    }
  });
  ipcMain.handle(QUICK_CHAT_CLOSE_CHANNEL, (event) => {
    if (quickChat?.fromWindow(event)) quickChat.hide();
  });
  ipcMain.handle(BLACKOUT_SHORTCUT_CHANNEL, (event, value?: unknown) => {
    if (!fromApp(event) || !blackout) return { shortcut: '', registered: false };
    if (value === undefined) return { shortcut: blackout.shortcut, registered: !!blackout.shortcut };
    const old = blackout.shortcut;
    const registered = typeof value === 'string' && value.length <= 100 && blackout.setShortcut(value.trim());
    if (registered) {
      try {
        writeFileSync(shortcutFile, blackout.shortcut);
      } catch {
        if (old) blackout.setShortcut(old);
        throw new Error('黑屏快捷键无法保存，请重试。');
      }
    }
    return { shortcut: blackout.shortcut, registered };
  });
  const beforeQuit = (event: Electron.Event) => {
    if (!quit.mayCloseWindows) {
      event.preventDefault();
      void requestQuit();
    }
  };
  const activate = () => show();
  app.on('before-quit', beforeQuit);
  app.on('activate', activate);
  return {
    window,
    tray,
    show,
    requestQuit,
    requestScriptedQuit: (install?: () => void) => quit.request('scripted', install),
    get exiting() {
      return quit.mayCloseWindows;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      blackout?.dispose();
      quickChat?.dispose();
      for (const channel of [
        QUICK_CHAT_SETTINGS_CHANNEL,
        QUICK_CHAT_CONTEXT_CHANNEL,
        QUICK_CHAT_SEND_CHANNEL,
        QUICK_CHAT_CLOSE_CHANNEL,
      ])
        ipcMain.removeHandler(channel);
      for (const channel of [ZOOM_GET_CHANNEL, ZOOM_SET_CHANNEL, THEME_SET_CHANNEL]) ipcMain.removeHandler(channel);
      rendererConfirmation.dispose();
      for (const channel of [
        OPEN_LOG_FOLDER_CHANNEL,
        DIAGNOSTIC_INFO_CHANNEL,
        REPORT_PROBLEM_CHANNEL,
        REPORT_PROBLEM_CAPTURE_CHANNEL,
        TAKE_CRASH_RECORD_CHANNEL,
        CLEAR_CRASH_RECORD_CHANNEL,
      ])
        ipcMain.removeHandler(channel);
      ipcMain.removeHandler(DIRECTORY_PICK_CHANNEL);
      ipcMain.removeHandler(FILES_PICK_CHANNEL);
      ipcMain.removeHandler(LOGIN_ITEM_CHANNEL);
      ipcMain.removeHandler(BLACKOUT_CHANNEL);
      ipcMain.removeHandler(BLACKOUT_SHORTCUT_CHANNEL);
      ipcMain.removeHandler(OPEN_WINDOW_CHANNEL);
      ipcMain.removeHandler(PIN_WINDOW_CHANNEL);
      ipcMain.removeHandler(LOCALE_CHANNEL);
      ipcMain.removeHandler(FOCUS_MAIN_CHANNEL);
      ipcMain.removeHandler(OPEN_EDITOR_CHANNEL);
      ipcMain.off(OPEN_LINK_CHANNEL, openLink);
      for (const child of conversationWindows.values()) if (!child.isDestroyed()) child.destroy();
      app.off('before-quit', beforeQuit);
      app.off('activate', activate);
      trayControl?.dispose();
      activity.dispose();
      tray?.destroy();
    },
  };
}
