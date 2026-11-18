// Isolated renderer smoke: fixture HTTP only, temporary Electron profile, no real account or model.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { electronArgs } = require('../tests/helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'reports', 'composer-smoke');
const reportPath = path.join(out, 'result.json');

if (!process.versions.electron) {
  void (async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-composer-smoke-'));
    try {
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(
        reportPath,
        JSON.stringify({ passed: false, checks: [], errors: ['Renderer smoke has not completed'] }),
      );
      const environment = { ...process.env, COMBORUNNER_COMPOSER_SMOKE_PROFILE: profile };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        windowsHide: true,
        stdio: 'inherit',
        env: environment,
      });
      const timeout = setTimeout(() => child.kill(), 90000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (value) => resolve(value ?? 1));
      }).finally(() => clearTimeout(timeout));
      process.exitCode = code;
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(profile);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-composer-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      const report = JSON.parse(
        await fs
          .readFile(reportPath, 'utf8')
          .catch(() => '{"passed":false,"checks":[],"errors":["Electron did not finish within 90 seconds"]}'),
      );
      report.temporaryProfileRemoved = true;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ passed: report.passed, checks: report.checks, temporaryProfileRemoved: true }));
      if (!report.passed) process.exitCode = 1;
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const http = require('node:http');
  const captureScreenshots = process.env.COMBORUNNER_COMPOSER_SMOKE_SCREENSHOTS !== '0';
  const profile = process.env.COMBORUNNER_COMPOSER_SMOKE_PROFILE;
  assert.ok(profile && path.basename(profile).startsWith('comborunner-composer-smoke-'));
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  const now = new Date().toISOString();
  const projectPath = 'C:/Fixture/Composer';
  const target = {
    id: 'codex-native',
    provider: 'codex',
    label: 'Fixture Codex',
    command: 'fixture-never-executed',
    enabled: true,
    environment: 'native',
  };
  const history = Array.from({ length: 3000 }, (_, index) => ({
    id: `history-${index}`,
    conversationId: 'conversation',
    role: index % 2 ? 'assistant' : 'user',
    content: `Fixture message ${index}\n\n- Retained local history\n- No account data\n\n\`\`\`ts\nconst step = ${index};\n\`\`\``,
    createdAt: new Date(Date.parse(now) - (3000 - index) * 1000).toISOString(),
  }));
  const state = {
    app: {
      name: 'PugPort',
      version: require(path.join(root, 'package.json')).version,
      platform: 'win32',
      dataDir: 'fixture',
    },
    targets: [target],
    runtimes: [
      {
        ...target,
        installed: true,
        status: 'ready',
        models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low'] }],
        quota: { status: 'known', source: 'fixture', observedAt: now, windows: [] },
        capabilities: { execute: true, resume: true, cancel: true, approvals: true },
        refreshedAt: now,
      },
    ],
    runs: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    jev: { configured: false, enabled: false, status: 'not-configured' },
    settings: {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 120,
      preferCli: true,
      designProvider: 'codex',
      architectureProvider: 'codex',
      routineProvider: 'codex',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: projectPath,
      maxConcurrentRuns: 1,
    },
    projects: [{ id: 'project', name: 'Fixture project', path: projectPath, createdAt: now, updatedAt: now }],
    conversations: [
      { id: 'conversation', projectId: 'project', title: '3000 message fixture', createdAt: now, updatedAt: now },
    ],
    workflows: [],
    conversationMessages: [],
  };
  const report = {
    at: now,
    fixture: true,
    realModelRequests: 0,
    passed: false,
    checks: [],
    styles: [],
    typing: {},
    requests: [],
    errors: [],
  };
  const posts = [];
  const sockets = new Set();
  const events = new Set();
  let window, server;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = async (source) => {
    const result = await window.webContents.executeJavaScript(
      `(async()=>{try{return await (0,eval)(${JSON.stringify(source)})}catch(error){return {__smokeError:error.stack||String(error)}}})()`,
      true,
    );
    if (result?.__smokeError) throw new Error(result.__smokeError + '\nProbe: ' + source);
    return result;
  };
  async function wait(source) {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(source)) return;
      await pause(60);
    }
    throw new Error('Renderer wait timed out: ' + source);
  }
  async function select(selector, value) {
    await evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing select');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
    await pause(50);
  }
  async function theme(value) {
    const label = { light: '浅色', dark: '深色', system: '跟随系统' }[value];
    await evaluate(`[...document.querySelectorAll('.nav-item')].find(el=>el.textContent.trim()==='设置').click()`);
    await wait(`!!document.querySelector('.theme-options')`);
    await evaluate(
      `[...document.querySelectorAll('.theme-options button')].find(el=>el.textContent.trim()===${JSON.stringify(label)}).click()`,
    );
    await evaluate(`document.querySelector('.conversation-link').click()`);
    await wait(`document.querySelectorAll('.conversation-message').length===3000`);
    await evaluate(`document.querySelector('button[aria-label="调度选项"]').click()`);
    await select('select[aria-label="任务执行器"]', 'codex-native');
  }
  async function draft(text) {
    await evaluate(
      `(()=>{const el=document.querySelector('#conversation-input');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    );
    await wait(
      `document.querySelector('#conversation-input').value===${JSON.stringify(text)} && !document.querySelector('button[aria-label="发送消息"]').disabled`,
    );
  }
  async function enter(modifiers = []) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers });
    await pause(80);
  }
  function contrast(first, second) {
    const luminance = (value) => {
      const components = value
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number);
      assert.equal(components?.length, 3);
      return components
        .map((component) => {
          const s = component / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    };
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }
  async function inspectStyles(label, expectedTheme) {
    await wait(`document.documentElement.dataset.theme===${JSON.stringify(expectedTheme)}`);
    const styles = await evaluate(
      `(()=>{const names=['任务执行器','任务模型','任务理解方式','文件权限'];return names.map(name=>{const el=document.querySelector('select[aria-label="'+name+'"]');if(!el)throw Error('Missing select '+name);const s=getComputedStyle(el);return {name,scheme:s.colorScheme,options:[...el.options].filter(option=>!option.disabled).map(option=>{const style=getComputedStyle(option);return {label:option.label,color:style.color,background:style.backgroundColor}})}})})()`,
    );
    for (const style of styles) {
      assert.equal(style.scheme, expectedTheme, `${label}: ${style.name} color-scheme`);
      for (const option of style.options) {
        assert.notEqual(option.background, 'rgba(0, 0, 0, 0)', `${label}: opaque option background`);
        option.contrast = Number(contrast(option.color, option.background).toFixed(2));
        assert.ok(option.contrast >= 4.5, `${label}: readable ${style.name}/${option.label}`);
      }
    }
    report.styles.push({ label, resolvedTheme: expectedTheme, styles });
    if (captureScreenshots)
      await fs.writeFile(
        path.join(out, label + '.png'),
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
    else report.screenshotsSkipped = true;
  }
  void app.whenReady().then(async () => {
    console.log('Composer fixture: Electron ready');
    await fs.mkdir(out, { recursive: true });
    try {
      server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': fixture\n\n');
          events.add(res);
          req.on('close', () => events.delete(res));
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          report.requests.push({ method: req.method, path: url.pathname });
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'GET' && url.pathname === '/api/session') res.end(JSON.stringify({ token: 'fixture' }));
          else if (req.method === 'GET' && url.pathname === '/api/state') res.end(JSON.stringify(state));
          else if (req.method === 'GET' && url.pathname === '/api/conversations/conversation')
            res.end(JSON.stringify({ messages: history }));
          else if (req.method === 'POST' && url.pathname === '/api/conversations/conversation/messages') {
            let content = '';
            for await (const chunk of req) content += chunk;
            posts.push(JSON.parse(content));
            res.end(JSON.stringify({ fixture: true }));
          } else {
            res.statusCode = 400;
            report.errors.push(`Unexpected fixture API: ${req.method} ${url.pathname}`);
            res.end(JSON.stringify({ error: 'Unsupported fixture operation' }));
          }
          return;
        }
        try {
          const directory = path.join(root, 'dist', 'ui');
          const file = path.resolve(directory, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
          assert.ok(file.startsWith(directory + path.sep));
          res.setHeader(
            'Content-Type',
            file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
          );
          res.end(await fs.readFile(file));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      console.log('Composer fixture: HTTP ready');
      const origin = `http://127.0.0.1:${server.address().port}`;
      const preload = path.join(profile, 'composer-probe-preload.cjs');
      await fs.writeFile(
        preload,
        `require('electron').contextBridge.executeInMainWorld({func:()=>{
        window.__historyReads=0;
        const originalFetch=window.fetch;
        window.fetch=async function(...args){const response=await originalFetch.apply(this,args);const url=new URL(String(args[0]),location.href);if(url.pathname==='/api/conversations/conversation'){const originalJson=response.json.bind(response);response.json=async()=>{const payload=await originalJson();for(const message of payload.messages){const content=message.content;Object.defineProperty(message,'content',{enumerable:true,get(){window.__historyReads++;return content}})}return payload}}return response};
        addEventListener('error',event=>{window.__rendererErrors=(window.__rendererErrors||[]).concat(event.message)});
      }});`,
      );
      window = new BrowserWindow({
        show: false,
        width: 1440,
        height: 1000,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
          preload,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith(origin + '/') }),
      );
      await window.loadURL(origin);
      console.log('Composer fixture: renderer loaded');
      await wait(`document.body.innerText.includes('已连接本地服务')`);
      await evaluate(
        `localStorage.setItem('agent-studio-project','project');localStorage.setItem('agent-studio-conversation','conversation');localStorage.setItem('agent-studio-theme','dark')`,
      );
      window.webContents.reload();
      await wait(`document.querySelectorAll('.conversation-message').length===3000`);
      assert.ok(
        await evaluate(`window.__historyReads>0`),
        'History getter instrumentation must observe initial render',
      );
      console.log('Composer fixture: 3000 history messages ready');
      await evaluate(`document.querySelector('button[aria-label="调度选项"]').click()`);
      await select('select[aria-label="任务执行器"]', 'codex-native');
      await inspectStyles('dark', 'dark');
      await theme('light');
      await inspectStyles('light', 'light');
      nativeTheme.themeSource = 'light';
      await theme('system');
      await inspectStyles('system-light', 'light');
      nativeTheme.themeSource = 'dark';
      await inspectStyles('system-dark', 'dark');
      report.checks.push('Dark/light/live system native select options have opaque backgrounds and contrast >=4.5');

      await draft('Native Enter fixture');
      await enter();
      await wait(`document.querySelector('#conversation-input').value===''`);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].content, 'Native Enter fixture');
      await draft('First line');
      await enter(['shift']);
      assert.equal(await evaluate(`document.querySelector('#conversation-input').value`), 'First line\n');
      assert.equal(posts.length, 1);
      report.checks.push('Native Enter sends exactly once; native Shift+Enter inserts a newline without sending');

      await draft('中文候选');
      await evaluate(
        `(()=>{const el=document.querySelector('#conversation-input');el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中文'}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,isComposing:true,bubbles:true,cancelable:true}))})()`,
      );
      await enter();
      assert.equal(posts.length, 1);
      await evaluate(
        `(()=>{const el=document.querySelector('#conversation-input');el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文候选'}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true,cancelable:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true}))})()`,
      );
      await pause(150);
      assert.equal(posts.length, 1);
      await evaluate(
        `document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}))`,
      );
      await pause(30);
      assert.equal(posts.length, 1);
      await enter();
      await wait(`document.querySelector('#conversation-input').value===''`);
      assert.equal(posts.length, 2);
      assert.equal(posts[1].content, '中文候选');
      report.checks.push(
        'IME active/isComposing, post-composition confirmation Enter, and keyCode229 never send; subsequent deliberate Enter sends',
      );

      await evaluate(
        `document.querySelector('#conversation-input').focus();window.__historyReads=0;window.__typingLatency=[]`,
      );
      for (const character of 'typing smoke') {
        await evaluate(`window.__inputStart=performance.now()`);
        window.webContents.sendInputEvent({ type: 'char', keyCode: character });
        await evaluate(
          `new Promise(resolve=>requestAnimationFrame(()=>{window.__typingLatency.push(performance.now()-window.__inputStart);resolve()}))`,
        );
      }
      report.typing = await evaluate(
        `({historyMessages:document.querySelectorAll('.conversation-message').length,characters:document.querySelector('#conversation-input').value,historicalContentReads:window.__historyReads,frameLatenciesMs:window.__typingLatency})`,
      );
      assert.equal(report.typing.characters, 'typing smoke');
      assert.equal(report.typing.historyMessages, 3000);
      assert.equal(report.typing.historicalContentReads, 0, 'Typing must not read the 3000 unchanged message bodies');
      report.checks.push('Typing with 3000 history messages reads zero unchanged historical message bodies');
      state.conversationMessages = [{ ...history.at(-1), content: 'Fixture refreshed history after typing' }];
      for (const response of events) response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      await wait(
        `document.querySelector('.conversation-message:last-child').textContent.includes('Fixture refreshed history after typing')`,
      );
      assert.equal(await evaluate(`document.querySelectorAll('.conversation-message').length`), 3000);
      report.checks.push(
        'A subsequent fixture state update replaces the latest history body without freezing conversation rendering',
      );
      assert.equal(posts.length, 2);
      assert.deepEqual(await evaluate(`window.__rendererErrors||[]`), []);
      assert.deepEqual(report.errors, []);
      report.passed = true;
    } catch (error) {
      report.errors.push(String(error.stack || error));
      console.error(error);
      if (window)
        try {
          await fs.writeFile(path.join(out, 'failure.png'), (await window.webContents.capturePage()).toPNG());
        } catch {}
      process.exitCode = 1;
    } finally {
      report.fixturePosts = posts;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      window?.destroy();
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
      app.exit(report.passed ? 0 : 1);
    }
  });
}
