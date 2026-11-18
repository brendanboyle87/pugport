import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { OwnedBackend, type BackendState } from '../src/electron/backend.ts';
import { APP_NAME, APP_VERSION, GITHUB_REPO_URL } from '../src/shared/identity.ts';
import { electronModule } from './helpers/electron-harness.ts';
import type { BackendGuard } from '../src/electron/windows-backend-guard.ts';

class Child extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = { resume() {} };
  stderr = { resume() {} };
  messages: Record<string, unknown>[] = [];
  constructor(readonly pid: number) {
    super();
  }
  send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
    this.messages.push(message);
    callback?.(null);
  }
  finish(code = 1) {
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code, null);
  }
}
function fixture(options: Partial<ConstructorParameters<typeof OwnedBackend>[0]> = {}) {
  const children: Child[] = [];
  const states: BackendState[] = [];
  const logs: string[] = [];
  const launches: NodeJS.ProcessEnv[] = [];
  const dataDir = resolve(tmpdir(), 'pugport-backend-recovery-unit');
  const backend = new OwnedBackend({
    healthFetch: async () => {
      throw new Error('synthetic offline probe');
    },
    root: resolve('.'),
    port: 54321,
    dataDir,
    startupMs: 500,
    shutdownMs: 50,
    restartBackoffMs: 10,
    changed: (state) => states.push(state),
    log: (line) => logs.push(line),
    terminate: async (child) => (child as unknown as Child).finish(),
    launch: (env) => {
      launches.push(env);
      const child = new Child(10000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    ...options,
  });
  const child = () => children.at(-1)!;
  const ready = (target = child(), change = {}) =>
    target.emit('message', { type: 'ready', name: APP_NAME, version: APP_VERSION, port: 54321, dataDir, ...change });
  const start = async () => {
    const pending = backend.start();
    ready();
    await pending;
  };
  const stop = async () => {
    const pending = backend.stop();
    if (child()?.connected) {
      child().emit('message', { type: 'shutdown-complete' });
      child().finish(0);
    }
    await pending;
  };
  return { backend, children, states, logs, launches, child, ready, start, stop };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('session arrives before ready and is cleared on stop', async () => {
  const f = fixture();
  const pending = f.backend.start();
  f.child().emit('message', { type: 'session', token: 'synthetic', owner: 'owner' });
  assert.equal(f.backend.token, 'synthetic');
  assert.equal(f.backend.owner, 'owner');
  f.ready();
  await pending;
  assert.equal(f.backend.token, 'synthetic');
  await f.stop();
  assert.equal(f.backend.token, undefined);
  assert.equal(f.backend.owner, undefined);
  const old = fixture();
  await old.start();
  assert.equal(old.backend.token, undefined);
  await old.stop();
});

test('permission changes use the owned child IPC and propagate success and rejection', async () => {
  const f = fixture();
  await assert.rejects(
    f.backend.changePermission({ kind: 'caller', tool: 'codex', mode: 'write' }, false),
    /后台不可用/,
  );
  await f.start();
  try {
    const change = { kind: 'caller' as const, tool: 'codex' as const, mode: 'write' as const };
    const inspect = f.backend.changePermission(change, false);
    let message = f.child().messages.at(-1)!;
    assert.equal(message.type, 'permission-change');
    assert.equal(message.apply, false);
    f.child().emit('message', {
      type: 'permission-change-result',
      requestId: message.requestId,
      description: 'Codex permission',
    });
    assert.equal(await inspect, 'Codex permission');
    const apply = f.backend.changePermission(change, true, 'Codex permission');
    message = f.child().messages.at(-1)!;
    assert.equal(message.apply, true);
    assert.equal(message.expected, 'Codex permission');
    f.child().emit('message', {
      type: 'permission-change-result',
      requestId: message.requestId,
      error: 'Synthetic rejection',
    });
    await assert.rejects(apply, /Synthetic rejection/);
  } finally {
    await f.stop();
  }
});

test('a guarded backend cannot acknowledge ready before containment and replacement waits for full old-job cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const guards: Array<{ ready: ReturnType<typeof deferred<void>>; closed: ReturnType<typeof deferred<void>> }> = [];
  const f = fixture({
    guard: () => {
      const guard = { ready: deferred<void>(), closed: deferred<void>() };
      guards.push(guard);
      return {
        ready: guard.ready.promise,
        closed: guard.closed.promise,
        terminate: async () => guard.closed.promise,
      } satisfies BackendGuard;
    },
  });
  const starting = f.backend.start();
  guards[0]!.ready.resolve();
  await Promise.resolve();
  f.ready();
  await starting;
  f.child().finish();
  const replacement = f.backend.start();
  t.mock.timers.tick(2000);
  assert.equal(f.children.length, 1, 'zero-job cleanup must precede any replacement fork');
  guards[0]!.closed.resolve();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(10);
  assert.equal(f.children.length, 2);
  guards[1]!.ready.resolve();
  await Promise.resolve();
  f.ready();
  await replacement;
  const stopping = f.stop();
  guards[1]!.closed.resolve();
  await stopping;
});

test('missing guardian cleanup acknowledgement fails closed and never schedules a replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const clean = deferred<void>();
  const f = fixture({ guard: () => ({ ready: Promise.resolve(), closed: clean.promise, terminate: async () => {} }) });
  const starting = f.backend.start();
  await Promise.resolve();
  f.ready();
  await starting;
  f.child().finish();
  const waiting = f.backend.start();
  const rejected = assert.rejects(waiting, /清理未/);
  clean.reject(Error('guardian lost'));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await rejected;
  t.mock.timers.tick(100000);
  assert.equal(f.children.length, 1);
  assert.equal(f.backend.state.phase, 'error');
  assert.ok(f.logs.some((line) => /cleanup wait failed/.test(line)));
  assert.ok(f.logs.some((line) => /fail:.*清理未/.test(line)));
  await f.stop();
  assert.equal(f.backend.state.phase, 'stopped', 'loss of readiness never prevents bounded intentional quit');
});

test('stopping while old-job cleanup is pending cancels the future recovery fork', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const clean = deferred<void>();
  const f = fixture({
    guard: () => ({
      ready: Promise.resolve(),
      closed: clean.promise,
      terminate: async () => {
        clean.resolve();
      },
    }),
  });
  const starting = f.backend.start();
  await Promise.resolve();
  f.ready();
  await starting;
  f.child().finish();
  const waiting = f.backend.start();
  const cancelled = assert.rejects(waiting, /恢复已取消/);
  const stopping = f.stop();
  clean.resolve();
  await stopping;
  await cancelled;
  t.mock.timers.tick(100000);
  assert.equal(f.children.length, 1);
  assert.equal(f.backend.state.phase, 'stopped');
});

