import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

test(
  'conversation popover retains delegation controls and sidebar retains only lanes',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-delegation-tree-')));
    const artifacts = resolve('.design/shots');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-delegation-tree-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      stdin: {
        contents:
          '@import "./src/ui/studio.css"; @import "./src/ui/conversation-work.css"; @import "./src/ui/SwarmWorkspace.css"; @import "./src/ui/mods/mods.css"; @import "./src/ui/DelegationTree.css";',
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      outfile: join(fixture, 'style.css'),
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="fixture.css"><style>*,*::before,*::after{transition:none!important;animation:none!important}</style><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import {startInterfaceLanguage} from './src/ui/i18n';import React from 'react';import{createRoot}from'react-dom/client';import Studio from'./src/ui/Studio';import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';import{uiUpdateBlocked}from'./src/ui/ui-update-guard';window.updateBlocked=uiUpdateBlocked;
const stamp='2026-10-25T12:00:00Z';
const project={id:'p',name:'Synthetic project',path:'C:/Synthetic',scope:'project',createdAt:stamp,updatedAt:stamp};
const chat=(id,extra={})=>({id,projectId:'p',title:'Chat '+id,createdAt:stamp,updatedAt:stamp,...extra});
const conversations=[chat('a',{delegationCount:2,archivedDelegationCount:42,modeBinding:{modeId:'fixture.notes',version:'1.0.0',instanceId:'notes'}}),chat('lane-one',{lane:{parentConversationId:'a',sourceWorkflowId:'root',planItem:'Lane one'}}),chat('lane-two',{lane:{parentConversationId:'a',sourceWorkflowId:'root',planItem:'Lane two'}}),chat('plain'),chat('private',{incognito:true,delegationCount:1}),...Array.from({length:100},(_,i)=>chat('history-'+i,{delegationCount:2})),chat('daily',{projectId:'everyday',delegationCount:1}),chat('archive-only',{archivedDelegationCount:1})];
const task=(id,parentId,status='running',chatId='a')=>({id,conversationId:chatId,projectId:'p',userMessageId:id+'-input',input:{content:'Synthetic task '+id,mode:'chat',permissionMode:'read-only',executionPolicy:'cli-only'},status,phase:'execute',plan:[],runIds:[id+'-run'],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp,...(parentId?{delegation:{parentId,requestId:id,role:'worker',agent:{label:id}}}:{})});
const family=[task('root'),task('Scout','root'),task('Reviewer','root','running'),...Array.from({length:42},(_,i)=>({...task('Archived-'+i,'root','completed'),archivedAt:stamp}))];
const archivedFamily=[task('archive-root',undefined,'completed','archive-only'),{...task('Old-child','archive-root','completed','archive-only'),archivedAt:stamp}];
family[0].input.permissionMode='workspace-write';
const runs=family.map(w=>({id:w.id+'-run',workflowId:w.id,projectPath:'C:/Synthetic',kind:'general',status:w.status==='queued'?'queued':w.status==='failed'?'failed':'running',route:{runtimeId:'fixture',model:'synthetic-model',effort:'low',kind:'general',reasons:[],warnings:[]},startedAt:stamp,output:'PUBLIC_PROGRESS '+w.id,reasoning:'PRIVATE_REASONING_MUST_NOT_RENDER',events:[]}));
const messages=family.flatMap(w=>[{id:w.id+'-input',conversationId:'a',workflowId:w.id,role:'user',content:w.input.content,createdAt:stamp},{id:w.id+'-reply',conversationId:'a',workflowId:w.id,role:'assistant',content:'MEMBER_REPLY '+w.id,createdAt:stamp}]);
const state={app:{version:'fixture'},projects:[project,{...project,id:'everyday',scope:'chat',name:'日常对话'}],conversations,conversationMessages:[],workflows:family,runs,runtimes:[],targets:[],approvals:[],plugins:[],settings:{}};
const calls=[];let failRead=false,failSend=false,delaySend=false,finishSend,failCreate=true,failArchive=false;const requests=new Map();window.fixture={state,calls,family,messages,runs,setFailRead:v=>failRead=v,setFailSend:v=>failSend=v,setDelaySend:v=>delaySend=v,finishSend:()=>finishSend(),setFailCreate:v=>failCreate=v,setFailArchive:v=>failArchive=v,task};
const api=async(path,body,method='POST')=>{calls.push({path,body,method});
 if(path==='/api/modes')return{catalog:[{id:'fixture.notes',title:'Notes Mod',version:'1.0.0',compatible:true}],installed:[]};
 if(path.endsWith('/delegation-parent'))return{workflow:family[0]};
 if(path.endsWith('/delegate')){if(failCreate)throw Error('Synthetic child creation rejected');if(requests.has(body.requestId))return{workflow:requests.get(body.requestId)};const parentId=decodeURIComponent(path.split('/')[3]),id='Manual-'+(requests.size+1),child=task(id,parentId,'completed');child.input={...child.input,permissionMode:'workspace-write',intentText:body.task};child.executionWorkspaceId='tree-'+id;child.executionWorkspaceMode='isolated';child.executionWorkspace={id:child.executionWorkspaceId,state:'ready',directory:'C:/Synthetic/worktrees/'+id,branch:'child/'+id,delivery:{status:'conflict',changedPaths:['src/fixture.ts'],reason:'Synthetic parent edit must be reconciled'}};family.push(child);requests.set(body.requestId,child);state.workflows=[...family];return{workflow:child};}
 if(path.endsWith('/delivery')){const child=family.find(w=>w.id===decodeURIComponent(path.split('/')[3]));child.executionWorkspace.delivery={...child.executionWorkspace.delivery,status:'applied',reason:'Synthetic receipt verified'};child.executionDeliveryWorkflowId=child.id;state.workflows=[...family];return{workflow:child};}
 if(path.endsWith('/archive')||method==='DELETE'){if(failArchive)throw Error('Synthetic child archive rejected');const id=decodeURIComponent(path.split('/')[3]),child=family.find(w=>w.id===id);if(!child?.delegation)throw Error('Synthetic fixture refuses parent mutation');const ids=new Set([id]),at=new Date().toISOString();for(let pass=0;pass<family.length;pass++)for(const item of family)if(ids.has(item.delegation?.parentId))ids.add(item.id);for(const item of family.filter(w=>ids.has(w.id))){item.updatedAt=at;if(method==='DELETE')item.deletedAt=at;else if(body.archived)item.archivedAt=at;else delete item.archivedAt;}state.workflows=[...family];conversations[0].workflowHistoryRevision=(conversations[0].workflowHistoryRevision??0)+1;conversations[0].delegationCount=family.filter(w=>w.delegation&&!w.archivedAt&&!w.deletedAt).length;conversations[0].archivedDelegationCount=family.filter(w=>w.delegation&&w.archivedAt&&!w.deletedAt).length;return method==='DELETE'?{ok:true}:{workflow:structuredClone(child)};}
 if(path.endsWith('/swarm')){if(failRead)throw Error('Synthetic snapshot unavailable');return{workflows:structuredClone(path.includes('/archive-only/')?archivedFamily:family),messages:[]};}
 if(path.endsWith('/execution-record')){const id=decodeURIComponent(path.split('/')[3]);return{workflow:family.find(w=>w.id===id),runs:runs.filter(r=>r.workflowId===id),relatedRuns:runs.filter(r=>r.workflowId!==id),relatedWorkflows:family,messages};}
 if(path.endsWith('/swarm-message')){if(failSend)throw Error('Synthetic delivery failed');if(delaySend)await new Promise(resolve=>finishSend=resolve);return{ok:true,delivery:'queued',workflowId:decodeURIComponent(path.split('/')[3])};}
 if(path.endsWith('/cancel')){const id=decodeURIComponent(path.split('/')[3]);family.find(w=>w.id===id).status='cancelled';state.workflows=[...family];return{ok:true};}
 if(method!=='GET')throw Error('Unexpected write '+path);
 const id=path.split('/')[3];return{conversation:conversations.find(c=>c.id===id)??conversations[0],messages,workflows:family,runs};
};
window.__backend={connection:'connected',state,reload:async()=>window.refreshStudio(),api};
if(!localStorage.getItem('agent-studio-conversation'))localStorage.setItem('agent-studio-conversation','a');
const root=createRoot(document.getElementById('root'));window.refreshStudio=()=>root.render(<><Studio/><ConfirmDialogHost/></>);void startInterfaceLanguage().finally(window.refreshStudio);
`,
      },
      bundle: true,
      outfile: join(fixture, 'fixture.js'),
      platform: 'browser',
      format: 'iife',
      loader: { '.png': 'dataurl', '.webp': 'dataurl' },
      plugins: [
        {
          name: 'synthetic-backend',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/App$/ }, (args) =>
              args.importer.endsWith('Studio.tsx') ? { path: 'backend', namespace: 'mock' } : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              contents:
                'export const useBackend=()=>window.__backend;export const ApprovalCard=()=>null,EmptyState=()=>null,HandoffModal=()=>null,RunOutput=()=>null,SettingsPage=()=>null,StatusPill=()=>null;export const dateLabel=x=>x,readableError=x=>String(x);',
            }));
          },
        },
      ],
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1200,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!d.url.startsWith('file://');if(cancel)remote++;cb({cancel});});
win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error(message);});await win.loadFile(path.join(__dirname,'index.html'));const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error('Renderer step: '+code,{cause:error});}};const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const wait=async code=>{for(let n=0;n<90;n++){await frame();if(await read(code))return;}throw Error('Not ready: '+code);};
const click=async selector=>{await read('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};const count=selector=>read('document.querySelectorAll('+JSON.stringify(selector)+').length');
// Wait for the actual panel size/theme: the first offscreen paint can still contain the previous layout.
const screenshot=async(name,selector='.delegation-detail .side-sheet')=>{
  const [width,height]=win.getContentSize();
  const expected=await read('(()=>{const sheet=document.querySelector('+JSON.stringify(selector)+'),rect=sheet.getBoundingClientRect();return {x:Math.floor(rect.left)+6,y:Math.floor(rect.top+rect.height/2),rgb:getComputedStyle(sheet).backgroundColor.match(/[0-9]+/g).slice(0,3).map(Number)};})()');
  const panelPixel=Buffer.from(expected.rgb).reverse();
  const png=await new Promise((resolve,reject)=>{
    let lastFrame='none';
    const cleanup=()=>{clearTimeout(timer);win.webContents.removeListener('paint',paint);};
    const paint=(_event,_dirtyRect,image)=>{
      const size=image.getSize();lastFrame=size.width+'x'+size.height;
      if(image.isEmpty()||size.width!==width||size.height!==height){win.webContents.invalidate();return;}
      const offset=(expected.y*width+expected.x)*4,pixel=image.toBitmap().subarray(offset,offset+3);
      lastFrame+=' panel BGR '+[...pixel].join(',');
      if(!pixel.equals(panelPixel)){win.webContents.invalidate();return;}
      cleanup();
      try{const bytes=image.toPNG();assert.ok(bytes.length>0,'empty screenshot: '+name);resolve(bytes);}catch(error){reject(error);}
    };
    const timer=setTimeout(()=>{cleanup();reject(new Error('No current offscreen frame for '+name+'; expected '+width+'x'+height+' panel BGR '+[...panelPixel].join(',')+', last '+lastFrame));},8000);
    win.webContents.on('paint',paint);win.webContents.invalidate();
  });
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},name),png);
};
const tree='.conversation-toolbar .delegation-tree-toggle';
await wait('!!document.querySelector('+JSON.stringify(tree)+')');
assert.equal(await count('.sidebar .delegation-tree-toggle'),0,'subagents never appear in sidebar');
assert.equal(await count('.conversation-lane-child'),2,'lane children remain nested');
assert.equal(await read('window.fixture.calls.filter(c=>c.path.endsWith("/swarm")).length'),0,'list loads lazily');
assert.match(await read('document.querySelector('+JSON.stringify(tree)+').textContent'),/2/);
assert.equal(await count('.delegation-running-dot'),1);
for(const [locale,theme,width] of [['en','dark',1280],['en','light',900],['zh-CN','dark',1280]]){
 await read('localStorage.setItem("comborunner.locale",'+JSON.stringify(locale)+')');await win.reload();
 await wait('!!document.querySelector('+JSON.stringify(tree)+')');
 win.setSize(width,900);await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();
 await fs.writeFile(path.join(${JSON.stringify(artifacts)},locale+'-'+theme+'-'+width+'-sidebar.png'),(await win.webContents.capturePage()).toPNG());
 await click(tree);await wait('document.querySelectorAll(".delegation-tree-popover [role=treeitem]").length===2');
 assert.ok((await read('document.querySelector(".delegation-tree-popover").textContent')).includes(locale==='en'?'Archived (42)':'\u5df2\u5f52\u6863 (42)'));
 assert.equal(await count('.delegation-tree-popover > button'),0,'creation stays in Collaboration');
 assert.equal(await read('document.querySelector(".delegation-tree-popover [role=tree] > :last-child").className'), 'delegation-tree-more');
 assert.equal(await count('.conversation-title-line .delegation-tree-toggle'),1);
 assert.equal(await read('Array.from(document.querySelectorAll(".conversation-toolbar button")).every(b=>getComputedStyle(b).whiteSpace==="nowrap")'),true);
 await fs.writeFile(path.join(${JSON.stringify(artifacts)},locale+'-'+theme+'-'+width+'-popover.png'),(await win.webContents.capturePage()).toPNG());
 await click('.delegation-tree-more[aria-expanded]');await wait('document.querySelectorAll(".delegation-tree-popover [role=treeitem]").length===44');
 await click('[data-member-id="Archived-0"] .delegation-member-more');await wait('!!document.querySelector(".context-menu")');
 assert.equal(await read('document.querySelector(".context-menu").textContent.includes('+JSON.stringify(locale==='en'?'Restore':'\u6062\u590d\u5b50\u4ee3\u7406')+')'),true);
}
// Running, waiting and settled children are ordered ahead of the archive, and only running lights the dot.
await read('window.fixture.family[1].status="completed";window.fixture.family[2].status="queued";window.fixture.family.push(window.fixture.task("Runner","root"));window.fixture.state.workflows=[...window.fixture.family];window.refreshStudio()');
await wait('document.querySelector(".delegation-tree-count")?.textContent==="3"');
assert.deepEqual(await read('Array.from(document.querySelectorAll(".delegation-tree-popover [role=treeitem]")).slice(0,3).map(x=>x.dataset.memberId)'),['Runner','Reviewer','Scout']);
assert.equal(await count('.delegation-running-dot'),1);
await read('window.fixture.family.at(-1).status="queued";window.fixture.state.workflows=[...window.fixture.family];window.refreshStudio()');await wait('!document.querySelector(".delegation-running-dot")');
await read('window.fixture.family.pop();window.fixture.family[1].status="running";window.fixture.family[2].status="running";window.fixture.state.workflows=[...window.fixture.family];window.refreshStudio()');
// The tree only browses recorded children; creation stays in Collaboration.
await click(tree);await click(tree);await wait('!!document.querySelector(".delegation-tree-popover")');
assert.equal(await count('.delegation-tree-popover > button'),0);
assert.equal(await read('window.fixture.calls.some(c=>c.path.endsWith("/delegation-parent"))'),false);
await read('localStorage.setItem("agent-studio-conversation","plain")');await win.reload();
await wait('document.querySelector(".conversation-toolbar strong")?.textContent==="Chat plain"');
// A chat that never delegated shows no empty subagent chip or panel.
assert.equal(await count(tree),0);
assert.equal(remote,0);console.log('PASS conversation popover');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const env = offscreenElectronEnv();
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS conversation popover/);
    const invalidRunner = join(fixture, 'invalid-runner.cjs');
    await writeFile(invalidRunner, 'const = ;', 'utf8');
    await assert.rejects(
      promisify(execFile)(createRequire(import.meta.url)('electron') as string, electronArgs(invalidRunner), {
        env,
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 10000,
      }),
      (error: Error & { code?: number; stderr?: string }) => error.code === 1 && /SyntaxError/.test(error.stderr ?? ''),
    );
  },
);
