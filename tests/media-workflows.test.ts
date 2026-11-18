import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { builtinMediaWorkflows, mediaWorkflowSchema, parseMediaWorkflow } from '../src/shared/media-workflows.ts';
import {
  downloadMediaWorkflow,
  MediaWorkflowStore,
  publicWorkflowAddress,
  workflowDownloadUrl,
  mountMediaWorkflowRoutes,
} from '../src/server/media-workflows.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

function recipe() {
  return structuredClone(builtinMediaWorkflows[0]!.workflow);
}

test('portable workflows reject execution, embedded scope, reordered steps and unsupported limits', () => {
  for (const extra of [
    { command: 'powershell remove-item' },
    { folders: ['C:\\Users\\someone'] },
    { apiKey: 'secret' },
    { tools: ['recycle_files'] },
    { source: 'file:///C:/data' },
    { permission: 'write' },
  ])
    assert.equal(mediaWorkflowSchema.safeParse({ ...recipe(), ...extra }).success, false);
  for (const [key, value] of [
    ['topK', 21],
    ['topK', 0],
    ['videoSampleSeconds', 4],
    ['videoSampleSeconds', 121],
    ['maxFiles', 20_001],
    ['maxFiles', -1],
    ['engine', 'shell'],
    ['retrievalMode', 'execute-script'],
    ['maxFiles', 1.5],
  ]) {
    const valueRecipe = recipe();
    Object.assign(valueRecipe.parameters, { [key as string]: value });
    assert.equal(mediaWorkflowSchema.safeParse(valueRecipe).success, false, String(key));
  }
  const reordered = recipe();
  reordered.steps.reverse();
  assert.equal(mediaWorkflowSchema.safeParse(reordered).success, false);
  assert.equal(mediaWorkflowSchema.safeParse({ ...recipe(), schemaVersion: 2 }).success, false);
  assert.throws(() => parseMediaWorkflow('not JSON'), /JSON/);
  assert.throws(() => parseMediaWorkflow(' '.repeat(65 * 1024)), /64 KB/);
});

test('fast workflows use bounded adaptive retrieval while old portable recipes remain compatible', () => {
  assert.equal(recipe().parameters.retrievalMode, 'adaptive');
  assert.equal(recipe().parameters.ioConcurrency, 4);
  assert.equal(recipe().parameters.engine, 'legacy');
  assert.equal(
    builtinMediaWorkflows.some((item) => item.id === 'builtin-gemma-thorough'),
    false,
  );
  const older = recipe();
  delete older.parameters.retrievalMode;
  assert.equal(mediaWorkflowSchema.parse(older).parameters.retrievalMode, undefined);
});

test('workflow download only accepts public HTTPS hosts and global addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.2.3.4',
    '172.31.2.3',
    '192.168.1.5',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.2.3',
    '198.18.0.1',
    '192.0.2.4',
    '192.88.99.1',
    '203.0.113.2',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2001:0000::1',
    '2001:0002::1',
    '2002:8.8.8.8::1',
    '3fff::1',
  ])
    assert.equal(publicWorkflowAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.equal(publicWorkflowAddress(address), true, address);
  for (const url of [
    'http://example.com/workflow.json',
    'https://localhost/x',
    'https://host.local/x',
    'https://127.1/x',
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://[::1]/x',
    'https://example.com:8443/x',
    'https://user:pass@example.com/x',
    'file:///C:/file.json',
    'https://example.com/x#data',
  ])
    assert.throws(() => workflowDownloadUrl(url), /HTTPS|公开/, url);
  assert.equal(
    workflowDownloadUrl('https://raw.githubusercontent.com/user/repo/main/workflow.json').protocol,
    'https:',
  );
});

test('download checks every DNS answer and revalidates redirected hosts before connection', async () => {
  let requests = 0;
  await assert.rejects(
    downloadMediaWorkflow('https://workflow.example.com/x', {
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      get: async () => {
        requests++;
        return { text: '{}' };
      },
    }),
    /内网/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    downloadMediaWorkflow('https://workflow.example.com/x', {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      get: async () => {
        requests++;
        return { redirect: 'https://127.0.0.1/private' };
      },
    }),
    /本机|内网/,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    downloadMediaWorkflow('https://workflow.example.com/x', {
      resolve: async (host) => [
        { address: host === 'workflow.example.com' ? '8.8.8.8' : '169.254.169.254', family: 4 },
      ],
      get: async () => ({ redirect: 'https://other.example.com/private' }),
    }),
    /内网/,
  );
  const result = await downloadMediaWorkflow('https://workflow.example.com/x', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    get: async (url, address) => {
      assert.equal(address.address, '8.8.8.8');
      return url.pathname === '/x' ? { redirect: '/workflow.json' } : { text: JSON.stringify(recipe()) };
    },
  });
  assert.equal(result.source, 'https://workflow.example.com/workflow.json');
  assert.equal(parseMediaWorkflow(result.text).parameters.engine, 'legacy');
  await assert.rejects(
    downloadMediaWorkflow('https://workflow.example.com/x', {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      get: async () => ({ text: 'x'.repeat(65 * 1024) }),
    }),
    /64 KB/,
  );
});

