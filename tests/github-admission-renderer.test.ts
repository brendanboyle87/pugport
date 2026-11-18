import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'channel settings render offscreen in four layouts without conversation fixture',
  { timeout: 180000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-settings-'));
    const screenshots = resolve('.oil-ui/channels');
    await mkdir(screenshots, { recursive: true });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {GitHubConnection} from './src/ui/GitHubConnection';
import {applyInterfaceLocale} from './src/ui/i18n';
import './src/ui/studio.css';
import './src/ui/SlackGateway.css';
import './src/ui/settings.css';
const root=createRoot(document.getElementById('root'));
const stamp=new Date(Date.now()-72000).toISOString();
let view={enabled:true,state:'connected',login:'synthetic',status:'connected',appTokenHint:'…AAAA',botTokenHint:'…BBBB',workspace:'Synthetic Team',activeTasks:0,users:[{id:'UOWNER',name:'Alex',isOwner:true,pairedAt:stamp},{id:'UPAIRED',name:'Sam',pairedAt:stamp}]};
let rules={version:1,rules:[{source:'github',scope:'issue',senderClass:'trusted',level:'L3'},{source:'github',scope:'issue',senderId:'octocat',level:'L2'}]};
let digest={time:'09:00',destination:'pugport-slack'};
const api=async(path,body,method='GET')=>{
if(path==='/api/github/admission'){if(method==='PUT')rules=body;return structuredClone(rules);}
if(path==='/api/external-digest/settings'){if(method==='PUT')digest=body;return structuredClone(digest);}
if(path==='/api/devices')return {devices:[],slackHost:null};
if(path.startsWith('/api/slack/users/')&&method==='PATCH'){const id=decodeURIComponent(path.split('/').at(-1));view.users=view.users.map(u=>({...u,isOwner:u.id===id&&body.isOwner}));}
return structuredClone(view);
};
window.notices=[];
window.configure=async theme=>{document.documentElement.dataset.theme=theme;await applyInterfaceLocale('zh-CN');root.render(<main style={{maxWidth:900,margin:'auto',padding:24}}><h2>连接与服务</h2><GitHubConnection api={api} notify={n=>window.notices.push(n)}/></main>);};
window.ready=true;
`,
      },
      bundle: true,
      format: 'iife',
      outfile: join(directory, 'settings.js'),
      loader: { '.woff2': 'file', '.png': 'file', '.svg': 'file' },
      logLevel: 'silent',
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="settings.css"><div id="root"></div><script src="settings.js"></script>',
    );
    const runner = join(directory, 'runner.cjs');
    await writeFile(
      runner,
      `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');const assert=require('node:assert/strict');
app.disableHardwareAcceleration();app.setPath('userData',path.join(${JSON.stringify(directory)},'profile'));
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1280,height:760,webPreferences:{offscreen:true,contextIsolation:false,nodeIntegration:false}});
win.webContents.on('console-message',(_event,_level,message)=>console.error('renderer:',message));
await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
const evaluate=code=>win.webContents.executeJavaScript('(async()=>{try{return await ('+code+')}catch(error){return {rendererError:error.stack}}})()').then(value=>{if(value?.rendererError)throw Error(value.rendererError);return value;}),pause=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<100&&!await evaluate('window.ready');i++)await pause(20);
for(const width of [1280,760])for(const theme of ['light','dark']){
win.setSize(width,760);await evaluate('window.configure('+JSON.stringify(theme)+')');await pause(500);
assert.ok(await evaluate('document.body.innerText.includes("谁能让 PugPort 做事")'),'admission block renders on card');
assert.equal(await evaluate('document.querySelectorAll(".channel-digest").length'),0,'no duplicated digest');
assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow');
assert.equal(await evaluate('document.querySelectorAll(".channel-scope select").length'),4,'four sender rows');
assert.equal(await evaluate('document.querySelector(".turn-tail")'),null,'no conversation fixture');
assert.ok(await evaluate('document.body.innerText.includes("@octocat")'),'GitHub login');
assert.equal(await evaluate('document.querySelector(".channel-scope-title").textContent'), 'GitHub 上 @PugPort', 'merged scope label');
assert.equal(await evaluate('document.querySelectorAll(".channel-scope").length'), 1, 'one mention group');
assert.ok(await evaluate('[...document.querySelectorAll("select")].some(select=>select.value==="mixed" && select.selectedOptions[0].textContent==="混合")'), 'mixed state is visible');
assert.equal(await evaluate('/USENDER|My card|处理中|用时/.test(document.body.innerText)'),false,'no internal sender or conversation fixture text');
const styles=await evaluate('(()=>{const select=getComputedStyle(document.querySelector(".channel-scope select")),levels=[...document.querySelectorAll(".channel-fixed-level")],note=document.querySelector(".channel-admission-note"),muted=getComputedStyle(document.querySelector(".channel-scope-title")).color;return {selectSize:select.fontSize,levels:levels.map(node=>{const s=getComputedStyle(node);return {color:s.color,size:s.fontSize,weight:s.fontWeight}}),muted,noteFits:note.scrollWidth<=note.clientWidth,noteSingleLine:getComputedStyle(note).whiteSpace==="nowrap"}})()');
assert.equal(styles.levels.length,2,'two fixed levels');
for(const level of styles.levels){assert.equal(level.color,styles.muted,'fixed level uses muted text');assert.equal(level.size,styles.selectSize,'fixed level uses select font size');assert.equal(level.weight,'400','fixed level is not bold');}
assert.ok(styles.noteFits && styles.noteSingleLine,'helper fits on one line');
await fs.writeFile(path.join(${JSON.stringify(screenshots)},'github-settings-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
}
assert.deepEqual(await evaluate('window.notices'),[]);
console.log('PASS: four channel settings screenshots without conversation fixture');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);setTimeout(()=>process.exit(process.exitCode||0),1000);}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
        env,
        windowsHide: true,
        timeout: 170000,
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        // This host can retain Electron pipes after app.exit; reap only this finished fixture.
        if (stdout.includes('PASS: four channel settings screenshots')) child.kill();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        child.stdout.destroy();
        child.stderr.destroy();
        if (code === 0 || stdout.includes('PASS: four channel settings screenshots')) resolveResult(stdout);
        else reject(new Error(`Electron exited ${code}: ${stderr}`));
      });
    });
    assert.match(result, /PASS: four channel settings screenshots/);
  },
);
