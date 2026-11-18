// Real Electron windows/preload/IPC and real owned Node children. Native dialog answers are controlled.
// All servers, files and profiles are temporary fixtures; no account or model is contacted.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, fork } = require('node:child_process');
const { electronArgs } = require('../tests/helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const reportDirectory = path.join(root, 'reports', 'desktop-core');
const reportPath = path.join(reportDirectory, 'desktop-smoke.json');
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function until(predicate, description) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await pause(20);
  }
  throw new Error('Timed out: ' + description);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (!process.versions.electron) {
  void (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-desktop-smoke-'));
    let child;
    try {
      const { build } = require('esbuild');
      const identity = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      for (const name of ['shell', 'backend', 'preload'])
        await build({
          entryPoints: [path.join(root, 'src', 'electron', name + '.ts')],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          outfile: path.join(directory, name + '.cjs'),
        });
      await fs.writeFile(
        path.join(directory, 'backend-fixture.cjs'),
        `
        const {spawn}=require('node:child_process');const fs=require('node:fs');
        const [dataDir,mode]=process.argv.slice(2);let child;
        if(mode==='hung'){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:'ignore'});fs.writeFileSync(require('node:path').join(dataDir,'descendant.json'),JSON.stringify({pid:child.pid}));}
        process.on('message',message=>{if(message.type==='quit-inspection')process.send({type:'quit-inspection',requestId:message.requestId,active:1,queued:501,waitingApproval:1,scheduled:501});if(message.type==='shutdown'&&mode!=='hung')process.send({type:'shutdown-complete'},()=>process.exit(0));});
        process.send({type:'ready',name:${JSON.stringify(identity.productName)},version:${JSON.stringify(identity.version)},port:4317,dataDir});setInterval(()=>{},1000);
      `,
      );
      const env = { ...process.env, COMBORUNNER_DESKTOP_SMOKE_PROFILE: directory };
      delete env.ELECTRON_RUN_AS_NODE;
      child = spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: 'inherit',
      });
      let timer;
      const code = await Promise.race([
        new Promise((done, reject) => {
          child.once('error', reject);
          child.once('exit', (result) => done(result ?? 1));
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Desktop smoke exceeded 60 seconds')), 60000);
        }),
      ]).finally(() => clearTimeout(timer));
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      process.exitCode = code || (report.passed ? 0 : 1);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          const helper = spawn(
            path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, shell: false, stdio: 'ignore' },
          );
          try {
            await until(() => helper.exitCode !== null || helper.signalCode !== null, 'smoke process tree cleanup');
          } finally {
            if (helper.exitCode === null && helper.signalCode === null) helper.kill();
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        await until(() => !alive(child.pid), 'smoke Electron exit');
      }
      const canonical = await fs.realpath(directory),
        temporary = await fs.realpath(os.tmpdir());
      assert.equal(path.dirname(canonical).toLowerCase(), temporary.toLowerCase());
      assert.ok(path.basename(canonical).startsWith('comborunner-desktop-smoke-'));
      await fs.rm(canonical, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      try {
        const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
        report.temporaryProfileRemoved = true;
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
      } catch {}
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const http = require('node:http');
  const directory = process.env.COMBORUNNER_DESKTOP_SMOKE_PROFILE;
  assert.ok(directory && path.basename(directory).startsWith('comborunner-desktop-smoke-'));
  app.setPath('userData', path.join(directory, 'profile'));
  app.on('window-all-closed', () => {});
  const { OwnedBackend, terminateOwnedBackend } = require(path.join(directory, 'backend.cjs'));
  const { createDesktopShell } = require(path.join(directory, 'shell.cjs'));
  let desktop, backend, hung, sentinel, server, foreign;
  const sockets = new Set(),
    children = [],
    checks = [],
    errors = [];
  const report = {
    at: new Date().toISOString(),
    realModelRequests: 0,
    realElectron: true,
    nativeDialogChoices: 'mocked',
    passed: false,
    checks,
    errors,
  };
  function makeBackend(mode) {
    return new OwnedBackend({
      root,
      dataDir: directory,
      port: 4317,
      startupMs: 5000,
      shutdownMs: mode === 'hung' ? 100 : 2000,
      killMs: 7000,
      launch: () => {
        const child = fork(path.join(directory, 'backend-fixture.cjs'), [directory, mode], {
          execPath: process.execPath,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        children.push(child);
        return child;
      },
    });
  }
  void app
    .whenReady()
    .then(async () => {
      await fs.mkdir(reportDirectory, { recursive: true });
      try {
        server = http.createServer((request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(
            request.url === '/frame'
              ? '<html><body>Isolated child frame</body></html>'
              : '<html><body>Isolated PugPort desktop fixture<iframe src="/frame"></iframe></body></html>',
          );
        });
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        await new Promise((done) => server.listen(0, '127.0.0.1', done));
        const origin = `http://127.0.0.1:${server.address().port}`;
        backend = makeBackend('cooperative');
        await backend.start();
        let nativeCalls = 0,
          dialogResolve,
          dialogMode = 'pending',
          confirmed = 0,
          exitRequested = false;
        desktop = createDesktopShell({
          origin,
          preload: path.join(directory, 'preload.cjs'),
          backend: { inspect: () => backend.inspect(), stop: () => backend.stop() },
          windowOptions: { show: false, x: -10000, y: -10000, webPreferences: { backgroundThrottling: false } },
          confirm: async (state) => {
            assert.equal(state.scheduled, 501);
            confirmed++;
            return confirmed > 1;
          },
          exit: () => {
            exitRequested = true;
          },
          error: (error) => {
            errors.push(String(error));
          },
          pick: async () => {
            nativeCalls++;
            if (dialogMode === 'cancel') return { canceled: true, filePaths: [] };
            if (dialogMode === 'error') throw new Error('fixture-dialog-error');
            if (dialogMode === 'selected') return { canceled: false, filePaths: [directory] };
            return new Promise((done) => {
              dialogResolve = done;
            });
          },
        });
        await desktop.window.loadURL(origin);
        const evaluate = (source) => desktop.window.webContents.executeJavaScript(source, true);
        assert.deepEqual(
          await evaluate(
            '({keys:Object.keys(window.comboRunnerDesktop),require:typeof require,process:typeof process,frame:typeof document.querySelector("iframe").contentWindow.comboRunnerDesktop})',
          ),
          { keys: ['pickDirectory'], require: 'undefined', process: 'undefined', frame: 'undefined' },
        );
        checks.push('sandbox preload exposes only pickDirectory on the top-level application document');
        await evaluate(
          'window.fixturePicks=Promise.all([comboRunnerDesktop.pickDirectory(),comboRunnerDesktop.pickDirectory()]);true',
        );
        await until(() => nativeCalls === 1 && dialogResolve, 'one native directory dialog');
        dialogResolve({ canceled: false, filePaths: [directory] });
        assert.deepEqual(await evaluate('window.fixturePicks'), [directory, directory]);
        dialogMode = 'cancel';
        assert.equal(await evaluate('comboRunnerDesktop.pickDirectory()'), null);
        dialogMode = 'error';
        assert.match(
          await evaluate('comboRunnerDesktop.pickDirectory().catch(error=>error.message)'),
          /fixture-dialog-error/,
        );
        dialogMode = 'selected';
        assert.equal(await evaluate('comboRunnerDesktop.pickDirectory()'), directory);
        checks.push('real IPC coalesces concurrent picks, cancellation returns null, and dialog failure is retryable');

        foreign = new BrowserWindow({
          show: false,
          webPreferences: {
            preload: path.join(directory, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            additionalArguments: [`--combo-runner-origin=${origin}`],
          },
        });
        await foreign.loadURL(origin);
        const beforeForeign = nativeCalls;
        assert.match(
          await foreign.webContents.executeJavaScript('comboRunnerDesktop.pickDirectory().catch(error=>error.message)'),
          /主窗口/,
        );
        assert.equal(nativeCalls, beforeForeign);
        await foreign.loadURL('data:text/html,foreign');
        assert.equal(await foreign.webContents.executeJavaScript('typeof window.comboRunnerDesktop'), 'undefined');
        foreign.destroy();
        foreign = undefined;
        checks.push('other windows cannot invoke directory selection; a foreign origin receives no bridge');

        desktop.show();
        assert.equal(desktop.window.isVisible(), true);
        const contents = desktop.window.webContents.id;
        desktop.window.close();
        await until(() => !desktop.window.isVisible(), 'close hides window');
        assert.equal(desktop.window.isDestroyed(), false);
        assert.equal(desktop.window.webContents.id, contents);
        assert.equal((await backend.inspect()).scheduled, 501);
        desktop.tray.emit('click');
        assert.equal(desktop.window.isVisible(), true);
        assert.equal(desktop.window.webContents.id, contents);
        checks.push(
          'real close event hides without destroying the document or backend; tray restores that same document',
        );
        app.quit();
        await until(() => confirmed === 1, 'quit cancellation');
        await pause(50);
        assert.equal(exitRequested, false);
        assert.equal(backend.state.phase, 'ready');
        assert.equal(alive(backend.pid), true);
        checks.push(
          'real app before-quit with cancel preserves running, queued, approval and 501 future-scheduled work',
        );
        const ownedPid = backend.pid;
        assert.equal(await desktop.requestQuit(), true);
        assert.equal(exitRequested, true);
        assert.equal(alive(ownedPid), false);
        assert.deepEqual(backend.state, { phase: 'stopped' });
        desktop.window.close();
        await until(() => desktop.window.isDestroyed(), 'confirmed window close');
        desktop.dispose();
        desktop = undefined;
        checks.push(
          'confirmed quit receives shutdown-complete and waits for owned backend exit before allowing window close',
        );

        sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          stdio: 'ignore',
        });
        hung = makeBackend('hung');
        await hung.start();
        const descendant = JSON.parse(await fs.readFile(path.join(directory, 'descendant.json'), 'utf8')).pid;
        assert.equal(alive(descendant), true);
        await hung.stop();
        await until(() => !alive(descendant), 'owned descendant termination');
        assert.equal(alive(sentinel.pid), true);
        assert.match(hung.state.message, /检查任务结果/);
        checks.push(
          'hung owned backend and its descendant are terminated within bounds; unrelated sentinel process survives',
        );
        report.passed = true;
      } catch (error) {
        errors.push(error.stack || String(error));
      } finally {
        foreign?.destroy();
        if (desktop) {
          desktop.dispose();
          if (!desktop.window.isDestroyed()) desktop.window.destroy();
        }
        for (const processOwner of [backend, hung])
          if (processOwner) await processOwner.stop().catch((error) => errors.push('cleanup: ' + error));
        for (const child of children)
          if (child.pid && child.exitCode === null && child.signalCode === null)
            await terminateOwnedBackend(child).catch((error) => errors.push('cleanup: ' + error));
        if (sentinel?.pid && sentinel.exitCode === null && sentinel.signalCode === null) {
          sentinel.kill();
          await until(() => !alive(sentinel.pid), 'sentinel cleanup').catch((error) => errors.push(String(error)));
        }
        for (const socket of sockets) socket.destroy();
        if (server) await new Promise((done) => server.close(done));
        if (errors.length) report.passed = false;
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        app.exit(report.passed ? 0 : 1);
      }
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}
