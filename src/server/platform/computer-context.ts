import { setTimeout, clearTimeout } from 'node:timers';
import * as os from 'node:os';
import { readHardware, type Hardware } from './hardware.ts';
import { currentHost } from './host.ts';
import { underTest } from './under-test.ts';
import { parseOsRelease } from '../node/hardware.ts';
import type { Locale } from '../../shared/i18n/index.ts';

export type Computer = { system: string; hardware: Hardware; memory: number };
const gb = (bytes: number) => String(Number((bytes / 1024 ** 3).toFixed(1)));

export function computerSummary(computer: Computer | undefined, locale: Locale = 'zh-CN', remote = false): string {
  if (!computer || remote) return '';
  const en = locale === 'en';
  const { cpu, gpus } = computer.hardware;
  const parts = [computer.system];
  if (cpu.model)
    parts.push(`${cpu.model}${cpu.threads > 0 ? (en ? ` (${cpu.threads} threads)` : `（${cpu.threads} 线程）`) : ''}`);
  if (computer.memory > 0) parts.push(en ? `${gb(computer.memory)} GB RAM` : `${gb(computer.memory)} GB 内存`);
  for (const gpu of gpus)
    parts.push(
      gpu.name +
        (gpu.memoryBytes && gpu.memoryBytes > 0
          ? en
            ? ` (${gb(gpu.memoryBytes)} GB VRAM)`
            : `（${gb(gpu.memoryBytes)} GB 显存）`
          : ''),
    );
  return (en ? 'This computer: ' : '这台电脑：') + parts.filter(Boolean).join(' · ');
}

async function readComputer(): Promise<Computer | undefined> {
  if (underTest()) return undefined;
  const host = currentHost();
  const hardware = await readHardware(host);
  if (hardware.inventoryFailed) return undefined;
  let system = os.version();
  if (host.platform === 'darwin')
    system = `macOS ${(await host.run('sw_vers', ['-productVersion'], { timeout: 3000 })).stdout.trim()}`;
  if (host.platform === 'linux')
    system = parseOsRelease(host.fs.readFileSync('/etc/os-release', 'utf8')) ?? `${os.type()} ${os.release()}`;
  return { system, hardware, memory: os.totalmem() };
}

export function createComputerCache(read = readComputer, now = Date.now, timeout = 11000) {
  let value: Computer | undefined;
  let next = -Infinity;
  let pending: Promise<void> | undefined;
  const refresh = () => {
    if (pending || now() < next) return pending ?? Promise.resolve();
    next = now() + 86400000;
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        value = await Promise.race([
          Promise.resolve().then(read),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeout);
            timer.unref?.();
          }),
        ]);
      } catch {
        value = undefined;
      } finally {
        clearTimeout(timer);
        pending = undefined;
        // A busy machine can time out the first read; try again soon instead of a day later.
        if (!value) next = now() + 600000;
      }
    })();
    return pending;
  };
  return {
    refresh,
    summary(locale?: Locale, remote = false) {
      void refresh();
      return computerSummary(value, locale, remote);
    },
  };
}
export const localComputer = createComputerCache();
