import { listenForFetch } from './helpers/fetch-port.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { build } from 'esbuild';
import { finishUiDirectory, writeJsonAtomic } from '../scripts/ui-release.mjs';
import { serveUiReleases, UiReleases, uiReleaseRoutes } from '../src/server/ui-release.ts';
import { electronArgs } from './helpers/electron-app.cjs';

test(
  'real renderer updates without restarting its server and recovers a failed module once',
  { timeout: 45000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-ui-release-browser-')));
    t.after(async () => {
      assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(root).startsWith('pugport-ui-release-browser-'));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const compatibility = 'a'.repeat(64);
    for (const [buildId, previousBuildId] of [
      ['baseline', undefined],
      ['next', 'baseline'],
      ['broken', 'next'],
    ] as const) {
      const directory = join(root, 'dist/ui-releases', buildId);
      await mkdir(join(directory, 'assets'), { recursive: true });
      const main = join(directory, 'assets/main.js');
      if (buildId === 'broken') await writeFile(main, 'import "./missing-entry-dependency.js";');
      else
        await build({
          stdin: {
            loader: 'ts',
            resolveDir: process.cwd(),
            contents: `
import { startUiUpdates } from './src/ui/ui-update';
Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
const interval = window.setInterval.bind(window);
window.setInterval = (callback, delay, ...args) => interval(callback, delay === 10000 ? 30 : delay, ...args);
document.title = ${JSON.stringify(buildId)};
window.fixtureBuild = ${JSON.stringify(buildId)};
startUiUpdates(${JSON.stringify(buildId)}, ${JSON.stringify(compatibility)}, () => {});
window.dispatchEvent(new Event('pugport:ui-ready'));
`,
          },
          platform: 'browser',
          format: 'esm',
          bundle: true,
          outfile: main,
        });
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html><head><title>Loading</title></head><body><script type="module" src="/ui-releases/${buildId}/assets/main.js"></script></body></html>`,
      );
      await finishUiDirectory(directory, { buildId, compatibility, previousBuildId });
    }
    const pointer = join(root, 'dist/ui-releases/active.json');
    await writeJsonAtomic(pointer, { buildId: 'baseline' });
    const app = express();
    const requests: string[] = [];
    let ticks = 0;
    const task = setInterval(() => ticks++, 10);
    t.after(() => clearInterval(task));
    app.use((req, res, next) => {
      requests.push(`${req.method} ${req.path}`);
      if (req.method === 'POST' && req.headers['x-agent-token'] !== 'fixture-token') res.sendStatus(403);
      else next();
    });
    app.use(express.json());
    app.get('/api/session', (_req, res) => res.json({ token: 'fixture-token' }));
    app.get('/api/fixture-state', (_req, res) => res.json({ pid: process.pid, task: 'synthetic-running', ticks }));
    const releases = new UiReleases(root, compatibility, 'baseline');
    uiReleaseRoutes(app, releases);
    serveUiReleases(app, releases);
    const server = createServer(app);
    await listenForFetch(server);
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runner = join(root, 'runner.cjs');
    await writeFile(
      runner,
      `
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const base=${JSON.stringify(base)},pointer=${JSON.stringify(pointer)};
app.whenReady().then(async()=>{let window;try{
window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
let external=0;window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const cancel=!details.url.startsWith(base+'/');if(cancel)external++;callback({cancel});});
const read=code=>window.webContents.executeJavaScript(code);
const wait=async(code)=>{for(let attempt=0;attempt<160;attempt++){await new Promise(resolve=>setTimeout(resolve,50));try{if(await read(code))return;}catch{}}throw Error('Renderer condition not met: '+code);};
const activate=async(buildId)=>{const temp=pointer+'.fixture';await fs.writeFile(temp,JSON.stringify({buildId}));await fs.rename(temp,pointer);};
await window.loadURL(base+'/');await wait('window.fixtureBuild === "baseline"');
const before=await read('fetch("/api/fixture-state").then(r=>r.json())');
await activate('next');await wait('window.fixtureBuild === "next"');
assert.equal(new URL(window.webContents.getURL()).search,'?uiBuild=next');
const after=await read('fetch("/api/fixture-state").then(r=>r.json())');
assert.equal(after.pid,before.pid);assert.equal(after.task,'synthetic-running');assert.ok(after.ticks>before.ticks);
await activate('broken');await wait('window.fixtureBuild === "next" && JSON.parse(sessionStorage.getItem("pugport-ui-failed-builds") || "[]").includes("broken")');
assert.equal(new URL(window.webContents.getURL()).search,'?uiBuild=next');
await new Promise(resolve=>setTimeout(resolve,2500));
assert.equal(await read('window.fixtureBuild'),'next');
assert.deepEqual(await read('JSON.parse(sessionStorage.getItem("pugport-ui-failed-builds"))'),['broken']);
const recovered=await read('fetch("/api/fixture-state").then(r=>r.json())');
assert.equal(recovered.pid,before.pid);assert.equal(recovered.task,'synthetic-running');assert.ok(recovered.ticks>after.ticks);assert.equal(external,0);
console.log('PASS live renderer activation, unchanged server PID and running task, failed module fallback, rejected-build loop protection');
}catch(error){console.error(error);process.exitCode=1;}finally{window?.destroy();app.exit(process.exitCode||0);}});
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron') as string,
      electronArgs(runner),
      {
        env,
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 35000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.match(result.stdout, /PASS live renderer activation/);
    assert.equal(requests.filter((request) => request === 'POST /api/ui-release/fallback').length, 1);
    assert.equal(requests.filter((request) => request === 'GET /api/session').length, 1);
    assert.equal(
      requests.filter((request) => request === 'GET /ui-releases/broken/assets/missing-entry-dependency.js').length,
      1,
    );
    assert.equal(
      JSON.parse(await readFile(pointer, 'utf8')).buildId,
      'broken',
      'fallback affects only the failed window',
    );
  },
);
