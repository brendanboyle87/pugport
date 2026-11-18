// Synthetic local renderer only: no backend, account, agent or external network.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const reports = path.join(root, 'reports', 'a2-search');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pugport-search-'));
    await fs.mkdir(path.join(fixture, 'profile'));
    await fs.mkdir(reports, { recursive: true });
    await fs.writeFile(
      path.join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await require('esbuild').build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import Studio from './src/ui/Studio';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {searchSnippet} from './src/shared/search';
import './src/ui/studio.css';
import './src/ui/pinned-messages.css';
import './src/ui/SideChatPanel.css';
import './src/ui/ConversationQueue.css';
import './src/ui/composer.css';
import './src/ui/mods/mods.css';
const stamp=i=>new Date(Date.parse('2026-10-01T12:00:00Z')+i*60000).toISOString();
const history=Array.from({length:160},(_,i)=>({id:'m'+i,conversationId:'main',role:i%2?'assistant':'user',content:'Synthetic message '+i,createdAt:stamp(i)}));
history[0].content='Early **needle** in archived history. needle again.';
history[155].content='Recent nee**dle** with inline formatting.';
const conversation={id:'main',projectId:'p',title:'Release notes · conversation search',createdAt:stamp(0),updatedAt:stamp(159)};
const other={...conversation,id:'other',title:'Another conversation'};
const secret={...conversation,id:'secret',title:'隐身对话',incognito:true,memory:'off'};
const project={id:'p',scope:'chat',name:'Fixture',path:'C:/Fixture',createdAt:stamp(0),updatedAt:stamp(159)};
const state={app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-only',steerOnSend:false,unknownQuotaPolicy:'manual-only'},targets:[],runtimes:[],approvals:[],plugins:[],projects:[project],conversations:[conversation,other,secret],conversationMessages:history.slice(-100),runs:[],workflows:[]};
localStorage.setItem('agent-studio-conversation','other');
localStorage.setItem('agent-studio-project','p');
localStorage.setItem('comborunner.seen',JSON.stringify({main:''}));
window.fixture={calls:[],history,state};
const api=async(url,body,method)=>{
 window.fixture.calls.push({url,method});
 if(url==='/api/modes'){
  if(method!=='GET')throw Error('Mode catalog must use GET');
  return {catalog:[],installed:[]};
 }
 if(url.startsWith('/api/search')) return [{conversationId:'main',messageId:'m0',title:conversation.title,createdAt:stamp(0),snippet:searchSnippet('Early needle in archived history. needle again.','needle')}];
 if(url==='/api/conversations/main?recordOnly=1') return {conversation};
 if(url==='/api/conversations/main') return {conversation,messages:history,workflows:[]};
 if(url==='/api/conversations/other') return {conversation:other,messages:[],workflows:[]};
 if(url==='/api/conversations/secret') return {conversation:secret,messages:[],workflows:[]};
 if(url==='/api/conversations/secret/close-incognito') {
  state.conversations=state.conversations.filter(item=>item.id!=='secret');
  window.fixture.events?.listeners.state?.({data:JSON.stringify(state)});
  return {deleted:true};
 }
 if(url==='/api/state') return state;
 if(url==='/api/session') return {token:'fixture-local-only'};
 return [];
};
window.fetch=async(url,init={})=>new Response(JSON.stringify(await api(url,undefined,init.method||'GET')),{status:200,headers:{'Content-Type':'application/json'}});
window.EventSource=class {constructor(){this.listeners={};window.fixture.events=this;}addEventListener(name,fn){this.listeners[name]=fn;}close(){}};
const appRoot=createRoot(document.getElementById('root'));
flushSync(()=>appRoot.render(<><Studio/><ConfirmDialogHost/></>));
window.fixture.unmount=()=>flushSync(()=>appRoot.unmount());
`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl' },
      outfile: path.join(fixture, 'fixture.js'),
    });
    const env = { ...process.env, PUGPORT_SEARCH_FIXTURE: fixture };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => child.kill(), 45000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_SEARCH_FIXTURE;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const errors = [];
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const key = async (key, extra = {}, selector = 'document.activeElement') => {
    // A dispatched KeyboardEvent cannot invoke the browser's native dialog cancel action.
    if (key === 'Escape') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    } else {
      await evaluate(
        `(${selector}).dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })}))`,
      );
    }
    await frame();
  };
  const input = async (selector, value) => {
    await evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await frame();
  };
  const waitFor = async (source) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(source)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error('Timeout: ' + source);
  };
  const shot = async (name) => {
    await frame();
    // Resizing an offscreen window invalidates its compositor surface briefly.
    let capture;
    try {
      capture = await win.webContents.capturePage();
    } catch (error) {
      if (!String(error).includes('UnknownVizError')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await frame();
      capture = await win.webContents.capturePage();
    }
    await fs.writeFile(path.join(reports, name + '.png'), capture.toPNG());
  };
  app.whenReady().then(async () => {
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
      win.webContents.session.webRequest.onBeforeRequest((details, done) =>
        done({ cancel: !details.url.startsWith('file://') }),
      );
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error') errors.push(event.message);
      });
      await win.loadFile(path.join(fixture, 'index.html'));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await waitFor('!!document.querySelector(".conversation-workspace textarea")');
      win.setSize(800, 800);
      await frame();
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".studio-topbar")).display'), 'none');
      win.setSize(900, 800);
      await frame();
      assert.equal(
        await evaluate(`(()=>{
        const tabs=[...document.querySelectorAll('.sidebar-filters button')];
        const top=tabs[0].getBoundingClientRect().top;
        return tabs.every(tab=>tab.getBoundingClientRect().top===top&&getComputedStyle(tab).whiteSpace==='nowrap');
      })()`),
        true,
        'activity filters stay on one row at 900 px',
      );
      await evaluate(`(()=>{
        const state=window.fixture.state;
        const flow={id:'activity-running',projectId:'p',conversationId:'main',status:'running',createdAt:'2026-10-01T12:00:00Z',updatedAt:'2026-10-01T12:00:00Z',input:{text:'Synthetic task',mode:'chat'},plan:[],runIds:[]};
        state.workflows=[flow,{...flow,id:'activity-waiting',status:'waiting-approval'}];
        window.fixture.events.listeners.state({data:JSON.stringify(state)});
      })()`);
      await waitFor('!!document.querySelector(".conversation-row .activity-attention")');
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".conversation-row")].every(row=>row.querySelectorAll(".activity-dot,.unread-dot").length<=1)',
        ),
        true,
      );
      await evaluate(
        `window.fixture.state.workflows=[];window.fixture.events.listeners.state({data:JSON.stringify(window.fixture.state)});`,
      );
      win.setSize(1000, 800);
      await frame();
      await evaluate('document.querySelector(".new-conversation-row [aria-label=搜索对话]").click()');
      await waitFor('!!document.querySelector("dialog[open]")');
      assert.equal(
        await evaluate('document.querySelector("dialog[open]").textContent.includes("最多显示 50 条结果")'),
        false,
      );
      await evaluate(`window.fixture.searchCancels=0;
        document.querySelector('.history-search-dialog').addEventListener('cancel',()=>window.fixture.searchCancels++);`);
      await key('Escape');
      await waitFor('!document.querySelector("dialog[open]")');
      assert.equal(await evaluate('window.fixture.searchCancels'), 1, 'Escape invokes native dialog cancellation');
      await key('k', { ctrlKey: true });
      await waitFor('!!document.querySelector(".palette-backdrop")');
      await input('.palette-backdrop input', '搜索对话内容');
      await key('Enter');
      await waitFor('!!document.querySelector("dialog[open]")');
      await input('dialog input', 'needle');
      await waitFor('document.querySelectorAll(".search-results button").length===1');
      assert.equal(await evaluate('document.querySelectorAll(".search-snippet mark").length'), 2);
      for (const theme of ['light', 'dark']) {
        await evaluate(`document.documentElement.dataset.theme='${theme}'`);
        await frame();
        await shot('search-' + theme);
      }
      await key('Enter');
      await waitFor('!!document.querySelector("[data-message-id=m0].pinned-jump-highlight")');
      assert.equal(
        await evaluate('document.querySelector(".conversation-title-line strong").textContent'),
        'Release notes · conversation search',
      );
      assert.equal(
        await evaluate('window.fixture.calls.filter(call=>call.url==="/api/conversations/main?recordOnly=1").length'),
        1,
        'search resolves the durable conversation before selecting it',
      );
      assert.equal(
        await evaluate('window.fixture.calls.filter(call=>call.url==="/api/conversations/main").length'),
        1,
        'search fetches full history only once',
      );
      await key('f', { ctrlKey: true });
      await waitFor('!!document.querySelector(".conversation-find-bar input")');
      await input('.conversation-find-bar input', 'needle');
      await waitFor('document.querySelector(".conversation-find-bar output").textContent==="1/3"');
      assert.equal(await evaluate('CSS.highlights.get("conversation-find").size'), 3);
      const active = () =>
        evaluate(
          '[...CSS.highlights.get("conversation-find-active")][0].startContainer.parentElement.closest("[data-message-id]").dataset.messageId',
        );
      assert.equal(await active(), 'm0');
      await evaluate(`window.fixture.scrolls=0;window.fixture.originalScroll=Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView=function(...args){window.fixture.scrolls++;return window.fixture.originalScroll.apply(this,args)};
        const text=document.querySelector('[data-message-id=m155] .markdown');
        for(let i=0;i<10;i++) text.append(document.createTextNode(' streamed'));
        const timer=document.createElement('span');timer.textContent='elapsed 1s';document.querySelector('.conversation-scroll').append(timer);`);
      await frame();
      await frame();
      assert.equal(await evaluate('window.fixture.scrolls'), 0, 'stream and task mutations do not scroll');
      await key('Enter');
      assert.equal(await evaluate('window.fixture.scrolls'), 1, 'changing the active match scrolls');
      await evaluate('void (Element.prototype.scrollIntoView=window.fixture.originalScroll)');
      assert.equal(await evaluate('document.querySelector(".conversation-find-bar output").textContent'), '2/3');
      await key('Enter');
      assert.equal(await active(), 'm155');
      await key('Enter');
      assert.equal(await active(), 'm0');
      await key('Enter', { shiftKey: true });
      assert.equal(await active(), 'm155');
      assert.ok(
        await evaluate(
          '(()=>{const r=document.querySelector(".conversation-find-bar").getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight})()',
        ),
        'find bar remains visible while navigating',
      );
      for (const theme of ['light', 'dark']) {
        await evaluate(`document.documentElement.dataset.theme='${theme}'`);
        await frame();
        await shot('find-' + theme);
      }
      await input('.conversation-find-bar input', 'absent');
      assert.equal(await evaluate('document.querySelector(".conversation-find-bar output").textContent'), '0/0');
      await key('Escape');
      assert.equal(await evaluate('document.querySelector(".conversation-find-bar")'), null);
      assert.equal(await evaluate('CSS.highlights.get("conversation-find").size'), 0);
      await key('f', { ctrlKey: true });
      await input('.conversation-find-bar input', 'needle');
      await evaluate(
        '[...document.querySelectorAll(".conversation-link")].find(el=>el.textContent.includes("Another conversation")).click()',
      );
      await frame();
      assert.equal(await evaluate('document.querySelector(".conversation-find-bar")'), null);
      await evaluate(
        '[...document.querySelectorAll(".conversation-link")].find(el=>el.textContent.includes("Release notes")).dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}))',
      );
      await waitFor('document.querySelectorAll(".conversation-workspace").length===2');
      await evaluate('document.querySelectorAll(".conversation-workspace textarea")[1].focus()');
      await key('f', { ctrlKey: true });
      await input('.conversation-find-bar input', 'needle');
      await waitFor('document.querySelector(".conversation-find-bar output").textContent==="1/3"');
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".conversation-workspace")[0].querySelectorAll(".conversation-find-bar").length',
        ),
        0,
      );
      assert.equal(
        await evaluate(
          'document.querySelectorAll(".conversation-workspace")[1].querySelectorAll(".conversation-find-bar").length',
        ),
        1,
      );
      await shot('find-split');
      await key('Escape');
      await key('f', { ctrlKey: true, shiftKey: true });
      await waitFor('!!document.querySelector("dialog[open]")');
      await input('dialog input', 'needle');
      await waitFor('document.querySelectorAll(".search-results button").length===1');
      win.setContentSize(400, 800);
      await frame();
      assert.ok(await evaluate('document.body.scrollWidth<=innerWidth'));
      await shot('search-narrow');
      await key('Escape');
      win.setContentSize(1000, 800);
      await frame();
      await evaluate('document.querySelector(".conversation-link[title^=隐身对话]").click()');
      await waitFor('document.querySelector(".conversation-title-line strong").textContent==="隐身对话"');
      for (const accept of [false, true]) {
        await key('f', { ctrlKey: true, shiftKey: true });
        await waitFor('!!document.querySelector("dialog input")');
        await input('dialog input', 'needle');
        await waitFor('document.querySelectorAll(".search-results button").length===1');
        await key('Enter');
        await waitFor('!!document.querySelector(".confirm-dialog[open]")');
        assert.equal(await evaluate('document.querySelectorAll(".confirm-dialog").length'), 1);
        assert.equal(
          await evaluate('window.fixture.calls.filter(call=>call.url.endsWith("/close-incognito")).length'),
          0,
        );
        // Enter now presses the focused button (Cancel by default), so accept by pressing the action button.
        if (accept)
          await evaluate('document.querySelector(".confirm-dialog .modal-actions button:last-child").click()');
        else await key('Escape');
        await waitFor('!document.querySelector("dialog[open]")');
        if (!accept)
          assert.equal(
            await evaluate('document.querySelector(".conversation-title-line strong").textContent'),
            '隐身对话',
          );
      }
      await waitFor('!!document.querySelector("[data-message-id=m0].pinned-jump-highlight")');
      assert.equal(
        await evaluate('window.fixture.calls.filter(call=>call.url.endsWith("/close-incognito")).length'),
        1,
      );
      await evaluate('window.fixture.unmount()');
      assert.deepEqual(errors, []);
      await fs.writeFile(
        path.join(reports, 'renderer.json'),
        JSON.stringify(
          {
            passed: true,
            checks: [
              'palette',
              'shortcut',
              'safe highlights',
              'old history jump',
              'incognito search cancel and one-time confirmation',
              'find count',
              'next previous wrap',
              'inline Markdown match',
              'escape cleanup',
              'conversation switch',
              'split pane focus',
              'light dark narrow',
            ],
            errors,
          },
          null,
          2,
        ),
      );
      console.log(
        'PASS search renderer: palette, shortcut, old-message jump, find count/navigation/highlights, themes and narrow layout',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      if (win) await shot('failure').catch(() => {});
      app.exit(1);
    }
  });
}
