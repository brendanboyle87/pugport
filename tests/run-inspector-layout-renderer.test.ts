import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { offscreenElectronEnv, offscreenRequirePath } from './helpers/offscreen-electron.cjs';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'offscreen inspector uses available height and keeps long output, trajectory and footer reachable',
  { timeout: 45000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-inspector-layout-')));
    const artifacts = resolve('artifacts/run-inspector-layout');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-inspector-layout-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RunOutput} from './src/ui/App';
import './src/ui/studio.css';
const stamp='2026-10-24T19:00:00.000Z';
const run={id:'synthetic-run',prompt:'Synthetic task',projectPath:'C:/Synthetic',kind:'routine',status:'completed',route:{runtimeId:'fixture',model:'synthetic-model',effort:'low',kind:'routine',reasons:[],warnings:[]},startedAt:stamp,endedAt:'2026-10-24T19:00:09.000Z',output:'Task done.',events:Array.from({length:70},(_,i)=>({seq:i+1,type:'status',at:new Date(Date.parse(stamp)+i*100).toISOString(),text:'Synthetic progress '+i}))};
const root=createRoot(document.getElementById('root'));
window.show=(tab='output',long=true)=>root.render(<div className="studio-shell"><div className="studio-main"><header className="studio-topbar">Synthetic toolbar</header><main id="main-content" className="management-main"><div className="management-heading"><div><h1>执行记录</h1><p>查看完整执行过程与最终回复。</p></div></div><div className="run-record-layout"><aside className="run-record-browser"><label className="search-input"><input aria-label="搜索执行记录"/></label><div className="run-record-list"><button className="run-record-item">Synthetic task</button></div></aside><RunOutput key={tab+long} run={run} runtimes={[]} targets={[]} api={async()=>{throw Error('Unexpected request');}} notify={()=>{}} onHandoff={()=>{}} initialTab={tab} userInput="Synthetic task" finalOutput={long?Array.from({length:100},(_,i)=>'Synthetic reply line '+i).join('\\n'):'Short reply.'}/></div></main></div></div>);
window.errors=[];window.addEventListener('error',event=>window.errors.push(event.message));window.show();`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(directory, 'fixture.js'),
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      `
require(${JSON.stringify(offscreenRequirePath)});
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(2),35000);
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1920,height:1080,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 const remote=[];win.webContents.session.webRequest.onBeforeRequest((details,cb)=>{const blocked=!details.url.startsWith('file://');if(blocked)remote.push(details.url);cb({cancel:blocked});});
 await win.loadFile(path.join(__dirname,'index.html'));
 const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw new Error('Renderer step: '+code,{cause:error});}},frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 for(let n=0;n<40;n++){await frame();if(await read('!!document.querySelector(".output-footer")'))break;}
 const metrics=[];
 for(const theme of ['light','dark'])for(const [width,height] of [[1920,1080],[1180,820],[390,820],[1180,500]]){
  win.setSize(width,height);await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await read('window.show("output",true)');await frame();
  const measurement=await read('(()=>{const body=document.querySelector(".output-body"),footer=document.querySelector(".output-footer");return {width:innerWidth,height:innerHeight,gap:innerHeight-footer.getBoundingClientRect().bottom,bodyHeight:body.clientHeight,scrollHeight:body.scrollHeight,horizontal:document.documentElement.scrollWidth>innerWidth};})()');metrics.push({theme,...measurement});
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'x'+height+'-output.png'),(await win.webContents.capturePage()).toPNG());
  assert.equal(measurement.horizontal,false);
  if(width>900&&height>=640){assert.ok(measurement.gap>=-1&&measurement.gap<=24,JSON.stringify(measurement));assert.ok(measurement.scrollHeight>measurement.bodyHeight);if(height===1080)assert.ok(measurement.bodyHeight>580,JSON.stringify(measurement));}
  else {await read('(()=>{const main=document.querySelector("#main-content");main.scrollTop=main.scrollHeight;})()');await frame();assert.ok(await read('document.querySelector(".output-footer").getBoundingClientRect().bottom<=innerHeight+1'));}
  await read('(()=>{const body=document.querySelector(".output-body");body.focus();body.scrollTop=body.scrollHeight;})()');await frame();assert.ok(await read('document.querySelector(".output-body").scrollTop>0'));
  if(width>900&&height>=640)assert.equal(await read('document.activeElement===document.querySelector(".output-body")'),true);
  await read('window.show("trajectory",false)');await frame();assert.ok(await read('!!document.querySelector(".trajectory-panel")'));
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+width+'x'+height+'-trajectory.png'),(await win.webContents.capturePage()).toPNG());
  assert.ok(await read('document.querySelector(".output-body").scrollHeight>document.querySelector(".output-body").clientHeight'));
 }
 assert.deepEqual(await read('window.errors'),[]);assert.deepEqual(remote,[]);
 await fs.writeFile(path.join(${JSON.stringify(artifacts)},'metrics.json'),JSON.stringify(metrics,null,2));console.log('PASS: 8 layouts, bounded footer gap, scrollable long output and trajectory, 0 network requests');
}catch(error){console.error(error.stack||error);app.exitCode=1;}finally{clearTimeout(deadline);if(win)win.destroy();app.exit(app.exitCode||0);}});`,
    );
    const env = offscreenElectronEnv();
    const { stdout, stderr } = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      { timeout: 40000, windowsHide: true, env },
    );
    assert.match(stdout, /PASS: 8 layouts/);
    assert.doesNotMatch(stderr, /AssertionError/);
  },
);
