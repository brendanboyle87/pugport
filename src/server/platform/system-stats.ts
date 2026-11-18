import { currentHost, type Host } from './host.ts';
import { readHardware } from './hardware.ts';
import { shortHardwareName } from '../../shared/hardware-name.ts';

/*
 * Machine readings that differ per platform. The parsers are pure so captured command output can be tested on
 * any system; a reading that cannot be taken is undefined (or false for the battery), never a made-up zero.
 */

/** macOS `vm_stat`: memory the system can hand out without swapping (free + inactive + speculative + purgeable). */
export function parseVmStat(text: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return undefined;
  const pages = (label: string) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const free = pages('Pages free');
  const inactive = pages('Pages inactive');
  if (free === undefined || inactive === undefined) return undefined;
  return (free + inactive + (pages('Pages speculative') ?? 0) + (pages('Pages purgeable') ?? 0)) * pageSize;
}

/** Linux `/proc/meminfo`: the kernel's own estimate, MemAvailable (kB). */
export function parseMeminfo(text: string): number | undefined {
  const kilobytes = Number(/^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text)?.[1]);
  return Number.isSafeInteger(kilobytes) && kilobytes >= 0 ? kilobytes * 1024 : undefined;
}

/** macOS `pmset -g batt`: "Now drawing from 'Battery Power'" or "'AC Power'". */
export function parsePmset(text: string): boolean {
  return /drawing from '?Battery Power/i.test(text);
}

export type PowerSupply = { type?: string; online?: string; status?: string };
/** Linux `/sys/class/power_supply/*`: on battery when no charger is online and a battery is discharging. */
export function parsePowerSupplies(supplies: PowerSupply[]): boolean {
  const value = (text?: string) => text?.trim().toLowerCase() ?? '';
  if (supplies.some((supply) => value(supply.type) !== 'battery' && value(supply.online) === '1')) return false;
  return supplies.some((supply) => value(supply.type) === 'battery' && value(supply.status) === 'discharging');
}

