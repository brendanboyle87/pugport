import assert from 'node:assert/strict';
import test from 'node:test';
import * as channels from '../src/electron/channels.ts';
import * as desktop from '../src/ui/desktop.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import en from '../src/shared/i18n/en.json' with { type: 'json' };
import { electronModule } from './helpers/electron-harness.ts';

const recovering = { phase: 'recovering' as const, message: '本地后台意外退出，正在自动恢复（第 2 次）。' };
const stopped = 'PugPort 后台服务在 3 次重启失败后已停止。请打开日志文件夹，然后重新打开 PugPort。';

test('only loaded workspaces receive recovery, failure and ready state', () => {
  for (const phase of ['idle', 'starting', 'recovering', 'ready', 'error', 'stopping', 'stopped'] as const) {
    const state = { phase, message: 'fixture' };
    assert.equal(channels.backendWindowState(state, false), undefined);
    assert.deepEqual(
      channels.backendWindowState(state, true),
      ['recovering', 'error', 'ready'].includes(phase) ? state : undefined,
    );
  }
});

test('recovery notices retain attempts, failure explains the stopped restart, and ready clears', () => {
  assert.deepEqual(desktop.backendStateNotice(recovering), { tone: 'info', message: recovering.message });
  assert.deepEqual(desktop.backendStateNotice({ phase: 'error', message: 'cleanup failed' }), {
    tone: 'error',
    message: 'cleanup failed',
  });
  assert.equal(
    desktop.backendStateNotice({ phase: 'error', message: stopped.replace('3', '2') })?.message,
    stopped.replace('3', '2'),
  );
  assert.equal(desktop.backendStateNotice({ phase: 'ready' }), null);
  const translate = createTranslator(en);
  assert.equal(translate(recovering.message), 'The local backend stopped unexpectedly. Reconnecting (attempt 2)…');
  assert.equal(
    translate(stopped),
    "PugPort's background service stopped after 3 failed restarts. Open the log folder, then reopen PugPort.",
  );
});

test('backend failure offers a local log action and copies only after a click', async () => {
  let opened = 0;
  let read = 0;
  const bridge = {
    pickDirectory: async () => null,
    openLogFolder: async () => {
      opened++;
      return '';
    },
    diagnosticInfo: async () => {
      read++;
      return { version: '0.0.34', os: 'win32' };
    },
  };
  const notice = desktop.backendStateNotice({ phase: 'error' }, bridge, () => {})!;
  assert.equal(opened, 0);
  assert.equal(read, 0);
  assert.equal(notice.action?.label, '打开日志文件夹');
  assert.equal(notice.secondaryAction?.label, '复制诊断信息');
  await notice.action!.run();
  assert.equal(opened, 1);
});

test('preload subscribes before requesting the current backend state and removes its listener', async () => {
  assert.equal(channels.BACKEND_STATE_CHANNEL, 'combo-runner:backend-state');
  assert.equal(channels.BACKEND_STATE_READY_CHANNEL, 'combo-runner:backend-state-ready');
  let bridge: any;
  let handler: ((event: unknown, state: unknown) => void) | undefined;
  const received: unknown[] = [];
  await electronModule(
    'src/electron/preload.ts',
    {
      contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => (bridge = value) },
      ipcRenderer: {
        on: (channel: string, listener: typeof handler) => {
          assert.equal(channel, channels.BACKEND_STATE_CHANNEL);
          handler = listener;
        },
        off: (channel: string, listener: typeof handler) => {
          assert.equal(channel, channels.BACKEND_STATE_CHANNEL);
          assert.equal(listener, handler);
          handler = undefined;
        },
        send: (channel: string) => {
          assert.equal(channel, channels.BACKEND_STATE_READY_CHANNEL);
          assert.ok(handler, 'listener must exist before the snapshot can arrive');
          handler({}, recovering);
        },
      },
    },
    {
      process: { isMainFrame: true, argv: ['--combo-runner-origin=http://127.0.0.1:4317'] },
      location: { origin: 'http://127.0.0.1:4317' },
      window: { addEventListener() {} },
    },
  );
  const unsubscribe = bridge.onBackendState((state: unknown) => received.push(state));
  handler!({}, { phase: 'ready' });
  assert.deepEqual(received, [recovering, { phase: 'ready' }]);
  unsubscribe();
  assert.equal(handler, undefined);
});
