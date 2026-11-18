import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'Claude import dialog requires explicit file and selected chat; rejects invalid files and blocks duplicate submit/reload',
  { timeout: 45000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-claude-import-renderer-')));
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-claude-import-renderer-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {ClaudeHistoryImport} from './src/ui/ClaudeHistoryImport';
import {uiUpdateBlocked} from './src/ui/ui-update-guard';
const root=createRoot(document.getElementById('root'));window.calls=[];window.opened=[];window.blocked=uiUpdateBlocked;
const api=async(path,body)=>{window.calls.push({path,body});
 if(path.endsWith('/preview'))return {fingerprint:'synthetic-fingerprint',source:'claude',skippedRecords:0,conversations:[{id:'first',title:'One',messageCount:2},{id:'second',title:'Two',messageCount:3}]};
 await new Promise(resolve=>window.finish=resolve);return {conversation:{id:'imported'},reused:false,importedMessages:3};};
root.render(<ClaudeHistoryImport project={{id:'project',name:'Synthetic project'}} api={api} onOpen={async(id)=>{window.opened.push(id);return true;}} onClose={()=>root.render(<p>Closed</p>)}/>);`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(directory, 'fixture.js'),
      plugins: [
        {
          name: 'readable-error-only',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/App$/ }, () => ({ path: 'error', namespace: 'stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              contents: 'export const readableError=x=>x.message;',
            }));
          },
        },
      ],
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="fixture.js"></script>',
    );
    const runner = join(directory, 'runner.cjs');
    await writeFile(
      runner,
      `const assert=require('node:assert/strict'),path=require('node:path'),{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://')}));
 await win.loadFile(path.join(__dirname,'index.html'));const run=code=>win.webContents.executeJavaScript(code);
 const wait=async condition=>{for(let i=0;i<100;i++){if(await run(condition))return;await new Promise(r=>setTimeout(r,20));}throw Error('Renderer condition timed out: '+condition);};
 await wait('!!document.querySelector("dialog")?.open');assert.equal(await run('window.calls.length'),0);assert.equal(await run('window.blocked()'),true);
 assert.equal(await run('document.body.textContent.includes("不是原生会话续接")'),true);
 await run('(()=>{const input=document.querySelector("input[type=file]"),data=new DataTransfer();data.items.add(new File([new Uint8Array([255])],"invalid.json"));input.files=data.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await wait('!!document.querySelector("[role=alert]")');assert.equal(await run('window.calls.length'),0);
 await run('(()=>{const input=document.querySelector("input[type=file]"),data=new DataTransfer();data.items.add(new File(["synthetic-only-export"],"chosen.json"));input.files=data.files;input.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await wait('document.querySelectorAll(".cursor-import-list li").length===2');assert.equal(await run('window.calls.length'),1);assert.equal(await run('window.calls[0].body.text'), 'synthetic-only-export');
 await run('(()=>{const button=document.querySelectorAll(".cursor-import-list button")[1];button.click();button.click();})()');
 await wait('window.calls.length===2');assert.equal(await run('window.calls[1].body.conversationId'),'second');assert.equal(await run('window.calls[1].body.fingerprint'),'synthetic-fingerprint');
 assert.equal(await run('document.querySelector("button[aria-label=关闭]").disabled'),true);
 await run('document.querySelector("dialog").dispatchEvent(new Event("cancel",{cancelable:true}))');assert.equal(await run('!!document.querySelector("dialog")'),true);
 await run('window.finish()');await wait('!document.querySelector("dialog")');await wait('!window.blocked()');assert.deepEqual(await run('window.opened'),['imported']);
 console.log('Explicit selection, UTF-8 failure, exact chosen payload, duplicate prevention and update blocker verified.');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /Explicit selection/);
  },
);
