import type { Store } from '../../src/server/store.ts';
import type { RunRecord } from '../../src/shared/types.ts';

export function storedRuns(store: Store): RunRecord[] {
  const rows = store.db.prepare('SELECT value FROM runs ORDER BY started_at DESC LIMIT 200').all() as {
    value: string;
  }[];
  return rows.map((row) => JSON.parse(row.value) as RunRecord);
}
