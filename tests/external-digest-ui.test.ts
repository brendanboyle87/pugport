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
  'digest card: sections, source icons, decisions, safe links and offscreen themes',
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pugport-digest-ui-'));
    const artifacts = resolve('.oil-ui/channels');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><main id="root" style="position:absolute;bottom:24px;left:24px"></main><script src="fixture.js"></script></body></html>',
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
localStorage.setItem('comborunner.locale','zh-CN');document.documentElement.dataset.theme='light';
const item=(id,source,text,group,extra={})=>({id,source,text,group,...extra});
const digest={day:'2026-11-01',pending:[item('pending/1','slack','请确认首页的深色配色方案','#design',{status:'pending',permalink:'https://example.slack.com/archives/C1/p1'})],done:[item('done/1','slack','整理会议记录并列出三个后续任务','#team',{permalink:'https://example.slack.com/archives/C1/p2'}),item('done/2','github','修复了项目摘要中的日期显示','pugport/app',{workflowId:'workflow-1'})],noted:[item('noted/1','github','新增 issue：窄屏布局的文字换行','pugport/app',{permalink:'https://github.com/example/app/issues/1'}),item('noted/2','github','CI：主分支检查通过','pugport/app'),item('noted/3','slack','明天的例会移到上午十点','#team',{permalink:'javascript:alert(1)'})],remaining:4};
const base={id:'synthetic',kind:'external-digest',key:'synthetic',severity:'action',title:'昨天：做了 2 件 · 等你确认 1 件 · 记下 7 条',createdAt:'2026-11-02T14:00:00Z',updatedAt:'2026-11-02T14:00:00Z',count:1,externalDigest:digest};
window.fixture={calls:[],errors:[],runs:[],fail:false};
function App(){const [notice,setNotice]=useState(base);window.fixture.reset=()=>setNotice(base);const api=async(path,body)=>{window.fixture.calls.push({path,body});if(path==='/api/problem-reports/inbox')return {reports:[]};if(path.includes('/resolve')){if(window.fixture.fail)throw Error('Synthetic failure');setNotice({...base,externalDigest:{...digest,pending:digest.pending.map(item=>({...item,status:body.decision==='approve'?'approved':'rejected'}))}});}return {};};return <InboxButton summary={{unread:1,attention:1,open:[notice]}} api={api} reload={async()=>{}} notify={n=>window.fixture.errors.push(n)} openPage={()=>{}} onRun={()=>{}} onWorkflow={id=>window.fixture.runs.push(id)} onProjectRules={()=>{}}/>;}
startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<App/>));`,
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
win=new BrowserWindow({show:false,width:440,height:820,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://')&&!d.url.startsWith('data:')}));
const ev=c=>win.webContents.executeJavaScript(c),frame=()=>new Promise(r=>setTimeout(r,40));
const click=async label=>{await ev('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');await frame();};
const shot=async name=>{await ev('document.fonts.ready');await ev('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))');await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
await win.loadFile(path.join(__dirname,'index.html'));
for(let i=0;i<60;i++){await frame();if(await ev('!!document.querySelector(".sidebar-inbox")'))break;}
await ev('document.querySelector(".sidebar-inbox").click()');await frame();
assert.equal(await ev('document.querySelector(".external-digest-title").textContent'),'昨天：做了 2 件 · 等你确认 1 件 · 记下 7 条');
assert.deepEqual(await ev('Array.from(document.querySelectorAll(".external-digest h4")).map(x=>x.textContent)'),['等你确认','做完了','记下来的']);
assert.equal(await ev('document.querySelectorAll(".external-digest-item").length'),6);
assert.equal(await ev('document.querySelectorAll(".external-digest-item > svg").length'),6);
assert.equal(await ev('document.querySelectorAll(".external-digest-actions button").length'),2);
assert.equal(await ev('document.querySelector(".external-digest-more").textContent'),'还有 4 条');
assert.equal(await ev('document.querySelectorAll("a[href^=javascript]").length'),0);
assert.equal(await ev('document.querySelectorAll(".external-digest-group").length'),2);
assert.equal(await ev('document.querySelector(".external-digest").scrollWidth<=document.querySelector(".external-digest").clientWidth'),true);
await shot('digest-light');await ev('document.documentElement.dataset.theme="dark"');await shot('digest-dark');
await ev('window.fixture.fail=true');await click('批准');assert.equal(await ev('window.fixture.errors.length'),1);assert.equal(await ev('document.querySelectorAll(".external-digest-actions button").length'),2);await ev('window.fixture.fail=false');
for(const [label,decision] of [['批准','approve'],['拒绝','reject']]){await click(label);assert.equal(await ev('window.fixture.calls.at(-1).path'),'/api/slack/requests/pending%2F1/resolve');assert.equal(await ev('window.fixture.calls.at(-1).body.decision'),decision);assert.equal(await ev('document.querySelectorAll(".external-digest-actions button").length'),0);await ev('window.fixture.reset()');await frame();}
await click('修复了项目摘要中的日期显示');assert.equal(await ev('window.fixture.runs.at(-1)'),'workflow-1');
assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
console.log('PASS digest UI: sections, icons, grouping, decisions, retry, safe links, workflow and screenshots');
}catch(e){console.error(e);process.exitCode=1;}finally{setTimeout(()=>process.exit(process.exitCode||0),1000);win?.destroy();app.exit(process.exitCode||0);}});`,
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
    const timer = setTimeout(() => child.kill(), 170000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS digest UI/);
    } finally {
      clearTimeout(timer);
    }
  },
);
