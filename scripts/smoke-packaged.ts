import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { APP_VERSION } from '../src/shared/identity.ts';

const root = resolve('.'),
  output = join(root, 'reports', `packaged-${APP_VERSION}`),
  dataDir = join(output, `data-${Date.now()}`);
mkdirSync(output, { recursive: true });
const store = new Store(dataDir);
store.setConfig('targets', [
  {
    id: 'pi-local',
    provider: 'pi',
    label: 'Disabled for smoke',
    command: 'unused',
    environment: 'native',
    enabled: false,
  },
]);
store.close();
const packaged = join(root, 'release', 'PugPort-win32-x64');
const child = fork(join(packaged, 'resources', 'app', 'dist', 'server', 'main.js'), [], {
  execPath: join(packaged, 'PugPort.exe'),
  execArgv: [],
  windowsHide: true,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    COMBORUNNER_ROOT: join(packaged, 'resources', 'app'),
    COMBORUNNER_DATA_DIR: dataDir,
    COMBORUNNER_PORT: '0',
    HOME: dataDir,
    USERPROFILE: dataDir,
    JEV_API_KEY: '',
    TYPESAFE_API_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
const exited = new Promise((done) => child.once('exit', done));
const timeout = (ms: number) =>
  new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Smoke timed out')), ms);
    timer.unref();
  });
const report: Record<string, unknown> = { at: new Date().toISOString(), realModelCalls: 0 };
try {
  let token = '';
  let owner = '';
  const ready = await Promise.race([
    new Promise<{ port: number }>((done) =>
      child.on('message', (packet: any) => {
        if (packet?.type === 'session') {
          token = packet.token;
          owner = packet.owner;
        }
        if (packet.type === 'ready') done(packet);
      }),
    ),
    timeout(20000),
  ]);
  const base = `http://127.0.0.1:${ready.port}`;
  const get = async (path: string) => {
    const response = await fetch(base + path, {
      headers: { 'x-agent-token': token, 'x-pugport-owner': owner },
      signal: AbortSignal.timeout(20000),
    });
    assert.ok(response.ok);
    return response.json();
  };
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const result = await response.json();
    assert.ok(response.ok, `${path}: ${response.status}: ${result.error || 'unknown error'}`);
    return result;
  };
  const health = await get('/api/health');
  assert.equal(health.version, APP_VERSION);
  report.health = health;
  const accounts = await get('/api/accounts');
  assert.ok(Array.isArray(accounts.accounts));
  assert.ok(Array.isArray(accounts.providers));
  for (const provider of ['codex', 'grok'])
    assert.ok(
      accounts.providers.some((p: any) => p.id === provider && p.supported === true),
      `${provider} native account management must be supported`,
    );
  assert.equal(accounts.accounts.filter((a: any) => a.managed).length, 0);
  report.nativeAccountsApi = true;
  const chat = await post('/api/conversations');
  const state = await get('/api/state');
  assert.equal(state.projects.find((value: any) => value.id === chat.projectId)?.scope, 'chat');
  report.generalConversation = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : 'failed';
  process.exitCode = 1;
} finally {
  if (child.connected) child.send('shutdown');
  try {
    await Promise.race([exited, timeout(25000)]);
  } catch {
    child.kill();
    report.cleanShutdown = false;
    process.exitCode = 1;
  }
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
