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
  'channel settings render offscreen in four layouts and live text has real spacing',
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
import {SlackGateway} from './src/ui/SlackGateway';
import {ReasoningTail} from './src/ui/ConversationTurn';
import {applyInterfaceLocale} from './src/ui/i18n';
import './src/ui/studio.css';
import './src/ui/SlackGateway.css';
import './src/ui/settings.css';
import './src/ui/ConversationTurn.css';
const root=createRoot(document.getElementById('root'));
const stamp=new Date(Date.now()-72000).toISOString();
let view={enabled:true,status:'connected',appTokenHint:'…AAAA',botTokenHint:'…BBBB',workspace:'Synthetic Team',activeTasks:0,users:[{id:'UOWNER',name:'Alex',isOwner:true,pairedAt:stamp},{id:'UPAIRED',name:'Sam',pairedAt:stamp}]};
let rules={version:1,rules:[{source:'slack',scope:'channel-mention',senderClass:'trusted',level:'L3'},{source:'slack',scope:'channel-mention',senderId:'USENDER',level:'L2'}]};
let digest={time:'09:00',destination:'pugport-slack'};
const api=async(path,body,method='GET')=>{
if(path==='/api/slack/admission'){if(method==='PUT')rules=body;return structuredClone(rules);}
if(path==='/api/external-digest/settings'){if(method==='PUT')digest=body;return structuredClone(digest);}
if(path==='/api/devices')return {devices:[],slackHost:null};
if(path.startsWith('/api/slack/users/')&&method==='PATCH'){const id=decodeURIComponent(path.split('/').at(-1));view.users=view.users.map(u=>({...u,isOwner:u.id===id&&body.isOwner}));}
return structuredClone(view);
};
window.notices=[];
const run={id:'r',workflowId:'w',status:'running',route:{runtimeId:'synthetic',kind:'routine',reasons:[],warnings:[]},startedAt:stamp,reasoning:'**Latest headline**\nHidden body\n\nPartial',events:[]};
const workflow={id:'w',status:'running',startedAt:stamp,updatedAt:stamp,runIds:['r'],input:{content:'Synthetic task'},plan:[]};
window.configure=async theme=>{document.documentElement.dataset.theme=theme;await applyInterfaceLocale('zh-CN');root.render(<main style={{maxWidth:900,margin:'auto',padding:24}}><h2>连接与服务</h2><SlackGateway api={api} notify={n=>window.notices.push(n)}/><ReasoningTail workflow={workflow} runs={[run]} targets={[{id:'synthetic',label:'My card'}]}/></main>);};
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
win=new BrowserWindow({show:false,width:1280,height:1080,webPreferences:{offscreen:true,contextIsolation:false,nodeIntegration:false}});
win.webContents.on('console-message',(_event,_level,message)=>console.error('renderer:',message));
await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
const evaluate=code=>win.webContents.executeJavaScript('(async()=>{try{return await ('+code+')}catch(error){return {rendererError:error.stack}}})()').then(value=>{if(value?.rendererError)throw Error(value.rendererError);return value;}),pause=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<100&&!await evaluate('window.ready');i++)await pause(20);
for(const width of [1280,560])for(const theme of ['light','dark']){
win.setSize(width,1080);await evaluate('window.configure('+JSON.stringify(theme)+')');await pause(500);
assert.ok(await evaluate('document.body.innerText.includes("谁能让 PugPort 做事")'),'admission block renders on card');
assert.ok(await evaluate('document.body.innerText.includes("每日摘要")'),'digest row renders');
assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow');
const gaps=await evaluate('(()=>{const tail=document.querySelector(".turn-tail"),spans=[...tail.children],r=n=>{if(!n)throw Error(tail.outerHTML);return n.getBoundingClientRect()};return [r(spans[1]).left-r(spans[0]).right,r(spans[3]).left-r(spans[2]).right,r(spans[5]).left-r(spans[4]).right]})()');
assert.ok(gaps.every(n=>n>0),'visible gaps between executor/status, elapsed label/duration and ellipsis/headline: '+JSON.stringify(gaps));
await fs.writeFile(path.join(${JSON.stringify(screenshots)},'settings-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
}
assert.deepEqual(await evaluate('window.notices'),[]);
console.log('PASS: four channel settings screenshots and live text spacing');
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
