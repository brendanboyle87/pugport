import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  buildUiOnly,
  finishUiDirectory,
  requireUiBaseline,
  saveUiBaseline,
  uiBootstrap,
  uiCompatibility,
} from '../scripts/ui-release.mjs';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pugport-ui-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    'src/server/main.ts',
    'src/electron/main.ts',
    'src/shared/types.ts',
    'package.json',
    'package-lock.json',
    'scripts/build.mjs',
    'scripts/ui-release.mjs',
    'dist/server/main.js',
    'dist/electron/main.cjs',
    'dist/electron/preload.cjs',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path);
  }
  const compatibility = await uiCompatibility(root);
  const staging = join(root, 'dist/ui-releases/.staging-baseline');
  await emitUi(staging, 'baseline');
  await finishUiDirectory(staging, { buildId: 'baseline', compatibility });
  await saveUiBaseline(root, { buildId: 'baseline', compatibility }, staging);
  return { root, compatibility };
}

async function emitUi(directory: string, buildId: string) {
  await mkdir(join(directory, 'assets'), { recursive: true });
  await writeFile(join(directory, 'assets/main.js'), 'window.fixture = true;');
  await writeFile(
    join(directory, 'index.html'),
    `<html><head></head><body><script type="module" src="/ui-releases/${buildId}/assets/main.js"></script></body></html>`,
  );
}

test('UI-only builds activate complete immutable releases without modifying runtime artifacts', async (t) => {
  const { root, compatibility } = await fixture(t);
  const before = await readFile(join(root, 'dist/server/main.js'), 'utf8');
  const first = await buildUiOnly(root, async (options: any) => {
    const buildId = JSON.parse(options.define.__PUGPORT_UI_BUILD_ID__);
    assert.equal(JSON.parse(options.define.__PUGPORT_UI_COMPATIBILITY__), compatibility);
    assert.equal(options.base, `/ui-releases/${buildId}/`);
    assert.equal(JSON.parse(await readFile(join(root, 'dist/ui-releases/active.json'), 'utf8')).buildId, 'baseline');
    await emitUi(options.build.outDir, buildId);
  });
  assert.equal(first.previousBuildId, 'baseline');
  assert.equal(JSON.parse(await readFile(join(root, 'dist/ui-releases/active.json'), 'utf8')).buildId, first.buildId);
  assert.equal(await readFile(join(root, 'dist/server/main.js'), 'utf8'), before);
  assert.match(await readFile(join(root, 'dist/ui-releases', first.buildId, 'index.html'), 'utf8'), /pugport:ui-ready/);
  await assert.rejects(
    buildUiOnly(root, async () => {
      throw new Error('synthetic build failure');
    }),
    /synthetic build failure/,
  );
  assert.equal(JSON.parse(await readFile(join(root, 'dist/ui-releases/active.json'), 'utf8')).buildId, first.buildId);
  assert.equal(
    (await readdir(join(root, 'dist/ui-releases'))).some((path) => path.startsWith('.staging-')),
    false,
  );
  assert.match(await readFile(join(root, 'dist/ui-releases/baseline/assets/main.js'), 'utf8'), /fixture/);
  const second = await buildUiOnly(root, async (options: any) => {
    await emitUi(options.build.outDir, JSON.parse(options.define.__PUGPORT_UI_BUILD_ID__));
  });
  assert.equal(second.previousBuildId, first.buildId);
  assert.match(await readFile(join(root, 'dist/ui-releases', first.buildId, 'assets/main.js'), 'utf8'), /fixture/);
});

test('UI-only build refuses changed backend, dependencies, built runtime, and a race during compilation', async (t) => {
  const { root, compatibility } = await fixture(t);
  await writeFile(join(root, 'src/server/main.ts'), 'changed backend');
  await assert.rejects(
    buildUiOnly(root, async () => assert.fail('must not build')),
    /Backend, desktop/,
  );
  await writeFile(join(root, 'src/server/main.ts'), 'src/server/main.ts');
  await writeFile(join(root, 'dist/electron/preload.cjs'), 'changed desktop binary');
  await assert.rejects(requireUiBaseline(root, compatibility), /Built backend or desktop/);
  await writeFile(join(root, 'dist/electron/preload.cjs'), 'dist/electron/preload.cjs');
  await assert.rejects(
    buildUiOnly(root, async (options: any) => {
      await emitUi(options.build.outDir, JSON.parse(options.define.__PUGPORT_UI_BUILD_ID__));
      await writeFile(join(root, 'package-lock.json'), 'changed dependencies');
    }),
    /contract changed during/,
  );
  assert.equal(JSON.parse(await readFile(join(root, 'dist/ui-releases/active.json'), 'utf8')).buildId, 'baseline');
});

