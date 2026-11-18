import { createHash } from 'node:crypto';
import { executionModel } from '../shared/execution-model.ts';
import { isApiHarness } from '../shared/provider-registry.ts';
import type { DatabaseSync } from 'node:sqlite';
import {
  usageMetricKeys,
  type AccountingMode,
  type UsageAggregate,
  type UsageFilters,
  type UsageMeasures,
  type UsageMetric,
  type UsageProvider,
  type UsageReport,
  type UsageRun,
} from '../shared/usage.ts';
import type { RunEvent, RunRecord, RuntimeTarget } from '../shared/types.ts';
import type { SpendAccountSnapshot } from '../shared/spend-ledger.ts';
import { accountKey } from './quota-history.ts';

type Row = Record<string, unknown>;
type UsageTarget = Pick<RuntimeTarget, 'id' | 'label' | 'accountingMode' | 'gateway' | 'apiProvider'> & {
  provider: UsageProvider;
};
type Packet = {
  normalizationVersion?: number;
  values: UsageMeasures;
  scope: 'delta' | 'run-cumulative' | 'session-cumulative';
  baseline: boolean;
  freshSession: boolean;
  sessionId?: string;
  source?: string;
  note?: string;
};
type Entry = UsageRun & {
  normalizationVersion?: number;
  baselines: UsageMeasures;
  baselineCandidates: UsageMeasures;
  sessionTotals: UsageMeasures;
  unresolved: UsageMetric[];
  observationVersion?: number;
  /** Spend: the account fixed when the run started. Server-only; never part of UsageRun or /api/state. */
  account?: SpendAccountSnapshot;
};
/** Only the run's own launch evidence: a later rebinding or deleted target never rewrites it. */
export function usageAccountSnapshot(
  run: Pick<RunRecord, 'account' | 'route' | 'apiProvider'>,
  entry: Pick<UsageRun, 'runtimeId' | 'runtimeLabel' | 'provider' | 'executionKind'>,
): SpendAccountSnapshot {
  // Keep in step with spendAccountKey() in spend-ledger.ts, which keys the live accounts the same way.
  const fingerprint = run.account?.fingerprint ?? run.route?.accountFingerprint;
  const label = (run.account?.label ?? entry.runtimeLabel ?? entry.runtimeId).slice(0, 120);
  const provider = run.account?.provider ?? entry.provider;
  if (fingerprint) return { key: `acct:${accountKey(fingerprint)}`, label, provider, source: 'login' };
  if (entry.executionKind === 'api' || run.apiProvider)
    return { key: `api:${entry.runtimeId}`, label, provider, source: 'api-card' };
  return { key: `unrecorded:${entry.runtimeId}`, label, provider, source: 'unrecorded' };
}
const blank = (): UsageMeasures => Object.fromEntries(usageMetricKeys.map((key) => [key, null])) as UsageMeasures;
const object = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const finite = (...values: unknown[]): number | null => {
  const value = values.find((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0);
  return typeof value === 'number' ? value : null;
};
function usageEventKey(event: RunEvent): string {
  const data = event.data ?? {};
  const identity =
    typeof data.eventId === 'string' ? data.eventId : typeof data.messageId === 'string' ? data.messageId : null;
  return createHash('sha256')
    .update(identity === null ? JSON.stringify({ at: event.at, data }) : identity)
    .digest('hex');
}
function measures(value: unknown): UsageMeasures {
  const data = object(value),
    usage = object(data.usage),
    nested = { ...usage, ...data };
  return {
    inputTokens: finite(nested.inputTokens, nested.input_tokens, nested.input, nested.prompt_tokens),
    outputTokens: finite(nested.outputTokens, nested.output_tokens, nested.output, nested.completion_tokens),
    cacheReadTokens: finite(
      nested.cacheReadTokens,
      nested.cachedInputTokens,
      nested.cache_read_input_tokens,
      nested.cacheRead,
      object(nested.prompt_tokens_details).cached_tokens,
    ),
    cacheWriteTokens: finite(nested.cacheWriteTokens, nested.cache_creation_input_tokens, nested.cacheWrite),
    reasoningOutputTokens: finite(
      nested.reasoningOutputTokens,
      nested.reasoningTokens,
      nested.reasoning_tokens,
      object(nested.completion_tokens_details).reasoning_tokens,
    ),
    totalTokens: finite(nested.totalTokens, nested.total_tokens),
    estimatedCostUsd: finite(nested.estimatedCostUsd, nested.costUsd, nested.total_cost_usd, object(nested.cost).total),
  };
}
/** Adapter packets retain raw evidence; the ledger alone applies canonical token semantics. */
export function normalizeUsageMeasures(data: Row, provider: UsageProvider): UsageMeasures {
  const result = measures(data);
  const nested = { ...object(data.usage), ...data };
  const inclusive = provider === 'codex' && data.inputTokenSemantics !== 'uncached';
  const rawAcp = provider === 'grok' && ('cachedReadTokens' in nested || 'cacheCreationTokens' in nested);
  if (rawAcp) {
    result.cacheReadTokens = finite(nested.cachedReadTokens);
    result.cacheWriteTokens = finite(nested.cacheCreationTokens);
  }
  if (inclusive || rawAcp) {
    result.inputTokens =
      result.inputTokens !== null && result.cacheReadTokens !== null && (!rawAcp || result.cacheWriteTokens !== null)
        ? Math.max(0, result.inputTokens - result.cacheReadTokens - (rawAcp ? result.cacheWriteTokens! : 0))
        : null;
  }
  return result;
}
function normalize(data: Row, provider: UsageProvider): Packet {
  const session = data.scope === 'session-cumulative' || Object.keys(object(data.total)).length > 0;
  const source = typeof data.source === 'string' ? data.source.slice(0, 200) : undefined;
  const note =
    typeof data.note === 'string'
      ? data.note.slice(0, 500)
      : typeof data.scopeDetail === 'string'
        ? data.scopeDetail.slice(0, 500)
        : undefined;
  return {
    normalizationVersion: 1,
    values: normalizeUsageMeasures(
      session && Object.keys(object(data.total)).length ? object(data.total) : data,
      provider,
    ),
    scope: session
      ? 'session-cumulative'
      : data.scope === 'run-cumulative' || data.cumulative === true
        ? 'run-cumulative'
        : 'delta',
    baseline: data.baseline === true,
    freshSession: data.freshSession === true,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
    source,
    note,
  };
}
function aggregate(rows: UsageRun[]): UsageAggregate {
  const result: UsageAggregate = {
    ...blank(),
    runs: rows.length,
    reportedRuns: 0,
    tokenReportedRuns: 0,
    costReportedRuns: 0,
    historyImportedRuns: 0,
    uncertainRuns: 0,
    accountingRuns: { subscription: 0, usage: 0, unknown: 0 },
    metricReportedRuns: Object.fromEntries(usageMetricKeys.map((key) => [key, 0])) as Record<UsageMetric, number>,
  };
  for (const row of rows) {
    result.accountingRuns[row.accountingMode]++;
    if (usageMetricKeys.some((key) => row[key] !== null)) result.reportedRuns++;
    if (usageMetricKeys.some((key) => key !== 'estimatedCostUsd' && row[key] !== null)) result.tokenReportedRuns++;
    if (row.estimatedCostUsd !== null) result.costReportedRuns++;
    if (row.historyImported) result.historyImportedRuns++;
    if (row.uncertain) result.uncertainRuns++;
    for (const key of usageMetricKeys)
      if (row[key] !== null) {
        result[key] = (result[key] ?? 0) + row[key]!;
        result.metricReportedRuns[key]++;
      }
  }
  return result;
}
const pathKey = (value: string) =>
  /^[a-z]:[\\/]/i.test(value)
    ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : value.replace(/\/+$/, '') || '/';

/** Independent of the UI's bounded runs/events arrays. Stores only normalized usage and task metadata. */
export class UsageLedger {
  private reportEntries?: Entry[];
  private defaultReport?: UsageReport;
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_runs_runtime_started ON usage_runs(json_extract(value,'$.runtimeId'),started_at);
      CREATE TABLE IF NOT EXISTS usage_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, event_key TEXT NOT NULL, packet TEXT NOT NULL, UNIQUE(run_id,event_key));
      CREATE INDEX IF NOT EXISTS usage_events_run ON usage_events(run_id,seq);
      CREATE TABLE IF NOT EXISTS usage_sessions (runtime_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(runtime_id,session_id));`);
    this.normalizeHistory();
  }
  /** Upgrade the durable packet archive as well as totals so a later event cannot restore old semantics. */
  private normalizeHistory(): void {
    const rows = this.db
      .prepare("SELECT value FROM usage_runs WHERE json_extract(value,'$.normalizationVersion') IS NOT 1")
      .all() as { value: string }[];
    if (!rows.length) return;
    this.db.exec('SAVEPOINT usage_normalize');
    try {
      const hasRuns = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
      const normalizedSessions = new Set<string>();
      for (const row of rows) {
        const entry = JSON.parse(row.value) as Entry;
        const normalizeStored = (value: UsageMeasures) =>
          entry.provider === 'codex' ? normalizeUsageMeasures(value, entry.provider) : value;
        for (const key of ['baselines', 'baselineCandidates', 'sessionTotals'] as const)
          entry[key] = normalizeStored(entry[key]);
        Object.assign(
          entry,
          normalizeStored(Object.fromEntries(usageMetricKeys.map((key) => [key, entry[key]])) as UsageMeasures),
        );
        const raw = hasRuns
          ? (this.db.prepare('SELECT value FROM runs WHERE id=?').get(entry.runId) as { value: string } | undefined)
          : undefined;
        const events = raw ? (JSON.parse(raw.value) as RunRecord).events : [];
        const originals = new Map(
          events.filter((event) => event.type === 'usage').map((event) => [usageEventKey(event), event]),
        );
        const packets = this.db
          .prepare('SELECT event_key,packet FROM usage_events WHERE run_id=? ORDER BY seq')
          .all(entry.runId) as { event_key: string; packet: string }[];
        let reasoning: number | null = null;
        let reasoningDelta: number | null = null;
        let observedReasoning = false;
        for (const saved of packets) {
          const packet = JSON.parse(saved.packet) as Packet;
          if (packet.normalizationVersion !== 1) {
            packet.values = normalizeStored(packet.values);
            const original = originals.get(saved.event_key);
            if (original)
              packet.values.reasoningOutputTokens = normalize(
                original.data ?? {},
                entry.provider,
              ).values.reasoningOutputTokens;
            packet.normalizationVersion = 1;
            this.db
              .prepare('UPDATE usage_events SET packet=? WHERE run_id=? AND event_key=?')
              .run(JSON.stringify(packet), entry.runId, saved.event_key);
          }
          const value = packet.values.reasoningOutputTokens;
          if (value === null) continue;
          observedReasoning = true;
          if (packet.baseline) entry.baselines.reasoningOutputTokens = value;
          else if (packet.scope === 'delta') reasoningDelta = (reasoningDelta ?? 0) + value;
          else if (packet.scope === 'run-cumulative') reasoning = value;
          else {
            const baseline = entry.baselines.reasoningOutputTokens ?? (packet.freshSession ? 0 : null);
            reasoning = baseline !== null && value >= baseline ? value - baseline : null;
          }
        }
        if (observedReasoning) entry.reasoningOutputTokens = reasoning ?? reasoningDelta;
        entry.normalizationVersion = 1;
        this.save(entry);
        if (entry.provider === 'codex' && !normalizedSessions.has(entry.runtimeId)) {
          const sessions = this.db
            .prepare('SELECT session_id,value FROM usage_sessions WHERE runtime_id=?')
            .all(entry.runtimeId) as { session_id: string; value: string }[];
          for (const session of sessions)
            this.db
              .prepare('UPDATE usage_sessions SET value=? WHERE runtime_id=? AND session_id=?')
              .run(
                JSON.stringify(normalizeStored(JSON.parse(session.value) as UsageMeasures)),
                entry.runtimeId,
                session.session_id,
              );
          normalizedSessions.add(entry.runtimeId);
        }
      }
      this.db.exec('RELEASE usage_normalize');
    } catch (error) {
      this.reportEntries = undefined;
      this.defaultReport = undefined;
      this.db.exec('ROLLBACK TO usage_normalize; RELEASE usage_normalize');
      throw error;
    }
  }
  private get(id: string): Entry | undefined {
    const row = this.db.prepare('SELECT value FROM usage_runs WHERE id=?').get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Entry) : undefined;
  }
  private save(entry: Entry) {
    this.db
      .prepare(
        'INSERT INTO usage_runs(id,started_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(entry.runId, entry.startedAt, JSON.stringify(entry));
    this.reportEntries = undefined;
    this.defaultReport = undefined;
  }
  begin(run: RunRecord, target: UsageTarget, accountingMode: AccountingMode = 'unknown'): void {
    const existing = this.get(run.id);
    const entry: Entry = existing ?? {
      ...blank(),
      normalizationVersion: 1,
      runId: run.id,
      projectPath: run.projectPath,
      runtimeId: target.id,
      runtimeLabel: target.label,
      provider: target.provider,
      model: executionModel(run).model,
      accountingMode,
      status: run.status,
      startedAt: run.startedAt,
      eventCount: 0,
      historyImported: false,
      uncertain: false,
      sources: [],
      notes: [],
      baselines: blank(),
      baselineCandidates: blank(),
      sessionTotals: blank(),
      unresolved: [],
    };
    const observedProvider =
      target.provider === 'unknown'
        ? ((existing?.provider !== 'unknown' ? existing?.provider : undefined) ?? run.account?.provider ?? 'unknown')
        : target.provider;
    entry.executionKind =
      run.executionKind ??
      existing?.executionKind ??
      (run.apiProvider
        ? 'api'
        : observedProvider === 'unknown'
          ? null
          : isApiHarness(observedProvider) || target.gateway === 'api'
            ? 'api'
            : 'cli');
    entry.apiProvider =
      run.apiProvider !== undefined
        ? run.apiProvider
        : existing?.apiProvider !== undefined
          ? existing.apiProvider
          : entry.executionKind === 'api'
            ? (target.apiProvider ?? null)
            : null;
    entry.model = executionModel(run).model;
    entry.effort = executionModel(run).effort ?? null;
    entry.errorCode = run.errorCode ?? null;
    entry.parentRunId = run.parentRunId ?? null;
    entry.relay = run.relay ? { ...run.relay } : null;
    entry.adapterStartedAt = run.adapterStartedAt ?? null;
    entry.firstTextAt = run.firstTextAt ?? null;
    entry.adapterEndedAt = run.adapterEndedAt ?? null;
    entry.observationVersion = 1;
    entry.status = run.status;
    entry.endedAt = run.endedAt;
    entry.nativeSessionId = run.nativeSessionId ?? entry.nativeSessionId;
    entry.workflowId = run.workflowId;
    // Do not replace an observed accounting classification during a later import with no snapshot.
    if (accountingMode !== 'unknown' || !existing) entry.accountingMode = accountingMode;
    // Fixed once: later begin() calls (every event, history imports with current targets) never rewrite it.
    entry.account ??= usageAccountSnapshot(run, entry);
    this.save(entry);
  }
  private accountCache?: { source: Entry[]; value: ReadonlyMap<string, SpendAccountSnapshot> };
  /** Spend's account per run, cached with the report rows. Kept out of UsageRun so /api/state does not grow. */
  accountsByRun(): ReadonlyMap<string, SpendAccountSnapshot> {
    this.report();
    const source = this.reportEntries!;
    if (this.accountCache?.source === source) return this.accountCache.value;
    const value = new Map<string, SpendAccountSnapshot>();
    for (const entry of source)
      value.set(
        entry.runId,
        entry.account ?? {
          key: `unrecorded:${entry.runtimeId}`,
          label: entry.runtimeLabel,
          provider: entry.provider,
          source: 'unrecorded',
        },
      );
    this.accountCache = { source, value };
    return value;
  }
  record(run: RunRecord, target: UsageTarget, event: RunEvent, accountingMode: AccountingMode = 'unknown'): void {
    if (event.type !== 'usage' && event.type !== 'session') return;
    this.begin(run, target, accountingMode);
    if (event.type !== 'usage') return;
    const data = event.data ?? {},
      packet = normalize(data, target.provider);
    if (!usageMetricKeys.some((key) => packet.values[key] !== null)) return;
    const key = usageEventKey(event);
    this.db.exec('SAVEPOINT usage_record');
    try {
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO usage_events(run_id,event_key,packet) VALUES(?,?,?)')
        .run(run.id, key, JSON.stringify(packet));
      const entry = this.get(run.id)!;
      // A missing ledger row can be rebuilt from its surviving normalized event archive.
      if (!inserted.changes && entry.eventCount > 0) {
        this.db.exec('RELEASE usage_record');
        return;
      }
      const sessionId = packet.sessionId ?? entry.nativeSessionId;
      if (sessionId) entry.nativeSessionId = sessionId;
      let prior: UsageMeasures = blank();
      if (sessionId) {
        const row = this.db
          .prepare('SELECT run_id,value FROM usage_sessions WHERE runtime_id=? AND session_id=?')
          .get(target.id, sessionId) as { run_id: string; value: string } | undefined;
        if (row) {
          prior = JSON.parse(row.value) as UsageMeasures;
          if (row.run_id !== run.id)
            for (const metric of usageMetricKeys) entry.baselineCandidates[metric] ??= prior[metric];
        }
      }
      if (packet.scope === 'session-cumulative') {
        for (const metric of usageMetricKeys) {
          const value = packet.values[metric];
          if (value === null) continue;
          if (packet.baseline) {
            entry.baselines[metric] = value;
            entry.unresolved = entry.unresolved.filter((key) => key !== metric);
          } else {
            // Baselines are captured once, independently per metric. Claude cost snapshots may
            // follow separate run-local token snapshots, and must not subtract their token values.
            if (entry.baselines[metric] === null) {
              if (packet.freshSession) entry.baselines[metric] = 0;
              else if (entry.baselineCandidates[metric] !== null)
                entry.baselines[metric] = entry.baselineCandidates[metric];
            }
            entry.sessionTotals[metric] = value;
          }
        }
      }
      const events = this.db.prepare('SELECT packet FROM usage_events WHERE run_id=? ORDER BY seq').all(run.id) as {
        packet: string;
      }[];
      const delta = blank(),
        snapshot = blank();
      entry.sources = [];
      entry.notes = [];
      entry.unresolved = [];
      entry.eventCount = 0;
      for (const row of events) {
        const item = JSON.parse(row.packet) as Packet;
        if (item.source && !entry.sources.includes(item.source)) entry.sources.push(item.source);
        if (item.note && !entry.notes.includes(item.note)) entry.notes.push(item.note);
        if (item.baseline) continue;
        entry.eventCount++;
        for (const metric of usageMetricKeys) {
          const value = item.values[metric];
          if (value === null) continue;
          if (item.scope === 'delta') delta[metric] = (delta[metric] ?? 0) + value;
          else if (item.scope === 'run-cumulative') {
            snapshot[metric] = value;
            entry.unresolved = entry.unresolved.filter((key) => key !== metric);
          } else {
            const baseline = entry.baselines[metric];
            // A decreasing counter is a reset/unknown boundary, never negative consumption.
            if (baseline === null || value < baseline) {
              snapshot[metric] = null;
              if (!entry.unresolved.includes(metric)) entry.unresolved.push(metric);
            } else {
              snapshot[metric] = value - baseline;
              entry.unresolved = entry.unresolved.filter((key) => key !== metric);
            }
          }
        }
      }
      for (const metric of usageMetricKeys)
        entry[metric] = entry.unresolved.includes(metric) ? null : (snapshot[metric] ?? delta[metric]);
      entry.uncertain = entry.unresolved.length > 0;
      this.save(entry);
      if (sessionId && packet.scope === 'session-cumulative') {
        const value = { ...prior };
        for (const metric of usageMetricKeys)
          value[metric] = entry.sessionTotals[metric] ?? entry.baselines[metric] ?? value[metric];
        this.db
          .prepare(
            'INSERT INTO usage_sessions(runtime_id,session_id,run_id,value) VALUES(?,?,?,?) ON CONFLICT(runtime_id,session_id) DO UPDATE SET run_id=excluded.run_id,value=excluded.value',
          )
          .run(target.id, sessionId, run.id, JSON.stringify(value));
      }
      this.db.exec('RELEASE usage_record');
    } catch (error) {
      this.db.exec('ROLLBACK TO usage_record; RELEASE usage_record');
      throw error;
    }
  }
  /** Imports every persisted run, not Store.runs()'s newest 200. Historical event truncation is disclosed. */
  historyImport(targets: RuntimeTarget[]): { importedRuns: number } {
    this.normalizeHistory();
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
    if (!table) return { importedRuns: 0 };
    this.db.exec('SAVEPOINT usage_history_import');
    try {
      const steps = this.historyImportSteps(targets);
      let next = steps.next();
      while (!next.done) next = steps.next();
      const result = next.value;
      this.db.exec('RELEASE usage_history_import');
      return result;
    } catch (error) {
      this.reportEntries = undefined;
      this.defaultReport = undefined;
      this.db.exec('ROLLBACK TO usage_history_import; RELEASE usage_history_import');
      throw error;
    }
  }
  *historyImportSteps(targets: RuntimeTarget[]): Generator<void, { importedRuns: number }> {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
    if (!table) return { importedRuns: 0 };
    // Persist a change counter so an unchanged restart does not even scan large runs JSON in SQLite.
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage_history_state (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, imported_revision INTEGER);
      INSERT OR IGNORE INTO usage_history_state(id,revision) VALUES(1,0);`);
    for (const source of ['runs', 'usage_runs'])
      for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS usage_history_${source}_${operation}
          AFTER ${operation} ON ${source} BEGIN
            UPDATE usage_history_state SET revision=revision+1 WHERE id=1;
          END;`);
    const version = this.db.prepare('SELECT revision,imported_revision FROM usage_history_state WHERE id=1').get() as {
      revision: number;
      imported_revision: number | null;
    };
    // A pre-Spend database can have an up-to-date import revision but no launch-account snapshots yet.
    const needsAccounts = this.db
      .prepare(
        "SELECT 1 FROM usage_runs u JOIN runs r ON r.id=u.id WHERE json_type(u.value,'$.account') IS NULL LIMIT 1",
      )
      .get();
    if (version.revision === version.imported_revision && !needsAccounts) return { importedRuns: 0 };
    let expectedRevision = version.revision;
    let changedBetweenSlices = false;
    const revision = () =>
      (this.db.prepare('SELECT revision FROM usage_history_state WHERE id=1').get() as { revision: number }).revision;
    const checkpoint = () => {
      if (!changedBetweenSlices) this.db.exec('UPDATE usage_history_state SET imported_revision=revision WHERE id=1');
    };
    // Check every ID and mutable metadata: the newest imported run alone cannot prove coverage.
    const summaries = !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_summaries'")
      .get();
    const pending = this.db
      .prepare(
        `SELECT 1 FROM ${summaries ? 'run_summaries' : 'runs'} r LEFT JOIN usage_runs u ON u.id=r.id
        WHERE u.id IS NULL
          OR json_extract(r.value,'$.status') IS NOT json_extract(u.value,'$.status')
          OR json_extract(r.value,'$.endedAt') IS NOT json_extract(u.value,'$.endedAt')
          OR json_extract(r.value,'$.nativeSessionId') IS NOT json_extract(u.value,'$.nativeSessionId')
          OR json_extract(r.value,'$.workflowId') IS NOT json_extract(u.value,'$.workflowId')
          OR json_extract(u.value,'$.observationVersion') IS NOT 1
          OR json_type(u.value,'$.account') IS NULL
          OR json_extract(r.value,'$.errorCode') IS NOT json_extract(u.value,'$.errorCode')
          OR json_extract(r.value,'$.effectiveModel.model') IS NOT NULL
            AND json_extract(r.value,'$.effectiveModel.model') IS NOT json_extract(u.value,'$.model')
          OR (CASE WHEN json_extract(r.value,'$.effectiveModel') IS NOT NULL
              THEN json_extract(r.value,'$.effectiveModel.effort') ELSE json_extract(r.value,'$.route.effort') END)
            IS NOT json_extract(u.value,'$.effort')
          OR json_extract(r.value,'$.executionKind') IS NOT NULL
            AND json_extract(r.value,'$.executionKind') IS NOT json_extract(u.value,'$.executionKind')
          OR json_extract(r.value,'$.apiProvider') IS NOT NULL
            AND json_extract(r.value,'$.apiProvider') IS NOT json_extract(u.value,'$.apiProvider')
          OR json_extract(r.value,'$.parentRunId') IS NOT json_extract(u.value,'$.parentRunId')
          OR json_extract(r.value,'$.relay') IS NOT json_extract(u.value,'$.relay')
          OR json_extract(r.value,'$.adapterStartedAt') IS NOT json_extract(u.value,'$.adapterStartedAt')
          OR json_extract(r.value,'$.firstTextAt') IS NOT json_extract(u.value,'$.firstTextAt')
          OR json_extract(r.value,'$.adapterEndedAt') IS NOT json_extract(u.value,'$.adapterEndedAt')
        LIMIT 1`,
      )
      .get();
    if (!pending) {
      checkpoint();
      return { importedRuns: 0 };
    }
    // Existing ledger rows need metadata only; loading archived output/events here can read gigabytes at startup.
    // Missing ledger rows still use the full run so historical usage packets are preserved.
    const rows = this.db.prepare('SELECT id FROM runs ORDER BY started_at,id').all() as { id: string }[];
    const metadata = this.db.prepare(`SELECT value FROM ${summaries ? 'run_summaries' : 'runs'} WHERE id=?`);
    const fullRun = this.db.prepare('SELECT value FROM runs WHERE id=?');
    const parentIdentity = this.db.prepare(`SELECT json_extract(value,'$.route.runtimeId') AS runtimeId,
      json_extract(value,'$.nativeSessionId') AS nativeSessionId FROM ${summaries ? 'run_summaries' : 'runs'} WHERE id=?`);
    const seenSessions = new Set<string>();
    let importedRuns = 0;
    for (const row of rows) {
      yield;
      if (revision() !== expectedRevision) changedBetweenSlices = true;
      const existing = this.get(row.id);
      const current = (existing ? metadata : fullRun).get(row.id) as { value: string } | undefined;
      if (!current) continue;
      const run = JSON.parse(current.value) as RunRecord;
      const target: UsageTarget = targets.find((item) => item.id === run.route.runtimeId) ?? {
        id: run.route.runtimeId,
        label: run.route.runtimeId,
        provider: 'unknown',
      };
      // Removed targets can still contribute historical totals without guessing a provider.
      const mode =
        target.accountingMode === 'subscription' || target.accountingMode === 'usage'
          ? target.accountingMode
          : 'unknown';
      const sessionKey = run.nativeSessionId ? JSON.stringify([target.id, run.nativeSessionId]) : undefined;
      const parent = run.parentRunId
        ? (parentIdentity.get(run.parentRunId) as { runtimeId: string; nativeSessionId: string | null } | undefined)
        : undefined;
      const isResume =
        !!run.parentRunId &&
        (!parent || (parent.runtimeId === target.id && (parent.nativeSessionId ?? undefined) === run.nativeSessionId));
      const freshSession = !!sessionKey && !seenSessions.has(sessionKey) && !isResume;
      if (sessionKey) seenSessions.add(sessionKey);
      if (existing) {
        this.begin(run, target, existing.accountingMode);
        expectedRevision = revision();
        continue;
      }
      this.db.exec('SAVEPOINT usage_history_run');
      try {
        this.begin(run, target, mode);
        for (const event of run.events) {
          const legacyClaudeCost =
            target.provider === 'claude' &&
            event.type === 'usage' &&
            event.data?.scope === undefined &&
            typeof event.data?.estimatedCostUsd === 'number';
          const legacyCodexTotal =
            target.provider === 'codex' &&
            event.type === 'usage' &&
            event.data?.scope === undefined &&
            Object.keys(object(event.data?.total)).length > 0;
          this.record(
            run,
            target,
            legacyClaudeCost || legacyCodexTotal
              ? {
                  ...event,
                  data: { ...event.data, scope: 'session-cumulative', sessionId: run.nativeSessionId, freshSession },
                }
              : event,
            mode,
          );
        }
        const entry = this.get(run.id)!;
        entry.historyImported = true;
        entry.notes.push('历史回填只包含旧运行记录仍保存的 usage 事件；旧事件可能已截断。');
        this.save(entry);
        this.db.exec('RELEASE usage_history_run');
      } catch (error) {
        this.reportEntries = undefined;
        this.defaultReport = undefined;
        this.db.exec('ROLLBACK TO usage_history_run; RELEASE usage_history_run');
        throw error;
      }
      importedRuns++;
      expectedRevision = revision();
    }
    checkpoint();
    return { importedRuns };
  }
  private stateReportCache?: { source: UsageReport; key: string; value: UsageReport };
  runPage(offset = 0, limit = 100) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid usage history page');
    const report = this.report();
    return {
      perRun: report.perRun.slice(offset, offset + limit),
      total: report.perRun.length,
      ...(offset + limit < report.perRun.length ? { nextOffset: offset + limit } : {}),
    };
  }
  stateReport(runIds: string[] = [], now = new Date()): UsageReport {
    const source = this.report();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const key = JSON.stringify([month, runIds]);
    if (this.stateReportCache?.source === source && this.stateReportCache.key === key)
      return this.stateReportCache.value;
    const wanted = new Set(runIds);
    // Monthly savings and visible task cards need these rows even outside the recent page.
    const perRun = source.perRun.filter(
      (run, index) => index < 200 || Date.parse(run.startedAt) >= month || wanted.has(run.runId),
    );
    const value = perRun.length === source.perRun.length ? source : { ...source, perRun };
    this.stateReportCache = { source, key, value };
    return value;
  }
  report(filters: UsageFilters = {}): UsageReport {
    const date = (value?: string) => (value === undefined ? undefined : Date.parse(value));
    const from = date(filters.from),
      to = date(filters.to);
    if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to)))
      throw new Error('用量日期过滤格式无效。');
    if (from !== undefined && to !== undefined && from > to) throw new Error('起始日期不能晚于结束日期。');
    const unfiltered = !filters.projectPath && !filters.runtimeId && from === undefined && to === undefined;
    if (unfiltered && this.defaultReport) return this.defaultReport;
    if (!this.reportEntries) {
      const rows = this.db.prepare('SELECT value FROM usage_runs ORDER BY started_at DESC,id').all() as {
        value: string;
      }[];
      this.reportEntries = rows.map((row) => JSON.parse(row.value) as Entry);
    }
    const entries = this.reportEntries.filter(
      (row) =>
        (!filters.projectPath || pathKey(row.projectPath) === pathKey(filters.projectPath)) &&
        (!filters.runtimeId || row.runtimeId === filters.runtimeId) &&
        (from === undefined || Date.parse(row.startedAt) >= from) &&
        (to === undefined || Date.parse(row.startedAt) <= to),
    );
    const perRun: UsageRun[] = entries.map(
      ({
        baselines,
        baselineCandidates,
        sessionTotals,
        unresolved,
        observationVersion,
        normalizationVersion,
        account,
        ...run
      }) => run,
    );
    const group = (key: (run: UsageRun) => string) => {
      const groups = new Map<string, UsageRun[]>();
      for (const row of perRun) {
        const id = key(row),
          group = groups.get(id);
        if (group) group.push(row);
        else groups.set(id, [row]);
      }
      return [...groups.values()];
    };
    const report: UsageReport = {
      generatedAt: new Date().toISOString(),
      filters: { ...filters },
      totals: aggregate(perRun),
      perRun,
      byProject: group((run) => pathKey(run.projectPath)).map((rows) => ({
        projectPath: rows[0]!.projectPath,
        ...aggregate(rows),
      })),
      byRuntime: group((run) => run.runtimeId).map((rows) => ({
        runtimeId: rows[0]!.runtimeId,
        label: rows[0]!.runtimeLabel,
        provider: rows[0]!.provider,
        ...aggregate(rows),
      })),
      byModel: group((run) => JSON.stringify([run.runtimeId, run.model])).map((rows) => ({
        runtimeId: rows[0]!.runtimeId,
        model: rows[0]!.model,
        ...aggregate(rows),
      })),
      note: '仅统计 PugPort 观测到的用量；不是账户余额或供应商账单。金额为运行时报告的参考费用，缺失显示未知。各平台 token 口径可能不同，缓存/推理 token 可能已包含于总 token。历史回填可能缺少旧事件；未报告或无法确定会话基线的指标不按零计入。时间筛选按运行开始时间。',
    };
    if (unfiltered) this.defaultReport = report;
    return report;
  }
}
