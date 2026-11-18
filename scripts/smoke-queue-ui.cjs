// Drives only this application's own renderer against the isolated smoke backend.
const { app, BrowserWindow, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const out = path.join(root, 'reports', 'comborunner-v001');
const url = process.env.AGENT_STUDIO_SMOKE_URL;
if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('Local isolated smoke backend required');
app.setPath('userData', path.join(root, '.data', 'queue-ui-test-profile'));
let window;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (source) => window.webContents.executeJavaScript(source, true);
async function wait(source) {
  for (let i = 0; i < 60; i++) {
    if (await evaluate(source)) return;
    await pause(100);
  }
  throw new Error('UI condition timed out: ' + source);
}
async function clickText(selector, text) {
  await evaluate(
    `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}));if(!e)throw Error('Control missing');e.click()})()`,
  );
  await pause(100);
}
async function select(selector, value) {
  await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
  );
  await pause(100);
}
async function fill(selector, value) {
  await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  );
  await pause(80);
}
const screenshot = async (name) => {
  // Hidden Chromium windows can lag DOM assertions by a compositor frame.
  await window.webContents.capturePage();
  await pause(350);
  await fs.writeFile(path.join(out, name + '.png'), (await window.webContents.capturePage()).toPNG());
};
app.whenReady().then(async () => {
  const checks = [];
  await fs.mkdir(out, { recursive: true });
  window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadURL(url);
    await wait(
      `document.body.innerText.includes('已连接本地服务') && document.body.innerText.includes(${JSON.stringify('v' + pkg.version)})`,
    );
    await clickText('.nav-item', '任务队列');
    await wait(
      `document.querySelector('h1')?.textContent==='任务队列' && document.querySelectorAll('.queue-item').length===1`,
    );
    assert.ok(await evaluate(`document.querySelector('.queue-overview').innerText.includes('0 执行')`));
    checks.push('pending queue shown separately from execution');
    await select('select[aria-label="队列状态"]', 'all');
    await wait(`document.querySelectorAll('.queue-item').length===2`);
    checks.push('cancelled task available through status filter');
    await select('select[aria-label="队列状态"]', 'pending');
    await evaluate(`document.querySelector('.queue-item summary').click()`);
    await wait(`document.querySelector('.queue-item').open`);
    assert.ok(await evaluate(`document.querySelector('.queue-detail').innerText.includes('最早开始')`));
    await select('select[aria-label="外观主题"]', 'light');
    await wait(`document.documentElement.dataset.theme==='light'`);
    await screenshot('queue-light');
    await select('select[aria-label="外观主题"]', 'dark');
    await wait(`document.documentElement.dataset.theme==='dark'`);
    await screenshot('queue-dark');
    nativeTheme.themeSource = 'light';
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
    await select('select[aria-label="外观主题"]', 'system');
    await wait(`document.documentElement.dataset.theme==='light'`);
    nativeTheme.themeSource = 'dark';
    await wait(`document.documentElement.dataset.theme==='dark'`);
    checks.push('light dark and live system theme');
    window.setSize(1050, 760);
    await pause(150);
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    checks.push('queue fits desktop minimum width');
    window.setSize(1440, 1000);
    await clickText('.queue-actions button', '打开对话');
    await wait(`!!document.querySelector('#conversation-input')`);
    await clickText('.composer-config', '时间安排');
    const local = (offset) => {
      const date = new Date(Date.now() + offset);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    await fill('input[aria-label="最早开始时间"]', local(86400000));
    await fill('input[aria-label="任务期限"]', local(172800000));
    await select('select[aria-label="任务优先级"]', 'high');
    assert.ok(await evaluate(`document.querySelector('.composer-schedule input[type=checkbox]').checked`));
    await fill('#conversation-input', '通过界面预约的新任务');
    assert.equal(await evaluate(`document.querySelector('button[aria-label="发送消息"]').disabled`), false);
    await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
    await wait(`document.querySelector('#conversation-input').value===''`);
    const state = await evaluate(`fetch('/api/state').then(r=>r.json())`);
    const created = state.workflows.find((workflow) => workflow.input.content === '通过界面预约的新任务');
    assert.ok(created);
    assert.equal(created.input.schedule.priority, 'high');
    assert.equal(created.input.schedule.preferExpiringQuota, true);
    assert.ok(created.input.schedule.notBefore.endsWith('Z'));
    assert.equal(state.runs.length, 0);
    checks.push('composer queues with absolute dates and automatic reset preference');
    await clickText('.nav-item', '任务队列');
    await wait(`document.querySelectorAll('.queue-item').length===2`);
    await evaluate(`document.querySelector('[data-workflow-id="${created.id}"] summary').click()`);
    await clickText(`[data-workflow-id="${created.id}"] button`, '取消排队');
    await wait(`document.querySelectorAll('.queue-item').length===1`);
    checks.push('renderer cancellation updates queue via SSE');
    await fs.writeFile(
      path.join(out, 'ui-smoke.json'),
      JSON.stringify({ at: new Date().toISOString(), passed: true, checks }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, checks }));
  } catch (error) {
    await screenshot('failure').catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.quit();
  }
});
