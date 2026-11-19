import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';
import { electronArgs } from './helpers/electron-app.cjs';
import type { LayaSettings } from '../src/shared/laya.ts';

const bundle = await uiBundle('src/ui/LayaSettings.tsx');
function fixture() {
  const calls: Array<{ path: string; body?: any; method?: string }> = [];
  const notices: Array<{ message: string }> = [];
  const view = {
    settings: {} as LayaSettings,
    status: {
      state: 'disabled',
      modelVersion: 'pugport-laya-v4',
      reason: undefined as string | undefined,
      region: undefined as 'eu' | 'other' | undefined,
    },
    training: { directory: 'C:/Synthetic/routing-training', recording: true, error: undefined as string | undefined },
  };
  let readFailure = false;
  let saveFailure = false;
  let jevConfigured = false;
  const h = uiHarness(`${bundle}\nmodule.exports.setSettingsSave = fn => { saveSettings = fn; };`, { Error });
  let reloads = 0;
  const props = {
    section: 'advanced' as 'advanced' | 'sharing',
    api: async (path: string, body?: any, method?: string) => {
      calls.push({ path, body: body === undefined ? undefined : structuredClone(body), method });
      if (path === '/api/laya/status') {
        if (readFailure) throw Error('synthetic status offline');
        return structuredClone(view);
      }
      if (path === '/api/settings') {
        if (saveFailure) throw Error('synthetic save offline');
        Object.assign(view.settings, body.laya);
        view.training.recording = view.settings.recordTraining !== false;
      }
      if (path === '/api/jev/status') return { configured: jevConfigured };
      if (path === '/api/jev/config') {
        if (saveFailure) throw Error('synthetic save offline');
        jevConfigured = !!body.apiKey;
      }
      if (path === '/api/laya/training/delete') {
        if (saveFailure) throw Error('synthetic delete offline');
        return { deletedCount: 12 };
      }
      return {};
    },
    reload: async () => {
      reloads++;
    },
    notify: (notice: { message: string }) => notices.push(notice),
  };
  const render = () => h.render('LayaSettings', props);
  const node = (check: Parameters<typeof findNode>[1]) => {
    const found = findNode(render(), check);
    assert.ok(found);
    return found;
  };
  const field = (label: string) => node((n) => ['input', 'select'].includes(n.type) && n.props['aria-label'] === label);
  const button = (label: string) => node((n) => n.type === 'button' && text(n) === label);
  return {
    h,
    calls,
    notices,
    view,
    props,
    render,
    field,
    button,
    readFailure(value: boolean) {
      readFailure = value;
    },
    saveFailure(value: boolean) {
      saveFailure = value;
    },
    get reloads() {
      return reloads;
    },
  };
}

test('Laya settings delegate to the shared permission boundary and cancellation writes nothing', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.render();
  await nextTurn();
  const saves: unknown[] = [];
  f.h.exports.setSettingsSave(async (_api: unknown, current: unknown, update: unknown) => {
    saves.push(structuredClone({ current, update }));
    return false;
  });
  f.field('路由判断').props.onChange({ target: { value: 'local' } });
  await nextTurn();
  assert.deepEqual(saves, [{ current: { laya: {} }, update: { laya: { mode: 'local' } } }]);
  assert.equal(f.calls.filter((call) => call.path === '/api/settings').length, 0);
  assert.equal(f.calls.filter((call) => call.path === '/api/laya/status').length, 1);
  assert.equal(f.field('路由判断').props.value, 'cloud');
  assert.equal(f.field('路由判断').props.disabled, false);
  assert.equal(f.reloads, 0);
  assert.deepEqual(f.notices, []);
});

test('cancelled Laya path settings retain the unsaved draft for retry', async (t) => {
  const f = fixture();
  f.view.settings.mode = 'local';
  t.after(() => f.h.unmount());
  f.render();
  await nextTurn();
  f.h.exports.setSettingsSave(async () => false);
  f.field('Python 可执行文件').props.onChange({ target: { value: ' C:/Synthetic/retry.exe ' } });
  f.button('保存模型配置').props.onClick();
  await nextTurn();
  assert.equal(f.field('Python 可执行文件').props.value, ' C:/Synthetic/retry.exe ');
  assert.equal(f.button('保存模型配置').props.disabled, false);
  assert.equal(
    f.calls.some((call) => call.path === '/api/settings'),
    false,
  );
  assert.equal(f.reloads, 0);
  assert.deepEqual(f.notices, []);
});

