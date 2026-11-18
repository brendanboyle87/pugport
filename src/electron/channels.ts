import type { BackendState } from './backend.ts';

export const BACKEND_STATE_CHANNEL = 'combo-runner:backend-state';
export const BACKEND_STATE_READY_CHANNEL = 'combo-runner:backend-state-ready';
export type BackendWindowState = { phase: 'recovering' | 'error' | 'ready'; message?: string };

export function backendWindowState(state: BackendState, workspaceLoaded: boolean): BackendWindowState | undefined {
  const { phase, message } = state;
  if (workspaceLoaded && (phase === 'recovering' || phase === 'error' || phase === 'ready')) return { phase, message };
}

/** IPC channel for the "launch at sign-in" setting. */
export const LOGIN_ITEM_CHANNEL = 'combo-runner:launch-at-login';
export const BLACKOUT_CHANNEL = 'combo-runner:blackout';
export const BLACKOUT_SHORTCUT_CHANNEL = 'combo-runner:blackout-shortcut';
export const QUICK_CHAT_SETTINGS_CHANNEL = 'combo-runner:quick-chat-settings';
export const QUICK_CHAT_SEND_CHANNEL = 'combo-runner:quick-chat-send';
export const QUICK_CHAT_CLOSE_CHANNEL = 'combo-runner:quick-chat-close';
export const QUICK_CHAT_STATE_CHANNEL = 'combo-runner:quick-chat-state';
export const QUICK_CHAT_CONTEXT_CHANNEL = 'combo-runner:quick-chat-context';
/** The page reports its interface language, for the tray and other main-process text. */
export const LOCALE_CHANNEL = 'combo-runner:locale';
/** Opens a conversation in its own window. */
export const OPEN_WINDOW_CHANNEL = 'combo-runner:open-window';
/** Keeps the sender's window above other windows (or stops doing so). */
export const PIN_WINDOW_CHANNEL = 'combo-runner:pin-window';
/** Shows and focuses the main window, optionally on a conversation and its run details. */
export const FOCUS_MAIN_CHANNEL = 'combo-runner:focus-main';
/** Main to renderer: select this conversation, with an optional run ID to inspect. */
export const SELECT_CONVERSATION_CHANNEL = 'combo-runner:select-conversation';
export const SELECT_CONVERSATION_READY_CHANNEL = 'combo-runner:select-conversation-ready';
/** Shows a path from a reply in the file manager (a folder opens, a file is selected); never runs it. */
export const REVEAL_PATH_CHANNEL = 'combo-runner:reveal-path';
export const OPEN_LOG_FOLDER_CHANNEL = 'combo-runner:open-log-folder';
export const DIAGNOSTIC_INFO_CHANNEL = 'combo-runner:diagnostic-info';
export const REPORT_PROBLEM_CHANNEL = 'combo-runner:report-problem';
export const CLEAR_CRASH_RECORD_CHANNEL = 'combo-runner:clear-crash-record';
export const TAKE_CRASH_RECORD_CHANNEL = 'combo-runner:take-crash-record';
export const OPEN_EDITOR_CHANNEL = 'combo-runner:open-editor';
/** Preload-only trusted main-frame link clicks; never exposed in the renderer bridge. */
export const OPEN_LINK_CHANNEL = 'combo-runner:open-link';
/** Main-process questions, renderer readiness, and correlated answers. */
export const CONFIRMATION_CHANNEL = 'combo-runner:confirmation';
export const CONFIRMATION_READY_CHANNEL = 'combo-runner:confirmation-ready';
export const CONFIRMATION_ANSWER_CHANNEL = 'combo-runner:confirmation-answer';

export const ZOOM_GET_CHANNEL = 'appearance:zoom:get';
export const ZOOM_SET_CHANNEL = 'appearance:zoom:set';
export const ZOOM_CHANGED_CHANNEL = 'appearance:zoom:changed';
export const THEME_SET_CHANNEL = 'appearance:theme:set';

export const REPORT_PROBLEM_OPEN_CHANNEL = 'combo-runner:report-problem-open';
export const REPORT_PROBLEM_CAPTURE_CHANNEL = 'combo-runner:report-problem-capture';
export const REPORT_PROBLEM_READY_CHANNEL = 'combo-runner:report-problem-ready';
/** Mac one-click update: invoke with 'status', 'download' or 'install'; registered only where it is supported. */
export const APP_UPDATE_CHANNEL = 'combo-runner:app-update';
/** Main to renderer: the Mac update status changed. */
export const APP_UPDATE_STATUS_CHANNEL = 'combo-runner:app-update-status';
/** Windows native updater: the downloaded update (invoke to read, main to renderer when it changes). */
export const APP_UPDATE_STATE_CHANNEL = 'pugport:app-update-state';
export const APP_UPDATE_RESTART_CHANNEL = 'pugport:app-update-restart';
