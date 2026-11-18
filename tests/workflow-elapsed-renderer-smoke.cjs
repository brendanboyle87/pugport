// Hidden React renderer with synthetic timestamps; never starts the app, an API, or a model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-elapsed-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {WorkflowElapsed} from './src/ui/WorkflowElapsed';
const start=Date.parse('2026-10-01T12:00:00Z');
window.at=seconds=>new Date(start+seconds*1000).toISOString();
window.clock=start+5000;
Date.now=()=>window.clock;
window.liveTimers=new Set();window.delays=[];
const realSetInterval=window.setInterval.bind(window),realClearInterval=window.clearInterval.bind(window);
window.setInterval=(callback,delay,...args)=>{const id=realSetInterval(callback,delay,...args);window.liveTimers.add(id);window.delays.push(delay);return id;};
window.clearInterval=id=>{window.liveTimers.delete(id);realClearInterval(id);};
window.task={id:'task',status:'running',startedAt:window.at(0),updatedAt:window.at(2),runIds:['run']};
window.runs=[{id:'run',workflowId:'task',startedAt:window.at(1)}];
window.parentRenders=0;
const history=Array.from({length:30},(_,index)=>({...window.task,id:'history-'+index,status:'completed',updatedAt:window.at(3),runIds:[]}));
function Fixture(){window.parentRenders++;return <main><details id="current"><summary><WorkflowElapsed workflow={window.task} runs={window.runs}/></summary><p>Collapsed task details</p></details><aside>{history.map(task=><WorkflowElapsed key={task.id} workflow={task} runs={[]}/>)}</aside></main>;}
const root=createRoot(document.getElementById('root'));
window.renderFixture=()=>flushSync(()=>root.render(<Fixture/>));
window.unmountFixture=()=>flushSync(()=>root.unmount());
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, COMBORUNNER_ELAPSED_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 20000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-elapsed-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_ELAPSED_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-elapsed-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const counter = () => evaluate("document.querySelector('#current summary').textContent.trim()");
  const timers = () => evaluate('window.liveTimers.size');
  const tick = () => evaluate('new Promise(resolve=>setTimeout(resolve,1100))');
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
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
      await frame();
      assert.equal(await counter(), '5秒');
      assert.match(await evaluate("document.querySelector('#current .workflow-elapsed').title"), /已运行/);
      assert.equal(await evaluate("document.querySelector('#current').open"), false);
      assert.equal(await timers(), 1, 'only the active counter owns a timer; history is static');
      assert.deepEqual(await evaluate('window.delays'), [1000]);
      const parentRenders = await evaluate('window.parentRenders');
      await evaluate('window.clock+=7000');
      await tick();
      assert.equal(await counter(), '12秒', 'elapsed uses current wall time instead of counting timer callbacks');
      assert.equal(await evaluate('window.parentRenders'), parentRenders, 'local ticks do not rerender task history');

      await evaluate("window.task={...window.task,status:'waiting-approval'};window.renderFixture()");
      await frame();
      assert.equal(await timers(), 1);
      await evaluate('window.clock+=2000');
      await tick();
      assert.equal(await counter(), '14秒', 'approval waiting is part of the active task wall time');

      await evaluate(
        "window.task={...window.task,status:'waiting-resource',updatedAt:window.at(14)};window.renderFixture()",
      );
      await frame();
      assert.equal(await counter(), '14秒');
      assert.equal(await timers(), 0, 'resource waiting cleans the active interval');
      await evaluate(
        "window.clock+=16000;window.runs=window.runs.map(run=>({...run,endedAt:window.at(14)}));window.task={...window.task,status:'completed',updatedAt:window.at(14)};window.renderFixture()",
      );
      await frame();
      assert.equal(await counter(), '14秒');
      assert.equal(await timers(), 0);
      await evaluate('window.clock+=60000;window.task.updatedAt=window.at(90);window.renderFixture()');
      await frame();
      assert.equal(await counter(), '14秒', 'stopped duration stays fixed after later task metadata changes');

      await evaluate(
        "window.task={...window.task,status:'queued',startedAt:undefined,runIds:[]};window.renderFixture()",
      );
      await frame();
      assert.equal(await counter(), '');
      assert.equal(await timers(), 0);
      await evaluate(
        "window.task={...window.task,id:'next-task',status:'running',startedAt:window.at(80)};window.renderFixture()",
      );
      await frame();
      assert.equal(await counter(), '10秒');
      assert.equal(await timers(), 1, 'a newly launched workflow uses its own start');
      await evaluate('window.unmountFixture()');
      await frame();
      assert.equal(await timers(), 0, 'unmount cleans the interval');
      console.log(
        'Workflow elapsed renderer smoke passed: collapsed live counter, wall time, approval wait, frozen stops, timer cleanup.',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
