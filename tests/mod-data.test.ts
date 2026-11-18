import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { BankConnections } from '../src/server/bank-connections.ts';
import type { ConversationModes } from '../src/server/conversation-modes.ts';
import { markitdown } from '../src/server/local-tools.ts';
import { registerModDataRoutes } from '../src/server/mod-data-routes.ts';
import { ModStorage } from '../src/server/mod-storage.ts';
import { pdfPages } from '../src/server/pdf-text.ts';
import type { ModManifestV2, ModPermission } from '../src/shared/mods-manifest.ts';
import { createModDataHost } from '../src/ui/mods/mod-data-host.ts';
import { createModHostBridge, type ModHostContext, type ModPort } from '../src/ui/mods/mod-host-bridge.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const manifest = (permissions: ModPermission[], id = 'example.finance'): ModManifestV2 => ({
  schemaVersion: 2,
  id,
  version: '1.0.0',
  title: 'Finance',
  description: 'Synthetic',
  permissions,
});

async function server(t: TestContext, permissions: ModPermission[], granted: ModPermission[] = permissions) {
  const dir = await mkdtemp(join(tmpdir(), 'mod-data-'));
  const db = new DatabaseSync(':memory:');
  const storage = new ModStorage(db);
  const bank = new BankConnections({ file: join(dir, 'bank.private.json'), db });
  const modes = {
    view: (id: string) => {
      if (id !== 'chat') throw new Error('missing');
      return {
        installed: true,
        manifest: manifest(permissions),
        binding: { modeId: 'example.finance', version: '1.0.0', instanceId: 'instance' },
        granted,
      };
    },
  } as unknown as ConversationModes;
  const app = express();
  app.use('/api/conversations/:id/mod-files/pdf-text', express.raw({ type: 'application/pdf', limit: '30mb' }));
  app.use(express.json());
  registerModDataRoutes(app, { modes, storage, bank, python: () => undefined });
  const http = await listenForFetch(app);
  t.after(async () => {
    http.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const call = async (method: string, params: unknown = {}, instanceId = 'instance', chat = 'chat') => {
    const response = await fetch(`${base}/api/conversations/${chat}/mod-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId, method, params }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { call, storage, base };
}

test('the binding chooses the namespace and each method needs its declared permission', async (t) => {
  const s = await server(t, ['data:store']);
  const put = await s.call('storage.put', { collection: 'ledger', items: [{ key: 'tx_1', value: '{}' }] });
  assert.deepEqual(put, { status: 200, body: { written: 1 } });
  assert.equal(s.storage.get('example.finance', 'ledger', ['tx_1']).length, 1);
  assert.equal((await s.call('storage.list', { collection: 'ledger' })).body.items.length, 1);
  assert.deepEqual((await s.call('connections.list')).body, {
    code: 'E_PERMISSION',
    error: 'Permission is not declared.',
  });
  assert.equal(
    (await s.call('storage.get', { collection: 'ledger', keys: ['x'] }, 'other')).body.code,
    'E_UNAVAILABLE',
  );
  assert.equal((await s.call('storage.get', { collection: 'ledger', keys: ['x'] }, 'instance', 'nope')).status, 409);
  // File methods stay in the host window; extra fields are rejected.
  assert.equal((await s.call('files.pick', { accept: ['.csv'] })).body.code, 'E_INVALID');
  assert.equal((await s.call('storage.usage', { modId: 'example.other' })).body.code, 'E_INVALID');
  assert.equal((await s.call('storage.put', { collection: 'Bad!', items: [] })).body.code, 'E_INVALID');
});

test('bank authorization is unavailable when the host cannot show a dialog', async () => {
  const host = createModDataHost({
    modId: 'example.finance',
    api: async () => {
      throw new Error('Must not start a session without a dialog host');
    },
    conversationId: 'chat',
    instanceId: 'instance',
    title: 'Synthetic finance',
  });
  await assert.rejects(host.call('connections.authorize', { provider: 'plaid' }), { code: 'E_UNAVAILABLE' });
});

test('bank data needs connections:read approved when loading', async (t) => {
  const declared = await server(t, ['connections:read'], []);
  assert.equal((await declared.call('connections.list')).body.code, 'E_PERMISSION');
  const approved = await server(t, ['connections:read']);
  assert.deepEqual((await approved.call('connections.list')).body, { connections: [] });
  assert.equal(
    (await approved.call('connections.accounts', { connectionId: 'conn_abcdefgh12' })).body.code,
    'E_UNAVAILABLE',
  );
  // Without Plaid keys there is nothing to authorize.
  assert.equal((await approved.call('connections.authorize', { provider: 'plaid' })).body.code, 'E_NOT_CONFIGURED');
});

test('PDF text needs files:import and the local document reader', async (t) => {
  const s = await server(t, ['files:import']);
  const response = await fetch(`${s.base}/api/conversations/chat/mod-files/pdf-text?instanceId=instance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: '%PDF-1.4',
  });
  assert.equal(response.status, 409);
  const denied = await server(t, ['data:store']);
  const refused = await fetch(`${denied.base}/api/conversations/chat/mod-files/pdf-text?instanceId=instance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: '%PDF-1.4',
  });
  assert.equal(refused.status, 403);
});

class Port implements ModPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: any[] = [];
  postMessage(value: unknown) {
    this.sent.push(value);
  }
  start() {}
  close() {}
  async request(method: string, params: unknown = {}) {
    const id = String(Math.random());
    this.onmessage?.({ data: { type: 'request', id, method, params } } as MessageEvent);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    return this.sent.find((value) => value.type === 'response' && value.id === id);
  }
}
function bridge(declared: ModPermission[], granted: ModPermission[], pick?: () => Promise<File | undefined>) {
  const requests: unknown[] = [];
  const api = async <T>(path: string, body?: unknown) => {
    requests.push({ path, body });
    return { connections: [] } as T;
  };
  const context: ModHostContext = {
    conversationId: 'chat',
    modId: 'example.finance',
    version: '1.0.0',
    instanceId: 'instance',
    manifest: manifest(declared),
    isCurrent: () => true,
    info: () => ({
      apiVersion: 2,
      hostVersion: 'test',
      locale: 'en',
      theme: 'light',
      tokens: {},
      slot: 'rightPanel',
      layout: 'panel',
      conversation: { id: 'chat', title: 'Chat' },
    }),
    getState: async () => ({ revision: 0, values: {} }),
    setState: async () => ({ revision: 1, values: {} }),
    messages: () => [],
    insert() {},
    notify() {},
    granted: () => granted,
    data: createModDataHost({
      modId: 'example.finance',
      api,
      conversationId: 'chat',
      instanceId: 'instance',
      title: 'Finance',
      ...(pick ? { pick } : {}),
    }),
  };
  const host = createModHostBridge(context);
  const port = new Port();
  host.connect(port);
  return { host, port, requests };
}

test('bridge: data calls go to the server with the binding; files stay in the window', async () => {
  const b = bridge(
    ['data:store', 'files:import'],
    ['data:store', 'files:import'],
    async () => new File(['date,amount\n2026-10-01,12.50\n'], 'statement.csv'),
  );
  assert.deepEqual((await b.port.request('storage.usage')).result, { connections: [] });
  assert.deepEqual(b.requests.at(-1), {
    path: '/api/conversations/chat/mod-data',
    body: { instanceId: 'instance', method: 'storage.usage', params: {} },
  });
  assert.equal((await b.port.request('connections.list')).error.code, 'E_PERMISSION');
  const picked = (await b.port.request('files.pick', { accept: ['.csv'] })).result;
  assert.deepEqual(
    { ...picked, fileId: typeof picked.fileId },
    { fileId: 'string', name: 'statement.csv', size: 29, type: 'csv' },
  );
  assert.deepEqual((await b.port.request('files.readText', { fileId: picked.fileId })).result, {
    text: 'date,amount\n2026-10-01,12.50\n',
    length: 29,
  });
  assert.equal((await b.port.request('files.pdfText', { fileId: picked.fileId })).error.code, 'E_INVALID');
  assert.equal((await b.port.request('files.readText', { fileId: 'other' })).error.code, 'E_INVALID');
  // A file type the Mod did not ask for is refused.
  assert.equal((await b.port.request('files.pick', { accept: ['.pdf'] })).error.code, 'E_INVALID');
  b.host.detach();

  const unapproved = bridge(['connections:read'], []);
  assert.equal((await unapproved.port.request('connections.list')).error.code, 'E_PERMISSION');
  unapproved.host.detach();
});

// Two text pages written by hand; pdfminer tolerates the missing cross-reference offsets.
const pdf = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >> endobj',
    '4 0 obj << /Length 52 >> stream\nBT /F1 12 Tf 20 150 Td (Statement date 2026-10-05) Tj ET\nendstream endobj',
    '5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >> endobj',
    '6 0 obj << /Length 48 >> stream\nBT /F1 12 Tf 20 150 Td (Minimum payment 10.00) Tj ET\nendstream endobj',
    '7 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n'),
  'latin1',
);
const python = markitdown(join(import.meta.dirname, '..'));
test(
  'PDF text comes back page by page',
  { skip: !python || !existsSync(python) ? 'local document reader not installed' : false },
  async () => {
    assert.deepEqual(await pdfPages(python, pdf), [
      { page: 1, text: 'Statement date 2026-10-05' },
      { page: 2, text: 'Minimum payment 10.00' },
    ]);
    await assert.rejects(pdfPages(python, Buffer.from('not a pdf')), { code: 'E_INVALID' });
    await assert.rejects(pdfPages(undefined, pdf), { code: 'E_UNAVAILABLE' });
  },
);
