import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageLedger } from '../src/server/usage.ts';
import { contextFromEvent } from '../src/shared/context-usage.ts';
import type { RunEvent, RunRecord, RuntimeTarget } from '../src/shared/types.ts';

const target: RuntimeTarget = {
  id: 'pi-native',
  provider: 'pi',
  label: 'Pi Native RPC',
  command: 'unused',
  environment: 'native',
  enabled: true,
};
const run = (id = 'run-one', overrides: Partial<RunRecord> = {}): RunRecord => ({
  id,
  prompt: 'do not persist this prompt in the ledger',
  projectPath: 'C:\\Work\\One',
  kind: 'routine',
  status: 'running',
  route: { runtimeId: target.id, model: 'provider/model', kind: 'routine', reasons: [], warnings: [] },
  startedAt: '2026-09-26T10:00:00.000Z',
  output: '',
  events: [],
  ...overrides,
});
const event = (data: Record<string, unknown>, at = '2026-09-26T10:00:01.000Z'): RunEvent => ({
  type: 'usage',
  at,
  data,
});
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, ledger: new UsageLedger(db) };
}

test('context snapshots use native occupancy, ignore totals, and validate optional windows', () => {
  const cursor = { ...event({ contextTokens: 126000, contextWindow: 200000 }), type: 'status' as const };
  assert.deepEqual(contextFromEvent('cursor', '', cursor), { tokens: 126000, window: 200000, at: cursor.at });
  for (const provider of ['gemini', 'pi'] as const) {
    assert.equal(contextFromEvent(provider, '', cursor), undefined);
    assert.equal(contextFromEvent(provider, '', event({ totalTokens: 123 })), undefined);
  }
  assert.equal(contextFromEvent('codex', '', event({ total: { totalTokens: 99 } })), undefined);
  assert.equal(contextFromEvent('claude', '', event({ inputTokens: 999999, cumulative: false })), undefined);
  for (const invalid of [-1, NaN, Infinity, '123']) {
    assert.equal(contextFromEvent('cursor', '', { ...cursor, data: { contextTokens: invalid } }), undefined);
    assert.deepEqual(
      contextFromEvent('cursor', '', { ...cursor, data: { contextTokens: 0, contextWindow: invalid } }),
      { tokens: 0, at: cursor.at },
    );
  }
  assert.deepEqual(contextFromEvent('codex', '', event({ last: { totalTokens: 10 } })), { tokens: 10, at: cursor.at });
  assert.equal(contextFromEvent('codex', '', event({ last: { totalTokens: 2, reasoningOutputTokens: 3 } })), undefined);
});

test('message usage sums distinct messages and deduplicates retransmissions and imports', (t) => {
  const { ledger, db } = fixture(t),
    task = run();
  const first = event({
    eventId: 'message-one',
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    costUsd: 0.1,
    cumulative: false,
    source: 'Pi RPC',
  });
  ledger.record(task, target, first, 'usage');
  ledger.record(task, target, { ...first, at: '2026-09-26T11:00:00.000Z' }, 'usage');
  ledger.record(task, target, event({ ...first.data, eventId: 'message-two' }), 'usage');
  const report = ledger.report();
  assert.equal(report.totals.totalTokens, 34);
  assert.equal(report.totals.estimatedCostUsd, 0.2);
  assert.equal(report.perRun[0]!.eventCount, 2);
  assert.deepEqual(report.perRun[0]!.sources, ['Pi RPC']);
  assert.equal(report.totals.accountingRuns.usage, 1);
  assert.ok(
    !String((db.prepare('SELECT value FROM usage_runs').get() as { value: string }).value).includes(task.prompt),
  );
});

test('run-cumulative snapshots replace rather than add and zero differs from unknown', (t) => {
  const { ledger } = fixture(t),
    task = run();
  ledger.record(
    task,
    target,
    event({ eventId: 'first', scope: 'run-cumulative', inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0 }),
  );
  ledger.record(task, target, event({ eventId: 'second', scope: 'run-cumulative', inputTokens: 25, outputTokens: 7 }));
  assert.equal(ledger.report().totals.inputTokens, 25);
  assert.equal(ledger.report().totals.outputTokens, 7);
  assert.equal(ledger.report().totals.estimatedCostUsd, 0);
  assert.equal(ledger.report().totals.totalTokens, null);
});

