import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { sampleBackendCpu } from '../src/electron/backend-cpu.ts';
import { OwnedBackend } from '../src/electron/backend.ts';
import { APP_NAME, APP_VERSION } from '../src/shared/identity.ts';

class Child extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode = null;
  constructor(readonly pid: number) {
    super();
  }
  send() {}
  finish() {
    this.exitCode = 1;
    this.connected = false;
    this.emit('exit', 1, null);
  }
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture(t: TestContext, options: Partial<ConstructorParameters<typeof OwnedBackend>[0]> = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const dataDir = mkdtempSync(join(tmpdir(), 'pugport-hang-'));
  mkdirSync(join(dataDir, 'logs'));
  writeFileSync(join(dataDir, 'logs/backend-busy.json'), JSON.stringify({ name: 'synthetic-job', pid: 1234 }));
  const children: Child[] = [];
  const logs: string[] = [];
  let requests = 0,
    kills = 0,
    success = false;
  const backend = new OwnedBackend({
    root: dataDir,
    dataDir,
    port: 4317,
    startupMs: 300_000,
    restartBackoffMs: 1,
    log: (line) => logs.push(line),
    launch: () => {
      const child = new Child(1234 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    terminate: async (child) => {
      kills++;
      (child as unknown as Child).finish();
    },
    cpuTime: async (pid) => {
      assert.equal(pid, children.at(-1)!.pid);
      return '119000ms';
    },
    healthFetch: async (url, init) => {
      requests++;
      assert.equal(url, 'http://127.0.0.1:4317/api/health');
      assert.ok(init?.signal);
      if (!success) throw Error('synthetic failure');
      return new Response(JSON.stringify({ ok: true, name: APP_NAME, version: APP_VERSION }));
    },
    ...options,
  });
  const ready = () =>
    children.at(-1)!.emit('message', { type: 'ready', name: APP_NAME, version: APP_VERSION, port: 4317, dataDir });
  const start = async () => {
    const pending = backend.start();
    ready();
    await pending;
  };
  const tick = async (ms = 15_000) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  const fail = async (n: number) => {
    for (let i = 0; i < n; i++) await tick();
  };
  const log = () =>
    existsSync(join(dataDir, 'logs/backend.log')) ? readFileSync(join(dataDir, 'logs/backend.log'), 'utf8') : '';
  t.after(async () => {
    const stopping = backend.stop();
    children.at(-1)?.finish();
    await stopping;
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    backend,
    logs,
    children,
    ready,
    start,
    tick,
    fail,
    log,
    requests: () => requests,
    kills: () => kills,
    success: (value: boolean) => {
      success = value;
    },
  };
}

test('eight failed pings log one breadcrumb and CPU line, terminate, then recover', async (t) => {
  const f = fixture(t);
  await f.start();
  await f.fail(7);
  assert.equal(f.kills(), 0);
  await f.tick();
  assert.equal(f.kills(), 0);
  await f.tick(2000);
  assert.equal(f.kills(), 1);
  assert.match(
    f.log(),
    /\[hang\] backend unresponsive 122s, pid=1234, cpu=119000ms, cpuRate=0ms\/s, busy=.*synthetic-job/,
  );
  assert.equal(f.log().trim().split('\n').length, 1);
  await f.tick(1);
  assert.equal(f.children.length, 2);
  f.ready();
  assert.equal(f.backend.state.phase, 'ready');
});

test('a success resets consecutive failures', async (t) => {
  const f = fixture(t);
  await f.start();
  await f.fail(7);
  f.success(true);
  await f.tick();
  f.success(false);
  await f.fail(7);
  assert.equal(f.kills(), 0);
  await f.tick();
  assert.equal(f.kills(), 0);
  await f.tick(2000);
  assert.equal(f.kills(), 1);
});

test('wall clock jump resets failures and skips the waking tick', async (t) => {
  const f = fixture(t);
  await f.start();
  await f.fail(7);
  t.mock.timers.setTime(Date.now() + 120_000);
  await f.tick();
  assert.equal(f.requests(), 7);
  await f.fail(7);
  assert.equal(f.kills(), 0);
  await f.tick();
  assert.equal(f.kills(), 0);
  await f.tick(2000);
  assert.equal(f.kills(), 1);
});

test('no pings during startup, recovery startup, stopping or sleep; resume waits a full tick', async (t) => {
  const f = fixture(t);
  const starting = f.backend.start();
  await f.tick();
  assert.equal(f.requests(), 0);
  f.ready();
  await starting;
  f.backend.suspendHealth();
  await f.fail(4);
  assert.equal(f.requests(), 0);
  f.backend.resumeHealth();
  await f.tick(14_999);
  assert.equal(f.requests(), 0);
  await f.tick(1);
  assert.equal(f.requests(), 1);
  await f.fail(7);
  await f.tick(1);
  await f.tick();
  assert.equal(f.requests(), 8);
  const stopping = f.backend.stop();
  f.children.at(-1)!.finish();
  await stopping;
  await f.fail(2);
  assert.equal(f.requests(), 8);
});

test('consecutive hangs stop at the limit before the stable ready period', async (t) => {
  const f = fixture(t, { restartLimit: 2, restartStableMs: 300_000 });
  await f.start();
  await f.fail(8);
  await f.tick(2000);
  await f.tick(1);
  f.ready();
  await f.fail(8);
  await f.tick(2000);
  await f.tick(100);
  assert.equal(f.children.length, 2);
  assert.equal(f.kills(), 2);
  assert.equal(f.backend.state.phase, 'error');
  assert.match(f.backend.state.message!, /在 2 次重启失败后已停止/);
});

test('unresponsive fetch times out in five seconds, without overlapping probes', async (t) => {
  let calls = 0;
  const f = fixture(t, {
    healthFetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  await f.start();
  for (let i = 0; i < 8; i++) {
    await f.tick(i ? 10_000 : 15_000);
    assert.equal(calls, i + 1);
    await f.tick(4999);
    assert.equal(f.kills(), 0);
    await f.tick(1);
  }
  await f.tick(2000);
  assert.equal(f.kills(), 1);
});

test('stopping invalidates an in-flight failed probe', async (t) => {
  let reject!: (error: Error) => void;
  const f = fixture(t, {
    healthFetch: async () =>
      new Promise<Response>((_done, fail) => {
        reject = fail;
      }),
  });
  await f.start();
  await f.tick();
  const stopping = f.backend.stop();
  reject(Error('late result'));
  f.children.at(-1)!.finish();
  await stopping;
  await flush();
  assert.equal(f.log(), '');
  assert.equal(f.kills(), 0);
});

test('a stalled health response body is also bounded by five seconds', async (t) => {
  const f = fixture(t, { healthFetch: async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response });
  await f.start();
  for (let i = 0; i < 8; i++) {
    await f.tick(i ? 10_000 : 15_000);
    await f.tick(5000);
  }
  await f.tick(2000);
  assert.equal(f.kills(), 1);
});

test('sleep during CPU sampling cancels termination and resume starts a fresh failure budget', async (t) => {
  let cpuDone!: (value: string) => void;
  const f = fixture(t, {
    cpuTime: () =>
      new Promise((done) => {
        cpuDone = done;
      }),
  });
  await f.start();
  await f.fail(8);
  await f.tick(2000);
  f.backend.suspendHealth();
  f.backend.resumeHealth();
  cpuDone('100ms');
  await flush();
  assert.equal(f.log(), '');
  assert.equal(f.kills(), 0);
  await f.fail(7);
  assert.equal(f.kills(), 0);
});

test('zero restartLimit still terminates a hung child but never relaunches it', async (t) => {
  const f = fixture(t, {
    restartLimit: 0,
    cpuTime: async () => {
      throw Error('unavailable');
    },
  });
  await f.start();
  await f.fail(8);
  await f.tick(2000);
  await f.tick(100);
  assert.equal(f.kills(), 1);
  assert.equal(f.children.length, 1);
  assert.equal(f.backend.state.phase, 'error');
  assert.match(f.log(), /cpu=unavailable/);
});

test('recovery waits for the owned termination path after the root has exited', async (t) => {
  let cleaned!: () => void;
  const f = fixture(t, {
    terminate: async (child) => {
      (child as unknown as Child).finish();
      await new Promise<void>((done) => {
        cleaned = done;
      });
    },
  });
  await f.start();
  await f.fail(8);
  await f.tick(2000);
  await f.tick(1000);
  assert.equal(f.children.length, 1);
  cleaned();
  await flush();
  await f.tick(1);
  assert.equal(f.children.length, 2);
  assert.ok(f.logs.some((line) => /cleanup wait starting/.test(line)));
  for (const reason of ['eligible=true', 'limit check', 'cleanup wait succeeded', 'timer fired', 'relaunch starting'])
    assert.ok(
      f.logs.some((line) => line.includes(reason)),
      reason,
    );
});

test('guarded hang recovery waits for both zero-active-process acknowledgement and termination completion', async (t) => {
  let acknowledge!: () => void, complete!: () => void;
  const f = fixture(t, {
    guard: (child) => ({
      ready: Promise.resolve(),
      closed: new Promise<void>((done) => {
        acknowledge = done;
      }),
      terminate: async () => {
        (child as unknown as Child).finish();
        acknowledge();
        await new Promise<void>((done) => {
          complete = done;
        });
      },
    }),
  });
  const started = f.backend.start();
  await flush();
  f.ready();
  await started;
  await f.fail(8);
  await f.tick(2000);
  await f.tick(1000);
  assert.equal(f.children.length, 1);
  complete();
  await flush();
  await f.tick(1);
  assert.equal(f.children.length, 2);
  acknowledge(); // Allow fixture shutdown to observe the replacement guard's cleanup.
  await flush();
});

for (const [first, last, expected] of [
  ['119000ms', '121000ms', '121000ms, cpuRate=1000ms/s'],
  ['119000ms', '119000ms', '119000ms, cpuRate=0ms/s'],
  ['01:59', '02:01', '02:01, cpuRate=1000ms/s'],
  ['unavailable', '121000ms', '121000ms, cpuRate=unavailable'],
]) {
  test('CPU samples report cumulative time and delta rate: ' + expected, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let time = 0;
    const samples: number[] = [];
    const result = sampleBackendCpu(
      1234,
      async (pid) => {
        assert.equal(pid, 1234);
        samples.push(time);
        return samples.length === 1 ? first : last;
      },
      () => time,
    );
    await flush();
    time = 1999;
    t.mock.timers.tick(1999);
    await flush();
    assert.deepEqual(samples, [0]);
    time = 2000;
    t.mock.timers.tick(1);
    assert.equal(await result, expected);
    assert.deepEqual(samples, [0, 2000]);
  });
}

for (const rootExited of [false, true]) {
  test(`failed hang cleanup is logged and never relaunches (root exited=${rootExited})`, async (t) => {
    let reject!: (error: Error) => void;
    let cleanupCalls = 0;
    const f = fixture(t, {
      terminate: async (child) => {
        if (++cleanupCalls > 1) {
          (child as unknown as Child).finish();
          return;
        }
        if (rootExited) (child as unknown as Child).finish();
        await new Promise<void>((_done, fail) => {
          reject = fail;
        });
      },
    });
    await f.start();
    await f.fail(8);
    await f.tick(2000);
    reject(Error('synthetic cleanup failure'));
    await flush();
    f.children[0].finish();
    await f.tick(100);
    assert.equal(f.children.length, 1);
    assert.equal(f.backend.state.phase, 'error');
    assert.ok(f.logs.some((line) => /cleanup.*failed.*synthetic cleanup failure/.test(line)));
    assert.ok(f.logs.some((line) => /fail:.*清理未/.test(line)));
  });
}

test('an unexpected hang-path rejection is logged and an exited child still recovers', async (t) => {
  let child!: Child;
  const f = fixture(t, {
    cpuTime: () => {
      child.exitCode = 1;
      child.connected = false;
      throw Error('synthetic CPU exception');
    },
  });
  await f.start();
  child = f.children[0];
  await f.fail(8);
  await f.tick(1);
  assert.equal(f.children.length, 2);
  assert.ok(f.logs.some((line) => /hang.*failed.*synthetic CPU exception/.test(line)));
});

test('pingHealth catches unexpected errors and recovers an exited child', async (t) => {
  const f = fixture(t);
  await f.start();
  t.mock.method(
    Date,
    'now',
    () => {
      f.children[0].exitCode = 1;
      f.children[0].connected = false;
      throw Error('synthetic clock exception');
    },
    { times: 1 },
  );
  await f.tick();
  await f.tick(1);
  assert.equal(f.children.length, 2);
  assert.ok(f.logs.some((line) => /pingHealth failed.*synthetic clock exception/.test(line)));
});
