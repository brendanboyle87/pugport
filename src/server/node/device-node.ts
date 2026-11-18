import type { Express } from 'express';
import { realpathSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { isIP } from 'node:net';
import { arch, hostname, machine as machineName } from 'node:os';
import type { MachineReading } from '../member-allocation.ts';
import { gpuStats, type NvidiaReading } from '../platform/system-stats.ts';
import { z } from 'zod';
import { APP_NAME, APP_VERSION } from '../../shared/identity.ts';
import { capabilities, currentHost, type Host } from '../platform/host.ts';
import { protectedInside, protectedRoots, protectionKey } from '../platform/protected-roots.ts';
import { PeerRegistry } from './peer-auth.ts';
import { underTest, UnderTestError } from '../platform/under-test.ts';
import { isLoopbackAddress, PeerListener, type PeerListenerState } from './peer-listener.ts';
import {
  defaultPeerPort,
  serviceUnitPattern,
  type PeerInfo,
  type PeerRuntimes,
  type PeerServerStatus,
  type SlackHostRequest,
} from './peer-protocol.ts';
import { readHardware } from './hardware.ts';
import type { PeerHardware } from './peer-protocol.ts';
import { peerApp, type GitHubHostApi } from './peer-routes.ts';
import type { PeerTaskRunner } from './peer-tasks.ts';
import type { RepoImporter } from './peer-repos.ts';

/** PUGPORT_PEER_PORT, else an ephemeral test port or 4318. */
export function peerPort(env: NodeJS.ProcessEnv = process.env): number {
  const fallback = underTest() ? 0 : defaultPeerPort;
  const value = Number(env.PUGPORT_PEER_PORT || fallback);
  return Number.isSafeInteger(value) && value >= 0 && value < 65536 ? value : fallback;
}

/** Explicit IP address; tests default to loopback, otherwise the Tailscale address is found. */
export function peerHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.PUGPORT_PEER_HOST?.trim();
  if (underTest()) {
    if (value && (!isIP(value) || !isLoopbackAddress(value))) throw new UnderTestError('unsafe peer host');
    return value || '127.0.0.1';
  }
  return value && isIP(value) ? value : undefined;
}

/**
 * A folder a peer task may run in: an existing directory on this machine, by its real path, that is neither the
 * file system root, the home folder itself, nor inside a system or key folder (which also covers PugPort's own
 * data under ~/.local).
 */