test('an uncontained bootstrap ready message is rejected without starting tasks and can still be closed', async () => {
  const ready = deferred<void>(),
    clean = deferred<void>();
  const f = fixture({
    guard: (child) => ({
      ready: ready.promise,
      closed: clean.promise,
      terminate: async () => {
        (child as unknown as Child).finish();
        clean.resolve();
        ready.reject(Error('containment cancelled'));
      },
    }),
  });
  const starting = f.backend.start();
  f.ready();
  await assert.rejects(starting, /保护就绪之前/);
  assert.equal(f.backend.state.phase, 'error');
  await f.stop();
  assert.equal(f.backend.state.phase, 'stopped');
});

test('an owned ready backend crash recovers after backoff and requires the same identity, port and data directory', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  await f.start();
  assert.equal(f.launches[0].PUGPORT_PURGE_INCOGNITO, '1');
  const oldChild = f.child();
  oldChild.emit('message', { type: 'session', token: 'old', owner: 'old' });
  const inspection = f.backend.inspect();
  f.child().finish();
  assert.equal(f.backend.token, undefined);
  assert.equal(f.backend.owner, undefined);
  await assert.rejects(inspection, /已退出/);
  assert.equal(f.backend.state.phase, 'recovering');
  assert.equal(
    f.states.some((state) => state.phase === 'error'),
    false,
  );
  const waiting = f.backend.start();
  assert.equal(f.backend.start(), waiting);
  t.mock.timers.tick(9);
  assert.equal(f.children.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.children.length, 2);
  oldChild.emit('message', { type: 'session', token: 'late', owner: 'late' });
  assert.equal(f.backend.token, undefined);
  assert.equal(f.backend.owner, undefined);
  f.child().emit('message', { type: 'session', token: 'new', owner: 'new' });
  assert.equal(f.backend.owner, 'new');
  assert.equal(f.backend.token, 'new');
  assert.equal(f.launches[1].PUGPORT_PURGE_INCOGNITO, '0');
  await assert.rejects(f.backend.inspect(), /尚未就绪/);
  f.ready();
  assert.equal((await waiting).port, 54321);
  assert.equal(f.backend.state.phase, 'ready');
  assert.equal(f.backend.pid, f.child().pid);
  await f.stop();
});

