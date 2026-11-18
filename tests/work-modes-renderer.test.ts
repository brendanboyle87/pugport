import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';
import { packModDirectory } from '../src/server/mod-pack.ts';

// Offscreen only (show:false, offscreen:true): the mode chip, its menu, the chat approval card and the Store's
// Local build row in the English interface, light and dark. WORK_MODES_SHOTS chooses where the PNGs go.
test('work modes render offscreen: chip, menu, approval card and Store local build', { timeout: 90000 }, async () => {
  const root = process.cwd();
  const fixture = await mkdtemp(join(tmpdir(), 'pugport-work-modes-ui-'));
  const shots = resolve(process.env.WORK_MODES_SHOTS ?? 'artifacts/work-modes');
  await mkdir(shots, { recursive: true });
  const { manifest } = await packModDirectory(join(root, 'docs/examples/mods/reading-notes'));
  const { readme: _readme, ui: _ui, ...entry } = manifest as typeof manifest & { ui?: unknown };
  try {
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body style="overflow:auto"><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ArrowUp,Plus}from'lucide-react';
import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';import '@fontsource-variable/jetbrains-mono';
import './src/ui/studio.css';import './src/ui/composer.css';import './src/ui/StorePage.css';import './src/ui/mods/mods.css';
import{ModeChip,ModeMenu}from'./src/ui/ComposerControls';import{StorePage}from'./src/ui/StorePage';
import{NavigatorRoutePopover,navigatorRouteLabel}from'./src/ui/Workspace';
import{ModApprovalCard}from'./src/ui/ModApprovalCard';import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';
import{ModFrame}from'./src/ui/mods/ModFrame';import{ModWorkspaceBar}from'./src/ui/mods/ModWorkspaceBar';
import{modDebugDraft}from'./src/ui/mods/ModDebugMenu';import{useModDebug}from'./src/ui/mods/mod-debug-store';
import{startInterfaceLanguage}from'./src/ui/i18n';
const entry=${JSON.stringify({ ...entry, compatible: true, localBuild: { workspaceId: 'a1b2c3d4e5', conversationId: '00000000-0000-4000-8000-000000000001', conversationTitle: 'Reading notes Mod' } })};
window.fixture={calls:[],opened:[],drafts:[],routes:[]};
// A Local build whose ui/main.js logs once and then throws while loading.
const broken={schemaVersion:2,id:'local.pomodoro',version:'0.1.3',title:'Pomodoro',description:'Synthetic',state:{keys:[]},permissions:['data:store'],ui:{entries:{main:{html:'<p style="font:14px sans-serif;padding:24px">Pomodoro</p>',js:"console.log('starting timer');throw new TypeError('timer is undefined');"}}},contributions:{mainView:{kind:'web',entry:'main'}}};
const frameHost={conversationId:'debug-chat',modId:broken.id,version:broken.version,instanceId:'i',manifest:broken,isCurrent:()=>true,
 info:()=>({apiVersion:2,hostVersion:'synthetic',locale:'en',theme:'light',tokens:{},slot:'mainView',layout:'workspace',conversation:{id:'debug-chat',title:'Pomodoro Mod'}}),
 getState:async()=>({revision:0,values:{}}),setState:async()=>({revision:1,values:{}}),messages:()=>[],insert:()=>{},notify:()=>{}};
function Debug(){const d=useModDebug('debug-chat');const toggle=React.useRef(null);
 return <div style={{width:760,height:420,display:'flex',flexDirection:'column',position:'relative'}}>
 <ModWorkspaceBar mode={broken} chatOpen={false} chatId="debug-chat-drawer" chatToggle={toggle} busy={false} onChat={()=>{}} onDetails={()=>{}} onHide={()=>{}} onRemove={()=>{}}
  debug={{errors:d.errors,logs:d.logs,entries:d.entries,permissions:{declared:broken.permissions,approval:'none'},
   validation:{ok:true,warnings:['warn: ui.entries.main.html: inline event handler — not executed in the Mod frame'],issues:[]},
   onReload:()=>{},onSendToChat:()=>window.fixture.drafts.push(modDebugDraft(broken.title,broken.version,d.entries))}}/>
 <div style={{flex:1,position:'relative',display:'flex'}}><ModFrame host={frameHost} slot="mainView" hidden={false} messages={{count:0}} running={false}/></div></div>;}
const api=async(path,body,method='POST')=>{const f=window.fixture;f.calls.push({path,body,method});
 if(path==='/api/bank/settings')return{configured:false};if(path==='/api/bank/connections')return{connections:[]};
 if(path==='/api/mod-data')return{mods:[]};
 if(path==='/api/modes')return{catalog:[entry],installed:[{modeId:entry.id,version:entry.version,installedAt:''}]};
 if(path==='/api/modes/source')return{config:null,status:'unconfigured',catalog:[]};
 if(path==='/api/conversations')return{id:'00000000-0000-4000-8000-000000000002',projectId:'p',title:body.title,createdAt:'',updatedAt:''};
 if(path.startsWith('/api/conversations/')&&method==='PATCH')return{id:path.split('/').pop(),projectId:'p',title:'New Mod',workMode:body.workMode,createdAt:'',updatedAt:''};
 if(path==='/api/mod-workspaces/a1b2c3d4e5/edit')return{id:entry.localBuild.conversationId,projectId:'p',title:'Reading notes Mod',workMode:'mods-author',createdAt:'',updatedAt:''};
 throw new Error('Unexpected synthetic API '+path);};
// Two synthetic cards for Navigator › Runs on.
const routeState={targets:[{id:'claude-native',provider:'claude',label:'Claude · 本机',command:'unused',environment:'native',enabled:true},{id:'codex-native',provider:'codex',label:'Codex · 本机',command:'unused',environment:'native',enabled:true}],
 runtimes:[{id:'claude-native',provider:'claude',label:'Claude · 本机',environment:'native',installed:true,status:'ready',models:[{id:'opus-5.5',label:'Opus 5.5',efforts:['low','medium','high','max']}],capabilities:{execute:true,resume:true,cancel:true,approvals:true},refreshedAt:''},
  {id:'codex-native',provider:'codex',label:'Codex · 本机',environment:'native',installed:true,status:'ready',models:[{id:'synthetic-codex',label:'Synthetic Codex',efforts:['low','medium','high']}],capabilities:{execute:true,resume:true,cancel:true,approvals:true},refreshedAt:''}]};
const savedRoute={runtimeId:'claude-native',model:'opus-5.5',effort:'high'};
function Composer({mode,open,route}){const label=mode==='navigator'?navigatorRouteLabel(routeState,route):undefined;return <div className="composer-anchor" style={{width:620,margin:'250px 24px 24px'}}>
 {open==='route'&&<NavigatorRoutePopover state={routeState} policy="cli-first" route={route} onChange={value=>window.fixture.routes.push(value)}/>}
 {open===true&&<ModeMenu mode={mode} onPick={()=>{}} route={label} onChooseRoute={()=>{}} onChangeFolder={()=>{}}/>}
 <div className="conversation-composer"><textarea rows={2} placeholder="Message PugPort"/>
 <div className="composer-bottom"><div className="composer-controls"><button type="button" className="composer-plus" aria-label="添加和更多"><Plus size={17}/></button>
 <ModeChip mode={mode} open={open===true} onToggle={()=>{}} onClear={()=>{}} detail={label}/></div>
 <div className="composer-submit-actions"><button type="button" className="send-button" aria-label="发送"><ArrowUp size={16}/></button></div></div></div></div>;}
function Fixture(){const[scene,setScene]=useState('menu');window.fixture.scene=setScene;
 if(scene==='debug')return <Debug/>;
 if(scene==='menu')return <Composer open={true}/>;
 if(scene==='navigator')return <Composer mode="navigator" open={false} route={savedRoute}/>;
 if(scene==='navigator-menu')return <Composer mode="navigator" open={true}/>;
 if(scene==='normal')return <Composer open={false}/>;
 if(scene==='mods-menu')return <Composer mode="mods-author" open={true}/>;
 if(scene==='navigator-route')return <Composer mode="navigator" open="route" route={savedRoute}/>;
 if(scene==='approval')return <div style={{width:620,padding:24}}><ModApprovalCard request={{modeId:entry.id,version:'3.0.1',title:entry.title,permissions:['model:run'],requestedAt:''}} onAnswer={async()=>{}}/></div>;
 return <><StorePage api={api} notify={()=>{}} onOpenMod={()=>{}} onOpenConversation={c=>{window.fixture.opened.push(c.id)}}/><ConfirmDialogHost/></>;}
localStorage.setItem('comborunner.locale','en');
startInterfaceLanguage().then(()=>createRoot(document.getElementById('root')).render(<Fixture/>));
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.webp': 'dataurl', '.svg': 'dataurl', '.woff2': 'file' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1120,height:720,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!/^(file|data):/.test(d.url)}));
 win.webContents.session.on('will-download',event=>event.preventDefault());
 await win.loadFile(path.join(__dirname,'index.html'));
 const evaluate=code=>win.webContents.executeJavaScript(code);
 const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const ready=async code=>{for(let i=0;i<80;i++){if(await evaluate(code))return;await frame();}assert.fail('Renderer condition did not settle: '+code);};
 const shot=async(name,selector,pad=16)=>{await evaluate('Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))');await frame();
  const r=await evaluate('(()=>{const b=[...document.querySelectorAll('+JSON.stringify(selector)+')].map(e=>e.getBoundingClientRect());const x=Math.min(...b.map(r=>r.left)),y=Math.min(...b.map(r=>r.top));return{x:Math.max(0,Math.floor(x-'+pad+')),y:Math.max(0,Math.floor(y-'+pad+')),width:Math.ceil(Math.max(...b.map(r=>r.right))-x+'+pad*2+'),height:Math.ceil(Math.max(...b.map(r=>r.bottom))-y+'+pad*2+')}})()');
  await fs.writeFile(path.join(${JSON.stringify(shots)},name+'.png'),(await win.webContents.capturePage(r)).toPNG());};
 const both=async(name,selector)=>{for(const theme of ['light','dark']){await evaluate('document.documentElement.dataset.theme='+JSON.stringify(theme)+';document.body.style.background=getComputedStyle(document.documentElement).getPropertyValue("--bg")||"";');await frame();await shot(name+'-'+theme,selector);}await evaluate('document.documentElement.dataset.theme="light"');};
 await ready('!!document.querySelector(".composer-mode-menu")');await evaluate('document.fonts.ready');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".composer-mode-menu [role=menuitemradio]")].map(e=>[e.querySelector("span").textContent,e.getAttribute("aria-checked")])'),[['Normal','true'],['Mods author','false'],['Navigator','false']]);
 assert.equal(await evaluate('document.querySelector(".composer-mode").title'),'Mode: Normal');
 assert.equal(await evaluate('document.querySelector(".composer-mode").textContent'),'','Normal shows only the icon');
 await both('chip-menu','.composer-mode-menu, .conversation-composer');
 await evaluate('window.fixture.scene("normal")');await ready('!document.querySelector(".composer-mode-menu")');
 assert.equal(await evaluate('document.querySelector(".composer-controls").textContent'),'','Normal adds nothing but the icon');
 await both('normal-chip','.conversation-composer');
 await evaluate('window.fixture.scene("mods-menu")');await ready('!!document.querySelector(".composer-mode-setting")');
 assert.equal(await evaluate('document.querySelector(".composer-mode-setting").textContent'),'Folder: PugPort data › mods-workspace · Change…');
 await both('mods-author-menu','.composer-mode-menu, .conversation-composer');
 await evaluate('window.fixture.scene("navigator")');await ready('!!document.querySelector(".composer-mode-tag")');
 assert.equal(await evaluate('document.querySelector(".composer-mode-tag .composer-mode-open").textContent'),'Navigator· Opus 5.5 · High');
 assert.equal(await evaluate('document.querySelector(".composer-mode-tag > button:last-child").getAttribute("aria-label")'),'Back to Normal');
 await both('navigator-chip','.conversation-composer');
 await evaluate('window.fixture.scene("navigator-menu")');await ready('!!document.querySelector(".composer-mode-setting")');
 assert.equal(await evaluate('document.querySelector(".composer-mode-setting").textContent'),'Runs on: Auto · Choose…');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".composer-mode-menu [role=menuitemradio]")].map(e=>e.getAttribute("aria-checked"))'),['false','false','true']);
 await both('navigator-menu','.composer-mode-menu, .conversation-composer');
 await evaluate('window.fixture.scene("navigator-route")');await ready('!!document.querySelector(".navigator-route-popover .effort-slider")');
 assert.match(await evaluate('document.querySelector(".navigator-route-popover").textContent'),/What the navigator runs on/);
 await both('navigator-route','.navigator-route-popover, .conversation-composer');
 await evaluate('window.fixture.scene("approval")');await ready('!!document.querySelector(".mod-approval-card")');
 assert.match(await evaluate('document.querySelector(".mod-approval-card").textContent'),/Allow .Reading notes. 3\\.0\\.1 to use these permissions\\?/);
 await both('mod-approval','.mod-approval-card');
 // The frame's load-time throw reaches the Debug strip through the shim, the bridge and the store.
 await evaluate('window.fixture.scene("debug")');await ready('document.querySelector(".mod-debug-count")?.textContent==="1"');
 await evaluate('document.querySelector(".mod-debug-toggle").click()');await ready('!!document.querySelector(".mod-debug-panel")');
 const panel=await evaluate('document.querySelector(".mod-debug-panel").textContent');
 assert.match(panel,/Reload frame/);assert.match(panel,/Errors 1 · Logs 1/);assert.match(panel,/TypeError: timer is undefined/);
 for(const text of ['Permissions: data:store (no approval)','Manifest valid · 1 warning','Send to chat','Everything here also reaches the next turn automatically.'])assert.ok(panel.includes(text),text);
 await both('debug-strip','.mod-workspace-bar, .mod-debug-panel');
 await evaluate('document.querySelector(".mod-debug-send").click()');await frame();
 const draft=(await evaluate('window.fixture.drafts[0]')).split(String.fromCharCode(10));
 assert.equal(draft[0],'Mod debug · Pomodoro 0.1.3');
 assert.ok(draft.some(l=>l.includes('log    starting timer'))&&draft.some(l=>l.includes('error  ')&&l.includes('TypeError: timer is undefined')),draft.join(' | '));
 await evaluate('window.fixture.scene("store")');await ready('!!document.querySelector(".store-tabs [role=tab]")');
 assert.equal(await evaluate('document.querySelector(".store-toolbar .button.primary").textContent.trim()'),'Create a Mod');
 await evaluate('document.querySelectorAll(".store-tabs [role=tab]")[1].click()');await ready('!!document.querySelector(".store-local-build")');
 assert.equal(await evaluate('document.querySelector(".store-local-tag").textContent'),'Local build');
 assert.deepEqual(await evaluate('[...document.querySelectorAll(".store-local-actions button")].map(b=>b.textContent.trim())'),['Edit in chat','Open folder','Export JSON']);
 assert.match(await evaluate('document.querySelector(".store-local-build small").textContent'),/example\\.reading-notes · 3\\.0\\.0 · built in chat .Reading notes Mod./);
 await ready('[...document.querySelectorAll(".store-cover-button img")].every(i=>i.complete&&i.naturalWidth>0)');
 await both('store-local-build','.store-toolbar, .store-mode-card');
 await evaluate('document.querySelector(".store-local-actions button").click()');await ready('window.fixture.opened.length===1');
 await evaluate('document.querySelector(".store-toolbar .button.primary").click()');await ready('window.fixture.opened.length===2');
 assert.deepEqual(await evaluate('window.fixture.calls.filter(c=>c.path.startsWith("/api/mod-workspaces")||c.path.startsWith("/api/conversations")).map(c=>[c.method,c.path,c.body])'),[
  ['POST','/api/mod-workspaces/a1b2c3d4e5/edit',{}],
  ['POST','/api/conversations',{title:'新 Mod'}],
  ['PATCH','/api/conversations/00000000-0000-4000-8000-000000000002',{workMode:'mods-author'}],
 ]);
 console.log('PASS work modes renderer');app.exit(0);
}catch(error){console.error(error);app.exit(1);}finally{win?.destroy();}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timeout = setTimeout(() => child.kill(), 75000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS work modes renderer/);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    assert.equal(dirname(resolve(fixture)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
