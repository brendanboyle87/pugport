// Run with Node. A hidden Electron renderer uses only this local fixture server.
// No real backend, CLI, model request, account data or user profile is involved.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { electronArgs } = require('../tests/helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const out = path.join(root, 'reports', 'comborunner-v001');
const reportPath = path.join(out, 'core-ui-smoke.json');

if (!process.versions.electron) {
  void (async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-core-ui-'));
    let cleaned = false;
    try {
      const { spawn } = require('node:child_process');
      const environment = { ...process.env, AGENT_STUDIO_CORE_UI_PROFILE: profile };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        windowsHide: true,
        stdio: 'inherit',
        env: environment,
      });
      const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
      process.exitCode = exitCode;
    } finally {
      const temp = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(profile);
      assert.equal(path.dirname(resolved).toLowerCase(), temp.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('agent-studio-core-ui-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      cleaned = true;
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
      if (!report.passed) process.exitCode = 1;
      report.temporaryProfileRemoved = cleaned;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ passed: report.passed, checks: report.checks, temporaryProfileRemoved: cleaned }));
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const http = require('node:http');
  const profile = process.env.AGENT_STUDIO_CORE_UI_PROFILE;
  assert.ok(profile && path.basename(profile).startsWith('agent-studio-core-ui-'));
  app.setPath('userData', profile);
  const now = new Date().toISOString();
  const projectPath = 'C:/Fixture/Isolated';
  const targets = [
    {
      id: 'codex-native',
      provider: 'codex',
      label: 'Codex Native',
      command: 'fixture',
      enabled: true,
      environment: 'native',
    },
    { id: 'pi-local', provider: 'pi', label: 'Pi', command: 'fixture', enabled: true, environment: 'native' },
    // Deliberately stale enabled data proves the UI does not re-offer retired DSH.
    {
      id: 'dsh-local',
      provider: 'dsh',
      label: 'Legacy DSH Label',
      command: 'fixture',
      enabled: true,
      environment: 'native',
    },
  ];
  const runtimes = targets.slice(0, 2).map((target) => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low'] }],
    quota: { status: 'known', source: 'fixture', observedAt: now, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: now,
  }));
  const run = {
    id: 'legacy-run',
    prompt: 'Historical DSH task',
    projectPath,
    kind: 'general',
    status: 'completed',
    route: {
      runtimeId: 'dsh-local',
      model: 'historical-model',
      kind: 'general',
      reasons: ['Historical routing reason'],
      warnings: [],
    },
    startedAt: now,
    endedAt: now,
    output: 'Preserved historical output',
    events: [],
  };
  const metrics = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningOutputTokens',
    'totalTokens',
    'estimatedCostUsd',
  ];
  const measures = Object.fromEntries(metrics.map((metric) => [metric, metric === 'estimatedCostUsd' ? 0.01 : 10]));
  const aggregate = {
    ...measures,
    runs: 1,
    reportedRuns: 1,
    tokenReportedRuns: 1,
    costReportedRuns: 1,
    historyImportedRuns: 1,
    uncertainRuns: 0,
    accountingRuns: { subscription: 0, usage: 1, unknown: 0 },
    metricReportedRuns: Object.fromEntries(metrics.map((metric) => [metric, 1])),
  };
  const usage = {
    generatedAt: now,
    filters: {},
    totals: aggregate,
    byProject: [{ ...aggregate, projectPath }],
    byRuntime: [{ ...aggregate, runtimeId: 'dsh-local', label: targets[2].label, provider: 'dsh' }],
    byModel: [{ ...aggregate, runtimeId: 'dsh-local', model: run.route.model }],
    perRun: [
      {
        ...measures,
        runId: run.id,
        projectPath,
        runtimeId: 'dsh-local',
        runtimeLabel: targets[2].label,
        provider: 'dsh',
        model: run.route.model,
        accountingMode: 'usage',
        status: 'completed',
        startedAt: now,
        eventCount: 1,
        historyImported: true,
        uncertain: false,
        sources: ['fixture'],
        notes: [],
      },
    ],
  };
  const workflow = {
    id: 'pending-workflow',
    projectId: 'project',
    conversationId: 'conversation',
    userMessageId: 'message',
    input: {
      content: 'Future queued fixture',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
      schedule: { notBefore: new Date(Date.now() + 86400000).toISOString(), preferExpiringQuota: true },
    },
    status: 'queued',
    phase: 'queue',
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: now,
    updatedAt: now,
    scheduling: {
      reason: '等待最早开始时间',
      nextAttemptAt: new Date(Date.now() + 86400000).toISOString(),
      estimatedMinutes: 3,
      lastEvaluatedAt: now,
    },
  };
  const historical = {
    ...workflow,
    id: 'historical-workflow',
    userMessageId: 'history-message',
    input: { ...workflow.input, content: 'Historical DSH task', schedule: undefined },
    status: 'completed',
    phase: 'summarize',
    runIds: [run.id],
    planning: { strategy: 'direct', reason: '简单任务直接执行。' },
    scheduling: undefined,
  };
  const state = {
    app: { name: 'PugPort', version: pkg.version, platform: 'win32', dataDir: 'fixture' },
    targets,
    runtimes,
    runs: [run],
    approvals: [],
    plugins: [{ id: 'dsh', name: 'DeepSeek Harness', kind: 'runtime', installed: true, homepage: '' }],
    refreshing: false,
    usage,
    settings: {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 120,
      preferCli: true,
      designProvider: 'dsh',
      architectureProvider: 'codex',
      routineProvider: 'codex',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: projectPath,
      maxConcurrentRuns: 1,
    },
    projects: [{ id: 'project', name: 'Fixture project', path: projectPath, createdAt: now, updatedAt: now }],
    conversations: [
      { id: 'conversation', projectId: 'project', title: 'Fixture conversation', createdAt: now, updatedAt: now },
    ],
    workflows: [workflow, historical],
    conversationMessages: [workflow, historical].map((item) => ({
      id: item.userMessageId,
      conversationId: 'conversation',
      role: 'user',
      content: item.input.content,
      workflowId: item.id,
      createdAt: now,
    })),
  };
  let window, server;
  const sockets = new Set(),
    events = new Set(),
    requests = [],
    checks = [],
    errors = [];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = (source) => window.webContents.executeJavaScript(source, true);
  const publish = () => {
    for (const response of events) response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  };
  async function wait(source) {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(source)) return;
      await pause(80);
    }
    throw new Error('UI wait timed out: ' + source);
  }
  async function clickText(selector, text) {
    await evaluate(
      `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim().startsWith(${JSON.stringify(text)}));if(!el)throw Error('Missing control');el.click()})()`,
    );
    await pause(100);
  }
  async function select(selector, value) {
    await evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
    await pause(100);
  }
  async function capture(name) {
    await window.webContents.capturePage();
    await pause(300);
    await fs.writeFile(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  void app.whenReady().then(async () => {
    await fs.mkdir(out, { recursive: true });
    const report = { at: now, fixture: true, realModelRequests: 0, passed: false, checks, errors };
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
          requests.push({ method: req.method, path: url.pathname });
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'GET' && url.pathname === '/api/session') res.end(JSON.stringify({ token: 'fixture' }));
          else if (req.method === 'GET' && url.pathname === '/api/state') res.end(JSON.stringify(state));
          else if (req.method === 'GET' && url.pathname === '/api/usage') res.end(JSON.stringify(usage));
          else {
            res.statusCode = 400;
            errors.push(`Unexpected fixture API: ${req.method} ${url.pathname}`);
            res.end(JSON.stringify({ error: 'Only fixture reads are allowed' }));
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
        },
      });
      await window.loadURL(`http://127.0.0.1:${server.address().port}`);
      await wait(
        `document.body.innerText.includes('已连接本地服务') && document.body.innerText.includes(${JSON.stringify('v' + pkg.version)})`,
      );
      assert.equal(await evaluate('document.title'), 'PugPort · 本地工作台');
      assert.equal(await evaluate(`document.querySelector('.studio-brand strong').innerText`), 'PugPort');
      await evaluate(
        `localStorage.setItem('agent-studio-theme','dark');localStorage.setItem('agent-studio-project','project');localStorage.setItem('agent-studio-conversation','conversation')`,
      );
      await window.webContents.reload();
      await wait(
        `document.querySelector('.conversation-link.selected') && document.querySelector('select[aria-label="外观主题"]').value==='dark' && document.documentElement.dataset.theme==='dark'`,
      );
      checks.push('PugPort branding and legacy theme/project/conversation selections preserved');
      await evaluate(`document.querySelector('button[aria-label="添加项目"]').click()`);
      await wait(`!!document.querySelector('dialog[open]')`);
      assert.equal(await evaluate(`!!document.querySelector('button[aria-label="选择项目文件夹"]')`), false);
      assert.equal(await evaluate(`document.querySelector('input[aria-label="项目文件夹路径"]').value`), projectPath);
      await evaluate(`document.querySelector('button[aria-label="关闭添加项目"]').click()`);
      await evaluate(
        `window.comboRunnerDesktop={pickDirectory:()=>{window.__pickerCalls=(window.__pickerCalls||0)+1;return new Promise((resolve,reject)=>{window.__resolvePicker=resolve;window.__rejectPicker=reject})}};undefined`,
      );
      await evaluate(`document.querySelector('button[aria-label="添加项目"]').click()`);
      await wait(`!!document.querySelector('button[aria-label="选择项目文件夹"]')`);
      assert.ok(
        await evaluate(
          `document.querySelector('.desktop-background-note').innerText.includes('关闭窗口后在托盘继续运行') && document.querySelector('.desktop-background-note').innerText.includes('退出应用会停止任务')`,
        ),
      );
      await evaluate(
        `(()=>{const button=document.querySelector('button[aria-label="选择项目文件夹"]');button.click();button.click()})()`,
      );
      await wait(`document.querySelector('button[aria-label="选择项目文件夹"]').disabled`);
      assert.equal(await evaluate('window.__pickerCalls'), 1);
      assert.ok(
        await evaluate(
          `document.querySelector('button[aria-label="关闭添加项目"]').disabled && document.querySelector('input[aria-label="项目文件夹路径"]').disabled`,
        ),
      );
      await evaluate('window.__resolvePicker(null)');
      await wait(`!document.querySelector('button[aria-label="选择项目文件夹"]').disabled`);
      assert.equal(await evaluate(`document.querySelector('input[aria-label="项目文件夹路径"]').value`), projectPath);
      await evaluate(`document.querySelector('button[aria-label="选择项目文件夹"]').click()`);
      await evaluate(`window.__rejectPicker(new Error('Fixture picker failure'))`);
      await wait(`!!document.querySelector('.directory-picker-error')`);
      assert.equal(await evaluate(`document.querySelector('input[aria-label="项目文件夹路径"]').value`), projectPath);
      assert.equal(await evaluate(`document.querySelector('button[aria-label="选择项目文件夹"]').disabled`), false);
      await evaluate(`document.querySelector('button[aria-label="选择项目文件夹"]').click()`);
      await evaluate(`window.__resolvePicker('C:/Fixture/Chosen folder')`);
      await wait(`document.querySelector('input[aria-label="项目文件夹路径"]').value==='C:/Fixture/Chosen folder'`);
      assert.equal(await evaluate(`!!document.querySelector('.directory-picker-error')`), false);
      assert.equal(await evaluate('window.__pickerCalls'), 3);
      await capture('project-folder-picker');
      await evaluate(`document.querySelector('button[aria-label="关闭添加项目"]').click()`);
      checks.push(
        'optional desktop folder bridge handles cancel/error/retry/selection and prevents concurrent picks; Web manual input remains',
      );
      await clickText('.nav-item', '执行器与账号');
      assert.equal(await evaluate(`document.querySelectorAll('.target-card').length`), 2);
      assert.ok(
        !(await evaluate(
          `document.body.innerText.includes('DeepSeek Harness') || document.body.innerText.includes('打开管理')`,
        )),
      );
      checks.push('DSH management/configuration removed');
      await clickText('.nav-item', '设置');
      await select('select[aria-label="外观主题"]', 'light');
      await wait(`document.documentElement.dataset.theme==='light'`);
      assert.deepEqual(
        await evaluate(
          `(()=>{const e=document.querySelector('select[aria-label="设计类任务"]');return {value:e.value,disabled:e.selectedOptions[0].disabled,label:e.selectedOptions[0].text}})()`,
        ),
        { value: 'dsh', disabled: true, label: 'DeepSeek Harness · 不可用' },
      );
      assert.equal(await evaluate(`!!document.querySelector('#settings-judgment')`), false);
      assert.equal(await evaluate(`!!document.querySelector('[aria-label="Jev Key"]')`), false);
      assert.equal(await evaluate(`!!document.querySelector('select[aria-label="任务判断方式"]')`), false);
      assert.equal(await evaluate(`!!document.querySelector('select[aria-label="历史证据筛选"]')`), false);
      checks.push('retired cloud classification controls are absent');
      await select('select[aria-label="基础类任务"]', 'pi');
      assert.ok(await evaluate(`document.querySelector('.settings-save button').disabled`));
      checks.push('stale form DSH preference shown as unavailable and blocks saving without explicit replacement');
      await capture('settings-unavailable-preference-light');
      await select('select[aria-label="设计类任务"]', 'codex');
      assert.equal(await evaluate(`document.querySelector('.settings-save button').disabled`), false);
      await capture('settings-local-router-light');
      await clickText('.conversation-link', 'Fixture conversation');
      await evaluate(`document.querySelector('button[aria-label="调度选项"]').click()`);
      assert.ok(
        !(await evaluate(`!!document.querySelector('select[aria-label="任务执行器"] option[value="dsh-local"]')`)),
      );
      await select('select[aria-label="任务执行器"]', 'codex-native');
      targets[0].enabled = false;
      publish();
      await wait(`document.querySelector('select[aria-label="任务执行器"]').selectedOptions[0].disabled`);
      assert.equal(await evaluate(`document.querySelector('select[aria-label="任务执行器"]').value`), 'codex-native');
      await evaluate(
        `(()=>{const e=document.querySelector('#conversation-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Do not submit fixture');e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
      );
      await wait(`document.querySelector('#conversation-input').value==='Do not submit fixture'`);
      assert.ok(await evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`));
      await evaluate(
        `document.querySelector('#conversation-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))`,
      );
      await pause(100);
      checks.push(
        'selected runtime removed by state update stays visible and keyboard/button submission cannot silently reroute',
      );
      await evaluate(`document.querySelector('button[aria-label="关闭提示"]')?.click()`);
      targets[0].enabled = true;
      publish();
      await select('select[aria-label="任务执行器"]', '');
      assert.equal(await evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), false);
      assert.ok(
        await evaluate(
          `document.querySelector('.workflow-completed').innerText.includes('Legacy DSH Label') && document.querySelector('.workflow-completed').textContent.includes('直接执行')`,
        ),
      );
      await clickText('.nav-item', '任务队列');
      assert.equal(await evaluate(`document.querySelectorAll('.queue-item').length`), 1);
      assert.ok(await evaluate(`document.querySelector('.queue-overview').innerText.includes('0 执行')`));
      await select('select[aria-label="队列状态"]', 'all');
      await evaluate(`document.querySelector('[data-workflow-id="historical-workflow"] summary').click()`);
      assert.ok(
        await evaluate(
          `document.querySelector('[data-workflow-id="historical-workflow"]').innerText.includes('Legacy DSH Label')`,
        ),
      );
      checks.push('queue and conversation retain historical DSH names and recorded planning strategy');
      await select('select[aria-label="外观主题"]', 'light');
      await wait(`document.documentElement.dataset.theme==='light'`);
      await capture('core-queue-light');
      await select('select[aria-label="外观主题"]', 'dark');
      await wait(`document.documentElement.dataset.theme==='dark'`);
      await capture('core-queue-dark');
      nativeTheme.themeSource = 'light';
      await select('select[aria-label="外观主题"]', 'system');
      await wait(`document.documentElement.dataset.theme==='light'`);
      nativeTheme.themeSource = 'dark';
      await wait(`document.documentElement.dataset.theme==='dark'`);
      window.setSize(1050, 760);
      await pause(150);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
      window.setSize(390, 844);
      await pause(150);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
      await capture('core-queue-mobile');
      window.setSize(1440, 1000);
      await pause(150);
      checks.push('light dark live system theme and 1050/390 widths preserved');
      await clickText('.nav-item', '执行记录');
      await clickText('.run-record-item', 'Historical DSH task');
      assert.ok(
        await evaluate(
          `document.querySelector('.run-context').innerText.includes('Legacy DSH Label') && document.querySelector('.agent-output').innerText.includes('Preserved historical output')`,
        ),
      );
      await clickText('.output-tools button', '交接');
      assert.ok(!(await evaluate(`!!document.querySelector('.modal option[value="dsh-local"]')`)));
      await evaluate(`document.querySelector('button[aria-label="关闭交接窗口"]').click()`);
      checks.push('historical output retained and DSH excluded from new handoff targets');
      await clickText('.nav-item', '用量与资源');
      assert.equal(await evaluate(`document.querySelectorAll('.quota-card').length`), 2);
      await clickText('.resource-tabs button', '累计消耗');
      await wait(`!!document.querySelector('.usage-totals')`);
      assert.ok(
        await evaluate(`!!document.querySelector('select[aria-label="用量执行器范围"] option[value="dsh-local"]')`),
      );
      await clickText('.usage-group-tabs button', '每次调用');
      assert.ok(
        await evaluate(
          `document.querySelector('.usage-table').innerText.includes('Legacy DSH Label') && document.querySelector('.usage-table').innerText.includes('historical-model')`,
        ),
      );
      checks.push('historical DSH usage remains filterable with original name and model');
      assert.equal(requests.filter((request) => request.method !== 'GET').length, 0);
      assert.deepEqual(errors, []);
      report.passed = true;
    } catch (error) {
      errors.push(String(error.stack || error));
      await capture('core-ui-failure').catch(() => {});
      console.error(error);
      process.exitCode = 1;
    } finally {
      report.requests = requests;
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      window?.destroy();
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
      app.quit();
    }
  });
}
