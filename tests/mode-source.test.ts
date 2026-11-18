import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConversationModes } from '../src/server/conversation-modes.ts';
import { ModeSource } from '../src/server/mode-source.ts';
import { registerModeSourceRoutes } from '../src/server/mode-source-routes.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { modeSourceCatalogSchema, modeSourceConfigSchema, modeSourceViewSchema } from '../src/shared/mode-source.ts';
import { MODE_SOURCE_CATALOG_MAX_BYTES, type ConversationModeManifest } from '../src/shared/conversation-modes.ts';

const revision = 'a'.repeat(40);
const config = { enabled: true, repository: 'fixture/mods', ref: 'main', catalogPath: 'catalog.json' };
const manifest: ConversationModeManifest = {
  schemaVersion: 1,
  id: 'example.notes',
  version: '1.0.0',
  title: 'Notes',
  description: 'Fixture only',
  icon: 'book-open',
  view: { fields: [], actions: [] },
};
const raw = JSON.stringify(manifest) + '\n';
const entry = {
  id: manifest.id,
  version: manifest.version,
  title: manifest.title,
  description: manifest.description,
  icon: manifest.icon,
  path: 'mods/example.notes/1.0.0.json',
  sha256: createHash('sha256').update(raw).digest('hex'),
};
const catalog = () => ({ schemaVersion: 1, mods: [{ ...entry }] });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const modes = new ConversationModes({
    store,
    requireConversation() {
      throw new Error('Unused');
    },
    modeSwitchBarrier: () => undefined,
    notify() {},
  });
  let now = Date.parse('2026-10-24T20:00:00Z');
  const state = {
    revision,
    catalog: catalog() as unknown,
    raw,
    tokens: 0,
    reply: undefined as ((url: string, options: RequestInit) => Promise<Response | undefined>) | undefined,
  };
  const calls: string[] = [];
  const request: typeof fetch = async (input, options) => {
    const url = String(input);
    calls.push(url);
    assert.ok(url.startsWith('https://api.github.com/repos/'));
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer fixture-secret');
    const overridden = await state.reply?.(url, options ?? {});
    if (overridden) return overridden;
    if (url.includes('/commits/')) {
      assert.equal(new Headers(options?.headers).get('accept'), 'application/vnd.github.sha');
      return new Response(state.revision + '\n');
    }
    if (url.includes('/contents/catalog.json?ref=')) return json(state.catalog);
    if (url.includes('/contents/mods/example.notes/1.0.0.json?ref=')) return new Response(state.raw);
    throw new Error('Unexpected fixture URL');
  };
  const options = {
    fetch: request,
    tokenSource: async () => {
      state.tokens++;
      return { token: 'fixture-secret', login: 'fixture' };
    },
    now: () => now,
  };
  const source = new ModeSource(store, modes, options);
  t.after(() => {
    source.close();
    db.close();
  });
  return {
    db,
    store,
    modes,
    source,
    state,
    calls,
    options,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('the server registers source routes before /api/modes/:id/install can swallow source installs', () => {
  const main = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  const source = main.indexOf('registerModeSourceRoutes(app');
  const local = main.indexOf('registerConversationModeRoutes(app');
  assert.ok(source > 0 && local > 0);
  assert.ok(source < local, 'POST /api/modes/source/install must not reach the local install route');
});

test('source GET/configuration are local; refresh coalesces, uses a short cache and pins download to a commit', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.source.view(), { config: null, status: 'unconfigured', catalog: [] });
  assert.equal(f.source.configure(config).status, 'unconfigured');
  assert.equal(f.state.tokens, 0);
  assert.equal(f.calls.length, 0);
  const [first, shared] = await Promise.all([f.source.refresh(), f.source.refresh()]);
  assert.deepEqual(first, shared);
  assert.equal(first.status, 'ready');
  assert.equal(first.revision, revision);
  assert.equal(first.catalog[0]?.compatible, true);
  assert.equal('path' in first.catalog[0]!, false);
  assert.equal('sha256' in first.catalog[0]!, false);
  assert.equal(f.state.tokens, 1);
  assert.equal(f.calls.length, 2);
  await f.source.refresh();
  assert.equal(f.calls.length, 2);
  assert.ok(modeSourceViewSchema.safeParse(first).success);
  f.state.revision = 'b'.repeat(40);
  const downloaded = await f.source.download({ id: entry.id, version: entry.version, revision });
  assert.deepEqual(downloaded, manifest);
  assert.ok(f.calls.at(-1)?.endsWith(`?ref=${revision}`));
  assert.equal(f.modes.catalog().catalog.length, 0);
  const installed = await f.source.install({ id: entry.id, version: entry.version, revision });
  assert.equal(installed.installed[0]?.version, '1.0.0');
  assert.equal(f.store.list('workflow').length, 0);
  assert.equal(f.store.list('message').length, 0);
  const saved = f.db.prepare("SELECT value FROM workspace_records WHERE kind='mode-source'").get() as { value: string };
  assert.deepEqual(JSON.parse(saved.value), config);
  assert.ok(!saved.value.includes('fixture-secret'));
  f.advance(30_001);
  assert.equal((await f.source.refresh()).revision, 'b'.repeat(40));
});

