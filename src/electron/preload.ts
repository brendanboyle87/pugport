import { APP_UPDATE_STATE_CHANNEL, APP_UPDATE_RESTART_CHANNEL } from './channels.ts';
import type { AppState } from '../shared/types.ts';
import { REPORT_PROBLEM_READY_CHANNEL } from './channels.ts';
import { contextBridge, ipcRenderer } from 'electron';
import { DIRECTORY_PICK_CHANNEL, FILES_PICK_CHANNEL } from './directory-picker.ts';
import { bindQuickChat } from './quick-chat-page.ts';
import type { QuickChatSettings, QuickChatStatus, QuickChatConversation } from '../shared/quick-chat.ts';
import type { MacUpdateStatus } from '../shared/app-update.ts';
import {
  APP_UPDATE_CHANNEL,
  APP_UPDATE_STATUS_CHANNEL,
  BACKEND_STATE_CHANNEL,
  BACKEND_STATE_READY_CHANNEL,
  type BackendWindowState,
  CONFIRMATION_CHANNEL,
  CONFIRMATION_READY_CHANNEL,
  CONFIRMATION_ANSWER_CHANNEL,
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
  QUICK_CHAT_STATE_CHANNEL,
  QUICK_CHAT_CONTEXT_CHANNEL,
  OPEN_WINDOW_CHANNEL,
  PIN_WINDOW_CHANNEL,
  REVEAL_PATH_CHANNEL,
  OPEN_LOG_FOLDER_CHANNEL,
  DIAGNOSTIC_INFO_CHANNEL,
  REPORT_PROBLEM_CHANNEL,
  REPORT_PROBLEM_OPEN_CHANNEL,
  REPORT_PROBLEM_CAPTURE_CHANNEL,
  TAKE_CRASH_RECORD_CHANNEL,
  CLEAR_CRASH_RECORD_CHANNEL,
  OPEN_EDITOR_CHANNEL,
  OPEN_LINK_CHANNEL,
  SELECT_CONVERSATION_CHANNEL,
  SELECT_CONVERSATION_READY_CHANNEL,
} from './channels.ts';
import type { Confirmation } from '../shared/confirmation.ts';
import { PERMISSION_CHANGE_CHANNEL, type PermissionChange } from '../shared/permission-change.ts';
import {
  DESKTOP_TOOLS_CHANNEL,
  DESKTOP_TOOLS_EVENT,
  type DesktopToolsApi,
  type DesktopToolsEvent,
} from '../shared/desktop-tools.ts';

let reportProblemListeners = 0;
const tool = (action: string, fields: Record<string, unknown> = {}) =>
  ipcRenderer.invoke(DESKTOP_TOOLS_CHANNEL, { action, ...fields });
const projectTools: DesktopToolsApi = {
  openTerminal: (conversationId, size) => tool('terminal.open', { conversationId, size }),
  writeTerminal: (id, data) => tool('terminal.write', { id, data }),
  resizeTerminal: (id, size) => tool('terminal.resize', { id, size }),
  closeTerminal: (id) => tool('terminal.close', { id }),
  openBrowser: (conversationId) => tool('browser.open', { conversationId }),
  browserAction: (id, command, url) => tool('browser.action', { id, command, url }),
  browserBounds: (id, bounds) => tool('browser.bounds', { id, bounds }),
  browserCapture: (id) => tool('browser.capture', { id }),
  browserElement: (id, point) => tool('browser.element', { id, point }),
  browserText: (id, rect) => tool('browser.text', { id, rect }),
  closeBrowser: (id) => tool('browser.close', { id }),
  connectChrome: (conversationId, endpoint) => tool('chrome.connect', { conversationId, endpoint }),
  refreshChrome: (id) => tool('chrome.refresh', { id }),
  activateChrome: (id, pageId) => tool('chrome.activate', { id, pageId }),
  disconnectChrome: (id) => tool('chrome.disconnect', { id }),
  onEvent: (listener) => {
    const handler = (_event: unknown, event: DesktopToolsEvent) => listener(event);
    ipcRenderer.on(DESKTOP_TOOLS_EVENT, handler);
    return () => ipcRenderer.off(DESKTOP_TOOLS_EVENT, handler);
  },
};

