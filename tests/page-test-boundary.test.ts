import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { electronModule } from './helpers/electron-harness.ts';

const appPort = 43123;
async function fixture(onLoad?: (contents: any) => void) {
  let created = 0,
    destroyed = 0,
    hookInstalledBeforeLoad = false,
    permissionsInstalledBeforeLoad = false;
  let requestHook!: (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
  let permissionRequestHook:
    ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined;
  let permissionCheckHook: ((contents: unknown, permission: string, origin: string) => boolean) | undefined;
  let contents!: any;
  class Window {
    webContents: any;
    constructor(readonly options: any) {
      created++;
      contents = Object.assign(new EventEmitter(), {
        session: {
          setPermissionRequestHandler: (callback: NonNullable<typeof permissionRequestHook>) => {
            permissionRequestHook = callback;
          },
          setPermissionCheckHandler: (callback: NonNullable<typeof permissionCheckHook>) => {
            permissionCheckHook = callback;
          },
          webRequest: {
            onBeforeRequest: (callback: typeof requestHook) => {
              requestHook = callback;
            },
          },
        },
        setWindowOpenHandler: () => {},
        capturePage: async () => ({ toPNG: () => Buffer.from('fixture screenshot') }),
        getTitle: () => 'fixture page',
        executeJavaScript: async () => 'ready',
      });
      this.webContents = contents;
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.match(options.webPreferences.partition, /^page-test-/);
    }
    async loadURL() {
      hookInstalledBeforeLoad = !!requestHook;
      permissionsInstalledBeforeLoad = !!permissionRequestHook && !!permissionCheckHook;
      onLoad?.(contents);
    }
    destroy() {
      destroyed++;
    }
  }
  const module = await electronModule(
    'src/electron/page-test.ts',
    { BrowserWindow: Window },
    {
      setTimeout: (callback: (...args: any[]) => void, ms: number) => setTimeout(callback, ms < 1000 ? 0 : ms),
    },
  );
  return {
    run: module.runPageTest,
    stats: () => ({ created, destroyed, hookInstalledBeforeLoad, permissionsInstalledBeforeLoad }),
    blocked: (url: string) => {
      let blocked: boolean | undefined;
      requestHook({ url }, (result) => {
        blocked = result.cancel;
      });
      return blocked;
    },
    requestPermission: (permission: string) => {
      assert.ok(permissionRequestHook, 'permission request handler must be installed');
      let granted: boolean | undefined;
      permissionRequestHook(contents, permission, (result) => {
        granted = result;
      });
      return granted;
    },
    checkPermission: (permission: string) => {
      assert.ok(permissionCheckHook, 'permission check handler must be installed');
      return permissionCheckHook(contents, permission, 'http://localhost:5173');
    },
  };
}

test('a page test rejects the private app before creating any browser window', async () => {
  const f = await fixture();
  for (const host of ['localhost', '127.1', '2130706433', '0x7f000001', '[::1]', 'app.localhost']) {
    const result = await f.run({ url: `http://${host}:${appPort}/`, steps: [] }, 'unused', appPort);
    assert.match(result.error, /不能访问 PugPort/);
  }
  assert.equal(f.stats().created, 0);
});

test('an ordinary local page works, while all of its private-app resource requests are blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comborunner-page-boundary-'));
  const f = await fixture();
  try {
    const result = await f.run(
      { url: 'http://localhost:5173/', steps: [{ action: 'expect_text', text: 'ready' }] },
      root,
      appPort,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.steps[0].ok, true);
    assert.equal(result.screenshots.length, 1);
    assert.deepEqual(f.stats(), {
      created: 1,
      destroyed: 1,
      hookInstalledBeforeLoad: true,
      permissionsInstalledBeforeLoad: true,
    });
    for (const permission of [
      'media',
      'camera',
      'microphone',
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture',
      'unknown',
    ]) {
      assert.equal(f.requestPermission(permission), false, permission);
      assert.equal(f.checkPermission(permission), false, permission);
    }
    for (const host of ['localhost', '127.1', '2130706433', '0x7f000001', '[::1]', 'app.localhost']) {
      assert.equal(f.blocked(`http://${host}:${appPort}/api/session`), true, host);
      assert.equal(f.blocked(`ws://${host}:${appPort}/events`), true, host);
    }
    assert.equal(f.blocked('http://localhost:5173/api/data'), false);
    assert.equal(f.blocked('https://example.com/styles.css'), false, 'external page assets remain usable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('redirects and page navigation cannot gain private-app access or continue executing steps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comborunner-page-redirect-'));
  try {
    for (const event of ['will-navigate', 'will-redirect']) {
      let prevented = false;
      const f = await fixture((contents) =>
        contents.emit(
          event,
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          `http://localhost:${appPort}/`,
        ),
      );
      const result = await f.run(
        { url: 'file:///C:/fixture/index.html', steps: [{ action: 'click', target: 'delete' }] },
        root,
        appPort,
      );
      assert.equal(prevented, true);
      assert.match(result.error, /已拦截/);
      assert.equal(result.steps.length, 0);
      assert.equal(f.stats().destroyed, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
