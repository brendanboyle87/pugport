import { randomUUID } from 'node:crypto';
import type { EncryptedBody } from './account-sync-crypto.ts';
import { configuredSync, type SyncConfig, type SyncPayload } from '../shared/account-sync.ts';

export type RemoteRecord = {
  kind: string;
  id: string;
  seq: number;
  body: SyncPayload;
  deleted: boolean;
  device_id: string;
  size: number;
  server_updated_at: string;
};
export type PushChange = Omit<RemoteRecord, 'seq' | 'size' | 'server_updated_at'> & { last_seq: number };
export type LegacyRecord = Omit<RemoteRecord, 'body'> & { body: EncryptedBody; key_id: string };
export type PushResult = { kind: string; id: string } & (
  | { status: 'accepted'; record: RemoteRecord }
  | { status: 'conflict'; record: RemoteRecord | null }
  | { status: 'error'; code: string }
);
export type SyncAccount = { generation: string; legacyPending: boolean; legacyKeyId?: string };
export type SyncDevice = { id: string; name: string; platform: string; cli_providers: string[]; last_seen_at?: string };
type Secrets = Record<string, string>;
type WireRecord = RemoteRecord & { secrets?: Secrets | null };
type WireResult = PushResult & { secrets?: Secrets | null };

/**
 * Fields that never enter a cloud body. The push RPC stores a record's present ones together in one Supabase Vault
 * secret; the pull RPC returns them. Server nodes: the pairing token and the account's tunnel-only access key.
 */
export const secretFields: Readonly<Record<string, readonly string[]>> = {
  'api-provider': ['key'],
  'server-node': ['token', 'access'],
};
export function splitSecrets(kind: string, payload: SyncPayload): { body: SyncPayload; secrets?: Secrets } {
  const fields = (secretFields[kind] ?? []).filter((field) => payload.value && Object.hasOwn(payload.value, field));
  if (!fields.length) return { body: payload };
  const value = { ...payload.value };
  const secrets: Secrets = {};
  for (const field of fields) {
    const secret = value[field];
    delete value[field];
    if (typeof secret === 'string' && secret && !payload.deleted) secrets[field] = secret;
  }
  return { body: { ...payload, value }, ...(Object.keys(secrets).length ? { secrets } : {}) };
}
export function joinSecrets(kind: string, payload: SyncPayload, secrets?: Secrets | null): SyncPayload {
  if (!secrets || typeof secrets !== 'object' || payload.deleted || !payload.value || typeof payload.value !== 'object')
    return payload;
  const found = (secretFields[kind] ?? []).filter((field) => typeof secrets[field] === 'string');
  if (!found.length) return payload;
  return { ...payload, value: { ...payload.value, ...Object.fromEntries(found.map((f) => [f, secrets[f]])) } };
}
function joined({ secrets, ...record }: WireRecord): RemoteRecord {
  return record.body && typeof record.body === 'object'
    ? { ...record, body: joinSecrets(record.kind, record.body, secrets) }
    : record;
}

