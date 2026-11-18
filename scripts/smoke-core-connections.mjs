// One live connection-test submission per configured native executor. No fallback or resubmission.
// Run: node --import tsx scripts/smoke-core-connections.mjs --live [--runtime=pi-local --runtime=codex-native]
// Repeat --runtime to select multiple executors; omission retains the original Pi/Claude/Grok set.
// Credentials stay in the native CLIs' existing stores/environment and are never inspected or copied.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTargets } from '../src/server/discovery.ts';
import { makePiTarget } from '../src/server/adapters/pi.ts';

const supportedRuntimes = ['pi-local', 'claude-native', 'grok-native', 'codex-native'];
const selectedRuntimes = [];
for (const argument of process.argv.slice(2)) {
  if (argument === '--live') continue;
  if (!argument.startsWith('--runtime=')) throw new Error('unknown-argument');
  const runtimeId = argument.slice('--runtime='.length);
  if (!supportedRuntimes.includes(runtimeId)) throw new Error('unknown-runtime');
  if (!selectedRuntimes.includes(runtimeId)) selectedRuntimes.push(runtimeId);
}
if (!selectedRuntimes.length) selectedRuntimes.push('pi-local', 'claude-native', 'grok-native');
if (!process.argv.includes('--live')) throw new Error('explicit-live-flag-required');
if (process.platform !== 'win32') throw new Error('windows-native-required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const cleanEnvironment = () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (/^(?:COMBORUNNER|AGENT_STUDIO)_(?:ROOT|DATA_DIR|PORT|SMOKE_DIR|DESKTOP_USER_DATA_DIR)$/i.test(key))
      delete environment[key];
  return environment;
};
const reportPath = join(root, 'reports', 'comborunner-v001', 'connections.json');
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  productionBackend: 'dist/server/main.js',
  expectedAppVersion: pkg.version,
  selectedRuntimes,
  credentials: 'existing native CLI configuration; not inspected or copied',
  tests: [],
};
const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const safeError = (error) => (/^[a-z0-9-]+$/.test(String(error?.message)) ? error.message : 'smoke-check-failed');

async function save() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

