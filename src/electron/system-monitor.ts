import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { cpuUsagePercent, type CpuTimes } from '../server/platform/machine-load.ts';
export { cpuUsagePercent, type CpuTimes } from '../server/platform/machine-load.ts';
import {
  availableMemory,
  gpuStats,
  nvidiaQuery,
  parseNvidiaReading,
  parseNvidiaSmi,
  type GpuDetails,
} from '../server/platform/system-stats.ts';
import { readHardware, type CpuHardware, type GpuHardware, type Hardware } from '../server/platform/hardware.ts';

export type SystemResources = {
  cpuPercent?: number;
  gpuPercent?: number;
  cpu?: CpuHardware;
  gpu?: GpuDetails;
  memory?: { usedBytes: number; totalBytes: number; percent: number };
  observedAt: number;
  cpuObservedAt?: number;
  memoryObservedAt?: number;
  gpuObservedAt?: number;
  gpuState?: 'loading' | 'available' | 'unavailable' | 'stale';
  gpuProvider?: 'windows-counters' | 'nvidia-smi';
};

type GpuReading = { gpuPercent: number; gpuProvider: NonNullable<SystemResources['gpuProvider']>; gpu?: GpuDetails };

type MemoryReading = { totalBytes: number; freeBytes: number };
type Dependencies = {
  readCpus: () => readonly CpuTimes[];
  readMemory: () => MemoryReading;
  readGpu: (signal: AbortSignal) => Promise<unknown>;
  readHardware: () => Promise<Hardware | undefined>;
  platform: NodeJS.Platform;
  now: () => number;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
};

/**
 * GPU Engine counters are per PID. Sum the same adapter/engine across PIDs, then use the busiest
 * engine, as Task Manager does. Adding different engines or adapters would inflate the percentage.
 * https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/
 */
export function gpuUsagePercent(value: unknown): number | undefined {
  return windowsGpuUsage(value)?.percent;
}

function windowsGpuUsage(value: unknown, adapters?: GpuHardware[]): { percent: number; gpu?: GpuDetails } | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value.replace(/^\uFEFF/, '').trim());
    } catch {
      return;
    }
  }
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  const engines = new Map<string, { percent: number; adapter?: GpuHardware }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = row.Name;
    const percent = row.UtilizationPercentage;
    if (typeof name !== 'string' || typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) continue;
    const engine = /^pid_\d+_(luid_0x[\da-f]+_0x[\da-f]+_phys_\d+_eng_\d+)_engtype_/i.exec(name)?.[1];
    if (!engine) continue;
    const key = engine.toLowerCase();
    const luid = /^(luid_0x[\da-f]+_0x[\da-f]+)/i.exec(key)?.[1];
    const normalize = (id?: string) => id?.replace(/0x0+(?=[\da-f])/g, '0x');
    const adapter = adapters?.find((item) => normalize(item.luid) === normalize(luid));
    // Unknown counter identities must not be guessed from CIM/DXGI enumeration order.
    if (adapters?.length && !adapter && !(adapters.length === 1 && !adapters[0].luid)) continue;
    engines.set(key, {
      percent: (engines.get(key)?.percent ?? 0) + percent,
      adapter: adapter ?? (adapters?.length === 1 ? adapters[0] : undefined),
    });
  }
  if (!engines.size) return;
  const busiest = [...engines.values()].sort((a, b) => b.percent - a.percent)[0];
  return {
    percent: Math.min(100, busiest.percent),
    ...(busiest.adapter
      ? {
          gpu: {
            name: busiest.adapter.name,
            others: (adapters ?? []).filter((adapter) => adapter !== busiest.adapter).map((adapter) => adapter.name),
          },
        }
      : {}),
  };
}

/** NVIDIA may return N/A or Not Supported; neither means zero usage. */
export function nvidiaGpuUsagePercent(value: unknown): number | undefined {
  if (typeof value !== 'string') return;
  return parseNvidiaSmi(value);
}

const gpuCommand = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$rows = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage | Select-Object Name,UtilizationPercentage)',
  'ConvertTo-Json -InputObject $rows -Compress',
].join('; ');

type GpuCommand = {
  file: string;
  args: string[];
  timeout: number;
  signal: AbortSignal;
};
type GpuCommandRunner = (command: GpuCommand) => Promise<string>;

function runGpuCommand({ file, args, timeout, signal }: GpuCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout, maxBuffer: 1_048_576, encoding: 'utf8', signal },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * The NVIDIA driver tool answers in a fraction of a second; the Windows counters (which also cover Intel and
 * AMD) start PowerShell and can take seconds, longer still when memory is tight. Try NVIDIA first, then the
 * counters, and keep using whichever worked. A machine without NVIDIA re-checks for it every ten minutes.
 */
