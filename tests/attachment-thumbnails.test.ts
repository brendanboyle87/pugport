import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from '../src/server/platform/test-process.ts';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('message thumbnails and viewer interactions in an offscreen renderer', { timeout: 60000 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'attach-thumbs-'));
  const artifacts = resolve('.oil-ui/attach-thumbs');
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(fixture, 'index.html'),
    '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
  );
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationHistory} from './src/ui/Workspace';
import './src/ui/studio.css';
const canvas=document.createElement('canvas');canvas.width=720;canvas.height=480;
const ctx=canvas.getContext('2d');ctx.fillStyle='#38566a';ctx.fillRect(0,0,720,480);ctx.fillStyle='#b9cdd5';ctx.beginPath();ctx.arc(460,180,95,0,7);ctx.fill();ctx.fillStyle='#708f9d';ctx.fillRect(0,340,720,140);
const blob=await new Promise(r=>canvas.toBlob(r));const url=URL.createObjectURL(blob);
window.fetch=async path=> String(path).includes('broken')?new Response('',{status:404}):String(path).includes('loading')?new Promise(()=>{}):new Response(blob);
const root=createRoot(document.getElementById('root'));
window.renderCase=(kind)=>{
const image=(id)=>({id,name:id+'.png',size:285696,mimeType:'image/png',kind:'image'});
const attachments=kind==='single'?[image('one')]:kind==='mixed'?[image('one'),{id:'pdf',name:'project-specification-with-a-very-long-name.pdf',size:40960,mimeType:'application/pdf',kind:'file'}]:kind==='states'?[image('broken'),image('loading')]:[image('one'),image('two'),image('three')];
flushSync(()=>root.render(<main style={{padding:40,maxWidth:900,margin:'auto'}}><ConversationHistory messages={['user','assistant'].map((role,i)=>({id:role,conversationId:'fixture',role,content:'Find this content',createdAt:'2026-11-02T12:00:00Z',attachments}))} workflows={[]} state={{workflows:[],runs:[],targets:[],settings:{}}} api={async()=>({})} notify={()=>{}} onConversation={()=>{}} onInspect={()=>{}} /></main>));
};
window.renderCase('single');
const observer=new MutationObserver(()=>document.querySelectorAll('.image-viewer-stage > img').forEach(img=>{if(!img.src.startsWith('blob:'))img.src=url;}));observer.observe(document.body,{childList:true,subtree:true});
`,
    },
    bundle: true,
    format: 'esm',
    outfile: join(fixture, 'fixture.js'),
    platform: 'browser',
    loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
  });
  // The fixture bundle uses top-level await.
  await writeFile(
    join(fixture, 'index.html'),
    '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>',
  );
  const runner = join(fixture, 'runner.cjs');
  await writeFile(
    runner,
    `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
await win.loadFile(path.join(__dirname,'index.html'));
const ev=c=>win.webContents.executeJavaScript(c);
const frame=()=>ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const wait=async c=>{for(let i=0;i<200;i++){if(await ev(c))return;await new Promise(r=>setTimeout(r,20));}throw Error(c);};
const shot=async name=>{await ev('Promise.all(document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished))');await frame();const image=await new Promise(r=>{win.webContents.once('paint',(_e,_d,img)=>r(img));win.webContents.invalidate();});await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),image.toPNG());};
await wait('!!window.renderCase');
for(const theme of ['light','dark']){
await ev('document.documentElement.dataset.theme='+JSON.stringify(theme));
for(const kind of ['single','three','mixed']){
await ev('window.renderCase('+JSON.stringify(kind)+')');
await wait('[...document.querySelectorAll(".message-attachment-link img")].every(i=>i.naturalWidth>0)');await frame();
assert.equal(await ev('[...document.querySelectorAll(".message-attachment-link")].every(e=>e.offsetWidth===112&&e.offsetHeight===112&&getComputedStyle(e).borderRadius==="12px")'),true);
assert.equal(await ev('[...document.querySelectorAll(".conversation-message")].every(e=>e.querySelector(".message-attachments").getBoundingClientRect().bottom<=e.querySelector(".message-text").getBoundingClientRect().top)'),true);
assert.equal(await ev('[...document.querySelectorAll(".message-attachment-link")].every(e=>e.textContent.trim()===""&&e.getAttribute("aria-label"))'),true);
if(kind==='mixed')assert.equal(await ev('[...document.querySelectorAll("a.message-attachment")].every(e=>e.offsetWidth<=240&&e.offsetHeight<50&&e.download.endsWith(".pdf")&&e.textContent.includes("40 KB"))'),true);
await shot(theme+'-'+kind);
}
await ev('window.renderCase("three");document.querySelector(".message-attachment-link").click()');await wait('!!document.querySelector(".image-viewer")');await frame();
assert.equal(await ev('document.activeElement.className'), 'image-viewer-close');
await ev('window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');await frame();
assert.equal(await ev('document.querySelector(".image-viewer-name").textContent.includes("2 / 3")'),true);
assert.equal(await ev('document.querySelector(".image-viewer-actions a").download'), 'two.png');
await ev('document.querySelector(".image-viewer-step.next").focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
assert.equal(await ev('document.activeElement===document.querySelector(".image-viewer-actions button")'),true);
await shot(theme+'-lightbox');
await ev('window.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');await frame();
assert.equal(await ev('document.querySelector(".image-viewer-name").textContent.includes("1 / 3")'),true);
await ev('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await frame();
assert.equal(await ev('!document.querySelector(".image-viewer")&&document.activeElement===document.querySelector(".message-attachment-link")'),true);
for(const selector of ['.image-viewer-close','.image-viewer-stage']){
await ev('document.querySelector(".message-attachment-link").click()');await frame();await ev('document.querySelector('+JSON.stringify(selector)+').click()');await frame();assert.equal(await ev('!document.querySelector(".image-viewer")'),true);
}
}
win.setSize(380,800);await ev('window.renderCase("three")');await frame();
assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth&&document.querySelectorAll(".message-user .message-attachment-link")[2].getBoundingClientRect().top>document.querySelector(".message-user .message-attachment-link").getBoundingClientRect().top'),true);
await ev('window.renderCase("states")');await wait('!!document.querySelector(".attachment-thumbnail.failed")');
assert.equal(await ev('[...document.querySelectorAll(".message-attachment-link")].every(e=>e.offsetWidth===112&&e.offsetHeight===112)&&!!document.querySelector(".attachment-thumbnail.loading")&&!!document.querySelector(".attachment-thumbnail.failed svg")'),true);
console.log('PASS: size, ordering, documents, viewer, arrows, escape, focus, backdrop, loading/failure; 8 screenshots');
}catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});`,
  );
  const require = createRequire(import.meta.url),
    env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron') as string, electronArgs(runner), {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  const timer = setTimeout(() => child.kill(), 50000);
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, output);
    console.log(output);
  } finally {
    clearTimeout(timer);
  }
});
