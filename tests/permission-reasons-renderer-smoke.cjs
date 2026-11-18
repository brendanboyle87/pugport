// Synthetic renderer only, with all network requests blocked and an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'reports/b5-ui');

if (!process.versions.electron) {
  void (async () => {
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, 'index.html'),
      '<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><main id="root"></main><script src="fixture.js"></script></html>',
    );
    await fs.writeFile(
      path.join(out, 'style.css'),
      (await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8')) +
        '\nbody{overflow:auto}#root{padding:32px;max-width:1000px;margin:auto}h2{margin-top:32px}',
    );
    await require('esbuild').build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkflowTrace } from './src/ui/Workspace';
        const task = {id:'limited',conversationId:'c',projectId:'p',userMessageId:'m',
          input:{content:'Synthetic fixture',mode:'build',permissionMode:'workspace-write',executionPolicy:'cli-first',permissionOrigin:{mode:'workspace-write',source:'user'}},
          status:'completed',phase:'summarize',plan:[],runIds:['r'],memoryRevision:0,memoryExcerpt:'',createdAt:'2026-10-13T00:00:00Z',updatedAt:'2026-10-13T00:00:00Z'};
        const role = {...task,id:'role',runIds:[],input:{...task.input,mode:'chat',permissionMode:'read-only',permissionOrigin:{mode:'read-only',source:'role'}}};
        const run = {id:'r',workflowId:'limited',status:'completed',route:{runtimeId:'fixture',model:'fixture',kind:'general',reasons:[],warnings:[]},events:[],output:'Synthetic code updated.',
          taskOutcome:{status:'completed',source:'file-receipts',verificationLimited:true,limitedChecks:[{id:'test',command:'node --test synthetic.test.ts',reason:'listen EACCES: permission denied'},{id:'junction',command:'node synthetic-junction-check.js',reason:'EPERM: junction'}]}};
        const state = {targets:[],runtimes:[],runs:[run],workflows:[role,task],settings:{}};
        const actions = {api:async()=>({}),notify:()=>{},onConversation:()=>{},onInspect:()=>{}};
        createRoot(document.getElementById('root')).render(<><h2>只读角色</h2><WorkflowTrace {...actions} state={state} workflow={role}/><h2>验证受限</h2><WorkflowTrace {...actions} state={state} workflow={task}/></>);
      `,
      },
      bundle: true,
      platform: 'browser',
      loader: { '.png': 'dataurl' },
      outfile: path.join(out, 'fixture.js'),
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => child.kill(), 30000);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timeout));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', path.join(out, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      win.webContents.session.webRequest.onBeforeRequest((request, callback) =>
        callback({ cancel: !request.url.startsWith('file://') }),
      );
      await win.loadFile(path.join(out, 'index.html'));
      const frame = () =>
        win.webContents.executeJavaScript(
          'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        );
      await frame();
      const body = await win.webContents.executeJavaScript('document.body.innerText');
      assert.match(body, /只读 · 你点名的只读角色/);
      assert.match(body, /已完成 · 验证受限/);
      assert.equal(
        await win.webContents.executeJavaScript(
          'document.querySelector(".workflow-verification-limited details").open',
        ),
        false,
      );
      await fs.writeFile(path.join(out, 'collapsed.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(
        'document.querySelector(".workflow-verification-limited summary").click()',
      );
      await frame();
      assert.match(await win.webContents.executeJavaScript('document.body.innerText'), /listen EACCES/);
      assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[role=alert]").length'), 0);
      await fs.writeFile(path.join(out, 'expanded.png'), (await win.webContents.capturePage()).toPNG());
      console.log('PASS: read-only role, neutral limited verification, collapsible checks; screenshots reports/b5-ui');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
