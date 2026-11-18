// Isolated renderer only: fake APIs, temporary Electron profile, offscreen window, no account access or network.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-external-agents-smoke-'));
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
          (await fs.readFile(path.join(root, 'src/ui/composer.css'), 'utf8')) +
          '\n' +
          (await fs.readFile(path.join(root, 'src/ui/ExternalAgents.css'), 'utf8')) +
          '\n' +
          (await fs.readFile(path.join(root, 'src/ui/settings.css'), 'utf8')) +
          '\nbody{overflow:auto;margin:0}#root{padding:32px;max-width:900px;margin:auto;display:grid;gap:24px}@media(max-width:600px){#root{padding:16px}}',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalAgentsCard, ExternalReplyPanel } from './src/ui/ExternalAgents';
import { ConfirmDialogHost } from './src/ui/ConfirmDialog';
window.calls=[]; window.notices=[];
let agents=[
 {id:'grok-bot',name:'Grok Bot',kind:'web',description:'通过它的网页版提问',enabled:false,available:false,reason:'已关闭',url:'https://x.ai/bot',riskAccepted:false,queued:0},
 {id:'muse',name:'Muse',kind:'web',description:'通过 Meta Muse 网页版提问',enabled:false,available:false,reason:'已关闭',url:'',riskAccepted:false,queued:0},
];
const api=async(path,body,method)=>{
 window.calls.push({path,body,method});
 if(path==='/api/external-agents' && method==='GET') return {agents};
 if(method==='PATCH'){ const id=path.split('/').pop(); agents=agents.map(a=>a.id===id?{...a,...body,riskAccepted:true,available:true,reason:undefined,detection:{at:'x',ok:true,note:'能找到输入框，可以正常使用'}}:a); return {agents}; }
 return {ok:true};
};
const reply=(externalAgent,content)=>({id:'6f9619ff-8b86-4d11-b42d-00c04fc964ff',conversationId:'a',role:'assistant',content,createdAt:'2026-10-11T08:00:00Z',externalAgent});
const notify=(n)=>window.notices.push(n);
createRoot(document.getElementById('root')).render(<>
 <ConfirmDialogHost />
 <article id="following-fixture" className="conversation-message message-assistant"><div className="message-heading"><span>Muse</span></div><p>正在看，稍等。</p><p>这是稍后返回的完整答复。</p>
  <ExternalReplyPanel api={api} notify={notify} message={reply({agentId:'muse',name:'Muse',status:'done',following:{trackerId:'fake'},untrusted:true,request:'你好',updatedAt:'x'},'正在看，稍等。\\n\\n这是稍后返回的完整答复。')}/></article>
 <ExternalAgentsCard api={api} notify={notify}/>
 <article id="retired-fixture" className="conversation-message message-assistant"><div className="message-heading"><span>Codex 云端</span></div><p>Codex 云端已完成：任务 task_e_demo</p>
  <ExternalReplyPanel api={api} notify={notify} message={reply({agentId:'codex-cloud',name:'Codex 云端',status:'done',request:'x',updatedAt:'x',task:{id:'task_e_demo',state:'ready',projectPath:'D:/demo/repo',diff:'diff --git a/greeting.txt b/greeting.txt\\n--- a/greeting.txt\\n+++ b/greeting.txt\\n@@ -1 +1 @@\\n-hello\\n+你好',files:1,added:1,removed:1}},'Codex 云端已完成')}/></article>
 <article className="conversation-message message-assistant"><div className="message-heading"><span>Grok Bot</span></div>
  <ExternalReplyPanel api={api} notify={notify} onManageConnectors={id=>window.connectorsOpened=id} message={reply({agentId:'grok-bot',name:'Grok Bot',status:'needs-user',handoff:true,untrusted:true,request:'你好',updatedAt:'x',note:'Grok Bot 的页面要求人机验证。已把它的窗口放到最前面：请在那里完成，再回到 PugPort 点「重试」。'},'Grok Bot 需要你先处理一下它的页面。')}/></article>
</>);`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        plugins: [
          {
            name: 'restricted-worktree-resolution',
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (!args.path.startsWith('.') && !path.isAbsolute(args.path))
                  return {
                    path: require.resolve(args.path, { paths: [args.resolveDir || root] }),
                    namespace: 'source',
                  };
                const base = path.resolve(args.resolveDir || path.dirname(args.importer), args.path);
                const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts')].find(
                  (candidate) => require('node:fs').statSync(candidate, { throwIfNoEntry: false })?.isFile(),
                );
                return resolved ? { path: resolved, namespace: 'source' } : undefined;
              });
              builder.onLoad({ filter: /.*/, namespace: 'source' }, async (args) => ({
                contents: await fs.readFile(args.path),
                resolveDir: path.dirname(args.path),
                loader: args.path.endsWith('.tsx')
                  ? 'tsx'
                  : args.path.endsWith('.ts')
                    ? 'ts'
                    : args.path.endsWith('.json')
                      ? 'json'
                      : 'js',
              }));
            },
          },
        ],
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_EXTERNAL_AGENTS_SMOKE: fixture };
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
      assert.ok(path.basename(resolved).startsWith('pugport-external-agents-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_EXTERNAL_AGENTS_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-external-agents-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let win;
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const shot = async (name) => {
    await frame();
    await fs.writeFile(
      path.join(root, 'reports/external-agents', `${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
    );
  };
  void app.whenReady().then(async () => {
    try {
      await fs.mkdir(path.join(root, 'reports/external-agents'), { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 1000,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(fixture, 'index.html'));
      await frame();
      await frame();
      for (const theme of ['dark', 'light']) {
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        for (const width of [1100, 380]) {
          win.setSize(width, 1000);
          await frame();
          assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
          assert.match(await evaluate("document.getElementById('following-fixture').innerText"), /停止跟进/);
          assert.match(
            await evaluate("document.getElementById('following-fixture').innerText"),
            /正在留意 Muse 的后续回复/,
          );
          assert.equal(await evaluate("document.querySelectorAll('#following-fixture .spinning').length"), 0);
          assert.equal(await evaluate("!!document.querySelector('#following-fixture .external-reply.done')"), true);
          await shot(`following-${theme}-${width}`);
        }
      }
      win.setSize(1100, 1000);
      await evaluate(
        "document.documentElement.dataset.theme='dark'; document.querySelector('#following-fixture button').click()",
      );
      await frame();
      assert.equal(await evaluate("window.calls.some(c=>c.path.endsWith('/stop-following'))"), true);
      const body = () => evaluate('document.body.innerText');
      assert.match(await body(), /外部智能体/);
      await evaluate(
        "[...document.querySelectorAll('button')].find(b=>b.textContent==='设置例程，让回复回到 PugPort').click()",
      );
      assert.equal(await evaluate('window.connectorsOpened'), 'grok-bot');
      assert.equal(await evaluate("document.querySelectorAll('.settings-row').length"), 2);
      await shot('settings-off');
      const open = async () => {
        await evaluate(
          `document.querySelector('[aria-label="开启 Grok Bot"]').focus(); document.querySelector('[aria-label="开启 Grok Bot"]').click()`,
        );
        await frame();
      };
      const key = async (name) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: name });
        // A real Enter also sends a char event; the focused button's native click needs it.
        if (name === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: name });
        await frame();
      };
      const patches = () => evaluate("window.calls.filter(c=>c.method==='PATCH').map(c=>c.body)");
      await open();
      assert.match(await evaluate("document.querySelector('dialog').innerText"), /使用条款/);
      assert.equal(await evaluate("document.querySelectorAll('dialog li').length"), 4);
      assert.equal(await evaluate("document.querySelector('dialog').contains(document.activeElement)"), true);
      assert.deepEqual(await patches(), [], 'opening the dialog cannot enable the bot');
      await shot('confirmation-dark');
      for (let i = 0; i < 5; i++) {
        await key('Tab');
        assert.equal(
          await evaluate("document.querySelector('dialog').contains(document.activeElement)"),
          true,
          'Tab stays in the dialog',
        );
      }
      await key('Escape');
      assert.equal(await evaluate("document.querySelector('dialog') === null"), true);
      assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), '开启 Grok Bot');
      assert.deepEqual(await patches(), [], 'Escape leaves the bot disabled');
      await open();
      await evaluate(
        "document.querySelector('dialog').dispatchEvent(new MouseEvent('click', {bubbles:true,clientX:0,clientY:0}))",
      );
      await frame();
      assert.equal(await evaluate("document.querySelector('dialog') === null"), true, 'backdrop cancels');
      assert.deepEqual(await patches(), []);
      await open();
      win.setSize(380, 1000);
      await frame();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
      await shot('confirmation-narrow');
      win.setSize(1100, 1000);
      // Focus starts on Cancel; Tab to the confirm button before pressing Enter.
      await key('Tab');
      await key('Enter');
      await frame();
      assert.deepEqual(await patches(), [{ enabled: true, acceptRisk: true }]);
      assert.match(await body(), /可以使用/);
      for (
        let i = 0;
        i < 20 && (await evaluate("document.activeElement.getAttribute('aria-label')")) !== '关闭 Grok Bot';
        i++
      )
        await frame();
      assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), '关闭 Grok Bot');
      await evaluate("document.querySelector('[data-settings-item=grok-bot] .settings-row-expand').click()");
      await frame();
      assert.match(await body(), /可以使用 · 能找到输入框/);
      await shot('settings-on');
      assert.equal(await evaluate("document.querySelectorAll('#retired-fixture button').length"), 0);
      assert.equal(await evaluate("!!document.querySelector('#retired-fixture details pre')"), true);
      assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="交给它"]\')'), true);
      assert.match(await body(), /人机验证/);
      await evaluate("document.querySelector('.external-reply-diff').open=true");
      await shot('replies');
      win.setSize(380, 1000);
      await frame();
      assert.equal(
        await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),
        true,
        'Narrow view must not overflow horizontally',
      );
      await shot('narrow');
      console.log('PASS external agents renderer: card, risk confirmation, replies, narrow; reports/external-agents');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
