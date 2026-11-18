import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { before, test } from 'node:test';
import type { BrowserWindowConstructorOptions } from 'electron';
import { uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/electron/web-bridge.ts');
});
const target = { agentId: 'muse', name: 'Muse', url: 'https://fixture.test/chat' };
const request = {
  ...target,
  action: 'usage',
  automatic: true,
  background: true,
  usageUrl: 'https://fixture.test/usage',
};
const signature = {
  method: 'GET',
  origin: 'https://fixture.test',
  path: '/api/usage',
  windows: [{ id: 'weekly', label: 'Weekly', percent: { path: ['percent'], scale: 1 } }],
  balances: [],
};

function fixture(
  options: {
    login?: boolean;
    parseError?: boolean;
    network?: boolean;
    timeout?: boolean;
    status?: number;
    location?: string;
  } = {},
) {
  const windows: FakeWindow[] = [];
  const partitions: string[] = [];
  const gets: unknown[] = [];
  let presents = 0;
  let expire: (() => void) | undefined;
  const forbidden = () => {
    throw new Error('Unexpected window presentation or prompt');
  };
  const session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    webRequest: { onBeforeRequest() {} },
    async fetch(url: string, init: RequestInit) {
      gets.push({ url, init });
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'include');
      if (options.network) throw new Error('synthetic offline');
      if (options.timeout) return new Promise<Response>(() => {});
      return new Response(options.parseError ? '{}' : '{"percent":23}', {
        status: options.status ?? (options.login ? 401 : 200),
        headers: options.location ? { location: options.location } : {},
      });
    },
  };
  class FakeWindow extends EventEmitter {
    destroyed = false;
    url = '';
    popup!: (details: { url: string }) => unknown;
    webContents = Object.assign(new EventEmitter(), {
      session,
      getURL: () => this.url,
      isLoading: () => false,
      setWindowOpenHandler: (handler: typeof this.popup) => {
        this.popup = handler;
      },
      focus: forbidden,
      sendInputEvent: forbidden,
      insertText: forbidden,
    });
    constructor(readonly options: BrowserWindowConstructorOptions) {
      super();
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return false;
    }
    setTitle() {}
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    show = forbidden;
    focus = forbidden;
    moveTop = forbidden;
    setAlwaysOnTop = forbidden;
    restore = forbidden;
  }
  const require = createRequire(import.meta.url);
  const h = uiHarness(code, {
    require: (name: string) =>
      name === 'electron'
        ? {
            BrowserWindow: FakeWindow,
            session: {
              fromPartition: (partition: string) => {
                partitions.push(partition);
                return session;
              },
            },
          }
        : require(name),
    AbortSignal,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    setTimeout: (fn: () => void, ms: number) => {
      if (ms === 60_000) {
        expire = fn;
        return { unref() {} };
      }
      return setImmediate(fn);
    },
    clearTimeout() {},
  });
  const bridge = new h.exports.WebBridge({
    port: 1,
    present: () => {
      presents++;
    },
    // Background creation must not inherit a parent, focusability or visible options.
    windowOptions: { show: true, focusable: true, parent: {} },
  });
  bridge.load = async (window: FakeWindow, url: string) => {
    if (options.network) throw new Error('synthetic navigation failure');
    if (options.timeout) return new Promise(() => {});
    window.url = url;
  };
  bridge.page = async (_contents: unknown, script: string) => {
    assert.equal(script, '__pugportBridge.find({})', 'only read the page, never prepare or send a prompt');
    return { check: options.login ? 'login' : '', loginHint: !!options.login, input: true };
  };
  bridge.snapshot = async (contents: { getURL(): string }) => ({
    url: contents.getURL(),
    notices: [],
    text: options.parseError ? 'Welcome' : '免费版 已使用 23% 每周限额将在 10月30日重置',
  });
  bridge.send = forbidden;
  return { bridge, windows, partitions, gets, presents: () => presents, expire: () => expire!() };
}

test('automatic Muse usage creates and destroys an isolated hidden non-focusable login-partition window', async () => {
  const f = fixture();
  const result = await f.bridge.handle(request);
  assert.equal(result.ok, true);
  assert.equal(result.quota.windows[0].usedPercent, 23);
  assert.equal(f.presents(), 0);
  assert.equal(f.windows.length, 1);
  const window = f.windows[0]!;
  assert.equal(window.options.show, false);
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.parent, undefined);
  assert.equal(window.options.webPreferences?.partition, 'persist:pugport-web-muse');
  assert.equal(window.options.webPreferences?.disableDialogs, true);
  assert.equal((window.popup({ url: 'https://fixture.test/login' }) as { action: string }).action, 'deny');
  assert.equal(window.destroyed, true);
  assert.equal(f.bridge.windows.size, 0);
  f.bridge.dispose();
});

