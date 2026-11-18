// Synthetic settings only. A private hidden renderer blocks all network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-web-search-ui-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await require('esbuild').build({
        stdin: {
          contents:
            '@import "./src/ui/studio.css"; @import "./src/ui/SwarmWorkspace.css"; @import "./src/ui/settings.css"; @import "./src/ui/ExtensionsHome.css";',
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
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WebSearchSettings} from './src/ui/WebSearchSettings';
import {startInterfaceLanguage} from './src/ui/i18n';
localStorage.setItem('comborunner.locale','zh-CN');
window.english=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();};
window.fixture={calls:[],notices:[],view:{provider:'deepseek',enabled:true,configured:true,keyHint:'…demo',monthlyLimitCny:5,month:'2026-10',usage:{requests:4,billableRequests:2,uncertainRequests:1,estimatedCostCny:0.01,reservedCny:0.005}}};
const api=async(path,body,method)=>{
 if(path!=='/api/web-search'||!['GET','PUT'].includes(method))throw new Error('Unexpected API request');
 window.fixture.calls.push({path,body,method});
 if(body){const view=window.fixture.view;if(body.key)view.configured=true;if(body.clearKey){view.configured=false;delete view.keyHint;}if(body.enabled!==undefined)view.enabled=body.enabled;if(body.monthlyLimitCny!==undefined)view.monthlyLimitCny=body.monthlyLimitCny;}
 return structuredClone(window.fixture.view);
};
void startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<main className="extensions-home" style={{maxWidth:720,margin:'24px auto',padding:'0 16px'}}><div className="settings-content"><h1>扩展</h1><div className="settings-form"><WebSearchSettings api={api} notify={notice=>window.fixture.notices.push(notice)}/></div></div></main>));`,
        },
        bundle: true,
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const env = { ...process.env, PUGPORT_WEB_SEARCH_UI: fixture };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => child.kill(), 45000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-web-search-ui-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_WEB_SEARCH_UI;
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        useContentSize: true,
        width: 960,
        height: 1000,
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
      const input = async (selector, value) => {
        await evaluate(
          `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
        await frame();
      };
      const click = async (selector) => {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await frame();
      };
      const button = async (label) => {
        await evaluate(
          `[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)}).click()`,
        );
        await frame();
      };
      const screenshot = async (name) => {
        assert.equal(await evaluate("document.querySelector('input[type=password]').value"), '');
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        win.webContents.invalidate();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const directory =
          process.env.PUGPORT_WEB_SEARCH_SCREENSHOTS || path.join(root, 'reports/deepseek-search-20261024/ui');
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, name), (await win.webContents.capturePage()).toPNG());
      };
      await win.loadFile(path.join(fixture, 'index.html'));
      for (let i = 0; i < 20 && !(await evaluate("!!document.querySelector('input[type=checkbox]')")); i++)
        await frame();
      await frame();
      assert.equal(await evaluate("document.querySelector('input[type=password]')"), null);
      await button('管理');
      assert.equal(await evaluate("document.querySelector('[role=dialog]').getAttribute('aria-label')"), '联网搜索');
      assert.equal(await evaluate("document.querySelector('input[type=password]').value"), '');
      assert.match(await evaluate('document.body.textContent'), /…demo/);
      assert.equal(await evaluate('window.fixture.calls.length'), 1);
      assert.equal(await evaluate('window.fixture.calls[0].method'), 'GET');
      await input('input[type=password]', 'synthetic-test-key');
      await button('保存');
      assert.equal(await evaluate("document.querySelector('input[type=password]').value"), '');
      assert.equal(await evaluate('window.fixture.calls[1].body.key'), 'synthetic-test-key');
      await click('input[type=checkbox]');
      assert.equal(await evaluate('window.fixture.calls.at(-1).body.enabled'), false);
      await input('input[type=number]', '0');
      await button('保存预算');
      assert.equal(await evaluate('window.fixture.calls.at(-1).body.monthlyLimitCny'), 0);
      await screenshot('wide-zh.png');
      win.setContentSize(390, 1200);
      await frame();
      await screenshot('narrow-zh.png');
      await evaluate('window.english()');
      await frame();
      assert.match(await evaluate('document.body.textContent'), /Web search/);
      assert.doesNotMatch(await evaluate('document.body.textContent'), /启用联网搜索|每月搜索预算/);
      await screenshot('narrow-en.png');
      win.setContentSize(960, 1000);
      await frame();
      await screenshot('wide-en.png');
      await click('.side-sheet .button.quiet');
      assert.equal(await evaluate('window.fixture.calls.at(-1).body.clearKey'), true);
      assert.equal(await evaluate('window.fixture.view.configured'), false);
      assert.equal(await evaluate('window.fixture.calls.length'), 5);
      assert.equal(
        await evaluate(
          "window.fixture.calls.every(call=>call.path==='/api/web-search'&&['GET','PUT'].includes(call.method))",
        ),
        true,
      );
      assert.equal(
        await evaluate("Object.values(localStorage).some(value=>value.includes('synthetic-test-key'))"),
        false,
      );
      assert.deepEqual(errors, []);
      console.log(
        'PASS web search settings renderer: key, disable, clear, zero budget, translations, responsive screenshots',
      );
      win.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
