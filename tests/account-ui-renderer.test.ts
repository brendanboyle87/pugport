import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'Account renderer: hidden configuration, auth, upgrade waiting, merge consent, checklist and themes',
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pugport-account-ui-'));
    const shots = resolve('artifacts/account-sync/screenshots');
    await mkdir(shots, { recursive: true });
    await build({
      absWorkingDir: process.cwd(),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AccountSettings,AccountWelcome,AccountSyncPill} from './src/ui/AccountSettings';
import {SettingsShell} from './src/ui/SettingsShell';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {startInterfaceLanguage,applyInterfaceLocale} from './src/ui/i18n';
window.applyLocale=applyInterfaceLocale;
import './src/ui/studio.css';
import './src/ui/settings.css';
import './src/ui/AccountSettings.css';
localStorage.setItem('comborunner.locale','en');
window.fetch=()=>{throw Error('Unexpected network');};
const base={configured:true,auth:{phase:'signed-out'},sync:'off',setup:'none',devices:[],missingProviders:[]};
const f=window.fixture={view:base,calls:[],errors:[],skipped:false,opened:false};
window.addEventListener('error',e=>f.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason)));
const state={app:{platform:'win32'},targets:[],runtimes:[],settings:{},refreshing:false};
const action=async(name,body)=>{f.calls.push({name,body});return f.view;};
const root=createRoot(document.getElementById('root'));
window.show=(patch={})=>{f.view={...base,...patch};flushSync(()=>root.render(<><ConfirmDialogHost/><SettingsShell category="account" onCategory={()=>{}} accountConfigured={f.view.configured}><AccountSettings view={f.view} action={action} busy={false} state={state} api={async()=>({})} reload={async()=>{}} notify={()=>{}} onOpenAccounts={()=>{f.opened=true}}/></SettingsShell><AccountWelcome view={f.view} dismissed={f.skipped} onSkip={()=>{f.skipped=true;window.show(f.view)}} onOpen={()=>{f.opened=true}}/><AccountSyncPill view={f.view} onOpen={()=>{f.opened=true}}/></>));};
void startInterfaceLanguage().then(()=>{window.show();f.ready=true});`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(dir, 'fixture.js'),
    });
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(dir, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const ev=s=>win.webContents.executeJavaScript(s);
const wait=async(s)=>{for(let i=0;i<200;i++){if(await ev(s))return;await new Promise(r=>setTimeout(r,15));}throw Error('Timed out: '+s)};
const click=async(s)=>{await ev('document.querySelector('+JSON.stringify(s)+').click()');await new Promise(r=>setTimeout(r,40));};
let win;
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(d,cb)=>cb({cancel:true}));
 await win.loadFile(path.join(__dirname,'index.html'));await wait('window.fixture?.ready');
 await ev('show({configured:false})');assert.equal(await ev('document.querySelector("[data-settings-category=account]")'),null);assert.equal(await ev('document.querySelector(".account-settings")'),null);assert.equal(await ev('document.querySelector(".account-welcome")'),null);
 await ev('show()');await wait('document.body.textContent.includes("Continue with Google")');await click('[data-account-action="sign-in"]');assert.equal(await ev('fixture.calls.at(-1).name'),'sign-in');
 await click('[data-account-skip]');assert.equal(await ev('!!document.querySelector(".account-welcome")'),false);
 await ev('show({auth:{phase:"signing-in"}})');await wait('document.body.textContent.includes("Waiting for your browser")');await click('[data-account-action="cancel"]');
 await ev('show({auth:{phase:"signed-out",memoryOnly:true,error:"SESSION_EXPIRED"}})');await wait('document.body.textContent.includes("Sign in again")');
 const signed={phase:'signed-in',email:'synthetic@example.test',memoryOnly:true};
 await ev('show({auth:'+JSON.stringify(signed)+',setup:"waiting-upgrade"})');await wait('document.body.textContent.includes("Open PugPort on the computer that last synced")');assert.equal(await ev('document.querySelector(".account-sync-state").textContent'),'Waiting for your other computer');assert.equal(await ev('document.querySelector(".account-setup details").open'),false);assert.equal(await ev('document.querySelector(".account-setup summary").textContent'),"Can't use that computer?");
 await click('.account-setup details .button.danger');await wait('!!document.querySelector("dialog[open]")');assert.equal(await ev('fixture.calls.some(x=>x.name==="delete-cloud")'),false);await click('dialog .button.danger');assert.deepEqual(await ev('fixture.calls.at(-1)'),{name:'delete-cloud',body:{confirmed:true}});
 await ev('show({auth:'+JSON.stringify(signed)+',setup:"upgrading"})');await wait('document.querySelector(".account-sync-state")?.textContent==="Upgrading cloud data…"');assert.equal(await ev('/recovery code/i.test(document.body.textContent)'),false);
 await ev('show({auth:'+JSON.stringify(signed)+',setup:"ready",sync:"idle",error:"UPGRADE_FAILED"})');await wait('document.body.textContent.includes("The cloud upgrade did not finish. It retries automatically.")');
 await ev('show({auth:'+JSON.stringify(signed)+',setup:"merge",merge:{local:{chats:1,folders:2,projects:3,memories:4},cloud:{chats:5,folders:6,projects:7,memories:8},accountChange:true}})');
 await wait('document.body.textContent.includes("backup")');assert.equal(await ev('document.querySelector(".account-sync-pill.wait")?.textContent'),'Merge pending');assert.equal(await ev('document.querySelector("[data-settings-item=account-merge]")?.tabIndex'),-1);assert.equal(await ev('!!document.querySelector("[data-settings-item=account-merge] [data-settings-focus]")'),false);await click('[data-account-merge]');await wait('!!document.querySelector("dialog[open]")');assert.equal(await ev('fixture.calls.some(x=>x.name==="merge")'),false);await click('dialog .button.danger');assert.equal(await ev('fixture.calls.at(-1).body.allowAccountChange'),true);
 await ev('show({auth:'+JSON.stringify(signed)+',setup:"ready",sync:"offline",deviceName:"Test PC",devices:[{id:"other",name:"Other PC",platform:"linux",last_seen_at:"2026-10-29T12:00:00Z",cli_providers:["codex"]}],missingProviders:["codex","grok","gemini","agy"]})');
 await wait('document.body.textContent.includes("Sign in to Codex")');assert.equal(await ev('document.body.textContent.includes("Gemini")||document.body.textContent.includes("agy")'),false);await click('.account-sync-pill');assert.equal(await ev('fixture.opened'),true);
 for(const theme of ['light','dark']){await ev('document.documentElement.dataset.theme='+JSON.stringify(theme));await new Promise(r=>setTimeout(r,100));await fs.writeFile(path.join(process.argv[2],theme+'.png'),(await win.webContents.capturePage()).toPNG());}
 for(const sync of ['syncing','error: OFFLINE','idle']){await ev('show({auth:'+JSON.stringify(signed)+',setup:"ready",sync:'+JSON.stringify(sync)+'})');assert.equal(await ev('!!document.querySelector(".account-sync-pill")'),sync!=='idle');}
 await ev('window.applyLocale("zh-CN")');await wait('document.body.textContent.includes("\u9000\u51fa\u767b\u5f55")');await ev('window.applyLocale("en")');await wait('document.body.textContent.includes("Sign out")');
 assert.deepEqual(await ev('fixture.errors'),[]);console.log('Account renderer assertions passed');app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(dir, 'runner.cjs'), shots),
      { timeout: 80000, env, windowsHide: true },
    );
    assert.match(result.stdout, /Account renderer assertions passed/);
    assert.ok((await readFile(join(shots, 'dark.png'))).length > 1000);
  },
);
