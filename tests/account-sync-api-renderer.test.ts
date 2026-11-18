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

test(
  'synced API cards show local unavailability in a hidden renderer in both languages',
  { timeout: 60000 },
  async (t) => {
    const dir = temporaryFolder(t, 'api-sync-ui-'),
      artifacts = resolve('.oil-ui/sync-api');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><main id="root" style="padding:24px;max-width:1000px;margin:auto"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ExecutorsPage} from './src/ui/Executors';import {startInterfaceLanguage} from './src/ui/i18n';
 import './src/ui/studio.css';import './src/ui/settings.css';import './src/ui/ExternalAgents.css';
 localStorage.setItem('comborunner.locale',new URLSearchParams(location.search).get('locale')||'zh-CN');document.documentElement.dataset.theme='dark';
 const target={id:'api-synthetic',provider:'pi',gateway:'api',apiProvider:'custom-api',label:'Synced local API',enabled:true,environment:'native',command:'synthetic'};
 const provider={targetId:target.id,preset:'custom-api',label:target.label,enabled:true,keyHint:'…fake',console:'',currency:'USD',unavailable:'这台电脑的本地 API 或模型不可用。',connection:{protocol:'openai-completions',baseUrl:'http://127.0.0.1:43199/v1',model:'synthetic'}};
 const state={app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'synthetic'},settings:{refreshSeconds:60,reservePercent:10,maxQuotaAgeSeconds:120,toolApprovalMode:'auto',executionPolicy:'cli-first',unknownQuotaPolicy:'manual-only',maxConcurrentRuns:1,excludedExecutors:[target.id]},targets:[target],runtimes:[],runs:[],projects:[],conversations:[],workflows:[],conversationMessages:[],approvals:[],plugins:[],apiProviders:[provider],refreshing:false};
 const api=async(path)=>path==='/api/accounts'?{providers:[],accounts:[]}:path==='/api/external-agents'?{agents:[]}:{};
 startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<ExecutorsPage state={state} api={api} reload={async()=>{}} refresh={async()=>{}} refreshing={false} notify={()=>{}}/>));
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
 const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const {app,BrowserWindow}=require('electron');
 app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://')&&!d.url.startsWith('data:')}));
 for(const locale of ['zh-CN','en']){
 await win.loadFile(path.join(__dirname,'index.html'),{query:{locale}});
 const expected=locale==='en'?'The local API or model is unavailable':'这台电脑的本地 API 或模型不可用';
 for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript('document.body.textContent.includes('+JSON.stringify(expected)+')'))break;}
 const text=await win.webContents.executeJavaScript('document.body.textContent');assert(text.includes('Synced local API'));assert(text.includes(expected),text);
 assert(await win.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'));
 const visible=await win.webContents.executeJavaScript('(()=>{const p=document.querySelector("[role=status]");return !!p&&p.getBoundingClientRect().height>0;})()');assert(visible);
 await fs.writeFile(path.join(${JSON.stringify(artifacts)},'computer-b-'+locale+'.png'),(await win.webContents.capturePage()).toPNG());
 }console.log('PASS hidden API cards, both locales, local note visible');
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
  },
);