test('local Laya recording defaults on, and stopping records saves only that setting', async (t) => {
  const f = fixture();
  f.view.settings.mode = 'local';
  t.after(() => f.h.unmount());
  f.render();
  await nextTurn();
  assert.equal(f.field('路由判断').props.value, 'local');
  assert.equal(f.field('保存本机路由记录，供后续复审和模型训练').props.checked, true);
  assert.match(text(f.render()), /按日期保存在本机，不会自动上传或启动训练/);
  f.field('保存本机路由记录，供后续复审和模型训练').props.onChange({ target: { checked: false } });
  await nextTurn();
  assert.deepEqual(
    f.calls.find((call) => call.method === 'PATCH'),
    {
      path: '/api/settings',
      body: { laya: { recordTraining: false } },
      method: 'PATCH',
    },
  );
  assert.equal(f.field('保存本机路由记录，供后续复审和模型训练').props.checked, false);
  assert.match(text(f.render()), /已停止新增/);
  assert.match(text(f.render()), /C:\/Synthetic\/routing-training/);
  f.button('打开文件夹').props.onClick();
  await nextTurn();
  assert.deepEqual(f.calls.at(-1)?.body, { kind: 'routing-training' });
  assert.equal(
    f.calls.some((call) => call.method === 'DELETE'),
    false,
  );
});

test('Laya path drafts survive a status refresh and save without enabling the model or training', async (t) => {
  const f = fixture();
  f.view.settings.mode = 'local';
  t.after(() => f.h.unmount());
  f.render();
  await nextTurn();
  f.field('Python 可执行文件').props.onChange({ target: { value: ' C:/Synthetic/python.exe ' } });
  f.field('Task Router v4 模型文件夹').props.onChange({ target: { value: ' C:/Synthetic/laya-v4 ' } });
  await f.button('刷新状态').props.onClick();
  await nextTurn();
  assert.equal(f.field('Python 可执行文件').props.value, ' C:/Synthetic/python.exe ');
  f.button('保存模型配置').props.onClick();
  f.button('保存模型配置').props.onClick();
  await nextTurn();
  assert.deepEqual(
    f.calls.filter((call) => call.method === 'PATCH'),
    [
      {
        path: '/api/settings',
        body: { laya: { pythonPath: 'C:/Synthetic/python.exe', checkpointPath: 'C:/Synthetic/laya-v4' } },
        method: 'PATCH',
      },
    ],
  );
  assert.equal(f.field('Python 可执行文件').props.value, 'C:/Synthetic/python.exe');
  assert.equal(f.button('保存模型配置').props.disabled, true);
});

test('a failed initial Laya read ends loading and can recover through the visible refresh action', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.readFailure(true);
  f.render();
  await nextTurn();
  assert.match(text(f.render()), /状态读取失败/);
  assert.equal(f.button('刷新状态').props.disabled, false);
  f.readFailure(false);
  f.button('刷新状态').props.onClick();
  await nextTurn();
  assert.equal(f.field('路由判断').props.disabled, false);
  assert.doesNotMatch(text(f.render()), /状态读取失败|synthetic status offline/);
});

test('a Laya model error keeps fallback and settings usable; failed saves release controls and preserve the draft', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.view.settings.mode = 'local';
  f.view.status.state = 'error';
  f.view.status.reason = 'synthetic checkpoint missing';
  f.render();
  await nextTurn();
  assert.match(text(f.render()), /出错，已回退/);
  assert.match(text(f.render()), /任务会继续使用本地规则/);
  assert.equal(f.field('路由判断').props.disabled, false);
  f.field('Python 可执行文件').props.onChange({ target: { value: 'C:/Synthetic/retry.exe' } });
  f.saveFailure(true);
  f.button('保存模型配置').props.onClick();
  await nextTurn();
  assert.match(text(f.render()), /Task Router 设置保存失败：synthetic save offline/);
  assert.equal(f.field('Python 可执行文件').props.value, 'C:/Synthetic/retry.exe');
  assert.equal(f.button('保存模型配置').props.disabled, false);
  f.saveFailure(false);
  f.button('保存模型配置').props.onClick();
  await nextTurn();
  assert.equal(f.button('保存模型配置').props.disabled, true);
});

