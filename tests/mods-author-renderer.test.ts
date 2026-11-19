import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { packMod } from '../scripts/pack-mod';

// Owner-only: actual frames and author code with synthetic persistence, never real chat data.
test(
  'author example, sidebar lifecycle, independent windows, logo fallback and removal Undo',
  { timeout: 90000 },
  async () => {
    const root = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'mods-author-renderer-'));
    try {
      const packed = await packMod('docs/examples/mods/reading-notes', { out: join(dir, 'notes.json') });
      assert.equal(packed.manifest.schemaVersion, 2);
      const logo = `data:image/png;base64,${(await readFile(join(root, 'src/ui/assets/mod-cover.png'))).toString('base64')}`;
      await writeFile(
        join(dir, 'index.html'),
        '<!doctype html><html data-theme="light"><link rel="stylesheet" href="fixture.css"><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React,{useState,useRef}from'react';import{createRoot}from'react-dom/client';
import{ModFrame}from'./src/ui/mods/ModFrame';import{ModWorkspaceBar}from'./src/ui/mods/ModWorkspaceBar';
import{ModeIcon}from'./src/ui/mods/mod-icons';import{resolveModLayout}from'./src/ui/mods/mod-layout';
import{removeConversationMod}from'./src/ui/mod-removal';import{uiUpdateBlocked}from'./src/ui/ui-update-guard';
import './src/ui/mods/mods.css';
const manifest=${JSON.stringify(packed.manifest)};
manifest.ui.entries.sidebar={html:'<input id="sidebar-input" aria-label="Sidebar notes">',js:''};
const companionManifest={...manifest,contributions:{sidebarPanel:{kind:'web',entry:'sidebar'}}};
const binding={instanceId:'i',modeId:manifest.id,version:manifest.version};
const f=window.fixture={chat:'a',chatOpen:false,hidden:false,attached:true,state:{revision:0,values:{notes:'saved'}},drafts:[],notices:[],calls:[],logo:${JSON.stringify(logo)},icon:'book-open',blocked:uiUpdateBlocked};
let redraw;const repaint=()=>redraw(n=>n+1);f.set=p=>{Object.assign(f,p);repaint();};
const view=()=>({binding:f.attached?binding:null,pending:null,installed:true,manifest,instance:{id:'i',conversationId:f.chat,modeId:manifest.id,version:manifest.version,revision:f.state.revision,state:f.state.values,schemaVersion:2,createdAt:'',updatedAt:''}});
const hosts=new Map();function host(id,companion=false){const key=id+companion;if(!hosts.has(key))hosts.set(key,{conversationId:id,modId:manifest.id,version:manifest.version,instanceId:'i',manifest:companion?companionManifest:manifest,isCurrent:()=>f.attached&&f.chat===id,info:()=>({apiVersion:2,hostVersion:'fixture',locale:'en',theme:'light',tokens:{'--text':'#202020','--surface-1':'#ffffff','--sidebar':'#f4f4f4','--accent-text':'#2558aa','--border':'#dddddd','--muted':'#666666','--focus':'#2558aa'},slot:'mainView',layout:'workspace',conversation:{id,title:id}}),getState:async()=>structuredClone(f.state),setState:async(values,revision)=>{if(revision!==f.state.revision)throw Object.assign(new Error('Conflict'),{code:'E_CONFLICT'});f.state={revision:revision+1,values:{...f.state.values,...values}};repaint();return structuredClone(f.state);},messages:()=>[{id:'m',role:'user',content:'<b>Latest synthetic message</b>',createdAt:'2026-10-29'}],chat:open=>{f.chatOpen=open;repaint();},insert:(text,mode)=>{f.chatOpen=true;f.drafts.push({text,mode});document.getElementById('composer').value+=text;document.getElementById('composer').focus();},notify:(title,message)=>f.notices.push({title,message})});return hosts.get(key);}
const api=async(path,body,method)=>{f.calls.push({path,body,method});f.attached=body.modeId!==null;return view();};
const notify=n=>{f.notice=n;repaint();};
f.remove=()=>removeConversationMod(api,{id:f.chat,modeBinding:binding},notify,async()=>repaint(),()=>true);
function Fixture(){const[,update]=useState(0);redraw=update;const toggle=useRef(null);const layout=resolveModLayout(manifest,f.hidden,false);const sidebarLayout=resolveModLayout(companionManifest,f.hidden,false);const web={host:host(f.chat),state:f.state,messages:{count:1,lastId:'m'},running:false};return <>
<div id="logo" style={{color:'rgb(10, 20, 30)'}}><ModeIcon mode={{icon:f.icon,logo:f.logo?{src:f.logo,alt:'Synthetic'}:undefined}}/></div>
<aside id="sidebar" style={{height:500,display:'flex',flexDirection:'column'}}><div className="mod-sidebar-slot">{f.attached&&<ModFrame key={f.chat} {...web} host={host(f.chat,true)} slot="sidebarPanel" hidden={!sidebarLayout.sidebarPanel.visible}/>}</div></aside>
{f.attached&&<div style={{height:600}}><ModWorkspaceBar mode={manifest} chatOpen={f.chatOpen} chatId="composer" chatToggle={toggle} busy={false} onChat={()=>f.set({chatOpen:!f.chatOpen})} onDetails={()=>{}} onHide={()=>f.set({hidden:true})} onRemove={()=>void f.remove()}/><ModFrame key={f.chat} {...web} slot="mainView" hidden={!layout.mainView.visible}/></div>}
<textarea id="composer"/><button id="sidebar-remove" onClick={()=>void f.remove()}>Remove from sidebar</button>
{f.notice?.action&&<button id="undo" onClick={()=>void f.notice.action.run()}>Undo</button>}
</>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
        },
        bundle: true,
        platform: 'browser',
        outfile: join(dir, 'fixture.js'),
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      });
      const runner = join(dir, 'runner.cjs');
      await writeFile(
        runner,
        `
const assert=require('node:assert/strict'),path=require('node:path');const{app,BrowserWindow}=require('electron');
const{frameDisposed,srcdocFrames}=require(${JSON.stringify(join(root, 'tests', 'helpers', 'electron-frames.cjs'))});
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const windows=[];try{console.log('author: ready');
const open=async()=>{const w=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});windows.push(w);await w.loadFile(path.join(__dirname,'index.html'));console.log('author: window loaded');return w;};
const win=await open();const read=code=>win.webContents.executeJavaScript(code);
// A frame found by an earlier attempt may be disposed by a remount meanwhile; the check then looks it up again.
const wait=async(check)=>{for(let i=0;i<150;i++){try{if(await check())return;}catch(error){if(!frameDisposed(error))throw error;}await new Promise(r=>setTimeout(r,20));}throw Error('Renderer condition timed out');};
const child=async(w,selector)=>{for(const frame of srcdocFrames(w.webContents)){let timer;try{const found=await Promise.race([frame.executeJavaScript('!!document.querySelector('+JSON.stringify(selector)+')'),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),500);})]);if(found)return frame;}catch{}finally{clearTimeout(timer);}}return null;};
console.log('author: locating frames');let panel,sidebar;await wait(async()=>{panel=await child(win,'#notes');sidebar=await child(win,'#sidebar-input');return panel&&sidebar&&await panel.executeJavaScript('!document.getElementById("discuss").disabled');});
assert.equal(await panel.executeJavaScript('document.getElementById("notes").value'),'saved');
assert.equal(await panel.executeJavaScript('document.body.getBoundingClientRect().height===innerHeight'),true);
assert.equal(await panel.executeJavaScript('document.getElementById("mod-root").getBoundingClientRect().height===innerHeight'),true);
assert.equal(await panel.executeJavaScript('document.querySelector(".bar").getBoundingClientRect().bottom===innerHeight'),true);
await panel.executeJavaScript('document.getElementById("quote").click()');await wait(()=>read('window.fixture.chatOpen'));
await read('window.fixture.set({chatOpen:false})');
await wait(async()=>await panel.executeJavaScript('document.getElementById("status").textContent')==='No reply yet. Ask something in the chat.');
assert.equal(await read('document.querySelectorAll("iframe").length'),2);
assert.equal(await read('document.querySelector(".mod-sidebar-slot").getBoundingClientRect().height<=200'),true);
const edit=async(text)=>panel.executeJavaScript('document.getElementById("notes").value='+JSON.stringify(text)+';document.getElementById("notes").dispatchEvent(new Event("input"))');
console.log('author: initial state ready');await edit('local edit');await wait(()=>read('window.fixture.blocked()'));
await sidebar.executeJavaScript('document.getElementById("sidebar-input").value="unsaved sidebar"');
await read('window.originalFrame=document.querySelector(".mod-sidebar-slot iframe");window.fixture.set({hidden:true})');
await wait(()=>read('document.querySelector(".mod-sidebar-slot .mod-frame").hidden'));
assert.equal(await read('getComputedStyle(document.querySelector(".mod-sidebar-slot")).display'),'none');
await read('window.fixture.set({hidden:false})');await wait(()=>read('!document.querySelector(".mod-sidebar-slot .mod-frame").hidden'));
assert.equal(await read('document.querySelector(".mod-sidebar-slot iframe")===window.originalFrame'),true);
assert.equal(await sidebar.executeJavaScript('document.getElementById("sidebar-input").value'),'unsaved sidebar');
assert.equal(await panel.executeJavaScript('document.getElementById("notes").value'),'local edit');
await read('window.fixture.set({state:{revision:1,values:{notes:"saved elsewhere"}}})');
await panel.executeJavaScript('document.getElementById("discuss").click()');
await wait(async()=>await panel.executeJavaScript('document.getElementById("status").textContent')==='Also changed in another window.');
assert.equal(await read('window.fixture.drafts.length'),0);
await edit('saved');assert.equal(await panel.executeJavaScript('document.getElementById("notes").value'),'saved');

await wait(()=>read('window.fixture.blocked()'));
await panel.executeJavaScript('document.getElementById("retry").click()');await wait(()=>read('window.fixture.state.revision===2&&!window.fixture.blocked()'));
await edit('draft text');await panel.executeJavaScript('document.getElementById("discuss").click()');
await wait(()=>read('document.getElementById("composer").value.endsWith("draft text")'));
assert.equal(await read('window.fixture.state.values.notes'),'draft text');
assert.equal(await read('document.activeElement.id'),'composer');
assert.deepEqual(await read('window.fixture.drafts'),[{text:'My reading notes:\\n\\ndraft text',mode:'append'}]);
console.log('author: save and draft ready');const popup=await open();let popSidebar;await wait(async()=>{popSidebar=await child(popup,'#sidebar-input');return !!popSidebar;});
console.log('author: popup sidebar ready');await popSidebar.executeJavaScript('document.getElementById("sidebar-input").value="popout input"');
console.log('author: switching main chat');await read('window.fixture.set({chat:"b"})');await wait(()=>read('document.querySelector(".mod-sidebar-slot iframe")!==window.originalFrame'));
await wait(async()=>{sidebar=await child(win,'#sidebar-input');return sidebar&&await sidebar.executeJavaScript('document.getElementById("sidebar-input").value')==='';});
console.log('author: checking popup retained input');assert.equal(await popSidebar.executeJavaScript('document.getElementById("sidebar-input").value'),'popout input');
await read('window.fixture.set({chat:"a"})');
await wait(async()=>{panel=await child(win,'#notes');return panel&&await panel.executeJavaScript('!document.getElementById("discuss").disabled');});
console.log('author: independent windows ready');for(const selector of ['.mod-workspace-bar .mod-panel-menu > button','#sidebar-remove']){
 await read('document.querySelector('+JSON.stringify(selector)+').click()');
 if(selector!== '#sidebar-remove'){await wait(()=>read('!!document.querySelector(".mod-workspace-bar [role=menuitem]:last-child")'));await read('document.querySelector(".mod-workspace-bar [role=menuitem]:last-child").click()');}
 await wait(()=>read('document.querySelectorAll("iframe").length===0&&!!document.getElementById("undo")'));
 assert.equal(await read('window.fixture.state.values.notes'),'draft text');
 await read('document.getElementById("undo").click()');await wait(()=>read('document.querySelectorAll("iframe").length===2'));
}
assert.equal(await read('window.fixture.calls.filter(c=>c.body.restoreInstanceId==="i").length'),2);
assert.equal(await popup.webContents.executeJavaScript('document.querySelectorAll("iframe").length'),2);
await wait(()=>read('!!document.querySelector("#logo .mod-logo")'));
for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));assert.equal(await read('getComputedStyle(document.querySelector("#logo .mod-logo")).backgroundColor'),'rgb(10, 20, 30)');}
await read('window.fixture.set({logo:"data:image/png;base64,broken"})');await wait(()=>read('!!document.querySelector("#logo .lucide-book-open")'));
await read('window.fixture.set({logo:undefined,icon:undefined})');await wait(()=>read('!!document.querySelector("#logo .lucide-puzzle")'));
console.log('PASS author renderer: actual frames, reading-notes, sidebar, windows, Undo and logos');
}catch(error){console.error(error);process.exitCode=1;}finally{for(const w of windows)w.destroy();app.exit(process.exitCode||0);}});
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
        assert.match(output, /PASS author renderer:/);
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    } finally {
      assert.equal(dirname(resolve(dir)).toLowerCase(), resolve(tmpdir()).toLowerCase());
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  },
);
