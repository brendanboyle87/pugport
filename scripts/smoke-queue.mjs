// Production HTTP/storage smoke in an isolated data directory. All runtimes are disabled.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { electronArgs } from '../tests/helpers/electron-app.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const cleanEnvironment = () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (/^(?:COMBORUNNER|AGENT_STUDIO)_(?:ROOT|DATA_DIR|PORT|SMOKE_DIR|DESKTOP_USER_DATA_DIR)$/i.test(key))
      delete environment[key];
  return environment;
};
const directory = await mkdtemp(join(tmpdir(), 'agent-studio-queue-smoke-'));
const dataDir = join(directory, 'data');
await mkdir(dataDir);
await mkdir(join(directory, 'project'));
const seed = new DatabaseSync(join(dataDir, 'studio.sqlite'));
seed.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
seed.prepare('INSERT INTO config VALUES (?,?)').run(
  'targets',
  JSON.stringify(
    ['pi', 'dsh', 'codex', 'claude', 'cursor', 'gemini'].map((provider) => ({
      id: `${provider}-${['cursor', 'gemini'].includes(provider) ? 'native' : 'local'}`,
      provider,
      label: provider,
      command: 'disabled',
      environment: 'native',
      enabled: false,
    })),
  ),
);
seed.close();
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const assigned = server.address().port;
    server.close(() => resolvePort(assigned));
  });
});
const base = `http://127.0.0.1:${port}`;
const checks = [];
const lifecycle = { shutdownAcknowledgements: 0 };
let child;
let token = '';
let owner = '';
async function start() {
  child = fork(join(root, 'dist', 'server', 'main.js'), [], {
    cwd: root,
    execPath: process.execPath,
    windowsHide: true,
    env: {
      ...cleanEnvironment(),
      COMBORUNNER_ROOT: root,
      COMBORUNNER_DATA_DIR: dataDir,
      COMBORUNNER_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-3000);
  });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 20000);
    const fail = (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited ${code}: ${output}`));
    };
    child.once('exit', fail);
    child.once('error', reject);
    child.on('message', (message) => {
      if (message?.type === 'session') {
        token = message.token;
        owner = message.owner;
      }
      if (message?.type === 'ready') {
        clearTimeout(timer);
        child.off('exit', fail);
        ready();
      }
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const running = child;
  let acknowledged = false;
  const acknowledge = (message) => {
    if (message?.type === 'shutdown-complete') acknowledged = true;
  };
  running.on('message', acknowledge);
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => running.kill(), 15000);
    running.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    if (running.connected) running.send('shutdown');
    else running.kill();
  });
  running.off('message', acknowledge);
  if (acknowledged) lifecycle.shutdownAcknowledgements++;
  child = undefined;
}
async function request(path, body, method = 'POST', expected = 200) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  return value;
}
const state = () =>
  fetch(base + '/api/state', { headers: { 'x-agent-token': token, 'x-pugport-owner': owner } }).then((response) =>
    response.json(),
  );
async function inspectQuit() {
  const running = child,
    requestId = 701;
  assert.ok(running?.connected);
  const inspection = await new Promise((done, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      running.off('message', receive);
      running.off('exit', exited);
    };
    const receive = (message) => {
      if (message?.type !== 'quit-inspection' || message.requestId !== requestId) return;
      cleanup();
      done(message);
    };
    const exited = () => {
      cleanup();
      reject(new Error('Backend exited before quit inspection'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Quit inspection timed out'));
    }, 5000);
    running.on('message', receive);
    running.once('exit', exited);
    running.send({ type: 'quit-inspection', requestId }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
  assert.equal(inspection.requestId, requestId);
  assert.equal(inspection.error, undefined);
  for (const key of ['active', 'queued', 'waitingApproval', 'scheduled'])
    assert.ok(Number.isSafeInteger(inspection[key]) && inspection[key] >= 0);
  assert.equal(inspection.scheduled, 2);
  assert.equal(inspection.queued, 0);
  assert.equal(inspection.active, 0);
  lifecycle.quitInspection = inspection;
}
async function disconnectAndVerifyCleanup() {
  const running = child;
  assert.ok(running?.connected);
  const exited = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not stop after parent IPC disconnect')), 20000);
    running.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal });
    });
  });
  running.disconnect();
  const result = await exited;
  child = undefined;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  await assert.rejects(stat(join(dataDir, 'server.lock')), { code: 'ENOENT' });
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : done())),
    );
  });
  lifecycle.parentDisconnect = { ...result, lockRemoved: true, portReleased: true };
}

try {
  await start();
  assert.equal((await state()).app.version, pkg.version);
  checks.push('production backend version');
  const project = await request(
    '/api/projects',
    { path: join(directory, 'project'), name: '队列验收项目' },
    'POST',
    201,
  );
  const conversation = await request('/api/conversations', { projectId: project.id, title: '调度验收' }, 'POST', 201);
  const input = {
    content: '预约队列测试；不要调用模型。',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
  };
  await request(
    `/api/conversations/${conversation.id}/messages`,
    { ...input, schedule: { deadlineAt: '2026-01-01T20:00' } },
    'POST',
    400,
  );
  checks.push('timezone-less deadline rejected');
  const notBefore = new Date(Date.now() + 86400000).toISOString();
  const deadlineAt = new Date(Date.now() + 172800000).toISOString();
  const first = await request(
    `/api/conversations/${conversation.id}/messages`,
    { ...input, schedule: { notBefore, deadlineAt, priority: 'high' } },
    'POST',
    201,
  );
  const second = await request(
    `/api/conversations/${conversation.id}/messages`,
    { ...input, content: '可取消的第二个队列任务', schedule: { notBefore, deadlineAt } },
    'POST',
    201,
  );
  assert.notEqual(first.workflow.id, second.workflow.id);
  let current = await state();
  assert.equal(current.runs.length, 0);
  assert.equal(current.workflows.length, 2);
  assert.ok(current.workflows.every((workflow) => ['queued', 'waiting-resource'].includes(workflow.status)));
  checks.push('multiple messages durably queued without inference');
  await inspectQuit();
  checks.push('production quit-inspection IPC correlates its request and reports future scheduled work');
  await request(`/api/workflows/${second.workflow.id}/cancel`, {});
  assert.equal((await state()).workflows.find((workflow) => workflow.id === second.workflow.id).status, 'cancelled');
  checks.push('queued cancellation');
  await request(
    `/api/workflows/${first.workflow.id}/schedule`,
    { schedule: { notBefore, deadlineAt, priority: 'normal', preferExpiringQuota: true } },
    'PATCH',
  );
  await request(
    `/api/workflows/${first.workflow.id}/schedule`,
    { schedule: { notBefore: deadlineAt, deadlineAt: notBefore } },
    'PATCH',
    400,
  );
  checks.push('reschedule and invalid date order');
  await stop();
  assert.ok(lifecycle.shutdownAcknowledgements >= 1);
  checks.push('backend acknowledges explicit graceful shutdown');
  await start();
  current = await state();
  const restored = current.workflows.find((workflow) => workflow.id === first.workflow.id);
  assert.ok(restored);
  assert.equal(restored.input.schedule.notBefore, notBefore);
  assert.ok(['queued', 'waiting-resource'].includes(restored.status));
  assert.equal(current.runs.length, 0);
  checks.push('unstarted queue survives real process restart');
  await request('/api/queue/wake', {});
  assert.equal((await state()).runs.length, 0);
  checks.push('manual reevaluation preserves not-before');
  if (process.argv.includes('--ui')) {
    const require = createRequire(import.meta.url),
      electron = require('electron');
    const environment = { ...cleanEnvironment(), AGENT_STUDIO_SMOKE_URL: base };
    delete environment.ELECTRON_RUN_AS_NODE;
    await new Promise((resolveUI, reject) => {
      const ui = spawn(electron, electronArgs(join(root, 'scripts', 'smoke-queue-ui.cjs')), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      ui.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-5000);
      });
      ui.stderr.on('data', (chunk) => {
        output = (output + chunk).slice(-5000);
      });
      const timer = setTimeout(() => {
        ui.kill();
        reject(new Error('UI smoke timed out'));
      }, 60000);
      ui.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      ui.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? resolveUI() : reject(new Error(`UI smoke failed (${code}): ${output}`));
      });
    });
    checks.push('actual Electron queue UI');
  }
  assert.ok((await state()).targets.every((target) => !target.enabled));
  assert.equal((await state()).runs.length, 0);
  await stop();
  await start();
  await disconnectAndVerifyCleanup();
  checks.push('parent IPC disconnect gracefully exits backend and releases its lock and port');
  await mkdir(join(root, 'reports', 'comborunner-v001'), { recursive: true });
  await writeFile(
    join(root, 'reports', 'comborunner-v001', 'http-smoke.json'),
    JSON.stringify({ at: new Date().toISOString(), passed: true, checks, lifecycle }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks, lifecycle }));
} finally {
  await stop();
  const cleanup = resolve(directory);
  assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep) && basename(cleanup).startsWith('agent-studio-queue-smoke-'));
  await rm(cleanup, { recursive: true, force: true });
}
