import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from '../src/server/platform/test-process.ts';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import type { Conversation, RuntimeTarget } from '../src/shared/types.ts';

test(
  'HTTP skill preferences persist for one chat, keep legacy permissions and reject invalid or unauthenticated changes',
  { timeout: 30000 },
  async (t) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-skills-http-')));
    const data = join(directory, 'data'),
      extensionDir = join(directory, 'extensions');
    mkdirSync(extensionDir);
    const items = ['review', 'notes', 'disabled'].map((name) => ({
      kind: 'skill',
      id: name,
      name,
      description: 'Synthetic skill',
      path: join(directory, name),
      source: 'fixture',
      managed: false,
      enabled: name !== 'disabled',
      installedAt: new Date().toISOString(),
    }));
    writeFileSync(join(extensionDir, 'extensions.json'), JSON.stringify({ version: 1, items }));
    const store = new Store(data);
    store.setConfig(
      'targets',
      (['codex', 'claude', 'grok', 'pi', 'cursor', 'gemini'] as const).map<RuntimeTarget>((provider) => ({
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
    const child = fork(resolve('src/server/main.ts'), [], {
      cwd: process.cwd(),
      execArgv: ['--import', 'tsx'],
      windowsHide: true,
      env: {
        ...process.env,
        COMBORUNNER_ROOT: directory,
        COMBORUNNER_DATA_DIR: data,
        COMBORUNNER_EXTENSIONS_DIR: extensionDir,
        COMBORUNNER_MEMORY_DIR: join(directory, 'memory'),
        COMBORUNNER_SECRETS_DIR: join(directory, 'secrets'),
        COMBORUNNER_PORT: '0',
        USERPROFILE: directory,
        HOME: directory,
        APPDATA: directory,
        LOCALAPPDATA: directory,
        CODEX_HOME: join(directory, 'codex'),
        CLAUDE_CONFIG_DIR: join(directory, 'claude'),
        JEV_API_KEY: '',
        TYPESAFE_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output = (output + chunk).slice(-8000);
    });
    child.stderr?.on('data', (chunk) => {
      output = (output + chunk).slice(-8000);
    });
    const exited = new Promise((done) => child.once('exit', done));
    t.after(async () => {
      if (child.exitCode === null && child.connected) child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-skills-http-'));
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
    const request = (path: string, method = 'GET', body?: unknown, authenticated = true) =>
      fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authenticated ? { 'x-agent-token': token, 'x-pugport-owner': owner } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    const create = async () => (await (await request('/api/conversations', 'POST', {})).json()) as Conversation;
    const first = await create(),
      second = await create();
    assert.equal(first.appliedSkills, undefined);
    const url = '/api/conversations/' + first.id + '/skills';
    assert.equal((await request(url, 'PATCH', { appliedSkills: ['review'] }, false)).status, 403);
    const legacy = await request(url, 'PATCH', { skills: ['review', 'notes'] });
    assert.equal(legacy.status, 200);
    const saved = await request(url, 'PATCH', { appliedSkills: [' REVIEW ', 'review', 'disabled'] });
    assert.equal(saved.status, 200);
    const chosen = (await saved.json()) as Conversation;
    assert.deepEqual(chosen.appliedSkills, ['review', 'disabled']);
    assert.deepEqual(chosen.skills, ['review', 'notes']);
    for (const body of [
      { appliedSkills: ['missing'] },
      { appliedSkills: 'review' },
      { appliedSkills: Array(41).fill('review') },
      { appliedSkills: ['notes'], skills: null },
    ])
      assert.equal((await request(url, 'PATCH', body)).status, 400);
    const read = await (await request('/api/conversations/' + first.id)).json();
    assert.deepEqual(read.conversation.appliedSkills, ['review', 'disabled']);
    assert.equal(
      (await (await request('/api/conversations/' + second.id)).json()).conversation.appliedSkills,
      undefined,
    );
    assert.equal((await request(url, 'PATCH', { appliedSkills: [] })).status, 200);
    const cleared = await (await request('/api/conversations/' + first.id)).json();
    assert.deepEqual(cleared.conversation.appliedSkills, []);
    assert.deepEqual(cleared.conversation.skills, ['review', 'notes']);
    assert.deepEqual((await (await request('/api/extensions')).json()).items, items);
  },
);
