import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { backup as backupDatabase } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { WorkspaceStore } from './workspace-store.ts';
import {
  filterSyncValue,
  localConversationKeys,
  localLaneKeys,
  stableJson,
  syncKinds,
  type SyncPayload,
  type SyncValue,
} from '../shared/account-sync.ts';
import { projectSyncIdentity } from './account-sync-project.ts';
import { mapApiRouting } from '../shared/account-sync-routing.ts';
import { messageProvenanceHash, encryptRecord, decryptRecord, type EncryptedBody } from './account-sync-crypto.ts';

export type LocalChange = SyncPayload & { kind: string; id: string; generation: number; changedAt: number };
export type SyncBase = SyncPayload & { seq: number; deviceId: string };
type PendingRow = Omit<LocalChange, 'value' | 'deleted'> & { value: string; deleted: number };
const kindsSql = syncKinds.map((k) => `'${k}'`).join(',');
function eligible(row: string): string {
  return `${row}.kind IN (${kindsSql})
    AND (${row}.kind<>'message' OR json_extract(${row}.value,'$.syncNotice') IS NULL)
    AND (${row}.kind<>'conversation' OR COALESCE(json_extract(${row}.value,'$.incognito'),0)=0)
    AND (${row}.kind NOT IN ('message','human-message') OR (
      EXISTS (SELECT 1 FROM workspace_records c WHERE c.kind='conversation' AND c.id=${row}.owner AND COALESCE(json_extract(c.value,'$.incognito'),0)=0)
      AND json_extract(${row}.value,'$.importedFrom') IS NULL
      AND (${row}.kind<>'human-message' OR EXISTS (SELECT 1 FROM workspace_records m WHERE m.kind='message' AND m.id=${row}.id AND m.owner=${row}.owner AND json_extract(m.value,'$.importedFrom') IS NULL))
      AND NOT EXISTS (SELECT 1 FROM workspace_records m WHERE m.kind='message' AND m.id=${row}.id AND json_extract(m.value,'$.importedFrom') IS NOT NULL)))`;
}

