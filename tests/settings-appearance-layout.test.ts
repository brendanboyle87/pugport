import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { offscreenElectronEnv, offscreenRequirePath } from './helpers/offscreen-electron.cjs';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'General Appearance remains usable at 1000x700 with every zoom preset, offscreen only',
  { timeout: 45000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-appearance-layout-')));
    const artifacts = resolve('reports/appearance-layout');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-appearance-layout-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    // Every stylesheet the app loads, so fixed elements such as the problem-report button sit where they do in the app.
    const appStyles = (await readFile('src/ui/main.tsx', 'utf8'))
      .split('\n')
      .filter((line) => /^import '\.\/[^']+\.css';/.test(line))
      .map((line) => line.replace("'./", "'./src/ui/"))
      .join('\n');
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import Studio from './src/ui/Studio';
${appStyles}
const settings={maxQuotaAgeSeconds:120,notifyOnFinish:'background'};
window.fixture={state:{projects:[],conversations:[],conversationMessages:[],workflows:[],runs:[],runtimes:[],targets:[],approvals:[],plugins:[],app:{version:'synthetic',platform:'win32'},settings},connection:'connected',api:async(path)=>path==='/api/settings/status'?{paths:{dataDir:'Synthetic',memoryDir:'Synthetic'},tools:{}}:[],reload:async()=>{}};
window.errors=[];window.addEventListener('error',event=>window.errors.push(event.message));
let zoom=1;const listeners=new Set();
window.comboRunnerDesktop={pickDirectory:async()=>null,getZoom:async()=>zoom,setZoom:async(value)=>{zoom=value;for(const fn of listeners)fn(value);return value;},onZoomChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},setTheme:async()=>{}};
localStorage.setItem('pugport-settings-category','general');
createRoot(document.getElementById('root')).render(<Studio/>);`,
      },
      plugins: [
        {
          name: 'synthetic-backend',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/App$/ }, (args) =>
              args.importer.endsWith('Studio.tsx') ? { path: 'fixture-backend', namespace: 'mock' } : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              resolveDir: process.cwd(),
              contents: "export * from './src/ui/App'; export const useBackend=()=>window.fixture;",
            }));
          },
        },
      ],
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
const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(2),35000);
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1000,height:700,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 const remote=[];win.webContents.session.webRequest.onBeforeRequest((details,cb)=>{const blocked=!details.url.startsWith('file://')&&!details.url.startsWith('data:');if(blocked)remote.push(details.url);cb({cancel:blocked});});
 const read=code=>win.webContents.executeJavaScript(code),frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 await win.loadFile(path.join(__dirname,'index.html'));
 for(let n=0;n<40;n++){await frame();if(await read('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="设置")'))break;}
 await read('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="设置").click()');await frame();
 const metrics=[];
 for(const theme of ['light','dark'])for(const zoom of [0.8,0.9,1,1.1,1.25,1.5]){
  win.webContents.setZoomFactor(zoom);await read('window.comboRunnerDesktop.setZoom('+zoom+')');await frame();
  // Compact settings use category navigation; select General if the detail is not mounted yet.
  if(!await read('!!document.querySelector("[aria-label=界面大小]")')){await read('document.querySelector("[data-settings-category=general]").click()');await frame();}
  await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();
  const value=await read('(()=>{const group=document.querySelector("[aria-label=界面大小]"),accent=document.querySelector("[aria-label=强调色]");const controls=[...group.querySelectorAll("button"),...accent.querySelectorAll("button")];return {width:innerWidth,height:innerHeight,horizontal:document.documentElement.scrollWidth>innerWidth,controls:controls.map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};}),presets:group.querySelectorAll("button").length};})()');metrics.push({theme,zoom,...value});
  assert.equal(value.horizontal,false,JSON.stringify(metrics.at(-1)));assert.equal(value.presets,6);
  for(const control of value.controls){assert.ok(control.width>0&&control.height>0);assert.ok(control.left>=0&&control.right<=value.width+1,JSON.stringify(metrics.at(-1)));}
  await read('document.querySelector("[aria-label=强调色]").scrollIntoView({block:"center"})');await frame();
  assert.ok(await read('document.querySelector("[aria-label=强调色]").getBoundingClientRect().bottom<=innerHeight+1'));
  await fs.writeFile(path.join(${JSON.stringify(artifacts)},theme+'-'+Math.round(zoom*100)+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 assert.deepEqual(await read('window.errors'),[]);assert.deepEqual(remote,[]);
 await fs.writeFile(path.join(${JSON.stringify(artifacts)},'metrics.json'),JSON.stringify(metrics,null,2));console.log('PASS: 12 appearance layouts, 1000x700, 80-150%, no visible window');
 }catch(error){console.error(error.stack||error);app.exitCode=1;}finally{clearTimeout(deadline);if(win)win.destroy();app.exit(app.exitCode||0);}});
`,
    );
    const { stdout, stderr } = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      { timeout: 40000, windowsHide: true, env: offscreenElectronEnv() },
    );
    assert.match(stdout, /PASS: 12 appearance layouts/);
    assert.doesNotMatch(stderr, /AssertionError/);
  },
);
