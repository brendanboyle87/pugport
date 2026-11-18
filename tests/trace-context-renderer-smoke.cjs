// Trace › Context renderer check. Local synthetic fixture only; the Electron window is hidden and offscreen.
// Scenario data comes from the real server modules (tests/helpers/trace-context-fixture.ts) over an in-memory DB.
// Screenshots go to artifacts/trace-context, or to TRACE_CONTEXT_SHOTS when set.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { electronArgs } = require('./helpers/electron-app.cjs');
const { offscreenElectronEnv } = require('./helpers/offscreen-electron.cjs');
const { createRequire } = require('node:module');
const { readFileSync, statSync } = require('node:fs');
const root = path.resolve(__dirname, '..');

/** Latin subsets of the app fonts, inlined so the hidden page renders like the app without network access. */
async function fontFaces(pkg) {
  const dir = path.join(root, 'node_modules', pkg);
  const css = await fs.readFile(path.join(dir, 'index.css'), 'utf8');
  const blocks = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  const kept = [];
  for (const block of blocks) {
    const file = block.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1];
    if (!file || !/-latin-(?:wght|opsz|standard)?-?normal|-latin-[a-z]*-?normal/.test(file) || file.includes('ext'))
      continue;
    const data = (await fs.readFile(path.join(dir, 'files', file))).toString('base64');
    kept.push(block.replace(/src:[^;]*;/, `src: url(data:font/woff2;base64,${data}) format('woff2-variations');`));
  }
  return kept.join('\n');
}

