import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chromeEndpoint, chromeMcpConfiguration } from '../src/shared/desktop-tools.ts';
import { electronModule } from './helpers/electron-harness.ts';
import {
  MARKUP_WORLD_ID,
  cleanPageElement,
  cleanPageText,
  pageElementScript,
  pageTextScript,
  pageViewportScript,
} from '../src/electron/page-markup.ts';

const origin = 'http://127.0.0.1:43123';
async function fixture(options: Record<string, unknown> = {}) {
  let number = 0;
  const views: any[] = [],
    ptys: any[] = [],
    calls: any[] = [],
    handlers = new Map();
  class Contents extends EventEmitter {
    id = ++number;
    mainFrame = { url: origin };
    url = origin;
    title = 'Synthetic page';
    destroyed = false;
    sent: any[] = [];
    loading = false;
    emptyImage = false;
    scriptResult: unknown = { width: 800, height: 600 };
    scripts: Array<{ world: number; code: string }> = [];
    async capturePage() {
      return { isEmpty: () => this.emptyImage, toDataURL: () => 'data:image/png;base64,synthetic' };
    }
    async executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>) {
      this.scripts.push({ world, code: scripts[0]!.code });
      return this.scriptResult;
    }
    history = { back: false, forward: false };
    navigationHistory = {
      canGoBack: () => this.history.back,
      canGoForward: () => this.history.forward,
      goBack: () => calls.push('back'),
      goForward: () => calls.push('forward'),
    };
    session: any = {
      clearStorageData: async () => {
        this.session.cleared = true;
      },
      setPermissionRequestHandler: (handler: any) => {
        this.session.permission = handler;
      },
      setPermissionCheckHandler: (handler: any) => {
        this.session.check = handler;
      },
      webRequest: {
        onBeforeRequest: (handler: any) => {
          this.session.request = handler;
        },
      },
      on: (name: string, handler: any) => {
        this.session[name] = handler;
      },
    };
    send(channel: string, data: any) {
      this.sent.push({ channel, data });
    }
    getURL() {
      return this.url;
    }
    getTitle() {
      return this.title;
    }
    isLoading() {
      return this.loading;
    }
    isDestroyed() {
      return this.destroyed;
    }
    setWindowOpenHandler(handler: any) {
      (this as any).open = handler;
    }
    async loadURL(url: string) {
      this.url = url;
      this.emit('did-navigate');
    }
    reload() {
      calls.push('reload');
    }
    stop() {
      calls.push('stop');
    }
    close() {
      this.destroyed = true;
    }
  }
  class Window extends EventEmitter {
    webContents = new Contents();
    destroyed = false;
    children: any[] = [];
    contentView = {
      addChildView: (view: any) => this.children.push(view),
      removeChildView: (view: any) => {
        this.children = this.children.filter((item) => item !== view);
      },
    };
    getContentSize() {
      return [800, 600];
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  class View {
    webContents = new Contents();
    visible = false;
    bounds: unknown;
    constructor(readonly options: any) {
      this.webContents.url = '';
      views.push(this);
    }
    setVisible(value: boolean) {
      this.visible = value;
    }
    setBounds(value: unknown) {
      this.bounds = value;
    }
  }
  const exports = await electronModule(
    'src/electron/project-tools.ts',
    {
      app: { getAppPath: () => process.cwd() },
      BrowserWindow: Window,
      WebContentsView: View,
      ipcMain: {
        handle: (name: string, fn: any) => handlers.set(name, fn),
        removeHandler: (name: string) => handlers.delete(name),
      },
    },
    { TextDecoder, AbortController },
  );
  const manager = new exports.ProjectTools({
    origin,
    context: async (id: string) => ({ conversationId: id, projectId: 'project', directory: 'C:/Synthetic' }),
    spawn: (shell: string, args: string[], settings: any) => {
      const pty: any = {
        shell,
        args,
        settings,
        killed: 0,
        input: [],
        resize: (cols: number, rows: number) => {
          pty.size = [cols, rows];
        },
        write: (value: string) => pty.input.push(value),
        kill: () => pty.killed++,
        onData: (fn: any) => {
          pty.data = fn;
          return {
            dispose: () => {
              pty.data = () => {};
            },
          };
        },
        onExit: (fn: any) => {
          pty.exit = fn;
          return { dispose: () => {} };
        },
      };
      ptys.push(pty);
      return pty;
    },
    ...options,
  });
  const window = new Window();
  manager.install();
  manager.register(window);
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const call = (value: unknown, from = event) => manager.handle(from, value);
  return { manager, exports, window, Window, views, ptys, calls, call, event, handlers };
}

test('desktop tools only accept the registered window main frame, not foreign origins or child frames', async () => {
  const f = await fixture();
  const action = {
    action: 'terminal.open',
    conversationId: 'one',
    size: { cols: 80, rows: 24 },
    directory: 'C:/Forged',
  };
  for (const event of [
    { ...f.event, senderFrame: { url: origin } },
    { sender: new f.Window().webContents, senderFrame: f.event.senderFrame },
    { ...f.event, senderFrame: undefined },
  ])
    await assert.rejects(f.call(action, event as any), /窗口/);
  f.window.webContents.mainFrame.url = 'https://example.test';
  await assert.rejects(f.call(action), /来源/);
  assert.equal(f.ptys.length, 0);
  f.manager.dispose();
});

test('terminal creation is idempotent, ignores supplied paths, bounds input/output and closes only its owned PTY', async () => {
  const f = await fixture();
  const request = {
    action: 'terminal.open',
    conversationId: 'one',
    size: { cols: 80, rows: 24 },
    directory: 'C:/Forged',
  };
  const [first, second] = (await Promise.all([f.call(request), f.call(request)])) as any[];
  assert.equal(first.id, second.id);
  assert.equal(f.ptys.length, 1);
  assert.equal(f.ptys[0].settings.cwd, 'C:/Synthetic');
  assert.equal(f.ptys[0].settings.env.PUGPORT_UNDER_TEST, undefined);
  await f.call({ action: 'terminal.write', id: first.id, data: 'synthetic pasted secret\r' });
  assert.deepEqual(f.ptys[0].input, ['synthetic pasted secret\r']);
  assert.equal(f.window.webContents.sent.length, 0, 'input is never emitted or logged');
  await assert.rejects(f.call({ action: 'terminal.write', id: first.id, data: 'x'.repeat(65537) }), /过长/);
  await assert.rejects(f.call({ action: 'terminal.resize', id: first.id, size: { cols: Infinity, rows: 24 } }), /尺寸/);
  await f.call({ action: 'terminal.resize', id: first.id, size: { cols: 100, rows: 40 } });
  assert.deepEqual(f.ptys[0].size, [100, 40]);
  const other = new f.Window();
  f.manager.register(other);
  await assert.rejects(
    f.call(
      { action: 'terminal.close', id: first.id },
      { sender: other.webContents, senderFrame: other.webContents.mainFrame },
    ),
    /不属于/,
  );
  for (let index = 0; index < 2000; index++) f.ptys[0].data('output'.repeat(100));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.window.webContents.sent.length, 1, 'high output is batched, not one IPC per chunk');
  assert.ok(f.window.webContents.sent[0].data.data.length < 263000);
  const restored: any = await f.call(request);
  assert.ok(restored.output.length <= 262144);
  await f.call({ action: 'terminal.close', id: first.id });
  assert.equal(f.ptys[0].killed, 1);
  f.manager.dispose();
  assert.equal(f.ptys[0].killed, 1);
});