test('late messages, close and page-test results from an exited child cannot affect its replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let finishPage!: (result: unknown) => void;
  const f = fixture({ pageTest: () => new Promise((done) => (finishPage = done)) });
  await f.start();
  const previous = f.child();
  previous.emit('message', { type: 'page-test', requestId: 7, request: {} });
  previous.finish();
  const waiting = f.backend.start();
  t.mock.timers.tick(10);
  previous.emit('message', { type: 'ready', name: APP_NAME, version: APP_VERSION, port: 54321 });
  previous.emit('message', { type: 'fatal' });
  previous.emit('close', 1, null);
  previous.emit('error', Error('late error'));
  assert.equal(f.backend.state.phase, 'recovering');
  f.ready();
  await waiting;
  const inspecting = f.backend.inspect();
  const requestId = f.child().messages.at(-1)!.requestId;
  previous.emit('message', {
    type: 'quit-inspection',
    requestId,
    active: 99,
    queued: 0,
    scheduled: 0,
    waitingApproval: 0,
  });
  f.child().emit('message', {
    type: 'quit-inspection',
    requestId,
    active: 0,
    queued: 0,
    scheduled: 0,
    waitingApproval: 0,
  });
  assert.equal((await inspecting).active, 0);
  finishPage({ title: 'old page' });
  await Promise.resolve();
  assert.equal(
    f.child().messages.some((message) => message.type === 'page-test-result'),
    false,
  );
  assert.equal(f.backend.state.phase, 'ready');
  await f.stop();
});

test('three consecutive crashes stop recovery with a logged limit message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  await f.start();
  for (const delay of [10, 20]) {
    const previousCount = f.children.length;
    f.child().finish();
    const waiting = f.backend.start();
    t.mock.timers.tick(delay - 1);
    assert.equal(f.children.length, previousCount);
    t.mock.timers.tick(1);
    assert.equal(f.children.length, previousCount + 1);
    f.ready();
    await waiting;
  }
  f.child().finish();
  assert.equal(f.backend.state.phase, 'error');
  assert.match(f.backend.state.message!, /3 次重启失败后已停止/);
  await assert.rejects(f.backend.start(), /3 次重启失败后已停止/);
  t.mock.timers.tick(100000);
  assert.equal(f.children.length, 3);
  assert.ok(f.logs.some((line) => line.includes('fail:') && line.includes(f.backend.state.message!)));
  await f.stop();
});

test('a stable ready period resets consecutive failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture({ restartLimit: 3, restartStableMs: 100 });
  await f.start();
  f.child().finish();
  const first = f.backend.start();
  t.mock.timers.tick(10);
  f.ready();
  await first;
  t.mock.timers.tick(100);
  assert.ok(f.logs.some((line) => /stable ready.*reset/.test(line)));
  f.child().finish();
  const second = f.backend.start();
  t.mock.timers.tick(10);
  assert.equal(f.children.length, 3);
  f.ready();
  await second;
  f.child().finish();
  t.mock.timers.tick(20);
  f.ready();
  f.child().finish();
  assert.equal(f.backend.state.phase, 'error');
  assert.ok(f.logs.some((line) => /attempt=3.*limit check/.test(line)));
  await f.stop();
});

