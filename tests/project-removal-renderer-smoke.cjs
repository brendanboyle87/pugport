// Real Studio and in-app confirmation in a hidden Electron window, with synthetic fetch/SSE only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-project-remove-ui-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          contents: "@import './src/ui/studio.css'; @import './src/ui/composer.css'; @import './src/ui/settings.css';",
          loader: 'css',
        },
        bundle: true,
        outfile: path.join(fixture, 'style.css'),
      });
      await require('esbuild').build({
        stdin: {
          resolveDir: root,
          loader: 'tsx',
          contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Studio from './src/ui/Studio';
import {ConfirmDialogHost} from './src/ui/ConfirmDialog';
import {startInterfaceLanguage} from './src/ui/i18n';
const stamp='2026-10-13T20:00:00.000Z';
const project={id:'project',name:'Synthetic project',path:'C:/Synthetic/missing',folderMissing:true,createdAt:stamp,updatedAt:stamp};
const chat={id:'chat',projectId:'project',title:'Synthetic chat',pinnedAt:stamp,createdAt:stamp,updatedAt:stamp};
localStorage.setItem('agent-studio-conversation','chat');
localStorage.setItem('agent-studio-project','project');
localStorage.setItem('comborunner.locale','en');
window.fixture={calls:[],state:{app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'fixture'},
settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,defaultProjectPath:'C:/Synthetic',maxConcurrentRuns:1},
targets:[],runtimes:[],runs:[],approvals:[],plugins:[],refreshing:false,projects:[project],removedProjects:[],conversations:[chat],workflows:[],conversationMessages:[],backgroundTasks:[],tasteTests:[],conversationFolders:[]}};
const f=window.fixture;
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';f.calls.push({path:url,method});
 if(url==='/api/modes'){
  if(method!=='GET')throw Error('Mode catalog must use GET');
  return response({catalog:[],installed:[]});
 }
 if(url==='/api/conversation-history')return response({archived:0,deleted:0,purge:{count:0,olderCount:0,token:'a'.repeat(64)}});
 if(url==='/api/session')return response({token:'synthetic'});
 if(url==='/api/state')return response(f.state);
 if(url==='/api/projects/project/purge-preview'){
  if(method!=='GET')throw Error('Project purge preview must use GET');
  return response({projectId:project.id,name:project.name,token:'a'.repeat(64),conversations:1,attachments:0,managedFiles:0,managedBytes:0,preservedProjectPath:project.path,canPurge:true,partial:false});
 }
 if(url==='/api/projects/project'&&method==='DELETE'){
  f.state.projects=[];f.state.conversations=[];f.state.removedProjects=[{...project,removedAt:stamp}];return response({});
 }
 if(url==='/api/projects/project/restore'){
  f.state.projects=[project];f.state.conversations=[chat];f.state.removedProjects=[];return response(project);
 }
 if(url==='/api/projects/project/move-to-chats'){
  if(f.holdMove)await new Promise(done=>{f.finishMove=done});
  Object.assign(project,{scope:'chat',name:'日常对话',path:'C:/Synthetic/workspaces/new',folderMissing:false});
  return response(project);
 }
 if(url==='/api/conversations/chat')return response({conversation:chat,messages:[],workflows:[],runs:[]});
 return response({});
};
window.EventSource=class {addEventListener(){}close(){}};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<><Studio/><ConfirmDialogHost/></>));
`,
        },
        bundle: true,
        platform: 'browser',
        loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_PROJECT_REMOVE_UI: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => child.kill(), 30000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-project-remove-ui-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_PROJECT_REMOVE_UI;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        width: 1200,
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
      const evaluate = (source) =>
        win.webContents.executeJavaScript(source).catch((error) => {
          throw new Error(`Renderer evaluation failed: ${source}`, { cause: error });
        });
      const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      const click = async (selector) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));})()`,
        );
        await frame();
      };
      const screenshot = async (name, selector) => {
        await fs.mkdir(path.join(root, 'reports/shots'), { recursive: true });
        const rect = selector
          ? await evaluate(
              `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`,
            )
          : undefined;
        await fs.writeFile(path.join(root, 'reports/shots', name), (await win.webContents.capturePage(rect)).toPNG());
      };
      const load = async () => {
        await win.loadFile(path.join(fixture, 'index.html'));
        for (let i = 0; i < 60 && !(await evaluate("!!document.querySelector('.project-missing')")); i++) await frame();
      };
      await load();
      for (const theme of ['light', 'dark']) {
        await evaluate(`localStorage.setItem('agent-studio-theme',${JSON.stringify(theme)})`);
        await load();
        assert.equal(await evaluate('document.documentElement.lang'), 'en');
        assert.match(await evaluate("document.querySelector('.project-missing').textContent"), /Move to Chats/);
        assert.match(
          await evaluate("document.querySelector('.composer-missing-folder').textContent"),
          /This project's folder is unavailable. You can keep chatting; normal access comes back automatically when the folder returns./,
        );
        await evaluate(
          `(()=>{const input=document.querySelector('#conversation-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Keep this draft');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
        );
        await frame();
        assert.equal(await evaluate("document.querySelector('.composer-missing-folder button')"), null);
        assert.equal(
          await evaluate("document.querySelector('.conversation-composer button[type=submit]').disabled"),
          false,
        );
        const layout = await evaluate(`(()=>{
          const row=document.querySelector('.project-missing'), label=row.querySelector('span'), actions=row.querySelector('.project-missing-actions');
          const r=row.getBoundingClientRect();
          const notice=document.querySelector('.composer-missing-folder span').getBoundingClientRect(), size=document.querySelector('.composer-size').getBoundingClientRect();
          return {width:r.width,labelAbove:label.getBoundingClientRect().bottom<=actions.getBoundingClientRect().top,
            composerFits:notice.right<=size.left,
            fits:[label,...actions.querySelectorAll('button')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&el.scrollWidth<=el.clientWidth})};
        })()`);
        assert.ok(layout.width <= 220, JSON.stringify(layout));
        assert.ok(layout.labelAbove && layout.fits && layout.composerFits, JSON.stringify(layout));
        await screenshot(`missing-folder-${theme}.png`);
        await screenshot(`missing-folder-sidebar-${theme}.png`, '.project-missing');
        await screenshot(`missing-folder-composer-${theme}.png`, '.composer-missing-folder');
        await evaluate('window.fixture.holdMove=true');
        await click('.project-missing button:first-child');
        assert.equal(await evaluate("document.querySelector('.composer-missing-folder button')"), null);
        assert.equal(await evaluate("document.querySelector('.project-missing button:first-child').disabled"), true);
        await evaluate("document.querySelector('.project-missing button:first-child').click()");
        assert.equal(
          await evaluate(
            "window.fixture.calls.filter(c=>c.path==='/api/projects/project/move-to-chats'&&c.method==='POST').length",
          ),
          1,
        );
        await evaluate('window.fixture.finishMove()');
        await frame();
        assert.equal(await evaluate("document.querySelector('#conversation-input').value"), 'Keep this draft');
        assert.equal(await evaluate("document.querySelector('.composer-missing-folder')"), null);
        assert.equal(await evaluate("document.querySelector('.sidebar-project')"), null);
        assert.match(await evaluate("document.querySelector('.conversation-link').textContent"), /Synthetic chat/);
        assert.match(await evaluate('document.body.textContent'), /Moved to Chats\./);
      }
      await load();
      await evaluate('window.fixture.holdMove=true');
      await click('.project-missing button:first-child');
      assert.equal(await evaluate("document.querySelector('.project-missing button:first-child').disabled"), true);
      assert.equal(await evaluate("document.querySelector('.composer-missing-folder button')"), null);
      assert.equal(
        await evaluate("window.fixture.calls.filter(c=>c.path==='/api/projects/project/move-to-chats').length"),
        1,
      );
      await evaluate('window.fixture.finishMove()');
      await frame();
      await load();
      await click('.project-more');
      assert.match(await evaluate("document.querySelector('.context-menu').textContent"), /Rename/);
      assert.match(await evaluate("document.querySelector('.context-menu').textContent"), /Remove from list/);
      await screenshot('project-menu.png');
      await evaluate(
        "[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent.includes('Remove from list')).click()",
      );
      await frame();
      assert.equal(
        await evaluate("document.querySelector('dialog h2').textContent"),
        "Remove this project from PugPort? Files on disk won't be deleted.",
      );
      await screenshot('project-confirm.png');
      await click('dialog button');
      assert.equal(await evaluate("window.fixture.calls.filter(c=>c.method==='DELETE').length"), 0);
      await click('.project-missing button:last-child');
      await click('dialog .danger');
      assert.equal(await evaluate("document.querySelectorAll('.sidebar-project').length"), 0);
      assert.equal(await evaluate("document.querySelectorAll('.conversation-link').length"), 0);
      await evaluate(
        "[...document.querySelectorAll('.sidebar-tools .nav-item')].find(b=>b.textContent.trim()==='Settings').click()",
      );
      await frame();
      await click('[data-settings-category="conversation"]');
      await click('[aria-label="Manage removed projects"]');
      assert.equal(
        await evaluate("document.querySelectorAll('#settings-removed-projects .removed-project-settings-row').length"),
        1,
      );
      await click('#settings-removed-projects .removed-project-settings-row summary');
      for (
        let i = 0;
        i < 60 &&
        (await evaluate("document.querySelector('.removed-project-settings-actions button:first-child').disabled"));
        i++
      )
        await frame();
      await evaluate("document.querySelector('#settings-removed-projects').scrollIntoView({block:'center'})");
      await frame();
      await screenshot('removed-projects.png');
      assert.equal(
        await evaluate("document.querySelector('.removed-project-settings-actions button:first-child').disabled"),
        false,
      );
      await click('.removed-project-settings-actions button:first-child');
      assert.equal(await evaluate("document.querySelectorAll('.sidebar-project').length"), 1);
      assert.match(await evaluate("document.querySelector('.conversation-link').textContent"), /Synthetic chat/);
      assert.equal(await evaluate("window.fixture.calls.filter(c=>c.method==='DELETE').length"), 1);
      console.log(
        'PASS project renderer: English light/dark narrow layout, pinned chat, informational composer with enabled send, manual sidebar move, draft preserved, menu, confirm, cancel, remove, Settings Chat restore, offscreen screenshots',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
