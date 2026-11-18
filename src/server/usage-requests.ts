import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { contextFromEvent } from '../shared/context-usage.ts';
import type { ContextCoverage, RequestObservation, RequestSource, RequestUsage } from '../shared/context-trace.ts';
import type { Provider, RunEvent, RunRecord } from '../shared/types.ts';
import type { UsageMeasures } from '../shared/usage.ts';
import { normalizeUsageMeasures } from './usage.ts';

/*
 * Per-request observation ledger. One row per model request (or occupancy update) that an executor
 * actually reported, keyed by (run, request id) so a replayed event updates its row instead of adding one.
 *
 * - Pi: every assistant message (usage, context occupancy, window, turn start and end).
 * - Claude Code: each root assistant message's input-side usage snapshot.
 * - Codex: each thread token update's `last` request usage and its occupancy.
 * - Cursor: context occupancy updates only (scope 'occupancy').
 * - Grok and others: nothing; the UI says "not reported".
 *
 * Writes are queued and flushed in one transaction; the run's other observations are never re-read.
 */

type Row = Record<string, unknown>;
type Parsed = Omit<RequestObservation, 'runId' | 'ordinal'>;
type RunState = { next: number; ordinals: Map<string, number> };

const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown, limit = 200): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
const isoTime = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;

const requestUsage = (values: UsageMeasures): RequestUsage => ({
  inputTokens: values.inputTokens,
  outputTokens: values.outputTokens,
  cacheReadTokens: values.cacheReadTokens,
  cacheWriteTokens: values.cacheWriteTokens,
  reasoningOutputTokens: values.reasoningOutputTokens,
  totalTokens: values.totalTokens,
  costUsd: values.estimatedCostUsd,
});

/** Reads one adapter event as a request observation, or nothing when the executor reported none. */
export function parseRequestObservation(provider: Provider, model: string, event: RunEvent): Parsed | undefined {
  const data = event.data ?? {};
  const observedAt = isoTime(event.at) ?? new Date().toISOString();
  const context = contextFromEvent(provider, model, event);
  if (provider === 'pi' && event.type === 'usage' && data.scope === 'assistant-message') {
    return {
      requestId: text(data.eventId) ?? `pi:${observedAt}`,
      startedAt: isoTime(data.requestStartedAt),
      endedAt: observedAt,
      observedAt,
      usage: requestUsage(normalizeUsageMeasures(data, 'pi')),
      contextTokens: context?.tokens ?? null,
      contextWindow: context?.window ?? null,
      scope: 'request',
      source: 'pi-assistant-message',
    };
  }
  if (provider === 'claude' && event.type === 'status' && data.messageUsage && context) {
    const usage = object(data.messageUsage);
    return {
      requestId: text(data.messageId) ?? `claude:${observedAt}:${context.tokens}`,
      startedAt: null,
      endedAt: null,
      observedAt,
      // Claude's message snapshot is input-side only; output is reported once per turn elsewhere.
      usage: {
        inputTokens: count(usage.input_tokens),
        outputTokens: null,
        cacheReadTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens),
        reasoningOutputTokens: null,
        totalTokens: null,
        costUsd: null,
      },
      contextTokens: context.tokens,
      contextWindow: context.window ?? null,
      scope: 'request',
      source: 'claude-message-usage',
    };
  }
  if (provider === 'codex' && event.type === 'usage' && data.baseline !== true) {
    const last = object(data.last);
    if (!Object.keys(last).length) return;
    return {
      requestId: text(data.eventId) ?? `codex:${observedAt}`,
      startedAt: null,
      endedAt: observedAt,
      observedAt,
      usage: requestUsage(normalizeUsageMeasures(last, 'codex')),
      contextTokens: context?.tokens ?? null,
      contextWindow: context?.window ?? null,
      scope: 'request',
      source: 'codex-last-token-usage',
    };
  }
  if (provider === 'cursor' && event.type === 'status' && context)
    return {
      requestId: `cursor:${observedAt}:${context.tokens}`,
      startedAt: null,
      endedAt: null,
      observedAt,
      usage: null,
      contextTokens: context.tokens,
      contextWindow: context.window ?? null,
      scope: 'occupancy',
      source: 'cursor-context-update',
    };
  return undefined;
}

/** Marker source for a stored run rebuilt only up to a read limit; a later read continues it. */
export const partialHistory = 'retained-events-partial';

export type RequestSummary = {
  count: number;
  coverage: ContextCoverage;
  sources: RequestSource[];
  last?: { contextTokens: number; contextWindow: number | null; at: string; source: RequestSource };
};

