// Hidden renderer, synthetic history, in-memory pin API and temporary profile.
// No real account, backend, database, browser authorization or agent is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const prefix = 'pugport-pinned-messages-smoke-';

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationWorkspace} from './src/ui/Workspace';
import './src/ui/studio.css';
import './src/ui/pinned-messages.css';
import './src/ui/mods/mods.css';
import './src/ui/SideChatPanel.css';
import './src/ui/ConversationQueue.css';
const stamp=index=>new Date(Date.parse('2026-10-07T12:00:00Z')+index*60000).toISOString();
const message=index=>({id:'m'+index,conversationId:'main',role:index%2?'assistant':'user',
 content:'记录 '+index+'：已核对本轮材料，保留已有结果，等待下一项进展。',createdAt:stamp(index)});
const history=Array.from({length:160},(_,index)=>message(index));
history[0].content='已发客户报价，等待客户确认交付范围与启动日期；下周收到回复后再处理。';
history[146].content='已发邮件给客户，本轮报价已经整理好，下一步等待对方回复。';history[146].workflowId='office';
history[147].content='继续处理本地文件对比，保留已保存的检查结果。';history[147].workflowId='scan';
const workflow=(id,index,status)=>({id,conversationId:'main',projectId:'project',userMessageId:'m'+index,
 input:{content:history[index].content,mode:'chat',permissionMode:'read-only',executionPolicy:'cli-first'},
 status,phase:'execute',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:stamp(index),updatedAt:stamp(index)});
const main={id:'main',projectId:'project',title:'客户跟进与本地任务',createdAt:stamp(0),updatedAt:stamp(159),
 pinnedMessagesRevision:1,pinnedMessages:[{messageId:'m0',pinnedAt:stamp(0),tracking:'follow-up',followUpStatus:'waiting'},
 {messageId:'m147',pinnedAt:stamp(147),tracking:'task'}]};
const project={id:'project',scope:'chat',name:'Fixture',path:'C:/Fixture',createdAt:stamp(0),updatedAt:stamp(0)};
window.fixture={history,conversation:main,notices:[],calls:[],inspections:[],current:'main',state:{
 app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},
 settings:{toolApprovalMode:'auto',executionPolicy:'cli-only',steerOnSend:false,unknownQuotaPolicy:'manual-only'},
 targets:[],runtimes:[],approvals:[],plugins:[],projects:[project],conversations:[main,
 {id:'other',projectId:'project',title:'另一个对话',createdAt:stamp(0),updatedAt:stamp(0)}],
 conversationMessages:history.slice(-100),runs:[],workflows:[workflow('office',146,'completed'),
 {...workflow('scan',147,'running'),waitingOn:{kind:'media-analysis',jobId:'local-job'}}],
 backgroundTasks:[{id:'local-job',kind:'media-analysis',conversationId:'main',title:'本地媒体比对',detail:'第 5 步逐对核验',
 state:'running',done:30,total:120,startedAt:stamp(147),steps:[{key:'compare',label:'逐对核验',state:'running',done:30,total:120}]}]
}};
const f=window.fixture;const root=createRoot(document.getElementById('root'));
const api=async(url,body,method)=>{
 f.calls.push({url,body,method});
 if(method==='GET'&&/^\\/api\\/conversations\\/(main|other)$/.test(url)){
  const id=url.split('/').at(-1);return {conversation:f.state.conversations.find(item=>item.id===id),
  messages:id==='main'?f.history:[],workflows:f.state.workflows.filter(item=>item.conversationId===id)};
 }
 const match=/^\\/api\\/conversations\\/main\\/messages\\/([^/]+)\\/pin$/.exec(url);
 if(match&&method==='PATCH'){
  const id=decodeURIComponent(match[1]);let pins=f.conversation.pinnedMessages||[];
  const before=JSON.stringify(pins);let existing=pins.find(item=>item.messageId===id);
  if(body.pinned===false)pins=pins.filter(item=>item.messageId!==id);
  else {
   const linked=f.state.workflows.some(item=>item.userMessageId===id);
   if(!existing){existing={messageId:id,pinnedAt:stamp(160),tracking:linked?'task':'follow-up'};pins=[...pins,existing];}
   if(body.tracking)existing.tracking=body.tracking;
   if(existing.tracking==='follow-up')existing.followUpStatus=body.followUpStatus||existing.followUpStatus||'todo';
   else delete existing.followUpStatus;
  }
  f.conversation={...f.conversation,pinnedMessages:pins};
  if(JSON.stringify(pins)!==before)f.conversation.pinnedMessagesRevision++;
  f.state.conversations=f.state.conversations.map(item=>item.id==='main'?f.conversation:item);
  window.renderFixture();return {...f.conversation,pinnedMessages:pins.map(item=>({...item}))};
 }
 throw new Error('Unexpected fixture API; agents are forbidden: '+method+' '+url);
};
window.renderFixture=()=>flushSync(()=>root.render(<main className="workspace-main" style={{height:'100vh'}}>
 <ConversationWorkspace state={{...f.state,workflows:[...f.state.workflows],backgroundTasks:f.state.backgroundTasks.map(item=>({...item})),
 conversationMessages:[...f.state.conversationMessages]}} api={api} project={project}
 conversation={f.state.conversations.find(item=>item.id===f.current)} notify={notice=>f.notices.push(notice)}
 onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={id=>f.inspections.push(id)}/>
 </main>));
