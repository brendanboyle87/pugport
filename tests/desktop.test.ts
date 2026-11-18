import { productionPaths } from './helpers/production-paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('update quit callback stays behind the scripted task guard and backend cleanup', async () => {
  let active = 1;
  const calls: string[] = [];
  const quit = new DesktopQuitController({
    inspect: async () => ({ active, queued: 0, waitingApproval: 0, scheduled: 0 }),
    confirm: async () => {
      throw Error('update must not prompt to kill work');
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
  const install = () => {
    calls.push('install');
  };
  assert.equal(await quit.request('scripted', install), false);
  assert.equal(calls.length, 0);
  assert.equal(quit.mayCloseWindows, false);
  active = 0;
  assert.equal(await quit.request('scripted', install), true);
  assert.deepEqual(calls, ['stop', 'install']);
});
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogReturnValue } from 'electron';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnedBackend } from '../src/electron/backend.ts';
import { desktopDataDirectory } from '../src/electron/data-directory.ts';
import {
  DesktopQuitController,
  isQuitInspection,
  needsQuitConfirmation,
  quitDescription,
  scriptedQuitReason,
  type QuitState,
} from '../src/electron/lifecycle.ts';
import { createDirectoryPicker, createFilesPicker } from '../src/electron/directory-picker.ts';
import { APP_NAME, APP_VERSION } from '../src/shared/identity.ts';

const zero = { active: 0, queued: 0, waitingApproval: 0, scheduled: 0 };

test('scripted quit refuses active, queued, approval, incognito and unknown states; allows scheduled-only and idle', () => {
  assert.equal(scriptedQuitReason(zero), undefined);
  assert.equal(scriptedQuitReason({ ...zero, scheduled: 10 }), undefined);
  for (const key of ['active', 'queued', 'waitingApproval']) assert.ok(scriptedQuitReason({ ...zero, [key]: 1 }));
  assert.match(scriptedQuitReason({ ...zero, incognito: ['private'] })!, /incognito/);
  assert.match(scriptedQuitReason('unknown')!, /unknown/);
});

test('scripted quit never uses dialogs, stops before exit only when safe, and logs refusals once', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  for (const state of [
    zero,
    { ...zero, scheduled: 10 },
    { ...zero, active: 1 },
    { ...zero, incognito: ['private'] },
    'unknown',
  ] as QuitState[]) {
    const calls: string[] = [];
    const quit = new DesktopQuitController({
      inspect: async () => {
        if (state === 'unknown') throw Error('offline');
        return state;
      },
      confirm: async () => assert.fail('scripted quit must never confirm'),
      stop: async () => {
        calls.push('stop');
      },
      exit: () => {
        calls.push('exit');
      },
      error: () => assert.fail('scripted quit must never show an error box'),
    });
    const safe = state !== 'unknown' && !state.active && !state.incognito?.length;
    const previousWarnings = warnings.length;
    assert.equal(await quit.request('scripted'), safe);
    assert.deepEqual(calls, safe ? ['stop', 'exit'] : []);
    assert.equal(warnings.length - previousWarnings, safe ? 0 : 1);
  }
  const broken = new DesktopQuitController({
    inspect: async () => zero,
    confirm: async () => assert.fail('no dialog'),
    stop: async () => {
      throw Error('cleanup failed');
    },
    exit: () => assert.fail('must keep running'),
    error: () => assert.fail('no error box'),
  });
  assert.equal(await broken.request('scripted'), false);
  assert.match(warnings.at(-1)!, /cleanup failed/);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
class FakeChild extends EventEmitter {
  pid = 987654;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = { resume() {} };
  stderr = { resume() {} };
  messages: Record<string, unknown>[] = [];
  send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
    this.messages.push(message);
    callback?.(null);
  }
  finish(code = 0) {
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code, null);
  }
}
function backendFixture(
  options: {
    startupMs?: number;
    inspectionMs?: number;
    shutdownMs?: number;
    terminate?: (child: ChildProcess) => Promise<void>;
  } = {},
) {
  const child = new FakeChild();
  const dataDir = resolve(tmpdir(), 'combo-desktop-unit-data');
  let launches = 0;
  const backend = new OwnedBackend({
    healthFetch: async () => {
      throw new Error('synthetic offline probe');
    },
    root: resolve('.'),
    dataDir,
    port: 4317,
    launch: () => {
      launches++;
      return child as unknown as ChildProcess;
    },
    killMs: 30,
    // These shutdown/startup tests use one fake child; recovery has a separate
    // fixture which launches a new owned process for every attempt.
    restartLimit: 0,
    terminate: async (target) => (target as unknown as FakeChild).finish(1),
    ...options,
  });
  const ready = () =>
    child.emit('message', { type: 'ready', name: APP_NAME, version: APP_VERSION, port: 4317, dataDir });
  return { backend, child, dataDir, ready, launches: () => launches };
}