export class RequestLedger {
  private readonly pending = new Map<string, RequestObservation>();
  private readonly runs = new Map<string, RunState>();
  private readonly marked = new Set<string>();
  private liveMarks: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly upsert: StatementSync;
  private readonly mark: StatementSync;
  private readonly markBackfill: StatementSync;
  private readonly findOrdinal: StatementSync;
  constructor(
    readonly db: DatabaseSync,
    private readonly options: { flushDelayMs?: number; batchSize?: number } = {},
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_requests (run_id TEXT NOT NULL, request_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL, started_at TEXT, ended_at TEXT, observed_at TEXT NOT NULL, context_tokens INTEGER,
        scope TEXT NOT NULL, source TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,request_key));
      CREATE INDEX IF NOT EXISTS usage_requests_order ON usage_requests(run_id,ordinal);
      CREATE TABLE IF NOT EXISTS usage_request_runs (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    // Idempotent: a replayed request keeps its first ordinal and start, and takes the newest figures.
    this.upsert = db.prepare(`INSERT INTO usage_requests(run_id,request_key,ordinal,started_at,ended_at,observed_at,
        context_tokens,scope,source,value) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,request_key) DO UPDATE SET started_at=COALESCE(usage_requests.started_at,excluded.started_at),
        ended_at=COALESCE(excluded.ended_at,usage_requests.ended_at),observed_at=excluded.observed_at,
        context_tokens=COALESCE(excluded.context_tokens,usage_requests.context_tokens),value=excluded.value`);
    this.findOrdinal = db.prepare('SELECT ordinal FROM usage_requests WHERE run_id=? AND request_key=?');
    this.mark = db.prepare(
      'INSERT INTO usage_request_runs(run_id,source,updated_at) VALUES(?,?,?) ON CONFLICT(run_id) DO NOTHING',
    );
    // A backfill may only advance a partial rebuild; a live or complete marker is never replaced.
    this.markBackfill = db.prepare(`INSERT INTO usage_request_runs(run_id,source,updated_at) VALUES(?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET source=excluded.source,updated_at=excluded.updated_at
      WHERE usage_request_runs.source='${partialHistory}'`);
  }

  private state(runId: string): RunState {
    let state = this.runs.get(runId);
    if (!state) {
      // Queued rows of an evicted run must be on disk before MAX(ordinal) is read again.
      if (this.pending.size) this.flush();
      const row = this.db
        .prepare('SELECT COALESCE(MAX(ordinal),0) AS last FROM usage_requests WHERE run_id=?')
        .get(runId) as { last: number };
      state = { next: row.last + 1, ordinals: new Map() };
      // Only recently active runs keep their in-memory ordinals; others re-read MAX(ordinal) once.
      if (this.runs.size >= 128) this.runs.delete(this.runs.keys().next().value!);
      this.runs.set(runId, state);
    }
    return state;
  }

  private queue(runId: string, parsed: Parsed): RequestObservation {
    const state = this.state(runId);
    let ordinal = state.ordinals.get(parsed.requestId);
    if (ordinal === undefined) {
      // A request replayed after a restart keeps its stored ordinal and does not open a gap.
      const stored = this.findOrdinal.get(runId, parsed.requestId) as { ordinal: number } | undefined;
      ordinal = stored?.ordinal ?? state.next++;
      if (state.ordinals.size < 20_000) state.ordinals.set(parsed.requestId, ordinal);
    }
    const key = `${runId}\u0000${parsed.requestId}`;
    const previous = this.pending.get(key);
    const observation: RequestObservation = {
      ...parsed,
      runId,
      ordinal: previous?.ordinal ?? ordinal,
      startedAt: previous?.startedAt ?? parsed.startedAt,
    };
    this.pending.set(key, observation);
    return observation;
  }

