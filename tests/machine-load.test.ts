import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMachineReader } from '../src/server/platform/machine-load.ts';
import { localRunLimit, type MachineReading } from '../src/server/member-allocation.ts';
import { Controller } from '../src/server/controller.ts';
import type { RunRecord } from '../src/shared/types.ts';

const GB = 1024 ** 3;
test('CPU is a 15-second moving average with memory and CPU reads cached for three seconds', () => {
  let time = 0,
    busy = 0,
    idle = 0,
    reads = 0,
    memoryReads = 0;
  const read = createMachineReader({
    now: () => time,
    readCpus: () => {
      reads++;
      return [{ user: busy, idle, sys: 0, irq: 0, nice: 0 }];
    },
    readMemory: () => {
      memoryReads++;
      return 8 * GB;
    },
    totalBytes: () => 16 * GB,
    cores: () => 8,
  });
  const first = read();
  assert.equal(first.sampledAt, 0);
  assert.equal(first.cpuPercent, undefined, 'no invented first CPU reading');
  time = 2999;
  assert.equal(read(), first);
  assert.equal(read().sampledAt, 0, 'cache hits retain the source sample time');
  assert.equal(reads, 1);
  for (let i = 1; i <= 5; i++) {
    time = i * 3000;
    busy += 3000;
    assert.equal(read().cpuPercent, 100);
    assert.equal(read().sampledAt, time);
  }
  time += 3000;
  idle += 3000;
  assert.equal(read().cpuPercent, 80, 'one idle sample does not erase the previous busy samples');
  for (let i = 0; i < 4; i++) {
    time += 3000;
    idle += 3000;
    read();
  }
  assert.equal(read().cpuPercent, 0, 'old busy samples expire');
  assert.equal(reads, 11);
  assert.equal(memoryReads, reads);
  assert.equal(read().availableMemoryBytes, 8 * GB);
});

test('thresholds are strict and available memory reserves six percent on large machines', () => {
  const machine = { totalBytes: 64 * GB, cpus: 16, cpuPercent: 84.9, availableMemoryBytes: 8 * GB };
  assert.equal(localRunLimit(machine).reason, 'machine');
  assert.equal(localRunLimit({ ...machine, cpuPercent: 85 }).reason, 'cpu');
  assert.equal(localRunLimit({ ...machine, availableMemoryBytes: 64 * GB * 0.06 }).reason, 'memory');
  assert.equal(localRunLimit({ ...machine, totalBytes: 16 * GB, availableMemoryBytes: 2 * GB }).reason, 'memory');
});

test('top-level and member starts share limits, pending starts count once, and parked parents release execution slots but retain the process cap', () => {
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, { settings: { maxConcurrentRuns: 0 }, active: new Map(), executionResumes: [] });
  let machine = { totalBytes: 16 * GB, cpus: 2, cpuPercent: 92, availableMemoryBytes: 8 * GB };
  controller.machineReading = () => machine;
  assert.equal(controller.hasExecutionCapacity(), true, 'idle exception');
  assert.equal(controller.hasExecutionCapacity(1), false, 'a reserved first start consumes the exception');
  controller.active.set('first', {
    run: { status: 'running', workflowId: 'wf' } as RunRecord,
    abort: new AbortController(),
    project: '/test',
  });
  assert.equal(controller.hasExecutionCapacity(), false);
  assert.equal(controller.hasExecutionCapacity(0, true), true, 'one-time load override');
  controller.settings.maxConcurrentRuns = 1;
  assert.equal(controller.hasExecutionCapacity(0, true), false, 'override preserves explicit caps');
  controller.settings.maxConcurrentRuns = 0;
  machine = { ...machine, cpuPercent: 20 };
  assert.equal(controller.hasExecutionCapacity(['wf', 'a', 'b']), true, 'already created workflow counts once');
  assert.equal(controller.hasExecutionCapacity(3), false, 'top-level process limit');
  assert.equal(controller.hasExecutionCapacity(3, true), false, 'override preserves fixed process limit');
  controller.active.get('first')!.parked = true;
  machine = { ...machine, cpuPercent: 92 };
  assert.equal(controller.hasExecutionCapacity(), true, 'parked parent leaves one execution slot for its child');
  assert.equal(controller.hasExecutionCapacity(1), false, 'a starting child uses the idle exception');
  assert.equal(controller.hasExecutionCapacity(3), false, 'parked processes still obey the fixed cap');
  machine = { ...machine, cpuPercent: 20, availableMemoryBytes: 2 * GB };
  assert.equal(controller.hasExecutionCapacity(), true, 'parked parent also permits a child under memory pressure');
  Object.assign(controller, { executionResumes: [{}] });
  assert.equal(controller.hasExecutionCapacity(0, true), false, 'returning turns keep priority');
});

