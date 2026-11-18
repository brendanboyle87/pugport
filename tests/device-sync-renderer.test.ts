import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { temporaryFolder } from './helpers/fake-peer.ts';
import { electronArgs } from './helpers/electron-app.cjs';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

test('computer B renders synced cards and missing SSH note in a hidden window', { timeout: 60000 }, async (t) => {
  const dir = temporaryFolder(t, 'device-sync-ui-');
  const artifacts = resolve('.oil-ui/sync-scope');
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><main id="root" style="padding:32px;max-width:1000px;margin:auto"></main><script src="fixture.js"></script></body></html>',
  );
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {DevicesCard} from './src/ui/Devices';
      import {RemoteServerCard} from './src/ui/RemoteServers';
      import {startInterfaceLanguage} from './src/ui/i18n';
      import './src/ui/studio.css';import './src/ui/Devices.css';import './src/ui/ExternalAgents.css';import './src/ui/settings.css';
      const locale=new URLSearchParams(location.search).get('locale')||'zh-CN';
      localStorage.setItem('comborunner.locale',locale);document.documentElement.dataset.theme='dark';
      const device={id:'00000000-0000-4000-8000-000000000001',name:'Enrolled Ubuntu',address:'100.64.0.2',pairedAt:'2026-11-02T00:00:00Z',online:true,platform:'linux',executors:[]};
      const server={name:'Ubuntu',ssh:'ubuntu',missingSsh:'ubuntu',purpose:'Synthetic synced server',spec:'4 vCPU / 8 GiB'};
      const api=async(path)=>path.startsWith('/api/devices')?{devices:[device],slackHost:null}:path.startsWith('/api/remote-servers')?{servers:[server],file:'synthetic/remote-servers.json'}:{};
      startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<><DevicesCard api={api} notify={()=>{}}/><RemoteServerCard api={api} notify={()=>{}} server={server} now={Date.now()}/></>));
    `,
    },
    bundle: true,
    platform: 'browser',
    outfile: join(dir, 'fixture.js'),
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
  });
  const runner = join(dir, 'runner.cjs');
  await writeFile(
    runner,
    `
    const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
    const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
    app.whenReady().then(async()=>{let win;try{
      win=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://')&&!d.url.startsWith('data:')}));
      for(const locale of ['zh-CN','en']){
        await win.loadFile(path.join(__dirname,'index.html'),{query:{locale}});
        for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript('document.body.textContent.includes("Enrolled Ubuntu")'))break;}
        const text=await win.webContents.executeJavaScript('document.body.textContent');assert(text.includes('Enrolled Ubuntu'));assert(text.includes('Ubuntu'));assert(!text.includes('Computer-B-self'));
        assert(text.includes(locale==='en'?'account access to this server is not set up yet':'这台服务器也还没开通账号直连'));
        assert(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'));
        await fs.writeFile(path.join(${JSON.stringify(artifacts)},'computer-b-'+locale+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      console.log('PASS hidden synced device/server cards, both locales, no overflow');
    }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
  `,
  );
  const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
    cwd: process.cwd(),
    env: offscreenElectronEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const timeout = setTimeout(() => child.kill(), 45000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, output);
    assert.match(output, /PASS hidden/);
  } finally {
    clearTimeout(timeout);
  }
});
