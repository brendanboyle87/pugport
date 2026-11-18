// Deterministic renderer fixture checks. No model requests or user configuration writes.
const { app, BrowserWindow, nativeTheme } = require('electron');
require('tsx/cjs');
const { usageInsights } = require('../src/server/usage-insights.ts');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'),
  out = process.env.USAGE_INSIGHTS_ARTIFACTS || path.join(root, 'reports', 'usage-ui-v3'),
  serversOut = process.env.USAGE_INSIGHTS_ARTIFACTS
    ? path.join(out, 'servers')
    : path.join(root, 'reports', 'usage-servers');
const now = new Date().toISOString(),
  projectPath = 'C:\\Example\\Fixture';
const metrics = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'estimatedCostUsd',
];
const measures = {
  inputTokens: 1200,
  outputTokens: 80,
  cacheReadTokens: 400,
  cacheWriteTokens: null,
  reasoningOutputTokens: null,
  totalTokens: 1680,
  estimatedCostUsd: 0.0125,
};
const aggregate = {
  ...measures,
  runs: 2,
  reportedRuns: 1,
  tokenReportedRuns: 1,
  costReportedRuns: 1,
  historyImportedRuns: 1,
  uncertainRuns: 1,
  accountingRuns: { subscription: 0, usage: 2, unknown: 0 },
  metricReportedRuns: Object.fromEntries(metrics.map((key) => [key, measures[key] === null ? 0 : 1])),
};
const model = { id: 'fixture-model', label: 'Fixture model', efforts: ['low'] };
const targets = [
  {
    id: 'pi-local',
    provider: 'pi',
    label: 'Pi Native RPC',
    command: 'fixture',
    args: [],
    enabled: true,
    environment: 'native',
    accountingMode: 'usage',
    commandDiscovery: 'fixed',
  },
];
const runtimes = [
  {
    ...targets[0],
    installed: true,
    status: 'ready',
    models: [model],
    quota: { status: 'unknown', source: 'fixture', observedAt: now, windows: [], note: 'No framework balance' },
    accounting: { mode: 'usage', source: 'fixture provider', note: '模型调用按用量统计。' },
    capabilities: { execute: true, cancel: true, resume: true, approvals: true },
    refreshedAt: now,
    lastConnectionTest: { at: now, ok: true, model: model.id },
  },
];
const report = {
  generatedAt: now,
  filters: {},
  totals: aggregate,
  byProject: [{ ...aggregate, projectPath }],
  byRuntime: [{ ...aggregate, runtimeId: 'pi-local', label: 'Pi Native RPC', provider: 'pi' }],
  byModel: [{ ...aggregate, runtimeId: 'pi-local', model: model.id }],
  perRun: [
    {
      ...measures,
      runId: 'fixture-run-01',
      projectPath,
      runtimeId: 'pi-local',
      runtimeLabel: 'Pi Native RPC',
      provider: 'pi',
      model: model.id,
      accountingMode: 'usage',
      executionKind: 'api',
      status: 'completed',
      startedAt: now,
      eventCount: 1,
      historyImported: true,
      uncertain: true,
      sources: ['fixture'],
      notes: ['Fixture data only'],
    },
  ],
  note: '仅用于界面验证的固定数据。',
};
const state = {
  app: { name: 'PugPort', version: 'ui-fixture', platform: 'win32', dataDir: 'fixture' },
  targets,
  runtimes,
  plugins: [],
  approvals: [],
  runs: [],
  refreshing: false,
  usage: report,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    preferNative: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: projectPath,
    maxConcurrentRuns: 1,
  },
  projects: [{ id: 'fixture-project', name: 'Fixture project', path: projectPath, createdAt: now, updatedAt: now }],
  conversations: [],
  workflows: [],
  conversationMessages: [],
};

