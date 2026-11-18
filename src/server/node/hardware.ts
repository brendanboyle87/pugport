import * as os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readHardware as platformHardware } from '../platform/hardware.ts';
import { availableMemory } from '../platform/system-stats.ts';
import { peerHardwareSchema, type PeerHardware } from './peer-protocol.ts';

export function parseOsRelease(text: string): string | undefined {
  const value = text.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.trim();
  return value?.replace(/^(["'])(.*)\1$/, '$2') || undefined;
}
const defaults = {
  platform: os.platform(),
  readFile: (path: string) => readFile(path, 'utf8'),
  execFile: async (file: string, args: string[], options: { timeout: number; windowsHide: boolean }) =>
    (await promisify(execFile)(file, args, options)).stdout,
  statfs: (path: string) => statfs(path),
  type: os.type,
  release: os.release,
  version: os.version,
  hardware: () => platformHardware(),
  availableMemory: () => availableMemory(),
  totalmem: os.totalmem,
  homedir: os.homedir,
};
export async function readHardware(deps: Partial<typeof defaults> = {}): Promise<PeerHardware> {
  const d = { ...defaults, ...deps };
  const attempt = async <T>(read: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch {
      return undefined;
    }
  };
  const command = (file: string, args: string[]) => d.execFile(file, args, { timeout: 3000, windowsHide: true });
  const fallback = `${(await attempt(d.type)) ?? 'Unknown'} ${(await attempt(d.release)) ?? ''}`.trim();
  const system = await attempt(async () =>
    d.platform === 'linux'
      ? parseOsRelease(await d.readFile('/etc/os-release'))
      : d.platform === 'darwin'
        ? `macOS ${(await command('sw_vers', ['-productVersion'])).trim()}`
        : d.platform === 'win32'
          ? d.version()
          : undefined,
  );
  const hardware = await attempt(d.hardware);
  const disk = await attempt(async () => d.statfs(d.homedir()));
  const values = {
    cpu: hardware?.cpu.model.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined,
    cores: hardware?.cpu.cores,
    threads: hardware?.cpu.threads,
    gpu: hardware?.gpus[0]?.name.slice(0, 120),
    gpuOthers: hardware?.gpus.slice(1, 5).map((gpu) => gpu.name.slice(0, 120)),
    memoryTotal: await attempt(d.totalmem),
    memoryAvailable: await attempt(d.availableMemory),
    diskTotal: disk ? disk.blocks * disk.bsize : undefined,
    diskFree: disk ? disk.bavail * disk.bsize : undefined,
  };
  const result: PeerHardware = { os: (system || fallback).slice(0, 80), readAt: new Date().toISOString() };
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    const value = values[key];
    if (value !== undefined && peerHardwareSchema.shape[key].safeParse(value).success)
      Object.assign(result, { [key]: value });
  }
  return result;
}
