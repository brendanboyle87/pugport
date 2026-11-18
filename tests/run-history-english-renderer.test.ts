import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';

// Real Studio and WorkflowTrace in hidden offscreen Electron, English UI, synthetic state and no backend.
test(
  'Electron: Run history labels translate in English while the user message stays as written',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-run-history-en-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-run-history-en-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve('reports/run-history-english');
    await mkdir(screenshots, { recursive: true });
    const app = resolve('src/ui/App.tsx');
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import Studio from './src/ui/Studio';
import {WorkflowTrace} from './src/ui/Workspace';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
import './src/ui/composer.css';
import './src/ui/ConversationTrace.css';
localStorage.setItem('comborunner.locale','en');
localStorage.setItem('agent-studio-theme','light');
window.errors=[];
window.addEventListener('error',event=>window.errors.push(event.message));
window.fetch=()=>{throw Error('Unexpected real fetch');};
const stamp='2026-10-19T14:00:00Z';
const route={runtimeId:'fixture',model:'gpt-5.5',effort:'medium',kind:'routine',reasons:[],warnings:[]};
const run=(id,extra)=>({id,prompt:'Internal instructions',projectPath:'C:/Fixture',kind:'routine',status:'completed',route,startedAt:stamp,output:'Done.',events:[],...extra});
const project={id:'project',name:'Fixture',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const conversation={id:'chat',projectId:'project',title:'Spring launch',createdAt:stamp,updatedAt:stamp};
const task={id:'task',conversationId:'chat',projectId:'project',userMessageId:'message',input:{content:'Fixture',mode:'auto',permissionMode:'read-only',executionPolicy:'cli-first'},status:'completed',phase:'summarize',
 plan:[{id:'step',title:'Draft the plan',status:'completed',runIds:['asked']}],runIds:['asked'],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp};
const state={app:{version:'test'},projects:[project],conversations:[conversation],workflows:[task],
 runs:[run('asked',{workflowId:'task',userInput:'把发布计划整理成表格'}),run('unknown',{startedAt:'2026-10-19T13:00:00Z'}),
  run('continued',{userInput:'继续',workflowId:'gone',startedAt:'2026-10-19T12:00:00Z',verification:{command:'npm test',status:'passed',exitCode:0,output:''}})],
 conversationMessages:[],runtimes:[],targets:[],approvals:[],plugins:[],refreshing:false,
 settings:{maxQuotaAgeSeconds:120,reservePercent:10,refreshSeconds:60,toolApprovalMode:'auto',executionPolicy:'cli-first'}};
const api=async(path,_body,method='POST')=>{
 if(path==='/api/modes'){
  if(method!=='GET')throw Error('Mode catalog must use GET');
  return {catalog:[],installed:[]};
 }
 if(path==='/api/workflows/task/execution-record'){
  if(method!=='GET')throw Error('Execution records must use GET');
  return {workflow:task,userInput:state.runs[0].userInput,runs:[state.runs[0]],relatedRuns:[]};
 }
 // What App.tsx's api() throws when the server answers without a JSON error.
 if(path.endsWith('/execution-record'))throw Error('请求失败（404）');
 return path==='/api/scheduled-tasks'?[]:{messages:[],workflows:[],runs:[]};
};
window.__backend={state,api,reload:async()=>{},connection:'connected'};
localStorage.setItem('agent-studio-conversation','chat');
void startInterfaceLanguage().then(()=>{
 createRoot(document.getElementById('root')).render(<Studio/>);
 createRoot(document.getElementById('trace')).render(<WorkflowTrace workflow={task} state={state} api={api} notify={()=>{}} onInspect={()=>{}} onTrace={()=>{}}/>);
});`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
      plugins: [
        {
          name: 'synthetic-backend',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/App$/ }, (args) =>
              args.importer.endsWith('Studio.tsx') ? { path: 'backend', namespace: 'mock' } : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              contents: `export * from ${JSON.stringify(app)};\nexport const useBackend=()=>window.__backend;`,
              resolveDir: process.cwd(),
            }));
          },
        },
      ],
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>#trace{display:none;width:560px;padding:20px}</style></head><body><div id="root"></div><div id="trace"></div><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let win;const network=[];
const evaluate=source=>win.webContents.executeJavaScript(source);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const wait=async(expression)=>{for(let n=0;n<250;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+expression);};
const textOf=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent.trim()');
const click=async(selector,text)=>{if(!await evaluate('(()=>{const node=[...document.querySelectorAll('+JSON.stringify(selector)+')].find(node=>node.textContent.includes('+JSON.stringify(text)+'));node?.click();return !!node;})()'))throw Error('Missing '+selector+' '+text);await frame();};
const shot=async(name,rect)=>{await evaluate('document.fonts.ready');await frame();await new Promise(resolve=>setTimeout(resolve,300));await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage(rect)).toPNG());};
void app.whenReady().then(async()=>{
 try{
  win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
  await win.loadFile(path.join(__dirname,'index.html'));
  await wait('!!document.querySelector(".nav-item")');
  const traceButton='.toolbar-actions button[aria-label="View chat trace"]';
  const traceBackground=()=>evaluate('getComputedStyle(document.querySelector('+JSON.stringify(traceButton)+')).backgroundColor');
  const idleTraceBackground=await traceBackground();
  assert.equal(await evaluate('document.querySelector('+JSON.stringify(traceButton)+').getAttribute("aria-pressed")'),'false');
  await click(traceButton,'');
  await wait('!!document.querySelector(".conversation-trace-inspect")');
  assert.equal(await evaluate('document.querySelector('+JSON.stringify(traceButton)+').getAttribute("aria-pressed")'),'true');
  assert.notEqual(await traceBackground(),idleTraceBackground,'Open trace has a visible pressed background');
  assert.equal(await evaluate('!!document.querySelector(".run-record-back")'),false);
  await click('.conversation-trace-inspect','Open in run history');
  await wait('!!document.querySelector(".run-record-back")');
  assert.equal(await textOf('.run-record-back'),'All runs');
  assert.equal(await textOf('.run-record-group h2'),'Spring launch');
  assert.equal(await evaluate('document.querySelectorAll(".run-record-item").length'),1);
  assert.equal(await textOf('.run-record-item.selected > span'),'把发布计划整理成表格');
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('run-history-scoped-'+theme);}
  await click('.run-record-back','All runs');
  assert.equal(await evaluate('document.querySelectorAll(".run-record-item").length'),3);
  assert.equal(await textOf('.run-record-item.selected > span'),'把发布计划整理成表格');
  assert.equal(await evaluate('[...document.querySelectorAll(".management-heading button")].some(button=>button.textContent.includes("Back to chat"))'),false);
  await click('.conversation-link','Spring launch');
  await click('.nav-item','Task');await click('[role=tab]','Run history');
  await wait('document.querySelectorAll(".run-record-item").length===3');
  await click('.run-record-item','把发布计划整理成表格');
  await wait('!!document.querySelector(".run-prompt")');
  assert.equal(await evaluate('document.querySelector(".run-record-item.selected > code")'),null);
  assert.equal(await textOf('.run-prompt > span'),'Original user message');
  assert.equal(await textOf('.run-prompt > p'),'把发布计划整理成表格');
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('run-history-'+theme);}
  // What the user wrote stays as written even when it equals an interface string.
  await evaluate('document.querySelector(".run-prompt > p").firstChild.nodeValue="继续"');await frame();
  assert.equal(await textOf('.run-prompt > p'),'继续');
  await click('.run-record-item','Original message unavailable');
  await wait('document.querySelector(".run-prompt > p")?.textContent.trim()!=="继续"');
  assert.equal(await textOf('.run-prompt > p'),'The original user message is unavailable.');
  // In the list too, only the fallback is interface text.
  const listed=await evaluate('[...document.querySelectorAll(".run-record-item > span:first-child")].map(node=>node.textContent.trim())');
  assert.deepEqual(listed,['把发布计划整理成表格','Original message unavailable','继续']);
  await click('.run-record-item','继续');
  // The load-failure notice is one sentence, so its closing punctuation translates with it; the error inside is
  // itself an interface sentence.
  await wait('!!document.querySelector(".run-detail-notice.failed")');
  assert.equal(await textOf('.run-detail-notice.failed > span'),'Failed to load the complete task execution history (Request failed (404)).');
  // With no command output, the placeholder is interface text rather than protected output.
  await click('[role=tab]','Validation');
  assert.equal(await textOf('.verification-result > :last-child'),'The command produced no output.');
  for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await shot('run-history-validation-'+theme);}
  assert.equal(await evaluate('document.querySelector("#trace .execution-chip")'),null);
  assert.equal(await textOf('#trace .trace-link'),'View trace');
  await evaluate('document.documentElement.dataset.theme="light";document.getElementById("root").style.display="none";document.getElementById("trace").style.display="block";document.querySelector("#trace details").open=true');
  const rect=await evaluate('(()=>{const r=document.querySelector("#trace .plan-list").getBoundingClientRect();return {x:0,y:0,width:600,height:Math.ceil(r.bottom+20)};})()');
  await shot('task-plan-light',rect);
  assert.deepEqual(await evaluate('window.errors'),[]);assert.deepEqual(network,[]);
  console.log('PASS run history English labels');app.exit(0);
 }catch(error){console.error(error);if(win)console.error(await evaluate("document.body.textContent.slice(0,3000)").catch(()=>''));app.exit(1);}
});`.replace('SCREENSHOTS', JSON.stringify(screenshots)),
    );
    const env: NodeJS.ProcessEnv = { PUGPORT_UNDER_TEST: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      {
        env,
        windowsHide: true,
        timeout: 75000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS run history English labels/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