test('a final run snapshot supersedes partial deltas without double counting', (t) => {
  const { ledger } = fixture(t),
    task = run();
  ledger.record(task, target, event({ eventId: 'delta', inputTokens: 3, outputTokens: 2 }));
  ledger.record(task, target, event({ eventId: 'final', scope: 'run-cumulative', inputTokens: 8, outputTokens: 4 }));
  assert.equal(ledger.report().totals.inputTokens, 8);
  assert.equal(ledger.report().totals.outputTokens, 4);
});

test('Codex session cumulative totals use explicit per-turn baseline for resume', (t) => {
  const { ledger } = fixture(t),
    task = run('resume', { parentRunId: 'external-old-run', nativeSessionId: 'codex-thread' });
  const codex = { ...target, provider: 'codex' as const };
  ledger.record(
    task,
    codex,
    event({
      eventId: 'baseline',
      scope: 'session-cumulative',
      sessionId: 'codex-thread',
      baseline: true,
      total: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, totalTokens: 110 },
    }),
    'subscription',
  );
  ledger.record(
    task,
    codex,
    event({
      eventId: 'update-1',
      scope: 'session-cumulative',
      sessionId: 'codex-thread',
      total: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 15, totalTokens: 135 },
    }),
    'subscription',
  );
  ledger.record(
    task,
    codex,
    event({
      eventId: 'update-2',
      scope: 'session-cumulative',
      sessionId: 'codex-thread',
      total: { inputTokens: 140, cachedInputTokens: 0, outputTokens: 20, totalTokens: 160 },
    }),
    'subscription',
  );
  const result = ledger.report();
  assert.equal(result.totals.inputTokens, 40);
  assert.equal(result.totals.totalTokens, 50);
  assert.equal(result.totals.estimatedCostUsd, null);
  assert.equal(result.perRun[0]!.eventCount, 2);
  assert.equal(result.totals.uncertainRuns, 0);
});

test('session baseline survives run boundaries and restart independently per metric', (t) => {
  const { ledger, db } = fixture(t),
    first = run('first', { nativeSessionId: 'thread' }),
    second = run('second', { nativeSessionId: 'thread', parentRunId: 'first' });
  ledger.record(
    first,
    target,
    event({
      eventId: 'first',
      scope: 'session-cumulative',
      sessionId: 'thread',
      freshSession: true,
      inputTokens: 10,
      estimatedCostUsd: 2,
    }),
  );
  const restarted = new UsageLedger(db);
  restarted.record(
    second,
    target,
    event({ eventId: 'second-token', scope: 'session-cumulative', sessionId: 'thread', inputTokens: 15 }),
  );
  restarted.record(
    second,
    target,
    event({ eventId: 'second-cost', scope: 'session-cumulative', sessionId: 'thread', estimatedCostUsd: 3 }),
  );
  const result = restarted.report();
  assert.equal(result.totals.inputTokens, 15);
  assert.equal(result.totals.estimatedCostUsd, 3);
  assert.equal(result.perRun.find((r) => r.runId === 'second')!.estimatedCostUsd, 1);
});

test('Claude current-turn tokens do not contaminate resumed session cost baseline', (t) => {
  const { ledger } = fixture(t),
    claude = { ...target, provider: 'claude' as const },
    first = run('first'),
    second = run('second', { parentRunId: 'first' });
  ledger.record(
    first,
    claude,
    event({ eventId: 'tokens', scope: 'run-cumulative', input_tokens: 20, output_tokens: 3 }),
  );
  ledger.record(
    first,
    claude,
    event({
      eventId: 'cost',
      scope: 'session-cumulative',
      sessionId: 'claude-session',
      freshSession: true,
      estimatedCostUsd: 0.5,
    }),
  );
  ledger.record(
    second,
    claude,
    event({ eventId: 'tokens', scope: 'run-cumulative', input_tokens: 50, output_tokens: 10 }),
  );
  ledger.record(
    second,
    claude,
    event({ eventId: 'cost', scope: 'session-cumulative', sessionId: 'claude-session', estimatedCostUsd: 0.8 }),
  );
  const result = ledger.report();
  assert.equal(result.totals.inputTokens, 70);
  assert.equal(result.totals.outputTokens, 13);
  assert.ok(Math.abs(result.totals.estimatedCostUsd! - 0.8) < 1e-10);
  assert.equal(result.totals.uncertainRuns, 0);
});

