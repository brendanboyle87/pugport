import * as sessionEndpoint from '../src/server/platform/desktop-endpoint.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { backendPort, PugPortClient } from '../src/cli/client.ts';
import { ensureBackend } from '../src/cli/launch.ts';
import { probeLoopbackPort, selectDesktopPort } from '../src/electron/backend-port.ts';
import { desktopApp } from '../src/server/node/desktop-app.ts';
import { mcpCommand } from '../src/server/external-tasks.ts';
import {
  desktopEndpointFile,
  publishDesktopPort,
  publishForwardToken,
  readDesktopPort,
} from '../src/server/platform/desktop-endpoint.ts';
import { appDirs } from '../src/server/platform/dirs.ts';
import { fetchPortAllowed } from '../src/server/platform/loopback-port.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';
import { electronModule } from './helpers/electron-harness.ts';
import { listenForFetch } from './helpers/fetch-port.ts';
import { nextTurn } from './helpers/ui-harness.ts';

test('default desktop port falls back immediately for Windows exclusion EACCES and throws other errors', async () => {
  const calls: number[] = [];
  const selected = await selectDesktopPort(
    {},
    async (port) => {
      calls.push(port);
      if (port === 4317) throw Object.assign(new Error('excluded'), { code: 'EACCES' });
      return 54321;
    },
    { sleep: async () => assert.fail('EACCES must not retry') },
  );
  assert.equal(selected, 54321);
  assert.deepEqual(calls, [4317, 0]);
  await assert.rejects(
    selectDesktopPort(
      {},
      async () => {
        throw Object.assign(new Error('bad'), { code: 'EMFILE' });
      },
      { sleep: async () => assert.fail('other errors must not retry') },
    ),
    /bad/,
  );
});

test('default desktop port returns 4317 when an occupied port clears during retries', async () => {
  const calls: number[] = [];
  const delays: number[] = [];
  let elapsed = 0;
  const selected = await selectDesktopPort(
    {},
    async (port) => {
      calls.push(port);
      if (port === 4317 && calls.length < 4) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      return port || 54321;
    },
    {
      now: () => elapsed,
      sleep: async (ms) => {
        delays.push(ms);
        elapsed += ms;
      },
    },
  );
  assert.equal(selected, 4317);
  assert.deepEqual(calls, [4317, 4317, 4317, 4317]);
  assert.deepEqual(delays, [500, 500, 500]);
});

test('default desktop port falls back after at most twelve seconds of occupied-port retries', async () => {
  const calls: number[] = [];
  const delays: number[] = [];
  let elapsed = 0;
  const selected = await selectDesktopPort(
    {},
    async (port) => {
      calls.push(port);
      if (port === 4317) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
      return 54321;
    },
    {
      now: () => elapsed,
      sleep: async (ms) => {
        delays.push(ms);
        elapsed += ms;
      },
    },
  );
  assert.equal(selected, 54321);
  assert.deepEqual(calls, [...Array<number>(25).fill(4317), 0]);
  assert.deepEqual(delays, Array<number>(24).fill(500));
  assert.equal(elapsed, 12_000);
});

test('default desktop port retry budget includes probing and tries 4317 once more after the last wait', async () => {
  for (const oversleep of [0, 100]) {
    const calls: number[] = [];
    const delays: number[] = [];
    let elapsed = 0;
    const selected = await selectDesktopPort(
      {},
      async (port) => {
        calls.push(port);
        if (calls.length === 1) elapsed += 11_800;
        if (port === 4317) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
        return 54321;
      },
      {
        now: () => elapsed,
        sleep: async (ms) => {
          delays.push(ms);
          elapsed += ms + oversleep;
        },
      },
    );
    assert.equal(selected, 54321);
    assert.deepEqual(delays, [200]);
    assert.deepEqual(calls, [4317, 4317, 0]);
  }
});

test('default desktop port stops retrying when an occupied port reports a different error', async () => {
  for (const code of ['EACCES', 'EMFILE']) {
    const calls: number[] = [];
    let elapsed = 0;
    const pending = selectDesktopPort(
      {},
      async (port) => {
        calls.push(port);
        if (port === 0) return 54321;
        throw Object.assign(new Error(code), { code: calls.length === 1 ? 'EADDRINUSE' : code });
      },
      {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      },
    );
    if (code === 'EACCES') assert.equal(await pending, 54321);
    else await assert.rejects(pending, /EMFILE/);
    assert.equal(elapsed, 500);
    assert.deepEqual(calls, code === 'EACCES' ? [4317, 4317, 0] : [4317, 4317]);
  }
});