test('cold restart can validate a pinned catalog; immutable local versions cannot be overwritten', async (t) => {
  const f = fixture(t);
  f.source.configure(config);
  const restarted = new ModeSource(f.store, f.modes, f.options);
  t.after(() => restarted.close());
  assert.equal(restarted.view().catalog.length, 0);
  assert.deepEqual(await restarted.download({ id: entry.id, version: entry.version, revision }), manifest);
  assert.ok(f.calls[0]?.endsWith(`catalog.json?ref=${revision}`));
  f.modes.import({ ...manifest, title: 'A different existing local version' });
  await assert.rejects(restarted.install({ id: entry.id, version: entry.version, revision }), /already exists/);
  assert.equal(f.modes.catalog().installed.length, 0);
  assert.equal(f.modes.export(entry.id, entry.version).title, 'A different existing local version');
});

test('source presentation keeps cover identity in metadata and fetches README only in the verified package', async (t) => {
  const f = fixture(t);
  const cover = {
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWMwTptpnDYTAAeZAmUGcC4NAAAAAElFTkSuQmCC',
    alt: 'A blue cover',
  };
  const value = { ...manifest, cover, readme: '# Detailed introduction\n\nNo remote assets.' };
  f.state.raw = JSON.stringify(value);
  const presentationEntry = { ...entry, cover, sha256: createHash('sha256').update(f.state.raw).digest('hex') };
  f.state.catalog = { schemaVersion: 1, mods: [presentationEntry] };
  f.source.configure(config);
  const view = await f.source.refresh();
  assert.deepEqual(view.catalog[0]?.cover, cover);
  assert.equal('readme' in view.catalog[0]!, false);
  assert.equal(f.calls.filter((url) => url.includes('/contents/mods/')).length, 0);
  assert.deepEqual(await f.source.download({ id: entry.id, version: entry.version, revision }), value);
  assert.equal(f.modes.catalog().catalog.length, 0);
  f.state.catalog = {
    schemaVersion: 1,
    mods: [{ ...presentationEntry, cover: { ...cover, alt: 'A different cover' } }],
  };
  await f.source.refresh(true);
  await assert.rejects(f.source.install({ id: entry.id, version: entry.version, revision }), /目录信息不一致/);
  assert.equal(f.modes.catalog().installed.length, 0);
  f.state.catalog = { schemaVersion: 1, mods: [presentationEntry] };
  await f.source.refresh(true);
  await f.source.install({ id: entry.id, version: entry.version, revision });
  assert.deepEqual(f.modes.export(entry.id, entry.version), value);
});

