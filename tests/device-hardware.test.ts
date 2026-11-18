import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOsRelease, readHardware } from '../src/server/node/hardware.ts';
import { shortHardwareName } from '../src/shared/hardware-name.ts';
test('OS release uses the distribution name', () => {
  assert.equal(parseOsRelease('NAME=Linux\nPRETTY_NAME="Ubuntu 26.04.1 LTS"\n'), 'Ubuntu 26.04.1 LTS');
  assert.equal(parseOsRelease('NAME=Linux'), undefined);
});
const deps = {
  type: () => 'FixtureOS',
  release: () => '1',
  version: () => 'Windows 11 Home',
  hardware: async () => ({
    cpu: { model: ' Apple   M2 ', cores: 8, threads: 8 },
    gpus: [{ name: 'Apple M2' }, { name: 'Second GPU' }],
  }),
  totalmem: () => 8 * 1024 ** 3,
  availableMemory: () => 2 * 1024 ** 3,
  homedir: () => '/synthetic/private-user',
  statfs: async () => ({ blocks: 100, bsize: 4096, bavail: 40 }) as import('node:fs').StatsFs,
  readFile: async (path: string) => {
    assert.equal(path, '/etc/os-release');
    return 'PRETTY_NAME="Ubuntu 26.04.1 LTS"';
  },
  execFile: async () => {
    throw new Error('unexpected child process');
  },
};
test('Linux hardware delegates inventory and available memory, exposes no paths', async () => {
  const hardware = await readHardware({ ...deps, platform: 'linux' });
  assert.equal(hardware.os, 'Ubuntu 26.04.1 LTS');
  assert.equal(hardware.cores, 8);
  assert.equal(hardware.threads, 8);
  assert.equal(hardware.diskFree, 40 * 4096);
  assert.equal(hardware.memoryAvailable, 2 * 1024 ** 3);
  assert.equal(hardware.cpu, 'Apple M2');
  assert.equal(hardware.gpu, 'Apple M2');
  assert.deepEqual(hardware.gpuOthers, ['Second GPU']);
  assert.doesNotMatch(JSON.stringify(hardware), /hostname|private-user|synthetic|path|username/);
});
test('macOS adds only OS version with safe child options', async () => {
  const hardware = await readHardware({
    ...deps,
    platform: 'darwin',
    execFile: async (file, args, options) => {
      assert.equal(file, 'sw_vers');
      assert.deepEqual(args, ['-productVersion']);
      assert.deepEqual(options, { timeout: 3000, windowsHide: true });
      return '15.7.5\n';
    },
  });
  assert.equal(hardware.os, 'macOS 15.7.5');
  assert.equal(hardware.cores, 8);
  assert.equal(hardware.memoryAvailable, deps.availableMemory());
});
test('hardware failures are independent and all peer strings and GPU lists are bounded', async () => {
  const fail = () => {
    throw new Error('missing');
  };
  const hardware = await readHardware({
    ...deps,
    platform: 'darwin',
    execFile: fail,
    hardware: fail,
    statfs: fail,
    totalmem: fail,
  });
  assert.equal(hardware.os, 'FixtureOS 1');
  assert.equal(hardware.cpu, undefined);
  assert.equal(hardware.diskTotal, undefined);
  assert.equal(hardware.memoryTotal, undefined);
  assert.equal(hardware.memoryAvailable, deps.availableMemory());
  const long = await readHardware({
    ...deps,
    platform: 'win32',
    version: () => 'w'.repeat(100),
    hardware: async () => ({
      cpu: { model: 'c'.repeat(200), threads: 8 },
      gpus: Array.from({ length: 8 }, () => ({ name: 'g'.repeat(200) })),
    }),
  });
  assert.equal(long.os.length, 80);
  assert.equal(long.cpu!.length, 120);
  assert.equal(long.gpu!.length, 120);
  assert.deepEqual(
    long.gpuOthers!.map((gpu) => gpu.length),
    [120, 120, 120, 120],
  );
  assert.equal((await readHardware({ ...deps, availableMemory: () => undefined })).memoryAvailable, undefined);
});

test('Linux lspci inventory prefers bracketed products and preserves names without brackets', async () => {
  const { readHardware: inventory } = await import('../src/server/platform/hardware.ts');
  const { fakeHost, fakeFs } = await import('./helpers/fake-host.ts');
  const host = fakeHost('linux', {
    fs: fakeFs({ readFileSync: () => '' }),
    run: async (file) => {
      assert.equal(file, 'lspci');
      return {
        stdout: [
          '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 620 (rev 07)',
          '00:03.0 VGA compatible controller: Intel Corporation Kaby Lake-U GT2 [HD Graphics 620] (rev 07)',
          '01:00.0 3D controller: NVIDIA Corporation GP108M [GeForce MX150] (rev a1)',
          '02:00.0 Display controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 23 [Radeon RX 6600/6600 XT/6600M] (rev c7)',
          '03:00.0 VGA compatible controller: Example Co., Ltd. Graphics',
          '04:00.0 Audio device: Example Corporation Audio',
        ].join('\n'),
        stderr: '',
      };
    },
  });
  const names = (await inventory(host, () => [])).gpus.map((gpu) => gpu.name);
  assert.deepEqual(names, [
    'Intel UHD Graphics 620',
    'Intel HD Graphics 620',
    'NVIDIA GeForce MX150',
    'AMD Radeon RX 6600',
    'Example Graphics',
  ]);
  assert.deepEqual(names.map(shortHardwareName), [
    'UHD Graphics 620',
    'HD Graphics 620',
    'MX150',
    'Radeon RX 6600',
    'Example Graphics',
  ]);
});
