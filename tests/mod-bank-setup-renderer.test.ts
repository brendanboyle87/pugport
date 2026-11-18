import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'Mod bank setup stays in the host, scopes data, and guides missing-key connections offline',
  { timeout: 90000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-mod-bank-'));
    const artifacts = resolve('artifacts/mod-bank-setup');
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(fixture, 'profile'));
    try {
      await writeFile(
        join(fixture, 'index.html'),
        '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';import './src/ui/settings.css';import './src/ui/StorePage.css';
import {StorePage} from './src/ui/StorePage';import {BankLinkDialog} from './src/ui/BankLinkDialog';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';import {InboxButton} from './src/ui/InboxPanel';
import {createModDataHost} from './src/ui/mods/mod-data-host';import {startInterfaceLanguage} from './src/ui/i18n';
const finance={schemaVersion:2,id:'fixture.finance',title:'Personal finance',description:'A private place for your accounts and spending.',author:'Fixture Studio',version:'1.0.0',permissions:['connections:read','data:store'],compatible:true};
const plain={...finance,id:'fixture.notes',title:'Notes',permissions:[]};
const bank={id:'conn_fixture',provider:'plaid',environment:'sandbox',institution:{name:'Synthetic Credit Union'},status:'connected',products:['transactions'],modIds:['fixture.finance']};
window.fixture={calls:[],notices:[],errors:[],plaid:{configured:true,environment:'sandbox',clientIdEnding:'0001',sandboxSecret:true,productionSecret:false},connections:[bank],usage:{modId:finance.id,items:1840,bytes:2400000},installed:true,permissions:finance.permissions,linkStatus:'waiting'};
const f=window.fixture;
f.visible=true;f.deferred=[];
window.addEventListener('error',event=>f.errors.push(event.message));
window.fetch=()=>{throw Error('Unexpected network request');};
const api=async(path,body,method='POST')=>{
 f.calls.push({path,body,method});
 if(path==='/api/modes')return {catalog:[{...finance,permissions:f.permissions},plain],installed:f.installed?[{modeId:finance.id,version:'1.0.0'},{modeId:plain.id,version:'1.0.0'}]:[]};
 if(path==='/api/modes/source')return {config:null,status:'unconfigured',catalog:[]};
 if(path.endsWith('/export')){const {compatible,...manifest}=path.includes(plain.id)?plain:finance;return {...manifest,readme:'# Your finances\\n\\nConnect a bank or import a statement to get started.'};}
 if(path==='/api/bank/settings'){
   if(method==='PUT')f.plaid={configured:true,environment:body.environment,clientIdEnding:'0001',sandboxSecret:!!body.sandboxSecret||f.plaid.sandboxSecret,productionSecret:!!body.productionSecret||f.plaid.productionSecret};
   if(method==='DELETE')f.plaid={configured:false,environment:'sandbox',sandboxSecret:false,productionSecret:false};
   return {...f.plaid};
 }
 if(path==='/api/bank/connections')return {connections:structuredClone(f.connections)};
 if(path==='/api/mod-data')return {mods:[{...f.usage}]};
 if(path==='/api/mod-data/fixture.finance/backup')return {modId:finance.id,collections:[]};
 if(path==='/api/mod-data/fixture.finance/restore'){f.usage.items=2;return {restored:2};}
 if(path==='/api/mod-data/fixture.finance'&&method==='DELETE'){f.usage.items=0;return {};}
 if(path==='/api/bank/connections/link'||path==='/api/conversations/chat/mod-data'){
   if(f.hold)await new Promise(resolve=>f.deferred.push(resolve));
   if(f.linkError)throw Object.assign(Error('Synthetic unavailable'),{code:f.linkError});
   if(!f.plaid.configured)throw Object.assign(Error('Plaid keys are not set.'),{code:'E_NOT_CONFIGURED'});
   return {id:'link_fixture',status:'waiting',url:'https://secure.plaid.com/fixture'};
 }
 if(path==='/api/bank/link/link_fixture')return {id:'link_fixture',status:method==='DELETE'?'cancelled':f.linkStatus,connectionId:'conn_fixture'};
 if(path==='/api/bank/connections/conn_fixture/mods/fixture.finance'){f.connections[0].modIds=body.shared?[finance.id]:[];return {};}
 if(path==='/api/bank/connections/conn_fixture'&&method==='DELETE'){f.connections=[];return {};}
 if(path.startsWith('/api/inbox/'))return {};
 throw Error('Unexpected fixture API: '+path);
};
const realNow=Date.now();f.clock=0;Date.now=()=>realNow+f.clock;
const host=createModDataHost({api,conversationId:'chat',instanceId:'instance',modId:finance.id,title:finance.title});
f.authorize=()=>host.call('connections.authorize',{provider:'plaid'},()=>f.visible);
f.reconnect=()=>createModDataHost({api,conversationId:'other-chat',instanceId:'another-instance',modId:finance.id,title:finance.title}).call('connections.reconnect',{connectionId:'conn_fixture'});
f.otherAuthorize=()=>createModDataHost({api,conversationId:'chat',instanceId:'other-mod',modId:'fixture.other',title:'Other Mod'}).call('connections.authorize',{provider:'plaid'});
f.downloads=[];const anchorClick=HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click=function(){if(this.download){f.downloads.push({name:this.download,href:this.href});}else anchorClick.call(this);};
function Fixture(){const[epoch,setEpoch]=useState(0);const[target,setTarget]=useState();const[notice,setNotice]=useState();
 f.refresh=()=>setEpoch(v=>v+1);f.notice=(status,legacy=false)=>{f.connections[0].status=status;setNotice({id:'bank-notice',kind:'bank-connection',key:'conn_fixture:reauth',severity:'action',title:'Bank notice',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),count:1,action:legacy?{kind:'open-bank-settings'}:{kind:'open-bank-settings',connectionId:'conn_fixture'}});};
 return <><InboxButton summary={{unread:notice?1:0,attention:notice?1:0,open:notice?[notice]:[]}} api={api} notify={n=>f.notices.push(n)} reload={async()=>{}} openPage={()=>{throw Error('Unexpected old navigation');}} onModDetails={id=>{f.details=id;setTarget({id,request:Date.now()});}} onRun={()=>{}} onProjectRules={()=>{}}/>
 <StorePage key={epoch} api={api} notify={n=>f.notices.push(n)} target={target}/><BankLinkDialog/><ConfirmDialogHost/></>;
}
localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();createRoot(document.getElementById('root')).render(<Fixture/>);
`,
        },
        bundle: true,
        platform: 'browser',
        format: 'esm',
        outfile: join(fixture, 'fixture.js'),
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
      });
      // The fixture bundle uses top-level await to install the normal i18n observer before rendering.
      await writeFile(
        join(fixture, 'index.html'),
        '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
      );
      const runner = join(fixture, 'runner.cjs');
      await writeFile(
        runner,
        `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1140,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
const external=[];win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const blocked=!/^(file|data|blob):/.test(d.url);if(blocked)external.push(d.url);cb({cancel:blocked});});
win.webContents.session.on('will-download',e=>{e.preventDefault();throw Error('Unexpected real download');});
await win.loadFile(path.join(__dirname,'index.html'));
const ev=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error(code.slice(0,250),{cause:error});}};
const frame=()=>ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const wait=async code=>{for(let i=0;i<120;i++){if(await ev(code))return;await frame();}throw Error('Not ready: '+code);};
const click=async(label,scope='document')=>{await ev('[...'+scope+'.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'||b.getAttribute("aria-label")==='+JSON.stringify(label)+').click()');await frame();};
const fill=async(selector,value)=>{await ev('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};
const shot=async(name)=>{await ev('document.fonts.ready');await ev('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
const open=async(title)=>{await click(title);await wait('!!document.querySelector(".store-drawer")');await frame();};
await wait('!!document.querySelector(".store-mode-title")');
assert.equal(await ev('!!document.querySelector(".saved-mod-resources")'),false);
await open('Personal finance');await wait('document.querySelector("[data-settings-item=mod-data-row]")?.textContent.includes("1,840") || document.querySelector("[data-settings-item=mod-data-row]")?.textContent.includes("1840")');
assert.equal(await ev('document.querySelectorAll(".mod-resources > .settings-row").length'),2);
assert.match(await ev('document.querySelector("[data-settings-item=mod-bank-row]").textContent'),/Sandbox.*1 bank connected/);
assert.doesNotMatch(await ev('document.querySelector("[data-settings-item=mod-data-row]").textContent'),/999/);
await wait('!!document.querySelector(".store-readme")');await ev('document.querySelector(".mod-resources").scrollIntoView({block:"end"})');
for(const theme of ['light','dark']){await ev('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('drawer-'+theme);}
await click('Manage');await wait('!!document.querySelector(".mod-bank-dialog[open]")');
assert.equal(await ev('document.querySelector(".mod-bank-dialog a").href'),'https://dashboard.plaid.com/');
assert.deepEqual(await ev('[...document.querySelectorAll(".mod-bank-dialog input[type=password]")].map(i=>i.value)'),['','']);
for(const theme of ['light','dark']){await ev('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('manage-'+theme);}
await click('Clear keys','document.querySelector(".mod-bank-dialog")');await wait('!!document.querySelector(".confirm-dialog[open]")');
assert.match(await ev('document.querySelector(".confirm-dialog").textContent'),/every Mod that uses banks/);
await click('Cancel','document.querySelector(".confirm-dialog")');
await ev('document.querySelector(".bank-share input").click()');await frame();
assert.deepEqual(await ev('window.fixture.calls.filter(c=>c.method==="PUT"&&c.path.includes("/mods/")).map(c=>({path:c.path,body:c.body}))'),[{path:'/api/bank/connections/conn_fixture/mods/fixture.finance',body:{shared:false}}]);
await ev('document.querySelector(".bank-share input").click()');await frame();
await click('Close','document.querySelector(".mod-bank-dialog")');
// Backup and destructive actions are always scoped to this Mod, with the existing confirmations.
await click('Back up','document.querySelector(".mod-resources")');await frame();
assert.equal(await ev('window.fixture.downloads[0].name'),'fixture.finance-data.json');
await click('Delete all data');await wait('!!document.querySelector(".confirm-dialog[open]")');await click('Cancel','document.querySelector(".confirm-dialog")');
assert.equal(await ev('window.fixture.calls.filter(c=>c.method==="DELETE"&&c.path.startsWith("/api/mod-data")).length'),0);
await click('Delete all data');await click('Delete data','document.querySelector(".confirm-dialog")');await frame();
assert.deepEqual(await ev('window.fixture.calls.find(c=>c.method==="DELETE"&&c.path.startsWith("/api/mod-data"))'),{path:'/api/mod-data/fixture.finance',method:'DELETE',body:{confirm:'fixture.finance'}});
await ev('(()=>{const dt=new DataTransfer();dt.items.add(new File([JSON.stringify({modId:"fixture.finance",collections:[]})],"backup.json",{type:"application/json"}));const input=document.querySelector(".mod-resources input[type=file]");input.files=dt.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame();await click('Restore','document.querySelector(".confirm-dialog")');await frame();
assert.equal(await ev('window.fixture.calls.filter(c=>c.path==="/api/mod-data/fixture.finance/restore").length'),1);
assert.equal(await ev('window.fixture.calls.some(c=>c.path.includes("fixture.other"))'),false);
await click('Close details');await open('Notes');assert.equal(await ev('!!document.querySelector(".mod-resources")'),false);await click('Close details');
await ev('window.fixture.installed=false;window.fixture.refresh()');await frame();await open('Personal finance');assert.equal(await ev('!!document.querySelector(".mod-resources")'),false);await click('Close details');
await wait('!!document.querySelector(".saved-mod-resources")');
assert.match(await ev('document.querySelector(".saved-mod-resources").textContent'),/Saved bank and Mod data/);
await ev('document.documentElement.dataset.theme="dark"');await shot('saved-data-dark');
await click('Manage','document.querySelector(".saved-mod-resources")');await wait('!!document.querySelector(".mod-bank-dialog[open]")');
assert.match(await ev('document.querySelector(".mod-bank-dialog").textContent'),/Synthetic Credit Union.*fixture.finance/s);
assert.equal(await ev('!!document.querySelector(".mod-bank-dialog .bank-share")'),false);
await click('Back up','document.querySelector(".mod-bank-dialog")');await frame();
assert.equal(await ev('window.fixture.downloads.at(-1).name'),'fixture.finance-data.json');
await click('Delete all data','document.querySelector(".mod-bank-dialog")');await frame();await click('Cancel','document.querySelector(".confirm-dialog")');
await click('Close','document.querySelector(".mod-bank-dialog")');
// A frame request without keys returns pending, shows host setup, and cancel makes no writes.
await ev('window.fixture.plaid={configured:false,environment:"sandbox",sandboxSecret:false,productionSecret:false}');
assert.deepEqual(await ev('window.fixture.authorize()'),{status:'pending'});await wait('document.querySelector(".bank-link-dialog h2")?.textContent==="Set up Plaid"');
assert.equal(await ev('window.fixture.authorize().then(()=>"unexpected",error=>error.code)'), 'E_LIMIT');
assert.equal(await ev('document.querySelector(".bank-link-dialog select").value'),'sandbox');
assert.equal(await ev('document.querySelectorAll(".bank-link-dialog ol li").length'),3);
assert.match(await ev('document.querySelector(".bank-link-dialog").textContent'),/Personal finance/);
assert.equal(await ev('document.querySelector(".bank-link-dialog a").href'),'https://dashboard.plaid.com/');
for(const theme of ['light','dark']){await ev('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('setup-'+theme);}
await fill('[aria-label="Client ID"]','synthetic-client');await fill('[aria-label="Sandbox secret"]','synthetic-secret');
await click('Cancel','document.querySelector(".bank-link-dialog")');
assert.equal(await ev('window.fixture.calls.filter(c=>c.path==="/api/bank/settings"&&c.method!=="GET").length'),0);
assert.equal(await ev('window.fixture.calls.filter(c=>c.path.startsWith("/api/bank/link/")).length'),0);
assert.equal(await ev('!!document.querySelector(".bank-link-dialog")'),false);
assert.equal(await ev('window.fixture.authorize().then(()=>"unexpected",error=>error.code)'), 'E_LIMIT');
await ev('window.fixture.clock+=59999');
assert.equal(await ev('window.fixture.reconnect().then(()=>"unexpected",error=>error.code)'), 'E_LIMIT');
assert.deepEqual(await ev('window.fixture.otherAuthorize()'),{status:'pending'});await frame();await click('Cancel','document.querySelector(".bank-link-dialog")');
await ev('window.fixture.clock+=1');
// Saving starts the same bound request; secrets never become its arguments or its pending result.
assert.deepEqual(await ev('window.fixture.authorize()'),{status:'pending'});await frame();
await fill('[aria-label="Client ID"]','synthetic-client');await fill('[aria-label="Sandbox secret"]','synthetic-secret');await click('Save and continue');
await wait('document.querySelector(".bank-link-dialog h2")?.textContent==="Connect a bank"');
assert.deepEqual(await ev('window.fixture.calls.find(c=>c.path==="/api/bank/settings"&&c.method==="PUT").body'),{environment:'sandbox',clientId:'synthetic-client',sandboxSecret:'synthetic-secret'});
assert.equal(await ev('window.fixture.calls.filter(c=>c.path==="/api/conversations/chat/mod-data"&&c.body.instanceId==="instance").every(c=>JSON.stringify(c.body)===' + JSON.stringify(JSON.stringify({instanceId:'instance',method:'connections.authorize',params:{provider:'plaid'}})) + ')'),true);
await click('Cancel','document.querySelector(".bank-link-dialog")');
// Real unavailability and revoked permissions stay errors instead of entering setup.
await ev('window.fixture.clock+=60000');
for(const code of ['E_UNAVAILABLE','E_PERMISSION']){await ev('window.fixture.linkError='+JSON.stringify(code));assert.equal(await ev('window.fixture.authorize().then(()=>"unexpected",error=>error.code)'),code);assert.equal(await ev('!!document.querySelector(".bank-link-dialog")'),false);}await ev('delete window.fixture.linkError');
// The Manage Connect button uses the same setup, and a connected bank is shared only with this Mod.
await ev('window.fixture.installed=true;window.fixture.plaid={configured:false,environment:"sandbox",sandboxSecret:false,productionSecret:false};window.fixture.refresh()');await frame();await open('Personal finance');await click('Manage');await frame();
assert.deepEqual(await ev('window.fixture.authorize()'),{status:'pending'});await frame();
await click('Connect a bank','document.querySelector(".mod-bank-dialog")');
assert.match(await ev('document.querySelector(".mod-bank-dialog [role=alert]").textContent'),/Finish or close the open bank dialog, then try again/);
await click('Cancel','document.querySelector(".bank-link-dialog")');
await click('Connect a bank','document.querySelector(".mod-bank-dialog")');
await wait('document.querySelector(".bank-link-dialog h2")?.textContent==="Set up Plaid"');await click('Cancel','document.querySelector(".bank-link-dialog")');await frame();
await click('Connect a bank','document.querySelector(".mod-bank-dialog")');await frame();await fill('.bank-link-dialog [aria-label="Client ID"]','synthetic-client');await fill('.bank-link-dialog [aria-label="Sandbox secret"]','synthetic-secret');await click('Save and continue');await frame();await ev('window.fixture.linkStatus="connected"');await wait('!document.querySelector(".bank-link-dialog")');
assert.equal(await ev('window.fixture.calls.filter(c=>c.path.endsWith("/mods/fixture.finance")&&c.body.shared).length'),2);
await wait('document.querySelector(".mod-bank-dialog [data-settings-item=plaid-keys]").textContent.includes("Clear keys")');
assert.equal(await ev('[...document.querySelectorAll(".mod-bank-dialog button")].find(b=>b.textContent==="Save").disabled'),false);
await click('Close','document.querySelector(".mod-bank-dialog")');await click('Close details');
// A legacy inbox notice reconnects directly; an informational one opens this Mod's drawer.
await ev('window.fixture.linkStatus="waiting";window.fixture.notice("reauth_required",true)');await frame();await ev('document.querySelector(".sidebar-inbox").click()');await frame();await click('Bank connections','document.querySelector(".inbox-panel")');await wait('!!document.querySelector(".bank-link-dialog")');
assert.deepEqual(await ev('window.fixture.calls.filter(c=>c.path==="/api/bank/connections/link").at(-1).body'),{reconnect:'conn_fixture'});await click('Cancel','document.querySelector(".bank-link-dialog")');
await ev('window.fixture.notice("connected")');await frame();await ev('document.querySelector(".sidebar-inbox").click()');await frame();await click('Bank connections','document.querySelector(".inbox-panel")');await wait('!!document.querySelector(".store-drawer")');assert.equal(await ev('window.fixture.details'),'fixture.finance');
await click('Close details');await ev('window.fixture.connections[0].status="reauth_required";window.fixture.refresh()');await frame();await open('Personal finance');await wait('!!document.querySelector("[data-settings-item=mod-bank-row] .warning")');
assert.match(await ev('document.querySelector("[data-settings-item=mod-bank-row]").textContent'),/Needs sign-in again/);
await click('Manage');await frame();await click('Reconnect','document.querySelector(".mod-bank-dialog")');await wait('!!document.querySelector(".bank-link-dialog")');assert.deepEqual(await ev('window.fixture.calls.filter(c=>c.path==="/api/bank/connections/link").at(-1).body'),{reconnect:'conn_fixture'});await click('Cancel','document.querySelector(".bank-link-dialog")');
// Late concurrent starts recheck cancellation and visibility before showing a dialog.
await ev('window.fixture.clock+=60000;window.fixture.hold=true;void(window.fixture.pendingA=window.fixture.authorize().then(()=>"pending",e=>e.code));void(window.fixture.pendingB=window.fixture.authorize().then(()=>"pending",e=>e.code))');
await wait('window.fixture.deferred.length===2');await ev('window.fixture.deferred.shift()()');
assert.equal(await ev('window.fixture.pendingA'),'pending');await frame();await click('Cancel','document.querySelector(".bank-link-dialog")');
const cancelledSessions=await ev('window.fixture.calls.filter(c=>c.path.startsWith("/api/bank/link/")&&c.method==="DELETE").length');
await ev('window.fixture.deferred.shift()()');assert.equal(await ev('window.fixture.pendingB'),'E_LIMIT');
assert.equal(await ev('!!document.querySelector(".bank-link-dialog")'),false);
assert.equal(await ev('window.fixture.calls.filter(c=>c.path.startsWith("/api/bank/link/")&&c.method==="DELETE").length'),cancelledSessions+1);
await ev('window.fixture.clock+=60000;void(window.fixture.pendingC=window.fixture.authorize().then(()=>"pending",e=>e.code))');await wait('window.fixture.deferred.length===1');
await ev('window.fixture.visible=false;window.fixture.deferred.shift()()');assert.equal(await ev('window.fixture.pendingC'),'E_UNAVAILABLE');
assert.equal(await ev('!!document.querySelector(".bank-link-dialog")'),false);
assert.equal(await ev('window.fixture.calls.filter(c=>c.path.startsWith("/api/bank/link/")&&c.method==="DELETE").length'),cancelledSessions+2);
assert.deepEqual(external,[]);assert.deepEqual(await ev('window.fixture.errors'),[]);
console.log('PASS Mod bank setup: permission rows, scoped backup/restore/delete, guided authorize/cancel/save, Manage connect/share, legacy inbox reconnect, details navigation; six offscreen PNGs');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const timer = setTimeout(() => child.kill(), 75000);
      try {
        const code = await new Promise<number | null>((done, reject) => {
          child.once('error', reject);
          child.once('exit', done);
        });
        assert.equal(code, 0, output);
        assert.match(output, /PASS Mod bank setup/);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      assert.equal(dirname(resolve(fixture)).toLowerCase(), resolve(tmpdir()).toLowerCase());
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  },
);