const mac = {
  id: 'fixture-mac',
  name: 'Mac-mini',
  address: '100.64.0.10',
  pairedAt: now,
  online: true,
  checkedAt: now,
  version: '0.0.fixture',
  arch: 'arm64',
  running: 0,
  hardware: {
    os: 'macOS',
    cpu: 'Apple M4',
    cores: 10,
    gpu: 'Apple M4',
    memoryTotal: 16 * 1024 ** 3,
    diskTotal: 512 * 1024 ** 3,
    diskFree: 320 * 1024 ** 3,
    readAt: now,
  },
  resources: { cpuPercent: 12, gpuPercent: 5, memoryUsed: 6 * 1024 ** 3, memoryTotal: 16 * 1024 ** 3, observedAt: now },
  executors: [
    {
      label: 'Codex · 本机',
      provider: 'codex',
      status: 'ready',
      tightest: 72,
      observedAt: now,
      windows: [{ name: 'Weekly', remaining: 72 }],
    },
    {
      label: 'Claude · 本机',
      provider: 'claude',
      status: 'ready',
      tightest: 58,
      observedAt: now,
      windows: [{ name: 'Weekly', remaining: 58 }],
    },
  ],
};
const devices = {
  slackHost: null,
  devices: [
    mac,
    {
      ...mac,
      id: 'fixture-vps',
      name: 'fixture-vps',
      address: '127.0.0.1',
      tunnel: { ssh: 'fixture-vps', remotePort: 4318 },
      arch: 'x64',
      running: 1,
      hardware: {
        os: 'Ubuntu 24.04',
        cpu: 'Fixture CPU',
        gpu: 'Fixture GPU',
        cores: 4,
        memoryTotal: 8 * 1024 ** 3,
        diskTotal: 80 * 1024 ** 3,
        diskFree: 55 * 1024 ** 3,
        readAt: now,
      },
      resources: { cpuPercent: 26, memoryUsed: 3 * 1024 ** 3, memoryTotal: 8 * 1024 ** 3, observedAt: now },
      executors: [{ ...mac.executors[0], label: 'Codex' }],
    },
  ],
};
devices.devices.push({
  id: 'fixture-old-box',
  name: 'old-box',
  address: '127.0.0.1',
  pairedAt: now,
  tunnel: { ssh: 'old-box', remotePort: 4318 },
  online: true,
  platform: 'linux',
  executors: [{ label: 'Codex', provider: 'codex', status: 'ready', windows: [] }],
});
const remoteServers = {
  file: 'synthetic/remote-servers.json',
  servers: [
    {
      name: 'fixture-vps',
      ssh: 'fixture-vps',
      provider: 'Fixture Cloud',
      region: 'Test region',
      expiresOn: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
      live: {
        online: true,
        checkedAt: now,
        cpuPercent: 26,
        cores: 4,
        arch: 'x64',
        memoryTotal: 8 * 1024 ** 3,
        memoryAvailable: 5 * 1024 ** 3,
        diskTotal: 80 * 1024 ** 3,
        diskFree: 55 * 1024 ** 3,
      },
    },
    {
      name: 'spare-vps',
      ssh: 'fixture-spare',
      provider: 'Fixture Cloud',
      live: {
        online: true,
        checkedAt: now,
        cpuPercent: 2,
        cores: 2,
        arch: 'x64',
        memoryTotal: 4 * 1024 ** 3,
        memoryAvailable: 3 * 1024 ** 3,
        diskTotal: 40 * 1024 ** 3,
        diskFree: 32 * 1024 ** 3,
      },
    },
  ],
};

let window, server;
const sockets = new Set(),
  queries = [],
  fixtureErrors = [],
  checks = [];
