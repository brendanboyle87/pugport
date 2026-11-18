import { AppUpdater, nativeUpdatesEnabled, WINDOWS_UPDATE_FEED } from './app-updater.ts';
import { APP_UPDATE_STATE_CHANNEL, APP_UPDATE_RESTART_CHANNEL } from './channels.ts';
import { isAppMainFrame } from './mod-frame-guard.ts';
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
} from 'electron';
import { attachSessionHeader, backendRequest, setSessionOwner, setSessionToken } from './session-header.ts';
import { createPermissionChange } from './permission-change.ts';
import { PERMISSION_CHANGE_CHANNEL } from '../shared/permission-change.ts';
import { join, resolve } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { OwnedBackend, type BackendState } from './backend.ts';
import { AccountAuth, AccountVault } from './account.ts';
import { configuredSync, readSyncConfig } from '../shared/account-sync.ts';
import { selectDesktopPort } from './backend-port.ts';
import { publishDesktopPort } from '../server/platform/desktop-endpoint.ts';
import { desktopDataDirectory } from './data-directory.ts';
import { DataLocationError } from '../shared/data-location.ts';
import { createDesktopShell } from './shell.ts';
import { splashHtml } from './splash.ts';
import { APP_NAME, APP_VERSION } from '../shared/identity.ts';
import { diagnosticInput, type DiagnosticInput } from '../shared/diagnostics.ts';
import { reportIssue } from '../shared/report-issue.ts';
import type { AppState } from '../shared/types.ts';
import { REPORT_PROBLEM_OPEN_CHANNEL, REPORT_PROBLEM_READY_CHANNEL } from './channels.ts';
import { createCrashRecord, type CrashRecord } from './crash-record.ts';
import { createLogFolderHandler } from './log-folder.ts';
import { APP_USER_MODEL_ID, ensureTaskbarIdentity, watchTaskbarIdentity } from './taskbar-identity.ts';
import { restoreMainLocale, t } from './locale.ts';
import { runPageTest, type PageTestRequest } from './page-test.ts';
import { WebBridge } from './web-bridge.ts';
import { ProjectTools } from './project-tools.ts';
import { MacUpdater } from './mac-updater.ts';
import { flushThenExit } from './keyring-exit.ts';
import { macInstallTarget, macUpdateFeed, startMacInstall } from '../server/platform/mac-update.ts';
import {
  APP_UPDATE_CHANNEL,
  APP_UPDATE_STATUS_CHANNEL,
  BACKEND_STATE_CHANNEL,
  BACKEND_STATE_READY_CHANNEL,
  backendWindowState,
  SELECT_CONVERSATION_CHANNEL,
  SELECT_CONVERSATION_READY_CHANNEL,
} from './channels.ts';

