import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'hidden sidebar: attention kinds, expansion, actions, protected text and empty state in both themes/languages',
  { timeout: 90000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-needs-you-ui-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-needs-you-ui-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const screenshots = resolve(process.env.NEEDS_YOU_SCREENSHOTS ?? join(directory, 'screenshots'));
    await mkdir(screenshots, { recursive: true });
    await mkdir(join(directory, 'home'));
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {NeedsYou} from './src/ui/NeedsYou';
import {activityFilters} from './src/ui/sidebar-activity';
import {startInterfaceLanguage} from './src/ui/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import './src/ui/studio.css';
const query=new URLSearchParams(location.search);
localStorage.setItem('comborunner.locale',query.get('locale')||'zh-CN');
document.documentElement.dataset.theme=query.get('theme')||'dark';
window.fixture={calls:[],errors:[],selected:[],notices:[],ready:false};
const f=window.fixture;
window.addEventListener('error',event=>f.errors.push(event.message));
window.addEventListener('unhandledrejection',event=>f.errors.push(String(event.reason)));
window.fetch=()=>{throw Error('Unexpected real fetch');};
window.open=()=>{throw Error('Unexpected external window');};
const stamp='2026-10-31T12:00:00Z';
const titles=['Release review','Repository access','Migration plan','Regression check','Additional task','Old task'];
const conversations=titles.map((title,i)=>({id:'chat-'+i,title,projectId:'project',createdAt:stamp,updatedAt:stamp}));
const workflows=['completed','waiting-approval','waiting-confirmation','failed','blocked','interrupted'].map((status,i)=>({id:'flow-'+i,conversationId:'chat-'+i,status,runIds:i===3?['last']:[],createdAt:'2026-10-'+(31-i)+'T12:00:00Z',...(i===0?{userQuestion:{text:'Which release branch should I use?',askedAt:stamp,options:[]}}:{})}));
const runs=[{id:'last',taskOutcome:{status:'failed',source:'executor-tool',summary:'Fixture directory is missing.'}}];
let visible=workflows.slice(0,4);
const root=createRoot(document.getElementById('root'));
const api=async(path,body,method)=>{f.calls.push({path,body,method});if(f.fail)throw Error('Synthetic action failure');if(path.endsWith('/dismiss-attention')){visible=visible.map(item=>path.includes(item.id)?{...item,attentionDismissedAt:stamp}:item);window.renderFixture();}};
window.renderFixture=()=>flushSync(()=>root.render(<aside className="studio-sidebar">
<div className="sidebar-brand-row"><div className="studio-brand">PugPort</div></div>
<div className="sidebar-activity-bar"><div className="sidebar-activity-filter sidebar-filters" role="group" aria-label="对话活动筛选">{activityFilters.map(([key,label])=><button key={key} aria-pressed={key==='all'}>{label}</button>)}</div></div>
<div className="sidebar-conversations"><NeedsYou now={Date.parse(stamp)} conversations={conversations} workflows={visible} runs={runs} api={api} notify={notice=>f.notices.push(notice)} onSelect={(chat,flow)=>f.selected.push([chat.id,flow.id])}/><div className="general-conversations pinned-conversations"><div className="project-heading"><span>已置顶</span></div><button className="conversation-link"><span>Project notes</span></button></div><div className="project-heading"><span>项目列表</span></div><button className="conversation-link"><span>Release workspace</span></button></div>
</aside>));
window.showFixture=mode=>{visible=mode==='empty'?[]:mode==='many'?workflows:workflows.slice(0,4);window.renderFixture();};
window.protectFixture=()=>{conversations[0].title='设置';workflows[0].userQuestion.text='继续';runs[0].taskOutcome.summary='停止';window.renderFixture();};
void startInterfaceLanguage().then(()=>{window.renderFixture();f.ready=true;});`,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
      outfile: join(directory, 'fixture.js'),
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}#root{height:100vh;display:flex}.studio-sidebar{height:100%;width:248px;flex-basis:248px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>',
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
const wait=async(expression)=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+expression);};
const click=async(selector)=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
const shot=async(name)=>{await evaluate('document.fonts.ready');await frame();await new Promise(resolve=>setTimeout(resolve,200));await fs.writeFile(path.join(SCREENSHOTS,name+'.png'),(await win.webContents.capturePage({x:0,y:0,width:248,height:560})).toPNG());};
void app.whenReady().then(async()=>{
try{
win=new BrowserWindow({show:false,width:1280,height:560,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=/^(file:|data:)/.test(details.url);if(!allowed)network.push(details.url);callback({cancel:!allowed});});
win.webContents.setWindowOpenHandler(()=>{network.push('window.open');return {action:'deny'};});
for(const locale of ['zh-CN','en'])for(const theme of ['light','dark']){
await win.loadFile(path.join(__dirname,'index.html'),{query:{locale,theme}});await wait('window.fixture?.ready===true');await frame();
assert.equal(win.isVisible(),false);
assert.equal(await evaluate('document.querySelectorAll(".needs-you-row").length'),4);
assert.equal(await evaluate('document.querySelector(".sidebar-conversations").firstElementChild.className'),'needs-you');
assert.equal(await evaluate('document.querySelectorAll(".sidebar-activity-filter button").length'),3);
assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
assert.equal(await evaluate('document.querySelector(".needs-you-warning").getBoundingClientRect().width'),14);
await evaluate('('+(() => {
        const row = document.querySelector('.needs-you-link'),
          pinned = document.querySelector('.pinned-conversations .conversation-link');
        const title = document.querySelector('.needs-you-title'),
          reason = document.querySelector('.needs-you-reason');
        const rows = [...document.querySelectorAll('.needs-you-row')];
        const style = (element) => getComputedStyle(element),
          rect = (element) => element.getBoundingClientRect();
        const check = (condition, message) => {
          if (!condition) throw Error(message);
        };
        check(
          rect(document.querySelector('.needs-you .project-heading > span')).x ===
            rect(document.querySelector('.pinned-conversations .project-heading > span')).x,
          'Heading alignment',
        );
        check(document.querySelector('.needs-you .nav-count').textContent === '4', 'Count badge');
        check(rect(row).x === rect(pinned).x && rect(row).width === rect(pinned).width, 'Row edges');
        check(style(row).borderRadius === style(pinned).borderRadius, 'Row hover shape');
        check(
          style(row).padding === '6px 10px' && style(row).display === 'grid' && style(row).columnGap === '8px',
          'Row padding and grid',
        );
        check(rect(title).x - rect(row.querySelector('svg')).right === 8, 'Icon column gap');
        check(
          Math.abs(rect(row.querySelector('svg')).y + 7 - (rect(title).y + rect(title).height / 2)) < 1,
          'Icon aligned to title',
        );
        check(
          style(title).fontSize === '13px' && style(title).fontWeight === style(pinned).fontWeight,
          'Title typography',
        );
        check(
          style(reason).fontSize === '12px' &&
            style(reason).lineHeight === '16.2px' &&
            style(reason).marginTop === '2px',
          'Reason typography',
        );
        for (const text of [title, reason])
          check(
            style(text).textOverflow === 'ellipsis' &&
              style(text).whiteSpace === 'nowrap' &&
              style(text).overflow === 'hidden',
            'Single-line ellipsis',
          );
        for (let i = 1; i < rows.length; i++)
          check(Math.abs(rect(rows[i]).y - rect(rows[i - 1]).bottom - 2) < 0.1, 'Row spacing');
        check(
          Math.abs(
            rect(document.querySelector('.pinned-conversations .project-heading')).y - rect(rows.at(-1)).bottom - 8,
          ) < 0.1,
          'Next heading spacing',
        );
        const probe = document.createElement('span');
        row.append(probe);
        const token = (name) => {
          probe.style.color = 'var(--' + name + ')';
          return style(probe).color;
        };
        check(style(title).color === token('text') && style(reason).color === token('faint'), 'Text colors');
        for (const icon of document.querySelectorAll('.needs-you-link > svg'))
          check(
            style(icon).color === token(icon.classList.contains('needs-you-warning') ? 'warning' : 'muted'),
            'Icon colors',
          );
        probe.remove();
      }).toString()+')()');
if(locale==='en'){
const body=await evaluate('document.body.innerText');
for(const label of ['Needs you','Waiting for your approval','Waiting for you to confirm the plan','Stopped'])assert.ok(body.includes(label),label);
assert.doesNotMatch(body,/[\u3400-\u9fff]/);
assert.equal(await evaluate('document.querySelector(".needs-you-actions button").title'),'Continue');
assert.equal(await evaluate('document.querySelector(".needs-you-actions button:last-child").title'),'Dismiss');
}
await shot(locale+'-'+theme+'-inbox');
await click('.needs-you-link');assert.deepEqual(await evaluate('window.fixture.selected'),[['chat-0','flow-0']]);
await click('.needs-you-actions button');assert.deepEqual(await evaluate('window.fixture.calls[0]'),{path:'/api/workflows/flow-3/continue',body:{uiLocale:locale},method:'POST'});
await click('.needs-you-actions button:last-child');assert.equal(await evaluate('document.querySelectorAll(".needs-you-row").length'),3);
await evaluate('window.showFixture("many")');await frame();assert.equal(await evaluate('document.querySelectorAll(".needs-you-row").length'),5);
assert.equal(await evaluate('document.querySelector(".needs-you-more").innerText'),locale==='en'?'1 more':'还有 1 项');
await click('.needs-you-more');assert.equal(await evaluate('document.querySelectorAll(".needs-you-row").length'),6);
await evaluate('window.fixture.fail=true');await click('.needs-you-actions button');assert.equal(await evaluate('window.fixture.notices.at(-1).message'),'Synthetic action failure');
if(locale==='en'){await evaluate('window.protectFixture()');await frame();assert.equal(await evaluate('document.querySelector(".needs-you-title").innerText'),'设置');assert.equal(await evaluate('document.querySelector(".needs-you-reason").innerText'),'继续');assert.ok((await evaluate('document.querySelectorAll(".needs-you-reason")[3].innerText')).includes('停止'));}
await evaluate('window.showFixture("empty")');await frame();assert.equal(await evaluate('document.querySelector(".needs-you")'),null);
await shot(locale+'-'+theme+'-empty');assert.deepEqual(await evaluate('window.fixture.errors'),[]);
}
assert.deepEqual(network,[]);console.log('PASS Needs you: hidden, eight screenshots, actions, expansion, translations, protected text, empty state');app.exit(0);
}catch(error){console.error(error);if(win)console.error(await evaluate('document.body.innerText').catch(()=>''));app.exit(1);}
});`.replace('SCREENSHOTS', JSON.stringify(screenshots)),
    );
    const env: NodeJS.ProcessEnv = {
      HOME: join(directory, 'home'),
      USERPROFILE: join(directory, 'home'),
      PUGPORT_UNDER_TEST: '1',
    };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY'])
      if (process.env[key]) env[key] = process.env[key];
    const result = await promisify(execFile)(
      electron as unknown as string,
      electronArgs(join(directory, 'runner.cjs')),
      { env, windowsHide: true, timeout: 75000, maxBuffer: 1024 * 1024 },
    );
    assert.match(result.stdout, /PASS Needs you/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