test('a learned same-origin GET uses the login session without creating or presenting any window', async () => {
  const f = fixture();
  const result = await f.bridge.handle({ ...request, signatures: [signature] });
  assert.equal(result.ok, true);
  assert.equal(result.quota.windows[0].usedPercent, 23);
  assert.deepEqual(f.partitions, ['persist:pugport-web-muse']);
  assert.equal(f.gets.length, 1);
  assert.equal(f.windows.length, 0);
  assert.equal(f.presents(), 0);
});

test('unsafe signatures never issue a GET and background reads never touch an existing chat window', async () => {
  const f = fixture();
  const existing = {
    isDestroyed: () => false,
    destroy() {},
    webContents: {},
    show() {
      assert.fail('chat shown');
    },
  };
  f.bridge.windows.set('muse', existing);
  const result = await f.bridge.handle({ ...request, signatures: [{ ...signature, origin: 'https://other.test' }] });
  assert.equal(result.ok, true);
  assert.equal(f.gets.length, 0);
  assert.equal(f.bridge.windows.get('muse'), existing);
  assert.equal(f.windows[0]!.destroyed, true);
  assert.equal(f.presents(), 0);
  f.bridge.dispose();
});

test('background GET distinguishes login responses from retryable HTTP failures', async () => {
  for (const [status, location, expected] of [
    [401, undefined, 'login'],
    [302, '/login', 'login'],
    [303, 'https://fixture.test/signin', 'login'],
    [302, '/sign-in', 'login'],
    [403, undefined, 'load-failed'],
    [403, '/login', 'load-failed'],
    [302, '/usage', 'load-failed'],
    [302, '/authors?next=/login', 'load-failed'],
    [503, undefined, 'load-failed'],
  ] as const) {
    const f = fixture({ status, location });
    for (let retry = 0; retry < 2; retry++) {
      const result = await f.bridge.handle({ ...request, signatures: [signature] });
      assert.equal(result.ok, false);
      assert.equal(result.code, expected);
      assert.equal(result.quota, undefined);
      assert.equal(result.message, undefined);
    }
    assert.equal(f.gets.length, 2);
    assert.equal(f.windows.length, 0);
    assert.equal(f.presents(), 0);
    f.bridge.dispose();
  }
});

for (const kind of ['login', 'network', 'parseError', 'timeout'] as const) {
  for (const api of [false, true])
    test(`background ${api ? 'GET' : 'page'} ${kind} is quiet and closes temporary windows`, async () => {
      const f = fixture({ [kind]: true });
      const pending = f.bridge.handle({ ...request, ...(api ? { signatures: [signature] } : {}) });
      if (kind === 'timeout') {
        await new Promise(setImmediate);
        f.expire();
      }
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.message, undefined);
      assert.equal(result.quota, undefined);
      if (kind === 'login') assert.equal(result.code, 'login');
      if (kind === 'timeout') assert.equal(result.code, 'timeout');
      assert.equal(f.presents(), 0);
      assert.ok(f.windows.every((window) => window.destroyed));
      f.bridge.dispose();
    });
}

test('manual usage still presents the window and keeps it open', async () => {
  const f = fixture();
  const result = await f.bridge.handle({ ...target, action: 'usage', navigate: true, usageUrl: request.usageUrl });
  assert.equal(result.ok, true);
  assert.equal(f.presents(), 1);
  assert.equal(f.windows[0]!.destroyed, false);
  f.bridge.dispose();
});

test('monitor confirms sign-in only from an existing usable page without presenting or creating a window', async () => {
  const f = fixture();
  const monitor = { ...target, action: 'monitor', enabled: true, usageSignedOut: true };
  assert.equal((await f.bridge.handle(monitor)).code, 'closed');
  assert.equal(f.windows.length, 0);
  await f.bridge.handle({ ...target, action: 'usage' });
  const presents = f.presents();
  const page = f.bridge.page;
  let checks = 0;
  f.bridge.page = async (...args: unknown[]) => {
    checks++;
    return page(...args);
  };
  for (const usageSignedOut of [undefined, false]) {
    assert.equal((await f.bridge.handle({ ...monitor, usageSignedOut })).authenticated, undefined);
    assert.equal(checks, 0);
  }
  assert.equal((await f.bridge.handle(monitor)).authenticated, true);
  assert.equal(checks, 1);
  f.bridge.page = async () => ({ check: 'login', loginHint: true, input: false });
  assert.equal((await f.bridge.handle(monitor)).authenticated, false);
  assert.equal(f.presents(), presents);
  assert.equal(f.windows.length, 1);
  f.bridge.dispose();
});
