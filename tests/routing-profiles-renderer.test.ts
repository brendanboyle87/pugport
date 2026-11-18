import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'named routing profiles work in real settings and composer without network or model calls',
  { timeout: 60000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-routing-profiles-')));
    const artifacts = resolve(process.env.ROUTING_FLOW_ARTIFACTS ?? 'artifacts/routing-profiles');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-routing-profiles-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>*,*::before,*::after{transition:none!important;animation:none!important}html,body,#root{height:100%;margin:0}.fixture{height:100%;display:flex;flex-direction:column}.fixture>nav{display:flex;gap:8px;padding:8px;border-bottom:1px solid var(--line)}.fixture-body{flex:1;min-height:0;overflow:auto}.fixture-body>.conversation-workspace{height:100%}.settings-form{max-width:820px;margin:0 auto;padding:20px}</style><body><main id="root"></main><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';import './src/ui/studio.css';
import './src/ui/settings.css';import './src/ui/ConversationPanel.css';import './src/ui/composer.css';
import{SettingsPage}from'./src/ui/App';import{ConversationWorkspace}from'./src/ui/Workspace';import{ConfirmDialogHost}from'./src/ui/ConfirmDialog';
import{MemoryEditor}from'./src/ui/Workspace';import{uiUpdateBlocked}from'./src/ui/ui-update-guard';window.updateBlocked=uiUpdateBlocked;
import{routingProfileSchema}from'./src/shared/routing-profiles';
import{parseRoutingRules}from'./src/shared/routing-parser';import{routingCardsOf}from'./src/ui/ConversationPanel';
import{applyInterfaceLocale}from'./src/ui/i18n';window.switchLocale=applyInterfaceLocale;
const stamp='2026-10-25T12:00:00Z';
const project={id:'project',name:'合成项目',path:'C:/Synthetic',scope:'project',createdAt:stamp,updatedAt:stamp};
const conversation={id:'chat',projectId:'project',title:'合成对话',createdAt:stamp,updatedAt:stamp};
const targets=[{id:'claude',provider:'claude',label:'Claude · 本机',enabled:true,environment:'native',command:'fixture'},{id:'codex',provider:'codex',label:'Codex',enabled:true,environment:'native',command:'fixture'},{id:'api-deepseek',provider:'pi',label:'DeepSeek API',enabled:true,gateway:'api',apiProvider:'deepseek',environment:'native',command:'fixture'},{id:'missing-gemini',provider:'gemini',label:'Gemini · 未连接',enabled:true,environment:'native',command:'fixture'}];
const runtimes=targets.map(target=>({...target,installed:target.id!=='missing-gemini',status:target.id==='missing-gemini'?'missing':'ready',models:target.id==='codex'?[{id:'gpt-6-astra',label:'gpt-6-astra',efforts:['low','high']},{id:'gpt-6-sol',label:'gpt-6-sol',efforts:['low','high']}]:[{id:target.id==='claude'?'claude-opus-5-5':'deepseek-chat',label:target.id==='claude'?'Opus 5.5':'DeepSeek',efforts:['low','high']}],quota:{status:'unknown',source:'fixture',observedAt:null,windows:[]},capabilities:{execute:true,resume:true,cancel:true,approvals:true},refreshedAt:stamp}));
const state={app:{name:'PugPort',version:'fixture',platform:'win32'},settings:{routingProfiles:[],routePreferencesEnabled:false,designProvider:'claude',architectureProvider:'claude',routineProvider:'claude',routePolicy:{mature:[]},toolApprovalMode:'auto',reservePercent:10,unknownQuotaPolicy:'manual-only',preferCli:true,refreshSeconds:60,maxQuotaAgeSeconds:120,maxConcurrentRuns:1},projects:[project],conversations:[conversation],conversationMessages:[],workflows:[],runs:[],runtimes,targets,approvals:[],plugins:[]};
let redraw;const f=window.fixture={state,calls:[],lastNotice:null,profile(){return state.settings.routingProfiles[0];}};
const api=async(path,body,method='POST')=>{f.calls.push({path,body,method});
 if(path==='/api/routing-profiles/compile'){if(f.compileMode==='failure')throw Error('Synthetic timeout');const draft=body.text.includes('Opus5.5')?{version:2,text:body.text,rules:[],unparsed:[],chapterAgents:false,mask:false,roles:{coordinator:{provider:'claude',model:'claude-opus-5-5',effort:'high'},verifier:[{provider:'codex',model:'gpt-6-astra'},{provider:'codex',model:'gpt-6-sol'}]}}:parseRoutingRules(body.text,routingCardsOf(state),body.categories);if(f.compileMode==='deferred')return new Promise(resolve=>f.resolveCompile=()=>resolve({draft,fallback:false}));return{draft,fallback:false};}
 if(path==='/api/projects/project/memory')return{content:'',revision:1};
 if(path==='/api/projects/project/local-memory')return{exportEnabled:true,cliEnabled:false,files:[],warnings:[]};
 if(path==='/api/laya/status')return{settings:{mode:'cloud'},status:{state:'disabled',region:'global'},training:{directory:'C:/Synthetic',recording:false}};
 if(path==='/api/extensions')return{items:[]};
 if(path==='/api/github')return{enabled:false,state:'off'};
 if(path==='/api/routing-profiles'&&method==='GET')return{profiles:structuredClone(state.settings.routingProfiles)};
 if(path==='/api/projects/project/routing-profile'){if(method!=='PATCH')throw Error('Expected project PATCH');if(body.profileId)project.routingProfileId=body.profileId;else delete project.routingProfileId;redraw();return structuredClone(project);}
 if(path.startsWith('/api/routing-profiles/')){const id=path.split('/').at(-1);if(method==='PUT'){const parsed=routingProfileSchema.parse({id,...body});state.settings={...state.settings,routingProfiles:[...state.settings.routingProfiles.filter(p=>p.id!==id),parsed]};}else if(method==='DELETE'){if(conversation.routingProfileId===id)throw Error('此方案仍在使用');state.settings={...state.settings,routingProfiles:state.settings.routingProfiles.filter(p=>p.id!==id)};}else throw Error('Unexpected profile method');redraw();return{profiles:structuredClone(state.settings.routingProfiles)};}
 if(path==='/api/conversations/chat/routing-profile'){if(method!=='PATCH')throw Error('Expected PATCH');if(body.inheritProject)delete conversation.routingProfileId;else conversation.routingProfileId=body.profileId;redraw();return structuredClone(conversation);}
 if(path==='/api/settings'){state.settings={...state.settings,...body};redraw();return state.settings;}
 if(method==='GET'&&path.startsWith('/api/conversations/'))return{conversation:structuredClone(conversation),messages:[],workflows:[],runs:[],binding:null,pending:null,installed:false,manifest:null,instance:null};
 throw Error('Unexpected synthetic API '+method+' '+path);
};
localStorage.setItem('comborunner.locale','zh-CN');
function Fixture(){const[view,setView]=useState('routing');const[,tick]=useState(0);redraw=()=>tick(n=>n+1);return <div className="fixture"><nav>{['routing','advanced','chat','project'].map(id=><button key={id} data-view={id} onClick={()=>setView(id)}>{id==='routing'?'智能路由':id==='advanced'?'高级设置':id==='project'?'项目设置':'合成对话'}</button>)}</nav><div className="fixture-body">{view==='project'?<MemoryEditor project={project} api={api} notify={notice=>f.lastNotice=notice}/>:view==='chat'?<ConversationWorkspace state={state} conversation={conversation} project={project} api={api} reload={async()=>redraw()} notify={notice=>f.lastNotice=notice} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}}/>:<SettingsPage state={state} category={view} api={api} reload={async()=>redraw()} notify={notice=>f.lastNotice=notice}/>}</div><ConfirmDialogHost/></div>;}createRoot(document.getElementById('root')).render(<Fixture/>);
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.png': 'dataurl', '.woff2': 'file' },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{win=new BrowserWindow({show:false,width:1120,height:1400,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const allowed=d.url.startsWith('file://')||d.url.startsWith('data:');if(!allowed)remote++;cb({cancel:!allowed});});
await win.loadFile(path.join(__dirname,'index.html'));const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error('Renderer step: '+code,{cause:error});}};const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const click=async selector=>{await read('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};const button=async label=>{await read('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');await frame();};
const type=async(selector,value)=>{await read('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');const type=el.tagName==="TEXTAREA"?HTMLTextAreaElement:HTMLInputElement;Object.getOwnPropertyDescriptor(type.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};
const shot=async name=>{await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
for(let n=0;n<30;n++){await frame();if(await read('!!document.querySelector("[aria-label=自定义路由方案]")'))break;}await read('document.fonts.ready');
assert.equal(await read('[...document.querySelectorAll("details")].every(d=>!d.open)'),true);assert.equal(await read('document.body.textContent.includes("路由偏好")'),false);
await button('新建路由方案');
await read('document.querySelector("[aria-label=编辑路由方案]").scrollIntoView({block:"start"})');await shot('routing-flow-empty-zh');
await read('window.switchLocale("en")');await frame();await shot('routing-flow-empty-en');await read('window.switchLocale("zh-CN")');await frame();
assert.equal(await read('window.updateBlocked()'),true);await type('[aria-label="路由方案名称"]','日常快答');await type('[aria-label="路由规则原话"]','其余内容优先 Claude');await button('重新解析');
await read('document.querySelector("[aria-label=规则候选的选择方式]").closest("details").open=true');await read('(()=>{const select=document.querySelector("[aria-label=规则候选的选择方式]");select.value="quota";select.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame();await type('[aria-label="自动选择时排除这些模型"]','*-tiny, blocked-model');await shot('profile-advanced-light');await button('保存并启用');
assert.equal(await read('window.fixture.profile().rules.selection'),'quota');assert.deepEqual(await read('window.fixture.profile().rules.excludeModels'),['*-tiny','blocked-model']);assert.equal(await read('window.updateBlocked()'),false);
assert.equal(await read('window.fixture.state.settings.routingProfiles.length'),1);assert.equal(await read('window.fixture.profile().name'),'日常快答');assert.equal(await read('window.fixture.profile().rules.rules[0].candidates[0].provider'),'claude');await shot('settings-light-collapsed');
await click('[data-view=advanced]');assert.equal(await read('document.querySelector("[aria-label=启用固定路由偏好]").checked'),false);assert.equal(await read('document.querySelector(".route-policy")'),null);await click('[aria-label=启用固定路由偏好]');
assert.equal(await read('document.querySelector("[aria-label=启用固定路由偏好]").checked'),true);assert.deepEqual(await read('[...document.querySelectorAll(".route-policy-row:first-child .route-policy-chips button")].filter(b=>!b.classList.contains("unavailable-runtime")).map(b=>b.textContent.trim().replace(/^\\d+/,""))'),['Claude','Codex','DeepSeek API']);assert.equal(await read('document.querySelector(".route-policy").textContent.includes("Gemini")'),false);await shot('advanced-connected-options');
await click('[data-view=project]');await frame();await click('.memory-advanced summary');await frame();const projectChoice=async value=>{await read('(()=>{const el=document.querySelector("[aria-label=项目默认路由方案]");el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame();};await projectChoice(await read('window.fixture.profile().id'));assert.equal(await read('window.updateBlocked()'),true);await button('保存记忆与设置');assert.equal(await read('window.fixture.state.projects[0].routingProfileId'),await read('window.fixture.profile().id'));assert.equal(await read('window.fixture.state.conversations[0].routingProfileId'),undefined);await shot('project-default-light');
await click('[data-view=chat]');assert.match(await read('document.querySelector("[aria-label=调度选项]").textContent'),/项目默认 · 日常快答/);await type('#conversation-input','保留这条未发送的问题');await click('[aria-label=调度选项]');await read('document.querySelector("select[aria-label=任务执行器]").closest(".chip-select").querySelector("button").click()');await frame();await button('日常快答');
assert.equal(await read('window.fixture.state.conversations[0].routingProfileId'),await read('window.fixture.profile().id'));assert.equal(await read('document.querySelector("#conversation-input").value'),'保留这条未发送的问题');assert.equal(await read('document.querySelector("[aria-label=调度选项]").textContent.trim()'),'日常快答');assert.equal(await read('document.querySelector("select[aria-label=任务模型]")'),null);
await read('document.documentElement.dataset.theme="dark"');win.setSize(500,820);await frame();await shot('composer-profile-dark');assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);
await read('document.querySelector("select[aria-label=任务执行器]").closest(".chip-select").querySelector("button").click()');await frame();await button('自动（全局与对话规则）');assert.equal(await read('window.fixture.state.conversations[0].routingProfileId'),null);assert.equal(await read('document.querySelector("#conversation-input").value'),'保留这条未发送的问题');
await read('document.querySelector("select[aria-label=任务执行器]").closest(".chip-select").querySelector("button").click()');await frame();await button('项目默认（日常快答）');assert.equal(await read('window.fixture.state.conversations[0].routingProfileId'),undefined);assert.match(await read('document.querySelector("[aria-label=调度选项]").textContent'),/项目默认 · 日常快答/);await shot('composer-inherited-dark');
await read('document.querySelector("select[aria-label=任务执行器]").closest(".chip-select").querySelector("button").click()');await frame();await button('自动（全局与对话规则）');await click('[data-view=project]');await frame();await click('.memory-advanced summary');await frame();await projectChoice('');await button('保存记忆与设置');assert.equal(await read('window.fixture.state.projects[0].routingProfileId'),undefined);
win.setSize(1120,1400);await read('document.documentElement.dataset.theme="light"');await click('[data-view=routing]');await click('[aria-label="删除路由方案 日常快答"]');assert.equal(await read('window.fixture.state.settings.routingProfiles.length'),1);assert.equal(await read('document.querySelector("[role=alertdialog]").textContent.includes("先切回自动")'),true);await shot('delete-profile-confirm');await read('[...document.querySelectorAll("[role=alertdialog] button")].find(b=>b.textContent.trim()==="删除方案").click()');await frame();assert.equal(await read('window.fixture.state.settings.routingProfiles.length'),0);
await button('新建路由方案');await type('[aria-label="路由方案名称"]','领航模式');
const ownerText='直接使用Opus5.5作为开始，不需要判断，然后后面分配具体的任务给不同的模型和强度，codex astra或者sol进行核验';
await type('[aria-label="路由规则原话"]',ownerText);const writesBefore=await read('window.fixture.calls.filter(c=>c.method==="PUT").length');await read('new Promise(resolve=>setTimeout(resolve,900))');await frame();
assert.equal(await read('window.fixture.calls.filter(c=>c.method==="PUT").length'),writesBefore);assert.equal(await read('window.fixture.state.settings.routingProfiles.length'),0);
assert.equal(await read('document.querySelector("[aria-label=路由流程]").children.length'),3);assert.match(await read('document.querySelector("[aria-label=路由流程]").textContent'),/Opus 5.5/);assert.match(await read('document.querySelector("[aria-label=路由流程]").textContent'),/gpt-6-astra.*gpt-6-sol/);assert.equal(await read('document.querySelector(".target-advanced").open'),false);
await read('document.querySelector("[aria-label=编辑路由方案]").scrollIntoView({block:"start"})');await shot('routing-flow-zh');
win.setSize(390,1400);await frame();await read('document.querySelector("[aria-label=编辑路由方案]").scrollIntoView({block:"start"})');await shot('routing-flow-narrow-zh');assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);win.setSize(1120,1400);await frame();
await button('保存并启用');assert.equal(await read('window.fixture.profile().rules.roles.coordinator.model'),'claude-opus-5-5');assert.deepEqual(await read('window.fixture.profile().rules.roles.verifier.map(c=>c.model)'),['gpt-6-astra','gpt-6-sol']);
await button('编辑');await read('window.fixture.compileMode="deferred"');await type('[aria-label="路由规则原话"]','先用 Claude');await button('重新解析');await type('[aria-label="路由规则原话"]','其余内容优先 Codex');await read('window.fixture.resolveCompile()');await frame();assert.equal(await read('document.querySelector("textarea").value'),'其余内容优先 Codex');assert.match(await read('document.querySelector("[aria-label=路由流程]").textContent'),/Opus 5.5/);
await read('window.fixture.compileMode="failure"');await button('保存修改');assert.equal(await read('window.fixture.calls.filter(c=>c.method==="PUT").length'),writesBefore+1);assert.equal(await read('document.body.textContent.includes("模型暂时不可用，用的是本地解析")'),true);assert.equal(await read('window.fixture.profile().rules.text'),ownerText);
await read('window.fixture.compileMode="deferred"');await type('[aria-label="路由规则原话"]','先用 Claude');await button('重新解析');await button('取消编辑');await button('新建路由方案');await type('[aria-label="路由方案名称"]','保留新草稿');await type('[aria-label="路由规则原话"]',ownerText);await read('window.fixture.resolveCompile()');await frame();assert.equal(await read('document.querySelector("[aria-label=路由方案名称]").value'),'保留新草稿');assert.equal(await read('document.querySelector("textarea").value'),ownerText);
await read('window.fixture.compileMode="immediate"');await button('重新解析');await type('[aria-label="路由方案名称"]','领航模式');await read('window.switchLocale("en")');await frame();assert.equal(await read('document.querySelector("textarea").value'),ownerText);assert.match(await read('document.querySelector("[aria-label="+JSON.stringify("Routing flow")+"]").textContent'),/Starts with.*Sub-tasks.*Verify with/s);assert.equal(await read('document.querySelector(".target-advanced").open'),false);await read('document.querySelector("textarea").closest(".routing-tab").scrollIntoView({block:"start"})');await shot('routing-flow-en');
assert.deepEqual(await read('[...document.querySelectorAll(".routing-stage legend")].map(n=>n.textContent)'),['Starts with','Sub-tasks','Verify with']);
assert.equal(await read('document.querySelector("[aria-label="+JSON.stringify("Verify when done")+"]").checked'),true);
win.setSize(390,1400);await frame();await read('document.querySelector("textarea").closest(".routing-tab").scrollIntoView({block:"start"})');await shot('routing-flow-narrow-en');assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);

assert.equal(await read('window.fixture.calls.some(c=>c.path.endsWith("/messages"))'),false);assert.equal(remote,0);console.log('PASS routing profiles renderer: model draft preview and explicit save, local fallback, stale and unmounted reply guards, verifier persistence, Chinese and English flow, connected-only choices, defaults off, composer profile and automatic, draft preservation, collapsed settings, confirmation, zero model/network calls');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    const timeout = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS routing profiles renderer/);
    } finally {
      clearTimeout(timeout);
    }
  },
);
