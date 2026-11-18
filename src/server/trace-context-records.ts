import type { DatabaseSync } from 'node:sqlite';
import type { UsageRun } from '../shared/usage.ts';

/*
 * Every Trace › Context table keyed by run id. Purging a conversation or project removes these rows with
 * the runs themselves, so command summaries and paths never outlive the record they came from.
 */
export const traceContextRunTables = [
  'usage_requests',
  'usage_request_runs',
  'tool_operations',
  'tool_operation_runs',
  'run_context_parts',
  'run_context_backfill',
] as const;

/** Deletes the run-keyed Trace › Context rows for these runs. Tables that were never created are skipped. */
export function deleteTraceContextRows(db: DatabaseSync, runIds: readonly string[]) {
  if (!runIds.length) return;
  const ids = JSON.stringify([...new Set(runIds)]);
  for (const table of traceContextRunTables)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT value FROM json_each(?))`).run(ids);
}

/** One run's normalized usage, read directly from the usage ledger's table; null metrics mean not reported. */
export function storedUsageRun(db: DatabaseSync, id: string): UsageRun | undefined {
  try {
    const row = db.prepare('SELECT value FROM usage_runs WHERE id=?').get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as UsageRun) : undefined;
  } catch {
    return undefined;
  }
}
