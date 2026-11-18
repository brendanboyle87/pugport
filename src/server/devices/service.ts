import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir, rm, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { validateFiles, type RecordedPeerFile } from '../node/peer-files.ts';
import { uploadFiles, downloadFiles } from './file-transfer.ts';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { fileIdentity } from '../platform/file-identity.ts';
import type { MessageInput, Workflow } from '../../shared/types.ts';
import { deviceNameProblem, type DeviceView, type DevicesView } from '../../shared/devices.ts';
import { withoutMention } from '../../shared/external-agents.ts';
import { normalizeAgentName } from '../agent-names.ts';
import {
  dispatchReplySchema,
  okReplySchema,
  pairReplySchema,
  peerInfoSchema,
  peerRuntimesSchema,
  peerTaskResultSchema,
  peerTaskStatusSchema,
  peerRequestLookupSchema,
  peerServerStatusSchema,
  settledStatuses,
  peerRequestRetryMs,
  slackHostReplySchema,
  githubHostReplySchema,
  githubHostRequestSchema,
  type GitHubHostRequest,
  type PeerRuntimes,
  type PeerServerStatus,
  type PeerTaskStatus,
  type PeerTaskResult,
} from '../node/peer-protocol.ts';
import {
  formatPeerAddress,
  parsePeerAddress,
  peerRequest,
  PeerRefused,
  PeerUnreachable,
  PeerStopUnconfirmed,
  PeerOutcomeUnknown,
  type Lookup,
  type PeerFetch,
  type PeerRequestOptions,
} from './peer-client.ts';
import { DeviceStore, type StoredDevice } from './store.ts';
import { SshTunnels, managedKeyRefused } from './ssh-tunnel.ts';
import {
  accessMarker,
  authorizedKeyLine,
  encodeManagedAccess,
  generateAccessKey,
  installAccessScript,
  parseInstallOutput,
  parseSshConfig,
  readManagedAccess,
  removeAccessScript,
  type ManagedAccess,
  type ManagedKeyFiles,
} from './managed-access.ts';
import { findMentions } from '../../shared/mentions.ts';

/** The Slack gateway of this computer, as choosing the Slack host needs it. */
export type SlackHosting = {
  /** This computer's Slack setup, handed to a device chosen to run Slack. */
  config(): Promise<{
    appToken?: string;
    botToken?: string;
    users: { id: string; name?: string; pairedAt: string; isOwner?: boolean }[];
  }>;
  /** Stop this computer's gateway because `hostedBy` runs Slack, or (undefined) run it here again. */
  standby(hostedBy: string | undefined): Promise<void>;
};

export type DevicesOptions = {
  file: string;
  cacheFile?: string;
  /** This computer's name, as the device lists who is paired. */
  selfName: string;
  isSelf?: (device: StoredDevice) => boolean;
  sshAvailable?: (alias: string) => boolean;
  /** Names already taken by executors, so @ and delegation never mean two things. */
  reservedNames?: () => string[];
  slack?: SlackHosting;
  github?: {
    config(): Promise<
      Omit<Extract<GitHubHostRequest, { host: true }>, 'host' | 'hostedBy' | 'leaseMinutes'> | undefined
    >;
    /** Reconcile the local host with the saved selection; undefined means this computer or none. */
    standby(hostedBy: string | undefined): Promise<void>;
  };
  fetch?: PeerFetch;
  lookup?: Lookup;
  now?: () => number;
  /** How long one result request waits on the device (seconds). */
  resultWaitSeconds?: number;
  /** How long a lost connection may last before a task is given up on. */
  offlineLimitMs?: number;
  /** Total deadline for a cancel acknowledgement and terminal status. */
  stopTimeoutMs?: number;
  /** Pauses between reconnection attempts. */
  retryDelaysMs?: number[];
  helperTimeoutMs?: number;
  tunnels?: SshTunnels;
  beforeSsh?: (alias: string) => Promise<void>;
  /** Where the account's access keys become files for ssh; without it they are never used on this computer. */
  managedKeys?: ManagedKeyFiles;
  /** The owner's own SSH (`ssh -G`, a script on the server), for the one-time access upgrade. */
  ownSsh?: { config(alias: string): Promise<string>; run(alias: string, script: string): Promise<string> };
};

type Status = {
  online: boolean;
  checkedAt: number;
  reason?: string;
};
const cachedInfoSchema = peerInfoSchema.pick({
  version: true,
  platform: true,
  arch: true,
  hardware: true,
  slackHost: true,
  githubHost: true,
  allowWrite: true,
});
type Known = {
  info: z.infer<typeof cachedInfoSchema> & Pick<Partial<z.infer<typeof peerInfoSchema>>, 'hostname' | 'resources'>;
  runtimes?: PeerRuntimes;
  seenAt: string;
};

/** What the workspace needs to run a task on a device (see Workspace.remote). */
export type RemoteResult = { text: string; name: string; executor?: string; model?: string; backBundle?: string };
export type RemoteRepository = {
  bundle: string;
  top: string;
  head: string;
  snapshot: string;
  trip: string;
  key: string;
  subpath: string;
};

const freshMs = 30_000;
/** The device finished the task without an answer: told as it is, never retried. */
class RemoteTaskFailed extends Error {
  backBundle?: string;
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', stop, { once: true });
  });

/** The reason in plain words, without anything the request carried. */
function reasonOf(error: unknown): string {
  if (error instanceof PeerUnreachable || error instanceof PeerRefused) return error.message;
  return '连不上设备。';
}

const noAccess = (device: StoredDevice) =>
  device.enrolledServer
    ? '这台电脑没有它的 SSH 配置，这台服务器也还没开通账号直连：在一台能 SSH 登录它的电脑上打开 PugPort，会自动开通。'
    : '这台电脑缺 SSH 配置，隧道连接用不了。';
const managedName = (device: StoredDevice) => `access:${device.id}`;

function executorLabel(device: StoredDevice, label: string): string {
  return device.tunnel ? label.replace(/\s*·\s*本机$/u, '') : label;
}

/**
 * The owner's device nodes on the desktop side: pairing, whether each is online and what its accounts have left,
 * running one task on a device (an @ message or a delegated sub-task), and which PugPort runs Slack.
 */
function enrollmentProof(device: StoredDevice): string {
  return createHash('sha256')
    .update(JSON.stringify([device.token, device.peerId, device.pairedAt]))
    .digest('hex');
}

export class Devices {
  readonly store: DeviceStore;
  private readonly tunnels: SshTunnels;
  private readonly known = new Map<string, Known>();
  private readonly writtenAt = new Map<string, number>();
  private cacheWrite = Promise.resolve();
  private readonly status = new Map<string, Status>();
  private readonly probing = new Map<string, Promise<Status>>();
  private githubWork: Promise<unknown> = Promise.resolve();
  private slackWork: Promise<unknown> = Promise.resolve();
  private githubTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  /** Access texts a server turned away here; the device then counts as not upgraded until the text changes. */
  private readonly refused = new Map<string, string>();
  private readonly upgrades = new Map<string, Promise<boolean>>();
  private readonly upgradeState = new Map<string, { state: 'running' | 'failed'; reason?: string }>();