test('source schema rejects executable metadata, duplicates, traversal, URLs and arbitrary source hosts', () => {
  assert.deepEqual(modeSourceConfigSchema.parse({ enabled: false, repository: 'fixture/mods' }), {
    ...config,
    enabled: false,
  });
  for (const repository of [
    'https://github.com/fixture/mods',
    'fixture/mods?token=secret',
    '../mods',
    'fixture/mods/extra',
  ])
    assert.equal(modeSourceConfigSchema.safeParse({ ...config, repository }).success, false);
  for (const ref of ['../main', 'main?x=1', '/main', 'main//child', 'main/'])
    assert.equal(modeSourceConfigSchema.safeParse({ ...config, ref }).success, false);
  assert.equal(modeSourceConfigSchema.safeParse({ ...config, catalogPath: '../private.json' }).success, false);
  for (const path of [
    '../x.json',
    'mods/../x.json',
    'mods\\x.json',
    'https://example.invalid/x.json',
    'mods/%2e%2e/x.json',
    'mods/x.json?token=x',
  ])
    assert.equal(modeSourceCatalogSchema.safeParse({ schemaVersion: 1, mods: [{ ...entry, path }] }).success, false);
  assert.equal(modeSourceCatalogSchema.safeParse({ schemaVersion: 1, mods: [entry, entry] }).success, false);
  assert.equal(
    modeSourceCatalogSchema.safeParse({ schemaVersion: 1, mods: [{ ...entry, script: 'private-content' }] }).success,
    false,
  );
});

test('failed refresh retains the last good catalog; changing or disabling the source clears it without network', async (t) => {
  const f = fixture(t);
  f.source.configure(config);
  await f.source.refresh();
  f.state.reply = async () => new Response('fixture-secret private repository detail', { status: 403 });
  const failed = await f.source.refresh(true);
  assert.equal(failed.status, 'error');
  assert.equal(failed.catalog.length, 1);
  assert.equal(failed.revision, revision);
  assert.ok(!JSON.stringify(failed).includes('fixture-secret'));
  assert.ok(!JSON.stringify(failed).includes('private repository detail'));
  const before = f.calls.length;
  assert.equal(f.source.configure({ ...config, repository: 'fixture/other' }).catalog.length, 0);
  assert.equal(f.source.view().error, undefined);
  f.source.configure({ ...config, enabled: false });
  assert.equal((await f.source.refresh()).status, 'unconfigured');
  assert.equal(f.calls.length, before);
});

test('redirects, streamed oversize files and invalid catalogs cannot become trusted cache', async (t) => {
  const f = fixture(t);
  f.source.configure(config);
  for (const reply of [
    () => new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }),
    () => new Response('x', { headers: { 'content-length': '99999999' } }),
    () => new Response('x'.repeat(MODE_SOURCE_CATALOG_MAX_BYTES + 1)),
    () => json({ schemaVersion: 1, mods: [{ ...entry, path: 'mods/../private.json' }] }),
    () => json({ schemaVersion: 1, mods: [entry, entry] }),
  ]) {
    f.state.reply = async (url) => (url.includes('/commits/') ? undefined : reply());
    assert.equal((await f.source.refresh(true)).status, 'error');
    assert.equal(f.source.view().catalog.length, 0);
  }
  assert.ok(f.calls.every((url) => url.startsWith('https://api.github.com/')));
  assert.equal(f.modes.catalog().catalog.length, 0);
});

test('bad hash, executable manifest, mismatched metadata and oversized packages install nothing', async (t) => {
  const f = fixture(t);
  f.source.configure(config);
  for (const [body, validDigest, error] of [
    [raw + ' ', false, /校验失败/],
    [JSON.stringify({ ...manifest, script: 'private-content' }), true, /格式无效/],
    [JSON.stringify({ ...manifest, title: 'Another title' }), true, /不一致/],
    ['x'.repeat(256 * 1024 + 1), true, /大小限制/],
  ] as const) {
    f.state.raw = body;
    f.state.catalog = {
      schemaVersion: 1,
      mods: [{ ...entry, sha256: validDigest ? createHash('sha256').update(body).digest('hex') : entry.sha256 }],
    };
    await f.source.refresh(true);
    await assert.rejects(f.source.install({ id: entry.id, version: entry.version, revision }), error);
    assert.equal(f.modes.catalog().catalog.length, 0);
    assert.equal(f.modes.catalog().installed.length, 0);
  }
});

