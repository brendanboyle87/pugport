// Local synthetic fixture only. The Electron window is always hidden and offscreen.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { electronArgs } = require('./helpers/electron-app.cjs');
const { offscreenElectronEnv } = require('./helpers/offscreen-electron.cjs');
const { createRequire } = require('node:module');
const { readFileSync, statSync } = require('node:fs');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-trace-smoke-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><button id="opener">Open trace</button><div id="root"></div><script>window.traceErrors=[];window.addEventListener("error",event=>window.traceErrors.push(event.error?.stack||event.message));window.addEventListener("unhandledrejection",event=>window.traceErrors.push(String(event.reason?.stack||event.reason)));</script><script src="fixture.js"></script></body></html>',
      );
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        (await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8')).replace(/^@import .*;\r?\n/gm, '') +
          (await fs.readFile(path.join(root, 'src/ui/ConversationTrace.css'), 'utf8')) +
          '\nbody{margin:0}#root{position:relative;height:calc(100vh - 32px);min-width:0}#opener{height:32px}',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationTrace } from './src/ui/ConversationTrace';
const at = seconds => new Date(Date.UTC(2026, 9, 8) + seconds * 1000).toISOString();
const workflow = (id, patch = {}) => ({ id, conversationId: 'chat', projectId: 'project', userMessageId: id+'-message', input: {content: 'Inspect the synthetic long API run', mode:'auto', permissionMode:'read-only',executionPolicy:'api-only'}, status:'completed', phase:'summarize', plan:[], runIds:[id+'-run'], memoryRevision:2,memoryExcerpt:'',createdAt:at(0),startedAt:at(0),updatedAt:at(660),...patch });
const workflows = [workflow('first'), workflow('child',{parentWorkflowId:'first',createdAt:at(1)}), workflow('last',{createdAt:at(2),status:'queued',runIds:[]})];
const events = [];
for(let i=0;i<30;i++) {
  events.push({type:'tool',at:at(i*22+1),data:{tool:'read_file',toolCallId:'tool-'+i,status:'started',arguments:{path:'synthetic/file-'+i+'.ts'}}});
  events.push({type:'tool',at:at(i*22+1.009),data:{toolCallId:'tool-'+i,status:'completed',result:'Read successfully'}});
}
for(let i=0;i<2500;i++) events.push({type:'status',at:at(659),data:{source:'native',kind:'protocol-observation',detail:{type:'packet-'+i}}});
for(let i=0;i<60;i++) events.push({type:'usage',at:at(660),data:{inputTokens:i}});
const run={id:'first-run',workflowId:'first',prompt:'User request\\n\\n项目规则：\\n'+ 'A long safe prompt paragraph. '.repeat(200),userInput:'Inspect the synthetic long API run',projectPath:'C:/fixture',kind:'routine',status:'completed',startedAt:at(0),endedAt:at(660),route:{runtimeId:'api-fixture',model:'synthetic',kind:'routine',reasons:['Synthetic test route'],warnings:[]},account:{label:'Fixture API',provider:'api-anthropic'},output:'Completed the synthetic inspection.',events,eventsDropped:0,auditVersion:1};
const state={app:{name:'Fixture',version:'test',platform:'win32',dataDir:'fixture'},runs:[run],workflows,targets:[],runtimes:[],settings:{executionPolicy:'api-only'},projects:[],conversations:[],conversationMessages:[],approvals:[],plugins:[]};
const messages=workflows.map(w=>({id:w.userMessageId,conversationId:'chat',role:'user',content:w.id+' user request '+ 'x'.repeat(140),createdAt:w.createdAt}));
const root=createRoot(document.getElementById('root'));
window.traceRequests=0;
window.traceClosed=0;
const props={conversation:{id:'chat',title:'Synthetic API trace'},workflows,messages,state,initialRunId:run.id,initialTab:'calls',api:async()=>{window.traceRequests++; return {workflow:workflows[0],userInput:run.userInput,finalOutput:run.output,runs:[run],relatedRuns:[],relatedWorkflows:[workflows[1]]}},notify:()=>{},onInspect:()=>{},onClose:()=>{window.traceClosed++;flushSync(()=>root.render(null));}};
window.renderTrace=()=>{document.getElementById('opener').focus();flushSync(()=>root.render(<ConversationTrace {...props}/>));};
window.renderTrace();`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        // The custom source namespace does not inherit tsconfig's JSX transform.
        jsx: 'automatic',
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        loader: { '.png': 'dataurl' },
        // Resolve through Node as the UI harness does; esbuild cannot enumerate sandbox ancestors.
        plugins: [
          {
            name: 'local-fixture-sources',
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (args.path.startsWith('data:')) return { path: args.path, external: true };
                let resolved;
                if (args.path.startsWith('.') || path.isAbsolute(args.path)) {
                  const base = path.resolve(args.importer ? path.dirname(args.importer) : root, args.path);
                  resolved = [
                    base,
                    ...['.ts', '.tsx', '.js', '.css', '/index.ts', '/index.tsx', '/index.js'].map((ext) => base + ext),
                  ].find((value) => statSync(value, { throwIfNoEntry: false })?.isFile());
                } else
                  resolved = createRequire(
                    path.isAbsolute(args.importer) ? args.importer : path.join(root, 'package.json'),
                  ).resolve(args.path);
                if (!resolved) throw new Error(`Fixture source missing: ${args.path}`);
                return { path: resolved, namespace: 'fixture-source' };
              });
              builder.onLoad({ filter: /.*/, namespace: 'fixture-source' }, (args) => ({
                contents: readFileSync(args.path),
                loader: args.path.endsWith('.tsx')
                  ? 'tsx'
                  : args.path.endsWith('.ts')
                    ? 'ts'
                    : args.path.endsWith('.css')
                      ? 'css'
                      : args.path.endsWith('.json')
                        ? 'json'
                        : args.path.endsWith('.png')
                          ? 'dataurl'
                          : 'js',
                resolveDir: path.dirname(args.path),
              }));
            },
          },
        ],
        define: { 'process.env.NODE_ENV': '"development"' },
        outfile: path.join(fixture, 'fixture.js'),
      });
      const environment = offscreenElectronEnv({ ...process.env, COMBORUNNER_TRACE_SMOKE: fixture });
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 45000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (value) => resolve(value ?? 1));
      }).finally(() => clearTimeout(timeout));
      process.exitCode = code;
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-trace-smoke-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_TRACE_SMOKE;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-trace-smoke-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const window = new BrowserWindow({
        show: false,
        width: 1400,
        height: 900,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') }),
      );
      const evaluate = (source) => window.webContents.executeJavaScript(source);
      const frame = () =>
        evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await window.loadFile(path.join(fixture, 'index.html'));
      await evaluate(`new Promise((resolve,reject) => {
        const started=performance.now();
        const check=()=> {
          if (window.traceErrors.length) reject(new Error(window.traceErrors.join('\\n')));
          else if (document.querySelector('.conversation-trace-record')) resolve();
          else if (performance.now()-started>10000) reject(new Error('Trace fixture did not mount: '+document.body.innerText));
          else requestAnimationFrame(check);
        };
        check();
      })`);
      await frame();
      const screenshots = path.join(root, 'artifacts/chat-ui/trace-screenshots');
      await fs.mkdir(screenshots, { recursive: true });
      for (const [width, height] of [
        [1400, 900],
        [900, 700],
      ]) {
        window.setContentSize(width, height);
        for (const theme of ['light', 'dark']) {
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          await frame();
          const metrics = await evaluate(
            `({width:innerWidth,scroll:document.documentElement.scrollWidth,marks:[...document.querySelectorAll('.trajectory-marker[data-lane="tools"]')].map(el=>el.getBoundingClientRect().width), records:document.querySelectorAll('.conversation-trace-record').length, requests:window.traceRequests, errors:window.traceErrors})`,
          );
          assert.deepEqual(metrics.errors, [], 'The fixture must render without uncaught errors');
          assert.ok(metrics.scroll <= metrics.width, JSON.stringify(metrics));
          assert.equal(metrics.records, 3);
          assert.equal(metrics.requests, 1, 'Rendering and resizing do not reload the archive');
          assert.equal(metrics.marks.length, 30);
          assert.ok(
            metrics.marks.every((value) => value >= 3),
            JSON.stringify(metrics.marks),
          );
          await fs.writeFile(
            path.join(screenshots, `trace-${width}-${theme}.png`),
            (await window.webContents.capturePage()).toPNG(),
          );
        }
      }
      await evaluate(`document.querySelector('.trajectory-marker[data-lane="tools"]').click()`);
      await frame();
      assert.equal(await evaluate(`!!document.querySelector('.trajectory-detail-modal')`), true);
      const backdrop = await evaluate(`(() => {
        const rect = document.querySelector('.trajectory-detail-backdrop').getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
      })()`);
      assert.equal(backdrop.x, 0, 'The fixed dialog must escape the Trace containing layer');
      assert.equal(backdrop.y, 0);
      assert.equal(backdrop.width, backdrop.viewportWidth);
      assert.equal(backdrop.height, backdrop.viewportHeight);
      await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await frame();
      assert.equal(await evaluate('window.traceClosed'), 0, 'Detail Esc must not close the overlay');
      assert.equal(await evaluate(`!!document.querySelector('.trajectory-detail-modal')`), false);
      await evaluate(
        `document.querySelector('.conversation-trace').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
      );
      await frame();
      assert.equal(await evaluate('window.traceClosed'), 1);
      assert.equal(await evaluate('document.activeElement.id'), 'opener');
      console.log(
        'Conversation Trace renderer smoke passed: 4 size/theme layouts, 30 tool marks >= 3 px, no horizontal scroll, one request, detail Esc isolation, overlay Esc and focus return.',
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
