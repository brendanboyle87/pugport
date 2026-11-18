import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { offscreenElectronEnv } from './helpers/offscreen-electron.cjs';

test(
  'Skills renderer: localized search, groups, precise toggles, collapse persistence and four screenshots offline',
  { timeout: 60000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'pugport-skills-ui-'));
    const artifacts = resolve('artifacts/skill-summaries');
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><main id="root" style="height:100vh;width:440px;margin:0 auto"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationPanel} from './src/ui/ConversationPanel';
import {startInterfaceLanguage} from './src/ui/i18n';
import './src/ui/studio.css';
import './src/ui/ConversationPanel.css';
const locale=new URLSearchParams(location.search).get('locale')||'en';
const theme=new URLSearchParams(location.search).get('theme')||'dark';
localStorage.setItem('comborunner.locale',locale);
document.documentElement.dataset.theme=theme;
const make=(name,category,en,zh)=>({kind:'skill',id:name,name,description:en+'. Extra trigger instructions stay in this tooltip.',enabled:true,summaries:{[locale]:{hash:'fixture',language:locale,category,summary:locale==='en'?en:zh}}});
const items=[make('draft-brief','writing','Turn rough notes into a clear project brief','把零散笔记整理成清晰的项目简报'),make('edit-copy','writing','Polish text for clarity and a natural voice','润色文字，让表达清晰自然'),make('review-code','review','Find bugs and missing tests in your changes','检查代码改动中的缺陷和测试遗漏'),make('test-plan','review','Plan focused tests for important user flows','为关键用户流程制定测试计划'),make('research-notes','research','Compare sources and organize research findings','对比资料来源，整理研究发现'),make('chart-data','data','Turn tables into useful charts and summaries','把表格转成实用的图表和摘要'),{kind:'skill',id:'fallback',name:'fallback-skill',description:'Read the first sentence. Never show this extra instruction.',enabled:true},{...make('disabled-skill','coding','Hidden disabled skill','隐藏的技能'),enabled:false}];
window.fixture={calls:[]};
const conversation={id:'synthetic-chat',title:'Synthetic chat',createdAt:'',updatedAt:'',appliedSkills:['draft-brief']};
const api=async(path,body,method)=>{window.fixture.calls.push({path,body,method});if(method==='GET')return {items};return {...conversation,appliedSkills:body.appliedSkills};};
startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<ConversationPanel tab="skills" onTab={()=>{}} onClose={()=>{}} conversation={conversation} state={{}} api={api} notify={()=>{}}/>));
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,width:440,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')&&!details.url.startsWith('data:')}));
const evaluate=code=>win.webContents.executeJavaScript(code);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const search=async value=>{await evaluate('(()=>{const input=document.querySelector("input[type=search]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};
for(const locale of ['en','zh-CN'])for(const theme of ['dark','light']){
await win.loadFile(path.join(__dirname,'index.html'),{query:{locale,theme}});
for(let attempt=0;attempt<40;attempt++){await frame();if(await evaluate('!!document.querySelector(".skill-choices li")'))break;}
await evaluate('document.querySelector(".skill-group-actions button").textContent.includes("Expand")||document.querySelector(".skill-group-actions button").textContent.includes("展开")?document.querySelector(".skill-group-actions button").click():null');await frame();
assert.equal(await evaluate('document.body.textContent.includes("disabled-skill")'),false);
assert.equal(await evaluate('document.querySelector(".skill-choices li small").closest("label")'),null);
const before=await evaluate('window.fixture.calls.filter(c=>c.method==="PATCH").length');
await evaluate('document.querySelector(".skill-choices li small").click()');await frame();
assert.equal(await evaluate('window.fixture.calls.filter(c=>c.method==="PATCH").length'),before);
await evaluate('document.querySelector(".skill-choices li label span").click()');await frame();
assert.equal(await evaluate('window.fixture.calls.filter(c=>c.method==="PATCH").length'),before+1);
await search(locale==='en'?'Research':'研究');
assert.equal(await evaluate('document.querySelectorAll(".skill-choices li").length'),1);
assert.match(await evaluate('document.querySelector(".skill-choices li").textContent'),/research-notes/);
await search('missing skill');assert.equal(await evaluate('document.querySelectorAll(".skill-choices li").length'),0);
await search('');
await evaluate('document.querySelector(".skill-group-actions button").click()');await frame();
assert.equal(await evaluate('document.querySelectorAll(".skill-choices li").length'),0);
await evaluate('document.querySelector(".skill-group-actions button").click()');await frame();
assert.equal(await evaluate('document.querySelectorAll(".skill-choices li").length'),7);
await evaluate('document.querySelectorAll(".skill-group h3 button")[1].click()');await frame();
assert.equal(await evaluate('document.querySelectorAll(".skill-group button[aria-expanded=false]").length'),1);
assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
assert.equal(await evaluate('document.querySelector("input[type=search]").placeholder'),locale==='en'?'Search Skills':'搜索 Skills');
await fs.writeFile(path.join(${JSON.stringify(artifacts)},'skills-'+locale+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
await win.reload();await frame();
for(let attempt=0;attempt<40;attempt++){await frame();if(await evaluate('!!document.querySelector(".skill-group")'))break;}
assert.equal(await evaluate('document.querySelectorAll(".skill-group button[aria-expanded=false]").length'),1);
// Clear this synthetic window's collapse preference for the next independent locale/theme capture.
await evaluate('document.querySelector(".skill-group button[aria-expanded=false]").click()');await frame();
}
console.log('PASS skills renderer: disabled hidden, summary clicks inert, name toggles, localized category search, empty results, collapse all, group collapse, reload persistence, no overflow, 4 screenshots');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const require = createRequire(import.meta.url);
    const child = spawn(require('electron') as string, electronArgs(runner), {
      cwd: process.cwd(),
      env: offscreenElectronEnv(),
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
      assert.match(output, /PASS skills renderer/);
    } finally {
      clearTimeout(timeout);
      assert.equal(dirname(resolve(fixture)).toLowerCase(), resolve(tmpdir()).toLowerCase());
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  },
);
