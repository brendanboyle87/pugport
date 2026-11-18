import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { AppUpdater, nativeUpdatesEnabled, WINDOWS_UPDATE_FEED } from '../src/electron/app-updater.ts';
import { DesktopQuitController } from '../src/electron/lifecycle.ts';
import { usesNativeWindowsUpdater } from '../src/server/app-update-check.ts';

test('native checks replace GitHub only in packaged Windows; smoke never starts the native updater', () => {
  assert.equal(nativeUpdatesEnabled(true, 'win32', false), true);
  for (const [packaged, platform, smoke] of [
    [false, 'win32', false],
    [true, 'darwin', false],
    [true, 'win32', true],
  ] as const)
    assert.equal(nativeUpdatesEnabled(packaged, platform, smoke), false);
  assert.equal(usesNativeWindowsUpdater({ COMBORUNNER_PACKAGED: '1' }, 'win32'), true);
  assert.equal(usesNativeWindowsUpdater({}, 'win32'), false);
  assert.equal(usesNativeWindowsUpdater({ COMBORUNNER_PACKAGED: '1' }, 'darwin'), false);
});

test('electron-updater exposes its lazy autoUpdater getter through the CommonJS default export', async () => {
  const imported = await import('electron-updater');
  const updaterModule = imported.default ?? imported;
  // Inspect the getter without creating Electron's updater or accessing a real profile.
  assert.equal(typeof Object.getOwnPropertyDescriptor(updaterModule, 'autoUpdater')?.get, 'function');
});

test('silent checks, once-only errors, task guard and deferred install', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls: unknown[] = [];
  let enabled = true,
    active = 1;
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: (value: unknown) => calls.push(value),
    checkForUpdates: async () => {
      calls.push('check');
    },
    quitAndInstall: (silent: boolean, reopen: boolean) => calls.push(['install', silent, reopen]),
  });
  const quit = new DesktopQuitController({
    inspect: async () => ({ active, queued: 0, waitingApproval: 0, scheduled: 0 }),
    confirm: async () => {
      throw Error('must not prompt');
    },
    stop: async () => {
      calls.push('stop');
    },
    exit: (install) => {
      assert.equal(quit.mayCloseWindows, true);
      install?.();
    },
    error: (error) => {
      throw error;
    },
  });
  const controller = new AppUpdater(updater, {
    enabled: async () => enabled,
    requestQuit: (install) => quit.request('scripted', install),
    changed: () => calls.push('changed'),
    error: () => calls.push('error'),
  });
  try {
    assert.deepEqual(calls[0], { provider: 'generic', url: WINDOWS_UPDATE_FEED });
    assert.equal(updater.autoDownload && updater.autoInstallOnAppQuit, true);
    t.mock.timers.tick(29_999);
    await Promise.resolve();
    assert.equal(calls.includes('check'), false);
    t.mock.timers.tick(1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.filter((x) => x === 'check').length, 1);
    enabled = false;
    await controller.check();
    assert.equal(calls.filter((x) => x === 'check').length, 1);
    enabled = true;
    t.mock.timers.tick(6 * 60 * 60_000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.filter((x) => x === 'check').length, 2);
    updater.emit('error', Error('offline'));
    updater.emit('error', Error('offline'));
    assert.equal(calls.filter((x) => x === 'error').length, 1);
    updater.emit('update-downloaded', { version: '0.0.35' });
    assert.deepEqual(controller.update, { version: '0.0.35', status: 'ready' });
    await controller.restart();
    assert.equal(controller.update?.status, 'waiting');
    assert.equal(calls.includes('stop'), false);
    active = 0;
    t.mock.timers.tick(1000);
    for (let i = 0; i < 15; i++) await Promise.resolve();
    assert.deepEqual(calls.slice(-2), ['stop', ['install', true, true]]);
  } finally {
    controller.close();
  }
});