test('closing or crashing a window while context is pending cannot create a late terminal', async () => {
  let finish!: (value: unknown) => void;
  const f = await fixture({
    context: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = f.call({ action: 'terminal.open', conversationId: 'one', size: { cols: 80, rows: 24 } });
  f.window.webContents.emit('render-process-gone');
  finish({ conversationId: 'one', projectId: 'p', directory: 'C:/Synthetic' });
  await assert.rejects(pending, /变化/);
  assert.equal(f.ptys.length, 0);
  f.manager.dispose();
});

test('browser is an isolated owned view with navigation, bounded layout and blocked app/file/permission/download access', async () => {
  const f = await fixture();
  const browser: any = await f.call({ action: 'browser.open', conversationId: 'one' });
  const view = f.views[0],
    contents = view.webContents;
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.contextIsolation, true);
  assert.match(view.options.webPreferences.partition, /^persist:pugport-browser-/);
  assert.equal(view.options.webPreferences.preload, undefined);
  for (const url of [
    'file:///C:/secret.txt',
    `${origin}/api/session`,
    'http://localhost:43123/',
    'http://127.1:43123/',
    'ws://localhost:43123/events',
    'https://anything.test:43123/',
  ]) {
    let cancel;
    contents.session.request({ url }, (value: any) => {
      cancel = value.cancel;
    });
    assert.equal(cancel, true, url);
  }
  let cancel;
  contents.session.request({ url: 'https://example.test/image.png' }, (value: any) => {
    cancel = value.cancel;
  });
  assert.equal(cancel, false);
  let granted;
  contents.session.permission(null, 'camera', (value: boolean) => {
    granted = value;
  });
  assert.equal(granted, false);
  assert.equal(contents.session.check(), false);
  let download = false;
  contents.session['will-download']({
    preventDefault: () => {
      download = true;
    },
  });
  assert.equal(download, true);
  await assert.rejects(
    f.call({ action: 'browser.action', id: browser.id, command: 'navigate', url: origin }),
    /不能访问/,
  );
  await f.call({ action: 'browser.action', id: browser.id, command: 'navigate', url: 'https://example.test/' });
  assert.equal(contents.url, 'https://example.test/');
  contents.history.back = true;
  await f.call({ action: 'browser.action', id: browser.id, command: 'back' });
  assert.deepEqual(f.calls, ['back']);
  let prevented = false;
  contents.emit(
    'will-redirect',
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    'file:///C:/secret',
  );
  assert.equal(prevented, true);
  await f.call({ action: 'browser.bounds', id: browser.id, bounds: { x: -10, y: 500, width: 1000, height: 300 } });
  assert.deepEqual(JSON.parse(JSON.stringify(view.bounds)), { x: 0, y: 500, width: 800, height: 100 });
  assert.equal(view.visible, true);
  await f.call({ action: 'browser.bounds', id: browser.id, bounds: null });
  assert.equal(view.visible, false);
  await assert.rejects(f.call({ action: 'browser.bounds', id: browser.id, bounds: { x: 0 } }), /区域/);
  f.window.close();
  assert.equal(contents.destroyed, true);
  f.manager.dispose();
});

test('explicit Chrome connection only contacts the supplied loopback service and activates existing pages', async () => {
  const seen: string[] = [];
  const f = await fixture({
    request: async (url: string, options: any) => {
      seen.push(url);
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/json/version')) return Response.json({ Browser: 'Chrome/150.0.0.0' });
      if (url.endsWith('/json/list'))
        return Response.json([
          { id: 'page-one', type: 'page', title: 'Synthetic', url: 'https://example.test/' },
          { id: 'worker', type: 'service_worker', url: 'chrome-extension://id' },
        ]);
      return new Response('Target activated');
    },
  });
  for (const endpoint of [
    'http://example.com:9222',
    'file:///C:/profile',
    'http://127.0.0.1:9222/path',
    'http://user:pass@127.0.0.1:9222',
    origin,
  ])
    await assert.rejects(f.call({ action: 'chrome.connect', conversationId: 'one', endpoint }));
  assert.equal(seen.length, 0);
  const connection: any = await f.call({
    action: 'chrome.connect',
    conversationId: 'one',
    endpoint: 'http://localhost:9222',
  });
  assert.equal(connection.endpoint, 'http://127.0.0.1:9222');
  assert.equal(connection.pages.length, 1);
  assert.equal(f.views.length, 0);
  assert.equal(f.ptys.length, 0);
  await assert.rejects(f.call({ action: 'chrome.activate', id: connection.id, pageId: '../close' }), /已经关闭/);
  await f.call({ action: 'chrome.activate', id: connection.id, pageId: 'page-one' });
  assert.equal(seen.at(-1), 'http://127.0.0.1:9222/json/activate/page-one');
  await f.call({ action: 'chrome.disconnect', id: connection.id });
  await assert.rejects(f.call({ action: 'chrome.refresh', id: connection.id }), /不属于/);
  assert.ok(seen.every((url) => !/cookie|close|new|profile/.test(url)));
  f.manager.dispose();
});

test('private conversations use disposable browser storage and close clears it', async () => {
  const f = await fixture({
    context: async (id: string) => ({ conversationId: id, projectId: 'p', directory: 'C:/Synthetic', incognito: true }),
  });
  const browser: any = await f.call({ action: 'browser.open', conversationId: 'private-chat' });
  assert.match(f.views[0].options.webPreferences.partition, /^pugport-browser-private-/);
  await f.call({ action: 'browser.close', id: browser.id });
  assert.equal(f.views[0].webContents.session.cleared, true);
  f.manager.dispose();
});

test('disconnect during Chrome refresh prevents a late activation', async () => {
  let hold = false,
    finish!: () => void;
  const requests: string[] = [];
  const f = await fixture({
    request: async (url: string) => {
      requests.push(url);
      if (hold)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      if (url.endsWith('/json/version')) return Response.json({ Browser: 'Chrome/150.0' });
      return Response.json([{ id: 'page-one', type: 'page', url: 'https://example.test/' }]);
    },
  });
  const connection: any = await f.call({
    action: 'chrome.connect',
    conversationId: 'one',
    endpoint: 'http://127.0.0.1:9222',
  });
  hold = true;
  const activating = f.call({ action: 'chrome.activate', id: connection.id, pageId: 'page-one' });
  await new Promise((resolve) => setImmediate(resolve));
  await f.call({ action: 'chrome.disconnect', id: connection.id });
  hold = false;
  finish();
  await assert.rejects(activating);
  assert.ok(requests.every((url) => !url.includes('/json/activate/')));
  f.manager.dispose();
});

test('desktop context uses a local session token and canonical directory; Chrome config never auto-connects or launches a profile', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-tools-context-')));
  t.after(async () => {
    assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-tools-context-'));
    await rm(directory, { recursive: true });
  });
  const f = await fixture();
  const calls: any[] = [];
  const context = await f.exports.desktopToolContext(
    origin,
    'one',
    async (url: string, options: any) => {
      calls.push({ url, options });
      return Response.json(
        url.endsWith('/api/session')
          ? { token: 'synthetic-token' }
          : { conversationId: 'one', projectId: 'p', directory },
      );
    },
    'synthetic-token',
  );
  assert.equal(context.directory, directory);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-agent-token'], 'synthetic-token');
  assert.equal(calls[0].url, `${origin}/api/conversations/one/desktop-context`);
  await assert.rejects(
    f.exports.desktopToolContext(origin, 'one', async () => {
      assert.fail('must not request without a token');
    }),
    /本地会话无法确认/,
  );
  assert.equal(chromeEndpoint('http://localhost:9222'), 'http://127.0.0.1:9222');
  const config = chromeMcpConfiguration('http://127.0.0.1:9222');
  assert.match(config, /--browser-url=http:\/\/127\.0\.0\.1:9222/);
  assert.doesNotMatch(config, /autoConnect|user-data-dir|executablePath/);
  f.manager.dispose();
});