app.setPath('userData', path.join(root, '.data', 'usage-ui-fixture'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (source) => window.webContents.executeJavaScript(source, true);
async function wait(source) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(source)) return;
    await pause(80);
  }
  throw new Error('UI wait timed out: ' + source);
}
async function clickText(selector, text) {
  await evaluate(
    `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Element missing');el.click()})()`,
  );
  await pause(100);
}
async function select(selector, value) {
  await evaluate(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await pause(160);
}
async function theme(value) {
  await clickText('.nav-item', '设置');
  await evaluate("document.querySelector('[data-settings-category=general]').click()");
  await clickText('.theme-options button', { light: '浅色', dark: '深色', system: '跟随系统' }[value]);
  await clickText('.nav-item', '用量与连接');
  await clickText('.page-tabs button', '消耗');
  await wait("!!document.querySelector('.insight-kpis')");
}
async function capture(name, directory = out) {
  window.webContents.invalidate();
  await pause(250);
  await fs.writeFile(path.join(directory, name + '.png'), (await window.webContents.capturePage()).toPNG());
}
async function smoke() {
  await fs.access(path.join(root, 'dist', 'ui', 'index.html'));
  await fs.mkdir(out, { recursive: true });
  await fs.mkdir(serversOut, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': fixture\n\n');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/session') res.end(JSON.stringify({ token: 'fixture-token' }));
      else if (url.pathname === '/api/state') res.end(JSON.stringify(state));
      else if (url.pathname === '/api/app-info')
        res.end(
          JSON.stringify({
            paths: { dataDir: 'synthetic/data', memoryDir: 'synthetic/memory' },
            tools: { ripgrep: true, markitdown: false, voice: false },
          }),
        );
      else if (url.pathname === '/api/devices') res.end(JSON.stringify(devices));
      else if (url.pathname === '/api/remote-servers') res.end(JSON.stringify(remoteServers));
      else if (url.pathname === '/api/external-agents') res.end(JSON.stringify({ agents: [] }));
      else if (url.pathname === '/api/usage/insights') {
        queries.push(url.search);
        const filters = {
          range: url.searchParams.get('range') || '7d',
          kind: url.searchParams.get('kind') || 'all',
          project: url.searchParams.get('project') || '',
          runtime: url.searchParams.get('runtime') || '',
        };
        const incomplete = {
          ...report.perRun[0],
          runId: 'fixture-run-02',
          ...Object.fromEntries(metrics.map((key) => [key, null])),
        };
        res.end(
          JSON.stringify(
            usageInsights(
              { ...report, perRun: [...report.perRun, incomplete] },
              [],
              filters,
              new Date(Date.now() + 1000),
            ),
          ),
        );
      } else if (url.pathname === '/api/usage/tasks') res.end('[]');
      else if (url.pathname === '/api/usage') {
        queries.push(url.search);
        res.end(JSON.stringify({ ...report, filters: Object.fromEntries(url.searchParams) }));
      } else {
        fixtureErrors.push(req.method + ' ' + req.url);
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Unexpected fixture API request' }));
      }
      return;
    }
    try {
      const asset = url.pathname.replace(/^\/ui-releases\/[^/]+\//, '/');
      const filename = path.join(root, 'dist', 'ui', asset === '/' ? 'index.html' : asset);
      res.setHeader(
        'Content-Type',
        filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html',
      );
      res.end(await fs.readFile(filename));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  window = new BrowserWindow({
    show: false,
    width: 1480,
    height: 980,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`);

    await evaluate(
      "localStorage.setItem('comborunner.locale', 'zh-CN'); localStorage.setItem('agent-studio-theme', 'light'); sessionStorage.removeItem('pugport-usage-selection')",
    );
    await window.loadURL(window.webContents.getURL());
    await wait("document.documentElement.lang==='zh-Hans' && !!document.querySelector('.connection-dot.connected')");
    await evaluate('window.comboRunnerDesktop = { pickDirectory: async () => null, pickFiles: async () => [] }; true');
    await clickText('.nav-item', '用量与连接');
    await wait("document.querySelectorAll('.remote-server-card').length===2");
    window.setSize(1480, 1180);
    for (const locale of ['zh-CN', 'en']) {
      if (locale === 'en') {
        await evaluate("localStorage.setItem('comborunner.locale', 'en')");
        await window.loadURL(window.webContents.getURL());
        await wait("document.documentElement.lang==='en' && document.body.innerText.includes('Usage & connections')");
        await evaluate(
          'window.comboRunnerDesktop = { pickDirectory: async () => null, pickFiles: async () => [] }; true',
        );
        await clickText('.nav-item', 'Usage & connections');
        await wait("document.querySelectorAll('.remote-server-card').length===2");
      }
      await evaluate("document.querySelector('.device-usage-section').scrollIntoView({block:'start'})");
      await pause(300);
      assert.equal(await evaluate("document.querySelectorAll('.device-usage-section .device-quota-card').length"), 1);
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('.quota-card h3')].filter(el=>el.textContent==='fixture-vps').length",
        ),
        1,
      );
      const cardText = await evaluate("document.querySelector('.remote-server-card[data-runtime-id]').innerText");
      assert.match(cardText, locale === 'en' ? /Connected · Online/ : /已接入 · 在线/);
      assert.match(cardText, /Codex/);
      const sendTitle = locale === 'en' ? 'Send files…' : '发送文件…';
      assert.ok(
        await evaluate(
          `(expected => {
            const row = document.querySelector('.remote-server-card[data-runtime-id] .remote-server-connection');
            const send = row.querySelector('.icon-button');
            if (!send || send.title !== expected || send.getAttribute('aria-label') !== expected || send.disabled) return false;
            const button = send.getBoundingClientRect();
            const disconnect = send.previousElementSibling.getBoundingClientRect();
            const status = row.querySelector('p').getBoundingClientRect();
            return status.right <= disconnect.left && disconnect.right <= button.left && button.right <= row.getBoundingClientRect().right;
          })(${JSON.stringify(sendTitle)})`,
        ),
      );
      assert.doesNotMatch(cardText, /本机|This computer|this computer/);
      assert.ok(
        await evaluate(
          "document.documentElement.dataset.theme==='light' && document.documentElement.scrollWidth<=innerWidth",
        ),
      );
      await capture(locale === 'en' ? 'live-quota-en' : 'live-quota-zh', serversOut);
    }
    await evaluate("document.querySelector('.remote-server-card[data-runtime-id]').click()");
    await wait("!!document.querySelector('.quota-zoom')");
    assert.ok(await evaluate("!!document.querySelector('.quota-zoom .device-account')"));
    assert.match(await evaluate("document.querySelector('.quota-zoom').innerText"), /Fixture GPU/);
    await capture('server-zoom-en', serversOut);
    checks.push('server appears once, connected status and quota in both languages, full device zoom');
    for (const locale of ['zh-CN', 'en']) {
      await evaluate('localStorage.setItem("comborunner.locale", ' + JSON.stringify(locale) + ')');
      await window.loadURL(window.webContents.getURL());
      await wait(
        'document.documentElement.lang===' +
          JSON.stringify(locale === 'en' ? 'en' : 'zh-Hans') +
          " && !!document.querySelector('.connection-dot.connected')",
      );
      await clickText('.nav-item', locale === 'en' ? 'Settings' : '设置');
      await wait("!!document.querySelector('[data-settings-category=devices]')");
      await evaluate("document.querySelector('[data-settings-category=devices]').click()");
      await wait(
        "!!document.querySelector('.devices [data-settings-item=fixture-old-box]') && !document.querySelector('.devices [data-settings-item=fixture-vps]')",
      );
      const groups = await evaluate(
        "[...document.querySelectorAll('.devices .settings-group')].map(group => ({title: group.querySelector('h3').textContent, rows: [...group.querySelectorAll('.settings-row[data-settings-item]')].map(row => row.dataset.settingsItem)}))",
      );
      assert.deepEqual(groups, [
        { title: locale === 'en' ? 'Added devices' : '已添加的设备', rows: ['fixture-mac'] },
        { title: locale === 'en' ? 'Servers' : '服务器', rows: ['fixture-old-box'] },
        { title: 'Slack', rows: [] },
      ]);
      assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.devices select option')].map(option => option.value)"),
        ['', 'fixture-mac', 'fixture-vps', 'fixture-old-box'],
      );
      await evaluate("document.querySelectorAll('.devices .settings-row-expand').forEach(button => button.click())");
      assert.deepEqual(fixtureErrors, []);
      assert.equal(await evaluate("document.querySelectorAll('.devices .inline-error').length"), 0);
      await capture(locale === 'en' ? 'settings-devices-en' : 'settings-devices-zh', serversOut);
    }
    checks.push('Settings devices and orphan servers grouped in both languages; every device remains a Slack host');

    await evaluate("localStorage.setItem('comborunner.locale', 'zh-CN')");
    await window.loadURL(window.webContents.getURL());
    await wait("document.documentElement.lang==='zh-Hans' && !!document.querySelector('.connection-dot.connected')");
    window.setSize(1480, 980);

    await clickText('.nav-item', '用量与连接');
    await clickText('.page-tabs button', '消耗');
    await wait(`!!document.querySelector('.insight-kpis')`);
    assert.equal(await evaluate(`document.querySelectorAll('.insight-kpi').length`), 6);
    assert.ok(await evaluate(`document.querySelector('.insight-kpis').innerText.includes('缺少数据')`));
    checks.push('unknown metrics and partial coverage clearly rendered');
    await theme('light');
    await wait(`document.documentElement.dataset.theme==='light'`);
    await capture('usage-light');
    await theme('dark');
    await wait(`document.documentElement.dataset.theme==='dark'`);
    await capture('usage-dark');
    checks.push('light and dark usage rendering');
    assert.ok(await evaluate("document.querySelector('.insight-executor-table').innerText.includes('Pi Native RPC')"));
    await evaluate("document.querySelector('.insight-expand').click()");
    assert.ok(await evaluate("document.querySelector('.insight-model-row').innerText.includes('fixture-model')"));
    await clickText('.usage-group-tabs button', '按项目');
    assert.ok(
      await evaluate("document.querySelector('.insight-details .usage-table').innerText.includes('Fixture project')"),
    );
    await clickText('.usage-group-tabs button', '每次调用');
    assert.ok(
      await evaluate("document.querySelector('.insight-details .usage-table').innerText.includes('按用量统计')"),
    );
    checks.push('project, executor/model expansion and per-call groups render');
    await select('select[aria-label="用量项目范围"]', projectPath);
    await select('select[aria-label="用量执行器范围"]', 'pi-local');
    await clickText('.insight-segmented button', '30d');
    const query = new URLSearchParams(queries.at(-1));
    assert.equal(query.get('project'), projectPath);
    assert.equal(query.get('runtime'), 'pi-local');
    assert.equal(query.get('range'), '30d');
    assert.equal(query.get('kind'), 'all');
    checks.push('project, executor, execution type and 30-day range sent to backend');
    window.setSize(1050, 760);
    await pause(150);
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    checks.push('minimum desktop width has no page overflow');
    nativeTheme.themeSource = 'dark';
    await theme('system');
    await wait(`document.documentElement.dataset.theme==='dark'`);
    checks.push('system theme still works');
    assert.deepEqual(fixtureErrors, []);
    await fs.writeFile(
      path.join(out, 'ui-smoke.json'),
      JSON.stringify({ at: new Date().toISOString(), fixture: true, passed: true, checks }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, checks }));
  } catch (error) {
    await capture('failure').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
}
app
  .whenReady()
  .then(smoke)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
