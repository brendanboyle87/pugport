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
  'hidden Electron desktop tools use a real PTY and owned web view without app access, and explicit synthetic Chrome',
  { timeout: 75000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-tools-renderer-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-tools-renderer-'));
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
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {ProjectTools} from './src/ui/ProjectTools';
    import {uiUpdateBlocked} from './src/ui/ui-update-guard';
    const root=createRoot(document.getElementById('root'));
    const initialTab='terminal',conversationId='synthetic-chat';
    window.fixture={close:()=>root.render(<div>Closed</div>),visible:visible=>root.render(<ProjectTools conversationId={conversationId} visible={visible} onClose={()=>window.fixture.close()}/>),open:(initialTab,conversationId)=>root.render(<ProjectTools conversationId={conversationId} initialTab={initialTab} onClose={()=>window.fixture.close()}/>),blocked:uiUpdateBlocked};
    root.render(<ProjectTools conversationId={conversationId} initialTab={initialTab} onClose={()=>window.fixture.close()}/>);
  `,
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: join(directory, 'ui.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>:root{--border:#ddd;--surface:#fff;--text:#20242c;--muted:#626975;--accent:#3263df}body{margin:20px;font:14px Arial}button,input,textarea{font:inherit}button{cursor:pointer}.icon-button{border:0;background:none}.button{padding:6px}.field{display:flex;flex-direction:column;gap:5px}.project-tools{height:520px;max-height:none}.project-tools-content{min-height:0}</style><body><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    const artifacts = resolve('artifacts/desktop-tools');
    await mkdir(artifacts, { recursive: true });
    const script = `
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http');
const{app,BrowserWindow}=require('electron'); const {ProjectTools,loadNodePty}=require('./tools.cjs');
app.setPath('userData',path.join(__dirname,'profile')); app.disableHardwareAcceleration();
let owner,tools,uiServer,pageServer,chromeServer,pty,ptyExited=false,apiHits=0,activated=0,contextGate,contextCalls=0;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server?server.close(resolve):resolve());
const wait=async check=>{const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Synthetic condition timed out');};
app.whenReady().then(async()=>{try{
 uiServer=http.createServer(async(req,res)=>{if(req.url.startsWith('/api/')){apiHits++;res.end('DO_NOT_READ');return;} const name=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','ui.js','ui.css'].includes(name)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(path.join(__dirname,name)));});
 const uiPort=await listen(uiServer),origin='http://127.0.0.1:'+uiPort;
 pageServer=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Synthetic owned page</title><h1>Private browser fixture</h1><script>fetch('+JSON.stringify(origin+'/api/session')+').then(()=>document.title="BAD").catch(()=>document.title="Boundary verified");</script>');}); const pagePort=await listen(pageServer);
 chromeServer=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(req.url==='/json/version'?JSON.stringify({Browser:'Chrome/150.0.0.0'}):req.url==='/json/list'?JSON.stringify([{type:'page',id:'synthetic-page',title:'Synthetic Chrome page',url:'https://example.test/'}]):(activated++,JSON.stringify('activated')));});const chromePort=await listen(chromeServer);
 tools=new ProjectTools({origin,context:async id=>{if(id.startsWith('pending-')){contextCalls++;await new Promise(resolve=>contextGate=resolve);}return {conversationId:id,projectId:'p',directory:__dirname};},spawn:(shell,args,settings)=>{ptyExited=false;pty=loadNodePty(${JSON.stringify(resolve('.'))}).spawn(shell,args,settings);pty.onExit(()=>ptyExited=true);return pty;}});tools.install();
 owner=new BrowserWindow({show:false,width:1050,height:720,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,additionalArguments:['--combo-runner-origin='+origin]}});tools.register(owner);
 await owner.loadURL(origin); const js=code=>owner.webContents.executeJavaScript(code);
 await wait(()=>js('!!document.querySelector(".project-tool-path")')); assert.ok(pty.pid>0,'native PTY spawned inside the actual Electron ABI');
 assert.equal(await js('window.fixture.blocked()'),true);
 await js('window.termEvents=[];void window.comboRunnerDesktop.projectTools.onEvent(e=>{if(e.kind==="terminal-data")window.termEvents.push(e.data)});');
 await js('window.comboRunnerDesktop.projectTools.openTerminal("synthetic-chat",{cols:100,rows:24}).then(t=>{window.term=t;return window.comboRunnerDesktop.projectTools.writeTerminal(t.id,'+JSON.stringify(process.platform === 'win32' ? "Write-Output ('ABI_' + 'VERIFIED')\\r" : "printf 'ABI_%s\\n' VERIFIED\\r")+')})');
 await wait(()=>js('window.termEvents.join("").includes("ABI_VERIFIED")'));
 await js('document.querySelectorAll("[role=tab]")[1].click()');
 await wait(()=>owner.contentView.children.length>0); const view=owner.contentView.children[0];
 await wait(()=>view.getVisible()); await wait(()=>js('document.querySelectorAll("[role=tab]")[1].getAttribute("aria-selected")==="true"'));
 await js('window.comboRunnerDesktop.projectTools.openBrowser("synthetic-chat").then(b=>window.comboRunnerDesktop.projectTools.browserAction(b.id,"navigate",'+JSON.stringify('http://127.0.0.1:'+pagePort+'/')+'))');
 await wait(()=>view.webContents.getTitle()==='Boundary verified'); assert.equal(apiHits,0); assert.equal(await view.webContents.executeJavaScript('typeof window.comboRunnerDesktop'), 'undefined');
 await js('window.fixture.visible(false)');await wait(()=>!view.getVisible());assert.equal(tools.activeTerminals,1,'hidden tools keep the terminal process');assert.equal(view.webContents.isDestroyed(),false);
 await js('window.fixture.visible(true)');await wait(()=>view.getVisible());assert.equal(view.webContents.getTitle(),'Boundary verified','showing a retained panel preserves its page');
 assert.equal(await js('window.comboRunnerDesktop.projectTools.openTerminal("synthetic-chat",{cols:100,rows:24}).then(t=>t.id===window.term.id)'),true,'switching to browser keeps terminal alive');
 await new Promise(r=>setTimeout(r,150)); await fs.writeFile(${JSON.stringify(join(artifacts, 'browser.png'))},(await owner.webContents.capturePage()).toPNG());
 await js('document.querySelectorAll("[role=tab]")[2].click()'); await wait(()=>js('!!document.querySelector(".project-chrome-connect input")'));
 assert.equal(view.getVisible(),false,'native view is hidden under the Chrome controls');
 await js('(()=>{const input=document.querySelector(".project-chrome-connect input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify('http://127.0.0.1:'+chromePort) +');input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await js('document.querySelector(".project-chrome-connect").requestSubmit()');
 await wait(()=>js('document.body.textContent.includes("Synthetic Chrome page")'));
 await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("切换到此页")).click()');await wait(()=>activated===1);
 await fs.writeFile(${JSON.stringify(join(artifacts, 'chrome.png'))},(await owner.webContents.capturePage()).toPNG());
 await js('document.querySelectorAll("[role=tab]")[0].click()');await new Promise(r=>setTimeout(r,150));
 await fs.writeFile(${JSON.stringify(join(artifacts, 'terminal.png'))},(await owner.webContents.capturePage()).toPNG());
 await js('window.fixture.close()');await wait(()=>owner.contentView.children.length===0 && ptyExited);assert.equal(await js('window.fixture.blocked()'),false);
 const connectPendingChrome=async()=>{await wait(()=>js('!!document.querySelector(".project-chrome-connect input")'));await js('(()=>{const input=document.querySelector(".project-chrome-connect input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify('http://127.0.0.1:'+chromePort)+');input.dispatchEvent(new Event("input",{bubbles:true}));})()');await js('document.querySelector(".project-chrome-connect").requestSubmit()');};
 for(const kind of ['terminal','browser','chrome']){
  const previous=contextCalls;
  await js('window.fixture.open('+JSON.stringify(kind)+','+JSON.stringify('pending-'+kind)+')');if(kind==='chrome')await connectPendingChrome();await wait(()=>contextCalls===previous+1);
  await js('window.fixture.close()');await wait(()=>js('!document.querySelector(".project-tools")'));
  await js('window.fixture.open('+JSON.stringify(kind)+','+JSON.stringify('pending-'+kind)+')');await wait(()=>js('!!document.querySelector(".project-tools")'));if(kind==='chrome')await connectPendingChrome();await new Promise(r=>setTimeout(r,150));
  assert.equal(contextCalls,previous+1,'reopened panel shares the pending host open');contextGate();
  if(kind==='terminal'){await wait(()=>js('!!document.querySelector(".project-tool-path")'));await new Promise(r=>setTimeout(r,150));assert.equal(tools.activeTerminals,1,'stale mount must not close new terminal');}
  else if(kind==='browser'){await wait(()=>owner.contentView.children.length===1);await new Promise(r=>setTimeout(r,150));assert.equal(owner.contentView.children.length,1,'stale mount must not close new view');}
  else{await wait(()=>js('document.body.textContent.includes("Synthetic Chrome page")'));await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("切换到此页")).click()');await wait(()=>activated===2);}
  await js('window.fixture.close()');await wait(()=>kind==='terminal'?ptyExited:kind==='browser'?owner.contentView.children.length===0:tools.chrome.size===0);
 }
 console.log('PASS desktop tools: Electron '+process.versions.electron+' ABI '+process.versions.modules+' real PTY, view isolation, tab preservation, explicit synthetic CDP, cleanup');
 }catch(error){console.error(error);process.exitCode=1;}finally{tools?.dispose();owner?.destroy();await Promise.all([close(uiServer),close(pageServer),close(chromeServer)]);app.exit(process.exitCode||0);}});
setTimeout(()=>{console.error('Desktop tools fixture timeout');tools?.dispose();app.exit(1)},60000).unref();
`;
    await writeFile(join(directory, 'run.cjs'), script);
    const require = createRequire(import.meta.url),
      electron = require('electron') as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(electron, electronArgs(join(directory, 'run.cjs')), {
      env,
      windowsHide: true,
      timeout: 65000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /PASS desktop tools/);
  },
);