test('a throwing recovering callback cannot interrupt logging or the replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture({
    changed: (state) => {
      if (state.phase === 'recovering') throw Error('synthetic UI failure');
    },
  });
  t.after(f.stop);
  await f.start();
  f.child().finish();
  t.mock.timers.tick(10);
  assert.equal(f.children.length, 2);
  f.ready();
  assert.equal(f.backend.state.phase, 'ready');
  assert.ok(f.logs.some((line) => /changed callback threw.*synthetic UI failure/.test(line)));
  for (const reason of ['eligible=true', 'limit check', 'unexpected exit', 'timer fired', 'relaunch starting'])
    assert.ok(
      f.logs.some((line) => line.includes(reason)),
      reason,
    );
  assert.ok(f.logs.every((line) => /generation=\d+ pid=\d+ phase=\w+ attempt=\d+ reason=/.test(line)));
});

test('duplicate, stale and intentional exits log why recovery was skipped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  t.after(f.stop);
  await f.start();
  const old = f.child();
  const close = old.listeners('close')[0];
  old.finish();
  close(1, null);
  t.mock.timers.tick(10);
  old.emit('close', 1, null);
  f.ready();
  await f.stop();
  for (const reason of ['already exited', 'stale child', 'intentional stop'])
    assert.ok(
      f.logs.some((line) => line.includes(reason)),
      reason,
    );
});

test('intentional stop cancels recovery backoff and never launches another process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  await f.start();
  f.child().finish();
  const waiting = f.backend.start();
  const cancelled = assert.rejects(waiting, /恢复已取消/);
  await f.stop();
  await cancelled;
  t.mock.timers.tick(100000);
  assert.equal(f.children.length, 1);
  assert.equal(f.backend.state.phase, 'stopped');
  await assert.rejects(f.backend.start(), /已关闭/);
});

test('stop during a recovery handshake waits for the current child and cancels its readiness', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  await f.start();
  f.child().finish();
  const waiting = f.backend.start();
  const cancelled = assert.rejects(waiting, /恢复已取消/);
  t.mock.timers.tick(10);
  await f.stop();
  await cancelled;
  t.mock.timers.tick(100000);
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.child().messages, [{ type: 'shutdown' }]);
  assert.equal(f.backend.state.phase, 'stopped');
});

test('initial exit, launch error, startup timeout and fatal port/identity failures do not trigger recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const reason of ['exit', 'launch', 'timeout', 'fatal', 'identity']) {
    let launches = 0;
    const f = fixture(
      reason === 'launch'
        ? {
            launch: () => {
              launches++;
              throw Error('spawn failed');
            },
          }
        : {},
    );
    const starting = f.backend.start();
    const failed = assert.rejects(starting);
    if (reason === 'exit') f.child().finish();
    if (reason === 'timeout') t.mock.timers.tick(500);
    if (reason === 'fatal') f.child().emit('message', { type: 'fatal', message: 'EADDRINUSE' });
    if (reason === 'identity') f.ready(f.child(), { port: 9999 });
    await failed;
    assert.equal(f.backend.state.phase, 'error');
    assert.ok(
      f.logs.some((line) => line.includes('fail:') && line.includes(f.backend.state.message!)),
      reason,
    );
    f.child()?.finish();
    t.mock.timers.tick(100000);
    assert.equal(reason === 'launch' ? launches : f.children.length, 1);
    await f.stop();
  }
  const recovering = fixture();
  await recovering.start();
  recovering.child().finish();
  const pending = recovering.backend.start();
  const rejected = assert.rejects(pending, /握手不匹配/);
  t.mock.timers.tick(10);
  recovering.ready(recovering.child(), { version: 'unknown-version' });
  await rejected;
  recovering.child().finish();
  t.mock.timers.tick(100000);
  assert.equal(recovering.children.length, 2);
  await recovering.stop();
});

test('a replacement crashing before readiness retries only within the existing recovery budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  await f.start();
  f.child().finish();
  const waiting = f.backend.start();
  t.mock.timers.tick(10);
  f.child().finish();
  await Promise.resolve();
  assert.equal(f.backend.state.phase, 'recovering');
  t.mock.timers.tick(20);
  f.ready();
  await waiting;
  assert.equal(f.children.length, 3);
  assert.equal(f.backend.state.phase, 'ready');
  await f.stop();
});

