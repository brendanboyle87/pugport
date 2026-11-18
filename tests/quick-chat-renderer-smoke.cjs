// Isolated real Electron renderer and synthetic messages. No live backend, accounts or OS shortcuts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const electron = require('electron');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'reports', 'quick-chat-smoke');
fs.mkdirSync(output, { recursive: true });
if (!process.versions.electron) {
  const { buildSync } = require('esbuild');
  buildSync({
    stdin: {
      contents: `export * from './src/electron/quick-chat'; export * from './src/electron/channels'; export {setMainLocale,t} from './src/electron/locale';`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(output, 'source.cjs'),
  });
  buildSync({
    entryPoints: [path.join(root, 'src/electron/preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(output, 'preload.cjs'),
  });
  buildSync({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
import {QuickChatSettingsSection} from './src/ui/QuickChatSettings'; import './src/ui/studio.css'; import './src/ui/settings.css';
const bridge = {quickChatSettings: async (value) => ({enabled:true,shortcut:'Ctrl+Alt+Space',target:'everyday',...value,registered:true})};
createRoot(document.getElementById('root')).render(<section className="panel settings-section" style={{margin:24}}><h2>通用</h2><QuickChatSettingsSection bridge={bridge}/></section>);`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(output, 'settings.js'),
  });
  fs.writeFileSync(
    path.join(output, 'settings.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="settings.css"></head><body><div id="root"></div><script src="settings.js"></script></body></html>',
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, electronArgs(__filename), {
    cwd: root,
    env,
    windowsHide: true,
    timeout: 45000,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const { app, BrowserWindow, ipcMain, screen, nativeTheme } = electron;
  app.on('window-all-closed', () => {});
  app.setPath('userData', path.join(output, `profile-${process.pid}`));
  app.disableHardwareAcceleration();
  const source = require(path.join(output, 'source.cjs'));
  let control,
    popup,
    visible = false,
    sent = [],
    opened = [],
    fail = false,
    checks = 0;
  const waitFor = async (read, expected = true) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if ((await read()) === expected) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error('renderer wait timed out');
  };
  const js = (code) => popup.webContents.executeJavaScript(code);
  const key = (key, extras = '') =>
    js(
      `document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,${extras}}))`,
    );
  const draft = (value) =>
    js(
      `document.querySelector('#input').value=${JSON.stringify(value)};document.querySelector('#input').dispatchEvent(new Event('input'))`,
    );
  app
    .whenReady()
    .then(async () => {
      nativeTheme.themeSource = 'light';
      source.setMainLocale('zh-CN', false);
      const settingsFile = path.join(app.getPath('userData'), 'quick-chat.json');
      const options = {
        createWindow: (options) => {
          popup = new BrowserWindow({
            ...options,
            webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true },
          });
          popup.show = () => {
            visible = true;
          };
          popup.hide = () => {
            visible = false;
          };
          popup.focus = () => {};
          return popup;
        },
        screen,
        shortcuts: { register: () => true, unregister() {} },
        preload: path.join(output, 'preload.cjs'),
        read: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
        write: (value) => fs.writeFileSync(settingsFile, JSON.stringify(value)),
        send: async (text, id) => {
          if (fail) throw new Error('Synthetic offline');
          sent.push({ text, id });
          return 'synthetic-chat';
        },
        conversation: async (id) => id ?? 'synthetic-chat',
        open: (id) => opened.push(id),
        translate: source.t,
        notice: () => {
          throw new Error('Unexpected notice');
        },
      };
      control = source.createQuickChat(options);
      ipcMain.handle(source.QUICK_CHAT_SEND_CHANNEL, async (event, text) => {
        assert.equal(control.fromWindow(event), true);
        await control.send(text);
      });
      ipcMain.handle(source.QUICK_CHAT_CLOSE_CHANNEL, (event) => {
        assert.equal(control.fromWindow(event), true);
        control.hide();
      });
      await control.show();
      await waitFor(() => js(`!!document.querySelector('#target').textContent`));
      const isolation = await js(
        `({node:typeof require,process:typeof process,desktop:typeof comboRunnerDesktop,api:typeof pugportQuickChat})`,
      );
      assert.deepEqual(isolation, {
        node: 'undefined',
        process: 'undefined',
        desktop: 'undefined',
        api: 'undefined',
      });
      checks++;
      assert.equal(await js(`document.activeElement.id`), 'input');
      checks++;
      const capture = async (name) => {
        await new Promise((done) => setTimeout(done, 80));
        fs.writeFileSync(
          path.join(output, name),
          (await popup.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
        );
      };
      await capture('quick-chat-light.png');
      await draft('Synthetic message');
      await key('Enter', 'isComposing:true');
      await key('Enter', 'shiftKey:true');
      assert.equal(sent.length, 0);
      checks++;
      await key('Enter');
      await waitFor(() => sent.length === 1 && !visible);
      assert.equal(sent[0].text, 'Synthetic message');
      await waitFor(() => js(`document.querySelector('#input').value===''`));
      checks++;
      await control.show();
      await draft('Preserved draft');
      await key('Escape');
      await waitFor(() => !visible);
      assert.equal(await js(`document.querySelector('#input').value`), 'Preserved draft');
      checks++;
      await control.show();
      fail = true;
      await key('Enter');
      await waitFor(() => js(`document.querySelector('#error').textContent.includes('Synthetic offline')`));
      assert.equal(visible, true);
      assert.equal(await js(`document.querySelector('#input').value`), 'Preserved draft');
      checks++;
      fail = false;
      await js(`document.querySelector('#send').click()`);
      await waitFor(() => sent.length === 2 && !visible);
      checks++;
      await control.show();
      popup.emit('blur');
      assert.equal(visible, false);
      checks++;
      await control.show();
      await js(`document.querySelector('#open').click()`);
      await waitFor(() => opened.length === 1);
      assert.equal(opened[0], 'synthetic-chat');
      assert.equal(visible, false);
      checks++;
      source.setMainLocale('en', false);
      nativeTheme.themeSource = 'dark';
      control.configure({ enabled: true, shortcut: 'Ctrl+Alt+Space', target: 'last' });
      control.remember({ id: 'synthetic-chat', project: 'Example project', title: 'Planning the next step' });
      await control.show();
      await waitFor(() => js(`document.querySelector('#title').textContent==='Quick chat'`));
      assert.equal(
        await js(`document.querySelector('#target').textContent`),
        'Example project · Planning the next step',
      );
      checks++;
      assert.equal(
        await js(
          `document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight`,
        ),
        true,
      );
      checks++;
      await capture('quick-chat-dark-en.png');
      control.configure({ enabled: false, shortcut: 'Ctrl+Alt+N', target: 'last' });
      control.dispose();
      control = source.createQuickChat(options);
      assert.deepEqual(control.configure(), {
        enabled: false,
        shortcut: 'Ctrl+Alt+N',
        target: 'last',
        registered: false,
      });
      checks++;
      const settingsWindow = new BrowserWindow({
        width: 720,
        height: 360,
        show: false,
        frame: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
      });
      await settingsWindow.loadFile(path.join(output, 'settings.html'));
      await waitFor(() =>
        settingsWindow.webContents.executeJavaScript(
          `!!document.querySelector('#quick-chat-target') && !document.querySelector('#quick-chat-target').disabled`,
        ),
      );
      await new Promise((done) => setTimeout(done, 80));
      fs.writeFileSync(
        path.join(output, 'quick-chat-settings.png'),
        (await settingsWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
      );
      settingsWindow.destroy();
      checks++;
      fs.writeFileSync(
        path.join(output, 'result.json'),
        JSON.stringify(
          {
            passed: checks,
            failed: 0,
            electron: process.versions.electron,
            screenshots: ['quick-chat-light.png', 'quick-chat-dark-en.png', 'quick-chat-settings.png'],
            synthetic: true,
          },
          null,
          2,
        ),
      );
      console.log(`Quick chat renderer smoke: ${checks} passed, 0 failed. Screenshots: reports/quick-chat-smoke`);
      control.dispose();
      app.exit(0);
    })
    .catch((error) => {
      console.error(error);
      control?.dispose();
      app.exit(1);
    });
}
