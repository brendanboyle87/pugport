// Synthetic, hidden/offscreen renderer only. No app backend, keys or provider requests.
// A long model picker (200+ synthetic models across three cards): filter field, More models group, keyboard and
// input-method handling, the selection staying visible, both languages and themes, narrow and upward menus.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pugport-long-picker-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
        'utf8',
      );
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8'),
        'utf8',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceExecutionFields} from './src/ui/Workspace';
import {startInterfaceLanguage} from './src/ui/i18n';
import {pickerTargets,pickerRuntimes} from './tests/helpers/model-picker-catalog';
localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('lang'));
const short={id:'api-short',provider:'pi',gateway:'api',apiProvider:'deepseek',label:'DeepSeek',enabled:true};
const targets=[...pickerTargets,short];
const runtimes=[...pickerRuntimes,{id:'api-short',models:[{id:'deepseek/deepseek-chat',label:'DeepSeek Chat',efforts:[]},{id:'deepseek/deepseek-reasoner',label:'DeepSeek Reasoner',efforts:[]}]}];
const app=createRoot(document.getElementById('root'));
window.picks=[];
window.renderFixture=()=>app.render(<main style={window.bottom?{position:'fixed',left:16,bottom:16}:{padding:16}}><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><WorkspaceExecutionFields state={{targets,runtimes}} policy="api-only" selection={window.selection??'api-openai'} model={window.model??''} onSelection={()=>{}} onModel={value=>window.picks.push(value)}/></div></main>);
window.renderFixture();
startInterfaceLanguage();`,
          resolveDir: root,
          sourcefile: 'long-picker-fixture.tsx',
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        format: 'iife',
        outfile: path.join(fixture, 'fixture.js'),
        logLevel: 'silent',
      });
      const { execFileSync, spawn } = require('node:child_process');
      if (process.platform === 'win32') {
        for (;;) {
          const cpu = Number(
            execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
              ],
              { encoding: 'utf8', windowsHide: true },
            ).trim(),
          );
          console.log(`Before hidden Electron: CPU ${cpu}%`);
          if (Number.isFinite(cpu) && cpu <= 70) break;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
      const env = { ...process.env, PUGPORT_LONG_PICKER_FIXTURE: fixture, PUGPORT_UNDER_TEST: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), electronArgs(__filename), { env, windowsHide: true, stdio: 'inherit' });
      const timer = setTimeout(() => child.kill(), 90000);
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      }).finally(() => clearTimeout(timer));
    } finally {
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('pugport-long-picker-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.PUGPORT_LONG_PICKER_FIXTURE;
  assert.ok(fixture && path.basename(fixture).startsWith('pugport-long-picker-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    let win;
    try {
      // Screenshots go to reports/ unless a review folder is named (.oil-ui/model-picker for the design record).
      const output = path.resolve(root, process.env.PUGPORT_PICKER_SHOTS || 'reports/model-picker');
      await fs.mkdir(output, { recursive: true });
      win = new BrowserWindow({
        show: false,
        width: 900,
        height: 520,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      const evaluate = (source) => win.webContents.executeJavaScript(source);
      const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,120))');
      const shot = async (name) =>
        fs.writeFile(
          path.join(output, `${name}.png`),
          (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
        );
      const load = async (lang) => {
        await win.loadFile(path.join(fixture, 'index.html'), { query: { lang } });
        await settle();
      };
      const render = async (settings) => {
        await evaluate(
          `localStorage.removeItem('pugport.picker-groups.model.api-openai');Object.assign(window,{selection:undefined,model:undefined,bottom:false},${JSON.stringify(settings)});window.renderFixture()`,
        );
        await settle();
      };
      const openModels = async () => {
        await evaluate(
          `(()=>{const button=document.querySelectorAll('.chip-value')[1];if(button.getAttribute('aria-expanded')!=='true')button.click()})()`,
        );
        await settle();
      };
      const key = async (name, extra = {}) => {
        await evaluate(
          `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true,...${JSON.stringify(extra)}}))`,
        );
        await settle();
      };
      const state = () =>
        evaluate(`(()=>{const menu=document.querySelector('.chip-menu');if(!menu)return null;const box=menu.getBoundingClientRect();
const input=menu.querySelector('.chip-search input');
const options=[...menu.querySelectorAll('[role=option]')];
const visible=(el)=>{const r=el.getBoundingClientRect();return r.top>=box.top-1&&r.bottom<=box.bottom+1&&r.height>0;};
const selected=menu.querySelector('[role=option][aria-selected=true]');
return {focused:document.activeElement===input,hasSearch:!!input,query:input?.value,placeholder:input?.placeholder,
groups:[...menu.querySelectorAll('.chip-group-header')].map(h=>h.querySelector('span').textContent+' '+h.querySelector('small').textContent),
moreTitle:[...menu.querySelectorAll('.chip-group-header')].map(h=>h.title).filter(Boolean)[0],
options:options.map(o=>o.querySelector('span').textContent),active:menu.querySelector('[role=option].active span')?.textContent,
selected:selected?.querySelector('span').textContent,selectedVisible:!!selected&&visible(selected),
empty:menu.querySelector('.chip-empty')?.textContent,searchLast:!!input&&input.parentElement.getBoundingClientRect().bottom>=box.bottom-2,
left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight};})()`);

      for (const [lang, text] of [
        ['zh-CN', { search: '搜索', more: '更多模型', textGroup: '文字', none: '没有匹配的结果', auto: '自动' }],
        ['en', { search: 'Search', more: 'More models', textGroup: 'Text', none: 'No matching results', auto: 'Auto' }],
      ]) {
        await load(lang);
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          for (const width of [900, 320]) {
            win.setContentSize(width, 520);
            await render({});
            await openModels();
            let s = await state();
            assert.equal(s.hasSearch, true, 'a long list gets a filter field');
            assert.equal(s.focused, true, 'typing filters straight away');
            assert.equal(s.placeholder, text.search);
            assert.deepEqual(
              s.groups.map((group) => group.replace(/ \d+$/, '')),
              [text.textGroup, text.more, lang === 'en' ? 'Image' : '图片', lang === 'en' ? 'Video' : '视频'],
            );
            assert.match(s.moreTitle, lang === 'en' ? /Older generations and dated snapshots/ : /快照/);
            assert.ok(s.left >= 0 && s.right <= s.width, JSON.stringify(s));
            const suffix = `${lang}-${theme}-${width}`;
            await shot(`after-${suffix}-default`);
            // The current models up front, as the owner opens the Text group.
            await evaluate(`document.querySelector('.chip-group-header').click()`);
            await settle();
            s = await state();
            assert.equal(s.options[1], 'GPT-5.4');
            assert.ok(!s.options.includes('gpt-4o-2024-08-06'), 'snapshots stay in More models');
            await shot(`after-${suffix}-open`);

            // Typing filters every group, collapsed or not, by name and id.
            win.webContents.insertText('gpt 5.4');
            await settle();
            s = await state();
            assert.equal(s.query, 'gpt 5.4');
            assert.ok(s.options.includes('gpt-5.4-2026-03-05'), 'a match inside the collapsed More models group shows');
            assert.ok(
              s.options.every((name) => /5\.4/.test(name)),
              JSON.stringify(s.options),
            );
            assert.equal(s.active, s.options[0], 'the first match is ready for Enter');
            await shot(`after-${suffix}-filter`);

            if (theme === 'light' && width === 900) {
              // Enter while an input method is still composing never picks a model.
              await key('Enter', { isComposing: true });
              assert.deepEqual(await evaluate('window.picks'), []);
              assert.ok(await state(), 'the menu stays open while composing');
              // Arrow keys move over the matches; Enter picks the highlighted one.
              await key('ArrowDown');
              s = await state();
              assert.equal(s.active, s.options[1]);
              await key('Enter');
              assert.deepEqual(await evaluate('window.picks.splice(0)'), ['openai/gpt-5.4-mini']);
              assert.equal(await state(), null, 'picking closes the menu');

              // Nothing matches: a quiet note; the first Escape clears, the second closes.
              await openModels();
              win.webContents.insertText('zzz');
              await settle();
              s = await state();
              assert.equal(s.empty, text.none);
              assert.deepEqual(s.options, []);
              await key('Escape');
              s = await state();
              assert.equal(s.query, '');
              await key('Escape');
              assert.equal(await state(), null);

              // Chinese text and the interface-language name both find Auto.
              await openModels();
              win.webContents.insertText(lang === 'en' ? 'auto' : '自动');
              await settle();
              assert.deepEqual((await state()).options, [text.auto]);
              await key('Escape');
              await key('Escape');

              // A selected model in More models is shown open, in view, and checked.
              await render({ model: 'openai/gpt-4o-2024-08-06' });
              await openModels();
              s = await state();
              assert.equal(s.selected, 'gpt-4o-2024-08-06');
              assert.equal(s.selectedVisible, true, JSON.stringify(s));
              await shot(`after-${suffix}-selected-older`);
              await key('Escape');

              // Near the bottom of the window the menu opens upward, with the filter next to the chip.
              await render({ bottom: true });
              await openModels();
              s = await state();
              assert.equal(s.searchLast, true, 'the filter sits at the chip side of an upward menu');
              assert.ok(s.top >= 0 && s.bottom <= s.height, JSON.stringify(s));
              win.webContents.insertText('o4');
              await settle();
              s = await state();
              assert.ok(s.options.includes('o4-mini') && s.searchLast, JSON.stringify(s));
              await shot(`after-${suffix}-upward`);
              await key('Escape');
              await key('Escape');

              // A short list stays a plain menu.
              await render({ selection: 'api-short' });
              await openModels();
              s = await state();
              assert.equal(s.hasSearch, false);
              assert.deepEqual(s.options, [text.auto, 'DeepSeek Chat', 'DeepSeek Reasoner']);
              await key('Escape');
            } else {
              await key('Escape');
              await key('Escape');
            }
            assert.equal(win.isVisible(), false);
            console.log(`PASS long picker ${suffix}`);
          }
        }
      }
      console.log('PASS long model picker renderer');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    } finally {
      win?.destroy();
    }
  });
}
