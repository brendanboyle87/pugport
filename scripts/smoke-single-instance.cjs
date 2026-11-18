// Windows integration test of the real electron . entry point, using isolated data.
// CDP is enabled only on these owned test processes; no product test IPC is added.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('node:net');
const { tmpdir, homedir } = require('node:os');
const path = require('node:path');
const { electronArgs } = require('../tests/helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, 'reports', 'comborunner-v001', 'single-instance');
const tempPrefix = 'comborunner-single-instance-';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check, label, limit = 15000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function processes() {
  const helper = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  helper.stdout.on('data', (data) => {
    output += data;
  });
  let timer;
  try {
    await Promise.race([
      new Promise((done, reject) => {
        helper.once('error', reject);
        helper.once('exit', (code) => (code === 0 ? done() : reject(new Error('Process inspection failed'))));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Process inspection timed out')), 10000);
      }),
    ]);
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
  }
}
async function closeOwnedWindow(child) {
  assert.ok(child.pid && child.exitCode === null && child.signalCode === null);
  const command = `Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeWindow {
  public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int limit);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static int Close(uint pid) {
    int count=0;
    EnumWindows((window, parameter) => { uint owner; GetWindowThreadProcessId(window,out owner); var title=new StringBuilder(512); GetWindowText(window,title,512);
      if(owner==pid && title.ToString().StartsWith("PugPort")) { if(PostMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero)) count++; } return true;
    },IntPtr.Zero); return count;
  }
}
'@
if ([SmokeWindow]::Close(${child.pid}) -ne 1) { exit 1 }`;
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    await until(() => helper.exitCode !== null || helper.signalCode !== null, 'owned window close event');
    assert.equal(helper.exitCode, 0, 'Exactly one owned PugPort window must accept WM_CLOSE');
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
  }
}
async function connect(url) {
  const socket = new WebSocket(url),
    pending = new Map();
  let sequence = 0;
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(event.data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    reply.error ? request.reject(new Error(reply.error.message)) : request.done(reply.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP closed'));
    }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    send: (method, params = {}) =>
      new Promise((done, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('CDP timed out: ' + method));
          }, 5000);
        pending.set(id, { done, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
}

void (async () => {
  const report = {
    at: new Date().toISOString(),
    realElectron: true,
    realEntryPoint: 'electron .',
    realModelRequests: 0,
    passed: false,
    checks: [],
    cleanup: {},
  };
  let directory,
    first,
    second,
    restarted,
    cdp,
    descendants = [];
  const launch = (environment, debugPort) => {
    const child = spawn(
      require('electron'),
      electronArgs('.', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`),
      { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    child.once('error', (error) => {
      child.spawnFailure = String(error);
    });
    return child;
  };
  try {
    assert.equal(process.platform, 'win32', 'This integration smoke validates Windows');
    directory = await fs.mkdtemp(path.join(tmpdir(), tempPrefix));
    const dataDir = path.join(directory, 'data'),
      profile = path.join(directory, 'profile');
    await fs.mkdir(dataDir);
    await fs.mkdir(profile);
    const targets = [
      ['codex-native', 'codex', 'native'],
      ['claude-native', 'claude', 'native'],
      ['grok-native', 'grok', 'native'],
      ['codex-wsl', 'codex', 'wsl'],
      ['pi-local', 'pi', 'native'],
      ['dsh-local', 'dsh', 'native'],
    ].map(([id, provider, environment]) => ({
      id,
      provider,
      environment,
      label: id,
      command: 'disabled',
      commandDiscovery: 'fixed',
      enabled: false,
    }));
    const seed = new DatabaseSync(path.join(dataDir, 'studio.sqlite'));
    try {
      seed.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      seed.prepare('INSERT INTO config VALUES (?,?)').run('targets', JSON.stringify(targets));
    } finally {
      seed.close();
    }
    const port = await freePort(),
      debugPort = await freePort(),
      environment = { ...process.env };
    for (const key of Object.keys(environment))
      if (
        /^(?:(?:COMBORUNNER|AGENT_STUDIO)_(?:ROOT|DATA_DIR|PORT|SMOKE_DIR|DESKTOP_USER_DATA_DIR)|ELECTRON_RUN_AS_NODE)$/i.test(
          key,
        )
      )
        delete environment[key];
    Object.assign(environment, {
      COMBORUNNER_DATA_DIR: dataDir,
      COMBORUNNER_DESKTOP_USER_DATA_DIR: profile,
      COMBORUNNER_PORT: String(port),
    });
    const origin = `http://127.0.0.1:${port}`;
    first = launch(environment, debugPort);
    report.firstPid = first.pid;
    let state, target;
    await until(
      async () => {
        if (first.spawnFailure || first.exitCode !== null || first.signalCode !== null)
          throw new Error('First Electron exited before ready: ' + (first.spawnFailure || first.exitCode));
        try {
          const { token } = JSON.parse(
            await fs.readFile(path.join(homedir(), '.pugport', `session-${port}.json`), 'utf8'),
          );
          const response = await fetch(origin + '/api/state', {
            headers: { 'x-agent-token': token },
            signal: AbortSignal.timeout(500),
          });
          if (!response.ok) return false;
          state = await response.json();
          return !state.refreshing;
        } catch {
          return false;
        }
      },
      'first owned backend ready',
      30000,
    );
    assert.equal(path.resolve(state.app.dataDir), dataDir);
    assert.ok(state.targets.every((target) => !target.enabled));
    assert.deepEqual(state.runtimes, []);
    const backendPid = Number(await fs.readFile(path.join(dataDir, 'server.lock'), 'utf8'));
    report.backendPid = backendPid;
    const initial = await processes();
    assert.equal(initial.find((item) => item.ProcessId === backendPid)?.ParentProcessId, first.pid);
    report.checks.push('real entry point starts an owned backend with isolated data and every executor disabled');
    await until(async () => {
      try {
        target = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json())).find(
          (item) => item.type === 'page' && item.url.startsWith(origin),
        );
        return !!target;
      } catch {
        return false;
      }
    }, 'application CDP target');
    cdp = await connect(target.webSocketDebuggerUrl);
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await until(async () => (await evaluate('document.visibilityState')) === 'visible', 'first window visible');
    const marker = 'same-document-' + Date.now();
    await evaluate(`window.__singleInstanceSmoke=${JSON.stringify(marker)};true`);
    await closeOwnedWindow(first);
    await until(async () => (await evaluate('document.visibilityState')) === 'hidden', 'close hides the window');
    assert.equal(alive(backendPid), true);
    report.checks.push(
      'native WM_CLOSE triggers the real close-to-tray path while its document and backend remain alive',
    );

    second = launch(environment, await freePort());
    report.secondPid = second.pid;
    await until(
      () => second.spawnFailure || second.exitCode !== null || second.signalCode !== null,
      'second instance exits',
    );
    assert.equal(second.spawnFailure, undefined);
    assert.equal(second.exitCode, 0);
    await until(
      async () => (await evaluate('document.visibilityState')) === 'visible',
      'first window restored by second-instance event',
    );
    assert.equal(await evaluate('window.__singleInstanceSmoke'), marker);
    assert.equal(Number(await fs.readFile(path.join(dataDir, 'server.lock'), 'utf8')), backendPid);
    assert.equal(alive(backendPid), true);
    assert.equal((await processes()).find((item) => item.ProcessId === backendPid)?.ParentProcessId, first.pid);
    report.checks.push(
      'second real entry exits with code 0, restores the same document, and preserves the original owned backend PID',
    );

    const snapshot = await processes(),
      owned = new Set([first.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const item of snapshot)
        if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) {
          owned.add(item.ProcessId);
          grew = true;
        }
    }
    descendants = snapshot.filter((item) => owned.has(item.ProcessId) && item.ProcessId !== first.pid);
    cdp.close();
    cdp = undefined;
    // Kill only our Electron main process. Windows may end its child before graceful cleanup.
    first.kill();
    await until(
      () => !alive(backendPid) && (first.exitCode !== null || first.signalCode !== null),
      'backend and its terminated owner exit',
    );
    const lockRemoved = async () => {
      try {
        await fs.stat(path.join(dataDir, 'server.lock'));
        return false;
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
      }
    };
    report.cleanup.ownerTerminated = true;
    report.cleanup.backendExitedAfterOwnerDeath = true;
    report.cleanup.lockWasRemovedAfterForcedOwnerExit = await lockRemoved();
    report.checks.push(
      'terminating only the owned Electron parent leaves no live backend; this does not claim graceful child cleanup',
    );

    const restartSmoke = path.join(directory, 'restart-smoke');
    restarted = launch({ ...environment, COMBORUNNER_SMOKE_DIR: restartSmoke }, await freePort());
    report.restartedPid = restarted.pid;
    await until(
      () => restarted.spawnFailure || restarted.exitCode !== null || restarted.signalCode !== null,
      'same-data restart and automatic clean exit',
      30000,
    );
    assert.equal(restarted.spawnFailure, undefined);
    assert.equal(restarted.exitCode, 0);
    const restartResult = JSON.parse(await fs.readFile(path.join(restartSmoke, 'desktop-smoke.json'), 'utf8'));
    assert.equal(path.resolve(restartResult.dataDir), dataDir);
    assert.equal(restartResult.hasWorkspace, true);
    assert.deepEqual(restartResult.runtimes, []);
    assert.equal(await lockRemoved(), true);
    report.cleanup.sameDataRestartSucceeded = true;
    report.cleanup.lockRemovedAfterNormalRestartExit = true;
    report.checks.push(
      'the same data and profile reopen successfully after owner death, handle any stale lock, and remove the lock on normal exit',
    );
    const database = new DatabaseSync(path.join(dataDir, 'studio.sqlite'), { readOnly: true });
    try {
      for (const table of ['runs', 'usage_runs'])
        assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
    } finally {
      database.close();
    }
    report.checks.push('isolated database records zero model runs and zero usage runs');
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
  } finally {
    cdp?.close();
    try {
      // Snapshot descendants before terminating a still-live owned root after a failed assertion.
      const snapshot = await processes(),
        owned = new Set(
          [first, second, restarted]
            .filter((child) => child?.pid && child.exitCode === null && child.signalCode === null)
            .map((child) => child.pid),
        );
      for (let grew = true; grew;) {
        grew = false;
        for (const item of snapshot)
          if (owned.has(item.ParentProcessId) && !owned.has(item.ProcessId)) {
            owned.add(item.ProcessId);
            grew = true;
          }
      }
      descendants.push(...snapshot.filter((item) => owned.has(item.ProcessId)));
      for (const child of [first, second, restarted])
        if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
      await pause(500);
      const current = await processes();
      for (const item of descendants)
        if (
          current.some(
            (candidate) => candidate.ProcessId === item.ProcessId && candidate.CreationDate === item.CreationDate,
          ) &&
          alive(item.ProcessId)
        )
          process.kill(item.ProcessId);
      await until(() => descendants.every((item) => !alive(item.ProcessId)), 'owned process cleanup');
      if (directory) {
        const canonical = await fs.realpath(directory),
          temporary = await fs.realpath(tmpdir());
        assert.equal(path.dirname(canonical).toLowerCase(), temporary.toLowerCase());
        assert.ok(path.basename(canonical).startsWith(tempPrefix));
        await fs.rm(canonical, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        report.cleanup.temporaryProfileRemoved = true;
      }
    } catch (error) {
      report.cleanup.error = String(error);
      report.cleanup.retainedDirectory = directory;
      report.passed = false;
    }
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, 'validation.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
