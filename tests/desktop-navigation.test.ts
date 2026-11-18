import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLACKOUT_CHANNEL,
  FOCUS_MAIN_CHANNEL,
  REVEAL_PATH_CHANNEL,
  SELECT_CONVERSATION_CHANNEL,
  OPEN_EDITOR_CHANNEL,
  OPEN_LOG_FOLDER_CHANNEL,
  DIAGNOSTIC_INFO_CHANNEL,
  REPORT_PROBLEM_CHANNEL,
  TAKE_CRASH_RECORD_CHANNEL,
  CLEAR_CRASH_RECORD_CHANNEL,
} from '../src/electron/channels.ts';
import { electronModule, fakeSession } from './helpers/electron-harness.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

async function desktopNavigation(platform: string) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const rendererListeners = new Map<string, (...args: any[]) => unknown>();
  let bridge: any;
  const frame = { url: 'http://127.0.0.1:4317/' };
  const ipc = new EventEmitter();
  let nativeQuestions = 0;
  let reports = 0;
  let crashReads = 0;
  let crashClears = 0;
  const trayActions: { reportProblem?: () => void } = {};
  let uncResponse = 0;
  const pathEvents: string[] = [];
  let stopped = 0;
  let applicationMenu: any[] = [];
  const editorUrls: string[] = [];
  let editorMissing = false;
  const session = fakeSession();
  let nextContentsId = 0;
  class Contents extends EventEmitter {
    id = ++nextContentsId;
    session = session;
    setWebRTCIPHandlingPolicy() {}
    setZoomFactor() {}
    mainFrame = frame;
    isDestroyed() {
      return false;
    }
    setWindowOpenHandler() {}
    send(channel: string, ...args: unknown[]) {
      rendererListeners.get(channel)?.({}, ...args);
    }
  }
  class Window extends EventEmitter {
    setBackgroundColor() {}
    webContents = new Contents();
    shown = false;
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    show() {
      this.shown = true;
    }
    focus() {}
    destroy() {}
    getBounds() {
      return { height: 900 };
    }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    destroy() {}
  }
  const app = Object.assign(new EventEmitter(), {
    quit() {},
    getPath: () => 'fixture-missing-user-data',
    commandLine: { getSwitchValue: () => '', appendSwitch() {} },
  });
  const shell = await electronModule(
    'src/electron/shell.ts',
    {
      app,
      screen: { on() {}, off() {} },
      globalShortcut: { register: () => true, unregister() {} },
      powerSaveBlocker: { start: () => 1, stop() {} },
      BrowserWindow: Window,
      Tray,
      dialog: {
        showMessageBox: async (options: any) => {
          if (options.message === '确定连接这台网络电脑？') {
            pathEvents.push('confirm');
            assert.match(options.detail, /Windows.*登录凭据/);
            assert.equal(options.defaultId, 0);
            assert.equal(options.cancelId, 0);
            return { response: uncResponse };
          }
          nativeQuestions++;
          return { response: 0 };
        },
      },
      nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
      shell: {
        openExternal: async (url: string) => {
          if (editorMissing) throw new Error('fixture editor missing');
          editorUrls.push(url);
        },
        openPath: async () => {
          pathEvents.push('open');
          return '';
        },
        showItemInFolder: () => pathEvents.push('select'),
      },
      nativeImage: { createFromBitmap: () => ({}) },
      Menu: {
        buildFromTemplate: (template: any[]) => {
          applicationMenu = template;
          return {};
        },
        setApplicationMenu() {},
      },
      ipcMain: {
        on: ipc.on.bind(ipc),
        off: ipc.off.bind(ipc),
        handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
      },
    },
    {
      process: { ...process, platform },
      trayActions,
      fixtureStat: async () => {
        pathEvents.push('stat');
        return { isDirectory: () => true };
      },
    },
    {
      './tray.ts':
        'export const attachTray=(options)=>{Object.assign(trayActions,options);return {dispose(){}};},launchAtLogin=()=>false,trayIcon=()=>undefined;',
      'node:path': `import { posix, win32 } from 'path';
          export const { isAbsolute, join, resolve, dirname, basename, extname, relative, normalize, parse, format, sep, delimiter, toNamespacedPath } = ${platform === 'win32' ? 'win32' : 'posix'};`,
      'node:os': 'export const hostname=()=>"fixture-PC";',
      'node:fs/promises': 'export const stat=(value)=>globalThis.fixtureStat(value); export const mkdir=async()=>{};',
    },
  );
  const desktop = shell.createDesktopShell({
    dataDir: 'synthetic',
    diagnosticInfo: async () => ({}),
    reportProblem: async () => {
      reports++;
    },
    clearCrashRecord: () => {
      crashClears++;
    },
    takeCrashRecord: () => {
      crashReads++;
      return undefined;
    },
    origin: 'http://127.0.0.1:4317',
    preload: 'fixture',
    backend: {
      inspect: async () => ({ active: 1, queued: 0, waitingApproval: 0, scheduled: 0 }),
      stop: async () => {
        stopped++;
      },
    },
    exit() {},
  });
  const reveal = handlers.get(REVEAL_PATH_CHANNEL)!;
  if (platform === 'darwin') {
    const submenu = applicationMenu[0].submenu;
    for (const role of ['hide', 'hideOthers', 'unhide']) assert.ok(submenu.some((item: any) => item.role === role));
    assert.ok(applicationMenu.some((item) => item.role === 'windowMenu'));
    const quitItem = submenu.find((item: any) => item.label === '退出 PugPort');
    assert.equal(quitItem.accelerator, 'Command+Q');
    quitItem.click();
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(nativeQuestions, 1, 'Command+Q goes through the existing task-aware quit confirmation');
    assert.equal(stopped, 0, 'cancelling the Mac menu quit keeps the backend alive');
    nativeQuestions = 0;
  }
  const ownEvent = { sender: desktop.window.webContents, senderFrame: frame };
  const foreignEvent = { ...ownEvent, senderFrame: { url: 'https://foreign.example' } };
  const help = applicationMenu.find((item) => item.label === '帮助');
  assert.equal(help.submenu.length, 1);
  help.submenu[0].click();
  assert.equal(reports, 1);
  await handlers.get(REPORT_PROBLEM_CHANNEL)!(foreignEvent);
  assert.equal(reports, 1);
  await handlers.get(REPORT_PROBLEM_CHANNEL)!(ownEvent);
  assert.equal(reports, 2);
  trayActions.reportProblem!();
  assert.equal(reports, 3, 'tray, menu and IPC use the same report callback');
  assert.equal(await handlers.get(DIAGNOSTIC_INFO_CHANNEL)!(foreignEvent), undefined);
  assert.deepEqual(await handlers.get(DIAGNOSTIC_INFO_CHANNEL)!(ownEvent), {});
  assert.equal(await handlers.get(OPEN_LOG_FOLDER_CHANNEL)!(foreignEvent, '/tmp/arbitrary'), 'invalid');
  handlers.get(TAKE_CRASH_RECORD_CHANNEL)!({ ...ownEvent, sender: new Contents() });
  assert.equal(crashReads, 0, 'a secondary app window cannot consume the crash notice');
  handlers.get(TAKE_CRASH_RECORD_CHANNEL)!(ownEvent);
  assert.equal(crashReads, 1);
  await handlers.get(CLEAR_CRASH_RECORD_CHANNEL)!(foreignEvent);
  await handlers.get(CLEAR_CRASH_RECORD_CHANNEL)!({ ...ownEvent, sender: new Contents() });
  assert.equal(crashClears, 0);
  await handlers.get(CLEAR_CRASH_RECORD_CHANNEL)!(ownEvent);
  assert.equal(crashClears, 1);
  if (platform === 'win32') {
    for (const path of [
      String.raw`\\nas\share\x`,
      String.raw`\\?\UNC\nas\share\x`,
      '//nas/share/x',
      String.raw`\\nas`,
    ]) {
      pathEvents.length = 0;
      uncResponse = 0;
      assert.equal(await reveal(ownEvent, path), 'cancelled');
      assert.deepEqual(pathEvents, ['confirm'], 'cancel never stats or opens the remote host');
      pathEvents.length = 0;
      uncResponse = 1;
      assert.equal(await reveal(ownEvent, path), 'ok');
      assert.deepEqual(pathEvents, ['confirm', 'stat', 'open']);
    }
    for (const path of [String.raw`\\LOCALHOST\C$\x`, String.raw`\\FIXTURE-pc\share\x`, 'C:/fixture/x']) {
      pathEvents.length = 0;
      assert.equal(await reveal(ownEvent, path), 'ok');
      assert.deepEqual(pathEvents, ['stat', 'open']);
    }
    pathEvents.length = 0;
    assert.equal(
      await reveal(
        { sender: desktop.window.webContents, senderFrame: { url: 'https://example.test/' } },
        String.raw`\\nas\share\x`,
      ),
      'invalid',
    );
    assert.deepEqual(pathEvents, []);
  }
  await electronModule(
    'src/electron/preload.ts',
    {
      contextBridge: {
        exposeInMainWorld: (_: string, value: unknown) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        send: (channel: string, ...args: unknown[]) =>
          ipc.emit(channel, { sender: desktop.window.webContents, senderFrame: frame }, ...args),
        invoke: (channel: string, ...args: unknown[]) =>
          Promise.resolve(handlers.get(channel)?.({ sender: desktop.window.webContents, senderFrame: frame }, ...args)),
        on: (channel: string, listener: (...args: any[]) => unknown) => rendererListeners.set(channel, listener),
        off: (channel: string) => rendererListeners.delete(channel),
      },
    },
    {
      process: { argv: ['--combo-runner-origin=http://127.0.0.1:4317'], isMainFrame: true },
      location: { origin: 'http://127.0.0.1:4317' },
      window: { addEventListener() {} },
    },
  );
  const reportReady: boolean[] = [];
  ipc.on('combo-runner:report-problem-ready', (_event, value) => reportReady.push(value));
  const stopReportOne = bridge.onReportProblem(() => {});
  const stopReportTwo = bridge.onReportProblem(() => {});
  stopReportOne();
  stopReportOne();
  assert.deepEqual(reportReady, [true], 'a remaining report listener stays ready');
  stopReportTwo();
  assert.deepEqual(reportReady, [true, false]);
  const safePath = platform === 'win32' ? 'C:\\fixture\\图片 # ? %.ts' : '/Users/fixture/图片 # ? %.ts';
  for (const editor of ['vscode', 'cursor']) {
    assert.equal(await bridge.openEditor({ editor, path: safePath }), 'ok');
    assert.equal(
      editorUrls.at(-1),
      `${editor}://file/${safePath.replaceAll('\\', '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/')}`,
    );
  }
  assert.match(editorUrls[0]!, /%20%23%20%3F%20%25/);
  const opened = editorUrls.length;
  for (const value of [
    null,
    {},
    { editor: 'cmd', path: safePath },
    { editor: 'vscode', path: 123 },
    ...[
      'relative.txt',
      '\\host\\share\\x',
      ...(platform === 'win32' ? ['/host/share/x', '\\??\\C:\\x'] : []),
      'C:foo',
      '\\\\server\\share\\a',
      '//server/share/a',
      '\\\\?\\C:\\a',
      `${safePath}\0`,
      `${safePath}"`,
      `${safePath}'`,
    ].map((path) => ({ editor: 'vscode', path })),
  ])
    assert.equal(await bridge.openEditor(value), 'invalid');
  assert.equal(
    await handlers.get(OPEN_EDITOR_CHANNEL)!(
      { sender: desktop.window.webContents, senderFrame: { url: 'https://example.test/' } },
      { editor: 'vscode', path: safePath },
    ),
    'invalid',
  );
  assert.equal(editorUrls.length, opened);
  editorMissing = true;
  assert.equal(await bridge.openEditor({ editor: 'cursor', path: safePath }), 'failed');
  assert.equal(await desktop.requestQuit(), false, 'before the host is ready, native fallback cancels');
  assert.equal(nativeQuestions, 1);
  let finish!: (answer: boolean) => void;
  const unsubscribe = bridge.onConfirmation((options: any) => {
    assert.equal(options.action, '退出 PugPort');
    assert.match(options.points.join('\n'), /正在执行：1/);
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  const cancelledQuit = desktop.requestQuit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, 0, 'backend stays alive while awaiting the in-app answer');
  finish(false);
  assert.equal(await cancelledQuit, false);
  assert.equal(nativeQuestions, 1, 'ready renderer replaces the native dialog');
  const acceptedQuit = desktop.requestQuit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish(true);
  assert.equal(await acceptedQuit, true);
  assert.equal(stopped, 1);
  unsubscribe();
  const stamp = '2026-10-03T12:00:00Z';
  const conversation = { id: 'a', projectId: 'p', title: 'A', createdAt: stamp, updatedAt: stamp };
  const run = {
    id: 'run-a',
    status: 'completed',
    prompt: 'Fixture run',
    route: { model: 'fixture' },
    startedAt: stamp,
  };
  const state = {
    projects: [],
    conversations: [conversation],
    workflows: [],
    runs: [run],
    runtimes: [],
    targets: [],
    app: { version: 'test' },
    settings: {},
    approvals: [],
  };
  const code = await uiBundle('src/ui/Studio.tsx', true);
  const lateConversation = { ...conversation, id: 'late', title: 'Created in quick chat' };
  const backend = {
    state,
    api: async (path: string) => {
      assert.equal(path, '/api/conversations/late?recordOnly=1');
      return { conversation: lateConversation };
    },
    reload: async () => {},
    connection: 'connected',
  };
  const main = uiHarness(code, {
    __backend: backend,
    window: {
      comboRunnerDesktop: bridge,
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  main.render('default');
  const popout = uiHarness(code, {
    __backend: backend,
    location: { search: '?view=conversation&id=a' },
    window: {
      comboRunnerDesktop: { ...bridge, onSelectConversation: undefined },
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  const workspace = findNode(popout.render('default'), (node) => node.type?.name === 'ConversationWorkspace');
  assert.ok(workspace);
  await workspace.props.onInspect('run-a');
  const details = findNode(main.render('default'), (node) => node.type?.name === 'RunOutput');
  assert.equal(details?.props.run?.id, 'run-a');
  assert.equal(desktop.window.shown, true);
  await bridge.focusMain('late');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const latePanes = findNode(main.render('default'), (node) => node.type?.name === 'SplitView');
  assert.equal(latePanes?.props.ids[0], 'late');
  const lateWorkspace = latePanes!.props.children('late', 0);
  assert.equal(
    lateWorkspace?.props.conversation?.id,
    'late',
    'quick-chat navigation works before the SSE snapshot arrives',
  );
  // An untrusted sender cannot drive navigation, and malformed run IDs cannot be forwarded.
  let forwarded: any[] = [];
  rendererListeners.set(SELECT_CONVERSATION_CHANNEL, (...args) => {
    forwarded = args;
  });
  handlers.get(FOCUS_MAIN_CHANNEL)!(
    { sender: desktop.window.webContents, senderFrame: { url: 'https://example.test/' } },
    'a',
    'run-a',
  );
  assert.equal(forwarded.length, 0);
  handlers.get(FOCUS_MAIN_CHANNEL)!(ownEvent, 'a', '../invalid');
  assert.equal(forwarded[2], undefined);
  main.unmount();
  popout.unmount();
  desktop.dispose();
}

for (const platform of ['win32', 'linux', 'darwin'])
  test(`popout navigation and editor paths work on ${platform}`, () => desktopNavigation(platform));

test('quitting during blackout closes the covers without rebuilding them and keeps the restart marker', async (t) => {
  const userData = mkdtempSync(join(tmpdir(), 'pugport-quit-blackout-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const frame = { url: 'http://127.0.0.1:4317/' };
  const windows: Window[] = [];
  let exits = 0;
  const session = fakeSession();
  let nextContentsId = 0;
  class Contents extends EventEmitter {
    id = ++nextContentsId;
    session = session;
    setWebRTCIPHandlingPolicy() {}
    setZoomFactor() {}
    mainFrame = frame;
    isDestroyed() {
      return false;
    }
    setWindowOpenHandler() {}
  }
  class Window extends EventEmitter {
    setBackgroundColor() {}
    webContents = new Contents();
    destroyed = false;
    constructor(readonly options?: unknown) {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    isFocused() {
      return true;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    loadURL() {
      return new Promise<void>(() => {});
    }
    show() {}
    focus() {}
    getBounds() {
      return { height: 900 };
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const app = Object.assign(new EventEmitter(), {
    quit() {},
    getPath: () => userData,
    commandLine: { getSwitchValue: () => '', appendSwitch() {} },
  });
  const shell = await electronModule(
    'src/electron/shell.ts',
    {
      app,
      screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display }),
      globalShortcut: { register: () => true, unregister() {} },
      powerSaveBlocker: { start: () => 1, stop() {} },
      BrowserWindow: Window,
      Tray: class extends EventEmitter {
        setToolTip() {}
        destroy() {}
      },
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
      shell: {},
      nativeImage: { createFromBitmap: () => ({}) },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
      ipcMain: {
        on() {},
        off() {},
        handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
      },
    },
    { process },
    {
      './tray.ts': 'export const attachTray=()=>({dispose(){}}),launchAtLogin=()=>false,trayIcon=()=>undefined;',
    },
  );
  const desktop = shell.createDesktopShell({
    dataDir: 'synthetic',
    diagnosticInfo: async () => ({}),
    reportProblem: async () => {},
    takeCrashRecord: () => undefined,
    origin: 'http://127.0.0.1:4317',
    preload: 'fixture',
    backend: {
      inspect: async () => ({ active: 0, queued: 0, waitingApproval: 0, scheduled: 0 }),
      stop: async () => {},
    },
    exit() {
      exits++;
    },
  });
  handlers.get(BLACKOUT_CHANNEL)!({ sender: desktop.window.webContents, senderFrame: frame });
  const covers = windows.slice(1);
  assert.equal(covers.length, 1);
  assert.equal(covers[0]!.destroyed, false);
  await desktop.requestQuit();
  assert.equal(exits, 1);
  assert.equal(covers[0]!.destroyed, true);
  assert.equal(windows.length, 2, 'closing the covers during quit must not rebuild them');
  // Normal quit keeps the marker, stamped with the exit time, so a quick restart returns to blackout.
  const saved = JSON.parse(readFileSync(join(userData, 'power-state.json'), 'utf8'));
  assert.equal(saved.blackout, true);
  assert.equal(typeof saved.blackoutExitedAt, 'number');
  desktop.dispose();
});

test('desktop permission errors strip only the Electron transport prefix', async () => {
  let bridge: any;
  let message = "Error invoking remote method 'permission-change': Error: 学习记录已变化，请刷新后重试。";
  await electronModule(
    'src/electron/preload.ts',
    {
      contextBridge: {
        exposeInMainWorld: (_: string, value: unknown) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        invoke: async () => {
          throw new Error(message);
        },
      },
    },
    {
      Error,
      process: { argv: ['--combo-runner-origin=http://127.0.0.1:4317'], isMainFrame: true },
      location: { origin: 'http://127.0.0.1:4317' },
      window: { addEventListener() {} },
    },
  );
  await assert.rejects(bridge.changePermission({}), { message: '学习记录已变化，请刷新后重试。' });
  message = 'Already readable';
  await assert.rejects(bridge.changePermission({}), { message });
});