export function createWindowsGpuReader(
  dependencies: { run?: GpuCommandRunner; now?: () => number; readAdapters?: () => Promise<GpuHardware[]> } = {},
) {
  const run = dependencies.run ?? runGpuCommand;
  const now = dependencies.now ?? Date.now;
  let preferCountersUntil = 0;
  let adapters: Promise<GpuHardware[]> | undefined;
  const inventory = () =>
    (adapters ??= (dependencies.readAdapters?.() ?? readHardware().then((hardware) => hardware.gpus)).catch(() => []));
  const counters = async (signal: AbortSignal): Promise<GpuReading> => {
    const value = await run({
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', gpuCommand],
      timeout: 4_000,
      signal,
    });
    const reading = windowsGpuUsage(value, await inventory());
    if (!reading) throw new Error('GPU engine counters were unavailable');
    return {
      gpuPercent: reading.percent,
      gpuProvider: 'windows-counters',
      ...(reading.gpu ? { gpu: reading.gpu } : {}),
    };
  };
  const nvidia = async (signal: AbortSignal): Promise<GpuReading> => {
    const value = await run({
      file: 'nvidia-smi.exe',
      args: [nvidiaQuery, '--format=csv,noheader,nounits'],
      timeout: 2_000,
      signal,
    });
    const reading = parseNvidiaReading(value);
    if (!reading) throw new Error('NVIDIA GPU utilization was unavailable');
    if (reading.gpu) {
      const names = (await inventory()).map((adapter) => adapter.name);
      reading.gpu.others = [...new Set([...reading.gpu.others, ...names])].filter((name) => name !== reading.gpu!.name);
    }
    return { gpuPercent: reading.percent, gpuProvider: 'nvidia-smi', ...(reading.gpu ? { gpu: reading.gpu } : {}) };
  };
  return async (signal: AbortSignal): Promise<GpuReading> => {
    signal.throwIfAborted();
    const preferNvidia = now() >= preferCountersUntil;
    try {
      const reading = await (preferNvidia ? nvidia(signal) : counters(signal));
      signal.throwIfAborted();
      return reading;
    } catch (firstError) {
      signal.throwIfAborted();
      try {
        const reading = await (preferNvidia ? counters(signal) : nvidia(signal));
        signal.throwIfAborted();
        preferCountersUntil = reading.gpuProvider === 'windows-counters' ? now() + 600_000 : 0;
        return reading;
      } catch (secondError) {
        signal.throwIfAborted();
        throw new AggregateError([firstError, secondError], 'No GPU utilization provider was available');
      }
    }
  };
}

export const readWindowsGpu = createWindowsGpuReader();

function gpuReading(value: unknown): {
  gpuPercent?: number;
  gpuProvider?: SystemResources['gpuProvider'];
  gpu?: GpuDetails;
} {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'gpuPercent' in value) {
    const { gpuPercent, gpuProvider, gpu } = value as Partial<GpuReading>;
    if (typeof gpuPercent === 'number' && Number.isFinite(gpuPercent) && gpuPercent >= 0 && gpuPercent <= 100)
      return {
        gpuPercent,
        ...(gpu ? { gpu } : {}),
        ...(gpuProvider === 'windows-counters' || gpuProvider === 'nvidia-smi' ? { gpuProvider } : {}),
      };
    return {};
  }
  return { gpuPercent: gpuUsagePercent(value) };
}

