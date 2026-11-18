import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BACKEND_STATE_CHANNEL,
  SELECT_CONVERSATION_CHANNEL,
  SELECT_CONVERSATION_READY_CHANNEL,
} from '../src/electron/channels.ts';
import { electronModule } from './helpers/electron-harness.ts';
import { nextTurn } from './helpers/ui-harness.ts';

async function fixture(argv: string[] = [], packaged = false, smoke = '') {
  let start!: () => void;
  let loaded!: () => void;
  const starting = new Promise<void>((done) => {
    start = done;
  });
  const loading = new Promise<void>((done) => {
    loaded = done;
  });
  const ipcMain = Object.assign(new EventEmitter(), { handle() {} });
  const frame = { url: 'http://127.0.0.1:4317/' };
  const events: unknown[][] = [];
  const registrations: string[] = [];
  const desktop = {
    exiting: false,
    show: () => events.push(['show']),
    window: {
      isDestroyed: () => false,
      setTitle() {},
      loadURL: async (url: string) => {
        if (url.startsWith('http:')) await loading;
      },
      webContents: Object.assign(new EventEmitter(), {
        mainFrame: frame,
        executeJavaScript: async () => {},
        send: (...args: unknown[]) => {
          if (args[0] !== BACKEND_STATE_CHANNEL) events.push(args);
        },
      }),
    },
  };
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => tmpdir(),
    getAppPath: () => resolve(tmpdir(), 'pugport-links-fixture'),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    isPackaged: packaged,
    setAsDefaultProtocolClient: (scheme: string) => registrations.push(scheme),
    quit() {},
    exit: () => assert.fail('unexpected exit'),
  });
  await electronModule(
    'src/electron/main.ts',
    {
      app,
      crashReporter: { start() {} },
      ipcMain,
      session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} } } },
      dialog: { showErrorBox: (title: string, message: string) => assert.fail(`${title}: ${message}`) },
    },
    {
      desktop,
      starting,
      process: { env: smoke ? { COMBORUNNER_SMOKE_DIR: smoke } : {}, platform: 'linux', argv },
      setTimeout: () => 0,
    },
    {
      './backend.ts': `export class OwnedBackend {
      state={phase:'ready'};
      async start(){await starting;}
      async stop(){}
    }`,
      './shell.ts': 'export const createDesktopShell=()=>desktop;',
      './data-directory.ts': 'export const desktopDataDirectory=()=>"unused";',
      './taskbar-identity.ts':
        'export const APP_USER_MODEL_ID="fixture",ensureTaskbarIdentity=()=>{},watchTaskbarIdentity=()=>()=>{};',
      './locale.ts': 'export const restoreMainLocale=()=>{},t=text=>text;',
      './web-bridge.ts': 'export class WebBridge {}',
      './page-test.ts': 'export const runPageTest=()=>{};',
    },
  );
  await nextTurn();
  const ready = (value = true) =>
    ipcMain.emit(SELECT_CONVERSATION_READY_CHANNEL, { sender: desktop.window.webContents, senderFrame: frame }, value);
  return { app, events, registrations, start, loaded, ready, ipcMain, desktop, frame };
}

test('first-launch links wait for listener readiness after workspace load, then show before selecting; second-instance works too', async () => {
  const f = await fixture(['app', 'pugport://conversation/first_1-2']);
  assert.equal(f.events.length, 0);
  f.start();
  await nextTurn();
  assert.equal(f.events.length, 0, 'backend ready alone is not workspace loaded');
  f.loaded();
  await nextTurn();
  assert.deepEqual(f.events, [], 'workspace load alone must not send');
  f.ready();
  assert.deepEqual(f.events, [['show'], [SELECT_CONVERSATION_CHANNEL, 'first_1-2']]);
  f.events.length = 0;
  f.app.emit('second-instance', {}, ['app', 'pugport://conversation/second']);
  assert.deepEqual(f.events.at(-1), [SELECT_CONVERSATION_CHANNEL, 'second']);
  assert.equal(f.events[0]?.[0], 'show');
});

test('a second-instance link arriving during startup is delivered after load', async () => {
  const f = await fixture();
  f.app.emit('second-instance', {}, ['pugport://conversation/queued']);
  f.app.emit('second-instance', {}, ['pugport://wrong/ignored']);
  assert.ok(f.events.every(([type]) => type === 'show'));
  f.start();
  f.loaded();
  await nextTurn();
  assert.ok(f.events.every(([type]) => type === 'show'));
  f.ready();
  assert.deepEqual(f.events.at(-1), [SELECT_CONVERSATION_CHANNEL, 'queued']);
});