test('incomplete or remote executable assets cannot become a UI release', async (t) => {
  const { root, compatibility } = await fixture(t);
  const directory = join(root, 'broken');
  await emitUi(directory, 'broken');
  await writeFile(
    join(directory, 'index.html'),
    '<html><head></head><script type="module" src="https://remote.invalid/main.js"></script></html>',
  );
  await assert.rejects(finishUiDirectory(directory, { buildId: 'broken', compatibility }), /complete, local/);
});

test('UI builds refuse redirected release folders and reject staging paths outside their exact build directory', async (t) => {
  const { root, compatibility } = await fixture(t);
  const outside = join(root, 'unrelated');
  await mkdir(outside);
  await writeFile(join(outside, 'preserve.txt'), 'preserve');
  await assert.rejects(
    saveUiBaseline(root, { buildId: 'unexpected', compatibility }, outside),
    /outside its build root/,
  );
  const releases = join(root, 'dist/ui-releases');
  await rename(releases, join(root, 'saved-releases'));
  await symlink(outside, releases, 'junction');
  await assert.rejects(
    buildUiOnly(root, async () => assert.fail('must not build through junction')),
    /must not be redirected/,
  );
  assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(outside), ['preserve.txt']);
});

test('UI build cleanup refuses a staging junction substituted during a failed compilation', async (t) => {
  const { root } = await fixture(t);
  const outside = join(root, 'unrelated');
  await mkdir(outside);
  await writeFile(join(outside, 'preserve.txt'), 'preserve');
  await assert.rejects(
    buildUiOnly(root, async (options: any) => {
      await symlink(outside, options.build.outDir, 'junction');
      throw new Error('synthetic build failed');
    }),
    /must not be redirected/,
  );
  assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'preserve');
});

test('pre-entry watchdog recovers a broken module with auth once and stops after renderer ready', async () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const storage = new Map<string, string>();
  const requests: { path: string; init: any }[] = [];
  const navigations: string[] = [];
  let timeout: (() => Promise<void>) | undefined;
  class Script {}
  const context = {
    sessionStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    location: { origin: 'http://127.0.0.1:4000', replace: (url: string) => navigations.push(url) },
    fetch: async (path: string, init: any) => {
      requests.push({ path, init });
      return {
        ok: true,
        json: async () =>
          path === '/api/session'
            ? { token: 'token' }
            : { buildId: 'baseline', compatibility: 'contract', url: '/?uiBuild=baseline' },
      };
    },
    setTimeout: (callback: () => Promise<void>) => {
      timeout = callback;
      return 1;
    },
    clearTimeout: () => {},
    addEventListener: (name: string, callback: (...args: any[]) => void) => listeners.set(name, callback),
    HTMLScriptElement: Script,
    URL,
  };
  runInNewContext(`(${uiBootstrap.toString()})('broken', 'contract')`, context);
  await timeout!();
  assert.deepEqual(navigations, ['http://127.0.0.1:4000/?uiBuild=baseline']);
  assert.equal(requests[1].init.headers['x-agent-token'], 'token');
  assert.deepEqual(JSON.parse(storage.get('pugport-ui-failed-builds')!), ['broken']);
  await timeout!();
  assert.equal(navigations.length, 1);
  runInNewContext(`(${uiBootstrap.toString()})('healthy', 'contract')`, context);
  listeners.get('pugport:ui-ready')!();
  await timeout!();
  assert.equal(navigations.length, 1);
  runInNewContext(`(${uiBootstrap.toString()})('missing-chunk', 'contract')`, context);
  listeners.get('error')!({ target: new Script() });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(navigations.length, 2);
  runInNewContext(`(${uiBootstrap.toString()})('broken', 'contract')`, context);
  await timeout!();
  assert.equal(navigations.length, 2, 'a previously failed build never retries recovery');
});