export function projectFolderCheck(host: Host = currentHost()) {
  return (path: string): string | undefined => {
    if (path === '~' || path.startsWith('~/')) path = host.path.join(host.home, path.slice(2));
    if (!host.path.isAbsolute(path) || /[\0\r\n]/.test(path)) return undefined;
    let real: string;
    try {
      real = realpathSync.native(path);
      if (!statSync(real).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const roots = protectedRoots(host);
    const key = protectionKey(real, host);
    if (host.path.dirname(real) === real || key === protectionKey(roots.home, host)) return undefined;
    if (roots.systemNames.test(real)) return undefined;
    // The temporary folder is the user's own even where it lies inside a system tree (Windows AppData).
    if (roots.allowedInside.some((root) => protectedInside(real, root, host))) return real;
    if (roots.system.some((root) => key === protectionKey(root, host) || protectedInside(real, root, host)))
      return undefined;
    return real;
  };
}

export type DeviceNodeOptions = {
  /** Where the paired PugPorts' token hashes are kept (the per-user secrets folder). */
  peersFile: string;
  port: number;
  host?: string;
  runner: PeerTaskRunner;
  runtimes: () => PeerRuntimes | Promise<PeerRuntimes>;
  hardware?: () => Promise<PeerHardware>;
  now?: () => number;
  machine: () => MachineReading;
  gpuStats?: () => Promise<NvidiaReading | undefined>;
  slackHost: () => boolean;
  slack?: (request: SlackHostRequest) => Promise<{ slackHost: boolean }>;
  githubHost?: () => boolean;
  github?: GitHubHostApi;
  importRepo?: RepoImporter;
  allowWrite?: boolean;
  log?: (line: string) => void;
  /** Tests replace the root disk and systemd readings. */
  disk?: () => Promise<{ diskTotal: number; diskFree: number }>;
  services?: (patterns: string[]) => Promise<{ name: string; state: string }[]>;
};

/** Like `df -Pk /`: the root file system's size and what an ordinary user may still write. */
async function rootDisk(host: Host = currentHost()) {
  const disk = await statfs(host.path.parse(host.home).root || '/');
  return { diskTotal: disk.blocks * disk.bsize, diskFree: disk.bavail * disk.bsize };
}

/** systemd's unit list for the given names or patterns, run without a shell; LOAD/ACTIVE as `systemctl` shows. */
async function systemdServices(patterns: string[], host: Host = currentHost()) {
  const { stdout } = await host.run(
    'systemctl',
    ['list-units', '--type=service', '--all', '--no-legend', '--plain', ...patterns.map(serviceUnitPattern)],
    { timeout: 5000, env: { PATH: host.env.PATH, LC_ALL: 'C' } },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length >= 3 && words[0])
    .slice(0, 16)
    .map((words) => ({ name: words[0].slice(0, 200), state: words[2].slice(0, 40) }));
}

export type NodeStatus = {
  role: 'node';
  name: string;
  peer: PeerListenerState;
  peers: ReturnType<PeerRegistry['list']>;
  pairingExpiresAt?: string;
  slackHost: boolean;
  githubHost: boolean;
  allowWrite: boolean;
  execPath?: string;
};

/** The node side of device nodes: the paired PugPorts, the peer listener and its API. */
export class DeviceNode {
  readonly registry: PeerRegistry;
  readonly listener: PeerListener;
  private loadError?: string;
  private hardware?: PeerHardware;
  private hardwareRead?: Promise<void>;
  private hardwareCheckedAt = 0;
  private gpu?: NvidiaReading;
  private gpuRead?: Promise<void>;
  private gpuCheckedAt = -Infinity;
  private readonly allowWrite: boolean;

  constructor(private readonly options: DeviceNodeOptions) {
    this.allowWrite = options.allowWrite ?? true;
    this.registry = new PeerRegistry(options.peersFile);
    const app = peerApp({
      registry: this.registry,
      runner: options.runner,
      info: () => this.info(),
      runtimes: options.runtimes,
      serverStatus: (services) => this.serverStatus(services),
      ...(options.slack ? { slack: options.slack } : {}),
      ...(options.github ? { github: options.github } : {}),
      ...(options.importRepo ? { importRepo: options.importRepo } : {}),
      allowWrite: this.allowWrite,
      projectFolder: projectFolderCheck(),
      ...(options.log ? { log: options.log } : {}),
    });
    this.listener = new PeerListener({
      handler: app,
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  }

  private refreshHardware() {
    if (this.hardwareRead) return this.hardwareRead;
    this.hardwareCheckedAt = Date.now();
    this.hardwareRead = Promise.resolve()
      .then(() => (this.options.hardware ?? readHardware)())
      .then((value) => {
        this.hardware = value;
      })
      .catch(() => {})
      .finally(() => {
        this.hardwareRead = undefined;
      });
    return this.hardwareRead;
  }

  info(): Omit<PeerInfo, 'peerName'> {
    if (Date.now() - this.hardwareCheckedAt > 60_000) void this.refreshHardware();
    const now = (this.options.now ?? Date.now)();
    const machine = this.options.machine();
    if (!this.gpuRead && now - this.gpuCheckedAt >= 4000) {
      this.gpuRead = Promise.resolve()
        .then(() => (this.options.gpuStats ?? gpuStats)())
        .then((value) => {
          this.gpu = value;
        })
        .catch(() => {
          this.gpu = undefined;
        })
        .finally(() => {
          this.gpuCheckedAt = (this.options.now ?? Date.now)();
          this.gpuRead = undefined;
        });
    }
    const gpu = now - this.gpuCheckedAt <= 15_000 ? this.gpu : undefined;
    const memoryTotal = machine.totalBytes;
    const available = machine.availableMemoryBytes;
    const host = currentHost();
    return {
      ...(this.hardware ? { hardware: this.hardware } : {}),
      resources: {
        cpuPercent: machine.cpuPercent,
        gpuPercent: gpu?.percent,
        gpuName: gpu?.gpu?.name.slice(0, 120),
        memoryTotal,
        memoryUsed: available === undefined ? undefined : Math.max(0, memoryTotal - available),
        vram: gpu?.gpu?.memory,
        observedAt: new Date(now).toISOString(),
      },
      name: APP_NAME,
      version: APP_VERSION,
      role: 'node',
      ...(this.registry.nodeId ? { nodeId: this.registry.nodeId } : {}),
      hostname: hostname().slice(0, 255),
      platform: host.platform,
      arch: arch(),
      capabilities: capabilities(host),
      slackHost: this.options.slackHost(),
      githubHost: this.options.githubHost?.() ?? false,
      allowWrite: this.allowWrite,
    };
  }

  /** The remote server card's reading (the same fields its SSH probe reads), without giving anyone a shell. */
  async serverStatus(services: string[]): Promise<PeerServerStatus> {
    const machine = this.options.machine();
    const host = currentHost();
    const [disk, units] = await Promise.all([
      (this.options.disk ?? rootDisk)().catch(() => undefined),
      services.length && (this.options.services || host.platform === 'linux')
        ? (this.options.services ?? systemdServices)(services).catch(() => undefined)
        : undefined,
    ]);
    return {
      cpuPercent: machine.cpuPercent,
      cores: machine.cpus >= 1 ? Math.min(4096, Math.floor(machine.cpus)) : undefined,
      arch: machineName().slice(0, 40),
      memoryTotal: machine.totalBytes,
      memoryAvailable: machine.availableMemoryBytes,
      ...(disk ?? {}),
      ...(units ? { services: units } : {}),
      observedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
    };
  }

  /** Without a readable peer record nobody can sign in, but the listener still answers (with "not paired"). */
  async start() {
    void this.refreshHardware();
    try {
      await this.registry.load();
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      this.options.log?.('[peer] the paired-device record could not be read; nobody can sign in until it is fixed');
    }
    this.listener.start();
  }
  close() {
    return this.listener.close();
  }

  status(): NodeStatus {
    const pairingExpiresAt = this.registry.pairingExpiresAt();
    return {
      role: 'node',
      ...(this.registry.nodeId ? { nodeId: this.registry.nodeId } : {}),
      name: hostname().slice(0, 255),
      peer: this.listener.state(),
      peers: this.registry.list(),
      ...(pairingExpiresAt ? { pairingExpiresAt } : {}),
      slackHost: this.options.slackHost(),
      githubHost: this.options.githubHost?.() ?? false,
      allowWrite: this.allowWrite,
      execPath: process.execPath,
    };
  }
  createCode() {
    if (this.loadError) throw new Error(this.loadError);
    return { ...this.registry.createCode(), peer: this.listener.state() };
  }
}

/**
 * What the terminal command on the node uses (`pugport node pair|status|unpair`), on the local 127.0.0.1 listener
 * behind its session token. On the desktop app these say it is not a node.
 */
export function nodeLocalRoutes(app: Express, node: DeviceNode | undefined) {
  const required = () => {
    if (!node) throw new Error('这台 PugPort 不是设备节点（没有用 PUGPORT_ROLE=node 启动）。');
    return node;
  };
  app.get('/api/node', (_req, res) => res.json(node ? node.status() : { role: 'desktop' }));
  app.post('/api/node/pairing', (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    res.json(required().createCode());
  });
  app.delete('/api/node/peers/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!(await required().registry.revoke(id))) {
      res.status(404).json({ error: '没有这台已配对的电脑。' });
      return;
    }
    res.json(required().status());
  });
  app.delete('/api/node/peers', async (_req, res) => {
    await required().registry.revokeAll();
    res.json(required().status());
  });
}
