// Synthetic conversation only, in an always-hidden offscreen Electron window.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { electronArgs } = require('./helpers/electron-app.cjs');
const { offscreenElectronEnv } = require('./helpers/offscreen-electron.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-marker-renderer-'));
    const output = path.resolve(process.argv[2] || fixture);
    await fs.mkdir(output, { recursive: true });
    try {
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationHistory} from './src/ui/Workspace';
import {startInterfaceLanguage} from './src/ui/i18n';
window.useEnglish=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();};
import './src/ui/studio.css';
const root=createRoot(document.getElementById('root'));
const stamp=new Date().toISOString();
const message=(id,role,content,extra={})=>({id,role,content,conversationId:'fixture',createdAt:stamp,...extra});
const task=(id,status,extra={})=>({id,conversationId:'fixture',projectId:'project',userMessageId:id==='first'?'question':'resume',finalMessageId:id==='first'?'failure':'answer',input:{content:'Synthetic question',mode:'chat',permissionMode:'read-only',executionPolicy:'cli-first'},status,phase:'execute',plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp,...extra});
const workflows=[task('first','interrupted',{followUp:{workflowId:'next',kind:'continue',at:stamp}}),task('next','completed')];
window.renderFixture=(supplement,legacy=false)=>flushSync(()=>root.render(<ConversationHistory
  messages={[
    message('question','user','请检查 Mooncake 的缓存配置，并总结需要修改的地方。',{workflowId:'first'}),
    message('failure','assistant','检查中断，尚未完成配置核对。',{workflowId:'first',systemNotice:{text:'检查中断，尚未完成配置核对。'}}),
    message('resume','user',legacy?'继续同一任务。保留的原始需求：\\nOriginal\\n\\n用户补充（按时间先后）：\\n'+(supplement||'无')+'\\n\\n已有步骤状态：\\nfailed\\n不得直接重放。':supplement,legacy?{}:{resumed:true}),
    message('answer','assistant','缓存配置已核对。建议将过期时间从 60 秒调整为 300 秒，并保留手动刷新入口。',{workflowId:'next'}),
  ]}
  workflows={workflows} state={{targets:[],runtimes:[],runs:[],workflows,settings:{}}}
  api={async()=>({})} notify={()=>{}} onInspect={()=>{}} onConversation={()=>{}}
/>));
window.renderFixture('');`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: offscreenElectronEnv({ ...process.env, RESUME_MARKER_FIXTURE: fixture, RESUME_MARKER_OUTPUT: output }),
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 45000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timeout));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('resume-marker-renderer-'));
      // Keep default screenshots available when the caller did not specify an output directory.
      if (output !== fixture) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.RESUME_MARKER_FIXTURE;
  assert.ok(fixture && path.basename(fixture).startsWith('resume-marker-renderer-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  app.whenReady().then(async () => {
    try {
      win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 760,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: /^https?:/.test(details.url) }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      for (const theme of ['light', 'dark']) {
        for (const supplement of ['', '再查一下 Mooncake']) {
          await evaluate(
            `document.documentElement.dataset.theme=${JSON.stringify(theme)};window.renderFixture(${JSON.stringify(supplement)})`,
          );
          await evaluate('document.fonts.ready');
          await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          assert.equal(win.isVisible(), false);
          assert.equal(await evaluate('document.querySelectorAll(".resume-divider").length'), 0);
          assert.equal(await evaluate('document.querySelectorAll(".message-user").length'), supplement ? 2 : 1);
          assert.equal(await evaluate('document.querySelectorAll(".message-assistant").length'), 1);
          assert.equal(
            await evaluate(
              'document.querySelectorAll("#workflow-first, .system-notice, [data-message-id=failure]").length',
            ),
            0,
          );
          assert.equal(
            await evaluate(
              'document.body.textContent.match(/结果未确认|已创建续接任务|查看后续任务|检查中断|从中断处继续/)',
            ),
            null,
          );
          assert.equal(await evaluate('document.body.textContent.includes("已有步骤状态")'), false);
          await fs.writeFile(
            path.join(process.env.RESUME_MARKER_OUTPUT, `${theme}-${supplement ? 'supplement' : 'empty'}.png`),
            (await win.webContents.capturePage()).toPNG(),
          );
        }
      }
      // The editor receives recovered text, never the legacy executor wrapper.
      for (const legacy of [false, true]) {
        await evaluate(`window.renderFixture('再查一下 Mooncake',${legacy})`);
        await evaluate('document.querySelector(\'[data-message-id="resume"] [aria-label="编辑"]\').click()');
        assert.equal(await evaluate('document.querySelector("textarea").value'), '再查一下 Mooncake');
        await evaluate('window.renderFixture("")');
      }
      await evaluate('window.useEnglish()');
      assert.equal(await evaluate('document.querySelectorAll(".resume-divider, [data-message-id=resume]").length'), 0);
      console.log('PASS: traceless completed continuation, supplement, legacy edit; four light/dark screenshots.');
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      win?.destroy();
      app.exit(1);
    }
  });
}
