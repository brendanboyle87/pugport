import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { electronArgs } from './helpers/electron-app.cjs';

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const cardCode = await uiBundle('src/ui/GitHubConnection.tsx');
const online = {
  id: 'synthetic-device',
  name: 'Test computer',
  address: 'synthetic.invalid',
  pairedAt: '2026-10-01T00:00:00Z',
};
const offline = { ...online, id: 'offline-device', name: 'Offline computer', online: false };
import type { DevicesView } from '../src/shared/devices.ts';

const code = await uiBundle('src/ui/GitHubConnection.tsx');
test('GitHub settings defaults missing status fields to a Connect action', async () => {
  const h = uiHarness(code);
  const props = { api: async () => ({}), notify() {} };
  h.render('GitHubConnection', props);
  await nextTurn();
  const tree = h.render('GitHubConnection', props);
  assert.equal(
    findNode(tree, (node) => node.type === 'input'),
    undefined,
  );
  assert.equal(text(tree.props.status), '');
  assert.ok(findNode(tree, (node) => node.type === 'button' && text(node) === '连接'));
  h.unmount();
});

for (const state of ['off', 'connected', 'not-signed-in', 'gh-missing', 'error'])
  test('GitHub settings row: ' + state, async () => {
    const h = uiHarness(code);
    const props = {
      api: async () => ({
        enabled: state !== 'off',
        state,
        ...(state === 'connected' ? { login: 'octocat' } : {}),
      }),
      notify() {},
    };
    h.render('GitHubConnection', props);
    await nextTurn();
    const tree = h.render('GitHubConnection', props);
    const input = findNode(tree, (node) => node.type === 'input');
    assert.equal(!!input, state === 'connected');
    if (input) assert.equal(input.props.checked, true);
    const status = text(tree.props.status);
    if (state === 'off') assert.equal(status, '');
    if (state === 'connected') {
      assert.equal(status, 'octocat');
      assert.equal(findNode(tree.props.status, (node) => text(node) === 'octocat')?.props.translate, 'no');
      assert.equal(tree.props.tone, undefined);
    }
    if (state === 'not-signed-in' || state === 'gh-missing') {
      // Commands stay out of the main row; the sign-in hint is in the row's details.
      assert.match(text(tree.props.children), /gh auth login/);
      assert.equal(tree.props.tone, 'warning');
    }
    if (state === 'error') assert.equal(tree.props.tone, 'danger');
    h.unmount();
  });