test('recovery timeout or rejected identity immediately stops only the current guarded replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  for (const reason of ['timeout', 'identity']) {
    const guards: Array<{ closed: ReturnType<typeof deferred<void>>; stops: number }> = [];
    const f = fixture({
      guard: (child) => {
        const guard = { closed: deferred<void>(), stops: 0 };
        guards.push(guard);
        return {
          ready: Promise.resolve(),
          closed: guard.closed.promise,
          terminate: async () => {
            guard.stops++;
            if (child.exitCode === null) (child as unknown as Child).finish();
            guard.closed.resolve();
          },
        };
      },
    });
    const first = f.backend.start();
    await Promise.resolve();
    f.ready();
    await first;
    const previous = f.child();
    previous.finish();
    const waiting = f.backend.start();
    const rejected = assert.rejects(waiting, reason === 'timeout' ? /启动超时/ : /握手不匹配/);
    guards[0]!.closed.resolve();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    t.mock.timers.tick(10);
    await Promise.resolve();
    const replacement = f.child();
    if (reason === 'timeout') t.mock.timers.tick(500);
    else f.ready(replacement, { version: 'wrong-version' });
    await rejected;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(f.backend.state.phase, 'error');
    assert.notEqual(replacement.exitCode, null, 'failed replacement must not continue processing tasks');
    assert.equal(guards[1]!.stops, 1);
    assert.equal(guards[0]!.stops, 0, 'already-cleaned old generation must not be stopped again');
    t.mock.timers.tick(100000);
    assert.equal(f.children.length, 2, 'fatal replacement startup must not retry');
    await f.stop();
  }
});