  /** Called for every live adapter event; ignores events that carry no request evidence. */
  observe(run: Pick<RunRecord, 'id' | 'route'>, provider: Provider, event: RunEvent): RequestObservation | undefined {
    // A diagnostic index must never break the run that feeds it.
    try {
      const parsed = parseRequestObservation(provider, run.route.model, event);
      if (!parsed) return undefined;
      if (!this.marked.has(run.id)) {
        this.marked.add(run.id);
        if (this.marked.size > 4096) this.marked.clear();
        this.liveMarks.push(run.id);
      }
      const observation = this.queue(run.id, parsed);
      if (this.pending.size >= (this.options.batchSize ?? 64)) this.safeFlush();
      else this.timer ??= setTimeout(() => this.safeFlush(), this.options.flushDelayMs ?? 500);
      this.timer?.unref?.();
      return observation;
    } catch (error) {
      console.warn(`Request ledger skipped an event: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Timer flushes must never take down the process: a failed batch is reported and dropped. */
  private safeFlush() {
    try {
      this.flush();
    } catch (error) {
      console.warn(`Request ledger flush failed: ${(error as Error).message}`);
    }
  }

  /** Writes queued observations in one transaction. Safe to call at any time; reads call it first. */
  flush(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rows = [...this.pending.values()];
    const marks = this.liveMarks;
    if (!rows.length && !marks.length) return 0;
    this.pending.clear();
    this.liveMarks = [];
    const now = new Date().toISOString();
    this.db.exec('SAVEPOINT usage_requests_flush');
    try {
      for (const runId of marks) this.mark.run(runId, 'live', now);
      for (const row of rows)
        this.upsert.run(
          row.runId,
          row.requestId,
          row.ordinal,
          row.startedAt,
          row.endedAt,
          row.observedAt,
          row.contextTokens,
          row.scope,
          row.source,
          JSON.stringify({ usage: row.usage, contextWindow: row.contextWindow }),
        );
      this.db.exec('RELEASE usage_requests_flush');
    } catch (error) {
      this.db.exec('ROLLBACK TO usage_requests_flush; RELEASE usage_requests_flush');
      throw error;
    }
    return rows.length;
  }

  /** 'live' when observed as it ran, 'retained-events' when rebuilt once from a stored record. */
  indexed(runId: string): string | undefined {
    this.flush();
    return (
      this.db.prepare('SELECT source FROM usage_request_runs WHERE run_id=?').get(runId) as
        { source: string } | undefined
    )?.source;
  }

  /**
   * Rebuild from events a stored run still has. Claude message snapshots were never retained. With
   * partial=true the events are one chunk of a longer history: the run stays marked partial and a later call
   * continues with the next chunk.
   */
  backfill(
    runId: string,
    provider: Provider | undefined,
    model: string,
    events: readonly RunEvent[],
    options: { partial?: boolean } = {},
  ): number {
    this.flush();
    const current = this.indexed(runId);
    if (current && current !== partialHistory) return 0;
    let added = 0;
    if (provider)
      for (const event of events) {
        const parsed = parseRequestObservation(provider, model, event);
        if (parsed) {
          this.queue(runId, parsed);
          added++;
        }
      }
    this.db.exec('SAVEPOINT usage_requests_backfill');
    try {
      this.markBackfill.run(runId, options.partial ? partialHistory : 'retained-events', new Date().toISOString());
      this.flush();
      this.db.exec('RELEASE usage_requests_backfill');
    } catch (error) {
      this.db.exec('ROLLBACK TO usage_requests_backfill; RELEASE usage_requests_backfill');
      throw error;
    }
    return added;
  }

  summary(runId: string): RequestSummary {
    this.flush();
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS count, SUM(scope='request') AS requests, GROUP_CONCAT(DISTINCT source) AS sources
         FROM usage_requests WHERE run_id=?`,
      )
      .get(runId) as { count: number; requests: number | null; sources: string | null };
    const last = this.db
      .prepare(
        `SELECT context_tokens,observed_at,source,value FROM usage_requests
         WHERE run_id=? AND context_tokens IS NOT NULL ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(runId) as { context_tokens: number; observed_at: string; source: RequestSource; value: string } | undefined;
    return {
      count: totals.count,
      coverage: totals.requests ? 'per-request' : totals.count ? 'snapshot' : 'not-reported',
      sources: (totals.sources?.split(',') ?? []) as RequestSource[],
      ...(last
        ? {
            last: {
              contextTokens: last.context_tokens,
              contextWindow: (JSON.parse(last.value) as { contextWindow: number | null }).contextWindow ?? null,
              at: last.observed_at,
              source: last.source,
            },
          }
        : {}),
    };
  }

  page(runId: string, offset = 0, limit = 200): { total: number; items: RequestObservation[] } {
    this.flush();
    const total = (
      this.db.prepare('SELECT COUNT(*) AS count FROM usage_requests WHERE run_id=?').get(runId) as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT request_key,ordinal,started_at,ended_at,observed_at,context_tokens,scope,source,value
         FROM usage_requests WHERE run_id=? ORDER BY ordinal LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as {
      request_key: string;
      ordinal: number;
      started_at: string | null;
      ended_at: string | null;
      observed_at: string;
      context_tokens: number | null;
      scope: RequestObservation['scope'];
      source: RequestSource;
      value: string;
    }[];
    return {
      total,
      items: rows.map((row) => {
        const value = JSON.parse(row.value) as { usage: RequestUsage | null; contextWindow: number | null };
        return {
          runId,
          requestId: row.request_key,
          ordinal: row.ordinal,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          observedAt: row.observed_at,
          usage: value.usage,
          contextTokens: row.context_tokens,
          contextWindow: value.contextWindow ?? null,
          scope: row.scope,
          source: row.source,
        };
      }),
    };
  }
}
