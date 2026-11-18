// Real Studio and in-app confirmation in a hidden Electron window, with synthetic fetch/SSE only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const english = require(path.join(root, 'src/shared/i18n/en.json'));
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-settings-categories-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: require('fs')
            .readFileSync(path.join(root, 'src/ui/main.tsx'), 'utf8')
            .split('\n')
            .filter((line) => /^import ['"].*(?:css|fontsource).*['"];/.test(line))
            .map((line) => '@import ' + line.slice(7))
            .join('\n'),
          resolveDir: path.join(root, 'src/ui'),
          loader: 'css',
        },
        bundle: true,
        outfile: path.join(fixture, 'style.css'),
        loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
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
import {ImageViewer} from './src/ui/ImageViewer';
window.previewImage=()=>{const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const close=()=>{root.unmount();host.remove()};const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440"><rect width="720" height="440" fill="#85b8b0"/><circle cx="360" cy="190" r="90" fill="#f3ead8"/><path d="M0 440L240 240L420 440L600 290L720 440" fill="#325d66"/></svg>');root.render(<ImageViewer images={[{src,name:'Synthetic landscape.svg'}]} index={0} onIndex={()=>{}} onClose={close}/>);};
import {startInterfaceLanguage} from './src/ui/i18n';
window.english=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();};
import { extensionCatalog } from './src/shared/extensions';
const stamp='2026-10-13T20:00:00.000Z';
const project={id:'project',name:'示例项目',path:'C:/Synthetic',createdAt:stamp,updatedAt:stamp};
const chat={id:'chat',projectId:'project',title:'示例对话',createdAt:stamp,updatedAt:stamp};
localStorage.setItem('agent-studio-conversation','chat');
localStorage.setItem('agent-studio-project','project');
localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('locale') || localStorage.getItem('comborunner.locale') || 'zh-CN');
window.fixture={calls:[],state:{app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'fixture'},
settings:{designProvider:'claude',architectureProvider:'codex',routineProvider:'codex',automaticExecutors:['claude'],toolApprovalMode:'ask',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,defaultProjectPath:'C:/Synthetic',maxConcurrentRuns:1},
targets:[{id:'claude',provider:'claude',label:'Anthropic',enabled:true,command:'fixture',environment:'native'}],runtimes:[{id:'claude',provider:'claude',label:'Anthropic',status:'ready',models:[{id:'opus',label:'Opus 5.5',efforts:['high','max']},{id:'sonnet',label:'Sonnet 5.5',efforts:['high']},...Array.from({length:16},(_,i)=>({id:'synthetic-'+i,label:'Synthetic model '+i,efforts:[]}))]}],runs:[],approvals:[],plugins:[],refreshing:false,projects:[project],removedProjects:[],conversations:[chat],workflows:[],conversationMessages:[],backgroundTasks:[],tasteTests:[],conversationFolders:[]}};
const f=window.fixture;
const originalInterval=window.setInterval, originalClear=window.clearInterval;
window.activeIntervals=new Map();
window.setInterval=(fn,ms,...args)=>{ const id=originalInterval(fn,ms,...args);window.activeIntervals.set(id,ms);if(ms===4000)window.pollSlack=fn;return id; };
window.clearInterval=id=>{window.activeIntervals.delete(id);originalClear(id);};
window.permissionCalls=[];window.allowPermission=false;
window.comboRunnerDesktop={pickDirectory:async()=>null,launchAtLogin:async(value)=>value??false,blackout:async()=>{},blackoutShortcut:async(value)=>({shortcut:value??'Ctrl+Alt+B',registered:true}),quickChatSettings:async(patch)=>({enabled:true,shortcut:'Alt+Space',target:'everyday',registered:true,...patch}),changePermission:async change=>{window.permissionCalls.push(change);return window.allowPermission;}};
const grokMessage={id:'grok-reply',conversationId:'chat',role:'assistant',content:'Grok Bot 需要设置例程。',createdAt:stamp,externalAgent:{agentId:'grok-bot',name:'Grok Bot',status:'needs-user',handoff:true,untrusted:true,request:'Synthetic',updatedAt:stamp}};
f.state.conversationMessages=JSON.parse(localStorage.getItem('batch1a-preview') || 'null') ?? [grokMessage];
f.models=f.state.runtimes[0].models;
window.broadcast=()=>f.listeners.state({data:JSON.stringify(f.state)});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';f.calls.push({path:url,method,body:init.body?JSON.parse(init.body):undefined});
 if(url==='/api/settings' && method==='PATCH'){if(f.holdSettings)await new Promise(done=>f.releaseSettings=done);Object.assign(f.state.settings,JSON.parse(init.body));return response({});}
 if(url==='/api/laya/status')return response({settings:f.state.settings.laya||{},status:{state:'disabled',modelVersion:'pugport-laya-v4'},training:{directory:'C:/Synthetic/routing-training',recording:f.state.settings.laya?.recordTraining!==false}});
 if(url==='/api/app-info')return response({paths:{dataDir:'C:/Synthetic',memoryDir:'C:/Synthetic/memory'},tools:{}});
 if(url==='/api/web-search')return response({provider:'deepseek',enabled:false,configured:false,monthlyLimitCny:5,month:'2026-10',usage:{requests:0,billableRequests:0,uncertainRequests:0,estimatedCostCny:0,reservedCny:0}});
 if(url==='/api/session')return response({token:'synthetic'});
 if(url==='/api/sandbox/learning')return response([]);
 if(url.includes('archived-conversations') || url.includes('deleted-conversations') || url.includes('scheduled-tasks'))return response([]);
 if(url==='/api/state')return response(f.state);
 if(url==='/api/external-agents' && f.agentsError)return new Response(JSON.stringify({error:'Synthetic offline'}),{status:503,headers:{'Content-Type':'application/json'}});
 if(url==='/api/external-agents')return response({agents:[
 {id:'grok-bot',name:'Grok Bot',kind:'handoff',description:'发给 Grok Bot，回复后回来粘贴',enabled:true,available:true,routine:{url:'https://synthetic.invalid/routine'}},
 {id:'muse',name:'Muse',kind:'web',description:'',enabled:false,available:false,url:'https://synthetic.invalid'}]});
 if(url==='/api/external/connections')return response({tools:[{id:'codex',name:'Codex',detected:true,state:'connected',method:'file',configPath:'/synthetic/config.toml',server:'pugport',manual:'synthetic'}],snippet:'synthetic'});
 if(url==='/api/external/terminal-command') {
  if(f.holdTerminal)await new Promise(done=>f.releaseTerminal=done);
  if(f.terminalError)return new Response(JSON.stringify({error:'Synthetic PATH denied'}),{status:500,headers:{'Content-Type':'application/json'}});
  if(method==='POST')f.terminalInstalled=true;
  if(method==='DELETE')f.terminalInstalled=false;
  return response({folder:'C:/Synthetic/PugPort/dist/bin',automatic:!f.manualTerminal,manualLine:f.manualTerminal?'fish_add_path -- /synthetic/PugPort/dist/bin':undefined,installed:!!f.terminalInstalled});
 }
 if(url==='/api/slack'){
  if(f.slackHttpError)return new Response(JSON.stringify({...f.slack,error:'Synthetic request failed'}),{status:503,headers:{'Content-Type':'application/json'}});
  if(method==='PATCH')Object.assign(f.slack,JSON.parse(init.body));
  return response(f.slack || {enabled:false,status:'off',users:[],activeTasks:0});
 }
 if(url.startsWith('/api/slack/users/') && method==='DELETE'){f.slack.users=[];return response(f.slack);}
 if(url.startsWith('/api/devices'))return response({devices:[{id:'mac-build',name:'Mac 构建机',address:'synthetic.invalid',pairedAt:stamp,platform:'darwin',online:true,executors:[]},{id:'linux-home',name:'家里的电脑',address:'synthetic.invalid',pairedAt:stamp,online:false,reason:'设备未连接'}],slackHost:null});
 if(url==='/api/extensions' || url.startsWith('/api/extensions?'))return response({items:[],catalog:extensionCatalog});
 if(url==='/api/modes')return response({catalog:[{id:'example.finance',title:'个人财务',permissions:['connections:read']}],installed:[]});
 if(url==='/api/bank/settings')return response({configured:true,environment:'sandbox',clientIdEnding:'0001',sandboxSecret:true,productionSecret:false});
 if(url==='/api/bank/connections')return response({connections:[
  {id:'conn_synthetic01',provider:'plaid',environment:'sandbox',institution:{id:'ins_1',name:'Synthetic Credit Union'},status:'connected',lastSyncedAt:stamp,products:['transactions','liabilities'],modIds:['example.finance']},
  {id:'conn_synthetic02',provider:'plaid',environment:'sandbox',institution:{id:'ins_2',name:'Synthetic Card Bank'},status:'reauth_required',lastSyncedAt:stamp,error:{code:'ITEM_LOGIN_REQUIRED',message:'The bank needs you to sign in again.'},products:['transactions'],modIds:[]}]});
 if(url==='/api/mod-data')return response({mods:[{modId:'example.finance',items:1840,bytes:2400000}]});
 if(url==='/api/tool-installations')return response({installations:[]});
 if(url==='/api/slack/admission' || url==='/api/github/admission')return response({version:1,rules:[]});
 if(url==='/api/conversations/chat')return response({conversation:chat,messages:f.state.conversationMessages,workflows:[],runs:[]});
 return response({});
};
window.EventSource=class {constructor(){f.listeners={}}addEventListener(name,fn){f.listeners[name]=fn}close(){}};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<><Studio/><ConfirmDialogHost/></>));
`,
        },
        bundle: true,
        platform: 'browser',
        loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_SETTINGS_CATEGORIES: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      const timer = setTimeout(() => child.kill(), 120000);
      process.exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', (code) => done(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-settings-categories-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_SETTINGS_CATEGORIES;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', (event) => event.preventDefault());
  let win;
  void app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        useContentSize: true,
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
      win.webContents.setFrameRate(240);
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      const rendererErrors = [];
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.level === 3) {
          rendererErrors.push(event.message);
          console.error(event.message);
        }
      });
      const evaluate = (source) =>
        win.webContents.executeJavaScript(source).catch((error) => {
          console.error(source);
          throw error;
        });
      const frame = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      const click = async (selector) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));})()`,
        );
        await frame();
      };
      const pointer = async (selector, type) => {
        const point = await evaluate(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`,
        );
        win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
        await frame();
      };
      const screenshotsDir = path.join(
        root,
        process.env.PUGPORT_UI_SIMPLIFY_B ? 'artifacts/ui-simplify-b' : 'reports/settings-categories',
      );
      let captured = false;
      const screenshot = async (name) => {
        await frame();
        const expected = { width: win.getContentBounds().width, height: 800 };
        if (!process.env.PUGPORT_SETTINGS_SCREENSHOTS && captured) {
          let size = await evaluate('({width:innerWidth,height:innerHeight})');
          for (
            let attempt = 0;
            attempt < 15 && (size.width !== expected.width || size.height !== expected.height);
            attempt++
          ) {
            await frame();
            size = await evaluate('({width:innerWidth,height:innerHeight})');
          }
          assert.deepEqual(size, expected);
          return;
        }
        // Repaint the whole hidden window; partial offscreen paints can omit unchanged controls.
        win.webContents.invalidate();
        if (process.env.PUGPORT_UI_SIMPLIFY_B) await new Promise((resolve) => setTimeout(resolve, 150));
        let capture = await win.webContents.capturePage();
        for (
          let attempt = 0;
          attempt < 15 && (capture.getSize().width !== expected.width || capture.getSize().height !== expected.height);
          attempt++
        ) {
          win.webContents.invalidate();
          await new Promise((resolve) => setTimeout(resolve, 20));
          capture = await win.webContents.capturePage();
        }
        assert.deepEqual(capture.getSize(), expected);
        captured = true;
        if (process.env.PUGPORT_SETTINGS_SCREENSHOTS) {
          await fs.mkdir(screenshotsDir, { recursive: true });
          await fs.writeFile(path.join(screenshotsDir, name), capture.toPNG());
        }
      };
      await win.loadFile(path.join(fixture, 'index.html'));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (let i = 0; i < 20 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      const nav = async (label) => {
        await evaluate(
          "[...document.querySelectorAll('.sidebar-tools button')].find(b=>b.textContent===" +
            JSON.stringify(label) +
            ').click()',
        );
        await frame();
      };
      const fits = async () => assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      const model = () => evaluate('document.querySelector(\'select[aria-label="任务模型"]\').value');
      const choose = async (label, value) => {
        await evaluate(
          `(()=>{const el=document.querySelector('select[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await frame();
      };
      const category = async (id) => {
        if (!(await evaluate("!!document.querySelector('.settings-shell')"))) {
          await evaluate("document.querySelector('.sidebar-tools button:last-child').click()");
          await frame();
        }
        await click('[data-settings-category="' + id + '"]');
        await evaluate("document.querySelector('.management-main').scrollTop = 0");
        await frame();
        if (id === 'devices') {
          assert.equal(
            await evaluate(`(()=>{
              const heading=document.querySelector('.settings-category-heading');
              const action=document.querySelector('.settings-header-action .external-agent-head > button');
              const group=document.querySelector('.settings-content .settings-group');
              return heading.contains(action) && action.getBoundingClientRect().top>=heading.getBoundingClientRect().top && action.getBoundingClientRect().bottom<=heading.getBoundingClientRect().bottom && group.getBoundingClientRect().top>=heading.getBoundingClientRect().bottom;
            })()`),
            true,
            'add control shares the category heading row, above the groups',
          );
        }
      };
      const extension = async (tab) => {
        if (!(await evaluate("!!document.querySelector('.extensions-home')"))) await click('.sidebar-extensions');
        await click('#extensions-tab-' + tab);
        await evaluate("document.querySelector('.management-main').scrollTop = 0");
        await frame();
        if (tab === 'skills' || tab === 'connections') {
          assert.equal(
            await evaluate(`(()=>{
            const heading=document.querySelector('.extensions-heading');
            const action=document.querySelector('.settings-add > button');
            return heading.contains(action);
          })()`),
            true,
            'add control belongs to the Extensions heading',
          );
        }
      };
      const currentExtension = () =>
        evaluate(
          "document.querySelector('.extensions-home [role=tab][aria-selected=true]').id.replace('extensions-tab-','')",
        );
      const key = async (keyCode) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        if (keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        await frame();
      };
      const roving = async (selector) => {
        assert.deepEqual(
          await evaluate(
            `Array.from(document.querySelectorAll('${selector} [role=radio]'), el => [el.tabIndex, el.getAttribute('aria-checked')])`,
          ),
          await evaluate(
            `Array.from(document.querySelectorAll('${selector} [role=radio]'), el => [el.getAttribute('aria-checked') === 'true' ? 0 : -1, el.getAttribute('aria-checked')])`,
          ),
        );
        assert.equal(await evaluate(`document.querySelectorAll('${selector} [role=radio][tabindex="0"]').length`), 1);
      };
      const current = () =>
        evaluate("document.querySelector('[data-settings-category][aria-current=page]').dataset.settingsCategory");
      const counts = () =>
        evaluate('[...window.activeIntervals.values()].filter(ms=>[4000,5000,30000].includes(ms)).sort((a,b)=>a-b)');
      const setText = async (selector, value) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await frame();
      };
      if (process.env.PUGPORT_UI_SIMPLIFY_B) {
        await require('./helpers/ui-simplify-settings-renderer.cjs')({
          win,
          evaluate,
          frame,
          click,
          category,
          choose,
          fits,
          screenshot,
          english,
        });
        assert.deepEqual(rendererErrors, []);
        await new Promise((resolve) =>
          process.stdout.write('PASS UI simplify B: settings interactions and screenshots\n', resolve),
        );
        win.destroy();
        app.exit(0);
        return;
      }
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.sidebar-tools button')].map(b=>b.textContent)"),
        ['扩展', '任务列表', '用量与连接', '设置'],
      );
      const extensionReads = await evaluate("window.fixture.calls.filter(c=>c.path==='/api/extensions').length");
      await extension('mods');
      assert.equal(await evaluate("!!document.querySelector('.mode-store')"), true);
      assert.equal(await evaluate("[...document.querySelectorAll('h1')].some(h=>h.textContent==='Mods Store')"), false);
      assert.equal(await evaluate("!!document.querySelector('[data-settings-item=skills]')"), false);
      assert.equal(await evaluate("window.fixture.calls.filter(c=>c.path==='/api/extensions').length"), extensionReads);
      await nav('设置');
      assert.equal(await evaluate("document.querySelectorAll('[data-settings-category]').length"), 7);
      assert.equal(
        await evaluate(
          "!!document.querySelector('[data-settings-category=extensions],[data-settings-category=connect]')",
        ),
        false,
      );
      assert.deepEqual(await counts(), []);
      assert.equal(
        await evaluate(
          "window.fixture.calls.some(c=>['/api/external/connections','/api/devices','/api/external-agents'].includes(c.path))",
        ),
        false,
      );
      await click('.conversation-link');
      await setText('#conversation-input', 'Unsaved language-switch draft');
      await nav('设置');
      await category('general');
      await evaluate(
        "[...document.querySelectorAll('.language-options button')].find(b=>b.textContent==='English').click()",
      );
      await frame();
      assert.equal(await evaluate("localStorage.getItem('comborunner.locale')"), 'zh-CN');
      assert.match(await evaluate("document.querySelector('.notice-info').textContent"), /草稿/);
      await click('.conversation-link');
      assert.equal(
        await evaluate("document.querySelector('#conversation-input').value"),
        'Unsaved language-switch draft',
      );
      await setText('#conversation-input', '');
      await nav('设置');
      await category('general');
      const terminalRow = async (theme, width) => {
        const row =
          "[...document.querySelectorAll('.settings-row')].find(r=>r.querySelector('.settings-row-expand')?.textContent==='终端')";
        const button = async (label) => {
          await evaluate(
            `(()=>{const row=${row};const button=[...row.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing terminal action');button.click();})()`,
          );
          await frame();
        };
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await screenshot(`${theme}-terminal-before-${width}.png`);
        await button('加入 PATH');
        assert.equal(await evaluate(`(${row}).textContent.includes('已加入')`), true);
        assert.equal(
          await evaluate(`(${row}).textContent.includes('新开一个终端窗口后可用（已打开的 VS Code 需要重启）')`),
          true,
        );
        await button('终端');
        await fits();
        await screenshot(`${theme}-terminal-after-${width}.png`);
        await evaluate('window.fixture.terminalError=true');
        await button('从 PATH 移除');
        assert.equal(await evaluate(`(${row}).querySelector('[role=alert]').textContent`), 'Synthetic PATH denied');
        await screenshot(`${theme}-terminal-error-${width}.png`);
        await evaluate('window.fixture.terminalError=false');
        await button('重试');
        assert.equal(await evaluate(`(${row}).textContent.includes('已加入')`), false);
        await button('终端');
        await category('general');
        await evaluate('window.fixture.terminalInstalled=true');
        await extension('connections');
        assert.equal(await evaluate(`(${row}).textContent.includes('新开一个终端窗口')`), false);
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await screenshot(`${theme}-terminal-persisted-${width}.png`);
        await category('general');
        await evaluate('window.fixture.terminalInstalled=false;window.fixture.holdTerminal=true');
        await extension('connections');
        assert.equal(await evaluate(`(${row}).querySelector('.settings-row-actions button').disabled`), true);
        assert.equal(await evaluate(`(${row}).textContent.includes('正在检查…')`), true);
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await screenshot(`${theme}-terminal-checking-${width}.png`);
        await evaluate('window.fixture.holdTerminal=false;window.fixture.releaseTerminal()');
        await frame();
        await category('general');
        await evaluate('window.fixture.manualTerminal=true');
        await extension('connections');
        assert.equal(
          await evaluate(`(${row}).querySelector('.settings-row-actions button').textContent.trim()`),
          '复制命令',
        );
        await evaluate(`(${row}).scrollIntoView({block:'center'})`);
        await fits();
        await screenshot(`${theme}-terminal-manual-${width}.png`);
        await category('general');
        await evaluate('window.fixture.manualTerminal=false');
        await extension('connections');
      };
      for (const theme of ['light', 'dark']) {
        win.setContentSize(1280, 800);
        await frame();
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        for (const id of ['general', 'personal', 'conversation', 'routing', 'devices', 'permissions', 'advanced']) {
          await category(id);
          await fits();
          assert.equal(await current(), id);
          assert.deepEqual(await counts(), id === 'devices' ? [30000] : []);
          assert.equal(await evaluate("!!document.querySelector('.agent-connect')"), false);
          assert.equal(await evaluate("!!document.querySelector('.devices')"), id === 'devices');
          assert.equal(
            await evaluate("!!document.querySelector('.settings-content [data-settings-item=skills]')"),
            false,
          );
          await screenshot(theme + '-' + id + '-1280.png');
        }
        for (const tab of ['mods', 'skills', 'connections']) {
          await extension(tab);
          await fits();
          assert.equal(await currentExtension(), tab);
          assert.deepEqual(await counts(), tab === 'connections' ? [4000, 5000] : []);
          assert.equal(
            await evaluate("!!document.querySelector('.settings-add > button')"),
            ['skills', 'connections'].includes(tab),
          );
          assert.equal(
            await evaluate("document.querySelector('#extensions-body').getAttribute('aria-labelledby')"),
            'extensions-tab-' + tab,
          );
          assert.equal(await evaluate("!!document.querySelector('[data-settings-item=slack]')"), tab === 'connections');
          assert.equal(await evaluate("!!document.querySelector('.devices')"), false);
          assert.equal(
            await evaluate(`(()=>{
            const heading=document.querySelector('.extensions-heading');
            const tabs=document.querySelector('.extensions-home > .page-tabs');
            const body=document.querySelector('.extensions-body');
            return Math.abs(heading.getBoundingClientRect().left-tabs.getBoundingClientRect().left)<1 && Math.abs(heading.getBoundingClientRect().left-body.getBoundingClientRect().left)<1;
          })()`),
            true,
            'Extensions title, tabs and body share one left edge',
          );
          await screenshot(theme + '-extensions-' + tab + '-1280.png');
          if (tab === 'connections') await terminalRow(theme, '1280');
        }
        await category('general');
        for (const width of [1280, 1600, 1920]) {
          win.setContentSize(width, 800);
          await frame();
          await fits();
          assert.equal(
            await evaluate(`(()=>{
              const main=document.querySelector('.management-main');
              const shell=document.querySelector('.settings-shell');
              return Math.round(shell.getBoundingClientRect().left-main.getBoundingClientRect().left)===parseFloat(getComputedStyle(main).paddingLeft);
            })()`),
            true,
            `settings starts at the normal left padding at ${width}px`,
          );
          assert.equal(
            await evaluate("document.querySelector('.settings-content').getBoundingClientRect().width<=680"),
            true,
          );
          await screenshot(`${theme}-settings-${width}.png`);
        }
        win.setContentSize(1280, 800);
        await frame();
        await roving('.theme-options');
        await key('Tab');
        await evaluate("document.querySelector('.theme-options [aria-checked=true]').focus()");
        await key('Right');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await key('Left');
        await roving('.theme-options');
        assert.equal(await evaluate("document.activeElement.matches(':focus-visible')"), true);
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        await screenshot(theme + '-theme-keyboard.png');
        await key('Tab');
        assert.equal(await evaluate("document.activeElement.closest('.accent-options') !== null"), true);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('.accent-options');
        await key('Tab');
        assert.equal(await evaluate("document.activeElement.closest('[aria-label=界面语言]') !== null"), true);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('[aria-label=界面语言]');
        await evaluate("document.querySelector('[aria-label=界面语言] [aria-checked=true]').focus()");
        await key('Left');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'false');
        assert.equal(
          await evaluate("document.querySelector('[aria-label=界面语言] [aria-checked=true]').textContent"),
          '简体中文',
        );
        await key('Right');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('[aria-label=界面语言]');
        await category('routing');
        await roving('.goal-picker');
        const writesBefore = await evaluate("window.fixture.calls.filter(c=>c.path==='/api/settings').length");
        await evaluate("document.querySelector('.goal-picker [aria-checked=true]').focus()");
        await key('Right');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'false');
        assert.equal(await evaluate("window.fixture.calls.filter(c=>c.path==='/api/settings').length"), writesBefore);
        await key('Enter');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('.goal-picker');
        await key('Right');
        await key('Space');
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-checked')"), 'true');
        await roving('.goal-picker');
        await evaluate(
          "window.fixture.agentsError=true;window.fixture.slack={enabled:true,status:'connected',appTokenHint:'synthetic',botTokenHint:'synthetic',users:[{id:'synthetic',name:'Alice',pairedAt:'2026-10-15T12:00:00Z'}],activeTasks:0}",
        );
        await extension('connections');
        assert.equal(
          await evaluate(
            "document.querySelector('.external-agents [role=alert]').textContent.includes('Synthetic offline')",
          ),
          true,
        );
        await evaluate("document.querySelector('.external-agents [role=alert]').scrollIntoView({block:'center'})");
        await frame();
        await screenshot(theme + '-external-agents-error.png');
        win.setContentSize(380, 800);
        await frame();
        await evaluate("document.querySelector('.external-agents [role=alert]').scrollIntoView({block:'center'})");
        await fits();
        await screenshot(theme + '-external-agents-error-380.png');
        win.setContentSize(1280, 800);
        await frame();
        assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="移除 Alice"]\')'), false);
        await click('[data-settings-item="slack"] .settings-row-actions button');
        assert.equal(await evaluate('!!document.querySelector(\'.side-sheet[aria-label="Slack"]\')'), true);
        const guideStep = () =>
          evaluate("document.querySelector('.slack-steps > [aria-current=step] h4')?.textContent");
        const setSlack = async (view) => {
          await evaluate(`window.fixture.slack=${JSON.stringify(view)};window.pollSlack()`);
          await frame();
        };
        const slack = { enabled: false, status: 'off', users: [], activeTasks: 0 };
        await evaluate("document.querySelector('.notice .icon-button')?.click()");
        await setSlack(slack);
        assert.equal(await guideStep(), '创建 Slack 应用并填入 Token');
        assert.equal(await evaluate("document.querySelector('.slack-steps > li > div + div').hidden"), false);
        const stepColors = await evaluate(`(()=>{
          const step=document.querySelector('.slack-steps > [aria-current=step]');
          const later=document.querySelector('.slack-steps > [data-later=true] h4');
          const probe=document.createElement('span');step.append(probe);
          probe.style.color='var(--accent-text)';const accent=getComputedStyle(probe).color;
          probe.style.color='var(--muted)';const muted=getComputedStyle(probe).color;
          probe.style.backgroundColor='var(--panel)';const background=getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {marker:getComputedStyle(step,'::marker').color,accent,later:getComputedStyle(later).color,muted,background};
        })()`);
        assert.equal(stepColors.marker, stepColors.accent, 'current step number uses the text accent');
        assert.equal(stepColors.later, stepColors.muted, 'later titles use muted text');
        const luminance = (color) => {
          const channels = color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((n) => {
              const value = n / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const levels = [luminance(stepColors.later), luminance(stepColors.background)].sort((a, b) => a - b);
        assert.ok((levels[1] + 0.05) / (levels[0] + 0.05) >= 4.5, `${theme}: later titles pass 4.5:1`);
        // Later panels remain mounted but have no visible or focusable controls.
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('.slack-steps > li:not([aria-current]) button')].every(b=>!b.getClientRects().length)",
          ),
          true,
        );
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await evaluate("document.querySelector('[data-settings-item=slack]').scrollIntoView({block:'start'})");
          await fits();
          await screenshot(`${theme}-slack-step-1-${width}.png`);
        }
        win.setContentSize(1280, 800);
        slack.appTokenHint = 'synthetic';
        slack.botTokenHint = 'synthetic';
        await setSlack(slack);
        assert.equal(await guideStep(), '打开连接');
        assert.match(
          await evaluate("document.querySelector('.slack-guide .slack-note').textContent"),
          /第 2 步，共 3 步/,
        );
        await click('.slack-steps > li:first-child button[aria-controls]');
        assert.equal(
          await evaluate("document.querySelector('.slack-steps button[aria-controls]').getAttribute('aria-expanded')"),
          'true',
        );
        assert.equal(await evaluate("document.querySelector('.slack-check').getClientRects().length>0"), true);
        await click('.slack-steps > li:first-child button[aria-controls]');
        await click('.slack-steps > li:nth-child(2) .primary');
        assert.equal(
          await evaluate("window.fixture.calls.some(c=>c.path==='/api/slack'&&c.method==='PATCH'&&c.body.enabled)"),
          true,
        );
        assert.equal(await guideStep(), '和机器人配对');
        await setSlack({ ...slack, enabled: true, status: 'error', error: 'Synthetic offline' });
        assert.equal(await guideStep(), '和机器人配对', 'a connection error does not move the step back');
        assert.match(
          await evaluate('document.querySelector(\'.side-sheet[aria-label="Slack"] .slack-note\').textContent'),
          /出错：Synthetic offline/,
        );
        await evaluate('window.fixture.slackHttpError=true;window.pollSlack()');
        await frame();
        assert.match(
          await evaluate("document.querySelector('[data-settings-item=slack]').previousElementSibling.textContent"),
          /读不到 Slack 设置：Synthetic request failed/,
        );
        await evaluate('window.fixture.slackHttpError=false');
        await setSlack({ ...slack, enabled: true, status: 'connected' });
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await evaluate("document.querySelector('[data-settings-item=slack]').scrollIntoView({block:'start'})");
          await fits();
          await screenshot(`${theme}-slack-step-3-${width}.png`);
        }
        await setSlack({
          ...slack,
          enabled: true,
          status: 'connected',
          users: [{ id: 'synthetic', name: 'Alice', pairedAt: '2026-10-15T12:00:00Z' }],
        });
        assert.equal(await guideStep(), undefined);
        assert.equal(await evaluate("document.querySelector('.slack-steps').getClientRects().length"), 0);
        assert.match(
          await evaluate("document.querySelector('.slack-guide-summary').textContent"),
          /已设置好 ·.*查看步骤/s,
        );
        assert.equal(
          await evaluate('document.querySelector(\'button[aria-label="移除 Alice"]\').getClientRects().length>0'),
          true,
        );
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('.slack-people button')].some(b=>b.textContent==='生成配对码'&&b.getClientRects().length)",
          ),
          true,
        );
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await evaluate("document.querySelector('[data-settings-item=slack]').scrollIntoView({block:'start'})");
          await fits();
          await screenshot(`${theme}-slack-done-${width}.png`);
        }
        win.setContentSize(1280, 800);
        await frame();
        await click('.slack-guide-summary button');
        assert.equal(await evaluate("document.querySelector('.slack-steps > li > div + div').hidden"), false);
        assert.match(await evaluate("document.querySelector('.slack-guide .slack-note').textContent"), /3 步都已完成/);
        await evaluate("[...document.querySelectorAll('.slack-guide button')].find(b=>b.textContent==='收起').click()");
        await frame();
        assert.equal(await evaluate("document.querySelector('.slack-steps').getClientRects().length"), 0);
        await click('.slack-guide-summary button');
        await screenshot(theme + '-expanded-row.png');
        assert.equal(await evaluate("document.querySelector('.slack-check input').checked"), false);
        assert.equal(
          await evaluate("getComputedStyle(document.querySelector('.slack-check input')).colorScheme"),
          theme,
          'native checkboxes follow the theme token even if the root inline scheme differs',
        );
        const checkboxBounds = await evaluate(`(()=>{
          const input=document.querySelector('.slack-check input');
          input.scrollIntoView({block:'center'});
          const r=input.getBoundingClientRect();
          return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};
        })()`);
        await frame();
        const center =
          (Math.floor(checkboxBounds.height / 2) * checkboxBounds.width + Math.floor(checkboxBounds.width / 2)) * 4;
        let bitmap = (await win.webContents.capturePage(checkboxBounds)).toBitmap();
        for (
          let attempt = 0;
          attempt < 10 && !(theme === 'light' ? bitmap[center] > 180 : bitmap[center] < 150);
          attempt++
        ) {
          win.webContents.invalidate();
          await new Promise((resolve) => setTimeout(resolve, 20));
          bitmap = (await win.webContents.capturePage(checkboxBounds)).toBitmap();
        }
        assert.ok(
          theme === 'light' ? bitmap[center] > 180 : bitmap[center] < 150,
          'unchecked box has an empty center in both themes',
        );
        await click('button[aria-label="移除 Alice"]');
        await screenshot(theme + '-slack-remove-confirm.png');
        await key('Escape');
        assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="移除 Alice"]\')'), true);
        await click('button[aria-label="移除 Alice"]');
        await click('.confirm-dialog .button.danger');
        assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="移除 Alice"]\')'), false);
        assert.equal(await guideStep(), '和机器人配对');
        assert.equal(
          await evaluate("window.fixture.calls.some(c=>c.path==='/api/slack/users/synthetic'&&c.method==='DELETE')"),
          true,
        );
        await evaluate('window.fixture.agentsError=false');
        await click('.conversation-link');
        await click('button[aria-label="对话设置"]');
        await evaluate(
          "[...document.querySelectorAll('.conversation-panel [role=tab]')].find(b=>b.textContent==='Skills').click()",
        );
        await frame();
        await screenshot(theme + '-skills-empty.png');
        await evaluate(
          "[...document.querySelectorAll('.conversation-panel button')].find(b=>b.textContent==='安装 Skills').click()",
        );
        await frame();
        assert.equal(await currentExtension(), 'skills');
        assert.equal(
          await evaluate(
            '(()=>{const r=document.querySelector("#extensions-tab-skills").getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()',
          ),
          true,
        );
        await evaluate("document.querySelector('.settings-add > button').focus()");
        await key('Enter');
        assert.equal(await evaluate('document.activeElement.textContent'), '从链接或文件夹添加…');
        await key('Down');
        assert.equal(await evaluate('document.activeElement.textContent'), '从其他 AI 应用导入…');
        await key('Up');
        await screenshot(theme + '-add-menu.png');
        win.setContentSize(380, 800);
        await frame();
        await fits();
        await screenshot(theme + '-add-menu-380.png');
        win.setContentSize(1280, 800);
        await frame();
        await key('Escape');
        assert.equal(await evaluate("document.activeElement.matches('.settings-add > button')"), true);
        assert.equal(await evaluate("!!document.querySelector('[role=menu]')"), false);
        await key('Enter');
        await key('Enter');
        assert.equal(await evaluate('document.activeElement.id'), 'extension-input');
        assert.equal(await evaluate('!!document.querySelector(\'.side-sheet[aria-label="添加扩展"]\')'), true);
        await click('.side-sheet-head button[aria-label="关闭"]');
        win.setContentSize(380, 800);
        await frame();
        await nav('设置');
        if (await evaluate("document.querySelector('.settings-shell').dataset.view !== 'list'"))
          await click('.settings-back');
        await fits();
        assert.equal(await evaluate("document.querySelector('.settings-shell').dataset.view"), 'list');
        await screenshot(theme + '-list-380.png');
        for (const id of ['general', 'personal', 'conversation', 'routing', 'devices', 'permissions', 'advanced']) {
          await category(id);
          await fits();
          assert.equal(
            await evaluate("getComputedStyle(document.querySelector('.settings-navigation')).display"),
            'none',
          );
          await screenshot(theme + '-' + id + '-380.png');
          await click('.settings-back');
          assert.equal(await evaluate('document.activeElement.dataset.settingsCategory'), id);
          assert.deepEqual(await counts(), []);
          assert.equal(await evaluate("!!document.querySelector('.settings-category-body')"), false);
          {
            // Re-enter with a remembered category while narrow: no initial hidden mount or request.
            await click('.conversation-link');
            const before = await evaluate('window.fixture.calls.length');
            await nav('设置');
            assert.equal(await current(), id);
            assert.deepEqual(await counts(), []);
            assert.equal(
              await evaluate(
                `window.fixture.calls.slice(${before}).some(c=>['/api/external/connections','/api/devices','/api/external-agents'].includes(c.path))`,
              ),
              false,
            );
          }
        }
        for (const tab of ['mods', 'skills', 'connections']) {
          await extension(tab);
          await fits();
          assert.equal(await currentExtension(), tab);
          await screenshot(theme + '-extensions-' + tab + '-380.png');
          if (tab === 'connections') await terminalRow(theme, '380');
        }
        win.setContentSize(1280, 800);
        await frame();
        await click('.conversation-link');
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
        );
        await frame();
        assert.equal(await currentExtension(), 'connections');
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
        assert.equal(
          await evaluate(
            "document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').getAttribute('aria-expanded')",
          ),
          'true',
        );
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-details').hidden"),
          false,
        );
        assert.equal(await evaluate('document.activeElement.getClientRects().length > 0'), true);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await frame();
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] input[type=checkbox]').checked"),
          true,
        );
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot]').classList.contains('is-target')"),
          true,
        );
        await screenshot(theme + '-grok-deep-link.png');
        await click('[data-settings-item=grok-bot] .settings-row-expand');
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-details').hidden"),
          true,
        );
        await click('.conversation-link');
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
        );
        await frame();
        assert.equal(
          await evaluate(
            "document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').getAttribute('aria-expanded')",
          ),
          'true',
        );
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
      }
      // The same keyboard handler used by the desktop restores the last category.
      await category('advanced');
      await click('.conversation-link');
      await evaluate(
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true,cancelable:true}))",
      );
      await frame();
      assert.equal(await current(), 'advanced');
      assert.equal(await evaluate("localStorage.getItem('pugport-settings-category')"), 'advanced');
      // Text blur and immediate selects use partial settings writes.
      await category('personal');
      await setText('#global-instructions', 'Synthetic instructions');
      await evaluate('window.fixture.holdSettings=true');
      const memorySwitch = '.settings-fields .switch input';
      await pointer(memorySwitch, 'mouseDown');
      assert.equal(await evaluate('document.querySelector(".settings-fields").matches(":disabled")'), false);
      assert.equal(await evaluate(`document.querySelector('${memorySwitch}').matches(':disabled')`), false);
      await pointer(memorySwitch, 'mouseUp');
      assert.equal(await evaluate(`document.querySelector('${memorySwitch}').checked`), true);
      await evaluate('window.fixture.holdSettings=false;window.fixture.releaseSettings()');
      await frame();
      assert.equal(await evaluate('window.fixture.state.settings.memoryDistillation.enabled'), true);
      await category('general');
      assert.equal(
        await evaluate(
          "window.fixture.calls.some(c=>c.path==='/api/settings'&&c.body?.globalInstructions==='Synthetic instructions'&&Object.keys(c.body).length===1)",
        ),
        true,
      );
      await evaluate(
        "document.querySelector('select[aria-label=任务完成通知]').value='never';document.querySelector('select[aria-label=任务完成通知]').dispatchEvent(new Event('change',{bubbles:true}))",
      );
      await frame();
      assert.equal(await evaluate('window.fixture.state.settings.notifyOnFinish'), 'never');
      // Bank and Mod data controls live with installed Mods, not Settings.
      assert.equal(await evaluate("!!document.querySelector('[data-settings-category=data]')"), false);
      assert.equal(await evaluate("!!document.querySelector('[data-settings-item=plaid-keys]')"), false);
      await category('permissions');
      await evaluate(
        "const el=document.querySelector('select[aria-label=工具确认方式]');el.value='auto';el.dispatchEvent(new Event('change',{bubbles:true}))",
      );
      await frame();
      assert.equal(await evaluate("document.querySelector('select[aria-label=工具确认方式]').value"), 'ask');
      assert.deepEqual(await evaluate('window.permissionCalls.at(-1)'), {
        kind: 'settings',
        patch: { toolApprovalMode: 'auto' },
      });
      assert.equal(
        await evaluate("window.fixture.calls.some(c=>c.path==='/api/settings'&&c.body?.toolApprovalMode)"),
        false,
      );
      // Tabbing during the refresh write keeps the next numeric field ready for typing.
      await category('advanced');
      await setText('input[max="600"]', '90');
      await evaluate('window.fixture.holdSettings=true');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await frame();
      assert.equal(await evaluate('document.activeElement.max'), '1800');
      await win.webContents.insertText('91');
      await frame();
      assert.equal(await evaluate('document.activeElement.value'), '91');
      await evaluate('window.fixture.holdSettings=false;window.fixture.releaseSettings()');
      await frame();
      assert.equal(await evaluate('document.activeElement.value'), '91');
      // Emulate the actual media feature, so this verifies the CSS suppression.
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await click('.conversation-link');
      await evaluate(
        "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
      );
      await frame();
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
      assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.is-target')).boxShadow"), 'none');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();
      await win.loadFile(path.join(fixture, 'index.html'), { query: { view: 'conversation', id: 'chat' } });
      for (
        let i = 0;
        i < 30 &&
        !(await evaluate(
          "!!document.querySelector('.solo-shell .conversation-workspace,.solo-shell .conversation-pane')",
        ));
        i++
      )
        await frame();
      for (const theme of ['light', 'dark']) {
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        await evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置例程，让回复回到 PugPort')).click()",
        );
        await frame();
        assert.equal(await currentExtension(), 'connections');
        assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '例程 webhook 网址');
        assert.equal(
          await evaluate(
            "document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').getAttribute('aria-expanded')",
          ),
          'true',
        );
        assert.equal(
          await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-details').hidden"),
          false,
        );
        assert.equal(await evaluate('document.activeElement.getClientRects().length > 0'), true);
        await screenshot(theme + '-popout.png');
        await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='返回对话').click()");
        await frame();
        assert.equal(await evaluate("!!document.querySelector('.extensions-home')"), false);
      }
      win.setContentSize(380, 800);
      await win.loadFile(path.join(fixture, 'index.html'));
      for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      await nav('\u8bbe\u7f6e');
      await evaluate('window.english()');
      await category('conversation');
      await click(`input[aria-label="${english['自动插话']}"]`);
      for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.notice-success')")); i++) await frame();
      const switchToast = await evaluate("document.querySelector('.notice-success').textContent");
      assert.ok(switchToast.includes(english['自动插话']), switchToast);
      assert.doesNotMatch(switchToast, /[㐀-鿿]/);
      await screenshot('en-copy-switch-toast-380.png');
      await click('.settings-back');
      for (const theme of ['light', 'dark']) {
        await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
        for (const id of ['devices']) {
          await category(id);
          await evaluate("document.querySelector('.settings-back').style.paddingBlock='20px'");
          await frame();
          await fits();
          assert.equal(await evaluate('document.documentElement.lang'), 'en');
          assert.match(await evaluate("document.querySelector('.settings-header-action').textContent"), /Add/);
          await screenshot(theme + '-' + id + '-380-en.png');
          assert.equal(
            await evaluate(`(()=>{
            const action=document.querySelector('.settings-header-action');
            const back=document.querySelector('.settings-back');
            return action.getBoundingClientRect().top>=back.getBoundingClientRect().bottom;
          })()`),
            true,
          );
          await click('.settings-back');
        }
        await extension('skills');
        assert.equal(await evaluate('document.documentElement.lang'), 'en');
        assert.match(
          await evaluate("document.querySelector('.extensions-heading .settings-header-action').textContent"),
          /Add/,
        );
        await screenshot(theme + '-extensions-skills-380-en.png');
        for (const width of [1280, 380]) {
          win.setContentSize(width, 800);
          await frame();
          await fits();
          assert.equal(
            await evaluate(`(()=>{
            const title=document.querySelector('.extensions-heading h1').getBoundingClientRect();
            const action=document.querySelector('.extensions-heading .settings-header-action button').getBoundingClientRect();
            return action.top<title.bottom && action.bottom>title.top && title.right<=action.left &&
              action.left>=0 && action.right<=innerWidth;
          })()`),
            true,
            'Extensions title and action share a row without overlap, and the action is visible',
          );
        }
      }
      // Batch 1a: the real Studio, with synthetic messages and an isolated clipboard.
      for (const locale of ['zh-CN', 'en']) {
        for (const theme of ['light', 'dark']) {
          for (const width of [1280, 380]) {
            win.setContentSize(width, 800);
            await evaluate(`(()=>{
              const stamp='2026-10-15T12:00:00.000Z';
              const en=${JSON.stringify(locale)}==='en';
              const message=(id,role,content)=>({id,role,content,conversationId:'chat',createdAt:stamp});
              const messages=[
                message('design-user','user',en?'Please review this layout.':'请检查这个布局。'),
                message('design-reply','assistant',(en?'The layout is ready.':'布局已准备好。')+'\\n\\n'+
                  '~~~ts\\nconst width = 380;\\n~~~\\n\\n'+(en?'| Width | Result |\\n|---|---|\\n| 1280 | Ready |\\n| 380 | Ready |':'| 宽度 | 结果 |\\n|---|---|\\n| 1280 | 就绪 |\\n| 380 | 就绪 |')),
                {...message('design-review','assistant',en?'The controls and reading surface are clear.':'控件和阅读区域清晰。'),externalAgent:{agentId:'muse',name:en?'Review assistant':'审查助手',status:'completed',updatedAt:stamp}}
              ];
              localStorage.setItem('batch1a-preview',JSON.stringify(messages));
            })()`);
            await win.loadFile(path.join(fixture, 'index.html'), { query: { locale } });
            for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.project-more')")); i++)
              await frame();
            await evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme));
            await evaluate(`(()=>{
              window.codeCopies=[];
              Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.failCopy)throw Error('synthetic denied');window.codeCopies.push(value)}}});
            })()`);
            await frame();
            await click('.conversation-link');
            if (locale === 'en') {
              await frame();
              assert.equal(
                await evaluate("document.querySelector('.conversation-composer textarea').placeholder"),
                english['想做什么？'],
              );
            }
            for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.message-code-head')")); i++)
              await frame();
            await evaluate("document.querySelector('.conversation-scroll').scrollTop=0");
            const prefix = 'batch1a-' + locale + '-' + theme + '-' + width;
            await fits();
            assert.equal(await evaluate("!!document.querySelector('.participant-card')"), true);
            assert.equal(
              await evaluate("getComputedStyle(document.querySelector('.participant-card')).borderLeftWidth"),
              '1px',
            );
            assert.equal(
              await evaluate("document.querySelector('.message-code-head button').textContent"),
              locale === 'en' ? 'Copy' : '复制',
            );
            await screenshot(prefix + '-conversation.png');
            await click('.conversation-message.message-user button:has(.lucide-pencil)');
            assert.ok(
              await evaluate(
                `(()=>{const editor=document.querySelector('.sent-message-editor');return Math.abs(editor.getBoundingClientRect().width-editor.parentElement.clientWidth)<2})()`,
              ),
              'sent editor fills the message width',
            );
            await screenshot(prefix + '-sent-edit.png');
            await click('.sent-message-editor button[type=button]');
            if (locale === 'en' && theme === 'light' && width === 1280) {
              await evaluate('window.previewImage()');
              await frame();
              assert.equal(
                await evaluate("getComputedStyle(document.querySelector('.image-viewer')).backgroundColor"),
                'rgba(0, 0, 0, 0.86)',
              );
              await screenshot(prefix + '-image-viewer.png');
              await click('.image-viewer-close');
            }

            await evaluate("document.querySelector('.conversation-scroll').scrollTop=9999");
            await screenshot(prefix + '-conversation-detail.png');
            await click('.message-code-head button');
            assert.deepEqual(await evaluate('window.codeCopies'), ['const width = 380;']);
            assert.equal(
              await evaluate("document.querySelector('.message-code-head button').textContent"),
              locale === 'en' ? 'Copied' : '已复制',
            );
            if (locale === 'en' && theme === 'light' && width === 1280) {
              const resetDeadline = Date.now() + 5000;
              while (
                Date.now() < resetDeadline &&
                (await evaluate("document.querySelector('.message-code-head button').textContent")) !== 'Copy'
              )
                await frame();
              assert.equal(await evaluate("document.querySelector('.message-code-head button').textContent"), 'Copy');
            }
            await evaluate('window.failCopy=true');
            await click('.message-code-head button');
            assert.match(
              await evaluate("document.querySelector('.notice-error').textContent"),
              locale === 'en' ? /Couldn't copy/ : /无法复制/,
            );
            await click('.notice-error button');
            await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined})");
            await click('.message-code-head button');
            assert.equal(await evaluate("!!document.querySelector('.notice-error')"), true);
            await click('.notice-error button');
            if (width === 380) await evaluate("document.querySelector('.studio-sidebar').classList.add('mobile-open')");
            await screenshot(prefix + '-sidebar.png');
            if (width === 380)
              await evaluate("document.querySelector('.studio-sidebar').classList.remove('mobile-open')");
            await nav(locale === 'en' ? 'Settings' : '设置');
            for (const id of ['general', 'conversation']) {
              await category(id);
              await fits();
              if (locale === 'en' && id === 'conversation') {
                assert.equal(
                  await evaluate(`(()=>{
                  const select=document.querySelector('select[aria-label="${english['发送快捷键']}"]');
                  const style=getComputedStyle(select), context=document.createElement('canvas').getContext('2d');
                  context.font=style.font;
                  return [...select.options].every(option=>context.measureText(option.textContent).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)<=select.getBoundingClientRect().width);
                })()`),
                  true,
                  'send shortcut labels fit without clipping',
                );
                const headings = await evaluate(
                  "[...document.querySelectorAll('.settings-content h2')].map(e=>e.textContent)",
                );
                assert.equal(new Set(headings).size, headings.length, 'chat settings headings are distinct');
              }
              await screenshot(prefix + '-settings-' + id + '.png');
              if (width === 380) await click('.settings-back');
            }
          }
        }
      }
      win.setContentSize(1280, 800);
      await win.loadFile(path.join(fixture, 'index.html'), { query: { locale: 'zh-CN' } });
      for (let i = 0; i < 30 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      await nav('设置');
      await category('general');
      await evaluate(
        "history.replaceState(null,'',location.pathname);[...document.querySelectorAll('.language-options button')].find(b=>b.textContent==='English').click()",
      );
      for (
        let i = 0;
        i < 60 &&
        !(await evaluate("document.documentElement.lang==='en' && !!document.querySelector('.project-more')"));
        i++
      )
        await frame();
      assert.equal(await evaluate('document.documentElement.lang'), 'en', 'empty drafts allow the locale reload');
      assert.deepEqual(rendererErrors, []);
      await new Promise((resolve) =>
        process.stdout.write(
          'PASS settings categories renderer: light/dark and narrow screenshots, mount/unmount, deep links, radio keyboard, blur, native cancel and pop-out\n',
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
