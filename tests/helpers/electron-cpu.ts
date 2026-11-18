import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpuUsagePercent } from '../../src/server/platform/machine-load.ts';

export async function waitForElectronCpu() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const before = cpus().map((cpu) => cpu.times);
    await sleep(1000);
    const percent = cpuUsagePercent(
      before,
      cpus().map((cpu) => cpu.times),
    );
    assert.notEqual(percent, undefined, 'CPU reading required before Electron launch');
    console.log(`CPU before Electron: ${percent!.toFixed(1)}%`);
    if (percent! <= 70) return;
    assert.ok(Date.now() < deadline, 'CPU stayed above 70%; Electron was not launched');
  }
}