window.unmountFixture=()=>flushSync(()=>root.unmount());
window.renderFixture();`,
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_PINNED_SMOKE: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => child.kill(), 45000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith(prefix));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_PINNED_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith(prefix));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const errors = [];
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const update = async (source) => {
    await evaluate(`(()=>{${source};window.renderFixture();})()`);
    await frame();
  };
  const click = async (selector) => {
    await evaluate(
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing '+${JSON.stringify(selector)});element.click()})()`,
    );
    await frame();
  };
  const rowAction = async (row, text) => {
    await evaluate(`(()=>{const item=document.querySelectorAll('.pinned-message-row')[${row}];
      const button=[...item.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)});
      if(!button)throw Error('Missing row action '+${JSON.stringify(text)});button.click()})()`);
    await frame();
  };
  const shot = async (name) => {
    await frame();
    await fs.writeFile(
      path.join(root, 'reports', `pinned-messages-${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  };
  void app.whenReady().then(async () => {
    try {
      await fs.mkdir(path.join(root, 'reports'), { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 820,
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
      win.webContents.on('console-message', (event) => {
        if (['error', 'warning'].includes(event.level) && !event.message.includes('Electron Security Warning'))
          errors.push(event.message);
      });
      await win.loadFile(path.join(fixture, 'index.html'));
      await frame();
      assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.pinned-message-preview')).backgroundColor"),
        'rgba(0, 0, 0, 0)',
        'message previews remain plain text controls',
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.pinned-messages-list').length"),
        0,
        'one compact bar by default',
      );
      assert.equal(
        await evaluate("document.querySelector('[data-message-id=m0]')"),
        null,
        'old pin starts outside the history render window',
      );
      await shot('collapsed');

      const beforeScroll = await evaluate("document.querySelector('.pinned-messages').getBoundingClientRect().top");
      await evaluate(
        "const scroll=document.querySelector('.conversation-scroll');scroll.scrollTop=Math.max(500,scroll.scrollHeight/2);scroll.dispatchEvent(new Event('scroll')); ",
      );
      await frame();
      assert.equal(
        await evaluate("document.querySelector('.pinned-messages').getBoundingClientRect().top"),
        beforeScroll,
        'bar is outside the history scroller',
      );
      const historyTop = await evaluate("document.querySelector('.conversation-scroll').scrollTop");
      await click('.pinned-messages-summary .pinned-message-preview');
      assert.equal(await evaluate("document.querySelectorAll('.pinned-window').length"), 1, 'the bar opens the window');
      assert.equal(
        await evaluate("document.querySelector('.conversation-scroll').scrollTop"),
        historyTop,
        'opening the window keeps the history in place',
      );
      assert.equal(await evaluate("document.querySelector('[data-message-id=m0]')"), null, 'no jump on open');
      await evaluate(
        "[...document.querySelectorAll('.pinned-window-footer button')].find(item=>item.textContent.includes('在对话中定位')).click()",
      );
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('.pinned-window').length"), 0, 'locate minimizes');
      assert.equal(
        await evaluate('document.activeElement.dataset.messageId'),
        'm0',
        'jump reveals and focuses old saved message',
      );
      assert.equal(
        await evaluate("document.querySelector('[data-message-id=m0]').classList.contains('pinned-jump-highlight')"),
        true,
      );
      await click('.pinned-messages-toggle');
      assert.equal(await evaluate("document.querySelectorAll('.pinned-message-row').length"), 2);
      assert.match(
        await evaluate("document.querySelectorAll('.pinned-message-row')[1].textContent"),
        /本地处理中.*30 \/ 120/,
      );
      await update(
        'window.fixture.state.backgroundTasks[0].done=42;window.fixture.state.backgroundTasks[0].steps[0].done=42;',
      );
      assert.match(await evaluate("document.querySelectorAll('.pinned-message-row')[1].textContent"), /42 \/ 120/);
      await update("window.fixture.state.backgroundTasks[0].state='paused';");
      assert.match(await evaluate("document.querySelectorAll('.pinned-message-row')[1].textContent"), /本地任务已暂停/);
      await update("window.fixture.state.backgroundTasks[0].state='running';");

      await evaluate("document.querySelector('[data-message-id=m146] [aria-label=置顶消息]').click()");
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('.pinned-message-row').length"), 3);
      await rowAction(2, '改为跟进记录');
      await evaluate(
        "const select=document.querySelectorAll('.pinned-message-row')[2].querySelector('select');select.value='waiting';select.dispatchEvent(new Event('change',{bubbles:true}));",
      );
      await frame();
      assert.match(
        await evaluate("document.querySelectorAll('.pinned-message-row')[2].textContent"),
        /等待确认.*手动跟进/,
      );
      assert.equal(
        await evaluate("window.fixture.state.workflows.find(item=>item.id==='office').status"),
        'completed',
        'manual marker never changes the task',
      );
      await rowAction(2, '追踪执行任务');
      assert.match(
        await evaluate("document.querySelectorAll('.pinned-message-row')[2].textContent"),
        /已完成.*任务状态/,
      );
      await rowAction(2, '改为跟进记录');
      await shot('expanded');

      await evaluate(
        "document.getSelection().removeAllRanges();document.querySelector('[data-message-id=m158]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:150,clientY:200}));",
      );
      await frame();
      assert.equal(
        await evaluate(
          "document.querySelector('.context-menu [role=menuitem]')?.textContent.trim()||document.querySelector('.context-menu button')?.textContent.trim()",
        ),
        '置顶消息',
      );
      await click('.context-menu button');
      assert.equal(await evaluate("document.querySelectorAll('.pinned-message-row').length"), 4);
      await click('.pinned-message-row:last-child [aria-label=取消置顶]');
      assert.equal(await evaluate("document.querySelectorAll('.pinned-message-row').length"), 3);

      const priorCalls = await evaluate('window.fixture.calls.length');
      await click('[aria-label=刷新置顶状态]');
      assert.deepEqual(
        await evaluate(`window.fixture.calls.slice(${priorCalls}).map(item=>[item.url,item.method])`),
        [['/api/conversations/main', 'GET']],
        'refresh reads local records only',
      );
      const savedActivity = await evaluate('window.fixture.conversation.updatedAt');
      await update(
        "window.fixture.conversation={...window.fixture.conversation,pinnedMessages:window.fixture.conversation.pinnedMessages.filter(item=>item.messageId!=='m0'),pinnedMessagesRevision:window.fixture.conversation.pinnedMessagesRevision+1};window.fixture.state.conversations[0]=window.fixture.conversation;",
      );
      assert.equal(
        await evaluate("document.querySelectorAll('.pinned-message-row').length"),
        2,
        'newer other-window broadcast replaces local snapshot',
      );
      assert.equal(
        await evaluate('window.fixture.conversation.updatedAt'),
        savedActivity,
        'pin state does not move the conversation activity order',
      );

      const responsive = [];
      for (const width of [1000, 520, 360, 320]) {
        win.setContentSize(width, 820);
        await frame();
        const measured = await evaluate(
          `(()=>{const bar=document.querySelector('.pinned-messages');const list=document.querySelector('.pinned-messages-list');return {width:innerWidth,body:document.body.scrollWidth,bar:bar.scrollWidth,barClient:bar.clientWidth,list:list.scrollWidth,listClient:list.clientWidth,listHeight:list.getBoundingClientRect().height}})()`,
        );
        assert.ok(measured.bar <= measured.barClient + 1, 'pin bar must not overflow at ' + width);
        assert.ok(measured.list <= measured.listClient + 1, 'expanded list must not overflow at ' + width);
        assert.ok(measured.listHeight <= 230, 'expanded tracking list has bounded height');
        if (width >= 360) assert.ok(measured.body <= width + 1, 'supported viewport must not overflow');
        else assert.equal(measured.body, 360, 'existing desktop body minimum width is 360px');
        responsive.push(measured);
        await shot(String(width));
      }
      await update("window.fixture.current='other';");
      assert.equal(
        await evaluate("document.querySelector('.pinned-messages')"),
        null,
        'pins remain conversation-specific',
      );
      await update("window.fixture.current='main';");
      assert.equal(
        await evaluate("document.querySelectorAll('.pinned-messages-list').length"),
        0,
        'changing conversations collapses the tracker',
      );
      assert.equal(
        await evaluate(
          "window.fixture.calls.every(item=>!item.method||item.method==='GET'||item.method==='PATCH'&&item.url.endsWith('/pin'))",
        ),
        true,
        'no AI/agent mutation or polling calls',
      );
      assert.deepEqual(await evaluate('window.fixture.notices'), []);
      assert.deepEqual(errors, []);
      await fs.writeFile(
        path.join(root, 'reports/pinned-messages-renderer.json'),
        JSON.stringify(
          { verifiedAt: new Date().toISOString(), responsive, calls: await evaluate('window.fixture.calls'), errors },
          null,
          2,
        ),
      );
      await evaluate('window.unmountFixture()');
      console.log(
        'PASS pinned messages renderer: fixed bar, window opens without moving history, locate jump, live local progress, manual/task switches, message/context pin, unpin, cross-window revision, GET-only refresh and narrow layouts',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      if (win) await shot('failure').catch(() => {});
      app.exit(1);
    }
  });
}
