import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { packMod } from '../scripts/pack-mod.ts';

test(
  'Mods Store renderer keeps local search, visual details and managed load-open-unload offline',
  { timeout: 60000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-mode-store-ui-'));
    const artifacts = resolve(process.env.MOD_STORE_ARTIFACTS ?? 'artifacts/mode-store');
    await mkdir(artifacts, { recursive: true });
    const { manifest: example } = await packMod(join(root, 'docs/examples/mods/reading-notes'), {
      out: join(fixture, 'reading-notes.json'),
    });
    const manifest = {
      ...example,
      id: 'fixture.custom',
      version: '1.0.0',
      author: 'Fixture',
      category: '写作',
      readme: `${example.readme}\n\n![Blocked remote image](https://images.invalid/fixture-cover.png)`,
    };
    await writeFile(
      join(fixture, 'style.css'),
      'body{overflow:auto}#root{padding:24px}.fixture-mode-menu{display:flex;justify-content:flex-end}@media(max-width:560px){#root{padding:16px}}',
    );
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><link rel="stylesheet" href="style.css"><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';import '@fontsource-variable/jetbrains-mono';
import './src/ui/studio.css';
import './src/ui/StorePage.css';import './src/ui/mods/mods.css';import './src/ui/ConversationModeView.css';
import './src/ui/settings.css';
import{StorePage}from'./src/ui/StorePage';import{ModToolbarButton}from'./src/ui/mods/ModToolbarButton';
import{ModFormView}from'./src/ui/ConversationModeView';
import{normalizeModManifest}from'./src/shared/mods-manifest';
import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';
window.fixture={calls:[],uses:[],notices:[],opens:[],catalog:[],installed:[],failInstall:true,retainedState:{note:"已有合成笔记"},menuOpens:0,downloads:0,objectUrls:0};
const createUrl=URL.createObjectURL.bind(URL),anchorClick=HTMLAnchorElement.prototype.click;
URL.createObjectURL=blob=>{window.fixture.objectUrls++;return createUrl(blob);};
HTMLAnchorElement.prototype.click=function(){if(this.download){window.fixture.downloads++;throw new Error('Unexpected Save As');}else anchorClick.call(this);};
let rerender;
const api=async(path,body,method='POST')=>{
 const f=window.fixture;f.calls.push({path,body,method});
 const modes=()=>({catalog:[...f.catalog],installed:[...f.installed]});
 if(path==='/api/bank/settings')return{configured:false};
 if(path==='/api/bank/connections')return{connections:[]};
 if(path==='/api/mod-data')return{mods:[]};
 if(path==='/api/modes')return modes();
 if(path==='/api/modes/source')return{config:null,status:'unconfigured',catalog:[]};
 if(path==='/api/modes/import'){const{readme,...entry}=body.manifest;f.manifest=body.manifest;f.catalog=[{...entry,compatible:true},{...entry,version:"2.0.0",description:"Keep reading notes close to your conversation.",author:"Fixture",compatible:true}];return modes();}
 if(path==='/api/modes/fixture.custom/install'){
  if(method!=='DELETE'&&f.failInstall){f.failInstall=false;throw new Error('Synthetic install unavailable');}
  if(f.holdInstall)await new Promise(resolve=>{f.releaseInstall=resolve;});
  f.installed=method==='DELETE'?[]:[{modeId:'fixture.custom',version:body.version,installedAt:''}];rerender();return modes();
 }
 if(path==='/api/modes/fixture.custom/versions/1.0.0/export')return f.manifest;
 if(path==='/api/modes/fixture.custom/versions/2.0.0/export')return{...f.manifest,version:'2.0.0'};
 throw new Error('Unexpected synthetic API');
};
const notes=normalizeModManifest({schemaVersion:1,id:'fixture.notes',version:'1.0.0',title:'通用表单 · 隔离测试',description:'不是商店上架产品。',view:{markdown:'填写一段笔记，然后将它放入对话输入框。',fields:[{id:'note',label:'笔记',type:'textarea'}],actions:[{id:'compose',label:'填入对话',type:'compose',prompt:'请解释这段笔记'}]}});
function Fixture(){const[epoch,setEpoch]=useState(0);const[form,setForm]=useState(false);const[notesState,setNotes]=useState({note:'用于截图的合成笔记。'});rerender=()=>setEpoch(v=>v+1);window.fixture.showForm=()=>setForm(true);return <><div className="fixture-mode-menu"><ModToolbarButton hidden={false} hasSurface={false} onToggle={()=>{}} onStore={()=>{}} installed={window.fixture.catalog.filter(m=>window.fixture.installed.some(i=>i.modeId===m.id&&i.version===m.version))} onOpen={()=>{window.fixture.menuOpens++;}} onSelect={id=>window.fixture.uses.push(id)}/></div>{!form&&<StorePage api={api} notify={n=>window.fixture.notices.push(n)} onOpenMod={mode=>window.fixture.opens.push(mode)}/>}{form&&<ModFormView view={{binding:{instanceId:'notes-instance',modeId:notes.id,version:notes.version},pending:null,installed:true,manifest:notes,instance:{id:'notes-instance',conversationId:'synthetic',modeId:notes.id,version:notes.version,schemaVersion:1,revision:0,state:notesState,createdAt:'',updatedAt:''}}} busy={false} onSave={async values=>{window.fixture.saved=values;setNotes(values);}} onCompose={text=>{window.fixture.composed=text;}} onStore={()=>{}}/>}<ConfirmDialogHost/></>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.woff2': 'file' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1120,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 const externalRequests=[];win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const external=!/^(file|data):/.test(d.url);if(external)externalRequests.push(d.url);cb({cancel:external});});
 let downloads=0;win.webContents.session.on('will-download',event=>{downloads++;event.preventDefault();});
 await win.loadFile(path.join(__dirname,'index.html'));const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error('Synthetic renderer step failed: '+code.slice(0,200),{cause:error});}};
 assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('h1')].some(el=>el.textContent==='Mods Store')"),false);
 const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const ready=async code=>{for(let i=0;i<60;i++){if(await evaluate(code))return;await frame();}assert.fail('Renderer condition did not settle: '+code);};
 const click=async(label,scope='document')=>{await evaluate('[...'+scope+'.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'||b.getAttribute("aria-label")==='+JSON.stringify(label)+').click()');await frame();};
 const shot=async name=>{await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
 for(let i=0;i<30;i++){await frame();if(await evaluate('!!document.querySelector(".store-empty")'))break;}
 await evaluate('document.fonts.ready');
 assert.match(await evaluate('getComputedStyle(document.body).fontFamily'),/Inter Variable/);
 assert.equal(await evaluate('[...document.fonts].some(f=>f.family.includes("Inter Variable")&&f.status==="loaded")'),true);
 assert.equal(await evaluate('[...document.fonts].some(f=>f.family.includes("Noto Sans SC Variable")&&f.status==="loaded")'),true);
    assert.equal(await evaluate('document.querySelector(".mod-toolbar")'),null);
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".mode-store")).maxWidth'),'1080px');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".store-search input")).height'),'38px');
 assert.equal(await evaluate('(()=>{const a=document.querySelector(".store-toolbar button").getBoundingClientRect(),b=document.querySelector(".store-search").getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom})()'),true);
 assert.equal(await evaluate('document.querySelectorAll(".store-tabs [role=tab]").length'),2);
 assert.match(await evaluate('document.body.textContent'),/这里还没有 Mods/);assert.doesNotMatch(await evaluate('document.body.textContent'),/学习模式/);
 assert.equal(await evaluate('window.fixture.menuOpens'),1);await shot('discover-light-wide');
 assert.equal(await evaluate('window.fixture.calls.filter(c=>c.path==="/api/modes").length'),1);
 assert.equal(await evaluate('window.fixture.calls.filter(c=>c.path==="/api/modes/source"&&c.method==="GET").length'),1);
 await click('导入 Mod');
 const manifest=${JSON.stringify(manifest)};
 await evaluate('(()=>{const e=document.querySelector("#mode-manifest");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(JSON.stringify(manifest))+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();await click('导入清单');
 assert.equal(await evaluate('window.fixture.installed.length'),0);assert.equal(await evaluate('window.fixture.uses.length'),0);
 const beforeSearch=await evaluate('window.fixture.calls.length');
 const search=async value=>{await evaluate('(()=>{const e=document.querySelector(".store-search input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};
 await search('missing');assert.equal(await evaluate('document.querySelectorAll(".store-mode-card").length'),0);
 await search('Fixture');assert.equal(await evaluate('document.querySelectorAll(".store-mode-card").length'),1);
 await search('2.0.0');assert.equal(await evaluate('!!document.querySelector(".store-categories")'),true);assert.equal(await evaluate('document.querySelectorAll(".store-mode-card").length'),1);await search('');
 assert.equal(await evaluate('window.fixture.calls.length'),beforeSearch);
 assert.equal(await evaluate('document.querySelector(".store-mode-group > h3")'),null);
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".store-mode-card")).borderRadius'),'0px');
 assert.equal(await evaluate('document.querySelector(".store-mode-card").getBoundingClientRect().height<500'),true);
 assert.equal(await evaluate('Object.hasOwn(window.fixture.catalog[0],"readme")'),false);
 await ready('document.querySelector(".store-cover-button img").complete&&document.querySelector(".store-cover-button img").naturalWidth===800&&document.querySelector(".store-cover-button img").naturalHeight===600');
 assert.equal(await evaluate('document.querySelectorAll("a[download]").length'),0);
 assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="下载")'),false);
 await shot('catalog-light-wide');
 const beforeDetails=await evaluate('window.fixture.calls.length');
 await evaluate('document.querySelector(".store-cover-button").focus();document.querySelector(".store-cover-button").click()');await frame();
 await ready('!!document.querySelector(".store-readme")&&document.querySelector(".store-drawer img").naturalWidth===1280&&document.querySelector(".store-drawer img").naturalHeight===720');
 assert.equal(await evaluate('document.querySelector(".store-drawer").open'),true);
 assert.equal(await evaluate('(()=>{const r=document.querySelector(".store-drawer > img").getBoundingClientRect();return Math.abs(r.width/r.height-16/9)<0.01})()'),true);
 assert.equal(await evaluate('document.querySelector(".store-drawer-heading .button.primary").getBoundingClientRect().bottom<innerHeight'),true);
 assert.equal(await evaluate('document.querySelectorAll(".store-drawer .store-detail-access").length'),1);
 assert.equal(await evaluate('document.querySelector(".store-detail-access").textContent'),'可以读取这个对话的消息，并在输入框里填写草稿；不会代你发送。');
 assert.equal(await evaluate('document.querySelectorAll(".store-mode-card .store-detail-access,.mod-menu .store-detail-access").length'),0);
 await ready('document.querySelector(".store-drawer").getAnimations().every(a=>a.playState==="finished")');
 assert.equal(await evaluate('document.querySelector(".store-drawer").getBoundingClientRect().width'),760);
 assert.match(await evaluate('document.querySelector(".store-readme").textContent'),/Notes save as you type and stay with this chat/);
 assert.equal(await evaluate('document.querySelectorAll(".store-readme img").length'),0);
 assert.equal(await evaluate('[...document.querySelectorAll(".store-drawer button")].some(b=>b.textContent.trim()==="打开介绍网页")'),false);
 assert.equal(await evaluate('document.querySelectorAll(".store-drawer a.button").length'),0);
 assert.equal(await evaluate('window.fixture.installed.length'),0);assert.equal(await evaluate('window.fixture.uses.length'),0);
 assert.deepEqual(await evaluate('window.fixture.calls.slice('+beforeDetails+')'),[{path:'/api/modes/fixture.custom/versions/2.0.0/export',body:undefined,method:'GET'}]);
 for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('store-detail-'+theme);}
 for(const theme of ['light','dark']){for(const width of [1120,390]){
  await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));win.setSize(width,1000);await frame();
  assert.equal(await evaluate('(()=>{const d=document.querySelector(".store-drawer");const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth})()'),true);
  await evaluate('document.querySelector(".store-drawer").scrollTop=0');await shot('mode-detail-'+theme+'-'+(width===1120?'wide':'narrow'));
  await evaluate('document.querySelector(".store-detail-layout").scrollIntoView({block:"start"})');await shot('mode-readme-'+theme+'-'+(width===1120?'wide':'narrow'));
 }}
 await evaluate('document.documentElement.dataset.theme="light"');win.setSize(1120,1000);await frame();
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await frame();
 assert.equal(await evaluate('document.querySelector(".store-drawer")'),null);
 assert.equal(await evaluate('document.activeElement===document.querySelector(".store-cover-button")'),true);
 await evaluate('document.querySelector(".store-mode-title button").click()');await frame();assert.equal(await evaluate('document.querySelector(".store-drawer").open'),true);await click('关闭详情','document.querySelector("dialog")');
 await click('加载');assert.match(await evaluate('document.querySelector(".store-mode-description[role=alert]").textContent'),/没能完成，请重试/);
 assert.equal(await evaluate('window.fixture.uses.length'),0);
 await evaluate('window.fixture.holdInstall=true');await click('加载');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".store-mode-card .button.tiny")].map(b=>({disabled:b.disabled,spinning:!!b.querySelector(".spinning")}))'),[{disabled:true,spinning:true}]);
 await shot('mods-one-loading');
 await click('查看「Reading notes」详情');assert.equal(await evaluate('!!document.querySelector(".store-drawer .button.primary .spinning")'),true);await click('关闭详情','document.querySelector("dialog")');
 await evaluate('window.fixture.holdInstall=false;window.fixture.releaseInstall()');await ready('window.fixture.installed.length===1&&!document.querySelector(".store-mode-card .button.tiny").disabled');assert.deepEqual(await evaluate('window.fixture.uses'),[]);
 assert.equal(await evaluate('window.fixture.calls.filter(c=>c.path==="/api/modes/fixture.custom/install").length'),2);
 assert.equal(await evaluate('window.fixture.calls.find(c=>c.path==="/api/modes/fixture.custom/install").body.version'),'2.0.0');
 await click('已加载');assert.equal(await evaluate('document.querySelectorAll(".store-mode-card").length'),1);
 for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('store-grid-'+theme);}
 await evaluate('document.documentElement.dataset.theme="light"');
 const source='document.querySelector(".store-mode-card .store-cover-button")';await evaluate(source+'.focus();'+source+'.click()');await frame();
 await click('关闭详情','document.querySelector("dialog")');assert.equal(await evaluate('document.activeElement === '+source),true);
 assert.equal(await evaluate('document.querySelectorAll(".mod-toolbar-button").length'),1);
 assert.equal(await evaluate('document.querySelector(".store-mode-card .button.tiny").textContent.trim()'),'打开');
 await click('打开');assert.deepEqual(await evaluate('window.fixture.opens'),[{id:'fixture.custom',version:'2.0.0',title:manifest.title}]);
 await evaluate('document.querySelector(".mod-toolbar-button").click()');await frame();
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".mod-menu [role=menuitem]")].map(e=>e.textContent.trim())'),['Reading notes']);
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await frame();
 for(const width of [1120,760,390]){win.setSize(width,1000);await frame();assert.equal(await evaluate('document.querySelector(".store-source-toggle").getClientRects().length>0'),width>900);assert.equal(await evaluate('getComputedStyle(document.querySelector(".store-source")).display==="none"'),width<=900);}
 await evaluate('document.documentElement.dataset.theme="dark"');win.setSize(390,1000);await frame();
 const labels=await evaluate('({title:window.fixture.catalog[1].title,category:window.fixture.catalog[1].category})');
 await evaluate('window.fixture.catalog[1].title="长标题窄屏测试".repeat(12);window.fixture.catalog[1].category="很长的真实分类".repeat(5)');await search('Fixture');
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 await evaluate('Object.assign(window.fixture.catalog[1],'+JSON.stringify(labels)+')');await search('');
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await shot('installed-dark-narrow');
 await click('查看「Reading notes」详情');await frame();assert.equal(await evaluate('!!document.querySelector(".mod-resources")'),false);assert.equal(await evaluate('document.querySelector("dialog").getBoundingClientRect().right<=innerWidth'),true);await shot('mode-detail-dark-narrow');
 await click('卸载','document.querySelector(".store-drawer")');await frame();await click('卸载','document.querySelector(".confirm-dialog")');
 assert.equal(await evaluate('window.fixture.installed.length'),0);assert.match(await evaluate('document.body.textContent'),/还没有加载 Mods/);
 assert.equal(await evaluate('window.fixture.catalog.length'),2);assert.equal(await evaluate('window.fixture.retainedState.note'),'已有合成笔记');
 await click('发现');await click('加载');assert.equal(await evaluate('window.fixture.installed.length'),1);
 assert.equal(await evaluate('window.fixture.calls.filter(c=>c.path==="/api/modes/fixture.custom/install"&&c.method==="POST").length'),3);
 assert.equal(await evaluate('window.fixture.retainedState.note'),'已有合成笔记');assert.deepEqual(await evaluate('window.fixture.uses'),[]);
 assert.equal(await evaluate('window.fixture.calls.some(c=>/extensions|workflows|runs|turn/.test(c.path))'),false);
 await evaluate('window.fixture.installed[0].version="1.0.0";window.fixture.failInstall=true');
 await click('导入 Mod');
 await evaluate('(()=>{const e=document.querySelector("#mode-manifest");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(JSON.stringify(manifest))+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();await click('导入清单');
 assert.equal(await evaluate('document.querySelectorAll(".store-mode-card").length'),1);
 assert.equal(await evaluate('document.querySelector(".store-tabs .plan-badge").textContent'),'1');
 await shot('update-card');await click('查看「Reading notes」详情');await frame();
 assert.match(await evaluate('document.querySelector(".store-drawer").textContent'),/有可用更新：1.0.0 → 2.0.0/);
 await shot('update-detail');await click('更新到 2.0.0');
 assert.equal(await evaluate('window.fixture.installed[0].version'),'1.0.0');
 assert.ok(await evaluate('document.querySelector(".store-detail-error")'));
 await click('更新到 2.0.0');await frame();
 assert.equal(await evaluate('window.fixture.installed[0].version'),'2.0.0');
 assert.equal(await evaluate('document.querySelector(".store-tabs .plan-badge")'),null);
 assert.equal(await evaluate('document.querySelector(".store-drawer .button.primary").textContent.trim()'),'打开');
 await click('关闭详情');
 await evaluate('window.fixture.showForm()');await frame();await evaluate('document.querySelector(".conversation-mode-view").scrollIntoView({block:"start"})');await frame();
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".conversation-mode-view textarea")).minHeight'),'96px');
 const beforeCompose=await evaluate('window.fixture.calls.length');await click('填入对话');assert.equal(await evaluate('window.fixture.calls.length'),beforeCompose);
 assert.match(await evaluate('window.fixture.composed'),/请解释这段笔记/);assert.equal(await evaluate('window.fixture.saved.note'),'用于截图的合成笔记。');await shot('generic-form-dark-narrow');
 assert.deepEqual(externalRequests,[]);assert.equal(downloads,0);assert.equal(await evaluate('window.fixture.downloads'),0);assert.equal(await evaluate('window.fixture.objectUrls'),0);
 console.log('PASS Store renderer: no external requests or Save As, local search/category, actual 960x540 WebP, export-only README, managed load retry, unload and reload, focus/Escape, four detail layouts');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
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
    const timeout = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS Store renderer/);
    } finally {
      clearTimeout(timeout);
      assert.equal(dirname(resolve(fixture)).toLowerCase(), resolve(tmpdir()).toLowerCase());
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  },
);