/** No sampling or helper process while the tray popup is hidden. */
export function createSystemMonitor(options: {
  onUpdate: (resources: SystemResources) => void;
  dependencies?: Partial<Dependencies>;
}) {
  const deps: Dependencies = {
    readCpus: () => cpus().map(({ times }) => times),
    readMemory: () => ({ totalBytes: totalmem(), freeBytes: availableMemory() ?? freemem() }),
    readGpu: async (signal) => {
      if (process.platform === 'win32') return readWindowsGpu(signal);
      const reading = await gpuStats(undefined, signal);
      return reading
        ? {
            gpuPercent: reading.percent,
            gpu: reading.gpu,
            gpuProvider: process.platform === 'darwin' ? undefined : 'nvidia-smi',
          }
        : undefined;
    },
    readHardware,
    platform: process.platform,
    now: Date.now,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    ...options.dependencies,
  };
  let resources: SystemResources = {
    observedAt: 0,
    gpuState: ['win32', 'darwin', 'linux'].includes(deps.platform) ? 'loading' : 'unavailable',
  };
  let previous: readonly CpuTimes[] = [];
  let active = false;
  let disposed = false;
  let generation = 0;
  let cpuTimer: ReturnType<typeof setInterval> | undefined;
  let quickCpuTimer: ReturnType<typeof setInterval> | undefined;
  let gpuTimer: ReturnType<typeof setInterval> | undefined;
  let gpuRequest: { controller: AbortController; generation: number } | undefined;
  let lastGpuAttempt: number | undefined;
  let hardwareRequested = false;

  function snapshot(): SystemResources {
    return {
      ...resources,
      ...(resources.cpu && { cpu: { ...resources.cpu } }),
      ...(resources.gpu && {
        gpu: {
          ...resources.gpu,
          others: [...resources.gpu.others],
          ...(resources.gpu.memory && { memory: { ...resources.gpu.memory } }),
        },
      }),
      ...(resources.memory && { memory: { ...resources.memory } }),
    };
  }

  function publish() {
    if (active && !disposed) options.onUpdate(snapshot());
  }

  function sampleCpuMemory() {
    if (!active || disposed) return;
    let cpuPercent: number | undefined;
    let memory: SystemResources['memory'];
    try {
      const current = deps.readCpus().map((times) => ({ ...times }));
      cpuPercent = cpuUsagePercent(previous, current);
      previous = current;
    } catch {
      previous = [];
    }
    try {
      const { totalBytes, freeBytes } = deps.readMemory();
      if (
        Number.isFinite(totalBytes) &&
        totalBytes > 0 &&
        Number.isFinite(freeBytes) &&
        freeBytes >= 0 &&
        freeBytes <= totalBytes
      ) {
        const usedBytes = totalBytes - freeBytes;
        memory = { totalBytes, usedBytes, percent: (usedBytes / totalBytes) * 100 };
      }
    } catch {
      // Missing system metrics are shown as unavailable, never as fabricated zeroes.
    }
    const now = deps.now();
    resources = {
      ...resources,
      ...(cpuPercent === undefined ? {} : { cpuPercent, cpuObservedAt: now }),
      ...(memory === undefined ? {} : { memory, memoryObservedAt: now }),
      observedAt: now,
    };
    publish();
  }

  // A read still running from before a close is reused rather than duplicated; its result fills the cache.
  async function sampleGpu() {
    if (!active || disposed || !['win32', 'darwin', 'linux'].includes(deps.platform) || gpuRequest) return;
    const now = deps.now();
    if (lastGpuAttempt !== undefined && now - lastGpuAttempt < 5_000) return;
    lastGpuAttempt = now;
    const request = { controller: new AbortController(), generation };
    gpuRequest = request;
    try {
      const result = await deps.readGpu(request.controller.signal);
      if (disposed) return;
      const { gpuPercent, gpuProvider, gpu } = gpuReading(result);
      resources =
        gpuPercent === undefined
          ? { ...resources, gpuState: resources.gpuPercent === undefined ? 'unavailable' : 'stale' }
          : { ...resources, gpuPercent, gpuProvider, gpu, gpuObservedAt: deps.now(), gpuState: 'available' };
      publish();
    } catch {
      if (disposed) return;
      resources = { ...resources, gpuState: resources.gpuPercent === undefined ? 'unavailable' : 'stale' };
      publish();
    } finally {
      if (gpuRequest === request) gpuRequest = undefined;
    }
  }

  function stop() {
    active = false;
    generation++;
    if (cpuTimer !== undefined) deps.clearInterval(cpuTimer);
    if (quickCpuTimer !== undefined) deps.clearInterval(quickCpuTimer);
    if (gpuTimer !== undefined) deps.clearInterval(gpuTimer);
    cpuTimer = undefined;
    quickCpuTimer = undefined;
    gpuTimer = undefined;
    previous = [];
  }

  return {
    snapshot,
    start() {
      if (disposed || active) return;
      active = true;
      generation++;
      if (!hardwareRequested) {
        hardwareRequested = true;
        void deps
          .readHardware()
          .then((hardware) => {
            if (disposed || !hardware) return;
            resources = { ...resources, cpu: hardware.cpu };
            publish();
          })
          .catch(() => {});
      }
      if (
        resources.gpuPercent !== undefined &&
        resources.gpuObservedAt !== undefined &&
        deps.now() - resources.gpuObservedAt > 5_000
      )
        resources = { ...resources, gpuState: 'stale' };
      sampleCpuMemory();
      if (!active || disposed) return;
      cpuTimer = deps.setInterval(sampleCpuMemory, 2_000);
      // CPU needs two samples; take the second after half a second instead of waiting for the next tick.
      const quick = deps.setInterval(() => {
        deps.clearInterval(quick);
        if (quickCpuTimer === quick) quickCpuTimer = undefined;
        sampleCpuMemory();
      }, 500);
      quickCpuTimer = quick;
      if (['win32', 'darwin', 'linux'].includes(deps.platform)) {
        gpuTimer = deps.setInterval(() => void sampleGpu(), 5_000);
        void sampleGpu();
      }
    },
    stop,
    dispose() {
      disposed = true;
      stop();
      gpuRequest?.controller.abort();
    },
  };
}
