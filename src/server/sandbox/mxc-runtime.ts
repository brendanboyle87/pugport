import { execFile } from '../platform/test-process.ts';
import { release } from 'node:os';
import { promisify } from 'node:util';
import type { SandboxStatus } from '../../shared/sandbox.ts';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import type { MxcDriver } from './mxc-child.ts';
import { mxcHelpers } from './helper-client.ts';
import { failureReason } from './helper-protocol.ts';
import {
  captureDenialsStreamingSupported,
  captureDenialsStreamingUnavailableReason,
} from '../../shared/sandbox-capabilities.ts';

export const minimumBuilds: Readonly<Record<number, number>> = {
  26100: 9278,
  26200: 9278,
  26300: 9550,
  28000: 2804,
};

export function parseUbr(output: string): number | undefined {
  const value = /^\s*UBR\s+REG_DWORD\s+(0x[\da-f]+|\d+)\s*$/im.exec(output)?.[1];
  return value === undefined ? undefined : Number(value);
}

export function supportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]),
    minor = Number(match[2]);
  return (major === 24 && minor >= 21) || (major === 26 && minor >= 8) || major > 26;
}

type ProbeResult = {
  sdkVersion?: string;
  tier?: string;
  probes?: { baseContainerSupportsDenyPaths?: boolean };
};
export type MxcSdk = { probe: () => ProbeResult | Promise<ProbeResult> };
type Dependencies = {
  platform: () => string;
  arch: () => string;
  release: () => string;
  nodeVersion: () => string;
  ubr: () => Promise<number | undefined>;
  loadSdk: () => Promise<MxcSdk>;
};
const run = promisify(execFile);
const defaults: Dependencies = {
  platform: () => process.platform,
  arch: () => process.arch,
  release,
  nodeVersion: () => process.versions.node,
  ubr: async () => {
    const { stdout } = await run(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'UBR', '/reg:64'],
      { windowsHide: true, timeout: 5000, encoding: 'utf8' },
    );
    return parseUbr(stdout);
  },
  // Probe also enters koffi/native FFI. Keep it outside the backend, just like spawn.
  loadSdk: async () => ({ probe: () => mxcHelpers.probe() }),
};

export function createMxcRuntime(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  let status: SandboxStatus = { available: false, reason: 'checking', message: '正在检测沙箱' };
  let pending: Promise<SandboxStatus> | undefined;
  let generation = 0;
  async function detect(): Promise<SandboxStatus> {
    const base = { available: false, nodeVersion: deps.nodeVersion() };
    if (deps.platform() !== 'win32' || deps.arch() !== 'x64')
      return { ...base, reason: 'platform', message: '不可用：当前仅支持 Windows x64' };
    const buildNumber = Number(/^10\.0\.(\d+)(?:\.|$)/.exec(deps.release())?.[1]);
    const ubr = await deps.ubr().catch(() => undefined);
    const minimum = minimumBuilds[buildNumber];
    const build = Number.isFinite(buildNumber) ? `${buildNumber}.${ubr ?? '?'}` : deps.release();
    const requiredBuild = minimum === undefined ? undefined : `${buildNumber}.${minimum}`;
    const host = { ...base, build, requiredBuild };
    // Unknown branches and unreadable UBR fail closed; never infer support across Windows branches.
    if (minimum === undefined || ubr === undefined || ubr < minimum)
      return {
        ...host,
        reason: 'build',
        message: requiredBuild
          ? `不可用：系统 ${build}，需要 ${requiredBuild}${buildNumber === 26300 ? '（KB5124010）' : ''}`
          : `不可用：系统 ${build}，尚未确认支持`,
      };
    if (!supportedNode(base.nodeVersion))
      return { ...host, reason: 'node', message: '不可用：需要 Node ≥24.21.0 <25 或 ≥26.8.0' };
    let sdk: MxcSdk;
    try {
      sdk = await deps.loadSdk();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return {
        ...host,
        reason: code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' ? 'sdk-missing' : 'probe-failed',
        message:
          code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
            ? '沙箱组件未安装'
            : '不可用：沙箱组件加载失败',
      };
    }
    try {
      const result = await sdk.probe();
      const available = result.tier === 'base-container' && result.probes?.baseContainerSupportsDenyPaths === true;
      return {
        ...host,
        available,
        sdkVersion: result.sdkVersion,
        captureDenialsStreamingSupported: captureDenialsStreamingSupported(result.sdkVersion),
        learningUnavailableReason: captureDenialsStreamingSupported(result.sdkVersion)
          ? undefined
          : captureDenialsStreamingUnavailableReason(result.sdkVersion),
        tier: result.tier,
        denyPathsSupported: result.probes?.baseContainerSupportsDenyPaths === true,
        reason: available ? 'ready' : 'tier',
        message: available ? '可用 · 进程容器' : '不可用：进程容器或路径拒绝能力未就绪',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
        return { ...host, reason: 'sdk-missing', message: '沙箱组件未安装' };
      return {
        ...host,
        reason: 'probe-failed',
        diagnostic: failureReason(error),
        message: '沙箱学习暂不可用：辅助进程检测失败，请重新检测',
      };
    }
  }
  function probe(): Promise<SandboxStatus> {
    if (!pending) {
      const current = generation;
      pending = detect().then((value) => {
        if (current === generation) status = value;
        return value;
      });
    }
    return pending;
  }
  return {
    status: () => status,
    probe,
    refresh: () => {
      generation++;
      pending = undefined;
      status = { available: false, reason: 'checking', message: '正在检测沙箱' };
      return probe();
    },
  };
}

export const mxcRuntime = createMxcRuntime();

export async function spawnMxcProcess(request: ContainerRequest, signal?: AbortSignal): Promise<MxcDriver> {
  return mxcHelpers.spawn(request, signal);
}

export const mxcExecution = { status: mxcRuntime.probe, spawn: spawnMxcProcess };