test('preview is not installed or executable until imported; portable export leaves selected folders out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-workflows-'));
  try {
    const store = new MediaWorkflowStore(directory, async () => ({
      text: JSON.stringify(recipe()),
      source: 'https://example.com/final.json',
    }));
    const before = store.list().items.length;
    const preview = await store.preview({ url: 'https://example.com/recipe.json' });
    assert.equal(store.list().items.length, before);
    assert.equal(preview.source, 'https://example.com/final.json');
    const imported = store.importPreview(preview.token);
    assert.equal(imported.builtin, false);
    assert.equal(imported.source, preview.source);
    assert.throws(() => store.importPreview(preview.token), /过期/);
    const options = store.options(imported.id, ['D:\\Selected by user']);
    assert.deepEqual(options, { ...recipe().parameters, folders: ['D:\\Selected by user'], recipeId: imported.id });
    const portable = store.export(imported.id);
    assert.ok(!portable.includes('Selected by user'));
    assert.deepEqual(parseMediaWorkflow(portable), recipe());
    const restored = new MediaWorkflowStore(directory);
    assert.deepEqual(restored.get(imported.id).workflow, recipe());
    assert.throws(() => restored.save(recipe(), 'builtin-gemma-fast'), /内置流程/);
    assert.throws(() => restored.remove('builtin-gemma-fast'), /内置流程/);
    const edited = recipe();
    edited.parameters.topK = 17;
    edited.parameters.videoSampleSeconds = 60;
    restored.save(edited, imported.id);
    assert.equal(restored.get(imported.id).source, preview.source, 'editing retains import provenance');
    assert.equal(restored.options(imported.id, ['D:\\Scope']).topK, 17);
    assert.equal(restored.options(imported.id, ['D:\\Scope']).videoSampleSeconds, 60);
    restored.remove(imported.id);
    assert.equal(restored.list().items.length, before);
    await assert.rejects(store.preview({ text: JSON.stringify({ ...recipe(), shell: 'something' }) }), /不允许/);
    await assert.rejects(store.preview({ text: '{}', url: 'https://example.com/x' }), /请选择/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP routes import, save, export and remove actual recipes without an application backend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-workflows-http-'));
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const store = new MediaWorkflowStore(directory);
  mountMediaWorkflowRoutes(app, store);
  const server = await listenForFetch(app);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    async function call(path: string, body?: unknown, method = 'POST') {
      const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    }
    const listed = await call('/api/media-workflows', undefined, 'GET');
    assert.equal(listed.status, 200);
    assert.equal(listed.value.items.length, 2);
    const pending = await call('/api/media-workflows/preview', { text: JSON.stringify(recipe()) });
    assert.equal(pending.status, 200);
    const imported = await call('/api/media-workflows/import', { token: pending.value.token });
    assert.equal(imported.status, 200);
    const id = imported.value.item.id;
    const changed = recipe();
    changed.parameters.engine = 'legacy';
    const saved = await call('/api/media-workflows/save', { id, workflow: changed });
    assert.equal(saved.status, 200);
    assert.equal(store.options(id, ['/synthetic']).engine, 'legacy');
    const exported = await call(`/api/media-workflows/${id}/export`, undefined, 'GET');
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.value, changed);
    const invalid = await call('/api/media-workflows/preview', { url: 'https://127.0.0.1/workflow.json' });
    assert.equal(invalid.status, 400);
    assert.equal((await call('/api/media-workflows/save', { workflow: { ...changed, command: 'exec' } })).status, 400);
    assert.equal((await call(`/api/media-workflows/${id}`, undefined, 'DELETE')).status, 200);
    assert.equal(store.list().items.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt personal workflow storage is preserved without blocking builtin use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-workflows-corrupt-'));
  try {
    const path = join(directory, 'media-workflows.json');
    await writeFile(path, '{broken');
    const store = new MediaWorkflowStore(directory);
    assert.ok(store.list().warning?.includes('原文件已保留'));
    assert.equal(store.get('builtin-gemma-fast').workflow.parameters.engine, 'legacy');
    assert.throws(() => store.save(recipe()), /修复文件/);
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
