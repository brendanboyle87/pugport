import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeUsageMeasures, UsageLedger } from '../src/server/usage.ts';
import { grokAcpUsage } from '../src/server/adapters/grok-acp.ts';
import type { RunEvent, RunRecord, RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'executor',
  label: 'Executor',
  provider: 'codex',
  command: 'unused',
  environment: 'native',
  enabled: true,
};
const run = (extra: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run',
  prompt: 'synthetic',
  projectPath: '/synthetic',
  kind: 'routine',
  status: 'running',
  route: { runtimeId: target.id, model: 'requested', effort: 'low', kind: 'routine', reasons: [], warnings: [] },
  startedAt: '2026-11-01T10:00:00.000Z',
  output: '',
  events: [],
  ...extra,
});
const event = (data: Record<string, unknown>): RunEvent => ({ type: 'usage', at: '2026-11-01T10:00:01.000Z', data });

test('inclusive input is split once; unknown cache remains unknown and zero remains observed', () => {
  const split = normalizeUsageMeasures(
    { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningTokens: 4 },
    'codex',
  );
  assert.equal(split.inputTokens, 20);
  assert.equal(split.cacheReadTokens, 80);
  assert.equal(split.reasoningOutputTokens, 4);
  assert.equal(normalizeUsageMeasures({ inputTokens: 100 }, 'codex').inputTokens, null);
  assert.equal(normalizeUsageMeasures({ inputTokens: 0, cachedInputTokens: 0 }, 'codex').inputTokens, 0);
  const raw = { inputTokens: 100, cachedReadTokens: 30, cacheCreationTokens: 20, outputTokens: 7, reasoningTokens: 3 };
  assert.equal(normalizeUsageMeasures(raw, 'grok').inputTokens, 50);
  const canonical = grokAcpUsage(raw)!;
  const normalized = normalizeUsageMeasures(canonical, 'grok');
  assert.equal(normalized.inputTokens, 50);
  assert.equal(normalized.cacheReadTokens, 30);
  assert.equal(normalized.cacheWriteTokens, 20);
  assert.equal(normalized.reasoningOutputTokens, 3);
  assert.equal(
    normalizeUsageMeasures({ inputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 }, 'pi').inputTokens,
    50,
  );
});

test('run snapshots update confirmed model, failure, relay, linkage and independent timing', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ledger = new UsageLedger(db);
  const api = { ...target, provider: 'pi' as const, gateway: 'api' as const, apiProvider: 'supplier-a' };
  const value = run({ executionKind: 'api', apiProvider: 'supplier-a', workflowId: 'task', parentRunId: 'parent' });
  ledger.begin(value, api, 'usage');
  ledger.begin(
    {
      ...value,
      status: 'failed',
      errorCode: 'network-error',
      effectiveModel: { model: 'confirmed', effort: 'high', source: 'session' },
      relay: { fromRunId: 'previous', fromRuntimeId: 'other', reason: 'technical' },
      adapterStartedAt: '2026-11-01T10:00:01.000Z',
      firstTextAt: '2026-11-01T10:00:02.000Z',
      adapterEndedAt: '2026-11-01T10:00:04.000Z',
      endedAt: '2026-11-01T10:00:05.000Z',
    },
    { ...api, apiProvider: 'supplier-edited' },
  );
  const row = ledger.report().perRun[0]!;
  assert.equal(row.executionKind, 'api');
  assert.equal(row.apiProvider, 'supplier-a');
  assert.equal(row.model, 'confirmed');
  assert.equal(row.effort, 'high');
  assert.equal(row.errorCode, 'network-error');
  assert.equal(row.workflowId, 'task');
  assert.equal(row.parentRunId, 'parent');
  assert.equal(row.relay?.fromRuntimeId, 'other');
  assert.equal(row.relay?.reason, 'technical');
  assert.equal(row.adapterStartedAt, '2026-11-01T10:00:01.000Z');
  assert.equal(row.firstTextAt, '2026-11-01T10:00:02.000Z');
  assert.equal(row.adapterEndedAt, '2026-11-01T10:00:04.000Z');
  assert.equal(row.accountingMode, 'usage');
});

test('backfill derives retained metadata, keeps unknown timing null and refreshes unchanged terminal rows', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const ledger = new UsageLedger(db);
  const historical = run({
    status: 'failed',
    errorCode: 'timeout',
    effectiveModel: { model: 'observed', source: 'session' },
    parentRunId: 'previous',
    workflowId: 'task',
  });
  ledger.begin(run({ status: 'failed' }), target);
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(historical.id, historical.startedAt, JSON.stringify(historical));
  ledger.historyImport([target]);
  let row = ledger.report().perRun[0]!;
  assert.equal(row.errorCode, 'timeout');
  assert.equal(row.model, 'observed');
  assert.equal(row.parentRunId, 'previous');
  assert.equal(row.adapterStartedAt, null);
  assert.equal(row.firstTextAt, null);
  assert.equal(row.adapterEndedAt, null);
  const removed = run({ id: 'removed', route: { ...historical.route, runtimeId: 'removed' } });
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(removed.id, removed.startedAt, JSON.stringify(removed));
  ledger.historyImport([target]);
  row = ledger.report().perRun.find((entry) => entry.runId === 'removed')!;
  assert.equal(row.executionKind, null);
  assert.equal(row.apiProvider, null);
});

