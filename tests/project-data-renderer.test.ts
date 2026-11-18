import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'removed-project management is in settings, preserves original-folder scope and supports safe retries offline',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-project-data-'))),
      artifacts = resolve('artifacts/project-data-settings');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-project-data-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        contents: '@import "./src/ui/studio.css";@import "./src/ui/settings.css";',
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,
      outfile: join(fixture, 'style.css'),
    });
    await build({
      stdin: {
        contents: `import React from'react';import{createRoot}from'react-dom/client';import Studio from'./src/ui/Studio';import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';
const stamp='2026-10-25T12:00:00Z';const p={id:'live',name:'正在使用的项目',scope:'project',path:'C:/Original/live',createdAt:stamp,updatedAt:stamp};
const removed=['safe','active','partial'].map((id,i)=>({...p,id,name:['旧项目：保留源码','仍有任务的项目','上次未完成清空'][i],path:'C:/Original/keep-this-project-folder/'+id,removedAt:stamp}));
const state={app:{version:'fixture'},projects:[p],removedProjects:removed,conversations:[{id:'chat',projectId:p.id,title:'普通父对话',createdAt:stamp,updatedAt:stamp}],conversationMessages:[],workflows:[],runs:[],runtimes:[],targets:[],approvals:[],plugins:[],settings:{}};
const calls=[];let sequence=0,failOnce=true;window.fixture={calls,state};
window.__backend={state,connection:'connected',reload:async()=>window.refresh(),api:async(path,body,method='POST')=>{calls.push({path,body,method});if(path==='/api/modes')return{catalog:[],installed:[]};if(path==='/api/conversation-history')return{archived:7,deleted:3};if(path.startsWith('/api/conversations/'))return{conversation:state.conversations[0],messages:[],workflows:[],runs:[]};const id=path.split('/')[3],project=removed.find(item=>item.id===id);if(path.endsWith('/purge-preview'))return{projectId:id,name:project.name,token:'preview-'+(++sequence),conversations:3,attachments:2,managedFiles:7,managedBytes:2048,preservedProjectPath:project.path,canPurge:id!=='active',blockedReason:id==='active'?'此项目仍有任务在运行。':undefined,partial:id==='partial'||(id==='safe'&&!failOnce)};if(path.endsWith('/purge')){if(failOnce){failOnce=false;throw Error('合成文件暂被占用，请重新检查后重试。');}state.removedProjects=state.removedProjects.filter(item=>item.id!==id);window.refresh();return{projectId:id,conversations:3,attachments:2,deletedFiles:6,freedBytes:1024,sharedFilesKept:1,databaseSpace:'reusable'};}if(path.endsWith('/restore')){state.removedProjects=state.removedProjects.filter(item=>item.id!==id);window.refresh();return project;}throw Error('Unexpected API '+method+' '+path);}};
localStorage.setItem('agent-studio-conversation','chat');localStorage.setItem('agent-studio-project','live');localStorage.setItem('comborunner.locale','zh-CN');const root=createRoot(document.getElementById('root'));window.refresh=()=>root.render(<><Studio/><ConfirmDialogHost/></>);window.refresh();`,
        resolveDir: process.cwd(),
        loader: 'tsx',
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
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
win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0;win.webContents.session.webRequest.onBeforeRequest((details,cb)=>{const cancel=!details.url.startsWith('file://');if(cancel)remote++;cb({cancel});});await win.loadFile(path.join(__dirname,'index.html'));
const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error('Renderer step: '+code,{cause:error});}},frame=()=>read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const wait=async code=>{for(let n=0;n<50;n++){await frame();if(await read(code))return;}throw Error('Not ready '+code);};const click=async code=>{await read(code);await frame();};const row=id=>'[...document.querySelectorAll(".removed-project-settings-row")].find(row=>row.textContent.includes('+JSON.stringify(id)+'))';const button=(id,label)=>'[...'+row(id)+'.querySelectorAll("button")].find(button=>button.textContent.trim()==='+JSON.stringify(label)+')';
await wait('!!document.querySelector(".sidebar-tools")');assert.equal(await read('document.querySelector(".studio-sidebar").textContent.includes("已移除的项目")'),false);assert.equal(await read('window.fixture.calls.filter(call=>call.path.endsWith("/purge-preview")).length'),0);
await click('[...document.querySelectorAll(".sidebar-tools .nav-item")].find(button=>button.textContent.trim()==="设置").click()');await click('document.querySelector('+JSON.stringify('[data-settings-category="conversation"]')+').click()');await wait('document.querySelector("#settings-conversations").textContent.includes("7 个对话")');assert.deepEqual(await read('[...document.querySelectorAll("#settings-conversations .settings-row-status")].map(row=>row.textContent)'),['7 个对话','3 个对话','3 个项目']);assert.equal(await read('!!document.querySelector("#settings-removed-projects")'),false);await click('document.querySelector('+JSON.stringify('[aria-label="管理已移除的项目"]')+').click()');await wait('!!document.querySelector("#settings-removed-projects")');assert.equal(await read('window.fixture.calls.filter(call=>call.path.endsWith("/purge-preview")).length'),0,'collapsed rows do not inspect every project eagerly');
await click(row('旧项目：保留源码')+'.querySelector("summary").click()');await wait(row('旧项目：保留源码')+'.textContent.includes("7 个应用管理文件")');
for(const theme of ['light','dark'])for(const width of [1200,420]){win.setSize(width,900);await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());}
win.setSize(1200,900);await read('document.documentElement.dataset.theme="light"');await frame();await click(button('旧项目：保留源码','永久清空')+'.click()');await wait('!!document.querySelector("dialog[open]")');assert.match(await read('document.querySelector("dialog[open]").textContent'),/3 个对话、2 个附件记录、7 个应用管理文件/);assert.match(await read('document.querySelector("dialog[open]").textContent'),/C:\\/Original\\/keep-this-project-folder\\/safe/);await fs.writeFile(path.join(${JSON.stringify(artifacts)},'confirm-scope.png'),(await win.webContents.capturePage()).toPNG());await click('document.querySelector("dialog[open] .button.secondary").click()');assert.equal(await read('window.fixture.calls.filter(call=>call.path.endsWith("/purge")).length'),0);
await click(button('旧项目：保留源码','永久清空')+'.click()');await wait('!!document.querySelector("dialog[open]")');await click('document.querySelector("dialog[open] .button.danger").click()');await wait(row('旧项目：保留源码')+'.textContent.includes("暂被占用")');await click(button('旧项目：保留源码','重新检查')+'.click()');await wait(row('旧项目：保留源码')+'.textContent.includes("只能重试清空")');assert.equal(await read(button('旧项目：保留源码','恢复')+'.disabled'),true);await click(button('旧项目：保留源码','重试清空')+'.click()');await wait('!!document.querySelector("dialog[open]")');await click('document.querySelector("dialog[open] .button.danger").click()');await wait('!'+row('旧项目：保留源码'));
await click(row('仍有任务的项目')+'.querySelector("summary").click()');await wait(row('仍有任务的项目')+'.textContent.includes("仍有任务在运行")');assert.equal(await read(button('仍有任务的项目','永久清空')+'.disabled'),true);assert.equal(await read('window.fixture.calls.filter(call=>call.path.endsWith("/purge")).length'),2);assert.equal(await read('window.fixture.calls.filter(call=>call.method==="DELETE").length'),0);assert.equal(remote,0);console.log('PASS settings-only removed projects, lazy previews, safe scope confirmation, cancel, partial retry, active-task block and four layouts');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});`,
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
    assert.match(result.stdout, /PASS settings-only/);
  },
);