test('config changes discard an older refresh and stop an in-flight package from being installed', async (t) => {
  const f = fixture(t);
  f.source.configure(config);
  let release!: () => void;
  let reached!: () => void;
  let entered = new Promise<void>((done) => {
    reached = done;
  });
  let gate = new Promise<void>((done) => {
    release = done;
  });
  f.state.reply = async (url) => {
    if (url.includes('/commits/')) {
      reached();
      await gate;
    }
    return undefined;
  };
  const refresh = f.source.refresh();
  await entered;
  f.source.configure({ ...config, repository: 'fixture/new' });
  release();
  assert.equal((await refresh).status, 'unconfigured');
  assert.equal(f.source.view().catalog.length, 0);
  f.state.reply = undefined;
  await f.source.refresh();
  entered = new Promise<void>((done) => {
    reached = done;
  });
  gate = new Promise<void>((done) => {
    release = done;
  });
  f.state.reply = async (url) => {
    if (url.includes('/contents/mods/')) {
      reached();
      await gate;
    }
    return undefined;
  };
  const install = f.source.install({ id: entry.id, version: entry.version, revision });
  await entered;
  f.source.configure({ ...config, enabled: false });
  release();
  await assert.rejects(install, /已更改/);
  assert.equal(f.modes.catalog().installed.length, 0);
  assert.equal(f.modes.catalog().catalog.length, 0);
});

test('missing authentication is sanitized and close cancels late work before the store is closed', async (t) => {
  const f = fixture(t);
  const missing = new ModeSource(f.store, f.modes, {
    ...f.options,
    tokenSource: async () => {
      throw new Error('secret token data');
    },
  });
  missing.configure(config);
  const failed = await missing.refresh();
  assert.equal(failed.status, 'error');
  assert.ok(!JSON.stringify(failed).includes('secret token data'));
  missing.close();
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((done) => {
    reached = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  f.state.reply = async () => {
    reached();
    await gate;
    return undefined;
  };
  const refresh = f.source.refresh();
  await entered;
  f.source.close();
  release();
  assert.deepEqual(await refresh, { config: null, status: 'unconfigured', catalog: [] });
  await assert.rejects(f.source.download({ id: entry.id, version: entry.version, revision }), /已关闭/);
});

test('source HTTP contracts use pinned revision and keep export read-only', async (t) => {
  const f = fixture(t);
  const app = express();
  app.use(express.json());
  registerModeSourceRoutes(app, f.source);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(400).json({ error: 'Invalid request' }),
  );
  const server = createServer(app);
  await listenForFetch(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, method = 'POST') =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await request('/api/modes/source', undefined, 'GET')).status, 200);
  assert.equal((await request('/api/modes/source', { ...config, token: 'never accepted' }, 'PUT')).status, 400);
  assert.equal((await request('/api/modes/source', config, 'PUT')).status, 200);
  const refreshed = await (await request('/api/modes/source/refresh', { force: true })).json();
  assert.equal(refreshed.revision, revision);
  assert.equal((await request('/api/modes/source/install', { id: entry.id, version: entry.version })).status, 400);
  const exported = await request(
    `/api/modes/source/${entry.id}/versions/${entry.version}/export?revision=${revision}`,
    undefined,
    'GET',
  );
  assert.equal(exported.status, 200);
  assert.deepEqual(await exported.json(), manifest);
  assert.equal(f.modes.catalog().installed.length, 0);
  const installed = await request('/api/modes/source/install', { id: entry.id, version: entry.version, revision });
  assert.equal(installed.status, 200);
  assert.equal((await installed.json()).installed[0].modeId, entry.id);
  f.store.save('mode-manifest', `${entry.id}@${entry.version}`, 'conversation-modes', {
    ...manifest,
    title: 'Previously imported content',
  });
  const conflict = await request('/api/modes/source/install', { id: entry.id, version: entry.version, revision });
  assert.equal(conflict.status, 409);
  assert.equal(f.modes.export(entry.id, entry.version).title, 'Previously imported content');
});

