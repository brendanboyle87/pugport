// Run with .runtime/node.exe tests/conversation-queue-renderer-smoke.cjs. All API calls use in-memory mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-queue-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        (await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8')) +
          '\n' +
          (await fs.readFile(path.join(root, 'src/ui/ConversationQueue.css'), 'utf8')),
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationQueue } from './src/ui/ConversationQueue';
import { ConversationHistory } from './src/ui/Workspace';
import { conversationQueuedMessages, representedQueueHeadId } from './src/ui/message-queue';
import { conversationTimeline } from './src/ui/conversation-timeline';
const stamp = '2026-09-30T12:00:00.000Z';
const workflow = (id, status = 'queued') => ({
 id, status, conversationId:'conversation', projectId:'project', userMessageId:'message-' + id,
 input:{content:'Fixture ' + id, mode:'build', permissionMode:'workspace-write', executionPolicy:'cli-first'},
 phase: status === 'running' ? 'execute' : 'queue', plan:[], runIds:[], memoryRevision:0, memoryExcerpt:'', createdAt:stamp, updatedAt:stamp
});
window.makeWorkflow = workflow;
window.makeMessage = id => ({id:'message-'+id,workflowId:id,conversationId:'conversation',role:'user',content:'Fixture '+id,createdAt:stamp});
window.fixture = {
 conversation: {id:'conversation',projectId:'project',title:'Fixture',createdAt:stamp,updatedAt:stamp},
 state: {
  settings:{toolApprovalMode:'auto'},
  targets:[], runtimes:[],
  workflows:[workflow('active','running'), workflow('a'), workflow('b')],
  runs:[{id:'run',workflowId:'active',stepId:'step',status:'running',steerAvailable:true,toolApprovalMode:'auto',startedAt:stamp}],
  conversationMessages:[window.makeMessage('a'),window.makeMessage('b')]
 }
};
window.calls = []; window.notices = []; window.sideChats = [];
const root = createRoot(document.getElementById('root'));
const api = async (path, body, method) => {
 window.calls.push({path,body,method});
 if (window.holdNext) { window.holdNext = false; await new Promise(resolve => window.releaseRequest = resolve); }
 if (window.failure) { const failure = window.failure; window.failure = undefined; throw new Error(failure); }
 const {state, conversation} = window.fixture;
 const id = path.split('/')[3];
 if (path.endsWith('/queue/order')) for (const workflow of state.workflows) {
  const index = body.workflowIds.indexOf(workflow.id);
  if (index >= 0) workflow.queueOrder = Date.parse(stamp) + index;
 }
 else if (path.endsWith('/input')) state.workflows.find(item => item.id === id).input.content = body.content;
 else if (path.endsWith('/cancel')) state.workflows.find(item => item.id === id).status = 'cancelled';
 else if (method === 'DELETE' || path.endsWith('/steer')) state.workflows.find(item => item.id === id).deletedAt = stamp;
 else if (path.endsWith('/queueing')) conversation.queueingEnabled = body.enabled;
 window.renderFixture();
 return {ok:true};
};
window.renderFixture = () => flushSync(() => root.render(<>
{window.fixture.showHistory && <ConversationHistory
 messages={[...window.fixture.state.conversationMessages]} workflows={[...window.fixture.state.workflows]}
 state={{...window.fixture.state}} api={api} notify={notice => window.notices.push(notice)} onInspect={() => {}}
/>}
<ConversationQueue
 conversation={{...window.fixture.conversation}}
 state={{...window.fixture.state, workflows:[...window.fixture.state.workflows]}}
 api={api} notify={notice => window.notices.push(notice)} onSideChat={workflow => window.sideChats.push(workflow.id)}
 representedHeadId={window.fixture.showHistory ? representedQueueHeadId(
  conversationQueuedMessages(window.fixture.state.workflows,window.fixture.conversation.id),
  conversationTimeline(window.fixture.state.conversationMessages,window.fixture.state.workflows,window.fixture.state.runs)
 ) : undefined}
/></>));
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },

        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, COMBORUNNER_QUEUE_SMOKE: fixture };
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
      assert.ok(path.basename(resolved).startsWith('comborunner-queue-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_QUEUE_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-queue-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const row = (id) => `.conversation-queue-message[data-workflow-id="${id}"]`;
  const click = async (selector, text) => {
    await evaluate(`(() => {
      const button = [...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)} || button.getAttribute('aria-label') === ${JSON.stringify(text)});
      if (!button) throw new Error('Missing fixture action');
      button.click();
    })()`);
    await frame();
  };
  const menuAction = async (id, text) => {
    await click(row(id), '更多操作');
    await click('.context-menu', text);
  };
  const ids = () =>
    evaluate("[...document.querySelectorAll('.conversation-queue-message')].map(row => row.dataset.workflowId)");
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 650,
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
      assert.deepEqual(await ids(), ['a', 'b']);
      assert.equal(
        await evaluate('document.querySelectorAll(".conversation-queue-message [aria-haspopup=menu]").length'),
        2,
      );
      assert.equal(await evaluate('document.querySelectorAll("[aria-label^=上移], [aria-label^=下移]").length'), 0);
      await click(row('a'), '更多操作');
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll(".context-menu [role=menuitem]")].map(button => button.textContent.trim())',
        ),
        ['编辑', '在侧边对话打开', '上移', '下移', '移出队列'],
      );
      assert.equal(await evaluate('document.querySelector(".context-menu .danger").textContent.trim()'), '移出队列');
      await evaluate(`(() => {
        const trigger = document.querySelector(${JSON.stringify(row('a'))}).querySelector('[aria-haspopup="menu"]');
        trigger.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
      })()`);
      await frame();
      await click(row('a'), '更多操作');
      assert.equal(await evaluate('document.querySelector(".context-menu")'), null, 'second click closes the menu');
      await click(row('a'), '更多操作');
      await click('.context-menu', '编辑');
      assert.equal(
        await evaluate('document.activeElement === document.querySelector(".conversation-queue-edit textarea")'),
        true,
      );
      await evaluate(`(() => {
        const input = document.querySelector('.conversation-queue-edit textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Revised fixture');
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
      await frame();
      await evaluate("window.failure = 'Fixture: edit rejected'");
      await click('.conversation-queue-edit', '保存');
      assert.equal(
        await evaluate("document.querySelector('.conversation-queue-edit textarea').value"),
        'Revised fixture',
      );
      assert.equal(await evaluate('window.notices.at(-1).tone'), 'error');
      await click('.conversation-queue-edit', '保存');
      assert.equal(
        await evaluate(
          `document.querySelector(${JSON.stringify(row('a'))}).querySelector('.conversation-queue-content').textContent`,
        ),
        'Revised fixture',
      );

      await evaluate(`(() => {
        window.transfer = new DataTransfer();
        document.querySelector(${JSON.stringify(row('b'))}).querySelector('[draggable]').dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer:window.transfer}));
      })()`);
      await frame();
      await evaluate(`(() => {
        const target = document.querySelector(${JSON.stringify(row('a'))});
        target.dispatchEvent(new DragEvent('dragover', {bubbles:true,cancelable:true,dataTransfer:window.transfer,clientY:target.getBoundingClientRect().top + 1}));
      })()`);
      await frame();
      await evaluate(
        `document.querySelector(${JSON.stringify(row('a'))}).dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:window.transfer}))`,
      );
      await frame();
      assert.deepEqual(await ids(), ['b', 'a']);
      assert.deepEqual(
        await evaluate("window.calls.find(call => call.path.endsWith('/queue/order')).body.workflowIds"),
        ['b', 'a'],
      );
      await evaluate("window.failure = 'Fixture: reorder rejected'");
      await menuAction('b', '下移');
      assert.deepEqual(await ids(), ['b', 'a'], 'Failed reorder must restore server order');
      const focusedTrigger = () =>
        evaluate('document.activeElement?.closest("[data-workflow-id]")?.dataset.workflowId');
      assert.equal(await focusedTrigger(), 'b', 'failed reorder restores trigger focus');
      await evaluate('window.holdNext = true');
      await menuAction('b', '下移');
      assert.equal(
        await evaluate(
          `document.querySelector(${JSON.stringify(row('b'))}).querySelector('[aria-haspopup="menu"]').disabled`,
        ),
        true,
      );
      await evaluate('window.releaseRequest()');
      await frame();
      assert.deepEqual(await ids(), ['a', 'b']);
      assert.equal(await focusedTrigger(), 'b', 'focus returns after the moved trigger is enabled again');
      await menuAction('b', '上移');
      assert.deepEqual(await ids(), ['b', 'a']);
      assert.equal(await focusedTrigger(), 'b', 'moving up retains the same trigger');

      await menuAction('a', '在侧边对话打开');
      assert.deepEqual(await evaluate('window.sideChats'), ['a']);
      await evaluate("window.failure = 'Fixture: native input channel changed'");
      await click(row('b'), '插入当前任务（steer）');
      assert.deepEqual(await ids(), ['b', 'a'], 'Failed steer must retain the queue item');
      assert.match(await evaluate('window.notices.at(-1).message'), /channel changed/);
      await evaluate(`(() => {
        window.holdNext = true;
        const button = document.querySelector(${JSON.stringify(row('b'))}).querySelector('[aria-label="插入当前任务（steer）"]');
        button.click(); button.click();
      })()`);
      await frame();
      assert.equal(
        await evaluate("window.calls.filter(call => call.path.endsWith('/steer')).length"),
        2,
        'One failed request and one pending request, never a duplicate',
      );
      assert.ok(
        await evaluate(
          "[...document.querySelectorAll('.conversation-queue-actions button')].every(button => button.disabled)",
        ),
      );
      await evaluate('window.releaseRequest()');
      await frame();
      assert.deepEqual(await ids(), ['a']);
      assert.equal(await evaluate('window.fixture.state.conversationMessages.length'), 2, 'Steer retains messages');

      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('.conversation-queue button')].some(button => button.textContent.includes('关闭排队'))",
        ),
        false,
      );
      await evaluate('window.fixture.conversation.queueingEnabled = false; window.renderFixture()');
      await frame();
      assert.equal(await evaluate('window.fixture.conversation.queueingEnabled'), false);
      await click('.conversation-queue-hint', '开启排队');
      assert.equal(await evaluate('window.fixture.conversation.queueingEnabled'), true);
      await menuAction('a', '移出队列');
      assert.deepEqual(await ids(), []);
      assert.equal(await evaluate("document.querySelector('.conversation-queue')"), null);
      assert.deepEqual(await evaluate('window.calls.slice(-2).map(call => [call.path,call.method])'), [
        ['/api/workflows/a/cancel', 'POST'],
        ['/api/workflows/a', 'DELETE'],
      ]);
      assert.equal(await evaluate('window.fixture.state.conversationMessages.length'), 2, 'Delete retains messages');

      await evaluate(`(() => {
        const head = window.makeWorkflow('head', 'waiting-resource');
        head.machineLoadChoice = 'wait';
        head.queueOrder = Date.parse(head.createdAt) - 1;
        head.scheduling = {reason:'Synthetic: waiting for memory'};
        window.fixture.showHistory = true;
        window.fixture.state.workflows = [head];
        window.fixture.state.runs = [];
        window.fixture.state.conversationMessages = [window.makeMessage('head')];
        window.renderFixture();
      })()`);
      await frame();
      assert.deepEqual(await ids(), [], 'The waiting timeline head is not a second queue entry');
      assert.equal(await evaluate('document.querySelectorAll("#workflow-head").length'), 1);
      assert.equal(await evaluate(`document.querySelectorAll('[data-message-id="message-head"]').length`), 1);
      assert.equal(await evaluate('document.querySelectorAll(".machine-load-actions button").length'), 0);
      assert.equal(await evaluate('document.querySelectorAll("#workflow-head .workflow-status .spinning").length'), 1);
      assert.deepEqual(await ids(), [], 'Quiet memory wait keeps one timeline card without a duplicate queue row');
      assert.equal(await evaluate('window.fixture.state.workflows.length'), 1);
      assert.equal(await evaluate('window.fixture.state.conversationMessages.length'), 1);
      assert.equal(await evaluate('document.querySelectorAll(".machine-load-actions button").length'), 0);
      assert.equal(await evaluate('document.querySelectorAll("#workflow-head").length'), 1);

      await evaluate(`(() => {
        window.fixture.state.workflows[0].machineLoadChoice = 'pending';
        window.fixture.state.workflows.push(window.makeWorkflow('b'), window.makeWorkflow('c'));
        window.fixture.state.conversationMessages.push(window.makeMessage('b'), window.makeMessage('c'));
        window.renderFixture();
      })()`);
      await frame();
      assert.deepEqual(await ids(), ['b', 'c']);
      assert.equal(
        await evaluate('document.querySelector(".conversation-queue-heading strong").textContent'),
        '消息队列 · 2',
      );
      const artifacts = path.join(root, 'artifacts', 'conversation-queue');
      await fs.mkdir(artifacts, { recursive: true });
      win.setSize(800, 900);
      await frame();
      await fs.writeFile(
        path.join(artifacts, 'waiting-head-followups.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      win.setSize(390, 900);
      await frame();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await fs.writeFile(
        path.join(artifacts, 'waiting-head-followups-narrow.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      await menuAction('b', '下移');
      assert.deepEqual(await ids(), ['c', 'b']);
      assert.deepEqual(await evaluate('window.calls.at(-1).body.workflowIds'), ['head', 'c', 'b']);
      await menuAction('b', '移出队列');
      assert.deepEqual(await ids(), ['c']);
      assert.equal(await evaluate('window.fixture.state.conversationMessages.length'), 3);
      await evaluate(`(() => {
        const head = window.fixture.state.workflows.find(item => item.id === 'head');
        head.status = 'running';
        head.startedAt = head.createdAt;
        window.renderFixture();
      })()`);
      await frame();
      assert.equal(await evaluate('window.fixture.state.workflows.find(item => item.id === "head").status'), 'running');
      assert.deepEqual(await ids(), ['c'], 'Starting the recovered head preserves the later queue');
      assert.equal(await evaluate('window.calls.some(call => call.path.endsWith("/machine-load"))'), false);
      console.log(
        'PASS queue renderer: drag reorder, rollback, edit/retry, side-chat callback, duplicate-safe steer, re-enable hint, retained messages, quiet waiting head, recovery, complete reorder payload and 2 screenshots',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
