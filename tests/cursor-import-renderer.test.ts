import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { cursorFixture, cursorWorkspace } from './helpers/cursor-fixture.ts';
import { pathToFileURL } from 'node:url';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'offscreen Electron: Cursor dialog and imported conversation in light/dark, wide/narrow',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-cursor-renderer-')));
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-cursor-renderer-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const artifacts = resolve('reports/cursor-import');
    await mkdir(artifacts, { recursive: true });
    const controller = new Controller(fixture, join(fixture, 'data'));
    clearInterval(controller.timer);
    const workspace = new Workspace(controller, { autoTick: false });
    let project, conversation, messages, list;
    try {
      project = await workspace.createProject(fixture, '示例项目');
      const cursor = join(fixture, 'cursor');
      cursorFixture(cursor, fixture, '项目设计与实现记录');
      conversation = await workspace.importCursorChat(project.id, 'chat', cursor);
      messages = workspace.store.allMessages(conversation.id);
      cursorWorkspace(cursor, 'second', { folder: pathToFileURL(fixture).href }, [
        { composerId: 'new', name: '接口调试与下一步计划', lastUpdatedAt: 1791979200000 },
      ]);
      list = workspace.cursorChats(project.id, cursor);
    } finally {
      await workspace.close();
      await controller.close();
    }
    await build({
      stdin: {
        contents: `@import './src/ui/studio.css'; @import './src/ui/composer.css';`,
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      outfile: join(fixture, 'style.css'),
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="fixture.js"></script>',
    );
    await build({
      stdin: {
        contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import Studio from './src/ui/Studio';
const project=${JSON.stringify(project)}, conversation=${JSON.stringify(conversation)}, messages=${JSON.stringify(messages)}, list=${JSON.stringify(list)};
window.modeCatalogMethods=[];
window.__backend={connection:'connected',reload:async()=>{},
 state:{app:{version:'test'},projects:[project],conversations:[conversation],conversationMessages:messages,workflows:[],runs:[],runtimes:[],targets:[],approvals:[],plugins:[],settings:{}},
 api:async(path,_body,method='POST')=>{
  if(path==='/api/modes'){
   if(method!=='GET')throw Error('Mode catalog must use GET');
   window.modeCatalogMethods.push(method);return {catalog:[],installed:[]};
  }
  return path.endsWith('/cursor-chats')?list:{conversation,messages,workflows:[],runs:[]};
 }};
localStorage.setItem('agent-studio-conversation',conversation.id);
localStorage.setItem('agent-studio-theme','light');
localStorage.setItem('comborunner.locale','zh-CN');
createRoot(document.getElementById('root')).render(<Studio/>);`,
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
export const ApprovalCard=()=>null, EmptyState=()=>null, HandoffModal=()=>null, QuotaCard=()=>null, RunOutput=()=>null, SettingsPage=()=>null, StatusPill=()=>null, TargetEditor=()=>null;
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
const fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1060,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
  await win.loadFile(path.join(__dirname,'index.html'));
  const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error('Synthetic renderer step: '+code,{cause:error});}};
  const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot=async()=>{
   await frame();
   return await new Promise(resolve=>{win.webContents.once('paint',(_event,_dirty,image)=>resolve(image));win.webContents.invalidate();});
  };
  for(let i=0;i<30;i++){await frame();if(await evaluate('!!document.querySelector(".conversation-toolbar")'))break;}
  for(const theme of ['light','dark']) for(const width of [1060,390]) {
   win.setSize(width,820);await frame();
   await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));
   await evaluate(${JSON.stringify(`document.querySelector('[aria-label="项目 示例项目 的更多操作"]').click()`)});await frame();
   await evaluate('[...document.querySelectorAll(".context-menu button")].find(b=>b.textContent.includes("从 Cursor 导入对话")).click()');await frame();
   assert.equal(await evaluate('document.querySelector("dialog").open'),true);
   const content=await evaluate('document.querySelector("dialog").textContent');
   assert.ok(content.includes('已导入')&&content.includes('打开')&&content.includes('导入'));
   assert.equal(await evaluate('document.querySelectorAll(".cursor-import-list li").length'),2);
   assert.equal(await evaluate('(()=>{const d=document.querySelector("dialog"),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&d.scrollWidth<=d.clientWidth})()'),true);
   await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'-dialog.png'),(await screenshot()).toPNG());
   await evaluate('[...document.querySelectorAll("dialog button")].find(b=>b.textContent.trim()==="打开").click()');await frame();
   assert.equal(await evaluate('!!document.querySelector("dialog")'),false);
   assert.equal(await evaluate('document.body.textContent.includes("Imported from Cursor: 项目设计与实现记录")'),true);
   assert.equal(await evaluate('document.body.textContent.includes("项目设计与实现记录.md")'),true);
   assert.equal(await evaluate(${JSON.stringify(`!!document.querySelector('.message-actions [aria-label="编辑"], .message-actions [aria-label="重新发送"]')`)}),false);
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
   await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'-conversation.png'),(await screenshot()).toPNG());
  }
  assert.ok(await evaluate('window.modeCatalogMethods.length>0&&window.modeCatalogMethods.every(method=>method==="GET")'));
  console.log('4 layouts passed; 8 screenshots; imported attachment visible; edit/resend absent.');
 } catch(error){console.error(error);process.exitCode=1;}
 finally{win?.destroy();app.exit(process.exitCode||0);}
});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
      cwd: process.cwd(),
      env,
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
  },
);