test('missing resume baseline and counter resets remain unknown instead of guessing consumption', (t) => {
  const { ledger } = fixture(t),
    task = run();
  ledger.record(
    task,
    target,
    event({ eventId: 'unknown', scope: 'session-cumulative', sessionId: 'external', totalTokens: 9000 }),
  );
  assert.equal(ledger.report().totals.totalTokens, null);
  assert.equal(ledger.report().totals.uncertainRuns, 1);
  ledger.record(
    task,
    target,
    event({
      eventId: 'baseline',
      scope: 'session-cumulative',
      sessionId: 'external',
      baseline: true,
      totalTokens: 8000,
    }),
  );
  assert.equal(ledger.report().totals.totalTokens, 1000);
  ledger.record(
    task,
    target,
    event({ eventId: 'reset', scope: 'session-cumulative', sessionId: 'external', totalTokens: 100 }),
  );
  assert.equal(ledger.report().totals.totalTokens, null);
  assert.equal(ledger.report().totals.uncertainRuns, 1);
});

test('unreported runs including failures contribute coverage, not invented zero usage', (t) => {
  const { ledger } = fixture(t),
    failed = run('failed', { status: 'failed' }),
    known = run('known');
  ledger.begin(failed, target, 'usage');
  ledger.begin(known, target, 'usage');
  ledger.record(known, target, event({ eventId: 'tokens', inputTokens: 12, outputTokens: 3 }), 'usage');
  const report = ledger.report();
  assert.equal(report.totals.runs, 2);
  assert.equal(report.totals.reportedRuns, 1);
  assert.equal(report.totals.tokenReportedRuns, 1);
  assert.equal(report.totals.costReportedRuns, 0);
  assert.equal(report.totals.estimatedCostUsd, null);
  assert.equal(report.totals.metricReportedRuns.inputTokens, 1);
  assert.equal(report.totals.metricReportedRuns.totalTokens, 0);
  assert.equal(report.perRun.find((row) => row.runId === 'failed')!.inputTokens, null);
});

test('normalized metric aliases and invalid numbers preserve reporting semantics', (t) => {
  const { ledger } = fixture(t),
    task = run();
  ledger.record(
    task,
    target,
    event({
      eventId: 'usage',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
      costUsd: -5,
      totalTokens: Infinity,
    }),
  );
  const result = ledger.report().totals;
  assert.equal(result.inputTokens, 1);
  assert.equal(result.cacheReadTokens, 3);
  assert.equal(result.cacheWriteTokens, 4);
  assert.equal(result.reasoningOutputTokens, 1);
  assert.equal(result.totalTokens, null);
  assert.equal(result.estimatedCostUsd, null);
});

test('project/runtime/model and time filters aggregate only requested observations', (t) => {
  const { ledger } = fixture(t);
  ledger.record(run('one'), target, event({ eventId: 'one', totalTokens: 5 }), 'usage');
  ledger.record(
    run('two', { projectPath: 'c:/work/one/', startedAt: '2026-09-27T10:00:00.000Z' }),
    target,
    event({ eventId: 'two', totalTokens: 6 }),
    'usage',
  );
  const other = { ...target, id: 'dsh', provider: 'dsh' as const, label: 'DSH' };
  ledger.record(
    run('three', {
      projectPath: 'C:\\Work\\Two',
      route: { runtimeId: 'dsh', model: 'other-model', kind: 'routine', reasons: [], warnings: [] },
    }),
    other,
    event({ eventId: 'three', totalTokens: 7 }),
    'unknown',
  );
  assert.equal(ledger.report().byProject.length, 2);
  assert.equal(ledger.report().byRuntime.length, 2);
  assert.equal(ledger.report().byModel.length, 2);
  assert.equal(ledger.report({ projectPath: 'C:\\Work\\One' }).totals.totalTokens, 11);
  assert.equal(ledger.report({ runtimeId: 'dsh' }).totals.totalTokens, 7);
  assert.equal(ledger.report({ from: '2026-09-27T00:00:00.000Z' }).totals.totalTokens, 6);
  assert.equal(ledger.report({ to: '2026-09-26T23:59:59.000Z' }).totals.totalTokens, 12);
  assert.throws(() => ledger.report({ from: 'wrong' }));
});

