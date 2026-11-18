// Hidden, synthetic renderer only. No application backend, account, model, or user browser is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const electron = require('electron');
const { electronArgs } = require('./helpers/electron-app.cjs');

const root = path.resolve(__dirname, '..');
const prefix = 'pugport-background-ui-';
const inElectron = !!process.versions.electron;
const temporary = inElectron ? process.env.PUGPORT_BACKGROUND_UI_DIR : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
assert.ok(temporary, 'Use the node wrapper to create an isolated fixture profile.');
const fullTemporary = path.resolve(temporary);
assert.equal(path.dirname(fullTemporary).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
assert.ok(path.basename(fullTemporary).startsWith(prefix));

const longPath = [
  String.raw`D:\Synthetic media`,
  '项目素材',
  'very-long-folder-name-'.repeat(18),
  `${'长文件名'.repeat(40)}.mp4`,
].join('\\');
assert.ok(longPath.length > 500, 'the fixture must exercise a genuinely long path');
const longTitle = `本地媒体比对 ${'LongTaskTitleWithoutSpaces'.repeat(16)}`;
const preview =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#719d86"/></svg>',
  );
const tasks = ['image-running', 'image-paused', 'media-running', 'media-paused'].map((id, index) => ({
  id,
  kind: id.startsWith('image') ? 'image-search' : 'media-analysis',
  conversationId: 'synthetic-conversation',
  title: index === 2 ? longTitle : id.startsWith('image') ? '后台图片检索' : '本地媒体比对',
  detail: `${id.startsWith('image') ? '正在核对图片' : '本地读取'} ${longPath}`,
  done: 1234,
  total: 9876,
  startedAt: '2026-10-06T12:00:00Z',
  state: id.endsWith('paused') ? 'paused' : 'running',
  folders: [[String.raw`D:\Synthetic media`, 'FolderWithoutSpaces'.repeat(14)].join('\\')],
  reference: index === 1 ? longPath : undefined,
  previewUrl: index === 0 ? preview : undefined,
}));
tasks[2].assistance = {
  maxWorkers: 2,
  baseWorkers: 2,
  maxFrameReaders: 6,
  workers: ['running', 'failed', 'waiting'].map((status, index) => ({
    workerId: `synthetic-tail-${index}`,
    accountLabel: 'Grok B',
    direction: 'back',
    status,
    checked: index + 12,
    startedAt: '2026-10-06T12:00:00Z',
    updatedAt: '2026-10-06T12:00:10Z',
    elapsedSeconds: 10,
    model: 'grok-4.7-build-fast',
    effort: 'low',
  })),
};
tasks[2].performance = {
  observedAt: '2026-10-06T12:00:10Z',
  cpuPercent: 83,
  memoryPercent: 92,
  freeMemoryBytes: 2.5 * 1024 ** 3,
  assistBudget: 0,
  maxAssistants: 2,
  activeAssistedChecks: 1,
  activeFrameReadLimit: 5,
  reason: 'cpu-pressure',
  freshCompleted: 44,
  freshChecksPerMinute: 2.4,
  throughputComparable: false,
  staging: { copying: true, pendingPairs: 3, activePairs: 2, usedBytes: 1024 ** 3, maxBytes: 8 * 1024 ** 3 },
};
tasks[2].mediaAudit = { scope: 'partial', evidenceGroups: 123, readErrors: 7 };
const longStepLabel = 'CurrentFingerprintStepWithoutSpaces'.repeat(22);
const estimateTasks = ['unknown', 'step', 'whole', 'paused'].map((mode, index) => {
  const range = { minSeconds: 190, maxSeconds: 420 };
  const wholeRange = { minSeconds: 5400, maxSeconds: 16200 };
  const known = mode !== 'unknown';
  const current = mode === 'whole' ? 2 : 1;
  return {
    ...tasks[index],
    id: `estimate-${mode}`,
    kind: 'media-analysis',
    title: `Local media analysis ${mode}`,
    state: mode === 'paused' ? 'paused' : 'running',
    remainingRange: known ? (mode === 'whole' ? wholeRange : range) : undefined,
    remainingSeconds: known ? 300 : undefined,
    estimateScope: mode === 'whole' ? 'whole-task' : 'current-step',
    totalRemainingRange: known
      ? { minSeconds: wholeRange.minSeconds, ...(mode === 'whole' ? { maxSeconds: wholeRange.maxSeconds } : {}) }
      : undefined,
    estimateNote: 'Long timing uncertainty explanation '.repeat(30),
    steps: ['list', 'fingerprints', 'verify'].map((key, stepIndex) => ({
      key,
      label: stepIndex === current ? longStepLabel : `Step ${stepIndex + 1}`,
      state: stepIndex < current ? 'done' : stepIndex === current ? 'running' : 'pending',
      done: stepIndex < current ? 9876 : stepIndex === current ? 1234 : 0,
      total: 9876,
      note: stepIndex === current ? 'LongCurrentStepDetailWithoutSpaces'.repeat(18) : undefined,
      estimateState: stepIndex === current ? (known ? 'stable' : 'learning') : undefined,
      remainingRange: stepIndex === current && known ? (mode === 'whole' ? wholeRange : range) : undefined,
      remainingSeconds: stepIndex === current && known ? (mode === 'whole' ? 10800 : 300) : undefined,
      estimateNote: stepIndex === current ? 'Long current-step timing explanation '.repeat(30) : undefined,
    })),
  };
});
const resumeTask = {
  ...tasks[2],
  id: 'resume-check',
  title: 'Local media comparison',
  detail: `Original private filename: ${longPath}`,
  done: 12958,
  total: 12958,
  state: 'running',
  resume: {
    savedFiles: 12958,
    savedFingerprints: 2088,
    checkedFiles: 100,
    checkingFiles: true,
    previousPhase: 'coarse',
  },
  remainingRange: { minSeconds: 600, maxSeconds: 1800 },
  remainingSeconds: 1200,
  steps: ['scan', 'exact', 'coarse', 'compare', 'verify'].map((key, index) => ({
    key,
    label: index === 0 ? '核对已保存的文件清单' : `Saved step ${index + 1}`,
    state: index === 0 ? 'running' : 'pending',
    done: index === 0 ? 12958 : index === 2 ? 2088 : 0,
    total: index < 3 ? 12958 : null,
    estimateState: index === 0 ? 'learning' : undefined,
    remainingRange: index === 0 ? { minSeconds: 600, maxSeconds: 1800 } : undefined,
  })),
};
const resumedTask = {
  ...resumeTask,
  id: 'resume-ready',
  detail: `Normal current step: ${longPath}`,
  done: 2100,
  total: 12958,
  remainingRange: undefined,
  remainingSeconds: undefined,
  resume: { ...resumeTask.resume, checkedFiles: 12958, checkingFiles: false },
  steps: resumeTask.steps.map((step, index) => ({
    ...step,
    label: index === 0 ? '列出文件' : step.label,
    state: index < 2 ? 'done' : index === 2 ? 'running' : 'pending',
    done: index < 2 ? 12958 : index === 2 ? 2100 : 0,
    remainingRange: undefined,
    estimateState: index === 2 ? 'learning' : undefined,
  })),
};
const changedInventoryTask = {
  ...resumeTask,
  id: 'resume-added-files',
  resume: { ...resumeTask.resume, savedFiles: 150, checkedFiles: 200 },
};
const emptyInventoryTask = {
  ...resumeTask,
  id: 'resume-empty-inventory',
  resume: { ...resumeTask.resume, savedFiles: 0, savedFingerprints: 0, checkedFiles: 20 },
};