test('page capture strips URL secrets and uses the isolated viewport; queries whitelist and bound page facts', async (t) => {
  const f = await fixture();
  t.after(() => f.manager.dispose());
  const { id } = await f.call({ action: 'browser.open', conversationId: 'page' });
  const contents = f.views[0].webContents;
  contents.url = 'https://example.test/pricing?secret=1#frag';
  // Without a <title> Chromium's getTitle() is the full address; the title must come from document.title.
  contents.title = 'example.test/pricing?secret=1#frag';
  contents.scriptResult = { width: 800, height: 600, title: '  Pricing\n ' + 'x'.repeat(200) };
  const capture = await f.call({ action: 'browser.capture', id });
  assert.equal(capture.url, 'https://example.test/pricing');
  assert.equal(capture.title.length, 120);
  assert.match(capture.title, /^Pricing x/);
  assert.doesNotMatch(JSON.stringify(capture), /secret/);
  assert.deepEqual(JSON.parse(JSON.stringify(capture.viewport)), { width: 800, height: 600 });
  assert.match(capture.dataUrl, /^data:image\/png;base64,/);
  contents.scriptResult = {
    tag: 'DIV<',
    selector: 'x'.repeat(400),
    role: ' a\n b ',
    name: 'n'.repeat(200),
    text: 't'.repeat(200),
    value: 'SECRET-VALUE',
    rect: { x: -5, y: 2, width: 30000, height: 30 },
    frame: false,
  };
  const hit = await f.call({ action: 'browser.element', id, point: { x: 17, y: 23 } });
  assert.equal(hit.tag, 'unknown');
  assert.equal(hit.value, undefined);
  assert.equal(hit.selector.length, 300);
  assert.equal(hit.name.length, 120);
  assert.equal(hit.text.length, 120);
  assert.equal(hit.role, 'a b');
  assert.equal(hit.rect.x, 0);
  assert.equal(hit.rect.width, 20000);
  assert.ok(contents.scripts.every((script: any) => script.world === MARKUP_WORLD_ID && script.world !== 0));
  assert.match(contents.scripts.at(-1).code, /elementFromPoint\(17, 23\)/);
  contents.scriptResult = '  Pro\n $29/month ' + 'x'.repeat(500);
  const text = await f.call({ action: 'browser.text', id, rect: { x: 0, y: 0, width: 100, height: 100 } });
  assert.equal(text.length, 300);
  assert.match(text, /^Pro \$29\/month /);
  assert.equal(cleanPageText(null), '');
  assert.equal(cleanPageElement({ tag: 'div', rect: { x: NaN, y: 0, width: 1, height: 1 } }), null);
  assert.equal(
    cleanPageElement({ tag: 'input', text: 'SECRET-VALUE', rect: { x: 0, y: 0, width: 1, height: 1 } })?.text,
    '',
  );
});