test('remote legacy metadata keeps a 100-character title without schemaVersion', async (t) => {
  const f = fixture(t);
  const title = 'N'.repeat(100);
  f.state.raw = JSON.stringify({ ...manifest, title });
  f.state.catalog = {
    schemaVersion: 1,
    mods: [{ ...entry, title, sha256: createHash('sha256').update(f.state.raw).digest('hex') }],
  };
  f.source.configure(config);
  assert.equal((await f.source.refresh()).status, 'ready');
  assert.equal(modeSourceViewSchema.safeParse(f.source.view()).success, true);
  assert.equal((await f.source.install({ id: entry.id, version: entry.version, revision })).installed.length, 1);
});

test('v2 source retains card and logo metadata, verifies their identity and permits packages above 256 KiB', async (t) => {
  const f = fixture(t);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWMwTptpnDYTAAeZAmUGcC4NAAAAAElFTkSuQmCC',
    'base64',
  );
  png.writeUInt32BE(64, 16);
  png.writeUInt32BE(64, 20);
  png[25] = 6;
  const logo = { src: 'data:image/png;base64,' + png.toString('base64'), alt: 'Notes' };
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  const card = { src: 'data:image/png;base64,' + png.toString('base64'), alt: 'Notes close-up' };
  const value = {
    schemaVersion: 2,
    id: entry.id,
    version: entry.version,
    title: 'Notes',
    description: 'Fixture only',
    icon: 'book-open',
    logo,
    card,
    license: 'MIT',
    permissions: ['chat:read', 'composer:draft'],
    ui: { entries: { panel: { html: '<p>Notes</p>', js: ' '.repeat(256 * 1024) } } },
    contributions: { rightPanel: { kind: 'web', entry: 'panel' } },
  };
  f.state.raw = JSON.stringify(value);
  assert.ok(Buffer.byteLength(f.state.raw) > 256 * 1024 && Buffer.byteLength(f.state.raw) < 1024 * 1024);
  const metadata = {
    ...entry,
    schemaVersion: 2,
    logo,
    card,
    permissions: value.permissions,
    sha256: createHash('sha256').update(f.state.raw).digest('hex'),
  };
  f.state.catalog = { schemaVersion: 1, mods: [metadata] };
  f.source.configure(config);
  const sourceView = await f.source.refresh();
  assert.equal(sourceView.status, 'ready');
  assert.deepEqual(sourceView.catalog[0]?.card, card);
  assert.equal((await f.source.install({ id: entry.id, version: entry.version, revision })).installed.length, 1);
  assert.deepEqual(f.modes.export(entry.id, entry.version), value);
  assert.deepEqual(f.modes.catalog().catalog[0]?.card, card);
  f.state.catalog = { schemaVersion: 1, mods: [{ ...metadata, card: { ...card, alt: 'Different subject' } }] };
  await f.source.refresh(true);
  await assert.rejects(f.source.download({ id: entry.id, version: entry.version, revision }), /目录信息不一致/);
});

test('source mismatched permissions or schemaVersion install nothing', async (t) => {
  const f = fixture(t);
  const value = {
    schemaVersion: 2,
    id: entry.id,
    version: entry.version,
    title: entry.title,
    description: entry.description,
    icon: entry.icon,
    permissions: ['chat:read'],
  };
  f.state.raw = JSON.stringify(value);
  f.source.configure(config);
  for (const mismatch of [
    { schemaVersion: 2, permissions: [] },
    { schemaVersion: 1, permissions: ['chat:read'] },
  ]) {
    f.state.catalog = {
      schemaVersion: 1,
      mods: [{ ...entry, ...mismatch, sha256: createHash('sha256').update(f.state.raw).digest('hex') }],
    };
    assert.equal((await f.source.refresh(true)).status, 'ready');
    await assert.rejects(f.source.install({ id: entry.id, version: entry.version, revision }), /目录信息不一致/);
    assert.equal(f.modes.catalog().catalog.length, 0);
    assert.equal(f.modes.catalog().installed.length, 0);
  }
});