test('a saved Laya switch remains committed if the following status read fails', async (t) => {
  const f = fixture();
  f.view.settings.mode = 'local';
  t.after(() => f.h.unmount());
  f.render();
  await nextTurn();
  f.readFailure(true);
  f.field('保存本机路由记录，供后续复审和模型训练').props.onChange({ target: { checked: false } });
  await nextTurn();
  assert.match(text(f.render()), /Task Router 设置已保存，但状态刷新失败/);
  assert.equal(f.field('保存本机路由记录，供后续复审和模型训练').props.checked, false);
  assert.equal(f.field('保存本机路由记录，供后续复审和模型训练').props.disabled, false);
  assert.match(text(f.render()), /已停止新增/);
  assert.doesNotMatch(text(f.render()), /正在记录/);
});

test('a Laya record write failure is visible without claiming that recording succeeded', async (t) => {
  const f = fixture();
  f.view.settings.mode = 'local';
  t.after(() => f.h.unmount());
  f.view.training.error = 'Synthetic recording disk unavailable';
  f.render();
  await nextTurn();
  assert.match(text(f.render()), /保存失败/);
  assert.doesNotMatch(text(f.render()), /正在记录/);
  const alert = findNode(f.render(), (node) => node.props.role === 'alert');
  assert.equal(text(alert), 'Synthetic recording disk unavailable');
  assert.equal(alert?.props.translate, 'no');
  assert.equal(f.field('保存本机路由记录，供后续复审和模型训练').props.checked, true);
  assert.equal(f.field('保存本机路由记录，供后续复审和模型训练').props.disabled, false);
  f.view.training.error = undefined;
  f.button('刷新状态').props.onClick();
  await nextTurn();
  assert.equal(
    findNode(f.render(), (node) => node.props.role === 'alert'),
    undefined,
  );
  assert.match(text(f.render()), /正在记录/);
});

test('cloud is the default and switching providers preserves the sharing preference', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.view.settings.shareTraining = true;
  f.render();
  await nextTurn();
  assert.equal(f.field('路由判断').props.value, 'cloud');
  assert.equal(
    findNode(f.render(), (node) => node.props.type === 'password'),
    undefined,
  );
  for (const mode of ['local', 'jev', 'rules', 'cloud']) {
    f.field('路由判断').props.onChange({ target: { value: mode } });
    await nextTurn();
    assert.equal(f.field('路由判断').props.value, mode);
    assert.equal(!!findNode(f.render(), (node) => node.props.type === 'password'), mode === 'jev');
    assert.deepEqual(f.calls.filter((call) => call.method === 'PATCH').at(-1)?.body, { laya: { mode } });
    f.props.section = 'sharing';
    assert.equal(f.field('帮助改进路由').props.checked, mode === 'cloud');
    assert.equal(f.field('帮助改进路由').props.disabled, mode !== 'cloud');
    assert.equal(
      findNode(f.render(), (node) => node.props.type === 'password'),
      undefined,
    );
    assert.equal(
      findNode(f.render(), (node) => node.props['aria-label'] === '路由判断'),
      undefined,
    );
    f.props.section = 'advanced';
  }
  assert.equal(f.view.settings.shareTraining, true);
});

test('EU and unknown regions require opt-in while other regions default on', async (t) => {
  for (const region of ['eu', 'other', undefined] as const) {
    const f = fixture();
    t.after(() => f.h.unmount());
    f.props.section = 'sharing';
    f.view.status.region = region;
    f.render();
    await nextTurn();
    assert.equal(f.field('帮助改进路由').props.checked, region === 'other');
    f.field('帮助改进路由').props.onChange({ target: { checked: true } });
    await nextTurn();
    assert.equal(f.field('帮助改进路由').props.checked, true);
    f.field('帮助改进路由').props.onChange({ target: { checked: false } });
    await nextTurn();
    assert.equal(f.field('帮助改进路由').props.checked, false);
    assert.match(text(f.render()), /保存 2 年/);
  }
});

