import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpuUsagePercent,
  createSystemMonitor,
  createWindowsGpuReader,
  gpuUsagePercent,
  nvidiaGpuUsagePercent,
  type CpuTimes,
  type SystemResources,
} from '../src/electron/system-monitor.ts';

const cpu = (user: number, idle: number): CpuTimes => ({ user, idle, nice: 0, sys: 0, irq: 0 });
const gpu = (pid: number, engine: number, percent: number, adapter = '0x00000000_0x00000001', physical = 0) => ({
  Name: `pid_${pid}_luid_${adapter}_phys_${physical}_eng_${engine}_engtype_3D`,
  UtilizationPercentage: percent,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(
  options: {
    platform?: NodeJS.Platform;
    readGpu?: (signal: AbortSignal) => Promise<unknown>;
    onUpdate?: (resources: SystemResources) => void;
  } = {},
) {
  let now = 10_000;
  let nextTimer = 0;
  let cpuReads = 0;
  let gpuReads = 0;
  let current = [cpu(100, 100)];
  let memory = { totalBytes: 1_000, freeBytes: 500 };
  const timers = new Map<number, { callback: () => void; interval: number }>();
  const signals: AbortSignal[] = [];
  const updates: SystemResources[] = [];
  const monitor = createSystemMonitor({
    onUpdate: (resources) => {
      updates.push(resources);
      options.onUpdate?.(resources);
    },
    dependencies: {
      platform: options.platform ?? 'win32',
      now: () => now,
      readCpus: () => {
        cpuReads++;
        return current;
      },
      readMemory: () => memory,
      readHardware: async () => undefined,
      readGpu: (signal) => {
        gpuReads++;
        signals.push(signal);
        return options.readGpu ? options.readGpu(signal) : Promise.resolve([gpu(1, 0, 15)]);
      },
      setInterval: ((callback: () => void, interval: number) => {
        const id = ++nextTimer;
        timers.set(id, { callback, interval });
        return id as unknown as ReturnType<typeof setInterval>;
      }) as typeof globalThis.setInterval,
      clearInterval: ((id: ReturnType<typeof setInterval>) => {
        timers.delete(id as unknown as number);
      }) as typeof globalThis.clearInterval,
    },
  });
  return {
    monitor,
    updates,
    signals,
    timers,
    get cpuReads() {
      return cpuReads;
    },
    get gpuReads() {
      return gpuReads;
    },
    setCpu(value: CpuTimes[]) {
      current = value;
    },
    setMemory(value: typeof memory) {
      memory = value;
    },
    advance(ms: number) {
      now += ms;
    },
    fire(interval: number) {
      for (const timer of [...timers.values()]) if (timer.interval === interval) timer.callback();
    },
  };
}

test('CPU uses deltas across every logical CPU, including system time', () => {
  const previous = [cpu(100, 100), cpu(100, 100)];
  const current = [cpu(120, 180), { ...cpu(110, 170), sys: 20 }];
  assert.equal(cpuUsagePercent(previous, current), 25);
  assert.equal(cpuUsagePercent([cpu(0, 0)], [cpu(0, 100)]), 0);
  assert.equal(cpuUsagePercent([cpu(0, 0)], [cpu(100, 0)]), 100);
});

test('CPU baseline, clock resets, core changes, and invalid counters are unavailable', () => {
  assert.equal(cpuUsagePercent([], [cpu(0, 0)]), undefined);
  assert.equal(cpuUsagePercent([cpu(1, 1)], [cpu(1, 1)]), undefined);
  assert.equal(cpuUsagePercent([cpu(1, 1)], [cpu(2, 2), cpu(2, 2)]), undefined);
  assert.equal(cpuUsagePercent([cpu(20, 1)], [cpu(10, 2)]), undefined);
  assert.equal(cpuUsagePercent([cpu(0, 0)], [cpu(NaN, 100)]), undefined);
});

test('GPU sums PIDs for each engine, then selects busiest physical adapter engine', () => {
  assert.equal(
    gpuUsagePercent([
      gpu(10, 0, 30),
      gpu(11, 0, 15),
      gpu(10, 1, 20),
      gpu(10, 0, 40, '0x00000000_0x00000002'),
      gpu(10, 0, 35, '0x00000000_0x00000001', 1),
    ]),
    45,
  );
  assert.equal(gpuUsagePercent([gpu(1, 0, 70), gpu(2, 0, 50)]), 100);
  assert.equal(gpuUsagePercent({ ...gpu(1, 0, 0), Name: gpu(1, 0, 0).Name.replace('3D', '') }), 0);
});

test('GPU parses CIM JSON without treating absent or invalid counters as idle hardware', () => {
  assert.equal(gpuUsagePercent(`\uFEFF${JSON.stringify([gpu(1, 0, 25)])}`), 25);
  assert.equal(gpuUsagePercent(JSON.stringify(gpu(1, 0, 0))), 0);
  for (const data of [
    '',
    'broken JSON',
    [],
    null,
    { Name: '_Total', UtilizationPercentage: 5 },
    { ...gpu(1, 0, 0), UtilizationPercentage: -1 },
    { ...gpu(1, 0, 0), UtilizationPercentage: NaN },
    { ...gpu(1, 0, 0), UtilizationPercentage: '0' },
  ]) {
    assert.equal(gpuUsagePercent(data), undefined);
  }
});

test('NVIDIA utilization parses valid adapter percentages without inventing values for unsupported readings', () => {
  assert.equal(nvidiaGpuUsagePercent('0\r\n'), 0);
  assert.equal(nvidiaGpuUsagePercent('12\r\n74.5\r\nN/A\r\n'), 74.5);
  assert.equal(nvidiaGpuUsagePercent(' 22 % '), 22);
  for (const value of ['', 'N/A', '[Not Supported]', 'NaN', '-1', '101', 'name, 30', null, {}])
    assert.equal(nvidiaGpuUsagePercent(value), undefined);
});

test('Windows GPU reader asks the fast NVIDIA tool first and launches nothing else when it answers', async () => {
  const commands: string[] = [];
  const reader = createWindowsGpuReader({
    readAdapters: async () => [],
    run: async (command) => {
      commands.push(command.file);
      assert.equal(command.timeout, 2_000);
      assert.deepEqual(command.args, [
        '--query-gpu=utilization.gpu,name,memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ]);
      return 'N/A\r\n37\r\n';
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await reader(signal), { gpuPercent: 37, gpuProvider: 'nvidia-smi' });
  assert.deepEqual(await reader(signal), { gpuPercent: 37, gpuProvider: 'nvidia-smi' });
  assert.deepEqual(commands, ['nvidia-smi.exe', 'nvidia-smi.exe']);
});

test('without NVIDIA the reader uses Windows counters, keeps using them, and looks for NVIDIA again later', async () => {
  for (const response of ['missing', 'N/A']) {
    let now = 1_000;
    const commands: string[] = [];
    const reader = createWindowsGpuReader({
      readAdapters: async () => [],
      now: () => now,
      run: async (command) => {
        commands.push(command.file);
        if (command.file === 'nvidia-smi.exe') {
          if (response === 'missing') throw new Error('spawn nvidia-smi.exe ENOENT');
          return response;
        }
        assert.equal(command.timeout, 4_000);
        assert.ok(command.args.includes('-NonInteractive'));
        return JSON.stringify([gpu(1, 0, 20), gpu(2, 0, 15)]);
      },
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await reader(signal), { gpuPercent: 35, gpuProvider: 'windows-counters' });
    now += 5_000;
    await reader(signal);
    assert.deepEqual(commands, ['nvidia-smi.exe', 'powershell.exe', 'powershell.exe']);
    now += 600_000;
    await reader(signal);
    assert.deepEqual(commands.slice(-2), ['nvidia-smi.exe', 'powershell.exe']);
  }
});

test('Windows GPU reader never reports unavailable NVIDIA values as zero and does not fall back after cancellation', async () => {
  let calls = 0;
  const unavailable = createWindowsGpuReader({
    readAdapters: async () => [],
    run: async () => {
      calls++;
      return calls === 1 ? '[]' : 'N/A';
    },
  });
  await assert.rejects(unavailable(new AbortController().signal), AggregateError);
  assert.equal(calls, 2);
  const controller = new AbortController();
  let cancelledCalls = 0;
  const cancelled = createWindowsGpuReader({
    readAdapters: async () => [],
    run: async () => {
      cancelledCalls++;
      controller.abort();
      throw new Error('cancelled helper');
    },
  });
  await assert.rejects(cancelled(controller.signal), { name: 'AbortError' });
  assert.equal(cancelledCalls, 1);
  await assert.rejects(cancelled(controller.signal), { name: 'AbortError' });
  assert.equal(cancelledCalls, 1, 'pre-cancelled reads do not launch helpers');
});

test('a failing NVIDIA tool falls back to Windows counters and the counters are then remembered', async () => {
  const commands: string[] = [];
  const reader = createWindowsGpuReader({
    readAdapters: async () => [],
    now: () => 1_000,
    run: async (command) => {
      commands.push(command.file);
      if (commands.length === 2) throw new Error('provider temporarily unavailable');
      return command.file === 'nvidia-smi.exe' ? '0' : JSON.stringify([gpu(1, 0, 61)]);
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await reader(signal), { gpuPercent: 0, gpuProvider: 'nvidia-smi' });
  assert.deepEqual(await reader(signal), { gpuPercent: 61, gpuProvider: 'windows-counters' });
  assert.deepEqual(await reader(signal), { gpuPercent: 61, gpuProvider: 'windows-counters' });
  assert.deepEqual(commands, ['nvidia-smi.exe', 'nvidia-smi.exe', 'powershell.exe', 'powershell.exe']);
});

test('visible monitor samples CPU/RAM every 2 seconds and GPU every 5 seconds', async () => {
  const f = fixture();
  assert.equal(f.cpuReads, 0);
  assert.equal(f.gpuReads, 0);
  f.monitor.start();
  f.monitor.start();
  assert.equal(f.cpuReads, 1);
  assert.equal(f.gpuReads, 1);
  assert.equal(f.timers.size, 3, 'CPU, a one-off quick CPU sample, and GPU');
  assert.equal(f.updates[0].cpuPercent, undefined);
  assert.equal(f.updates[0].gpuState, 'loading');
  assert.deepEqual(f.updates[0].memory, { usedBytes: 500, totalBytes: 1_000, percent: 50 });
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuPercent, 15);
  f.setCpu([cpu(120, 180)]);
  f.setMemory({ totalBytes: 1_000, freeBytes: 250 });
  f.advance(2_000);
  f.fire(2_000);
  assert.equal(f.monitor.snapshot().cpuPercent, 20);
  assert.equal(f.monitor.snapshot().memory?.percent, 75);
  assert.equal(f.gpuReads, 1);
  f.advance(3_000);
  f.fire(5_000);
  assert.equal(f.gpuReads, 2);
  f.monitor.dispose();
});

test('the second CPU sample comes half a second after opening, then the quick timer is gone', () => {
  const f = fixture({ platform: 'freebsd' });
  f.monitor.start();
  assert.equal(f.monitor.snapshot().cpuPercent, undefined);
  f.setCpu([cpu(130, 170)]);
  f.advance(500);
  f.fire(500);
  assert.equal(f.monitor.snapshot().cpuPercent, 30);
  assert.equal(f.timers.size, 1, 'only the regular 2-second timer is left');
  f.fire(500);
  assert.equal(f.cpuReads, 2);
  f.monitor.dispose();
});

test('closing clears timers but lets a running GPU read finish into the cache without publishing it', async () => {
  const pending = deferred<unknown>();
  const f = fixture({ readGpu: () => pending.promise });
  f.monitor.start();
  const callbacks = [...f.timers.values()].map(({ callback }) => callback);
  const updates = f.updates.length;
  f.monitor.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.signals[0].aborted, false, 'a slow read is not thrown away');
  for (const callback of callbacks) callback();
  pending.resolve([gpu(1, 0, 99)]);
  await Promise.resolve();
  assert.equal(f.cpuReads, 1);
  assert.equal(f.updates.length, updates, 'nothing is pushed to a closed view');
  assert.equal(f.monitor.snapshot().gpuPercent, 99, 'the next open shows it at once');
  f.monitor.dispose();
});

test('reopening reuses the GPU read still in flight instead of starting another', async () => {
  const requests = [deferred<unknown>(), deferred<unknown>()];
  let index = 0;
  const f = fixture({ readGpu: () => requests[index++].promise });
  f.monitor.start();
  f.advance(5_000);
  f.fire(5_000);
  assert.equal(f.gpuReads, 1);
  f.monitor.stop();
  f.monitor.start();
  assert.equal(f.gpuReads, 1);
  requests[0].resolve([gpu(1, 0, 99)]);
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuPercent, 99);
  assert.equal(f.monitor.snapshot().gpuState, 'available');
  assert.equal(f.updates.at(-1)?.gpuPercent, 99, 'the open view gets it');
  f.advance(5_000);
  f.fire(5_000);
  assert.equal(f.gpuReads, 2);
  requests[1].resolve([gpu(1, 0, 10)]);
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuPercent, 10);
  f.monitor.dispose();
  const pending = deferred<unknown>();
  const g = fixture({ readGpu: () => pending.promise });
  g.monitor.start();
  g.monitor.dispose();
  assert.equal(g.signals[0].aborted, true, 'quitting the app still cancels a read in flight');
});

test('rapid close/reopen does not launch GPU helpers more than once per 5 seconds', async () => {
  const f = fixture();
  f.monitor.start();
  await Promise.resolve();
  f.advance(100);
  f.monitor.stop();
  f.monitor.start();
  assert.equal(f.gpuReads, 1);
  f.advance(5_000);
  f.fire(5_000);
  assert.equal(f.gpuReads, 2);
  f.monitor.dispose();
});

test('CPU, RAM and GPU cache survive close/reopen while new readings refresh in the background', async () => {
  const pending = deferred<unknown>();
  let reads = 0;
  const f = fixture({
    readGpu: () => (++reads === 1 ? Promise.resolve({ gpuPercent: 42, gpuProvider: 'nvidia-smi' }) : pending.promise),
  });
  f.monitor.start();
  await Promise.resolve();
  f.setCpu([cpu(120, 180)]);
  f.setMemory({ totalBytes: 1_000, freeBytes: 250 });
  f.advance(2_000);
  f.fire(2_000);
  const cached = f.monitor.snapshot();
  assert.equal(cached.cpuPercent, 20);
  assert.equal(cached.cpuObservedAt, 12_000);
  assert.equal(cached.gpuPercent, 42);
  assert.equal(cached.gpuProvider, 'nvidia-smi');
  f.monitor.stop();
  f.advance(10_000);
  f.monitor.start();
  const reopening = f.monitor.snapshot();
  assert.equal(reopening.cpuPercent, 20, 'a fresh CPU baseline does not blank the last percentage');
  assert.equal(reopening.cpuObservedAt, cached.cpuObservedAt);
  assert.deepEqual(reopening.memory, cached.memory);
  assert.equal(reopening.gpuPercent, 42);
  assert.equal(reopening.gpuObservedAt, cached.gpuObservedAt);
  assert.equal(reopening.gpuProvider, 'nvidia-smi');
  assert.equal(reopening.gpuState, 'stale');
  pending.resolve({ gpuPercent: 7, gpuProvider: 'windows-counters' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuPercent, 7);
  assert.equal(f.monitor.snapshot().gpuProvider, 'windows-counters');
  assert.equal(f.monitor.snapshot().gpuObservedAt, 22_000);
  assert.equal(f.monitor.snapshot().gpuState, 'available');
  f.monitor.dispose();
});

test('invalid or failed updates retain successful metric values and their actual observation times', async () => {
  let attempt = 0;
  const f = fixture({
    readGpu: async () => {
      attempt++;
      if (attempt === 1) return [gpu(1, 0, 27)];
      if (attempt === 2) throw new Error('temporary driver timeout');
      if (attempt === 3) return [];
      return [gpu(1, 0, 0)];
    },
  });
  f.monitor.start();
  await Promise.resolve();
  f.setCpu([cpu(120, 180)]);
  f.advance(2_000);
  f.fire(2_000);
  const cached = f.monitor.snapshot();
  f.setCpu([cpu(1, 1)]);
  f.setMemory({ totalBytes: 0, freeBytes: 0 });
  f.advance(3_000);
  f.fire(2_000);
  f.fire(5_000);
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().cpuPercent, cached.cpuPercent);
  assert.equal(f.monitor.snapshot().cpuObservedAt, cached.cpuObservedAt);
  assert.deepEqual(f.monitor.snapshot().memory, cached.memory);
  assert.equal(f.monitor.snapshot().memoryObservedAt, cached.memoryObservedAt);
  assert.equal(f.monitor.snapshot().gpuPercent, 27);
  assert.equal(f.monitor.snapshot().gpuObservedAt, 10_000);
  assert.equal(f.monitor.snapshot().gpuState, 'stale');
  f.advance(5_000);
  f.fire(5_000);
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuPercent, 27, 'empty provider data does not erase the GPU cache');
  assert.equal(f.monitor.snapshot().gpuObservedAt, 10_000);
  f.advance(5_000);
  f.fire(5_000);
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuPercent, 0, 'an actual idle reading replaces the old value');
  assert.equal(f.monitor.snapshot().gpuObservedAt, 25_000);
  assert.equal(f.monitor.snapshot().gpuState, 'available');
  f.monitor.dispose();
});

test('failed GPU queries show unavailable and retry without breaking CPU/RAM readings', async () => {
  let fail = true;
  const f = fixture({ readGpu: async () => (fail ? Promise.reject(new Error('timeout')) : [gpu(1, 0, 0)]) });
  f.monitor.start();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuState, 'unavailable');
  assert.equal(f.monitor.snapshot().gpuPercent, undefined);
  assert.equal(f.monitor.snapshot().memory?.percent, 50);
  fail = false;
  f.advance(5_000);
  f.fire(5_000);
  await Promise.resolve();
  assert.equal(f.monitor.snapshot().gpuState, 'available');
  assert.equal(f.monitor.snapshot().gpuPercent, 0);
  f.monitor.dispose();
});

test('unsupported systems never launch GPU helpers and invalid memory stays unavailable', () => {
  const f = fixture({ platform: 'freebsd' });
  f.setMemory({ totalBytes: 0, freeBytes: 0 });
  f.monitor.start();
  assert.equal(f.gpuReads, 0);
  assert.equal(f.timers.size, 2, 'CPU and the one-off quick CPU sample');
  assert.equal(f.monitor.snapshot().gpuState, 'unavailable');
  assert.equal(f.monitor.snapshot().memory, undefined);
  for (const memory of [
    { totalBytes: 1_000, freeBytes: 1_001 },
    { totalBytes: 1_000, freeBytes: -1 },
    { totalBytes: NaN, freeBytes: 0 },
  ]) {
    f.setMemory(memory);
    f.fire(2_000);
    assert.equal(f.monitor.snapshot().memory, undefined);
  }
  f.monitor.dispose();
  f.monitor.start();
  assert.equal(f.cpuReads, 4);
  assert.equal(f.timers.size, 0);
});

test('snapshots and callback values cannot mutate the sampler memory state', () => {
  const f = fixture({ platform: 'freebsd' });
  f.monitor.start();
  f.monitor.snapshot().memory!.usedBytes = 1;
  f.updates[0].memory!.usedBytes = 2;
  assert.equal(f.monitor.snapshot().memory?.usedBytes, 500);
  f.monitor.dispose();
});

test('a startup callback can stop or dispose without leaving background timers', () => {
  for (const action of ['stop', 'dispose'] as const) {
    const f = fixture({ onUpdate: () => f.monitor[action]() });
    f.monitor.start();
    assert.equal(f.timers.size, 0);
    assert.equal(f.gpuReads, 0);
    f.monitor.dispose();
  }
});