test('page annotation validates all coordinates and ownership for every action', async (t) => {
  const f = await fixture();
  t.after(() => f.manager.dispose());
  const { id } = await f.call({ action: 'browser.open', conversationId: 'page' });
  for (const point of [
    null,
    {},
    { x: NaN, y: 1 },
    { x: Infinity, y: 1 },
    { x: -1, y: 1 },
    { x: 20001, y: 1 },
    { x: '1', y: 1 },
  ])
    await assert.rejects(f.call({ action: 'browser.element', id, point }), /标注位置无效/);
  for (const rect of [
    null,
    {},
    { x: 0, y: 0, width: -1, height: 1 },
    { x: 0, y: NaN, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: 20001 },
  ])
    await assert.rejects(f.call({ action: 'browser.text', id, rect }), /标注区域无效/);
  const other = new f.Window();
  f.manager.register(other);
  for (const action of ['browser.capture', 'browser.element', 'browser.text']) {
    await assert.rejects(
      f.call({ action, id }, { sender: other.webContents, senderFrame: other.webContents.mainFrame }),
      /不属于/,
    );
    await assert.rejects(f.call({ action, id }, { ...f.event, senderFrame: { url: origin } }), /窗口/);
    f.window.webContents.mainFrame.url = 'https://foreign.test/';
    await assert.rejects(f.call({ action, id }), /来源/);
    f.window.webContents.mainFrame.url = origin;
  }
  assert.equal(f.views[0].webContents.scripts.length, 0);
});