test('Jev keeps a failed password draft and saves it only through the secret endpoint', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.view.settings.mode = 'jev';
  f.render();
  await nextTurn();
  f.render();
  await nextTurn();
  assert.equal(f.field('Jev API 密钥').props.type, 'password');
  assert.equal(f.field('Jev API 密钥').props.value, '');
  assert.match(text(f.render()), /消息会发送给 Jev/);
  f.field('Jev API 密钥').props.onChange({ target: { value: 'synthetic-jev-key' } });
  f.saveFailure(true);
  f.button('保存 Jev 密钥').props.onClick();
  await nextTurn();
  assert.equal(f.field('Jev API 密钥').props.value, 'synthetic-jev-key');
  assert.match(text(f.render()), /Jev 密钥保存失败/);
  f.saveFailure(false);
  f.button('保存 Jev 密钥').props.onClick();
  f.button('保存 Jev 密钥').props.onClick();
  await nextTurn();
  assert.equal(f.calls.filter((call) => call.path === '/api/jev/config').length, 2);
  assert.deepEqual(f.calls.at(-1), { path: '/api/jev/config', body: { apiKey: 'synthetic-jev-key' }, method: 'PUT' });
  assert.equal(f.field('Jev API 密钥').props.value, '');
  assert.match(text(f.render()), /已配置密钥/);
  assert.equal(
    f.calls.some((call) => call.path === '/api/settings'),
    false,
  );
  f.field('路由判断').props.onChange({ target: { value: 'rules' } });
  await nextTurn();
  assert.equal(
    findNode(f.render(), (node) => node.props.type === 'password'),
    undefined,
  );
});

test('enabling sharing also enables recording after a legacy recording opt-out', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.props.section = 'sharing';
  f.view.settings = { mode: 'cloud', recordTraining: false, shareTraining: true };
  f.render();
  await nextTurn();
  assert.equal(f.field('帮助改进路由').props.checked, false);
  f.field('帮助改进路由').props.onChange({ target: { checked: true } });
  await nextTurn();
  assert.deepEqual(f.calls.find((call) => call.method === 'PATCH')?.body, {
    laya: { shareTraining: true, recordTraining: true },
  });
  assert.equal(f.field('帮助改进路由').props.checked, true);
  f.field('帮助改进路由').props.onChange({ target: { checked: false } });
  await nextTurn();
  assert.equal(f.view.settings.recordTraining, true);
  assert.equal(f.field('帮助改进路由').props.checked, false);
});

test('deleting contributions reports the count and a later failure does not claim deletion', async (t) => {
  const f = fixture();
  t.after(() => f.h.unmount());
  f.props.section = 'sharing';
  f.render();
  await nextTurn();
  f.button('删除我贡献的数据').props.onClick();
  f.button('删除我贡献的数据').props.onClick();
  await nextTurn();
  assert.equal(f.calls.filter((call) => call.path === '/api/laya/training/delete').length, 1);
  assert.deepEqual(f.calls.at(-1), { path: '/api/laya/training/delete', body: {}, method: 'POST' });
  assert.match(text(f.render()), /已删除 12 条记录/);
  f.saveFailure(true);
  f.button('删除我贡献的数据').props.onClick();
  await nextTurn();
  assert.match(text(f.render()), /删除贡献数据失败/);
  assert.doesNotMatch(text(f.render()), /已删除 12/);
  assert.equal(f.button('删除我贡献的数据').props.disabled, false);
});