test('macOS open-url queues cold-start links and selects warm links after renderer readiness', async () => {
  const f = await fixture();
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  f.app.emit('open-url', event, 'pugport://conversation/mac-cold');
  assert.equal(f.events.length, 0);
  f.app.emit('open-url', event, 'pugport://conversation/bad?extra=1');
  f.start();
  f.loaded();
  await nextTurn();
  assert.equal(f.events.length, 0);
  f.ready();
  assert.deepEqual(f.events, [['show'], [SELECT_CONVERSATION_CHANNEL, 'mac-cold']]);
  f.events.length = 0;
  f.app.emit('open-url', event, 'pugport://conversation/mac-warm');
  assert.deepEqual(f.events, [['show'], [SELECT_CONVERSATION_CHANNEL, 'mac-warm']]);
  f.events.length = 0;
  for (const url of ['https://example.test', 'pugport://conversation/id/extra', 'pugport://conversation/id\n'])
    f.app.emit('open-url', event, url);
  assert.deepEqual(f.events, []);
  assert.equal(prevented, 6);
});

test('first and second launch reject invalid IDs, hosts, extra parts and URL decorations', async () => {
  const invalid = [
    'pugport://conversation/',
    'pugport://conversation/a.b',
    `pugport://conversation/${'a'.repeat(101)}`,
    'pugport://other/id',
    'pugport://conversation/id/extra',
    'pugport://conversation/id/',
    'pugport://conversation/id?x=1',
    'pugport://conversation/id#x',
    'pugport://conversation/%61',
    'pugport://conversation/../id',
    'https://conversation/id',
    'pugport://conversation/id\n',
  ];
  const f = await fixture(invalid);
  f.start();
  f.loaded();
  await nextTurn();
  f.ready();
  assert.equal(f.events.length, 0);
  for (const link of invalid) f.app.emit('second-instance', {}, [link]);
  assert.ok(f.events.every(([type]) => type === 'show'));
  f.app.emit('second-instance', {}, [`pugport://conversation/${'a'.repeat(100)}`]);
  assert.deepEqual(f.events.at(-1), [SELECT_CONVERSATION_CHANNEL, 'a'.repeat(100)]);
});

test('protocol registration happens only in packaged non-smoke runs', async () => {
  for (const [packaged, smoke, expected] of [
    [false, '', []],
    [true, 'fixture-smoke', []],
    [true, '', ['pugport']],
  ] as const) {
    const f = await fixture([], packaged, smoke);
    assert.deepEqual(f.registrations, expected);
  }
});

test('readiness before load is retained, but navigation and unsubscribe reset it', async () => {
  const f = await fixture(['pugport://conversation/early']);
  f.ready();
  assert.equal(f.events.length, 0);
  f.start();
  f.loaded();
  await nextTurn();
  assert.deepEqual(f.events.at(-1), [SELECT_CONVERSATION_CHANNEL, 'early']);
  for (const reset of [
    () => f.ready(false),
    () => f.desktop.window.webContents.emit('did-start-navigation', {}, '', false, true),
    () => f.desktop.window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' }),
  ]) {
    reset();
    f.events.length = 0;
    f.app.emit('second-instance', {}, ['pugport://conversation/later']);
    assert.ok(f.events.every(([type]) => type === 'show'));
    f.ipcMain.emit(SELECT_CONVERSATION_READY_CHANNEL, { sender: {}, senderFrame: f.frame }, true);
    f.ipcMain.emit(
      SELECT_CONVERSATION_READY_CHANNEL,
      { sender: f.desktop.window.webContents, senderFrame: { url: f.frame.url } },
      true,
    );
    const original = f.frame.url;
    f.frame.url = 'https://example.test/';
    f.ready();
    f.frame.url = original;
    assert.ok(
      f.events.every(([type]) => type === 'show'),
      'untrusted readiness cannot deliver',
    );
    f.ready();
    assert.deepEqual(f.events.at(-1), [SELECT_CONVERSATION_CHANNEL, 'later']);
  }
});

test('preload announces readiness only after installing the conversation listener', async () => {
  let bridge: any;
  let listener: ((...args: unknown[]) => void) | undefined;
  const readiness: boolean[] = [];
  const selected: string[] = [];
  await electronModule(
    'src/electron/preload.ts',
    {
      contextBridge: {
        exposeInMainWorld: (_name: string, value: unknown) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        on: (_channel: string, handler: typeof listener) => {
          listener = handler;
        },
        off: () => {
          listener = undefined;
        },
        send: (channel: string, ready: boolean) => {
          assert.equal(channel, SELECT_CONVERSATION_READY_CHANNEL);
          assert.equal(!!listener, ready);
          readiness.push(ready);
          if (ready) listener!({}, 'first');
        },
      },
    },
    {
      process: { isMainFrame: true, argv: ['--combo-runner-origin=http://127.0.0.1:4317'] },
      location: { origin: 'http://127.0.0.1:4317' },
      window: { addEventListener() {} },
    },
  );
  assert.deepEqual(readiness, []);
  const unsubscribe = bridge.onSelectConversation((id: string) => selected.push(id));
  assert.deepEqual(selected, ['first']);
  unsubscribe();
  assert.deepEqual(readiness, [true, false]);
});
