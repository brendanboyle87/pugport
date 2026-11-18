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
test('background dropdown keyboard, clear, lazy output and localized hidden renders', { timeout: 90000 }, async () => {
  const dir = join(tmpdir(), 'ui-chat', 'background');
  await mkdir(dir, { recursive: true });
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';
import {ConversationBackground} from './src/ui/ConversationBackground';import {applyInterfaceLocale} from './src/ui/i18n';import './src/ui/studio.css';
const root=createRoot(document.getElementById('root'));let id=0;
const jobs=[{key:'shell',title:'node synthetic-worker.js --verify',kind:'pwsh',status:'running',tail:'Processing synthetic files…',runId:'r'},{key:'member',title:'Review the updated files',kind:'Executor A',status:'running',tail:'Checking the focused changes.',conversationId:'child'},{key:'done',title:'node synthetic-check.js',kind:'pwsh',status:'completed',tail:'All checks passed.',exitCode:0},{key:'failed',title:'Review the failing check',kind:'子任务',status:'failed',tail:'Synthetic failure.',exitCode:1}].map(job=>({...job,startedAt:new Date(Date.now()-(job.key==='failed'?59000:72000)).toISOString(),endedAt:new Date().toISOString()}));
window.calls=0;window.configure=async(locale,theme)=>{await applyInterfaceLocale(locale);document.documentElement.dataset.theme=theme;root.render(<main style={{padding:24,background:'var(--surface-1)',color:'var(--text)',height:'100vh'}}><h2>Conversation</h2><ConversationBackground key={id++} state={{workflows:[{id:'w',conversationId:'c'}],conversationPresentations:{w:{background:jobs}}}} conversationId="c" load={async()=>{window.calls++;return {background:jobs.map(job=>({...job,output:'Full synthetic output'}))};}} inspect={id=>window.opened=id} openConversation={id=>window.opened=id}/></main>);};
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
 win.setSize(width,900);await ev('window.configure('+JSON.stringify(locale)+','+JSON.stringify(theme)+')');await pause();await ev('document.querySelector(".background-trigger").click()');await pause();assert.equal(await ev('document.querySelectorAll(".background-work-row").length'),4);assert.equal(await ev('window.calls'),0);
 assert.equal(await ev('document.querySelectorAll(".background-work-summary time")[2].textContent'),locale==='en'?'1 min 12 s':'1 分 12 秒');
 assert.equal(await ev('document.querySelectorAll(".background-work-summary time")[3].textContent'),locale==='en'?'59 s':'59 秒');
 const fonts=await ev('Array.from(document.querySelectorAll(".background-work-title"),e=>getComputedStyle(e).fontFamily)');
 const uiFont=await ev('getComputedStyle(document.querySelector(".background-work-summary")).fontFamily');
 assert.equal(fonts[1],uiFont);assert.equal(fonts[3],uiFont);assert.match(fonts[0],/monospace/);assert.match(fonts[2],/monospace/);
 assert.equal(await ev('document.querySelector("header button").textContent'),locale==='en'?'Clear':'清空');
 await ev('document.querySelector(".background-work-summary").click()');await pause();
 await fs.writeFile(${JSON.stringify(dir)}+'/background-'+locale+'-'+theme+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());
 assert.ok(await ev('document.documentElement.scrollWidth<=innerWidth'));
 }
 await ev('document.querySelector(".background-work-body button").click()');await pause();assert.equal(await ev('window.calls'),1);
 await ev('document.querySelector("header button").click()');await pause();assert.equal(await ev('document.querySelectorAll(".background-work-row").length'),2);
 await ev('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await pause();assert.equal(await ev('!!document.querySelector(".background-popover")'),false);
 await ev('document.querySelector(".background-trigger").click()');await pause();await ev('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');await pause();assert.equal(await ev('!!document.querySelector(".background-popover")'),false);
 console.log('PASS background dropdown: 8 screenshots');}catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();app.exit(process.exitCode||0);}});
 `,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), electronArgs(runner), {
    env,
    windowsHide: true,
    timeout: 80000,
  });
  assert.match(result.stdout, /PASS background/);
});
