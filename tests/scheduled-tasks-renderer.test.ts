import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('offline Electron renders routines, edits a dialog, navigates history and prevents repeated dispatch', async () => {
  const root = process.cwd();
  const fixture = await mkdtemp(join(tmpdir(), 'pugport-a5-renderer-'));
  const artifacts = resolve('artifacts/a5');
  await mkdir(artifacts, { recursive: true });
  await build({ entryPoints: ['src/ui/studio.css'], bundle: true, outfile: join(fixture, 'style.css') });
  await writeFile(
    join(fixture, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="fixture.js"></script>',
  );
  await build({
    stdin: {
      contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduledTasks } from './src/ui/ScheduledTasks';
window.calls = []; window.opened = [];
let routines = [{id:'daily',name:'每日项目摘要',prompt:'Summarize the synthetic project.',schedule:{type:'daily',time:'09:00'},permissionMode:'read-only',enabled:false,createdAt:'2026-10-13T00:00:00Z',nextRunAt:'2026-10-14T13:00:00Z',history:[{at:'2026-10-13T13:00:00Z',workflowId:'wf',conversationId:'conversation',status:'completed'}]}];
const api = async (path,body,method='POST') => {
 window.calls.push({path,body,method});
 if(path.startsWith('/api/conversations/')) return {conversation:{id:'conversation',projectId:'project',title:'Synthetic'}};
 if(method==='GET') return routines.map(r=>({...r}));
 if(path.endsWith('/run')) await new Promise(resolve=>{window.releaseRun=resolve});
 else if(method==='PATCH') routines=routines.map(r=>({...r,...body}));
 else if(method==='PUT') routines=routines.map(r=>({...r,...body}));
 else if(method==='POST') routines.push({...body,id:'new',enabled:false,history:[],createdAt:'2026-10-13T00:00:00Z',nextRunAt:'2026-10-14T13:00:00Z'});
 return {};
};
createRoot(document.getElementById('root')).render(<ScheduledTasks api={api} state={{runtimes:[{id:'mock',label:'Synthetic Codex',models:[{id:'mock-model',efforts:['low','high']}]}]}} notify={notice=>{throw Error(notice.message)}} onConversation={value=>window.opened.push(value.id)} />);`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    outfile: join(fixture, 'fixture.js'),
    platform: 'browser',
    format: 'iife',
  });
  const runner = join(fixture, 'runner.cjs');
  await writeFile(
    runner,
    `const assert=require('node:assert/strict');
const fs=require('node:fs/promises'); const path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile')); app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1060,height:880,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
  await win.loadFile(path.join(__dirname,'index.html'));
  const evaluate=code=>win.webContents.executeJavaScript(code);
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  // Hidden software capture can fail transiently on CI runners; retry only that Electron snapshot error.
  const capture=async()=>{try{return await win.webContents.capturePage();}catch(error){if(!String(error).includes('UnknownVizError'))throw error;await frame();return win.webContents.capturePage();}};
  const click=label=>evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==='+JSON.stringify(label)+').click()');
  for(let i=0;i<30;i++) { await frame(); if(await evaluate('!!document.querySelector(".routine-card")')) break; }
  assert.equal(await evaluate('document.querySelectorAll(".routine-card").length'),1);
  assert.equal(await evaluate('document.querySelector("[role=switch]").getAttribute("aria-checked")'),'false');
  assert.equal(await evaluate('document.body.textContent.includes("按本地时间自动运行并使用额度；错过的周期只补跑一次。")'),true);
  await evaluate('document.querySelector(".routine-history").open=true'); await frame();
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},'routines-desktop.png'),(await capture()).toPNG());
  await evaluate('document.querySelector(".routine-history a").click()'); await frame();
  assert.deepEqual(await evaluate('window.opened'),['conversation']);
  await evaluate('document.querySelector("[role=switch]").click()'); await frame();
  assert.equal(await evaluate('document.querySelector("[role=switch]").getAttribute("aria-checked")'),'true');
  await click('立即运行'); await click('立即运行'); await frame();
  assert.equal(await evaluate('window.calls.filter(c=>c.path.endsWith("/run")).length'),1);
  await evaluate('window.releaseRun()'); await frame();
  await click('编辑'); await frame();
  assert.equal(await evaluate('document.querySelector("dialog").open'),true);
  assert.equal(await evaluate('document.querySelector("dialog input").value'),'每日项目摘要');
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},'routine-dialog.png'),(await capture()).toPNG());
  // Select writable and weekly through real DOM change events.
  await evaluate('(()=>{const s=document.querySelectorAll("dialog select")[0];s.value="weekly";s.dispatchEvent(new Event("change",{bubbles:true}));})()'); await frame();
  assert.equal(await evaluate('document.querySelectorAll("dialog select").length'),4);
  await evaluate('(()=>{const s=document.querySelectorAll("dialog select")[2];s.value="workspace-write";s.dispatchEvent(new Event("change",{bubbles:true}));})()'); await frame();
  assert.equal(await evaluate('document.querySelector("input[placeholder]").required'),true);
  await evaluate('(()=>{const s=document.querySelectorAll("dialog select")[2];s.value="read-only";s.dispatchEvent(new Event("change",{bubbles:true}));})()'); await frame();
  win.setSize(390,820); await frame();
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await evaluate('document.querySelector("dialog").scrollWidth<=document.querySelector("dialog").clientWidth'),true);
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},'routine-dialog-narrow.png'),(await capture()).toPNG());
  await click('保存'); await frame();
  assert.equal(await evaluate('document.querySelector("dialog")===null'),true);
  const saved=await evaluate('window.calls.find(c=>c.method==="PUT")');
  assert.equal(saved.body.schedule.type,'weekly'); assert.equal(saved.body.permissionMode,'read-only');
  assert.equal('enabled' in saved.body,false); assert.equal('history' in saved.body,false);
  await click('新建任务'); await frame();
  assert.equal(await evaluate('document.querySelector("dialog input").value'),'');
  assert.equal(await evaluate('document.querySelector("dialog").textContent.includes("新任务默认暂停")'),true);
  await evaluate('document.querySelector("dialog button[aria-label=关闭]").click()'); await frame();
  console.log('List, switch, run deduplication, history link, edit/save, create dialog and narrow layout passed; 3 screenshots saved.');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{win?.destroy();app.exit(process.exitCode||0);}
});`,
  );
  const require = createRequire(import.meta.url);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron') as string, electronArgs(runner), {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const timeout = setTimeout(() => child.kill(), 45000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, output);
  } finally {
    clearTimeout(timeout);
  }
});
