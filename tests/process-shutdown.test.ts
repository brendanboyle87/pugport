import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const processModuleUrl = new URL('../src/server/adapters/process.ts', import.meta.url).href;
const root = fileURLToPath(new URL('..', import.meta.url));

// Each case gets a fresh process module. Its intentionally irreversible shutdown gate cannot
// contaminate the Codex adapter tests, even if a caller disables node:test file isolation.
async function isolated(script: string) {
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: root,
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

test('spawnTarget marks its child as a PugPort executor', async () => {
  const result = await isolated(`
    import { once } from 'node:events';
    import { spawnTarget } from ${JSON.stringify(processModuleUrl)};
    const target = { id: 'mock', provider: 'codex', label: 'Mock', environment: 'native', enabled: true, command: process.execPath };
    const child = await spawnTarget(target, ['-e', 'process.stdout.write(process.env.PUGPORT_EXECUTOR || "missing")'], { env: { ...process.env, pugport_executor: '0' } });
    let output = ''; child.stdout.on('data', chunk => output += chunk);
    await once(child, 'close');
    process.stdout.write(JSON.stringify({ marker: output }));
  `);
  assert.equal(result.marker, '1');
});

test(
  'application shutdown reaps all live owned children, remains idempotent, and leaves unowned processes alone',
  { timeout: 20_000 },
  async () => {
    const result = await isolated(`
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { spawnTarget, terminateProcess, shutdownOwnedProcesses } from ${JSON.stringify(processModuleUrl)};
    const target = { id: 'mock', provider: 'codex', label: 'Mock', environment: 'native', enabled: true, command: process.execPath };
    const args = ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'];
    const unowned = spawn(process.execPath, args, { stdio: 'pipe', windowsHide: true });
    await once(unowned, 'spawn');
    const owned = [];
    try {
      owned.push(await spawnTarget({ ...target, id: 'quota-discovery' }, args));
      owned.push(await spawnTarget({ ...target, id: 'task-execution' }, args));
      await terminateProcess(unowned);
      assert.equal(unowned.exitCode, null);
      const stopping = shutdownOwnedProcesses();
      assert.equal(shutdownOwnedProcesses(), stopping);
      await stopping;
      for (const child of owned) {
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned child must exit before shutdown resolves');
        assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
      }
      assert.doesNotThrow(() => process.kill(unowned.pid, 0));
      await assert.rejects(spawnTarget(target, args), /operation-cancelled/);
      await shutdownOwnedProcesses();
      process.stdout.write(JSON.stringify({ stopped: owned.length, unownedSurvived: true, lateSpawnBlocked: true }));
    } finally {
      await Promise.all(owned.map(child => terminateProcess(child)));
      const closed = once(unowned, 'close');
      unowned.kill();
      await closed;
    }
  `);
    assert.deepEqual(result, { stopped: 2, unownedSurvived: true, lateSpawnBlocked: true });
  },
);

test(
  'shutdown while executable resolution is pending prevents any subsequent OS spawn',
  { timeout: 20_000 },
  async () => {
    const result = await isolated(`
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    let calls = 0;
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (...args) => { calls++; return originalSpawn(...args); };
    syncBuiltinESMExports();
    const { spawnTarget, shutdownOwnedProcesses } = await import(${JSON.stringify(processModuleUrl)});
    const target = { id: 'mock', provider: 'codex', label: 'Mock', environment: 'native', enabled: true, command: process.execPath };
    const pending = spawnTarget(target, ['-e', 'setInterval(() => {}, 1000)']);
    const rejected = assert.rejects(pending, /operation-cancelled/);
    await shutdownOwnedProcesses();
    await rejected;
    assert.equal(calls, 0, 'access/resolve continuation must not launch after shutdown');
    process.stdout.write(JSON.stringify({ spawnCalls: calls }));
  `);
    assert.deepEqual(result, { spawnCalls: 0 });
  },
);

for (const [ignoreTerm, leaderExitsFirst] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])
  test(
    `POSIX cleanup stops a helper ${leaderExitsFirst ? 'whose leader already closed' : 'after its leader exits on EOF'}${ignoreTerm ? ', escalating ignored TERM' : ''}`,
    { skip: process.platform === 'win32', timeout: 20_000 },
    async () => {
      const helperSource = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}console.log('ready');setInterval(() => {}, 1000);`;
      const parentSource = `const {spawn}=require('node:child_process');
        const helper=spawn(process.execPath,['-e',${JSON.stringify(helperSource)}],{stdio:['ignore','pipe','ignore']});
        helper.stdout.once('data',()=>{helper.stdout.destroy();helper.unref();console.log(helper.pid);${leaderExitsFirst ? 'setTimeout(()=>process.exit(0),25)' : ''}});
        process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
      const result = await isolated(`
        import assert from 'node:assert/strict';
        import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        import { spawnTarget, terminateProcess, isOwnedProcess, shutdownOwnedProcesses } from ${JSON.stringify(processModuleUrl)};
        const parentSource = ${JSON.stringify(parentSource)};
        const target={id:'synthetic-parent',provider:'codex',label:'Synthetic',environment:'native',enabled:true,command:process.execPath};
        const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        let parent, helperPid;
        try {
          await once(unrelated,'spawn');
          parent=await spawnTarget(target,['-e',parentSource]);
          const [output]=await once(parent.stdout,'data');
          helperPid=Number(output.toString().trim());
          assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
          ${leaderExitsFirst ? "await once(parent,'close');assert.equal(isOwnedProcess(parent.pid),false);" : ''}
          await terminateProcess(parent);
          assert.ok(parent.exitCode!==null || parent.signalCode!==null);
          assert.throws(()=>process.kill(helperPid,0),error=>error.code==='ESRCH','helper must be gone before cancellation resolves');
          assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
          await terminateProcess(parent);
          await shutdownOwnedProcesses();
          process.stdout.write(JSON.stringify({parentStopped:true,helperStopped:true,unrelatedSurvived:true}));
        } finally {
          if(helperPid) {try{process.kill(helperPid,'SIGKILL')}catch{}}
          if(parent) await terminateProcess(parent);
          const closed=once(unrelated,'close');unrelated.kill('SIGKILL');await closed;
        }
      `);
      assert.deepEqual(result, { parentStopped: true, helperStopped: true, unrelatedSurvived: true });
    },
  );

