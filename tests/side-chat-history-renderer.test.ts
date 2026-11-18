import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'side-chat history right-click deletes only that child and preserves the parent menu',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-side-history-')));
    const artifacts = resolve('artifacts/side-chat-history');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-side-history-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      stdin: {
        contents: '@import "./src/ui/studio.css"; @import "./src/ui/SideChatPanel.css";',
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      outfile: join(fixture, 'style.css'),
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import React from'react';import{createRoot}from'react-dom/client';import Studio from'./src/ui/Studio';import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';
const stamp='2026-10-25T12:00:00Z';const project={id:'p',name:'Synthetic project',path:'C:/Synthetic',scope:'project',createdAt:stamp,updatedAt:stamp};
const chat=(id,title,parent)=>({id,title,projectId:'p',createdAt:stamp,updatedAt:stamp,...(parent?{sideChat:{parentConversationId:parent,context:'Synthetic context',selection:{executionPolicy:'cli-only'}}}:{})});
const conversations=[chat('main','Parent chat'),chat('other','Other parent'),chat('side-one','Child one','main'),chat('side-two','Child two','main'),chat('side-other','Unrelated child','other')];
const messages=[{id:'main-msg',conversationId:'main',role:'assistant',content:'PARENT_MESSAGE_MUST_REMAIN',createdAt:stamp},{id:'child-msg',conversationId:'side-one',role:'assistant',content:'Child one reply',createdAt:stamp}];
const state={app:{version:'fixture'},projects:[project],conversations,conversationMessages:messages,workflows:[],runs:[],runtimes:[],targets:[],approvals:[],plugins:[],settings:{}};const calls=[];window.fixture={state,calls};
const api=async(path,body,method='POST')=>{calls.push({path,body,method});if(path==='/api/modes')return{catalog:[],installed:[]};const id=decodeURIComponent(path.split('/')[3]??'');if(method==='DELETE'){state.conversations=state.conversations.filter(c=>c.id!==id);state.conversationMessages=state.conversationMessages.filter(m=>m.conversationId!==id);window.refreshStudio();return{deleted:true};}if(method!=='GET')throw Error('Unexpected write '+path);return{conversation:state.conversations.find(c=>c.id===id),messages:state.conversationMessages.filter(m=>m.conversationId===id),workflows:[],runs:[]};};
window.__backend={connection:'connected',state,reload:async()=>window.refreshStudio(),api};localStorage.setItem('agent-studio-conversation','main');localStorage.setItem('comborunner.locale','zh-CN');sessionStorage.removeItem('pugport-ui-page');
const root=createRoot(document.getElementById('root'));window.refreshStudio=()=>root.render(<><Studio/><ConfirmDialogHost/></>);window.refreshStudio();
`,
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
              contents:
                'export const useBackend=()=>window.__backend;export const ApprovalCard=()=>null,EmptyState=()=>null,HandoffModal=()=>null,RunOutput=()=>null,SettingsPage=()=>null,StatusPill=()=>null;export const dateLabel=x=>x,readableError=x=>String(x);',
            }));
          },
        },
      ],
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1100,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!d.url.startsWith('file://');if(cancel)remote++;cb({cancel});});await win.loadFile(path.join(__dirname,'index.html'));
const read=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(error){throw Error('Renderer step: '+code,{cause:error})}};const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const wait=async code=>{for(let n=0;n<80;n++){await frame();if(await read(code))return;}throw Error('Not ready: '+code)};
await wait('!!document.querySelector("button[aria-label=侧聊记录]")');await read('document.querySelector("button[aria-label=侧聊记录]").click()');await wait('document.querySelectorAll(".side-chat-history-list > button").length===2');
assert.equal(await read('document.querySelector(".side-chat-history-list").textContent.includes("Unrelated child")'),false);
await read('[...document.querySelectorAll(".side-chat-history-list > button")].find(b=>b.textContent.includes("Child one")).dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:850,clientY:200}))');await wait('!!document.querySelector(".context-menu")');
const menus=await read('[...document.querySelectorAll(".context-menu")].map(e=>e.textContent)');
await read('[...document.querySelectorAll(".context-menu")].at(-1).querySelector("button.danger").click()');await wait('!!document.querySelector("dialog[open], .modal[aria-label=删除对话]")');
await read('(()=>{const side=document.querySelector("dialog[open] .button.danger");if(side)side.click();else document.querySelector(".modal[aria-label=删除对话] button[type=submit]").click()})()');await wait('window.fixture.calls.some(c=>c.method==="DELETE")');
assert.deepEqual(await read('window.fixture.calls.filter(c=>c.method==="DELETE").map(c=>c.path)'),['/api/conversations/side-one'],'right-click delete must target the selected side chat, never its parent');
assert.equal(menus.length,1,'one right-click owns one menu');assert.equal(menus[0].includes('开启蜂群模式'),false,'side-chat menu contains no parent actions');
assert.deepEqual(await read('window.fixture.state.conversations.map(c=>c.id)'),['main','other','side-two','side-other']);assert.equal(await read('window.fixture.state.conversationMessages.find(m=>m.id==="main-msg")?.content'),'PARENT_MESSAGE_MUST_REMAIN');
await wait('document.querySelectorAll(".side-chat-history-list > button").length===1');assert.equal(await read('document.querySelector(".side-chat-history-list").textContent.includes("Child two")'),true);
await read('(()=>{const row=document.querySelector(".side-chat-history-list > button");row.focus();row.dispatchEvent(new KeyboardEvent("keydown",{key:"F10",shiftKey:true,bubbles:true,cancelable:true}))})()');await wait('document.querySelectorAll(".context-menu").length===1');assert.equal(await read('document.querySelector(".context-menu").textContent.includes("开启蜂群模式")'),false,'keyboard menu also belongs to the selected child');await fs.writeFile(path.join(${JSON.stringify(artifacts)},'child-only-context-menu.png'),(await win.webContents.capturePage()).toPNG());
await read('document.querySelector(".context-menu button.danger").click()');await wait('!!document.querySelector("dialog[open]")');assert.equal(await read('document.querySelector("dialog[open]").textContent.includes("Child two")'),true);await read('document.querySelector("dialog[open] .button.secondary").click()');await frame();assert.equal(await read('window.fixture.calls.filter(c=>c.method==="DELETE").length'),1,'cancel deletes neither child nor parent');
await read('document.querySelector("button[aria-label=侧聊记录]").click();document.querySelector(".conversation-heading").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:500,clientY:90}))');await wait('!!document.querySelector(".context-menu")');assert.equal(await read('document.querySelector(".context-menu").textContent.includes("开启蜂群模式")'),true,'parent toolbar retains its own context menu');assert.equal(remote,0);
console.log('PASS child-only delete, single owned menu, preserved parent/sibling/unrelated history, cancelled delete and parent toolbar menu');
}catch(error){console.error(error);process.exitCode=1}finally{win?.destroy();app.exit(process.exitCode||0)}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS child-only delete/);
  },
);
