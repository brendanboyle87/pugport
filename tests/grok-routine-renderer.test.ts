import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electron from 'electron';
import { GrokBotControls } from '../src/ui/ExternalAgents.tsx';
import type { ExternalAgentView } from '../src/shared/external-agents.ts';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'Electron renders the routine card in light/dark at 380px and 1100px without overflow',
  { timeout: 30000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'grok-routine-renderer-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('grok-routine-renderer-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const screenshots = resolve('reports/grok-routine');
    await mkdir(screenshots, { recursive: true });
    const agent: ExternalAgentView = {
      id: 'grok-bot',
      name: 'Grok Bot',
      kind: 'handoff',
      description: '',
      enabled: true,
      available: true,
      routine: { url: 'https://api2.cursor.sh/automations/webhook/synthetic', keyHint: '…1234' },
    };
    const card = renderToStaticMarkup(
      createElement(GrokBotControls, { agent, api: async <T>() => ({}) as T, onPatch() {}, onOpen() {}, onLogin() {} }),
    );
    const css = (
      await Promise.all(
        ['studio.css', 'composer.css', 'ExternalAgents.css'].map((file) => readFile(join('src/ui', file), 'utf8')),
      )
    ).join('\n');
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}
body{margin:0;overflow:auto}main{padding:16px;max-width:800px;margin:auto}.external-agent-row{min-width:0}</style></head><body><main><section class="external-agent-row"><strong>Grok Bot</strong>${card}</section></main></body></html>`,
    );
    await writeFile(
      join(directory, 'check.cjs'),
      `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile')); app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 try {
  const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true}});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('file://')}));
  await win.loadFile(path.join(__dirname,'index.html'));
  for(const theme of ['light','dark']) for(const width of [380,1100]) {
   win.setSize(width,850);
   await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme));
   await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
   await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,180))');
   assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'),true);
   assert.equal(await win.webContents.executeJavaScript("document.querySelector('input[type=password]').value"),'');
   assert.equal(await win.webContents.executeJavaScript("document.querySelector('input[type=password]').placeholder"),'…1234');
   await fs.writeFile(path.join(${JSON.stringify(screenshots)},theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  console.log('PASS: 4 layouts, masked key, no network'); app.exit(0);
 } catch(error) { console.error(error);app.exit(1); }
});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'check.cjs')),
      {
        env,
        windowsHide: true,
        timeout: 25000,
      },
    );
    assert.match(result.stdout, /PASS: 4 layouts/);
  },
);
