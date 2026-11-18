import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/server/store.ts';
import type { Project, Conversation, RuntimeTarget } from '../src/shared/types.ts';

test('PATCH workMode validates, saves and clears the conversation mode', { timeout: 30000 }, async (t) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-work-mode-http-')));
  const folder = join(directory, 'project');
  mkdirSync(folder);
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
    assert.ok(basename(directory).startsWith('pugport-work-mode-http-'));
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
    await request('/api/conversations', 'POST', { projectId: project.id, title: 'Mode fixture' })
  ).json()) as Conversation;
  const url = '/api/conversations/' + conversation.id;
  const saved = async () =>
    ((await (await request(url + '?recordOnly=1')).json()) as { conversation: Conversation }).conversation;
  assert.equal((await request(url, 'PATCH', { workMode: 'navigator' }, false)).status, 403);
  assert.equal((await request(url, 'PATCH', { workMode: 'normal' })).status, 400);
  assert.equal((await request(url, 'PATCH', { workMode: 'creator' })).status, 400);
  assert.equal((await saved()).workMode, undefined);
  for (const mode of ['mods-author', 'navigator'] as const) {
    const response = await request(url, 'PATCH', { workMode: mode });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Conversation).workMode, mode);
    assert.equal((await saved()).workMode, mode);
  }
  // Other edits leave the mode alone; null goes back to Normal.
  assert.equal((await request(url, 'PATCH', { pinned: true })).status, 200);
  assert.equal((await saved()).workMode, 'navigator');
  assert.equal((await request(url, 'PATCH', { workMode: null })).status, 200);
  assert.equal('workMode' in (await saved()), false);
  // Navigator › Runs on: a card, optional model and effort; null goes back to automatic.
  for (const navigatorRoute of [{ runtimeId: '' }, { model: 'x' }, { runtimeId: 'card', extra: true }])
    assert.equal((await request(url, 'PATCH', { navigatorRoute })).status, 400);
  const route = { runtimeId: 'claude-native', model: 'synthetic-model', effort: 'high' };
  assert.equal((await request(url, 'PATCH', { navigatorRoute: route })).status, 200);
  assert.deepEqual((await saved()).navigatorRoute, route);
  assert.equal((await request(url, 'PATCH', { navigatorRoute: null })).status, 200);
  assert.equal('navigatorRoute' in (await saved()), false);
});
