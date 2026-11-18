const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-server-enroll-smoke-'));
    await fs.mkdir(path.join(fixture, 'profile'));
    await fs.writeFile(
      path.join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await fs.copyFile(path.join(root, 'src/ui/studio.css'), path.join(fixture, 'style.css'));
    await require('esbuild').build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ServerEnroll } from './src/ui/ServerEnroll';
      import { ConfirmDialog } from './src/ui/ConfirmDialog';
      const server={name:'fixture-server',ssh:'fixture-box',purpose:'Synthetic development server'};
      function Fixture(){ const [view,setView]=useState('card'); const [purge,setPurge]=useState(false); return <>
        {view==='card' && <ServerEnroll api={async()=>{throw Error('No real requests')}} server={server} onClose={()=>setView('confirm')} />}
        {view==='confirm' && <ConfirmDialog options={{title:'断开服务器？',action:'断开',tone:'danger'}} onAnswer={()=>{}}><label><input type="checkbox" checked={purge} onChange={e=>setPurge(e.currentTarget.checked)}/> 同时删除服务器上的 PugPort</label></ConfirmDialog>}
      </> };
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `,
      },
      bundle: true,
      platform: 'browser',
      outfile: path.join(fixture, 'fixture.js'),
    });
    const env = { ...process.env, PUGPORT_SERVER_ENROLL_FIXTURE: fixture };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => child.kill(), 40000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_SERVER_ENROLL_FIXTURE;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const out = path.join(root, 'reports/server-enroll');
      await fs.mkdir(out, { recursive: true });
      const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 760,
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
      await win.loadFile(path.join(fixture, 'index.html'));
      const run = (source) => win.webContents.executeJavaScript(source);
      const frame = () => run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const settle = () =>
        run(
          'Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))',
        );
      await frame();
      assert.equal(await run('!!document.querySelector(".server-enroll-dialog[open]")'), true);
      assert.equal(
        await run('document.querySelector(".server-enroll-dialog").innerText.includes("Synthetic development server")'),
        true,
      );
      for (const [theme, width, file] of [
        ['light', 1000, 'light.png'],
        ['dark', 1000, 'dark.png'],
        ['dark', 400, 'narrow.png'],
      ]) {
        win.setSize(width, 760);
        await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await frame();
        await settle();
        await fs.writeFile(
          path.join(out, file),
          (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
        );
      }
      await run('document.querySelector(".server-enroll-dialog button").click()');
      await frame();
      assert.equal(await run('!!document.querySelector(".confirm-dialog[open] input[type=checkbox]")'), true);
      await settle();
      await fs.writeFile(
        path.join(out, 'disconnect.png'),
        (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
      console.log('Hidden server enrollment renderer passed');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