test('page capture rejects blank, loading, empty, destroyed and malformed viewport states', async (t) => {
  const f = await fixture();
  t.after(() => f.manager.dispose());
  const { id } = await f.call({ action: 'browser.open', conversationId: 'page' });
  const contents = f.views[0].webContents;
  await assert.rejects(f.call({ action: 'browser.capture', id }), /还没有打开网页/);
  contents.url = 'https://example.test/';
  contents.loading = true;
  await assert.rejects(f.call({ action: 'browser.capture', id }), /还在加载/);
  contents.loading = false;
  contents.emptyImage = true;
  await assert.rejects(f.call({ action: 'browser.capture', id }), /网页截图失败，请重试。/);
  contents.emptyImage = false;
  contents.scriptResult = { width: 0, height: 10 };
  await assert.rejects(f.call({ action: 'browser.capture', id }), /截图失败/);
  contents.destroyed = true;
  await assert.rejects(f.call({ action: 'browser.capture', id }), /网页已停止/);
});

test('page queries require a capture and return empty after navigation, including in-flight navigation', async (t) => {
  const f = await fixture();
  t.after(() => f.manager.dispose());
  const { id } = await f.call({ action: 'browser.open', conversationId: 'page' });
  const contents = f.views[0].webContents;
  const element = { action: 'browser.element', id, point: { x: 1, y: 2 } };
  const text = { action: 'browser.text', id, rect: { x: 0, y: 0, width: 10, height: 10 } };
  assert.equal(await f.call(element), null);
  assert.equal(await f.call(text), '');
  contents.url = 'https://example.test/pricing?one=1';
  await f.call({ action: 'browser.capture', id });
  contents.scriptResult = 'same page';
  assert.equal(await f.call(text), 'same page');
  // A query or hash navigation (a hash router going to #/login) is a different page too.
  contents.url = 'https://example.test/pricing?one=1#/login';
  assert.equal(await f.call(text), '');
  contents.url = 'https://example.test/changed';
  const count = contents.scripts.length;
  assert.equal(await f.call(element), null);
  assert.equal(await f.call(text), '');
  assert.equal(contents.scripts.length, count);
  for (const request of [element, text]) {
    contents.url = 'https://example.test/pricing?one=1';
    let finish!: (raw: unknown) => void;
    contents.scriptResult = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = f.call(request);
    contents.url = 'https://example.test/changed';
    finish({ tag: 'button', rect: { x: 0, y: 0, width: 10, height: 10 } });
    assert.equal(await pending, request === element ? null : '');
  }
});