test('persistent ledger retains 220 runs and more than 1000 events even without old UI events', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'studio-usage-test-')),
    database = join(folder, 'usage.sqlite');
  let db = new DatabaseSync(database),
    ledger = new UsageLedger(db);
  t.after(() => {
    db.close();
    const safe = resolve(folder);
    assert.ok(safe.startsWith(resolve(tmpdir()) + sep) && basename(safe).startsWith('studio-usage-test-'));
    rmSync(safe, { recursive: true, force: true });
  });
  for (let i = 0; i < 220; i++)
    ledger.record(run(`run-${i}`), target, event({ eventId: `event-${i}`, totalTokens: 1 }), 'usage');
  const long = run('long');
  for (let i = 0; i < 1005; i++)
    ledger.record(long, target, event({ eventId: `message-${i}`, totalTokens: 1 }), 'usage');
  ledger.begin({ ...long, status: 'failed', endedAt: '2026-09-26T12:00:00.000Z', events: [] }, target, 'usage');
  db.close();
  db = new DatabaseSync(database);
  ledger = new UsageLedger(db);
  const result = ledger.report();
  assert.equal(result.totals.runs, 221);
  assert.equal(result.totals.totalTokens, 1225);
  assert.equal(result.perRun.find((row) => row.runId === 'long')!.eventCount, 1005);
  assert.equal(result.perRun.find((row) => row.runId === 'long')!.status, 'failed');
});

test('history migration imports all persisted runs once with explicit partial-history coverage', (t) => {
  const { db, ledger } = fixture(t);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  for (let i = 0; i < 230; i++) {
    const task = run(`old-${i}`, { status: 'completed', events: [event({ totalTokens: 2 })] });
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(task));
  }
  assert.equal(ledger.historyImport([target]).importedRuns, 230);
  assert.equal(ledger.historyImport([target]).importedRuns, 0);
  assert.equal(ledger.report().totals.totalTokens, 460);
  assert.equal(ledger.report().totals.historyImportedRuns, 230);
  assert.ok(ledger.report().perRun.every((row) => row.notes.some((note) => note.includes('截断'))));
});

test('history migration retains removed runtimes and corrects legacy Claude resumed cost snapshots', (t) => {
  const { db, ledger } = fixture(t);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const claude = { ...target, provider: 'claude' as const };
  const tasks = [
    run('one', { nativeSessionId: 'thread', events: [event({ estimatedCostUsd: 1, cumulative: true })] }),
    run('two', {
      parentRunId: 'one',
      nativeSessionId: 'thread',
      startedAt: '2026-09-26T11:00:00.000Z',
      events: [event({ estimatedCostUsd: 3, cumulative: true })],
    }),
    run('removed', {
      route: { runtimeId: 'removed', model: 'old', kind: 'routine', reasons: [], warnings: [] },
      events: [event({ totalTokens: 4 })],
    }),
  ];
  for (const task of tasks)
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(task));
  assert.equal(ledger.historyImport([claude]).importedRuns, 3);
  assert.equal(ledger.report().totals.estimatedCostUsd, 3);
  assert.equal(ledger.report().perRun.find((row) => row.runId === 'removed')!.provider, 'unknown');
});

test('history migration recognizes fresh Codex sessions and subtracts observed resumed totals', (t) => {
  const { db, ledger } = fixture(t);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const codex = { ...target, provider: 'codex' as const };
  const tasks = [
    run('first', { nativeSessionId: 'thread', events: [event({ total: { inputTokens: 10, totalTokens: 15 } })] }),
    run('resumed', {
      nativeSessionId: 'thread',
      parentRunId: 'first',
      startedAt: '2026-09-26T11:00:00.000Z',
      events: [event({ total: { inputTokens: 25, totalTokens: 40 } })],
    }),
    run('external-resume', {
      nativeSessionId: 'outside-thread',
      parentRunId: 'missing-old-run',
      events: [event({ total: { totalTokens: 1000 } })],
    }),
  ];
  for (const task of tasks)
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(task));
  ledger.historyImport([codex]);
  const result = ledger.report();
  assert.equal(result.totals.totalTokens, 40);
  assert.equal(result.perRun.find((r) => r.runId === 'resumed')!.totalTokens, 25);
  assert.equal(result.perRun.find((r) => r.runId === 'external-resume')!.totalTokens, null);
});

