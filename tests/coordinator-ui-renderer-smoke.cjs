// The plan panel of an ordinary chat and a question card in a hidden renderer. Data is synthetic; network is blocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-coordinator-ui-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: '@import "./src/ui/studio.css"; @import "./src/ui/SwarmWorkspace.css";',
          resolveDir: root,
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
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationHistory} from './src/ui/Workspace';
import {SwarmPlanPanel, conversationPlan} from './src/ui/SwarmWorkspace';
import {startInterfaceLanguage} from './src/ui/i18n';
localStorage.setItem('comborunner.locale','zh-CN');
const at='2026-10-27T12:00:00.000Z';
const task=(id,conversationId,patch={})=>({id,projectId:'project',conversationId,userMessageId:'user-'+id,input:{content:id,mode:'build',permissionMode:'workspace-write',executionPolicy:'cli-first'},status:'running',phase:'execute',runIds:[],plan:[],memoryRevision:0,memoryExcerpt:'',createdAt:at,updatedAt:at,...patch});
const copy={
 zh:{items:[['read','读现有路由代码','read'],['write','改写分配逻辑','write'],['lane','在工作线里重做设置页','write'],['docs','更新文档','write']],ask:'帮我把路由改快一点',reply:'路由的读取部分已核对完，改写和设置页正在进行。',question:'设置页要保留旧的高级选项吗？',options:['保留，折叠起来','直接去掉']},
 en:{items:[['read','Read the routing code','read'],['write','Rewrite the assignment logic','write'],['lane','Rebuild the settings page in a lane','write'],['docs','Update the docs','write']],ask:'Make routing faster',reply:'The routing code is checked; the rewrite and the settings page are in progress.',question:'Keep the old advanced options on the settings page?',options:['Keep them, collapsed','Remove them']},
};
const data=(locale)=>{
 const c=copy[locale];
 const items=c.items.map(([id,title,kind])=>({id,title,kind,...(id==='read'?{done:true}:{})}));
 const owner=task('root','chat',{status:'completed',finalMessageId:'reply-root',taskList:{items,updatedAt:at},userQuestion:{text:c.question,options:c.options,askedAt:at}});
 const member=task('member','chat',{delegation:{parentId:'root',role:'worker',requestId:'m',planItem:'write'}});
 const laneRoot=task('lane-root','lane');
 const conversations=[{id:'chat',projectId:'project',title:'Chat',createdAt:at,updatedAt:at},{id:'lane',projectId:'project',title:'Lane',createdAt:at,updatedAt:at,lane:{parentConversationId:'chat',sourceWorkflowId:'root',planItem:'lane'}}];
 const workflows=[owner,member,laneRoot];
 const messages=[{id:'user-root',conversationId:'chat',workflowId:'root',role:'user',content:c.ask,createdAt:at},{id:'reply-root',conversationId:'chat',role:'assistant',content:c.reply,createdAt:at}];
 return {plan:conversationPlan(workflows,conversations,'chat'),workflows:[owner],messages};
};
window.fixture={answers:[]};
const api=async()=>({});
let show;
function Fixture(){
 const [view,setView]=useState(()=>data('zh'));
 show=(locale)=>setView(data(locale));
 return <main style={{maxWidth:760,margin:'24px auto',padding:'0 16px',display:'grid',gap:12}}>
  {view.plan&&<SwarmPlanPanel plan={view.plan}/>}
  <ConversationHistory messages={view.messages} workflows={view.workflows} state={{targets:[],runtimes:[],runs:[],workflows:view.workflows,settings:{}}} api={api} notify={()=>{}} onInspect={()=>{}} onAnswer={(text)=>window.fixture.answers.push(text)}/>
 </main>;
}
window.english=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();show('en');};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<Fixture/>));`,
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_COORDINATOR_UI: fixture };
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
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-coordinator-ui-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_COORDINATOR_UI;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        useContentSize: true,
        width: 900,
        height: 760,
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
      const errors = [];
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.level === 3) errors.push(event.message);
      });
      const evaluate = (source) => win.webContents.executeJavaScript(source);
      const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      const screenshot = async (name) => {
        win.webContents.invalidate();
        await new Promise((done) => setTimeout(done, 150));
        const directory = path.join(root, 'reports/coordinator-ui');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, name), (await win.webContents.capturePage()).toPNG());
      };
      const themes = async (locale) => {
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          await frame();
          assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
          await screenshot(`${locale}-${theme}.png`);
        }
      };
      const card = (label) => `document.querySelector('section[aria-label=${JSON.stringify(label)}]')`;
      await win.loadFile(path.join(fixture, 'index.html'));
      for (let i = 0; i < 40 && !(await evaluate(`!!${card('问题卡')}`)); i++) await frame();
      // Plan panel: one item done, one running through its member, one through its lane, one queued.
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.swarm-plan-item')].map((row)=>row.className.split(' ')[1])"),
        ['done', 'running', 'running', 'queued'],
      );
      assert.match(await evaluate('document.body.textContent'), /读现有路由代码[\s\S]*在工作线里重做设置页/);
      // Question card: two buttons under the final reply, the first primary; a click sends that option.
      assert.equal(await evaluate(`${card('问题卡')}.querySelectorAll('button').length`), 2);
      assert.equal(await evaluate(`${card('问题卡')}.querySelector('button').className`), 'button primary');
      assert.equal(
        await evaluate(
          `document.body.textContent.indexOf('正在进行') < document.body.textContent.indexOf('设置页要保留旧的高级选项吗')`,
        ),
        true,
      );
      await themes('zh');
      await evaluate(`${card('问题卡')}.querySelectorAll('button')[1].click()`);
      assert.deepEqual(await evaluate('window.fixture.answers'), ['直接去掉']);
      await evaluate('window.english()');
      for (let i = 0; i < 40 && !(await evaluate(`!!${card('Question card')}`)); i++) await frame();
      assert.match(await evaluate('document.body.textContent'), /Rebuild the settings page in a lane/);
      assert.equal(await evaluate(`${card('Question card')}.querySelectorAll('button').length`), 2);
      await themes('en');
      win.setContentSize(390, 900);
      await frame();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await screenshot('en-dark-narrow.png');
      assert.deepEqual(errors, []);
      console.log('PASS coordinator UI renderer: plan panel, question card, answer click, zh/en, light/dark, narrow');
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
