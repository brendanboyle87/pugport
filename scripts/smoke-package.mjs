// Launch the actual Windows package with an empty, isolated database and no enabled executors.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseSmokePort, smokeEnvironment, smokeTargets } from './smoke-package-isolation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.productName, 'PugPort');
const executable = join(root, 'release', `${pkg.productName}-win32-x64`, `${pkg.productName}.exe`);
const reportDir = join(root, 'reports', `desktop-${pkg.version}`);
const tempPrefix = 'comborunner-package-smoke-';
let port;
const checks = [];
const startedAt = new Date().toISOString();
let directory, dataDir, child, completion, exitResult;
let output = '',
  error,
  cleanupError;
let cleanup = { attempted: false, graceful: false, forced: false, removedTemporaryDirectory: false };

function withTimeout(promise, milliseconds, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function requireFreePort() {
  if (port !== undefined) await chooseSmokePort(String(port));
}

async function runCleanupCommand(command, args) {
  const helper = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
  await withTimeout(
    new Promise((done, reject) => {
      helper.once('error', reject);
      helper.once('exit', (code) => (code === 0 ? done() : reject(new Error(`Cleanup helper exited ${code}`))));
    }),
    10000,
    'Cleanup helper timed out',
  ).finally(() => {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
  });
}

async function stopOwnedApplication() {
  if (!child?.pid || exitResult || child.exitCode !== null || child.signalCode !== null) return;
  cleanup.attempted = true;
  cleanup.forced = true;
  // Closing a window now hides it to the tray. Successful smoke runs request quit
  // inside Electron; only a failed/timed-out launch reaches this owned-PID cleanup.
  const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  await runCleanupCommand(taskkill, ['/PID', String(child.pid), '/T', '/F']);
  await withTimeout(completion, 10000, 'Owned application process did not exit');
}

await mkdir(reportDir, { recursive: true });
try {
  assert.equal(process.platform, 'win32', 'This smoke script validates the Windows release');
  assert.ok((await stat(executable)).isFile(), 'Packaged executable must exist before running this script');
  for (const excluded of ['experiments', 'node_modules/@deepseek-ai/dsh', 'scripts/dsh-bridge.mjs', 'Start-DSH.cmd']) {
    await assert.rejects(stat(join(dirname(executable), 'resources', 'app', excluded)), { code: 'ENOENT' });
  }
  checks.push('desktop package contains no DSH runtime, bridge, launcher or experimental archive');
  port = await chooseSmokePort(process.env.COMBORUNNER_SMOKE_PORT);
  checks.push(`isolated port ${port} was free before launch`);

  directory = await mkdtemp(join(tmpdir(), tempPrefix));
  dataDir = join(directory, 'data');
  const smokeDir = join(directory, 'smoke-output');
  const environment = smokeEnvironment(directory, port);
  for (const key of [
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'COMBORUNNER_DATA_DIR',
    'COMBORUNNER_DESKTOP_USER_DATA_DIR',
    'COMBORUNNER_SMOKE_DIR',
  ])
    await mkdir(environment[key], { recursive: true });
  const targets = smokeTargets();
  const seed = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  try {
    seed.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    seed.prepare('INSERT INTO config VALUES (?,?)').run('targets', JSON.stringify(targets));
  } finally {
    seed.close();
  }
  checks.push('isolated SQLite seeded with all executors disabled, including Cursor, Pi and DSH');
  checks.push('home, app data, memory, extensions and models isolated; no user credentials or CLI PATH inherited');
  child = spawn(executable, [], {
    cwd: dirname(executable),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-24000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  completion = new Promise((done) => {
    child.once('error', (spawnError) => {
      exitResult = { spawnError: String(spawnError) };
      done(exitResult);
    });
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      done(exitResult);
    });
  });
  const result = await withTimeout(
    completion,
    90000,
    'Packaged application did not automatically exit within 90 seconds',
  );
  assert.equal(result.spawnError, undefined);
  assert.equal(result.code, 0, `Packaged application failed: ${JSON.stringify(result)}\n${output}`);
  assert.equal(result.signal, null);
  cleanup.graceful = true;
  checks.push(`actual ${pkg.productName}.exe automatically quit with code 0`);

  const desktop = JSON.parse(await readFile(join(smokeDir, 'desktop-smoke.json'), 'utf8'));
  assert.ok(Date.parse(desktop.at) >= Date.parse(startedAt), 'Smoke result must belong to this launch');
  assert.equal(desktop.packaged, true);
  assert.equal(desktop.hidden, true, 'Smoke window must never be shown');
  assert.equal(desktop.desktopIntegration, false, 'Smoke must not register shortcuts, a tray or launch at login');
  assert.equal(desktop.appVersion, pkg.version);
  assert.ok(desktop.title.includes(pkg.productName), 'Rendered title must use the current product name');
  assert.equal(desktop.hasWorkspace, true);
  assert.ok(desktop.width >= 1000 && desktop.height >= 700);
  assert.equal(resolve(desktop.dataDir), resolve(dataDir), 'Application must use the isolated database');
  assert.equal(resolve(desktop.root), resolve(dirname(executable), 'resources', 'app'));
  assert.deepEqual(desktop.runtimes, [], 'Disabled targets must not be discovered or invoked');
  checks.push(
    `packaged ${pkg.version} workspace rendered from the release with isolated data and no runtime discovery`,
  );

  const screenshot = await readFile(join(smokeDir, 'desktop.png'));
  assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(screenshot.length > 1000, 'Screenshot must contain a rendered image');
  const database = new DatabaseSync(join(dataDir, 'studio.sqlite'), { readOnly: true });
  try {
    const persistedTargets = JSON.parse(database.prepare("SELECT value FROM config WHERE key='targets'").get().value);
    assert.ok(
      persistedTargets.length >= targets.length && persistedTargets.every((target) => target.enabled === false),
    );
    assert.ok(
      persistedTargets.some((target) => target.id === 'pi-local') &&
        persistedTargets.some((target) => target.id === 'dsh-local') &&
        persistedTargets.some((target) => target.id === 'cursor-native'),
    );
    assert.equal(database.prepare('SELECT count(*) AS count FROM runs').get().count, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM usage_runs').get().count, 0);
  } finally {
    database.close();
  }
  checks.push('all persisted executors stayed disabled; zero model runs and usage records');
  await requireFreePort();
  checks.push(`owned backend released port ${port} on exit`);
  await copyFile(join(smokeDir, 'desktop-smoke.json'), join(reportDir, 'desktop-smoke.json'));
  await copyFile(join(smokeDir, 'desktop.png'), join(reportDir, 'desktop.png'));
} catch (failure) {
  error = failure instanceof Error ? failure.stack || failure.message : String(failure);
} finally {
  try {
    await stopOwnedApplication();
    if (directory) {
      // Retain the directory if shutdown is uncertain rather than deleting files under a live backend.
      await requireFreePort();
      const taskTempPath = await realpath(directory);
      const tempRoot = await realpath(tmpdir());
      assert.ok(
        isAbsolute(taskTempPath) &&
          taskTempPath.startsWith(tempRoot + sep) &&
          basename(taskTempPath).startsWith(tempPrefix),
      );
      await rm(taskTempPath, { recursive: true, force: true });
      cleanup.removedTemporaryDirectory = true;
    }
  } catch (failure) {
    cleanupError = String(failure);
    cleanup.retainedDirectory = directory;
  }
  const report = {
    at: new Date().toISOString(),
    startedAt,
    productName: pkg.productName,
    expectedVersion: pkg.version,
    passed: !error && !cleanupError,
    executable,
    port,
    checks,
    exit: exitResult,
    cleanup,
    error,
    cleanupError,
  };
  await writeFile(join(reportDir, 'process-output.log'), output);
  await writeFile(join(reportDir, 'validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
