import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { createWindowsBackendGuard, windowsBackendGuardScript } from '../src/electron/windows-backend-guard.ts';
import { waitForBackendContainment } from '../src/server/backend-bootstrap.ts';

const nonce = '0123456789abcdef0123456789abcdef';
const birth = '134042592000000000';
class FakeProcess extends EventEmitter {
  pid = 111;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = 0;
  messages: unknown[] = [];
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  handle() {
    return this as unknown as ChildProcess;
  }
  send(value: unknown, callback?: (error?: Error) => void) {
    this.messages.push(value);
    callback?.();
  }
  kill() {
    this.killed++;
    this.exitCode = 1;
    this.connected = false;
    this.emit('exit', 1, null);
    this.emit('close', 1, null);
    return true;
  }
}
function fixture() {
  const backend = new FakeProcess(),
    helper = new FakeProcess();
  const commands: string[] = [];
  helper.stdin.on('data', (bytes) => commands.push(bytes.toString()));
  let launches = 0;
  const guard = createWindowsBackendGuard(backend.handle(), {
    nonce,
    startupMs: 100,
    launch: () => {
      launches++;
      return helper.handle();
    },
  });
  const emit = (type: string, other = {}) =>
    helper.stdout.write(JSON.stringify({ type, pid: 111, nonce, birth, active: 0, ...other }) + '\n');
  const opened = () => {
    backend.emit('message', { type: 'containment-bootstrap' });
    emit('opened');
  };
  const contained = () => {
    opened();
    backend.emit('message', { type: 'containment-challenge-ack', nonce, birth });
    emit('contained');
  };
  const cleaned = () => {
    emit('cleaned');
    helper.exitCode = 0;
    helper.emit('close', 0, null);
  };
  return { backend, helper, guard, commands, emit, opened, contained, cleaned, launches: () => launches };
}

test('bootstrap loads no service until a valid original IPC challenge and containment release', async () => {
  const process = new FakeProcess();
  const waiting = waitForBackendContainment(process as unknown as Parameters<typeof waitForBackendContainment>[0], 100);
  assert.deepEqual(process.messages, [{ type: 'containment-bootstrap' }]);
  process.emit('message', { type: 'containment-go', nonce });
  let done = false;
  void waiting.then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  process.emit('message', { type: 'containment-challenge', nonce, birth });
  assert.deepEqual(process.messages.at(-1), { type: 'containment-challenge-ack', nonce, birth });
  process.emit('message', { type: 'containment-go', nonce: 'f'.repeat(32) });
  await Promise.resolve();
  assert.equal(done, false);
  process.emit('message', { type: 'containment-go', nonce });
  await waiting;
  assert.equal(done, true);
  assert.equal(process.listenerCount('message'), 0);
});

test('bootstrap timeout and loss of the original desktop connection never release the service', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const process = new FakeProcess();
  const timeout = waitForBackendContainment(process as unknown as Parameters<typeof waitForBackendContainment>[0], 50);
  const rejected = assert.rejects(timeout, /保护启动超时/);
  t.mock.timers.tick(50);
  await rejected;
  const disconnected = waitForBackendContainment(
    process as unknown as Parameters<typeof waitForBackendContainment>[0],
    50,
  );
  process.emit('disconnect');
  await assert.rejects(disconnected, /桌面连接已关闭/);
  assert.equal(process.listenerCount('message'), 0);
});

test('guard challenges the original fork using held-handle birth identity before it assigns the job', async () => {
  const f = fixture();
  f.opened();
  assert.equal(f.launches(), 1);
  assert.deepEqual(f.backend.messages, [{ type: 'containment-challenge', nonce, birth }]);
  assert.deepEqual(f.commands, []);
  f.backend.emit('message', { type: 'containment-challenge-ack', nonce, birth });
  assert.deepEqual(f.commands, ['assign:' + nonce + ':' + birth + '\n']);
  f.emit('contained');
  await f.guard.ready;
  assert.deepEqual(f.backend.messages.at(-1), { type: 'containment-go', nonce });
  let closed = false;
  void f.guard.closed.then(() => (closed = true));
  f.emit('cleaned');
  await Promise.resolve();
  assert.equal(closed, false, 'zero job count alone does not leave a live helper');
  f.helper.exitCode = 0;
  f.helper.emit('close', 0, null);
  await f.guard.closed;
  assert.equal(closed, true);
});

