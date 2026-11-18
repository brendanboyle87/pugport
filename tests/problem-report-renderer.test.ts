import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

test(
  'problem report hidden renderer: capture, payload, empty send, nudge, inbox actions and both themes',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pugport-report-ui-'));
    const screenshots = resolve('.design/report-problem/impl');
    await mkdir(screenshots, { recursive: true });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {ProblemReporter,ReportProblemAction,ProblemReportCard} from './src/ui/ProblemReport';import {WorkflowTrace} from './src/ui/Workspace';import {InboxButton} from './src/ui/InboxPanel';
import {startInterfaceLanguage} from './src/ui/i18n';
import './src/ui/studio.css';import './src/ui/ProblemReport.css';import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';
window.fixture={calls:[],notices:[],errors:[],ready:false};const f=window.fixture;
window.addEventListener('error',e=>f.errors.push(e.message));window.addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason)));
window.fetch=()=>{throw Error('No real fetch allowed');};window.open=()=>{throw Error('No external windows allowed');};
const canvas=document.createElement('canvas');canvas.width=600;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#f3f3f5';ctx.fillRect(0,0,600,360);ctx.fillStyle='#3758d6';ctx.fillRect(30,30,120,24);ctx.fillStyle='#1b1c20';ctx.font='20px sans-serif';ctx.fillText('Synthetic screenshot',30,100);const shot=canvas.toDataURL('image/jpeg');
const state={projects:[],conversations:[],conversationMessages:[],plugins:[],targets:[],runtimes:[],runs:[],approvals:[],settings:{},workflows:[{id:'task-1',status:'running',createdAt:'2026-11-03T12:00:00Z',updatedAt:'2026-11-03T12:01:00Z',input:{content:'整理发票',permissionMode:'read-only'},runIds:[],plan:[]}]};
let mode='panel', report={id:'PP-1234',description:'I sent a message and nothing happened.',version:'0.0.34',os:'win32',images:[shot],duplicateCount:2,status:'new'};
const api=async(path,body)=>{f.calls.push({path,body});if(path==='/api/problem-reports/inbox')return {reports:[report]};if(path==='/api/problem-reports/preview')return {installId:'synthetic-install',version:'0.0.34',os:'win32',description:body.description,diagnostics:{environment:{version:'0.0.34',os:'win32'},errors:'Synthetic executor exited',...(body.includeConversation?{conversation:['Synthetic message']}:{}),task:{id:body.taskId}}};if(path==='/api/problem-reports'&&body){f.payload=body.payload;return {localId:'local-1',id:'PP-1234',description:body.payload.description,status:f.offline?'draft':'sent',imageCount:body.images.length};}if(path==='/api/problem-reports')return {reports:[]};if(path.endsWith('/diagnose'))return {taskId:'diagnosis-1'};if(path.endsWith('/status'))return {};if(path.endsWith('/files'))return {localId:'local-1',id:'PP-1234',status:'sent',imageCount:2};return {};};
const notify=n=>f.notices.push(n);const root=createRoot(document.getElementById('root'));
window.renderFixture=()=>flushSync(()=>root.render(<><aside className="studio-sidebar"><div className="studio-brand">PugPort</div><div className="sidebar-conversations"><button className="conversation-link">整理发票</button></div><div className="sidebar-status"/></aside><main className="fixture-main"><div className="fixture-message">把这周的发票整理成表格</div>{mode==='actual-inbox'?<InboxButton summary={{open:[],unread:0,attention:0}} reportCount={1} api={api} reload={async()=>{}} notify={notify} openPage={()=>{}} onRun={()=>{}} onWorkflow={id=>f.task=id} onProjectRules={()=>{}}/>:mode==='inbox'?<section className="inbox-panel" style={{position:'static',width:480}}><header className="inbox-header"><strong>信箱</strong></header><ul className="inbox-list"><ProblemReportCard report={report} api={api} onChanged={()=>f.changed=true} onTask={id=>f.task=id}/></ul></section>:<div className="fixture-failed"><WorkflowTrace workflow={state.workflows[0]} state={state} api={api} notify={notify} onInspect={()=>{}}/></div>}<div className="fixture-composer conversation-composer">问点什么，或者交给 PugPort 去做…<button className="button primary">发送</button></div></main><ProblemReporter api={api} state={state} notify={notify} currentTaskId="task-1"/></>));
window.failTask=()=>{state.workflows=[{...state.workflows[0],status:'failed'}];window.renderFixture();};
window.showInbox=()=>{mode='inbox';window.renderFixture();};window.showActualInbox=()=>{mode='actual-inbox';window.renderFixture();};
localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('locale')||'zh-CN');document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
void startInterfaceLanguage().then(()=>{window.renderFixture();f.ready=true;});
`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}#root{display:flex;height:100vh}.studio-sidebar{width:190px;flex-basis:190px;padding:20px 12px}.fixture-main{flex:1;padding:45px 32px;position:relative;background:var(--bg)}.fixture-message{background:var(--raised);padding:8px 12px;border-radius:12px;margin:0 0 28px auto;width:fit-content}.fixture-failed{border:1px solid var(--border);border-radius:10px;padding:12px;max-width:420px}.fixture-failed p{color:var(--muted)}.fixture-composer{position:absolute;bottom:20px;left:32px;right:32px;border:1px solid var(--border-strong);border-radius:12px;padding:12px;height:70px;color:var(--faint)}.fixture-composer button{float:right}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`,
    );
    await writeFile(
      join(directory, 'preload.cjs'),
      `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('comboRunnerDesktop',{pickDirectory:async()=>null,captureProblemScreenshot:()=>ipcRenderer.invoke('capture'),onReportProblem:()=>()=>{}});`,
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow,ipcMain}=require('electron');const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();let win,captures=0;
const evaluate=s=>win.webContents.executeJavaScript(s);const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
// A time limit, not a number of tries: the nudge ends on its own 6-second timer, which a fast machine's 200 tries did not reach.
const wait=async(s)=>{const end=Date.now()+10000;while(Date.now()<end){if(await evaluate(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout '+s);};
const click=async(s)=>{await evaluate('document.querySelector('+JSON.stringify(s)+').click()');await frame();};
const shot=async(name)=>{await evaluate('document.fonts.ready');await evaluate('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>a.finished.catch(()=>{})))');await frame();await new Promise(r=>setTimeout(r,180));await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG());};
ipcMain.handle('capture',async()=>{assert.equal(await evaluate('!!document.querySelector(".problem-report-panel")'),false,'capture excludes panel');captures++;return (await win.webContents.capturePage()).toDataURL();});
app.whenReady().then(async()=>{try{
win=new BrowserWindow({show:false,width:1000,height:740,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
const network=[];win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const allowed=/^(file:|data:|blob:)/.test(d.url);if(!allowed)network.push(d.url);cb({cancel:!allowed});});
for(const theme of ['light','dark']){
await win.loadFile(path.join(__dirname,'index.html'),{query:{theme}});await wait('window.fixture?.ready');assert.equal(win.isVisible(),false);
await evaluate('window.failTask()');await wait('!!document.querySelector(".problem-report-fab.nudge")');await shot(theme+'-failed-card');
assert.equal(await evaluate('document.querySelectorAll(".workflow-outcome .report-problem-action").length'),1);await click('.workflow-outcome .report-problem-action');await wait('!!document.querySelector(".problem-report-shot")');await wait('!document.querySelector(".problem-report-panel .primary").disabled');
assert.equal(await evaluate('document.querySelector(".problem-report-check input").checked'),false);await shot(theme+'-panel');
await click('.problem-report-add');await wait('document.querySelectorAll(".problem-report-shot").length===2');assert.ok(captures>=2);
await click('.problem-report-remove');await click('.problem-report-remove');assert.equal(await evaluate('document.querySelector(".problem-report-panel .primary").disabled'),true);
await evaluate('(()=>{const e=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"Synthetic report");e.dispatchEvent(new Event("input",{bubbles:true}));})()');await wait('!document.querySelector(".problem-report-panel .primary").disabled');
await click('.problem-report-attach button');const preview=await evaluate('JSON.parse(document.querySelector(".problem-report-preview").textContent)');await click('.problem-report-panel .primary');await wait('!!document.querySelector(".problem-report-panel.sent")');assert.deepEqual(await evaluate('window.fixture.payload'),preview);await shot(theme+'-sent');
await click('.problem-report-panel header button');await evaluate('window.showInbox()');await frame();await shot(theme+'-inbox');
await click('.problem-report-card .primary');await wait('window.fixture.task==="diagnosis-1"');await click('.problem-report-card .external-request-actions button:nth-child(2)');await evaluate('(()=>{const e=document.querySelector(".problem-report-fixed input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"0.0.35");e.dispatchEvent(new Event("input",{bubbles:true}));})()');await click('.problem-report-fixed button');await wait('window.fixture.calls.some(c=>c.body?.status==="fixed"&&c.body.fixedIn==="0.0.35")');await click('.problem-report-card .external-request-actions button:nth-child(3)');await wait('window.fixture.calls.some(c=>c.body?.status==="ignored")');
await wait('!document.querySelector(".problem-report-fab.nudge")');
assert.deepEqual(await evaluate('window.fixture.errors'),[]);
}
await evaluate('window.showActualInbox()');await click('.sidebar-inbox');await wait('!!document.querySelector(".problem-report-inbox-image")');await click('.problem-report-inbox-image');await wait('!!document.querySelector(".image-viewer")');await evaluate('document.querySelector(".image-viewer-bar button").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');await frame();assert.equal(await evaluate('!!document.querySelector(".image-viewer")'),true,'lightbox interactions preserve Inbox');await click('.image-viewer-close');assert.equal(await evaluate('!!document.querySelector(".inbox-panel")'),true);await click('.inbox-header button');
await evaluate('document.querySelector(".fixture-composer").style.height="180px"');await frame();await frame();assert.equal(await evaluate('document.querySelector(".problem-report-fab").getBoundingClientRect().bottom<document.querySelector(".fixture-composer").getBoundingClientRect().top'),true,'floating button clears expanded composer');
await click('.problem-report-fab');await wait('!!document.querySelector(".problem-report-panel .primary")&&!document.querySelector(".problem-report-panel .primary").disabled');await evaluate('window.fixture.offline=true');await click('.problem-report-panel .primary');await wait('document.querySelector(".problem-report-panel.sent")?.textContent.includes("已保存草稿")');await click('.problem-report-panel header button');
await win.setSize(500,740);await frame();await wait('!!document.querySelector(".sidebar-status .problem-report-fab")');assert.equal(await evaluate('(()=>{const b=document.querySelector(".sidebar-status .problem-report-fab").getBoundingClientRect(),s=document.querySelector(".sidebar-status").getBoundingClientRect();return b.left>=s.left&&b.right<=s.right})()'),true);
assert.deepEqual(network,[]);await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({ok:true,captures}));app.exit(0);
}catch(error){await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({ok:false,error:String(error.stack),body:win?await evaluate('document.body.innerText').catch(()=>''):''}));app.exit(1);}});
`.replace('SCREENSHOTS', JSON.stringify(screenshots)),
    );
    const env = offscreenElectronEnv({ ...process.env, ELECTRON_RUN_AS_NODE: undefined });
    const args = electronArgs(join(directory, 'runner.cjs'));
    const result = await promisify(execFile)(
      process.platform === 'win32' ? 'conhost.exe' : (electron as unknown as string),
      process.platform === 'win32' ? ['--headless', electron as unknown as string, ...args] : args,
      { env, windowsHide: true, timeout: 100000, maxBuffer: 1024 * 1024 },
    );
    let receipt: { ok: boolean; error?: string; body?: string } | undefined;
    for (let i = 0; i < 450; i++) {
      try {
        receipt = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    assert.ok(receipt, 'Hidden renderer did not write a completion receipt: ' + result.stderr);
    assert.equal(receipt.ok, true, receipt.error + '\n' + receipt.body);
  },
);