test('legacy inclusive ledger, packet and session totals migrate only once across resume and restart', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let ledger = new UsageLedger(db);
  const first = run({ nativeSessionId: 'session' });
  ledger.record(
    first,
    target,
    event({
      eventId: 'one',
      scope: 'session-cumulative',
      freshSession: true,
      sessionId: 'session',
      total: { inputTokens: 100, cachedInputTokens: 80 },
    }),
  );
  const row = JSON.parse((db.prepare('SELECT value FROM usage_runs').get() as { value: string }).value);
  delete row.normalizationVersion;
  delete row.observationVersion;
  row.inputTokens = 100;
  row.sessionTotals.inputTokens = 100;
  db.prepare('UPDATE usage_runs SET value=?').run(JSON.stringify(row));
  const saved = JSON.parse((db.prepare('SELECT packet FROM usage_events').get() as { packet: string }).packet);
  delete saved.normalizationVersion;
  saved.values.inputTokens = 100;
  db.prepare('UPDATE usage_events SET packet=?').run(JSON.stringify(saved));
  const session = JSON.parse((db.prepare('SELECT value FROM usage_sessions').get() as { value: string }).value);
  session.inputTokens = 100;
  db.prepare('UPDATE usage_sessions SET value=?').run(JSON.stringify(session));
  ledger = new UsageLedger(db);
  assert.equal(ledger.report().perRun[0]!.inputTokens, 20);
  ledger.record(
    run({ id: 'resume', nativeSessionId: 'session', parentRunId: 'run' }),
    target,
    event({
      eventId: 'two',
      scope: 'session-cumulative',
      sessionId: 'session',
      total: { inputTokens: 130, cachedInputTokens: 90 },
    }),
  );
  assert.equal(ledger.report().totals.inputTokens, 40);
  ledger = new UsageLedger(db);
  assert.equal(ledger.report().totals.inputTokens, 40);
  assert.equal(ledger.report().totals.cacheReadTokens, 90);
});

test('legacy reasoning alias is recovered from retained observations without replaying costs', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  let ledger = new UsageLedger(db);
  const usage = event({
    eventId: 'result',
    scope: 'run-cumulative',
    inputTokens: 8,
    cacheReadTokens: 4,
    reasoningTokens: 3,
    estimatedCostUsd: 0.2,
  });
  const value = run({ events: [usage] });
  const executor = { ...target, provider: 'grok' as const };
  ledger.record(value, executor, usage);
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(value.id, value.startedAt, JSON.stringify(value));
  const row = JSON.parse((db.prepare('SELECT value FROM usage_runs').get() as { value: string }).value);
  delete row.normalizationVersion;
  row.reasoningOutputTokens = null;
  db.prepare('UPDATE usage_runs SET value=?').run(JSON.stringify(row));
  const saved = JSON.parse((db.prepare('SELECT packet FROM usage_events').get() as { packet: string }).packet);
  delete saved.normalizationVersion;
  saved.values.reasoningOutputTokens = null;
  db.prepare('UPDATE usage_events SET packet=?').run(JSON.stringify(saved));
  ledger = new UsageLedger(db);
  assert.equal(ledger.report().perRun[0]!.reasoningOutputTokens, 3);
  assert.equal(ledger.report().perRun[0]!.estimatedCostUsd, 0.2);
  assert.equal(ledger.report().perRun[0]!.inputTokens, 8);
});

test('removed targets retain derivable execution type and terminal metadata corrections backfill', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const ledger = new UsageLedger(db);
  const value = run({ status: 'completed' });
  ledger.begin(value, target);
  const saved = JSON.parse((db.prepare('SELECT value FROM usage_runs').get() as { value: string }).value);
  delete saved.executionKind;
  delete saved.observationVersion;
  db.prepare('UPDATE usage_runs SET value=?').run(JSON.stringify(saved));
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(value.id, value.startedAt, JSON.stringify(value));
  ledger.historyImport([]);
  assert.equal(ledger.report().perRun[0]!.executionKind, 'cli');
  const corrected = { ...value, effectiveModel: { model: 'requested', effort: 'high', source: 'session' } };
  db.prepare('UPDATE runs SET value=?').run(JSON.stringify(corrected));
  ledger.historyImport([]);
  assert.equal(ledger.report().perRun[0]!.effort, 'high');
});

test('retained account snapshot supplies transport when ledger provider was unknown', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ledger = new UsageLedger(db);
  const value = run({ account: { id: 'account', label: 'Account', provider: 'pi' } });
  const unknown = { id: 'removed', label: 'Removed', provider: 'unknown' as const };
  ledger.begin(run(), unknown);
  ledger.begin(value, unknown);
  assert.equal(ledger.report().perRun[0]!.executionKind, 'api');
});
