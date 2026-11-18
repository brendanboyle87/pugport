import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAppearance } from '../src/electron/appearance.ts';
import { presetZoom, stepZoom, zoomPresets } from '../src/shared/appearance.ts';
import * as channels from '../src/electron/channels.ts';
import { electronModule, fakeSession } from './helpers/electron-harness.ts';

test('appearance store defaults, clamps to presets, persists theme and restores before first paint', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-appearance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nativeTheme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
  let store = createAppearance(dir, nativeTheme);
  assert.deepEqual(store.get(), { zoom: 1, theme: 'system' });
  for (const [value, expected] of [
    [-1, 0.8],
    [100, 1.5],
    [1.21, 1.25],
    [NaN, 1],
    [Infinity, 1],
  ])
    assert.equal(presetZoom(value), expected);
  for (const [index, value] of zoomPresets.entries()) {
    assert.equal(stepZoom(value, 1), zoomPresets[Math.min(index + 1, zoomPresets.length - 1)]);
    assert.equal(stepZoom(value, -1), zoomPresets[Math.max(index - 1, 0)]);
  }
  store.setZoom(1.24);
  store.setTheme('dark');
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'appearance.json'), 'utf8')), { zoom: 1.25, theme: 'dark' });
  nativeTheme.themeSource = 'system';
  store = createAppearance(dir, nativeTheme);
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.equal(store.setZoom(1), 1);
  store.setTheme('light');
  store.setTheme('invalid');
  assert.equal(nativeTheme.themeSource, 'light');
  store.setTheme('system');
  assert.equal(nativeTheme.themeSource, 'system');
  writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ zoom: 'bad', theme: 'bad' }));
  assert.deepEqual(createAppearance(dir, nativeTheme).get(), { zoom: 1, theme: 'system' });
});

test('fake windows receive saved zoom after navigation, shortcut changes, and native theme updates', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-appearance-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ zoom: 1.1, theme: 'dark' }));
  let systemDark = false;
  const nativeTheme = Object.assign(new EventEmitter(), { themeSource: 'system' });
  Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
    get: () => nativeTheme.themeSource === 'dark' || (nativeTheme.themeSource === 'system' && systemDark),
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const windows: Window[] = [];
  let menu: any[] = [];
  const session = fakeSession();
  class Contents extends EventEmitter {
    id = windows.length + 1;
    session = session;
    mainFrame = { url: 'http://127.0.0.1:4317/' };
    setWebRTCIPHandlingPolicy() {}
    zoom = 1;
    messages: unknown[][] = [];
    setZoomFactor(value: number) {
      this.zoom = value;
    }
    setWindowOpenHandler() {}
    send(...args: unknown[]) {
      this.messages.push(args);
    }
    getURL() {
      return 'http://127.0.0.1:4317/';
    }
    isDestroyed() {
      return false;
    }
  }
  class Window extends EventEmitter {
    webContents = new Contents();
    background = '';
    constructor(readonly options: any) {
      super();
      assert.equal(nativeTheme.themeSource, 'dark', 'saved theme applied before construction');
      windows.push(this);
    }
    setBackgroundColor(color: string) {
      this.background = color;
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    getBounds() {
      return { height: 900 };
    }
    async loadURL(url: string) {
      this.webContents.emit('did-navigate', {}, url);
    }
    destroy() {
      this.emit('closed');
    }
  }
  const { createDesktopShell } = await electronModule(
    'src/electron/shell.ts',
    {
      app: Object.assign(new EventEmitter(), {
        getPath: () => dir,
        commandLine: { getSwitchValue: () => '', appendSwitch() {} },
      }),
      BrowserWindow: Window,
      Tray: class extends EventEmitter {
        setToolTip() {}
        destroy() {}
      },
      nativeImage: { createFromBitmap: () => ({}) },
      nativeTheme,
      powerSaveBlocker: { start: () => 1, stop() {} },
      Menu: {
        buildFromTemplate: (value: any[]) => {
          menu = value;
          return value;
        },
        setApplicationMenu() {},
      },
      ipcMain: Object.assign(new EventEmitter(), {
        handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
        removeHandler: (channel: string) => handlers.delete(channel),
      }),
    },
    {},
    {
      './taskbar-identity.ts': 'export const applyTaskbarIdentity=()=>{};',
      './context-menu.ts': 'export const attachContextMenu=()=>{};',
      './window-activity.ts': 'export const createWindowActivity=()=>({title(){},dispose(){}});',
      './tray.ts': 'export const attachTray=()=>({dispose(){}}),launchAtLogin=()=>false,trayIcon=()=>undefined;',
      './blackout.ts': 'export const createBlackout=()=>undefined,DEFAULT_BLACKOUT_SHORTCUT="synthetic";',
      './quick-chat.ts': 'export const createQuickChat=()=>undefined;',
    },
  );
  const desktop = createDesktopShell({
    dataDir: 'synthetic',
    diagnosticInfo: async () => ({}),
    reportProblem: async () => {},
    takeCrashRecord: () => undefined,
    origin: 'http://127.0.0.1:4317',
    preload: 'synthetic',
    backend: { inspect: async () => ({}), stop: async () => {} },
  });
  t.after(() => desktop.dispose());
  const window = windows[0]!;
  assert.equal(window.options.backgroundColor, '#121316');
  assert.equal(window.background, '#121316');
  assert.equal(window.webContents.zoom, 1.1);
  window.webContents.zoom = 1;
  await window.loadURL('data:text/html,splash');
  assert.equal(window.webContents.zoom, 1);
  await window.loadURL('http://127.0.0.1:4317/');
  assert.equal(window.webContents.zoom, 1.1);
  const event = { senderFrame: window.webContents.mainFrame, sender: window.webContents };
  const call = (channel: string, value?: unknown) => handlers.get(channel)!(event, value);
  await call(channels.OPEN_WINDOW_CHANNEL, 'synthetic-chat');
  assert.equal(windows.length, 2);
  assert.equal(windows[1]!.webContents.zoom, 1.1);
  assert.equal(call(channels.ZOOM_GET_CHANNEL), 1.1);
  call(channels.ZOOM_SET_CHANNEL, 0.9);
  const items = menu.flatMap((group) => group.submenu ?? []);
  items.find((item) => item.accelerator === 'CommandOrControl+=').click();
  assert.equal(window.webContents.zoom, 1);
  assert.equal(windows[1]!.webContents.zoom, 1);
  items.find((item) => item.accelerator === 'CommandOrControl+-').click();
  assert.equal(window.webContents.zoom, 0.9);
  items.find((item) => item.accelerator === 'CommandOrControl+0').click();
  assert.equal(window.webContents.zoom, 1);
  assert.deepEqual(window.webContents.messages.at(-1), [channels.ZOOM_CHANGED_CHANNEL, 1]);
  call(channels.THEME_SET_CHANNEL, 'light');
  nativeTheme.emit('updated');
  assert.equal(window.background, '#F3F3F5');
  assert.equal(windows[1]!.background, '#F3F3F5');
  call(channels.THEME_SET_CHANNEL, 'system');
  systemDark = true;
  nativeTheme.emit('updated');
  assert.equal(window.background, '#121316');
  assert.equal(windows[1]!.background, '#121316');
  handlers.get(channels.ZOOM_SET_CHANNEL)!(
    { sender: window.webContents, senderFrame: { url: 'https://example.test/' } },
    1.5,
  );
  assert.equal(window.webContents.zoom, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'appearance.json'), 'utf8')).theme, 'system');
});
