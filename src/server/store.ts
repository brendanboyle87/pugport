import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runOutputTail } from '../shared/run-output.ts';
import type { RunEvent, RunRecord, RuntimeTarget, Settings } from '../shared/types.ts';
import type { ResponseLatencySample } from './response-latency.ts';

/** Broadcast summaries keep only this many trailing characters of a finished run's output. */
export const runSummaryOutputChars = 1000;
const recentRunLimit = 200;
export const presentationBudget = { events: 10_000, bytes: 8 * 1024 * 1024, eventBytes: 1024 * 1024, runs: 32 };
const latencyFields = [
  'runId',
  'runtimeId',
  'key',
  'model',
  'effort',
  'sessionMode',
  'firstTextMs',
  'observedAt',
] as const;
export function summarizeRun(run: RunRecord): RunRecord {
  return {
    ...run,
    summary: true,
    events: [],
    output: runOutputTail(run.output, runSummaryOutputChars),
    reasoning: undefined,
  };
}
function newest(runs: Map<string, RunRecord>): RunRecord[] {
  return [...runs.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .slice(0, recentRunLimit);
}

export class Store {
  db: DatabaseSync;
  private summaries?: Map<string, RunRecord>;
  private auditInsert?: StatementSync;
  private latencySamples?: ResponseLatencySample[];
  private latencyWindow?: Map<string, { startedAt: string; signature: string }>;
  private runRevision = 0;
  private readonly runRevisions = new Map<string, number>();
  private readonly presentationSizes = new Map<
    string,
    { revision: number; value: { bytes: number; events: number; maxEventBytes: number } }
  >();
  /** Changes whenever this process saves the run, so callers can cache what they derive from it. */
  runRevisionOf(id: string) {
    return this.runRevisions.get(id) ?? 0;
  }
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'studio.sqlite'));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at); CREATE INDEX IF NOT EXISTS runs_status ON runs(json_extract(value,'$.status')); CREATE INDEX IF NOT EXISTS runs_workflow ON runs(json_extract(value,'$.workflowId'));",
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS run_audit_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,seq));',
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS run_summaries (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_summaries_started ON run_summaries(started_at);
      DROP TRIGGER IF EXISTS runs_summary_insert;
      DROP TRIGGER IF EXISTS runs_summary_update;
      CREATE TRIGGER IF NOT EXISTS runs_summary_delete AFTER DELETE ON runs BEGIN
        DELETE FROM run_summaries WHERE id=OLD.id; END;
      INSERT INTO run_summaries SELECT id,started_at,
        json_remove(json_set(value, '$.events', json('[]'),
          '$.output', substr(json_extract(value, '$.output'), -${runSummaryOutputChars}),
          '$.summary', json('true')), '$.reasoning') FROM runs
        WHERE id NOT IN (SELECT id FROM run_summaries);`);
    const unfinished = this.db
      .prepare(
        "SELECT value FROM runs WHERE json_extract(value, '$.status') IN ('running', 'queued', 'waiting-approval')",
      )
      .all() as { value: string }[];
    for (const row of unfinished) {
      const run = JSON.parse(row.value) as RunRecord;
      if (['running', 'queued', 'waiting-approval'].includes(run.status)) {
        run.status = 'interrupted';
        run.endedAt = new Date().toISOString();
        run.error = '应用重启；此任务未自动重放。可以恢复原生会话。';
        this.saveRun(run);
      }
    }
  }
  /** Synchronous commit-before-action writes must survive power loss, not just process exit. */
  durable<T>(fn: () => T): T {
    this.db.exec('PRAGMA synchronous=FULL');
    try {
      return fn();
    } finally {
      this.db.exec('PRAGMA synchronous=NORMAL');
    }
  }
  config<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  setConfig(key: string, value: Settings | RuntimeTarget[] | Record<string, unknown>) {
    this.db
      .prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  saveRun(run: RunRecord) {
    const summary = summarizeRun(run);
    // A savepoint keeps both rows atomic even inside a caller's transaction.
    const inTransaction = this.db.isTransaction;
    this.db.exec('SAVEPOINT save_run');
    try {
      for (const [table, value] of [
        ['runs', run],
        ['run_summaries', summary],
      ] as const)
        this.db
          .prepare(
            `INSERT INTO ${table}(id,started_at,value) VALUES(?,?,?)
          ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, value=excluded.value`,
          )
          .run(run.id, run.startedAt, JSON.stringify(value));
      this.db.exec('RELEASE save_run');
    } catch (error) {
      this.db.exec('ROLLBACK TO save_run; RELEASE save_run');
      throw error;
    }
    this.runRevisions.set(run.id, ++this.runRevision);
    if (this.latencyWindow) {
      const prior = this.latencyWindow.get(run.id);
      const signature = JSON.stringify([
        run.status,
        !!run.hadToolActivity,
        !!(run.steeringProgress || run.steeringInputs?.length),
        run.route.runtimeId,
        ...latencyFields.map((field) => run.responseLatency?.[field] ?? null),
      ]);
      const oldest = [...this.latencyWindow.values()].at(-1)?.startedAt;
      if (
        prior
          ? prior.startedAt !== run.startedAt || prior.signature !== signature
          : this.latencyWindow.size < recentRunLimit || !oldest || run.startedAt >= oldest
      )
        this.latencySamples = undefined;
    }
    if (inTransaction) {
      this.summaries = undefined;
      return;
    }
    if (this.summaries) {
      this.summaries.set(run.id, summary);
      if (this.summaries.size > 2 * recentRunLimit)
        this.summaries = new Map(newest(this.summaries).map((r) => [r.id, r]));
    }
  }
  /**
   * Newest runs without events and with only the tail of their output, for state broadcasts.
   * The save transaction maintains durable trimmed rows; saveRun() updates the in-memory page too.
   * Even the first broadcast never reads or parses full multi-MB run records.
   */
  runSummaries(): RunRecord[] {
    if (this.db.isTransaction) {
      this.summaries = undefined;
      return this.readSummaries();
    }
    if (!this.summaries) {
      this.summaries = new Map(this.readSummaries().map((r) => [r.id, r]));
    }
    return newest(this.summaries);
  }
  forgetRunSummaries() {
    this.summaries = undefined;
    this.latencySamples = undefined;
    this.latencyWindow = undefined;
  }
  runSummaryPage(offset = 0, limit = 100) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid run history page');
    const rows = this.db
      .prepare('SELECT value FROM run_summaries ORDER BY started_at DESC,id LIMIT ? OFFSET ?')
      .all(limit + 1, offset) as { value: string }[];
    return {
      runs: rows.slice(0, limit).map((row) => JSON.parse(row.value) as RunRecord),
      ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
    };
  }
  /** Only bounded scalar observations enter routing, never prompts, output or event archives. */
  responseLatencySamples(): ResponseLatencySample[] {
    if (this.db.isTransaction) this.latencySamples = undefined;
    if (this.latencySamples) return this.latencySamples;
    const rows = this.db
      .prepare(
        `
      WITH recent AS MATERIALIZED (
        SELECT id,started_at,value FROM run_summaries ORDER BY started_at DESC LIMIT ?
      )
      SELECT id AS runId, json_extract(value,'$.route.runtimeId') AS runtimeId,
        started_at AS startedAt, json_extract(value,'$.status') AS status,
        json_extract(value,'$.hadToolActivity') AS hadToolActivity,
        (COALESCE(json_array_length(value,'$.steeringInputs'),0)>0 OR json_extract(value,'$.steeringProgress') IS NOT NULL) AS steered,
        json_extract(value,'$.responseLatency.runId') AS sampleRunId,
        json_extract(value,'$.responseLatency.runtimeId') AS sampleRuntimeId,
        json_extract(value,'$.responseLatency.key') AS key,
        json_extract(value,'$.responseLatency.model') AS model,
        json_extract(value,'$.responseLatency.effort') AS effort,
        json_extract(value,'$.responseLatency.sessionMode') AS sessionMode,
        json_extract(value,'$.responseLatency.firstTextMs') AS firstTextMs,
        json_extract(value,'$.responseLatency.observedAt') AS observedAt
      FROM recent
    `,
      )
      .all(recentRunLimit) as Array<Record<string, unknown>>;
    const samples = rows.flatMap((row): ResponseLatencySample[] => {
      if (
        row.status !== 'completed' ||
        row.hadToolActivity ||
        row.steered ||
        row.sampleRunId !== row.runId ||
        row.sampleRuntimeId !== row.runtimeId ||
        typeof row.runId !== 'string' ||
        typeof row.runtimeId !== 'string' ||
        typeof row.key !== 'string' ||
        !row.key ||
        typeof row.model !== 'string' ||
        !row.model ||
        (row.effort !== null && typeof row.effort !== 'string') ||
        (row.sessionMode !== 'new' && row.sessionMode !== 'resume') ||
        typeof row.firstTextMs !== 'number' ||
        !Number.isFinite(row.firstTextMs) ||
        row.firstTextMs <= 0 ||
        typeof row.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(row.observedAt))
      )
        return [];
      return [
        {
          runId: row.runId,
          runtimeId: row.runtimeId,
          key: row.key,
          model: row.model,
          ...(row.effort === null ? {} : { effort: row.effort }),
          sessionMode: row.sessionMode,
          firstTextMs: row.firstTextMs,
          observedAt: row.observedAt,
        },
      ];
    });
    if (!this.db.isTransaction) {
      this.latencySamples = samples;
      this.latencyWindow = new Map(
        rows.map((row) => [
          row.runId as string,
          {
            startedAt: row.startedAt as string,
            signature: JSON.stringify([
              row.status,
              !!row.hadToolActivity,
              !!row.steered,
              row.runtimeId,
              ...latencyFields.map((field) =>
                field === 'runId' ? row.sampleRunId : field === 'runtimeId' ? row.sampleRuntimeId : row[field],
              ),
            ]),
          },
        ]),
      );
    }
    return samples;
  }
  private readSummaries(): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT value FROM run_summaries
        ORDER BY started_at DESC LIMIT ?`,
      )
      .all(recentRunLimit) as {
      value: string;
    }[];
    return rows.map((row) => JSON.parse(row.value) as RunRecord);
  }
  appendRunAuditEvent(runId: string, event: RunEvent) {
    // Preserve public model turns as well as tool/status observations. The bounded live
    // window must never decide what remains available for later diagnosis.
    if (event.type === 'reasoning' || event.seq === undefined) return;
    this.auditInsert ??= this.db.prepare('INSERT OR IGNORE INTO run_audit_events(run_id,seq,value) VALUES(?,?,?)');
    const inserted = this.auditInsert.run(runId, event.seq, JSON.stringify(event));
    if (inserted.changes) this.runRevisions.set(runId, ++this.runRevision);
  }
  storedRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT value FROM runs WHERE id=?').get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RunRecord) : undefined;
  }
  /** Inspect bounded SQL metadata before loading or parsing any full audit into the UI process. */
  presentationSize(id: string) {
    const revision = this.runRevisionOf(id);
    const previous = this.presentationSizes.get(id);
    if (previous?.revision === revision) return previous.value;
    const value = this.readPresentationSize(id);
    if (this.presentationSizes.size >= 256) this.presentationSizes.delete(this.presentationSizes.keys().next().value!);
    this.presentationSizes.set(id, { revision, value });
    return value;
  }
  private readPresentationSize(id: string) {
    const run = this.db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM runs WHERE id=?').get(id) as
      { bytes: number } | undefined;
    if ((run?.bytes ?? 0) > presentationBudget.bytes) return { bytes: run!.bytes, events: 0, maxEventBytes: 0 };
    const archived = this.db
      .prepare(
        `SELECT count(*) AS events, coalesce(sum(bytes),0) AS bytes,
      coalesce(max(bytes),0) AS maxEventBytes FROM (
        SELECT length(CAST(value AS BLOB)) AS bytes FROM run_audit_events WHERE run_id=? LIMIT ?
      )`,
      )
      .get(id, presentationBudget.events + 1) as { events: number; bytes: number; maxEventBytes: number };
    if (
      archived.events > presentationBudget.events ||
      archived.bytes > presentationBudget.bytes ||
      archived.maxEventBytes > presentationBudget.eventBytes
    )
      return archived;
    const retained = this.db
      .prepare(
        `SELECT count(*) AS events, coalesce(max(bytes),0) AS maxEventBytes FROM (
      SELECT length(CAST(value AS BLOB)) AS bytes FROM json_each((SELECT value FROM runs WHERE id=?),'$.events') LIMIT ?
    )`,
      )
      .get(id, presentationBudget.events + 1) as { events: number; maxEventBytes: number };
    // Count duplicate retained observations conservatively; a size check must never expand the budget.
    return {
      bytes: archived.bytes + (run?.bytes ?? 0),
      events: archived.events + retained.events,
      maxEventBytes: Math.max(archived.maxEventBytes, retained.maxEventBytes),
    };
  }
  /** Compact display reads omit ordinary file-tool bodies before JSON enters the JS heap. */
  presentationRun(id: string): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT json_set(value,'$.events',json('[]')) AS value FROM runs WHERE id=?")
      .get(id) as { value: string } | undefined;
    if (!row) return undefined;
    const run = JSON.parse(row.value) as RunRecord;
    // Unknown tools and any background/session evidence keep their results. Detail reads
    // always use the unchanged durable record, including the bodies omitted here.
    const background = this.db
      .prepare(
        `SELECT 1 FROM (
      SELECT value FROM json_each((SELECT value FROM runs WHERE id=?),'$.events')
      UNION ALL SELECT value FROM run_audit_events WHERE run_id=?
    ) WHERE json_extract(value,'$.type')='tool' AND (
      value LIKE '%session ID%' OR value LIKE '%session_id%' OR value LIKE '%task_id%'
      OR value LIKE '%backgroundTaskId%' OR value LIKE '%run_in_background%' OR value LIKE '%backgroundedByUser%') LIMIT 1`,
      )
      .get(id, id);
    const compact = background
      ? 'value'
      : `CASE WHEN json_extract(value,'$.type')='tool'
      AND lower(json_extract(value,'$.data.tool')) IN ('read','read_file','grep','glob','write','edit')
      THEN json_remove(value,'$.data.output','$.data.result') ELSE value END`;
    const archived = this.db
      .prepare(`SELECT ${compact} AS value FROM run_audit_events WHERE run_id=? ORDER BY seq`)
      .all(id) as { value: string }[];
    const retained = this.db
      .prepare(`SELECT ${compact} AS value FROM json_each((SELECT value FROM runs WHERE id=?),'$.events')`)
      .all(id) as { value: string }[];
    const events = new Map<number, RunEvent>();
    const legacy: RunEvent[] = [];
    for (const item of [...archived, ...retained]) {
      const event = JSON.parse(item.value) as RunEvent;
      if (event.seq === undefined) legacy.push(event);
      else events.set(event.seq, event);
    }
    return { ...run, events: [...legacy, ...[...events.values()].sort((a, b) => a.seq! - b.seq!)] };
  }
  /** The stored summary: no events and only the output tail, cheap enough to read for every listed task. */
  storedRunSummary(id: string, presentation = false): RunRecord | undefined {
    const row = this.db
      .prepare(
        presentation
          ? `SELECT json_object(
      'id',id,'prompt','','projectPath','','kind',json_extract(value,'$.kind'),
      'status',json_extract(value,'$.status'),'startedAt',json_extract(value,'$.startedAt'),
      'visualAssistant',json(CASE WHEN json_extract(value,'$.visualAssistant') THEN 'true' ELSE 'false' END),
      'endedAt',json_extract(value,'$.endedAt'),'events',json('[]'),
      'output',substr(json_extract(value,'$.output'),-${runSummaryOutputChars}),
      'route',json_object('runtimeId',substr(json_extract(value,'$.route.runtimeId'),1,128),
        'model',substr(json_extract(value,'$.route.model'),1,128),'reasons',json('[]'),'warnings',json('[]'))
      ) AS value FROM run_summaries WHERE id=?`
          : 'SELECT value FROM run_summaries WHERE id=?',
      )
      .get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RunRecord) : undefined;
  }
  /** Distillation needs recent event evidence, never the audit archive or large task text. */
  storedRunForDistillation(id: string, since = 0): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT json_remove(value,'$.prompt','$.output','$.reasoning','$.memoryExcerpt') AS value
        FROM runs WHERE id=? AND (?=0
          OR json_extract(value,'$.status') IN ('queued','running','waiting-approval')
          OR unixepoch(json_extract(value,'$.endedAt'),'subsec') IS NULL
          OR CAST(round(unixepoch(json_extract(value,'$.endedAt'),'subsec') * 1000) AS INTEGER)>?)`,
      )
      .get(id, since, since) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RunRecord) : undefined;
  }
  run(id: string): RunRecord | undefined {
    const run = this.storedRun(id);
    return run && this.withAudit(run);
  }
  withAudit(run: RunRecord): RunRecord {
    const archived = this.db.prepare('SELECT value FROM run_audit_events WHERE run_id=? ORDER BY seq').all(run.id) as {
      value: string;
    }[];
    if (archived.length) {
      const events = new Map<number, RunEvent>();
      for (const item of archived) {
        const event = JSON.parse(item.value) as RunEvent;
        events.set(event.seq!, event);
      }
      const legacy = run.events.filter((event) => event.seq === undefined);
      for (const event of run.events) if (event.seq !== undefined) events.set(event.seq, event);
      const ordered = [...legacy, ...[...events.values()].sort((a, b) => a.seq! - b.seq!)];
      let latest = 0;
      for (const sequence of events.keys()) latest = Math.max(latest, sequence);
      return {
        ...run,
        events: ordered,
        ...(run.auditVersion === 1 && !legacy.length ? { auditEventsMissing: latest - events.size } : {}),
      };
    }
    return run;
  }
  close() {
    this.db.close();
  }
}
