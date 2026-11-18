// Isolated real React/Electron renderer. No actual app, native CLI, accounts, network or real user data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-submit-renderer-'));
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
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationWorkspace} from './src/ui/Workspace';
import {SplitView} from './src/ui/SplitView';
import {ComposerSession} from './src/ui/composer-session';
const stamp='2026-10-05T12:00:00.000Z';
const conversation=id=>({id,projectId:'project',title:'Fixture '+id,createdAt:stamp,updatedAt:stamp});
const session=new ComposerSession();
window.fixture={current:'chat',adoptedDraftId:'',requests:[],notices:[],state:{app:{name:'Fixture',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-only',steerOnSend:false},targets:[],runtimes:[],approvals:[],plugins:[],projects:[{id:'project',name:'Fixture',scope:'chat',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp}],conversations:[conversation('chat')],workflows:[],runs:[],conversationMessages:[{id:'old',conversationId:'chat',role:'user',content:'Previous question',createdAt:stamp}]}};
const f=window.fixture;
let createdCount=0;
const api=async(path,body,method)=>{
 if(method==='GET')return {messages:[],workflows:[]};
 if(path==='/api/conversations')return conversation('created-'+(++createdCount));
 if(path.endsWith('/messages'))return new Promise((resolve,reject)=>f.requests.push({body,conversationId:path.split('/')[3],resolve,reject}));
 throw Error('Unexpected fixture endpoint '+path);
};
const root=createRoot(document.getElementById('root'));
window.renderFixture=()=>flushSync(()=>root.render(<main className="workspace-main" style={{height:'100vh'}}><SplitView ids={[f.current]} sizes={[1]} adoptedDraftId={f.adoptedDraftId} onSizes={()=>{}} onDrop={()=>{}}>{id=><ConversationWorkspace composerSession={session} state={{...f.state,workflows:[...f.state.workflows],runs:[...f.state.runs],conversationMessages:[...f.state.conversationMessages]}} api={api} project={f.state.projects[0]} conversation={f.state.conversations.find(c=>c.id===id)} notify={notice=>f.notices.push(notice)} onConversation={value=>{f.current=value.id;f.adoptedDraftId=value.id;if(!f.state.conversations.some(c=>c.id===value.id))f.state.conversations.push(value);window.renderFixture();}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} />}</SplitView></main>));
window.serverMessage=index=>{const request=f.requests[index];return {id:'saved-'+index,clientMessageId:request.body.clientMessageId,conversationId:request.conversationId,role:'user',content:request.body.content,quotes:request.body.quotes,createdAt:new Date().toISOString()};};
window.emit=index=>{const message=window.serverMessage(index);if(!f.state.conversationMessages.some(m=>m.id===message.id))f.state.conversationMessages.push(message);window.renderFixture();};
window.ack=index=>f.requests[index].resolve({message:window.serverMessage(index)});
window.reject=index=>f.requests[index].reject(Error('Fixture rejected'));
window.newDraft=()=>{f.current='';window.renderFixture();};
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_SUBMIT_RENDERER: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 30000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const resolved = await fs.realpath(fixture),
        temporaryRoot = await fs.realpath(os.tmpdir());
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-submit-renderer-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_SUBMIT_RENDERER;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-submit-renderer-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const fill = async (text) => {
    await evaluate(
      `(()=>{const input=document.querySelector('#conversation-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await frame();
  };
  const enter = async () => {
    await evaluate(
      "document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
    );
    await frame();
  };
  const bool = async (source, message) => assert.equal(await evaluate(source), true, message);
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
      await evaluate(
        "window.originalInput=document.querySelector('#conversation-input');window.originalScroll=document.querySelector('.conversation-scroll');window.oldMessage=document.querySelector('[data-message-id=old]');window.originalInput.focus();",
      );
      await fill('Same text');
      await enter();
      await evaluate("window.pending=document.querySelector('.pending-send')");
      await bool('!!window.pending', 'optimistic row exists');
      await evaluate('window.emit(0)');
      await frame();
      await bool(
        "document.querySelector('[data-message-id=saved-0]')===window.pending",
        'SSE updates the original message DOM without a remount',
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.message-user').length"),
        2,
        'SSE before ACK does not duplicate the pending bubble',
      );
      await evaluate('window.ack(0)');
      await frame();
      await bool(
        "document.querySelector('[data-message-id=saved-0]')===window.pending",
        'ACK preserves the same saved DOM',
      );
      await bool(
        "document.querySelector('#conversation-input')===window.originalInput && document.querySelector('.conversation-scroll')===window.originalScroll && document.querySelector('[data-message-id=old]')===window.oldMessage",
        'existing composer, scroller and messages remain mounted',
      );
      await fill('Same text');
      await enter();
      await evaluate("window.second=document.querySelector('.pending-send');window.ack(1)");
      await frame();
      await bool(
        "document.querySelector('[data-message-id=saved-1]')===window.second",
        'ACK before SSE preserves optimistic DOM',
      );
      await evaluate('window.emit(1)');
      await frame();
      await bool(
        "document.querySelector('[data-message-id=saved-1]')===window.second",
        'later SSE does not remount acknowledged row',
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.message-user').length"),
        3,
        'identical text stays as two separate requests',
      );
      await fill('Rejected original');
      await enter();
      await fill('Next draft');
      await evaluate('window.reject(2)');
      await frame();
      await bool(
        "document.querySelector('.pending-send-error button').disabled",
        'failed send cannot replace next draft',
      );
      await fill('');
      await evaluate("document.querySelector('.pending-send-error button').click()");
      await frame();
      assert.equal(
        await evaluate("document.querySelector('#conversation-input').value"),
        'Rejected original',
        'failed row recovers original text',
      );
      await fill('Already delivered');
      await enter();
      await evaluate('window.emit(3);window.reject(3)');
      await frame();
      assert.equal(
        await evaluate("document.querySelector('#conversation-input').value"),
        '',
        'broadcast-confirmed delivery is not restored when HTTP fails',
      );
      assert.equal(await evaluate("document.querySelectorAll('[data-message-id=saved-3]').length"), 1);
      await evaluate('window.newDraft()');
      await frame();
      await evaluate(
        "window.draftInput=document.querySelector('#conversation-input');window.draftScroll=document.querySelector('.conversation-scroll');window.draftInput.focus()",
      );
      await fill('First message');
      await enter();
      await evaluate("window.firstDraftBubble=document.querySelector('.pending-send')");
      await bool("!document.querySelector('.conversation-empty')", 'first send immediately hides empty welcome');
      await evaluate('window.ack(4)');
      await frame();
      await bool(
        "document.querySelector('#conversation-input')===window.draftInput && document.querySelector('.conversation-scroll')===window.draftScroll",
        'assigning the conversation ID does not remount the pane',
      );
      await bool(
        "document.querySelector('[data-message-id=saved-4]')===window.firstDraftBubble",
        'first send preserves its message DOM across draft adoption',
      );
      await evaluate('window.emit(4)');
      await frame();
      await bool(
        "document.querySelector('[data-message-id=saved-4]')===window.firstDraftBubble",
        'new conversation SSE retains the existing message',
      );
      await evaluate('window.newDraft()');
      await frame();
      await fill('First saved without ACK');
      await enter();
      await evaluate(
        "window.failedAckBubble=document.querySelector('.pending-send');window.failedAckInput=document.querySelector('#conversation-input')",
      );
      await fill('Queued second Enter');
      await enter();
      await evaluate('window.emit(5);window.reject(5)');
      await frame();
      await bool(
        "document.querySelector('[data-message-id=saved-5]')===window.failedAckBubble",
        'SSE-confirmed first message survives failed HTTP ACK and adopts conversation',
      );
      await bool(
        "document.querySelector('#conversation-input')===window.failedAckInput",
        'failed ACK adoption keeps composer mounted',
      );
      assert.equal(
        await evaluate('window.fixture.requests.length'),
        6,
        'Enter while a send is pending does not automatically submit a second task',
      );
      assert.equal(await evaluate("document.querySelector('#conversation-input').value"), 'Queued second Enter');
      await enter();
      assert.equal(await evaluate('window.fixture.requests.length'), 7, 'a fresh Enter sends the retained draft');
      await bool(
        'window.fixture.requests[6].conversationId===window.fixture.requests[5].conversationId',
        'the explicit second send uses the adopted conversation',
      );
      await evaluate('window.ack(6);window.emit(6)');
      await frame();
      console.log(
        'PASS submit renderer: stable message/composer/scroller DOM, SSE/ACK race both directions, duplicate text, failure recovery, first conversation adoption.',
      );
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      win?.destroy();
      app.exit(1);
    }
  });
}