// Package smoke runs use a hidden, disposable profile and never register with the OS shell.
const smokeDirectory = process.env.COMBORUNNER_SMOKE_DIR || process.env.AGENT_STUDIO_SMOKE_DIR;
let smokeFailed = false;
app.setName(APP_NAME);
if (smokeDirectory && process.env.APPDATA) app.setPath('appData', process.env.APPDATA);
// Groups the window under PugPort's own taskbar entry and icon instead of Electron's.
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
app.setPath('userData', process.env.COMBORUNNER_DESKTOP_USER_DATA_DIR || join(app.getPath('appData'), 'ComboRunner'));
// Electron 44's API permits omitting submitURL when uploads are disabled.
crashReporter.start({ uploadToServer: false, compress: true });
let quitting = false;
let dataDirectory: string | undefined;
let crashes: ReturnType<typeof createCrashRecord> | undefined;
let previousCrash: CrashRecord | undefined;
const fallbackDiagnosticInfo = (): DiagnosticInput => ({
  version: APP_VERSION,
  os: process.platform,
  arch: process.arch,
});
let appUpdater: AppUpdater | undefined;
let desktop: ReturnType<typeof createDesktopShell> | undefined;
let backend: OwnedBackend | undefined;
let account: AccountAuth | undefined;
let webBridge: WebBridge | undefined;
let projectTools: ProjectTools | undefined;
let macUpdater: MacUpdater | undefined;
const appWindows = new Set<number>();
let failed = false;
let workspaceLoaded = false;
let conversationSelectionReady = false;
function conversationLink(argv: string[]) {
  for (const arg of argv) {
    // Unlike $, this end assertion also rejects a trailing newline.
    const match = /^pugport:\/\/conversation\/([\w-]{1,100})(?![\s\S])/.exec(arg);
    if (match) return match[1];
  }
}
let pendingConversation = conversationLink(process.argv);
function selectPendingConversation() {
  if (!desktop || !workspaceLoaded || !conversationSelectionReady || !pendingConversation) return;
  desktop.show();
  desktop.window.webContents.send(SELECT_CONVERSATION_CHANNEL, pendingConversation);
  pendingConversation = undefined;
}
/** The pug for the startup screen, read once; the screen still works without it. */
let splashLogo = '';
let port = 4317;
let origin = `http://127.0.0.1:${port}`;
let clearEndpoint: (() => void) | undefined;
function sendBackendState(state: BackendState) {
  if (!desktop || desktop.window.isDestroyed() || desktop.exiting) return;
  const value = backendWindowState(state, workspaceLoaded);
  // A notice must never stop startup or recovery, even if the window is closing.
  try {
    if (value) desktop.window.webContents.send(BACKEND_STATE_CHANNEL, value);
  } catch (error) {
    console.error('Backend state notice could not be sent:', error);
  }
}
ipcMain.on(BACKEND_STATE_READY_CHANNEL, (event) => {
  if (
    !desktop ||
    desktop.window.isDestroyed() ||
    event.sender !== desktop.window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    return;
  try {
    if (new URL(event.senderFrame.url).origin !== origin) return;
  } catch {
    return;
  }
  if (backend) sendBackendState(backend.state);
});
ipcMain.on(SELECT_CONVERSATION_READY_CHANNEL, (event, value: unknown) => {
  if (
    !desktop ||
    desktop.window.isDestroyed() ||
    event.sender !== desktop.window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    return;
  try {
    if (new URL(event.senderFrame.url).origin !== origin) return;
  } catch {
    return;
  }
  conversationSelectionReady = value === true;
  selectPendingConversation();
});

async function diagnosticInfo(): Promise<DiagnosticInput> {
  let input = fallbackDiagnosticInfo();
  try {
    const response = await backendRequest(`${origin}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) input = diagnosticInput((await response.json()) as AppState);
  } catch {
    /* The report action must also work while the backend is down. */
  }
  return input;
}

let reportProblemReady = false;
let reportDialogInFlight: Promise<boolean> | undefined;
ipcMain.on(REPORT_PROBLEM_READY_CHANNEL, (event, ready: unknown) => {
  if (
    !desktop ||
    desktop.window.isDestroyed() ||
    event.sender !== desktop.window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    return;
  try {
    if (new URL(event.senderFrame.url).origin !== origin) return;
  } catch {
    return;
  }
  reportProblemReady = ready === true;
});
async function reportProblem(): Promise<boolean> {
  const window = desktop?.window;
  if (!window || window.isDestroyed()) return false;
  desktop?.show();
  try {
    if (
      reportProblemReady &&
      backend?.state.phase === 'ready' &&
      new URL(window.webContents.mainFrame.url).origin === origin
    ) {
      window.webContents.send(REPORT_PROBLEM_OPEN_CHANNEL);
      return true;
    }
  } catch {
    /* An unavailable renderer uses the offline dialog below. */
  }
  return (reportDialogInFlight ??= showReportDialog(window).finally(() => {
    reportDialogInFlight = undefined;
  }));
}
async function showReportDialog(window: BrowserWindow): Promise<boolean> {
  const report = reportIssue(await diagnosticInfo());
  if (window.isDestroyed()) return false;
  const result = await dialog.showMessageBox(window, {
    type: 'info',
    title: t('报告问题…'),
    message: t('仅预填版本和操作系统。在 GitHub 上提交前，不会发送问题报告。'),
    detail: report.detail,
    buttons: [t('取消'), t('打开 GitHub')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return false;
  try {
    await shell.openExternal(report.url);
    return true;
  } catch {
    if (!window.isDestroyed())
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'PugPort',
        message: t('无法打开浏览器，请稍后重试。'),
      });
    return false;
  }
}
async function startupFailure(title: string, detail: string) {
  // The dialog blocks the main thread; record the reason first and bring the app forward so it is not hidden.
  console.error(`PugPort startup failed: ${detail}`);
  if (dataDirectory) {
    try {
      mkdirSync(join(dataDirectory, 'logs'), { recursive: true });
      appendFileSync(
        join(dataDirectory, 'logs', 'desktop.log'),
        `${new Date().toISOString()} startup failed: ${detail}\n`,
      );
    } catch {
      /* The dialog still shows the reason. */
    }
  }
  app.focus({ steal: true });
  const result = await dialog.showMessageBox({
    type: 'error',
    title,
    message: detail,
    ...(!dataDirectory ? { detail: t('尚未确定数据文件夹，无法打开日志。') } : {}),
    buttons: dataDirectory ? [t('打开日志文件夹'), t('关闭')] : [t('关闭')],
    defaultId: dataDirectory ? 1 : 0,
    cancelId: dataDirectory ? 1 : 0,
    noLink: true,
  });
  if (dataDirectory && result.response === 0) {
    const error = await createLogFolderHandler(
      dataDirectory,
      () => true,
      (path) => shell.openPath(path),
    )(undefined);
    if (error) await dialog.showMessageBox({ type: 'error', title: 'PugPort', message: t('无法打开日志文件夹。') });
  }
}

function showState(message: string, failed = false) {
  if (!desktop || desktop.window.isDestroyed()) return;
  const text = t(message);
  desktop.window.setTitle(failed ? `PugPort · ${text}` : 'PugPort');
  void desktop.window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(text, failed, splashLogo))}`)
    .catch(() => {});
}

const scriptedQuit = process.argv.includes('--quit');
if (!app.requestSingleInstanceLock({ quit: scriptedQuit }) || scriptedQuit) app.exit(0);
else {
  // macOS delivers protocol links as open-url, including before the app is ready.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (account?.handleUrl(url)) {
      desktop?.show();
      return;
    }
    const conversation = conversationLink([url]);
    if (!conversation) return;
    pendingConversation = conversation;
    selectPendingConversation();
  });
  app.on('second-instance', (_event, argv, _directory, additionalData) => {
    if ((additionalData as { quit?: unknown })?.quit === true) {
      if (desktop) void desktop.requestScriptedQuit();
      else console.warn('PugPort --quit refused: task state unknown (desktop starting).');
      return;
    }
    if (argv.some((url) => account?.handleUrl(url))) {
      desktop?.show();
      return;
    }
    pendingConversation = conversationLink(argv) ?? pendingConversation;
    desktop?.show();
    selectPendingConversation();
  });
  // A hidden primary window and its tray keep the process alive on every supported platform.
  app.on('window-all-closed', () => {});
  void app
    .whenReady()
    .then(async () => {
      if (app.isPackaged && !smokeDirectory) app.setAsDefaultProtocolClient('pugport');
      port = await selectDesktopPort();
      origin = `http://127.0.0.1:${port}`;
      const root = app.getAppPath();
      if (!smokeDirectory) {
        ensureTaskbarIdentity(join(root, 'assets', 'icons'));
        watchTaskbarIdentity(join(root, 'assets', 'icons'));
      }
      try {
        splashLogo = `data:image/svg+xml;base64,${readFileSync(join(root, 'assets', 'brand', 'pug-line.svg')).toString('base64')}`;
      } catch {
        splashLogo = '';
      }
      restoreMainLocale();
      const dataDir = desktopDataDirectory({ root, appData: app.getPath('appData'), packaged: app.isPackaged });
      dataDirectory = dataDir;
      const accountConfig = readSyncConfig();
      if (configuredSync(accountConfig) && !smokeDirectory) {
        // Sync is optional: a missing OS keystore or similar setup failure leaves the app running without it.
        try {
          account = new AccountAuth({
            config: accountConfig,
            vault: new AccountVault(dataDir, safeStorage),
            send: (message) => backend?.sendAccount(message),
            openExternal: (url) => shell.openExternal(url),
            protocolAvailable: () => app.isPackaged && app.isDefaultProtocolClient('pugport'),
            signedIn: () => desktop?.show(),
          });
          // OS storage and network work must never delay the first window or a Chat.
          void account.restore().catch(() => {});
        } catch (error) {
          account = undefined;
          console.warn('PugPort account sync is unavailable:', error instanceof Error ? error.message : error);
        }
      }
      crashes = createCrashRecord(dataDir);
      previousCrash = crashes.take();
      const bridge = (webBridge = new WebBridge({ port, dataDir, mainWindow: () => desktop?.window }));
      projectTools = new ProjectTools({ origin, token: () => backend?.token });
      projectTools.install();
      backend = new OwnedBackend({
        root,
        dataDir,
        port,
        env: {
          ...process.env,
          PUGPORT_DESKTOP_DISCOVERY: smokeDirectory ? '0' : '1',
          COMBORUNNER_PACKAGED: app.isPackaged ? '1' : '0',
        },
        crashed: (reason) => crashes?.record('backend', reason, quitting || !!desktop?.exiting),
        pageTest: (request) => runPageTest(request as PageTestRequest, dataDir, port),
        // Web agents' windows (Grok Bot, Muse …), each with its own sign-in; off unless the user turns one on.
        webAgent: (request) => bridge.handle(request),
        accountMessage: (message) => {
          void account?.handle(message).catch(() => {});
        },
        changed: (state) => {
          if (state.phase === 'ready')
            try {
              account?.handoff();
            } catch (error) {
              // Sync is optional; a failed handoff must not turn a ready backend into a startup failure.
              console.warn('PugPort account handoff failed:', error instanceof Error ? error.message : error);
            }
          clearEndpoint?.();
          clearEndpoint = undefined;
          if (state.phase === 'ready' && !smokeDirectory) {
            try {
              clearEndpoint = publishDesktopPort(port);
            } catch (error) {
              console.error('Desktop port discovery could not be published:', error);
            }
          }
          // Keep the renderer (and unsent draft) alive; its existing SSE connection
          // reconnects to the same origin once the owned child completes its handshake.
          if (workspaceLoaded && desktop && !desktop.window.isDestroyed() && !desktop.exiting) {
            sendBackendState(state);
            if (state.phase === 'recovering' || state.phase === 'error')
              desktop.window.setTitle(`PugPort · ${t(state.message || '后台服务不可用。')}`);
            else if (state.phase === 'ready') desktop.window.setTitle('PugPort');
            return;
          }
          if (state.phase === 'error' && !failed) {
            failed = true;
            showState(state.message || '后台服务不可用。', true);
          }
        },
      });
      setSessionToken(() => backend?.token);
      setSessionOwner(() => backend?.owner);
      attachSessionHeader(
        session.defaultSession,
        origin,
        () => backend?.token,
        appWindows,
        () => backend?.owner,
      );
      powerMonitor?.on('suspend', () => backend?.suspendHealth());
      powerMonitor?.on('resume', () => backend?.resumeHealth());
      desktop = createDesktopShell({
        origin,
        dataDir,
        diagnosticInfo,
        reportProblem,
        takeCrashRecord: () => previousCrash,
        clearCrashRecord: () => {
          if (previousCrash) crashes?.clear(previousCrash);
          previousCrash = undefined;
        },
        onWindowCreated: (window) => {
          projectTools!.register(window);
          appWindows.add(window.webContents.id);
          window.on('focus', () => account?.setActive(true));
          const updateAccountActivity = () =>
            account?.setActive(
              BrowserWindow.getAllWindows().some(
                (candidate) => !candidate.isDestroyed() && candidate.isVisible() && !candidate.isMinimized(),
              ),
            );
          window.on('hide', updateAccountActivity);
          window.on('minimize', updateAccountActivity);
          window.on('closed', updateAccountActivity);
        },
        preload: join(root, 'dist', 'electron', 'preload.cjs'),
        iconsDir: join(root, 'assets', 'icons'),
        ...(smokeDirectory
          ? {
              desktopIntegration: false,
              windowOptions: { show: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } },
              error: (error: unknown) => console.error('Package smoke shutdown failed:', error),
              exit: () => app.exit(smokeFailed ? 1 : 0),
            }
          : {}),
        backend: {
          inspect: async () => {
            const state = await backend!.inspect();
            return { ...state, active: state.active + (projectTools?.activeTerminals ?? 0) };
          },
          stop: () => {
            account?.stop();
            return backend!.stop();
          },
        },
      });
      if (nativeUpdatesEnabled(app.isPackaged, process.platform, !!smokeDirectory)) {
        try {
          const electronUpdater = await import('electron-updater');
          const { autoUpdater } = electronUpdater.default ?? electronUpdater;
          // Packager's prepackaged folder does not supply electron-builder's cache configuration.
          const updateConfigPath = join(app.getPath('userData'), 'pugport-updater.yml');
          await writeFile(
            updateConfigPath,
            JSON.stringify({
              provider: 'generic',
              url: WINDOWS_UPDATE_FEED,
              updaterCacheDirName: 'pugport-updater',
            }),
          );
          autoUpdater.updateConfigPath = updateConfigPath;
          autoUpdater.logger = null;
          appUpdater = new AppUpdater(autoUpdater, {
            enabled: async () => {
              const response = await backendRequest(origin + '/api/state', { signal: AbortSignal.timeout(3000) });
              if (!response.ok) return false;
              const state = (await response.json()) as AppState;
              return state.settings.updateCheck !== false;
            },
            requestQuit: (install) => desktop!.requestScriptedQuit(install),
            changed: () => {
              for (const window of BrowserWindow.getAllWindows())
                if (appWindows.has(window.webContents.id) && !window.isDestroyed())
                  window.webContents.send(APP_UPDATE_STATE_CHANNEL, appUpdater?.update);
            },
            error: (error) => console.warn('PugPort update unavailable:', error),
          });
          app.once('will-quit', () => appUpdater?.close());
        } catch (error) {
          console.warn('PugPort update unavailable:', error);
        }
      }
      const trustedUpdaterSender = (event: Electron.IpcMainInvokeEvent) =>
        appWindows.has(event.sender.id) && isAppMainFrame(event.sender, event.senderFrame, origin);
      ipcMain.handle(APP_UPDATE_STATE_CHANNEL, (event) =>
        trustedUpdaterSender(event) ? appUpdater?.update : undefined,
      );
      ipcMain.handle(APP_UPDATE_RESTART_CHANNEL, (event) => {
        if (trustedUpdaterSender(event)) return appUpdater?.restart();
      });
      // Mac only: one-click update. Elsewhere no handler exists and the page keeps the plain notice.
      const updateFeed = smokeDirectory ? undefined : macUpdateFeed({ packaged: app.isPackaged, env: process.env });
      if (updateFeed) {
        const owner = desktop;
        const updater = (macUpdater = new MacUpdater({
          feed: updateFeed,
          currentVersion: APP_VERSION,
          updatesDir: join(dataDir, 'updates'),
          target: () => macInstallTarget({ packaged: app.isPackaged, execPath: process.execPath }),
          quit: () => owner.requestQuit(),
          launch: (job) => startMacInstall(job),
          changed: (status) => {
            for (const window of BrowserWindow.getAllWindows()) {
              if (window.isDestroyed() || !isAppMainFrame(window.webContents, window.webContents.mainFrame, origin))
                continue;
              try {
                window.webContents.send(APP_UPDATE_STATUS_CHANNEL, status);
              } catch {
                /* A closing window misses one status. */
              }
            }
          },
        }));
        ipcMain.handle(APP_UPDATE_CHANNEL, (event, action: unknown) => {
          if (!isAppMainFrame(event.sender, event.senderFrame, origin)) throw new Error('Not allowed.');
          if (action === 'download') void updater.download();
          else if (action === 'install') return updater.install();
          return updater.state;
        });
      }
      desktop.window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) {
          conversationSelectionReady = false;
          reportProblemReady = false;
        }
      });
      desktop.window.webContents.on('render-process-gone', (_event, details) => {
        crashes?.record('renderer', details.reason, quitting || !!desktop?.exiting);
        reportProblemReady = false;
        conversationSelectionReady = false;
      });
      showState('正在启动…');
      ipcMain.handle(
        PERMISSION_CHANGE_CHANNEL,
        createPermissionChange(
          () => desktop?.window,
          origin,
          (window, options) => dialog.showMessageBox(window, options),
          (change, apply, expected) => backend!.changePermission(change, apply, expected),
        ),
      );
      try {
        await backend.start();
        if (failed || desktop.exiting) return;
        desktop.window.setTitle('PugPort');
        // The pug grabs its bone as the app opens: about a quarter of a second, never more than 350 ms.
        await Promise.race([
          desktop.window.webContents.executeJavaScript('window.pugportReady?.()').catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 350)),
        ]);
        while (!desktop.exiting) {
          if (backend.state.phase !== 'ready') await backend.start();
          try {
            await desktop.window.loadURL(origin);
            break;
          } catch (error) {
            // A ready child can crash during the opening animation or first
            // navigation. Wait for its bounded recovery instead of cancelling it.
            if (backend.state.phase !== 'recovering') throw error;
          }
        }
        if (desktop.exiting) return;
        workspaceLoaded = true;
        sendBackendState(backend.state);
        selectPendingConversation();
        const smoke = smokeDirectory;
        if (smoke) {
          const directory = resolve(smoke);
          try {
            const until = Date.now() + 45000;
            while (Date.now() < until) {
              const state = (await backendRequest(origin + '/api/state', { signal: AbortSignal.timeout(3000) }).then(
                (response) => response.json(),
              )) as { refreshing: boolean };
              if (!state.refreshing) break;
              await new Promise((done) => setTimeout(done, 500));
            }
            let workspaceReady = false;
            const rendererDeadline = Date.now() + 15000;
            while (Date.now() < rendererDeadline) {
              workspaceReady = await desktop.window.webContents.executeJavaScript(`(() => {
                const input = document.querySelector('#conversation-input');
                return !!document.querySelector('.connection-dot.connected') &&
                  !document.querySelector('.loading-page') && !!input &&
                  !input.disabled && !input.readOnly && input.getBoundingClientRect().height > 0;
              })()`);
              if (workspaceReady) break;
              await new Promise((done) => setTimeout(done, 100));
            }
            if (!workspaceReady) throw new Error('Desktop smoke: connected workspace did not become ready.');
            await desktop.window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
            // Hidden windows can report a ready DOM before their first composited frame reaches capturePage.
            await new Promise((done) => setTimeout(done, 500));
            const view = await desktop.window.webContents.executeJavaScript(
              '({title:document.title,text:document.body.innerText,width:innerWidth,height:innerHeight})',
            );
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'desktop.png'), (await desktop.window.webContents.capturePage()).toPNG());
            const resources = (await backendRequest(origin + '/api/state').then((response) => response.json())) as {
              app: { version: string };
              runtimes: { id: string; installed: boolean; status: string; models: unknown[]; capabilities: unknown }[];
            };
            await writeFile(
              join(directory, 'desktop-smoke.json'),
              JSON.stringify(
                {
                  at: new Date().toISOString(),
                  packaged: app.isPackaged,
                  hidden: !desktop.window.isVisible(),
                  desktopIntegration: !smokeDirectory,
                  versions: process.versions,
                  appVersion: resources.app.version,
                  title: view.title,
                  width: view.width,
                  height: view.height,
                  hasWorkspace: workspaceReady,
                  runtimes: resources.runtimes.map((runtime) => ({
                    id: runtime.id,
                    installed: runtime.installed,
                    status: runtime.status,
                    modelCount: runtime.models.length,
                    capabilities: runtime.capabilities,
                  })),
                  root,
                  dataDir,
                },
                null,
                2,
              ),
            );
          } catch (error) {
            smokeFailed = true;
            console.error('Packaged smoke validation failed:', error);
          } finally {
            await desktop.requestQuit();
          }
        }
      } catch (error) {
        clearEndpoint?.();
        if (desktop.exiting || backend.state.phase === 'stopping' || backend.state.phase === 'stopped') return;
        failed = true;
        showState(`本地后台无法启动或已断开。请确认端口 ${port} 没有被其他程序占用，再重新打开应用。`, true);
        await backend.stop().catch(() => {});
        if (smokeDirectory) {
          console.error('Packaged smoke backend failed:', error);
          app.exit(1);
          return;
        }
        await startupFailure(
          t('PugPort 后台不可用'),
          error instanceof Error ? t(error.message) : t('启动失败；不会连接已有的未知服务。'),
        );
      }
    })
    .catch(async (error) => {
      if (smokeDirectory) console.error('Packaged smoke startup failed:', error);
      else
        await startupFailure(
          'PugPort',
          error instanceof DataLocationError
            ? t('找不到 PugPort 的数据文件夹：{0}。请检查 {1}，或把文件夹放回原处。')
                .replace('{0}', () => error.path)
                .replace('{1}', '.data\\data-location.json') + `\n${error.message}`
            : error instanceof Error
              ? t(error.message)
              : t('桌面启动失败。'),
        );
      void (backend?.stop() ?? Promise.resolve()).finally(() => app.exit(1));
    });
  app.on('will-quit', (event) => {
    macUpdater?.close();
    account?.stop();
    quitting = true;
    clearEndpoint?.();
    desktop?.dispose();
    const partitions = webBridge?.partitions ?? [];
    webBridge?.dispose();
    projectTools?.dispose();
    // macOS asks before a newly signed build reads the account key; while that dialog is unanswered Electron's
    // shutdown never finishes. Everything above has already stopped, so write session data and end here.
    if (account?.keyringBusy) {
      event.preventDefault();
      console.warn('PugPort is exiting with an unanswered keychain request.');
      const sessions = [session.defaultSession, ...partitions.map((partition) => session.fromPartition(partition))];
      void flushThenExit({
        flush: sessions.flatMap((item) => [() => item.flushStorageData(), () => item.cookies.flushStore()]),
        exit: () => (process as unknown as { reallyExit(code: number): never }).reallyExit(0),
      });
    }
  });
}
