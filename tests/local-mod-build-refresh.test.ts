import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'Local build fetches on mount, own mod_load completion and a slow interval only',
  { timeout: 45000 },
  async (t) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'pugport-local-mod-refresh-')));
    t.after(async () => {
      assert.equal(dirname(fixture).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(fixture).startsWith('pugport-local-mod-refresh-'));
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await writeFile(
      join(fixture, 'index.html'),
      '<!doctype html><div id="root"></div><script src="fixture.js"></script>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useLocalModBuild} from './src/ui/mods/use-mod-debug';
let conversation={id:'chat',modWorkspaceId:'workspace',modeBinding:{modeId:'mod',version:'1.0.0'},updatedAt:'0'};
let runs=[{id:'own',events:[]},{id:'other',events:[]}];const workflows=[{runIds:['own']}];
window.calls=[];window.timers=new Map();let timer=0;
window.setInterval=(callback,ms)=>{const id=++timer;window.timers.set(id,{callback,ms});return id};
window.clearInterval=id=>window.timers.delete(id);
const api=async(path,body,method)=>{window.calls.push({path,body,method});return {id:'workspace',modId:'mod',latestVersion:String(window.calls.length)}};
function Probe(){const value=useLocalModBuild(api,conversation,runs,workflows);return <div>{value?.latestVersion}</div>}
const root=createRoot(document.getElementById('root'));const render=()=>root.render(<Probe/>);
window.update=()=>{conversation={...conversation,updatedAt:String(Number(conversation.updatedAt)+1)};render()};
window.event=(id,tool,status)=>{runs=runs.map(run=>run.id===id?{...run,events:[...run.events,{seq:run.events.length+1,at:'2026-11-04T00:00:00Z',type:'tool',data:{tool,status}}]}:run);render()};
window.tick=()=>{for(const timer of window.timers.values())timer.callback()};
window.snapshot=()=>({calls:window.calls.length,timers:[...window.timers.values()].map(t=>t.ms),text:document.body.innerText});
window.unmount=()=>root.unmount();render();`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(fixture, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    });
    const runner = join(fixture, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),path=require('node:path'),{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const deadline=setTimeout(()=>app.exit(2),30000);
app.whenReady().then(async()=>{let win;try{
win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
await win.loadFile(path.join(__dirname,'index.html'));const evaluate=code=>win.webContents.executeJavaScript(code);
const frame=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
for(let i=0;i<20;i++){await frame();if((await evaluate('window.snapshot()')).calls)break;}
assert.equal((await evaluate('window.snapshot()')).calls,1);assert.deepEqual((await evaluate('window.snapshot()')).timers,[60000]);
for(let i=0;i<20;i++){await evaluate('window.update()');await frame();}
assert.equal((await evaluate('window.snapshot()')).calls,1,'updatedAt does not refetch');
await evaluate('window.event("other","mod_load","completed")');await frame();
await evaluate('window.event("own","mod_debug","completed")');await frame();
await evaluate('window.event("own","mod_load","inProgress")');await frame();
assert.equal((await evaluate('window.snapshot()')).calls,1,'unrelated tools and unfinished calls do not refetch');
await evaluate('window.event("own","mod_load","completed")');await frame();
assert.equal((await evaluate('window.snapshot()')).calls,2);assert.match((await evaluate('window.snapshot()')).text,/2/);
await evaluate('window.tick()');await frame();assert.equal((await evaluate('window.snapshot()')).calls,3);
await evaluate('window.unmount()');assert.deepEqual((await evaluate('window.snapshot()')).timers,[]);
console.log('PASS: mount, stable timestamps, own mod_load, slow refresh and cleanup');
}catch(error){console.error(error);process.exitCode=1}finally{clearTimeout(deadline);win?.destroy();app.exit(process.exitCode||0)}});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        windowsHide: true,
        timeout: 35000,
        maxBuffer: 1024 * 1024,
      },
    );
    console.log(result.stdout.trim());
    assert.match(result.stdout, /PASS: mount, stable timestamps, own mod_load, slow refresh and cleanup/);
  },
);
