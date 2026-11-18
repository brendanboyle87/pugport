// Real settings component in a hidden renderer. API replies and projects are synthetic; network is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-hindsight-ui-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: '@import "./src/ui/studio.css"; @import "./src/ui/settings.css";',
          resolveDir: root,
          loader: 'css',
        },
        bundle: true,
        outfile: path.join(fixture, 'style.css'),
      });
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HindsightSettingsPanel} from './src/ui/HindsightSettings';
import {defaultHindsightSettings} from './src/shared/hindsight';
import {startInterfaceLanguage} from './src/ui/i18n';
localStorage.setItem('comborunner.locale','zh-CN');
window.english=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();};
const budget={perRunUsd:0.1,limitUsd:2,maxConcurrentRuns:1,burstConcurrentRuns:1,preferExpiring:true,startedAt:'2026-10-22T00:00:00Z',expiresAt:'2026-12-01T00:00:00Z'};
window.fixture={calls:[],writes:[],status:{state:'disabled'},state:{targets:[{id:'managed-api',label:'Synthetic API',gateway:'api',apiProvider:'custom',enabled:true,apiBudget:budget}],projects:[{id:'project-id',name:'Synthetic project'}],apiProviders:[{targetId:'managed-api',budget:{policy:budget,phase:'normal',remainingUsd:1.23}}]}};
const api=async(...args)=>{window.fixture.calls.push(args);return args[0]==='/api/hindsight/forget'?{revoked:true,serviceDeleted:false}:window.fixture.status};
function Fixture(){
 const [settings,setSettings]=useState(defaultHindsightSettings);
 const change=value=>{window.fixture.writes.push(value);setSettings(value)};
 return <main className="settings-container" style={{maxWidth:720,margin:'24px auto',padding:'0 16px'}}><div className="settings-content"><h1>Settings</h1><div className="settings-form"><HindsightSettingsPanel state={window.fixture.state} settings={settings} api={api} onChange={change}/></div></div></main>;
}
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<Fixture/>));`,
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_HINDSIGHT_UI: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => child.kill(), 45000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-hindsight-ui-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_HINDSIGHT_UI;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        useContentSize: true,
        width: 960,
        height: 1300,
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
      const errors = [];
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.level === 3) errors.push(event.message);
      });
      const evaluate = (source) => win.webContents.executeJavaScript(source);
      const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      const click = async (selector) => {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await frame();
      };
      const input = async (selector, value) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
        );
        await frame();
      };
      const screenshot = async (name) => {
        win.webContents.invalidate();
        await new Promise((done) => setTimeout(done, 150));
        const directory = path.join(root, 'reports/hindsight-settings');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, name), (await win.webContents.capturePage()).toPNG());
      };
      await win.loadFile(path.join(fixture, 'index.html'));
      for (let i = 0; i < 20 && !(await evaluate("!!document.querySelector('.settings-row-expand')")); i++)
        await frame();
      assert.equal(await evaluate("document.querySelector('.settings-row-details').hidden"), true);
      assert.equal(await evaluate('document.querySelector(\'[aria-label="启用 Hindsight 项目记忆"]\').checked'), false);
      await screenshot('collapsed.png');
      await click('.settings-row-expand');
      await input('[aria-label="Hindsight Python 可执行文件"]', 'C:/Synthetic/hindsight/python.exe');
      await input('[aria-label="Hindsight API 账号"]', 'managed-api');
      await click('[aria-label="Synthetic project"]');
      await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='保存配置').click()");
      await frame();
      assert.equal(await evaluate('window.fixture.writes.length'), 1);
      assert.deepEqual(await evaluate('window.fixture.writes[0].projectIds'), ['project-id']);
      assert.equal(
        await evaluate('document.querySelector(\'[aria-label="启用 Hindsight 项目记忆"]\').disabled'),
        false,
      );
      await evaluate(
        "window.fixture.status={state:'unavailable',detail:'Hindsight 1.1.0 dependency missing. Local memory remains available.'}",
      );
      await click('[aria-label="启用 Hindsight 项目记忆"]');
      assert.equal(await evaluate('window.fixture.writes[1].enabled'), true);
      assert.match(await evaluate('document.body.textContent'), /Hindsight 1.1.0 dependency missing/);
      await input('[aria-label="要清除 Hindsight 副本的项目"]', 'project-id');
      await evaluate(
        "[...document.querySelectorAll('button')].find(el=>el.textContent==='清除此项目的 Hindsight 副本').click()",
      );
      await frame();
      assert.match(await evaluate('document.body.textContent'), /已撤销本地引用；服务中的副本是否删除尚未确认/);
      assert.deepEqual(await evaluate('window.fixture.calls.filter(call=>call[0]==="/api/hindsight/forget")'), [
        ['/api/hindsight/forget', { projectId: 'project-id' }, 'POST'],
      ]);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await screenshot('configured-unavailable.png');
      win.setContentSize(390, 1500);
      await frame();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await screenshot('narrow.png');
      await evaluate('window.english()');
      await frame();
      assert.match(await evaluate('document.body.textContent'), /Hindsight project memory \(pilot\)/);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await screenshot('narrow-en.png');
      win.setContentSize(960, 1300);
      await frame();
      await screenshot('configured-unavailable-en.png');
      assert.equal(
        await evaluate(
          'window.fixture.calls.every(call=>(call[0]==="/api/hindsight/status" && call[2]==="GET") || (call[0]==="/api/hindsight/forget" && call[2]==="POST"))',
        ),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        'Hindsight renderer: collapsed default, configuration save, explicit enable, missing dependency, explicit project forgetting, narrow layout and screenshots passed.',
      );
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
