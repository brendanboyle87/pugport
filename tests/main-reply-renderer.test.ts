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
  'offline Electron shows streamed main replies and hands them to saved messages without exposing internals',
  { timeout: 45000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-main-reply-ui-')));
    const artifacts = resolve('artifacts/main-reply');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-main-reply-ui-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      stdin: {
        contents: '@import "./src/ui/studio.css"; @import "./src/ui/SwarmWorkspace.css";',
        resolveDir: process.cwd(),
        loader: 'css',
      },
      bundle: true,

      tsconfigRaw: {},
      outfile: join(fixture, 'style.css'),
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body><main id="root" style="max-width:760px;margin:auto;padding:20px"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationHistory} from './src/ui/Workspace';
import {WebSearchReply} from './src/ui/WebSearchReply';
import {RunEvidence} from './src/ui/RunEvidence';
import {SwarmPlanPanel,SwarmWorkspaceView,swarmMembers} from './src/ui/SwarmWorkspace';
const stamp=new Date().toISOString(), at=n=>new Date(Date.parse(stamp)+n*1000).toISOString();
const originalRun={id:'run',workflowId:'chat',stepId:'reply',prompt:'Synthetic',projectPath:'',kind:'routine',status:'running',route:{runtimeId:'fixture',model:'synthetic-model',effort:'medium',kind:'routine',reasons:[],warnings:[]},startedAt:stamp,output:'你好，这是第一段回答。',reasoning:'Synthetic reasoning: check the requested reply.\\nHidden reasoning body',events:[]};
const originalTask={id:'chat',conversationId:'conversation',projectId:'project',userMessageId:'user',input:{content:'合成问题',mode:'chat',permissionMode:'read-only',executionPolicy:'cli-first'},status:'running',phase:'execute',activeStepId:'reply',plan:[{id:'reply',title:'回答问题',instruction:'',kind:'routine',transport:'auto',dependsOn:[],status:'running',runIds:['run']}],runIds:['run'],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp};
const user={id:'user',conversationId:'conversation',workflowId:'chat',role:'user',content:'合成问题',createdAt:stamp};
const root=createRoot(document.getElementById('root'));
window.showReplyState=(name)=>{
 let task=structuredClone(originalTask),run=structuredClone(originalRun),messages=[user];
 if(name==='growing')run.output+=' 第二段正在继续。';
 if(name==='notice')messages.push({id:'notice',conversationId:'conversation',workflowId:'chat',role:'assistant',content:'Synthetic relay notice',systemNotice:{text:'Synthetic relay notice'},createdAt:at(5)});
 if(name.startsWith('steering')){
  run.output='OLD_STAGE_MARKER当前补充后的回答。';
  run.events=[{type:'text',at:at(1),text:'OLD_STAGE_MARKER'},{type:'text',at:at(4),text:'当前补充后的回答。'}];
  messages.push({id:'correction',conversationId:'conversation',workflowId:'chat',role:'user',content:'请按补充继续',createdAt:at(2),steering:{runId:'run',status:'accepted',acceptedAt:at(3)}});
 }
 if(name==='steering-empty'){run.summary=true;run.events=[];run.output='OLD_STAGE_MARKER';}
 if(name==='summary'||name==='steering-summary'){
  task.status='completed';task.phase='summarize';task.finalMessageId='final';run.status='completed';run.summary=true;run.events=[];run.output='TRIMMED_TAIL_MARKER';
 }
 if(name==='steering-final'){
  task.status='completed';task.phase='summarize';task.finalMessageId='final';run.status='completed';run.summary=true;run.events=[];
  messages.push({id:'final',conversationId:'conversation',workflowId:'chat',role:'assistant',content:'当前补充后的回答。',createdAt:at(5)});
 }
 if(name==='final-pending'||name==='final'||name==='final-notice'){
  task.status='completed';task.phase='summarize';task.finalMessageId='final';run.status='completed';
  if(name==='final')messages.push({id:'final',conversationId:'conversation',workflowId:'chat',role:'assistant',content:run.output,createdAt:at(5)});
  if(name==='final-notice')messages.push({id:'final',conversationId:'conversation',workflowId:'chat',role:'assistant',content:run.output,systemNotice:{text:'Synthetic final stop notice',details:'TERMINAL_RAW_MARKER'},createdAt:at(5)});
 }
 if(name==='failed'){task.status='failed';run.status='failed';task.error='Synthetic failure';}
 if(name==='planning'){task.status='planning';task.phase='plan';run.stepId=undefined;run.output='PLANNING_JSON_MARKER';}
 if(name==='build')task.input.mode='build';
 if(name==='planned-answer'){
  task.input.mode='auto';task.activeStepId='synthesize';run.stepId='synthesize';
  task.plan=[{id:'search',title:'Find sources',status:'completed',runIds:[]},{...task.plan[0],id:'synthesize',title:'Answer the question'}];
 }
 if(name==='relay'){task.runIds.push('new-run');run.status='failed';}
 if(name==='relay-summary'){run.id='new-run';task.runIds=['new-run'];task.plan[0].runIds=['new-run'];run.summary=true;run.events=[];run.output='OLD_STAGE_MARKER';}
 const state={targets:[],runtimes:[],runs:[run],workflows:[task],settings:{}};
 root.render(<ConversationHistory messages={messages} workflows={[task]} state={state} api={async()=>{throw Error('No backend calls allowed')}} notify={()=>{}} onInspect={()=>{}}/>);
};
window.fixtureCalls=[];
window.showEvidence=()=>{
 const receipt={id:'synthetic-check',source:'host-verification',checkedAt:stamp,snapshot:'0123456789abcdef',reused:true,stable:true,scope:{projectPath:'C:/synthetic',environment:'native',permissionMode:'read-only',command:'synthetic-check'}};
 root.render(<RunEvidence run={{...originalRun,status:'completed',endedAt:at(2),taskOutcome:{status:'completed',source:'executor-report'},verification:{command:'synthetic-check',status:'passed',exitCode:0,output:'',receipt}}}/>);
};
window.showFinishedTeam=()=>{
 const task={...originalTask,id:'finished-team',status:'completed',input:{...originalTask.input,swarm:true},runIds:[]};
 root.render(<SwarmWorkspaceView members={swarmMembers([task],[],[])} communications={[]} messages={[]} loading={false} sending={false} draft="" onSelect={()=>{}} onDraft={()=>{}} onSend={()=>{}} onInspect={()=>{}} plan={{scope:'finished-team',done:1,rows:[{id:'done',title:'Old completed task',kind:'read',state:'done'}]}}/>);
};
window.showSearchReading=()=>{
 const article=['## Student account and student card guide','','**Start with the official account.** Complete your account setup before submitting a card request. This source explains the sequence and the records to keep.','','### Before you apply','','- Confirm your student number and legal name','- Use the photo requirements on the official page','- Keep a copy of the confirmation email','','### Review the dates','','For the next intake, check the next published date. A previous intake date gives context, but it does not establish the next deadline.','','| Check | Where to look |','| --- | --- |','| Account status | Student portal |','| Card request | Official card page |'].join(String.fromCharCode(10));
 const source={id:'source',conversationId:'chat',role:'assistant',content:'Saved source list',createdAt:stamp,webSearch:{query:'Which enrollment dates are confirmed?',status:'completed',durationMs:530,estimatedCostCny:0.005,results:[{title:'Official registration dates',url:'https://example.com/dates',date:'2026-10-24T12:00:00.000Z',summary:'Short readable overview. Dates need to be checked against the current official release.'},{title:'Student account and student card guide',url:'https://example.org/guide',date:'2026-10-23T08:30:00.000Z',summary:article}]}};
 const plan={scope:'reading-fixture',done:1,rows:[{id:'done',title:'Old completed task',kind:'read',state:'done'},{id:'failed',title:'Old failed task',kind:'read',state:'failed'},{id:'running',title:'Active task stays visible',kind:'read',state:'running'}]};
 root.render(<><SwarmPlanPanel plan={plan}/><h2>Which enrollment dates are confirmed?</h2><WebSearchReply message={source} api={async(path)=>{window.fixtureCalls.push(path);return {reply:{...source,webSearch:{...source.webSearch,answer:{status:'unavailable',error:'Synthetic executor unavailable'}}}};}}/></>);
};
window.showSearchSafety=()=>{
 const summary=['## Source formatting boundaries','','![Tracker alt](https://tracker.invalid/pixel.gif)','','<img src="https://tracker.invalid/raw.gif" onerror="window.injected=true"><script>window.injected=true</script><iframe src="https://tracker.invalid/frame"></iframe>','','[Unsafe](javascript:alert) [Local](file:///C:/private.txt) [Credentials](https://user:password@example.org/) [Safe](https://example.org/read)','',String.fromCharCode(96).repeat(3)+'text','unbroken-code-'.repeat(100),String.fromCharCode(96).repeat(3),'','| Item | Long value |','| --- | --- |','| Example | '+'table-cell-'.repeat(100)+' |'].join(String.fromCharCode(10));
 const source={id:'safety',conversationId:'chat',role:'assistant',content:'',createdAt:stamp,webSearch:{query:'Offline formatting fixture',status:'completed',results:[{title:'',url:'https://example.org/'+'long-path-'.repeat(100),summary,date:'Date unavailable'},{title:'Source without summary',url:'https://example.net/empty',summary:''}]}};
 root.render(<WebSearchReply message={source}/>);
};
window.showReplyState('first');`,
      },
      bundle: true,

      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
const out=${JSON.stringify(artifacts)};
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(2),30000);
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1000,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 const remoteRequests=[];win.webContents.session.webRequest.onBeforeRequest((details,cb)=>{const cancel=!details.url.startsWith('file://');if(cancel)remoteRequests.push(details.url);cb({cancel});});
 await win.loadFile(path.join(__dirname,'index.html'));
 const evaluate=code=>win.webContents.executeJavaScript(code);
 const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 for(let i=0;i<30;i++){await frame();if(await evaluate('!!document.querySelector(".live-main-reply")'))break;}
 const show=async name=>{await evaluate('window.showReplyState('+JSON.stringify(name)+')');await frame();};
 for(const theme of ['light','dark'])for(const width of [1000,390]){
  win.setSize(width,820);await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme));await show('first');
  assert.equal(await evaluate('document.querySelector(".live-main-reply").closest("details")===null'),true);
  assert.equal(await evaluate('document.querySelector(".live-main-reply").getBoundingClientRect().height>0'),true);
  assert.equal(await evaluate('document.querySelector(".workflow-trace > details").open'),false);
  assert.equal(await evaluate('document.querySelector(".thinking-ticker")'),null);
  assert.equal(await evaluate('document.querySelector(".turn-tail").parentElement.classList.contains("workflow-trace")'),true);
  assert.match(await evaluate('document.body.innerText'),/Synthetic reasoning: check the requested reply/);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'-live.png'),(await win.webContents.capturePage()).toPNG());
  await show('growing');assert.match(await evaluate('document.body.innerText'),/第二段正在继续/);
  assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),1);
  await show('summary');assert.match(await evaluate('document.body.innerText'),/你好，这是第一段回答/);assert.match(await evaluate('document.body.innerText'),/第二段正在继续/);assert.doesNotMatch(await evaluate('document.body.innerText'),/TRIMMED_TAIL_MARKER/);
  await show('notice');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),1);assert.match(await evaluate('document.body.innerText'),/你好，这是第一段回答/);
  await show('steering-empty');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),0);assert.doesNotMatch(await evaluate('document.body.innerText'),/OLD_STAGE_MARKER/);
  await show('steering');assert.match(await evaluate('document.body.innerText'),/当前补充后的回答/);assert.doesNotMatch(await evaluate('document.body.innerText'),/OLD_STAGE_MARKER/);
  await show('steering-summary');assert.match(await evaluate('document.body.innerText'),/当前补充后的回答/);assert.doesNotMatch(await evaluate('document.body.innerText'),/OLD_STAGE_MARKER|TRIMMED_TAIL_MARKER/);
  await show('steering-final');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),0);assert.equal(await evaluate('document.body.innerText.split("当前补充后的回答。").length-1'),1);
  await show('final-pending');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),1);
  await show('final-notice');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),0);assert.match(await evaluate('document.body.innerText'),/Synthetic final stop notice/);assert.equal(await evaluate('document.body.innerText.split("你好，这是第一段回答。").length-1'),1,'the saved answer remains below its stop notice');assert.doesNotMatch(await evaluate('document.body.innerText'),/TERMINAL_RAW_MARKER/);
  await show('final');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),0);
  assert.equal(await evaluate('document.body.innerText.split("你好，这是第一段回答。").length-1'),1);
  await show('planned-answer');assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),1,'the final answer step streams outside folded execution details');
  assert.equal(await evaluate('document.querySelector(".live-main-reply").closest("details")===null'),true);
  for(const name of ['failed','planning','build','relay','relay-summary']){await show(name);assert.equal(await evaluate('document.querySelectorAll(".live-main-reply").length'),0);assert.doesNotMatch(await evaluate('document.body.innerText'),/你好，这是第一段回答|PLANNING_JSON_MARKER|OLD_STAGE_MARKER/);}
  await evaluate('window.showSearchReading()');await frame();
  assert.equal(await evaluate('document.querySelector(".web-search-sources").open'),false);
  assert.doesNotMatch(await evaluate('document.body.innerText'),/For the next intake,/);
  assert.equal(await evaluate('window.fixtureCalls.length'),0);
  await fs.writeFile(path.join(out,'search-collapsed-'+theme+'-'+width+'.png'),(await win.capturePage()).toPNG());
  await evaluate('document.querySelector(".web-search-sources > summary").click()');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".web-search-source").length'),2);
  await evaluate('document.querySelector(".web-search-source-full > summary").click()');await frame();
  assert.match(await evaluate('document.body.innerText'),/For the next intake,/);
  assert.equal(await evaluate('document.querySelector(".web-search-source-full h3").textContent'),'Student account and student card guide');
  assert.equal(await evaluate('document.querySelectorAll(".web-search-source-full li").length'),3);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".web-search-source-preview")).display'),'none');
  assert.doesNotMatch(await evaluate('document.body.innerText'),/## Student|2026-10-24T/);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
  await fs.writeFile(path.join(out,'search-expanded-'+theme+'-'+width+'.png'),(await win.capturePage()).toPNG());
  await evaluate('document.querySelectorAll(".web-search-source")[1].scrollIntoView({block:"start"})');await frame();
  await fs.writeFile(path.join(out,'search-article-'+theme+'-'+width+'.png'),(await win.capturePage()).toPNG());
  for(let i=0;i<2;i++){await evaluate('document.querySelector(".swarm-plan-hide").click()');await frame();}
  assert.equal(await evaluate('document.querySelectorAll(".swarm-plan-item").length'),1);
  assert.match(await evaluate('document.querySelector(".swarm-plan").innerText'),/Active task stays visible/);
  await evaluate('document.querySelector(".swarm-plan-restore").click()');await frame();
  assert.equal(await evaluate('document.querySelectorAll(".swarm-plan-item").length'),3);
  await evaluate('document.querySelector(".web-search-progress button").click()');await frame();await frame();
  assert.match(await evaluate('document.body.innerText'),/Synthetic executor unavailable/);
  assert.equal(await evaluate('window.fixtureCalls.pop()'),'/api/conversations/chat/messages/source/search-answer');
  await evaluate('window.showFinishedTeam()');await frame();
  assert.equal(await evaluate('!!document.querySelector(".swarm-bar")'),false);
  assert.match(await evaluate('document.body.innerText'),/成员与任务/);
  await fs.writeFile(path.join(out,'finished-team-'+theme+'-'+width+'.png'),(await win.capturePage()).toPNG());
  await evaluate('document.querySelector(".swarm-details-toggle").click()');await frame();
  assert.equal(await evaluate('!!document.querySelector(".swarm-bar")'),true);
  await fs.writeFile(path.join(out,'expanded-team-'+theme+'-'+width+'.png'),(await win.capturePage()).toPNG());
  await evaluate('document.querySelector(".swarm-details-hide").click()');await frame();
  assert.equal(await evaluate('!!document.querySelector(".swarm-bar")'),false);
  await evaluate('window.showEvidence()');await frame();
  assert.equal(await evaluate('document.querySelector(".run-evidence").open'),false);
  await evaluate('document.querySelector(".run-evidence > summary").click()');await frame();
  assert.match(await evaluate('document.body.innerText'),/该检查已通过/);
  assert.match(await evaluate('document.body.innerText'),/0123456789ab/);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
  await fs.writeFile(path.join(out,'evidence-'+theme+'-'+width+'.png'),(await win.capturePage()).toPNG());
 }
 await evaluate('window.showSearchSafety()');await frame();win.setSize(360,820);await frame();
 assert.equal(await evaluate('document.querySelector(".web-search-sources").open'),false);
 await evaluate('document.querySelector(".web-search-sources > summary").click()');await frame();
 await evaluate('document.querySelector(".web-search-source-full > summary").click()');await frame();
 assert.equal(await evaluate('document.querySelectorAll(".web-search-reply img,.web-search-reply iframe,.web-search-reply script,[data-local-path],[data-relative-path]").length'),0);
 assert.equal(await evaluate('window.injected===undefined'),true);
 assert.equal(await evaluate('[...document.querySelectorAll(".web-search-reply a")].every(a=>/^https?:$/.test(new URL(a.href).protocol)&&!new URL(a.href).username&&!new URL(a.href).password)'),true);
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
 assert.equal(await evaluate('document.querySelectorAll(".web-search-source")[1].querySelectorAll(".web-search-source-article,.web-search-source-full").length'),0);
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".web-search-source-article")).fontSize'),'14px');
 assert.equal(await evaluate('getComputedStyle(document.querySelector(".web-search-source-article h3")).fontSize'),'15px');
 assert.equal(remoteRequests.length,0);
 await fs.writeFile(path.join(out,'search-safety-dark-360.png'),(await win.capturePage()).toPNG());
 console.log('PASS: 4 layouts, 16 sequential reply states, no network, 4 screenshots');
 }catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(deadline);win?.destroy();app.exit(process.exitCode||0);}});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        windowsHide: true,
        timeout: 35000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS: 4 layouts, 16 sequential reply states/);
  },
);
