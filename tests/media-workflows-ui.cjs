// Isolated, hidden synthetic renderer: no application server, account or model is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const electron = require('electron');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const prefix = 'pugport-media-workflow-ui-';
const inElectron = !!process.versions.electron;
const temporary = inElectron ? process.env.PUGPORT_WORKFLOW_UI_DIR : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
assert.ok(temporary);
const fullTemporary = path.resolve(temporary);
assert.equal(path.dirname(fullTemporary).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
assert.ok(path.basename(fullTemporary).startsWith(prefix));

if (!inElectron) {
  try {
    buildSync({
      stdin: {
        contents: `import React from 'react';
import './src/ui/media-workflows.css';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {MediaWorkflows} from './src/ui/MediaWorkflows';
import {ConversationWorkspace} from './src/ui/Workspace';
import {ExtensionsPage} from './src/ui/Extensions';
import './src/ui/studio.css';
import {builtinMediaWorkflows,mediaWorkflowSchema} from './src/shared/media-workflows';
window.fixtureErrors=[];window.fixtureCalls=[];window.fixtureStarts=[];window.fixtureEnsure=0;
window.addEventListener('error',event=>window.fixtureErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason)));
window.fetch=()=>{throw Error('Unexpected network request');};
let items=structuredClone(builtinMediaWorkflows);
const stamp='2026-10-07T12:00:00Z';
const project={id:'fixture-project',name:'Fixture project',path:'D:\\\\Synthetic media',scope:'project',createdAt:stamp,updatedAt:stamp};
const conversation={id:'fixture-conversation',projectId:project.id,title:'Fixture conversation',createdAt:stamp,updatedAt:stamp};
const state={app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'manual-only',defaultProjectPath:project.path,maxConcurrentRuns:1},targets:[],runtimes:[],approvals:[],plugins:[],refreshing:false,projects:[project],conversations:[conversation],workflows:[],runs:[],conversationMessages:[]};
const results=Array.from({length:5},(_,i)=>({a:'D:\\\\Synthetic media\\\\file-'+i+'.jpg',b:'D:\\\\Synthetic media\\\\copy-'+i+'.jpg',classification:'exact-bytes',deleteEligible:false,explanation:'Synthetic verified identical bytes',observedAt:stamp,stamps:[]}));
results[1]={...results[1],classification:'partial-overlap',explanation:'Synthetic short clip samples match within a longer clip',visual:{matches:12,samplesA:12,samplesB:12,matchedFractionA:1,matchedFractionB:1,spanA:[0,10],spanB:[30,40],offsetSeconds:30,positions:[],coverage:'partial-overlap',sampledContainment:{kind:'sampled-contained',contained:'a',container:'b',containedSpan:[0,10],containerSpan:[30,40],matchedSamples:12,plannedSamples:12,unverified:['between-sample-frames','audio','subtitles','quality']}}};
const report={id:'fixture-analysis',owner:{conversationId:conversation.id},status:'completed',phase:'done',progress:'Fixture analysis finished',folders:[project.path],createdAt:stamp,updatedAt:stamp,analysisOnly:true,counts:{files:10,fingerprinted:10,errors:0,results:5},issues:[],coverage:['Synthetic fixture scope only'],scope:{status:'complete',fileLimit:20000,listedFiles:10,visitedEntries:10,remainingDirectories:[],remainingDirectoryCount:0},limits:[],execution:{requestedEngine:'gemma',actualEngine:'gemma',modelId:'fixture-model',topK:8,videoSampleSeconds:10},summary:'Synthetic result summary',results,offset:0,nextOffset:null};
const snapshot=()=>({...report,...(window.fixtureAnalysisRunning?{status:'running',counts:{...report.counts,results:window.fixtureLiveCount??1},results:results.slice(0,window.fixtureLiveCount??1)}:{}),...(window.fixturePartial?{scope:{...report.scope,status:'partial',remainingDirectoryCount:1},limits:[{code:'file-limit',limit:20000,message:'Synthetic enumeration stopped at the file limit; unlisted files remain.'}]}:{})});
const api=async(path,body,method)=>{
 window.fixtureCalls.push({path,body,method});
 if(path==='/api/media-workflows')return {items:structuredClone(items)};
 if(path==='/api/media-workflows/save'){
  const item={id:'fixture-custom',builtin:false,workflow:mediaWorkflowSchema.parse(body.workflow),source:'本机创建',updatedAt:'2026-10-07T00:00:00Z'};
  items=[...items,item];return {item};
 }
 if(path==='/api/media-analysis'){await new Promise(resolve=>setTimeout(resolve,50));return {id:'fixture-analysis'};}
 if(path.startsWith('/api/media-analysis?'))return {jobs:[{...snapshot(),results:[]}]};
 if(path.startsWith('/api/media-analysis/')){const data=snapshot();if(window.fixtureDeferDetail)return await new Promise(resolve=>window.fixtureResolveDetail=()=>resolve(data));return data;}
 if(path==='/api/conversations')return conversation;
 if(path==='/api/extensions')return {items:[],catalog:[]};
 if(path==='/api/app-info')return {tools:{voice:false,images:{model:false},memory:{model:false},gemma:{model:false},markitdown:false,everything:'missing'}};
 if(path==='/api/tool-installations')return {installations:[]};
 if(path==='/api/reveal')return {ok:true};
 throw Error('Unexpected fixture API '+path);
};
const root=createRoot(document.getElementById('fixture'));
window.fixtureMode='recipes';window.currentConversation=undefined;
window.renderFixture=()=>flushSync(()=>root.render(window.fixtureMode==='workspace'?<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={state} api={api} project={project} conversation={window.currentConversation} notify={()=>{}} onConversation={created=>{window.currentConversation=created;window.renderFixture();}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}}/></main>:window.fixtureMode==='extensions'?<ExtensionsPage section="components" api={api} notify={()=>{}}/>:<MediaWorkflows key={window.fixtureRecipeKey} api={api} notify={()=>{}} conversationId={window.fixtureOwner} defaultFolder={project.path} ensureConversation={async()=>{window.fixtureEnsure++;return conversation.id;}} onStarted={id=>window.fixtureStarts.push(id)}/>));
window.renderFixture();`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      platform: 'browser',
      outfile: path.join(fullTemporary, 'fixture.js'),
    });
    fs.writeFileSync(
      path.join(fullTemporary, 'index.html'),
      '<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0;min-width:0;padding:16px;background:#101012;color:#eee;font:14px sans-serif}#fixture{min-width:0}</style><body><main id="fixture"></main><script src="fixture.js"></script></body></html>',
    );
    const env = { ...process.env, PUGPORT_WORKFLOW_UI_DIR: fullTemporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      timeout: 45_000,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    const actual = fs.realpathSync(fullTemporary);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith(prefix));
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
} else {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', path.join(fullTemporary, 'profile'));
  app.disableHardwareAcceleration();
  let window;
  const network = [];
  const evaluate = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      console.error('Failed fixture evaluation:', code);
      throw error;
    });
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  async function click(text) {
    const point = await evaluate(
      `(()=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)});if(!button)throw Error('Missing button');button.scrollIntoView({block:'center'});const box=button.getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()`,
    );
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await frame();
  }
  async function value(selector, text) {
    await evaluate(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});const type=input.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;const setter=Object.getOwnPropertyDescriptor(type.prototype,'value').set;setter.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await frame();
  }
  void app.whenReady().then(async () => {
    try {
      window = new BrowserWindow({
        show: false,
        width: 792,
        height: 1100,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url.startsWith('file://') || details.url.startsWith('data:');
        if (!allowed) network.push(details.url);
        callback({ cancel: !allowed });
      });
      await window.loadFile(path.join(fullTemporary, 'index.html'));
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('.media-workflows-select option').length"), 2);
      const screenshots = path.join(root, 'reports', 'media-workflows-ui');
      fs.mkdirSync(screenshots, { recursive: true });
      for (const width of [760, 360, 280]) {
        window.setContentSize(width + 32, 1100);
        await frame();
        assert.ok(
          await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'),
          `${width}: no horizontal overflow`,
        );
        if (width === 760 || width === 280)
          fs.writeFileSync(
            path.join(screenshots, `width-${width}.png`),
            (await window.webContents.capturePage()).toPNG(),
          );
      }
      await click('另存副本');
      assert.ok(await evaluate("!!document.querySelector('.media-workflow-editor')"));
      assert.ok(
        await evaluate('!document.querySelector(\'.media-workflow-fields input[min="5"]\')'),
        'fast mode does not advertise a dense-index interval',
      );
      assert.ok(
        await evaluate(
          "![...document.querySelectorAll('.media-workflow-fields label')].some(label=>label.textContent.includes('候选引擎'))",
        ),
        'the retired engine selector is absent',
      );
      assert.equal(
        await evaluate('document.querySelector(\'.media-workflow-fields input[min="1"][max="20"]\').disabled'),
        false,
        'adaptive mode allows editing topK',
      );
      await evaluate(
        "(()=>{const select=document.querySelector('select[aria-label=\"检索方式\"]');select.value='full-index';select.dispatchEvent(new Event('change',{bubbles:true}));})()",
      );
      await frame();
      assert.ok(
        await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'),
        'editor fits narrow view',
      );
      assert.equal(
        await evaluate('document.querySelector(\'.media-workflow-fields input[min="1"][max="20"]\').disabled'),
        true,
        'full-index mode disables topK',
      );
      fs.writeFileSync(
        path.join(screenshots, 'editor-full-index.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await evaluate(
        "(()=>{const select=document.querySelector('select[aria-label=\"检索方式\"]');select.value='adaptive';select.dispatchEvent(new Event('change',{bubbles:true}));})()",
      );
      await frame();
      assert.equal(
        await evaluate('document.querySelector(\'.media-workflow-fields input[min="1"][max="20"]\').disabled'),
        false,
      );
      fs.writeFileSync(path.join(screenshots, 'editor-adaptive.png'), (await window.webContents.capturePage()).toPNG());
      await value('.media-workflow-editor > label input', '我的快速流程');
      await value('.media-workflow-fields input[type="number"][min="1"][max="20"]', '11');
      await click('保存流程');
      assert.equal(await evaluate("document.querySelector('.media-workflows-select select').value"), 'fixture-custom');
      const saved = await evaluate(
        "window.fixtureCalls.find(call=>call.path==='/api/media-workflows/save').body.workflow",
      );
      assert.equal(saved.name, '我的快速流程');
      assert.equal(saved.parameters.topK, 11);
      assert.equal(saved.parameters.videoSampleSeconds, 30);
      assert.equal(saved.folders, undefined);
      await click('开始本地分析');
      for (let attempt = 0; attempt < 10 && !(await evaluate('window.fixtureStarts.length')); attempt++) await frame();
      const started = await evaluate("window.fixtureCalls.filter(call=>call.path==='/api/media-analysis')");
      assert.equal(started.length, 1);
      assert.equal(started[0].body.workflowId, 'fixture-custom');
      assert.equal(started[0].body.conversationId, 'fixture-conversation');
      assert.equal(started[0].body.folders.length, 1);
      assert.ok(started[0].body.folders[0].includes('Synthetic media'));
      assert.equal(await evaluate('window.fixtureEnsure'), 1);
      assert.deepEqual(await evaluate('window.fixtureStarts'), ['fixture-analysis']);
      await click('查看证据');
      assert.equal(await evaluate("document.querySelectorAll('.media-workflow-evidence').length"), 3);
      assert.ok(
        await evaluate(
          "document.querySelectorAll('.media-workflow-evidence')[1].textContent.includes('短片整段抽样匹配')",
        ),
      );
      assert.ok(
        await evaluate(
          "document.querySelectorAll('.media-workflow-evidence')[1].textContent.includes('第一份短片 12/12')",
        ),
      );
      assert.ok(
        await evaluate("document.querySelectorAll('.media-workflow-evidence')[1].textContent.includes('尚未核验')"),
      );
      assert.ok(
        await evaluate("document.querySelector('.media-workflow-results').textContent.includes('EmbeddingGemma')"),
      );
      assert.ok(await evaluate("document.querySelector('.media-workflow-results').textContent.includes('10 秒')"));
      assert.equal(await evaluate("!!document.querySelector('.media-workflow-warning')"), false);
      await evaluate('window.fixturePartial=true');
      await click('刷新记录');
      await click('刷新结果');
      assert.ok(
        await evaluate("document.querySelector('.media-workflow-job strong').textContent.includes('目录未扫描完整')"),
      );
      assert.ok(
        await evaluate(
          "document.querySelector('.media-workflow-warning').textContent.includes('unlisted files remain')",
        ),
      );
      assert.ok(
        await evaluate("!document.querySelector('.media-workflow-results details').open"),
        'scope warning is visible even when report details are collapsed',
      );
      await evaluate('window.fixturePartial=false');
      await click('刷新记录');
      await click('刷新结果');
      await click('显示本页全部 5 项');
      assert.equal(await evaluate("document.querySelectorAll('.media-workflow-evidence').length"), 5);
      assert.ok(
        await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'),
        'evidence fits narrow view',
      );
      await evaluate("document.querySelector('.media-workflow-path').click()");
      await frame();
      assert.equal(await evaluate("window.fixtureCalls.filter(call=>call.path==='/api/reveal').length"), 1);
      await evaluate(
        "window.fixtureAnalysisRunning=true;window.fixtureOwner='fixture-conversation';window.fixtureRecipeKey='live-results';window.renderFixture()",
      );
      await frame();
      await click('查看证据');
      assert.equal(await evaluate("document.querySelectorAll('.media-workflow-evidence').length"), 1);
      await evaluate('window.fixtureLiveCount=4');
      await click('刷新记录');
      await frame();
      await click('显示本页全部 4 项');
      assert.equal(await evaluate("document.querySelectorAll('.media-workflow-evidence').length"), 4);
      const detailCallsBeforeCompletion = await evaluate(
        "window.fixtureCalls.filter(call=>call.path.startsWith('/api/media-analysis/')).length",
      );
      await evaluate('window.fixtureDeferDetail=true');
      await click('刷新结果');
      await evaluate('window.fixtureAnalysisRunning=false');
      await evaluate('new Promise(resolve=>setTimeout(resolve,2200))');
      assert.ok(
        await evaluate("document.querySelector('.media-workflow-results h4').textContent.includes('本地分析完成')"),
      );
      await evaluate('window.fixtureDeferDetail=false;window.fixtureResolveDetail()');
      await frame();
      await frame();
      assert.equal(
        await evaluate("document.querySelectorAll('.media-workflow-evidence').length"),
        5,
        'completion during a pending detail request refreshes final evidence and preserves the expanded page',
      );
      assert.equal(
        await evaluate("window.fixtureCalls.filter(call=>call.path.startsWith('/api/media-analysis/')).length"),
        detailCallsBeforeCompletion + 2,
        'the older request settles and only one reconciliation request follows',
      );
      window.setContentSize(1000, 1100);
      await evaluate("window.fixtureMode='workspace';window.fixtureCalls=[];window.renderFixture()");
      await frame();
      await value('#conversation-input', 'Keep this unsent draft while starting local analysis');
      await evaluate('document.querySelector(\'[aria-label="添加和更多"]\').click()');
      await frame();
      if (!(await evaluate("!!document.querySelector('.composer-menu')"))) {
        await evaluate('document.querySelector(\'[aria-label="添加和更多"]\').click()');
        await frame();
      }
      await click('本地流程');
      assert.ok(await evaluate("document.querySelector('.media-workflow-dialog').open"));
      assert.ok(
        await evaluate("document.querySelector('.media-workflow-dialog').contains(document.activeElement)"),
        'dialog receives focus',
      );
      const box = await evaluate(
        "(()=>{const r=document.querySelector('.media-workflow-dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight}})()",
      );
      assert.ok(
        box.left >= 0 && box.right <= box.w && box.top >= 0 && box.bottom <= box.h,
        'dialog is bounded by viewport',
      );
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await frame();
      assert.equal(await evaluate("!!document.querySelector('.media-workflow-dialog')"), false);
      if (!(await evaluate("!!document.querySelector('.composer-menu')"))) {
        await evaluate('document.querySelector(\'[aria-label="添加和更多"]\').click()');
        await frame();
      }
      await click('本地流程');
      await click('开始本地分析');
      for (
        let attempt = 0;
        attempt < 10 && (await evaluate("!!document.querySelector('.media-workflow-dialog')"));
        attempt++
      )
        await frame();
      assert.equal(await evaluate("window.fixtureCalls.filter(call=>call.path==='/api/conversations').length"), 1);
      assert.equal(await evaluate("window.fixtureCalls.filter(call=>call.path==='/api/media-analysis').length"), 1);
      assert.equal(
        await evaluate("!!document.querySelector('.media-workflow-dialog')"),
        false,
        'accepted start closes dialog',
      );
      assert.equal(
        await evaluate("document.querySelector('#conversation-input').value"),
        'Keep this unsent draft while starting local analysis',
        'creating the analysis conversation preserves the unsent composer draft',
      );
      if (!(await evaluate("!!document.querySelector('.composer-menu')"))) {
        await evaluate('document.querySelector(\'[aria-label="添加和更多"]\').click()');
        await frame();
      }
      await click('本地流程');
      await evaluate(
        "window.currentConversation={...window.currentConversation,id:'different-conversation'};window.renderFixture()",
      );
      await frame();
      assert.equal(
        await evaluate("!!document.querySelector('.media-workflow-dialog')"),
        false,
        'switching conversation closes old scope',
      );
      await evaluate("window.fixtureMode='extensions';window.renderFixture()");
      await frame();
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='管理本地流程').click()");
      await frame();
      assert.ok(await evaluate("!!document.querySelector('.media-workflow-dialog .media-workflows')"));
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='开始本地分析').disabled",
        ),
        true,
        'management works without conversation but cannot run ownerless analysis',
      );
      assert.deepEqual(await evaluate('window.fixtureErrors'), []);
      assert.deepEqual(network, []);
      fs.writeFileSync(
        path.join(screenshots, 'smoke.txt'),
        'PASS: 760/360/280px have no horizontal overflow; real clicks copy/edit/save and start; evidence defaults to 3 rows and expands, completion during a pending detail request refreshes once and preserves expansion, file paths reveal via existing API; composer More entry opens focused bounded dialog, Escape closes it, new conversation is created once without losing the unsent draft, successful start closes dialog and switching conversation isolates scope; Settings local workflows dialog works without a conversation. No application backend, account or model was used.\n',
      );
      console.log('PASS media workflow UI: narrow layout, copy/edit/save parameters, conversation-bound start');
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      window?.destroy();
      app.exit(process.exitCode ?? 0);
    }
  });
}