/** Lazy migration: constructing a store while signed out does not create any sync objects. */
export class SyncStore {
  private deviceKey?: Buffer;
  /** The per-computer seal key for local server-node/API-card mirror rows. */
  setSealKey(key?: Uint8Array) {
    this.deviceKey?.fill(0);
    this.deviceKey = key && Buffer.from(key);
    if (!key) return;
    const fingerprint = createHash('sha256').update(key).digest('hex');
    if (this.workspace.get<{ fingerprint: string }>('account-sync-local', 'seal')?.fingerprint === fingerprint) return;
    this.purgeSealedMirrors(fingerprint);
  }
  /** Same id on every computer of one account, without any secret. */
  opaqueId(kind: string, name: string): string {
    const account = this.state()?.account;
    if (!account) throw Error('SYNC_INACTIVE');
    return createHmac('sha256', account).update(`${kind}\0${name}`).digest('hex');
  }
  private protect(kind: string, value: SyncValue): SyncValue {
    if (!['server-node', 'api-provider'].includes(kind) || !Object.keys(value).length) return value;
    if (!this.deviceKey) throw Error('KEY_REQUIRED');
    return { sealedDevice: encryptRecord(this.deviceKey, `${kind}-local`, kind, value) };
  }
  private reveal(kind: string, value: SyncValue): SyncValue {
    if (!['server-node', 'api-provider'].includes(kind) || !Object.keys(value).length) return value;
    if (!this.deviceKey) throw Error('KEY_REQUIRED');
    if (!value.sealedDevice) throw Error('INVALID_DEVICE_STORAGE');
    return decryptRecord<SyncValue>(this.deviceKey, `${kind}-local`, kind, value.sealedDevice as EncryptedBody);
  }
  private readPayload(kind: string, text: string): SyncPayload {
    const payload = JSON.parse(text) as SyncPayload;
    return { ...payload, value: this.reveal(kind, payload.value) };
  }
  private writePayload(kind: string, payload: SyncPayload) {
    return JSON.stringify({ ...payload, value: this.protect(kind, payload.value) });
  }
  private backupCleanupTimer?: ReturnType<typeof setTimeout>;
  private backupCleanupGeneration = 0;
  constructor(
    readonly workspace: WorkspaceStore,
    readonly directory: string,
  ) {
    this.purgeLegacyDevices();
    this.purgeSealedMirrors();
  }
  /**
   * Plain sync seals mirror rows with a local key and derives server ids from the account, so rows written
   * with the old cloud key are unreadable. The files stay the source of truth and are captured again.
   */
  private purgeSealedMirrors(fingerprint?: string) {
    if (!fingerprint && this.workspace.get<{ v: number }>('account-sync-local', 'format')?.v === 2) return;
    this.workspace.transaction(() => {
      const state = this.exists() ? this.db.prepare('SELECT suppressed FROM sync_state WHERE id=1').get() : undefined;
      if (state) this.db.exec('UPDATE sync_state SET suppressed=1');
      const kinds = fingerprint ? "('server-node','api-provider')" : "('server-node','api-provider','remote-server')";
      this.db.exec(`DELETE FROM workspace_records WHERE kind IN ${kinds}`);
      for (const table of ['sync_outbox', 'sync_base', 'sync_retained']) {
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          this.db.exec(`DELETE FROM ${table} WHERE kind IN ${kinds}`);
      }
      // Re-pull cloud-only mirrors too; file capture reconstructs the local entries before that pull.
      if (state && fingerprint) this.db.exec('UPDATE sync_state SET cursor=0');
      if (fingerprint) this.workspace.save('account-sync-local', 'seal', '', { fingerprint });
      this.workspace.save('account-sync-local', 'format', '', { v: 2 });
      if (state) this.db.prepare('UPDATE sync_state SET suppressed=?').run(state.suppressed);
    });
  }
  private purgeLegacyDevices() {
    this.workspace.transaction(() => {
      const state = this.exists() ? this.db.prepare('SELECT suppressed FROM sync_state WHERE id=1').get() : undefined;
      if (state) this.db.exec('UPDATE sync_state SET suppressed=1');
      this.db.exec("DELETE FROM workspace_records WHERE kind='device'");
      for (const table of ['sync_outbox', 'sync_base', 'sync_retained', 'sync_alias']) {
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          this.db.exec(`DELETE FROM ${table} WHERE kind='device'`);
      }
      const manifest = this.workspace.get<{ account: string; entries: Record<string, string> }>(
        'account-sync-files',
        'manifest',
      );
      if (manifest) {
        manifest.entries = Object.fromEntries(
          Object.entries(manifest.entries).filter(([key]) => JSON.parse(key)[0] !== 'device'),
        );
        this.workspace.save('account-sync-files', 'manifest', '', manifest);
      }
      if (state) this.db.prepare('UPDATE sync_state SET suppressed=?').run(state.suppressed);
    });
  }
  get db() {
    return this.workspace.db;
  }
  counts() {
    const counts = { chats: 0, folders: 0, projects: 0, memories: 0 };
    const fields: Record<string, keyof typeof counts> = {
      conversation: 'chats',
      'conversation-folder': 'folders',
      project: 'projects',
      memory: 'memories',
    };
    for (const row of this.db
      .prepare(`SELECT kind,COUNT(*) AS n FROM workspace_records r WHERE ${eligible('r')} GROUP BY kind`)
      .all() as { kind: string; n: number }[])
      if (fields[row.kind]) counts[fields[row.kind]] = row.n;
    return counts;
  }
  /** Any record the first union would upload. Settings are left out: on a first pull the cloud's fields win. */
  hasLocalRecords() {
    return !!this.db.prepare(`SELECT 1 FROM workspace_records r WHERE ${eligible('r')} LIMIT 1`).get();
  }
  exists() {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_state'").get();
  }
  state():
    | { account: string; enabled: number; cursor: number; backup: string | null; disabled_at: string | null }
    | undefined {
    return this.exists()
      ? (this.db.prepare('SELECT * FROM sync_state WHERE id=1').get() as ReturnType<SyncStore['state']>)
      : undefined;
  }
  get backupPath() {
    return this.state()?.backup ?? undefined;
  }
  get cursor() {
    return this.state()?.cursor ?? 0;
  }
  activity() {
    return this.db
      .prepare('SELECT n AS generation,EXISTS(SELECT 1 FROM sync_outbox) AS pending FROM sync_clock WHERE id=1')
      .get() as { generation: number; pending: number };
  }
  set cursor(seq: number) {
    this.db.prepare('UPDATE sync_state SET cursor=? WHERE id=1').run(seq);
  }
  async activate(account: string, allowAccountChange = false) {
    this.purgeLegacyDevices();
    const state = this.state();
    if (state?.account && state.account !== account && !allowAccountChange)
      throw Error('ACCOUNT_CHANGE_REQUIRES_CONSENT');
    let backup = state?.backup ?? null;
    if (!state || state.account !== account) {
      mkdirSync(this.directory, { recursive: true });
      backup = join(this.directory, `before-account-sync-${randomUUID()}.sqlite`);
      await backupDatabase(this.db, backup);
      try {
        await this.sanitizeBackup(backup);
      } catch (error) {
        await unlink(backup).catch(() => {});
        throw error;
      }
    }
    this.workspace.transaction(() => {
      this.migrate();
      if (backup)
        this.db
          .prepare('INSERT OR IGNORE INTO sync_backups(path,account,first_success_at) VALUES(?,?,NULL)')
          .run(backup, account);
      if (state?.account && state.account !== account)
        this.db.exec(
          "DELETE FROM sync_outbox; DELETE FROM sync_base; DELETE FROM sync_alias; DELETE FROM sync_retained; DELETE FROM sync_human_markers; DELETE FROM workspace_records WHERE kind IN ('server-node','remote-server','api-provider');",
        );
      this.db
        .prepare(
          `INSERT INTO sync_state(id,account,enabled,suppressed,cursor,backup) VALUES(1,?,1,0,0,?)
        ON CONFLICT(id) DO UPDATE SET account=excluded.account,enabled=1,suppressed=0,backup=excluded.backup,cursor=CASE WHEN sync_state.account=excluded.account THEN sync_state.cursor ELSE 0 END`,
        )
        .run(account, backup);
      // Enabled triggers already captured live changes. Revisit only rows changed while disabled.
      const hasSnapshot = !!this.db.prepare('SELECT 1 FROM sync_base LIMIT 1').get();
      const changedSince =
        state?.account === account && (state.cursor !== 0 || hasSnapshot)
          ? (state.disabled_at ?? (state.enabled ? '9999' : ''))
          : '';
      const rows = this.db
        .prepare(`SELECT kind,id,owner,value FROM workspace_records r WHERE ${eligible('r')} AND updated_at>=?`)
        .all(changedSince) as { kind: string; id: string; owner: string; value: string }[];
      for (const row of rows) {
        const payload = { owner: row.owner, value: this.filtered(row.kind, JSON.parse(row.value)), deleted: false };
        const retained = this.db
          .prepare('SELECT payload FROM sync_retained WHERE kind=? AND id=?')
          .get(row.kind, row.id);
        if (retained && stableJson(payload) === stableJson(this.readPayload(row.kind, retained.payload as string)))
          continue;
        if (stableJson(payload) !== stableJson(this.basePayload(row.kind, row.id)))
          this.enqueue(row.kind, row.id, payload);
      }
      for (const row of this.db
        .prepare(
          `SELECT b.kind,b.id,b.payload FROM sync_base b
        LEFT JOIN workspace_records r ON r.kind=b.kind AND r.id=b.id
        WHERE b.kind<>'settings' AND r.id IS NULL AND COALESCE(json_extract(b.payload,'$.deleted'),0)=0
        AND (b.kind<>'human-message' OR NOT EXISTS(SELECT 1 FROM sync_human_markers m WHERE m.id=b.id))`,
        )
        .all() as {
        kind: string;
        id: string;
        payload: string;
      }[]) {
        const old = this.readPayload(row.kind, row.payload);
        this.enqueue(row.kind, row.id, { ...old, deleted: true });
      }
      if (this.hasConfig()) {
        const settings = this.filtered('settings', this.settings());
        if (stableJson(settings) !== stableJson(this.base('settings', 'settings')?.value ?? {}))
          this.enqueue('settings', 'settings', { owner: '', value: settings, deleted: false });
      }
      this.db.exec('UPDATE sync_state SET disabled_at=NULL WHERE id=1');
    });
    await this.cleanupBackups();
  }
  deactivate() {
    if (this.exists()) {
      this.migrate();
      this.db
        .prepare('UPDATE sync_state SET enabled=0,suppressed=0,disabled_at=COALESCE(disabled_at,?) WHERE id=1')
        .run(new Date().toISOString());
    }
  }
  private async sanitizeBackup(path: string) {
    // Vacuum and secure deletion run on the backup's own worker connection, never on the UI/backend thread.
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(
        `
        const { DatabaseSync } = require('node:sqlite');
        const { workerData } = require('node:worker_threads');
        const db = new DatabaseSync(workerData);
        try {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_state'").get())
            db.exec('UPDATE sync_state SET enabled=0,suppressed=0');
          db.exec("PRAGMA secure_delete=ON; BEGIN; CREATE TEMP TABLE private_chats AS SELECT id FROM workspace_records WHERE kind='conversation' AND json_extract(value,'$.incognito')=1;");
          db.exec("CREATE TEMP TABLE private_messages AS SELECT id FROM workspace_records WHERE kind IN ('message','human-message') AND owner IN (SELECT id FROM private_chats);");
          for (const table of ['sync_base', 'sync_retained', 'sync_outbox', 'sync_human_markers']) {
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
            if (table === 'sync_human_markers') {
              db.exec("DELETE FROM sync_human_markers WHERE owner IN (SELECT id FROM private_chats) OR id IN (SELECT id FROM private_messages)");
              continue;
            }
            const owner = table === 'sync_outbox' ? 'owner' : "json_extract(payload,'$.owner')";
            db.exec("DELETE FROM " + table + " WHERE (kind='conversation' AND id IN (SELECT id FROM private_chats)) OR (kind IN ('message','human-message') AND (" + owner + " IN (SELECT id FROM private_chats) OR id IN (SELECT id FROM private_messages)))");
          }
          db.exec("DELETE FROM workspace_records WHERE (kind IN ('message','human-message') AND owner IN (SELECT id FROM private_chats)) OR (kind='conversation' AND id IN (SELECT id FROM private_chats)); COMMIT; VACUUM;");
        } finally { db.close(); }
      `,
        { eval: true, workerData: path },
      );
      worker.once('error', reject);
      worker.once('exit', (code) => (code === 0 ? resolve() : reject(Error(`BACKUP_CLEANUP_FAILED:${code}`))));
    });
  }
  async markSuccessfulSync() {
    if (!this.exists()) return;
    this.db.prepare('UPDATE sync_backups SET first_success_at=? WHERE first_success_at IS NULL').run(Date.now());
    await this.cleanupBackups();
  }
  async cleanupBackups() {
    this.dispose();
    const generation = this.backupCleanupGeneration;
    if (!this.exists()) return;
    const lifetime = 14 * 86400_000;
    const backups = this.db
      .prepare('SELECT path,first_success_at FROM sync_backups WHERE first_success_at IS NOT NULL')
      .all() as { path: string; first_success_at: number }[];
    let next = Number.POSITIVE_INFINITY;
    for (const entry of backups) {
      const remaining = entry.first_success_at + lifetime - Date.now();
      if (remaining > 0) {
        next = Math.min(next, remaining);
        continue;
      }
      try {
        await unlink(entry.path);
      } catch (error) {
        if (generation !== this.backupCleanupGeneration) return;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          next = Math.min(next, 60_000);
          continue;
        }
      }
      if (generation !== this.backupCleanupGeneration) return;
      this.db.prepare('DELETE FROM sync_backups WHERE path=?').run(entry.path);
      this.db.prepare('UPDATE sync_state SET backup=NULL WHERE backup=?').run(entry.path);
    }
    if (Number.isFinite(next)) {
      this.backupCleanupTimer = setTimeout(
        () => {
          void this.cleanupBackups().catch(() => {});
        },
        Math.max(1, next),
      );
      this.backupCleanupTimer.unref();
    }
  }
  dispose() {
    this.backupCleanupGeneration++;
    clearTimeout(this.backupCleanupTimer);
    this.backupCleanupTimer = undefined;
  }
  private hasConfig() {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config'").get();
  }
  settings(): SyncValue {
    const row = this.hasConfig() ? this.db.prepare("SELECT value FROM config WHERE key='settings'").get() : undefined;
    return filterSyncValue('settings', row ? JSON.parse(row.value as string) : {});
  }
  private migrate() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK(id=1),account TEXT NOT NULL,enabled INTEGER NOT NULL,suppressed INTEGER NOT NULL,cursor INTEGER NOT NULL,backup TEXT,disabled_at TEXT);
      CREATE TABLE IF NOT EXISTS sync_backups (path TEXT PRIMARY KEY,account TEXT NOT NULL,first_success_at INTEGER);
      CREATE TABLE IF NOT EXISTS sync_clock (id INTEGER PRIMARY KEY CHECK(id=1),n INTEGER NOT NULL);
      INSERT OR IGNORE INTO sync_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS sync_outbox (kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,value TEXT NOT NULL,deleted INTEGER NOT NULL,generation INTEGER NOT NULL,changed_at INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS sync_outbox_generation ON sync_outbox(generation);
      CREATE TABLE IF NOT EXISTS sync_base (kind TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS sync_alias (kind TEXT NOT NULL,id TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS sync_retained (kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS sync_human_markers (id TEXT PRIMARY KEY,owner TEXT NOT NULL,value TEXT NOT NULL);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(sync_state)')
        .all()
        .some((column) => column.name === 'disabled_at')
    )
      this.db.exec('ALTER TABLE sync_state ADD COLUMN disabled_at TEXT');
    const enabled = '(SELECT enabled=1 AND suppressed=0 FROM sync_state WHERE id=1)';
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      const condition =
        operation === 'DELETE'
          ? `(${eligible(row)}) OR (OLD.kind IN ('message','human-message') AND EXISTS(SELECT 1 FROM sync_base WHERE kind=OLD.kind AND id=OLD.id))`
          : eligible(row);
      this.db.exec(`DROP TRIGGER IF EXISTS sync_workspace_${operation.toLowerCase()}`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS sync_workspace_${operation.toLowerCase()}
        ${operation === 'DELETE' ? 'BEFORE' : 'AFTER'} ${operation} ON workspace_records
        WHEN ${enabled} AND (${condition}) BEGIN
          UPDATE sync_clock SET n=n+1;
          INSERT INTO sync_outbox(kind,id,owner,value,deleted,generation,changed_at)
          VALUES(${row}.kind,${row}.id,${row}.owner,${row}.value,${operation === 'DELETE' ? 1 : 0},(SELECT n FROM sync_clock WHERE id=1),CAST(unixepoch('subsec')*1000 AS INTEGER))
          ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,value=excluded.value,deleted=excluded.deleted,generation=excluded.generation,changed_at=excluded.changed_at;
        END`);
    }
    // A privacy toggle must also remove queued children before the next network batch.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS sync_privacy_update AFTER UPDATE ON workspace_records
      WHEN ${enabled} AND (NEW.kind='conversation' AND json_extract(NEW.value,'$.incognito')=1) BEGIN
        DELETE FROM sync_outbox WHERE (kind='conversation' AND id=NEW.id) OR (kind IN ('message','human-message') AND owner=NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS sync_import_update AFTER UPDATE ON workspace_records
      WHEN ${enabled} AND NEW.kind='message' AND json_extract(NEW.value,'$.importedFrom') IS NOT NULL BEGIN
        DELETE FROM sync_outbox WHERE kind IN ('message','human-message') AND id=NEW.id;
      END;`);
    if (this.hasConfig())
      for (const operation of ['INSERT', 'UPDATE'])
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS sync_settings_${operation.toLowerCase()} AFTER ${operation} ON config
      WHEN ${enabled} AND NEW.key='settings' BEGIN
        UPDATE sync_clock SET n=n+1;
        INSERT INTO sync_outbox(kind,id,owner,value,deleted,generation,changed_at) VALUES('settings','settings','',NEW.value,0,(SELECT n FROM sync_clock),CAST(unixepoch('subsec')*1000 AS INTEGER))
        ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,generation=excluded.generation,changed_at=excluded.changed_at;
      END`);
  }
  pending(limit = Number.MAX_SAFE_INTEGER, include: (change: LocalChange) => boolean = () => true): LocalChange[] {
    if (!this.exists()) return [];
    const result: LocalChange[] = [];
    for (const raw of this.db
      .prepare('SELECT *,changed_at AS changedAt FROM sync_outbox ORDER BY generation')
      .iterate()) {
      const row = this.cleanPending(raw as unknown as PendingRow);
      if (row && include(row)) result.push(row);
      if (result.length >= limit) break;
    }
    return result;
  }
  pendingOne(kind: string, id: string): LocalChange | undefined {
    const raw = this.db
      .prepare('SELECT *,changed_at AS changedAt FROM sync_outbox WHERE kind=? AND id=?')
      .get(kind, id);
    return raw ? this.cleanPending(raw as unknown as PendingRow) : undefined;
  }
  hasNewMessage(owner: string, exceptId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM sync_outbox o WHERE o.kind='message' AND o.owner=? AND o.id<>? AND o.deleted=0
      AND NOT EXISTS(SELECT 1 FROM sync_base b WHERE b.kind=o.kind AND b.id=o.id) LIMIT 1`,
      )
      .get(owner, exceptId);
  }
  private cleanPending(raw: PendingRow): LocalChange | undefined {
    if (raw.kind !== 'settings' && !syncKinds.includes(raw.kind as (typeof syncKinds)[number])) {
      this.db.prepare('DELETE FROM sync_outbox WHERE kind=? AND id=?').run(raw.kind, raw.id);
      return;
    }
    const row = { ...raw, value: this.filtered(raw.kind, JSON.parse(raw.value)), deleted: !!raw.deleted };
    const current = this.workspace.get<SyncValue>(row.kind, row.id);
    const parent = ['message', 'human-message'].includes(row.kind)
      ? this.workspace.get<SyncValue>('conversation', row.owner)
      : undefined;
    const message = row.kind === 'human-message' ? this.workspace.get<SyncValue>('message', row.id) : current;
    if (
      (row.kind === 'conversation' && (current?.incognito || row.value.incognito)) ||
      parent?.incognito ||
      (['message', 'human-message'].includes(row.kind) && (message?.importedFrom || row.value.importedFrom))
    ) {
      this.acknowledge(row);
      return;
    }
    if (row.kind !== 'settings' && !current && !row.deleted) {
      row.deleted = true;
      row.value = {};
      this.db
        .prepare("UPDATE sync_outbox SET deleted=1,value='{}' WHERE kind=? AND id=? AND generation=?")
        .run(row.kind, row.id, row.generation);
    }
    return row;
  }
  /** Reset after confirmed cloud deletion or a changed cloud generation, never from an empty records pull. */
  resetAfterCloudDeletion() {
    if (!this.exists()) return;
    this.workspace.transaction(() =>
      this.db.exec(
        "UPDATE sync_state SET enabled=0,suppressed=1,cursor=0,disabled_at=NULL; DELETE FROM workspace_records WHERE kind IN ('server-node','api-provider','remote-server'); DELETE FROM sync_outbox; DELETE FROM sync_base; DELETE FROM sync_alias; DELETE FROM sync_retained; DELETE FROM sync_human_markers; UPDATE sync_state SET suppressed=0;",
      ),
    );
  }
  filtered(kind: string, value: SyncValue): SyncValue {
    if (['server-node', 'api-provider'].includes(kind) && value.sealedDevice) value = this.reveal(kind, value);
    if (kind === 'human-message' && !value.messageHash && typeof value.id === 'string') {
      const row = this.db
        .prepare("SELECT owner,value FROM workspace_records WHERE kind='message' AND id=?")
        .get(value.id);
      if (row)
        value = { ...value, messageHash: messageProvenanceHash(row.owner as string, JSON.parse(row.value as string)) };
    }
    const remote = kind === 'project' ? projectSyncIdentity(value) : undefined;
    if (kind === 'project') {
      value = { ...value };
      delete value.gitRemote;
    }
    return this.routingValue(kind, filterSyncValue(kind, remote ? { ...value, gitRemote: remote } : value), false);
  }
  private routingValue(kind: string, value: SyncValue, incoming: boolean): SyncValue {
    if (!['settings', 'conversation'].includes(kind) || !this.hasConfig()) return value;
    const row = this.db.prepare("SELECT value FROM config WHERE key='apiSyncIds'").get();
    const ids = row ? (JSON.parse(row.value as string) as Record<string, string>) : {};
    const canonical = (id: string) => (this.exists() ? this.alias('api-provider', id) : id);
    const reverse = new Map(Object.entries(ids).map(([local, remote]) => [canonical(remote), local]));
    return mapApiRouting(kind, value, (id) =>
      incoming ? (reverse.get(canonical(id)) ?? id) : ids[id] ? canonical(ids[id]) : canonical(id),
    );
  }
  rebindApiRouting() {
    this.suppress(() => {
      if (this.hasConfig()) this.apply('settings', 'settings', { owner: '', value: this.settings(), deleted: false });
      const queueChanged = (kind: string, id: string) => {
        const current = this.current(kind, id);
        const base = this.base(kind, id);
        if (!current || base?.deleted || stableJson(current) === stableJson(this.basePayload(kind, id))) return;
        const pending = this.pendingOne(kind, id);
        if (
          pending &&
          pending.deleted === current.deleted &&
          pending.owner === current.owner &&
          stableJson(pending.value) === stableJson(current.value)
        )
          return;
        this.enqueue(kind, id, current);
      };
      queueChanged('settings', 'settings');
      for (const row of this.db
        .prepare("SELECT id,owner,value FROM workspace_records WHERE kind='conversation'")
        .all()) {
        const before = JSON.parse(row.value as string) as SyncValue;
        const value = this.routingValue('conversation', before, true);
        if (stableJson(before) !== stableJson(value))
          this.workspace.save('conversation', row.id as string, row.owner as string, value);
        if (before.routing || before.sideChat) queueChanged('conversation', row.id as string);
      }
    });
  }
  enqueue(kind: string, id: string, payload: SyncPayload) {
    this.db.exec('UPDATE sync_clock SET n=n+1');
    this.db
      .prepare(
        `INSERT INTO sync_outbox(kind,id,owner,value,deleted,generation,changed_at) VALUES(?,?,?,?,?,(SELECT n FROM sync_clock),?)
      ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,value=excluded.value,deleted=excluded.deleted,generation=excluded.generation,changed_at=excluded.changed_at`,
      )
      .run(
        kind,
        id,
        payload.owner,
        JSON.stringify(this.protect(kind, payload.value)),
        Number(payload.deleted),
        Date.now(),
      );
  }
  acknowledge(change: LocalChange) {
    this.db
      .prepare('DELETE FROM sync_outbox WHERE kind=? AND id=? AND generation=?')
      .run(change.kind, change.id, change.generation);
  }
  base(kind: string, id: string): SyncBase | undefined {
    const row = this.db.prepare('SELECT seq,payload,device_id FROM sync_base WHERE kind=? AND id=?').get(kind, id);
    return row
      ? { ...this.readPayload(kind, row.payload as string), seq: row.seq as number, deviceId: row.device_id as string }
      : undefined;
  }
  /** The cloud has no row for this base; the next push uploads the queued change as new. */
  dropBase(kind: string, id: string) {
    this.db.prepare('DELETE FROM sync_base WHERE kind=? AND id=?').run(kind, id);
  }
  private basePayload(kind: string, id: string): SyncPayload | undefined {
    const base = this.base(kind, id);
    if (!base) return;
    const { seq: _, deviceId: __, ...payload } = base;
    return payload;
  }
  setBase(kind: string, id: string, seq: number, payload: SyncPayload, deviceId: string) {
    const { observedSeq: _, ...body } = payload;
    this.db
      .prepare(
        'INSERT INTO sync_base(kind,id,seq,payload,device_id) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET seq=excluded.seq,payload=excluded.payload,device_id=excluded.device_id',
      )
      .run(kind, id, seq, this.writePayload(kind, body), deviceId);
  }
  suppress<T>(fn: () => T): T {
    this.db.exec('SAVEPOINT sync_apply');
    try {
      this.db.exec('UPDATE sync_state SET suppressed=suppressed+1');
      const result = fn();
      this.db.exec('UPDATE sync_state SET suppressed=suppressed-1; RELEASE sync_apply');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO sync_apply; RELEASE sync_apply');
      throw error;
    }
  }
  current(kind: string, id: string): SyncPayload | undefined {
    if (kind === 'settings') return { owner: '', value: this.filtered('settings', this.settings()), deleted: false };
    const row = this.db.prepare('SELECT owner,value FROM workspace_records WHERE kind=? AND id=?').get(kind, id);
    return row
      ? { owner: row.owner as string, value: this.filtered(kind, JSON.parse(row.value as string)), deleted: false }
      : undefined;
  }
  apply(kind: string, id: string, payload: SyncPayload) {
    if (kind === 'settings') {
      if (!this.hasConfig()) this.db.exec('CREATE TABLE config (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      const old = this.db.prepare("SELECT value FROM config WHERE key='settings'").get();
      const value = old ? (JSON.parse(old.value as string) as SyncValue) : {};
      for (const key of Object.keys(filterSyncValue('settings', value))) delete value[key];
      Object.assign(value, this.routingValue('settings', filterSyncValue('settings', payload.value), true));
      this.db
        .prepare(
          "INSERT INTO config(key,value) VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(value));
      this.migrate();
      return;
    }
    const old = this.workspace.get<SyncValue>(kind, id);
    if (payload.deleted) {
      const beforeDelete = this.current(kind, id);
      // A purge is a local recycle operation. Keep messages, attachments and provenance for recovery.
      if (kind === 'conversation' && old)
        this.workspace.save(kind, id, payload.owner, { ...old, deletedAt: old.deletedAt || new Date().toISOString() });
      else if (!['message', 'human-message'].includes(kind)) this.workspace.deleteRecord(kind, id);
      const retained = this.current(kind, id) ?? beforeDelete;
      if (retained)
        this.db
          .prepare(
            'INSERT INTO sync_retained VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload',
          )
          .run(kind, id, this.writePayload(kind, retained));
      return;
    }
    this.db.prepare('DELETE FROM sync_retained WHERE kind=? AND id=?').run(kind, id);
    if (kind === 'human-message') {
      if (!/^[a-f0-9]{64}$/.test(String(payload.value.messageHash))) throw Error('INVALID_PROVENANCE');
      this.db
        .prepare(
          'INSERT INTO sync_human_markers(id,owner,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,value=excluded.value',
        )
        .run(id, payload.owner, JSON.stringify(payload.value));
      this.reconcileHuman(id);
      return;
    }
    const value = filterSyncValue(kind, payload.value);
    if (kind === 'project') {
      for (const [key, v] of Object.entries(old ?? {}))
        if (!Object.hasOwn(filterSyncValue('project', { [key]: v }), key)) value[key] = v;
      if (!old) {
        value.path = '';
        value.trusted = false;
        value.folderMissing = true;
      }
    }
    if (kind === 'conversation' && old)
      for (const key of localConversationKeys) if (Object.hasOwn(old, key)) value[key] = old[key];
    if (kind === 'conversation' && old?.lane && value.lane) {
      const oldLane = old.lane as SyncValue,
        newLane = value.lane as SyncValue;
      for (const key of localLaneKeys) if (Object.hasOwn(oldLane, key)) newLane[key] = oldLane[key];
    }
    if (
      kind === 'message' &&
      old &&
      messageProvenanceHash(payload.owner, old) !== messageProvenanceHash(payload.owner, value)
    )
      this.workspace.deleteRecord('human-message', id);
    this.workspace.save(kind, id, payload.owner, this.protect(kind, this.routingValue(kind, value, true)));
    if (kind === 'message') this.reconcileHuman(id);
  }
  private reconcileHuman(id: string) {
    const marker = this.db.prepare('SELECT owner,value FROM sync_human_markers WHERE id=?').get(id);
    const message = this.workspace.get<SyncValue>('message', id);
    if (!marker || !message || message.role !== 'user') return;
    const value = JSON.parse(marker.value as string) as SyncValue;
    if (value.messageHash !== messageProvenanceHash(marker.owner as string, message)) return;
    const owner = this.db.prepare("SELECT owner FROM workspace_records WHERE kind='message' AND id=?").get(id)?.owner;
    if (owner === marker.owner) this.workspace.save('human-message', id, owner as string, value);
  }
  alias(kind: string, id: string): string {
    let current = id;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const row = this.db.prepare('SELECT target FROM sync_alias WHERE kind=? AND id=?').get(kind, current);
      if (!row) break;
      current = row.target as string;
    }
    return current;
  }
  setAlias(kind: string, id: string, target: string) {
    if (id === target) return;
    this.db
      .prepare(
        'INSERT INTO sync_alias(kind,id,target) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET target=excluded.target',
      )
      .run(kind, id, target);
  }
}
