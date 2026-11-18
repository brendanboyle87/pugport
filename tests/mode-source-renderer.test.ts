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
import { packMod } from '../scripts/pack-mod.ts';

test(
  'offline Store source previews pinned README and loads or unloads Mods without applying them',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-mode-source-')));
    const artifacts = resolve('artifacts/mod-source');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-mode-source-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const { manifest: example } = await packMod(resolve('docs/examples/mods/reading-notes'), {
      out: join(fixture, 'reading-notes.json'),
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{overflow:auto}#root{padding:20px}*,*::before,*::after{transition:none!important;animation:none!important}</style><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    const readme = `${example.readme}

- Synthetic first point
- Synthetic second point
- Synthetic third point

![Blocked external image](https://images.example.invalid/private-cover.png)`;
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import React from'react';import{createRoot}from'react-dom/client';import{StorePage}from'./src/ui/StorePage';import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';import'@fontsource-variable/inter';import'@fontsource-variable/noto-sans-sc';import'./src/ui/studio.css';import'./src/ui/StorePage.css';
const manifest={...${JSON.stringify(example)},id:'fixture.private',version:'1.0.0',title:'Private reading notes',author:'Fixture Studio',homepage:'https://example.invalid/mods/private',readme:${JSON.stringify(readme)}};
const{ui,state,contributions,readme:fullReadme,...metadata}=manifest;
const noHomepageManifest={...manifest,id:'fixture.nohomepage',title:'No homepage'};delete noHomepageManifest.homepage;
const{ui:noHomepageUi,state:noHomepageState,contributions:noHomepageContributions,readme:noHomepageReadme,...noHomepageMetadata}=noHomepageManifest;
const f=window.fixture={calls:[],downloads:[],blobUrls:0,local:[],installed:[],remote:[],manifest,savedData:{conversationId:'existing-chat',note:'已有 Mod 数据必须保留。'},fail:false,source:{enabled:true,repository:'fixture/private-mods',ref:'main',catalogPath:'catalog.json'},revision:'a'.repeat(40)};
URL.createObjectURL=()=>{f.blobUrls++;throw Error('Unexpected Save As');};const anchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download){f.downloads.push(this.download);return;}return anchorClick.call(this);};
const api=async(path,body,method='POST')=>{f.calls.push({path,body,method});const local=()=>({catalog:[...f.local],installed:[...f.installed]}),source=()=>({config:f.source,status:f.fail?'error':'ready',catalog:[...f.remote],revision:f.revision,checkedAt:'2026-10-24T12:00:00.000Z',...(f.fail?{error:'当前 GitHub 登录没有此私有仓库的读取权限。'}:{})});
 if(path==='/api/bank/settings')return{configured:false};
 if(path==='/api/bank/connections')return{connections:[]};
 if(path==='/api/mod-data')return{mods:[]};
 if(path==='/api/modes')return local();
 if(path==='/api/modes/source'){if(method==='PUT'){f.source=body;f.remote=[];return{config:body,status:'unconfigured',catalog:[]};}return source();}
 if(path==='/api/modes/source/refresh')return source();
 if(path==='/api/modes/source/install'){if(body.revision!==f.revision)throw Error('Stale revision');f.local=[{...metadata,compatible:true}];f.installed=[{modeId:metadata.id,version:metadata.version,installedAt:''}];return local();}
 if(path==='/api/modes/fixture.private/install'&&method==='DELETE'){f.installed=[];return local();}
 if(path.startsWith('/api/modes/source/fixture.private/versions/1.0.0/export?revision='))return manifest;
 if(path.startsWith('/api/modes/source/fixture.nohomepage/versions/1.0.0/export?revision='))return noHomepageManifest;
 if(path==='/api/modes/fixture.private/versions/1.0.0/export')return manifest;
 throw Error('Unexpected API '+path);
};
f.publish=()=>{f.remote=[{...metadata,compatible:true},{...noHomepageMetadata,compatible:true}];};
createRoot(document.getElementById('root')).render(<><StorePage api={api} notify={()=>{}}/><ConfirmDialogHost/></>);
`,
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: join(fixture, 'fixture.js'),
      loader: { '.woff2': 'file', '.png': 'dataurl', '.webp': 'dataurl' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1120,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});let remote=0,downloads=0;const external=[];win.webContents.setWindowOpenHandler(details=>{external.push(details.url);return{action:'deny'};});win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const cancel=!d.url.startsWith('file://')&&!d.url.startsWith('data:image/png;base64,')&&!d.url.startsWith('data:image/webp;base64,');if(cancel)remote++;cb({cancel});});win.webContents.session.on('will-download',(event)=>{downloads++;event.preventDefault();});
 await win.loadFile(path.join(__dirname,'index.html'));const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error('Renderer step: '+code,{cause:error});}};const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const wait=async code=>{for(let n=0;n<50;n++){await frame();if(await read(code))return;}throw Error('Not ready: '+code);};
 const click=async(label,scope='document')=>{await read('[...'+scope+'.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+'||b.getAttribute("aria-label")==='+JSON.stringify(label)+').click()');await frame();};const shot=async name=>{await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
 await wait('document.querySelector(".store-source-heading [role=status]")?.textContent==="来源：GitHub · 0 个 Mods"');assert.equal(await read('document.querySelectorAll(".store-mode-card").length'),0);assert.equal(await read('window.fixture.calls.filter(c=>c.path.endsWith("/install")).length'),0);await shot('empty-private-light-1120');
 await read('window.fixture.publish()');await click('设置来源');await click('刷新来源');await click('设置来源');await wait('document.querySelectorAll(".store-mode-card").length===2');assert.equal(await read('window.fixture.installed.length'),0);assert.equal(await read('document.querySelector(".store-mode-origin")'),null);assert.equal(await read('document.querySelector(".store-mode-card .button.tiny").textContent.trim()'),'加载');
 assert.equal(await read('window.fixture.remote.every(m=>!("readme" in m))'),true);assert.equal(await read('window.fixture.calls.some(c=>c.path.includes("/export"))'),false);await wait('document.querySelector(".store-cover-button img")?.complete&&document.querySelector(".store-cover-button img")?.naturalWidth===800&&document.querySelector(".store-cover-button img")?.naturalHeight===600');assert.equal(await read('document.querySelector(".store-cover-button img").src===window.fixture.manifest.card.src'),true);
 await click('查看「Private reading notes」详情');await wait('document.querySelector(".store-drawer[open] .store-readme h2")?.textContent==="Reading notes"');await wait('document.querySelector(".store-drawer img")?.complete&&document.querySelector(".store-drawer img")?.naturalWidth===1280&&document.querySelector(".store-drawer img")?.naturalHeight===720');assert.equal(await read('document.querySelector(".store-drawer img").src===window.fixture.manifest.cover.src'),true);assert.match(await read('document.querySelector(".store-detail-sidebar").textContent'),/Fixture Studio/);assert.equal(await read('document.querySelectorAll(".store-readme img,.store-readme script,.store-readme iframe").length'),0);assert.equal(await read('document.querySelectorAll(".store-readme li").length>=3'),true);assert.equal(await read('window.fixture.installed.length'),0);assert.deepEqual(await read('window.fixture.calls.filter(c=>c.path.includes("/export")).map(c=>({path:c.path,method:c.method}))'),[{path:'/api/modes/source/fixture.private/versions/1.0.0/export?revision='+'a'.repeat(40),method:'GET'}]);assert.equal(await read('document.querySelector(".store-drawer").getBoundingClientRect().width===760'),true);assert.deepEqual(await read('(()=>{const a=[...document.querySelectorAll(".store-drawer a")].find(a=>a.textContent.trim()==="介绍网页");return{href:a.href,target:a.target,rel:[...a.relList].sort()}})()'),{href:'https://example.invalid/mods/private',target:'_blank',rel:['noopener','noreferrer']});await read('[...document.querySelectorAll(".store-drawer a")].find(a=>a.textContent.trim()==="介绍网页").click()');await frame();assert.deepEqual(external,['https://example.invalid/mods/private']);assert.equal(win.webContents.getURL().startsWith('file://'),true);await shot('private-detail-cover-light-1120');
 for(const theme of ['light','dark']){for(const width of [1120,390]){win.setSize(width,900);await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();await read('document.querySelector(".store-readme").scrollIntoView({block:"start"})');await frame();assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);assert.equal(await read('document.querySelector(".store-drawer").scrollWidth<=document.querySelector(".store-drawer").clientWidth+1'),true);await shot('private-readme-'+theme+'-'+width);}}
 await click('加载','document.querySelector(".store-drawer")');await wait('window.fixture.installed.length===1&&window.fixture.local.length===1');assert.deepEqual(await read('window.fixture.calls.filter(c=>c.path==="/api/modes/source/install").map(c=>({body:c.body,method:c.method}))'),[{body:{id:'fixture.private',version:'1.0.0',revision:'a'.repeat(40)},method:'POST'}]);assert.equal(await read('window.fixture.local.every(m=>!("readme" in m))'),true);assert.equal(await read('document.querySelector(".store-drawer .button.primary").textContent.trim()'),'打开');await click('卸载','document.querySelector(".store-drawer")');await wait('!!document.querySelector(".confirm-dialog[open]")');assert.match(await read('document.querySelector(".confirm-dialog").textContent'),/已有对话中的内容会保留/);await click('取消','document.querySelector(".confirm-dialog")');assert.equal(await read('window.fixture.calls.filter(c=>c.method==="DELETE").length'),0);assert.equal(await read('window.fixture.installed.length'),1);await read('document.querySelector("button[aria-label="+JSON.stringify("关闭详情")+"]").click()');await frame();
 await click('查看「Private reading notes」详情');await wait('!!document.querySelector(".store-drawer[open]")');await click('卸载','document.querySelector(".store-drawer")');await wait('!!document.querySelector(".confirm-dialog[open]")');await click('卸载','document.querySelector(".confirm-dialog")');await wait('window.fixture.installed.length===0&&document.querySelector(".store-mode-card .button.tiny").textContent.trim()==="加载"');assert.deepEqual(await read('window.fixture.calls.filter(c=>c.method==="DELETE").map(c=>({path:c.path,body:c.body,method:c.method}))'),[{path:'/api/modes/fixture.private/install',body:undefined,method:'DELETE'}]);assert.equal(await read('window.fixture.local.length'),1);assert.deepEqual(await read('window.fixture.savedData'),{conversationId:'existing-chat',note:'已有 Mod 数据必须保留。'});assert.equal(await read('window.fixture.calls.filter(c=>c.path==="/api/modes/source/install").length'),1);
 await click('No homepage');await wait('!!document.querySelector(".store-drawer[open] .store-readme")');assert.equal(await read('[...document.querySelectorAll(".store-drawer button")].some(b=>b.textContent.trim()==="介绍网页")'),false);assert.equal(await read('[...document.querySelectorAll(".store-drawer a")].some(a=>a.textContent.trim()==="介绍网页")'),false);await read('document.querySelector("button[aria-label="+JSON.stringify("关闭详情")+"]").click()');await frame();
 win.setSize(1120,900);await frame();assert.equal(await read('document.querySelector(".store-source-toggle").getClientRects().length>0'),true);await click('设置来源');const set=async(placeholder,value)=>{await read('(()=>{const e=[...document.querySelectorAll(".store-source-form input")].find(e=>e.placeholder==='+JSON.stringify(placeholder)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};await set('owner/repository','fixture/new-private');await set('main','release/v1');await click('保存并刷新');await wait('window.fixture.calls.some(c=>c.method==="PUT")');assert.deepEqual(await read('window.fixture.calls.find(c=>c.method==="PUT").body'),{enabled:true,repository:'fixture/new-private',ref:'release/v1',catalogPath:'catalog.json'});assert.equal(await read('document.querySelectorAll(".store-mode-card").length'),1);
 await read('window.fixture.fail=true');await click('设置来源');await click('刷新来源');assert.match(await read('document.querySelector(".store-source-error").textContent'),/没能完成，请重试/);assert.equal(await read('document.querySelectorAll(".store-mode-card").length'),1);
 for(const theme of ['light','dark']){for(const width of [1120,390]){win.setSize(width,900);await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await frame();assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);assert.equal(await read('document.querySelectorAll("input[type=password]").length'),0);assert.equal(await read('document.querySelector(".store-source-toggle").getClientRects().length>0'),width>900);assert.equal(await read('getComputedStyle(document.querySelector(".store-source")).display==="none"'),width<=900);await shot('source-config-'+theme+'-'+width);}}
 assert.deepEqual(await read('window.fixture.calls.filter(c=>!c.path.startsWith("/api/modes")&&!(c.method==="GET"&&["/api/bank/settings","/api/bank/connections","/api/mod-data"].includes(c.path)))'),[]);assert.equal(await read('window.fixture.blobUrls'),0);assert.deepEqual(await read('window.fixture.downloads'),[]);assert.deepEqual(await read('[...document.querySelectorAll("button")].map(b=>b.textContent.trim()).filter(text=>/使用|应用|下载|另存为|Save As/.test(text))'),[]);assert.equal(downloads,0);assert.equal(remote,0);console.log('PASS Store source renderer: empty private catalog, metadata excludes README, pinned read-only detail, related WebP card at 800x600 and cover at 1280x720, load once, cancel and confirm unload with data retained, real homepage link and omitted absent homepage, source form, local preservation, private access error, 4 README + 4 source layouts, no apply, Save As or remote requests');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        cwd: process.cwd(),
        env,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS Store source renderer/);
  },
);
