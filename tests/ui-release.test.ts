import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { UiReleases, serveUiReleases, uiReleaseRoutes } from '../src/server/ui-release.ts';
import { safeUiAsset } from '../src/shared/ui-release.ts';

const compatibility = 'a'.repeat(64);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pugport-ui-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releases = new UiReleases(root, compatibility, 'baseline');
  async function release(buildId: string, previousBuildId?: string, contract = compatibility) {
    const directory = join(root, 'dist/ui-releases', buildId);
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'index.html'), `<!doctype html><title>${buildId}</title>`);
    await writeFile(join(directory, 'assets/main.js'), `window.release = '${buildId}'`);
    await writeFile(
      join(directory, 'ui-release.json'),
      JSON.stringify({
        schema: 1,
        buildId,
        previousBuildId,
        compatibility: contract,
        assets: ['index.html', 'assets/main.js'],
      }),
    );
    return directory;
  }
  async function active(buildId: string) {
    await mkdir(releases.directory, { recursive: true });
    await writeFile(join(releases.directory, 'active.json'), JSON.stringify({ buildId }));
  }
  return { root, releases, release, active };
}

test('active releases require the running backend contract and preserve fallback after a full build', async (t) => {
  const f = await fixture(t);
  await f.release('baseline');
  await f.release('new-ui', 'baseline');
  await f.active('new-ui');
  assert.equal(f.releases.status().buildId, 'new-ui');
  assert.equal(f.releases.fallback('new-ui')?.manifest.buildId, 'baseline');
  assert.equal(f.releases.fallback('baseline'), undefined);
  await f.release('new-backend', undefined, 'b'.repeat(64));
  await f.active('new-backend');
  assert.equal(f.releases.status().buildId, 'baseline');
  await f.active('../../outside');
  assert.equal(f.releases.status().buildId, 'baseline');
  await writeFile(join(f.releases.directory, 'active.json'), '{interrupted');
  assert.equal(f.releases.status().buildId, 'baseline');
});

test('release asset validation rejects traversal, encoded paths, missing files and junction escapes', async (t) => {
  const f = await fixture(t);
  const directory = await f.release('baseline');
  for (const path of [
    '../secret',
    '/absolute',
    'assets/../main.js',
    'assets\\main.js',
    'https://host/x.js',
    'x%2fy',
    '.hidden',
  ])
    assert.equal(safeUiAsset(path), false, path);
  assert.equal(f.releases.asset('baseline', 'assets/missing.js'), undefined);
  assert.equal(f.releases.asset('../baseline', 'assets/main.js'), undefined);
  assert.equal(f.releases.asset('baseline', 'ui-release.json'), undefined);
  assert.equal(await readFile(f.releases.asset('baseline', 'assets/main.js')!, 'utf8'), "window.release = 'baseline'");
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'escape.js'), 'outside');
  await symlink(outside, join(directory, 'escape'), 'junction');
  const manifestPath = join(directory, 'ui-release.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets.push('escape/escape.js');
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(f.releases.asset('baseline', 'escape/escape.js'), undefined);
});

test('HTTP release serving retains old chunks, exposes no activation route, and uses guarded per-window fallback', async (t) => {
  const f = await fixture(t);
  await f.release('baseline');
  await f.release('new-ui', 'baseline');
  await f.active('new-ui');
  const app = express();
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.headers['x-agent-token'] !== 'fixture-token') res.sendStatus(403);
    else next();
  });
  app.use(express.json());
  uiReleaseRoutes(app, f.releases);
  serveUiReleases(app, f.releases);
  const server = createServer(app);
  await listenForFetch(server);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.match(await (await fetch(base)).text(), /new-ui/);
  assert.match(await (await fetch(`${base}/?uiBuild=baseline`)).text(), /baseline/);
  const oldChunk = await fetch(`${base}/ui-releases/baseline/assets/main.js`);
  assert.equal(oldChunk.status, 200);
  assert.match(oldChunk.headers.get('cache-control')!, /immutable/);
  assert.equal((await fetch(`${base}/ui-releases/new-ui/active.json`)).status, 404);
  assert.equal((await fetch(`${base}/ui-releases/new-ui/index.html`)).status, 404);
  assert.equal((await fetch(`${base}/?uiBuild=https://evil.invalid/main.js`)).status, 400);
  assert.equal(
    (
      await fetch(`${base}/api/ui-release/fallback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ buildId: 'new-ui' }),
      })
    ).status,
    403,
  );
  const fallback = await fetch(`${base}/api/ui-release/fallback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': 'fixture-token' },
    body: JSON.stringify({ buildId: 'new-ui' }),
  });
  assert.equal((await fallback.json()).url, '/?uiBuild=baseline');
  assert.equal(f.releases.status().buildId, 'new-ui');
  assert.equal(
    (
      await fetch(`${base}/api/ui-release/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': 'fixture-token' },
        body: '{}',
      })
    ).status,
    404,
  );
});

test('legacy entry works in development but a compiled backend never falls through to an incompatible UI', async (t) => {
  const f = await fixture(t);
  await mkdir(f.releases.legacyDirectory, { recursive: true });
  await writeFile(join(f.releases.legacyDirectory, 'index.html'), '<title>legacy</title>');
  assert.equal(f.releases.status().enabled, false);
  assert.equal(f.releases.status().buildId, 'legacy');
  const app = express();
  app.use(
    '/compiled',
    (() => {
      const compiled = express();
      serveUiReleases(compiled, f.releases);
      return compiled;
    })(),
  );
  serveUiReleases(app, new UiReleases(f.root, '', ''));
  const server = createServer(app);
  await listenForFetch(server);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/compiled/`)).status, 503);
  const legacy = await fetch(base);
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /legacy/);
});