if (!inElectron) {
  try {
    buildSync({
      stdin: {
        contents: `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {BackgroundTasks} from './src/ui/BackgroundTasks';
import {startInterfaceLanguage} from './src/ui/i18n';
import './src/ui/studio.css';
window.fixtureErrors=[];window.fixtureRequests=[];window.fixtureCalls=[];
window.addEventListener('error', event=>window.fixtureErrors.push(event.message));
window.addEventListener('unhandledrejection', event=>window.fixtureErrors.push(String(event.reason)));
window.fetch=async (...args)=>{window.fixtureRequests.push(args);throw Error('Unexpected fixture fetch');};
const initial=${JSON.stringify(tasks)};
function Fixture(){
 const [tasks,setTasks]=useState(initial);
 window.fixtureReset=()=>flushSync(()=>setTasks(initial));
 window.fixtureSetTasks=tasks=>flushSync(()=>setTasks(tasks));
 window.fixtureEnglish=async()=>{localStorage.setItem('comborunner.locale','en');await startInterfaceLanguage();};
 const act=(action,id)=>{
   window.fixtureCalls.push([action,id]);
   setTasks(old=>action==='close'?old.filter(task=>task.id!==id):old.map(task=>task.id===id?{...task,state:action==='pause'?'paused':'running'}:task));
 };
 return <BackgroundTasks tasks={[...tasks,{...initial[0],id:'foreign-task',conversationId:'other',title:'FOREIGN_TASK'}]}
 conversationId="synthetic-conversation" onPause={id=>act('pause',id)} onResume={id=>act('resume',id)} onClose={id=>act('close',id)}/>;
}
createRoot(document.getElementById('fixture')).render(<Fixture/>);`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      platform: 'browser',
      outfile: path.join(fullTemporary, 'fixture.js'),
    });
    fs.writeFileSync(
      path.join(fullTemporary, 'index.html'),
      '<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0;padding:16px}#fixture{width:100%;min-width:0}</style><body><main id="fixture"></main><script src="fixture.js"></script></body></html>',
    );
    const environment = { ...process.env, PUGPORT_BACKGROUND_UI_DIR: fullTemporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, electronArgs(__filename), {
      cwd: root,
      env: environment,
      windowsHide: true,
      timeout: 45_000,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // Verify both resolved paths before removing only this invocation's random fixture directory.
    const actual = fs.realpathSync(fullTemporary);
    assert.equal(path.dirname(actual).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(actual).startsWith(prefix));
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
} else {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', path.join(fullTemporary, 'profile'));
  app.disableHardwareAcceleration();
  let window;
  const network = [];
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const capture = async () => {
    try {
      return await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    } catch (error) {
      // Hidden software capture can transiently fail just after native resizing. Keep geometry assertions
      // strict; retry only this Electron snapshot error, never an assertion or renderer exception.
      if (!String(error).includes('UnknownVizError')) throw error;
      await frame();
      return window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    }
  };
  const click = async (selector) => {
    const point = await evaluate(
      `(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw Error('Fixture button missing');button.scrollIntoView({block:'center'});const box=button.getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()`,
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await frame();
  };
  void app.whenReady().then(async () => {
    const checks = [];
    try {
      window = new BrowserWindow({
        show: false,
        width: 872,
        height: 760,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          offscreen: true,
          backgroundThrottling: false,
        },
      });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url.startsWith('file://') || details.url.startsWith('data:');
        if (!allowed) network.push(details.url);
        callback({ cancel: !allowed });
      });
      await window.loadFile(path.join(fullTemporary, 'index.html'));
      await frame();
      assert.equal(await evaluate("document.querySelectorAll('.background-task').length"), 4);
      assert.equal(await evaluate("document.querySelectorAll('.background-task-assistant').length"), 3);
      assert.equal(
        await evaluate("document.querySelector('.background-task-assistant.running').textContent.includes('Grok B 1')"),
        true,
      );
      assert.equal(await evaluate("!!document.querySelector('.background-task-assistant.failed svg.lucide-x')"), true);
      assert.equal(
        await evaluate("!!document.querySelector('.background-task-assistant.failed svg.lucide-check')"),
        false,
      );
      const performance = await evaluate(
        "(()=>{const row=document.querySelector('.background-task-performance');const waiting=document.querySelector('.background-task-assistant.waiting');return {text:row.textContent,title:row.title,waiting:waiting.textContent,waitingIcon:!!waiting.querySelector('svg.lucide-clock-3'),waitingSpins:!!waiting.querySelector('.spinning')};})()",
      );
      assert.match(performance.text, /CPU 83%/);
      assert.match(performance.text, /可用内存 2\.5 GiB/);
      assert.match(performance.text, /协助并发 1\/2/);
      assert.match(performance.text, /2\.4 组\/分钟/);
      assert.match(performance.text, /正在复制待核验视频/);
      assert.equal(performance.title, '处理器繁忙，减少并发');
      assert.match(performance.waiting, /Grok B 3.*等待资源/);
      assert.equal(performance.waitingIcon, true);
      assert.equal(performance.waitingSpins, false);
      const mediaAudit = await evaluate(
        "[...document.querySelectorAll('.background-task-performance')].find(row=>row.title.includes('核验进度')).textContent",
      );
      assert.match(mediaAudit, /相似证据 123 组/);
      assert.match(mediaAudit, /读取\/核验异常 7/);
      assert.match(mediaAudit, /本批未覆盖全部目录/);
      checks.push(
        'Adaptive CPU, free-memory, lane budget and fresh-work rate render; parked helpers show waiting resources; evidence and read errors retain partial-scope wording',
      );
      assert.equal(await evaluate("document.body.textContent.includes('FOREIGN_TASK')"), false);
      const screenshots = path.join(root, 'reports', 'background-tasks-ui');
      fs.mkdirSync(screenshots, { recursive: true });
      for (const width of [840, 520, 360, 280]) {
        // A narrow composer can live inside a wide app. Test container sizing independently
        // of the app's 360px viewport minimum and viewport media queries.
        window.setContentSize(1000, 760);
        await evaluate(
          `document.getElementById('fixture').style.width='${width}px';window.fixtureReset();window.fixtureCalls=[]`,
        );
        window.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
        await frame();
        const geometry = await evaluate(`(()=>{
          const main=document.getElementById('fixture');
          return {main:{width:main.getBoundingClientRect().width,client:main.clientWidth,scroll:main.scrollWidth},document:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth},rows:[...document.querySelectorAll('.background-task')].map(row=>{
            const box=row.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,client:row.clientWidth,scroll:row.scrollWidth,
              buttons:[...row.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};})};
          })};
        })()`);
        assert.ok(Math.abs(geometry.main.width - width) < 2, `${width}: fixture must use the intended container width`);
        assert.ok(
          geometry.main.scroll <= geometry.main.client + 1,
          `${width}: container overflow: ${JSON.stringify(geometry)}`,
        );
        assert.ok(
          geometry.document.scroll <= geometry.document.client + 1,
          `${width}: page must not scroll horizontally`,
        );
        for (const row of geometry.rows) {
          assert.ok(row.scroll <= row.client + 1, `${width}: progress row must not overflow`);
          assert.equal(row.buttons.length, 2);
          for (const button of row.buttons) {
            assert.ok(
              button.left >= row.left &&
                button.right <= row.right + 1 &&
                button.top >= row.top &&
                button.bottom <= row.bottom + 1,
              `${width}: action escaped its row: ${JSON.stringify({ row, button })}`,
            );
            assert.ok(button.width > 25 && button.height >= 24, `${width}: actions retain usable target sizes`);
          }
          assert.ok(
            row.buttons[0].right <= row.buttons[1].left + 1 || row.buttons[0].bottom <= row.buttons[1].top + 1,
            `${width}: actions must not overlap`,
          );
        }
        const text = await evaluate(
          `([...document.querySelectorAll('.background-task')].map(row=>({title:row.querySelector('.background-task-title').title,detail:row.querySelector('.background-task-detail').title,peek:row.querySelector('.background-task-peek')?.textContent??''})))`,
        );
        tasks.forEach((task, index) => {
          assert.ok(
            text[index].title === task.title || text[index].peek.includes(task.title),
            `${width}: complete title remains available`,
          );
          assert.ok(
            text[index].detail.includes(task.detail) || text[index].peek.includes(task.detail),
            `${width}: complete detail remains available`,
          );
          assert.ok(text[index].peek.includes(task.folders[0]), `${width}: full folder path remains available`);
        });
        if (width === 840) {
          const titles = await evaluate(
            "[...document.querySelectorAll('.background-task-title')].map(node=>({client:node.clientWidth,scroll:node.scrollWidth}))",
          );
          for (const index of [0, 1, 3])
            assert.ok(
              titles[index].scroll <= titles[index].client + 1,
              'ordinary task titles remain readable beside long paths at 840px',
            );
          assert.ok(
            titles[2].scroll > titles[2].client,
            'the exceptionally long title is abbreviated without forcing overflow',
          );
        }
        // Real input events exercise hit-testing, not just invoking the callbacks through the DOM.
        await click('.background-task:nth-child(1) .background-task-action:not(.close)');
        assert.equal(await evaluate("document.querySelector('.background-task').classList.contains('paused')"), true);
        await click('.background-task:nth-child(1) .background-task-action.resume');
        assert.equal(await evaluate("document.querySelector('.background-task').classList.contains('paused')"), false);
        await click('.background-task:nth-child(2) .background-task-action.resume');
        await click('.background-task:nth-child(3) .background-task-action:not(.close)');
        assert.equal(
          await evaluate(
            "[...document.querySelectorAll('.background-task:nth-child(3) .background-task-performance')].some(row=>row.textContent.includes('CPU'))",
          ),
          false,
          `${width}: paused media hides the live performance row`,
        );
        await click('.background-task:nth-child(4) .background-task-action.resume');
        await click('.background-task:nth-child(4) .background-task-action.close');
        assert.deepEqual(await evaluate('window.fixtureCalls'), [
          ['pause', 'image-running'],
          ['resume', 'image-running'],
          ['resume', 'image-paused'],
          ['pause', 'media-running'],
          ['resume', 'media-paused'],
          ['close', 'media-paused'],
        ]);
        assert.equal(await evaluate("document.querySelectorAll('.background-task').length"), 3);
        await evaluate('window.fixtureReset()');
        await frame();
        // Focus a button to reveal the keyboard-accessible full-detail popup.
        await evaluate("document.querySelector('.background-task:nth-child(4) button').focus()");
        await frame();
        const popup = await evaluate(
          `(()=>{const p=document.querySelector('.background-task:nth-child(4) .background-task-peek'),box=p.getBoundingClientRect();return {display:getComputedStyle(p).display,overflowY:getComputedStyle(p).overflowY,left:box.left,right:box.right,client:p.clientWidth,scroll:p.scrollWidth,height:box.height,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight};})()`,
        );
        assert.notEqual(popup.display, 'none', `${width}: focusing actions reveals full details`);
        assert.ok(
          popup.left >= 0 && popup.right <= width + 32 + 1 && popup.scroll <= popup.client + 1,
          `${width}: full-detail popup must fit horizontally: ${JSON.stringify(popup)}`,
        );
        assert.ok(popup.height <= 420, `${width}: long full-detail popup remains bounded in height`);
        if (popup.scrollHeight > popup.clientHeight) {
          assert.ok(['auto', 'scroll'].includes(popup.overflowY), `${width}: clipped detail is reachable by scrolling`);
          assert.equal(
            await evaluate(
              "(()=>{const p=document.querySelector('.background-task:nth-child(4) .background-task-peek');p.scrollTop=p.scrollHeight;return p.scrollTop>0;})()",
            ),
            true,
          );
        }
        await evaluate('document.activeElement.blur()');
        window.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
        await frame();
        if (width === 840 || width === 280) {
          window.setContentSize(Math.max(width + 32, 380), 760);
          await frame();
          const image = await capture();
          fs.writeFileSync(path.join(screenshots, `width-${width}.png`), image.toPNG());
        }
        checks.push(
          `${width}px: long title/path contained, full detail accessible, image/media pause/resume/close clickable`,
        );
        window.setContentSize(1000, 760);
        await evaluate(
          `window.fixtureSetTasks(${JSON.stringify(estimateTasks)});document.getElementById('fixture').style.width='${width}px'`,
        );
        await frame();
        const ranges = await evaluate(`(()=>{
          const main=document.getElementById('fixture');
          return {client:main.clientWidth,scroll:main.scrollWidth,rows:[...document.querySelectorAll('.background-task')].map(row=>({
            client:row.clientWidth,scroll:row.scrollWidth,
            estimates:[...row.querySelectorAll('.background-task-step-estimate')].map(node=>node.textContent),
            visibleEstimates:[...row.querySelectorAll('.background-task-step-estimate')].filter(node=>{const box=node.getBoundingClientRect();return box.width>0&&box.height>0&&getComputedStyle(node).display!=='none';}).map(node=>node.textContent),
            whole:row.querySelector('.background-task-total-estimate')?.textContent??null,
            note:row.querySelector('.background-task-note')?.textContent??'',
            title:row.querySelector('.background-task-title').title,
            detail:row.querySelector('.background-task-detail').title,
            peek:row.querySelector('.background-task-peek').textContent,
            current:row.querySelector('.background-task-steps .running')?.textContent??'',
            steps:[...row.querySelectorAll('.background-task-steps li')].map(node=>({client:node.clientWidth,scroll:node.scrollWidth}))
          }))};
        })()`);
        assert.ok(
          ranges.scroll <= ranges.client + 1,
          `${width}: ETA ranges and long step labels stay inside the container: ${JSON.stringify({ client: ranges.client, scroll: ranges.scroll, rows: ranges.rows.map((row) => ({ client: row.client, scroll: row.scroll, steps: row.steps })) })}`,
        );
        for (const [index, row] of ranges.rows.entries()) {
          assert.ok(row.scroll <= row.client + 1, `${width}: ETA task ${index} does not overflow`);
          for (const step of row.steps)
            assert.ok(step.scroll <= step.client + 1, `${width}: long step text wraps without overflow`);
          assert.equal(row.title, estimateTasks[index].title);
          assert.ok(
            row.detail.includes(estimateTasks[index].detail),
            `${width}: full ETA task path remains in its title`,
          );
          assert.ok(
            row.peek.includes(estimateTasks[index].folders[0]),
            `${width}: full ETA folder path remains readable`,
          );
          assert.ok(row.current.includes(longStepLabel), `${width}: actual current step remains present`);
        }
        assert.deepEqual(ranges.rows[0].estimates, [], `${width}: unknown speed has no estimate element`);
        assert.equal(ranges.rows[0].whole, null);
        assert.doesNotMatch(ranges.rows[0].note, /预计|估算|分钟|小时|采样估速/);
        assert.deepEqual(ranges.rows[3].estimates, [], `${width}: paused task removes stale backend estimates`);
        assert.equal(ranges.rows[3].whole, null);
        assert.doesNotMatch(ranges.rows[3].note, /预计|分钟|小时/);
        assert.match(ranges.rows[1].estimates.join(' '), /3–7/);
        assert.match(
          ranges.rows[1].visibleEstimates.join(' '),
          /3–7/,
          `${width}: known current-step ETA remains visible`,
        );
        assert.equal(
          ranges.rows[1].whole,
          null,
          `${width}: the current-step range is not represented as whole-task ETA`,
        );
        assert.match(ranges.rows[2].estimates.join(' '), /1\.5–4\.5/);
        assert.match(ranges.rows[2].whole ?? ranges.rows[2].note, /1\.5–4\.5/);
        assert.match(
          ranges.rows[2].visibleEstimates.join(' '),
          /整个任务.*1\.5–4\.5/,
          `${width}: whole-task ETA remains visible even when the narrow-card note is hidden`,
        );
        if (width === 840 || width === 280) {
          window.setContentSize(Math.max(width + 32, 380), 760);
          await frame();
          const image = await capture();
          fs.writeFileSync(path.join(screenshots, `ranges-width-${width}.png`), image.toPNG());
        }
        checks.push(`${width}px: current/whole ranges fit long step labels; unknown and paused tasks do not show ETA`);
        window.setContentSize(1000, 760);
        await evaluate(
          `window.fixtureSetTasks(${JSON.stringify([resumeTask, resumedTask, changedInventoryTask, emptyInventoryTask])});document.getElementById('fixture').style.width='${width}px'`,
        );
        await frame();
        const resumed = await evaluate(`(()=>{
          const main=document.getElementById('fixture');
          return {client:main.clientWidth,scroll:main.scrollWidth,rows:[...document.querySelectorAll('.background-task')].map(row=>({
            client:row.clientWidth,scroll:row.scrollWidth,
            detail:row.querySelector('.background-task-detail').textContent,
            detailTitle:row.querySelector('.background-task-detail').title,
            note:row.querySelector('.background-task-note').textContent,
            count:row.querySelector('.background-task-count').textContent,
            countTitle:row.querySelector('.background-task-count').title,
            progress:row.querySelector('.background-task-bar>span').style.width,
            stepCount:row.querySelectorAll('.background-task-steps li').length,
            first:row.querySelector('.background-task-steps li').textContent,
            peek:row.querySelector('.background-task-peek').textContent,
            estimates:row.querySelectorAll('.background-task-step-estimate').length,
            buttons:row.querySelectorAll('button').length
          }))};
        })()`);
        assert.ok(
          resumed.scroll <= resumed.client + 1,
          `${width}: checkpoint recovery stays in the progress container`,
        );
        for (const row of resumed.rows) {
          assert.ok(row.scroll <= row.client + 1, `${width}: recovery card does not overflow`);
          assert.equal(row.stepCount, 5, `${width}: all five stages remain available during checkpoint validation`);
          assert.equal(row.buttons, 2);
        }
        const validating = resumed.rows[0],
          ready = resumed.rows[1];
        assert.match(validating.detail, /正在核对文件清单.*2,088.*份指纹/);
        assert.match(validating.detailTitle, /2,088/);
        assert.match(validating.note, /复用已保存的.*2,088/);
        assert.match(validating.count, /已核对 100 个/);
        assert.match(validating.countTitle, /本次已核对 100 个.*上次保存 12,958 个文件/);
        assert.equal(validating.progress, '0%', `${width}: inventory validation does not invent a completion ratio`);
        assert.match(validating.first, /核对已保存的文件清单.*100 个.*本次已核对 100 个.*上次保存 12,958 个文件/);
        assert.doesNotMatch(validating.detail + validating.note + validating.peek, /Original private filename:/);
        assert.equal(validating.estimates, 0, `${width}: validation does not resurrect the old phase ETA`);
        assert.equal(ready.detail, resumedTask.detail, `${width}: after validation the normal live detail returns`);
        assert.match(ready.count, /2,100\s*\/\s*12,958/);
        assert.doesNotMatch(ready.note, /复用已保存的/);
        const changed = resumed.rows[2],
          empty = resumed.rows[3];
        assert.match(changed.count, /已核对 200 个/);
        assert.match(changed.countTitle, /上次保存 150 个文件/);
        assert.doesNotMatch(changed.count + changed.first, /200\s*\/\s*150/);
        assert.equal(
          changed.progress,
          '0%',
          `${width}: additional files cannot make checkpoint checking look complete`,
        );
        assert.match(empty.count, /已核对 20 个/);
        assert.match(empty.countTitle, /上次保存 0 个文件/);
        assert.match(empty.detail, /已保存的 0 份指纹/);
        assert.equal(empty.progress, '0%');
        checks.push(
          `${width}px: checkpoint validation distinguishes 100 checked files from 12,958 saved files and 2,088 reusable fingerprints`,
        );
        if (width === 840) {
          const stageLabels = [
            '文件清单已核对',
            '完全相同文件检查',
            '本地指纹预筛（视频抽6帧）',
            '筛选疑似重复组合',
            '逐对核验',
          ];
          const chineseExamples = [
            {
              ...resumeTask,
              title: '本地媒体比对 · 恢复核对',
              detail: '继续比对：核对文件清单',
              folders: undefined,
              reference: undefined,
            },
            {
              ...resumedTask,
              title: '本地媒体比对 · 接着处理',
              detail: '第3/5步：本地指纹预筛 · 复用已保存的指纹，处理剩余文件',
              folders: undefined,
              reference: undefined,
            },
          ].map((task, taskIndex) => ({
            ...task,
            steps: task.steps.map((step, index) => ({
              ...step,
              label: taskIndex === 0 && index === 0 ? '核对已保存的文件清单' : stageLabels[index],
              note: taskIndex === 1 && index === 2 ? '已复用 2,088 份指纹，本次接着处理剩余文件' : undefined,
            })),
          }));
          await evaluate(
            `window.fixtureSetTasks(${JSON.stringify(chineseExamples)});(()=>{const caption=document.createElement('p');caption.id='fixture-example-label';caption.textContent='界面测试样例 · 恢复核对与接续指纹计算（非真实任务数据）';caption.style.cssText='margin:0 0 12px;font-size:12px;color:#A1A1AA';document.getElementById('fixture').before(caption);})()`,
          );
          window.setContentSize(872, 360);
          await frame();
          const sampleHeight = await evaluate(
            "Math.ceil(document.getElementById('fixture').getBoundingClientRect().bottom+16)",
          );
          window.setContentSize(872, Math.max(200, sampleHeight));
          await frame();
          fs.writeFileSync(path.join(screenshots, 'resume-vs-coarse-zh.png'), (await capture()).toPNG());
          await evaluate("document.getElementById('fixture-example-label').remove()");
          checks.push(
            '840px: saved a clearly labelled Chinese UI example showing inventory validation and resumed fingerprint processing',
          );
        }
      }
      await evaluate('window.fixtureEnglish()');
      await evaluate(
        `window.fixtureSetTasks(${JSON.stringify(estimateTasks)});document.getElementById('fixture').style.width='840px'`,
      );
      window.setContentSize(1000, 760);
      await frame();
      const english = await evaluate(
        "[...document.querySelectorAll('.background-task-step-estimate,.background-task-total-estimate,.background-task-note')].map(node=>node.textContent).join(' | ')",
      );
      assert.doesNotMatch(english, /[㐀-鿿]/, `English ETA labels contain no untranslated Chinese: ${english}`);
      assert.match(english, /3\s*[–-]\s*7/);
      assert.match(english, /1\.5\s*[–-]\s*4\.5/);
      const englishGeometry = await evaluate(
        "(()=>{const main=document.getElementById('fixture');return {client:main.clientWidth,scroll:main.scrollWidth,rows:[...document.querySelectorAll('.background-task')].map(node=>({client:node.clientWidth,scroll:node.scrollWidth}))};})()",
      );
      assert.ok(englishGeometry.scroll <= englishGeometry.client + 1);
      for (const row of englishGeometry.rows) assert.ok(row.scroll <= row.client + 1);
      checks.push(
        'English current-step and whole-task ranges render without untranslated Chinese or horizontal overflow',
      );
      await evaluate(`window.fixtureSetTasks(${JSON.stringify([resumeTask, resumedTask])})`);
      await frame();
      const englishResume = await evaluate(
        "(()=>{const row=document.querySelector('.background-task');return {detail:row.querySelector('.background-task-detail').textContent,note:row.querySelector('.background-task-note').textContent,count:row.querySelector('.background-task-count').textContent,countTitle:row.querySelector('.background-task-count').title,first:row.querySelector('.background-task-steps li').textContent};})()",
      );
      assert.doesNotMatch(
        Object.values(englishResume).join(' | '),
        /[㐀-鿿]/,
        `English recovery wording contains no untranslated Chinese: ${JSON.stringify(englishResume)}`,
      );
      assert.match(englishResume.detail, /2,088/);
      assert.match(englishResume.count, /100/);
      assert.doesNotMatch(englishResume.count, /12,958/);
      assert.match(englishResume.countTitle, /100.*12,958/);
      checks.push('English recovery separates checked files from the previous inventory and reusable fingerprints');
      await evaluate(`window.fixtureSetTasks(${JSON.stringify([tasks[2]])})`);
      await frame();
      const englishPerformance = await evaluate(
        "(()=>{const rows=[...document.querySelectorAll('.background-task-performance')],row=rows[0],waiting=document.querySelector('.background-task-assistant.waiting');return {text:row.textContent,title:row.title,waiting:waiting.textContent,audit:rows[1].textContent,auditTitle:rows[1].title};})()",
      );
      assert.doesNotMatch(
        Object.values(englishPerformance).join(' | '),
        /[㐀-鿿]/,
        `English adaptive performance contains no untranslated Chinese: ${JSON.stringify(englishPerformance)}`,
      );
      assert.match(englishPerformance.text, /CPU 83%/);
      assert.match(englishPerformance.text, /2\.5 GiB/);
      assert.match(englishPerformance.text, /1\/2/);
      assert.match(englishPerformance.waiting, /Waiting for resources/i);
      checks.push('English adaptive performance and waiting-helper labels are translated');
      assert.deepEqual(await evaluate('window.fixtureErrors'), []);
      assert.deepEqual(await evaluate('window.fixtureRequests'), []);
      assert.deepEqual(network, []);
      console.log(JSON.stringify({ passed: true, checks, screenshots }));
    } catch (error) {
      console.error(JSON.stringify({ passed: false, checks, error: String(error) }));
      console.error(error);
      process.exitCode = 1;
    } finally {
      app.exit(process.exitCode ?? 0);
    }
  });
}
