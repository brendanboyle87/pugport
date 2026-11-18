import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  MOD_STORAGE_LIST_MAX,
  MOD_STORAGE_QUOTA_BYTES,
  modDataBackupSchema,
  modStorageCollectionSchema,
  modStorageKeySchema,
  type ModDataBackup,
  type ModStorageItem,
} from '../shared/mod-data.ts';

export class ModStorageError extends Error {
  readonly status: number;
  constructor(readonly code: 'E_INVALID' | 'E_LIMIT') {
    super(code === 'E_LIMIT' ? 'Request limit exceeded.' : 'Invalid request.');
    this.status = code === 'E_LIMIT' ? 429 : 400;
  }
}
type Row = { collection: string; key: string; value: string; updated_at: string };
const encodeCursor = (collection: string, key: string) =>
  Buffer.from(JSON.stringify([collection, key]), 'utf8').toString('base64url');
function decodeCursor(cursor: string, collection: string): string {
  try {
    const [owner, key] = z
      .tuple([z.string(), modStorageKeySchema])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (owner === collection) return key;
  } catch {
    /* Fall through. */
  }
  throw new ModStorageError('E_INVALID');
}
const bytes = (collection: string, key: string, value: string) =>
  Buffer.byteLength(collection) + Buffer.byteLength(key) + Buffer.byteLength(value);

/**
 * Data a Mod keeps for itself, namespaced by Mod ID and separate from chats: removing or deleting a chat never
 * touches it. Writes are upserts by key, so repeating one is harmless. Only the user deletes a whole namespace.
 */
