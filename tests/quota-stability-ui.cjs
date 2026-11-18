// Synthetic hidden renderer only: no application backend, account, model request or user browser.
const electron = require('electron');
const { electronArgs } = require('./helpers/electron-app.cjs');
const { app, BrowserWindow } = electron;
const { buildSync } = require('esbuild');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inElectron = !!process.versions.electron;
const prefix = 'pugport-quota-ui-';
const temporary = inElectron ? process.env.PUGPORT_QUOTA_UI_DIR : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
if (!temporary) throw new Error('Run with node, which creates an isolated temporary profile.');
const fullTemporary = path.resolve(temporary);
assert.ok(
  fullTemporary.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(fullTemporary).startsWith(prefix),
);
const epoch = Date.parse('2026-10-06T16:00:00Z');
const base = {
  id: 'cursor-fixture',
  provider: 'cursor',
  label: 'Cursor fixture',
  environment: 'native',
  installed: true,
  status: 'ready',
  authMode: 'chatgpt',
  accountFingerprint: 'fixture-account-a',
  models: [],
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  refreshedAt: new Date(epoch).toISOString(),
  quota: {
    status: 'known',
    source: 'synthetic provider response',
    observedAt: new Date(epoch - 600_000).toISOString(),
    windows: [
      {
        id: 'cursor',
        label: 'Cursor Models',
        usedPercent: 50,
        resetsAt: new Date(epoch + 86_400_000).toISOString(),
        modelPool: 'cursor',
      },
    ],
    cursorCredits: { accountUsd: 40, balanceUsd: 25, totalUsd: 50, grants: [], onDemand: null },
  },
};