test('page scripts time out and reject late results after ownership is lost', async (t) => {
  const f = await fixture({ scriptTimeoutMs: 50 });
  t.after(() => f.manager.dispose());
  const { id } = await f.call({ action: 'browser.open', conversationId: 'page' });
  const contents = f.views[0].webContents;
  contents.url = 'https://example.test/pricing';
  await f.call({ action: 'browser.capture', id });
  contents.scriptResult = new Promise(() => {});
  const start = performance.now();
  await assert.rejects(f.call({ action: 'browser.element', id, point: { x: 1, y: 2 } }), /网页没有响应/);
  assert.ok(performance.now() - start < 500);
  let finish!: (raw: unknown) => void;
  contents.scriptResult = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = f.call({ action: 'browser.text', id, rect: { x: 0, y: 0, width: 10, height: 10 } });
  f.window.close();
  finish('late text');
  await assert.rejects(pending, /窗口|不属于/);
});

test('page scripts execute without reading control state, traversing frames or installing globals', () => {
  const rect = { x: 10, y: 20, width: 100, height: 40, left: 10, top: 20, right: 110, bottom: 60 };
  const el: any = {
    tagName: 'INPUT',
    id: 'email',
    classList: [],
    getAttribute: (name: string) => (name === 'placeholder' ? '  Email\n address ' : null),
    getBoundingClientRect: () => rect,
  };
  for (const name of ['value', 'defaultValue', 'checked', 'files', 'contentDocument'])
    Object.defineProperty(el, name, { get: () => assert.fail(`read forbidden field ${name}`) });
  const excluded = {
    parentElement: { closest: () => el },
    get textContent(): never {
      return assert.fail('read excluded control or frame text');
    },
  };
  const text = { parentElement: { closest: () => null }, textContent: '  Pro\n $29/month ' };
  const body = { nodes: [excluded, text] };
  el.parentElement = body;
  const context: any = {
    innerWidth: 800,
    innerHeight: 600,
    NodeFilter: { SHOW_TEXT: 4 },
    CSS: { escape: (s: string) => s },
    document: {
      body,
      documentElement: {},
      elementFromPoint: () => el,
      querySelectorAll: () => [el],
      createTreeWalker: (root: any) => {
        let index = 0;
        return { nextNode: () => root.nodes?.[index++] };
      },
      createRange: () => ({ selectNodeContents: () => {}, getClientRects: () => [rect] }),
    },
  };
  const keys = Object.keys(context);
  const viewport = runInNewContext(pageViewportScript, context);
  assert.equal(viewport.width, 800);
  const hit = runInNewContext(pageElementScript({ x: 15, y: 25 }), context);
  assert.equal(hit.selector, '#email');
  assert.equal(hit.text, '');
  assert.equal(hit.name, 'Email address');
  assert.equal(runInNewContext(pageTextScript({ x: 0, y: 0, width: 200, height: 100 }), context), 'Pro $29/month');
  assert.equal(runInNewContext(pageTextScript({ x: 500, y: 500, width: 20, height: 20 }), context), '');
  el.tagName = 'IFRAME';
  assert.equal(runInNewContext(pageElementScript({ x: 15, y: 25 }), context).frame, true);
  assert.deepEqual(Object.keys(context), keys);
});