for (const signal of ['SIGTERM', 'SIGKILL'])
  for (const disappears of [true, false])
    test(
      `POSIX ${signal} EPERM ${disappears ? 'accepts proven group exit' : 'rejects a group still running'}`,
      { skip: process.platform === 'win32', timeout: 20000 },
      async () => {
        const result = await isolated(`
        import assert from 'node:assert/strict';
        import {once} from 'node:events';
        import {spawnTarget,terminateProcess} from ${JSON.stringify(processModuleUrl)};
        const target={id:'synthetic',provider:'codex',label:'Synthetic',environment:'native',enabled:true,command:process.execPath};
        const child=await spawnTarget(target,['-e',"process.on('SIGTERM',()=>{});console.log('ready');process.stdin.resume();setInterval(()=>{},1000)"]);
        await once(child.stdout,'data');
        const kill=process.kill;
        let denied=0;
        process.kill=(pid,signal)=>{
          if(pid===-child.pid&&signal===${JSON.stringify(signal)}) {
            denied++;
            if(${disappears})kill(pid,'SIGKILL');
            throw Object.assign(new Error('synthetic EPERM after concurrent exit'),{code:'EPERM'});
          }
          return kill(pid,signal);
        };
        try {
          const stopping=terminateProcess(child);
          ${disappears ? "await stopping;assert.throws(()=>kill(-child.pid,0),error=>error.code==='ESRCH');" : "await assert.rejects(stopping,{code:'owned-processes-still-running'});assert.doesNotThrow(()=>kill(-child.pid,0));"}
          assert.equal(denied,1);
          process.stdout.write(JSON.stringify({denied,disappears:${disappears}}));
        } finally {
          process.kill=kill;
          if(child.exitCode===null&&child.signalCode===null){
            const closed=once(child,'close');
            try{kill(-child.pid,'SIGKILL');}catch(error){if(!['ESRCH','EPERM'].includes(error.code))throw error;}
            await closed;
          }
        }
      `);
        assert.deepEqual(result, { denied: 1, disappears });
      },
    );

