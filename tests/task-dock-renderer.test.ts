import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
test('task dock expansion and localized hidden renders', { timeout: 90000 }, async () => {
  const dir = process.env.TASK_DOCK_ARTIFACTS ?? join(tmpdir(), 'ui-chat', 'task-dock');
  await mkdir(dir, { recursive: true });
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';
import {ConversationTaskDock} from './src/ui/ConversationTaskDock';import {applyInterfaceLocale} from './src/ui/i18n';import './src/ui/studio.css';
const root=createRoot(document.getElementById('root'));let id=0;
const workflows=[{id:'w',conversationId:'c',createdAt:'2026-11-01',runIds:['r'],plan:[]}];
const state={runs:[{id:'r',startedAt:'2026-11-01',route:{runtimeId:'Executor A',model:'model-a'},context:{tokens:24000,window:100000}}],conversationPresentations:{w:{tasks:[{title:'Read the source files',status:'completed'},{title:'Update the conversation display',status:'running'},{title:'Run synthetic checks',status:'pending'}],items:[{calls:[{key:'call'}]}]}},usage:{perRun:[{runId:'r',runtimeLabel:'Executor A',model:'model-a',inputTokens:1000,cacheReadTokens:3000,cacheWriteTokens:0,totalTokens:4500}]}};
window.configure=async(locale,theme)=>{await applyInterfaceLocale(locale);document.documentElement.dataset.theme=theme;root.render(<main style={{padding:32,background:'var(--surface-1)',color:'var(--text)',height:'100vh'}}><div style={{height:260}}>Conversation</div><ConversationTaskDock key={id++} workflows={workflows} state={state}/><div style={{border:'1px solid var(--border)',borderRadius:16,padding:24}}>Message</div><ConversationTaskDock workflows={workflows} state={state} stats/></main>);};
window.ready=true;`,
    },
    bundle: true,
    outfile: join(dir, 'fixture.js'),
    loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    logLevel: 'silent',
  });
  await writeFile(
    join(dir, 'index.html'),
    '<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
  );
  const runner = join(dir, 'runner.cjs');
  await writeFile(
    runner,
    `
 const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs/promises');app.disableHardwareAcceleration();app.setPath('userData',${JSON.stringify(join(dir, 'profile'))});
 app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:false}});try{await win.loadFile(${JSON.stringify(join(dir, 'index.html'))});const ev=s=>win.webContents.executeJavaScript(s),pause=()=>new Promise(r=>setTimeout(r,150));
 for(const width of [1280,760])for(const locale of ['zh-CN','en'])for(const theme of ['light','dark']){
 win.setSize(width,900);await ev('window.configure('+JSON.stringify(locale)+','+JSON.stringify(theme)+')');await pause();await ev('document.querySelector(".conversation-task-dock summary").click()');await pause();assert.equal(await ev('document.querySelectorAll(".conversation-task-dock li").length'),3);
 await fs.writeFile(${JSON.stringify(dir)}+'/task-dock-'+locale+'-'+theme+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());
 assert.ok(await ev('document.documentElement.scrollWidth<=innerWidth'));
 assert.equal(await ev('/缓存命中|Cache hit/.test(document.querySelector(".conversation-stats").textContent)'),false);
 assert.ok(await ev('document.querySelector(".conversation-stats").textContent.includes("4,500 tok")'));
 assert.equal(await ev('document.querySelectorAll(".conversation-stats details").length'),3);
 }
 console.log('PASS task dock: 8 screenshots');}catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}});
 `,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), electronArgs(runner), {
    env,
    windowsHide: true,
    timeout: 80000,
  });
  assert.match(result.stdout, /PASS task dock/);
});