test('desktop data uses explicit PugPort env first and inherits only an existing legacy data directory', () => {
  const appData = resolve(tmpdir(), 'profiles'),
    root = resolve(tmpdir(), 'source');
  const current = join(appData, 'ComboRunner', 'data'),
    old = join(appData, 'Agent Studio', 'data');
  const select = (existing: string[], env: NodeJS.ProcessEnv = {}, packaged = true) =>
    productionPaths(() =>
      desktopDataDirectory({ appData, root, packaged, env, exists: (path) => existing.includes(path) }),
    );
  assert.equal(select([]), current);
  assert.equal(select([old]), old);
  assert.equal(select([old, current]), current);
  assert.equal(select([old], {}, false), join(root, '.data'));
  assert.equal(select([old], { AGENT_STUDIO_DATA_DIR: './old-explicit' }), resolve('./old-explicit'));
  assert.equal(
    select([old], { COMBORUNNER_DATA_DIR: './new-explicit', AGENT_STUDIO_DATA_DIR: './old-explicit' }),
    resolve('./new-explicit'),
  );
});

test('only the launched child can complete a matching ready handshake and startup coalesces', async () => {
  const f = backendFixture();
  const first = f.backend.start();
  assert.equal(f.backend.start(), first);
  assert.equal(f.launches(), 1);
  assert.equal(f.backend.state.phase, 'starting');
  f.ready();
  assert.equal((await first).port, 4317);
  assert.equal(f.backend.state.phase, 'ready');
  const pending = f.backend.inspect();
  const id = f.child.messages.at(-1)!.requestId;
  f.child.emit('message', { type: 'quit-inspection', requestId: Number(id) + 1, ...zero });
  f.child.emit('message', { type: 'quit-inspection', requestId: id, ...zero, scheduled: 501 });
  assert.equal((await pending).scheduled, 501);
  f.child.finish();
  await f.backend.stop();
});

test('wrong identity, port, version or data directory is rejected without attaching another service', async () => {
  for (const change of [
    { name: 'Agent Studio' },
    { port: 9999 },
    { version: 'different' },
    { dataDir: resolve(tmpdir(), 'other-data') },
  ]) {
    const f = backendFixture();
    const starting = f.backend.start();
    f.child.emit('message', {
      type: 'ready',
      name: APP_NAME,
      version: APP_VERSION,
      port: 4317,
      dataDir: f.dataDir,
      ...change,
    });
    await assert.rejects(starting, /握手不匹配/);
    assert.equal(f.backend.state.phase, 'error');
    f.child.finish();
    await f.backend.stop();
  }
});

test('startup and inspection timeouts are bounded and unexpected exit rejects pending inspection', async () => {
  const slow = backendFixture({ startupMs: 5 });
  await assert.rejects(slow.backend.start(), /启动超时/);
  slow.child.finish();
  await slow.backend.stop();
  const f = backendFixture({ inspectionMs: 5 });
  const starting = f.backend.start();
  f.ready();
  await starting;
  await assert.rejects(f.backend.inspect(), /检查超时/);
  const pending = f.backend.inspect();
  f.child.finish(1);
  await assert.rejects(pending, /已退出/);
  assert.equal(f.backend.state.phase, 'error');
  await f.backend.stop();
});

test('shutdown is idempotent, awaits acknowledgement and exit, and cannot restart a stopped child', async () => {
  const f = backendFixture();
  const starting = f.backend.start();
  f.ready();
  await starting;
  const stopping = f.backend.stop();
  assert.equal(f.backend.stop(), stopping);
  assert.deepEqual(f.child.messages, [{ type: 'shutdown' }]);
  assert.equal(f.backend.state.phase, 'stopping');
  f.child.emit('message', { type: 'shutdown-complete' });
  f.child.finish();
  await stopping;
  assert.deepEqual(f.backend.state, { phase: 'stopped' });
  await assert.rejects(f.backend.start(), /已关闭/);
});

