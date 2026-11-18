import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('offline Electron exports both formats across layouts and preserves menu focus on refresh', async () => {
  const artifacts = resolve('reports/a4-export');
  const fixture = join(artifacts, 'fixture');
  await mkdir(fixture, { recursive: true });
  await build({ entryPoints: ['src/ui/studio.css'], bundle: true, outfile: join(fixture, 'style.css') });
  await writeFile(
    join(fixture, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="fixture.js"></script>',
  );
  await build({
    stdin: {
      contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import Studio from './src/ui/Studio';
import { ContextMenu } from './src/ui/DesktopFeatures';
const stamp='2026-10-14T12:00:00Z';
const project={id:'p',name:'示例项目',path:'C:/Synthetic',scope:'chat',createdAt:stamp,updatedAt:stamp};
const conversation={id:'c',projectId:'p',title:'示例对话',createdAt:stamp,updatedAt:stamp};
window.calls=[]; window.downloads=[];
HTMLAnchorElement.prototype.click=function(){window.downloads.push({href:this.href,fileName:this.download});};
window.__backend={connection:'connected',reload:async()=>{},
 state:{app:{version:'test'},projects:[project],conversations:[conversation],conversationMessages:[],workflows:[],runs:[],runtimes:[],targets:[],approvals:[],plugins:[],settings:{}},
 api:async(path,body,method='POST')=>{
  window.calls.push({path,method});
  if(path==='/api/modes') {
   if(method!=='GET') throw Error('Mode catalog must use GET');
   return {catalog:[],installed:[]};
  }
  if(path.includes('/export?')) {
   if(method!=='GET') throw Error('Export must use GET');
   const json=path.endsWith('json');
   return {fileName:json?'示例对话.json':'示例对话.md',mimeType:json?'application/json':'text/markdown',content:json?'{}':'# 示例对话'};
  }
  return {conversation,messages:[],workflows:[],runs:[]};
 }};
localStorage.setItem('agent-studio-conversation','c');
localStorage.setItem('agent-studio-theme','light');
localStorage.setItem('comborunner.locale','zh-CN');
const root=createRoot(document.getElementById('root'));
window.refreshStudio=()=>root.render(<Studio/>);
window.refreshMenu=()=>root.render(<ContextMenu x={20} y={20} onClose={()=>{}} items={[
 {label:'First',onSelect:()=>{}},{label:'Second',onSelect:()=>{}}
]}/>);
root.render(<Studio/>);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    outfile: join(fixture, 'fixture.js'),
    platform: 'browser',
    format: 'iife',
    loader: { '.png': 'dataurl', '.webp': 'dataurl' },
    plugins: [
      {
        name: 'synthetic-backend',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/App$/ }, (args) =>
            args.importer.endsWith('Studio.tsx') ? { path: 'backend', namespace: 'mock' } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents: `export const useBackend=()=>window.__backend;
export const ApprovalCard=()=>null, EmptyState=()=>null, HandoffModal=()=>null, QuotaCard=()=>null,
RunOutput=()=>null, SettingsPage=()=>null, StatusPill=()=>null, TargetEditor=()=>null;
export const dateLabel=x=>x, readableError=x=>String(x);`,
          }));
        },
      },
    ],
  });
  const runner = join(fixture, 'runner.cjs');
  await writeFile(
    runner,
    `const assert=require('node:assert/strict');
const fs=require('node:fs/promises'); const path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile')); app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1060,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
  await win.loadFile(path.join(__dirname,'index.html'));
  const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error('Synthetic renderer step: '+code,{cause:error});}};
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const click=label=>evaluate('[...document.querySelectorAll(".context-menu button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
  for(let i=0;i<30;i++){await frame();if(await evaluate('!!document.querySelector(".conversation-toolbar")'))break;}
  for(const theme of ['light','dark']) {
   for(const width of [1060,390]) {
    win.setSize(width,820); await frame();
    await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
    await evaluate('document.querySelector(".conversation-toolbar").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:innerWidth-5,clientY:innerHeight-5}))');
    await frame();
    const labels=await evaluate('[...document.querySelectorAll(".context-menu button")].map(b=>b.textContent.trim())');
    assert.equal(labels.includes('复制标题'),false);
    assert.ok(labels.includes('导出→'));
    await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'-menu.png'),(await win.webContents.capturePage()).toPNG());
    await click('导出→'); await frame();
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".context-menu button")].map(b=>b.textContent.trim())'),['Markdown','JSON']);
    assert.equal(await evaluate('document.activeElement.textContent.trim()'),'Markdown');
    await evaluate('window.refreshStudio()'); await frame();
    assert.equal(await evaluate('document.activeElement.textContent.trim()'),'Markdown');
    assert.equal(await evaluate('(()=>{const b=document.querySelector(".context-menu").getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight})()'),true);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'-formats.png'),(await win.webContents.capturePage()).toPNG());
    await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    assert.equal(await evaluate('document.activeElement.textContent.trim()'),'JSON');
    const format=theme==='light'?'Markdown':'JSON';
    await click(format); await frame();
    assert.equal(await evaluate('document.querySelector(".context-menu")===null'),true);
    assert.equal(await evaluate('window.downloads.at(-1).fileName'),format==='JSON'?'示例对话.json':'示例对话.md');
    assert.equal(await evaluate('document.querySelector(".notice[role=status]").textContent.includes(window.downloads.at(-1).fileName)'),true);
   }
  }
  assert.deepEqual(await evaluate('window.calls.filter(c=>c.path.includes("/export?")).map(c=>c.method)'),['GET','GET','GET','GET']);
  // Ordinary chats now load the Mods catalog once; exports and refreshes must not reload it.
  assert.deepEqual(await evaluate('window.calls.filter(c=>c.path==="/api/modes").map(c=>c.method)'),['GET']);
  await evaluate('window.refreshMenu()'); await frame();
  assert.equal(await evaluate('document.activeElement.textContent.trim()'),'First');
  await evaluate('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
  assert.equal(await evaluate('document.activeElement.textContent.trim()'),'Second');
  await evaluate('window.refreshMenu()'); await frame();
  assert.equal(await evaluate('document.activeElement.textContent.trim()'),'Second');
  console.log('4 layouts passed; 4 downloads intercepted; 8 screenshots saved; refreshed menu kept keyboard focus.');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{win?.destroy();app.exit(process.exitCode||0);}
});`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
    cwd: process.cwd(),
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const timeout = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, output);
    console.log(output.trim());
  } finally {
    clearTimeout(timeout);
  }
});
