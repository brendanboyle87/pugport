import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'usage activity opens the exact tasks, stays still and respects reduced motion in both views',
  { timeout: 90000 },
  async (t) => {
    const root = resolve('.design');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'activity-renderer-'));
    t.after(async () => {
      assert.equal(dirname(directory), root);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = join(root, 'shots');
    await mkdir(screenshots, { recursive: true });
    await mkdir(join(directory, 'home'));
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {UsagePage} from './src/ui/UsagePage';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
const locale = new URLSearchParams(location.search).get('locale') || 'en';
localStorage.setItem('comborunner.locale', locale);
sessionStorage.clear();localStorage.removeItem('pugport-usage-view');
document.documentElement.dataset.theme = locale === 'en' ? 'dark' : 'light';
const now=Date.parse('2026-10-28T12:00:00Z'),stamp=new Date(now-120000).toISOString();
const runtime=(id,label,provider='codex')=>({id,label,provider,environment:'native',installed:true,status:'ready',models:[],capabilities:{execute:true,resume:true,cancel:true,approvals:true},refreshedAt:stamp,subscription:{label:'Pro',source:'fixture',observedAt:stamp},quota:{status:'known',source:'fixture',observedAt:stamp,windows:[{id:'weekly',label:'每周额度',durationMinutes:10080,usedPercent:25,resetsAt:'2026-11-01T12:00:00Z'}]}});
const flows=['first','second','wait'].map((id,index)=>({id,conversationId:id,projectId:'project',status:index===2?'waiting-approval':'running',phase:index===0?'plan':'execute',input:{},runIds:[id],createdAt:stamp,updatedAt:stamp}));
const runs=flows.map((flow,index)=>({id:flow.id,workflowId:flow.id,status:index===2?'waiting-approval':'running',route:{runtimeId:index===2?'codex':'api-anthropic',model:'fixture'},startedAt:stamp,events:[]}));
const state={app:{name:'PugPort',version:'fixture'},settings:{maxQuotaAgeSeconds:600},targets:[],runtimes:[runtime('codex','Codex · 本机'),runtime('codex-work','Codex Work'),runtime('claude','Claude')],apiProviders:[{targetId:'api-anthropic',preset:'anthropic',label:'Anthropic',enabled:true,currency:'USD',budget:{policy:{limitUsd:200,startedAt:stamp,expiresAt:'2026-12-01T00:00:00Z'},spentUsd:20,remainingUsd:180,reservedUsd:0,unreportedRuns:0}}],runs,workflows:flows,projects:[],conversations:flows.map((f,index)=>({id:f.id,title:['Review the workspace','设置','Waiting for approval'][index],projectId:'project',createdAt:stamp,updatedAt:stamp})),conversationMessages:[],approvals:[],plugins:[],refreshing:false};
const agents=['grok-bot','muse'].map((id,index)=>({id,name:index?'Muse':'Grok Bot',kind:index?'web':'handoff',available:true,enabled:true,added:true,quota:{status:'known',source:'fixture',observedAt:stamp,windows:[{id:'weekly',label:'每周额度',durationMinutes:10080,usedPercent:40,resetsAt:'2026-11-01T12:00:00Z'}]}}));
const f=window.fixture={opened:[],errors:[],calls:[]};
window.addEventListener('error',event=>f.errors.push(String(event.error||event.message)));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
const api=async(path)=>{f.calls.push(path);if(path==='/api/external-agents')return {agents};if(path.startsWith('/api/devices'))return {devices:[]};if(path.startsWith('/api/remote-servers'))return {servers:[]};throw Error('Unexpected fixture API '+path);};
const root=createRoot(document.getElementById('root'));
window.renderFixture=()=>flushSync(()=>root.render(<UsagePage state={state} api={api} now={now} refreshing={false} refresh={async()=>{}} notify={()=>{}} onInspect={()=>{}} onConversation={id=>f.opened.push(id)}/>));
window.idle=()=>{state.runs=[];state.workflows=[];window.renderFixture();};
window.restore=()=>{state.runs=runs;state.workflows=flows;window.renderFixture();};
window.external=()=>{state.conversationMessages=[{id:'external',conversationId:'first',createdAt:stamp,externalAgent:{agentId:'muse',name:'Not used for identity',status:'working'}}];window.renderFixture();};
window.authError=()=>{state.runtimes[0].status='auth-required';window.renderFixture();};
void startInterfaceLanguage().then(()=>{window.renderFixture();f.ready=true;});`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0;overflow:auto}#root{max-width:1240px;margin:auto;padding:24px;display:grid;gap:16px}</style></head><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let win;const network=[];
const evaluate=source=>win.webContents.executeJavaScript(source);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const wait=async(source)=>{for(let i=0;i<150;i++){if(await evaluate(source))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+source);};
const click=async(selector)=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
const status=id=>'[data-runtime-id="'+id+'"] .executor-activity';
const label=id=>evaluate('document.querySelector('+JSON.stringify(status(id))+').innerText');
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await evaluate('Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})))');await fs.writeFile(path.join(SHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG());};
void app.whenReady().then(async()=>{
try{
win=new BrowserWindow({show:false,width:1280,height:1050,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
win.webContents.setWindowOpenHandler(()=>{network.push('window.open');return {action:'deny'};});
await win.loadFile(path.join(__dirname,'index.html'),{query:{locale:'en'}});
await wait('window.fixture?.ready && document.querySelectorAll(".executor-activity").length===6');await frame();
assert.equal(await label('api-anthropic'),'Running · 2');assert.equal(await label('codex'),'Waiting · 1');assert.equal(await label('codex-work'),'Ready');
assert.equal(await evaluate('document.querySelectorAll(".executor-activity.running").length'),1);
assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-runtime-id=codex] .runtime-dot")).animationName'),'none');
const geometry=await evaluate('[...document.querySelectorAll(".quota-card")].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})');
await shot('english-dark-1280');
await click(status('api-anthropic'));
assert.equal(await evaluate('document.querySelectorAll("[role=menuitem]").length'),2);
assert.match(await evaluate('document.querySelector("[role=menu]").innerText'),/Review the workspace[\s\S]*Breaking down[\s\S]*2m 00s[\s\S]*设置/);
assert.equal(await evaluate('document.querySelector(".quota-zoom-backdrop")'),null);
await shot('active-tasks-1280');
await click('[role=menuitem]');assert.deepEqual(await evaluate('window.fixture.opened'),['first']);
await evaluate('window.idle()');await frame();assert.equal(await label('api-anthropic'),'Ready');
assert.deepEqual(await evaluate('[...document.querySelectorAll(".quota-card")].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})'),geometry);
await click(status('api-anthropic'));assert.equal(await evaluate('document.querySelector("[role=menuitem]").disabled'),true);
await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await frame();
await evaluate('window.restore()');await frame();
win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
assert.equal(await evaluate('getComputedStyle(document.querySelector(".executor-activity.running .runtime-dot")).animationName'),'none');
await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
assert.equal(await evaluate('getComputedStyle(document.querySelector(".executor-activity.running .runtime-dot")).animationName'),'executor-pulse');
// The usage page has one view now; its status labels and exact task links are checked there.
assert.equal(await label('api-anthropic'),'Running · 2');assert.equal(await label('codex'),'Waiting · 1');
await click(status('codex'));assert.equal(await evaluate('document.querySelectorAll("[role=menuitem]").length'),1);
assert.equal(await evaluate('document.querySelector(".quota-zoom-backdrop")'),null);
await click('[role=menuitem]');assert.deepEqual(await evaluate('window.fixture.opened'),['first','wait']);
assert.equal(await evaluate('document.querySelector(".quota-zoom-backdrop")'),null,'a task click never opens the enclosing quota card');
await click(status('codex'));
await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await frame();
assert.equal(await evaluate('document.activeElement.matches("[data-runtime-id=codex] .executor-activity")'),true);
await evaluate('window.authError()');await frame();assert.equal(await evaluate('document.querySelector("[data-runtime-id=codex] .executor-activity").classList.contains("error")'),true);
await evaluate('window.external()');await frame();assert.equal(await label('muse'),'Running · 1');await click(status('muse'));await click('[role=menuitem]');assert.deepEqual(await evaluate('window.fixture.opened'),['first','wait','first']);
assert.deepEqual(await evaluate('window.fixture.errors'),[]);
await win.loadFile(path.join(__dirname,'index.html'),{query:{locale:'zh-CN'}});await wait('window.fixture?.ready && document.querySelectorAll(".executor-activity").length===6');await frame();
assert.equal(await label('api-anthropic'),'运行中 · 2');assert.equal(await label('codex'),'等待中 · 1');
await shot('chinese-light-1280');
assert.deepEqual(await evaluate('window.fixture.errors'),[]);assert.deepEqual(network,[]);assert.equal(win.isVisible(),false);
console.log('PASS executor activity renderer: statuses, exact list, navigation, geometry, keyboard, errors, compact, external, reduced motion, English/dark and Chinese/light; 0 network requests');app.exit(0);
}catch(error){console.error(error);if(win)console.error(await evaluate('JSON.stringify({body:document.body.innerText,errors:window.fixture?.errors,calls:window.fixture?.calls})').catch(()=>''));app.exit(1);}
});`.replaceAll('SHOTS', JSON.stringify(screenshots)),
    );
    const env: NodeJS.ProcessEnv = {
      HOME: join(directory, 'home'),
      USERPROFILE: join(directory, 'home'),
      PUGPORT_UNDER_TEST: '1',
    };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP'])
      if (process.env[key]) env[key] = process.env[key];
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      {
        env,
        windowsHide: true,
        timeout: 75000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS executor activity renderer/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
