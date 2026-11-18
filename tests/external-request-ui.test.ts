import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

test(
  'external request: three decisions, retry, collapse, task link and offline screenshots',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pugport-external-request-ui-'));
    const artifacts = resolve('.oil-ui/channels');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><main id="root" style="position:absolute;bottom:32px;left:32px"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InboxButton} from './src/ui/InboxPanel';
import {startInterfaceLanguage} from './src/ui/i18n';
import './src/ui/studio.css';
localStorage.setItem('comborunner.locale','zh-CN');
document.documentElement.dataset.theme='light';
const base={id:'synthetic',kind:'external-request',key:'synthetic',severity:'action',title:'Slack',body:'帮我把首页的配色改成深色。保留现在的信息层级，检查窄屏上的按钮布局，并给出修改后的截图。',createdAt:new Date(Date.now()-120000).toISOString(),updatedAt:new Date().toISOString(),count:1,externalRequest:{eventId:'synthetic/event',source:'slack',senderName:'张三',scopeLabel:'#design',permalink:'https://example.slack.com/archives/C123/p123',status:'pending',suggestAlways:true}};
window.fixture={calls:[],errors:[],runs:[],fail:false};
function App(){const [notice,setNotice]=useState(base);window.fixture.reset=()=>setNotice(base);window.fixture.terminal=receiptState=>setNotice({...base,severity:'info',externalRequest:{...base.externalRequest,status:'approved',workflowId:'workflow-1',receiptState}});const api=async(path,body)=>{window.fixture.calls.push({path,body});if(path==='/api/problem-reports/inbox')return {reports:[]};if(path.includes('/resolve')){if(window.fixture.fail)throw Error('Synthetic failure');setNotice({...base,severity:'info',externalRequest:{...base.externalRequest,status:body.decision==='reject'?'rejected':'approved',workflowId:'workflow-1'}});}return {};};return <InboxButton summary={{unread:1,attention:notice.severity==='action'?1:0,open:[notice]}} api={api} reload={async()=>{}} notify={n=>window.fixture.errors.push(n)} openPage={()=>{}} onRun={()=>{}} onWorkflow={id=>window.fixture.runs.push(id)} onProjectRules={()=>{}}/>;}
startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<App/>));
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(dir, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
    });
    const runner = join(dir, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:440,height:400,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://')&&!d.url.startsWith('data:')}));
const ev=c=>win.webContents.executeJavaScript(c),frame=()=>ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const click=async label=>{await ev('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');await frame();};
const shot=async name=>{await ev('document.fonts.ready');await ev('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))');await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
await win.loadFile(path.join(__dirname,'index.html'));
for(let i=0;i<60;i++){await frame();if(await ev('!!document.querySelector(".sidebar-inbox")'))break;}
await ev('document.querySelector(".sidebar-inbox").click()');await frame();
assert.equal(await ev('document.querySelector(".external-request-actions .primary").textContent'),'以后都直接做');
assert.equal(await ev('document.querySelector(".external-request-text").getAttribute("aria-expanded")'),'false');
await ev('document.querySelector(".external-request-text").click()');await frame();assert.equal(await ev('document.querySelector(".external-request-text").getAttribute("aria-expanded")'),'true');
await ev('document.querySelector(".external-request-text").click()');await frame();await shot('inbox-request-light');
await ev('document.documentElement.dataset.theme="dark"');await shot('inbox-request-dark');
await ev('window.fixture.fail=true');await click('批准');assert.equal(await ev('window.fixture.errors.length'),1);assert.equal(await ev('!!document.querySelector(".external-request-actions")'),true);
await ev('window.fixture.fail=false');
for(const [label,decision] of [['批准','approve'],['拒绝','reject'],['以后都直接做','always']]){
await click(label);assert.equal(await ev('window.fixture.calls.at(-1).path'),'/api/slack/requests/synthetic%2Fevent/resolve');assert.equal(await ev('window.fixture.calls.at(-1).body.decision'),decision);
assert.equal(await ev('!!document.querySelector(".inbox-panel")'),true);assert.equal(await ev('!!document.querySelector(".external-request-actions")'),false);
if(decision!=='reject'){await click('查看任务');assert.equal(await ev('window.fixture.runs.at(-1)'),'workflow-1');await shot('inbox-request-approved');}
await ev('window.fixture.reset()');await frame();}
for(const [state,label] of [['done','已批准 · 已完成'],['failed','已批准 · 没做成']]){
await ev('window.fixture.terminal('+JSON.stringify(state)+')');await frame();
assert.equal(await ev('document.querySelector(".external-request-settled span").textContent'),label);
assert.equal(await ev('!!document.querySelector(".external-request-actions")'),false);
await click('查看任务');assert.equal(await ev('window.fixture.runs.at(-1)'),'workflow-1');
await shot('inbox-request-'+state);}
assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
console.log('PASS external request UI: decisions, retry, collapse, task link, expansion, suggested action and screenshots');
}catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const require = createRequire(import.meta.url);
    const child = spawn(require('electron') as string, electronArgs(runner), {
      cwd: process.cwd(),
      env: offscreenElectronEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const timer = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS external request UI/);
    } finally {
      clearTimeout(timer);
    }
  },
);
