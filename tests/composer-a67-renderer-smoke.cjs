// Synthetic, hidden Electron renderer: no application backend, account or executor calls.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'reports', 'composer-a67');
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-a67-renderer-'));
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(fixture, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await require('esbuild').build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationWorkspace} from './src/ui/Workspace';
import './src/ui/studio.css';
import './src/ui/composer.css';
import './src/ui/SideChatPanel.css';
const stamp='2026-10-13T12:00:00Z';
const project={id:'project',name:'Composer demo',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const conversation={id:'chat',projectId:project.id,title:'Composer demo',createdAt:stamp,updatedAt:stamp};
const target={id:'fixture',provider:'codex',label:'Fixture executor',enabled:true,environment:'native'};
const runtime={...target,installed:true,status:'ready',defaultModel:'fixture-model',models:[{id:'fixture-model',label:'Fixture model',efforts:['low','high']}],capabilities:{execute:true},quota:{status:'known',windows:[]}};
const state={app:{name:'Fixture',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},projects:[project],conversations:[conversation],targets:[target],runtimes:[runtime],runs:[],workflows:[],approvals:[],plugins:[],conversationMessages:[{id:'old',conversationId:'chat',role:'user',content:'Review the composer interaction.',createdAt:stamp}]};
window.requests=[];window.notices=[];
const api=async(path,body,method)=>{
 if(path.includes('/files?'))return [{path:'src/ui/Workspace.tsx',kind:'file'},{path:'src/ui',kind:'folder'}];
 if(body)window.requests.push({path,body,method});
 if(path.endsWith('/messages')&&body)return {message:{id:'sent',conversationId:'chat',role:'user',content:body.content,createdAt:stamp}};
 return {messages:[],workflows:[]};
};
const root=createRoot(document.getElementById('root'));
window.renderFixture=()=>flushSync(()=>root.render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={state} api={api} project={project} conversation={conversation} notify={notice=>window.notices.push(notice)} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>));
window.ctrlMode=()=>{state.settings.composerSendKey='ctrl-enter';window.renderFixture();};
window.renderFixture();`,
      },
      bundle: true,
      platform: 'browser',
      outfile: path.join(fixture, 'fixture.js'),
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    });
    const env = { ...process.env, PUGPORT_A67_RENDERER: fixture };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => child.kill(), 45000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timeout));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_A67_RENDERER;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-a67-renderer-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const checks = [];
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const fill = async (value) => {
    await evaluate(
      `(()=>{const input=document.querySelector('#conversation-input');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await frame();
  };
  const key = async (key, extra = {}) => {
    await evaluate(
      `document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, bubbles: true, cancelable: true, ...extra })}))`,
    );
    await frame();
  };
  const check = async (expression, label) => {
    assert.equal(await evaluate(expression), true, label);
    checks.push(label);
  };
  const shot = async (name) =>
    fs.writeFile(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
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
      await fill('/');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await shot('slash-menu');
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.composer-command-menu [role=option] code')].map(node=>node.textContent)",
        ),
        ['/搜索', '/plan', '/side', '/new'],
        'slash menu exposes the supported conversation and execution actions',
      );
      checks.push('slash menu exposes conversation and execution actions');
      await fill('/sea');
      await check("document.querySelectorAll('.composer-command-menu [role=option]').length===1", 'slash filtering');
      await fill('@src');
      await new Promise((resolve) => setTimeout(resolve, 220));
      await frame();
      await shot('file-menu');
      await check(
        "document.querySelectorAll('.composer-command-menu [role=option]').length===2",
        'file menu loads files and folders',
      );
      await key('Enter');
      await check(
        "document.querySelector('#conversation-input').value.includes('src/ui/Workspace.tsx')",
        'file choice inserts relative reference',
      );
      await key('Enter');
      await check(
        'window.requests.at(-1).body.content===\'"src/ui/Workspace.tsx"\'',
        'reference reaches message payload',
      );
      await fill('@');
      await key('Escape');
      await check("document.querySelector('#conversation-input').value==='@'", 'unselected @ remains text');
      await fill('');
      await key('ArrowUp');
      await check(
        "document.querySelector('#conversation-input').value==='\"src/ui/Workspace.tsx\"'",
        'Up recalls latest acknowledged user text before broadcast',
      );
      await evaluate('window.ctrlMode()');
      await fill('Ctrl send');
      const count = await evaluate('window.requests.length');
      await key('Enter');
      assert.equal(await evaluate('window.requests.length'), count);
      checks.push('plain Enter does not send in Ctrl mode');
      await key('Enter', { ctrlKey: true });
      await check("window.requests.at(-1).body.content==='Ctrl send'", 'Ctrl+Enter sends');
      await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
      console.log(
        JSON.stringify({ passed: checks.length, failed: 0, screenshots: ['slash-menu.png', 'file-menu.png'] }),
      );
    } catch (error) {
      console.error(error);
      console.error(
        await evaluate(
          "JSON.stringify({menus:[...document.querySelectorAll('.chip-menu')].map(x=>x.getAttribute('aria-label')),active:document.activeElement?.outerHTML,input:document.querySelector('#conversation-input').value})",
        ),
      );
      await fs.writeFile(
        path.join(out, 'result.json'),
        JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
      );
      process.exitCode = 1;
    } finally {
      win?.destroy();
      app.exit(process.exitCode ?? 0);
    }
  });
}
