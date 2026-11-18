import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { OwnedBackend } from '../src/electron/backend.ts';
import { createPosixBackendGuard } from '../src/electron/posix-backend-guard.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(check: () => boolean) {
  const until = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= until) throw Error('Synthetic process observation timed out');
    await new Promise((done) => setTimeout(done, 20));
  }
}
const helperScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
const commandScript = `const {spawn}=require('node:child_process');
const helper=spawn(process.execPath,['-e',${JSON.stringify(helperScript)}],{stdio:'ignore'});
helper.once('spawn',()=>console.log(JSON.stringify({command:process.pid,helper:helper.pid})));
process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);`;

for (const mode of ['forced-stop', 'crash-recovery', 'normal-cancellation'] as const)
  test(
    `POSIX ${mode} confirms task and descendant exit before completion`,
    { skip: process.platform === 'win32', timeout: 25000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pugport-posix-test-'));
      const fixture = join(directory, 'backend.mts');
      await writeFile(
        fixture,
        `
import {waitForPosixContainment} from ${moduleUrl('../src/server/backend-bootstrap.ts')};
import {spawnTarget,terminateProcess} from ${moduleUrl('../src/server/adapters/process.ts')};
import {APP_NAME,APP_VERSION} from ${moduleUrl('../src/shared/identity.ts')};
await waitForPosixContainment(process);
let task;
if(process.env.FIRST==='1') {
  task=await spawnTarget({id:'synthetic',provider:'codex',label:'Synthetic',environment:'native',enabled:true,command:process.execPath},['-e',${JSON.stringify(commandScript)}]);
  let output='';
  await new Promise(done=>task.stdout.on('data',bytes=>{output+=bytes.toString();if(output.includes('\\n'))done()}));
  process.send({type:'probe',...JSON.parse(output.trim()),wrapper:task.pid,path:process.env.PUGPORT_POSIX_GUARD_SOCKET});
}
process.on('message',async value=>{
  if(value.type==='cancel'&&task){
    try {await terminateProcess(task);process.send({type:'cancelled',signal:task.signalCode});}
    catch(error){process.send({type:'cancel-failed',error:error.message});}
  }
});
process.send({type:'ready',name:APP_NAME,version:APP_VERSION,port:54329,dataDir:process.env.COMBORUNNER_DATA_DIR});
setInterval(()=>{},1000);
`,
      );
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      await once(unrelated, 'spawn');
      let first: ChildProcess | undefined;
      let launches = 0;
      let cancelled = false;
      let cancellationError: string | undefined;
      let cancellationSignal: string | undefined;
      let diagnostic = '';
      let probe: { command: number; helper: number; wrapper: number; path: string } | undefined;
      const backend = new OwnedBackend({
        root,
        dataDir: directory,
        port: 54329,
        startupMs: 10000,
        shutdownMs: 40,
        killMs: 5000,
        restartBackoffMs: 10,
        guard: createPosixBackendGuard,
        launch: (env) => {
          const child = fork(fixture, [], {
            execPath: process.execPath,
            execArgv: ['--import', 'tsx'],
            cwd: root,
            env: { ...env, FIRST: String(++launches === 1 ? 1 : 0) },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          });
          first ??= child;
          child.stderr?.on('data', (bytes) => {
            diagnostic = (diagnostic + bytes.toString()).slice(-4000);
          });
          child.once('exit', (code, signal) => {
            diagnostic += `\nbackend exit ${code} ${signal}`;
          });
          child.on('message', (input) => {
            const value = input as typeof probe & { type?: string; signal?: string; error?: string };
            if (value?.type === 'probe') probe = value;
            if (value?.type === 'cancelled') {
              cancellationSignal = value.signal;
              cancelled = true;
            }
            if (value?.type === 'cancel-failed') cancellationError = value.error;
          });
          return child;
        },
      });
      try {
        await backend.start();
        assert.ok(probe);
        assert.ok(alive(probe.command) && alive(probe.helper));
        for (const packet of ['null', '[]', JSON.stringify({ pid: unrelated.pid, token: 'wrong' })]) {
          const impostor = connect(probe.path);
          impostor.on('error', () => {});
          impostor.once('connect', () => impostor.write(packet + '\n'));
          await once(impostor, 'close');
        }
        if (mode === 'crash-recovery') {
          const exited = once(first!, 'exit');
          first!.kill('SIGKILL');
          await exited;
          await backend.start();
          assert.equal(launches, 2);
          assert.equal(backend.state.phase, 'ready');
        } else if (mode === 'normal-cancellation') {
          first!.send({ type: 'cancel' });
          await waitFor(() => cancelled || cancellationError !== undefined).catch((error: Error) => {
            throw new Error(`${error.message}; ${diagnostic}`);
          });
          assert.equal(cancellationError, undefined, diagnostic);
          assert.equal(cancellationSignal, 'SIGKILL');
        } else {
          await backend.stop();
          assert.equal(backend.state.phase, 'stopped');
        }
        assert.equal(alive(probe.command), false, 'command is gone before completion');
        assert.equal(alive(probe.helper), false, 'descendant is gone before completion');
        assert.equal(alive(probe.wrapper), false, 'group anchor is gone before completion');
        assert.equal(alive(unrelated.pid!), true, 'unrelated child survives');
        await backend.stop();
        await assert.rejects(access(probe.path), { code: 'ENOENT' });
      } finally {
        await backend.stop().catch(() => {});
        if (probe?.wrapper && alive(probe.wrapper)) process.kill(-probe.wrapper, 'SIGKILL');
        const exited = once(unrelated, 'exit');
        unrelated.kill('SIGKILL');
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

for (const execPath of [
  process.execPath,
  ...(process.platform === 'darwin'
    ? [join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')]
    : []),
])
  test(
    `POSIX guarded commands preserve stdout, stderr, exit codes and spawn errors under ${execPath === process.execPath ? 'Node' : 'Electron'}`,
    { skip: process.platform === 'win32', timeout: 25000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pugport-posix-result-'));
      const fixture = join(directory, 'backend.mts');
      await writeFile(
        fixture,
        `
import {once} from 'node:events';
import {waitForPosixContainment} from ${moduleUrl('../src/server/backend-bootstrap.ts')};
import {spawnPosixTask} from ${moduleUrl('../src/server/platform/posix-task.ts')};
await waitForPosixContainment(process);
const results=[];
for(const code of [0,7]) {
 const task=spawnPosixTask(process.execPath,['-e',"process.stdout.write('output');process.stderr.write('diagnostic');process.exit("+code+")"],{});
 let stdout='',stderr='';task.stdout.on('data',b=>stdout+=b);task.stderr.on('data',b=>stderr+=b);
 await once(task,'close');results.push({code:task.exitCode,signal:task.signalCode,stdout,stderr});
}
const missing=spawnPosixTask('/nonexistent/pugport-test-command',[],{});
const [error]=await once(missing,'error');
await new Promise(done=>missing.once('close',done));
process.send({type:'results',results,error:error.code});process.disconnect();
`,
      );
      const child = fork(fixture, [], {
        execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: ['--import', 'tsx'],
        cwd: root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      const guard = createPosixBackendGuard(child);
      try {
        const [message] = await once(child, 'message').then(async (first) => {
          if ((first[0] as { type?: string }).type === 'results') return first;
          while (true) {
            const next = await once(child, 'message');
            if ((next[0] as { type?: string }).type === 'results') return next;
          }
        });
        assert.deepEqual(message, {
          type: 'results',
          results: [0, 7].map((code) => ({ code, signal: null, stdout: 'output', stderr: 'diagnostic' })),
          error: 'ENOENT',
        });
        await guard.closed;
      } finally {
        await guard.terminate().catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

test(
  'owner dying before desktop registration acknowledgement never starts the command',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const directory = await mkdtemp('/tmp/pugport-guard-test-');
    const path = join(directory, 'tasks.sock');
    const marker = join(directory, 'command-ran');
    const fixture = join(directory, 'owner.mts');
    let wrapper = 0;
    const server = createServer((socket) =>
      socket.once('data', (bytes) => {
        wrapper = JSON.parse(bytes.toString()).pid;
      }),
    );
    await new Promise<void>((done) => server.listen(path, done));
    await writeFile(
      fixture,
      `
import {spawnPosixTask} from ${moduleUrl('../src/server/platform/posix-task.ts')};
const task=spawnPosixTask(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`)}],{});
task.on('error',()=>{});
setInterval(()=>{},1000);
`,
    );
    const owner = fork(fixture, [], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      cwd: root,
      env: { ...process.env, PUGPORT_POSIX_GUARD_SOCKET: path, PUGPORT_POSIX_GUARD_TOKEN: 'a'.repeat(32) },
      stdio: 'ignore',
    });
    try {
      await waitFor(() => wrapper > 0);
      const exited = once(owner, 'exit');
      owner.kill('SIGKILL');
      await exited;
      await waitFor(() => !alive(wrapper));
      await assert.rejects(access(marker), { code: 'ENOENT' });
    } finally {
      owner.kill('SIGKILL');
      if (wrapper && alive(wrapper)) process.kill(-wrapper, 'SIGKILL');
      server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'stopping POSIX containment before bootstrap leaves no child or pending startup',
  { skip: process.platform === 'win32', timeout: 10000 },
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const guard = createPosixBackendGuard(child);
    const rejected = assert.rejects(guard.ready, /取消/);
    try {
      await guard.terminate();
      await rejected;
      await guard.closed;
      assert.equal(alive(child.pid!), false);
    } finally {
      child.kill('SIGKILL');
    }
  },
);

test(
  'a claimed PID with no live group anchor fails cleanup closed without signalling the unrelated process',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pugport-posix-unrelated-'));
    const fixture = join(directory, 'backend.mts');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    await once(unrelated, 'spawn');
    await writeFile(
      fixture,
      `
import {connect} from 'node:net';
import {waitForPosixContainment} from ${moduleUrl('../src/server/backend-bootstrap.ts')};
await waitForPosixContainment(process);
const socket=connect(process.env.PUGPORT_POSIX_GUARD_SOCKET);
socket.on('error',()=>{});
socket.once('connect',()=>socket.write(JSON.stringify({pid:${unrelated.pid},token:process.env.PUGPORT_POSIX_GUARD_TOKEN})+'\\n'));
socket.once('data',()=>{socket.end();process.send({type:'registered'});});
setInterval(()=>{},1000);
`,
    );
    const child = fork(fixture, [], {
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const guard = createPosixBackendGuard(child);
    try {
      await guard.ready;
      await new Promise<void>((done) =>
        child.on('message', (value) => {
          if ((value as { type?: string }).type === 'registered') done();
        }),
      );
      await assert.rejects(guard.terminate(), /未停止/);
      await assert.rejects(guard.closed, /未停止/);
      assert.equal(alive(unrelated.pid!), true);
    } finally {
      child.kill('SIGKILL');
      const exited = once(unrelated, 'exit');
      unrelated.kill('SIGKILL');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
