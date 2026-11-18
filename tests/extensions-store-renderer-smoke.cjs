// Isolated renderer only: fake APIs, temporary Electron profile, no account access or network.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-extension-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><main id="root"></main><script src="fixture.js"></script></body></html>',
      );
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        (await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8')) +
          '\n' +
          (
            await Promise.all(
              [
                'composer.css',
                'SwarmWorkspace.css',
                'Connectors.css',
                'ExternalAgents.css',
                'Devices.css',
                'SlackGateway.css',
                'media-workflows.css',
                'settings.css',
                'StorePage.css',
                'ExtensionsHome.css',
              ].map((name) => fs.readFile(path.join(root, 'src/ui', name), 'utf8')),
            )
          ).join('\n') +
          '\nbody{overflow:auto;margin:0}#root{padding:32px;max-width:1280px;margin:auto}.exec-group{margin-top:20px}@media(max-width:600px){#root{padding:18px}}',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExtensionsHome } from './src/ui/ExtensionsHome';
import { extensionCatalog } from './src/shared/extensions';
window.calls=[]; window.notices=[]; window.jobs=[]; window.errors=[];
window.addEventListener('error',event=>window.errors.push(event.message));
window.fetch=()=>{throw Error('Unexpected real fetch');};
const tools={voice:false,images:{model:false},memory:{model:false},markitdown:false};
const api=async(path,body,method)=>{
 window.calls.push({path,body,method});
 if(path==='/api/modes') return {catalog:[],installed:[]};
 if(path==='/api/modes/source') return {config:null,status:'unconfigured',catalog:[]};
 if(path==='/api/github') return {enabled:false,state:'off'};
 if(path==='/api/web-search') return {provider:'deepseek',enabled:false,configured:false,monthlyLimitCny:5,month:'2026-10',usage:{requests:0,billableRequests:0,uncertainRequests:0,estimatedCostCny:0,reservedCny:0}};
 if(path==='/api/slack') return {enabled:false,status:'off',users:[],activeTasks:0};
 if(path==='/api/external-agents') return {agents:[]};
 if(path==='/api/devices') return {slackHost:null,devices:[{id:'fixture-device',name:'合成设备',online:true}]};
 if(path==='/api/external/connections') return {server:'synthetic',tools:[],snippet:''};
 if(path==='/api/external/terminal-command') return {folder:'C:/Synthetic/PugPort',platform:'win32'};
 if(path==='/api/extensions') return {items:[
 {kind:'skill',id:'synthetic-skill',name:'写周报',description:'按固定格式整理一周进展。',path:'/synthetic/skills/weekly',source:'fixture',managed:true,enabled:true},
 {kind:'mcp',id:'synthetic-tool',name:'个人笔记库',description:'读取和整理你的笔记。',transport:'http',url:'https://synthetic.invalid/mcp',source:'fixture',enabled:true,headers:{Authorization:false}}
 ],catalog:extensionCatalog};
 if(path==='/api/app-info') return {tools};
 if(path==='/api/tool-installations' && !body) return {installations:window.jobs.map(job=>({...job}))};
 if(path==='/api/tool-installations') {
  const installation={id:'voice-job',tool:body.tool,status:'running',phase:'downloading',message:'正在下载语音模型；可离开此页。',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  window.jobs=[installation]; return {installation:{...installation}};
 }
 if(path==='/api/connectors') return {accounts:[],providers:['google','microsoft'].map(provider=>({provider,configured:false,clientId:'',hasClientSecret:false,tenant:'common',redirectUri:'http://localhost:4317/api/connectors/oauth/callback'}))};
 throw new Error('Unexpected fixture request: '+path);
};
createRoot(document.getElementById('root')).render(<ExtensionsHome api={api} notify={value=>window.notices.push(value)}/>);`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        loader: { '.png': 'dataurl', '.webp': 'dataurl' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_EXTENSION_SMOKE: fixture };
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
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-extension-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_EXTENSION_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-extension-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await frame();
  };
  const capture = async () => {
    try {
      return await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    } catch (error) {
      // Native resizing can transiently reject a hidden software snapshot.
      if (!String(error).includes('UnknownVizError')) throw error;
      await frame();
      return win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    }
  };
  const shot = async (name) => {
    await frame();
    await fs.writeFile(path.join(root, 'reports/extensions-store', `${name}.png`), (await capture()).toPNG());
  };
  void app.whenReady().then(async () => {
    try {
      await fs.mkdir(path.join(root, 'reports/extensions-store'), { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 1100,
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
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.extensions-home > .page-tabs [role=tab]')].map(node=>node.textContent)",
        ),
        ['Mods', '技能', '连接与服务'],
      );
      assert.equal(await evaluate("document.querySelector('.extensions-heading h1').textContent"), '扩展');
      assert.equal(
        await evaluate("[...document.querySelectorAll('h1')].some(node=>node.textContent==='Mods Store')"),
        false,
      );
      assert.equal(await evaluate("document.body.textContent.includes('已连接账号')"), false);
      assert.equal(await evaluate('document.querySelectorAll(\'[aria-label="连接 Google Workspace"]\').length'), 0);
      for (const theme of ['dark', 'light']) {
        await evaluate(`document.documentElement.dataset.theme='${theme}'`);
        for (const tab of ['mods', 'skills', 'connections']) {
          await click(`#extensions-tab-${tab}`);
          assert.equal(await evaluate(`localStorage.getItem('pugport-extensions-tab')`), tab);
          assert.equal(
            await evaluate(
              "document.querySelectorAll('.extensions-heading [aria-controls=extensions-add-menu]').length",
            ),
            tab === 'skills' || tab === 'connections' ? 1 : 0,
          );
          assert.equal(
            await evaluate(`document.querySelector('#extensions-tab-${tab}').getAttribute('aria-selected')`),
            'true',
          );
          const lefts = await evaluate(
            "['.extensions-heading','.extensions-home > .page-tabs','#extensions-body'].map(selector=>document.querySelector(selector).getBoundingClientRect().left)",
          );
          assert.ok(Math.max(...lefts) - Math.min(...lefts) < 2, `${tab}: header, tabs and body share a left edge`);
          await evaluate('window.scrollTo(0,0)');
          await shot(`${tab}-${theme}-wide`);
          win.setSize(520, 980);
          await frame();
          await shot(`${tab}-${theme}-narrow`);
          assert.equal(
            await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
            true,
            `${tab} does not overflow`,
          );
          win.setSize(1440, 1100);
          await frame();
        }
      }
      await click('#extensions-tab-skills');
      await click('.extensions-heading [aria-controls=extensions-add-menu]');
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('#extensions-add-menu [role=menuitem]')].map(node=>node.textContent)",
        ),
        ['从链接或文件夹添加…', '从其他 AI 应用导入…'],
      );
      await click('#extensions-add-menu [role=menuitem]');
      assert.equal(await evaluate("document.querySelector('.side-sheet').getAttribute('aria-label')"), '添加扩展');
      assert.equal(await evaluate("document.querySelectorAll('.side-sheet .ext-install').length"), 1);
      await shot('skills-add-sheet');
      await click('.side-sheet-head button');
      await click('[data-settings-item=synthetic-skill] .ext-more');
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.context-menu [role=menuitem]')].map(node=>node.textContent)"),
        ['删除…'],
      );
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await click('#extensions-tab-connections');
      await click('.extensions-heading [aria-controls=extensions-add-menu]');
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('#extensions-add-menu [role=menuitem]')].map(node=>node.textContent)",
        ),
        ['添加 MCP 工具…', '从其他 AI 应用导入…'],
      );
      await click('#extensions-add-menu [role=menuitem]');
      await shot('connections-add-sheet');
      await click('.side-sheet-head button');
      assert.equal(
        await evaluate("document.querySelector('[data-settings-item=synthetic-tool] .settings-row-details').hidden"),
        true,
      );
      await click('[data-settings-item=synthetic-tool] .ext-more');
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.context-menu [role=menuitem]')].map(node=>node.textContent)"),
        ['改名称和设置…', '重新检查', '移除…'],
      );
      await click('.context-menu [role=menuitem]');
      assert.equal(await evaluate("document.querySelector('.side-sheet').getAttribute('aria-label')"), '个人笔记库');
      await shot('mcp-settings-sheet');
      await click('.side-sheet-head button');
      assert.equal(await evaluate("document.querySelectorAll('[data-settings-item=slack] .slack-steps').length"), 0);
      await click('[data-settings-item=slack] button');
      assert.equal(await evaluate("document.querySelector('.side-sheet').getAttribute('aria-label')"), 'Slack');
      assert.equal(await evaluate("document.querySelectorAll('.side-sheet .slack-steps > li').length"), 3);
      assert.equal(
        await evaluate('document.querySelectorAll(\'.side-sheet select[aria-label="Slack 由哪台运行"]\').length'),
        1,
      );
      await shot('slack-setup-sheet');
      await click('.side-sheet-head button');
      await click('[data-settings-item=web-search] button');
      assert.equal(await evaluate("document.querySelector('.side-sheet').getAttribute('aria-label')"), '联网搜索');
      await shot('web-search-sheet');
      await click('.side-sheet-head button');
      await click('#extensions-tab-connections');
      assert.equal(
        await evaluate(
          "document.querySelectorAll('.settings-group:last-child .settings-catalog .settings-row').length",
        ),
        4,
      );
      await click('.settings-group:last-child .settings-catalog .settings-row .settings-row-expand');
      assert.match(
        await evaluate(
          "document.querySelector('.settings-group:last-child .settings-catalog .settings-row .settings-row-details:not([hidden])').textContent",
        ),
        /FunASR/,
      );
      await shot('component-details');
      await click('[aria-label="安装 视频转写"]');
      assert.equal(await evaluate('document.querySelector(\'[aria-label="安装 视频转写"]\').disabled'), true);
      assert.match(await evaluate('document.body.textContent'), /正在下载语音模型/);
      await shot('installation-background');
      assert.match(await evaluate('document.body.textContent'), /正在下载语音模型/);
      await evaluate(
        "window.jobs[0]={...window.jobs[0],status:'failed',phase:'failed',message:'下载连接中断，请重试。'}; window.dispatchEvent(new Event('focus'));",
      );
      await frame();
      assert.match(await evaluate('document.body.textContent'), /安装失败/);
      await shot('installation-failure');
      await click('[aria-label="安装 视频转写"]');
      assert.equal(
        await evaluate("window.calls.filter(call=>call.path==='/api/tool-installations' && call.body).length"),
        2,
      );
      assert.match(await evaluate('document.body.textContent'), /后台安装中/);
      assert.deepEqual(await evaluate('window.errors'), []);
      console.log(
        'PASS extensions renderer: three tabs, Add menus, sheets, light/dark wide/narrow, component installation and retry; screenshots reports/extensions-store',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