  constructor(private readonly options: DevicesOptions) {
    this.store = new DeviceStore(options.file, options.helperTimeoutMs);
    this.tunnels = options.tunnels ?? new SshTunnels();
    if (options.cacheFile) {
      try {
        const entries: unknown = JSON.parse(readFileSync(options.cacheFile, 'utf8'));
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          for (const [id, value] of Object.entries(entries)) {
            if (!value || typeof value !== 'object') continue;
            const info = cachedInfoSchema.safeParse(value.info);
            const runtimes = peerRuntimesSchema.safeParse(value.runtimes);
            if (info.success && typeof value.seenAt === 'string' && Number.isFinite(Date.parse(value.seenAt)))
              this.known.set(id, {
                info: info.data,
                ...(runtimes.success ? { runtimes: runtimes.data } : {}),
                seenAt: value.seenAt,
              });
          }
        }
      } catch {
        /* A missing or damaged cache never prevents pairing or probing. */
      }
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private devices() {
    return this.store.current().devices.filter((device) => !this.options.isSelf?.(device));
  }
  isSelfServer(alias: string): boolean {
    return this.store.current().devices.some((device) => device.tunnel?.ssh === alias && this.options.isSelf?.(device));
  }
  /** The account's tunnel-only key, when it fits this pairing and the server has not turned it away here. */
  private managedAccess(device: StoredDevice): ManagedAccess | undefined {
    if (!device.tunnel || !device.enrolledServer || !this.options.managedKeys) return undefined;
    if (device.access !== undefined && this.refused.get(device.id) === device.access) return undefined;
    const access = readManagedAccess(device.access);
    return access?.nodePort === device.tunnel.remotePort ? access : undefined;
  }
  private hasOwnSsh(device: StoredDevice): boolean {
    return !!device.tunnel && this.options.sshAvailable?.(device.tunnel.ssh) !== false;
  }
  /** Which tunnel reaches the device here: the account's key first, else this computer's own SSH alias. */
  private tunnelName(device: StoredDevice): string | undefined {
    if (this.managedAccess(device)) return managedName(device);
    return this.hasOwnSsh(device) ? device.tunnel!.ssh : undefined;
  }
  private useTunnel(device: StoredDevice): boolean {
    return !!this.tunnelName(device);
  }
  private async openTunnel(device: StoredDevice): Promise<number> {
    const tunnel = device.tunnel!;
    await this.options.beforeSsh?.(tunnel.ssh);
    const access = this.managedAccess(device);
    if (!access) return this.tunnels.ensure(tunnel.ssh, tunnel.remotePort);
    const route = await this.options.managedKeys!.route(device.id, device.enrolledServer ?? device.name, access);
    try {
      return await this.tunnels.ensure({ ...route, name: managedName(device) }, tunnel.remotePort);
    } catch (error) {
      // A key the server turns away is set up again where the owner's own SSH exists (see upgradeAccess).
      if (managedKeyRefused(error)) this.refused.set(device.id, device.access!);
      // The recorded address may not be reachable from here while this computer's own alias still is.
      if (!this.hasOwnSsh(device)) throw error;
      return this.tunnels.ensure(tunnel.ssh, tunnel.remotePort);
    }
  }
  private device(id: string): StoredDevice | undefined {
    return this.devices().find((device) => device.id === id);
  }
  private async target(device: StoredDevice) {
    if (this.useTunnel(device)) return { host: '127.0.0.1', port: await this.openTunnel(device) };
    if (device.tunnel && /^(127\.|localhost(?::|$)|\[?::1)/i.test(device.address))
      throw new PeerUnreachable(noAccess(device));
    return parsePeerAddress(device.address);
  }
  private async call<T>(device: StoredDevice, options: Omit<PeerRequestOptions<T>, 'token' | 'fetch' | 'lookup'>) {
    if (this.options.isSelf?.(device)) throw new PeerRefused(400, 'Cannot route a device request to this computer');
    const address = await this.target(device);
    if (!address) throw new PeerRefused(400, `设备「${device.name}」的地址不对，请移除后重新添加。`);
    return peerRequest(address, {
      ...options,
      token: device.token,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
    });
  }

  async request<T>(id: string, options: Omit<PeerRequestOptions<T>, 'token' | 'fetch' | 'lookup'>) {
    await this.store.read();
    const device = this.device(id);
    if (!device) throw new Error('GitHub host device is no longer paired');
    return this.call(device, options);
  }

  /** Reads the saved devices; when one of them runs Slack, this computer's gateway stays off. */
  async load() {
    const data = await this.store.read();
    for (const id of this.known.keys()) if (!data.devices.some((device) => device.id === id)) this.known.delete(id);
    const host = data.slackHost && this.device(data.slackHost!);
    if (host) await this.options.slack?.standby(host.name);
    if (this.options.github && !this.closed) {
      this.githubTimer ??= setInterval(() => {
        void this.renewGitHubHosting().catch(() => {});
      }, 30 * 60_000);
      this.githubTimer.unref();
      await this.renewGitHubHosting();
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.githubTimer);
    this.githubTimer = undefined;
    await this.githubWork.catch(() => {});
  }

  // ---- The 设备 card.

  private saveCache() {
    const file = this.options.cacheFile;
    if (!file) return Promise.resolve();
    this.cacheWrite = this.cacheWrite.then(async () => {
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true });
        const entries = [...this.known];
        const cached = entries.map(([id, value]) => [id, { ...value, info: cachedInfoSchema.parse(value.info) }]);
        await writeFile(temp, JSON.stringify(Object.fromEntries(cached)), 'utf8');
        await rename(temp, file);
        for (const [id, value] of entries) if (this.known.get(id) === value) this.writtenAt.set(id, this.now());
      } catch {
        /* Cache failures do not change whether the device is reachable. */
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
    });
    return this.cacheWrite;
  }

  async view(refresh = false): Promise<DevicesView> {
    const data = await this.store.read();
    if (refresh) void this.pruneAccessFiles().catch(() => {});
    if (refresh)
      await Promise.all(
        this.devices().map((device) => {
          const tunnel = this.tunnelName(device);
          if (tunnel && !this.tunnels.isOpen(tunnel)) return;
          const status = this.status.get(device.id);
          if (status?.online === false && this.now() - status.checkedAt < freshMs) return;
          return this.probe(device.id);
        }),
      );
    return {
      devices: this.devices().map((device) => this.deviceView(device)),
      slackHost: data.slackHost && this.device(data.slackHost) ? data.slackHost : null,
      githubHost:
        data.githubHost === 'self' || (data.githubHost && this.device(data.githubHost)) ? data.githubHost : null,
    };
  }

  /** 「重新检查」: unlike view(true), opens a closed tunnel and always looks again so executors are re-read. */
  async check(id: string): Promise<DeviceView> {
    await this.store.read();
    const device = this.device(id);
    if (!device) throw new Error('这台设备已经从「设备」里移除了。');
    if (this.useTunnel(device)) await this.openTunnel(device);
    await this.probe(id);
    return this.deviceView(device);
  }