test('a hung child uses bounded termination of that owned object only, never an already-exited child', async () => {
  let terminated = 0;
  const f = backendFixture({
    shutdownMs: 5,
    terminate: async (child) => {
      assert.equal(child, f.child);
      terminated++;
      f.child.finish(1);
    },
  });
  const starting = f.backend.start();
  f.ready();
  await starting;
  await f.backend.stop();
  assert.equal(terminated, 1);
  assert.match(f.backend.state.message!, /检查任务结果/);
  const exited = backendFixture({
    terminate: async () => {
      assert.fail('must not terminate an exited process');
    },
  });
  const early = exited.backend.start();
  exited.ready();
  await early;
  exited.child.finish();
  await exited.backend.stop();
});

test('retry after a root exit still checks a previously incomplete descendant cleanup', async () => {
  let attempts = 0;
  const f = backendFixture({
    shutdownMs: 1,
    terminate: async () => {
      attempts++;
      f.child.finish();
      if (attempts === 1) throw Error('owned descendant still alive');
    },
  });
  const starting = f.backend.start();
  f.ready();
  await starting;
  await assert.rejects(f.backend.stop(), /descendant still alive/);
  assert.equal(f.backend.state.phase, 'error');
  await f.backend.stop();
  assert.equal(attempts, 2);
  assert.equal(f.backend.state.phase, 'stopped');
});

test('quit asks about each class of work, rejects malformed counts, and explains unknown status', () => {
  assert.ok(isQuitInspection(zero));
  assert.equal(needsQuitConfirmation(zero), false);
  for (const key of Object.keys(zero)) {
    assert.equal(needsQuitConfirmation({ ...zero, [key]: 1 }), true);
    assert.equal(isQuitInspection({ ...zero, [key]: -1 }), false);
  }
  assert.equal(isQuitInspection({ ...zero, queued: Infinity }), false);
  assert.equal(isQuitInspection({ active: 0 }), false);
  assert.match(quitDescription({ ...zero, scheduled: 501 }), /未来预约：501/);
  assert.match(quitDescription('unknown'), /无法确认/);
});

test('concurrent quit requests share one decision; cancel preserves backend, confirm stops before exit', async () => {
  const answer = deferred<boolean>();
  const calls: string[] = [];
  let confirmations = 0;
  const quit = new DesktopQuitController({
    inspect: async () => ({ ...zero, scheduled: 201 }),
    confirm: async () => {
      confirmations++;
      return answer.promise;
    },
    stop: async () => {
      calls.push('stop');
    },
    exit: () => calls.push('exit'),
    error: (error) => {
      throw error;
    },
  });
  const first = quit.request();
  assert.equal(quit.request(), first);
  answer.resolve(false);
  assert.equal(await first, false);
  assert.equal(confirmations, 1);
  assert.equal(calls.length, 0);
  assert.equal(quit.mayCloseWindows, false);
  const approved = new DesktopQuitController({
    inspect: async () => ({ ...zero, active: 1 }),
    confirm: async () => true,
    stop: async () => {
      calls.push('stop');
    },
    exit: () => calls.push('exit'),
    error: (error) => {
      throw error;
    },
  });
  assert.equal(await approved.request(), true);
  assert.deepEqual(calls, ['stop', 'exit']);
  assert.equal(approved.mayCloseWindows, true);
});

test('scripted quit refuses a pending tray decision without opening another dialog', async (t) => {
  const answer = deferred<boolean>();
  let confirmations = 0;
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const quit = new DesktopQuitController({
    inspect: async () => ({ ...zero, active: 1 }),
    confirm: async () => {
      confirmations++;
      return answer.promise;
    },
    stop: async () => assert.fail('cancelled quit must not stop'),
    exit: () => assert.fail('cancelled quit must not exit'),
    error: () => assert.fail('must not show an error'),
  });
  const tray = quit.request();
  assert.equal(await quit.request('scripted'), false);
  answer.resolve(false);
  assert.equal(await tray, false);
  assert.equal(confirmations, 1);
  assert.equal(warnings.length, 1);
});

