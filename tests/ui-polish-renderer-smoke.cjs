// Real Studio and in-app confirmation in a hidden Electron window, with synthetic fetch/SSE only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-ui-polish-'));
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
const stamp='2026-10-13T20:00:00.000Z';
const project={id:'project',name:'示例项目',path:'C:/Synthetic',createdAt:stamp,updatedAt:stamp};
const chat={id:'chat',projectId:'project',title:'示例对话',createdAt:stamp,updatedAt:stamp};
const unreadChat={...chat,id:'unread-chat',title:'未读示例'};
localStorage.setItem('comborunner.seen',JSON.stringify({'unread-chat':''}));
localStorage.setItem('agent-studio-conversation','chat');
localStorage.setItem('agent-studio-project','project');
localStorage.setItem('pugport-locale','zh-CN');
window.fixture={calls:[],state:{app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'fixture'},
settings:{toolApprovalMode:'auto',refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,preferCli:true,defaultProjectPath:'C:/Synthetic',maxConcurrentRuns:1},
targets:[{id:'claude',provider:'claude',label:'Anthropic',enabled:true,command:'fixture',environment:'native'}],runtimes:[{id:'claude',provider:'claude',label:'Anthropic',status:'ready',models:[{id:'opus',label:'Opus 5.5',efforts:['high','max']},{id:'sonnet',label:'Sonnet 5.5',efforts:['high']},...Array.from({length:16},(_,i)=>({id:'synthetic-'+i,label:'Synthetic model '+i,efforts:[]}))]}],runs:[],approvals:[],plugins:[],refreshing:false,projects:[project],removedProjects:[],conversations:[chat],workflows:[],conversationMessages:[],backgroundTasks:[],tasteTests:[],conversationFolders:[]}};
const f=window.fixture;
f.state.conversations.push(unreadChat);
f.deletedChats=[];
f.models=f.state.runtimes[0].models;
window.broadcast=()=>f.listeners.state({data:JSON.stringify(f.state)});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';f.calls.push({path:url,method});
 if(url==='/api/modes'){
  if(method!=='GET')throw Error('Mode catalog must use GET');
  return response({catalog:[],installed:[]});
 }
 if(url==='/api/app-info')return response({paths:{dataDir:'C:/Synthetic',memoryDir:'C:/Synthetic/memory'},tools:{}});
 if(url==='/api/conversation-history')return response({archived:0,deleted:f.deletedChats.length,purge:{count:f.deletedChats.length,olderCount:0,pendingCount:0,token:'a'.repeat(64)}});
 if(url==='/api/session')return response({token:'synthetic'});
 if(url==='/api/deleted-conversations')return response(f.deletedChats);
 if(url.includes('archived-conversations') || url.includes('scheduled-tasks'))return response([]);
 if(url==='/api/state')return response(f.state);
 if(url==='/api/external-agents')return response({agents:[]});
 if(url==='/api/conversations/chat' || url==='/api/conversations/unread-chat')return response({conversation:url.endsWith('/chat')?chat:unreadChat,messages:[],workflows:[],runs:[]});
 return response({});
};
window.EventSource=class {constructor(){f.listeners={};f.events=this}addEventListener(name,fn){f.listeners[name]=fn}close(){}};
createRoot(document.getElementById('root')).render(<><Studio/><ConfirmDialogHost/></>);
`,
        },
        bundle: true,
        platform: 'browser',
        loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.css': 'empty' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_UI_POLISH: fixture };
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
      assert.ok(path.basename(resolved).startsWith('pugport-ui-polish-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_UI_POLISH;
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
      const press = async (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        await frame();
      };
      const click = async (selector) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));})()`,
        );
        await frame();
      };
      const screenshot = async (name) => {
        // Offscreen resize finishes after the DOM frame; wait for the compositor too.
        await new Promise((resolve) => setTimeout(resolve, 150));
        await fs.mkdir(path.join(root, 'reports/ui-polish'), { recursive: true });
        await fs.writeFile(path.join(root, 'reports/ui-polish', name), (await win.webContents.capturePage()).toPNG());
      };
      await win.loadFile(path.join(fixture, 'index.html'));
      // Hidden windows need focus emulation for Chromium's native keyboard focus rings.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      for (let i = 0; i < 20 && !(await evaluate("!!document.querySelector('.project-more')")); i++) await frame();
      assert.equal(await evaluate(`!!document.querySelector('.unread-dot[role="img"][aria-label="有新内容"]')`), true);
      assert.equal(
        await evaluate(`document.querySelector('.unread-dot').closest('button').hasAttribute('aria-label')`),
        false,
      );
      await evaluate(`document.querySelector('.conversation-actions button').focus()`);
      await press('Enter');
      assert.equal(
        await evaluate(
          `document.activeElement===document.querySelector('.context-menu [role="menuitem"]:not(:disabled)')`,
        ),
        true,
      );
      const keyboardAnchor = await evaluate(
        `(()=>{const b=document.querySelector('.conversation-actions button').getBoundingClientRect();const m=document.querySelector('.context-menu').getBoundingClientRect();return {button:b.toJSON(),menu:m.toJSON(),width:innerWidth,height:innerHeight}})()`,
      );
      assert.ok(
        Math.abs(
          keyboardAnchor.menu.left -
            Math.max(4, Math.min(keyboardAnchor.button.left, keyboardAnchor.width - keyboardAnchor.menu.width - 4)),
        ) < 2 &&
          Math.abs(
            keyboardAnchor.menu.top -
              Math.max(
                4,
                Math.min(keyboardAnchor.button.bottom, keyboardAnchor.height - keyboardAnchor.menu.height - 4),
              ),
          ) < 2,
        `keyboard menu anchors to its button within the viewport: ${JSON.stringify(keyboardAnchor)}`,
      );
      await press('End');
      assert.equal(
        await evaluate(
          `document.activeElement===[...document.querySelectorAll('.context-menu [role="menuitem"]:not(:disabled)')].at(-1)`,
        ),
        true,
      );
      await press('Down');
      assert.equal(
        await evaluate(
          `document.activeElement===document.querySelector('.context-menu [role="menuitem"]:not(:disabled)')`,
        ),
        true,
      );
      await press('Escape');
      assert.equal(
        await evaluate(
          `document.activeElement===document.querySelector('.conversation-actions button') && !document.querySelector('.context-menu')`,
        ),
        true,
      );
      await evaluate(`document.querySelector('.conversation-link').focus()`);
      await press('F10', ['shift']);
      assert.equal(
        await evaluate(`!!document.querySelector('.context-menu')`),
        true,
        'Shift+F10 opens the row menu on every desktop platform',
      );
      await press('Escape');
      assert.equal(await evaluate(`document.activeElement===document.querySelector('.conversation-link')`), true);
      await evaluate(`document.querySelector('.project-name').focus()`);
      await press('F10', ['shift']);
      assert.equal(
        await evaluate(`!!document.querySelector('.context-menu')`),
        true,
        'project rows also support Shift+F10',
      );
      await press('Escape');
      assert.equal(await evaluate(`document.activeElement===document.querySelector('.project-name')`), true);
      await evaluate(`document.querySelector('.conversation-link').focus()`);
      await evaluate(
        `document.querySelector('.conversation-link').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:200,button:2}))`,
      );
      await frame();
      assert.equal(
        await evaluate(
          `(()=>{const b=document.querySelector('.context-menu').getBoundingClientRect();return b.left===100&&b.top===200})()`,
        ),
        true,
        'mouse context menu keeps its pointer position even with detail zero',
      );
      await press('Escape');
      for (const appearance of ['light', 'dark']) {
        await evaluate(`document.documentElement.dataset.theme='${appearance}';window.fixture.events.onerror()`);
        await frame();
        assert.equal(await evaluate(`document.querySelector('.connection-dot').getAttribute('role')`), 'img');
        assert.equal(
          await evaluate(`document.querySelector('.connection-dot').getAttribute('aria-label')`),
          '重新连接中',
        );
        assert.equal(await evaluate(`document.querySelector('.connection-dot').tabIndex`), -1);
        assert.match(await evaluate(`document.querySelector('.sidebar-status').textContent`), /重新连接中/);
        await screenshot(`a11y-sidebar-reconnecting-${appearance}.png`);
      }
      await evaluate(`window.fixture.events.onopen()`);
      for (let i = 0; i < 20 && !(await evaluate(`!!document.querySelector('.connection-dot.connected')`)); i++)
        await frame();
      assert.equal(
        await evaluate(`document.querySelector('.connection-dot').getAttribute('aria-label')`),
        '已连接本地服务',
      );
      assert.doesNotMatch(
        await evaluate(`document.querySelector('.sidebar-status').textContent`),
        /已连接本地服务|重新连接中|正在连接/,
      );
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
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.sidebar-tools button')].map(b=>b.textContent)"),
        ['扩展', '任务列表', '用量与连接', '设置'],
      );
      for (const theme of ['light', 'dark']) {
        win.setSize(1440, 1000);
        await frame();
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        await nav('设置');
        for (const width of [1440, 1040, 380]) {
          win.setSize(width, 1000);
          await frame();
          await fits();
          const box = await evaluate(
            "(()=>{const r=document.querySelector('.settings-shell').getBoundingClientRect();const p=document.querySelector('#main-content');return {width:r.width,left:r.left,parentLeft:p.getBoundingClientRect().left,padding:parseFloat(getComputedStyle(p).paddingLeft)}})()",
          );
          assert.ok(box.width <= 900 && Math.abs(box.left - box.parentLeft - box.padding) < 1, JSON.stringify(box));
          await screenshot(`settings-${theme}-${width}.png`);
        }
        await evaluate('window.fixture.deletedChats=[]');
        await click('[data-settings-category=conversation]');
        for (const [label, kind] of [
          ['已归档', 'archived'],
          ['最近删除', 'deleted'],
        ]) {
          await click('[aria-label="管理' + label + '"]');
          assert.equal(
            await evaluate(`!!document.querySelector('.conversation-archive[aria-label="${label}"]')`),
            true,
          );
          assert.equal(await evaluate(`window.fixture.calls.some(c=>c.path==='/api/${kind}-conversations')`), true);
          assert.doesNotMatch(
            await evaluate("document.querySelector('.conversation-archive').textContent"),
            /永久删除/,
          );
          assert.equal(
            await evaluate(
              "[...document.querySelectorAll('.conversation-archive .side-sheet-actions button')].map(b=>b.textContent.trim()).filter(t=>t!=='').join('|')",
            ),
            kind === 'archived' ? '全部删除' : '清空',
          );
          if (kind === 'deleted') {
            for (
              let i = 0;
              i < 50 &&
              !(await evaluate("document.querySelector('.conversation-archive').textContent.includes('暂无对话')"));
              i++
            )
              await frame();
            assert.equal(
              await evaluate("document.querySelector('.conversation-archive .side-sheet-actions button').disabled"),
              true,
              'Empty is disabled when there are no chats or pending cleanups',
            );
            await click('.conversation-archive [aria-label="关闭"]');
            await evaluate(
              "window.fixture.deletedChats=[{id:'deleted-chat',projectId:'project',title:'合成已删除对话',createdAt:'2026-10-13T20:00:00.000Z',updatedAt:'2026-10-13T20:00:00.000Z',deletedAt:'2026-10-13T20:00:00.000Z',deletedByUser:true}]",
            );
            await click('[aria-label="管理最近删除"]');
            for (
              let i = 0;
              i < 50 &&
              !(await evaluate("!document.querySelector('.conversation-archive .side-sheet-actions button').disabled"));
              i++
            )
              await frame();
            assert.equal(
              await evaluate("document.querySelector('.conversation-archive .side-sheet-actions button').disabled"),
              false,
            );
            await click('.conversation-archive .side-sheet-actions button');
            for (let i = 0; i < 50 && !(await evaluate("!!document.querySelector('dialog[open]')")); i++) await frame();
            assert.match(await evaluate("document.querySelector('dialog[open]').textContent"), /此列表中的 1 个对话/);
            await screenshot('empty-confirm-' + theme + '.png');
            await click('dialog[open] .button.secondary');
            assert.equal(
              await evaluate("window.fixture.calls.some(c=>c.path==='/api/deleted-conversations/empty')"),
              false,
            );
          }
          await click('.conversation-archive [aria-label="关闭"]');
        }
        win.setSize(1440, 1000);
        await frame();
        await screenshot(`sidebar-${theme}.png`);
        await nav('任务列表');
        assert.equal(
          await evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"),
          '定时任务',
        );
        assert.equal(await evaluate("!!document.querySelector('.routines-page')"), true);
        await evaluate("window.fixture.state.workflows=[{id:'synthetic-queued',status:'queued'}];window.broadcast()");
        await frame();
        assert.equal(await evaluate("document.querySelector('.page-tabs .nav-count').textContent"), '1');
        assert.equal(
          await evaluate(
            "(()=>{const badge=document.querySelector('.page-tabs .nav-count');return getComputedStyle(badge).backgroundColor!==getComputedStyle(badge.parentElement.parentElement).backgroundColor})()",
          ),
          true,
        );
        await screenshot(`tasks-${theme}.png`);
        await evaluate('window.fixture.state.workflows=[];window.broadcast()');
        await frame();
        await click('.conversation-link');
        await click('[aria-label="调度选项"]');
        await choose('任务执行器', 'claude');
        assert.equal(await evaluate('!!document.querySelector(\'select[aria-label="任务模型"]\')'), true);
        await choose('任务模型', 'opus');
        assert.match(
          await evaluate('document.querySelector(\'[aria-label="调度选项"]\').textContent'),
          /Anthropic · Opus 5.5/,
        );
        await click('.composer-chips > .chip-more');
        const planned = await evaluate('document.querySelector(\'[aria-label="先计划"]\').checked');
        await click('[aria-label="先计划"]');
        assert.equal(await evaluate('document.querySelector(\'[aria-label="先计划"]\').checked'), !planned);
        for (const width of [1440, 380]) {
          win.setSize(width, 1000);
          await frame();
          await fits();
          await click('.chip-select:has(select[aria-label="任务模型"]) .chip-value');
          assert.equal(
            await evaluate("document.querySelector('[role=option][aria-selected=true]').textContent"),
            'Opus 5.5',
          );
          await screenshot(`models-${theme}-${width}.png`);
          await click('.chip-select:has(select[aria-label="任务模型"]) .chip-value');
        }
        await choose('任务执行器', '');
        assert.equal(await evaluate('!!document.querySelector(\'select[aria-label="任务模型"]\')'), false);
        await click('[aria-label="调度选项"]');
      }
      win.setSize(1440, 1000);
      await frame();
      await click('[aria-label="调度选项"]');
      await choose('任务执行器', 'claude');
      await choose('任务模型', 'opus');
      await evaluate('document.querySelector(\'.chip-select:has(select[aria-label="任务模型"]) .chip-value\').focus()');
      for (const keyCode of ['ArrowDown', 'ArrowDown', 'Enter']) {
        await evaluate(
          `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(keyCode)},bubbles:true,cancelable:true}))`,
        );
        await frame();
      }
      assert.equal(await model(), 'sonnet', 'model menu supports keyboard selection');
      await choose('任务模型', 'opus');
      await evaluate('window.fixture.state.runtimes[0].models=[];window.broadcast()');
      await frame();
      assert.equal(await model(), 'opus');
      await evaluate(
        'window.fixture.state.refreshing=true;window.fixture.state.runtimes[0].models=window.fixture.models.slice(1);window.broadcast()',
      );
      await frame();
      assert.equal(await model(), 'opus');
      await evaluate('window.fixture.state.refreshing=false;window.broadcast()');
      await frame();
      assert.equal(await model(), '');
      assert.match(
        await evaluate("document.querySelector('.conversation-composer').textContent"),
        /所选模型已不可用，已改为自动/,
      );
      assert.deepEqual(rendererErrors, []);
      console.log(
        'PASS ui-polish renderer: footer, archives, tasks, models, refresh/fallback, plan switch, 14 screenshots',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