test(
  'Laya settings render, save and recover in a hidden Electron window with translations and no network',
  { timeout: 60000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'pugport-laya-settings-')));
    const artifacts = resolve('artifacts/laya-settings');
    await mkdir(artifacts, { recursive: true });
    t.after(async () => {
      assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-laya-settings-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>*,*::before,*::after{transition:none!important;animation:none!important}body{margin:0}.settings-container{max-width:900px;margin:24px auto;padding:0 16px}</style><body><div id="root"></div><script src="fixture.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import '@fontsource-variable/inter';import '@fontsource-variable/noto-sans-sc';import './src/ui/studio.css';import './src/ui/settings.css';
import{LayaSettings}from'./src/ui/LayaSettings';import{LayaFirstUseNotice}from'./src/ui/LayaFirstUseNotice';import{startInterfaceLanguage}from'./src/ui/i18n';import{uiUpdateBlocked}from'./src/ui/ui-update-guard';
localStorage.setItem('comborunner.locale','zh-CN');
const f=window.fixture={calls:[],notices:[],readFailure:false,saveFailure:false,configured:false,view:{settings:{},status:{state:'ready',region:'other',modelVersion:'pugport-laya-v4'},training:{directory:'C:/Synthetic/PugPort/routing-training',recording:true}}};
const api=async(path,body,method='POST')=>{f.calls.push({path,body,method});
if(path==='/api/laya/status'&&method==='GET'){if(f.readFailure)throw Error('synthetic status offline');return structuredClone(f.view);}
if(path==='/api/settings'&&method==='PATCH'){if(f.saveFailure)throw Error('synthetic save offline');Object.assign(f.view.settings,body.laya);f.view.training.recording=f.view.settings.recordTraining!==false;return {laya:structuredClone(f.view.settings)};}
if(path==='/api/jev/status'&&method==='GET')return {configured:f.configured};
if(path==='/api/jev/config'&&method==='PUT'){f.configured=!!body.apiKey;return {configured:f.configured};}
if(path==='/api/laya/training/delete'&&method==='POST')return {deletedCount:12};
if(path==='/api/open-folder')return {};throw Error('Unexpected synthetic API '+method+' '+path);};
window.blocked=uiUpdateBlocked;window.language=async(locale)=>{localStorage.setItem('comborunner.locale',locale);await startInterfaceLanguage();};
function Fixture(){const[section,setSection]=useState('advanced');window.openSection=setSection;return <main className="settings-container"><div className="settings-content"><div className="settings-form"><LayaSettings key={section} section={section} api={api} reload={async()=>{}} notify={notice=>f.notices.push(notice)}/></div></div><LayaFirstUseNotice onOpenSettings={()=>setSection('sharing')}/><form className="conversation-composer"><textarea aria-label="Message" placeholder="Message" rows={3}/></form></main>;}
const root=createRoot(document.getElementById('root'));let revision=0;window.remount=()=>root.render(<Fixture key={revision++}/>);window.remount();
`,
      },
      bundle: true,
      platform: 'browser',
      outfile: join(directory, 'fixture.js'),
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      loader: { '.woff2': 'file' },
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'renderer-local-sources',
          setup(builder) {
            const require = createRequire(import.meta.url);
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.path.startsWith('data:')) return { path: args.path, external: true };
              const directory = args.importer && args.importer !== '<stdin>' ? dirname(args.importer) : process.cwd();
              if (!args.path.startsWith('.') && !isAbsolute(args.path))
                return { path: require.resolve(args.path, { paths: [directory] }), namespace: 'fixture-source' };
              const base = resolve(directory, args.path);
              const path = [
                base,
                ...['.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx', '/index.js'].map(
                  (extension) => base + extension,
                ),
              ].find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
              return path ? { path, namespace: 'fixture-source' } : undefined;
            });
            builder.onLoad({ filter: /.*/, namespace: 'fixture-source' }, (args) => ({
              contents: readFileSync(args.path),
              loader:
                extname(args.path) === '.woff2'
                  ? 'file'
                  : extname(args.path) === '.css'
                    ? 'css'
                    : extname(args.path) === '.json'
                      ? 'json'
                      : extname(args.path) === '.tsx'
                        ? 'tsx'
                        : extname(args.path) === '.ts'
                          ? 'ts'
                          : 'js',
            }));
          },
        },
      ],
    });
    const runner = join(directory, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');const{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{let win;try{win=new BrowserWindow({show:false,width:1050,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
let remote=0;win.webContents.session.webRequest.onBeforeRequest((d,cb)=>{const allowed=d.url.startsWith('file://')||d.url.startsWith('data:');if(!allowed)remote++;cb({cancel:!allowed});});
win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)console.error(event.message);});
await win.loadFile(path.join(__dirname,'index.html'));const read=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error('Renderer step: '+code,{cause:error});}},frame=()=>read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
const click=async selector=>{await read('document.querySelector('+JSON.stringify(selector)+').click()');await frame();};
const button=async label=>{await read('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');await frame();};
const type=async(selector,value)=>{await read('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');await frame();};
const choose=async value=>{await read('(()=>{const el=document.querySelector("select");el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event("change",{bubbles:true}));})()');await frame();};
const shot=async name=>{await frame();await fs.writeFile(path.join(${JSON.stringify(artifacts)},name+'.png'),(await win.webContents.capturePage()).toPNG());};
for(let i=0;i<30;i++){await frame();if(await read('!!document.querySelector("select:not(:disabled)")'))break;}
assert.equal(await read('document.querySelector("select").value'),'cloud');
assert.equal(await read('document.querySelectorAll("[role=note]").length'),1);await shot('cloud-light-zh');
await read('window.language("en")');await frame();assert.doesNotMatch(await read('document.body.textContent'),/[\\u3400-\\u9fff]/);await shot('cloud-light-en');await read('window.language("zh-CN")');await frame();
await choose('local');assert.equal(await read('window.fixture.view.settings.mode'),'local');
assert.equal(await read('document.querySelector("input[type=checkbox]").checked'),true);
assert.equal(await read('document.querySelector(".settings-row-expand").getAttribute("aria-expanded")'),'false');
await read('window.fixture.view.status={state:"starting",modelVersion:"pugport-laya-v4"}');await button('刷新状态');assert.match(await read('document.body.textContent'),/启动中/);
await read('window.fixture.view.status={state:"error",modelVersion:"pugport-laya-v4",reason:"synthetic checkpoint missing"}');await new Promise(r=>setTimeout(r,2200));await frame();assert.match(await read('document.body.textContent'),/出错，已回退/);
await click('input[aria-label="保存本机路由记录，供后续复审和模型训练"]');assert.equal(await read('window.fixture.view.settings.recordTraining'),false);
assert.equal(await read('document.querySelector("input[type=checkbox]").disabled'),false);await click('.settings-row-expand');
await type('[aria-label="Python 可执行文件"]',' C:/Synthetic/python.exe ');await type('[aria-label="Task Router v4 模型文件夹"]',' C:/Synthetic/laya-v4 ');assert.equal(await read('window.blocked()'),true);
await read('window.fixture.saveFailure=true');await button('保存模型配置');assert.match(await read('document.querySelector("[role=alert]").textContent'),/保存失败/);assert.equal(await read('document.querySelector("input[spellcheck=false]").disabled'),false);
await read('window.fixture.saveFailure=false');await button('保存模型配置');assert.equal(await read('window.fixture.view.settings.pythonPath'),'C:/Synthetic/python.exe');assert.equal(await read('window.blocked()'),false);
await button('打开文件夹');assert.deepEqual(await read('window.fixture.calls.at(-1).body'),{kind:'routing-training'});await shot('expanded-fallback-zh');
await read('window.fixture.readFailure=true');await button('刷新状态');assert.match(await read('document.querySelector("[role=alert]").textContent'),/状态失败/);
await read('window.fixture.readFailure=false;window.fixture.view.status={state:"ready",modelVersion:"pugport-laya-v4"}');await button('刷新状态');assert.equal(await read('document.querySelector("[role=alert]")'),null);
await choose('rules');assert.equal(await read('document.querySelector("input[aria-label^=Python]")'),null);
await choose('jev');assert.equal(await read('document.querySelector("input[type=password]").value'),'');await type('input[type=password]','synthetic-jev-key');await button('保存 Jev 密钥');assert.equal(await read('window.fixture.configured'),true);assert.equal(await read('document.querySelector("input[type=password]").value'),'');await shot('jev-light-zh');
await choose('cloud');await button('设置');assert.equal(await read('document.querySelector("[role=note]")'),null);assert.equal(await read('document.querySelector("input[type=checkbox]").checked'),false);
await click('input[type=checkbox]');assert.equal(await read('window.fixture.view.settings.shareTraining'),true);assert.equal(await read('window.fixture.view.settings.recordTraining'),true);await click('input[type=checkbox]');assert.equal(await read('window.fixture.view.settings.shareTraining'),false);await button('删除我贡献的数据');assert.match(await read('document.body.textContent'),/已删除 12 条记录/);
await read('window.fixture.view.status.region="eu";delete window.fixture.view.settings.shareTraining;window.openSection("advanced")');await frame();await read('window.openSection("sharing")');await frame();assert.equal(await read('document.querySelector("input[type=checkbox]").checked'),false);await click('input[type=checkbox]');assert.equal(await read('window.fixture.view.settings.shareTraining'),true);
await read('window.language("en")');await frame();assert.doesNotMatch(await read('document.body.textContent'),/[\\u3400-\\u9fff]/);
win.setSize(430,980);await read('document.documentElement.dataset.theme="dark"');await frame();assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);await shot('sharing-narrow-dark-en');
await read('window.remount()');await frame();assert.equal(await read('document.querySelector("[role=note]")'),null);
assert.equal(remote,0);assert.equal(await read('window.fixture.calls.some(c=>c.path==="/api/settings"&&JSON.stringify(c.body).includes("synthetic-jev-key"))'),false);console.log('PASS Laya renderer: all modes, sharing defaults, deletion count, secret endpoint, once notice, fallback, drafts, translations, narrow layout, zero network/model calls');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(createRequire(import.meta.url)('electron') as string, electronArgs(runner), {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    const timeout = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(code, 0, output);
      assert.match(output, /PASS Laya renderer/);
    } finally {
      clearTimeout(timeout);
    }
  },
);
