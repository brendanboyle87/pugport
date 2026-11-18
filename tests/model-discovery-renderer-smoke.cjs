// Synthetic, hidden/offscreen renderer only. No app backend, keys or provider requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    assert.ok(require('node:fs').existsSync(path.join(root, 'src/server/platform/under-test.ts')));
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-model-picker-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
        'utf8',
      );
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8'),
        'utf8',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceExecutionFields} from './src/ui/Workspace';
import {startInterfaceLanguage} from './src/ui/i18n';
localStorage.setItem('comborunner.locale','en');
const target={id:'api-synthetic',provider:'pi',gateway:'api',apiProvider:'deepseek',label:'DeepSeek',enabled:true};
const models=[{id:'deepseek/catalog',label:'DeepSeek V4 Pro',efforts:['low','high'],price:{input:1.32,output:3.96}},{id:'deepseek/new-release',label:'deepseek-new-release-with-a-long-name',efforts:[],discovered:true}];
const app=createRoot(document.getElementById('root'));
window.opens=0;window.picks=[];
window.renderFixture=()=>app.render(<main style={{padding:16}}><h2>Model discovery</h2><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><WorkspaceExecutionFields state={{targets:[target],runtimes:[{id:target.id,models}]}} policy="api-only" selection={target.id} model={window.model??'deepseek/new-release'} onSelection={()=>{}} onModel={value=>window.picks.push(value)} onModelsOpen={()=>window.opens++}/></div></main>);
window.renderFixture();
startInterfaceLanguage();`,
          resolveDir: root,
          sourcefile: 'model-picker-fixture.tsx',
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(fixture, 'fixture.js'),
        logLevel: 'silent',
      });
      const { execFileSync, spawn } = require('node:child_process');
      if (process.platform === 'win32') {
        for (;;) {
          const cpu = Number(
            execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
              ],
              { encoding: 'utf8', windowsHide: true },
            ).trim(),
          );
          console.log(`Before hidden Electron: CPU ${cpu}%`);
          if (Number.isFinite(cpu) && cpu <= 70) break;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
      const env = { ...process.env, PUGPORT_MODEL_PICKER_FIXTURE: fixture, PUGPORT_UNDER_TEST: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), electronArgs(__filename), { env, windowsHide: true, stdio: 'inherit' });
      const timer = setTimeout(() => child.kill(), 45000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-model-picker-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_MODEL_PICKER_FIXTURE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-model-picker-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    let win;
    try {
      const output = path.join(root, 'reports/model-discovery');
      await fs.mkdir(output, { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 480,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      const evaluate = (source) => win.webContents.executeJavaScript(source);
      const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,100))');
      await settle();
      for (const theme of ['light', 'dark'])
        for (const width of [900, 320]) {
          win.setContentSize(width, 480);
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};window.renderFixture()`);
          await settle();
          await evaluate(
            `(()=>{const buttons=[...document.querySelectorAll('.chip-value')];const button=buttons[1];if(button.getAttribute('aria-expanded')!=='true')button.click()})()`,
          );
          await settle();
          const result = await evaluate(
            `(()=>{const menu=document.querySelector('[role=listbox]');const box=menu.getBoundingClientRect();return {text:menu.innerText,left:box.left,right:box.right,width:innerWidth,title:menu.querySelector('[title]')?.title,visible:document.visibilityState,opens:window.opens}})()`,
          );
          assert.match(result.text, /New/);
          assert.match(result.text, /Price unknown/);
          assert.match(result.title, /Smart routing skips it, so pick it yourself/);
          assert.ok(result.left >= 0 && result.right <= result.width, JSON.stringify(result));
          assert.equal(win.isVisible(), false);
          await fs.writeFile(
            path.join(output, `${theme}-${width}.png`),
            (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
          );
          console.log(`PASS hidden picker ${theme} ${width}px`);
        }
      await evaluate(`window.model='';window.renderFixture()`);
      await settle();
      await evaluate(`document.querySelectorAll('[role=option]')[2].click()`);
      assert.deepEqual(await evaluate('window.picks'), ['deepseek/new-release']);
      console.log('PASS exact manual picker ID');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    } finally {
      win?.destroy();
    }
  });
}
