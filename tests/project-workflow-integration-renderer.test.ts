import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'real Studio work panel preserves drafts and request identities through lost responses for jobs, mail and lanes',
  { timeout: 60000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-work-panel-renderer-')));
    const artifacts = resolve('artifacts/project-workflow-tools');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-work-panel-renderer-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const styles = [...(await readFile('src/ui/main.tsx', 'utf8')).matchAll(/^import '\.\/([^']+\.css)';$/gm)]
      .map((match) => `@import "./src/ui/${match[1]}";`)
      .join('\n');
    await build({
      stdin: { contents: styles, resolveDir: process.cwd(), loader: 'css' },
      bundle: true,
      outfile: join(directory, 'style.css'),
    });
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import Studio from './src/ui/Studio';
const at='2026-10-25T12:00:00Z';const project={id:'project',name:'Synthetic ordinary chat',path:'C:/Synthetic',scope:'chat',createdAt:at,updatedAt:at};
const main={id:'main',projectId:'project',title:'Main fixture',createdAt:at,updatedAt:at,delegationCount:1};
const parent={id:'parent',conversationId:'main',projectId:'project',status:'completed',input:{content:'Synthetic main',permissionMode:'read-only'},runIds:[],plan:[],createdAt:at,updatedAt:at};
const child={...parent,id:'child',delegation:{parentId:'parent',requestId:'request',label:'Retained child',depth:1},input:{content:'Child fixture',permissionMode:'read-only'}};
const state={app:{version:'fixture'},projects:[project],conversations:[main],conversationMessages:[],workflows:[parent,child],runs:[],targets:[],runtimes:[],approvals:[],plugins:[],settings:{}};
const calls=[],jobs=[],mail=[],lanes=[],desktop={opened:0,closed:0},receipts=new Map(),lost=new Set();window.fixture={state,calls,desktop,jobs,mail,lanes};
const acceptOnce=(kind,body,create)=>{const key=kind+':'+body.requestId,prior=receipts.get(key);if(prior){if(prior.input!==JSON.stringify(body))throw Error('Request id reused for changed payload');return prior.value;}const value=create();receipts.set(key,{input:JSON.stringify(body),value});if(!lost.has(kind)){lost.add(kind);throw Error('Accepted then response lost: '+kind);}return value;};
window.comboRunnerDesktop={pickDirectory:async()=>null,projectTools:{openTerminal:async conversationId=>{desktop.opened++;return{id:'owned-terminal',conversationId,directory:'Synthetic directory',shell:'fixture',output:'',sequence:0}},closeTerminal:async()=>{desktop.closed++},resizeTerminal:async()=>{},writeTerminal:async()=>{},onEvent:()=>()=>{}}};
const api=async(path,body,method='POST')=>{calls.push({path,body,method});const id=decodeURIComponent(path.split('/')[3]??'');
 if(path==='/api/modes')return{catalog:[],installed:[]};
 if(path.endsWith('/cli-context'))return{projectId:'project',revision:0,sshQueries:[]};
 if(path.endsWith('/work/peers'))return[{id:'main',title:'Main fixture'},{id:'peer',title:'Synthetic peer'}];
 if(path.endsWith('/work/settings')){const saved={...state.conversations.find(c=>c.id===id),...body};state.conversations=state.conversations.map(c=>c.id===id?saved:c);window.refresh();return saved;}
 if(path.endsWith('/work/jobs')&&method==='POST')return acceptOnce('jobs',body,()=>{const job={...body,id:'job-'+jobs.length,enabled:true,nextAt:at};jobs.push(job);return job;});
 if(path.endsWith('/work/messages'))return acceptOnce('mail',body,()=>{const message={...body,id:'mail-'+mail.length};mail.push(message);return message;});
 if(path.endsWith('/work/lanes'))return acceptOnce('lanes',body,()=>{const lane={id:'lane-'+lanes.length,projectId:'project',title:body.title,createdAt:at,updatedAt:at,lane:{parentConversationId:'main',sourceWorkflowId:'parent'},collaborationEnabled:true};lanes.push(lane);state.conversations=[...state.conversations,lane];return lane;});
 if(path.endsWith('/work'))return{jobs,messages:[]};
 if(path.endsWith('/delegation'))return{workflows:state.workflows};
 if(path.endsWith('/delegation-parent')&&method==='GET')return{workflow:parent};
 if(method!=='GET')throw Error('Unexpected write '+path);
 return{conversation:state.conversations.find(c=>c.id===id),messages:[],workflows:state.workflows.filter(w=>w.conversationId===id),runs:[]};};
window.__backend={connection:'connected',state,api,reload:async()=>window.refresh()};
localStorage.setItem('agent-studio-conversation','main');localStorage.setItem('comborunner.locale','zh-CN');sessionStorage.removeItem('pugport-ui-page');
const root=createRoot(document.getElementById('root'));window.refresh=()=>root.render(<Studio/>);window.refresh();
window.setField=(label,value)=>{const field=[...document.querySelectorAll('.conversation-work-panel label')].find(e=>e.querySelector('span')?.textContent===label)?.querySelector('input,textarea,select');if(!field)throw Error('Missing field '+label);Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));};
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(directory, 'fixture.js'),
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
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>',
    );
    const runner = join(directory, 'runner.cjs');
    await writeFile(
      runner,
      `const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,offscreen:true}});win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://')}));await win.loadFile(path.join(__dirname,'index.html'));
const run=code=>win.webContents.executeJavaScript(code),wait=async condition=>{for(let i=0;i<150;i++){if(await run(condition))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+condition);};
const screenshot=async file=>{await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const image=await new Promise(resolve=>{win.webContents.once('paint',(_event,_dirty,image)=>resolve(image));win.webContents.invalidate();});await fs.writeFile(file,image.toPNG());};
await wait('!!document.querySelector("#conversation-input")');assert.equal(await run('window.fixture.desktop.opened'),0);assert.equal(await run('!!document.querySelector("button[aria-label=创建子代理]")'),false);assert.equal(await run('!!document.querySelector(".conversation-delegation-tree")'),false);
await run('(()=>{const input=document.querySelector("#conversation-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"COMPOSER_DRAFT_KEEP");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
await run('document.querySelector("button[aria-label=协作与后台工作]").click()');await wait('!!document.querySelector(".conversation-work-panel")');assert.equal(await run('window.fixture.desktop.opened'),0,'work panel must not start a terminal');
assert.notEqual(await run('getComputedStyle(document.querySelector(".conversation-work-panel")).backgroundColor'),'rgba(0, 0, 0, 0)','work panel must be opaque');assert.equal(await run('getComputedStyle(document.querySelector("button[aria-label=终端和浏览器]")).whiteSpace'),'nowrap');
assert.deepEqual(await run('[...document.querySelectorAll(".conversation-work-body > details > summary > span:first-child")].map(e=>e.textContent)'),['安排提醒或循环工作','给其他对话发消息','子代理与工作线']);assert.equal(await run('[...document.querySelectorAll(".conversation-work-body > details")].some(e=>e.open)'),false,'ordinary collaboration starts folded');await run('document.querySelector(".conversation-work-panel input[type=checkbox]").closest("details").open=true;document.querySelector(".conversation-work-panel input[type=checkbox]").click()');await wait('window.fixture.state.conversations[0].collaborationEnabled===true&&!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent.trim()==="新建子代理").click()');await wait('!!document.querySelector("dialog[aria-label=创建子代理][open]")');assert.equal(await run('document.querySelector("select[aria-label=子代理角色]").value'),'reviewer');await run('document.querySelector("button[aria-label=关闭创建子代理]").click()');await wait('!document.querySelector("dialog[aria-label=创建子代理]")');
await run('window.fixture.state.projects=[{...window.fixture.state.projects[0],scope:"project",name:"Synthetic project"}];window.refresh()');await wait('!!document.querySelector(".delegation-tree-toggle")');await wait('!!document.querySelector(".conversation-delegation-tree")');assert.equal(await run('document.querySelectorAll(".conversation-mode-child").length'),0);assert.equal(await run('[...document.querySelectorAll(".conversation-work-body details")].find(e=>e.querySelector(":scope > summary > span")?.textContent==="高级").open'),false);
await run('document.querySelector(".delegation-tree-toggle").click()');await wait('!!document.querySelector(".delegation-tree-popover")');assert.equal(await run('[...document.querySelectorAll(".delegation-tree-popover button")].some(b=>b.textContent.includes("新建子代理"))'),false,'the tree has no duplicate create action');await run('document.querySelector(".delegation-tree-toggle").click()');await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent.trim()==="新建子代理").click()');await wait('!!document.querySelector("dialog[aria-label=创建子代理][open]")');await run('document.querySelector("button[aria-label=关闭创建子代理]").click()');await wait('!document.querySelector("dialog[aria-label=创建子代理]")');
await run('window.setField("名称","Synthetic reminder");window.setField("要做什么","Read synthetic status only.");window.setField("运行方式","interval")');await wait('!![...document.querySelectorAll(".conversation-work-panel label")].find(e=>e.textContent.includes("间隔（分钟）"))');await run('window.setField("间隔（分钟）","7")');
await run('[...document.querySelectorAll(".conversation-work-panel details")].find(e=>e.querySelector("summary")?.textContent.includes("安排提醒")).open=true');await screenshot(${JSON.stringify(join(artifacts, 'collaboration-panel.png'))});
await run('document.querySelector("button[aria-label=终端和浏览器]").click()');await wait('window.fixture.desktop.opened===1');assert.equal(await run('document.querySelector("#conversation-input").value'),'COMPOSER_DRAFT_KEEP');
await wait('!!document.querySelector(".project-tool-path")');
await screenshot(${JSON.stringify(join(artifacts, 'desktop-dock.png'))});
await run('document.querySelector("button[aria-label=协作与后台工作]").click()');await wait('!!document.querySelector(".conversation-work-panel")');assert.equal(await run('window.fixture.desktop.closed'),0,'switching panels must keep the terminal alive');
assert.equal(await run('[...document.querySelectorAll(".conversation-work-panel label")].find(e=>e.querySelector("span")?.textContent==="名称").querySelector("input").value'),'Synthetic reminder','work form draft survives panel switch');
await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent==="安排工作").click()');await wait('window.fixture.calls.some(c=>c.path.endsWith("/work/jobs")&&c.method==="POST")');
const job=await run('window.fixture.calls.find(c=>c.path.endsWith("/work/jobs")&&c.method==="POST").body');assert.deepEqual(job.schedule,{type:'interval',minutes:7});assert.equal(job.write,false);assert.equal(job.prompt,'Read synthetic status only.');assert.match(job.requestId,/^[0-9a-f-]{36}$/);
await wait('document.querySelector(".conversation-work-panel [role=alert]")?.textContent.includes("response lost: jobs")&&!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');assert.equal(await run('window.fixture.jobs.length'),1);
assert.equal(await run('[...document.querySelectorAll(".conversation-work-panel label")].find(e=>e.querySelector("span")?.textContent==="名称").querySelector("input").value'),'Synthetic reminder','accepted but unacknowledged job retains its draft');
await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent==="安排工作").click()');await wait('window.fixture.calls.filter(c=>c.path.endsWith("/work/jobs")&&c.method==="POST").length===2&&!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');
const jobRetry=await run('window.fixture.calls.filter(c=>c.path.endsWith("/work/jobs")&&c.method==="POST")[1].body');assert.deepEqual(jobRetry,job,'unchanged job retry retains its exact UUID and payload');assert.equal(await run('window.fixture.jobs.length'),1,'lost response must not duplicate the accepted job');
await run('[...document.querySelectorAll(".conversation-work-panel details")].find(e=>e.querySelector("summary")?.textContent.includes("给其他对话发消息")).open=true;window.setField("接收对话","peer");window.setField("协作信息","Synthetic peer result.")');
await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent==="发送并在空闲时提醒").click()');await wait('document.querySelector(".conversation-work-panel [role=alert]")?.textContent.includes("response lost: mail")&&!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');
const mail=await run('window.fixture.calls.find(c=>c.path.endsWith("/work/messages")).body');assert.equal(await run('window.fixture.mail.length'),1);assert.equal(mail.toConversationId,'peer');assert.equal(mail.text,'Synthetic peer result.');
assert.equal(await run('[...document.querySelectorAll(".conversation-work-panel label")].find(e=>e.querySelector("span")?.textContent==="协作信息").querySelector("textarea").value'),'Synthetic peer result.');
await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent==="发送并在空闲时提醒").click()');await wait('window.fixture.calls.filter(c=>c.path.endsWith("/work/messages")).length===2&&!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');assert.deepEqual(await run('window.fixture.calls.filter(c=>c.path.endsWith("/work/messages"))[1].body'),mail);assert.equal(await run('window.fixture.mail.length'),1,'lost response must not duplicate the accepted mail');
await wait('!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');await run('window.setField("新建长期工作线","Synthetic persistent lane")');await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent.includes("创建工作线")).click()');await wait('window.fixture.calls.some(c=>c.path.endsWith("/work/lanes"))');assert.equal(await run('window.fixture.calls.find(c=>c.path.endsWith("/work/lanes")).body.title'),'Synthetic persistent lane');
await wait('document.querySelector(".conversation-work-panel [role=alert]")?.textContent.includes("response lost: lanes")&&!document.querySelector(".conversation-work-panel input[type=checkbox]").disabled');const lane=await run('window.fixture.calls.find(c=>c.path.endsWith("/work/lanes")).body');assert.equal(await run('window.fixture.lanes.length'),1);
assert.equal(await run('[...document.querySelectorAll(".conversation-work-panel label")].find(e=>e.querySelector("span")?.textContent==="新建长期工作线").querySelector("input").value'),'Synthetic persistent lane');
await run('[...document.querySelectorAll(".conversation-work-panel button")].find(b=>b.textContent.includes("创建工作线")).click()');await wait('window.fixture.calls.filter(c=>c.path.endsWith("/work/lanes")).length===2');assert.deepEqual(await run('window.fixture.calls.filter(c=>c.path.endsWith("/work/lanes"))[1].body'),lane);assert.equal(await run('window.fixture.lanes.length'),1,'lost response must not create another lane');
assert.equal(await run('window.fixture.state.conversations.filter(c=>c.lane).length'),1);console.log('PASS work panel explicit collaboration, retained child tree, lazy desktop and drafts, exactly-once job/mail/lane after accepted-response loss');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0)}});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS work panel/);
  },
);