test('startup import synchronizes interrupted status without changing original accounting or live coverage', (t) => {
  const { db, ledger } = fixture(t);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const task = run();
  ledger.begin(task, target, 'subscription');
  const interrupted = { ...task, status: 'interrupted', endedAt: '2026-09-26T11:00:00.000Z' };
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(interrupted));
  assert.equal(ledger.historyImport([{ ...target, accountingMode: 'usage' }]).importedRuns, 0);
  const row = ledger.report().perRun[0]!;
  assert.equal(row.status, 'interrupted');
  assert.equal(row.accountingMode, 'subscription');
  assert.equal(row.historyImported, false);
});

test('reports reuse parsed observations and invalidate on begin and usage changes', (t) => {
  const { ledger } = fixture(t);
  ledger.record(run('one'), target, event({ eventId: 'one', totalTokens: 5 }), 'usage');
  const first = ledger.report();
  assert.equal(ledger.report(), first);
  assert.equal(ledger.report({ runtimeId: target.id }).totals.totalTokens, 5);
  assert.throws(() => ledger.report({ from: 'invalid' }));
  ledger.begin(run('one', { status: 'completed' }), target, 'usage');
  assert.notEqual(ledger.report(), first);
  assert.equal(ledger.report().perRun[0]!.status, 'completed');
  ledger.record(run('one'), target, event({ eventId: 'two', totalTokens: 3 }), 'usage');
  assert.equal(ledger.report().totals.totalTokens, 8);
  assert.equal(ledger.report({ runtimeId: target.id }).totals.totalTokens, 8);
});

test('second startup skips parsing history but still detects older gaps and metadata changes', (t) => {
  const { db, ledger } = fixture(t);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const insert = (task: RunRecord) =>
    db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(task));
  const first = run('first', { status: 'completed', events: [event({ totalTokens: 2 })] });
  const newest = run('newest', { status: 'completed', startedAt: '2026-09-27T10:00:00Z' });
  insert(first);
  insert(newest);
  assert.equal(ledger.historyImport([target]).importedRuns, 2);
  let parses = 0;
  const original = JSON.parse;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return original(...args);
  });
  const restarted = new UsageLedger(db);
  assert.equal(restarted.historyImport([target]).importedRuns, 0);
  assert.equal(parses, 0);
  t.diagnostic(`second-start history JSON.parse calls: ${parses}`);
  // Newest is already covered, but an older missing record must still be imported.
  insert(run('older-gap', { startedAt: '2026-09-25T10:00:00Z', events: [event({ totalTokens: 7 })] }));
  assert.equal(restarted.historyImport([target]).importedRuns, 1);
  assert.equal(restarted.report().totals.totalTokens, 9);
  insert({ ...first, status: 'interrupted', endedAt: '2026-09-26T12:00:00Z', workflowId: 'workflow-new' });
  assert.equal(restarted.historyImport([target]).importedRuns, 0);
  const updated = restarted.report().perRun.find((row) => row.runId === first.id)!;
  assert.equal(updated.status, 'interrupted');
  assert.equal(updated.endedAt, '2026-09-26T12:00:00Z');
  assert.equal(updated.workflowId, 'workflow-new');
  assert.equal(restarted.report().totals.totalTokens, 9);
  db.prepare('DELETE FROM usage_runs WHERE id=?').run('older-gap');
  assert.equal(restarted.historyImport([target]).importedRuns, 1);
  assert.equal(restarted.report().totals.totalTokens, 9);
});

test('history revision guard migrates after runs appears and does not checkpoint failed imports', (t) => {
  const { db, ledger } = fixture(t);
  assert.equal(ledger.historyImport([target]).importedRuns, 0);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const task = run('late-history', { events: [event({ totalTokens: 4 })] });
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, 'invalid JSON');
  assert.throws(() => ledger.historyImport([target]));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='usage_history_state'").get(), undefined);
  db.prepare('UPDATE runs SET value=? WHERE id=?').run(JSON.stringify(task), task.id);
  assert.equal(ledger.historyImport([target]).importedRuns, 1);
  const original = db.prepare;
  const sql: string[] = [];
  t.mock.method(db, 'prepare', (query: string) => {
    sql.push(query);
    return original.call(db, query);
  });
  assert.equal(new UsageLedger(db).historyImport([target]).importedRuns, 0);
  assert.ok(!sql.some((query) => query.includes('FROM runs')));
  assert.equal(ledger.report().totals.totalTokens, 4);
});

