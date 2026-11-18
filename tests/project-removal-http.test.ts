import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { AppState, Project, Conversation, RuntimeTarget } from '../src/shared/types.ts';
import type { ProjectPurgePreview, ProjectPurgeResult } from '../src/shared/project-data.ts';

test(
  'HTTP remove and restore require a session token and state hides the project and its conversations',
  { timeout: 30000 },
  async (t) => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-project-http-')));
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
    const records = new WorkspaceStore(store.db);
    for (const id of ['dispatch-existing', 'dispatch-removed', 'dispatch-restore']) {
      const path = join(directory, id);
      mkdirSync(path);
      records.save('project', id, id, {
        id,
        name: id,
        path: realpathSync.native(path),
        origin: 'dispatch',
        createdAt: '',
        updatedAt: '',
        ...(id !== 'dispatch-existing' ? { removedAt: '2026-01-01' } : {}),
      });
    }
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
      assert.ok(basename(directory).startsWith('pugport-project-http-'));
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
    assert.equal((await request('/api/routing-profiles', 'GET', undefined, false)).status, 403);
    assert.equal((await request('/api/routing-profiles')).status, 200);
    const created = await request('/api/projects', 'POST', { path: folder });
    assert.equal(created.status, 201);
    const project = (await created.json()) as Project;
    const restoreFolder = join(directory, 'dispatch-restore');
    assert.equal(dirname(realpathSync.native(restoreFolder)), directory);
    rmSync(restoreFolder, { recursive: true });
    const restoredDispatch = await request('/api/projects/dispatch-restore/restore', 'POST', {});
    assert.equal(restoredDispatch.status, 200);
    assert.equal(((await restoredDispatch.json()) as Project).origin, undefined);
    const afterRestore = (await (await request('/api/state')).json()) as AppState;
    assert.equal(afterRestore.projects?.find((p) => p.id === 'dispatch-restore')?.folderMissing, true);
    assert.equal(
      afterRestore.removedProjects?.some((p) => p.id === 'dispatch-restore'),
      false,
    );
    for (const id of ['dispatch-existing', 'dispatch-removed']) {
      const claimed = await request('/api/projects', 'POST', { path: join(directory, id) });
      assert.equal(claimed.status, 201);
      const owned = (await claimed.json()) as Project;
      assert.equal(owned.id, id);
      assert.equal(owned.origin, undefined);
      assert.equal(owned.removedAt, undefined);
      const state = (await (await request('/api/state')).json()) as AppState;
      assert.equal(state.projects?.find((p) => p.id === id)?.origin, undefined);
    }
    const conversation = (await (
      await request('/api/conversations', 'POST', { projectId: project.id })
    ).json()) as Conversation;
    assert.equal((await request('/api/projects/' + project.id, 'DELETE', {}, false)).status, 403);
    assert.equal((await request('/api/projects/' + project.id, 'DELETE', {})).status, 200);
    const state = (await (await request('/api/state')).json()) as AppState;
    assert.equal(
      state.projects?.some((value) => value.id === project.id),
      false,
    );
    assert.equal(
      state.conversations?.some((value) => value.id === conversation.id),
      false,
    );
    assert.equal(state.removedProjects?.[0].id, project.id);
    assert.equal((await request('/api/conversations/' + conversation.id)).status, 400);
    assert.equal((await request('/api/projects/' + project.id + '/restore', 'POST', {}, false)).status, 403);
    assert.equal((await request('/api/projects/' + project.id + '/restore', 'POST', {})).status, 200);
    const restored = (await (await request('/api/state')).json()) as AppState;
    assert.equal(
      restored.projects?.some((value) => value.id === project.id),
      true,
    );
    assert.equal(
      restored.conversations?.some((value) => value.id === conversation.id),
      true,
    );
    assert.equal(readFileSync(join(folder, 'keep.txt'), 'utf8'), 'synthetic');
    assert.equal((await request('/api/projects/' + project.id, 'DELETE', {})).status, 200);
    const added = await request('/api/projects', 'POST', { path: folder });
    assert.equal(added.status, 201);
    assert.equal(((await added.json()) as Project).id, project.id);
    const move = '/api/projects/' + project.id + '/move-to-chats';
    assert.equal((await request(move, 'POST', {}, false)).status, 403);
    const available = await request(move, 'POST', {});
    assert.equal(available.status, 400);
    assert.equal(((await available.json()) as { error: string }).error, '文件夹还在，不需要移到对话。');
    assert.equal(dirname(realpathSync.native(folder)), directory);
    rmSync(folder, { recursive: true });
    const moved = await request(move, 'POST', {});
    assert.equal(moved.status, 200);
    const chatProject = (await moved.json()) as Project;
    assert.equal(chatProject.id, project.id);
    assert.equal(chatProject.scope, 'chat');
    const movedState = (await (await request('/api/state')).json()) as AppState;
    assert.equal(movedState.conversations?.find((c) => c.id === conversation.id)?.projectId, project.id);
    const purge = `/api/projects/${project.id}/purge`;
    assert.equal((await request(purge + '-preview')).status, 400, 'active list entries cannot be purged');
    assert.equal((await request('/api/projects/' + project.id, 'DELETE', {})).status, 200);
    assert.equal((await request(purge + '-preview', 'GET', undefined, false)).status, 403);
    const preview = (await (await request(purge + '-preview')).json()) as ProjectPurgePreview;
    assert.equal(preview.canPurge, true);
    assert.equal(preview.conversations, 1);
    assert.equal((await request(purge, 'POST', { token: preview.token }, false)).status, 403);
    assert.equal((await request(purge, 'POST', { token: '0'.repeat(64) })).status, 400);
    const purged = await request(purge, 'POST', { token: preview.token });
    assert.equal(purged.status, 200);
    assert.equal(((await purged.json()) as ProjectPurgeResult).conversations, 1);
    assert.equal((await request('/api/projects/' + project.id + '/restore', 'POST', {})).status, 400);
    const afterPurge = (await (await request('/api/state')).json()) as AppState;
    assert.equal(
      afterPurge.removedProjects?.some((item) => item.id === project.id),
      false,
    );

    const original = join(directory, 'preserve-original');
    mkdirSync(original);
    writeFileSync(join(original, 'keep.txt'), 'preserved source');
    const preserved = (await (await request('/api/projects', 'POST', { path: original })).json()) as Project;
    await request('/api/projects/' + preserved.id, 'DELETE', {});
    const sourcePreview = (await (
      await request(`/api/projects/${preserved.id}/purge-preview`)
    ).json()) as ProjectPurgePreview;
    assert.equal(
      (await request(`/api/projects/${preserved.id}/purge`, 'POST', { token: sourcePreview.token })).status,
      200,
    );
    assert.equal(readFileSync(join(original, 'keep.txt'), 'utf8'), 'preserved source');
  },
);