test('explicit desktop ports are retained and errors never trigger fallback or retries', async () => {
  for (const key of ['COMBORUNNER_PORT', 'AGENT_STUDIO_PORT']) {
    for (const code of ['EACCES', 'EADDRINUSE']) {
      const calls: number[] = [];
      await assert.rejects(
        selectDesktopPort(
          { [key]: '4317' },
          async (port) => {
            calls.push(port);
            throw Object.assign(new Error('excluded'), { code });
          },
          { sleep: async () => assert.fail('explicit ports must not retry') },
        ),
        /excluded/,
      );
      assert.deepEqual(calls, [4317]);
    }
    assert.equal(await selectDesktopPort({ [key]: '14317' }, async (port) => port), 14317);
    await assert.rejects(
      selectDesktopPort({ [key]: '0' }, async () => assert.fail('invalid port was probed')),
      /65535/,
    );
  }
});

test('automatic probe returns a usable loopback port and releases the probe listener', async (t) => {
  const port = await probeLoopbackPort(0);
  assert.equal(fetchPortAllowed(port), true);
  const server = createServer();
  t.after(() => server.close());
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
});

test('discovery validates ports and owner liveness, contains no secrets and cleans only its own instance', () => {
  const file = join(testDirectory(), 'endpoint-fixture', 'endpoint.json');
  const first = publishDesktopPort(54321, file);
  assert.equal(readDesktopPort(file), 54321);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(value).sort(), ['instance', 'pid', 'port']);
  assert.equal(value.pid, process.pid);
  const second = publishDesktopPort(54322, file);
  first();
  assert.equal(readDesktopPort(file), 54322);
  second();
  assert.equal(existsSync(file), false);
  for (const value of [
    { port: 0, pid: process.pid, instance: 'fixture' },
    { port: 65536, pid: process.pid, instance: 'fixture' },
    { port: '54321', pid: process.pid, instance: 'fixture' },
    { port: 54321, pid: -1, instance: 'fixture' },
    { port: 54321, pid: 2147483647, instance: 'fixture' },
    { port: 54321, url: 'http://example.invalid' },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    assert.equal(readDesktopPort(file), undefined);
  }
  writeFileSync(file, '{');
  assert.equal(readDesktopPort(file), undefined);
});

test('Windows discovery lives in the profile folder, which a packaged parent app cannot redirect, and the old place is kept', () => {
  const primary = desktopEndpointFile();
  const legacy = join(appDirs().memoryBase, 'desktop-endpoint.json');
  if (process.platform === 'win32') {
    assert.ok(primary.endsWith(join('home', '.pugport', 'desktop-endpoint.json')));
    assert.notEqual(primary, legacy);
  } else assert.equal(primary, legacy);
  const clear = publishDesktopPort(54323);
  assert.equal(JSON.parse(readFileSync(primary, 'utf8')).port, 54323);
  assert.equal(readFileSync(legacy, 'utf8'), readFileSync(primary, 'utf8'));
  assert.equal(readDesktopPort(), 54323);
  clear();
  assert.equal(existsSync(primary), false);
  assert.equal(existsSync(legacy), false);
  const entry = (port: number, pid = process.pid) => JSON.stringify({ port, pid, instance: 'fixture' });
  try {
    // Only the new file: the AppData write went into a packaged app's private folder.
    writeFileSync(primary, entry(54324));
    assert.equal(readDesktopPort(), 54324);
    if (primary !== legacy) {
      // Only the old file: an older desktop.
      rmSync(primary);
      writeFileSync(legacy, entry(54325));
      assert.equal(readDesktopPort(), 54325);
      // A newer file left by a desktop that has exited is skipped.
      writeFileSync(primary, entry(54326, 2147483647));
      assert.equal(readDesktopPort(), 54325);
    }
  } finally {
    rmSync(primary, { force: true });
    rmSync(legacy, { force: true });
  }
});

/** A desktop on this computer publishes its port and, once listening, the forward token for that port. */
function publishDesktop(port: number) {
  const clearPort = publishDesktopPort(port);
  const clearToken = publishForwardToken('synthetic-forward-token', port);
  return () => {
    clearToken();
    clearPort();
  };
}

test('CLI auto-launch refreshes discovery; device callers use it while explicit overrides win', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      assert.equal(req.headers['x-agent-token'], 'fixture-token');
      return res.end(JSON.stringify({ ok: true }));
    }
    res.end(JSON.stringify({ ok: true, name: 'PugPort', role: 'desktop' }));
  });
  await listenForFetch(server);
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  t.after(sessionEndpoint.publishSessionToken('fixture-token', port));
  const closed = await probeLoopbackPort(0);
  let clear = publishDesktop(closed);
  t.after(() => clear());
  const client = new PugPortClient();
  assert.equal(client.port, closed);
  const device = desktopApp();
  // The old desktop on the closed port has gone (its endpoint names this live test process, so say so).
  await ensureBackend(client, {
    launch: () => {
      clear();
      clear = publishDesktop(port);
      return true;
    },
    running: () => false,
    sleep: async () => {},
    waitMs: 1000,
  });
  assert.equal(client.port, port);
  assert.equal(backendPort({}), port);
  assert.equal(backendPort({ PUGPORT_PORT: String(closed) }), closed);
  assert.equal(backendPort({ COMBORUNNER_PORT: String(closed) }), closed);
  assert.equal(await device.probe(), 'device');
  assert.equal(await desktopApp({ port: closed }).probe(), undefined);
  assert.deepEqual(await client.post('/fixture'), { ok: true });
  assert.equal(
    mcpCommand('/fixture', port, '/node', false, true).env,
    undefined,
    'saved MCP configs must not pin a temporary port',
  );
  assert.deepEqual(mcpCommand('/fixture', port, '/node', false, false).env, { PUGPORT_PORT: String(port) });
});

