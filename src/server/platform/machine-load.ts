import { availableParallelism, cpus, totalmem } from 'node:os';
import type { MachineReading } from '../member-allocation.ts';
import { availableMemory } from './system-stats.ts';

export type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };
const cpuKeys = ['user', 'nice', 'sys', 'idle', 'irq'] as const;

/** Time spent working across all logical CPUs between samples; the first sample has no percentage. */
export function cpuUsagePercent(previous: readonly CpuTimes[], current: readonly CpuTimes[]): number | undefined {
  if (!previous.length || previous.length !== current.length) return;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < current.length; i++) {
    for (const key of cpuKeys) {
      const before = previous[i][key];
      const after = current[i][key];
      if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < before) return;
      const delta = after - before;
      total += delta;
      if (key === 'idle') idle += delta;
    }
  }
  if (!Number.isFinite(total) || total <= 0) return;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

export const machineSampleMs = 3000;
const averageMs = 15000;

/** Cached OS counters only: no process scans, shell commands for CPU, or GPU probes. */
export function createMachineReader(
  dependencies: {
    now?: () => number;
    readCpus?: () => readonly CpuTimes[];
    readMemory?: () => number | undefined;
    totalBytes?: () => number;
    cores?: () => number;
  } = {},
): () => MachineReading {
  const now = dependencies.now ?? Date.now;
  const readCpus = dependencies.readCpus ?? (() => cpus().map((cpu) => cpu.times));
  const history: { at: number; times: readonly CpuTimes[] }[] = [];
  let cached: MachineReading;
  let sampledAt = -Infinity;
  return () => {
    const at = now();
    if (cached && at >= sampledAt && at - sampledAt < machineSampleMs) return cached;
    if (at < sampledAt) history.length = 0;
    const times = readCpus();
    while (history.length && history[0].at < at - averageMs) history.shift();
    const cpuPercent = history.length ? cpuUsagePercent(history[0].times, times) : undefined;
    history.push({ at, times });
    sampledAt = at;
    cached = {
      sampledAt: at,
      totalBytes: (dependencies.totalBytes ?? totalmem)(),
      cpus: (dependencies.cores ?? availableParallelism)(),
      availableMemoryBytes: (dependencies.readMemory ?? availableMemory)(),
      cpuPercent,
    };
    return cached;
  };
}
