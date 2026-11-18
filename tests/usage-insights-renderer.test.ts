import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import electron from 'electron';
import { buildRenderer } from './helpers/renderer-build.ts';
import { electronArgs } from './helpers/electron-app.cjs';
import { buildSpendOverview, buildSpendDetails } from '../src/server/spend-ledger.ts';
import { spendFixture } from './helpers/spend-fixture.ts';

test(
  'Spend ledger: hidden light/dark screenshots, filters, paging and trace actions',
  { timeout: 180000 },
  async () => {
    const output = resolve('.design/context-insight/impl-spend');
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(join(process.env.TEMP ?? output, 'spend-renderer-'));
    await buildRenderer({
      absWorkingDir: process.cwd(),
      entryPoints: [resolve('tests/helpers/spend-renderer.tsx')],
      bundle: true,
      outfile: join(directory, 'fixture.js'),
      platform: 'browser',
      format: 'iife',
      loader: { '.woff2': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' },
      define: {
        __PUGPORT_UI_BUILD_ID__: JSON.stringify('fixture'),
        __PUGPORT_UI_COMPATIBILITY__: JSON.stringify('fixture'),
      },
    });
    const source = {
      ...spendFixture(),
      ledger: {
        quotaPace: (id: string) => (id === 'executor-0' ? 9 : id === 'executor-1' ? 6 : 16),
        extraUsd: () => 0,
        firstPeriodAt: () => Date.parse('2026-10-08T00:00:00Z'),
      },
    };
    const fixtures: Record<string, unknown> = {};
    for (const range of ['24h', '7d', '30d', 'all'] as const)
      for (const billing of ['all', 'usage', 'subscription'] as const)
        fixtures[`${range}-${billing}`] = buildSpendOverview(source, { range, billing });
    for (const group of ['task', 'project', 'run'] as const)
      fixtures[`details-${group}`] = buildSpendDetails(source, { group, range: '7d', limit: 20 });
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:auto;min-height:100%;margin:0;overflow:visible}body{background:var(--bg);padding:24px 32px 40px 252px;box-sizing:border-box}aside{position:fixed;inset:0 auto 0 0;width:220px;background:var(--surface-1);border-right:1px solid var(--border);padding:24px 20px;box-sizing:border-box;color:var(--text)}aside p{margin-top:30px;font-size:13px}*{animation:none!important;transition:none!important}</style></head><body><aside><b>PugPort</b><p>New task</p><p>Needs you</p><p>Routines</p><p><b>Usage &amp; connections</b></p><p>Settings</p></aside><div id="root"></div><script>window.spendFixtures=${JSON.stringify(fixtures).replaceAll('<', '\\u003c')}</script><script src="fixture.js"></script></body></html>`,
    );
    await writeFile(
      join(directory, 'runner.cjs'),
      String.raw`
const assert=require('node:assert/strict'), fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'session'));app.setPath('logs',path.join(__dirname,'logs'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 const remote=[];win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((d,done)=>{const cancel=!d.url.startsWith('file://')&&!d.url.startsWith('data:');if(cancel)remote.push(d.url);done({cancel});});
 const read=code=>win.webContents.executeJavaScript(code);const frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const wait=async code=>{for(let i=0;i<180;i++){if(await read(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('Not ready: '+code);};
 for(const theme of ['light','dark']){
  win.setSize(1440,1000);await win.loadFile(path.join(__dirname,'index.html'),{query:{locale:'en'}});
  await wait('window.ready && document.body.innerText.includes("Ledger by account")');
  await read('document.documentElement.dataset.theme='+JSON.stringify(theme));await read('document.fonts.ready');await frame();
  for(const label of ['What runs out first','Where it went','Costliest tasks','Health & details'])assert.ok(await read('document.body.innerText.includes('+JSON.stringify(label)+')'),label);
  assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true,'no horizontal page overflow');
  const height=await read('Math.ceil(document.documentElement.scrollHeight)');win.setSize(1440,height);await frame();await new Promise(r=>setTimeout(r,350));
  const shot=await win.webContents.capturePage({x:0,y:0,width:1440,height},{stayHidden:true});await fs.writeFile(path.join(OUTPUT,'spend-'+theme+'.png'),shot.toPNG());
  assert.deepEqual(await read('window.errors'),[]);
 }
 const clickText=async(text)=>{assert.ok(await read('(()=>{const b=[...document.querySelectorAll("button")].find(n=>n.textContent.trim()==='+JSON.stringify(text)+');if(!b)return false;b.click();return true})()'),'button '+text);await frame();};
 await clickText('24h');await wait('window.calls.at(-1).includes("range=24h")');
 await clickText('Pay per use');await wait('window.calls.some(p=>p.includes("billing=usage"))');
 const trace=await read('(()=>{const b=[...document.querySelectorAll("button")].find(n=>n.textContent.includes("Open trace"));if(!b)return false;b.click();return true})()');assert.ok(trace);assert.ok(await read('window.opened.length>0'));
 await read('document.querySelector(".spend-cell[tabindex=\\"0\\"]").focus()');
 await read('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');await frame();
 assert.ok(await read('document.querySelector(".spend-tooltip").textContent.includes("runs")'),'keyboard focus exposes daily values');
 await read('document.activeElement.click()');await wait('window.calls.some(p=>p.includes("/details?")&&p.includes("day=")&&p.includes("account="))');
 assert.ok(await read('document.querySelector(".spend-health details[open]")'),'day drilldown expands details');
 await read('[...document.querySelectorAll("summary")].find(n=>n.textContent.includes("Tokens and cache")).click()');await frame();
 assert.ok(await read('!!document.querySelector("[aria-labelledby=tokens-title] svg")'),'health charts retained');
 assert.deepEqual(remote,[]);assert.equal(win.isVisible(),false);assert.deepEqual(await read('window.errors'),[]);
 await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({passed:true,remote}));app.exit(0);
}catch(e){await fs.writeFile(path.join(__dirname,'result.json'),JSON.stringify({passed:false,error:String(e),body:win?await win.webContents.executeJavaScript('document.body.innerText.slice(0,7000)').catch(()=>''):''}));app.exit(1)}});
`.replaceAll('OUTPUT', JSON.stringify(output)),
    );
    const env: NodeJS.ProcessEnv = { PUGPORT_UNDER_TEST: '1', TEMP: directory, TMP: directory, TMPDIR: directory };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const args = electronArgs(join(directory, 'runner.cjs'));
    const result = await promisify(execFile)(
      process.platform === 'win32' ? 'conhost.exe' : (electron as unknown as string),
      process.platform === 'win32' ? ['--headless', electron as unknown as string, ...args] : args,
      { env, windowsHide: true, timeout: 150000, maxBuffer: 1024 * 1024 },
    );
    let receipt: { passed: boolean; error?: string; body?: string } | undefined;
    for (let i = 0; i < 600; i++) {
      try {
        receipt = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(receipt, 'hidden renderer produced a receipt: ' + result.stderr);
    assert.equal(receipt.passed, true, JSON.stringify(receipt));
  },
);