  private deviceView(device: StoredDevice): DeviceView {
    const tunnel = this.tunnelName(device);
    const status =
      tunnel && !this.tunnels.isOpen(tunnel)
        ? { online: false, checkedAt: this.now(), reason: '未连接（发任务时会自动连）' }
        : this.status.get(device.id);
    const upgrade =
      this.upgradeState.get(device.id) ?? (this.canUpgrade(device) ? { state: 'pending' as const } : undefined);
    const known = this.known.get(device.id);
    const info = known?.info;
    return {
      id: device.id,
      name: device.name,
      address: device.address,
      pairedAt: device.pairedAt,
      ...(device.tunnel ? { tunnel: device.tunnel } : {}),
      ...(device.tunnel && !tunnel ? { missingSsh: device.tunnel.ssh } : {}),
      ...(tunnel ? { route: tunnel === device.tunnel?.ssh ? ('ssh' as const) : ('account' as const) } : {}),
      ...(upgrade && !this.managedAccess(device) ? { accessUpgrade: upgrade } : {}),
      ...(status ? { online: status.online, checkedAt: new Date(status.checkedAt).toISOString() } : {}),
      ...(status?.reason ? { reason: status.reason } : {}),
      ...((info?.hostname ?? device.hostname) ? { hostname: info?.hostname ?? device.hostname } : {}),
      ...((info?.platform ?? device.platform) ? { platform: info?.platform ?? device.platform } : {}),
      ...(info
        ? { version: info.version, slackHost: info.slackHost, githubHost: info.githubHost, allowWrite: info.allowWrite }
        : {}),
      ...(info?.hardware ? { hardware: info.hardware } : {}),
      ...(status?.online && info?.resources ? { resources: info.resources } : {}),
      ...(info ? { arch: info.arch } : {}),
      ...(known ? { lastSeenAt: known.seenAt } : {}),
      folders: device.folders ?? [],
      ...(known?.runtimes
        ? {
            executors: known.runtimes.executors.map((executor) => ({
              ...executor,
              label: executorLabel(device, executor.label),
            })),
            running: known.runtimes.running,
          }
        : {}),
    };
  }

  /** Looks at one device now (at most one look at a time per device). */
  probe(id: string): Promise<Status> {
    const running = this.probing.get(id);
    if (running) return running;
    const look = (async (): Promise<Status> => {
      const device = this.device(id);
      if (!device) return { online: false, checkedAt: this.now(), reason: '这台设备已经移除了。' };
      let status: Status;
      try {
        const [info, runtimes] = await Promise.all([
          this.call(device, { path: '/peer/v1/info', schema: peerInfoSchema, timeoutMs: 5000 }),
          this.call(device, {
            path: '/peer/v1/runtimes',
            schema: peerRuntimesSchema,
            timeoutMs: 5000,
          }).catch(() => undefined),
        ]);
        status = { online: true, checkedAt: this.now() };
        if (this.device(id)) {
          if (info.nodeId && !device.nodeId)
            await this.store.update((data) => {
              const saved = data.devices.find((item) => item.id === id);
              if (saved && saved.token === device.token) saved.nodeId = info.nodeId;
            });
          const previous = this.known.get(id);
          this.known.set(id, {
            info: { ...info, hardware: info.hardware ?? previous?.info.hardware },
            runtimes: runtimes ?? previous?.runtimes,
            seenAt: new Date(this.now()).toISOString(),
          });
          if (!this.writtenAt.has(id) || this.now() - this.writtenAt.get(id)! >= 300_000) await this.saveCache();
        }
        // A device that still runs Slack although another PugPort was chosen is told to stop.
        if (info.slackHost && this.store.current().slackHost !== id)
          void this.slackExclusive(async () => {
            if (this.store.current().slackHost !== id) await this.releaseSlack(device);
          });
        if (this.options.github)
          await this.githubExclusive(async () => {
            if (this.closed) return;
            if (this.store.current().githubHost === id) await this.confirmGitHubHost(device);
            else if (info.githubHost) await this.releaseGitHub(device);
          });
      } catch (error) {
        return this.markOffline(id, error);
      }
      if (this.device(id)) this.status.set(id, status);
      return status;
    })().finally(() => this.probing.delete(id));
    this.probing.set(id, look);
    return look;
  }

  private async markOffline(id: string, error: unknown): Promise<Status> {
    const status = { online: false, checkedAt: this.now(), reason: reasonOf(error) };
    if (this.device(id)) {
      const wasOnline = this.status.get(id)?.online === true;
      this.status.set(id, status);
      if (wasOnline) await this.saveCache();
    }
    return status;
  }

  private nameProblem(name: string, except?: string): string | undefined {
    const problem = deviceNameProblem(name);
    if (problem) return problem;
    const wanted = normalizeAgentName(name);
    if (this.devices().some((device) => device.id !== except && normalizeAgentName(device.name) === wanted))
      return `已经有一台设备叫“${name}”了。`;
    if ((this.options.reservedNames?.() ?? []).some((label) => normalizeAgentName(label) === wanted))
      return `“${name}”和一个执行器重名了，请换个名字。`;
    return undefined;
  }

