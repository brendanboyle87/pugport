import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'hidden Electron page annotation preserves the guest and delivers sanitized marks with a composed PNG',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-page-markup-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-page-markup-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      entryPoints: ['src/electron/project-tools.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      outfile: join(directory, 'tools.cjs'),
    });
    await build({
      entryPoints: ['src/electron/preload.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: join(directory, 'preload.cjs'),
    });
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ProjectTools} from './src/ui/ProjectTools';import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';import './src/ui/composer.css';
localStorage.setItem('comborunner.locale','zh-CN');
window.received=[];window.accept=true;window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
window.language=async locale=>{localStorage.setItem('comborunner.locale',locale);await startInterfaceLanguage();};
window.pointer=(x,y,type)=>{const mark=document.querySelector('.image-markup'),rect=mark.getBoundingClientRect(),scale=Number(mark.dataset.k)*Number(mark.dataset.scale);mark.querySelector('svg').dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:rect.left+x*scale,clientY:rect.top+y*scale}));};
window.note=text=>{const el=document.querySelector('.quote-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));};
window.key=key=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
const onMarkup=async r=>{const bitmap=await createImageBitmap(r.file);const original=await createImageBitmap(await(await fetch(r.src)).blob());const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(original,0,0);const before=ctx.getImageData(0,0,canvas.width,canvas.height).data;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0);const after=ctx.getImageData(0,0,canvas.width,canvas.height).data;let changed=0;for(let i=0;i<before.length;i+=4)if(before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2])changed++;window.received.push({markup:r.markup,type:r.file.type,size:r.file.size,name:r.file.name,width:bitmap.width,height:bitmap.height,changed});bitmap.close();original.close();return window.accept;};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<><ProjectTools conversationId="page-fixture" initialTab="browser" onClose={()=>{}} onMarkup={onMarkup}/><ConfirmDialogHost/></>));
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(directory, 'ui.js'),
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:24px}.project-tools{height:610px;max-height:none}</style><div id="root"></div><script src="ui.js"></script></html>',
    );
    const artifacts = resolve('artifacts/annotations-screenshots');
    await mkdir(artifacts, { recursive: true });
    const script = String.raw`
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http');
const {app,BrowserWindow}=require('electron');const {ProjectTools}=require('./tools.cjs');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let owner,other,tools,uiServer,pageServer;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server?server.close(resolve):resolve());
const wait=async check=>{const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw Error('Page annotation condition timed out');};
app.whenReady().then(async()=>{try{
 uiServer=http.createServer(async(req,res)=>{const name=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','ui.js','ui.css'].includes(name)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(path.join(__dirname,name)));});
 const origin='http://127.0.0.1:'+await listen(uiServer);
 const fixture='<!doctype html><meta charset="utf-8"><title>Pricing</title><style>body{margin:0;background:#edf2f7;color:#142c44;font:18px Arial}main{margin:32px;padding:28px;background:white;border-radius:14px}h1{margin:0 0 20px}button{padding:16px 24px;border:0;border-radius:8px;background:#225dcc;color:white;font:600 18px Arial}input{display:block;margin-top:24px;padding:12px;border:1px solid #94a3b8;border-radius:6px}p{margin:20px 0}iframe{width:200px;height:80px;border:1px solid #94a3b8}</style><main><h1>Pricing</h1><button data-testid="cta" class="primary">Start free trial</button><input id="email" value="SECRET-VALUE" placeholder="Email"><p class="plan">Pro $29/month</p><iframe srcdoc="<b>inside</b>"></iframe><textarea style="display:none">SECRET-TEXTAREA</textarea><div aria-hidden="true">HIDDEN-SECRET</div></main><script>document.elementFromPoint=()=>{throw Error("Main world patched")};Element.prototype.getBoundingClientRect=()=>{throw Error("Main world patched")};document.querySelectorAll=()=>{throw Error("Main world patched")};</script>';
 pageServer=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture);});
 const pageUrl='http://127.0.0.1:'+await listen(pageServer)+'/pricing';
 // A hidden window has no display surface: render the same page in an offscreen window instead.
 const capture=async contents=>{const [width,height]=await contents.executeJavaScript('[innerWidth,innerHeight]');const shot=new BrowserWindow({show:false,useContentSize:true,width,height,webPreferences:{offscreen:true,sandbox:true}});try{await shot.loadURL(contents.getURL());return await new Promise(resolve=>{shot.webContents.once('paint',(_e,_r,image)=>resolve(image));shot.webContents.invalidate();});}finally{shot.destroy();}};
 tools=new ProjectTools({origin,capture,context:async id=>({conversationId:id,projectId:'synthetic',directory:__dirname,incognito:true})});tools.install();
 const settings={show:false,width:1100,height:800,webPreferences:{offscreen:true,preload:path.join(__dirname,'preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,additionalArguments:['--combo-runner-origin='+origin]}};
 owner=new BrowserWindow(settings);tools.register(owner);await owner.loadURL(origin);
 const js=code=>owner.webContents.executeJavaScript(code);
 const query=code=>view.webContents.executeJavaScriptInIsolatedWorld(7312,[{code}]);
 const click=selector=>js('document.querySelector('+JSON.stringify(selector)+').dispatchEvent(new MouseEvent("click",{bubbles:true}))');
 const note=async text=>{await wait(()=>js('!!document.querySelector(".quote-editor textarea")'));await js('window.note('+JSON.stringify(text)+')');await js('window.key("Enter")');await wait(()=>js('!document.querySelector(".quote-editor")'));};
 await wait(()=>owner.contentView.children.length===1);const view=owner.contentView.children[0];
 await wait(()=>js('!!document.querySelector(".project-browser-navigation button[type=button]:last-child")'));
 assert.equal(await js('document.querySelector(".project-browser-navigation button:last-child").disabled'),true);
 const id=await js('window.comboRunnerDesktop.projectTools.openBrowser("page-fixture").then(b=>b.id)');
 await js('window.comboRunnerDesktop.projectTools.browserAction('+JSON.stringify(id)+',"navigate",'+JSON.stringify(pageUrl+'?secret=1#frag')+')');
 await wait(()=>view.webContents.getTitle()==='Pricing'&&!view.webContents.isLoading());await wait(()=>view.getVisible());
 const rects=await query('(()=>{const result={};for(const name of ["button","input","p","iframe"]){const r=document.querySelector(name).getBoundingClientRect();result[name]={x:r.x,y:r.y,width:r.width,height:r.height};}return result;})()');
 const snapshot='JSON.stringify([document.getElementsByTagName("*").length,document.body.innerHTML])';
 const before=await query(snapshot);
 for(const locale of ['zh-CN','en']){
  if(locale==='en')await js('window.language("en")');
  await wait(()=>js('!document.querySelector(".project-browser-navigation button:last-child").disabled'));
  await click('.project-browser-navigation button:last-child');
  await wait(()=>js('document.querySelector(".image-markup img")?.naturalWidth>0'));
  await wait(()=>!view.getVisible());assert.equal(await js('document.querySelector(".image-viewer").getAttribute("aria-modal")'),'true');
  const point=async(name,type)=>{const r=rects[name];await js('window.pointer('+(r.x+r.width/2)+','+(r.y+r.height/2)+','+JSON.stringify(type)+')');};
  await point('button','pointermove');await wait(()=>js('document.querySelector(".image-markup-hover-label")?.textContent.includes("button")'));
  await point('button','pointerdown');await point('button','pointerup');
  await wait(()=>js('document.querySelector(".quote-editor")?.textContent.includes("Start free trial")'));await note('改成蓝色');
  const x=rects.input.x-5,y=rects.input.y-5,right=rects.input.x+rects.input.width+5,bottom=rects.p.y+rects.p.height+5;
  const execute=view.webContents.executeJavaScriptInIsolatedWorld.bind(view.webContents);let releaseText;view.webContents.executeJavaScriptInIsolatedWorld=(...args)=>new Promise(resolve=>{releaseText=()=>resolve(execute(...args));});
  await js('window.pointer('+x+','+y+',"pointerdown")');await js('window.pointer('+right+','+bottom+',"pointermove")');await js('window.pointer('+right+','+bottom+',"pointerup")');
  await wait(()=>!!releaseText);assert.equal(await js('document.querySelector(".image-markup-toolbar .primary").disabled'),true);view.webContents.executeJavaScriptInIsolatedWorld=execute;releaseText();
  await wait(()=>js('document.querySelector(".quote-editor")?.textContent.includes("Pro $29/month")'));
  assert.equal(await js('document.querySelector(".quote-editor").textContent.includes('+JSON.stringify(locale==='en'?'Text in this region':'区域内文字')+')'),true);
  assert.equal(await js('document.querySelector(".quote-editor").textContent.includes("SECRET-VALUE")'),false);await note('保留价格');
  await point('iframe','pointerdown');await point('iframe','pointerup');await wait(()=>js('document.querySelector(".quote-editor")?.textContent.includes("iframe")'));await js('window.key("Escape")');
  await click('.image-mark-badge[data-names]');await wait(()=>js('!!document.querySelector(".quote-editor textarea")'));
  await point('button','pointermove');await wait(()=>js('!!document.querySelector(".image-markup-hover-label")'));
  for(const theme of ['light','dark']){
   await js('document.documentElement.dataset.theme='+JSON.stringify(theme));await new Promise(r=>setTimeout(r,300));
   assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
   const boxes=await js('Array.from(document.querySelectorAll(".image-markup-hover-label,.quote-editor")).map(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})');assert.ok(boxes.every(Boolean));
   await fs.writeFile(path.join(ARTIFACTS,'page-'+locale+'-'+theme+'.png'),(await new Promise(resolve=>{owner.webContents.once('paint',(_e,_r,image)=>resolve(image));owner.webContents.invalidate();})).toPNG());
  }
  await js('window.key("Escape")');
  if(locale==='zh-CN'){
   await js('window.accept=false');await click('.image-markup-toolbar .primary');await wait(()=>js('window.received.length===1'));
   assert.equal(await js('!!document.querySelector(".image-viewer")'),true);assert.equal(view.getVisible(),false);await js('window.accept=true');
  }
  await wait(()=>js('!document.querySelector(".image-markup-toolbar .primary").disabled'));const previous=await js('window.received.length');await click('.image-markup-toolbar .primary');await wait(()=>js('window.received.length==='+ (previous+1)));await wait(()=>js('!document.querySelector(".image-viewer")'));await wait(()=>view.getVisible());
  const result=await js('window.received.at(-1)'),source=result.markup.source,marks=result.markup.marks;
  assert.equal(source.kind,'page');assert.equal(source.url,pageUrl);assert.equal(source.title,'Pricing');assert.equal(marks.length,3);
  assert.equal(marks[0].kind,'element');assert.equal(marks[0].element.selector,'button[data-testid="cta"]');assert.equal(marks[0].element.text,'Start free trial');assert.equal(marks[0].note,'改成蓝色');
  assert.ok(Math.abs(marks[0].box.x0*source.viewport.width-rects.button.x)<=2);assert.ok(Math.abs(marks[0].box.y0*source.viewport.height-rects.button.y)<=2);
  assert.ok(Math.abs((marks[0].box.x1-marks[0].box.x0)*source.viewport.width-rects.button.width)<=2);
  assert.equal(marks[1].kind,'rect');assert.match(marks[1].text,/Pro \$29\/month/);assert.equal(marks[2].element.frame,true);
  assert.doesNotMatch(JSON.stringify(result),/SECRET-VALUE|SECRET-TEXTAREA|HIDDEN-SECRET|inside|secret=1|#frag/);
  assert.equal(result.type,'image/png');assert.equal(result.name,locale==='en'?'Pricing-annotated.png':'Pricing-标注.png');assert.ok(result.size>0);assert.ok(result.changed>100);
  assert.equal(result.width,source.width);assert.equal(result.height,source.height);
 }
 assert.equal(await query(snapshot),before);
 assert.equal(await view.webContents.executeJavaScript('Object.keys(window).some(k=>/pugport|markup/i.test(k))'),false);
 assert.equal(await view.webContents.executeJavaScript('typeof buildSelector'), 'undefined');
 const api='window.comboRunnerDesktop.projectTools';
 const input=await js(api+'.browserElement('+JSON.stringify(id)+','+JSON.stringify({x:rects.input.x+10,y:rects.input.y+10})+')');assert.equal(input.text,'');assert.equal(input.name,'Email');
 await assert.rejects(js(api+'.browserElement('+JSON.stringify(id)+',{x:NaN,y:1})'),/标注位置无效/);
 other=new BrowserWindow(settings);tools.register(other);await other.loadURL(origin);
 for(const method of ['browserCapture','browserElement','browserText'])await assert.rejects(other.webContents.executeJavaScript('window.comboRunnerDesktop.projectTools.'+method+'('+JSON.stringify(id)+')'),/不属于/);
 other.destroy();other=undefined;
 await view.webContents.loadURL(pageUrl+'/next');
 assert.equal(await js(api+'.browserElement('+JSON.stringify(id)+',{x:1,y:1})'),null);
 assert.equal(await js(api+'.browserText('+JSON.stringify(id)+',{x:0,y:0,width:100,height:100})'),'');
 assert.deepEqual(await js('window.errors'),[]);
 console.log('PASS page annotation: isolated queries, unchanged DOM, private fields, modal visibility, composed PNG, 4 screenshots');
 }catch(error){console.error(error);process.exitCode=1;}finally{tools?.dispose();other?.destroy();owner?.destroy();await Promise.all([close(uiServer),close(pageServer)]);app.exit(process.exitCode||0);}});
setTimeout(()=>{console.error('Page annotation fixture timeout');tools?.dispose();app.exit(1)},75000).unref();
`.replace('ARTIFACTS', JSON.stringify(artifacts));
    await writeFile(join(directory, 'run.cjs'), script);
    const require = createRequire(import.meta.url),
      electron = require('electron') as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, electronArgs(join(directory, 'run.cjs')), {
      env,
      windowsHide: true,
      timeout: 80000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /PASS page annotation/);
  },
);