if (!process.versions.electron) {
  void (async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'comborunner-trace-context-'));
    try {
      await fs.mkdir(path.join(fixture, 'profile'));
      const data = execFileSync(process.execPath, ['--import', 'tsx', 'tests/helpers/trace-context-fixture.ts'], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      await fs.writeFile(path.join(fixture, 'data.js'), `window.traceData=${data.toString('utf8')};`);
      await fs.writeFile(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script>window.traceErrors=[];window.addEventListener("error",event=>window.traceErrors.push(event.error?.stack||event.message));window.addEventListener("unhandledrejection",event=>window.traceErrors.push(String(event.reason?.stack||event.reason)));</script><script src="data.js"></script><script src="fixture.js"></script></body></html>',
      );
      const strip = (css) => css.replace(/^@import .*;\r?\n/gm, '');
      await fs.writeFile(
        path.join(fixture, 'style.css'),
        (await fontFaces('@fontsource-variable/inter')) +
          (await fontFaces('@fontsource-variable/jetbrains-mono')) +
          strip(await fs.readFile(path.join(root, 'src/ui/studio.css'), 'utf8')) +
          (await fs.readFile(path.join(root, 'src/ui/ConversationTrace.css'), 'utf8')) +
          (await fs.readFile(path.join(root, 'src/ui/TraceContext.css'), 'utf8')) +
          '\nbody{margin:0;background:var(--surface-1)}#root{position:relative;height:100vh;min-width:0}',
      );
      await require('esbuild').build({
        stdin: {
          contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationTrace } from './src/ui/ConversationTrace';
import { startInterfaceLanguage } from './src/ui/i18n';
const root = createRoot(document.getElementById('root'));
window.traceRequests = [];
window.renderScenario = async (name) => {
  localStorage.setItem('comborunner.locale', 'en');
  await startInterfaceLanguage();
  const s = window.traceData[name];
  const api = async (path) => {
    window.traceRequests.push(path);
    const execution = path.match(/^\\/api\\/workflows\\/([^/]+)\\/execution-record/);
    if (execution) {
      const id = decodeURIComponent(execution[1]);
      return { workflow: s.workflows.find((w) => w.id === id), runs: s.runs.filter((r) => r.workflowId === id), relatedRuns: [], relatedWorkflows: [] };
    }
    if (/^\\/api\\/workflows\\/[^/]+\\/context/.test(path)) return s.page;
    const detail = path.match(/^\\/api\\/runs\\/([^/]+)\\/context/);
    if (detail) return s.details[decodeURIComponent(detail[1])];
    const run = path.match(/^\\/api\\/runs\\/([^/?]+)$/);
    if (run) return s.runs.find((r) => r.id === decodeURIComponent(run[1]));
    throw new Error('Unexpected fixture request ' + path);
  };
  const state = { app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' }, runs: s.runs, workflows: s.workflows, targets: s.targets, runtimes: [], settings: {}, projects: [], conversations: [], conversationMessages: [], approvals: [], plugins: [] };
  flushSync(() => root.render(null));
  flushSync(() =>
    root.render(
      <ConversationTrace
        key={name}
        conversation={{ id: 'chat', title: s.conversation }}
        workflows={s.workflows}
        messages={s.messages}
        state={state}
        api={api}
        notify={() => {}}
        initialWorkflowId={s.workflowId}
        initialTab="context"
        onClose={() => {}}
        onInspect={() => {}}
      />,
    ),
  );
};`,
          resolveDir: root,
          loader: 'tsx',
        },
        bundle: true,
        platform: 'browser',
        jsx: 'automatic',
        tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
        loader: { '.png': 'dataurl' },
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
                    ...['.ts', '.tsx', '.js', '.css', '.json', '/index.ts', '/index.tsx', '/index.js'].map(
                      (ext) => base + ext,
                    ),
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
                      ? 'empty'
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
      const environment = offscreenElectronEnv({ ...process.env, COMBORUNNER_TRACE_CONTEXT: fixture });
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawn(require('electron'), electronArgs(__filename), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: 'inherit',
      });
      const timeout = setTimeout(() => child.kill(), 120000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (value) => resolve(value ?? 1));
      }).finally(() => clearTimeout(timeout));
      process.exitCode = code;
    } finally {
      const temporaryRoot = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(fixture);
      assert.equal(path.dirname(resolved).toLowerCase(), temporaryRoot.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('comborunner-trace-context-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const fixture = process.env.COMBORUNNER_TRACE_CONTEXT;
  assert.ok(fixture && path.basename(fixture).startsWith('comborunner-trace-context-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    try {
      const window = new BrowserWindow({
        show: false,
        width: 1440,
        height: 1000,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('data:') }),
      );
      const evaluate = (source) => window.webContents.executeJavaScript(source);
      const frame = () =>
        evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await window.loadFile(path.join(fixture, 'index.html'));
      const shots = process.env.TRACE_CONTEXT_SHOTS
        ? path.resolve(root, process.env.TRACE_CONTEXT_SHOTS)
        : path.join(root, 'artifacts/trace-context');
      await fs.mkdir(shots, { recursive: true });
      const scenarios = [
        ['cli', 'context-cli-multi-attempt', 4],
        ['api', 'context-api-pi', 1],
        ['quiet', 'context-no-usage', 1],
      ];
      const results = [];
      for (const [name, file, rows] of scenarios) {
        for (const theme of ['light', 'dark']) {
          window.setContentSize(1440, 1000);
          await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          await evaluate(`window.renderScenario(${JSON.stringify(name)})`);
          await evaluate(`new Promise((resolve,reject) => {
            const started=performance.now();
            const check=()=> {
              if (window.traceErrors.length) reject(new Error(window.traceErrors.join('\\n')));
              else if (document.querySelectorAll('.trace-context-row[role="option"]').length === ${rows} && (document.querySelector('.trace-context-did-cols') || /This run had no tools/.test(document.body.innerText))) resolve();
              else if (performance.now()-started>15000) reject(new Error('Context did not load: '+document.body.innerText.slice(0,2000)));
              else requestAnimationFrame(check);
            };
            check();
          })`);
          await new Promise((resolve) => setTimeout(resolve, 350));
          const needed = await evaluate(
            `Math.ceil(document.querySelector('.conversation-trace-header').getBoundingClientRect().height + document.querySelector('.conversation-trace-detail').scrollHeight + 4)`,
          );
          window.setContentSize(1440, Math.max(900, needed));
          await frame();
          await new Promise((resolve) => setTimeout(resolve, 150));
          const metrics = await evaluate(`(() => {
            const detail = document.querySelector('.conversation-trace-detail');
            const text = document.body.innerText;
            return {
              width: innerWidth,
              scroll: document.documentElement.scrollWidth,
              detailOverflow: detail.scrollWidth - detail.clientWidth,
              selectedTab: document.querySelector('[role="tab"][aria-selected="true"]').textContent,
              english: /How the context was built/.test(text) && /What went in/.test(text) && /Why this context/.test(text),
              untranslated: [...document.querySelectorAll('.trace-context-root :not(script)')].filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && /[\\u4e00-\\u9fff]/.test(n.nodeValue) && !el.closest('[translate="no"]'))).map((el) => el.textContent.slice(0, 40)).slice(0, 8),
              notReported: /Total not reported by this CLI/.test(text),
              reportedBy: /Reported by/.test(text),
              noUsage: /didn't report token usage/.test(text),
              requestsChart: document.querySelectorAll('.trace-context-spark i').length,
              cardEdges: [...document.querySelectorAll('.trace-context-card')].map((el) => Math.round(el.getBoundingClientRect().right)),
              errors: window.traceErrors,
            };
          })()`);
          assert.deepEqual(metrics.errors, [], 'The fixture must render without uncaught errors');
          assert.ok(metrics.scroll <= metrics.width && metrics.detailOverflow <= 1, JSON.stringify(metrics));
          assert.equal(metrics.selectedTab, 'Context');
          assert.equal(
            new Set(metrics.cardEdges.filter((edge, index) => index !== 1)).size,
            1,
            'full-width cards share one right edge: ' + metrics.cardEdges,
          );
          assert.ok(metrics.english, 'English copy is applied');
          assert.deepEqual(metrics.untranslated, [], 'every Context string has an English translation');
          if (name === 'cli') assert.ok(metrics.notReported && metrics.requestsChart === 18, JSON.stringify(metrics));
          if (name === 'api') assert.ok(!metrics.notReported && metrics.requestsChart === 14, JSON.stringify(metrics));
          if (name === 'quiet') assert.ok(metrics.notReported && metrics.noUsage && metrics.requestsChart === 0);
          await fs.writeFile(
            path.join(shots, `${file}-${theme}.png`),
            (await window.webContents.capturePage()).toPNG(),
          );
          results.push(`${file}-${theme}`);
        }
      }
      // Interaction: a sub-task row moves B–E to that run; the sent-only scale hides reported totals.
      window.setContentSize(1440, 1000);
      await evaluate(`window.renderScenario('cli')`);
      await evaluate(
        `new Promise(resolve => { const check = () => document.querySelectorAll('.trace-context-row[role="option"]').length === 4 ? resolve() : requestAnimationFrame(check); check(); })`,
      );
      await evaluate(`document.querySelector('.trace-context-row[data-run-id="pi-review"]').click()`);
      await frame();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const subtask = await evaluate(
        `({ title: document.querySelector('.trace-context-stack h3').textContent, selected: document.querySelector('.trace-context-row[aria-selected="true"]').dataset.runId })`,
      );
      assert.equal(subtask.selected, 'pi-review');
      assert.match(subtask.title, /Pi · Anthropic card/);
      await evaluate(`[...document.querySelectorAll('.trace-context-toggle button')][1].click()`);
      await frame();
      assert.equal(await evaluate(`/Total not reported by this CLI/.test(document.body.innerText)`), false);
      await evaluate(`document.querySelector('.trace-context-did .tally').click()`);
      await frame();
      assert.equal(
        await evaluate(`document.querySelector('.conversation-trace-record[aria-selected="true"]').dataset.workflowId`),
        'review',
        'a sub-task tally opens that sub-task record',
      );
      console.log(
        `Trace Context renderer smoke passed: ${results.length} screenshots (${results.join(', ')}), English copy, no overflow, sub-task selection, scale toggle.`,
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}
