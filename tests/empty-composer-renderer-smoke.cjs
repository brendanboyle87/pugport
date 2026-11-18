// Hidden Workspace renderer with in-memory API mocks; never opens the actual desktop app or native CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-empty-enter-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      const sheets = await Promise.all(
        ['studio.css', 'ConversationQueue.css', 'SideChatPanel.css'].map((name) =>
          fs.readFile(path.join(root, 'src/ui', name), 'utf8'),
        ),
      );
      await fs.writeFile(path.join(fixture, 'style.css'), sheets.join('\n'));
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationWorkspace } from './src/ui/Workspace';
const stamp='2026-09-30T12:00:00.000Z';
const conversation=id=>({id,projectId:'project',title:'Fixture '+id,createdAt:stamp,updatedAt:stamp});
const queued=(id,order)=>({id,conversationId:'main',projectId:'project',userMessageId:'message-'+id,input:{content:'Fixture '+id,mode:'build',permissionMode:'workspace-write',executionPolicy:'cli-first'},status:'queued',phase:'queue',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:id==='first'?'2026-09-30T13:00:00.000Z':stamp,updatedAt:stamp,queueOrder:Date.parse(stamp)+order});
window.fixture={current:'main',state:{app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'manual-only',defaultProjectPath:'C:/Fixture',maxConcurrentRuns:1},targets:[],runtimes:[],approvals:[],plugins:[],refreshing:false,projects:[{id:'project',name:'Fixture',scope:'chat',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp}],conversations:[conversation('main'),conversation('other')],workflows:[{...queued('active',-1),status:'running',phase:'execute',runIds:['run']}],runs:[{id:'run',workflowId:'active',stepId:'step',prompt:'Fixture',projectPath:'C:/Fixture',kind:'general',status:'running',steerAvailable:true,steeringStatus:{state:'ready'},toolApprovalMode:'auto',route:{runtimeId:'fixture',model:'fixture',kind:'general',reasons:[],warnings:[]},startedAt:stamp,output:'Fixture ongoing answer',events:[]}],conversationMessages:[]}};
window.calls=[];window.notices=[];
const root=createRoot(document.getElementById('root'));
const api=async(path,body,method)=>{
 window.calls.push({path,body,method});const state=window.fixture.state;
 if(path.endsWith('/queueing')) {
  if(window.queueingFailure){window.queueingFailure=false;throw new Error('Fixture: queue preference rejected');}
  state.conversations.find(item=>item.id===path.split('/')[3]).queueingEnabled=body.enabled;
  window.renderFixture();return {ok:true};
 }
 if(path.endsWith('/steer')) {
  if(window.holdSteer){window.holdSteer=false;await new Promise(resolve=>window.releaseSteer=resolve);}
  const item=state.workflows.find(item=>item.id===path.split('/')[3]);
  if(item.input.runtimeId==='incompatible')throw new Error('Fixture: first message has incompatible execution settings; retained in queue');
  item.status='cancelled';item.followUp={workflowId:'active',kind:'message',at:stamp};
  state.conversationMessages.find(message=>message.workflowId===item.id).steering={runId:'run',status:'accepted'};
  window.renderFixture();return {steered:true};
 }
 if(path.endsWith('/queue/order')) {
  if(window.holdOrder){window.holdOrder=false;await new Promise(resolve=>window.releaseOrder=resolve);}
  body.workflowIds.forEach((id,index)=>state.workflows.find(item=>item.id===id).queueOrder=Date.parse(stamp)+index);
  window.renderFixture();return {ok:true};
 }
 if(path.endsWith('/attachments'))return {id:'attachment',conversationId:path.split('/')[3],name:'fixture.txt',mimeType:'text/plain',kind:'file',size:7,createdAt:stamp};
 if(path.endsWith('/messages')) {
  const message={id:'sent-'+window.calls.length,conversationId:path.split('/')[3],role:'user',content:body.content,createdAt:stamp};state.conversationMessages.push(message);window.renderFixture();return {message};
 }
 if(method==='GET')return {messages:state.conversationMessages.filter(message=>message.conversationId===path.split('/')[3])};
 throw new Error('Unexpected isolated fixture API');
};
window.renderFixture=()=>flushSync(()=>root.render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={{...window.fixture.state,workflows:[...window.fixture.state.workflows],runs:[...window.fixture.state.runs],conversationMessages:[...window.fixture.state.conversationMessages]}} api={api} project={window.fixture.state.projects[0]} conversation={window.fixture.state.conversations.find(item=>item.id===window.fixture.current)} notify={notice=>window.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>));
window.resetQueue=(ready=true)=>{const state=window.fixture.state;state.workflows=[state.workflows.find(item=>item.id==='active'),queued('second',1),queued('first',0)];state.runs[0].steerAvailable=ready;state.runs[0].steeringStatus={state:ready?'ready':'starting'};state.conversationMessages=['first','second'].map(id=>({id:'message-'+id,workflowId:id,conversationId:'main',role:'user',content:'Fixture '+id,createdAt:stamp}));window.renderFixture();};
window.switchMain=id=>{window.fixture.current=id;window.renderFixture();};
window.resetQueue();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, COMBORUNNER_EMPTY_ENTER_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 30000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-empty-enter-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_EMPTY_ENTER_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-empty-enter-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) =>
    win.webContents.executeJavaScript(source).catch((error) => {
      console.error('Failed fixture evaluation:', source.slice(0, 200));
      throw error;
    });
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const fill = async (selector, value) => {
    await evaluate(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await frame();
  };
  const enter = async (options = {}) => {
    await evaluate(
      `document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...${JSON.stringify(options)}}))`,
    );
    await frame();
  };
  const steers = () => evaluate("window.calls.filter(call=>call.path.endsWith('/steer')).map(call=>call.path)");
  const click = async (selector, text) => {
    await evaluate(
      `(()=>{const button=[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing fixture button');button.click();})()`,
    );
    await frame();
  };
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 800,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      await frame();
      assert.equal(
        await evaluate(`document.querySelectorAll('.voice-button, .voice-panel, [aria-label="语音输入"]').length`),
        0,
        'the composer has no dictation controls',
      );
      await fs.mkdir(path.join(root, 'dist'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'dist/remove-voice-composer.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.conversation-queue-message')].map(item=>item.dataset.workflowId)",
        ),
        ['first', 'second'],
      );
      assert.match(await evaluate("document.querySelector('.send-button').title"), /插入首条排队消息 · Enter/);
      assert.equal(await evaluate("Boolean(document.querySelector('.composer-caption'))"), false);
      await enter({ shiftKey: true });
      await enter({ keyCode: 229 });
      await enter({ isComposing: true });
      await enter({ repeat: true });
      assert.deepEqual(await steers(), []);
      await evaluate(
        `(()=>{const input=document.querySelector('#conversation-input');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
      );
      await frame();
      assert.deepEqual(await steers(), []);
      await evaluate(
        "document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}))",
      );
      await fill('#conversation-input', '  \n');
      await evaluate('window.holdSteer=true');
      await enter();
      await enter();
      assert.deepEqual(await steers(), ['/api/workflows/first/steer']);
      assert.ok(
        await evaluate(
          "[...document.querySelectorAll('.conversation-queue-actions button')].every(button=>button.disabled)",
        ),
      );
      await evaluate("window.switchMain('other')");
      await frame();
      await fill('#conversation-input', 'Other conversation draft');
      assert.equal(
        await evaluate("document.querySelector('.send-button').disabled"),
        false,
        'Held ACK in main must not block other conversation',
      );
      await evaluate('window.releaseSteer()');
      await frame();
      assert.equal(await evaluate("document.querySelector('#conversation-input').value"), 'Other conversation draft');
      await evaluate("window.switchMain('main')");
      await frame();
      assert.equal(await evaluate("window.fixture.state.workflows.find(item=>item.id==='active').status"), 'running');
      assert.equal(await evaluate('window.fixture.state.runs.length'), 1);
      assert.equal(await evaluate("window.calls.filter(call=>call.path.endsWith('/messages')).length"), 0);
      assert.ok(
        await evaluate(
          "window.fixture.state.conversationMessages.some(message=>message.workflowId==='first'&&message.steering?.status==='accepted')",
        ),
      );

      await evaluate('window.resetQueue()');
      await frame();
      await evaluate("window.fixture.state.workflows.find(item=>item.id==='first').input.runtimeId='incompatible'");
      await enter();
      assert.deepEqual(await steers(), ['/api/workflows/first/steer', '/api/workflows/first/steer']);
      assert.match(await evaluate('window.notices.at(-1).message'), /incompatible/);
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.conversation-queue-message')].map(item=>item.dataset.workflowId)",
        ),
        ['first', 'second'],
      );
      await evaluate('window.resetQueue(false)');
      await frame();
      await enter();
      assert.equal((await steers()).length, 2);
      await evaluate(
        "window.resetQueue();window.fixture.state.workflows=window.fixture.state.workflows.filter(item=>item.id==='active');window.renderFixture()",
      );
      await frame();
      await enter();
      assert.equal((await steers()).length, 2);

      assert.equal(await evaluate("document.querySelector('.conversation-queue')"), null);
      await evaluate('document.querySelector(\'[aria-label="调度选项"]\').click()');
      await frame();
      await click('.composer-chips', '高级');
      assert.equal(await evaluate('document.querySelector(\'[aria-label="消息排队开关"]\')'), null);
      await evaluate('document.querySelector(\'[aria-label="调度选项"]\').click()');
      await evaluate(
        'window.fixture.state.conversations.find(item=>item.id==="main").queueingEnabled=false;window.renderFixture()',
      );
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('.conversation-queue-hint button').length"), 1);
      await evaluate('window.queueingFailure=true');
      await click('.conversation-queue-hint', '开启排队');
      assert.match(await evaluate('window.notices.at(-1).message'), /queue preference rejected/);
      assert.equal(
        await evaluate('window.fixture.state.conversations.find(item=>item.id==="main").queueingEnabled'),
        false,
      );
      await click('.conversation-queue-hint', '开启排队');
      assert.equal(
        await evaluate('window.fixture.state.conversations.find(item=>item.id==="main").queueingEnabled'),
        true,
      );
      assert.equal(await evaluate("document.querySelector('.conversation-queue')"), null);

      await evaluate('window.resetQueue();window.holdOrder=true');
      await frame();
      await evaluate('document.querySelector(\'[data-workflow-id="first"] [aria-label="更多操作"]\').click()');
      await frame();
      await click('.context-menu', '下移');
      assert.equal(await evaluate("document.querySelector('.context-menu')"), null);
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.conversation-queue-message')].map(item=>item.dataset.workflowId)",
        ),
        ['second', 'first'],
      );
      await enter();
      assert.equal((await steers()).length, 2, 'Reorder in flight blocks empty Enter');
      await evaluate('window.releaseOrder()');
      await frame();
      await enter();
      assert.equal(
        (await steers()).at(-1),
        '/api/workflows/second/steer',
        'After durable reorder ACK, Enter uses displayed first',
      );

      await evaluate('window.resetQueue()');
      await frame();
      await evaluate('document.querySelector(\'[aria-label="添加和更多"]\').click()');
      await frame();
      await evaluate(
        `[...document.querySelectorAll('.composer-menu button')].find(item=>item.textContent.includes('时间安排')).click()`,
      );
      await frame();
      await click('.schedule-options', '高优先级');
      await enter();
      assert.equal((await steers()).length, 3, 'Actual scheduling intent cannot steer stale queued text');
      await click('.schedule-options', '高优先级');
      await evaluate('document.querySelector(\'[aria-label="调度选项"]\').click()');
      await frame();
      await evaluate(
        `[...document.querySelectorAll('.route-popover button')].find(button=>button.textContent==='高级' && button.getAttribute('aria-expanded')!=='true')?.click()`,
      );
      await frame();
      await fill('input[placeholder="完成后运行，如 npm test"]', 'fixture-check');
      await enter();
      assert.equal((await steers()).length, 3, 'Verifier intent cannot steer stale queued text');
      await fill('input[placeholder="完成后运行，如 npm test"]', '');
      await fill('#conversation-input', 'Normal nonempty fixture');
      await enter();
      assert.equal(await evaluate("window.calls.filter(call=>call.path.endsWith('/messages')).length"), 1);
      assert.equal((await steers()).length, 3);

      await evaluate(
        `(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'fixture.txt',{type:'text/plain'}));const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await frame();
      await enter();
      assert.equal(
        await evaluate("window.calls.filter(call=>call.path.endsWith('/attachments')).length"),
        1,
        'Attachment-only draft keeps normal upload/send behavior',
      );
      assert.equal(await evaluate("window.calls.filter(call=>call.path.endsWith('/messages')).length"), 2);
      assert.equal((await steers()).length, 3);
      assert.equal(
        await evaluate(
          "window.calls.filter(call=>call.path==='/api/conversations'||call.path.includes('/runs')||call.path.includes('/cancel')).length",
        ),
        0,
      );
      console.log(
        'PASS empty composer Enter: first durable item only, IME/Shift guards, one request until ACK, scope isolation, incompatible retention, hidden empty queue and preference retry, no-op readiness, reorder ACK, schedule/verifier guards and normal attachment/message send',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
