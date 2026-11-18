import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from '../src/server/platform/test-process.ts';
import { build } from 'esbuild';
import express from 'express';
import sharp from 'sharp';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Attachments } from '../src/server/attachments.ts';
import { attachmentUploadRoute } from '../src/server/attachment-routes.ts';
import { listenForFetch } from './helpers/fetch-port.ts';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'offscreen composer: thumbnails, paste recovery, original and fitted upload, next draft and routing options',
  { timeout: 60000 },
  async (t) => {
    const root = process.cwd(),
      fixture = await mkdtemp(join(tmpdir(), 'pugport-attachments-renderer-'));
    const artifacts = resolve('artifacts/composer-attachments');
    await mkdir(artifacts, { recursive: true });
    const db = new Store(join(fixture, 'data')),
      store = new WorkspaceStore(db.db),
      files = new Attachments(join(fixture, 'data'), store),
      id = randomUUID();
    t.after(() => db.close());
    store.save('conversation', id, 'project', { id });
    const original = await sharp({ create: { width: 6000, height: 700, channels: 3, background: '#3686bb' } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    assert.ok(original.length >= 12 * 1024 * 1024);
    await writeFile(join(fixture, 'large.png'), original);
    await writeFile(
      join(fixture, 'small.png'),
      await sharp({ create: { width: 80, height: 60, channels: 3, background: '#b27c42' } })
        .png()
        .toBuffer(),
    );
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
    );
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationWorkspace} from './src/ui/Workspace';
import {fittedAttachment,attachmentThumbnail} from './src/ui/attachments';
import './src/ui/studio.css';
import './src/ui/composer.css';
import './src/ui/mods/mods.css';
import './src/ui/ConversationModeView.css';
const stamp='2026-10-14T12:00:00Z';
const project={id:'project',name:'Synthetic project',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const conversation={id:${JSON.stringify(id)},projectId:'project',title:'附件预览',routingProfileId:null,createdAt:stamp,updatedAt:stamp};
const state={app:{name:'Fixture',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},projects:[project],conversations:[conversation],targets:[],runtimes:[],runs:[],workflows:[],approvals:[],plugins:[],conversationMessages:[]};
window.notices=[];window.requests=[];window.finished=false;
const api=async(path,body,method='POST')=>{
 if(body instanceof File){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':body.type,'x-attachment-name':encodeURIComponent(body.name)},body});
  const result=await response.json();if(!response.ok)throw Error(result.error);return result;
 }
 if(path.endsWith('/messages')&&body){window.requests.push(body);window.messagePending=true;await new Promise(resolve=>window.releaseSend=resolve);window.finished=true;return {message:{id:'sent',conversationId:conversation.id,role:'user',content:body.content,createdAt:stamp}};}
 return {messages:[],workflows:[]};
};
createRoot(document.getElementById('root')).render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={state} api={api} project={project} conversation={conversation} notify={notice=>window.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>);
window.checkFits=async()=>{
 const strip=new OffscreenCanvas(6000,700);strip.getContext('2d').fillRect(0,0,6000,700);
 const source=await strip.convertToBlob({type:'image/png'});
 const originalBitmap=window.createImageBitmap;
 let active=0,peak=0;
 window.createImageBitmap=async(...args)=>{
  active++;peak=Math.max(peak,active);
  const bitmap=await originalBitmap.call(window,...args);
  return {width:bitmap.width,height:bitmap.height,close(){bitmap.close();active--;}};
 };
 // Mock drawImage only while tracking concurrent decoded bitmaps.
 const draw=OffscreenCanvasRenderingContext2D.prototype.drawImage;
 OffscreenCanvasRenderingContext2D.prototype.drawImage=()=>{};
 try {await Promise.all([1,2,3].map(()=>attachmentThumbnail(source)));if(peak!==1||active!==0)throw Error('parallel thumbnail decoding');}
 finally {window.createImageBitmap=originalBitmap;OffscreenCanvasRenderingContext2D.prototype.drawImage=draw;}
 for(const size of ['draft','message']){
  const bitmap=await createImageBitmap(await attachmentThumbnail(source,size));
  if(size==='draft' ? Math.min(bitmap.width,bitmap.height)!==112 : Math.max(bitmap.width,bitmap.height)!==600)throw Error('thumbnail dimensions');
  bitmap.close();
 }

 const canvas=new OffscreenCanvas(8201,32), context=canvas.getContext('2d');
 context.fillStyle='#4395bd';context.fillRect(10,8,40,16);
 for(const type of ['image/png','image/jpeg','image/webp']){
  const input=new File([await canvas.convertToBlob({type})],'tall.'+type.slice(6),{type});
  const fitted=await fittedAttachment(input);
  if(!fitted || fitted.size>3.5*1024*1024 || fitted.type!==(type==='image/png'?'image/png':'image/jpeg'))throw Error('wrong fitted format');
  const bitmap=await createImageBitmap(fitted);
  if(Math.max(bitmap.width,bitmap.height)>2048)throw Error('fitted edge');
  if(type==='image/png') {const preview=new OffscreenCanvas(bitmap.width,bitmap.height);const ctx=preview.getContext('2d');ctx.drawImage(bitmap,0,0);if(ctx.getImageData(0,0,1,1).data[3]!==0)throw Error('PNG alpha was lost');}
  bitmap.close();
 }
 if(await fittedAttachment(new File(['GIF89a'],'anim.gif',{type:'image/gif'})))throw Error('GIF was re-encoded');
};
window.loadFiles=async()=>{const small=await(await fetch('/small.png')).blob();window.small=small;window.draftFiles=[...['one.png','two.png','three.png'].map(name=>new File([small],name,{type:'image/png'})),new File(['Synthetic document'],'notes.txt',{type:'text/plain'})];window.large=new File([await(await fetch('/large.png')).blob()],'large.png',{type:'image/png'});};
window.add=files=>{const input=document.querySelector('input[type=file]');const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
window.pasteEmpty=usable=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>usable?[{types:['image/png'],getType:async()=>window.small}]:[]}});const data=new DataTransfer();data.items.add(new File([],'empty.png',{type:'image/png'}));document.querySelector('#conversation-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));};
`,
      },
      bundle: true,
      outfile: join(fixture, 'fixture.js'),
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    });
    const app = express();
    attachmentUploadRoute(app, files);
    app.use(express.static(fixture));
    const server = await listenForFetch(app);
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1040,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith(${JSON.stringify(base)})&&!details.url.startsWith('blob:')&&!details.url.startsWith('data:')}));
  await win.loadURL(${JSON.stringify(base)});
  const evaluate=code=>win.webContents.executeJavaScript(code);
  // Offscreen paint already supplies the frame; capturePage races Chromium's copy-output surface after resize.
  const paint=()=>new Promise(resolve=>{win.webContents.once('paint',(_event,_dirty,image)=>resolve(image));win.webContents.invalidate();});
  const screenshot=async()=>{
   const expected=await evaluate('({width:Math.round(innerWidth*devicePixelRatio),height:Math.round(innerHeight*devicePixelRatio),rgb:getComputedStyle(document.documentElement).backgroundColor.match(/[0-9]+/g).slice(0,3).map(Number)})');
   for(let attempt=0;attempt<20;attempt++){
    await frame();const image=await paint(),size=image.getSize();
    if(size.width===expected.width&&size.height===expected.height&&image.toBitmap().subarray(0,3).equals(Buffer.from(expected.rgb).reverse()))return image;
   }
   throw Error('Offscreen frame did not reach the requested size and theme');
  };
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+expression);};
  await wait('!!document.querySelector("#conversation-input")');
  await evaluate('window.checkFits().catch(e=>{throw new Error(e.name+": "+e.message+" STACK "+e.stack)})');await evaluate('window.loadFiles()');await evaluate('window.add(window.draftFiles)');
  await wait('document.querySelectorAll(".attachment-chip-preview img").length===3 && [...document.querySelectorAll(".attachment-chip-preview img")].every(i=>i.naturalWidth>0)');
  assert.equal(await evaluate('document.querySelectorAll(".attachment-chip:not(.attachment-chip-image)").length'),1);
  assert.equal(await evaluate('[...document.querySelectorAll(".attachment-chip-preview img")].every(i=>i.getBoundingClientRect().width===56 && i.getBoundingClientRect().height===56 && Math.max(i.naturalWidth,i.naturalHeight)<=160)'),true);
  for(const theme of ['light','dark'])for(const width of [1040,380]){
   win.setSize(width,760);await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth && document.querySelector(".attachment-drafts").scrollWidth<=document.querySelector(".attachment-drafts").clientWidth'),true);
   assert.equal(await evaluate('document.querySelector("#conversation-input").getBoundingClientRect().height>40'),true);
   await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'.png'),(await screenshot()).toPNG());
  }
  await evaluate('document.querySelector(".attachment-chip-preview").click()');await frame();
  assert.equal(await evaluate('!!document.querySelector(".image-viewer")'),true);
  await evaluate('document.querySelector(".image-viewer-close").click();document.querySelector(".attachment-remove").click()');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".attachment-chip-preview").length'),2);
  await evaluate('[...document.querySelectorAll(".attachment-remove")].forEach(b=>b.click())');await frame();
  await evaluate('window.pasteEmpty(true)');await wait('document.querySelectorAll(".attachment-chip-preview").length===1');
  assert.equal(await evaluate('document.querySelector(".attachment-chip-preview").title.startsWith("empty.png")'),true);
  await evaluate('document.querySelector(".attachment-remove").click()');await frame();
  await evaluate('window.pasteEmpty(false)');await wait('window.notices.length>0');
  assert.match(await evaluate('window.notices.at(-1).message'),/这个文件是空的，请重新复制或改用拖入/);
  assert.equal(await evaluate('document.querySelectorAll(".attachment-chip").length'),0);
  await evaluate('document.querySelector(".composer-route").click()');await frame();
  assert.equal(await evaluate('[...document.querySelectorAll(".route-popover .chip-check")].some(e=>e.textContent.includes("省钱"))'),false);
  assert.equal(await evaluate('[...document.querySelectorAll(".composer-bottom button")].some(e=>e.textContent.trim()==="省钱")'),false);
  assert.equal(await evaluate('document.querySelector(".composer-route").textContent.includes("省钱")'),false);
  await evaluate('Promise.all(document.querySelector(".route-popover").getAnimations().map(animation=>animation.finished))');
  for(const theme of ['light','dark'])for(const width of [1040,380]){
   win.setSize(width,760);await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth && document.querySelector(".route-popover").scrollWidth<=document.querySelector(".route-popover").clientWidth'),true);
   await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-options-'+width+'.png'),(await screenshot()).toPNG());
  }

  await evaluate('document.querySelector(".composer-route").click();window.add([window.large])');await frame();
  await wait('document.querySelector(".attachment-chip-preview img")?.naturalWidth>0');
  assert.equal(await evaluate('Math.min(document.querySelector(".attachment-chip-preview img").naturalWidth,document.querySelector(".attachment-chip-preview img").naturalHeight)'),112);
  assert.equal(await evaluate('document.querySelector(".attachment-drafts").scrollHeight<=document.querySelector(".attachment-drafts").clientHeight'),true);
  await evaluate('document.querySelector("#conversation-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
  await wait('window.messagePending===true');
  assert.equal(await evaluate('window.requests[0].attachmentIds.length'),1);
  assert.equal(await evaluate('"saveMoney" in window.requests[0]'),false);
  await evaluate('window.add([new File(["next draft"],"next.txt",{type:"text/plain"})])');await frame();
  assert.equal(await evaluate('document.querySelector(".attachment-chip strong")?.textContent'), 'next.txt');
  await evaluate('window.releaseSend()');await wait('window.finished');await frame();
  assert.equal(await evaluate('document.querySelector(".attachment-chip strong")?.textContent'), 'next.txt');
  console.log('PASS: 3 thumbnails + 1 chip; viewer; removal; clipboard fallback/error; 12 MB send; next draft; route popover; 6 screenshots');
 }catch(error){console.error(error.stack||String(error));process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});`,
    );
    const require = createRequire(import.meta.url),
      environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron') as string, electronArgs(runner), {
      cwd: root,
      env: environment,
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
    const timer = setTimeout(() => child.kill(), 50000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      const records = store.list<{ id: string }>('attachment', id);
      assert.equal(records.length, 1, 'companion is not listed separately');
      const stored = files.get(id, records[0]!.id);
      assert.equal(stored.size, original.length);
      assert.equal(
        createHash('sha256')
          .update(await readFile(stored.path))
          .digest('hex'),
        createHash('sha256').update(original).digest('hex'),
      );
      assert.ok(stored.fitted && stored.fitted.size < 3.5 * 1024 * 1024);
      assert.ok(['image/png', 'image/jpeg'].includes(stored.fitted.mimeType));
      const dimensions = await sharp(stored.fitted.path).metadata();
      assert.ok(Math.max(dimensions.width!, dimensions.height!) <= 2048);
    } finally {
      clearTimeout(timer);
    }
  },
);
