import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  globalShortcut,
  IpcMainInvokeEvent,
  screen,
} from 'electron';
import {
  DEFAULT_QUICK_CHAT_SETTINGS,
  isQuickChatSettings,
  type QuickChatSettings,
  type QuickChatConversation,
} from '../shared/quick-chat.ts';
import { QUICK_CHAT_STATE_CHANNEL } from './channels.ts';
import { quickChatHtml, quickChatLabels } from './quick-chat-page.ts';

export function createQuickChat(options: {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  screen: Pick<typeof screen, 'getCursorScreenPoint' | 'getDisplayNearestPoint'>;
  shortcuts: Pick<typeof globalShortcut, 'register' | 'unregister'>;
  preload: string;
  read: () => unknown;
  write: (settings: QuickChatSettings) => void;
  send: (text: string, id?: string) => Promise<string>;
  conversation: (id?: string) => Promise<string>;
  open: (id: string) => void;
  translate: (text: string) => string;
  notice: (message: string) => void;
}) {
  let settings = { ...DEFAULT_QUICK_CHAT_SETTINGS };
  try {
    const saved = options.read();
    if (isQuickChatSettings(saved)) settings = { ...saved };
  } catch {
    /* First launch. */
  }
  let shortcut = '';
  let disposed = false;
  let window: BrowserWindow | undefined;
  let loaded: Promise<void> | undefined;
  let page = '';
  let last: QuickChatConversation | undefined;
  let target: QuickChatConversation | undefined;
  let pending = false;
  let composerSendKey: 'enter' | 'ctrl-enter' = 'enter';
  let showing = 0;
  const hide = () => {
    showing++;
    if (window && !window.isDestroyed()) window.hide();
  };
  const status = () => ({ ...settings, registered: !!shortcut });
  const fromWindow = (event: IpcMainInvokeEvent) =>
    !disposed &&
    !!window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === page;
  const show = async () => {
    if (disposed || !settings.enabled) return;
    const ticket = ++showing;
    if (!pending) target = settings.target === 'last' ? last : undefined;
    if (!window || window.isDestroyed()) {
      const labels = quickChatLabels(options.translate, composerSendKey);
      page = `data:text/html;charset=utf-8,${encodeURIComponent(quickChatHtml(labels))}`;
      const popup = (window = options.createWindow({
        width: 580,
        height: 310,
        frame: false,
        show: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        title: 'PugPort',
        webPreferences: {
          preload: options.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          additionalArguments: ['--pugport-quick-chat'],
        },
      }));
      popup.on('blur', hide);
      popup.on('close', (event) => {
        if (!disposed) {
          event.preventDefault();
          hide();
        }
      });
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      popup.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        if (url !== 'pugport-quick-chat:open' || pending) return;
        pending = true;
        void options
          .conversation(target?.id)
          .then((id) => {
            if (!disposed) {
              hide();
              options.open(id);
            }
          })
          .catch(() => {
            if (!disposed) options.notice('打开对话失败，请稍后重试。');
          })
          .finally(() => {
            pending = false;
          });
      });
      popup.webContents.on('render-process-gone', () => {
        hide();
        popup.destroy();
      });
      loaded = popup.loadURL(page);
    }
    try {
      await loaded;
      if (disposed || ticket !== showing || !window || window.isDestroyed()) return;
      const area = options.screen.getDisplayNearestPoint(options.screen.getCursorScreenPoint()).workArea;
      const width = Math.min(580, area.width),
        height = Math.min(310, area.height);
      window.setBounds({
        width,
        height,
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
      });
      window.webContents.send(QUICK_CHAT_STATE_CHANNEL, {
        labels: quickChatLabels(options.translate, composerSendKey),
        composerSendKey,
        target: target ? `${target.project} · ${target.title}` : options.translate('日常对话 · 新对话'),
      });
      window.show();
      window.focus();
    } catch {
      if (!disposed) {
        window?.destroy();
        options.notice('快捷聊天窗口无法打开，请重试。');
      }
    }
  };
  const register = (next: QuickChatSettings) => {
    if (!next.enabled || next.shortcut === shortcut) return true;
    try {
      return options.shortcuts.register(next.shortcut, () => void show());
    } catch {
      return false;
    }
  };
  const configure = (value?: unknown) => {
    if (disposed) return status();
    if (value === undefined) return status();
    if (!isQuickChatSettings(value)) throw new Error('快捷聊天设置无效。');
    const next: QuickChatSettings = { enabled: value.enabled, shortcut: value.shortcut.trim(), target: value.target };
    // The settings page shows a taken shortcut inline; no dialog on top of it.
    if (!register(next)) return { ...status(), registered: false };
    try {
      options.write(next);
    } catch {
      if (next.enabled && next.shortcut !== shortcut) options.shortcuts.unregister(next.shortcut);
      throw new Error('快捷聊天设置无法保存，请重试。');
    }
    if (shortcut && (!next.enabled || shortcut !== next.shortcut)) options.shortcuts.unregister(shortcut);
    shortcut = next.enabled ? next.shortcut : '';
    settings = next;
    if (!settings.enabled) hide();
    return status();
  };
  // A shortcut taken by another app at startup is reported on the settings page, not in a startup dialog.
  if (settings.enabled) {
    if (register(settings)) shortcut = settings.shortcut;
    else console.warn(`[quick-chat] shortcut ${settings.shortcut} is taken by another app`);
  }
  return {
    show,
    hide,
    configure,
    fromWindow,
    remember(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const item = value as QuickChatConversation;
      if (item.composerSendKey === 'enter' || item.composerSendKey === 'ctrl-enter')
        composerSendKey = item.composerSendKey;
      if (
        typeof item.id === 'string' &&
        /^[\w-]{1,100}$/.test(item.id) &&
        typeof item.title === 'string' &&
        item.title.length <= 300 &&
        typeof item.project === 'string' &&
        item.project.length <= 300
      )
        last = { ...item };
    },
    async send(value: unknown) {
      if (disposed || pending || typeof value !== 'string' || !value.trim() || value.length > 50000)
        throw new Error('暂时无法发送，请检查输入后重试。');
      pending = true;
      try {
        const id = await options.send(value, target?.id);
        if (!disposed) {
          last = {
            id,
            title: target?.title ?? value.slice(0, 80),
            project: target?.project ?? options.translate('日常对话'),
          };
          hide();
        }
      } finally {
        pending = false;
      }
    },
    dispose() {
      disposed = true;
      hide();
      if (shortcut) options.shortcuts.unregister(shortcut);
      window?.destroy();
    },
  };
}