test('GitHub switch posts the new value and shows the connected login', async () => {
  const h = uiHarness(code),
    calls: unknown[] = [];
  const props = {
    api: async (path: string, body?: unknown, method?: string) => {
      calls.push({ path, body, method });
      return body ? { enabled: true, state: 'connected', login: 'octocat' } : { enabled: false, state: 'off' };
    },
    notify() {},
  };
  h.render('GitHubConnection', props);
  await nextTurn();
  const tree = h.render('GitHubConnection', props);
  await findNode(tree, (node) => node.type === 'button' && text(node) === '连接')!.props.onClick();
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { path: '/api/github', body: { enabled: true } });
  const updated = h.render('GitHubConnection', props);
  assert.match(text(updated.props.status), /octocat/);
  assert.equal(findNode(updated, (node) => node.type === 'input')?.props.checked, true);
  h.unmount();
});
test(
  'hidden Electron renders GitHub settings in English without overflow or network',
  { timeout: 60000 },
  async (t) => {
    const { build } = await import('esbuild');
    const { mkdtemp, mkdir, writeFile, rm, realpath } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve, dirname, basename } = await import('node:path');
    const { promisify } = await import('node:util');
    const { execFile } = await import('../src/server/platform/test-process.ts');
    const { default: electron } = await import('electron');
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-github-ui-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-github-ui-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve('reports/github-connection');
    await mkdir(screenshots, { recursive: true });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: [
          "import React from 'react';",
          "import {createRoot} from 'react-dom/client';",
          "import {GitHubConnection} from './src/ui/GitHubConnection';",
          "import {SettingsGroup} from './src/ui/SettingsRow';",
          "import {startInterfaceLanguage} from './src/ui/i18n';",
          "import './src/ui/studio.css'; import './src/ui/settings.css';",
          "localStorage.setItem('comborunner.locale','en'); startInterfaceLanguage();",
          "window.fetch=()=>{throw Error('Unexpected network');}; window.open=()=>{throw Error('Unexpected window');};",
          "const root=createRoot(document.getElementById('root'));",
          "window.renderState=(state)=>root.render(<SettingsGroup title='GitHub'><GitHubConnection key={state.state} api={async(path)=>path==='/api/github/admission'?{version:1,rules:[]}:state} notify={()=>{}} /></SettingsGroup>);",
          "window.renderState({enabled:true,state:'connected',login:'octocat'});",
        ].join('\n'),
      },
      bundle: true,
      outfile: join(directory, 'app.js'),
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
      logLevel: 'silent',
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>body{margin:0;overflow:auto}main{padding:24px;max-width:960px;margin:auto}</style></head><body><main id="root"></main><script src="app.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'check.cjs'),
      [
        "const {app,BrowserWindow}=require('electron');",
        "const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');",
        "app.setPath('userData',path.join(__dirname,'profile')); app.disableHardwareAcceleration();",
        'app.whenReady().then(async()=>{try{',
        'const win=new BrowserWindow({show:false,width:1100,height:420,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});',
        "win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file://')}));",
        "await win.loadFile(path.join(__dirname,'index.html'));",
        "for(const theme of ['light','dark']) for(const width of [420,1100]){",
        "win.setSize(width,420); await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));",
        "await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,250))');",
        "assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);",
        "assert.match(await win.webContents.executeJavaScript('document.body.innerText'),/octocat/);",
        'assert.equal(await win.webContents.executeJavaScript(\'document.querySelector("input").checked\'),true);',
        'await fs.writeFile(path.join(' +
          JSON.stringify(screenshots) +
          ",theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());",
        '}',
        "console.log('PASS: 4 hidden GitHub layouts'); app.exit(0);",
        '}catch(error){console.error(error);app.exit(1);}});',
      ].join('\n'),
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'check.cjs')),
      {
        env,
        windowsHide: true,
        timeout: 45000,
      },
    );
    assert.match(result.stdout, /PASS: 4 hidden GitHub layouts/);
  },
);