test('the actual main state callback preserves the loaded renderer during recovery and final failure', async () => {
  const records: unknown[][] = [];
  const crashStarts: unknown[] = [];
  const urls: string[] = [];
  const titles: string[] = [];
  const sent: unknown[][] = [];
  const ipcMain = Object.assign(new EventEmitter(), { handle() {}, removeHandler() {} });
  const frame = { url: 'http://127.0.0.1:4317/' };
  const holder: {
    options?: { changed: (state: BackendState) => void };
    shell?: {
      diagnosticInfo: () => Promise<{ commit?: string; os?: string; clis?: unknown[] }>;
      reportProblem: () => Promise<void>;
    };
  } = {};
  let offline = false;
  let confirmation = 0;
  let browserFailure = false;
  const external: string[] = [];
  const dialogs: { detail: string; message: string }[] = [];
  let dialogGate: Promise<void> | undefined;
  const fixtureRequest = async () => {
    if (offline) throw new Error('offline');
    return {
      ok: true,
      json: async () => ({
        app: { version: APP_VERSION, commit: 'abc1234', platform: 'linux', arch: 'x64', packaged: true },
        runtimes: [{ installed: true, provider: 'grok', version: '1.2.3', status: 'ready' }],
      }),
    };
  };
  const desktop = {
    exiting: false,
    show() {},
    dispose() {},
    window: {
      isDestroyed: () => false,
      setTitle: (title: string) => titles.push(title),
      loadURL: async (url: string) => urls.push(url),
      webContents: Object.assign(new EventEmitter(), {
        executeJavaScript: async () => {},
        mainFrame: frame,
        send: (...args: unknown[]) => sent.push(args),
      }),
    },
  };
  const application = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => tmpdir(),
    getAppPath: () => resolve(tmpdir(), 'pugport-no-real-app'),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    isPackaged: false,
    quit() {},
    exit() {
      assert.fail('a state change must not exit the app');
    },
  });
  await electronModule(
    'src/electron/main.ts',
    {
      app: application,
      crashReporter: { start: (options: unknown) => crashStarts.push(options) },
      ipcMain,
      session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} } } },
      dialog: {
        showMessageBox: async (parent: unknown, options: { detail: string; message: string }) => {
          assert.equal(parent, desktop.window);
          dialogs.push(options);
          await dialogGate;
          return { response: confirmation };
        },
      },
      shell: {
        openExternal: async (url: string) => {
          if (browserFailure) throw new Error('synthetic browser failure');
          external.push(url);
        },
      },
    },
    { holder, desktop, records, fixtureRequest, process: { env: {}, platform: 'linux', argv: [] } },
    {
      './session-header.ts':
        'export const attachSessionHeader=()=>{},setSessionOwner=()=>{},setSessionToken=()=>{},backendRequest=(...args)=>fixtureRequest(...args);',
      './crash-record.ts':
        'export const createCrashRecord=()=>({take:()=>undefined,record:(...args)=>records.push(args)});',
      './backend.ts': `export class OwnedBackend {
        state={phase:'idle'};
        constructor(options){this.options=options;holder.options={changed:state=>{this.state=state;options.changed(state);}};}
        async start(){this.state={phase:'ready'};this.options.changed(this.state);return {};}
        async stop(){}
        async inspect(){return {};}
      }`,
      './shell.ts': 'export const createDesktopShell=options=>{holder.shell=options;return desktop;};',
      './data-directory.ts': 'export const desktopDataDirectory=()=>"unused-isolated-data";',
      './taskbar-identity.ts':
        'export const APP_USER_MODEL_ID="fixture",ensureTaskbarIdentity=()=>{},watchTaskbarIdentity=()=>()=>{};',
      './locale.ts': 'export const restoreMainLocale=()=>{},t=(text)=>text;',
      './page-test.ts': 'export const runPageTest=async()=>({});',
    },
  );
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual(JSON.parse(JSON.stringify(crashStarts)), [{ uploadToServer: false, compress: true }]);
  assert.equal(urls.at(-1), 'http://127.0.0.1:4317');
  const diagnostics = await holder.shell!.diagnosticInfo();
  assert.equal(diagnostics.commit, 'abc1234');
  assert.equal(diagnostics.clis?.length, 1);
  const beforeReports = sent.length;
  const reportEvent = { sender: desktop.window.webContents, senderFrame: frame };
  let closeReportDialog!: () => void;
  dialogGate = new Promise<void>((resolve) => {
    closeReportDialog = resolve;
  });
  const fallbackOne = holder.shell!.reportProblem();
  const fallbackTwo = holder.shell!.reportProblem();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dialogs.length, 1);
  closeReportDialog();
  assert.equal(await fallbackOne, false, 'no listener falls back to cancellable dialog');
  assert.equal(await fallbackTwo, false);
  dialogGate = undefined;
  ipcMain.emit('combo-runner:report-problem-ready', reportEvent, true);
  const firstReport = holder.shell!.reportProblem();
  const secondReport = holder.shell!.reportProblem();
  assert.equal(await firstReport, true);
  assert.equal(await secondReport, true);
  assert.deepEqual(external, [], 'reports open inside PugPort');
  assert.equal(sent.length, beforeReports + 2);
  assert.equal(sent.at(-1)?.[0], 'combo-runner:report-problem-open');
  await holder.shell!.reportProblem();
  assert.equal(sent.length, beforeReports + 3);
  frame.url = 'data:text/html,offline';
  offline = true;
  confirmation = 1;
  assert.equal(await holder.shell!.reportProblem(), true, 'offline splash uses GitHub fallback');
  assert.equal(external.length, 1);
  frame.url = 'http://127.0.0.1:4317/';
  ipcMain.emit('combo-runner:report-problem-ready', reportEvent, false);
  assert.equal(await holder.shell!.reportProblem(), true, 'listener removal restores fallback');
  browserFailure = true;
  assert.equal(await holder.shell!.reportProblem(), false, 'failed browser open is not success');
  browserFailure = false;
  confirmation = 0;
  assert.ok(
    external.every((url) => {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname === `${GITHUB_REPO_URL}/issues/new`;
    }),
  );
  offline = true;
  const fallback = await holder.shell!.diagnosticInfo();
  assert.deepEqual(
    Object.keys(fallback)
      .filter((key) => (fallback as Record<string, unknown>)[key] !== undefined)
      .sort(),
    ['arch', 'os', 'version'],
  );
  const loaded = [...urls];
  holder.options!.changed({ phase: 'recovering', message: '本地后台意外退出，正在自动恢复（第 2 次）。' });
  assert.equal(titles.at(-1), 'PugPort · 本地后台意外退出，正在自动恢复（第 2 次）。');
  assert.ok(sent.at(-1), 'recovery must reach the loaded window through IPC');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), [
    'combo-runner:backend-state',
    { phase: 'recovering', message: '本地后台意外退出，正在自动恢复（第 2 次）。' },
  ]);
  const event = { sender: desktop.window.webContents, senderFrame: frame };
  const beforeSnapshot = sent.length;
  ipcMain.emit('combo-runner:backend-state-ready', { ...event, sender: {} });
  ipcMain.emit('combo-runner:backend-state-ready', { ...event, senderFrame: { ...frame } });
  frame.url = 'https://untrusted.example/';
  ipcMain.emit('combo-runner:backend-state-ready', event);
  frame.url = 'http://127.0.0.1:4317/';
  assert.equal(sent.length, beforeSnapshot, 'only the trusted main frame can request a snapshot');
  ipcMain.emit('combo-runner:backend-state-ready', event);
  assert.equal(sent.length, beforeSnapshot + 1, 'late subscriptions receive the current recovery');
  holder.options!.changed({
    phase: 'error',
    message: 'PugPort 后台服务在 3 次重启失败后已停止。请打开日志文件夹，然后重新打开 PugPort。',
  });
  assert.equal(
    titles.at(-1),
    'PugPort · PugPort 后台服务在 3 次重启失败后已停止。请打开日志文件夹，然后重新打开 PugPort。',
  );
  assert.equal((sent.at(-1)![1] as BackendState).phase, 'error');
  holder.options!.changed({ phase: 'ready' });
  assert.equal(titles.at(-1), 'PugPort');
  assert.equal((sent.at(-1)![1] as BackendState).phase, 'ready');
  const beforeStarting = sent.length;
  holder.options!.changed({ phase: 'starting' });
  assert.equal(sent.length, beforeStarting, 'relaunching must not clear the recovery notice');
  assert.deepEqual(urls, loaded);
  assert.deepEqual(records, [], 'phase error does not create a crash record');
  desktop.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  application.emit('will-quit');
  desktop.window.webContents.emit('render-process-gone', {}, { reason: 'killed' });
  assert.deepEqual(JSON.parse(JSON.stringify(records)), [
    ['renderer', 'crashed', false],
    ['renderer', 'killed', true],
  ]);
});

