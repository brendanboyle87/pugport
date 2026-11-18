import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { electronModule } from './helpers/electron-harness.ts';
import { nextTurn } from './helpers/ui-harness.ts';

async function fixture(options: { quit?: boolean; lock?: boolean; root?: string; env?: NodeJS.ProcessEnv } = {}) {
  const calls: unknown[][] = [];
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => tmpdir(),
    getAppPath: () => {
      calls.push(['root']);
      return options.root ?? join(tmpdir(), 'pugport-quit-fixture');
    },
    requestSingleInstanceLock: (data: unknown) => {
      calls.push(['lock', data]);
      return options.lock !== false;
    },
    whenReady: async () => {
      calls.push(['ready']);
    },
    isPackaged: false,
    focus: () => undefined,
    quit: () => calls.push(['quit']),
    exit: (code: number) => calls.push(['exit', code]),
  });
  const desktop = {
    exiting: false,
    show: () => calls.push(['show']),
    requestScriptedQuit: async () => {
      calls.push(['scripted']);
      return false;
    },
    window: {
      isDestroyed: () => false,
      setTitle() {},
      loadURL: async () => {},
      webContents: Object.assign(new EventEmitter(), { executeJavaScript: async () => {}, send() {} }),
    },
  };
  await electronModule(
    'src/electron/main.ts',
    {
      app,
      crashReporter: { start() {} },
      ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
      session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} } } },
      dialog: {
        showMessageBox: async (options: { title: string; message: string }) => {
          calls.push(['error', options.title, options.message]);
          return { response: 0 };
        },
      },
    },
    {
      calls,
      desktop,
      process: {
        env: options.env ?? {},
        cwd: () => process.cwd(),
        platform: 'linux',
        argv: options.quit ? ['electron', '.', '--quit'] : [],
      },
      setTimeout: () => 0,
    },
    {
      './backend.ts': `export class OwnedBackend {
      state={phase:'ready'};
      constructor(){calls.push(['backend']);}
      async start(){calls.push(['start']);} async stop(){calls.push(['stop']);}
    }`,
      './shell.ts': "export const createDesktopShell=()=>{calls.push(['window']);return desktop;};",
      ...(options.root
        ? {}
        : { './data-directory.ts': "export const desktopDataDirectory=()=>{calls.push(['data']);return 'unused';};" }),
      './taskbar-identity.ts':
        'export const APP_USER_MODEL_ID="fixture",ensureTaskbarIdentity=()=>{},watchTaskbarIdentity=()=>()=>{};',
      './locale.ts': "export const restoreMainLocale=()=>{},t=(text)=>{calls.push(['translate',text]);return text;};",
      './page-test.ts': 'export const runPageTest=async()=>({});',
    },
  );
  await nextTurn();
  return { app, calls };
}

test('--quit sends additionalData and exits 0 without startup whether or not an app already has the lock', async () => {
  for (const lock of [true, false]) {
    const f = await fixture({ quit: true, lock });
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
      ['lock', { quit: true }],
      ['exit', 0],
    ]);
    assert.equal(f.app.listenerCount('second-instance'), 0);
  }
});

test('running app routes scripted quit by additionalData only, without showing or focusing the desktop', async () => {
  const f = await fixture();
  assert.ok(f.calls.some(([call]) => call === 'start'));
  f.calls.length = 0;
  f.app.emit('second-instance', {}, ['no-quit-argument'], '', { quit: true });
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['scripted']]);
  f.calls.length = 0;
  f.app.emit('second-instance', {}, ['--quit'], '', {});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['show']]);
});

test('bad data location shows one translated native error then exits 1 before backend or window creation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-desktop-data-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'explicit-stub');
  mkdirSync(target);
  writeFileSync(join(target, 'data-location.json'), '{');
  const f = await fixture({ root, env: { COMBORUNNER_DATA_DIR: target } });
  const errors = f.calls.filter(([call]) => call === 'error');
  assert.equal(errors.length, 1);
  assert.ok(
    String(errors[0]![2]).startsWith(
      `找不到 PugPort 的数据文件夹：${join(target, 'data-location.json')}。请检查 .data\\data-location.json，或把文件夹放回原处。\n`,
    ),
    String(errors[0]![2]),
  );
  assert.match(String(errors[0]![2]), /expected JSON/);
  assert.ok(
    f.calls.some(
      ([call, text]) =>
        call === 'translate' && text === '找不到 PugPort 的数据文件夹：{0}。请检查 {1}，或把文件夹放回原处。',
    ),
  );
  assert.equal(
    f.calls.some(([call]) => ['backend', 'window', 'start'].includes(String(call))),
    false,
  );
  assert.deepEqual(f.calls.at(-1), ['exit', 1]);
  assert.equal(existsSync(join(target, 'studio.sqlite')), false);
});

test('stale environment override shows the variable and moved destination in the native error', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pugport-desktop-stale-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, 'explicit-stub');
  mkdirSync(stub);
  const target = join(root, 'relocated');
  writeFileSync(join(stub, 'data-location.json'), JSON.stringify({ dataDir: target }));
  const f = await fixture({ root, env: { COMBORUNNER_DATA_DIR: stub } });
  const message = String(f.calls.find(([call]) => call === 'error')?.[2]);
  assert.ok(message.includes(`this data folder has moved to ${target}`));
  assert.ok(message.includes('COMBORUNNER_DATA_DIR'));
  assert.ok(message.includes('\nCannot find'));
  assert.equal(
    f.calls.some(([call]) => call === 'backend'),
    false,
  );
  assert.equal(existsSync(join(root, '.data/studio.sqlite')), false);
});
