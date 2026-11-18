import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { AppState, Project, Conversation, RuntimeTarget } from '../src/shared/types.ts';

test(
  'HTTP archive, lists, restore and batch use distinct paths and session protection',
  { timeout: 30000 },
  async (t) => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-archive-http-')));
    const folder = join(directory, 'project');
    mkdirSync(folder);
    writeFileSync(join(folder, 'keep.txt'), 'synthetic');
    const data = join(directory, 'data');
    const store = new Store(data);
    store.setConfig(
      'targets',
      (['codex', 'claude', 'grok', 'pi', 'cursor'] as const).map<RuntimeTarget>((provider) => ({
        id: provider + '-native',
        provider,
        label: 'Disabled fixture',
        command: 'unused',
        environment: 'native',
        enabled: false,
        commandDiscovery: 'fixed',
      })),
    );
    store.close();
    const child = fork(join(root, 'src/server/main.ts'), [], {
      cwd: root,
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        ...process.env,
        COMBORUNNER_ROOT: directory,
        COMBORUNNER_DATA_DIR: data,
        COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
        COMBORUNNER_PORT: '0',
        USERPROFILE: directory,
        HOME: directory,
        CODEX_HOME: join(directory, 'codex'),
        JEV_API_KEY: '',
        TYPESAFE_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-archive-http-'));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    let token = '';
    let owner = '';
    const port = await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(Error(output)));
      child.on('message', (message: { type?: string; token?: string; owner?: string; port?: number }) => {
        if (message.type === 'session') {
          token = message.token ?? '';
          owner = message.owner ?? '';
        }
        if (message.type === 'ready' && message.port) done(message.port);
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const request = async (path: string, method = 'GET', body?: unknown, authenticated = true) =>
      fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { 'x-agent-token': token, 'x-pugport-owner': owner } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    const project = (await (await request('/api/projects', 'POST', { path: folder })).json()) as Project;
    const conversation = (await (
      await request('/api/conversations', 'POST', { projectId: project.id, title: 'Archive needle' })
    ).json()) as Conversation;
    const url = '/api/conversations/' + conversation.id;
    assert.equal((await request(url, 'PATCH', { archived: true }, false)).status, 403);
    assert.equal((await request(url, 'PATCH', { archived: 'yes' })).status, 400);
    const archived = (await (await request(url, 'PATCH', { archived: true })).json()) as Conversation;
    assert.ok(archived.archivedAt);
    assert.equal((await request('/api/archived-conversations')).status, 200);
    assert.equal((await (await request('/api/archived-conversations')).json())[0].id, conversation.id);
    assert.deepEqual(await (await request('/api/deleted-conversations')).json(), []);
    assert.equal((await request(url)).status, 200);
    assert.equal((await (await request('/api/search?q=needle')).json())[0].archivedAt, archived.archivedAt);
    const state = (await (await request('/api/state')).json()) as AppState;
    assert.equal(
      state.conversations?.some((item) => item.id === conversation.id),
      false,
    );
    assert.equal((await request(url, 'PATCH', { archived: false })).status, 200);
    assert.equal((await request(url, 'DELETE', {})).status, 200);
    assert.equal((await (await request('/api/deleted-conversations')).json())[0].id, conversation.id);
    assert.equal((await request(url + '/restore', 'POST', {}, false)).status, 403);
    assert.equal((await request(url + '/restore', 'POST', {})).status, 200);
    assert.deepEqual(await (await request('/api/deleted-conversations')).json(), []);
    const bulk = (await (
      await request('/api/conversations', 'POST', { projectId: project.id, title: 'Bulk fixture' })
    ).json()) as Conversation;
    const bulkUrl = '/api/conversations/' + bulk.id;
    assert.equal((await request(bulkUrl, 'PATCH', { archived: true })).status, 200);
    const deleteAll = '/api/archived-conversations/delete-all';
    assert.equal((await request(deleteAll, 'POST', {}, false)).status, 403);
    assert.equal((await request(deleteAll, 'POST', { extra: true })).status, 400);
    assert.deepEqual(await (await request(deleteAll, 'POST', {})).json(), { deleted: 1, skipped: 0 });
    const counts = (await (await request('/api/conversation-history')).json()) as {
      archived: number;
      deleted: number;
      purge: { count: number; olderCount: number; token: string };
    };
    assert.deepEqual([counts.archived, counts.deleted, counts.purge.count, counts.purge.olderCount], [0, 1, 1, 0]);
    const empty = '/api/deleted-conversations/empty';
    assert.equal((await request(empty, 'POST', { token: counts.purge.token }, false)).status, 403);
    assert.equal((await request(empty, 'POST', {})).status, 400);
    assert.equal((await request(empty, 'POST', { token: counts.purge.token, extra: 1 })).status, 400);
    assert.equal((await request(empty, 'POST', { token: 'f'.repeat(64) })).status, 400);
    assert.deepEqual(await (await request(empty, 'POST', { token: counts.purge.token })).json(), {
      deleted: 1,
      skipped: 0,
      kept: 0,
      unsafe: 0,
    });
    assert.deepEqual(await (await request('/api/deleted-conversations')).json(), []);
    assert.equal((await request('/api/removed-projects/clear', 'POST', {}, false)).status, 403);
    assert.equal((await request('/api/removed-projects/clear', 'POST', { extra: 1 })).status, 400);
    const busy = (await (
      await request('/api/conversations', 'POST', { projectId: project.id, title: 'Busy fixture' })
    ).json()) as Conversation;
    // Seed a running fixture after startup; no executor or real task is launched.
    const fixtureStore = new Store(data);
    const records = new WorkspaceStore(fixtureStore.db);
    const workflow = {
      id: 'busy-fixture',
      projectId: project.id,
      conversationId: busy.id,
      status: 'running',
      runIds: [],
      input: { content: 'Synthetic task', mode: 'chat' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      records.save('workflow', workflow.id, busy.id, workflow);
    } finally {
      fixtureStore.close();
    }
    assert.equal((await request('/api/conversations/' + busy.id, 'PATCH', { archived: true })).status, 400);
    const batch = '/api/projects/' + project.id + '/archive-conversations';
    assert.equal((await request(batch, 'POST', {}, false)).status, 403);
    assert.deepEqual(await (await request(batch, 'POST', {})).json(), { archived: 1, skipped: 1 });
    assert.deepEqual(await (await request(batch, 'POST', {})).json(), { archived: 0, skipped: 1 });
    const completedStore = new Store(data);
    try {
      new WorkspaceStore(completedStore.db).save('workflow', workflow.id, busy.id, {
        ...workflow,
        status: 'completed',
      });
    } finally {
      completedStore.close();
    }
    await request('/api/projects/' + project.id, 'DELETE', {});
    assert.deepEqual(await (await request('/api/removed-projects/clear', 'POST', {})).json(), { cleared: true });
    const cleared = (await (await request('/api/state')).json()) as AppState;
    assert.ok(cleared.settings.removedProjectsClearedAt);
    assert.ok(
      cleared.removedProjects?.some((item) => item.id === project.id),
      'Clear list never filters app state',
    );
    assert.deepEqual(await (await request('/api/archived-conversations')).json(), []);
    assert.equal((await request(url + '/restore', 'POST', {})).status, 400);
  },
);
