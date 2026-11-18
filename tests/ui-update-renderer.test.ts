import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRenderer as build } from './helpers/renderer-build.ts';
import { electronArgs } from './helpers/electron-app.cjs';
import { buildSpendOverview } from '../src/server/spend-ledger.ts';
import { insightFixture, insightNow } from './helpers/usage-insights-fixture.ts';

test(
  'hidden UI update integration preserves real drafts, forms and in-flight requests',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-ui-update-')));
    const artifacts = resolve(process.env.USAGE_INSIGHTS_ARTIFACTS ?? join(tmpdir(), 'usage-insights'), 'ui-update');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-ui-update-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      stdin: {
        contents:
          '@import "./src/ui/studio.css"; @import "./src/ui/SwarmWorkspace.css"; @import "./src/ui/ConversationModeView.css"; @import "./src/ui/UiUpdateNotice.css";',
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      outfile: join(fixture, 'style.css'),
    });
    // The Spend page's ledger parts with no runs; the fixture adds its filter options.
    const emptySpend = buildSpendOverview({
      report: insightFixture({ range: '7d', kind: 'all' }, true).report,
      accounts: new Map(),
      workflows: [],
      projects: [],
      now: insightNow,
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import{insightFixture}from'./tests/helpers/usage-insights-fixture';import React from'react';import{createRoot}from'react-dom/client';import Studio from'./src/ui/Studio';import{useBackend}from'./src/ui/App';import{ModFormView}from'./src/ui/ConversationModeView';import{SwarmWorkspace}from'./src/ui/SwarmWorkspace';import{UiUpdateNotice}from'./src/ui/UiUpdateNotice';import{createUiUpdateCheck,editingUi,rejectedUiBuilds,failedUiBuildsKey}from'./src/ui/ui-update';import{uiUpdateBlocked,holdUiUpdate}from'./src/ui/ui-update-guard';
const emptySpend=${JSON.stringify(emptySpend)};
const stamp='2026-10-25T12:00:00Z';const project={id:'p',name:'Synthetic project',path:'C:/Synthetic',scope:'project',createdAt:stamp,updatedAt:stamp};const conversation={id:'a',projectId:'p',title:'Synthetic chat',createdAt:stamp,updatedAt:stamp};
const task=(id,parentId)=>({id,conversationId:'a',projectId:'p',userMessageId:id+'-input',input:{content:'Synthetic task',mode:'chat',permissionMode:'read-only',executionPolicy:'cli-only'},status:'running',phase:'execute',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp,...(parentId?{delegation:{parentId,requestId:id,role:'worker',agent:{label:'Synthetic member'}}}:{})});const workflows=[task('root'),task('member','root')];
const state={app:{version:'fixture'},projects:[project],conversations:[conversation],conversationMessages:[],workflows,runs:[],runtimes:[],targets:[{id:'fixture-target',label:'Synthetic target',provider:'codex',enabled:false,environment:'native',command:'unused'}],approvals:[],plugins:[],settings:{}};
let finishWrite,finishParse;let posts=0;const calls=[];const candidate={enabled:true,buildId:'ui-next',compatibility:'same'};
window.fetch=async(path,options={})=>{calls.push({path,method:options.method??'GET'});if(path==='/api/session')return{ok:true,json:async()=>({token:'synthetic-token'})};if(path==='/api/state')return{ok:true,json:async()=>state};if(path==='/api/ui-release')return{ok:true,json:async()=>candidate};if(path==='/api/synthetic-write'){posts++;return await new Promise(resolve=>finishWrite=()=>resolve({ok:true,json:()=>new Promise(resolve=>finishParse=()=>resolve({ok:true}))}));}throw Error('Unexpected fetch '+path);};window.EventSource=class{static CLOSED=2;constructor(){this.readyState=2;window.fakeEvents=this}addEventListener(){}close(){this.closed=true}};
const api=async(path,body,method='POST')=>{if(path==='/api/modes')return{catalog:[],installed:[]};if(path==='/api/accounts')return{accounts:[]};if(path.startsWith('/api/usage/spend')){const url=new URL(path,'http://fixture.test'),query=url.searchParams;const insights={...emptySpend.insights,...insightFixture({range:query.get('range')??'7d',kind:query.get('kind')??'all',project:query.get('project')??'',runtime:query.get('runtime')??''},true)};if(url.pathname.endsWith('/details'))return{query:{range:query.get('range'),kind:'all',billing:'all',group:query.get('group'),offset:0,limit:20},interval:insights.interval,report:insights.report,tasks:[],projects:[],total:0,offset:0,limit:20};return{...emptySpend,insights,options:{projects:['C:/Synthetic'],runtimes:[{id:'fixture-target',label:'Synthetic target'}],accounts:[]}};}if(path.endsWith('/swarm'))return{workflows,messages:[]};if(path.endsWith('/execution-record'))return{workflow:workflows[0],runs:[],relatedRuns:[],messages:[]};return{conversation,messages:[],workflows,runs:[]};};
window.__backend={connection:'connected',state,reload:async()=>{},api};
const originalInterval=window.setInterval.bind(window);let poll;window.setInterval=(fn,ms,...args)=>ms===10000?(poll=fn,12345):originalInterval(fn,ms,...args);let clock=Date.now();Date.now=()=>clock;
const root=createRoot(document.getElementById('root'));let view='empty';const mod={binding:{modeId:'fixture.notes',version:'1',instanceId:'i'},pending:null,installed:true,instance:{id:'i',conversationId:'a',modeId:'fixture.notes',version:'1',schemaVersion:1,revision:0,state:{note:''},createdAt:stamp,updatedAt:stamp},manifest:{schemaVersion:2,id:'fixture.notes',title:'Synthetic notes',version:'1',description:'test',contributions:{rightPanel:{kind:'form',form:{fields:[{id:'note',label:'Note',type:'textarea'}],actions:[{id:'save',label:'Save',type:'save'}]}}}}};
function ApiProbe(){window.backend=useBackend();return null;}
const render=next=>{view=next;root.render(next==='studio'?<Studio/>:next==='member'?<SwarmWorkspace state={state} conversation={conversation} api={api} reload={async()=>{}} notify={()=>{}} onInspect={()=>{}} selectedMemberId="member" onSelectMember={()=>{}}/>:next==='mod'?<ModFormView view={mod} busy={false} onSave={async()=>{}} onCompose={()=>{}} onStore={()=>{}}/>:next==='api'?<ApiProbe/>:next==='notice'?<UiUpdateNotice/>:<div>Safe idle fixture</div>);};
localStorage.setItem('agent-studio-conversation','a');localStorage.setItem('comborunner.locale','zh-CN');
window.fixture={state,render,blocked:uiUpdateBlocked,editing:()=>editingUi(document),calls,posts:()=>posts,finishWrite:()=>finishWrite(),finishParse:()=>finishParse(),hold:holdUiUpdate,poll:async()=>{clock+=3000;await poll?.()},failedUiBuildsKey,rejected:()=>rejectedUiBuilds(sessionStorage),newCheck:()=>{const activations=[];const check=createUiUpdateCheck({buildId:'ui-current',compatibility:'same',readStatus:async()=>candidate,rejected:()=>rejectedUiBuilds(sessionStorage),blocked:uiUpdateBlocked,activate:id=>activations.push(id),pending:()=>{}});return{check,activations};}};render('studio');
`,
      },
      bundle: true,
      outfile: join(fixture, 'fixture.js'),
      platform: 'browser',
      format: 'iife',
      loader: { '.png': 'dataurl', '.webp': 'dataurl' },
      define: {
        __PUGPORT_UI_BUILD_ID__: JSON.stringify('ui-current'),
        __PUGPORT_UI_COMPATIBILITY__: JSON.stringify('same'),
      },
      plugins: [
        {
          name: 'synthetic-studio',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/App$/ }, (args) =>
              args.importer.endsWith('Studio.tsx') ? { path: 'backend', namespace: 'mock' } : undefined,
            );
            builder.onResolve({ filter: /^\.\/Workspace$/ }, (args) =>
              args.importer.endsWith('Studio.tsx') ? { path: 'workspace', namespace: 'mock' } : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
              contents:
                args.path === 'workspace'
                  ? 'export const ConversationWorkspace=props=>{window.studioComposer=props.composerSession;return null};export const MemoryDialog=()=>null,ProjectDialog=()=>null;'
                  : 'export const useBackend=()=>window.__backend;export const ApprovalCard=()=>null,EmptyState=()=>null,HandoffModal=()=>null,RunOutput=()=>null,SettingsPage=()=>null,StatusPill=()=>null;export const dateLabel=x=>x,readableError=x=>String(x);',
            }));
          },
        },
      ],
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1100,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!d.url.startsWith('file://');if(cancel)remote++;cb({cancel});});win.webContents.on('console-message',(_e,l,m)=>{if(l>=2)console.error(m)});
await win.loadFile(path.join(__dirname,'index.html'));const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error('Renderer step: '+code,{cause:error})}};const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const wait=async code=>{for(let n=0;n<70;n++){await frame();if(await read(code))return;}throw Error('Not ready: '+code)};const show=async name=>{await read('window.fixture.render('+JSON.stringify(name)+')');await frame()};const blocked=()=>read('window.fixture.blocked()');
await wait('!!window.studioComposer');assert.equal(await blocked(),false,'running tasks alone allow update');
for(const draft of ['{content:"Unsent text",attachments:[],quotes:[]}','{content:"",attachments:[{id:"f",file:new File(["synthetic"],"synthetic.txt",{type:"text/plain"})}],quotes:[]}','{content:"",attachments:[],quotes:[{id:"q",text:"Quoted synthetic text",note:"Unsent note"}]}']){
await read('window.studioComposer.changeDraft("conversation:a",()=>('+draft+'))');await frame();assert.equal(await blocked(),true);await read('window.checkState=window.fixture.newCheck();window.checkState.check()');assert.deepEqual(await read('window.checkState.activations'),[]);await read('window.studioComposer.changeDraft("conversation:a",()=>({content:"",attachments:[],quotes:[]}))');await frame();assert.equal(await blocked(),false);}
await read('window.fixture.state.conversations[0].incognito=true;window.fixture.render("studio")');await frame();assert.equal(await blocked(),true);await read('delete window.fixture.state.conversations[0].incognito;window.fixture.render("studio")');await frame();assert.equal(await blocked(),false);
await read('[...document.querySelectorAll(".nav-item")].find(button=>button.textContent.includes("用量与连接")).click()');await wait('!!document.querySelector(".usage-accounts")');assert.equal(await blocked(),false,'read-only usage dashboard permits an update');assert.equal(await read('sessionStorage.getItem("pugport-ui-page")'),'resources');
await read('window.studioComposer.changeDraft("conversation:a",()=>({content:"Hidden composer draft",attachments:[{id:"f",file:new File(["test"],"test.txt")}],quotes:[{id:"q",text:"Quoted text",note:"Unsent note"}]}))');await frame();assert.equal(await blocked(),true,'hidden composer drafts still protect usage navigation');await read('window.studioComposer.changeDraft("conversation:a",()=>({content:"",attachments:[],quotes:[]}))');await frame();assert.equal(await blocked(),false);
await read('window.savedStorageDescriptor=Object.getOwnPropertyDescriptor(window,"sessionStorage");void Object.defineProperty(window,"sessionStorage",{configurable:true,get(){throw Error("Synthetic storage denial")}})');assert.equal(await blocked(),true,'usage cannot reload without restorable navigation');await read('void Object.defineProperty(window,"sessionStorage",window.savedStorageDescriptor)');assert.equal(await blocked(),false);
await read('sessionStorage.setItem("pugport-ui-page","unknown")');assert.equal(await blocked(),true,'corrupt stored page does not authorize update');await read('sessionStorage.setItem("pugport-ui-page","resources");window.usageCheck=window.fixture.newCheck();window.usageCheck.check()');await read('window.usageCheck.check()');assert.deepEqual(await read('window.usageCheck.activations'),['ui-next'],'clean dashboard activates exactly once');
const select=async(label,value)=>{await read('(()=>{const e=document.querySelector("select[aria-label="+'+JSON.stringify(label)+'+"]");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame()};
await read('[...document.querySelectorAll(".page-tabs button")].find(button=>button.textContent==="消耗").click()');await wait('!!document.querySelector(".spend-health > details")');
await read('document.querySelector(".spend-health > details > summary").click()');await frame();assert.equal(await blocked(),true,'expanded details wait for the user before a UI update');await read('document.querySelector(".spend-health > details > summary").click()');await frame();assert.equal(await blocked(),false);
await read('window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===sessionStorage)throw Error("Synthetic write-only denial");return window.originalStorageSet.call(this,key,value)};void 0');await select('用量项目范围','C:/Synthetic');assert.equal(await blocked(),true,'unsaved usage filter prevents an update when writes alone fail');await read('Storage.prototype.setItem=window.originalStorageSet;void 0');await select('用量执行器范围','fixture-target');await read('[...document.querySelectorAll(".insight-segmented button")].find(button=>button.textContent==="30d").click()');await frame();await read('[...document.querySelectorAll(".insight-details-heading .insight-segmented button")].find(button=>button.textContent.startsWith("按项目")).click()');await frame();assert.equal(await blocked(),false);assert.deepEqual(await read('JSON.parse(sessionStorage.getItem("pugport-usage-selection"))'),['usage','expanded','C:/Synthetic','fixture-target','30d','project','all','all','']);
const reload=async()=>{const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await loaded;await frame()};await reload();await wait('!!document.querySelector(".spend-health > details")');assert.equal(await read('document.querySelector(".page-tabs [aria-selected=true]").textContent'),'消耗','actual reload returns to usage');assert.deepEqual(await read('[...document.querySelectorAll(".insight-filters select")].map(e=>e.value)'),['C:/Synthetic','fixture-target']);assert.match(await read('document.querySelector(".insight-details-heading [aria-pressed=true]").textContent'),/^按项目/);assert.equal(await read('document.querySelector(".insight-filters .insight-filter:first-child [aria-pressed=true]").textContent'),'30d');assert.equal(await blocked(),false);
await fs.writeFile(path.join(${JSON.stringify(artifacts)},'restored-filtered-usage.png'),(await win.webContents.capturePage()).toPNG());
await read('window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===sessionStorage)throw Error("Synthetic write-only denial");return window.originalStorageSet.call(this,key,value)};document.querySelector(".studio-brand").click();void 0');await wait('!!window.studioComposer');assert.equal(await read('sessionStorage.getItem("pugport-ui-page")'),'spend');assert.equal(await blocked(),true,'workspace cannot reload into a readable stale resources marker');await read('window.stalePageCheck=window.fixture.newCheck();window.stalePageCheck.check()');assert.deepEqual(await read('window.stalePageCheck.activations'),[]);await read('Storage.prototype.setItem=window.originalStorageSet;[...document.querySelectorAll(".nav-item")].find(button=>button.textContent.includes("用量与连接")).click();void 0');await wait('!!document.querySelector(".usage-accounts")');assert.equal(await blocked(),false);
await read('history.replaceState({},"","?view=conversation&id=a")');await reload();await wait('!!window.studioComposer');assert.equal(await read('!!document.querySelector(".usage-accounts")'),false,'popout remains a chat');assert.equal(await read('sessionStorage.getItem("pugport-ui-page")'),'resources','popout does not overwrite main navigation');await read('history.replaceState({},"",location.pathname)');await reload();await wait('!!document.querySelector(".usage-accounts")');
await read('[...document.querySelectorAll(".page-tabs [role=tab]")].find(button=>button.textContent==="连接").click()');await frame();assert.equal(await blocked(),true,'editable account page remains blocked');await read('[...document.querySelectorAll(".nav-item")].find(button=>button.textContent==="设置").click()');await frame();assert.equal(await blocked(),true,'settings remain blocked');
await show('empty');await read('sessionStorage.setItem("pugport-ui-page","unknown")');await show('studio');await wait('!!window.studioComposer');assert.equal(await read('!!document.querySelector(".usage-accounts")'),false,'unknown stored page safely restores workspace');assert.equal(await blocked(),false);
await show('member');await wait('!!document.querySelector("textarea")');await read('(()=>{const e=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"Unsent member follow-up");e.dispatchEvent(new Event("input",{bubbles:true}));e.blur()})()');await frame();assert.equal(await blocked(),true,'member draft blocks even after blur');
await show('mod');await wait('!!document.querySelector("textarea")');assert.equal(await blocked(),false);await read('(()=>{const e=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"Unsaved Mod value");e.dispatchEvent(new Event("input",{bubbles:true}));e.blur()})()');await frame();assert.equal(await blocked(),true,'dirty Mod blocks without focused input');
await show('api');await wait('!!window.backend?.state');assert.equal(await blocked(),false);const sessions=await read('window.fixture.calls.filter(c=>c.path==="/api/session").length');await read('window.fakeEvents.onerror()');assert.equal(await read('window.fakeEvents.closed'),true);await new Promise(r=>setTimeout(r,5200));assert.ok(await read('window.fixture.calls.filter(c=>c.path==="/api/session").length')>sessions,'closed event stream initializes again');await read('void(window.pendingWrite=window.backend.api("/api/synthetic-write",{value:"synthetic"}))');
assert.equal(await blocked(),true,'POST blocks while response pending');await read('window.fixture.finishWrite()');await frame();assert.equal(await blocked(),true,'POST remains protected through JSON parsing');await read('window.fixture.finishParse()');await read('window.pendingWrite');assert.equal(await blocked(),false);
await show('empty');await read('sessionStorage.setItem(window.fixture.failedUiBuildsKey,JSON.stringify(["ui-next"]));window.failedCheck=window.fixture.newCheck();window.failedCheck.check()');assert.deepEqual(await read('window.failedCheck.activations'),[]);await read('sessionStorage.removeItem(window.fixture.failedUiBuildsKey);window.safeCheck=window.fixture.newCheck();window.safeCheck.check();');await read('window.safeCheck.check()');assert.deepEqual(await read('window.safeCheck.activations'),['ui-next']);
await read('void(window.stopUpdate=window.fixture.hold())');await show('notice');await read('window.fixture.poll()');await wait('!!document.querySelector(".ui-update-notice")');assert.equal(await read('location.search'),'', 'blocked status poll never navigates');await fs.writeFile(path.join(${JSON.stringify(artifacts)},'pending-safe-update.png'),(await win.webContents.capturePage()).toPNG());await show('empty');await read('window.stopUpdate()');assert.equal(await blocked(),false);assert.equal(remote,0);assert.equal(await read('window.fixture.calls.some(c=>c.path.includes("/cancel")||c.path.includes("/restart"))'),false);
console.log('PASS composer text/files/quotes, incognito, member draft, Mod dirty state, real API write/parsing, failed build exclusion, one clean activation and pending notice');
}catch(error){console.error(error);process.exitCode=1}finally{win?.destroy();app.exit(process.exitCode||0)}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      process.env.USAGE_INSIGHTS_ELECTRON ?? (createRequire(import.meta.url)('electron') as string),
      electronArgs(runner),
      {
        env,
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS composer text\/files\/quotes/);
  },
);
