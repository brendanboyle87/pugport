// Synthetic Trace › Context rows for purge tests; written through the real indexes, no executor involved.
import type { DatabaseSync } from 'node:sqlite';
import { RequestLedger } from '../../src/server/usage-requests.ts';
import { ToolOperationIndex } from '../../src/server/tool-operations.ts';
import { TraceContext, type TraceContextDeps } from '../../src/server/trace-context.ts';
import { traceContextRunTables } from '../../src/server/trace-context-records.ts';
import type { RunRecord } from '../../src/shared/types.ts';

/** One row in every run-keyed Trace › Context table for each run. */
export function seedTraceContextRows(db: DatabaseSync, runIds: string[]) {
  const requests = new RequestLedger(db);
  const tools = new ToolOperationIndex(db);
  // The constructor only creates its tables.
  new TraceContext({ db } as TraceContextDeps);
  for (const runId of runIds) {
    const at = new Date(Date.UTC(2026, 10, 1)).toISOString();
    requests.observe({ id: runId, route: { model: 'synthetic' } as RunRecord['route'] }, 'pi', {
      type: 'usage',
      at,
      data: { scope: 'assistant-message', eventId: `pi-${runId}`, input: 10, cacheRead: 100, cacheWrite: 0 },
    });
    tools.observe(runId, {
      type: 'tool',
      at,
      data: { toolCallId: 'c1', tool: 'Bash', status: 'completed', input: { command: 'cat private-notes.md' } },
    });
    db.prepare('INSERT INTO run_context_parts(run_id,final,value) VALUES(?,1,?)').run(runId, '{}');
    db.prepare('INSERT INTO run_context_backfill(run_id,seq) VALUES(?,1)').run(runId);
  }
  requests.flush();
  tools.flush();
}

/** Rows per run-keyed Trace › Context table for one run. */
export function traceContextRowCounts(db: DatabaseSync, runId: string) {
  return Object.fromEntries(
    traceContextRunTables.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=?`).get(runId) as { n: number }).n,
    ]),
  );
}
