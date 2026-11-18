// Run with .runtime/node.exe tests/reasoning-stream-renderer-smoke.cjs. Uses only a local fixture and temporary profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-reasoning-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
      );
      await fs.copyFile(path.join(root, 'src/ui/studio.css'), path.join(fixture, 'style.css'));
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ReasoningStream } from './src/ui/ReasoningStream';
const root = createRoot(document.getElementById('root'));
window.renderReasoning = (text, open = true, id = 'run') => flushSync(() => root.render(
  <div id="outer" style={{height: 320, overflow: 'auto'}}>
    <div style={{height: 500}} />
    <ReasoningStream key={id} text={text} open={open} />
    <div style={{height: 500}} />
  </div>
));`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,

        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        platform: 'browser',
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = { ...process.env, COMBORUNNER_REASONING_SMOKE: fixture };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 30000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (value) => resolve(value ?? 1));
      }).finally(() => clearTimeout(timeout));
      process.exitCode = code;
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-reasoning-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_REASONING_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-reasoning-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  let window;
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const metrics = () =>
    evaluate(`(() => {
      const pane = document.querySelector('.reasoning-stream > pre');
      return { top: pane.scrollTop, bottom: pane.scrollHeight - pane.clientHeight, outer: document.querySelector('#outer').scrollTop };
    })()`);
  const text = (count) => Array.from({ length: count }, (_, index) => `Reasoning line ${index}`).join('\n');
  const render = async (value, open = true, id = 'run') => {
    await evaluate(`window.renderReasoning(${JSON.stringify(value)}, ${open}, ${JSON.stringify(id)})`);
    await frame();
  };
  const scroll = async (position) => {
    await evaluate(`(() => {
      const pane = document.querySelector('.reasoning-stream > pre');
      pane.scrollTop = ${position};
      pane.dispatchEvent(new Event('scroll'));
    })()`);
    await frame();
  };
  const assertFollowing = async () => {
    const value = await metrics();
    assert.ok(value.bottom > 0, 'Fixture must overflow the reasoning pane');
    assert.ok(Math.abs(value.top - value.bottom) <= 1, JSON.stringify(value));
  };

  void app.whenReady().then(async () => {
    try {
      window = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      await window.loadFile(path.join(fixture, 'index.html'));
      await render(text(80));
      await assertFollowing();
      await evaluate("document.querySelector('#outer').scrollTop = 100");
      await render(text(100));
      await assertFollowing();
      assert.equal((await metrics()).outer, 100, 'Reasoning follow must not scroll its ancestor');

      await scroll(120);
      await render(text(140));
      assert.equal((await metrics()).top, 120, 'Reading position must survive streaming');
      await render(text(160));
      assert.equal((await metrics()).top, 120, 'Further chunks must stay paused');
      await scroll((await metrics()).bottom);
      await render(text(180));
      await assertFollowing();

      await evaluate("document.querySelector('.reasoning-stream').open = false");
      await frame();
      await render(text(200));
      await evaluate("document.querySelector('.reasoning-stream').open = true");
      await frame();
      await assertFollowing();
      await scroll(140);
      await evaluate("document.querySelector('.reasoning-stream').open = false");
      await frame();
      await render(text(220));
      await evaluate("document.querySelector('.reasoning-stream').open = true");
      await frame();
      assert.equal((await metrics()).top, 140, 'Reopening must preserve a paused reader');

      await render(text(240), true, 'next-run');
      await assertFollowing();
      await evaluate("document.querySelector('.reasoning-stream > pre').style.maxHeight = '140px'");
      await frame();
      await assertFollowing();
      const wrapped = 'x '.repeat(4096);
      const multiline = 'x\n'.repeat(4096);
      assert.equal(wrapped.length, multiline.length);
      await render(wrapped, true, 'next-run');
      await assertFollowing();
      await render(multiline, true, 'next-run');
      await assertFollowing();
      console.log(
        'Reasoning renderer smoke passed: follow, pause, resume, collapse/reopen, run reset, resize, same-length text, ancestor isolation',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
