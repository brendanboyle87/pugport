// Synthetic renderer only: no server, credentials or native CLI execution.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-branch-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><main style="max-width:780px;margin:32px auto;padding:24px"><h2>项目讨论</h2><div id="root"></div></main><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationHistory} from './src/ui/Workspace';
import './src/ui/studio.css';
import './src/ui/pinned-messages.css';
window.calls=[];window.opened=[];window.notices=[];window.running=false;window.fail=false;
const messages=[
 {id:'first',role:'user',content:'请说明这个项目的主要模块。'},
 {id:'reply',role:'assistant',content:'项目由桌面界面、任务调度和原生执行器三个部分组成。'},
 {id:'last',role:'user',content:'请进一步说明任务调度流程。'},
].map((m,i)=>({...m,conversationId:'conversation',createdAt:'2026-10-13T12:00:0'+i+'.000Z'}));
const root=createRoot(document.getElementById('root'));
window.presentationReads=[];
const api=async(path,body,method)=>{
 // A task card loads its presentation lazily; that read is not one of the user's actions.
 if(path.includes('/presentations?')){window.presentationReads.push(path);return {presentations:{}};}
 window.calls.push({path,body,method});
 if(window.fail)throw new Error('Synthetic API failure');
 if(path.endsWith('/fork'))return {id:'branch',projectId:'project',title:'项目讨论（分支）'};
 if(path.endsWith('/edit-and-resend'))return {conversation:{id:'edited',projectId:'project',title:'项目讨论（分支）'}};
 return {};
};
window.renderFixture=()=>{
 const workflows=window.running?[{id:'busy',conversationId:'conversation',userMessageId:'last',status:'running',phase:'execute',input:{content:'Fixture'},runIds:[],plan:[]}]:[];
 flushSync(()=>root.render(<ConversationHistory messages={messages} workflows={workflows}
 state={{workflows,runs:[],targets:[],settings:{}}} api={api} notify={n=>window.notices.push(n)} onInspect={()=>{}}
 onConversation={c=>window.opened.push(c.id)} />));
};
window.renderFixture();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, PUGPORT_BRANCH_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 45000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-branch-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_BRANCH_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-branch-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        width: 900,
        height: 720,
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
      const evaluate = (source) => win.webContents.executeJavaScript(source);
      const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const click = async (id, label) => {
        await evaluate(`document.querySelector('[data-message-id="${id}"] [aria-label="${label}"]').click()`);
        await frame();
      };
      await win.loadFile(path.join(fixture, 'index.html'));
      await frame();
      // A branch starts from an answer; the user's own messages are edited or resent instead.
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll("[aria-label=从这里分叉]")].map(node=>node.closest("[data-message-id]").dataset.messageId)',
        ),
        ['reply'],
      );
      assert.equal(await evaluate('document.querySelectorAll("[aria-label=编辑]").length'), 2);
      assert.equal(await evaluate('document.querySelectorAll("[aria-label=重新发送]").length'), 1);
      await click('first', '编辑');
      assert.equal(await evaluate('document.querySelector("textarea").value'), '请说明这个项目的主要模块。');
      await evaluate('document.querySelector(".sent-message-editor button[type=button]").click()');
      await frame();
      assert.equal(await evaluate('document.querySelector("textarea")===null'), true);
      assert.equal(await evaluate('window.calls.length'), 0);
      await click('last', '编辑');
      await evaluate(`(()=>{
        const node=document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,'请用三个步骤解释任务调度流程。');
        node.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await frame();
      await evaluate('document.querySelector(".sent-message-editor button[type=submit]").click()');
      await frame();
      assert.deepEqual(await evaluate('window.calls[0]'), {
        path: '/api/conversations/conversation/messages/last/edit-and-resend',
        body: { content: '请用三个步骤解释任务调度流程。' },
        method: 'POST',
      });
      assert.deepEqual(await evaluate('window.opened'), ['edited']);
      await click('reply', '从这里分叉');
      assert.deepEqual(await evaluate('window.calls[1]'), {
        path: '/api/conversations/conversation/fork',
        body: { messageId: 'reply' },
        method: 'POST',
      });
      assert.deepEqual(await evaluate('window.opened'), ['edited', 'branch']);
      await click('last', '重新发送');
      assert.deepEqual(await evaluate('window.calls[2]'), {
        path: '/api/conversations/conversation/messages/last/resend',
        body: {},
        method: 'POST',
      });
      await evaluate('window.running=true;window.renderFixture()');
      await frame();
      assert.equal(await evaluate('document.querySelector("[aria-label=重新发送]").disabled'), true);
      await click('last', '重新发送');
      assert.equal(await evaluate('window.calls.length'), 3);
      await evaluate('window.running=false;window.fail=true;window.renderFixture()');
      await frame();
      await click('last', '编辑');
      await evaluate('document.querySelector(".sent-message-editor button[type=submit]").click()');
      await frame();
      assert.equal(await evaluate('window.notices.at(-1).message'), 'Synthetic API failure');
      assert.equal(await evaluate('document.querySelector("textarea").value'), '请进一步说明任务调度流程。');
      await evaluate('document.querySelector("[aria-label=编辑]").focus()');
      await frame();
      assert.equal(await evaluate('getComputedStyle(document.querySelector("[aria-label=编辑]")).opacity'), '1');
      if (process.env.PUGPORT_BRANCH_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.PUGPORT_BRANCH_SCREENSHOT_DIR, { recursive: true });
        for (const [name, width, theme] of [
          ['light', 900, 'light'],
          ['dark-narrow', 440, 'dark'],
        ]) {
          win.setSize(width, 720);
          await evaluate(`document.documentElement.dataset.theme='${theme}'`);
          await frame();
          await evaluate('new Promise(resolve=>setTimeout(resolve,150))');
          assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
          const snapshot = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Screenshot timed out')), 5000);
            let frames = 0;
            const paint = (_event, _rect, image) => {
              if (++frames < 2) {
                win.webContents.invalidate();
                return;
              }
              clearTimeout(timeout);
              win.webContents.off('paint', paint);
              resolve(image.toPNG());
            };
            win.webContents.on('paint', paint);
            win.webContents.invalidate();
          });
          await fs.writeFile(
            path.join(process.env.PUGPORT_BRANCH_SCREENSHOT_DIR, `message-branch-${name}.png`),
            snapshot,
          );
        }
      }
      console.log(
        'PASS renderer: render, cancel, edit/send/open, fork/open, resend, running guard, error recovery, keyboard focus, light/dark narrow layout',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
