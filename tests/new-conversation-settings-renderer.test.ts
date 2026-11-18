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
  'offline new-chat settings open with routing and memory, retain the draft and include Skills for this conversation',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-new-settings-')));
    const artifacts = resolve('artifacts/new-conversation-settings');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-new-settings-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      stdin: {
        contents:
          '@import "./src/ui/studio.css"; @import "./src/ui/SwarmWorkspace.css"; @import "./src/ui/SideChatPanel.css"; @import "./src/ui/ConversationPanel.css"; @import "./src/ui/composer.css";',
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      outfile: join(fixture, 'style.css'),
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>*,*::before,*::after{transition:none!important;animation:none!important}</style><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import React from'react';import{createRoot}from'react-dom/client';import{ConversationWorkspace}from'./src/ui/Workspace';import{ComposerSession}from'./src/ui/composer-session';
const stamp='2026-10-24T12:00:00Z',project={id:'project',name:'离线合成项目',path:'C:/Synthetic',scope:'project',createdAt:stamp,updatedAt:stamp};
const state={app:{version:'fixture'},projects:[project],conversations:[],conversationMessages:[],workflows:[],runs:[],runtimes:[],targets:[],approvals:[],plugins:[],settings:{}};
const session=new ComposerSession();const f=window.fixture={calls:[],notices:[],memoryCalls:0,project,current:undefined,session};let creates=0;
const skills=[{id:'skill-ponytail',kind:'skill',name:'ponytail',enabled:true,description:'用最小完整改动解决开发任务。'},{id:'skill-review',kind:'skill',name:'code-review',enabled:true,description:'检查改动的正确性和边界。'},{id:'skill-paused',kind:'skill',name:'paused-example',enabled:false,description:'已停用的离线合成 Skill。'}];
const api=async(path,body,method='POST')=>{f.calls.push({path,body,method});if(path==='/api/conversations'){const created={id:'created-'+(++creates),projectId:f.project?.id??'chat',title:'新对话',createdAt:stamp,updatedAt:stamp};state.conversations.push(created);return new Promise(resolve=>f.finishCreate=()=>resolve(created));}if(path.endsWith('/skills')&&method==='PATCH'){const target=state.conversations.find(c=>c.id===path.split('/')[3]);target.appliedSkills=[...body.appliedSkills];return{...target};}if(path.split('?')[0]==='/api/extensions')return{items:skills};if(path.endsWith('/local-memory'))return{exportEnabled:false,cliEnabled:false,archiveDirectory:'',projectDirectory:'',dataDirectory:'',files:[],warnings:[]};if(path.endsWith('/memory'))return{projectId:'project',content:'',revision:0,updatedAt:stamp};if(method==='GET')return{messages:[],workflows:[]};throw Error('Unexpected write '+path);};
const root=createRoot(document.getElementById('root'));window.renderFixture=()=>root.render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace composerSession={session} state={state} api={api} project={f.project} conversation={f.current} notify={n=>f.notices.push(n)} onConversation={c=>{f.current=c;window.renderFixture();}} onAddProject={()=>{}} onMemory={()=>f.memoryCalls++} onInspect={()=>{}}/></main>);localStorage.setItem('comborunner.locale','zh-CN');window.renderFixture();
`,
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: join(fixture, 'fixture.js'),
      loader: { '.png': 'dataurl' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1120,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!d.url.startsWith('file://');if(cancel)remote++;cb({cancel});});
win.webContents.on('console-message',(_event,_level,message)=>{if(/Error|Warning/.test(message))console.error('Renderer console: '+message);});await win.loadFile(path.join(__dirname,'index.html'));const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error('Renderer step: '+code,{cause:error});}};const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const wait=async code=>{for(let n=0;n<50;n++){await frame();if(await read(code))return;}throw Error('Not ready: '+code);};const click=async selector=>{await read('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
await wait('!!document.querySelector("#conversation-input")');await read('(()=>{const e=document.querySelector("#conversation-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"设置前写下的草稿会保留");e.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();
await read('(()=>{const b=document.querySelector("button[aria-label=对话设置]");b.click();b.click();b.click();})()');await frame();assert.equal(await read('window.fixture.calls.filter(c=>c.path==="/api/conversations").length'),1);await read('window.fixture.finishCreate()');await wait('!!document.querySelector(".conversation-panel")');assert.equal(await read('window.fixture.memoryCalls'),0);assert.equal(await read('document.querySelector("#conversation-input").value'),'设置前写下的草稿会保留');
assert.deepEqual(await read('[...document.querySelectorAll(".conversation-panel [role=tab]")].map(e=>e.textContent.trim())'),['路由规则','Skills','记忆']);assert.equal(await read('document.querySelector(".conversation-panel [role=tab][aria-selected=true]").textContent.trim()'),'路由规则');
for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);await fs.writeFile(path.join(${JSON.stringify(artifacts)},'new-chat-settings-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());}
await read('[...document.querySelectorAll(".conversation-panel [role=tab]")].find(e=>e.textContent.trim()==="Skills").click()');await wait('document.querySelectorAll(".skills-tab input[type=checkbox]").length===2');assert.deepEqual(await read('[...document.querySelectorAll(".skills-tab input[type=checkbox]")].map(e=>({checked:e.checked,disabled:e.disabled}))'),[{checked:false,disabled:false},{checked:false,disabled:false}]);assert.doesNotMatch(await read('document.querySelector(".skills-tab").textContent'),/paused-example/);assert.equal(await read('[...document.querySelectorAll(".conversation-panel button")].some(e=>/保存/.test(e.textContent))'),false);assert.match(await read('document.querySelector(".skills-tab").textContent'),/未勾选的仍可按需调用/);
const shot=async name=>{await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('skills-default-unchecked-'+theme);}
await click('.skills-tab input[type=checkbox]');await wait('window.fixture.calls.some(c=>c.path.endsWith("/skills")&&c.method==="PATCH")&&!document.querySelector(".skills-tab [aria-label=正在保存]")');assert.deepEqual(await read('window.fixture.calls.filter(c=>c.path.endsWith("/skills")&&c.method==="PATCH").map(c=>({path:c.path,body:c.body}))'),[{path:'/api/conversations/created-1/skills',body:{appliedSkills:['ponytail']}}]);assert.deepEqual(await read('[...document.querySelectorAll(".skills-tab input[type=checkbox]")].map(e=>e.checked)'),[true,false]);assert.equal(await read('document.querySelector("#conversation-input").value'),'设置前写下的草稿会保留');assert.equal(await read('window.fixture.calls.filter(c=>c.path==="/api/conversations").length'),1);assert.equal(await read('[...document.querySelectorAll(".conversation-panel button")].some(e=>/保存/.test(e.textContent))'),false);for(const theme of ['light','dark']){await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('skills-applied-autosaved-'+theme);}win.setSize(390,850);await frame();assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);await shot('skills-applied-dark-390');win.setSize(1120,850);await frame();
await click('button[aria-label=关闭对话设置]');await wait('!document.querySelector(".conversation-panel")');await click('button[aria-label=对话设置]');await wait('!!document.querySelector(".conversation-panel")');assert.equal(await read('window.fixture.calls.filter(c=>c.path==="/api/conversations").length'),1);
await read('[...document.querySelectorAll(".conversation-panel [role=tab]")].find(e=>e.textContent.trim()==="记忆").click()');await frame();assert.equal(await read('document.querySelector(".conversation-panel [role=tab][aria-selected=true]").textContent.trim()'),'记忆');await click('button[aria-label=对话设置]');assert.equal(await read('!!document.querySelector(".conversation-panel")'),false);
await read('window.fixture.project=undefined;window.renderFixture()');await frame();await click('button[aria-label=对话设置]');await read('window.fixture.finishCreate()');await wait('!!document.querySelector(".conversation-panel")');assert.deepEqual(await read('window.fixture.calls.filter(c=>c.path==="/api/conversations").map(c=>c.body)'),[{projectId:'project'},{}]);assert.equal(await read('window.fixture.notices.length'),0);assert.equal(await read('window.fixture.calls.some(c=>c.method!=="GET"&&/messages|workflows|runs/.test(c.path))'),false);assert.equal(remote,0);
console.log('PASS new-chat settings renderer: single creation, routing/Skills/memory, enabled Skills unchecked, per-chat auto-save, disabled Skills hidden, no Save button, draft retention, close/reopen, standalone chat, 7 screenshots, no remote requests');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        cwd: process.cwd(),
        env,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS new-chat settings renderer/);
  },
);