test('owned backend reports actual abnormal exits, but not clean stops or fatal cleanup', async () => {
  const crashes: string[] = [];
  const f = fixture({ restartLimit: 0, crashed: (reason) => crashes.push(reason) });
  await f.start();
  f.child().finish(1);
  assert.deepEqual(crashes, ['abnormal-exit']);
  await f.stop();
  const clean = fixture({ crashed: (reason) => crashes.push(reason) });
  await clean.start();
  await clean.stop();
  const fatal = fixture({ crashed: (reason) => crashes.push(reason) });
  await fatal.start();
  fatal.child().emit('message', { type: 'fatal' });
  await new Promise<void>((done) => setImmediate(done));
  await fatal.stop();
  assert.deepEqual(crashes, ['abnormal-exit']);
});

test('recovered backend exits create no crash record; only exhaustion records the configurable limit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const crashes: string[] = [];
  const f = fixture({ restartLimit: 2, crashed: (reason) => crashes.push(reason) });
  await f.start();
  f.child().finish(1);
  assert.deepEqual(crashes, []);
  t.mock.timers.tick(10);
  f.ready();
  assert.equal(f.backend.state.phase, 'ready');
  assert.deepEqual(crashes, []);
  f.child().finish(1);
  assert.equal(f.backend.state.phase, 'error');
  assert.match(f.backend.state.message!, /2 次重启失败/);
  assert.deepEqual(crashes, ['abnormal-exit']);
  await f.stop();
});