test('orphan usage without account does not force the pending migration scan at every startup', (t) => {
  const { db, ledger } = fixture(t);
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  ledger.begin(run('purged'), target, 'usage');
  db.exec("UPDATE usage_runs SET value=json_remove(value,'$.account')");
  ledger.historyImport([target]);
  let pendingScans = 0;
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => {
    if (sql.includes('LEFT JOIN usage_runs')) pendingScans++;
    return prepare(sql);
  });
  for (let restart = 0; restart < 3; restart++)
    assert.equal(new UsageLedger(db).historyImport([target]).importedRuns, 0);
  assert.equal(pendingScans, 0);
  assert.equal(ledger.accountsByRun().get('purged')?.source, 'unrecorded');
});

test('history import rolls back initial rows and checkpoint after a usage write fails, then retries fully', (t) => {
  const { db, ledger } = fixture(t);
  ledger.record(run('preserved'), target, event({ eventId: 'preserved', totalTokens: 5 }));
  const cached = ledger.report();
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT);
    CREATE TRIGGER fail_history_usage BEFORE INSERT ON usage_events BEGIN
      SELECT RAISE(ABORT, 'synthetic usage write failure');
    END;`);
  const task = run('retry-history', { events: [event({ eventId: 'retry-event', totalTokens: 4 })] });
  db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(task));
  assert.throws(() => ledger.historyImport([target]), /synthetic usage write failure/);
  assert.equal(db.prepare('SELECT id FROM usage_runs WHERE id=?').get(task.id), undefined);
  assert.equal(db.prepare('SELECT run_id FROM usage_events WHERE run_id=?').get(task.id), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='usage_history_state'").get(), undefined);
  const afterFailure = ledger.report();
  assert.notEqual(afterFailure, cached);
  assert.equal(afterFailure.totals.totalTokens, 5);
  assert.equal(afterFailure.totals.runs, 1);
  db.exec('DROP TRIGGER fail_history_usage');
  assert.equal(ledger.historyImport([target]).importedRuns, 1);
  const imported = ledger.report().perRun.find((row) => row.runId === task.id)!;
  assert.equal(imported.totalTokens, 4);
  assert.equal(imported.eventCount, 1);
  assert.equal(ledger.report().totals.totalTokens, 9);
  const state = db.prepare('SELECT revision,imported_revision FROM usage_history_state').get() as {
    revision: number;
    imported_revision: number;
  };
  assert.equal(state.revision, state.imported_revision);
  assert.equal(new UsageLedger(db).historyImport([target]).importedRuns, 0);
  assert.equal(ledger.report().totals.totalTokens, 9);
});

test('startup reconciliation uses summaries for existing usage and full events only for missing usage', (t) => {
  const { db, ledger } = fixture(t);
  db.exec(
    'CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT, value TEXT); CREATE TABLE run_summaries(id TEXT PRIMARY KEY, started_at TEXT, value TEXT)',
  );
  const existing = run('existing', { status: 'completed', output: 'ARCHIVED_BODY_SENTINEL'.repeat(10000) });
  const missing = run('missing', { status: 'completed', events: [event({ totalTokens: 17 })] });
  ledger.begin(existing, target, 'usage');
  for (const task of [existing, missing]) {
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run(task.id, task.startedAt, JSON.stringify(task));
    db.prepare('INSERT INTO run_summaries VALUES(?,?,?)').run(
      task.id,
      task.startedAt,
      JSON.stringify({ ...task, events: [], output: '', summary: true }),
    );
  }
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, ...args: []) => {
    assert.ok(!text.includes('ARCHIVED_BODY_SENTINEL'), 'existing archived body must not enter the startup parser');
    return parse(text, ...args);
  });
  assert.equal(ledger.historyImport([target]).importedRuns, 1);
  assert.equal(ledger.report().totals.totalTokens, 17);
});
