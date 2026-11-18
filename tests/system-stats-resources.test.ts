import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { shortHardwareName } from '../src/shared/hardware-name.ts';
import { physicalAdapters, readHardware } from '../src/server/platform/hardware.ts';
import { gpuPercent, gpuStats, parseNvidiaReading } from '../src/server/platform/system-stats.ts';
import { createWindowsGpuReader, createSystemMonitor } from '../src/electron/system-monitor.ts';
import { trayResourcesHtml, trayPopupHtml } from '../src/electron/tray-popup.ts';
import { trayPopupMeasurementScript } from '../src/electron/tray-dom.ts';
import { fakeHost } from './helpers/fake-host.ts';

test('hardware short names retain useful model identifiers and omit software displays', () => {
  for (const [name, expected] of [
    ['Intel(R) Core(TM) Ultra 9 185H', 'Core Ultra 9 185H'],
    ['Intel(R) Core(TM) i7-12700H CPU @ 2.30GHz', 'Core i7-12700H'],
    ['AMD Ryzen 7 7840HS w/ Radeon 780M Graphics', 'Ryzen 7 7840HS'],
    ['AMD Ryzen 9 5950X 16-Core Processor', 'Ryzen 9 5950X'],
    ['AMD Ryzen 5 5600G with Radeon Graphics', 'Ryzen 5 5600G'],
    ['Apple M3 Pro', 'Apple M3 Pro'],
    ['NVIDIA GeForce RTX 4060 Laptop GPU', 'RTX 4060 Laptop'],
    ['AMD Radeon RX 7800 XT', 'Radeon RX 7800 XT'],
    ['Intel(R) Arc(TM) Graphics', 'Arc Graphics'],
    ['GameViewer Virtual Display Adapter', ''],
    ['Microsoft Remote Display Adapter', ''],
    ['Microsoft Basic Display Adapter', ''],
  ])
    assert.equal(shortHardwareName(name), expected, name);
});

test('NVIDIA selects the busiest GPU and its own VRAM, preserving unsupported values as unknown', () => {
  assert.deepEqual(parseNvidiaReading('10, NVIDIA A, 1024, 8192\n70, NVIDIA B, 3174, 8192\nN/A, NVIDIA C, N/A, N/A'), {
    percent: 70,
    gpu: { name: 'NVIDIA B', others: ['NVIDIA A', 'NVIDIA C'], memory: { usedMiB: 3174, totalMiB: 8192 } },
  });
  assert.deepEqual(parseNvidiaReading('0, NVIDIA A, N/A, 8192'), { percent: 0, gpu: { name: 'NVIDIA A', others: [] } });
  for (const text of ['N/A, NVIDIA A, 0, 8192', '101, NVIDIA A, 0, 8192', ''])
    assert.equal(parseNvidiaReading(text), undefined);
  for (const memory of ['100, N/A', '9000, 8192', '-1, 8192', '0, 0'])
    assert.equal(parseNvidiaReading(`20, NVIDIA A, ${memory}`)?.gpu?.memory, undefined);
});

test('one cached host inventory is shared by concurrent and repeated refreshes, including failures', async () => {
  for (const fail of [false, true]) {
    let spawns = 0;
    let cpuReads = 0;
    const host = fakeHost('win32', {
      run: async () => {
        spawns++;
        if (fail) throw new Error('unavailable');
        return {
          stdout: JSON.stringify({
            cores: 4,
            gpus: [{ name: 'Intel Arc Graphics' }, { name: 'GameViewer Virtual Display Adapter' }],
          }),
          stderr: '',
        };
      },
    });
    const cpu = () => {
      cpuReads++;
      return Array.from({ length: 8 }, () => ({
        model: 'Synthetic CPU',
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      }));
    };
    const results = await Promise.all([readHardware(host, cpu), readHardware(host, cpu)]);
    assert.equal(await readHardware(host, cpu), results[0]);
    assert.equal(spawns, 1);
    assert.equal(cpuReads, 1);
    assert.equal(results[0].cpu.threads, 8);
    assert.equal(results[0].cpu.cores, fail ? undefined : 4);
    assert.equal(results[0].gpus.length, fail ? 0 : 1);
  }
});

