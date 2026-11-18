import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import electron from 'electron';
import { AccountSettings } from '../src/ui/AccountSettings.tsx';
import { SettingsShell } from '../src/ui/SettingsShell.tsx';
import type { AccountView } from '../src/shared/account-ui.ts';
import type { AppState } from '../src/shared/types.ts';
import { electronArgs } from './helpers/electron-app.cjs';

// Static markup exercises the real components and CSS, but deliberately does not claim hydration or click coverage.
test(
  'Account static visual layout: merge, upgrade waiting and device checklist in light and dark themes',
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'pugport-account-visual-'));
    t.after(async () => {
      const absolute = resolve(directory);
      assert.ok(
        absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('pugport-account-visual-'),
      );
      await rm(absolute, { recursive: true, force: true });
    });
    const screenshots = resolve('artifacts/account-sync/screenshots');
    await mkdir(screenshots, { recursive: true });
    const state = { targets: [], runtimes: [], settings: {}, app: { platform: 'win32' } } as unknown as AppState;
    const noRequest = async (): Promise<never> => {
      throw Error('Static rendering must not request data');
    };
    const signed: AccountView = {
      configured: true,
      auth: { phase: 'signed-in', email: 'synthetic.person@example.test' },
      sync: 'idle',
      setup: 'ready',
      deviceName: 'Synthetic laptop',
      lastSyncedAt: '2026-10-29T12:00:00Z',
      devices: [],
      missingProviders: [],
    };
    const others = {
      devices: [
        {
          id: 'synthetic-other',
          name: 'Synthetic desktop',
          platform: 'linux',
          last_seen_at: '2026-10-28T10:30:00Z',
          cli_providers: ['codex', 'grok'],
        },
      ],
      missingProviders: ['codex', 'grok'],
    };
    const scenarios: Record<string, AccountView> = {
      synced: { ...signed, ...others },
      first: { ...signed, ...others, sync: 'syncing', lastSyncedAt: undefined },
      merge: {
        ...signed,
        setup: 'merge',
        sync: 'off',
        merge: {
          local: { chats: 42, folders: 5, projects: 6, memories: 12 },
          cloud: { chats: 17, folders: 3, projects: 4, memories: 8 },
          accountChange: true,
        },
      },
      ready: {
        ...signed,
        sync: 'offline',
        ...others,
      },
      waiting: { ...signed, ...others, setup: 'waiting-upgrade', sync: 'off', lastSyncedAt: undefined },
    };
    const stylesheets = ['studio.css', 'settings.css', 'AccountSettings.css']
      .map((name) => `<link rel="stylesheet" href="${pathToFileURL(resolve('src/ui', name)).href}">`)
      .join('');
    for (const [name, view] of Object.entries(scenarios)) {
      const account = createElement(AccountSettings, {
        view,
        action: noRequest,
        busy: false,
        state,
        api: noRequest,
        reload: noRequest,
        notify: () => {},
        onOpenAccounts: () => {},
      });
      const markup = renderToStaticMarkup(
        createElement(SettingsShell, {
          category: 'account',
          accountConfigured: true,
          onCategory: () => {},
          target: { id: 'account', request: 1 },
          children: account,
        }),
      );
      assert.ok(markup.includes('account-settings'));
      await writeFile(
        join(directory, `${name}.html`),
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${stylesheets}<style>*,*::before,*::after{transition:none!important;animation:none!important;}main{max-width:964px;margin:0 auto;padding:32px;}body{min-height:100vh;}</style></head><body><main>${markup}</main></body></html>`,
      );
    }
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron/main');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'synthetic-profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1120,height:1100,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,callback)=>callback({cancel:true}));
 const colors={};const reports=[];
 for(const scenario of ['synced','first','merge','ready','waiting']){
  await win.loadFile(path.join(__dirname,scenario+'.html'));
  for(const theme of ['light','dark']){
   await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));
   await win.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
   const layout=await win.webContents.executeJavaScript('(' + function () {
        const account = document.querySelector('.account-settings'),
          rect = account.getBoundingClientRect();
        const visible = (element) => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const outside = [...account.querySelectorAll('button,table,.settings-row-main')]
          .filter(visible)
          .filter((element) => {
            const r = element.getBoundingClientRect();
            return r.left < rect.left - 1 || r.right > rect.right + 1;
          })
          .map((element) => element.className);
        const overlaps = [...account.querySelectorAll('.settings-row-main')].filter((row) => {
          const copy = row.querySelector('.settings-row-copy'),
            actions = row.querySelector('.settings-row-actions');
          if (!copy || !actions || !visible(copy) || !visible(actions)) return false;
          const a = copy.getBoundingClientRect(),
            b = actions.getBoundingClientRect();
          return (
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
          );
        }).length;
        const luminance = (value) => {
          const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => {
            const c = channel / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const secondaryContrast = [...account.querySelectorAll('.button.secondary')].map(button => {
          const style = getComputedStyle(button);
          const foreground = luminance(style.color), background = luminance(style.backgroundColor);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
        return {
          width: rect.width,
          height: rect.height,
          bottom: rect.bottom,
          viewportHeight: innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
          stylesheets: document.styleSheets.length,
          background: getComputedStyle(document.documentElement).backgroundColor,
          text: getComputedStyle(account).color,
          outside,
          overlaps,
          secondaryContrast,
          mergeRows: document.querySelectorAll('.account-merge tbody tr').length,
          checklist: account.textContent.includes('Codex') && account.textContent.includes('Grok'),
        };
      }.toString() + ')()');
   reports.push({scenario,theme,...layout});
   assert.ok(layout.stylesheets>=3,'Stylesheets did not load');
   assert.ok(layout.width>=500&&layout.height>300,'Account content has no meaningful layout');
   assert.ok(layout.documentWidth<=layout.viewportWidth+1,'Page scrolls horizontally');
   assert.ok(layout.bottom<=layout.viewportHeight,'Account actions extend below screenshot');
   assert.deepEqual(layout.outside,[],'Controls overflow the Account column');
   assert.equal(layout.overlaps,0,'Settings text overlaps its controls');
   assert.ok(layout.secondaryContrast.length>0&&layout.secondaryContrast.every(ratio=>ratio>=4.5),'Secondary buttons need readable contrast');
   if(scenario==='merge')assert.equal(layout.mergeRows,4);
   else assert.equal(layout.checklist,true);
   colors[theme]=layout.background;
   win.webContents.invalidate(); await new Promise(resolve=>setTimeout(resolve,200));
   await fs.writeFile(path.join(process.argv[2],'static-'+scenario+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
 }
 assert.notEqual(colors.light,colors.dark,'Theme background did not change');
 console.log('Account static visual assertions passed '+JSON.stringify(reports));
 win.destroy();app.exit(0);
}).catch(error=>{console.error(error.stack||error);app.exit(1)});
`,
    );
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs'), screenshots),
      {
        timeout: 45000,
        windowsHide: true,
        env: environment,
      },
    );
    assert.match(result.stdout, /Account static visual assertions passed/);
    t.diagnostic(result.stdout.trim());
    for (const scenario of Object.keys(scenarios))
      for (const theme of ['light', 'dark']) {
        const png = await readFile(join(screenshots, `static-${scenario}-${theme}.png`));
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.ok(png.length > 5000, 'Screenshot is unexpectedly empty');
      }
  },
);