test('Windows shutdown falls back to the owned child handle when taskkill fails', { timeout: 20_000 }, async () => {
  const result = await isolated(`
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { once } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalSpawn = childProcess.spawn;
    let failedTreeKills = 0;
    childProcess.spawn = (command, args, options) => {
      if (String(command).endsWith('taskkill.exe')) {
        failedTreeKills++;
        return originalSpawn(process.execPath, ['-e', 'process.exit(1)'], options);
      }
      return originalSpawn(command, args, options);
    };
    syncBuiltinESMExports();
    const { spawnTarget, shutdownOwnedProcesses } = await import(${JSON.stringify(processModuleUrl)});
    const target = { id: 'mock', provider: 'codex', label: 'Mock', environment: 'native', enabled: true, command: process.execPath };
    const child = await spawnTarget(target, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)']);
    let handleKills = 0;
    const originalKill = child.kill.bind(child);
    child.kill = signal => { handleKills++; return originalKill(signal); };
    try {
      await shutdownOwnedProcesses();
      assert.equal(failedTreeKills, 1);
      assert.equal(handleKills, 1, 'failed taskkill must trigger direct child termination');
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'fallback must reap the child before shutdown resolves');
      assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
      process.stdout.write(JSON.stringify({ failedTreeKills, handleKills, childStopped: true }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        originalKill('SIGKILL');
        await closed;
      }
    }
  `);
  assert.deepEqual(result, { failedTreeKills: 1, handleKills: 1, childStopped: true });
});

test('shutdown rejects when best-effort termination leaves an owned child running', { timeout: 20_000 }, async () => {
  const result = await isolated(`
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { once } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) =>
      String(command).endsWith('taskkill.exe')
        ? originalSpawn(process.execPath, ['-e', 'process.exit(1)'], options)
        : originalSpawn(command, args, options);
    syncBuiltinESMExports();
    const { spawnTarget, shutdownOwnedProcesses } = await import(${JSON.stringify(processModuleUrl)});
    const target = { id: 'mock', provider: 'codex', label: 'Mock', environment: 'native', enabled: true, command: process.execPath };
    const child = await spawnTarget(target, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)']);
    const originalKill = child.kill.bind(child);
    child.kill = () => false;
    try {
      const stopping = shutdownOwnedProcesses();
      assert.equal(shutdownOwnedProcesses(), stopping);
      await assert.rejects(stopping, error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.code, 'owned-processes-still-running');
        assert.ok(error.errors.some(item => item.message.includes(String(child.pid))));
        return true;
      });
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      await assert.rejects(spawnTarget(target, []), /operation-cancelled/);
      process.stdout.write(JSON.stringify({ rejected: true, lateSpawnBlocked: true }));
    } finally {
      const closed = once(child, 'close');
      originalKill('SIGKILL');
      await closed;
    }
  `);
  assert.deepEqual(result, { rejected: true, lateSpawnBlocked: true });
});

test(
  'retired WSL targets are rejected before path conversion or any OS process can launch',
  { timeout: 20_000 },
  async () => {
    const result = await isolated(`
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let spawns = 0;
    childProcess.spawn = () => { spawns++; throw new Error('WSL retirement must block before spawn'); };
    syncBuiltinESMExports();
    const { spawnTarget, targetPath, shutdownOwnedProcesses } = await import(${JSON.stringify(processModuleUrl)});
    const target = { id: 'mock-wsl', provider: 'codex', label: 'Mock WSL', environment: 'wsl', enabled: true, command: 'codex' };
    for (const value of [target, { ...target, id: 'codex-wsl', environment: 'native' }]) {
      await assert.rejects(targetPath(value, 'C:/project'), /wsl-runtime-retired/);
      await assert.rejects(targetPath(value, '/already/linux/path'), /wsl-runtime-retired/);
      await assert.rejects(spawnTarget(value, ['app-server'], { cwd: 'C:/project' }), /wsl-runtime-retired/);
      await assert.rejects(spawnTarget(value, ['app-server']), /wsl-runtime-retired/);
    }
    await shutdownOwnedProcesses();
    assert.equal(spawns, 0, 'neither wslpath nor a runtime/helper may launch');
    process.stdout.write(JSON.stringify({ spawnCalls: spawns }));
  `);
    assert.deepEqual(result, { spawnCalls: 0 });
  },
);