test('counter LUID selects the busiest physical GPU and caches inventory across refreshes', async () => {
  let lookups = 0;
  let spawns = 0;
  const adapters = physicalAdapters([
    { name: 'Intel Arc Graphics', luid: 'luid_0x00000000_0x00000001' },
    { name: 'AMD Radeon RX 7800 XT', luid: 'luid_0x00000000_0x00000002' },
    { name: 'Remote Virtual Display', luid: 'luid_0x00000000_0x00000003' },
  ]);
  const reader = createWindowsGpuReader({
    now: () => 1000,
    readAdapters: async () => {
      lookups++;
      return adapters;
    },
    run: async ({ file }) => {
      spawns++;
      if (file === 'nvidia-smi.exe') throw new Error('no NVIDIA');
      return JSON.stringify(
        [
          ['01', 10, 1],
          ['02', 35, 2],
          ['02', 30, 3],
          ['03', 99, 4],
        ].map(([id, usage, pid]) => ({
          Name: `pid_${pid}_luid_0x00000000_0x000000${id}_phys_0_eng_0_engtype_3D`,
          UtilizationPercentage: usage,
        })),
      );
    },
  });
  const signal = new AbortController().signal;
  const expected = {
    gpuPercent: 65,
    gpuProvider: 'windows-counters',
    gpu: { name: 'AMD Radeon RX 7800 XT', others: ['Intel Arc Graphics'] },
  };
  assert.deepEqual(await reader(signal), expected);
  assert.deepEqual(await reader(signal), expected);
  assert.equal(lookups, 1);
  assert.equal(spawns, 3, 'one failed NVIDIA attempt and the existing counter call per refresh');
});

test('NVIDIA refresh queries model and VRAM in the existing call and preserves other physical adapters', async () => {
  let spawns = 0;
  let lookups = 0;
  const reader = createWindowsGpuReader({
    readAdapters: async () => {
      lookups++;
      return [{ name: 'Intel Arc Graphics' }];
    },
    run: async ({ args }) => {
      spawns++;
      assert.equal(args[0], '--query-gpu=utilization.gpu,name,memory.used,memory.total');
      return '50, NVIDIA GeForce RTX 4060 Laptop GPU, 3174, 8192';
    },
  });
  const signal = new AbortController().signal;
  for (let i = 0; i < 3; i++) assert.deepEqual((await reader(signal)).gpu?.others, ['Intel Arc Graphics']);
  assert.equal(spawns, 3);
  assert.equal(lookups, 1);
  let calls = 0;
  const host = fakeHost('linux', {
    run: async (_file, args) => {
      calls++;
      assert.equal(args[0], '--query-gpu=utilization.gpu,name,memory.used,memory.total');
      return { stdout: '50, NVIDIA A, N/A, N/A', stderr: '' };
    },
  });
  assert.equal(await gpuPercent(host), 50);
  assert.equal(await gpuPercent(host), 50);
  assert.equal(calls, 2);
});