/** macOS `ioreg -r -d 1 -w 0 -c IOAccelerator`: the busiest GPU's "Device Utilization %". */
export function parseIoreg(text: string): number | undefined {
  const values = [...text.matchAll(/"Device Utilization %"\s*=\s*(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((percent) => Number.isFinite(percent) && percent >= 0 && percent <= 100);
  return values.length ? Math.max(...values) : undefined;
}

export const nvidiaQuery = '--query-gpu=utilization.gpu,name,memory.used,memory.total';
export type GpuDetails = { name: string; others: string[]; memory?: { usedMiB: number; totalMiB: number } };
export type NvidiaReading = { percent: number; gpu?: GpuDetails };

/** MiB reported by the driver, never WMI's truncated AdapterRAM. Unsupported fields stay unknown. */
export function parseNvidiaReading(text: string): NvidiaReading | undefined {
  const rows = text.split(/\r?\n/).flatMap((line) => {
    const [usage, name, used, total] = line.split(',').map((part) => part.trim());
    if (name && !shortHardwareName(name)) return [];
    const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(usage);
    const percent = match ? Number(match[1]) : NaN;
    const numeric = (value?: string) => (value !== undefined && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN);
    const usedMiB = numeric(used);
    const totalMiB = numeric(total);
    const memory =
      Number.isFinite(totalMiB) && Number.isFinite(usedMiB) && totalMiB > 0 && usedMiB >= 0 && usedMiB <= totalMiB
        ? { usedMiB, totalMiB }
        : undefined;
    return [{ percent, name: name && !/^(?:N\/A|\[Not Supported\])$/i.test(name) ? name : undefined, memory }];
  });
  const busiest = rows
    .filter((row) => Number.isFinite(row.percent) && row.percent >= 0 && row.percent <= 100)
    .sort((a, b) => b.percent - a.percent)[0];
  if (!busiest) return;
  return {
    percent: busiest.percent,
    ...(busiest.name
      ? {
          gpu: {
            name: busiest.name,
            others: rows.filter((row) => row !== busiest && row.name).map((row) => row.name!),
            ...(busiest.memory ? { memory: busiest.memory } : {}),
          },
        }
      : {}),
  };
}

export function parseNvidiaSmi(text: string): number | undefined {
  return parseNvidiaReading(text)?.percent;
}

const memoryCache = new WeakMap<Host, { at: number; value: number | undefined }>();

/**
 * Memory available to new programs, in bytes. Windows: os.freemem() (already the available figure there).
 * Linux: MemAvailable. macOS: vm_stat (os.freemem() counts only completely free pages, which macOS keeps small),
 * read at most once a second; undefined when vm_stat cannot be read.
 */
export function availableMemory(host: Host = currentHost()): number | undefined {
  if (host.platform === 'win32') return host.freemem();
  const clamp = (value: number | undefined) =>
    value === undefined ? undefined : Math.max(0, Math.min(value, host.totalmem()));
  if (host.platform === 'darwin') {
    const cached = memoryCache.get(host);
    const now = Date.now();
    if (cached && now - cached.at < 1000) return cached.value;
    let value: number | undefined;
    try {
      value = clamp(parseVmStat(host.runSync('/usr/bin/vm_stat', [], { timeout: 2000 })));
    } catch {
      value = undefined;
    }
    memoryCache.set(host, { at: now, value });
    return value;
  }
  try {
    return clamp(parseMeminfo(host.fs.readFileSync('/proc/meminfo', 'utf8'))) ?? host.freemem();
  } catch {
    return host.freemem();
  }
}

/** Whether the computer runs on battery; a desktop, or a reading that fails, never does. */
export async function onBattery(host: Host = currentHost()): Promise<boolean> {
  if (host.platform === 'win32') {
    const { stdout } = await host
      .run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1).PowerOnline',
        ],
        { timeout: 15_000, windowsHide: true },
      )
      .catch(() => ({ stdout: '' }));
    return stdout.trim().toLowerCase() === 'false';
  }
  if (host.platform === 'darwin') {
    const { stdout } = await host
      .run('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000 })
      .catch(() => ({ stdout: '' }));
    return parsePmset(stdout);
  }
  const root = '/sys/class/power_supply';
  try {
    const read = (name: string, file: string) => {
      try {
        return host.fs.readFileSync(host.path.join(root, name, file), 'utf8');
      } catch {
        return undefined;
      }
    };
    return parsePowerSupplies(
      host.fs
        .readdirSync(root)
        .map((name) => ({ type: read(name, 'type'), online: read(name, 'online'), status: read(name, 'status') })),
    );
  } catch {
    return false;
  }
}

/** The busiest GPU's utilization: macOS ioreg, elsewhere nvidia-smi; undefined when there is no reading. */
export async function gpuStats(host: Host = currentHost(), signal?: AbortSignal): Promise<NvidiaReading | undefined> {
  try {
    if (host.platform === 'darwin') {
      const { stdout } = await host.run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'], {
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      });
      const { gpus } = await readHardware(host);
      // IOAccelerator entries contain the device name before their utilization dictionary.
      const entries = stdout.split(/(?=\+-o )/).flatMap((entry) => {
        const name = /\+-o\s+(.+?)(?:\s+<|\s*$)/m.exec(entry)?.[1];
        return name && !shortHardwareName(name) ? [] : [{ percent: parseIoreg(entry), entry }];
      });
      const busiest = entries.filter((entry) => entry.percent !== undefined).sort((a, b) => b.percent! - a.percent!)[0];
      if (!busiest) return;
      const adapter =
        gpus.find((gpu) => busiest?.entry.includes(gpu.name)) ?? (gpus.length === 1 ? gpus[0] : undefined);
      return {
        percent: busiest.percent!,
        ...(adapter
          ? { gpu: { name: adapter.name, others: gpus.filter((gpu) => gpu !== adapter).map((gpu) => gpu.name) } }
          : {}),
      };
    }
    const { stdout } = await host.run(
      host.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi',
      [nvidiaQuery, '--format=csv,noheader,nounits'],
      { timeout: 2000, windowsHide: true, ...(signal ? { signal } : {}) },
    );
    return parseNvidiaReading(stdout);
  } catch {
    return undefined;
  }
}

export async function gpuPercent(host: Host = currentHost(), signal?: AbortSignal): Promise<number | undefined> {
  return (await gpuStats(host, signal))?.percent;
}