async function test(runtimeId) {
  const item = {
    runtimeId,
    environment: 'native',
    at: new Date().toISOString(),
    result: 'pending',
    connectionTestSubmissions: 0,
    permissionMode: 'read-only',
    noFallback: true,
    noResubmission: true,
  };
  report.tests.push(item);
  let directory, child, base, token, owner, runId;
  let phase = 'setup';
  const request = async (path, body, expected = 200) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-agent-token': token,
        'x-pugport-owner': owner,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
    if (response.status !== expected) throw new Error(`http-${response.status}`);
    return response.json();
  };
  const cancel = async () => {
    if (runId) await request(`/api/runs/${runId}/cancel`, {}).catch(() => {});
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'agent-studio-core-connections-'));
    const dataDir = join(directory, 'data');
    await mkdir(dataDir);
    const targets = [
      ...defaultTargets().filter((target) => target.environment === 'native'),
      makePiTarget(root, dataDir),
    ].map((target) => ({ ...target, enabled: target.id === runtimeId }));
    assert.equal(targets.filter((target) => target.enabled).length, 1, 'exactly-one-native-target-required');
    const seed = new DatabaseSync(join(dataDir, 'studio.sqlite'));
    seed.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    seed.prepare('INSERT INTO config VALUES (?,?)').run('targets', JSON.stringify(targets));
    seed
      .prepare('INSERT INTO config VALUES (?,?)')
      .run(
        'settings',
        JSON.stringify({ maxConcurrentRuns: 1, unknownQuotaPolicy: 'manual-only', refreshSeconds: 600 }),
      );
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
      execArgv: [],
      windowsHide: true,
      env: {
        ...cleanEnvironment(),
        COMBORUNNER_ROOT: root,
        COMBORUNNER_DATA_DIR: dataDir,
        COMBORUNNER_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.resume();
    child.stderr.resume(); // Never retain potentially sensitive native diagnostics.
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
    const initial = await request('/api/state');
    item.appVersion = initial.app.version;
    assert.equal(initial.app.version, report.expectedAppVersion, 'production-version-mismatch');
    assert.deepEqual(
      initial.targets.filter((target) => target.enabled).map((target) => target.id),
      [runtimeId],
      'only-requested-target-enabled',
    );
    const runtime = initial.runtimes.find((candidate) => candidate.id === runtimeId);
    item.runtimeStatus = runtime?.status ?? 'missing';
    item.quotaStatus = runtime?.quota.status ?? 'unknown';
    item.accountingMode = runtime?.accounting?.mode ?? 'unknown';
    item.availableModels = runtime?.models.map((model) => model.id) ?? [];
    if (!runtime?.installed || runtime.status !== 'ready') {
      item.result = 'skipped';
      item.reason = `runtime-${item.runtimeStatus}`;
      return;
    }
    const model =
      runtimeId === 'pi-local'
        ? runtime.models.find((model) => model.id === 'openai/gpt-4.1-nano')
        : runtimeId === 'codex-native'
          ? runtime.models.find((model) => /luna/i.test(model.id))
          : runtimeId === 'claude-native'
            ? runtime.models.find((model) => /haiku/i.test(model.id))
            : (runtime.models.find((model) => /build-fast/i.test(model.id)) ??
              runtime.models.find((model) => /mini|fast/i.test(model.id)));
    if (!model) {
      item.result = 'skipped';
      item.reason = 'discovered-lightweight-model-unavailable';
      return;
    }
    item.model = model.id;
    if (runtimeId === 'codex-native') {
      const minimum = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].find((level) =>
        model.efforts.includes(level),
      );
      const endpointEffort = model.efforts.includes('low') ? 'low' : model.efforts[0];
      if (!minimum || endpointEffort !== minimum) {
        item.result = 'skipped';
        item.reason = 'connection-test-cannot-use-catalog-minimum-effort';
        return;
      }
      item.expectedEffort = minimum;
    }
    phase = 'connection';
    // Set before sending: a timeout/uncertain HTTP result must never cause a duplicate request.
    item.connectionTestSubmissions = 1;
    const started = Date.now();
    const submission = await request(`/api/targets/${runtimeId}/test`, { model: model.id }, 201);
    runId = submission.id;
    item.effort = submission.route.effort ?? null;
    if (runtimeId === 'codex-native') assert.equal(item.effort, item.expectedEffort, 'minimum-effort-mismatch');
    let finalState, run;
    while (Date.now() - started < 120000) {
      const current = await request('/api/state');
      run = current.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new Error('connection-run-missing');
      if (current.approvals.length || run.events.some((event) => event.type === 'tool')) {
        await cancel();
        throw new Error('unexpected-tool-or-approval-request');
      }
      if (run.events.some((event) => event.type === 'status' && /retrying/i.test(event.text ?? ''))) {
        item.nativeRetryObserved = true;
        await cancel();
        throw new Error('native-retry-announced-cancelled');
      }
      const snapshot = current.runtimes.find((candidate) => candidate.id === runtimeId);
      if (terminal.has(run.status) && snapshot?.lastConnectionTest && !current.refreshing) {
        finalState = current;
        break;
      }
      await pause(150);
    }
    item.elapsedMs = Date.now() - started;
    if (!finalState) {
      await cancel();
      throw new Error('connection-timeout');
    }
    item.runStatus = run.status;
    item.actualRuntimeId = run.route.runtimeId;
    item.actualModel = run.route.model;
    item.exactReply = run.output.trim() === 'STUDIO_CONNECTED';
    item.toolEvents = run.events.filter((event) => event.type === 'tool').length;
    item.actualRuns = finalState.runs.length;
    item.connectionIndicator =
      finalState.runtimes.find((candidate) => candidate.id === runtimeId)?.lastConnectionTest?.ok ?? false;
    item.failure = run.error && /^[a-z0-9-]+$/.test(run.error) ? run.error : undefined;
    const usage = (await request(`/api/usage?runtimeId=${encodeURIComponent(runtimeId)}`)).perRun.find(
      (candidate) => candidate.runId === runId,
    );
    item.usage = usage
      ? Object.fromEntries(
          [
            'accountingMode',
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'reasoningOutputTokens',
            'totalTokens',
            'estimatedCostUsd',
            'uncertain',
          ].map((key) => [key, usage[key] ?? null]),
        )
      : null;
    item.usageSources = run.events
      .filter((event) => event.type === 'usage')
      .map((event) => ({
        source: event.data?.source ?? null,
        costKind: event.data?.costKind ?? null,
        scope: event.data?.scope ?? null,
      }));
    item.billingNote =
      'Observed tokens and CLI/provider cost metadata only. Estimated cost is not an invoice or remaining balance; missing cost is unknown, not zero.';
    item.projectEmpty = (await readdir(join(dataDir, 'connection-tests'))).length === 0;
    assert.equal(item.actualRuns, 1, 'one-run-only');
    assert.equal(item.actualRuntimeId, runtimeId, 'runtime-mismatch');
    assert.equal(item.actualModel, model.id, 'model-mismatch');
    assert.equal(item.projectEmpty, true, 'isolated-project-modified');
    item.result = run.status === 'completed' && item.exactReply && item.connectionIndicator ? 'passed' : 'failed';
    if (item.result === 'failed' && !item.failure) item.failure = 'connection-did-not-pass';
  } catch (error) {
    item.result = 'failed';
    item.phase = phase;
    item.failure = safeError(error);
    await cancel();
  } finally {
    if (child && child.exitCode === null) {
      const running = child;
      const exit = new Promise((resolveExit) => running.once('exit', resolveExit));
      if (running.connected) running.send('shutdown');
      else running.kill();
      const graceful = await Promise.race([exit.then(() => true), pause(20000).then(() => false)]);
      if (!graceful) {
        item.forcedShutdown = true;
        await new Promise((resolveKill) => {
          const killer = spawn('taskkill.exe', ['/PID', String(running.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('exit', resolveKill);
          killer.once('error', resolveKill);
        });
        await Promise.race([exit, pause(5000)]);
      }
    }
    item.backendStopped = !child || child.exitCode !== null || child.signalCode !== null;
    item.backendExitCode = child?.exitCode ?? null;
    if (!item.backendStopped) {
      item.result = 'failed';
      item.cleanupFailure = 'own-backend-did-not-exit';
    }
    if (directory && item.backendStopped) {
      const cleanup = await realpath(directory),
        temp = await realpath(tmpdir());
      assert.ok(
        resolve(cleanup)
          .toLowerCase()
          .startsWith((resolve(temp) + sep).toLowerCase()) &&
          basename(cleanup).startsWith('agent-studio-core-connections-'),
        'refuse-cleanup-outside-own-temp-directory',
      );
      await rm(cleanup, { recursive: true, force: true });
      item.tempCleaned = true;
    }
    await save();
    console.log(JSON.stringify(item));
  }
}

for (const runtimeId of selectedRuntimes) await test(runtimeId);
report.completedAt = new Date().toISOString();
report.summary = Object.fromEntries(
  ['passed', 'failed', 'skipped'].map((result) => [
    result,
    report.tests.filter((test) => test.result === result).length,
  ]),
);
await save();
if (report.summary.failed) process.exitCode = 1;
