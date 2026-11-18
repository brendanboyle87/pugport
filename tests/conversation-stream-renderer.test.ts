import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('streaming in several conversations updates replies without rebuilding history', { timeout: 45000 }, async (t) => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-conversation-stream-')));
  const artifacts = resolve('artifacts/conversation-stream');
  await mkdir(artifacts, { recursive: true });
  t.after(async () => {
    assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(fixture).startsWith('pugport-conversation-stream-'));
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await writeFile(
    join(fixture, 'index.html'),
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>',
  );
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React, {Profiler} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationHistory,ConversationWorkspace} from './src/ui/Workspace';
import {applyRunUpdate} from './src/ui/run-events';
const at=n=>new Date(Date.UTC(2026,0,1,0,0,n)).toISOString();
const run=id=>({id,workflowId:id,stepId:'reply',prompt:'Synthetic',projectPath:'',kind:'routine',status:'running',route:{runtimeId:'fixture',model:'synthetic',kind:'routine',reasons:[],warnings:[]},startedAt:at(0),output:id+'-initial',events:[]});
const workflow=id=>({id,conversationId:id,projectId:'project',userMessageId:id+'-user',input:{content:'Synthetic',mode:'chat',permissionMode:'read-only'},status:'running',phase:'execute',activeStepId:'reply',plan:[{id:'reply',title:'Reply',instruction:'',kind:'routine',transport:'auto',dependsOn:[],status:'running',runIds:[id]}],runIds:[id],memoryRevision:0,memoryExcerpt:'',createdAt:at(0),updatedAt:at(0)});
let workflows=['A','B'].map(workflow),messages=Object.fromEntries(['A','B'].map(id=>[id,Array.from({length:80},(_,n)=>({id:id+'-'+n,conversationId:id,role:n%2?'assistant':'user',content:id+' history '+n,createdAt:at(n-100)})).concat({id:id+'-user',workflowId:id,conversationId:id,role:'user',content:'Synthetic',createdAt:at(0)})]));
const project={id:'project',name:'Fixture',path:'',scope:'chat',createdAt:at(0),updatedAt:at(0)},conversations=['A','B'].map(id=>({id,projectId:'project',title:id,createdAt:at(0),updatedAt:at(0)}));
let state={app:{name:'Fixture',version:'test',platform:'win32',dataDir:''},projects:[project],conversations,conversationMessages:[],plugins:[],targets:[],runtimes:[],runs:['A','B','C'].map(run),workflows,approvals:[],settings:{}};
const root=createRoot(document.getElementById('root')),api=async path=>{const id=path.split('/').at(-1);if(path.startsWith('/api/conversations/'))return {messages:messages[id],workflows:workflows.filter(w=>w.conversationId===id)};throw Error('Unexpected network')},noop=()=>{};
let workspaceMode=false;
window.commits={A:0,B:0};window.timelineCalls=0;
// Keep the workflow-array identity stable, as the real workspace does between run events.
const byPane=Object.fromEntries(workflows.map(task=>[task.id,[task]]));
const renderStable=()=>root.render(workspaceMode?<>{conversations.map(conversation=><section id={'pane-'+conversation.id} key={conversation.id}><ConversationWorkspace state={state} api={api} project={project} conversation={conversation} notify={noop} onConversation={noop} onAddProject={noop} onMemory={noop} onInspect={noop}/></section>)}</>:<>{workflows.map(task=><section id={'pane-'+task.id} key={task.id}><Profiler id={task.id} onRender={id=>window.commits[id]++}><ConversationHistory messages={messages[task.id]} workflows={byPane[task.id]} state={state} api={api} notify={noop} onInspect={noop} limit={60}/></Profiler></section>)}</>);
window.update=(id,type,text,seq)=>{state=applyRunUpdate(state,{runId:id,event:{type,text,seq,at:at(2)}});renderStable();};
window.summary=()=>{state={...state,runs:state.runs.map(r=>r.id==='A'?{...r,status:'completed',summary:true,events:[],output:'TRIMMED',endedAt:at(4)}:r)};renderStable();};
window.finish=()=>{workflows=workflows.map(w=>w.id==='A'?{...w,status:'completed',phase:'summarize',finalMessageId:'A-final'}:w);byPane.A=[workflows[0]];messages.A=[...messages.A,{id:'A-final',conversationId:'A',workflowId:'A',role:'assistant',content:'A-initial more',createdAt:at(5)}];state={...state,workflows};renderStable();};
window.steer=()=>{messages.B=[...messages.B,{id:'B-steer',conversationId:'B',workflowId:'B',role:'user',content:'Correction',createdAt:at(1),steering:{runId:'B',status:'accepted',acceptedAt:at(1)}}];renderStable();};
window.reassign=owner=>{state={...state,runs:state.runs.map(r=>r.id==='B'?{...r,workflowId:owner}:r)};renderStable();};
window.approve=()=>{workflows=workflows.map(w=>w.id==='B'?{...w,status:'waiting-approval'}:w);byPane.B=[workflows[1]];state={...state,workflows,approvals:[{id:'approval',runId:'B',tool:'synthetic',description:'Approval marker',status:'pending',createdAt:at(3)}]};renderStable();};
window.openWorkspace=()=>{workspaceMode=true;state={...state,conversationMessages:Object.values(messages).flat()};renderStable();};
window.snapshot=()=>({timelineCalls:window.timelineCalls,commits:window.commits,output:state.runs.map(r=>({id:r.id,output:r.output,reasoning:r.reasoning,events:r.events.map(e=>e.seq)})),approvals:state.approvals.length});
renderStable();`,
    },
    bundle: true,
    platform: 'browser',
    outfile: join(fixture, 'fixture.js'),
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    plugins: [
      {
        name: 'count-real-timeline',
        setup(builder) {
          builder.onLoad({ filter: /conversation-timeline\.ts$/ }, async ({ path }) => ({
            contents: (await readFile(path, 'utf8')).replace(
              '): ConversationTimelineRow[] {',
              '): ConversationTimelineRow[] { (window as any).timelineCalls++;',
            ),
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const runner = join(fixture, 'runner.cjs');
  await writeFile(
    runner,
    `const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(2),30000);
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
await win.loadFile(path.join(__dirname,'index.html'));const evaluate=code=>win.webContents.executeJavaScript(code);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
for(let i=0;i<30;i++){await frame();if(await evaluate('document.querySelectorAll(".live-main-reply").length===2'))break;}
const before=await evaluate('window.snapshot()');assert.equal(before.timelineCalls,2);
for(let i=1;i<=6;i++){await evaluate('window.update("C",'+JSON.stringify(i%2?'text':'reasoning')+'," external",'+i+')');await frame();}
const external=await evaluate('window.snapshot()');assert.equal(external.timelineCalls,before.timelineCalls,'unrelated streams must not rebuild either timeline');
await evaluate('window.update("A","text"," more",1)');await frame();
assert.match(await evaluate('document.querySelector("#pane-A .live-main-reply").textContent'),/A-initial more/);
await evaluate('window.update("A","reasoning","private reasoning",2)');await frame();
const own=await evaluate('window.snapshot()');assert.equal(own.timelineCalls,before.timelineCalls,'own stream text must not rebuild history');assert.ok(own.commits.A>before.commits.A,'the live reply actually renders');
await evaluate('window.update("A","text"," DUPLICATE",1)');await frame();assert.doesNotMatch(await evaluate('document.body.innerText'),/DUPLICATE/);
await evaluate('window.summary()');await frame();assert.equal((await evaluate('window.snapshot()')).timelineCalls,3,'a run end invalidates its timeline only');assert.match(await evaluate('document.querySelector("#pane-A .live-main-reply").textContent'),/A-initial more/);assert.doesNotMatch(await evaluate('document.body.innerText'),/TRIMMED/);
await evaluate('window.finish()');await frame();assert.equal(await evaluate('document.querySelectorAll("#pane-A .live-main-reply").length'),0);assert.equal(await evaluate('document.querySelector("#pane-A").innerText.split("A-initial more").length-1'),1);
await evaluate('window.steer()');await frame();assert.equal(await evaluate('document.querySelectorAll("#pane-B .steering-stage").length'),1);
await evaluate('window.reassign("foreign")');await frame();assert.equal(await evaluate('document.querySelectorAll("#pane-B .steering-stage").length'),0);
await evaluate('window.reassign("B")');await frame();assert.equal(await evaluate('document.querySelectorAll("#pane-B .steering-stage").length'),1);
await evaluate('window.update("B","text"," new stage",1)');await frame();assert.match(await evaluate('document.querySelector("#pane-B .live-main-reply").textContent'),/new stage/);assert.doesNotMatch(await evaluate('document.querySelector("#pane-B .live-main-reply").textContent'),/B-initial/);
await evaluate('window.approve()');await frame();assert.equal((await evaluate('window.snapshot()')).approvals,1);assert.match(await evaluate('document.querySelector("#pane-B").textContent'),/等待确认|等待审批/);
await evaluate('window.openWorkspace()');for(let i=0;i<6;i++)await frame();assert.equal(await evaluate('document.querySelectorAll(".conversation-workspace").length'),2);
const workspace=await evaluate('window.snapshot()');await evaluate('window.update("C","text"," outside",7)');await frame();await evaluate('window.update("B","text"," workspace-tail",2)');await frame();
assert.equal((await evaluate('window.snapshot()')).timelineCalls,workspace.timelineCalls,'real workspace callers keep pending and historical structure stable');assert.match(await evaluate('document.querySelector("#pane-B .live-main-reply").textContent'),/workspace-tail/);
await fs.writeFile(path.join(${JSON.stringify(artifacts)},'multi-conversation.png'),(await win.webContents.capturePage()).toPNG());
console.log(JSON.stringify({before,external,own,workspace,final:await evaluate('window.snapshot()')}));console.log('PASS: stream renders, history reuse, sequence replay, final handoff, steering and approval');
}catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(deadline);win?.destroy();app.exit(process.exitCode||0);}});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
    env,
    windowsHide: true,
    timeout: 35000,
    maxBuffer: 1024 * 1024,
  });
  console.log(result.stdout.trim());
  assert.match(result.stdout, /PASS: stream renders, history reuse/);
});
