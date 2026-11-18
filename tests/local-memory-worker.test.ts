import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { LocalMemoryScheduler } from '../src/server/local-memory-scheduler.ts';
import { memoryConversationPaths } from '../src/server/local-memory.ts';
import type { Conversation, Project } from '../src/shared/types.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test(
  'an export queued before removal cannot recreate the removed project private directory',
  { timeout: 10000 },
  async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-worker-removed-')));
    t.mock.property(process, 'env', { ...process.env, COMBORUNNER_MEMORY_DIR: join(root, 'private') });
    const data = join(root, 'data');
    const db = new Store(data);
    const store = new WorkspaceStore(db.db);
    const project: Project = {
      id: randomUUID(),
      name: 'Removed',
      path: join(root, 'source'),
      createdAt: '',
      updatedAt: '',
      removedAt: '2026-10-25',
    };
    const conversation: Conversation = {
      id: randomUUID(),
      projectId: project.id,
      title: 'Removed',
      createdAt: '',
      updatedAt: '',
    };
    mkdirSync(project.path);
    store.save('project', project.id, project.id, project);
    store.save('conversation', conversation.id, project.id, conversation);
    store.addMessage(conversation.id, 'user', 'This must not be exported after removal.');
    const scheduler = new LocalMemoryScheduler(data, resolve(import.meta.dirname, '..'), () => {});
    t.after(async () => {
      await scheduler.close();
      db.close();
      assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(root).startsWith('comborunner-worker-removed-'));
      rmSync(root, { recursive: true, force: true });
    });
    const result = await scheduler.flush(project.id);
    assert.ok(result.warnings.length > 0);
    assert.equal(existsSync(memoryConversationPaths(data, project.id, conversation.id).directory), false);
  },
);

test(
  'a real background worker exports a large history while the HTTP event loop keeps serving',
  { timeout: 30_000 },
  async (t) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-worker-test-')));
    const previousMemoryRoot = process.env.COMBORUNNER_MEMORY_DIR;
    process.env.COMBORUNNER_MEMORY_DIR = join(root, 'private');
    const store = new Store(join(root, 'data'));
    const workspace = new WorkspaceStore(store.db);
    const at = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: 'Synthetic',
      path: join(root, 'project'),
      createdAt: at,
      updatedAt: at,
    };
    const conversation: Conversation = {
      id: randomUUID(),
      projectId: project.id,
      title: 'Synthetic',
      createdAt: at,
      updatedAt: at,
    };
    mkdirSync(project.path);
    workspace.save('project', project.id, project.id, project);
    workspace.save('conversation', conversation.id, project.id, conversation);
    store.db.exec('BEGIN');
    for (let index = 0; index < 300; index++)
      workspace.addMessage(
        conversation.id,
        index % 2 ? 'assistant' : 'user',
        `Synthetic message ${index}\n` + 'x'.repeat(64 * 1024),
      );
    store.db.exec('COMMIT');
    const scheduler = new LocalMemoryScheduler(join(root, 'data'), resolve(import.meta.dirname, '..'), () => {});
    const server = createServer((_request, response) => response.end('responsive'));
    await listenForFetch(server);
    t.after(async () => {
      await scheduler.close();
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      if (previousMemoryRoot === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
      else process.env.COMBORUNNER_MEMORY_DIR = previousMemoryRoot;
      assert.ok(
        root.startsWith(realpathSync.native(tmpdir()) + sep) && basename(root).startsWith('comborunner-worker-test-'),
      );
      rmSync(root, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let finished = false;
    const exportJob = scheduler.flush(project.id).then((result) => {
      finished = true;
      return result;
    });
    let servedDuringExport = 0;
    while (!finished) {
      const body: string = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(3000) }).then(
        (response) => response.text(),
      );
      assert.equal(body, 'responsive');
      if (!finished) servedDuringExport++;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.deepEqual((await exportJob).warnings, []);
    assert.ok(servedDuringExport >= 2, 'HTTP requests must finish while the actual export worker is busy');
    assert.ok(
      statSync(memoryConversationPaths(join(root, 'data'), project.id, conversation.id).historyPath).size > 19_000_000,
    );
  },
);