test('foreground conversation admission requires fresh pressure, separate first-run headroom and a completely free slot', () => {
  const controller = Object.create(Controller.prototype) as Controller;
  const at = Date.now();
  Object.assign(controller, {
    settings: { maxConcurrentRuns: 1 },
    active: new Map(),
    executionResumes: [],
    clock: () => at,
  });
  const healthy = { totalBytes: 32 * GB, cpus: 8, cpuPercent: 92, availableMemoryBytes: 3 * GB, sampledAt: at };
  let reading: MachineReading = healthy;
  controller.machineReading = () => reading;
  const observe = () => controller.machineLoadObservation();
  assert.equal(observe().idleChatAvailable, true);
  assert.equal(observe().sourceSampledAt, new Date(at).toISOString());
  assert.equal(observe().memoryReserveBytes, 2 * GB);
  assert.equal(observe().firstRunHeadroomBytes, GB);
  assert.equal(observe().idleChatMemoryBytes, 1.6 * GB);
  assert.equal(controller.machineLoadObservation(['other']).idleChatAvailable, false);
  for (const patch of [
    { availableMemoryBytes: GB },
    { availableMemoryBytes: 1.6 * GB - 1 },
    { availableMemoryBytes: NaN },
    { availableMemoryBytes: undefined },
    { availableMemoryBytes: 33 * GB },
    { sampledAt: at - 3001 },
    { sampledAt: at + 1 },
    { sampledAt: NaN },
    { sampledAt: undefined },
    { cpuPercent: NaN },
    { cpuPercent: undefined },
    { cpuPercent: 101 },
  ]) {
    reading = { ...healthy, ...patch };
    assert.equal(observe().idleChatAvailable, false, JSON.stringify(patch));
  }
  reading = { ...healthy, availableMemoryBytes: 1.6 * GB };
  assert.equal(observe().idleChatAvailable, true, 'the startup memory boundary is inclusive');
  reading = { ...healthy, cpuPercent: 37.56, availableMemoryBytes: 1_864_527_872 };
  assert.equal(observe().memoryBusy, true);
  assert.equal(observe().idleChatAvailable, true, 'the real news request fits one run despite the ordinary reserve');
  reading = { ...healthy, availableMemoryBytes: GB };
  assert.equal(observe().cpuBusy, true);
  assert.equal(observe().memoryBusy, true, 'CPU pressure cannot hide simultaneous memory pressure');
  reading = healthy;
  controller.active.set('parked', {
    run: { status: 'running' } as RunRecord,
    abort: new AbortController(),
    project: '/test',
    parked: true,
  });
  assert.equal(observe().idleChatAvailable, false);
  controller.active.clear();
  Object.assign(controller, { executionResumes: [{}] });
  assert.equal(observe().idleChatAvailable, false);
});

test('a backward wall clock discards cached future samples and their CPU averaging history', () => {
  let time = 10_000,
    busy = 0,
    idle = 0,
    reads = 0;
  const read = createMachineReader({
    now: () => time,
    readCpus: () => {
      reads++;
      return [{ user: busy, idle, sys: 0, irq: 0, nice: 0 }];
    },
    readMemory: () => 8 * GB,
    totalBytes: () => 16 * GB,
    cores: () => 8,
  });
  read();
  time = 13_000;
  busy = 3000;
  assert.equal(read().cpuPercent, 100);
  time = 7000;
  busy = 6000;
  assert.equal(read().sampledAt, 7000);
  assert.equal(read().cpuPercent, undefined);
  time = 10_000;
  idle = 3000;
  assert.equal(read().cpuPercent, 0);
  assert.equal(reads, 4);
});
