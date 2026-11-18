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

// Real React components in hidden Electron; all API writes stay in a temporary synthetic profile.
test('Electron: Bot addition, risk consent, saved rows and existing account flows', { timeout: 90000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-bot-addition-ui-')));
  t.after(async () => {
    assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-bot-addition-ui-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const screenshots = resolve('reports/bot-addition');
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
import {UsagePage} from './src/ui/UsagePage';
import {ExternalAgentsCard, useExternalAgents} from './src/ui/ExternalAgents';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
import './src/ui/settings.css';
import './src/ui/composer.css';
import './src/ui/ExternalAgents.css';
const query=new URLSearchParams(location.search);
localStorage.setItem('comborunner.locale',query.get('locale')||'zh-CN');
document.documentElement.dataset.theme=query.get('theme')||'dark';
window.fixture={calls:[],errors:[],notices:[],page:'accounts'};
const f=window.fixture;
window.addEventListener('error',event=>f.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
window.fetch=()=>{throw Error('Unexpected real fetch');};
window.open=()=>{throw Error('Unexpected external window');};
const fresh=[
 {id:'muse',name:'Muse',kind:'web',description:'Synthetic Muse',added:false,enabled:false,available:false,riskAccepted:false,url:'https://muse.ai/'},
 {id:'grok-bot',name:'Grok Bot',kind:'handoff',description:'Synthetic Grok Bot',added:false,enabled:false,available:false},
];
let agents=JSON.parse(localStorage.getItem('synthetic-bot-agents')||'null')||fresh;
const accounts={providers:['codex','claude','grok','cursor'].map(id=>({id,supported:true})),accounts:[]};
const state={app:{name:'PugPort',version:'fixture',platform:'darwin',dataDir:'synthetic'},settings:{refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,toolApprovalMode:'auto',executionPolicy:'cli-first',unknownQuotaPolicy:'manual-only',maxConcurrentRuns:1},targets:[],runtimes:[],runs:[],projects:[],conversations:[],workflows:[],conversationMessages:[],approvals:[],plugins:[],apiProviders:[],refreshing:false};
const clone=value=>structuredClone(value);
const api=async(path,body,method)=>{
 f.calls.push({path,body:clone(body),method:method||(body?'POST':'GET')});
 if(path==='/api/external-agents'&&!body)return {agents:clone(agents)};
 if(/^\/api\/external-agents\/(muse|grok-bot)$/.test(path)&&method==='PATCH') {
  const id=path.split('/').pop();
  agents=agents.map(agent=>agent.id===id?{...agent,...body,riskAccepted:agent.riskAccepted||body.acceptRisk===true}:agent);
  localStorage.setItem('synthetic-bot-agents',JSON.stringify(agents));
  return {agents:clone(agents)};
 }
 if(path==='/api/accounts'&&!body)return clone(accounts);
 if(path==='/api/accounts'&&body){accounts.accounts.push({runtimeId:'synthetic-account',id:'synthetic-account',provider:body.provider,label:body.label,managed:true});return clone(accounts);}
 if(path==='/api/accounts/synthetic-account/login'&&body)return {ok:true};
 if((path==='/api/api-providers'||path==='/api/free-sources')&&body)return {ok:true};
 throw Error('Unexpected fixture API '+(method||'GET')+' '+path);
};
const notify=notice=>f.notices.push(notice);
const reload=async()=>{};
const root=createRoot(document.getElementById('root'));
function Picker(){const {agents,status}=useExternalAgents(api,true);return <div id="picker-fixture" data-status={status||'ready'}>{agents?.map(agent=><span key={agent.id}>{agent.name}</span>)}</div>;}
window.renderFixture=()=>flushSync(()=>root.render(<><ConfirmDialogHost/>{f.page==='usage'?<UsagePage state={state} api={api} now={Date.parse('2026-10-16T12:00:00Z')} refresh={reload} refreshing={false} notify={notify} onInspect={()=>{}}/>:f.page==='all'?<ExternalAgentsCard api={api} notify={notify}/>:f.page==='picker'?<Picker/>:<ExecutorsPage state={state} api={api} reload={reload} refresh={reload} refreshing={false} notify={notify}/>}</>));
window.showFixture=page=>{f.page=page;window.renderFixture();};
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
const wait=async(expression,label=expression)=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+label);};
const click=async(selector)=>{await evaluate('(()=>{const node=document.querySelector('+JSON.stringify(selector)+');if(!node||node.disabled)throw Error("Unavailable control: "+'+JSON.stringify(selector)+');node.click();})()');await frame();};
const tab=async(text)=>{await evaluate('(()=>{const node=[...document.querySelectorAll(".native-dialog [role=tab]")].find(item=>item.textContent.trim()==='+JSON.stringify(text)+');if(!node)throw Error("Missing tab");node.click();})()');await frame();};
const fill=async(selector,value)=>{await evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');const prototype=input.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event(input.tagName==="SELECT"?"change":"input",{bubbles:true}));})()');await frame();};
const open=async(kind=3)=>{await click('.management-heading [aria-haspopup=menu]');await wait('!!document.querySelector(".exec-add-menu")');await click('.exec-add-menu [role=menuitem]:nth-child('+kind+')');await wait('!!document.querySelector(".native-dialog[open]")');};
const bot=async()=>{await open();await tab('Bot');await wait('!!document.querySelector(".native-dialog select option[value=muse]")');};
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await new Promise(resolve=>setTimeout(resolve,350));await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG());};
const page=async(name)=>{await evaluate('window.showFixture('+JSON.stringify(name)+')');await frame();};
const load=async(locale='zh-CN',theme='dark')=>{await win.loadFile(path.join(__dirname,'index.html'),{query:{locale,theme}});await wait('window.fixture?.ready===true');await wait('window.fixture.calls.some(call=>call.path==="/api/accounts")');await frame();};
void app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
  win.webContents.setWindowOpenHandler(()=>{network.push('window.open');return {action:'deny'};});
  for(const locale of ['zh-CN','en'])for(const theme of ['dark','light']){
   await load(locale,theme);await bot();
   assert.deepEqual(await evaluate('[...document.querySelectorAll(".native-dialog select option")].map(node=>node.value)'),['muse','grok-bot']);
   assert.equal(await evaluate('document.querySelector(".native-dialog .button.primary").disabled'),false);
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
   if(locale==='en')assert.doesNotMatch(await evaluate('document.querySelector(".native-dialog").innerText'),/[\u3400-\u9fff]/);
   await shot(locale+'-'+theme+'-bot-add');
   win.setContentSize(380,900);await frame();
   assert.equal(await evaluate('(()=>{const box=document.querySelector(".native-dialog").getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&document.querySelector(".native-dialog").scrollWidth<=box.width;})()'),true,'Bot dialog fits 380px');
   await shot(locale+'-'+theme+'-bot-add-380');
   win.setContentSize(1100,900);await frame();
   await click('.native-dialog .button.primary');await wait('!!document.querySelector(".confirm-dialog[open]")');
   if(locale==='en')assert.doesNotMatch(await evaluate('document.querySelector(".confirm-dialog").innerText'),/[\u3400-\u9fff]/);
   await shot(locale+'-'+theme+'-muse-consent');
   await click('.confirm-dialog .button.secondary');
   assert.equal(await evaluate('window.fixture.calls.filter(call=>call.method==="PATCH").length'),0,'cancel must not save or enable Muse');
   assert.equal(await evaluate('!!document.querySelector(".native-dialog[open]")'),true,'cancel returns to Add');
   await fill('.native-dialog select','grok-bot');
   if(locale==='en')assert.doesNotMatch(await evaluate('document.querySelector(".native-dialog").innerText'),/[\u3400-\u9fff]/);
   await shot(locale+'-'+theme+'-grok-add');
   assert.deepEqual(await evaluate('window.fixture.errors'),[]);
  }
  await load();
  await wait('window.fixture.calls.some(call=>call.path==="/api/external-agents")');
  assert.equal(await evaluate('document.querySelector(".external-agents")?.textContent.includes("Muse")||false'),false,'fresh bots are absent from account rows');
  await page('usage');await frame();
  assert.equal(await evaluate('!!document.querySelector(".web-quota-section,.web-compact-section")'),false,'fresh bots have no usage cards');
  assert.equal(await evaluate('!!document.querySelector(".usage-view-switch")'),false,'usage uses one grid view');
  await page('all');await wait('!!document.querySelector(".external-agents")');
  assert.equal(await evaluate('document.querySelector(".external-agents").textContent.includes("Muse")'),false);
  await page('picker');await wait('document.querySelector("#picker-fixture")?.dataset.status==="ready"');
  assert.equal(await evaluate('document.querySelector("#picker-fixture").textContent'),'','fresh bots absent from @@');
  await page('accounts');await bot();await click('.native-dialog .button.primary');
  await wait('!!document.querySelector(".confirm-dialog[open]")');
  await click('.confirm-dialog .button:not(.secondary)');
  await wait('!document.querySelector(".native-dialog")');
  assert.deepEqual(await evaluate('window.fixture.calls.filter(call=>call.method==="PATCH").map(({path,body,method})=>({path,body,method}))'),[{path:'/api/external-agents/muse',body:{added:true,enabled:true,url:'https://muse.ai/',acceptRisk:true},method:'PATCH'}]);
  await wait('document.querySelector(".external-agents")?.textContent.includes("Muse")');
  assert.equal(await evaluate('window.fixture.calls.some(call=>call.path.startsWith("/api/external-agents/")&&["login","open","detect"].includes(call.path.split("/").pop()))'),false,'adding never opens or signs in a bot');
  await load();
  await wait('document.querySelector(".external-agents")?.textContent.includes("Muse")');
  await click('.external-agents input[aria-label="关闭 Muse"]');
  await wait('window.fixture.calls.some(call=>call.path==="/api/external-agents/muse"&&call.body?.enabled===false)');
  assert.equal(await evaluate('document.querySelector(".external-agents").textContent.includes("Muse")'),true,'disabled added bot remains manageable');
  await load();
  await wait('[...document.querySelectorAll(".external-agents input")].some(input=>input.getAttribute("aria-label")==="开启 Muse")');
  await page('usage');await wait('document.querySelector(".web-quota-section")?.textContent.includes("Muse")');
  assert.equal(await evaluate('document.querySelector(".web-quota-section").textContent.includes("Grok Bot")'),false);
  assert.equal(await evaluate('!!document.querySelector(".usage-view-switch,.web-compact-section")'),false,'saved bots remain in the usage grid');
  await page('accounts');await bot();
  assert.equal(await evaluate('document.querySelector(".native-dialog select option[value=muse]").disabled'),true,'an added bot cannot be duplicated');
  await fill('.native-dialog select','grok-bot');
  await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.equal(await evaluate('!!document.querySelector(".confirm-dialog")'),false,'Grok handoff does not use Muse web consent');
  const grok=await evaluate('window.fixture.calls.filter(call=>call.path==="/api/external-agents/grok-bot"&&call.method==="PATCH")');
  assert.equal(grok.length,1);assert.equal(grok[0].body.added,true);assert.equal(grok[0].body.enabled,true);assert.equal(grok[0].body.acceptRisk,undefined);
  await wait('document.querySelector(".external-agents")?.textContent.includes("Grok Bot")');
  await shot('zh-CN-dark-saved-bots');
  await open();
  assert.equal(await evaluate('!!document.querySelector(".native-dialog select option[value=gemini]")'),false,'Gemini CLI login is not offered');
  await shot('zh-CN-dark-native-without-gemini');
  await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.ok(await evaluate('window.fixture.calls.some(call=>call.path==="/api/accounts"&&call.body?.provider==="codex")'));
  assert.ok(await evaluate('window.fixture.calls.some(call=>call.path==="/api/accounts/synthetic-account/login")'),'native account still requests its synthetic official login');
  await open(1);await fill('.native-dialog input[type=password]','synthetic-key-not-a-secret');
  await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.ok(await evaluate('window.fixture.calls.some(call=>call.path==="/api/api-providers"&&call.body?.preset==="deepseek"&&call.body?.key==="synthetic-key-not-a-secret")'));
  await open(2);await click('.native-dialog .button.primary');await wait('!document.querySelector(".native-dialog")');
  assert.ok(await evaluate('window.fixture.calls.some(call=>call.path==="/api/free-sources"&&call.body?.preset==="ollama")'));
  assert.deepEqual(await evaluate('window.fixture.errors'),[]);assert.deepEqual(network,[]);
  console.log('PASS Bot addition: risk cancel/accept, persisted disabled rows, fresh filtering, native/API/free, four translated themes, no network');app.exit(0);
 }catch(error){console.error(error);if(win)console.error(await evaluate('JSON.stringify({body:document.body.innerText,fixture:window.fixture})').catch(()=>''));app.exit(1);}
});`.replace('SCREENSHOTS', JSON.stringify(screenshots)),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: join(directory, 'home'),
    USERPROFILE: join(directory, 'home'),
    PUGPORT_UNDER_TEST: '1',
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = await promisify(execFile)(electron as unknown as string, electronArgs(join(directory, 'runner.cjs')), {
    env,
    windowsHide: true,
    timeout: 75000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(result.stdout, /PASS Bot addition/);
  assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
});