if (inElectron) app.setPath('userData', path.join(fullTemporary, 'profile'));
if (!inElectron) {
  try {
    buildSync({
      stdin: {
        contents: `
          import React, {useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {UsagePage} from './src/ui/UsagePage';
          import './src/ui/studio.css';
          window.fixtureRequests=[]; window.fixtureErrors=[];
          window.fetch=async (...args)=>{window.fixtureRequests.push(args);throw Error('Unexpected fixture fetch');};
          window.addEventListener('error',e=>window.fixtureErrors.push(e.message));
          window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason)));
          function Fixture(){
            const [runtime,setRuntime]=useState(${JSON.stringify(base)});
            window.fixtureSet=setRuntime;
            const state={
              app:{name:'PugPort',version:'fixture',platform:'win32',dataDir:'isolated-fixture'},
              runtimes:[runtime], targets:[], runs:[{id:'fixture-run',status:'running',route:{runtimeId:runtime.id}}],
              approvals:[], plugins:[], projects:[], refreshing:false,
              settings:{refreshSeconds:60,maxQuotaAgeSeconds:180},
            };
            return <UsagePage state={state} now={${epoch}} refreshing={false}
              api={async()=>{throw Error('Unexpected fixture API');}}
              refresh={async()=>{throw Error('Unexpected fixture refresh');}}
              notify={notice=>window.fixtureErrors.push(notice)} onInspect={()=>{}}/>;
          }
          createRoot(document.getElementById('fixture')).render(<Fixture/>);`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: path.join(fullTemporary, 'fixture.js'),
    });
    fs.writeFileSync(
      path.join(fullTemporary, 'fixture.html'),
      '<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><body><main id="fixture" style="padding:32px;max-width:1080px;margin:auto"></main><script src="fixture.js"></script></body></html>',
    );
    const result = spawnSync(electron, electronArgs(__filename), {
      env: { ...process.env, PUGPORT_QUOTA_UI_DIR: fullTemporary },
      windowsHide: true,
      timeout: 60_000,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // Only this invocation's validated random fixture directory is removed.
    fs.rmSync(fullTemporary, { recursive: true, force: true });
  }
} else {
  let window;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = (source) => window.webContents.executeJavaScript(source, true);
  const balance = `document.querySelector('.resource-grid .quota-track[role="progressbar"]')?.getAttribute('aria-valuenow')`;
  async function wait(source, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(source)) return;
      await pause(20);
    }
    throw Error('Fixture condition timed out: ' + source);
  }
  let current = structuredClone(base);
  async function update(patch = {}, quota = {}) {
    current = { ...current, ...patch, quota: { ...current.quota, ...quota } };
    await evaluate(`window.fixtureSet(${JSON.stringify(current)})`);
  }
  async function remaining(value, overrides = {}) {
    await update({}, { windows: [{ ...current.quota.windows[0], ...overrides, usedPercent: 100 - value }] });
  }
  async function observe() {
    await evaluate(`(()=>{
      window.quotaObserver?.disconnect(); window.quotaChanges=[]; window.quotaStart=performance.now();
      let previous=${balance};
      window.quotaObserver=new MutationObserver(()=>{
        const value=${balance};
        if(value!==previous){previous=value;window.quotaChanges.push({value,at:performance.now()-window.quotaStart});}
      });
      window.quotaObserver.observe(document.querySelector('.resource-grid'),{subtree:true,attributes:true,childList:true,characterData:true});
    })()`);
  }
  app.whenReady().then(async () => {
    const checks = [],
      network = [];
    try {
      window = new BrowserWindow({
        show: false,
        width: 1120,
        height: 900,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      window.webContents.session.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, done) => {
          network.push(details.url);
          done({ cancel: true });
        },
      );
      await window.loadFile(path.join(fullTemporary, 'fixture.html'));
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
      await wait(`!matchMedia('(prefers-reduced-motion: reduce)').matches`);
      await wait(`${balance}==='50'`);
      await observe();
      await remaining(49);
      await pause(60);
      await remaining(48);
      await wait(`${balance}==='48'`);
      const burst = await evaluate('window.quotaChanges');
      assert.deepEqual(
        burst.map((item) => item.value),
        ['48'],
      );
      assert.ok(burst[0].at <= 1200, `burst took ${burst[0].at}ms`);
      checks.push('50→49→48 burst renders only final 48 within 1.2 seconds');

      await observe();
      for (let index = 0; index < 22; index++) {
        await remaining(47 - index);
        await pause(100);
      }
      await wait(`${balance}==='26'`);
      const continuous = await evaluate('window.quotaChanges');
      assert.ok(continuous.length >= 2 && continuous.length <= 4, JSON.stringify(continuous));
      assert.ok(continuous[0].at <= 1200, JSON.stringify(continuous));
      for (let index = 1; index < continuous.length; index++)
        assert.ok(continuous[index].at - continuous[index - 1].at >= 850, JSON.stringify(continuous));
      checks.push('continuous updates render during the stream without debounce starvation');

      await remaining(10); // A queued old-account update must not survive account invalidation.
      await update(
        { accountFingerprint: 'fixture-account-b', status: 'auth-required' },
        { status: 'unknown', observedAt: null, windows: [], cursorCredits: undefined },
      );
      await wait(`${balance}===undefined`, 250);
      assert.doesNotMatch(
        await evaluate(`document.querySelector('.resource-grid').textContent`),
        /\$40\.00|\$25\.00|26%|10%/,
      );
      await pause(1100);
      assert.equal(await evaluate(balance), undefined);
      await update({ status: 'ready' }, { ...base.quota, windows: [{ ...base.quota.windows[0], usedPercent: 20 }] });
      await wait(`${balance}==='80'`);
      await update(
        { authMode: 'apiKey' },
        { status: 'unknown', observedAt: null, windows: [], cursorCredits: undefined },
      );
      await wait(`${balance}===undefined`, 250);
      checks.push('account and authentication changes immediately clear old quota and queued balances');

      await update(
        { authMode: 'chatgpt' },
        { ...base.quota, windows: [{ ...base.quota.windows[0], usedPercent: 80 }] },
      );
      await wait(`${balance}==='20'`);
      await pause(1100); // Commit the new account scope before testing a normal same-account reset.
      await remaining(97, { resetsAt: new Date(epoch + 7 * 86_400_000).toISOString() });
      await wait(`${balance}==='97'`);
      checks.push('a real provider reset may increase remaining quota from 20 to 97');

      await update(
        {},
        {
          windows: [
            current.quota.windows[0],
            {
              id: 'other',
              label: 'Other Models',
              usedPercent: 30,
              modelPool: 'other',
              resetsAt: new Date(epoch + 86_400_000).toISOString(),
            },
          ],
        },
      );
      await wait(`document.querySelectorAll('.resource-grid .quota-window').length===2`);
      await evaluate(
        `window.quotaNodes=new Map([...document.querySelectorAll('.resource-grid .quota-window')].map(node=>[node.querySelector('.quota-window-heading > span').textContent,node]));undefined`,
      );
      await update({}, { windows: [...current.quota.windows].reverse() });
      await wait(`document.querySelector('.resource-grid .quota-window-heading > span').textContent==='其他模型'`);
      assert.equal(
        await evaluate(
          `[...document.querySelectorAll('.resource-grid .quota-window')].every(node=>window.quotaNodes.get(node.querySelector('.quota-window-heading > span').textContent)===node)`,
        ),
        true,
      );
      checks.push('window reordering preserves the existing quota row nodes');

      const footer = await evaluate(`document.querySelector('.quota-footer-line').textContent`);
      assert.doesNotMatch(footer, /更新于/);
      assert.equal(await evaluate(`document.querySelectorAll('.heading-actions time').length`), 1);
      assert.match(await evaluate(`document.querySelector('.heading-actions time').textContent`), /更新于/);
      assert.doesNotMatch(footer, /秒前|分钟前|已过期/);
      assert.match(
        await evaluate(`document.querySelector('.quota-details').textContent`),
        /当前显示上次报告的额度，刷新后核对/,
      );
      const motion = await evaluate(`(()=>{
        const bar=document.querySelector('.quota-track > span'),dot=document.querySelector('.executor-activity.running .runtime-dot');
        return {bar:getComputedStyle(bar).animationName,sweep:getComputedStyle(bar,'::after').animationName,
          dot:getComputedStyle(dot).animationName,property:getComputedStyle(bar).transitionProperty,duration:getComputedStyle(bar).transitionDuration,
          numerals:getComputedStyle(document.querySelector('.quota-window-heading strong')).fontVariantNumeric};
      })()`);
      assert.equal(motion.bar, 'none');
      assert.equal(motion.sweep, 'none');
      assert.equal(motion.dot, 'executor-pulse');
      const pulse = await evaluate(`(()=>{
        const cards=[...document.querySelectorAll('.quota-card')];
        const animations=cards.flatMap(card=>card.getAnimations({subtree:true}));
        const bounds=()=>cards.map(card=>{
          const {x,y,width,height}=card.getBoundingClientRect();return {x,y,width,height};
        });
        const before=bounds();
        const samples=animations.map(animation=>{
          const target=animation.effect.target;
          const properties=[...new Set(animation.effect.getKeyframes().flatMap(frame=>Object.keys(frame)
            .filter(key=>!['offset','computedOffset','easing','composite'].includes(key))))];
          animation.pause();
          const frames=[0,0.25,0.5,0.75,1].map(fraction=>{
            animation.currentTime=animation.effect.getTiming().duration*fraction;
            return {opacity:getComputedStyle(target).opacity,bounds:bounds()};
          });
          animation.play();
          return {name:animation.animationName,target:target.matches('.executor-activity.running .runtime-dot'),
            properties,frames};
        });
        return {before,samples};
      })()`);
      assert.equal(pulse.samples.length, 1, 'the running dot is the only animated card element');
      const [animation] = pulse.samples;
      assert.equal(animation.name, 'executor-pulse');
      assert.equal(animation.target, true);
      assert.deepEqual(animation.properties, ['opacity']);
      assert.ok(new Set(animation.frames.map((frame) => frame.opacity)).size > 1, 'the dot must pulse');
      for (const frame of animation.frames)
        assert.deepEqual(frame.bounds, pulse.before, 'animation must not change card size or position');
      assert.match(motion.property, /width|all/);
      assert.ok(parseFloat(motion.duration) > 0 && parseFloat(motion.duration) <= 0.5);
      assert.match(motion.numerals, /tabular-nums/);
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await wait(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
      assert.equal(
        await evaluate(
          `getComputedStyle(document.querySelector('.executor-activity.running .runtime-dot')).animationName`,
        ),
        'none',
      );
      assert.equal(await evaluate(`document.querySelector('.quota-card').getAnimations({subtree:true}).length`), 0);
      assert.ok(
        parseFloat(
          await evaluate(`getComputedStyle(document.querySelector('.quota-track > span')).transitionDuration`),
        ) <= 0.001,
        'reduced motion must remove any perceptible width transition',
      );
      window.webContents.debugger.detach();
      checks.push(
        'neutral footer, opacity-only running dot, fixed card geometry, tabular numbers and reduced-motion-safe animation',
      );

      // Grid and opened details consume the same throttled snapshot.
      await evaluate(`document.querySelector('.resource-grid .quota-card').click()`);
      await wait(`!!document.querySelector('.quota-zoom .quota-card')`);
      await remaining(60);
      await pause(30);
      assert.equal(
        await evaluate(`document.querySelector('.quota-zoom .quota-track').getAttribute('aria-valuenow')`),
        await evaluate(balance),
      );
      await wait(`${balance}==='60'`);
      assert.equal(
        await evaluate(`document.querySelector('.quota-zoom .quota-track').getAttribute('aria-valuenow')`),
        '60',
      );
      checks.push('grid and enlarged card stay on the same displayed snapshot');

      const reference = structuredClone(current.quota);
      await update(
        { status: 'error', note: 'runtime-timeout', lastKnownQuota: reference },
        { status: 'error', observedAt: null, windows: [], cursorCredits: undefined },
      );
      await wait(
        `document.querySelector('.resource-grid').textContent.includes('上次报告 · 正在等待新的额度读数')`,
        250,
      );
      assert.equal(await evaluate(balance), '60');
      assert.match(await evaluate(`document.querySelector('.resource-grid').textContent`), /Cursor 连接检查超时/);
      await pause(1100); // The reference is now committed, so removing it must bypass the display delay.
      await update({ lastKnownQuota: undefined });
      await wait(`${balance}===undefined`, 250);
      assert.equal(
        await evaluate(`document.querySelector('.quota-zoom .quota-track[role="progressbar"]')===null`),
        true,
      );
      await pause(1100);
      assert.equal(await evaluate(balance), undefined);
      assert.doesNotMatch(
        await evaluate(`document.querySelector('.resource-grid').textContent`),
        /60%|\$40\.00|上次报告/,
      );
      checks.push(
        'verified historical quota remains labelled, and revoking its reference immediately clears both views',
      );

      assert.deepEqual(await evaluate('window.fixtureErrors'), []);
      assert.deepEqual(await evaluate('window.fixtureRequests'), []);
      assert.deepEqual(network, []);
      console.log(JSON.stringify({ passed: true, checks }));
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      // Electron owns teardown of the fixture window and its open dialog.
      app.exit(process.exitCode ?? 0);
    }
  });
}