test('unknown inspection asks once and cleanup failure keeps the app open for retry', async () => {
  let confirmations = 0,
    exits = 0,
    stops = 0,
    errors = 0;
  const quit = new DesktopQuitController({
    inspect: async () => {
      throw new Error('unavailable');
    },
    confirm: async (state) => {
      assert.equal(state, 'unknown');
      confirmations++;
      return true;
    },
    stop: async () => {
      if (++stops === 1) throw new Error('still running');
    },
    exit: () => {
      exits++;
    },
    error: () => {
      errors++;
    },
  });
  assert.equal(await quit.request(), false);
  assert.equal(exits, 0);
  assert.equal(errors, 1);
  assert.equal(await quit.request(), true);
  assert.equal(exits, 1);
  assert.equal(confirmations, 2);
});

function pickerFixture(show: () => Promise<OpenDialogReturnValue>) {
  const frame = { url: 'http://127.0.0.1:4317/' },
    contents = { mainFrame: undefined as unknown };
  contents.mainFrame = frame;
  const window = {
    webContents: contents,
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
    restore() {},
  } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return {
    window,
    event,
    pick: createDirectoryPicker(() => window, 'http://127.0.0.1:4317', show),
    pickFiles: createFilesPicker(() => window, 'http://127.0.0.1:4317', show),
  };
}

test('file picker selects multiple files, joins pending dialogs and clears cancellation and errors', async () => {
  const response = deferred<OpenDialogReturnValue>();
  const f = pickerFixture(() => response.promise);
  const first = f.pickFiles(f.event);
  assert.equal(f.pickFiles(f.event), first);
  response.resolve({ canceled: false, filePaths: ['C:/synthetic/a.txt', 'C:/synthetic/b.txt'] });
  assert.deepEqual(await first, ['C:/synthetic/a.txt', 'C:/synthetic/b.txt']);
  let attempts = 0;
  const retry = pickerFixture(async () => {
    if (++attempts === 1) throw new Error('dialog failed');
    return { canceled: true, filePaths: ['C:/ignored.txt'] };
  });
  await assert.rejects(retry.pickFiles(retry.event), /dialog failed/);
  assert.deepEqual(await retry.pickFiles(retry.event), []);
  const pick = createFilesPicker(
    () => f.window,
    'http://127.0.0.1:4317',
    async (_, options) => {
      assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
      return { canceled: false, filePaths: [] };
    },
  );
  await pick(f.event);
});

test('file picker rejects foreign windows, subframes, origins and missing frames without opening', async () => {
  const f = pickerFixture(async () => assert.fail('An unowned caller must not open a picker'));
  for (const event of [
    { ...f.event, sender: {} },
    { ...f.event, senderFrame: { url: 'http://127.0.0.1:4317/frame' } },
    { ...f.event, senderFrame: null },
  ])
    await assert.rejects(f.pickFiles(event as IpcMainInvokeEvent), /主窗口/);
  Object.assign(f.event.senderFrame!, { url: 'https://example.test/' });
  await assert.rejects(f.pickFiles(f.event), /主窗口/);
});
test('directory picker joins concurrent dialogs, returns null on cancel, and permits retry after errors', async () => {
  const response = deferred<OpenDialogReturnValue>();
  let calls = 0;
  const f = pickerFixture(async () => {
    calls++;
    return response.promise;
  });
  const first = f.pick(f.event),
    second = f.pick(f.event);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  response.resolve({ canceled: true, filePaths: [] });
  assert.equal(await first, null);
  let attempts = 0;
  const retry = pickerFixture(async () => {
    if (++attempts === 1) throw new Error('native dialog failed');
    return { canceled: false, filePaths: ['C:/selected'] };
  });
  await assert.rejects(retry.pick(retry.event), /dialog failed/);
  assert.equal(await retry.pick(retry.event), 'C:/selected');
});

test('directory picker rejects other windows, subframes, foreign origins and missing frames', async () => {
  const f = pickerFixture(async () => {
    assert.fail('unowned callers must not show a dialog');
  });
  await assert.rejects(f.pick({ ...f.event, sender: {} } as IpcMainInvokeEvent), /主窗口/);
  await assert.rejects(
    f.pick({ ...f.event, senderFrame: { url: 'http://127.0.0.1:4317/frame' } } as IpcMainInvokeEvent),
    /主窗口/,
  );
  await assert.rejects(f.pick({ ...f.event, senderFrame: null } as IpcMainInvokeEvent), /主窗口/);
  Object.assign(f.event.senderFrame!, { url: 'https://example.test/' });
  await assert.rejects(f.pick(f.event), /主窗口/);
});