test('device status, result and cancellation follow a restarted desktop without a probe', async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') assert.equal(req.headers['x-agent-token'], 'restarted-session');
    res.end(JSON.stringify({ taskId: 'queued-1', status: 'queued' }));
  });
  await listenForFetch(server);
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  t.after(sessionEndpoint.publishSessionToken('restarted-session', port));
  let clear = publishDesktopPort(await probeLoopbackPort(0));
  t.after(() => clear());
  const device = desktopApp();
  const client = new PugPortClient();
  clear();
  clear = publishDesktopPort(port);
  assert.equal((await device.status('queued-1'))?.status, 'queued');
  assert.equal((await device.result('queued-1', 0))?.status, 'queued');
  assert.equal(await device.cancel('queued-1'), true);
  assert.deepEqual(await client.post('/fixture'), { taskId: 'queued-1', status: 'queued' });
  assert.ok(seen.includes('/api/external/tasks/queued-1/cancel'));
});

test('discovery changes during session retrieval cannot redirect CLI or device writes and tokens', async (t) => {
  for (const kind of ['cli', 'device']) {
    let release!: () => void;
    let received!: () => void;
    const holding = new Promise<void>((done) => {
      release = done;
    });
    const arrived = new Promise<void>((done) => {
      received = done;
    });
    const writes: string[] = [];
    const first = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      received();
      await holding;
      writes.push('first');
      assert.equal(req.headers['x-agent-token'], 'first-session');
      res.statusCode = 201;
      res.end(JSON.stringify({ taskId: 'first-task', status: 'queued' }));
    });
    const second = createServer((req, res) => {
      if (req.method === 'POST') writes.push('second');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, name: 'PugPort', role: 'desktop' }));
    });
    await listenForFetch(first);
    await listenForFetch(second);
    t.after(() => {
      first.close();
      second.close();
    });
    const firstPort = (first.address() as AddressInfo).port;
    const secondPort = (second.address() as AddressInfo).port;
    t.after(sessionEndpoint.publishSessionToken('first-session', firstPort));
    let clear = publishDesktop(firstPort);
    t.after(() => clear());
    const client = new PugPortClient();
    const device = desktopApp();
    const pending =
      kind === 'cli'
        ? client.post('/fixture')
        : device.dispatch({ task: 'synthetic', caller: 'fixture', write: false, untrusted: false }, 'device');
    await arrived;
    clear();
    clear = publishDesktop(secondPort);
    if (kind === 'cli') assert.equal(await client.health(), true);
    else assert.equal(await device.probe(), 'device');
    release();
    await pending;
    assert.deepEqual(writes, ['first']);
    clear();
  }
});

