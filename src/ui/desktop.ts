import type { AppState } from '../shared/types.ts';
import type { Confirmation } from '../shared/confirmation';
import type { PermissionChange } from '../shared/permission-change';
import type { QuickChatSettings, QuickChatStatus, QuickChatConversation } from '../shared/quick-chat';
import type { DesktopToolsApi } from '../shared/desktop-tools';
import type { BackendWindowState } from '../electron/channels';
import type { Notice } from './Workspace';
import type { DiagnosticInput } from '../shared/diagnostics';
import { redactDiagnosticText } from '../shared/diagnostics';
import type { CrashRecord } from '../electron/crash-record';
import { copyDiagnosticInfo } from './diagnostics';
import type { MacUpdateStatus } from '../shared/app-update';

export function backendStateNotice(
  state: BackendWindowState,
  bridge?: ComboRunnerDesktop,
  notify?: (notice: Notice) => void,
): Notice | null {
  if (state.phase === 'ready') return null;
  return state.phase === 'error'
    ? {
        tone: 'error',
        message: state.message || '后台服务不可用。',
        ...(bridge?.openLogFolder
          ? {
              action: {
                label: '打开日志文件夹',
                run: async () => {
                  try {
                    const error = await bridge.openLogFolder!();
                    if (error) notify?.({ tone: 'error', message: '无法打开日志文件夹。' });
                  } catch {
                    notify?.({ tone: 'error', message: '无法打开日志文件夹。' });
                  }
                },
              },
            }
          : {}),
        ...(bridge?.diagnosticInfo && notify
          ? {
              secondaryAction: {
                label: '复制诊断信息',
                run: async () => {
                  try {
                    await copyDiagnosticInfo(await bridge.diagnosticInfo!(), notify);
                  } catch {
                    notify({ tone: 'error', message: '无法读取诊断信息，请重试。' });
                  }
                },
              },
            }
          : {}),
      }
    : { tone: 'info', message: state.message || '本地后台正在恢复…' };
}

export function crashNotice(
  record: CrashRecord,
  bridge: ComboRunnerDesktop,
  notify: (notice: Notice) => void,
  dismiss = () => {},
): Notice {
  const clear = async () => {
    await bridge.clearCrashRecord?.();
    dismiss();
  };
  return {
    tone: 'info',
    message: 'PugPort 上次意外关闭。',
    onDismiss: clear,
    action: {
      label: '复制详情',
      run: async () => {
        try {
          const input = (await bridge.diagnosticInfo?.()) ?? {};
          const copied = await copyDiagnosticInfo(
            input,
            notify,
            redactDiagnosticText(`\nCrash: ${record.kind} / ${record.reason}\nTime: ${record.at}`),
          );
          if (copied) await clear();
        } catch {
          notify({ tone: 'error', message: '无法读取诊断信息，请重试。' });
        }
      },
    },
    ...(bridge.reportProblem
      ? {
          secondaryAction: {
            label: '报告…',
            run: async () => {
              try {
                if (await bridge.reportProblem!()) await clear();
              } catch {
                notify({ tone: 'error', message: '无法打开浏览器，请稍后重试。' });
              }
            },
          },
        }
      : {}),
  };
}

export type ComboRunnerDesktop = {
  /** Mac one-click update; the calls reject where the app has no updater. */
  appUpdate?: {
    status(): Promise<MacUpdateStatus>;
    download(): Promise<MacUpdateStatus>;
    install(): Promise<boolean>;
    onStatus(listener: (status: MacUpdateStatus) => void): () => void;
  };
  openLogFolder?(): Promise<string>;
  diagnosticInfo?(): Promise<DiagnosticInput>;
  reportProblem?(): Promise<boolean | void>;
  captureProblemScreenshot?(): Promise<string>;
  onReportProblem?(listener: () => void): () => void;
  takeCrashRecord?(): Promise<CrashRecord | undefined>;
  clearCrashRecord?(): Promise<void>;
  projectTools?: DesktopToolsApi;
  getZoom?(): Promise<number>;
  setZoom?(factor: number): Promise<number>;
  onZoomChanged?(listener: (factor: number) => void): () => void;
  setTheme?(theme: 'system' | 'light' | 'dark'): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pickFiles?(): Promise<string[]>;
  changePermission?(change: PermissionChange): Promise<boolean>;
  /** Reads, or with a value sets, whether PugPort starts at sign-in. */
  launchAtLogin?(value?: boolean): Promise<boolean>;
  blackout?(): Promise<void>;
  blackoutShortcut?(value?: string): Promise<{ shortcut: string; registered: boolean }>;
  quickChatSettings?(value?: QuickChatSettings): Promise<QuickChatStatus>;
  quickChatContext?(value: QuickChatConversation): Promise<void>;
  /** Opens a conversation in a separate window (one window per conversation). */
  openWindow?(conversationId: string): Promise<void>;
  /** Tells the app which interface language the page uses (tray menu and quota card follow it). */
  setLocale?(locale: string): Promise<void>;
  /** Keeps this window on top of others; returns the new state. */
  pinWindow?(value: boolean): Promise<boolean>;
  /** Shows a full path in the file manager: "ok", "missing", "invalid" or "failed". */
  revealPath?(path: string): Promise<string>;
  openEditor?(value: { editor: 'vscode' | 'cursor'; path: string }): Promise<string>;
  /** Brings the main window forward, optionally on a conversation or its run details. */
  focusMain?(conversationId?: string, runId?: string): Promise<void>;
  /** The main window is asked to show a conversation (from a notification or another window). */
  onSelectConversation?(listener: (id: string, runId?: string) => void): () => void;
  onAppUpdate?(listener: (update: AppState['appUpdate']) => void): () => void;
  restartToUpdate?(): Promise<void>;
  onBackendState?(listener: (state: BackendWindowState) => void): () => void;
  /** Answers desktop questions in the app; unsubscribe marks this renderer unavailable. */
  onConfirmation?(listener: (options: Confirmation) => Promise<boolean>): () => void;
};

declare global {
  interface Window {
    comboRunnerDesktop?: ComboRunnerDesktop;
  }
}

export function desktopBridge(): ComboRunnerDesktop | undefined {
  if (typeof window === 'undefined' || typeof window.comboRunnerDesktop?.pickDirectory !== 'function') return undefined;
  return window.comboRunnerDesktop;
}
