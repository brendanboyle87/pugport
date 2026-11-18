// One real, read-only Windows native Codex request through the production queue.
// Uses the user's existing native CLI login; never copies or prints credentials.
// Run: node --import tsx scripts/smoke-queue-live.mjs (uses the TypeScript discovery descriptor).
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTargets } from '../src/server/discovery.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const cleanEnvironment = () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (/^(?:COMBORUNNER|AGENT_STUDIO)_(?:ROOT|DATA_DIR|PORT|SMOKE_DIR|DESKTOP_USER_DATA_DIR)$/i.test(key))
      delete environment[key];
  return environment;
};
const expectedReply = 'STUDIO_QUEUE_CONNECTED';
const reportPath = join(root, 'reports', 'comborunner-v001', 'live-smoke.json');
const report = {
  at: new Date().toISOString(),
  live: true,
  passed: false,
  platform: process.platform,
  provider: 'codex',
  environment: 'native',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  effort: 'low',
  inferenceSubmissions: 0,
  statuses: [],
  checks: [],
};
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
let directory,
  child,
  base,
  token = '',
  owner = '',
  workflowId;
let phase = 'setup';

async function stop() {
  if (!child || child.exitCode !== null) return;
  const running = child;
  const exit = new Promise((resolveExit) => running.once('exit', resolveExit));
  if (running.connected) running.send('shutdown');
  else running.kill();
  const graceful = await Promise.race([exit.then(() => true), pause(20000).then(() => false)]);
  if (!graceful) {
    report.forcedShutdown = true;
    if (process.platform === 'win32') {
      await new Promise((resolveKill) => {
        const killer = spawn('taskkill.exe', ['/PID', String(running.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('exit', resolveKill);
        killer.once('error', resolveKill);
      });
    } else running.kill('SIGKILL');
    await Promise.race([exit, pause(5000)]);
  }
  assert.notEqual(running.exitCode, null, 'own-backend-did-not-exit');
  child = undefined;
  report.backendStopped = true;
}
async function request(path, body, expected = 200) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': token, 'x-pugport-owner': owner },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (response.status !== expected) throw new Error(`http-${response.status}`);
  return response.json();
}
async function state() {
  const response = await fetch(base + '/api/state', {
    headers: { 'x-agent-token': token, 'x-pugport-owner': owner },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`state-http-${response.status}`);
  return response.json();
}
function observe(workflow) {
  if (report.statuses.at(-1)?.status !== workflow.status)
    report.statuses.push({ status: workflow.status, at: new Date().toISOString() });
}

try {
  if (process.platform !== 'win32') throw new Error('windows-native-required');
  const descriptor = defaultTargets().find(
    (target) => target.id === 'codex-native' && target.provider === 'codex' && target.environment === 'native',
  );
  assert.ok(descriptor, 'native-codex-descriptor-unavailable');
  report.runtimeId = descriptor.id;
  directory = await mkdtemp(join(tmpdir(), 'agent-studio-queue-live-'));
  const dataDir = join(directory, 'data'),
    projectPath = join(directory, 'project');
  await mkdir(dataDir);
  await mkdir(projectPath);
  const seed = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  seed.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  seed.prepare('INSERT INTO config VALUES (?,?)').run(
    'targets',
    JSON.stringify([
      { ...descriptor, enabled: true },
      ...['pi', 'dsh', 'claude', 'grok'].map((provider) => ({
        id: `${provider}-local`,
        provider,
        label: provider,
        command: 'disabled',
        environment: 'native',
        enabled: false,
      })),
    ]),
  );
  seed
    .prepare('INSERT INTO config VALUES (?,?)')
    .run('settings', JSON.stringify({ maxConcurrentRuns: 1, unknownQuotaPolicy: 'manual-only', refreshSeconds: 60 }));
  seed.close();
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolvePort(value));
    });
  });
  base = `http://127.0.0.1:${port}`;
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
  // Discovery/runtime diagnostics are never retained or exposed in the report.
  child.stdout.resume();
  child.stderr.resume();
  await new Promise((ready, reject) => {
    const timeout = setTimeout(() => reject(new Error('backend-startup-timeout')), 20000);
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error('backend-startup-failed'));
    };
    child.once('exit', fail);
    child.once('error', fail);
    child.on('message', (message) => {
      if (message?.type === 'session') {
        token = message.token;
        owner = message.owner;
      }
      if (message?.type === 'ready') {
        clearTimeout(timeout);
        child.off('exit', fail);
        child.off('error', fail);
        ready();
      }
    });
  });
  phase = 'discovery';
  await request('/api/refresh', {});
  const initial = await state();
  assert.equal(initial.app.version, pkg.version, 'production-version-mismatch');
  report.appVersion = initial.app.version;
  assert.deepEqual(
    initial.targets.filter((target) => target.enabled).map((target) => target.id),
    ['codex-native'],
    'only-native-codex-enabled',
  );
  const runtime = initial.runtimes.find((item) => item.id === descriptor.id);
  report.runtimeStatus = runtime?.status ?? 'missing';
  report.quotaStatus = runtime?.quota.status ?? 'unknown';
  if (!runtime?.installed || runtime.status !== 'ready') throw new Error(`native-codex-${report.runtimeStatus}`);
  if (runtime.quota.status !== 'known') throw new Error('subscription-quota-unavailable');
  const candidates = runtime.models.filter(
    (model) => (model.lightweight || /luna|mini|nano/i.test(model.id)) && model.efforts.includes('low'),
  );
  const model = candidates.find((item) => /luna/i.test(item.id)) ?? candidates[0];
  if (!model) throw new Error('discovered-light-model-with-low-effort-unavailable');
  report.model = model.id;
  await request('/api/route', {
    prompt: expectedReply,
    projectPath,
    kind: 'routine',
    runtimeId: descriptor.id,
    model: model.id,
    effort: 'low',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    allowUnknownQuota: false,
  });
  report.checks.push(
    'only Windows native Codex enabled; discovered lightweight model and low effort; known subscription quota passes route check',
  );

  phase = 'queued-execution';
  const project = await request('/api/projects', { path: projectPath, name: 'Isolated native queue smoke' }, 201);
  const conversation = await request(
    '/api/conversations',
    { projectId: project.id, title: 'One read-only native queue smoke' },
    201,
  );
  const submittedAt = Date.now(),
    notBefore = new Date(submittedAt + 2000).toISOString(),
    deadlineAt = new Date(submittedAt + 120000).toISOString();
  const submission = await request(
    `/api/conversations/${conversation.id}/messages`,
    {
      content: `This is a minimal connectivity check. Do not call any tools. Do not read, create, edit or delete files. Do not browse or make additional network requests. Reply with exactly ${expectedReply} and nothing else.`,
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
      runtimeId: descriptor.id,
      model: model.id,
      effort: 'low',
      allowUnknownQuota: false,
      autoEscalate: false,
      schedule: { notBefore, deadlineAt, priority: 'normal', preferExpiringQuota: true },
    },
    201,
  );
  report.inferenceSubmissions = 1;
  workflowId = submission.workflow.id;
  observe(submission.workflow);
  assert.equal(submission.workflow.status, 'queued', 'submission-must-first-be-queued');
  assert.equal(submission.workflow.runIds.length, 0, 'queued-task-has-not-started');
  report.notBefore = notBefore;
  report.deadlineAt = deadlineAt;
  let finalState, flow;
  while (Date.now() < submittedAt + 120000) {
    const current = await state();
    flow = current.workflows.find((item) => item.id === workflowId);
    if (!flow) throw new Error('queued-workflow-missing');
    observe(flow);
    const runs = current.runs.filter((run) => run.workflowId === workflowId);
    if (Date.now() < Date.parse(notBefore)) assert.equal(runs.length, 0, 'started-before-not-before');
    if (current.approvals.length || runs.some((run) => run.events.some((event) => event.type === 'tool'))) {
      await request(`/api/workflows/${workflowId}/cancel`, {}).catch(() => {});
      throw new Error('unexpected-tool-or-approval-request');
    }
    if (['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(flow.status)) {
      finalState = current;
      break;
    }
    await pause(150);
  }
  report.workflowStatus = flow?.status ?? 'missing';
  if (!finalState) throw new Error('queued-execution-timeout');
  assert.equal(flow.status, 'completed', 'native-queue-did-not-complete');
  const runs = finalState.runs.filter((run) => run.workflowId === workflowId);
  assert.equal(runs.length, 1, 'one-inference-only');
  const run = runs[0];
  report.runStatus = run.status;
  report.actualRuntimeId = run.route.runtimeId;
  report.actualModel = run.route.model;
  report.actualEffort = run.route.effort;
  report.toolEvents = run.events.filter((event) => event.type === 'tool').length;
  report.exactReply = run.output.trim() === expectedReply;
  report.reply = report.exactReply ? expectedReply : '[unexpected reply omitted]';
  report.runStartedAt = run.startedAt;
  report.elapsedMs = Date.now() - submittedAt;
  assert.equal(run.status, 'completed');
  assert.equal(run.route.runtimeId, descriptor.id);
  assert.equal(run.route.model, model.id);
  assert.equal(run.route.effort, 'low');
  assert.ok(Date.parse(run.startedAt) >= Date.parse(notBefore), 'start-time-respects-not-before');
  assert.equal(report.exactReply, true, 'exact-reply-mismatch');
  assert.equal(report.toolEvents, 0, 'no-tools-allowed');
  assert.equal((await readdir(projectPath)).length, 0, 'isolated-project-must-remain-empty');
  report.checks.push(
    'HTTP message observed queued before execution',
    'actual start respects notBefore',
    'single native CLI-only read-only run completed with low effort',
    'exact expected reply; zero tool events; project remains empty',
  );
  report.passed = true;
} catch (error) {
  report.failedPhase = phase;
  // Only our own fixed failure classifications enter the report, never backend payloads.
  report.failure =
    error?.code === 'ERR_ASSERTION'
      ? String(error.message).split('\n')[0]
      : /^[a-z0-9-]+$/.test(String(error?.message))
        ? error.message
        : 'smoke-check-failed';
  process.exitCode = 1;
} finally {
  await stop().catch(() => {
    report.passed = false;
    report.cleanupFailure = 'backend-stop-failed';
    process.exitCode = 1;
  });
  if (directory && !child) {
    const cleanup = await realpath(directory),
      temp = await realpath(tmpdir());
    assert.ok(
      resolve(cleanup)
        .toLowerCase()
        .startsWith((resolve(temp) + sep).toLowerCase()) && basename(cleanup).startsWith('agent-studio-queue-live-'),
      'refuse-cleanup-outside-own-temp-directory',
    );
    await rm(cleanup, { recursive: true, force: true });
    report.tempCleaned = true;
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