test('main shares the selected origin with all consumers and publishes only after owned readiness', async () => {
  const calls: unknown[][] = [];
  const holder: { changed?: (state: { phase: string }) => void } = {};
  let ready!: () => void;
  const starting = new Promise<void>((done) => {
    ready = done;
  });
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => testDirectory(),
    getAppPath: () => testDirectory(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    isPackaged: false,
    focus: () => undefined,
    exit: (code: number) => calls.push(['exit', code]),
  });
  const webContents = Object.assign(new EventEmitter(), { executeJavaScript: async () => {} });
  const desktop = {
    exiting: false,
    dispose() {},
    window: {
      webContents,
      isDestroyed: () => false,
      setTitle() {},
      on() {},
      loadURL: async (url: string) => calls.push(['url', url]),
    },
  };
  await electronModule(
    'src/electron/main.ts',
    {
      app,
      crashReporter: { start() {} },
      ipcMain: Object.assign(new EventEmitter(), { handle() {} }),
      session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} } } },
      dialog: { showErrorBox: (...args: unknown[]) => assert.fail(JSON.stringify(args)) },
    },
    { calls, starting, desktop, holder, process: { env: {}, platform: 'linux', argv: [] } },
    {
      './backend-port.ts': 'export const selectDesktopPort=async()=>54321;',
      '../server/platform/desktop-endpoint.ts':
        'export const publishDesktopPort=port=>{calls.push(["publish",port]);return ()=>calls.push(["clear"]);};',
      './backend.ts':
        'export class OwnedBackend {state={phase:"ready"};constructor(options){holder.changed=options.changed;calls.push(["backend",options.port]);}async start(){await starting;holder.changed(this.state);}async stop(){}sendAccount(){}}',
      './shell.ts':
        'export const createDesktopShell=options=>{calls.push(["shell",options.origin]);options.onWindowCreated(desktop.window);return desktop;};',
      './web-bridge.ts':
        'export class WebBridge {constructor(options){calls.push(["bridge",options.port]);}dispose(){}}',
      './project-tools.ts':
        'export class ProjectTools {activeTerminals=0;constructor(options){calls.push(["tools",options.origin]);}install(){calls.push(["tools-installed"]);}register(window){calls.push(["tools-window",window===desktop.window]);}dispose(){calls.push(["tools-disposed"]);}}',
      './data-directory.ts': 'export const desktopDataDirectory=()=>"isolated-unused";',
      './taskbar-identity.ts':
        'export const APP_USER_MODEL_ID="fixture",ensureTaskbarIdentity=()=>{},watchTaskbarIdentity=()=>()=>{};',
      './locale.ts': 'export const restoreMainLocale=()=>{},t=text=>text;',
      './page-test.ts': 'export const runPageTest=async()=>({});',
    },
  );
  await nextTurn();
  assert.ok(calls.some(([name, port]) => name === 'backend' && port === 54321));
  assert.ok(calls.some(([name, port]) => name === 'bridge' && port === 54321));
  assert.ok(calls.some(([name, origin]) => name === 'shell' && origin === 'http://127.0.0.1:54321'));
  assert.ok(calls.some(([name, origin]) => name === 'tools' && origin === 'http://127.0.0.1:54321'));
  assert.ok(calls.some(([name]) => name === 'tools-installed'));
  assert.ok(calls.some(([name, owned]) => name === 'tools-window' && owned === true));
  assert.equal(
    calls.some(([name]) => name === 'publish'),
    false,
  );
  ready();
  await nextTurn();
  assert.ok(calls.some(([name, port]) => name === 'publish' && port === 54321));
  assert.ok(calls.some(([name, url]) => name === 'url' && url === 'http://127.0.0.1:54321'));
  holder.changed!({ phase: 'recovering' });
  assert.equal(calls.at(-1)?.[0], 'clear');
  holder.changed!({ phase: 'ready' });
  assert.equal(calls.at(-1)?.[0], 'publish');
  holder.changed!({ phase: 'error' });
  assert.equal(calls.at(-1)?.[0], 'clear');
  holder.changed!({ phase: 'ready' });
  app.emit('will-quit');
  assert.ok(calls.some(([name]) => name === 'clear'));
  assert.ok(calls.some(([name]) => name === 'tools-disposed'));
});

test('session files validate owner and port and clean up only their own content', (t) => {
  assert.match(sessionEndpoint.sessionTokenFile(4317), /[\\/]\.pugport[\\/]session-4317\.json$/);
  const dir = join(testDirectory(), 'session-token-fixture');
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, 'first.json');
  const second = join(dir, 'second.json');
  const remove = sessionEndpoint.publishSessionToken('synthetic', 4317, first);
  const removeSecond = sessionEndpoint.publishSessionToken('other', 4319, second);
  assert.deepEqual(JSON.parse(readFileSync(first, 'utf8')), { token: 'synthetic', pid: process.pid, port: 4317 });
  if (process.platform !== 'win32') assert.equal(statSync(first).mode & 0o777, 0o600);
  assert.equal(sessionEndpoint.readSessionToken(4317, first), 'synthetic');
  assert.equal(sessionEndpoint.readSessionToken(4319, first), undefined);
  removeSecond();
  assert.equal(existsSync(first), true);
  writeFileSync(first, JSON.stringify({ token: 'replacement', pid: process.pid, port: 4317 }));
  remove();
  assert.equal(existsSync(first), true);
  for (const content of ['{', '{}', 'x'.repeat(1025), JSON.stringify({ token: 'x', pid: 2147483647, port: 4317 })]) {
    writeFileSync(first, content);
    assert.equal(sessionEndpoint.readSessionToken(4317, first), undefined);
  }
  const temporary = `${first}.${process.pid}.tmp`;
  writeFileSync(temporary, 'leftover');
  sessionEndpoint.publishSessionToken('new', 4317, first);
  assert.equal(sessionEndpoint.readSessionToken(4317, first), 'new');
  assert.equal(existsSync(temporary), false);
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'file');
  assert.throws(() => sessionEndpoint.publishSessionToken('x', 4317, join(blocked, 'token.json')));
});
