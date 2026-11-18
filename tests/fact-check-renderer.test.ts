import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactCheck } from '../src/ui/ClaimsCheck.tsx';
import { electronArgs } from './helpers/electron-app.cjs';

test('fact check folds counts and source details, rejects active URL schemes, and only labels completed corrections', () => {
  const claims = [
    { claim: 'A', status: 'verified' as const, source: 'https://example.test/primary' },
    { claim: 'B', status: 'wrong' as const, correction: 'Correct B', source: 'javascript:alert(1)' },
    { claim: 'C', status: 'unverifiable' as const, reason: 'No primary record' },
  ];
  const pending = renderToStaticMarkup(createElement(FactCheck, { result: { status: 'completed', claims } }));
  assert.match(pending, /核验：已核实 1 条 · 无法核实 1 条/);
  assert.match(pending, /有误 1 条/);
  assert.doesNotMatch(pending, /已更正|<details[^>]*\bopen|href="javascript:/);
  assert.match(pending, /href="https:\/\/example.test\/primary"/);
  assert.match(pending, /Correct B/);
  const corrected = renderToStaticMarkup(
    createElement(FactCheck, { result: { status: 'completed', claims, corrected: 1 } }),
  );
  assert.match(corrected, /已更正 1 条/);
  const failed = renderToStaticMarkup(
    createElement(FactCheck, { result: { status: 'incomplete', claims: [], reason: 'Synthetic timeout' } }),
  );
  assert.match(failed, /核验未完成/);
  assert.match(failed, /Synthetic timeout/);
});

test(
  'hidden renderer: bilingual verify menu, chip, final-answer disclosure, corrected and failed checks',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-fact-check-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-fact-check-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve(process.env.FACT_CHECK_ARTIFACTS ?? join(tmpdir(), 'pugport-fact-check-screenshots'));
    await mkdir(screenshots, { recursive: true });
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConversationWorkspace} from './src/ui/Workspace';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
import './src/ui/composer.css';
import './src/ui/ConversationQueue.css';
import './src/ui/SwarmWorkspace.css';
import './src/ui/ExternalAgents.css';
import './src/ui/SideChatPanel.css';
const locale=new URLSearchParams(location.search).get('locale')||'zh-CN';
localStorage.setItem('comborunner.locale',locale);
window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
window.fetch=()=>{throw Error('Unexpected network fetch');};
const stamp='2026-10-31T12:00:00Z';
const project={id:'project',name:'Fixture',scope:'chat',path:'C:/Fixture',createdAt:stamp,updatedAt:stamp};
const conversation={id:'main',projectId:'project',title:locale==='en'?'Industry fact check':'行业信息核验',createdAt:stamp,updatedAt:stamp};
const question=locale==='en'?'When does the synthetic standard take effect?':'这份合成行业标准何时生效？';
const answer=locale==='en'?'The synthetic standard takes effect on 1 January 2027. The published primary record confirms this date.':'这份合成行业标准于 2027 年 1 月 1 日生效。已发布的一手文件确认了这一日期。';
const claim=locale==='en'?'The standard takes effect on 1 January 2027.':'标准于 2027 年 1 月 1 日生效。';
const reports={
 verified:{status:'completed',claims:[{claim,status:'verified',source:'https://example.test/standard'}]},
 mixed:{status:'completed',claims:[{claim,status:'verified',source:'https://example.test/standard'},{claim:locale==='en'?'The standard applies to every industry.':'该标准适用于所有行业。',status:'unverifiable',reason:locale==='en'?'No primary source establishes the full scope.':'没有一手来源确认完整适用范围。'}]},
 corrected:{status:'completed',corrected:1,claims:[{claim:locale==='en'?'The standard takes effect on 1 January 2026.':'标准于 2026 年 1 月 1 日生效。',status:'wrong',correction:claim,source:'https://example.test/standard'}]},
 failed:{status:'incomplete',claims:[],reason:locale==='en'?'The independent checker timed out.':'独立核验超时。'}
};
const workflow={id:'task',conversationId:'main',projectId:'project',userMessageId:'question',finalMessageId:'answer',status:'completed',phase:'done',input:{content:question,mode:'chat',permissionMode:'read-only',review:true},plan:[],runIds:[],memoryRevision:0,memoryExcerpt:'',createdAt:stamp,updatedAt:stamp};
const state={app:{name:'PugPort',version:'test',platform:'win32',dataDir:'fixture'},settings:{toolApprovalMode:'auto',executionPolicy:'cli-first'},targets:[{id:'codex',provider:'codex',label:'Codex',command:'fixture',environment:'native',enabled:true},{id:'claude',provider:'claude',label:'Claude',command:'fixture',environment:'native',enabled:true}],runtimes:[],approvals:[],plugins:[],refreshing:false,projects:[project],conversations:[conversation],workflows:[],runs:[],conversationMessages:[]};
const root=createRoot(document.getElementById('root'));
const api=async(path,body,method)=>path==='/api/external-agents'?{agents:[]}:path==='/api/devices'?{devices:[]}:method==='GET'?{messages:state.conversationMessages}:{};
window.renderFixture=(kind='menu')=>{
 state.workflows=kind==='menu'?[]:[{...workflow,review:{status:kind==='failed'?'stopped':'passed',round:0,factCheck:reports[kind]}}];
 state.conversationMessages=kind==='menu'?[]:[{id:'question',conversationId:'main',workflowId:'task',role:'user',content:question,createdAt:stamp},{id:'answer',conversationId:'main',workflowId:'task',role:'assistant',content:answer,createdAt:'2026-10-31T12:00:01Z'}];
 flushSync(()=>root.render(<main className="workspace-main" style={{height:'100vh'}}><ConversationWorkspace state={{...state}} api={api} project={project} conversation={conversation} notify={()=>{}} onConversation={()=>{}} onAddProject={()=>{}} onMemory={()=>{}} onInspect={()=>{}} /></main>));
};
void startInterfaceLanguage().then(()=>window.renderFixture());`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
let win;const network=[];
const evaluate=source=>win.webContents.executeJavaScript(source);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const wait=async(expression)=>{for(let n=0;n<250;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+expression);};
const text=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent.trim()');
const click=async(selector)=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
void app.whenReady().then(async()=>{try{
 win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
 for(const locale of ['zh-CN','en']){
  const english=locale==='en',mode=english?'Verify mode':'核验模式';
  await win.loadFile(path.join(__dirname,'index.html'),{query:{locale}});
  await wait('!!document.querySelector("#conversation-input") && document.documentElement.lang==='+JSON.stringify(english?'en':'zh-Hans'));
  await click('.composer-plus');
  await wait('!!document.querySelector(".composer-menu")');
  const menu=await text('.composer-menu');assert.ok(menu.includes(mode),menu);
  assert.ok(menu.includes(english?'Another vendor double-checks the result and any web facts':'由另一家厂商复核结果和网络事实'),menu);
  await shot(locale+'-composer-menu');
  await evaluate('[...document.querySelectorAll(".composer-menu [role=menuitemcheckbox]")].find(node=>node.textContent.includes('+JSON.stringify(mode)+')).click()');await frame();
  const close=english?'Turn off verify mode':'关闭核验模式';
  await wait('!!document.querySelector('+JSON.stringify('[aria-label="'+close+'"]')+')');
  assert.ok((await text('.composer-tag')).includes(mode));
  await shot(locale+'-composer-chip');
  await click('[aria-label="'+close+'"]');
  assert.equal(await evaluate('!!document.querySelector('+JSON.stringify('[aria-label="'+close+'"]')+')'),false);
  for(const kind of ['verified','mixed','corrected','failed']){
   await evaluate('window.renderFixture('+JSON.stringify(kind)+')');await frame();
   await wait('!!document.querySelector(".fact-check")');
   await evaluate('document.querySelector(".fact-check").open=false');await frame();
   assert.equal(await evaluate('document.querySelectorAll(".fact-check").length'),1);
   assert.equal(await evaluate('document.querySelectorAll(".review-label").length'),0);
   assert.equal(await evaluate('document.querySelector(".fact-check").previousElementSibling.classList.contains("message-assistant")'),true);
   const summary=await text('.fact-check > summary');
   if(kind==='verified')assert.equal(summary,english?'Verification: 1 verified · 0 unverifiable':'核验：已核实 1 条 · 无法核实 0 条');
   if(kind==='mixed')assert.equal(summary,english?'Verification: 1 verified · 1 unverifiable':'核验：已核实 1 条 · 无法核实 1 条');
   if(kind==='corrected')assert.ok(summary.includes(english?'1 corrected':'已更正 1 条'),summary);
   if(kind==='failed')assert.equal(summary,english?'Verification incomplete':'核验未完成');
   if(kind==='mixed'||kind==='corrected'||kind==='failed')await shot(locale+'-'+kind+'-folded');
   await click('.fact-check > summary');
   assert.equal(await evaluate('document.querySelector(".fact-check").open'),true);
   if(kind==='mixed'||kind==='corrected')assert.equal(await evaluate('document.querySelector(".fact-check a").href'),'https://example.test/standard');
   if(kind==='failed')assert.ok((await text('.fact-check')).includes(english?'The independent checker timed out.':'独立核验超时。'));
   if(kind==='mixed'||kind==='corrected'||kind==='failed')await shot(locale+'-'+kind+'-unfolded');
  }
  assert.deepEqual(await evaluate('window.errors'),[]);
 }
 assert.deepEqual(network,[]);console.log('PASS bilingual fact check');app.exit(0);
}catch(error){console.error(error);if(win)console.error(await evaluate('document.body.textContent').catch(()=>''));app.exit(1);}});
`.replaceAll('SCREENSHOTS', JSON.stringify(screenshots)),
    );
    const env: NodeJS.ProcessEnv = { PUGPORT_UNDER_TEST: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      { env, windowsHide: true, timeout: 75000, maxBuffer: 1024 * 1024 },
    );
    assert.match(result.stdout, /PASS bilingual fact check/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