test('GitHub hosting offers none, this computer and devices, and shows bounded activity', async () => {
  const calls: Array<{ path: string; body: unknown; method: string }> = [];
  let view: DevicesView = { devices: [online, offline], slackHost: null };
  const intervals: number[] = [];
  let tick!: () => void;
  let cleared = false;
  let statusReads = 0;
  const h = uiHarness(cardCode, {
    setInterval: (fn: () => void, ms: number) => {
      intervals.push(ms);
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  const props = {
    api: async (path: string, body: any, method: string) => {
      if (path === '/api/maintainer/status') {
        statusReads++;
        return {
          configured: true,
          desk: { link: 'peer' },
          host: {
            mode: 'shadow',
            ready: { app: false },
            score: { judged: 3, falsePasses: 0 },
            recent: Array.from({ length: 23 }, (_, number) => ({
              at: '2026-10-28T12:00:00Z',
              event: 'pr',
              number: number + 1,
              action: 'judge',
              result: 'pass',
            })),
          },
        };
      }
      if (path === '/api/remote-servers') return { servers: [] };
      if (method === 'PUT') {
        calls.push({ path, body, method });
        view = { ...view, githubHost: body.deviceId };
      }
      return view;
    },
    notify() {},
  };
  const render = () => h.render('GitHubMaintenance', props);
  const select = () => findNode(render(), (node) => node.props['aria-label'] === 'GitHub 维护由哪台运行')!;
  render();
  await nextTurn();
  await nextTurn();
  assert.equal(select().props.value, '');
  assert.equal(select().props.disabled, false);
  for (const value of ['', 'self', online.id, offline.id])
    assert.ok(findNode(select(), (node) => node.type === 'option' && node.props.value === value));
  const details = findNode(render(), (node) => node.type === 'details')!;
  assert.equal(details.props.open, undefined);
  assert.equal(findNode(details, (node) => node.type === 'ul')!.props.children.length, 20);
  const group = findNode(render(), (node) => node.props.title === 'GitHub')!;
  assert.match(text(group), /影子模式 · 尚未轮询 · App 未配置 · 已判 3 个 PR · 误放过 0/);
  assert.deepEqual(intervals, [30_000]);
  const beforeTick = statusReads;
  tick();
  await nextTurn();
  assert.equal(statusReads, beforeTick + 1);
  for (const value of [online.id, 'self', '']) {
    const beforeChoice = statusReads;
    select().props.onChange({ target: { value } });
    await nextTurn();
    assert.equal(statusReads, beforeChoice + 1);
    assert.equal(select().props.value, value);
    assert.deepEqual(plain(calls.at(-1)), {
      path: '/api/devices/github-host',
      body: { deviceId: value || null },
      method: 'PUT',
    });
  }
  h.unmount();
  assert.equal(cleared, true);
});

test('GitHub hosting without maintainer.json stays disabled and points to setup docs', async () => {
  const h = uiHarness(cardCode);
  const props = {
    api: async (path: string) =>
      path === '/api/maintainer/status'
        ? { configured: false, desk: { link: 'none' } }
        : { devices: [], servers: [], slackHost: null },
    notify() {},
  };
  h.render('GitHubMaintenance', props);
  await nextTurn();
  await nextTurn();
  const tree = h.render('GitHubMaintenance', props);
  const select = findNode(tree, (node) => node.props['aria-label'] === 'GitHub 维护由哪台运行')!;
  assert.equal(select.props.disabled, true);
  assert.equal(select.props.value, '');
  assert.match(text(tree), /先配置 maintainer.json，参见 docs\/maintainer-bot.md。/);
  h.unmount();
});

for (const status of ['unconfigured', 'request-error']) {
  test('a selected GitHub host can be stopped when status is ' + status, async () => {
    const h = uiHarness(cardCode);
    const calls: unknown[] = [];
    let view = { devices: [online], servers: [], slackHost: null, githubHost: online.id as string | null };
    const props = {
      api: async (path: string, body: any, method: string) => {
        if (path === '/api/maintainer/status') {
          if (status === 'request-error') throw new Error('Synthetic status failure');
          return { configured: false, desk: { link: 'peer' } };
        }
        if (method === 'PUT') {
          calls.push({ path, body, method });
          view = { ...view, githubHost: body.deviceId };
        }
        return view;
      },
      notify() {},
    };
    const render = () => h.render('GitHubMaintenance', props);
    render();
    await nextTurn();
    await nextTurn();
    const select = findNode(render(), (node) => node.props['aria-label'] === 'GitHub 维护由哪台运行')!;
    assert.equal(select.props.disabled, false);
    assert.ok(findNode(select, (node) => node.type === 'option' && node.props.value === '' && text(node) === '不运行'));
    select.props.onChange({ target: { value: '' } });
    await nextTurn();
    assert.deepEqual(plain(calls), [{ path: '/api/devices/github-host', body: { deviceId: null }, method: 'PUT' }]);
    assert.equal(findNode(render(), (node) => node.props['aria-label'] === 'GitHub 维护由哪台运行')!.props.value, '');
    h.unmount();
  });
}

test('paused judge offers resume, posts to the host route, and refreshes status', async () => {
  const h = uiHarness(cardCode);
  const calls: unknown[] = [];
  let paused = true;
  const props = {
    api: async (path: string, body: unknown, method = 'POST') => {
      if (path === '/api/maintainer/judge/resume') {
        calls.push({ path, body, method });
        paused = false;
        return {};
      }
      if (path === '/api/maintainer/status')
        return {
          configured: true,
          desk: { link: 'peer' },
          host: {
            mode: 'live',
            judgingPaused: paused,
            ready: { app: true },
            score: { judged: 0, falsePasses: 0 },
            recent: [],
          },
        };
      return { devices: [online], servers: [], slackHost: null, githubHost: online.id };
    },
    notify() {},
  };
  const render = () => h.render('GitHubMaintenance', props);
  render();
  await nextTurn();
  await nextTurn();
  const resume = () => findNode(render(), (node) => node.type === 'button' && text(node) === '恢复判官');
  assert.ok(resume());
  resume()!.props.onClick();
  await nextTurn();
  assert.deepEqual(plain(calls), [{ path: '/api/maintainer/judge/resume', body: {}, method: 'POST' }]);
  assert.equal(resume(), undefined);
  h.unmount();
});

test('GitHub keeps Manage and an off switch after disconnect; its expanded row owns maintenance', async () => {
  const h = uiHarness(code);
  const props = {
    api: async (_path: string, body?: { enabled: boolean }) =>
      body
        ? { enabled: body.enabled, state: body.enabled ? 'connected' : 'off' }
        : { enabled: true, state: 'connected', login: 'synthetic' },
    notify() {},
  };
  h.render('GitHubConnection', props);
  await nextTurn();
  let tree = h.render('GitHubConnection', props);
  findNode(tree, (node) => node.type === 'input')!.props.onChange({ target: { checked: false } });
  await nextTurn();
  tree = h.render('GitHubConnection', props);
  assert.equal(findNode(tree, (node) => node.type === 'input')!.props.checked, false);
  findNode(tree, (node) => node.type === 'button' && text(node) === '管理')!.props.onClick();
  tree = h.render('GitHubConnection', props);
  assert.equal(tree.props.expanded, true);
  assert.ok(findNode(tree, (node) => node.type?.name === 'GitHubMaintenance'));
  h.unmount();
});

test('an enabled connection missing login can be disconnected from its details', async () => {
  const h = uiHarness(code);
  const writes: unknown[] = [];
  const props = {
    api: async (_path: string, body?: unknown) => {
      if (body) writes.push(body);
      return { enabled: true, state: 'not-signed-in' };
    },
    notify() {},
  };
  h.render('GitHubConnection', props);
  await nextTurn();
  const tree = h.render('GitHubConnection', props);
  assert.equal(
    findNode(tree.props.control, (node) => node.type === 'input'),
    undefined,
  );
  findNode(tree.props.children, (node) => node.type === 'button' && text(node) === '断开')!.props.onClick();
  await nextTurn();
  assert.deepEqual(plain(writes), [{ enabled: false }]);
  h.unmount();
});

test('device load errors survive maintainer refresh and retry restores the actual selected host', async () => {
  const h = uiHarness(cardCode, { Error });
  let fail = true;
  let resolveStatus!: (value: unknown) => void;
  const props = {
    api: async (path: string) => {
      if (path === '/api/devices') {
        if (fail) throw new Error('Synthetic device-list failure');
        return { devices: [online], slackHost: null, githubHost: online.id };
      }
      return new Promise((resolve) => {
        resolveStatus = resolve;
      });
    },
    notify() {},
  };
  const render = () => h.render('GitHubMaintenance', props);
  const select = () => findNode(render(), (node) => node.type === 'select')!;
  render();
  await nextTurn();
  assert.equal(select().props.disabled, true);
  assert.equal(select().props.value, 'loading');
  assert.match(text(render()), /Synthetic device-list failure/);
  resolveStatus({ configured: true, desk: { link: 'peer' } });
  await nextTurn();
  assert.equal(select().props.disabled, true);
  assert.match(text(render()), /Synthetic device-list failure/);
  fail = false;
  findNode(render(), (node) => node.type === 'button' && text(node) === '重试')!.props.onClick();
  await nextTurn();
  assert.equal(select().props.disabled, false);
  assert.equal(select().props.value, online.id);
  assert.doesNotMatch(text(render()), /Synthetic device-list failure/);
  assert.ok(findNode(select(), (node) => node.type === 'option' && node.props.value === online.id));
  h.unmount();
});
