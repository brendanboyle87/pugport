import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import test, { type TestContext } from 'node:test';
import { ProjectCliContextService } from '../src/server/project-cli-context.ts';
import type { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { TargetSpawnOptions } from '../src/server/adapters/process.ts';
import type { ProjectCliContextUpdate } from '../src/shared/project-cli-context.ts';
import { electronArgs } from './helpers/electron-app.cjs';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  closed = false;
  finish(code: number) {
    this.exitCode = code;
    this.closed = true;
    this.emit('close', code);
  }
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-project-context-')));
  t.after(async () => {
    assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(root).startsWith('pugport-project-context-'));
    await rm(root, { recursive: true, force: true });
  });
  const records = new Map<string, unknown>();
  records.set('project:p', { id: 'p', path: root, scope: 'project' });
  records.set('project:q', { id: 'q', path: root, scope: 'project' });
  records.set('project:chat', { id: 'chat', path: root, scope: 'chat' });
  const store = {
    get: <T>(kind: string, id: string) => structuredClone(records.get(`${kind}:${id}`)) as T | undefined,
    save: (kind: string, id: string, _owner: string, value: unknown) => {
      records.set(`${kind}:${id}`, structuredClone(value));
    },
  } as Pick<WorkspaceStore, 'get' | 'save'>;
  const calls: { args: string[]; options: TargetSpawnOptions; child: FakeChild }[] = [];
  const terminated: FakeChild[] = [];
  let launch: ((child: FakeChild) => Promise<void>) | undefined;
  const service = new ProjectCliContextService(store, {
    launch: async (args, options) => {
      const child = new FakeChild();
      calls.push({ args, options, child });
      await launch?.(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    terminate: async (child) => {
      const fake = child as unknown as FakeChild;
      terminated.push(fake);
      if (!fake.closed) fake.finish(255);
    },
  });
  const input: ProjectCliContextUpdate = {
    revision: 0,
    autoMemoryDirectory: null,
    sshQueries: [
      { name: 'status', host: 'saved-alias', argv: ['printf', '%s', "$(no-execution); a'b"], timeoutSeconds: 1 },
    ],
  };
  const tick = () => new Promise<void>((done) => setImmediate(done));
  return {
    root,
    records,
    store,
    calls,
    terminated,
    service,
    input,
    tick,
    setLaunch: (value: typeof launch) => {
      launch = value;
    },
  };
}

test('project context requires explicit UI authorization and validates directory identity without reading settings', async (t) => {
  const f = await fixture(t),
    memory = join(f.root, 'memory');
  await mkdir(memory);
  await writeFile(join(memory, 'settings.local.json'), '{"env":{"NEVER_READ":"private"},"hooks":"never execute"}');
  await assert.rejects(
    f.service.update('p', { ...f.input, autoMemoryDirectory: memory }, { source: 'agent' } as never),
    /只能由用户/,
  );
  await assert.rejects(f.service.update('chat', f.input, { source: 'user' }), /仍存在的项目/);
  await assert.rejects(f.service.update('missing', f.input, { source: 'user' }), /仍存在的项目/);
  const saved = await f.service.update('p', { ...f.input, autoMemoryDirectory: memory }, { source: 'user' });
  assert.equal(saved.autoMemoryDirectory, await realpath(memory));
  assert.equal(await f.service.memoryDirectory('p'), await realpath(memory));
  assert.equal(JSON.stringify([...f.records.values()]).includes('NEVER_READ'), false);
  assert.equal(f.calls.length, 0);
  await rename(memory, join(f.root, 'original-memory'));
  await mkdir(memory);
  await assert.rejects(f.service.memoryDirectory('p'), /已移除或改变/);
  await f.service.update('p', { ...f.input, revision: saved.revision }, { source: 'user' });
  assert.equal(await f.service.memoryDirectory('p'), undefined);
});

test('project context rejects stale simultaneous writes, unknown settings and unsafe query declarations', async (t) => {
  const f = await fixture(t),
    memory = join(f.root, 'memory');
  await mkdir(memory);
  const results = await Promise.allSettled(
    [1, 2].map(() => f.service.update('p', { ...f.input, autoMemoryDirectory: memory }, { source: 'user' })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await assert.rejects(
    f.service.update('q', { ...f.input, env: { SECRET: 'forbidden' } } as never, { source: 'user' }),
    /配置无效/,
  );
  for (const patch of [
    { host: '-oProxyCommand=bad' },
    { host: 'user@host' },
    { argv: ['echo', 'line\ncommand'] },
    { name: '../run' },
    { timeoutSeconds: 121 },
    { command: 'not an allowed field' },
  ])
    await assert.rejects(
      f.service.update('q', { ...f.input, sshQueries: [{ ...f.input.sshQueries[0]!, ...patch }] }, { source: 'user' }),
    );
  const pending = f.service.update('q', { ...f.input, autoMemoryDirectory: memory }, { source: 'user' });
  f.records.set('project:q', { id: 'q', path: f.root, scope: 'chat' });
  await assert.rejects(pending, /仍存在的项目/);
  assert.equal(f.records.has('project-cli-context:q'), false);
});

test('remote queries use only the saved name, literal argv, existing host trust and redacted bounded output', async (t) => {
  const f = await fixture(t);
  await f.service.update('p', f.input, { source: 'user' });
  assert.deepEqual(f.service.listQueries('p'), f.input.sshQueries);
  await assert.rejects(f.service.runQuery('q', 'status'), /没有获得/);
  await assert.rejects(f.service.runQuery('p', 'unknown'), /没有获得/);
  const pending = f.service.runQuery('p', 'status');
  await f.tick();
  const call = f.calls[0]!;
  for (const setting of [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'UpdateHostKeys=no',
    'ForwardAgent=no',
    'ClearAllForwardings=yes',
    'ControlMaster=no',
    'ControlPath=none',
    'PermitLocalCommand=no',
    'ProxyCommand=none',
    'KnownHostsCommand=none',
  ])
    assert.ok(call.args.includes(setting));
  assert.deepEqual(call.args.slice(-3), ['--', 'saved-alias', "'printf' '%s' '$(no-execution); a'\\''b'"]);
  assert.equal(call.options.cwd, f.root);
  assert.equal(call.child.stdin.writableEnded, true);
  call.child.stdout.write('state=ok password=very');
  call.child.stdout.write('secret token=another-secret\n');
  call.child.stderr.write('-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-payload\n-----END OPENSSH PRIVATE KEY-----');
  call.child.finish(0);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.match(result.stdout, /state=ok/);
  assert.doesNotMatch(result.stdout, /verysecret|another-secret/);
  assert.doesNotMatch(result.stderr, /private-payload/);
  assert.ok(f.terminated.includes(call.child));
});

test('remote cancellation covers pending launch and config revocation without leaving a busy project', async (t) => {
  const f = await fixture(t);
  await f.service.update('p', f.input, { source: 'user' });
  const aborted = await f.service.runQuery('p', 'status', AbortSignal.abort());
  assert.equal(aborted.status, 'cancelled');
  assert.equal(f.calls.length, 0);
  let release!: () => void;
  f.setLaunch(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const controller = new AbortController(),
    pending = f.service.runQuery('p', 'status', controller.signal);
  await f.tick();
  await assert.rejects(f.service.runQuery('p', 'status'), /已有远程查询/);
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  await assert.rejects(f.service.runQuery('p', 'status'), /已有远程查询/);
  release();
  await f.tick();
  assert.ok(f.terminated.includes(f.calls[0]!.child));
  f.setLaunch(undefined);
  const second = f.service.runQuery('p', 'status');
  await f.tick();
  await f.service.update('p', { ...f.input, revision: 1, sshQueries: [] }, { source: 'user' });
  const result = await second;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.remoteMayContinue, true);
  await assert.rejects(f.service.runQuery('p', 'status'), /没有获得/);
});

test('remote queries stop at the combined output limit and timeout with truthful remote continuation status', async (t) => {
  const f = await fixture(t);
  await f.service.update('p', f.input, { source: 'user' });
  const flood = f.service.runQuery('p', 'status');
  await f.tick();
  f.calls[0]!.child.stdout.write(Buffer.alloc(256 * 1024 + 1, 65));
  const exceeded = await flood;
  assert.equal(exceeded.status, 'output-limit');
  assert.equal(exceeded.remoteMayContinue, true);
  assert.ok(exceeded.stdout.length <= 256 * 1024);
  const timeout = await f.service.runQuery('p', 'status');
  assert.equal(timeout.status, 'timed-out');
  assert.equal(timeout.remoteMayContinue, true);
  assert.ok(f.terminated.includes(f.calls[1]!.child));
});

test('closing project context rejects new queries and waits for pending owned launch cleanup', async (t) => {
  const f = await fixture(t);
  await f.service.update('p', f.input, { source: 'user' });
  let release!: () => void;
  f.setLaunch(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const run = f.service.runQuery('p', 'status');
  await f.tick();
  let closed = false;
  const closing = f.service.close();
  assert.equal(f.service.close(), closing);
  void closing.then(() => {
    closed = true;
  });
  assert.equal((await run).status, 'cancelled');
  await f.tick();
  assert.equal(closed, false);
  await assert.rejects(f.service.runQuery('p', 'status'), /正在关闭/);
  release();
  await closing;
  assert.equal(closed, true);
  assert.equal(f.calls.length, 1);
  assert.ok(f.terminated.includes(f.calls[0]!.child));
});

test(
  'project context shutdown has a bounded failure while retaining cleanup of a late launcher',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.service.update('p', f.input, { source: 'user' });
    let release!: () => void;
    f.setLaunch(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const run = f.service.runQuery('p', 'status');
    await f.tick();
    const closing = f.service.close();
    assert.equal((await run).status, 'cancelled');
    await assert.rejects(closing, /清理尚未完成/);
    await assert.rejects(f.service.runQuery('p', 'status'), /正在关闭/);
    release();
    await f.tick();
    assert.ok(f.terminated.includes(f.calls[0]!.child));
  },
);

test(
  'project context renderer preserves drafts and isolates late saves and folder choices by project',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.root, 'home'));
    await build({
      stdin: {
        loader: 'tsx',
        resolveDir: process.cwd(),
        contents: String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import {ProjectCliContext} from './src/ui/ProjectCliContext'; import {uiUpdateBlocked} from './src/ui/ui-update-guard';
import './src/ui/studio.css'; import './src/ui/settings.css';
const f=window.fixture={calls:[],errors:[],notices:[],project:'p',blocked:uiUpdateBlocked};
window.addEventListener('error',e=>f.errors.push(e.message));window.addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason)));
window.fetch=()=>{throw Error('No real fetch');}; window.comboRunnerDesktop={pickDirectory:()=>new Promise(resolve=>f.finishPicker=resolve)};
const data={p:{projectId:'p',revision:4,autoMemoryDirectory:'C:/synthetic/project-p-memory',sshQueries:[{name:'status',host:'saved-host',argv:['systemctl','is-active','service'],timeoutSeconds:30}]},q:{projectId:'q',revision:0,sshQueries:[]}};
const api=async(path,body,method)=>{const id=path.split('/')[3];f.calls.push({path,body:structuredClone(body),method});if(method==='PUT'){if(f.defer){f.defer=false;await new Promise(resolve=>f.finishSave=resolve);}if(f.fail){f.fail=false;throw Error('配置已被其他窗口更新，请重新载入后再保存。');}data[id]={projectId:id,revision:body.revision+1,autoMemoryDirectory:body.autoMemoryDirectory||undefined,sshQueries:body.sshQueries};}return structuredClone(data[id]);};
const root=createRoot(document.getElementById('root'));f.render=id=>{f.project=id;flushSync(()=>root.render(<ProjectCliContext projectId={id} api={api} notify={notice=>f.notices.push(notice)}/>));};f.render('p');`,
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: join(f.root, 'ui.js'),
      loader: { '.woff2': 'dataurl', '.png': 'dataurl' },
    });
    await writeFile(
      join(f.root, 'index.html'),
      '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{padding:24px;max-width:850px}fieldset{border:0;padding:16px}label{display:block;margin:12px 0}input,textarea{display:block;width:100%}.button-row{display:flex;gap:8px}</style><div id="root"></div><script src="ui.js"></script></html>',
    );
    const artifact = resolve('artifacts/project-cli-context');
    await mkdir(artifact, { recursive: true });
    await writeFile(
      join(f.root, 'runner.cjs'),
      `
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');const{app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();let win;
app.whenReady().then(async()=>{try{
win=new BrowserWindow({show:false,width:1000,height:1000,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
win.webContents.session.webRequest.onBeforeRequest((request,done)=>done({cancel:!request.url.startsWith('file:')&&!request.url.startsWith('data:')}));
await win.loadFile(path.join(__dirname,'index.html'));const js=code=>win.webContents.executeJavaScript(code);
const wait=async code=>{const end=Date.now()+15000;while(Date.now()<end){if(await js(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Condition timed out: '+code)};
const click=async text=>{await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes('+JSON.stringify(text)+')).click()');};
const input=async value=>{await js('(()=>{const i=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,'+JSON.stringify(value)+');i.dispatchEvent(new Event("input",{bubbles:true}));})()');await new Promise(r=>setTimeout(r,30));};
await wait('document.querySelector("input")?.value.includes("project-p-memory")');assert.equal(await js('window.fixture.blocked()'),false);
await input('C:/synthetic/changed');assert.equal(await js('window.fixture.blocked()'),true);
await js('window.fixture.defer=true');await click('授权并保存');await wait('!!window.fixture.finishSave');assert.equal(await js('document.querySelector("fieldset").disabled'),true);
await js('window.fixture.render("q")');await wait('document.querySelector("input")?.value===""');await js('window.fixture.finishSave()');await wait('!document.querySelector("fieldset").disabled');assert.equal(await js('document.querySelector("input").value'),'');
await click('选择文件夹');await wait('!!window.fixture.finishPicker');await js('window.fixture.render("p")');await wait('document.querySelector("input")?.value==="C:/synthetic/changed"');await js('window.fixture.finishPicker("C:/wrong-project")');await wait('!document.querySelector("fieldset").disabled');assert.equal(await js('document.querySelector("input").value'),'C:/synthetic/changed');
await input('C:/synthetic/keep-draft');await js('window.fixture.fail=true');await click('授权并保存');await wait('!!document.querySelector("[role=alert]")');assert.equal(await js('document.querySelector("input").value'),'C:/synthetic/keep-draft');assert.equal(await js('window.fixture.blocked()'),true);
await click('丢弃草稿并重新载入');await wait('document.querySelector("input")?.value==="C:/synthetic/changed"');assert.equal(await js('window.fixture.blocked()'),false);
assert.equal(await js('window.fixture.calls.filter(c=>c.method==="PUT").length'),2);assert.equal(await js('window.fixture.calls.some(c=>c.method==="PUT"&&c.path.includes("/q/"))'),false);assert.deepEqual(await js('window.fixture.errors'),[]);
await fs.writeFile(${JSON.stringify(join(artifact, 'project-context.png'))},(await win.webContents.capturePage()).toPNG());console.log('PASS project context renderer');app.exit(0);
}catch(error){console.error(error);app.exit(1)}});setTimeout(()=>app.exit(2),45000).unref();`,
    );
    const env: NodeJS.ProcessEnv = {
      HOME: join(f.root, 'home'),
      USERPROFILE: join(f.root, 'home'),
      PUGPORT_UNDER_TEST: '1',
    };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'XAUTHORITY'])
      if (process.env[key]) env[key] = process.env[key];
    const result = await promisify(execFile)(electron as unknown as string, electronArgs(join(f.root, 'runner.cjs')), {
      env,
      windowsHide: true,
      timeout: 50000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /PASS project context renderer/);
    assert.doesNotMatch(result.stderr, /AssertionError|TypeError|ReferenceError/);
  },
);
