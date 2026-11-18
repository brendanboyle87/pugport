import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { offscreenElectronEnv, offscreenRequirePath } from './helpers/offscreen-electron.cjs';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'API account budgets stay visible, update after edits and expire without provider requests',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-api-budget-ui-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-api-budget-ui-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve('artifacts/api-budget-autosave');
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
import {ExecutorsPage} from './src/ui/Executors';
import {NoticeToast} from './src/ui/Studio';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {uiUpdateBlocked} from './src/ui/ui-update-guard';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
import './src/ui/settings.css';
import './src/ui/ExternalAgents.css';
document.documentElement.dataset.theme='dark';
// The components render their Simplified Chinese source text; dates follow the same language, not the machine's.
localStorage.setItem('comborunner.locale','zh-CN');
window.fixture={calls:[],errors:[],notices:[],now:Date.parse('2026-11-20T12:00:00Z'),ticks:[]};
const f=window.fixture;
window.uiUpdateBlocked=uiUpdateBlocked;
Date.now=()=>f.now;
const interval=window.setInterval;
window.setInterval=(fn,delay,...args)=>{if(delay===30000)f.ticks.push(fn);return interval(fn,delay,...args);};
window.addEventListener('error',event=>f.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
window.fetch=()=>{throw Error('Unexpected real fetch');};
window.open=()=>{throw Error('Unexpected external window');};
const budget=(limit,spent,reserved,expiresAt)=>({policy:{limitUsd:limit,expiresAt,perRunUsd:1,maxConcurrentRuns:1,burstConcurrentRuns:4,preferExpiring:true,startedAt:'2026-11-01T00:00:00Z'},spentUsd:spent,reservedUsd:reserved,remainingUsd:limit-spent-reserved,unreportedRuns:reserved?1:0,phase:'normal',maxConcurrentRuns:1});
const providers=[
 {targetId:'anthropic-work',preset:'anthropic',label:'Anthropic Work',enabled:true,keyHint:'…synthetic',currency:'USD',console:'https://console.anthropic.com',budget:budget(20,5,1,'2026-12-20T12:00:00Z')},
 {targetId:'custom-work',preset:'custom-api',label:'Custom Work',enabled:true,keyHint:'…synthetic',currency:'USD',console:'',connection:{protocol:'openai-responses',baseUrl:'https://synthetic.example.test/v1',model:'synthetic',price:{input:1,output:2}},budget:budget(50,45,0)},
 {targetId:'deepseek-work',preset:'deepseek',label:'DeepSeek Work',enabled:true,keyHint:'…synthetic',currency:'CNY',console:'https://platform.deepseek.com',budget:budget(100,20,0,'2026-11-20T12:00:20Z'),balance:{observedAt:'2026-11-20T12:00:00Z',amounts:[{currency:'CNY',total:300}]}},
 {targetId:'no-limit',preset:'anthropic',label:'No limit',enabled:true,keyHint:'…synthetic',currency:'USD',console:'https://console.anthropic.com'}
];
const state={app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'synthetic'},settings:{refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,toolApprovalMode:'auto',executionPolicy:'cli-first',unknownQuotaPolicy:'manual-only',maxConcurrentRuns:1},targets:providers.map(p=>({id:p.targetId,provider:'pi',gateway:'api',apiProvider:p.preset,label:p.label,enabled:true})),runtimes:[{id:'codex-fixture',label:'Codex Work',authMode:'chatgpt',subscription:{label:'Pro'},provider:'codex',status:'ready',quota:{windows:[]}}],runs:[],projects:[],conversations:[],workflows:[],conversationMessages:[],approvals:[],plugins:[],apiProviders:providers,refreshing:false,usage:{byRuntime:providers.map(p=>({runtimeId:p.targetId,runs:1,totalTokens:1000,estimatedCostUsd:p.targetId==='no-limit'?null:2}))}};
const api=async(path,body,method)=>{
 f.calls.push({path,body:structuredClone(body),method:method||(body?'POST':'GET')});
 if(path==='/api/accounts')return {providers:[],accounts:[]};
 if(path==='/api/external-agents')return {agents:[]};
 const match=path.match(/^\/api\/api-providers\/([^/]+)\/budget$/);
 if(match&&method==='PUT'){
  if(f.failNextBudget){const reason=f.failNextBudget;f.failNextBudget=undefined;if(reason==='busy'||reason==='busy-already-idle'){if(reason==='busy')f.reloadFailure=true;else f.refreshIdle=true;throw Error('请等这个 API 的运行结束后再修改预算。');}throw Error(reason);}
  if(f.deferNextBudget){f.deferNextBudget=false;await new Promise(resolve=>{f.finishBudget=resolve;});}
  const provider=state.apiProviders.find(p=>p.targetId===decodeURIComponent(match[1]));
  const previous=body?.reset?budget(body.limitUsd,0,0,body.expiresAt):provider.budget??budget(body?.limitUsd,0,0,body?.expiresAt);
  provider.budget=body?{...previous,policy:{startedAt:previous.policy.startedAt,...body},remainingUsd:body.limitUsd-previous.spentUsd-previous.reservedUsd}:undefined;
  return {ok:true};
 }
 throw Error('Unexpected fixture API '+path);
};
const root=createRoot(document.getElementById('root'));
const reload=async()=>{f.reloads=(f.reloads||0)+1;if(f.reloadFailure){f.reloadFailure=false;throw Error('synthetic refresh failed');}if(f.refreshIdle){f.refreshIdle=false;state.runs=[];}window.renderFixture();};
const notify=notice=>{f.notices.push(notice);f.notice=notice;window.renderFixture();};
window.renderFixture=()=>flushSync(()=>root.render(<>{!f.hidden&&<ExecutorsPage state={state} api={api} reload={reload} refresh={reload} refreshing={false} notify={notify}/>}<ConfirmDialogHost/>{f.notice&&<NoticeToast notice={f.notice} state={state} onClose={()=>{f.notice=null;queueMicrotask(()=>window.renderFixture());}}/>}</>));
window.spend=()=>{const p=state.apiProviders[0];p.budget={...p.budget,spentUsd:10,remainingUsd:9};window.renderFixture();};
window.advance=()=>{f.now+=30000;f.ticks.forEach(tick=>tick());};
window.addBudget=()=>{state.apiProviders[3].budget=budget(10,2,0,'2026-12-01T12:00:00Z');window.renderFixture();};
window.addAccount=()=>{const p={...providers[0],targetId:'new-account',label:'New Work',budget:budget(30,0,0)};state.apiProviders.push(p);state.targets.push({id:p.targetId,provider:'pi',gateway:'api',apiProvider:p.preset,label:p.label,enabled:true});window.renderFixture();};
window.busy=value=>{state.runs=value?[{id:'synthetic-run',status:'running',route:{runtimeId:'anthropic-work'}}]:[];window.renderFixture();};
window.finishRun=()=>{state.runs=state.runs.map(run=>({...run,status:'completed'}));window.renderFixture();};
window.showDuplicateAnthropic=()=>{state.apiProviders=[{...providers[0],targetId:'api-anthropic',label:'Anthropic',budget:budget(200,3,0,'2027-01-01T12:00:00Z')},{...providers[0],targetId:'api-anthropic-2',label:'Anthropic Work',budget:undefined}];state.targets=state.apiProviders.map(p=>({id:p.targetId,provider:'pi',gateway:'api',apiProvider:p.preset,label:p.label,enabled:true}));f.originalBudget=structuredClone(state.apiProviders[0].budget);window.renderFixture();};
window.monthly=()=>{window.navigate(true);f.now=Date.parse('2026-10-31T12:00:00Z');const p=state.apiProviders[0];p.preset='openai';p.label='OpenAI';const expiry=new Date('2026-11-12T00:00').toISOString();p.budget={...budget(84,0,0,expiry),policy:{...budget(84,0,0,expiry).policy,monthlyUsd:200}};window.navigate(false);};
window.navigate=value=>{f.hidden=value;window.renderFixture();};
window.budgets=()=>state.apiProviders.map(p=>({targetId:p.targetId,budget:p.budget}));
window.renderFixture();f.ready=true;`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'file', '.png': 'dataurl', '.webp': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}body{margin:0;overflow:auto}#root{max-width:920px;margin:auto;padding:20px;display:grid;gap:16px}</style></head><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
require(${JSON.stringify(offscreenRequirePath)});
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let win;const network=[];
const evaluate=source=>win.webContents.executeJavaScript(source).catch(error=>{console.error('Failed evaluation:',source);throw error;});
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const wait=async(source)=>{for(let i=0;i<600;i++){if(await evaluate(source))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+source);};
const click=async(selector)=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
const fill=async(selector,value)=>{await evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};
const idle=()=>wait('document.querySelector(".exec-row fieldset")?.getAttribute("aria-busy")==="false"');
const puts=()=>evaluate('window.fixture.calls.filter(call=>call.method==="PUT").length');
// Hidden windows do not dispatch native focus events; exercise React's bubbling blur event explicitly.
const blur=async()=>{await evaluate('document.activeElement.dispatchEvent(new FocusEvent("focusout",{bubbles:true}));document.activeElement.blur()');await frame();await idle();};
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await evaluate('Promise.all(document.getAnimations().filter(animation=>Number.isFinite(animation.effect.getComputedTiming().endTime)).map(animation=>animation.finished.catch(()=>{})))');await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG());};
void app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({show:false,width:1100,height:1050,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
  win.webContents.setWindowOpenHandler(()=>{network.push('window.open');return {action:'deny'};});
  await win.loadFile(path.join(__dirname,'index.html'));await wait('window.fixture?.ready===true');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".exec-row").length'),4);
  assert.equal(await evaluate('document.querySelectorAll(".exec-row .exec-body").length'),0);
  assert.equal(await evaluate('document.querySelectorAll(".exec-row [role=progressbar]").length'),3);
  for(const [index,value] of [[0,70],[1,10],[2,80]]){
   assert.equal(await evaluate('document.querySelectorAll(".exec-row")[INDEX].querySelector("[role=progressbar]").getAttribute("aria-valuenow")'.replace('INDEX',index)),String(value));
  }
  assert.match(await evaluate('document.querySelectorAll(".exec-row")[0].innerText'),/Anthropic Work[\s\S]*2026\/12\/20 到期[\s\S]*已预留 \$1.00/);
  assert.match(await evaluate('document.querySelectorAll(".exec-row")[1].innerText'),/没有到期日/);
  assert.match(await evaluate('document.querySelectorAll(".exec-row")[2].innerText'),/余额 ¥300.00[\s\S]*本地额度 \$100.00/);
  assert.match(await evaluate('document.querySelectorAll(".exec-row")[3].innerText'),/费用未知/);
  assert.equal(await evaluate('document.querySelectorAll(".exec-row")[3].querySelector(".api-credit")'),null);
  await evaluate('document.querySelector(".exec-row").closest(".exec-group").scrollIntoView({block:"start"})');
  await shot('dark-1100');
  await evaluate('window.spend()');await frame();
  assert.equal(await evaluate('document.querySelector(".exec-row [role=progressbar]").getAttribute("aria-valuenow")'),'45');
  await click('.exec-row .exec-toggle');await click('.exec-row .target-advanced summary');
  await evaluate('document.querySelector(".exec-row .target-advanced .target-advanced").open=true');
  const optionCount=await evaluate('document.querySelectorAll(".exec-row .exec-option").length');
  for(let i=0;i<optionCount;i++){
   await evaluate('window.option=document.querySelectorAll(".exec-row .exec-option")['+i+'];window.box=window.option.querySelector("input[type=checkbox]");window.before=window.box.checked;window.option.click();window.option.querySelector("small")?.click();');await frame();
   assert.equal(await evaluate('window.box.checked===window.before'),true);
   assert.equal(await evaluate('window.option.querySelector("small")?.closest("label")'),null);
   assert.equal(await evaluate('window.option.querySelector("label").getBoundingClientRect().right<window.option.getBoundingClientRect().right-20'),true);
   await evaluate('window.option.querySelector("label").click()');await frame();await idle();
   assert.equal(await evaluate('window.box.checked!==window.before'),true);
   await evaluate('window.box.click()');await frame();await idle();
   assert.equal(await evaluate('window.box.checked===window.before'),true);
  }
  await evaluate('window.fixture.calls=[]');
  assert.equal(await evaluate('window.uiUpdateBlocked()'),false,'clean budget settings permit a UI update');
  await fill('.exec-row input[type=number]','4');
  await fill('.exec-row input[type=number]','40');
  assert.equal(await puts(),0,'typing does not send requests');
  await blur();
  assert.equal(await puts(),1,'blur saves exactly once');
  assert.equal(await evaluate('window.fixture.calls.find(call=>call.method==="PUT").body.limitUsd'),40);
  assert.equal(await evaluate('document.querySelector(".exec-row [role=progressbar]").getAttribute("aria-valuenow")'),'73');
  assert.equal(await evaluate('window.budgets()[0].budget.spentUsd'),10,'autosave preserves counted spend');
  assert.equal(await evaluate('window.fixture.calls.find(call=>call.method==="PUT").body.reset'),undefined);
  assert.equal(await evaluate('window.uiUpdateBlocked()'),false);
  assert.ok(await evaluate('document.querySelector(".api-budget-saved")'));
  assert.equal(await evaluate('document.querySelector(".exec-row button[type=submit]")'),null);
  await fill('.exec-row input[type=number]','0');await blur();
  assert.equal(await puts(),1,'invalid values never reach the API');
  assert.equal(await evaluate('document.querySelector(".exec-row input[type=number]").value'),'0');
  assert.ok(await evaluate('document.querySelector(".exec-row .inline-error")'));
  await evaluate('(()=>{const input=document.querySelector(".exec-row input[type=number]");input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"");Object.defineProperty(input,"validity",{configurable:true,value:{badInput:true}});input.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();await blur();
  assert.equal(await puts(),1,'incomplete numeric tokens do not clear the credit limit');
  await evaluate('delete document.querySelector(".exec-row input[type=number]").validity');
  await fill('.exec-row input[type=number]','41');
  await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');await frame();await idle();await blur();
  assert.equal(await puts(),2,'Enter followed by blur saves once');
  assert.equal(await evaluate('document.querySelector(".inline-error")'),null);
  await wait('!document.querySelector(".api-budget-saved")');
  await evaluate('window.fixture.deferNextBudget=true');
  await fill('.exec-row input[type=number]','42');await evaluate('document.activeElement.dispatchEvent(new FocusEvent("focusout",{bubbles:true}));document.activeElement.blur()');await frame();
  assert.equal(await evaluate('window.uiUpdateBlocked()'),true);
  await fill('.exec-row input[type=number]','43');await evaluate('document.activeElement.dispatchEvent(new FocusEvent("focusout",{bubbles:true}));document.activeElement.blur()');await frame();
  assert.equal(await puts(),3,'later edits queue behind an in-flight request');
  await evaluate('window.fixture.finishBudget()');await idle();
  assert.equal(await puts(),4);
  assert.equal(await evaluate('window.budgets()[0].budget.policy.limitUsd'),43);
  await fill('.exec-row input[type=number]','44');
  await evaluate('window.navigate(true)');await frame();
  await wait('window.budgets()[0].budget.policy.limitUsd===44');
  assert.equal(await puts(),5,'unmount flushes even without a blur event');
  await evaluate('window.navigate(false)');await frame();
  await click('.exec-row .exec-toggle');await click('.exec-row .target-advanced summary');
  await fill('.exec-row input[type=number]','45');
  await evaluate('document.activeElement.dispatchEvent(new FocusEvent("focusout",{bubbles:true}));document.activeElement.blur();window.navigate(true)');await frame();
  await wait('window.budgets()[0].budget.policy.limitUsd===45');
  assert.equal(await puts(),6,'blur followed immediately by navigation does not duplicate a request');
  await evaluate('window.navigate(false)');await frame();
  await click('.exec-row .exec-toggle');await click('.exec-row .target-advanced summary');
  await evaluate('document.querySelector(".exec-row .target-advanced .target-advanced").open=true');await frame();
  await click('.exec-row .target-advanced .target-advanced button');
  assert.equal(await puts(),6,'opening the in-app confirmation does not reset spend');
  assert.ok(await evaluate('document.querySelector("dialog[open]")'));
  await click('dialog .button.secondary');assert.equal(await puts(),6,'cancel does not save');
  await click('.exec-row .target-advanced .target-advanced button');await click('dialog .modal-actions .button:last-child');await idle();
  assert.equal(await puts(),7,'confirmation makes exactly one reset request');
  assert.equal(await evaluate('window.fixture.calls.filter(call=>call.method==="PUT").at(-1).body.reset'),true);
  assert.equal(await evaluate('window.budgets()[0].budget.spentUsd'),0);
  assert.deepEqual(await evaluate('window.fixture.notices'),[],'autosaves and reset never toast');
  await click('.exec-row .exec-toggle');
  await evaluate('window.advance()');await frame();
  assert.match(await evaluate('document.querySelectorAll(".exec-row")[2].innerText'),/\$0.00[\s\S]*已到期/);
  assert.equal(await evaluate('document.querySelectorAll(".exec-row")[2].querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'0');
  await evaluate('window.addBudget()');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".exec-row")[3].querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'80');
  await evaluate('window.addAccount()');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".exec-row")[4].querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'100');
  win.setContentSize(390,1000);await frame();
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await evaluate('[...document.querySelectorAll(".api-credit")].every(node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&node.scrollWidth<=node.clientWidth;})'),true);
  await evaluate('document.querySelector(".exec-row").scrollIntoView({block:"start"})');await shot('dark-390');
  await evaluate('document.documentElement.dataset.theme="light"');await shot('light-390');
  await click('.exec-row .exec-toggle');await click('.exec-row .target-advanced summary');
  await fill('.exec-row input[type=number]','46');
  await evaluate('window.fixture.failNextBudget="busy"');await blur();
  assert.match(await evaluate('document.querySelector(".exec-row .inline-error").innerText'),/请等这个 API 的运行结束后再修改预算/);
  assert.equal(await evaluate('window.fixture.notices.some(notice=>notice.message.includes("synthetic refresh failed"))'),false);
  await evaluate('window.busy(true)');await frame();
  assert.equal(await evaluate('document.querySelector(".exec-row fieldset").disabled'),true);
  assert.equal(await evaluate('window.uiUpdateBlocked()'),true);
  await evaluate('window.finishRun()');await frame();
  assert.equal(await evaluate('document.querySelector(".exec-row input[type=number]").value'),'46');
  assert.equal(await evaluate('window.uiUpdateBlocked()'),true,'becoming idle retains failed edits');
  await evaluate('window.fixture.failNextBudget="offline synthetic error"');
  await fill('.exec-row input[type=number]','46');await blur();
  assert.match(await evaluate('document.querySelector(".exec-row .inline-error").innerText'),/offline synthetic error/);
  await fill('.exec-row input[type=number]','46');await blur();
  assert.equal(await evaluate('document.querySelector(".exec-row .inline-error")'),null,'retry succeeds without losing text');
  await evaluate('window.showDuplicateAnthropic()');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".exec-row").length'),2);
  assert.equal(await evaluate('document.querySelectorAll(".exec-row")[1].querySelector("[role=progressbar]")'),null,'new same-provider account starts without an invented budget');
  await evaluate('document.querySelectorAll(".exec-row")[1].querySelector(".exec-toggle").click()');await frame();
  await evaluate('document.querySelectorAll(".exec-row")[1].querySelector(".target-advanced summary").click()');await frame();
  await evaluate('(()=>{const row=document.querySelectorAll(".exec-row")[1];for(const [selector,value] of [["input[type=number]","200"],["input[type=date]","2027-01-02"]]){const input=row.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));}})()');await frame();
  await wait('document.querySelectorAll(".exec-row")[1].querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")==="100"');
  assert.equal(await evaluate('window.fixture.calls.filter(call=>call.method==="PUT").at(-1).path'),'/api/api-providers/api-anthropic-2/budget');
  assert.equal(await evaluate('window.fixture.calls.filter(call=>call.method==="PUT").at(-1).body.limitUsd'),200);
  assert.equal(await evaluate('window.fixture.calls.filter(call=>call.method==="PUT").at(-1).body.expiresAt'),await evaluate('new Date("2027-01-02T00:00").toISOString()'));
  assert.deepEqual(await evaluate('window.budgets()[0].budget'),await evaluate('window.fixture.originalBudget'),'saving the second Anthropic account never changes the first account');
  assert.equal(await evaluate('window.fixture.calls.some(call=>call.method==="PUT"&&call.path==="/api/api-providers/api-anthropic/budget")'),false);
  await evaluate('document.querySelectorAll(".exec-row")[1].querySelector(".exec-toggle").click()');await frame();
  await evaluate('document.querySelector(".exec-row").scrollIntoView({block:"start"})');await shot('duplicate-anthropic-390');
  await evaluate('window.monthly()');await frame();
  assert.equal(await evaluate('document.querySelector(".exec-row [role=progressbar]").getAttribute("aria-valuenow")'),'42');
  assert.equal(await evaluate('document.querySelector(".exec-row [role=progressbar] > span").style.width'),'42%');
  assert.match(await evaluate('document.querySelector(".exec-row .api-credit").innerText'),/\$84.00 剩余，本月共 \$200.00/);
  win.setContentSize(1100,1200);await evaluate('document.documentElement.dataset.theme="dark"');await frame();
  await evaluate('document.querySelector(".exec-row").scrollIntoView({block:"start"})');await shot('collapsed-dark');
  await click('.exec-row .exec-toggle');await click('.exec-row .target-advanced summary');
  await evaluate('document.querySelector(".exec-row .target-advanced .target-advanced").open=true');await frame();
  const beforeSelect=await puts();
  await evaluate('(()=>{const select=document.querySelector(".exec-row select");select.value="codex-fixture";select.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame();await idle();
  assert.equal(await puts(),beforeSelect+1,'select applies once on change');
  assert.equal(await evaluate('window.fixture.calls.filter(call=>call.method==="PUT").at(-1).body.linkedAccountId'),'codex-fixture');
  await evaluate('document.querySelector(".exec-row").scrollIntoView({block:"start"})');await frame();await shot('expanded-dark');
  const beforeRemove=await puts();
  await evaluate('window.fixture.deferNextBudget=true');
  await fill('.exec-row input[type=number]','85');
  await evaluate('document.activeElement.dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');await frame();
  await click('.exec-row .target-advanced .exec-actions button');
  assert.equal(await evaluate('document.querySelector(".exec-row fieldset").disabled'),true,'clear locks edits until removal completes');
  await evaluate('window.fixture.finishBudget()');await idle();
  assert.equal(await puts(),beforeRemove+2);
  assert.equal(await evaluate('window.budgets()[0].budget'),undefined);
  assert.equal(await evaluate('document.querySelector(".exec-row input[type=number]").value'),'');

  assert.deepEqual(await evaluate('window.fixture.errors'),[]);assert.deepEqual(network,[]);
  assert.equal(await evaluate('window.fixture.calls.some(call=>call.path.endsWith("/balance"))'),false,'rendering local credit never requests a provider balance');
  await fs.writeFile(path.join(SCREENSHOTS,'renderer-result.json'),JSON.stringify({result:'pass',networkRequests:network.length,checks:['all provider variants show one collapsed budget bar','local currency stays USD and real balance retains CNY','unpriced usage remains unknown','state spending and saved policy update bar','blur and Enter deduplicate; invalid values retain text; queued edits and unmount save; restart confirms; select saves','clock expiry without new snapshot','no-limit and newly configured/added account','390px dark and light layout','busy and offline errors remain inline with draft retained; retry clears error','bad numeric input cannot remove the limit','clearing behind an in-flight autosave locks fields immediately','monthly 84 of 200 renders 42 percent','second same-provider account saves its exact ID and leaves the first budget untouched']},null,2));
  console.log('PASS API budget renderer');app.exit(0);
 }catch(error){console.error(error);if(win)console.error(await evaluate('JSON.stringify({body:document.body.innerText,errors:window.fixture?.errors})').catch(()=>''));app.exit(1);}
});`.replaceAll('SCREENSHOTS', JSON.stringify(screenshots)),
    );
    const env: NodeJS.ProcessEnv = {
      HOME: join(directory, 'home'),
      USERPROFILE: join(directory, 'home'),
      PUGPORT_UNDER_TEST: '1',
    };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      {
        env: offscreenElectronEnv(env),
        windowsHide: true,
        timeout: 75000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS API budget renderer/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