test('page selectors prefer test IDs, skip generated IDs and unstable classes, and distinguish siblings', () => {
  const body = {};
  const el: any = {
    tagName: 'BUTTON',
    id: 'stable-id',
    classList: [],
    parentElement: body,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  };
  let attributes: Record<string, string> = {};
  let siblings = false;
  el.getAttribute = (name: string) => attributes[name] ?? null;
  const context = {
    NodeFilter: { SHOW_TEXT: 4 },
    CSS: { escape: (s: string) => s },
    document: {
      body,
      documentElement: {},
      elementFromPoint: () => el,
      querySelectorAll: (selector: string) => (siblings && !selector.includes(':nth-of-type(2)') ? [el, el] : [el]),
      createTreeWalker: () => ({ nextNode: () => null }),
    },
  };
  const selector = () => runInNewContext(pageElementScript({ x: 1, y: 1 }), context).selector;
  attributes = { 'data-testid': 'cta', 'aria-label': 'Start' };
  assert.equal(selector(), 'button[data-testid="cta"]');
  attributes = {};
  assert.equal(selector(), '#stable-id');
  for (const id of [':r1:', 'radix-:r3:', 'input-48213', 'GeneratedABC1def']) {
    el.id = id;
    attributes = { 'aria-label': 'Start' };
    assert.equal(selector(), 'button[aria-label="Start"]');
  }
  attributes = {};
  el.classList = ['css-abc', 'hover:active', '[data-state]', 'GeneratedABC1def', 'stable', 'primary', 'extra'];
  assert.equal(selector(), 'button.stable.primary');
  siblings = true;
  Object.assign(body, { children: [{ tagName: 'BUTTON' }, el] });
  assert.equal(selector(), 'button.stable.primary:nth-of-type(2)');
});
