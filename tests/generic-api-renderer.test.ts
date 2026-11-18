import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'Electron: generic API connection, optional budget, keyboard submit and responsive account details',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-generic-api-ui-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-generic-api-ui-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve('reports/generic-api');
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
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
import './src/ui/settings.css';
import './src/ui/ExternalAgents.css';
const query=new URLSearchParams(location.search);
localStorage.setItem('comborunner.locale',query.get('locale')||'zh-CN');
document.documentElement.dataset.theme=query.get('theme')||'dark';
window.fixture={calls:[],errors:[],notices:[]};
const f=window.fixture;
window.addEventListener('error',event=>f.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
window.fetch=()=>{throw Error('Unexpected real fetch');};
window.open=()=>{throw Error('Unexpected external window');};
const agents=[{id:'muse',name:'Muse',kind:'web',added:false,enabled:false,available:false,riskAccepted:false,url:'https://muse.ai/'},{id:'grok-bot',name:'Grok Bot',kind:'handoff',added:false,enabled:false,available:false}];
const accounts={providers:['codex','claude','grok','cursor','gemini'].map(id=>({id,supported:true})),accounts:[]};
const state={app:{name:'PugPort',version:'fixture',platform:new URLSearchParams(location.search).get('platform')||'darwin',dataDir:'synthetic'},settings:{refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,toolApprovalMode:'auto',executionPolicy:'cli-first',unknownQuotaPolicy:'manual-only',maxConcurrentRuns:1},targets:[],runtimes:[],runs:[],projects:[],conversations:[],workflows:[],conversationMessages:[],approvals:[],plugins:[],apiProviders:[],refreshing:false};
const clone=value=>structuredClone(value);
const api=async(path,body,method)=>{
 f.calls.push({path,body:clone(body),method:method||(body?'POST':'GET')});
 if(path==='/api/accounts'&&!body)return clone(accounts);
 if(path==='/api/external-agents'&&!body)return {agents:clone(agents)};
 if(path==='/api/api-providers'&&body){
  const id='synthetic-api-'+state.apiProviders.length;
  state.targets.push({id,provider:'pi',apiPreset:body.preset,apiConnection:body.connection,label:body.label||'Synthetic API',enabled:true});
  state.apiProviders.push({targetId:id,preset:body.preset,label:body.label||'Synthetic API',enabled:true,keyHint:'…synthetic',console:'',currency:'USD',connection:body.connection,...(body.budget?{budget:{policy:{...body.budget,startedAt:new Date().toISOString()},spentUsd:0,reservedUsd:0,remainingUsd:body.budget.limitUsd,unreportedRuns:0,phase:'normal',maxConcurrentRuns:1}}:{})});
  return {ok:true};
 }
 if(path==='/api/free-sources'&&body)return {ok:true};
 if(path==='/api/accounts'&&body){accounts.accounts.push({runtimeId:'synthetic-account',id:'synthetic-account',provider:body.provider,label:body.label,managed:true});return clone(accounts);}
 if(path==='/api/accounts/synthetic-account/login'&&body)return {ok:true};
 if(path.endsWith('/budget')&&method==='PUT')return {ok:true};
 throw Error('Unexpected fixture API '+(method||'GET')+' '+path);
};
const root=createRoot(document.getElementById('root'));
const reload=async()=>window.renderFixture();
window.renderFixture=()=>flushSync(()=>root.render(<ExecutorsPage state={state} api={api} reload={reload} refresh={reload} refreshing={false} notify={notice=>f.notices.push(notice)}/>));
window.showInvalidConnection=()=>{const provider=state.apiProviders.at(-1);delete provider.connection;provider.connectionError='API 连接配置无效，请移除后重新添加。';window.renderFixture();};
void startInterfaceLanguage().then(()=>{window.renderFixture();f.ready=true;});`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0;overflow:auto}#root{max-width:1000px;margin:auto;padding:24px;display:grid;gap:16px}</style></head><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let win;const network=[];
const evaluate=source=>win.webContents.executeJavaScript(source).catch(error=>{console.error('Failed evaluation:',source);throw error;});
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const wait=async(expression)=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+expression);};
const click=async(selector)=>{await evaluate('(()=>{const node=document.querySelector('+JSON.stringify(selector)+');if(!node||node.disabled)throw Error("Unavailable control");node.click();})()');await frame();};
const fill=async(selector,value)=>{await evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');if(!input)throw Error("Missing input");const prototype=input.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event(input.tagName==="SELECT"?"change":"input",{bubbles:true}));})()');await frame();};
const open=async(kind=3)=>{await click('.management-heading [aria-haspopup=menu]');await wait('!!document.querySelector(".exec-add-menu")');await click('.exec-add-menu [role=menuitem]:nth-child('+kind+')');await wait('!!document.querySelector(".native-dialog[open]")');};
const api=async()=>{await open(1);};
const custom=async()=>{await api();await click('.native-dialog .preset-grid [role=radio]:last-child');};
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await new Promise(resolve=>setTimeout(resolve,250));await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG());};
const load=async(locale='zh-CN',theme='dark',platform)=>{await win.loadFile(path.join(__dirname,'index.html'),{query:{locale,theme,...(platform?{platform}:{})}});await wait('window.fixture?.ready===true');await wait('window.fixture.calls.some(call=>call.path==="/api/accounts")');await frame();};
const fit=async()=>{
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 assert.equal(await evaluate('(()=>{const dialog=document.querySelector(".native-dialog"),box=dialog.getBoundingClientRect(),scroll=dialog.querySelector(".add-executor-scroll"),actions=dialog.querySelector(".dialog-actions").getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&dialog.scrollWidth<=dialog.clientWidth&&actions.top>=scroll.getBoundingClientRect().bottom&&actions.bottom<=innerHeight;})()'),true,'dialog and action buttons fit without overlapping the scroll area');
};
void app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
  win.webContents.setWindowOpenHandler(()=>{network.push('window.open');return {action:'deny'};});
  for(const locale of ['zh-CN','en'])for(const theme of ['dark','light']){
   await load(locale,theme);await custom();
   assert.equal(await evaluate('document.querySelector("[name=api-protocol]").value'),'azure-openai-responses');
   assert.equal(await evaluate('[...document.querySelectorAll(".native-dialog a")].some(node=>!node.getAttribute("href"))'),false);
   await fill('[name=api-endpoint]','https://synthetic.openai.azure.com/openai/v1/responses');
   await fill('[name=api-model]','synthetic-deployment');
   await fill('[name=api-key]','synthetic-key-not-a-secret');
   await click('.api-add-budget summary');await fill('[name=api-input-price]','2');await fill('[name=api-output-price]','8');
   await click('[name=api-budget]');await fill('[name=api-budget-limit]','25');await fill('[name=api-budget-expiry]','2027-01-02');
   assert.equal(await evaluate('document.querySelector("[name=api-budget-reserve]").value'),'1');
   assert.equal(await evaluate('document.querySelector("[name=api-key]").type'),'password');
   assert.equal(await evaluate('document.querySelector(".native-dialog").innerText.includes("synthetic-key-not-a-secret")'),false);
   if(locale==='en')assert.doesNotMatch(await evaluate('document.querySelector(".native-dialog").innerText'),/[\u3400-\u9fff]/);
   await evaluate('document.querySelector(".add-executor-scroll").scrollTop=0');await fit();await shot(locale+'-'+theme+'-add-desktop');
   await evaluate('document.querySelector(".add-executor-scroll").scrollTop=10000');await fit();await shot(locale+'-'+theme+'-budget-desktop');
   win.setContentSize(380,720);await frame();await fit();
   await evaluate('document.querySelector(".add-executor-scroll").scrollTop=0');await shot(locale+'-'+theme+'-add-380');
   await evaluate('document.querySelector(".add-executor-scroll").scrollTop=10000');await fit();await shot(locale+'-'+theme+'-budget-380');
   assert.equal(await evaluate('(()=>{const scroll=document.querySelector(".add-executor-scroll"),reserve=document.querySelector("[name=api-budget-reserve]").getBoundingClientRect();return scroll.scrollHeight>scroll.clientHeight&&scroll.scrollTop>0&&reserve.top>=scroll.getBoundingClientRect().top&&reserve.bottom<=scroll.getBoundingClientRect().bottom;})()'),true,'budget reserve remains reachable inside the scroll area');
   await evaluate('document.querySelector("[name=api-budget-reserve]").focus()');
   win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'char',keyCode:'\r'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
   await wait('!document.querySelector(".native-dialog")');
   const writes=await evaluate('window.fixture.calls.filter(call=>call.path==="/api/api-providers"&&call.body)');
   assert.equal(writes.length,1,'Enter submits once');
   assert.deepEqual(writes[0].body,{preset:'custom-api',key:'synthetic-key-not-a-secret',label:undefined,connection:{protocol:'azure-openai-responses',baseUrl:'https://synthetic.openai.azure.com/openai/v1',model:'synthetic-deployment',price:{input:2,output:8}},budget:{limitUsd:25,expiresAt:await evaluate('new Date("2027-01-02T00:00").toISOString()'),perRunUsd:1,maxConcurrentRuns:1,burstConcurrentRuns:4,preferExpiring:true}});
   win.setContentSize(1100,900);await frame();await click('.exec-row .exec-toggle');
   assert.match(await evaluate('document.querySelector(".api-connection-details").innerText'),/synthetic-deployment/);
   assert.match(await evaluate('document.querySelector(".api-connection-details").innerText'),/https:\/\/synthetic.openai.azure.com\/openai\/v1/);
   assert.equal(await evaluate('[...document.querySelectorAll(".exec-row a")].some(node=>!node.getAttribute("href"))'),false);
   await shot(locale+'-'+theme+'-saved');
   await click('.exec-row .target-advanced summary');await fill('.exec-row input[type=number]','26');await evaluate('document.querySelector(".exec-row input[type=number]").dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');await frame();
   await wait('window.fixture.calls.some(call=>call.path.endsWith("/budget")&&call.method==="PUT")');
   assert.deepEqual(await evaluate('window.fixture.errors'),[]);
  }
  await load();await custom();await fill('[name=api-endpoint]','https://synthetic.example.test/openai/v1?api-key=synthetic');await fill('[name=api-model]','synthetic-deployment');await fill('[name=api-key]','synthetic-invalid-key');await click('.native-dialog .button.primary');
  await wait('!!document.querySelector(".native-dialog [role=alert]")');
  assert.equal(await evaluate('window.fixture.calls.filter(call=>call.path==="/api/api-providers"&&call.body).length'),0,'invalid endpoint never reaches the server');
  await shot('zh-CN-dark-validation-error');
  const errorBounds=await evaluate('(()=>{const alert=document.querySelector(".native-dialog [role=alert]").getBoundingClientRect(),scroll=document.querySelector(".add-executor-scroll").getBoundingClientRect();return {top:alert.top,bottom:alert.bottom,scrollTop:scroll.top,scrollBottom:scroll.bottom};})()');
  assert.ok(errorBounds.top>=errorBounds.scrollTop-1&&errorBounds.bottom<=errorBounds.scrollBottom+1,'validation errors scroll into view '+JSON.stringify(errorBounds));
  await click('.native-dialog .button.secondary');await api();await fill('[name=api-key]','synthetic-preset-key');await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.equal(await evaluate('window.fixture.calls.find(call=>call.path==="/api/api-providers"&&call.body).body.preset'),'deepseek','the default paid preset remains DeepSeek');
  await open(2);await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.equal(await evaluate('window.fixture.calls.find(call=>call.path==="/api/free-sources"&&call.body).body.preset'),'ollama');
  await open();await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.equal(await evaluate('window.fixture.calls.some(call=>call.path==="/api/accounts/synthetic-account/login")'),true);
  await custom();await fill('[name=api-protocol]','openai-responses');await fill('[name=api-endpoint]','https://synthetic.example.test/v1/responses');await fill('[name=api-model]','synthetic-model');await fill('[name=api-key]','synthetic-unpriced-key');await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  const last=await evaluate('window.fixture.calls.filter(call=>call.path==="/api/api-providers"&&call.body).at(-1).body');
  assert.deepEqual(last.connection,{protocol:'openai-responses',baseUrl:'https://synthetic.example.test/v1',model:'synthetic-model'});assert.equal(last.budget,undefined);
  await click('.exec-row:last-child .exec-toggle');
  assert.match(await evaluate('document.querySelector(".exec-row:last-child").innerText'),/费用未知/);
  await evaluate('window.showInvalidConnection()');await frame();
  assert.match(await evaluate('document.querySelector(".exec-row:last-child [role=alert]").innerText'),/API 连接配置无效/);
  assert.equal(await evaluate('document.querySelector(".exec-row:last-child .danger-text").disabled'),false,'invalid saved connections can still be removed');
  await shot('zh-CN-dark-invalid-connection');
  // Context and output limits are a macOS setting: present and submitted there, absent on other systems.
  for(const locale of ['zh-CN','en']){
   await load(locale,'dark');await custom();
   await fill('[name=api-protocol]','openai-completions');await fill('[name=api-endpoint]','http://127.0.0.1:8000/v1');await fill('[name=api-model]','synthetic-local-model');await fill('[name=api-key]','synthetic-local-key');
   await click('.api-add-limits summary');
   await fill('[name=api-context-window]','8192');await fill('[name=api-max-tokens]','16384');await click('.native-dialog .button.primary');
   await wait('!!document.querySelector(".native-dialog [role=alert]")');
   assert.equal(await evaluate('window.fixture.calls.filter(call=>call.path==="/api/api-providers"&&call.body).length'),0,'an output limit above the context never reaches the server');
   await fill('[name=api-context-window]','65536');await fill('[name=api-max-tokens]','32768');
   if(locale==='en')assert.doesNotMatch(await evaluate('document.querySelector(".native-dialog").innerText'),/[\u3400-\u9fff]/);
   await evaluate('document.querySelector(".add-executor-scroll").scrollTop=10000');await fit();await shot(locale+'-dark-limits-desktop');
   await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
   const limited=await evaluate('window.fixture.calls.filter(call=>call.path==="/api/api-providers"&&call.body).at(-1).body');
   assert.deepEqual(limited.connection,{protocol:'openai-completions',baseUrl:'http://127.0.0.1:8000/v1',model:'synthetic-local-model',limits:{contextWindow:65536,maxTokens:32768}});
   await click('.exec-row:last-child .exec-toggle');
   assert.match(await evaluate('document.querySelector(".exec-row:last-child .api-connection-details").innerText'),/65,536 \/ 32,768/);
   await shot(locale+'-dark-limits-saved');
  }
  for(const platform of ['win32','linux']){
   await load('zh-CN','dark',platform);await custom();
   assert.equal(await evaluate('!!document.querySelector(".api-add-limits")'),false,platform+' keeps the fixed limits');
   await evaluate('window.fixture.calls.length=0');
  }
  assert.deepEqual(await evaluate('window.fixture.errors'),[]);assert.deepEqual(network,[]);
  await fs.writeFile(path.join(SCREENSHOTS,'renderer-result.json'),JSON.stringify({result:'pass',locales:['zh-CN','en'],themes:['dark','light'],widths:[1100,380],networkRequests:network.length,errorBounds,checks:['macOS-only context and output limits','normalized Azure endpoint and exact budget payload','keyboard Enter submits once','visible action buttons and internal scroll','validation errors visible with no server write','saved connection details and existing budget save','DeepSeek, Ollama and native account flows','unpriced connection shows unknown cost','invalid saved connection remains removable']},null,2));
  console.log('PASS generic API renderer: exact synthetic payload, keyboard, saved budget, desktop/narrow, four translated themes, no network');app.exit(0);
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
        env,
        windowsHide: true,
        timeout: 75000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS generic API renderer/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
