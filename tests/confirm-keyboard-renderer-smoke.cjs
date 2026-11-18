// Synthetic confirmation only: native keyboard input records answers without performing an action.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-confirm-keyboard-'));
    try {
      await fs.mkdir(path.join(directory, 'profile'));
      await fs.writeFile(
        path.join(directory, 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
        'utf8',
      );
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConfirmDialog} from './src/ui/ConfirmDialog';
import './src/ui/studio.css';
window.answers=[];
createRoot(document.getElementById('root')).render(<ConfirmDialog options={{title:'合成删除确认', action:'删除合成记录', tone:'danger'}} onAnswer={answer=>window.answers.push(answer)}/>);
`,
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(directory, 'fixture.js'),
      });
      // Check immediately before each Electron launch; never add load to a busy machine.
      // Wait at most ~10 s: the wrapper's timeout must still fire before this loop could hang.
      let busy;
      let tries = 0;
      do {
        const before = os.cpus();
        await delay(500);
        const delta = os.cpus().map((cpu, i) => ({
          idle: cpu.times.idle - before[i].times.idle,
          total:
            Object.values(cpu.times).reduce((a, b) => a + b, 0) -
            Object.values(before[i].times).reduce((a, b) => a + b, 0),
        }));
        busy = 1 - delta.reduce((n, cpu) => n + cpu.idle, 0) / delta.reduce((n, cpu) => n + cpu.total, 0);
      } while (busy > 0.7 && ++tries < 20);
      const env = { ...process.env, PUGPORT_CONFIRM_KEYBOARD: directory };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => child.kill(), 30000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(directory);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-confirm-keyboard-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const directory = process.env.PUGPORT_CONFIRM_KEYBOARD;
  app.setPath('userData', path.join(directory, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        width: 700,
        height: 450,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      const evaluate = (value) => win.webContents.executeJavaScript(value);
      await win.loadFile(path.join(directory, 'index.html'));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (let i = 0; i < 100 && !(await evaluate('document.querySelector("dialog")?.open')); i++) await delay(20);
      assert.equal(await evaluate('document.activeElement.textContent.trim()'), '取消');
      const key = async (keyCode) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await delay(50);
      };
      await key('Enter');
      assert.deepEqual(await evaluate('window.answers'), [false]);
      await key('Tab');
      assert.equal(await evaluate('document.activeElement.textContent.trim()'), '删除合成记录');
      await key('Enter');
      assert.deepEqual(await evaluate('window.answers'), [false, true]);
      await key('Tab');
      assert.equal(await evaluate('document.activeElement.textContent.trim()'), '取消', 'Tab stays in the dialog');
      await key('Escape');
      assert.deepEqual(await evaluate('window.answers'), [false, true, false]);
      win.setSize(320, 450);
      const screenshots = path.join(root, 'reports', 'confirm-keyboard');
      await fs.mkdir(screenshots, { recursive: true });
      for (const theme of ['light', 'dark']) {
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await delay(100);
        assert.equal(
          await evaluate(`(() => {
          const dialog=document.querySelector('dialog'), bounds=dialog.getBoundingClientRect();
          return bounds.left>=0 && bounds.right<=innerWidth && dialog.scrollWidth<=dialog.clientWidth;
        })()`),
          true,
          `${theme}: confirmation fits at 320px`,
        );
        await fs.writeFile(
          path.join(screenshots, `confirm-${theme}-320.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      console.log('PASS confirmation keyboard: false,true');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