test('reused identity, malformed helper replies and timeout fail closed without releasing the bootstrap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const kind of ['identity', 'pid', 'malformed', 'null', 'primitive', 'array', 'timeout']) {
    const f = fixture();
    f.opened();
    const rejected = assert.rejects(f.guard.ready, /保护或子进程清理未完成/);
    if (kind === 'identity')
      f.backend.emit('message', { type: 'containment-challenge-ack', nonce, birth: '99999999999999999' });
    if (kind === 'pid') f.emit('contained', { pid: 999 });
    if (kind === 'malformed') f.helper.stdout.write('not-json\n');
    if (kind === 'null') f.helper.stdout.write('null\n');
    if (kind === 'primitive') f.helper.stdout.write('1\n');
    if (kind === 'array') f.helper.stdout.write('[]\n');
    if (kind === 'timeout') t.mock.timers.tick(100);
    await rejected;
    await assert.rejects(f.guard.closed);
    assert.equal(
      f.backend.messages.some((value: any) => value.type === 'containment-go'),
      false,
    );
    assert.equal(f.helper.killed, 1);
    assert.equal(f.backend.killed, 1);
  }
});

test('guardian failure after assignment rejects cleanup and termination needs zero-active-process confirmation', async () => {
  const bad = fixture();
  bad.contained();
  await bad.guard.ready;
  bad.helper.emit('close', 1, null);
  await assert.rejects(bad.guard.closed, /保护或子进程清理未完成/);
  const f = fixture();
  f.contained();
  await f.guard.ready;
  const terminating = f.guard.terminate();
  assert.equal(f.commands.at(-1), 'terminate\n');
  f.cleaned();
  await terminating;
  assert.equal(f.helper.killed, 0);
});

test('the guardian uses an unnamed kill-on-close job with no breakaway flags and validates launch values', () => {
  const script = windowsBackendGuardScript(111, 222, nonce);
  assert.match(script, /limits.Basic.Flags=0x2000/);
  assert.match(script, /CreateJobObject\(IntPtr.Zero,null\)/);
  assert.match(script, /AssignProcessToJobObject\(job,root\)/);
  assert.match(script, /accounting.ActiveProcesses==0/);
  assert.doesNotMatch(script, /Get-CimInstance|Win32_Process|BREAKAWAY_OK/);
  assert.throws(() => windowsBackendGuardScript(0, 222, nonce));
  assert.throws(() => windowsBackendGuardScript(111, 222, "' ; arbitrary"));
});

for (const cause of ['backend-crash', 'guardian-crash'])
  test(
    'native Windows actual bootstrap containment clears descendants on ' +
      cause +
      ' and preserves an unrelated process',
    { skip: process.platform !== 'win32', timeout: 50000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'pugport-job-guard-native-'));
      let backend: ChildProcess | undefined, unrelated: ChildProcess | undefined, guardian: ChildProcess | undefined;
      try {
        const file = join(directory, 'bootstrap.mjs');
        await (
          await import('esbuild')
        ).build({
          entryPoints: ['src/server/bootstrap.ts'],
          bundle: true,
          platform: 'node',
          format: 'esm',
          external: ['./main.js'],
          target: 'node24',
          outfile: file,
        });
        await writeFile(
          join(directory, 'main.js'),
          `const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e',\"const {spawn}=require('node:child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(grand.pid);setInterval(()=>{},1000);\"],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  child.stdout.once('data',bytes=>process.send({type:'descendants',child:child.pid,grandchild:Number(bytes.toString().trim())}));
setInterval(()=>{},1000);`,
        );
        backend = fork(file, [], {
          windowsHide: true,
          env: { ...process.env, PUGPORT_BACKEND_GUARD: 'windows-job' },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
        const descendants = new Promise<{ child: number; grandchild: number }>((done) =>
          backend!.on('message', (value: any) => {
            if (value.type === 'descendants') done(value);
          }),
        );
        const guard = createWindowsBackendGuard(backend, {
          startupMs: 35000,
          launch: (script) => {
            guardian = spawn(
              join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
              ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
              { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
            );
            return guardian;
          },
        });
        await guard.ready;
        const ids = await descendants;
        assert.ok(ids.child > 0 && ids.grandchild > 0);
        const exited = once(backend, 'exit');
        if (cause === 'backend-crash') {
          backend.kill('SIGKILL');
          await exited;
          await guard.closed;
        } else {
          const rejected = assert.rejects(guard.closed, /保护或子进程清理未完成/);
          guardian!.kill('SIGKILL');
          await rejected;
          await exited;
          await guard.terminate();
        }
        for (const pid of [ids.child, ids.grandchild])
          assert.throws(() => process.kill(pid, 0), 'no contained child survives root crash');
        assert.doesNotThrow(() => process.kill(unrelated!.pid!, 0), 'a process outside the job is untouched');
      } finally {
        for (const child of [guardian, backend, unrelated])
          if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
          }
        const resolved = await realpath(directory),
          temporary = await realpath(tmpdir());
        assert.equal(dirname(resolved).toLowerCase(), temporary.toLowerCase());
        assert.ok(basename(resolved).startsWith('pugport-job-guard-native-'));
        await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  );
