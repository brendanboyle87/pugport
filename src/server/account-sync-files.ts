import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stableJson, type SyncValue } from '../shared/account-sync.ts';
import { DeviceStore, deviceSchema, type StoredDevice } from './devices/store.ts';
import { readRemoteServers, serverSchema } from './remote-servers.ts';
import { writePrivateConfig } from './private-config.ts';
import type { SyncStore } from './account-sync-store.ts';
import type { AccountSyncApi } from './account-sync-api.ts';

type Entry = { kind: 'server-node' | 'remote-server' | 'api-provider'; id: string; value: SyncValue };
type Manifest = { account: string; entries: Record<string, string>; serverNames?: string[] };
const entryKey = (entry: Pick<Entry, 'kind' | 'id'>) => JSON.stringify([entry.kind, entry.id]);
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const deviceEntry = (value: StoredDevice): Entry => {
  const id = value.nodeId ?? value.id;
  return { kind: 'server-node', id, value: { ...value, id } };
};

/** Files remain the runtime source of truth. Only explicitly enrolled server nodes enter the sealed DB mirror. */
export class AccountSyncFiles {
  private observed = new Map<string, Entry>();
  constructor(
    private readonly devices: DeviceStore,
    private readonly serversFile: string,
    private readonly changed: () => void | Promise<void> = () => {},
    private readonly api?: AccountSyncApi,
  ) {}
  private async read(local: SyncStore): Promise<Entry[]> {
    const servers = await readRemoteServers(this.serversFile);
    if (servers.error) throw Error('SYNC_SERVER_FILE_INVALID');
    const devices = await this.devices.reload();
    return [
      ...devices.devices.filter((device) => device.enrolledServer).map(deviceEntry),
      ...servers.servers.map((value): Entry => ({
        kind: 'remote-server',
        id: local.opaqueId('remote-server', value.name),
        value,
      })),
      ...((await this.api?.read()) ?? []).map((entry): Entry => ({ ...entry, kind: 'api-provider' })),
    ];
  }
  /** Whether this computer holds a server or API card that a first sync would upload. Needs no account. */
  async hasLocalEntries(): Promise<boolean> {
    const servers = await readRemoteServers(this.serversFile);
    // An unreadable list is unknown, not empty.
    if (servers.error || servers.servers.length) return true;
    if ((await this.devices.reload()).devices.some((device) => device.enrolledServer)) return true;
    return !!(await this.api?.count());
  }
  private manifest(local: SyncStore) {
    return local.workspace.get<Manifest>('account-sync-files', 'manifest');
  }
  private remember(local: SyncStore, account: string, entries: Entry[]) {
    local.workspace.save('account-sync-files', 'manifest', '', {
      account,
      serverNames: entries.filter((entry) => entry.kind === 'remote-server').map((entry) => String(entry.value.name)),
      entries: Object.fromEntries(entries.map((entry) => [entryKey(entry), hash(entry.value)])),
    });
  }
  async capture(local: SyncStore, account: string) {
    let entries = await this.read(local);
    const manifest = this.manifest(local);
    if (manifest && manifest.account !== account) {
      // Account-owned entries must not be silently uploaded to the next account.
      const foreign = new Set(Object.keys(manifest.entries));
      await this.write(
        local,
        entries.filter(
          (entry) =>
            !foreign.has(entryKey(entry)) &&
            !(
              entry.kind === 'remote-server' &&
              (manifest.serverNames?.includes(String(entry.value.name)) ||
                foreign.has(JSON.stringify(['remote-server', entry.value.name])) ||
                Object.entries(manifest.entries).some(
                  ([key, value]) => JSON.parse(key)[0] === 'remote-server' && value === hash(entry.value),
                ))
            ),
        ),
        entries,
      );
      entries = await this.read(local);
    }
    this.observed = new Map(entries.map((entry) => [entryKey(entry), entry]));
    const prior = manifest?.account === account ? manifest.entries : {};
    local.suppress(() => {
      for (const entry of entries) {
        const current = local.current(entry.kind, entry.id);
        if (prior[entryKey(entry)] === hash(entry.value) && (current || local.base(entry.kind, entry.id))) continue;
        if (current && stableJson(current.value) === stableJson(entry.value)) continue;
        const payload = { owner: '', value: entry.value, deleted: false };
        local.apply(entry.kind, entry.id, payload);
        local.enqueue(entry.kind, entry.id, payload);
      }
      for (const key of Object.keys(prior)) {
        if (this.observed.has(key)) continue;
        const [kind, id] = JSON.parse(key) as [Entry['kind'], string];
        if (!local.current(kind, id)) continue;
        const payload = { owner: '', value: {}, deleted: true };
        local.apply(kind, id, payload);
        local.enqueue(kind, id, payload);
      }
      this.remember(local, account, entries);
    });
  }
  async flush(local: SyncStore, account: string) {
    const desired = (
      local.db
        .prepare("SELECT kind,id FROM workspace_records WHERE kind IN ('server-node','remote-server','api-provider')")
        .all() as {
        kind: Entry['kind'];
        id: string;
      }[]
    ).map(({ kind, id }): Entry => ({ kind, id, value: local.current(kind, id)!.value }));
    await this.write(local, desired, [...this.observed.values()]);
    if (this.api) local.rebindApiRouting();
    // Remember only successful writes. Concurrent local edits are captured next cycle.
    const actual = await this.read(local);
    const old = this.manifest(local)?.entries ?? {};
    const intended = new Map(desired.map((entry) => [entryKey(entry), hash(entry.value)]));
    const hashes: Record<string, string> = {};
    for (const entry of actual) {
      const key = entryKey(entry);
      if (intended.get(key) === hash(entry.value)) hashes[key] = hash(entry.value);
      else if (old[key]) hashes[key] = old[key];
    }
    for (const [key, value] of Object.entries(old))
      if (intended.has(key) && !actual.some((entry) => entryKey(entry) === key)) hashes[key] = value;
    local.workspace.save('account-sync-files', 'manifest', '', {
      account,
      entries: hashes,
      serverNames: actual.filter((entry) => entry.kind === 'remote-server').map((entry) => String(entry.value.name)),
    });
    await this.changed();
  }
  private async write(local: SyncStore, desired: Entry[], expected: Entry[]) {
    await this.api?.write(
      desired.filter((entry) => entry.kind === 'api-provider'),
      expected.filter((entry) => entry.kind === 'api-provider'),
    );
    const before = new Map(expected.map((entry) => [entryKey(entry), hash(entry.value)]));
    const merge = (kind: Entry['kind'], current: Entry[]) => {
      const target = new Map(desired.filter((entry) => entry.kind === kind).map((entry) => [entry.id, entry]));
      for (const entry of current) {
        const key = entryKey(entry);
        if (before.get(key) !== hash(entry.value)) target.set(entry.id, entry);
      }
      for (const entry of expected.filter((entry) => entry.kind === kind)) {
        if (!current.some((item) => item.id === entry.id)) target.delete(entry.id);
      }
      return [...target.values()];
    };
    await this.devices.update((data) => {
      const personal = data.devices.filter((device) => !device.enrolledServer);
      const current = data.devices.filter((device) => device.enrolledServer).map(deviceEntry);
      const localIds = new Map(data.devices.map((device) => [device.nodeId ?? device.id, device.id]));
      data.devices = [
        ...personal,
        ...merge('server-node', current)
          .filter(
            (entry) =>
              !personal.some((device) => device.id === entry.id || (device.nodeId && device.nodeId === entry.id)),
          )
          .map((entry) => deviceSchema.parse({ ...entry.value, id: localIds.get(entry.id) ?? entry.id })),
      ];
      // Two computers can finish pairing before either sees the other's sync result.
      const newest = new Map<string, StoredDevice>();
      for (const device of data.devices) {
        if (!device.enrolledServer) continue;
        const previous = newest.get(device.enrolledServer);
        if (!previous || `${device.pairedAt}:${device.id}` > `${previous.pairedAt}:${previous.id}`)
          newest.set(device.enrolledServer, device);
      }
      data.devices = data.devices.filter(
        (device) => !device.enrolledServer || newest.get(device.enrolledServer) === device,
      );
      if (data.slackHost && !data.devices.some((d) => d.id === data.slackHost)) delete data.slackHost;
      if (data.githubHost !== 'self' && !data.devices.some((d) => d.id === data.githubHost)) delete data.githubHost;
    });
    let text = '';
    try {
      text = await readFile(this.serversFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('SYNC_SERVER_FILE_INVALID');
    }
    let current: Entry[];
    try {
      current = (text ? JSON.parse(text.replace(/^\uFEFF/, '')).servers : []).map((value: unknown): Entry => {
        const parsed = serverSchema.parse(value);
        return { kind: 'remote-server', id: local.opaqueId('remote-server', parsed.name), value: parsed };
      });
    } catch {
      throw Error('SYNC_SERVER_FILE_INVALID');
    }
    const servers = merge('remote-server', current).map((entry) => serverSchema.parse(entry.value));
    if (stableJson(current.map((entry) => entry.value)) !== stableJson(servers))
      await writePrivateConfig(this.serversFile, JSON.stringify({ servers }, null, 2) + '\n', text);
  }
}