  /** A name made from the device's host name when none was given: "ubuntu-box", then "ubuntu-box-2", … */
  private defaultName(hostname: string) {
    const base = hostname.replace(/[\s@\p{Cc}\p{Cf}]/gu, '').slice(0, 20) || '设备';
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (!this.nameProblem(name)) return name;
    }
    return `设备-${randomUUID().slice(0, 6)}`;
  }

  /** Exchanges the one-time code the device printed (`pugport node pair`) for a token kept on this computer. */
  async add(input: {
    address: string;
    code: string;
    name?: string;
    tunnel?: { ssh: string; remotePort: number };
  }): Promise<DevicesView> {
    return this.pairDevice(input);
  }

  async addEnrolled(
    input: Parameters<Devices['add']>[0],
  ): Promise<{ view: DevicesView; deviceId: string; pairingProof: string }> {
    let created: StoredDevice | undefined;
    const view = await this.pairDevice(input, (device) => {
      created = device;
    });
    if (!created) throw new Error('Enrollment did not create a device.');
    return { view, deviceId: created.id, pairingProof: enrollmentProof(created) };
  }

  private async pairDevice(
    input: Parameters<Devices['add']>[0],
    created?: (device: StoredDevice) => void,
  ): Promise<DevicesView> {
    await this.store.read();
    if (input.tunnel && this.devices().some((device) => device.tunnel?.ssh === input.tunnel!.ssh)) {
      if (created) throw new Error('This SSH alias is already paired.');
      return this.view();
    }
    const address = input.tunnel
      ? { host: '127.0.0.1', port: input.tunnel.remotePort }
      : parsePeerAddress(input.address);
    if (!address) throw new Error('地址不对：填设备的 Tailscale 地址（100.x.x.x）或它在 Tailscale 里的名字。');
    const text = input.tunnel ? '127.0.0.1' : formatPeerAddress(address);
    if (!input.tunnel && this.devices().some((device) => !device.tunnel && device.address === text))
      throw new Error('这个地址的设备已经添加过了。');
    const name = input.name?.trim() || input.tunnel?.ssh;
    if (name) {
      const problem = this.nameProblem(name);
      if (problem) throw new Error(problem);
    }
    if (input.tunnel) {
      await this.options.beforeSsh?.(input.tunnel.ssh);
      address.port = await this.tunnels.ensure(input.tunnel.ssh, input.tunnel.remotePort);
    }
    let paired;
    try {
      paired = await peerRequest(address, {
        method: 'POST',
        path: '/peer/v1/pair',
        body: { code: input.code.trim().slice(0, 20), name: this.options.selfName.slice(0, 60) || 'PugPort' },
        schema: pairReplySchema,
        timeoutMs: 15_000,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
      });
    } catch (error) {
      if (error instanceof PeerUnreachable)
        throw new Error(`${error.message} 请确认设备开着、两边都连着 Tailscale，并且它运行了 pugport node install。`);
      throw new Error(reasonOf(error));
    }
    const device: StoredDevice = {
      id: paired.node.nodeId ?? randomUUID(),
      ...(paired.node.nodeId ? { nodeId: paired.node.nodeId } : {}),
      name: name || this.defaultName(paired.node.hostname),
      address: text,
      ...(input.tunnel ? { tunnel: input.tunnel } : {}),
      token: paired.token,
      peerId: paired.peerId,
      pairedAt: new Date(this.now()).toISOString(),
      hostname: paired.node.hostname,
      platform: paired.node.platform,
    };
    await this.store.update((data) => {
      const existing = data.devices.findIndex(
        (item) => item.id === device.id || (device.nodeId && item.nodeId === device.nodeId),
      );
      if (
        created &&
        (existing >= 0 || data.devices.some((item) => input.tunnel && item.tunnel?.ssh === input.tunnel.ssh))
      )
        throw new Error('Enrollment cannot replace an existing pairing.');
      if (existing < 0) data.devices.push(device);
      else {
        device.id = data.devices[existing].id;
        data.devices[existing] = device;
      }
    });
    created?.(structuredClone(device));
    this.status.set(device.id, { online: true, checkedAt: this.now() });
    this.known.set(device.id, { info: paired.node, seenAt: new Date(this.now()).toISOString() });
    await this.probe(device.id);
    return this.view();
  }

  async removeLegacyServer(alias: string): Promise<void> {
    const data = await this.store.read();
    for (const device of data.devices) {
      if (device.tunnel?.ssh === alias && !device.enrolledServer) await this.remove(device.id);
    }
  }

  async enrolledServerDevice(name: string): Promise<string | undefined> {
    const data = await this.store.read();
    return data.devices.find((device) => device.enrolledServer === name)?.id;
  }

  async markEnrolledServer(id: string, name: string, pairingProof?: string): Promise<void> {
    let superseded = false;
    await this.store.update((data) => {
      const device = data.devices.find((item) => item.id === id);
      if (!device) throw new Error('Enrolled device no longer exists.');
      if (device.enrolledServer && device.enrolledServer !== name)
        throw new Error('Device belongs to another remote server.');
      if (pairingProof ? enrollmentProof(device) !== pairingProof : device.enrolledServer !== name)
        throw new Error('Pairing changed during enrollment.');
      if (
        data.devices.some((item) => item.id !== id && item.enrolledServer === name && item.pairedAt > device.pairedAt)
      ) {
        data.devices = data.devices.filter((item) => item.id !== id);
        if (data.slackHost === id) delete data.slackHost;
        if (data.githubHost === id) delete data.githubHost;
        superseded = true;
        return;
      }
      device.enrolledServer = name;
      // A reinstalled node can have a new identity; keep only its latest server pairing.
      const replaced = data.devices.filter((item) => item.id !== id && item.enrolledServer === name);
      data.devices = data.devices.filter((item) => !replaced.includes(item));
      if (replaced.some((item) => item.id === data.slackHost)) delete data.slackHost;
      if (replaced.some((item) => item.id === data.githubHost)) delete data.githubHost;
    });
    if (superseded) throw new Error('A newer pairing already enrolled this server.');
  }

  /** Forgets the device here and, when it can be reached, revokes this computer's token there too. */
  async remove(id: string): Promise<DevicesView & { note?: string }> {
    return this.githubExclusive(() => this.slackExclusive(() => this.removeDevice(id)));
  }

  private async removeDevice(id: string): Promise<DevicesView & { note?: string }> {
    const data = await this.store.read();
    const device = this.device(id);
    if (!device) throw new Error('没有这台设备。');
    const wasSlackHost = data.slackHost === id;
    let notified = true;
    // Its Slack gateway stops first: once unpaired, nothing could tell it to stop any more.
    if (wasSlackHost && !(await this.releaseSlack(device)))
      return {
        ...(await this.view()),
        note: 'The previous Slack host has not confirmed release. The new host remains on standby.',
      };
    if (data.githubHost === id || this.known.get(id)?.info.githubHost) await this.releaseGitHub(device);
    try {
      await this.call(device, { method: 'DELETE', path: '/peer/v1/pairing', schema: okReplySchema, timeoutMs: 5000 });
    } catch {
      notified = false;
    }
    await this.store.update((current) => {
      current.devices = current.devices.filter((item) => item.id !== id);
      if (current.slackHost === id) delete current.slackHost;
      if (current.githubHost === id) delete current.githubHost;
    });
    if (device.tunnel) {
      await this.tunnels.close(device.tunnel.ssh);
      if (device.access) await this.tunnels.close(managedName(device));
      await this.options.managedKeys?.remove(device.id).catch(() => {});
    }
    this.refused.delete(id);
    this.upgradeState.delete(id);
    this.status.delete(id);
    this.known.delete(id);
    this.writtenAt.delete(id);
    await this.saveCache();
    if (wasSlackHost) await this.options.slack?.standby(undefined);
    if (data.githubHost === id) await this.options.github?.standby(undefined);
    return {
      ...(await this.view()),
      ...(notified
        ? {}
        : {
            note: `设备「${device.name}」现在连不上，只在本机移除了。它上线后，在它上面运行 pugport node unpair 移除这台电脑。`,
          }),
    };
  }

  // ---- Calling a device by name: @ in a conversation, or `delegate` with agent = its name.

  /** Ids and names, for the executors' agent list. */
  directory(): { id: string; name: string; online?: boolean; reason?: string; tunnel?: true }[] {
    return this.devices().flatMap((device) => {
      const status = this.status.get(device.id);
      const entry = {
        id: device.id,
        name: device.name,
        ...(device.tunnel ? { tunnel: true as const } : {}),
        ...(status ? { online: status.online } : {}),
        ...(status?.reason ? { reason: status.reason } : {}),
      };
      return device.enrolledServer && device.enrolledServer !== device.name
        ? [{ ...entry, name: device.enrolledServer }, entry]
        : [entry];
    });
  }

  find(name: string): { id: string; name: string } | undefined {
    const wanted = normalizeAgentName(name.replace(/^设备\s*[「“"]?|[」”"]$/gu, ''));
    const device = this.devices().find(
      (item) =>
        normalizeAgentName(item.name) === wanted ||
        (item.enrolledServer && normalizeAgentName(item.enrolledServer) === wanted),
    );
    return device && { id: device.id, name: device.name };
  }

  /** Throws a plain reason when the device is offline; a recent good look is trusted for 30 s. */
  async ensureReachable(id: string): Promise<{ id: string; name: string }> {
    const device = this.device(id);
    if (!device) throw new Error('这台设备已经从「设备」里移除了。');
    if (this.useTunnel(device)) await this.openTunnel(device);
    const known = this.status.get(id);
    const status = known?.online && this.now() - known.checkedAt < freshMs ? known : await this.probe(id);
    if (!status.online) throw new Error(`设备「${device.name}」现在连不上：${status.reason ?? '它可能关机或断网了'}`);
    return { id: device.id, name: device.name };
  }

  forgetSsh(alias: string): void {
    this.tunnels.forget(alias);
    for (const device of this.devices()) if (device.tunnel?.ssh === alias) this.tunnels.forget(managedName(device));
  }

  // ---- Account-bound server access (managed-access.ts).

  /** For the remote server card: can this computer reach the server's node, and how. */
  serverReach(alias: string): { ownSsh: boolean; account: boolean } {
    const device = this.devices().find((item) => item.tunnel?.ssh === alias && item.enrolledServer);
    return { ownSsh: this.options.sshAvailable?.(alias) !== false, account: !!device && !!this.managedAccess(device) };
  }

  /** An enrolled server this computer could upgrade: paired, no usable account key, own SSH alias here. */
  needsAccessUpgrade(id: string): boolean {
    const device = this.device(id);
    return !!device && this.canUpgrade(device);
  }
  private canUpgrade(device: StoredDevice): boolean {
    return (
      !!device.tunnel &&
      !!device.enrolledServer &&
      !!this.options.managedKeys &&
      !!this.options.ownSsh &&
      !this.managedAccess(device) &&
      this.hasOwnSsh(device)
    );
  }

  /**
   * One-time upgrade of an enrolled server with this computer's own SSH: installs a tunnel-only key, proves the key
   * alone reaches the node, then keeps it on the pairing, which account sync carries to the owner's other computers.
   */
  upgradeAccess(id: string): Promise<boolean> {
    const running = this.upgrades.get(id);
    if (running) return running;
    const work = this.runUpgrade(id).finally(() => this.upgrades.delete(id));
    this.upgrades.set(id, work);
    return work;
  }

  private async runUpgrade(id: string): Promise<boolean> {
    await this.store.read();
    if (!this.needsAccessUpgrade(id)) return false;
    const device = this.device(id)!;
    const ssh = this.options.ownSsh!;
    const alias = device.tunnel!.ssh;
    const nodeId = device.nodeId ?? device.id;
    let line: string | undefined;
    this.upgradeState.set(id, { state: 'running' });
    try {
      await this.options.beforeSsh?.(alias);
      const config = parseSshConfig(await ssh.config(alias));
      if (!config) throw new Error(`读不出 SSH 别名 ${alias} 指向的地址。`);
      if (config.proxied) throw new Error('这台服务器要经跳板机或代理命令才能连上；账号直连需要一个能直接连到的地址。');
      const key = generateAccessKey(accessMarker(nodeId));
      line = authorizedKeyLine(key.publicKey, device.tunnel!.remotePort, nodeId);
      const installed = parseInstallOutput(await ssh.run(alias, installAccessScript(line)));
      if (!installed.user || !installed.hostKeys.length)
        throw new Error('服务器没有返回登录用户或主机密钥（/etc/ssh/ssh_host_*_key.pub）。');
      const parsed = readManagedAccess(
        JSON.stringify({
          version: 1,
          host: config.host,
          port: config.port,
          user: installed.user,
          hostKeys: installed.hostKeys,
          nodePort: device.tunnel!.remotePort,
          key: key.privateKey,
        }),
      );
      if (!parsed) throw new Error(`SSH 别名 ${alias} 的地址或用户名无法用于账号直连。`);
      const access = encodeManagedAccess(parsed);
      await this.verifyAccess({ ...device, access });
      await this.store.update((data) => {
        const saved = data.devices.find((item) => item.id === id);
        if (!saved || saved.token !== device.token) throw new Error('开通期间配对变了，稍后会再试。');
        saved.access = access;
      });
      line = undefined;
      this.refused.delete(id);
      this.upgradeState.delete(id);
      // The account route takes over; the owner's own tunnel is no longer needed.
      await this.tunnels.close(alias);
      return true;
    } catch (error) {
      if (line) await ssh.run(alias, removeAccessScript(line)).catch(() => {});
      const reason = error instanceof Error ? error.message.slice(0, 300) : '开通失败。';
      this.upgradeState.set(id, { state: 'failed', reason });
      throw error;
    }
  }

  private async verifyAccess(device: StoredDevice): Promise<void> {
    const access = readManagedAccess(device.access)!;
    const name = managedName(device);
    await this.tunnels.close(name);
    try {
      const route = await this.options.managedKeys!.route(device.id, device.enrolledServer ?? device.name, access);
      const port = await this.tunnels.ensure({ ...route, name }, device.tunnel!.remotePort);
      await peerRequest(
        { host: '127.0.0.1', port },
        {
          path: '/peer/v1/info',
          schema: peerInfoSchema,
          timeoutMs: 8000,
          token: device.token,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          ...(this.options.lookup ? { lookup: this.options.lookup } : {}),
        },
      );
    } catch (error) {
      await this.tunnels.close(name);
      throw error;
    }
  }

  /** CPU, memory, disk and service states read from the server's own node (the remote server card). */
  async serverReading(alias: string, services: string[]): Promise<PeerServerStatus> {
    await this.store.read();
    const device = this.devices().find((item) => item.tunnel?.ssh === alias && item.enrolledServer);
    if (!device) throw new PeerUnreachable('这台服务器还没接入。');
    const query = new URLSearchParams(services.map((service) => ['service', service])).toString();
    try {
      return await this.call(device, {
        path: `/peer/v1/status${query ? `?${query}` : ''}`,
        schema: peerServerStatusSchema,
        timeoutMs: 10_000,
      });
    } catch (error) {
      if (!(error instanceof PeerRefused && error.status === 404)) throw error;
      // A node from before /peer/v1/status: what its info already carries (no services).
      const info = await this.call(device, { path: '/peer/v1/info', schema: peerInfoSchema, timeoutMs: 5000 });
      const memory = info.resources;
      return {
        cpuPercent: memory?.cpuPercent,
        memoryTotal: memory?.memoryTotal,
        memoryAvailable:
          memory?.memoryTotal !== undefined && memory.memoryUsed !== undefined
            ? Math.max(0, memory.memoryTotal - memory.memoryUsed)
            : undefined,
        diskTotal: info.hardware?.diskTotal,
        diskFree: info.hardware?.diskFree,
        cores: info.hardware?.threads ?? info.hardware?.cores,
        arch: info.arch,
        observedAt: memory?.observedAt ?? new Date(this.now()).toISOString(),
      };
    }
  }

  /** Removes key files of devices this computer no longer has (another computer's sync can remove them). */
  private pruneAccessFiles(): Promise<void> {
    return this.options.managedKeys?.prune(this.store.current().devices.map((d) => d.id)) ?? Promise.resolve();
  }

  /**
   * A message for one device keeps its selected remote folder, permission and attachments.
   * Undefined when the message calls no device.
   */
  async messageFor<T extends MessageInput>(input: T, deviceId?: string): Promise<T | undefined> {
    if (deviceId) await this.store.read();
    else {
      // Looked at for every message: one without an @ costs nothing, and an unreadable device record never stops
      // ordinary messages.
      if (!input.content.includes('@')) return undefined;
      try {
        await this.store.read();
      } catch {
        return undefined;
      }
    }
    const device = deviceId
      ? this.device(deviceId)
      : findMentions(
          input.content,
          this.devices().map((item) => ({ item, name: item.name, minTier: item.tunnel ? (3 as const) : (2 as const) })),
        )[0]?.item.item;
    if (deviceId && !device) throw new Error('没有这台设备，它可能已经被移除了。');
    if (!device) return undefined;
    if (!withoutMention(input.content, device.name) && !input.quotes?.length)
      throw new Error(`请在 @${device.name} 后面写上要它做的事。`);
    await this.ensureReachable(device.id);
    return {
      ...input,
      deviceId: device.id,
      review: undefined,
      agentPresetId: undefined,
      provider: undefined,
      runtimeId: undefined,
      model: undefined,
      effort: undefined,
      verificationCommand: undefined,
      swarm: false,
    };
  }

  private statusNote(name: string, status: PeerTaskStatus) {
    const who = status.executor ? ` · ${status.executor}${status.model ? `（${status.model}）` : ''}` : '';
    if (status.status === 'queued' || status.status === 'waiting-resource')
      return `设备「${name}」：排队中${status.note ? `，${status.note}` : ''}`;
    if (status.status.startsWith('waiting'))
      return `设备「${name}」：在等那台电脑上的确认${status.note ? `（${status.note}）` : ''}`;
    return `设备「${name}」：正在处理` + who;
  }

  /**
   * Runs one task on a device and returns its answer. A device that cannot be reached fails at once; a connection
   * lost midway is retried for a few minutes, then given up (the task may still finish on the device). Stopping the
   * task here requires a terminal confirmation from the device.
   */
  async run(
    workflow: Workflow,
    signal: AbortSignal,
    report: (note: string, progress?: PeerTaskStatus['progress']) => void,
    attachments: { path: string; name: string; size: number }[] = [],
    beforeSend?: () => void,
    repo?: RemoteRepository,
  ): Promise<RemoteResult> {
    await this.store.read();
    const device = workflow.input.deviceId ? this.device(workflow.input.deviceId) : undefined;
    if (!device) throw new Error('这台设备已经从「设备」里移除了。');
    const name = device.name;
    const receipt = (workflow.deviceTask ??= {});
    let repoNote = '';
    const withRepoNote = <T extends Error>(error: T): T => {
      error.message = repoNote + error.message;
      return error;
    };
    const receiveResultFiles = async (taskId: string, result: PeerTaskResult, downloadSignal: AbortSignal) => {
      let returned: string[] = [];
      let backBundle: string | undefined;
      if (result.files?.length) {
        report('正在传送文件…');
        try {
          const paths = await downloadFiles(await this.connection(device), taskId, result.files, downloadSignal);
          const backIndex = result.files.findIndex((file) => file.name === `pugport-back-${taskId}.bundle`);
          if (backIndex >= 0 && isAbsolute(paths[backIndex]!)) backBundle = paths[backIndex];
          returned = paths.flatMap((line, index) =>
            index === backIndex && backBundle ? [] : [isAbsolute(line) ? `收到来自「${name}」的文件：<${line}>` : line],
          );
        } catch (error) {
          if (downloadSignal.aborted) throw downloadSignal.reason;
          returned = [`文件下载失败：${error instanceof Error ? error.message : '传送失败'}`];
        }
      }
      return { backBundle, fileNote: returned.length ? `\n\n${returned.join('\n')}` : '' };
    };
    let attempted = receipt.uncertain === true;
    if (receipt.uncertain && !receipt.taskId && !receipt.requestId)
      throw new PeerStopUnconfirmed('设备停止请求未确认；任务可能仍在设备上运行，请核对设备后重试停止。');
    const stop = async (taskId: string): Promise<RemoteResult | undefined> => {
      receipt.stopRequested = true;
      receipt.uncertain = true;
      const timeout = this.options.stopTimeoutMs ?? 5000;
      const confirmation = AbortSignal.timeout(timeout);
      const path = `/peer/v1/tasks/${encodeURIComponent(taskId)}`;
      const confirm = async () => {
        let requested = false;
        for (;;) {
          const status = await this.call(device, {
            path,
            schema: peerTaskStatusSchema,
            timeoutMs: timeout,
            signal: confirmation,
          });
          if (settledStatuses.has(status.status)) {
            if (status.status === 'completed' || repo) {
              const result = await this.call(device, {
                path: `${path}/result`,
                schema: peerTaskResultSchema,
                timeoutMs: timeout,
                signal: confirmation,
              });
              if (!settledStatuses.has(result.status)) throw new Error('Device result is not confirmed');
              const { backBundle, fileNote } = await receiveResultFiles(taskId, result, confirmation);
              if (result.status !== 'completed') {
                if (backBundle)
                  throw Object.assign(
                    new RemoteTaskFailed(
                      `${repoNote}设备「${name}」上没有完成：${result.error?.trim() || result.status}${result.result ? `\n${result.result}` : ''}${fileNote}`,
                    ),
                    { backBundle },
                  );
                return undefined;
              }
              return {
                text: repoNote + (result.result ?? '') + fileNote,
                ...(backBundle ? { backBundle } : {}),
                name,
                executor: status.executor && executorLabel(device, status.executor),
                model: status.model,
              };
            }
            return undefined;
          }
          if (!requested) {
            await this.call(device, {
              method: 'POST',
              path: `${path}/cancel`,
              schema: okReplySchema,
              timeoutMs: timeout,
              signal: confirmation,
            });
            requested = true;
          }
          await sleep(50, confirmation);
        }
      };
      let expired: () => void = () => {};
      try {
        const answer = await Promise.race([
          confirm(),
          new Promise<never>((_, reject) => {
            expired = () => reject(confirmation.reason);
            confirmation.addEventListener('abort', expired, { once: true });
          }),
        ]);
        delete receipt.uncertain;
        return answer;
      } catch (error) {
        if (error instanceof RemoteTaskFailed) {
          delete receipt.uncertain;
          throw error;
        }
        throw new PeerStopUnconfirmed('设备停止请求未确认；任务可能仍在设备上运行，请核对设备后重试停止。');
      } finally {
        confirmation.removeEventListener('abort', expired);
      }
    };
    const recover = async (cancel = signal.aborted) => {
      receipt.stopRequested ||= signal.aborted;
      try {
        const path = `/peer/v1/requests/${encodeURIComponent(receipt.requestId!)}`;
        let found = await this.call(device, {
          method: cancel ? 'POST' : 'GET',
          path: `${path}${cancel ? '/cancel' : ''}`,
          schema: peerRequestLookupSchema,
          timeoutMs: this.options.stopTimeoutMs ?? 5000,
        });
        // Absence cannot rule out a POST still in flight; only a durable cancellation can.
        if (!found.taskId && !cancel)
          found = await this.call(device, {
            method: 'POST',
            path: `${path}/cancel`,
            schema: peerRequestLookupSchema,
            timeoutMs: this.options.stopTimeoutMs ?? 5000,
          });
        if (found.taskId) receipt.taskId = found.taskId;
        else delete receipt.uncertain;
        return found.taskId;
      } catch {
        receipt.uncertain = true;
        if (signal.aborted)
          throw new PeerStopUnconfirmed('设备停止请求未确认；任务可能仍在设备上运行，请核对设备后重试停止。');
        throw new PeerOutcomeUnknown(
          `设备「${name}」的发送结果未知；任务可能已经执行，请核对设备。重试会沿用原任务编号。`,
        );
      }
    };
    if (receipt.uncertain && !receipt.taskId) {
      if (!(await recover())) {
        signal.throwIfAborted();
        throw new Error(`设备「${name}」上没有这条请求，这条没有发出去。`);
      }
    }
    let task = (withoutMention(workflow.input.content, name) || workflow.input.content).slice(0, 50000);
    const files = receipt.task ? [] : await validateFiles(workflow.input.deviceFiles ?? []);
    for (const attachment of receipt.task ? [] : attachments) {
      const path = await realpath(attachment.path);
      const info = await stat(path, { bigint: true });
      if (!info.isFile() || info.size !== BigInt(attachment.size)) throw new Error('附件已改变。');
      const identity = fileIdentity(info);
      files.push({
        id: randomUUID(),
        path,
        name: attachment.name,
        size: Number(info.size),
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
      });
    }
    if (files.length) {
      report('正在传送文件…');
      const sent = await uploadFiles(await this.connection(device), files, signal);
      const manifest = `\n\nFiles sent to this computer:\n${sent.map((file) => file.path).join('\n')}`;
      if (manifest.length >= 50000) throw new Error('上传的文件路径太长，无法放进一条任务。');
      task = task.slice(0, 50000 - manifest.length) + manifest;
    }
    let projectPath = receipt.repo?.projectPath ?? workflow.input.deviceFolder;
    if (repo && !receipt.task && !receipt.taskId) {
      try {
        beforeSend?.();
        if (workflow.input.permissionMode !== 'workspace-write') throw new Error('任务现在是只读。');
        const sent = await uploadFiles(
          await this.connection(device),
          await validateFiles([repo.bundle]),
          signal,
          randomUUID(),
        );
        const imported = await this.call(device, {
          method: 'POST',
          path: `/peer/v1/repos/${repo.key}/import`,
          body: { bundlePath: sent[0]!.path, snapshot: repo.snapshot, trip: repo.trip },
          schema: z.object({ path: z.string().min(1), head: z.string().min(1) }),
          timeoutMs: 600_000,
          signal,
        });
        projectPath = repo.subpath ? `${imported.path}/${repo.subpath}` : imported.path;
        receipt.repo = { top: repo.top, snapshot: repo.snapshot, head: repo.head, trip: repo.trip, projectPath };
        const instruction = `\n\n用户项目的副本在 ${projectPath}，当前分支 pugport/${repo.trip}；在那里改。`;
        task = task.slice(0, 50000 - instruction.length) + instruction;
      } catch (error) {
        repoNote = `项目没有带到设备上：${reasonOf(error).replace(/\s+/g, ' ').slice(0, 200)}。\n\n`;
      }
    }
    task = receipt.task ?? task;
    receipt.task = task;
    const snippet = task.replace(/\s+/g, ' ').trim();
    report(`正在交给设备「${name}」…`);
    let taskId: string;
    try {
      const write = workflow.input.permissionMode === 'workspace-write';
      // Older receipts use the workflow's creation time; an unknown age must never renew a retry window.
      receipt.requestStartedAt ??= receipt.requestId ? Date.parse(workflow.createdAt) || 0 : this.now();
      receipt.requestId ??= workflow.id;
      const body = {
        task: task.slice(0, 50000),
        requestId: receipt.requestId,
        write,
        ...(projectPath ? { projectPath } : {}),
        title: snippet.length > 40 ? `${snippet.slice(0, 40)}…` : snippet,
        ...(workflow.input.untrustedContent || workflow.input.untrustedQuotesOnly ? { untrusted: true } : {}),
      };
      const request = {
        method: 'POST',
        path: '/peer/v1/tasks',
        body,
        beforeSend: () => {
          signal.throwIfAborted();
          if (this.now() - receipt.requestStartedAt! >= peerRequestRetryMs)
            throw new PeerRefused(409, '这条设备请求已超过重试期限，请先核对设备上的任务。');
          beforeSend?.();
          body.write = body.write && workflow.input.permissionMode === 'workspace-write' && !signal.aborted;
          receipt.writeAttempted ||= body.write;
          attempted = true;
        },
        schema: dispatchReplySchema,
        // Not cut short by a stop: once the device may have created the task, its id is needed to stop it there.
        timeoutMs: 15_000,
      } as const;
      let created;
      try {
        created = receipt.taskId ? { taskId: receipt.taskId } : await this.call(device, request);
      } catch (error) {
        if (!receipt.requestId || !(error instanceof PeerUnreachable)) throw error;
        receipt.uncertain = attempted;
        if (signal.aborted) throw error;
        try {
          created = await this.call(device, request);
        } catch (retryError) {
          if (!(retryError instanceof PeerRefused && retryError.notSent && receipt.uncertain)) throw retryError;
          const recovered = await recover(true);
          if (!recovered) throw retryError;
          created = { taskId: recovered };
        }
      }
      taskId = created.taskId;
      receipt.taskId = taskId;
      receipt.uncertain = true;
      if (receipt.writeAttempted && !body.write && !signal.aborted) {
        await stop(taskId);
        throw new PeerRefused(409, '权限已收窄，已向设备发出停止请求；首次发送可能已经执行，请核对结果后再继续。');
      }
      if (workflow.input.deviceFolder)
        await this.store
          .update((data) => {
            const saved = data.devices.find((item) => item.id === device.id);
            if (saved)
              saved.folders = [
                workflow.input.deviceFolder!,
                ...(saved.folders ?? []).filter((folder) => folder !== workflow.input.deviceFolder),
              ].slice(0, 10);
          })
          .catch(() => undefined);
    } catch (error) {
      if (error instanceof PeerOutcomeUnknown) throw withRepoNote(error);
      if (
        receipt.uncertain ||
        (attempted && (error instanceof PeerUnreachable || (error instanceof PeerRefused && error.status >= 500)))
      ) {
        receipt.uncertain = true;
        receipt.stopRequested ||= signal.aborted;
        if (signal.aborted) {
          const recovered = receipt.taskId ?? (await recover());
          if (recovered) {
            const answer = await stop(recovered);
            if (answer) return answer;
          }
          throw signal.reason;
        }
        await this.markOffline(device.id, error);
        throw withRepoNote(
          new PeerOutcomeUnknown(
            `设备「${name}」的发送结果未知；任务可能已经执行，请核对设备。${receipt.requestId ? '重试会沿用原任务编号。' : ''}`,
          ),
        );
      }
      signal.throwIfAborted();
      if (
        error instanceof PeerRefused &&
        error.status === 400 &&
        (/unrecognized|unknown.*key|schema|requestId|unsupported/i.test(error.message) ||
          (workflow.input.permissionMode === 'workspace-write' &&
            !workflow.input.deviceFolder &&
            error.message.includes('这台设备只接受只读任务（不改文件）。')))
      )
        throw withRepoNote(new Error(`请先更新设备「${name}」上的 PugPort：pugport node add <ssh target> --now`));
      if (error instanceof PeerUnreachable) await this.markOffline(device.id, error);
      throw withRepoNote(
        new Error(
          error instanceof PeerUnreachable
            ? `设备「${name}」现在连不上（${error.message}），这条没有发出去。`
            : `设备「${name}」没有接下这条：${reasonOf(error)}`,
        ),
      );
    }
    const path = `/peer/v1/tasks/${encodeURIComponent(taskId)}`;
    if (signal.aborted) {
      const answer = await stop(taskId);
      if (answer) return answer;
      throw signal.reason;
    }
    const wait = this.options.resultWaitSeconds ?? 5;
    const delays = this.options.retryDelaysMs ?? [2000, 5000, 10_000, 20_000, 30_000];
    let lostSince: number | undefined;
    let failures = 0;
    let note = '';
    let progress = '';
    let latest: PeerTaskStatus | undefined;
    try {
      report(`设备「${name}」已接下，正在安排执行器…`);
      for (;;) {
        signal.throwIfAborted();
        try {
          latest = await this.call(device, { path, schema: peerTaskStatusSchema, timeoutMs: 10_000, signal });
          if (latest.executor) latest.executor = executorLabel(device, latest.executor);
          if (device.tunnel && latest.note) latest.note = latest.note.replaceAll(' · 本机', '');
          const next = this.statusNote(name, latest);
          const nextProgress = JSON.stringify(latest.progress) ?? '';
          if (next !== note || nextProgress !== progress) report((note = next), latest.progress);
          progress = nextProgress;
          const result = settledStatuses.has(latest.status)
            ? await this.call(device, {
                path: `${path}/result`,
                schema: peerTaskResultSchema,
                timeoutMs: 15_000,
                signal,
              })
            : await this.call(device, {
                path: `${path}/result?wait=${wait}`,
                schema: peerTaskResultSchema,
                timeoutMs: (wait + 15) * 1000,
                signal,
              });
          lostSince = undefined;
          failures = 0;
          if (!settledStatuses.has(result.status)) continue;
          delete receipt.uncertain;
          const { backBundle, fileNote } = await receiveResultFiles(taskId, result, signal);
          if (result.status === 'completed') {
            return {
              text: repoNote + (result.result ?? '') + fileNote,
              ...(backBundle ? { backBundle } : {}),
              name,
              ...(latest.executor ? { executor: latest.executor } : {}),
              ...(latest.model ? { model: latest.model } : {}),
            };
          }
          throw Object.assign(
            new RemoteTaskFailed(
              `${repoNote}设备「${name}」上没有完成：${result.error?.trim() || latest.error || result.status}${result.result ? `\n${result.result}` : ''}${fileNote}`,
            ),
            { backBundle },
          );
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof RemoteTaskFailed) throw error;
          if (error instanceof PeerRefused && error.status === 404)
            throw new Error(`设备「${name}」上找不到这条任务了（它可能重启过）。`);
          if (error instanceof PeerRefused && error.status === 401)
            throw new Error(`设备「${name}」不认识这台电脑了：请在「设备」里移除它，再重新配对。`);
          if (error instanceof PeerRefused && error.status !== 429 && error.status < 500)
            throw new Error(`设备「${name}」：${error.message}`);
          lostSince ??= this.now();
          await this.markOffline(device.id, error);
          if (this.now() - lostSince >= (this.options.offlineLimitMs ?? 180_000))
            throw new Error(`和设备「${name}」断开太久，没拿回结果。任务可能还在那台设备上运行。`);
          report((note = `和设备「${name}」的连接断了，正在重连…`));
          await sleep(delays[Math.min(failures++, delays.length - 1)]!, signal);
        }
      }
    } catch (error) {
      if (signal.aborted) {
        const answer = await stop(taskId);
        if (answer) return answer;
        throw signal.reason;
      }
      if (receipt.uncertain) throw new PeerOutcomeUnknown(error instanceof Error ? error.message : reasonOf(error));
      throw error;
    }
  }

  private async connection(device: StoredDevice) {
    const address = await this.target(device);
    if (!address) throw new Error('设备地址无效。');
    return { address, token: device.token, name: device.name, fetch: this.options.fetch, lookup: this.options.lookup };
  }

  /** Sends checked local files without creating a conversation or task. */
  async sendFiles(id: string, files: RecordedPeerFile[]) {
    await this.store.read();
    const device = this.device(id);
    if (!device) throw new Error('没有这台设备。');
    return uploadFiles(await this.connection(device), files);
  }

  // ---- Which PugPort runs Slack.

  private slackExclusive<T>(action: () => Promise<T>): Promise<T> {
    const work = this.slackWork.catch(() => {}).then(action);
    this.slackWork = work;
    return work;
  }

  private async releaseSlack(device: StoredDevice) {
    try {
      const reply = await this.call(device, {
        method: 'PUT',
        path: '/peer/v1/slack',
        body: { host: false },
        schema: slackHostReplySchema,
        timeoutMs: 5000,
      });
      return reply.slackHost === false;
    } catch {
      return false;
    }
  }

  private githubExclusive<T>(action: () => Promise<T>): Promise<T> {
    const work = this.githubWork.catch(() => {}).then(action);
    this.githubWork = work;
    return work;
  }

  private async githubRequest() {
    const config = await this.options.github?.config();
    if (!config) throw new Error('Configure maintainer.json before choosing a GitHub host');
    return githubHostRequestSchema.parse({
      ...config,
      host: true,
      hostedBy: this.options.selfName.slice(0, 60),
      leaseMinutes: 360,
    });
  }

  private async confirmGitHubHost(device: StoredDevice) {
    await this.call(device, {
      method: 'PUT',
      path: '/peer/v1/github',
      body: await this.githubRequest(),
      schema: githubHostReplySchema,
      timeoutMs: 20_000,
    });
  }

  async releaseGitHub(device: StoredDevice) {
    try {
      await this.call(device, {
        method: 'PUT',
        path: '/peer/v1/github',
        body: { host: false },
        schema: githubHostReplySchema,
        timeoutMs: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  renewGitHubHosting(): Promise<void> {
    return this.githubExclusive(async () => {
      if (this.closed || !this.options.github) return;
      const data = await this.store.read();
      const device = this.device(data.githubHost!);
      await this.options.github.standby(device?.name);
      if (device) await this.confirmGitHubHost(device);
    });
  }

  setGitHubHost(id: string | null): Promise<DevicesView & { note?: string }> {
    return this.githubExclusive(async () => {
      if (this.closed) throw new Error('Devices are closed');
      if (!this.options.github) throw new Error('GitHub hosting is unavailable');
      const data = await this.store.read();
      const previous = this.device(data.githubHost!);
      const device = id ? this.device(id) : undefined;
      if (id && id !== 'self' && !device) throw new Error('GitHub host device is no longer paired');
      if (id) await this.githubRequest();
      const released = previous && previous.id !== id ? await this.releaseGitHub(previous) : true;
      if (data.githubHost === 'self' && id !== 'self') {
        await this.store.update((current) => {
          delete current.githubHost;
        });
        await this.options.github.standby(undefined);
      }
      if (device) await this.confirmGitHubHost(device);
      await this.store.update((current) => {
        if (id) current.githubHost = id;
        else delete current.githubHost;
      });
      await this.options.github.standby(device?.name);
      return {
        ...(await this.view()),
        ...(released
          ? {}
          : {
              note: 'The previous GitHub host is offline. It will stop when reconnected or its six-hour lease expires.',
            }),
      };
    });
  }

  /** Hands Slack to a device (with this computer's Slack setup) or takes it back; only one PugPort runs it. */
  setSlackHost(id: string | null): Promise<DevicesView & { note?: string }> {
    return this.slackExclusive(() => this.switchSlackHost(id));
  }

  private async switchSlackHost(id: string | null): Promise<DevicesView & { note?: string }> {
    const data = await this.store.read();
    const previous = data.slackHost ? this.device(data.slackHost!) : undefined;
    if (!id && !data.slackHost) return this.view();
    if (!this.options.slack) throw new Error('这台 PugPort 不能切换 Slack。');
    if (id) {
      const device = this.device(id);
      if (!device) throw new Error('没有这台设备。');
      const local = await this.options.slack.config();
      if (!local.appToken || !local.botToken)
        throw new Error('先在本机的 Slack 卡片里填好两个 Token，再交给设备运行。');
      if (previous && !(await this.releaseSlack(previous)))
        return {
          ...(await this.view()),
          note: 'The previous Slack host has not confirmed release. The new host remains on standby.',
        };
      await this.options.slack.standby(device.name);
      // Persist standby before sending: a lost start reply must not restart the old host after a reboot.
      await this.store.update((current) => {
        current.slackHost = id;
      });
      try {
        await this.call(device, {
          method: 'PUT',
          path: '/peer/v1/slack',
          body: { host: true, appToken: local.appToken, botToken: local.botToken, users: local.users },
          schema: slackHostReplySchema,
          timeoutMs: 20_000,
        });
      } catch (error) {
        throw new Error(`没能让设备「${device.name}」接手 Slack：${reasonOf(error)}`);
      }
      return this.view();
    }
    if (previous && !(await this.releaseSlack(previous)))
      return {
        ...(await this.view()),
        note: 'The previous Slack host has not confirmed release. The new host remains on standby.',
      };
    await this.store.update((current) => {
      delete current.slackHost;
    });
    await this.options.slack.standby(undefined);
    return this.view();
  }
}
