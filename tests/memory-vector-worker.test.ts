import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { indexMemory } from '../src/server/memory-vectors.ts';
import { runMemoryVectorWorker } from '../src/server/memory-vector-client.ts';

test('file-backed vector indexing scans in a worker, retains privacy filters and recovers after failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-vector-worker-'));
  const model = join(root, '.runtime', 'memory-search');
  mkdirSync(model, { recursive: true });
  writeFileSync(join(model, 'model.onnx'), 'synthetic: never loaded');
  writeFileSync(join(model, 'tokenizer.json'), '{}');
  const vectorDirectory = join(root, 'vectors');
  t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_VECTORS_DIR: vectorDirectory });
  const databasePath = join(root, 'studio.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE workspace_records(kind TEXT,id TEXT,owner TEXT,updated_at TEXT,value TEXT)');
  const insert = db.prepare('INSERT INTO workspace_records VALUES (?,?,?,?,?)');
  const add = (kind: string, id: string, owner: string, value: unknown) =>
    insert.run(kind, id, owner, '2026-01-01', JSON.stringify(value));
  add('project', 'p', 'p', { id: 'p' });
  add('conversation', 'c', 'p', { id: 'c' });
  add('conversation', 'private', 'p', { id: 'private', memory: 'off' });
  add('conversation', 'incognito', 'p', { id: 'incognito', incognito: true });
  db.exec('BEGIN');
  for (let i = 0; i < 500; i++)
    add('message', `m${i}`, 'c', {
      role: 'user',
      content: 'Synthetic history for worker regression.',
      createdAt: '2026-01-01',
    });
  add('message', 'private', 'private', { role: 'user', content: 'Must not be embedded.' });
  add('message', 'incognito', 'incognito', { role: 'user', content: 'Must not be embedded.' });
  add('message', 'untrusted', 'c', { role: 'user', content: 'Must not be embedded.', untrustedContent: true });
  db.exec('COMMIT');
  const store = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
  t.mock.method(store, 'iterateMemoryIndexRows', () => {
    throw new Error('Main thread scan forbidden');
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const job = { databasePath, appRoot: root, projectId: 'p', vectorDirectory, until: 0 };
  await assert.rejects(runMemoryVectorWorker({ ...job, databasePath: join(root, 'absent.sqlite') }));
  await assert.rejects(runMemoryVectorWorker(job, undefined, 1), /timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runMemoryVectorWorker(job, controller.signal));
  let previous = performance.now(),
    maximum = 0,
    ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximum = Math.max(maximum, now - previous - 5);
    previous = now;
    ticks++;
  }, 5);
  try {
    assert.equal(await indexMemory(root, store, 'p', { until: 0 }), 500);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 5);
  assert.ok(maximum < 200, `main thread delay ${maximum.toFixed(1)}ms`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_records').get()!.n, 507);
  t.diagnostic(`500 messages, main-thread maximum delay ${maximum.toFixed(1)}ms`);
});