export interface SyncRemote {
  readonly userId: string;
  /** Creates the account row when missing; a cloud deletion makes the next call start a new generation. */
  account(): Promise<SyncAccount>;
  legacyPull(afterSeq: number, limit?: number): Promise<LegacyRecord[]>;
  finishLegacyMigration(deviceId: string): Promise<void>;
  count(kind: string): Promise<number>;
  pull(afterSeq: number, limit?: number): Promise<RemoteRecord[]>;
  /** Bodies may carry secret fields; the transport moves them out of the body before anything is sent. */
  push(generation: string, changes: PushChange[]): Promise<PushResult[]>;
  upsertDevice(device: SyncDevice): Promise<void>;
  listDevices(): Promise<SyncDevice[]>;
  deleteMyCloudData(): Promise<void>;
}
export class SyncRemoteError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function deviceMetadata(device: SyncDevice): SyncDevice {
  if (!device.id || !device.name || !device.platform) throw new SyncRemoteError('INVALID_DEVICE');
  return {
    id: device.id,
    name: device.name.slice(0, 128),
    platform: device.platform.slice(0, 32),
    cli_providers: [...new Set(device.cli_providers)]
      .filter((p) => ['codex', 'claude', 'grok', 'cursor'].includes(p))
      .sort(),
  };
}
/** The callback is evaluated for every request. Refresh-token ownership stays in Electron. */
export class PostgrestSyncRemote implements SyncRemote {
  constructor(
    private readonly config: SyncConfig,
    readonly userId: string,
    private readonly accessToken: () => string | undefined | Promise<string | undefined>,
    private readonly request: typeof fetch = fetch,
  ) {}
  private async json(path: string, method = 'GET', body?: unknown, prefer?: string): Promise<unknown> {
    if (!configuredSync(this.config)) throw new SyncRemoteError('NOT_CONFIGURED');
    const token = await this.accessToken();
    if (!token) throw new SyncRemoteError('SIGNED_OUT');
    // This is an account-binding check, not JWT authentication; Supabase still verifies the signature.
    let subject: unknown;
    try {
      subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
    } catch {
      throw new SyncRemoteError('AUTH_REQUIRED');
    }
    if (subject !== this.userId) throw new SyncRemoteError('ACCOUNT_MISMATCH');
    let response: Response;
    try {
      response = await this.request(`${this.config.url.replace(/\/$/, '')}/rest/v1/${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          apikey: this.config.publishableKey,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(prefer ? { Prefer: prefer } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SyncRemoteError('OFFLINE');
    }
    if (!response.ok) {
      if (path === 'rpc/push_sync_records' && response.status === 400) {
        const failure = (await response.json().catch(() => undefined)) as
          { code?: string; message?: string } | undefined;
        // Recognize only the kind constraint. Never log the server's potentially sensitive detail.
        if (failure?.code === '23514' && /\bsync_records_kind_check\b/.test(failure.message ?? ''))
          throw new SyncRemoteError('UNSUPPORTED_KIND');
      }
      throw new SyncRemoteError(response.status === 401 ? 'AUTH_REQUIRED' : `HTTP_${response.status}`);
    }
    if (method === 'HEAD') {
      const count = Number(response.headers.get('Content-Range')?.split('/').at(-1));
      if (!Number.isSafeInteger(count) || count < 0) throw new SyncRemoteError('INVALID_RESPONSE');
      return count;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  async account(): Promise<SyncAccount> {
    const row = (await this.json('rpc/ensure_sync_account', 'POST', {})) as {
      generation?: unknown;
      legacy_pending?: unknown;
      legacy_key_id?: unknown;
    } | null;
    if (!row || typeof row.generation !== 'string' || !row.generation || typeof row.legacy_pending !== 'boolean')
      throw new SyncRemoteError('INVALID_RESPONSE');
    return {
      generation: row.generation,
      legacyPending: row.legacy_pending,
      ...(typeof row.legacy_key_id === 'string' ? { legacyKeyId: row.legacy_key_id } : {}),
    };
  }
  async count(kind: string) {
    return (await this.json(
      `sync_records?select=id&kind=eq.${encodeURIComponent(kind)}&deleted=is.false`,
      'HEAD',
      undefined,
      'count=exact',
    )) as number;
  }
  async legacyPull(afterSeq: number, limit = 200): Promise<LegacyRecord[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SyncRemoteError('INVALID_CURSOR');
    const rows = await this.json(
      `records?select=kind,id,seq,body,deleted,device_id,size,server_updated_at,key_id&seq=gt.${afterSeq}&order=seq.asc&limit=${Math.max(1, Math.min(200, limit))}`,
    );
    if (!Array.isArray(rows)) throw new SyncRemoteError('INVALID_RESPONSE');
    return rows as LegacyRecord[];
  }
  async finishLegacyMigration(deviceId: string) {
    await this.json('rpc/finish_legacy_migration', 'POST', { p_device_id: deviceId });
  }
  async pull(afterSeq: number, limit = 200) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SyncRemoteError('INVALID_CURSOR');
    const rows = await this.json('rpc/pull_sync_records', 'POST', {
      after_seq: afterSeq,
      max_rows: Math.max(1, Math.min(200, limit)),
    });
    if (!Array.isArray(rows)) throw new SyncRemoteError('INVALID_RESPONSE');
    return (rows as WireRecord[]).map((row) => (row && typeof row === 'object' ? joined(row) : row));
  }
  async push(generation: string, changes: PushChange[]) {
    const sent = changes.map((change) => {
      const { body, secrets } = splitSecrets(change.kind, change.body);
      return { change: { ...change, body }, secrets };
    });
    const results = await this.json('rpc/push_sync_records', 'POST', {
      p_generation: generation,
      changes: sent.map(({ change, secrets }) => ({ ...change, ...(secrets ? { secrets } : {}) })),
    });
    if (!Array.isArray(results)) throw new SyncRemoteError('INVALID_RESPONSE');
    return (results as WireResult[]).map((result, i): PushResult => {
      if (!result || typeof result !== 'object') return result;
      const { secrets, ...rest } = result;
      // Accepted rows echo the stored body; the secret is the one this request sent.
      if (rest.status === 'accepted' && rest.record)
        return { ...rest, record: joined({ ...rest.record, secrets: sent[i]?.secrets }) };
      if (rest.status === 'conflict' && rest.record) return { ...rest, record: joined({ ...rest.record, secrets }) };
      return rest;
    });
  }
  async upsertDevice(device: SyncDevice) {
    await this.json(
      'devices?on_conflict=user_id,id',
      'POST',
      { ...deviceMetadata(device), last_seen_at: new Date().toISOString() },
      'resolution=merge-duplicates',
    );
  }
  async deleteMyCloudData() {
    await this.json('rpc/delete_my_cloud_data', 'POST', {});
  }
  async listDevices() {
    return (await this.json(
      'devices?select=id,name,platform,last_seen_at,cli_providers&order=last_seen_at.desc',
    )) as SyncDevice[];
  }
}

/** PostgreSQL jsonb::text: keys ordered by length then bytes, a space after each separator. */
function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(
      ([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** One instance represents one authenticated account, shared by simulated devices. */
export class MemorySyncRemote implements SyncRemote {
  /** Cloud bodies exactly as stored: never a secret field. */
  readonly records = new Map<string, RemoteRecord>();
  readonly legacy = new Map<string, LegacyRecord>();
  /** Stand-in for Supabase Vault, keyed like `records`. */
  readonly secrets = new Map<string, Secrets>();
  readonly devices = new Map<string, SyncDevice>();
  online = true;
  /** Simulates an account that still has legacy end-to-end encrypted rows. */
  legacyKeyId?: string;
  migrated = false;
  private seq = 0;
  private row?: { generation: string };
  constructor(
    readonly quotaBytes = 50 * 1024 * 1024,
    readonly userId = 'user',
  ) {}
  /** The current generation; creates the account row like ensure_sync_account(). */
  get generation() {
    return (this.row ??= { generation: randomUUID() }).generation;
  }
  private check() {
    if (!this.online) throw new SyncRemoteError('OFFLINE');
  }
  private withSecrets(record: RemoteRecord): RemoteRecord {
    return joined({ ...structuredClone(record), secrets: this.secrets.get(JSON.stringify([record.kind, record.id])) });
  }
  async account() {
    this.check();
    return {
      generation: this.generation,
      legacyPending: !!this.legacyKeyId && !this.migrated,
      ...(this.legacyKeyId ? { legacyKeyId: this.legacyKeyId } : {}),
    };
  }
  async legacyPull(afterSeq: number, limit = 200) {
    this.check();
    return structuredClone(
      [...this.legacy.values()]
        .filter((r) => r.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit),
    );
  }
  async finishLegacyMigration(_deviceId: string) {
    this.check();
    if (!this.row) throw new SyncRemoteError('CLOUD_DATA_RESET');
    this.migrated = true;
  }
  async legacyPush(changes: LegacyRecord[]) {
    this.check();
    return changes.map((change) => {
      const code = this.migrated
        ? 'CLIENT_UPGRADE_REQUIRED'
        : change.key_id !== this.legacyKeyId
          ? 'CLOUD_DATA_RESET'
          : undefined;
      if (code) return { kind: change.kind, id: change.id, status: 'error', code };
      for (const row of this.legacy.values()) this.seq = Math.max(this.seq, row.seq);
      const record = { ...structuredClone(change), seq: ++this.seq };
      this.legacy.set(JSON.stringify([change.kind, change.id]), record);
      return { kind: change.kind, id: change.id, status: 'accepted', record };
    });
  }
  async count(kind: string) {
    this.check();
    return [...this.records.values()].filter((r) => r.kind === kind && !r.deleted).length;
  }
  async pull(afterSeq: number, limit = 200) {
    this.check();
    return [...this.records.values()]
      .filter((r) => r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => this.withSecrets(r));
  }
  async push(generation: string, changes: PushChange[]): Promise<PushResult[]> {
    this.check();
    for (const row of this.legacy.values()) this.seq = Math.max(this.seq, row.seq);
    return changes.map((change) => {
      if (!this.row || generation !== this.row.generation)
        return { kind: change.kind, id: change.id, status: 'error', code: 'CLOUD_DATA_RESET' };
      const key = JSON.stringify([change.kind, change.id]);
      const prior = this.records.get(key);
      if ((prior?.seq ?? 0) !== change.last_seq)
        return { kind: change.kind, id: change.id, status: 'conflict', record: prior ? this.withSecrets(prior) : null };
      const { body, secrets } = splitSecrets(change.kind, change.body);
      if ((secretFields[change.kind] ?? []).some((field) => Object.hasOwn(body.value, field)))
        return { kind: change.kind, id: change.id, status: 'error', code: 'SECRET_IN_BODY' };
      const size =
        Buffer.byteLength(jsonbText(body)) + Buffer.byteLength(change.id) + Buffer.byteLength(change.device_id) + 128;
      if (size > 512 * 1024) return { kind: change.kind, id: change.id, status: 'error', code: 'RECORD_TOO_LARGE' };
      if ([...this.records.values()].reduce((sum, r) => sum + r.size, 0) - (prior?.size ?? 0) + size > this.quotaBytes)
        return { kind: change.kind, id: change.id, status: 'error', code: 'QUOTA_EXCEEDED' };
      const record: RemoteRecord = {
        kind: change.kind,
        id: change.id,
        body: structuredClone(body),
        deleted: change.deleted,
        device_id: change.device_id,
        size,
        seq: ++this.seq,
        server_updated_at: new Date().toISOString(),
      };
      this.records.set(key, record);
      if (secrets) this.secrets.set(key, { ...secrets });
      else this.secrets.delete(key);
      return { kind: change.kind, id: change.id, status: 'accepted', record: this.withSecrets(record) };
    });
  }
  async upsertDevice(device: SyncDevice) {
    this.check();
    this.devices.set(device.id, deviceMetadata(device));
  }
  async listDevices() {
    this.check();
    return structuredClone([...this.devices.values()]);
  }
  async deleteMyCloudData() {
    this.check();
    this.records.clear();
    this.legacy.clear();
    this.secrets.clear();
    this.devices.clear();
    this.row = undefined;
    this.legacyKeyId = undefined;
    this.migrated = false;
  }
}