export class ModStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly quotaBytes = MOD_STORAGE_QUOTA_BYTES,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS mod_items (
      mod_id TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      bytes INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (mod_id, collection, key)
    ) WITHOUT ROWID;`);
  }

  get(modId: string, collection: string, keys: readonly string[]): ModStorageItem[] {
    modStorageCollectionSchema.parse(collection);
    const select = this.db.prepare(
      'SELECT key,value,updated_at FROM mod_items WHERE mod_id=? AND collection=? AND key=?',
    );
    return keys.flatMap((key) => {
      const row = select.get(modId, collection, key) as Row | undefined;
      return row ? [{ key: row.key, value: row.value, updatedAt: row.updated_at }] : [];
    });
  }

  list(
    modId: string,
    input: { collection: string; prefix?: string; cursor?: string; limit?: number },
  ): { items: ModStorageItem[]; cursor?: string } {
    const after = input.cursor ? decodeCursor(input.cursor, input.collection) : '';
    const limit = Math.min(input.limit ?? 100, MOD_STORAGE_LIST_MAX);
    const prefix = input.prefix ?? '';
    // `prefix || char(0x10FFFF)` bounds the range, so the primary key serves both the prefix and the cursor.
    const rows = this.db
      .prepare(
        `SELECT key,value,updated_at FROM mod_items WHERE mod_id=? AND collection=? AND key>? AND key>=? AND key<?
        ORDER BY key LIMIT ?`,
      )
      .all(modId, input.collection, after, prefix, `${prefix}\u{10FFFF}`, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at })),
      ...(rows.length > limit ? { cursor: encodeCursor(input.collection, page.at(-1)!.key) } : {}),
    };
  }

  /** Upserts by key: the same write twice leaves one item. The whole batch fits the quota or nothing is written. */
  put(modId: string, collection: string, items: readonly { key: string; value: string }[], now = new Date()) {
    modStorageCollectionSchema.parse(collection);
    if (new Set(items.map((item) => item.key)).size !== items.length) throw new ModStorageError('E_INVALID');
    const at = now.toISOString();
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT bytes FROM mod_items WHERE mod_id=? AND collection=? AND key=?');
      let used = this.usage(modId).bytes;
      for (const item of items)
        used +=
          bytes(collection, item.key, item.value) -
          ((existing.get(modId, collection, item.key) as { bytes: number } | undefined)?.bytes ?? 0);
      if (used > this.quotaBytes) throw new ModStorageError('E_LIMIT');
      const upsert = this.db.prepare(
        `INSERT INTO mod_items (mod_id,collection,key,value,bytes,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(mod_id,collection,key) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,updated_at=excluded.updated_at
        WHERE mod_items.value<>excluded.value`,
      );
      for (const item of items)
        upsert.run(modId, collection, item.key, item.value, bytes(collection, item.key, item.value), at);
      return { written: items.length };
    });
  }

  delete(modId: string, collection: string, keys: readonly string[]) {
    modStorageCollectionSchema.parse(collection);
    const remove = this.db.prepare('DELETE FROM mod_items WHERE mod_id=? AND collection=? AND key=?');
    return this.transaction(() => ({
      deleted: keys.reduce((count, key) => count + Number(remove.run(modId, collection, key).changes), 0),
    }));
  }

  usage(modId: string) {
    const totals = this.db
      .prepare('SELECT COUNT(*) AS items, COALESCE(SUM(bytes),0) AS bytes FROM mod_items WHERE mod_id=?')
      .get(modId) as { items: number; bytes: number };
    const collections = this.db
      .prepare(
        'SELECT collection, COUNT(*) AS items FROM mod_items WHERE mod_id=? GROUP BY collection ORDER BY collection',
      )
      .all(modId) as { collection: string; items: number }[];
    return {
      items: Number(totals.items),
      bytes: Number(totals.bytes),
      quotaBytes: this.quotaBytes,
      collections: collections.map((row) => ({ name: row.collection, items: Number(row.items) })),
    };
  }

  /** Every Mod ID that has stored data, for the settings list. */
  owners(): { modId: string; items: number; bytes: number }[] {
    return (
      this.db
        .prepare('SELECT mod_id, COUNT(*) AS items, SUM(bytes) AS bytes FROM mod_items GROUP BY mod_id ORDER BY mod_id')
        .all() as { mod_id: string; items: number; bytes: number }[]
    ).map((row) => ({ modId: row.mod_id, items: Number(row.items), bytes: Number(row.bytes) }));
  }

  backup(modId: string, now = new Date()): ModDataBackup {
    const rows = this.db
      .prepare('SELECT collection,key,value,updated_at FROM mod_items WHERE mod_id=? ORDER BY collection,key')
      .all(modId) as Row[];
    return {
      format: 'pugport-mod-data',
      version: 1,
      modId,
      exportedAt: now.toISOString(),
      items: rows.map((row) => ({
        collection: row.collection,
        key: row.key,
        value: row.value,
        updatedAt: row.updated_at,
      })),
    };
  }

  /** Restoring replaces the namespace with the backup, all or nothing. The backup must belong to this Mod. */
  restore(modId: string, input: unknown) {
    const backup = modDataBackupSchema.safeParse(input);
    if (!backup.success || backup.data.modId !== modId) throw new ModStorageError('E_INVALID');
    const total = backup.data.items.reduce((sum, item) => sum + bytes(item.collection, item.key, item.value), 0);
    if (total > this.quotaBytes) throw new ModStorageError('E_LIMIT');
    return this.transaction(() => {
      this.db.prepare('DELETE FROM mod_items WHERE mod_id=?').run(modId);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO mod_items (mod_id,collection,key,value,bytes,updated_at) VALUES (?,?,?,?,?,?)',
      );
      for (const item of backup.data.items)
        insert.run(
          modId,
          item.collection,
          item.key,
          item.value,
          bytes(item.collection, item.key, item.value),
          item.updatedAt,
        );
      return { restored: backup.data.items.length };
    });
  }

  /** The user's explicit delete. `confirm` must repeat the Mod ID, so a stray call cannot wipe a ledger. */
  clear(modId: string, confirm: string) {
    if (confirm !== modId) throw new ModStorageError('E_INVALID');
    return { deleted: Number(this.db.prepare('DELETE FROM mod_items WHERE mod_id=?').run(modId).changes) };
  }

  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
