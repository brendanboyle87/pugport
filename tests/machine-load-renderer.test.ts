import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { electronArgs } from './helpers/electron-app.cjs';

test('offline Electron renders quiet memory waits without load actions at desktop and narrow widths', async () => {
  const root = process.cwd();
  const fixture = await mkdtemp(join(tmpdir(), 'pugport-b9-renderer-'));
  const artifacts = resolve('artifacts/b9');
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(fixture, 'style.css'), await readFile('src/ui/studio.css'));
  await writeFile(
    join(fixture, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root" style="padding:24px;max-width:680px"></div><script src="fixture.js"></script>',
  );
  await build({
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    plugins: [
      {
        name: 'node-packages',
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, (args) => ({
            path: createRequire(join(root, 'package.json')).resolve(args.path),
          }));
        },
      },
    ],
    stdin: {
      contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WorkflowTrace } from './src/ui/Workspace';
import { machineLoadReasons } from './src/shared/machine-load';
window.calls = [];
window.presentationReads = [];
const workflow = { id:'busy', conversationId:'conversation', status:'waiting-resource', machineLoadChoice:'wait', input:{content:'Synthetic memory wait',mode:'chat',permissionMode:'read-only'}, runIds:[],plan:[],createdAt:'2026-10-13T00:00:00Z' };
const root = createRoot(document.getElementById('root'));
window.renderChoice = choice => flushSync(() => root.render(<WorkflowTrace workflow={{...workflow, machineLoadChoice:choice, scheduling:{reason:machineLoadReasons.memory}}} state={{runs:[],targets:[],runtimes:[],settings:{}}} api={async (path, body) => { if (path.includes('/presentations?')) { window.presentationReads.push(path); return {presentations:{}}; } window.calls.push({path,...body}); }} notify={() => {}} onInspect={() => {}} />));
window.renderChoice('wait');`,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    outfile: join(fixture, 'fixture.js'),
    platform: 'browser',
    format: 'iife',
  });
  const runner = join(fixture, 'runner.cjs');
  await writeFile(
    runner,
    `const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(__dirname, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
 let win;
 try {
  win = new BrowserWindow({show:false,width:760,height:300,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({cancel: !details.url.startsWith('file://')}));
  await win.loadFile(path.join(__dirname,'index.html'));
  const evaluate = code => win.webContents.executeJavaScript(code);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await frame();
  assert.equal(await evaluate('document.querySelectorAll(".machine-load-choice,.machine-load-actions").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".workflow-status .spinning").length'), 1);
  assert.equal(await evaluate('document.querySelector(".workflow-status").textContent'), '排队中');
  assert.equal(await evaluate('document.querySelectorAll("input,[role=dialog]").length'), 0);
  await fs.writeFile(path.join(${JSON.stringify(artifacts)}, 'quiet-wait.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(390,360);
  await frame();
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await fs.writeFile(path.join(${JSON.stringify(artifacts)}, 'quiet-wait-narrow.png'), (await win.webContents.capturePage()).toPNG());
  for (const theme of ['light','dark']) {
   await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
   await evaluate('window.renderChoice("pending")');
   for (const width of [760, 390]) {
    win.setSize(width,360);
    await frame();
    assert.equal(await evaluate('document.body.textContent.includes("等待选择") || document.body.textContent.includes("立即运行") || document.body.textContent.includes("等空闲时自动运行")'), false);
    assert.equal(await evaluate('document.querySelectorAll(".workflow-status .spinning").length'), 1);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await fs.writeFile(path.join(${JSON.stringify(artifacts)}, 'quiet-wait-'+theme+'-'+width+'.png'), (await win.webContents.capturePage()).toPNG());
   }
  }
  assert.deepEqual(await evaluate('window.calls'), []);
  // The card's lazy presentation read is not a load action and names this task's conversation.
  assert.ok((await evaluate('window.presentationReads')).every(read => read === '/api/conversations/conversation/presentations?workflows=busy'));
  console.log('Quiet current and legacy waits; 0 load actions; 0 time pickers; 0 horizontal overflow; 6 screenshots saved');
 } catch(error) { console.error(error); process.exitCode=1; }
 finally { win?.destroy(); app.exit(process.exitCode || 0); }
});`,
  );
  const require = createRequire(import.meta.url);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron') as string, electronArgs(runner), {
    cwd: root,
    env: environment,
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
  const timeout = setTimeout(() => child.kill(), 30000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, output);
  } finally {
    clearTimeout(timeout);
  }
});