test('tray model details are escaped, titled, and leave VRAM off the counter path', () => {
  const resources = {
    observedAt: 0,
    cpu: { model: 'Intel(R) Core(TM) Ultra 9 185H', cores: 16, threads: 22 },
    gpuPercent: 40,
    gpuState: 'available' as const,
    gpuProvider: 'nvidia-smi' as const,
    gpu: {
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      others: ['Intel Arc Graphics', '<unsafe>'],
      memory: { usedMiB: 3174, totalMiB: 8192 },
    },
  };
  const html = trayResourcesHtml(resources);
  assert.match(html, /cpu-detail">Core Ultra 9 185H · 16 核 22 线程/);
  assert.match(html, /gpu-detail">RTX 4060 Laptop · 显存 3\.1\/8\.0 GB/);
  assert.match(html, /title="Intel\(R\) Core\(TM\) Ultra 9 185H · Core Ultra 9 185H · 16 核 22 线程/);
  assert.match(html, /title="NVIDIA GeForce RTX 4060 Laptop GPU.*Intel Arc Graphics.*&lt;unsafe&gt;/);
  assert.doesNotMatch(html, /<unsafe>/);
  assert.doesNotMatch(trayResourcesHtml({ ...resources, gpuProvider: 'windows-counters' }), /显存/);
  assert.match(
    trayPopupHtml({ running: 0, lines: [], totals: [] }, 0, resources),
    /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/,
  );
});

test('macOS names the busiest physical adapter without VRAM and reuses its inventory', async () => {
  let lookups = 0;
  let samples = 0;
  const host = fakeHost('darwin', {
    run: async (file) => {
      if (file === '/bin/sh') {
        lookups++;
        return {
          stdout:
            '4\n' +
            JSON.stringify({
              SPDisplaysDataType: [
                { sppci_model: 'AMD Radeon RX 6800' },
                { sppci_model: 'Intel Arc Graphics' },
                { sppci_model: 'Remote Virtual Display' },
              ],
            }),
          stderr: '',
        };
      }
      samples++;
      return {
        stdout:
          '+-o AMD Radeon RX 6800 <class IOAccelerator>\n"Device Utilization %" = 10\n+-o Intel Arc Graphics <class IOAccelerator>\n"Device Utilization %" = 50\n+-o Remote Virtual Display <class IOAccelerator>\n"Device Utilization %" = 99',
        stderr: '',
      };
    },
  });
  await readHardware(host, () => []);
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await gpuStats(host), {
      percent: 50,
      gpu: { name: 'Intel Arc Graphics', others: ['AMD Radeon RX 6800'] },
    });
  assert.equal(lookups, 1);
  assert.equal(samples, 2);
});

test('CPU line measures the actual cell and drops counts only when they overflow', () => {
  let width = 100;
  const cpu = {
    dataset: { full: 'Core Ultra 9 185H · 16 核 22 线程', model: 'Core Ultra 9 185H' },
    textContent: '',
    get scrollWidth() {
      return this.textContent.length * 5;
    },
    get clientWidth() {
      return width;
    },
  };
  const card = { style: { maxHeight: '' }, getBoundingClientRect: () => ({ bottom: 100 }) };
  const document = {
    querySelector: (selector: string) => (selector === '.card' ? card : cpu),
    getElementById: () => undefined,
  };
  runInNewContext(trayPopupMeasurementScript, { document });
  assert.equal(cpu.textContent, cpu.dataset.model);
  width = 500;
  runInNewContext(trayPopupMeasurementScript, { document });
  assert.equal(cpu.textContent, cpu.dataset.full);
});

test('monitor looks up hardware only once across close and reopen and copies details', async () => {
  let lookups = 0;
  const monitor = createSystemMonitor({
    onUpdate: () => {},
    dependencies: {
      readHardware: async () => {
        lookups++;
        return { cpu: { model: 'Synthetic CPU', cores: 4, threads: 8 }, gpus: [] };
      },
      platform: 'win32',
      readCpus: () => [],
      readMemory: () => ({ totalBytes: 100, freeBytes: 50 }),
      readGpu: async () => ({
        gpuPercent: 10,
        gpuProvider: 'nvidia-smi',
        gpu: { name: 'Synthetic GPU', others: ['Other GPU'] },
      }),
    },
  });
  monitor.start();
  await Promise.resolve();
  monitor.stop();
  monitor.start();
  await Promise.resolve();
  assert.equal(lookups, 1);
  assert.equal(monitor.snapshot().cpu?.threads, 8);
  monitor.snapshot().gpu?.others.push('mutated');
  assert.deepEqual(monitor.snapshot().gpu?.others, ['Other GPU']);
  monitor.dispose();
});
