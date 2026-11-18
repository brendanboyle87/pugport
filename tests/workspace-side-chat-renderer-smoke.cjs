// Run with .runtime/node.exe tests/workspace-side-chat-renderer-smoke.cjs. Hidden renderer; in-memory APIs only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-side-mount-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      // Every stylesheet the app loads, in its order: layout wrappers such as the Mod workspace body live in them.
      const names = (await fs.readFile(path.join(root, 'src/ui/main.tsx'), 'utf8'))
        .split('\n')
        .map((line) => /^import '\.\/([^']+\.css)';/.exec(line)?.[1])
        .filter(Boolean);
      const sheets = await Promise.all(names.map((name) => fs.readFile(path.join(root, 'src/ui', name), 'utf8')));
      await fs.writeFile(path.join(fixture, 'style.css'), sheets.join('\n'));
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationWorkspace } from './src/ui/Workspace';
const stamp = '2026-09-30T12:00:00.000Z';
const conversation = id => ({id,projectId:'project',title:'Fixture ' + id,createdAt:stamp,updatedAt:stamp});
const sourceText = 'Fixture selected sentence. More fixture context.';
window.fixture = {
 current:'main',
 state:{
  app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},
  settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',unknownQuotaPolicy:'manual-only',defaultProjectPath:'C:/Fixture',maxConcurrentRuns:1},
  targets:[{id:'grok-b',label:'Fixture Grok B',provider:'grok',enabled:true,transport:'cli',config:{}}],runtimes:[],approvals:[],plugins:[],refreshing:false,
  projects:[{id:'project',name:'Fixture project',path:'C:/Fixture',scope:'chat',createdAt:stamp,updatedAt:stamp}],
  conversations:[conversation('main'),conversation('other')],
  workflows:[{id:'active',conversationId:'main',projectId:'project',userMessageId:'main-task',input:{content:'Fixture active task',mode:'build',permissionMode:'workspace-write',executionPolicy:'cli-first'},status:'running',phase:'execute',plan:[],runIds:['run'],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp}],
  runs:[{id:'run',workflowId:'active',stepId:'step',prompt:'Fixture task',projectPath:'C:/Fixture',kind:'general',status:'running',route:{runtimeId:'grok-b',model:'fixture-model',effort:'high',kind:'general',reasons:[],warnings:[]},toolApprovalMode:'auto',steerAvailable:true,startedAt:stamp,output:'Fixture ongoing answer',events:[]}],
  conversationMessages:[
   ...Array.from({length:16},(_,index) => ({id:'history-' + index,conversationId:'main',role:'assistant',content:'Fixture previous answer ' + index + '.\\n'.repeat(2) + 'More fixture text.',createdAt:'2026-09-30T11:' + String(index).padStart(2,'0') + ':00.000Z'})),
   {id:'main-task',conversationId:'main',role:'user',workflowId:'active',content:'Fixture active task',createdAt:stamp},
   {id:'source',conversationId:'main',role:'assistant',content:sourceText,createdAt:'2026-09-30T12:02:00.000Z'}
  ]
 }
};
window.calls=[];window.notices=[];
const root=createRoot(document.getElementById('root'));
let api=async(path,body,method) => {
 window.calls.push({path,body,method});
 if(window.failure && path.endsWith('/messages')) {const failure=window.failure;window.failure=undefined;throw new Error(failure);}
 const state=window.fixture.state;
 if(path.endsWith('/side-chat')) {
  const id='side-' + (state.conversations.filter(value => value.sideChat).length + 1);
  const created={...conversation(id),sideChat:{parentConversationId:path.split('/')[3],anchorMessageId:body.anchorMessageId,context:'Bounded source fixture context',selection:structuredClone(body.selection)}};
  state.conversations.push(created);window.renderFixture();return created;
 }
 if(path.endsWith('/messages')) {
  const conversationId=path.split('/')[3];
  const message={id:'sent-' + state.conversationMessages.length,conversationId,role:'user',content:body.content,createdAt:new Date().toISOString()};
  state.conversationMessages.push(message,{id:'answer-' + message.id,conversationId,role:'assistant',content:'Fixture side reply',createdAt:new Date().toISOString()});
  window.renderFixture();return {message};
 }
 if(method==='GET') return {conversation:state.conversations.find(value => value.id===path.split('/')[3]),messages:state.conversationMessages.filter(message => message.conversationId===path.split('/')[3])};
 throw new Error('Unexpected fixture API call: ' + path);
};
window.renderFixture=() => flushSync(() => root.render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace
 state={{...window.fixture.state}} api={api} project={window.fixture.state.projects[0]}
 conversation={window.fixture.state.conversations.find(value => value.id===window.fixture.current)}
 notify={notice => window.notices.push(notice)} onConversation={() => {}} onAddProject={() => {}} onMemory={() => {}} onInspect={() => {}}
/></main>));
window.switchMain=id => {window.fixture.current=id;window.renderFixture();};
window.remountFixture=() => {flushSync(() => root.render(null));const previous=api;api=(...args) => previous(...args);window.renderFixture();};
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, COMBORUNNER_SIDE_MOUNT_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      const timeout = setTimeout(() => child.kill(), 90000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-side-mount-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_SIDE_MOUNT_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-side-mount-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', (event) => event.preventDefault());
  let win;
  const evaluate = (source) =>
    win.webContents.executeJavaScript(source).catch((error) => {
      console.error('Failed isolated fixture evaluation:', source.slice(0, 300));
      throw error;
    });
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const setViewport = async (width, height) => {
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      viewSize: { width, height },
      scale: 1,
    });
    await frame();
    assert.deepEqual(await evaluate('({width: innerWidth, height: innerHeight})'), { width, height });
  };
  const fill = async (selector, value) => {
    await evaluate(
      `(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await frame();
  };
  const click = async (selector, text) => {
    await evaluate(
      `(() => {const button=[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(value => value.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing fixture button');button.click();})()`,
    );
    await frame();
  };
  const selectSource = async () => {
    await evaluate(`(() => {
      const source=document.querySelector('[data-message-id="source"] .message-text');
      source.scrollIntoView({block:'center'});
      const walker=document.createTreeWalker(source,NodeFilter.SHOW_TEXT);
      const text=walker.nextNode();const range=document.createRange();range.setStart(text,0);range.setEnd(text,'Fixture selected sentence.'.length);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      source.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    })()`);
    await frame();
  };
  const close = async () => {
    await evaluate('document.querySelector(\'[aria-label="关闭侧聊"]\').click()');
    await frame();
  };
  const enter = async () => {
    await evaluate(
      "document.querySelector('.side-chat-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
    );
    await frame();
  };
  const geometry = () =>
    evaluate(`(() => {
    const bounds=selector => {const element=document.querySelector(selector);if(!element)return null;const rect=element.getBoundingClientRect();return {x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height};};
    const scroll=document.querySelector('.conversation-scroll');
    return {viewport:{width:innerWidth,height:innerHeight},wrapper:bounds('.conversation-with-side-chat'),main:bounds('.conversation-workspace'),composer:bounds('.conversation-composer'),side:bounds('.side-chat-panel'),slotHidden:document.querySelector('.side-chat-slot')?.hidden,scroll:{height:scroll.clientHeight,total:scroll.scrollHeight}};
  })()`);
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.setFrameRate(240);
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      await setViewport(1280, 900);
      const initial = await geometry();
      assert.ok(
        initial.scroll.height > 100 && initial.scroll.total > initial.scroll.height,
        'Main transcript must remain bounded and scrollable',
      );
      assert.ok(initial.composer.bottom <= initial.viewport.height + 1, 'Composer must remain in the viewport');
      await fill('#conversation-input', 'Existing main draft.');
      await selectSource();
      assert.ok(await evaluate("!!document.querySelector('[data-selection-actions]')"));
      await click('[data-selection-actions]', '引用');
      await click('.quote-editor', '添加引用');
      const mainDraft = await evaluate("document.querySelector('#conversation-input').value");
      assert.equal(mainDraft, 'Existing main draft.');
      assert.match(await evaluate("document.querySelector('.quote-chips').textContent"), /Fixture selected sentence/);
      assert.equal(
        await evaluate("window.calls.filter(call => call.path.endsWith('/messages')).length"),
        0,
        'Quoting must not submit a task',
      );

      await selectSource();
      await click('[data-selection-actions]', '侧聊');
      assert.equal(await evaluate("document.querySelector('.side-chat-context')"), null);
      assert.equal(
        await evaluate("document.querySelector('.side-chat-composer').textContent.includes('只读：只回答')"),
        false,
      );
      const launch = await evaluate("window.calls.find(call => call.path.endsWith('/side-chat'))");
      assert.equal(launch.path, '/api/conversations/main/side-chat');
      assert.equal(launch.body.anchorMessageId, 'source');
      assert.equal(launch.body.quote, 'Fixture selected sentence.');
      assert.deepEqual(launch.body.selection, {
        runtimeId: 'grok-b',
        model: 'fixture-model',
        effort: 'high',
        executionPolicy: 'cli-first',
      });
      const open = await geometry();
      assert.ok(open.main.right <= open.side.x + 1, 'Wide layout must reserve space beside the main chat');
      assert.ok(open.side.width >= 320 && open.side.right <= open.viewport.width + 1);
      assert.ok(open.composer.bottom <= open.viewport.height + 1 && open.scroll.height > 100);
      await fill('.side-chat-composer textarea', 'Side draft retained.');
      await close();
      const closed = await geometry();
      assert.equal(closed.slotHidden, true);
      assert.ok(closed.main.width > open.main.width, 'Closing the side chat must restore main width');
      assert.equal(
        await evaluate('window.fixture.state.workflows[0].status'),
        'running',
        'Closing must not cancel the main task',
      );
      await evaluate('document.querySelector(\'[aria-label="\u4fa7\u804a\u8bb0\u5f55"]\').click()');
      await frame();
      await evaluate("document.querySelector('.side-chat-history-list button').click()");
      await frame();
      assert.equal(
        await evaluate("document.querySelector('.side-chat-composer textarea').value"),
        'Side draft retained.',
      );
      assert.equal(
        await evaluate("window.calls.filter(call => call.path.endsWith('/side-chat')).length"),
        1,
        'Reopening reuses the independent side session',
      );
      await enter();
      const sent = await evaluate("window.calls.find(call => call.path.endsWith('/messages'))");
      assert.equal(sent.path, '/api/conversations/side-1/messages');
      assert.equal(sent.body.content, 'Side draft retained.');
      assert.equal(sent.body.mode, 'chat');
      assert.equal(sent.body.permissionMode, 'read-only');
      assert.equal(sent.body.runtimeId, 'grok-b');
      assert.equal(sent.body.model, 'fixture-model');
      assert.equal(sent.body.effort, 'high');
      assert.equal(sent.body.schedule, undefined);
      assert.equal(await evaluate("document.querySelector('.side-chat-composer textarea').value"), '');
      assert.equal(await evaluate("document.querySelector('#conversation-input').value"), mainDraft);
      assert.ok(
        await evaluate("document.querySelector('.side-chat-messages').textContent.includes('Fixture side reply')"),
      );
      assert.equal(
        await evaluate(
          "getComputedStyle(document.querySelector('.side-chat-message.message-user .message-heading > span')).display",
        ),
        'block',
        'side chat keeps the You label',
      );
      assert.notEqual(
        await evaluate("getComputedStyle(document.querySelector('.side-chat-message.message-user')).alignItems"),
        'flex-end',
        'side chat does not inherit the main user bubble layout',
      );
      assert.equal(await evaluate('window.fixture.state.workflows[0].status'), 'running');

      await fill('.side-chat-composer textarea', 'Retained after failure.');
      await evaluate("window.failure='Fixture: side send rejected'");
      await enter();
      assert.equal(
        await evaluate("document.querySelector('.side-chat-composer textarea').value"),
        'Retained after failure.',
      );
      assert.match(
        await evaluate("document.querySelector('.side-chat-composer [role=alert]').textContent"),
        /side send rejected/,
      );
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('.side-chat-error')].filter(node => node.textContent.includes('side send rejected')).length",
        ),
        1,
        'Send errors appear once inline',
      );
      assert.equal(
        await evaluate("window.notices.filter(notice => notice.message.includes('side send rejected')).length"),
        0,
        'Inline delivery failures do not also create a toast',
      );
      await evaluate("window.switchMain('other')");
      await frame();
      assert.equal(await evaluate("document.querySelector('.side-chat-panel')"), null);
      assert.equal(await evaluate("document.querySelector('#conversation-input').value"), '');
      await evaluate("window.switchMain('main')");
      await frame();
      assert.equal(
        await evaluate("document.querySelector('.side-chat-composer textarea').value"),
        'Retained after failure.',
      );
      assert.equal(await evaluate("document.querySelector('#conversation-input').value"), mainDraft);

      const sends = await evaluate("window.calls.filter(call => call.path.endsWith('/messages')).length");
      await evaluate(
        `(() => {const input=document.querySelector('.side-chat-composer textarea');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`,
      );
      await frame();
      assert.equal(
        await evaluate("window.calls.filter(call => call.path.endsWith('/messages')).length"),
        sends,
        'IME confirmation must not submit',
      );
      await setViewport(900, 720);
      const narrow = await geometry();
      assert.ok(
        narrow.side.x >= 0 &&
          narrow.side.right <= narrow.viewport.width + 1 &&
          narrow.side.bottom <= narrow.viewport.height + 1,
        'Narrow side pane must fit its container',
      );
      await close();
      const narrowClosed = await geometry();
      assert.ok(narrowClosed.composer.bottom <= narrowClosed.viewport.height + 1 && narrowClosed.scroll.height > 100);
      const createCount = await evaluate("window.calls.filter(call => call.path.endsWith('/side-chat')).length");
      const messageCount = await evaluate("window.calls.filter(call => call.path.endsWith('/messages')).length");
      await evaluate('window.remountFixture()');
      await frame();
      assert.equal(await evaluate("document.querySelector('.side-chat-panel')"), null);
      await evaluate('document.querySelector(\'[aria-label="侧聊记录"]\').click()');
      await frame();
      assert.ok(
        await evaluate("document.querySelector('.side-chat-history-list').textContent.includes('Fixture side-1')"),
      );
      await evaluate("document.querySelector('.side-chat-history-list button').click()");
      await frame();
      assert.ok(
        await evaluate("document.querySelector('.side-chat-messages').textContent.includes('Fixture side reply')"),
      );
      assert.equal(
        await evaluate("window.calls.filter(call => call.path.endsWith('/side-chat')).length"),
        createCount,
        'Saved history must reopen the existing side conversation without creating another',
      );
      assert.equal(
        await evaluate("window.calls.filter(call => call.path.endsWith('/messages')).length"),
        messageCount,
        'Opening saved history must not submit a task',
      );
      assert.equal(await evaluate('window.fixture.state.workflows[0].status'), 'running');
      await close();
      assert.equal(
        await evaluate(
          "window.calls.filter(call => ['cancel', 'delete', '/runs'].some(value => call.path.includes(value))).length",
        ),
        0,
        'Mount actions must not cancel or launch native runs',
      );
      await new Promise((resolve) =>
        process.stdout.write(
          'PASS workspace side-chat mount: bounded layout, selected quote/side-chat, inherited model/effort, read-only Enter send, close/reopen, saved history after remount without duplicate creation, scope draft retention, failed-send retention and IME safety\n',
          resolve,
        ),
      );
      if (win && !win.isDestroyed()) win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      if (win && !win.isDestroyed()) win.destroy();
      app.exit(1);
    }
  });
}
