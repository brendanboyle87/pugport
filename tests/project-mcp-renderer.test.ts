import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'project MCP renderer saves inheritance, selected disabled servers and one-click empty scope offline',
  { timeout: 60000 },
  async () => {
    const root = process.cwd();
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-project-mcp-ui-'));
    const artifacts = resolve('artifacts/project-mcp');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(fixture, 'style.css'), await readFile('src/ui/studio.css'));
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body><main id="root" style="padding:24px;max-width:680px;margin:auto"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryEditor} from './src/ui/Workspace';
const initial={id:'synthetic-project',name:'Synthetic project',path:'C:/Synthetic/project',createdAt:'',updatedAt:''};
window.fixture={project:initial,calls:[],notices:[],memory:'Synthetic memory'};
let update;
const api=async(path,body,method)=>{
 window.fixture.calls.push({path,body,method});
 if(path==='/api/routing-profiles'&&method==='GET')return {profiles:[]};
 if(path==='/api/extensions'){if(window.fixture.failExtensions)throw new Error('Synthetic catalogue unavailable');return {items:[{kind:'mcp',id:'enabled',name:'本机合成工具',enabled:true},{kind:'mcp',id:'disabled',name:'已停用的合成工具',enabled:false}]};}
 if(path.endsWith('/local-memory'))return {exportEnabled:true,cliEnabled:false,dataDirectory:'Synthetic',archiveDirectory:'Synthetic',projectDirectory:'Synthetic',files:[],warnings:[]};
 if(path.endsWith('/memory')){if(method==='PATCH')window.fixture.memory=body.content;return {projectId:initial.id,content:window.fixture.memory,revision:1,updatedAt:''};}
 if(path==='/api/projects/'+initial.id && method==='PATCH'){
  const next={...window.fixture.project};
  if(body.mcpServers===null)delete next.mcpServers;else next.mcpServers=body.mcpServers;
  window.fixture.project=next;update(next);return next;
 }
 throw new Error('Unexpected synthetic API: '+path);
};
function Fixture(){const [project,setProject]=useState(initial);const [epoch,setEpoch]=useState(0);update=setProject;window.fixture.remount=()=>{const next={...initial,mcpServers:['disabled']};window.fixture.project=next;setProject(next);setEpoch(value=>value+1);};return <MemoryEditor key={epoch} project={project} api={api} notify={value=>window.fixture.notices.push(value)} autoFocus={false}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:760,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
 await win.loadFile(path.join(__dirname,'index.html'));
 const evaluate=code=>win.webContents.executeJavaScript(code);
 const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 for(let attempt=0;attempt<30;attempt++){await frame();if(await evaluate('!!document.querySelector("select:has(option[value=inherit])")'))break;}
 const scope='document.querySelector("select:has(option[value=inherit])").closest("fieldset")';
 const change=async value=>{await evaluate('(()=>{const el=document.querySelector("select:has(option[value=inherit])");el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame();};
 const click=async label=>{await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');await frame();};
 const shot=async name=>{await evaluate(scope+'.scrollIntoView({block:"center"})');await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
 assert.equal(await evaluate('document.querySelector("select:has(option[value=inherit])").value'),'inherit');
 assert.match(await evaluate(scope+'.textContent'),/当前生效：本机合成工具/);await shot('inherit');
 await change('selected');
 await evaluate(scope+'.querySelectorAll("input")[1].click()');await frame();
 assert.match(await evaluate(scope+'.textContent'),/全局已停用，当前不生效/);
 assert.match(await evaluate(scope+'.textContent'),/当前生效：本机合成工具/);
 await click('保存记忆与设置');
 assert.deepEqual(await evaluate('window.fixture.project.mcpServers'),['disabled','enabled']);await shot('selected-disabled');
 await click('禁用本项目全部 MCP');await click('保存记忆与设置');
 assert.deepEqual(await evaluate('window.fixture.project.mcpServers'),[]);
 assert.match(await evaluate(scope+'.textContent'),/本项目已禁用全部 MCP/);await shot('disabled-all');
 await change('inherit');await click('保存记忆与设置');
 assert.equal(await evaluate('Object.hasOwn(window.fixture.project,"mcpServers")'),false);
 assert.deepEqual(await evaluate('window.fixture.calls.filter(c=>c.method==="PATCH").map(c=>c.body.mcpServers)'),[['disabled','enabled'],[],null]);
 assert.equal(await evaluate('window.fixture.notices.filter(n=>n.tone==="error").length'),0);
 win.setSize(390,1000);await frame();assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await shot('inherit-narrow');
 await evaluate('window.fixture.failExtensions=true;window.fixture.remount()');await frame();
 assert.match(await evaluate('document.body.textContent'),/MCP 列表暂时无法读取，项目选择未更改/);
 assert.equal(await evaluate('document.querySelectorAll("select:has(option[value=inherit])").length'),0);
 assert.equal(await evaluate('document.querySelector("#project-memory-synthetic-project").value'),'Synthetic memory');
 await evaluate('(()=>{const el=document.querySelector("#project-memory-synthetic-project");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"Edited synthetic memory");el.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();
 await click('保存记忆与设置');
 assert.equal(await evaluate('window.fixture.memory'),'Edited synthetic memory');
 assert.deepEqual(await evaluate('window.fixture.project.mcpServers'),['disabled']);
 assert.equal(await evaluate('window.fixture.calls.filter(c=>c.path==="/api/projects/synthetic-project"&&c.method==="PATCH").length'),3);
 await evaluate('document.querySelector("[role=alert]").scrollIntoView({block:"center"})');await frame();
 await fs.writeFile(path.join(${JSON.stringify(artifacts)},'catalogue-error.png'),(await win.webContents.capturePage()).toPNG());
 await evaluate('window.fixture.failExtensions=false');await click('重试读取 MCP 列表');
 assert.equal(await evaluate('document.querySelector("select:has(option[value=inherit])").value'),'selected');
 assert.equal(await evaluate(scope+'.querySelectorAll("input")[1].checked'),true);
 assert.match(await evaluate(scope+'.textContent'),/当前生效：无/);
 assert.equal(await evaluate('window.fixture.calls.some(c=>c.path.endsWith("/routing-profile")&&c.method==="PATCH")'),false);
 console.log('PASS project MCP renderer: inheritance, selected globally disabled server, disable-all, three scope saves, catalogue failure preserves scope and memory save, retry, narrow layout, five screenshots');
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});`,
    );
    const require = createRequire(import.meta.url);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron') as string, electronArgs(runner), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS project MCP renderer/);
    } finally {
      clearTimeout(timeout);
      assert.equal(dirname(resolve(fixture)).toLowerCase(), resolve(tmpdir()).toLowerCase());
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  },
);
