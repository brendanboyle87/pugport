import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { electronArgs } from './helpers/electron-app.cjs';
const electron = createRequire(import.meta.url)('electron') as string;

test(
  'offscreen reply identity, execution records and bottom actions in both themes and narrow layouts',
  { timeout: 90000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-reply-actions-')));
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-reply-actions-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const artifacts = resolve('artifacts/reply-identity-actions');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><main style="max-width:840px;margin:auto;padding:24px"><div id="root"></div></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationHistory } from './src/ui/Workspace';
import { captureReplyIdentity } from './src/shared/reply-identity';
import { startInterfaceLanguage } from './src/ui/i18n';
import './src/ui/studio.css';
import './src/ui/pinned-messages.css';
import './src/ui/message-branch-actions.css';
import './src/ui/ParticipantReply.css';
localStorage.setItem('comborunner.locale', 'en');
window.errors=[];
window.addEventListener('error', e=>window.errors.push(e.message));
window.fetch=()=>{throw Error('Unexpected network request');};
const stamp='2026-10-01T12:00:00Z';
const at=n=>new Date(Date.parse(stamp)+n*1000).toISOString();
const step=(id)=>({id,title:'Answer the question',instruction:'Synthetic task',kind:'general',transport:'cli',dependsOn:[],status:'completed',runIds:[id+'-run']});
const task=(id,multi=false)=>({id,conversationId:'chat',projectId:'fixture',userMessageId:id+'-user',finalMessageId:id+'-reply',
 input:{content:'Explain the result.',mode:multi?'build':'chat',permissionMode:'workspace-write',executionPolicy:'cli-first'},
 ownSelection:{},status:'completed',phase:'execute',plan:multi?[step(id+'-a'),step(id+'-b')]:[step(id)],
 runIds:multi?[id+'-a-run',id+'-b-run']:[id+'-run'],createdAt:stamp,updatedAt:at(multi?92:12),memoryRevision:0,memoryExcerpt:''});
const single=task('single'), multi=task('multi',true);
const tasks=[single,multi];
const runs=tasks.flatMap(w=>w.plan.map((s,i)=>({id:s.runIds[0],workflowId:w.id,stepId:s.id,
 prompt:'Synthetic request',projectPath:'C:/Synthetic',kind:'general',status:'completed',
 route:{runtimeId:'codex-b',model:'requested-model',effort:'medium',kind:'general',reasons:[],warnings:[]},
 effectiveModel:{model:'gpt-5.6-terra',effort:'high',source:'fixture'},account:{id:'codex-b',label:'Codex B',provider:'codex'},
 startedAt:at(i?45:0),endedAt:at(w.id==='multi'?(i?92:44):12),events:[],output:'The result is ready.'})));
const messages=tasks.flatMap(w=>[
 {id:w.userMessageId,workflowId:w.id,role:'user',content:w.id==='single'?'Explain how automatic routing chose this answer.':'Summarize the two completed steps.'},
 {id:w.finalMessageId,workflowId:w.id,role:'assistant',content:w.id==='single'?'The reply came from Codex B, using gpt-5.6-terra with high effort.\\n\\nThe execution record above contains the recorded run and its trace.':'Both steps are complete. The first checked the inputs; the second prepared the result.',replyIdentity:captureReplyIdentity(w,runs.filter(r=>r.workflowId===w.id))}
].map(m=>({...m,conversationId:'chat',createdAt:at(m.role==='user'?0:100)})));
const root=createRoot(document.getElementById('root'));
window.traceCalls=[];
window.renderFixture=(edge=false,legacy)=>{
 const extra=edge?[
 {id:'long',conversationId:'chat',role:'assistant',content:'A long code block stays within the message.\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\n'+('const synthetic = "'+'x'.repeat(120)+'";\\n').repeat(8)+String.fromCharCode(96).repeat(3),createdAt:stamp,replyIdentity:messages[1].replyIdentity},
 {id:'notice',conversationId:'chat',role:'assistant',content:'System notice',systemNotice:{text:'System notice'},createdAt:stamp},
 {id:'pending:queued',conversationId:'chat',role:'user',content:'Queued message',createdAt:stamp}
 ]:[];
 const active=edge?{...task('stream'),status:'running',runIds:['stream-run'],plan:[{...step('stream'),id:'reply',status:'running'}],finalMessageId:undefined,activeStepId:'reply'}:null;
 const activeRun=active?{...runs[0],id:'stream-run',workflowId:'stream',stepId:'reply',status:'running',output:'Streaming reply remains readable.',endedAt:undefined}:null;
 const workflows=active?[...tasks,active]:tasks;
 const state={app:{platform:'win32'},settings:legacy===undefined?{}:{showAutomaticReplyIdentity:legacy},targets:[],runtimes:[],workflows,runs:activeRun?[...runs,activeRun]:runs,approvals:[],plugins:[]};
 flushSync(()=>root.render(<ConversationHistory messages={[...messages,...extra,...(active?[{id:active.userMessageId,workflowId:active.id,conversationId:'chat',role:'user',content:'Continue with the next answer.',createdAt:stamp}]:[])]} workflows={workflows} state={state} api={async()=>({})} notify={()=>{}} onInspect={()=>{}} onTrace={w=>window.traceCalls.push(w.id)} onPinMessage={()=>{}} onConversation={()=>{}}/>));
};
window.renderFixture();
startInterfaceLanguage();
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(1),60000);
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1000,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://')}));
  await win.loadFile(path.join(__dirname,'index.html'));
  const evaluate=async s=>{try{return await win.webContents.executeJavaScript(s);}catch(e){throw new Error(s+": "+e);}};
  const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await frame();
  for(const theme of ['light','dark']) for(const width of [1000,390]){
   win.setSize(width,1000);
   for(let i=0;i<50 && await evaluate('innerWidth')!==width;i++) await new Promise(r=>setTimeout(r,20));
   assert.equal(await evaluate('innerWidth'),width);
   await evaluate('window.renderFixture(false);document.documentElement.dataset.theme='+JSON.stringify(theme));
   await frame();
   assert.equal(await evaluate('document.querySelectorAll(".workflow-trace > details").length'),2);
   assert.equal(await evaluate('[...document.querySelectorAll(".workflow-trace > details")].every(d=>!d.open)'),true);
   assert.match(await evaluate('document.querySelector("#workflow-single summary").textContent'),/12s/);
   assert.equal(await evaluate('[...document.querySelectorAll(".workflow-trace > details > summary")].every(s=>!!s.querySelector(".workflow-status")&&!s.querySelector(".reply-identity"))'),true);
   assert.doesNotMatch(await evaluate('document.querySelector("#workflow-single summary").textContent'),/Codex B|gpt-5.6-terra|high|High/);
   assert.match(await evaluate('document.querySelector("[data-message-id=single-reply] .reply-identity").textContent'),/Codex B.*gpt-5.6-terra.*High/);
   assert.equal(await evaluate(\`JSON.stringify([...document.querySelectorAll(".conversation-message")].map(m=>{
     const body=m.querySelector(".message-text"),actions=m.querySelector(".message-actions");
     const b=body.getBoundingClientRect(),a=actions.getBoundingClientRect();
     return a.top>=b.bottom-1 && (m.classList.contains("message-user")?Math.abs(a.right-b.right)<2:Math.abs(a.left-b.left)<2);
   }))\`),'[true,true,true,true]');
   await evaluate('document.querySelector("[data-message-id=single-reply] .message-actions button").focus()');
   const userPosition=await evaluate('(()=>{const r=document.querySelector("[data-message-id=single-user]").getBoundingClientRect();return {x:Math.round(r.right-10),y:Math.round(r.top+10)}})()');
   win.webContents.sendInputEvent({type:'mouseMove',...userPosition});
   assert.equal(await evaluate('getComputedStyle(document.activeElement).opacity'),'1');
   if(width===390) assert.equal(await evaluate('[...document.querySelectorAll(".message-actions > button")].every(b=>getComputedStyle(b).opacity==="1")'),true);
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
   await frame();
   await new Promise(r=>setTimeout(r,200));
   const picture=await win.webContents.capturePage();
   await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'.png'),picture.toPNG());
   if(width===1000){
    await evaluate('document.querySelector("[data-message-id=multi-reply] .message-actions button").focus()');
    await frame();
    await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-1000-multi-actions.png'),(await win.webContents.capturePage()).toPNG());
   }
   await evaluate('document.querySelector("#workflow-single summary").click()');
   await frame();
   assert.equal(await evaluate('document.querySelector("#workflow-single > details").open'),true);
   assert.equal(await evaluate('document.querySelector("#workflow-single .trace-link").textContent'),'View trace');
   await evaluate('document.querySelector("#workflow-single .trace-link").click()');
   assert.equal(await evaluate('window.traceCalls.at(-1)'),'single');
   await evaluate('document.querySelector("#workflow-single summary").click()');
   await evaluate('window.renderFixture(false,false)');
   await frame();
   assert.equal(await evaluate('document.querySelector("[data-message-id=single-reply] .reply-identity")===null'),true);
   assert.equal(await evaluate('document.querySelectorAll(".workflow-trace > details").length'),2);
   await evaluate('window.renderFixture(true)');
   await frame();
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
   assert.equal(await evaluate('!!document.querySelector(".live-main-reply .message-text")'),true);
   assert.equal(await evaluate('document.querySelectorAll("#workflow-notice").length'),0);
   // A message still being sent cannot be forked, edited, resent or pinned; it can be copied like every message.
   assert.deepEqual(await evaluate('[...[...document.querySelectorAll("[data-message-id]")].find(m=>m.dataset.messageId==="pending:queued").querySelectorAll(".message-actions button")].map(b=>!!b.querySelector("svg.lucide-copy"))'),[true]);
   assert.equal(await evaluate(\`(()=>{const m=document.querySelector("[data-message-id=long]");return m.querySelector(".message-actions").getBoundingClientRect().top>=m.querySelector(".message-text").getBoundingClientRect().bottom})()\`),true);
  }
  assert.deepEqual(await evaluate('window.errors'),[]);
  await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({passed:true}));
  console.log('4 layouts passed; 6 PNGs; collapsed/expanded trace, focus, streaming, pending, notices and long code checked.');
 }catch(e){await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({error:String(e.stack||e)}));process.exitCode=1;}finally{clearTimeout(deadline);win?.destroy();app.exit(process.exitCode||0);}
});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const launcher = join(fixture, 'launch.cmd');
    await writeFile(
      launcher,
      `@echo off\r\n"${electron}" ${electronArgs(runner)
        .map((arg: string) => `"${arg}"`)
        .join(' ')} > "${join(fixture, 'electron.log')}" 2>&1\r\n`,
    );
    const child = spawn(
      process.platform === 'win32' ? 'powershell.exe' : electron,
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-Command',
            `$child = Start-Process conhost.exe -ArgumentList '--headless', 'cmd.exe', '/d', '/c', '${launcher.replaceAll("'", "''")}' -WindowStyle Hidden -PassThru -Wait; exit $child.ExitCode`,
          ]
        : electronArgs(runner),
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timeout = setTimeout(() => child.kill(), 70000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(join(fixture, 'result.json'), 'utf8').catch(() => '')) break;
        await new Promise((done) => setTimeout(done, 200));
      }
      const report = await readFile(join(fixture, 'result.json'), 'utf8').catch(async (error) => {
        throw new Error(await readFile(join(fixture, 'electron.log'), 'utf8').catch(() => String(error)));
      });
      assert.deepEqual(JSON.parse(report), { passed: true });
      console.log(output.trim());
    } finally {
      clearTimeout(timeout);
    }
  },
);
