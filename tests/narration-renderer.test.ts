import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('streaming Markdown survives a stale compact projection', { timeout: 45000 }, async (t) => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-conversation-stream-')));
  const artifacts = resolve('.oil-ui/narration-full');
  await mkdir(artifacts, { recursive: true });
  t.after(async () => {
    assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(fixture).startsWith('pugport-conversation-stream-'));
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await writeFile(
    join(fixture, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
  );
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkflowTrace} from './src/ui/Workspace';
import './src/ui/studio.css';
const at=new Date(Date.now()-30000).toISOString();
const workflow={id:'B',conversationId:'B',projectId:'p',input:{content:'Synthetic',mode:'chat',permissionMode:'read-only'},status:'running',phase:'execute',activeStepId:'reply',plan:[{id:'reply',title:'Reply',status:'running',runIds:['B']}],runIds:['B'],createdAt:at,updatedAt:at};
const run={id:'B',workflowId:'B',stepId:'reply',prompt:'Synthetic',projectPath:'',kind:'routine',status:'running',route:{runtimeId:'Anthropic',model:'synthetic'},startedAt:at,output:'',events:[]};
const body='## Content summary\\n\\n- Shopify uses coding agents.\\n- Markdown remains complete.\\n\\n'+'This synthetic response stays visible while the task is running. '.repeat(5)+'END-OF-BODY';
const root=createRoot(document.getElementById('root'));
const noop=()=>{},api=async()=>{throw Error('Synthetic offline')};
window.narration=(projected)=>{document.documentElement.dataset.theme='light';const state={runs:[{...run,output:body}],workflows:[workflow],targets:[],approvals:[],projects:[],conversations:[],settings:{},conversationPresentations:projected?{B:{version:1,workflowId:'B',needsDetail:true,items:[{key:'B:reply:0',runId:'B',kind:'narration',text:body.slice(0,100),preview:'flattened'}]}}:{}};root.render(<main id="pane-B" style={{padding:48}}><WorkflowTrace workflow={workflow} state={state} api={api} notify={noop} onInspect={noop}/></main>);};
window.narration(false);`,
    },
    bundle: true,
    platform: 'browser',
    outfile: join(fixture, 'fixture.js'),
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'file' },
  });
  const runner = join(fixture, 'runner.cjs');
  await writeFile(
    runner,
    `const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(2),30000);
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
await win.loadFile(path.join(__dirname,'index.html'));const evaluate=code=>win.webContents.executeJavaScript(code);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
for(let i=0;i<30;i++){await frame();if(await evaluate('document.querySelectorAll(".live-main-reply").length===1'))break;}
await evaluate('window.narration(false)');await frame();
assert.ok(await evaluate('document.querySelector("#pane-B .live-main-reply").textContent.includes("END-OF-BODY")'));
await evaluate('window.narration(true)');await frame();
assert.equal(await evaluate('document.querySelectorAll("#pane-B .live-main-reply").length'),0);
assert.equal(await evaluate('document.querySelectorAll("#pane-B .turn-narration h3").length'),1);
assert.equal(await evaluate('document.querySelectorAll("#pane-B .turn-narration li").length'),2);
assert.equal(await evaluate('document.querySelector("#pane-B").textContent.split("END-OF-BODY").length-1'),1);
assert.ok(await evaluate('document.querySelector("#pane-B .turn-narration").textContent.endsWith("END-OF-BODY")'));

await fs.writeFile(path.join(${JSON.stringify(artifacts)},'running-light.png'),(await win.webContents.capturePage()).toPNG());
console.log('PASS: full Markdown survives projection arrival');
}catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(deadline);win?.destroy();app.exit(process.exitCode||0);}});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
    env,
    windowsHide: true,
    timeout: 35000,
    maxBuffer: 1024 * 1024,
  });
  console.log(result.stdout.trim());
  assert.match(result.stdout, /PASS: full Markdown survives projection arrival/);
});
