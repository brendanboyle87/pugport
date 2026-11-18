import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computerSummary, createComputerCache } from '../src/server/platform/computer-context.ts';
import { physicalAdapters, readHardware } from '../src/server/platform/hardware.ts';
import { fakeHost } from './helpers/fake-host.ts';
const computer = {
  system: 'Windows 11',
  memory: 32 * 1024 ** 3,
  hardware: {
    cpu: { model: 'Synthetic CPU', threads: 16 },
    gpus: physicalAdapters([{ name: 'NVIDIA Synthetic GPU', memoryBytes: 8.25 * 1024 ** 3 }]),
  },
};
test('local context includes CPU RAM and rounded dedicated VRAM in both languages; remote omits it', () => {
  assert.match(
    computerSummary(computer),
    /这台电脑：Windows 11 · Synthetic CPU（16 线程） · 32 GB 内存 · NVIDIA Synthetic GPU（8.3 GB 显存）/,
  );
  assert.match(computerSummary(computer, 'en'), /This computer:.*16 threads.*32 GB RAM.*8.3 GB VRAM/);
  assert.equal(computerSummary(computer, 'en', true), '');
  assert.equal(computerSummary(undefined), '');
});
test('cache prewarms once, never waits at dispatch, and refreshes at most daily', async () => {
  let reads = 0,
    time = 0;
  const cache = createComputerCache(
    async () => {
      reads++;
      return computer;
    },
    () => time,
  );
  assert.equal(cache.summary(), '');
  await cache.refresh();
  assert.match(cache.summary(), /这台电脑/);
  await cache.refresh();
  assert.equal(reads, 1);
  time = 86400000;
  await cache.refresh();
  assert.equal(reads, 2);
});
test('failed and timed out inventory silently leaves empty context', async () => {
  const failed = createComputerCache(async () => {
    throw Error('synthetic');
  });
  await failed.refresh();
  assert.equal(failed.summary(), '');
  const stuck = createComputerCache(() => new Promise(() => {}), Date.now, 5);
  const keepAlive = setTimeout(() => {}, 100);
  await stuck.refresh();
  clearTimeout(keepAlive);
  assert.equal(stuck.summary(), '');
});
test('DXGI dedicated memory survives inventory parsing', async () => {
  const host = fakeHost('win32', {
    run: async (_file, args) => {
      assert.match(args.join(' '), /memoryBytes = desc.Video.ToUInt64/);
      return {
        stdout: JSON.stringify({ gpus: [{ name: 'NVIDIA Synthetic GPU', memoryBytes: 8 * 1024 ** 3 }] }),
        stderr: '',
      };
    },
  });
  const result = await readHardware(host, () => []);
  assert.equal(result.gpus[0]?.memoryBytes, 8 * 1024 ** 3);
});
