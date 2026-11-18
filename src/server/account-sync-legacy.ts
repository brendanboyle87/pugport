import { filterSyncValue, syncKinds, type SyncPayload } from '../shared/account-sync.ts';
import { decryptRecord } from './account-sync-crypto.ts';
import type { PushChange, SyncRemote } from './account-sync-remote.ts';

/** Transition only: normal sync never reads ciphertext. */
export async function migrateLegacyCloud({
  remote,
  key,
  generation,
  deviceId,
  isCurrent,
}: {
  remote: SyncRemote;
  key: Buffer;
  generation: string;
  deviceId: string;
  isCurrent: () => boolean;
}) {
  const current = () => {
    if (!isCurrent()) throw Error('SIGNED_OUT');
  };
  const legacySeq = new Map<string, number>();
  let cursor = 0;
  const read = async () => {
    const changes = new Map<string, PushChange>();
    while (true) {
      current();
      const rows = await remote.legacyPull(cursor, 200);
      current();
      if (!Array.isArray(rows) || rows.length > 200) throw Error('UPGRADE_FAILED');
      for (const row of rows) {
        if (
          !row ||
          !Number.isSafeInteger(row.seq) ||
          row.seq <= cursor ||
          typeof row.id !== 'string' ||
          typeof row.device_id !== 'string' ||
          typeof row.deleted !== 'boolean' ||
          ![...syncKinds, 'settings'].includes(row.kind)
        )
          throw Error('UPGRADE_FAILED');
        cursor = row.seq;
        if (['remote-server', 'server-node', 'api-provider'].includes(row.kind)) continue;
        let payload: SyncPayload;
        try {
          payload = decryptRecord(key, row.kind, row.id, row.body);
        } catch {
          throw Error('UPGRADE_FAILED');
        }
        if (
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          typeof payload.owner !== 'string' ||
          typeof payload.deleted !== 'boolean' ||
          payload.deleted !== row.deleted ||
          !payload.value ||
          typeof payload.value !== 'object' ||
          Array.isArray(payload.value) ||
          (payload.observedSeq !== undefined &&
            (!Number.isSafeInteger(payload.observedSeq) || payload.observedSeq < 0)) ||
          (payload.value.id !== undefined && payload.value.id !== row.id) ||
          (row.kind === 'conversation' && payload.value.incognito) ||
          (row.kind === 'message' && payload.value.importedFrom)
        )
          throw Error('UPGRADE_FAILED');
        legacySeq.set(JSON.stringify([row.kind, row.id]), row.seq);
        changes.set(JSON.stringify([row.kind, row.id]), {
          kind: row.kind,
          id: row.id,
          device_id: row.device_id,
          deleted: row.deleted,
          body: { owner: payload.owner, deleted: payload.deleted, value: filterSyncValue(row.kind, payload.value) },
          last_seq: 0,
        });
      }
      if (rows.length < 200) return [...changes.values()];
    }
  };
  const push = async (changes: PushChange[]) => {
    for (let i = 0; i < changes.length; i += 100) {
      current();
      const batch = changes.slice(i, i + 100);
      const results = await remote.push(generation, batch);
      current();
      if (results.length !== batch.length) throw Error('UPGRADE_FAILED');
      const retry: PushChange[] = [];
      for (let j = 0; j < results.length; j++) {
        const result = results[j],
          change = batch[j];
        if (!result || result.kind !== change.kind || result.id !== change.id) throw Error('UPGRADE_FAILED');
        if (result.status === 'error') throw Error(result.code);
        if (result.status !== 'accepted' && result.status !== 'conflict') throw Error('UPGRADE_FAILED');
        // Both tables use the same sequence; only a newer legacy edit may replace a plain row.
        if (
          result.status === 'conflict' &&
          result.record &&
          result.record.seq < legacySeq.get(JSON.stringify([change.kind, change.id]))!
        ) {
          if (result.record.seq <= change.last_seq) throw Error('UPGRADE_FAILED');
          retry.push({ ...change, last_seq: result.record.seq });
        }
      }
      if (retry.length) await push(retry);
    }
  };
  // Validate the entire snapshot before writing any of it.
  await push(await read());
  current();
  if ((await remote.account()).generation !== generation) throw Error('CLOUD_DATA_RESET');
  current();
  await remote.finishLegacyMigration(deviceId);
  current();
  await push(await read());
}