const prefix = '--combo-runner-origin=';
const origin = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
if (process.isMainFrame && process.argv.includes('--pugport-quick-chat') && location.protocol === 'data:') {
  const api = Object.freeze({
    send: (text: string): Promise<void> => ipcRenderer.invoke(QUICK_CHAT_SEND_CHANNEL, text),
    close: (): Promise<void> => ipcRenderer.invoke(QUICK_CHAT_CLOSE_CHANNEL),
  });
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      const update = bindQuickChat(document, api);
      ipcRenderer.on(QUICK_CHAT_STATE_CHANNEL, (_event, state) => update(state));
    },
    { once: true },
  );
}
if (process.isMainFrame && origin && location.origin === origin) {
  // The popup API cannot identify its sender frame. Only genuine main-document link clicks use IPC.
  const openLink = (event: MouseEvent) => {
    if (!event.isTrusted || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.composedPath().find((item) => item instanceof HTMLAnchorElement);
    if (!(anchor instanceof HTMLAnchorElement) || !/^https?:\/\//i.test(anchor.href)) return;
    const newWindow = anchor.target && !['_self', '_parent', '_top'].includes(anchor.target);
    if (!newWindow && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button !== 1) return;
    event.preventDefault();
    ipcRenderer.send(OPEN_LINK_CHANNEL, anchor.href);
  };
  window.addEventListener('click', openLink, true);
  window.addEventListener('auxclick', openLink, true);
  contextBridge.exposeInMainWorld(
    'comboRunnerDesktop',
    Object.freeze({
      projectTools: Object.freeze(projectTools),
      restartToUpdate: (): Promise<void> => ipcRenderer.invoke(APP_UPDATE_RESTART_CHANNEL),
      onAppUpdate: (listener: (update: AppState['appUpdate']) => void) => {
        let active = true;
        const handler = (_event: unknown, update: AppState['appUpdate']) => listener(update);
        ipcRenderer.on(APP_UPDATE_STATE_CHANNEL, handler);
        void ipcRenderer
          .invoke(APP_UPDATE_STATE_CHANNEL)
          .then((update) => {
            if (active) listener(update);
          })
          .catch(() => {});
        return () => {
          active = false;
          ipcRenderer.off(APP_UPDATE_STATE_CHANNEL, handler);
        };
      },
      pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(DIRECTORY_PICK_CHANNEL),
      pickFiles: (): Promise<string[]> => ipcRenderer.invoke(FILES_PICK_CHANNEL),
      changePermission: (change: PermissionChange): Promise<boolean> =>
        ipcRenderer.invoke(PERMISSION_CHANGE_CHANNEL, change).catch((error: unknown) => {
          if (error instanceof Error)
            error.message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
          throw error;
        }),
      launchAtLogin: (value?: boolean): Promise<boolean> => ipcRenderer.invoke(LOGIN_ITEM_CHANNEL, value),
      blackout: (): Promise<void> => ipcRenderer.invoke(BLACKOUT_CHANNEL),
      blackoutShortcut: (value?: string): Promise<{ shortcut: string; registered: boolean }> =>
        ipcRenderer.invoke(BLACKOUT_SHORTCUT_CHANNEL, value),
      quickChatSettings: (value?: QuickChatSettings): Promise<QuickChatStatus> =>
        ipcRenderer.invoke(QUICK_CHAT_SETTINGS_CHANNEL, value),
      quickChatContext: (value: QuickChatConversation): Promise<void> =>
        ipcRenderer.invoke(QUICK_CHAT_CONTEXT_CHANNEL, value),
      openWindow: (conversationId: string): Promise<void> => ipcRenderer.invoke(OPEN_WINDOW_CHANNEL, conversationId),
      pinWindow: (value: boolean): Promise<boolean> => ipcRenderer.invoke(PIN_WINDOW_CHANNEL, value),
      getZoom: (): Promise<number> => ipcRenderer.invoke(ZOOM_GET_CHANNEL),
      setZoom: (factor: number): Promise<number> => ipcRenderer.invoke(ZOOM_SET_CHANNEL, factor),
      setTheme: (theme: 'system' | 'light' | 'dark'): Promise<void> => ipcRenderer.invoke(THEME_SET_CHANNEL, theme),
      onZoomChanged: (listener: (factor: number) => void) => {
        const handler = (_event: unknown, factor: number) => listener(factor);
        ipcRenderer.on(ZOOM_CHANGED_CHANNEL, handler);
        return () => ipcRenderer.off(ZOOM_CHANGED_CHANNEL, handler);
      },
      setLocale: (locale: string): Promise<void> => ipcRenderer.invoke(LOCALE_CHANNEL, locale),
      focusMain: (conversationId?: string, runId?: string): Promise<void> =>
        ipcRenderer.invoke(FOCUS_MAIN_CHANNEL, conversationId, runId),
      revealPath: (path: string): Promise<string> => ipcRenderer.invoke(REVEAL_PATH_CHANNEL, path),
      openLogFolder: (): Promise<string> => ipcRenderer.invoke(OPEN_LOG_FOLDER_CHANNEL),
      diagnosticInfo: () => ipcRenderer.invoke(DIAGNOSTIC_INFO_CHANNEL),
      reportProblem: (): Promise<boolean> => ipcRenderer.invoke(REPORT_PROBLEM_CHANNEL),
      captureProblemScreenshot: (): Promise<string> => ipcRenderer.invoke(REPORT_PROBLEM_CAPTURE_CHANNEL),
      onReportProblem: (listener: () => void) => {
        const handler = () => listener();
        ipcRenderer.on(REPORT_PROBLEM_OPEN_CHANNEL, handler);
        if (++reportProblemListeners === 1) ipcRenderer.send(REPORT_PROBLEM_READY_CHANNEL, true);
        let removed = false;
        return () => {
          if (removed) return;
          removed = true;
          ipcRenderer.off(REPORT_PROBLEM_OPEN_CHANNEL, handler);
          if (--reportProblemListeners === 0) ipcRenderer.send(REPORT_PROBLEM_READY_CHANNEL, false);
        };
      },
      appUpdate: Object.freeze({
        status: (): Promise<MacUpdateStatus> => ipcRenderer.invoke(APP_UPDATE_CHANNEL, 'status'),
        download: (): Promise<MacUpdateStatus> => ipcRenderer.invoke(APP_UPDATE_CHANNEL, 'download'),
        install: (): Promise<boolean> => ipcRenderer.invoke(APP_UPDATE_CHANNEL, 'install'),
        onStatus: (listener: (status: MacUpdateStatus) => void) => {
          const handler = (_event: unknown, status: MacUpdateStatus) => listener(status);
          ipcRenderer.on(APP_UPDATE_STATUS_CHANNEL, handler);
          return () => ipcRenderer.off(APP_UPDATE_STATUS_CHANNEL, handler);
        },
      }),
      takeCrashRecord: () => ipcRenderer.invoke(TAKE_CRASH_RECORD_CHANNEL),
      clearCrashRecord: (): Promise<void> => ipcRenderer.invoke(CLEAR_CRASH_RECORD_CHANNEL),
      openEditor: (value: { editor: 'vscode' | 'cursor'; path: string }): Promise<string> =>
        ipcRenderer.invoke(OPEN_EDITOR_CHANNEL, value),
      onConfirmation: (listener: (options: Confirmation) => Promise<boolean>) => {
        const handler = (_event: unknown, id: string, options: Confirmation) => {
          void Promise.resolve()
            .then(() => listener(options))
            .then(
              (answer) => ipcRenderer.send(CONFIRMATION_ANSWER_CHANNEL, id, answer === true),
              () => ipcRenderer.send(CONFIRMATION_ANSWER_CHANNEL, id, false),
            );
        };
        ipcRenderer.on(CONFIRMATION_CHANNEL, handler);
        ipcRenderer.send(CONFIRMATION_READY_CHANNEL, true);
        return () => {
          ipcRenderer.off(CONFIRMATION_CHANNEL, handler);
          ipcRenderer.send(CONFIRMATION_READY_CHANNEL, false);
        };
      },
      onBackendState: (listener: (state: BackendWindowState) => void) => {
        const handler = (_event: unknown, state: BackendWindowState) => listener(state);
        ipcRenderer.on(BACKEND_STATE_CHANNEL, handler);
        ipcRenderer.send(BACKEND_STATE_READY_CHANNEL);
        return () => ipcRenderer.off(BACKEND_STATE_CHANNEL, handler);
      },
      onSelectConversation: (listener: (id: string, runId?: string) => void) => {
        const handler = (_event: unknown, id: unknown, runId: unknown) => {
          if (typeof id === 'string') listener(id, typeof runId === 'string' ? runId : undefined);
        };
        ipcRenderer.on(SELECT_CONVERSATION_CHANNEL, handler);
        ipcRenderer.send(SELECT_CONVERSATION_READY_CHANNEL, true);
        return () => {
          ipcRenderer.off(SELECT_CONVERSATION_CHANNEL, handler);
          ipcRenderer.send(SELECT_CONVERSATION_READY_CHANNEL, false);
        };
      },
    }),
  );
}
