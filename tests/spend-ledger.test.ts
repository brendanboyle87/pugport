process.env.TZ = 'America/New_York';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { UsageLedger } from '../src/server/usage.ts';
import { accountKey } from '../src/server/quota-history.ts';
import {
  SpendLedger,
  SpendService,
  buildSpendDetails,
  buildSpendOverview,
  localDays,
  spendAccountKey,
  type SpendLiveAccount,
  type SpendOverviewInput,
} from '../src/server/spend-ledger.ts';
import type { SpendAccountSnapshot } from '../src/shared/spend-ledger.ts';
import type { ApiBudgetPolicy, ApiBudgetView } from '../src/shared/api-providers.ts';
import type { RunRecord, RuntimeSnapshot, RuntimeTarget, Workflow } from '../src/shared/types.ts';
import type { UsageReport, UsageRun } from '../src/shared/usage.ts';

/* All data is synthetic. No providers, accounts or services are called. */

const day = 86_400_000;
const now = new Date('2026-11-03T17:00:00.000Z'); // 12:00 in New York, two days after DST ended.

function db(t: TestContext) {
  const value = new DatabaseSync(':memory:');
  t.after(() => value.close());
  return value;
}
const target = (id: string, extra: Partial<RuntimeTarget> = {}): RuntimeTarget => ({
  id,
  provider: 'codex',
  label: `Card ${id}`,
  command: 'unused',
  environment: 'native',
  enabled: true,
  ...extra,
});
const runRecord = (id: string, runtimeId: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  prompt: 'synthetic',
  projectPath: '/fixture/one',
  kind: 'routine',
  status: 'completed',
  route: { runtimeId, model: 'model-a', kind: 'routine', reasons: [], warnings: [] },
  startedAt: '2026-11-02T15:00:00.000Z',
  output: '',
  events: [],
  ...extra,
});

test('usage runs fix their account at launch: deduped by login, never rewritten, unknown kept apart', (t) => {
  const ledger = new UsageLedger(db(t));
  const fingerprint = 'synthetic-login-fingerprint';
  ledger.begin(
    runRecord('r1', 'codex-a', {
      account: { id: 'codex-a', label: 'Codex — Plus 1', provider: 'codex', fingerprint },
    }),
    { ...target('codex-a'), provider: 'codex' },
    'subscription',
  );
  // Same login on a second runtime: same account row.
  ledger.begin(
    runRecord('r2', 'codex-b', {
      route: {
        runtimeId: 'codex-b',
        model: 'm',
        kind: 'routine',
        reasons: [],
        warnings: [],
        accountFingerprint: fingerprint,
      },
    }),
    { ...target('codex-b'), provider: 'codex' },
    'subscription',
  );
  ledger.begin(
    runRecord('r3', 'api-x', { executionKind: 'api', apiProvider: 'openai' }),
    { ...target('api-x', { gateway: 'api' }), provider: 'pi' },
    'usage',
  );
  ledger.begin(runRecord('r4', 'grok-a'), { ...target('grok-a'), provider: 'grok' }, 'subscription');
  // Rebinding codex-a to another login later does not rewrite r1 (begin runs again on every event).
  ledger.begin(
    runRecord('r1', 'codex-a', {
      account: { id: 'codex-a', label: 'Renamed', provider: 'codex', fingerprint: 'another-login' },
    }),
    { ...target('codex-a', { label: 'Renamed' }), provider: 'codex' },
    'subscription',
  );
  const accounts = ledger.accountsByRun();
  const key = `acct:${accountKey(fingerprint)}`;
  assert.equal(accounts.get('r1')?.key, key);
  assert.equal(accounts.get('r1')?.label, 'Codex — Plus 1');
  assert.equal(accounts.get('r2')?.key, key);
  assert.equal(accounts.get('r3')?.key, 'api:api-x');
  assert.equal(accounts.get('r4')?.key, 'unrecorded:grok-a');
  // The raw fingerprint is never stored in a key and the snapshot is not part of UsageRun (or /api/state).
  assert.ok(![...accounts.values()].some((value) => JSON.stringify(value).includes(fingerprint)));
  assert.ok(ledger.report().perRun.every((row) => !('account' in row)));
  assert.equal(JSON.stringify(ledger.stateReport()).includes('acct:'), false);
  assert.equal(spendAccountKey(fingerprint, 'cli', 'codex-z'), key);
});

test('history import snapshots a deleted target from the run itself and backfills older ledger rows', (t) => {
  const database = db(t);
  database.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL)');
  const insert = (run: RunRecord) =>
    database
      .prepare('INSERT INTO runs(id,started_at,value) VALUES(?,?,?)')
      .run(run.id, run.startedAt, JSON.stringify(run));
  insert(
    runRecord('old-1', 'removed-card', {
      account: { id: 'removed-card', label: 'Deleted card', provider: 'claude', fingerprint: 'fp-deleted' },
    }),
  );
  insert(runRecord('old-2', 'removed-card-2'));
  const ledger = new UsageLedger(database);
  ledger.historyImport([]);
  assert.equal(ledger.accountsByRun().get('old-1')?.key, `acct:${accountKey('fp-deleted')}`);
  assert.equal(ledger.accountsByRun().get('old-1')?.label, 'Deleted card');
  assert.equal(ledger.accountsByRun().get('old-2')?.key, 'unrecorded:removed-card-2');

  // A ledger row written before snapshots existed is picked up by the pending check and backfilled once.
  const row = database.prepare("SELECT value FROM usage_runs WHERE id='old-1'").get() as { value: string };
  const value = JSON.parse(row.value) as Record<string, unknown>;
  delete value.account;
  database.prepare("UPDATE usage_runs SET value=? WHERE id='old-1'").run(JSON.stringify(value));
  // Simulate upgrading an unchanged pre-Spend database whose import revision was already checkpointed.
  database.exec('UPDATE usage_history_state SET imported_revision=revision');
  const again = new UsageLedger(database);
  again.historyImport([target('removed-card', { accountFingerprint: 'rebound-later' })]);
  assert.equal(again.accountsByRun().get('old-1')?.key, `acct:${accountKey('fp-deleted')}`);
});

const policy = (extra: Partial<ApiBudgetPolicy> = {}): ApiBudgetPolicy => ({
  limitUsd: 50,
  perRunUsd: 1,
  maxConcurrentRuns: 2,
  burstConcurrentRuns: 3,
  preferExpiring: false,
  startedAt: '2026-10-07T00:00:00.000Z',
  expiresAt: '2026-11-07T00:00:00.000Z',
  monthlyUsd: 50,
  ...extra,
});

test('spend ledger records periods, adjustments, renewals with lapse, removal and idempotent extra usage', (t) => {
  const database = db(t);
  const usage = new UsageLedger(database);
  usage.begin(
    runRecord('u1', 'api-x', { startedAt: '2026-10-20T12:00:00.000Z', executionKind: 'api' }),
    { ...target('api-x', { gateway: 'api' }), provider: 'pi' },
    'usage',
  );
  database.prepare("UPDATE usage_runs SET value=json_set(value,'$.estimatedCostUsd',12) WHERE id='u1'").run();
  const ledger = new SpendLedger(database, () => now.getTime());
  const first = policy();
  ledger.recordBudget('api-x', undefined, first, 'created');
  ledger.recordBudget('api-x', first, { ...first, limitUsd: 60 }, 'edit');
  ledger.recordBudget('api-x', first, { ...first, limitUsd: 60 }, 'edit', now.getTime() + 1);
  ledger.recordExtraUsage('api-x', first, { tokens: 10, costUsd: 3, calls: 1 });
  ledger.recordExtraUsage('api-x', first, { tokens: 10, costUsd: 3, calls: 1 }); // replay: ignored
  const renewed = { ...first, startedAt: first.expiresAt!, expiresAt: '2026-12-07T00:00:00.000Z' };
  ledger.recordBudget('api-x', first, renewed, 'renewal');
  ledger.recordBudget('api-x', first, renewed, 'renewal'); // idempotent
  ledger.recordBudget('api-x', renewed, undefined);
  const entries = ledger.entries('api-x').reverse();
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['period-start', 'adjustment', 'adjustment', 'extra-usage', 'expiry', 'renewal', 'removed'],
  );
  const expiry = entries.find((entry) => entry.kind === 'expiry')!;
  assert.equal(expiry.data.spentUsd, 15); // 12 from the run + 3 extra, each once
  assert.equal(expiry.data.lapsedUsd, 35);
  assert.equal(ledger.extraUsd('api-x', 0, now.getTime() + 1), 3);
  assert.ok(entries.every((entry) => !JSON.stringify(entry).includes('fingerprint')));
});

test('two different budget adjustments in the same millisecond are not lost', (t) => {
  const ledger = new SpendLedger(db(t), () => now.getTime());
  ledger.recordBudget('api-x', policy({ limitUsd: 10 }), policy({ limitUsd: 20 }));
  ledger.recordBudget('api-x', policy({ limitUsd: 20 }), policy({ limitUsd: 30 }));
  assert.equal(ledger.entries('api-x').filter((e) => e.kind === 'adjustment').length, 2);
});

const quotaSnapshot = (id: string, used: number, at: string, resetsAt: string): RuntimeSnapshot =>
  ({
    id,
    provider: 'codex',
    label: id,
    status: 'ready',
    accountFingerprint: 'fp-quota',
    quota: {
      status: 'known',
      observedAt: at,
      windows: [{ id: 'week', label: 'Weekly', usedPercent: used, resetsAt, observedAt: at }],
    },
  }) as unknown as RuntimeSnapshot;

test('quota readings are throttled, split at resets, and only count increases within 7 days', (t) => {
  const ledger = new SpendLedger(db(t), () => now.getTime());
  const reset1 = '2026-11-02T00:00:00.000Z',
    reset2 = '2026-11-09T00:00:00.000Z';
  const h = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  ledger.observeQuota([quotaSnapshot('codex-a', 10, h(60), reset1)]);
  ledger.observeQuota([quotaSnapshot('codex-a', 10.1, h(59.9), reset1)]); // throttled
  ledger.observeQuota([quotaSnapshot('codex-a', 40, h(48), reset1)]);
  // Reset: usage falls. The drop is not negative use and the gap across the reset is not counted.
  ledger.observeQuota([quotaSnapshot('codex-a', 2, h(36), reset2)]);
  ledger.observeQuota([quotaSnapshot('codex-a', 14, h(12), reset2)]);
  const readings = ledger.entries('codex-a').filter((entry) => entry.kind === 'quota-reading');
  assert.equal(readings.length, 4);
  const pace = ledger.quotaPace('codex-a', 'week', now.getTime() - 7 * day, now.getTime())!;
  // (30 + 12) points over (12 + 24) hours of same-period readings.
  assert.ok(Math.abs(pace - (42 / 36) * 24) < 1e-9, String(pace));
  assert.equal(ledger.quotaPace('codex-b', 'week', now.getTime() - 7 * day, now.getTime()), null);
});

test('rebinding a quota runtime cannot borrow the previous login burn rate', (t) => {
  const ledger = new SpendLedger(db(t), () => now.getTime());
  const reset = '2026-11-09T00:00:00.000Z';
  const h = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  ledger.observeQuota([quotaSnapshot('codex-a', 10, h(48), reset)]);
  ledger.observeQuota([quotaSnapshot('codex-a', 60, h(24), reset)]);
  ledger.observeQuota([{ ...quotaSnapshot('codex-a', 60, h(23.9), reset), accountFingerprint: 'new-login' }]);
  assert.equal(ledger.entries('codex-a').length, 3, 'identity change bypasses throttle');
  assert.equal(ledger.quotaPace('codex-a', 'week', now.getTime() - 7 * day), null);
  ledger.observeQuota([{ ...quotaSnapshot('codex-a', 62, h(11.9), reset), accountFingerprint: 'new-login' }]);
  assert.equal(ledger.quotaPace('codex-a', 'week', now.getTime() - 7 * day), 4);
});

const usageRun = (id: string, extra: Partial<UsageRun> = {}): UsageRun => ({
  runId: id,
  projectPath: '/fixture/one',
  runtimeId: 'api-x',
  runtimeLabel: 'API X',
  provider: 'pi',
  model: 'model-a',
  executionKind: 'api',
  accountingMode: 'usage',
  status: 'completed',
  startedAt: '2026-11-03T14:00:00.000Z',
  endedAt: '2026-11-03T14:00:05.000Z',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningOutputTokens: null,
  totalTokens: 15,
  estimatedCostUsd: 1,
  eventCount: 1,
  historyImported: false,
  uncertain: false,
  sources: [],
  notes: [],
  ...extra,
});
const workflow = (id: string, extra: Partial<Workflow> = {}): Workflow =>
  ({
    id,
    conversationId: `c-${id}`,
    projectId: 'p1',
    status: 'completed',
    createdAt: '2026-11-03T13:00:00.000Z',
    updatedAt: '2026-11-03T13:00:00.000Z',
    input: { content: `Task ${id}` },
    runIds: [],
    ...extra,
  }) as unknown as Workflow;
const report = (perRun: UsageRun[]): UsageReport =>
  ({ generatedAt: now.toISOString(), filters: {}, perRun, note: 'synthetic' }) as unknown as UsageReport;
const budgetView = (extra: Partial<ApiBudgetPolicy> = {}, remainingUsd = 30): ApiBudgetView => ({
  policy: policy({ preferExpiring: true, ...extra }),
  spentUsd: 20,
  reservedUsd: 0,
  remainingUsd,
  unreportedRuns: 0,
  phase: 'priority',
  maxConcurrentRuns: 2,
});

function fixtureInput(): SpendOverviewInput {
  const fp = `acct:${accountKey('fp-sub')}`;
  const runs: UsageRun[] = [
    usageRun('a1', { workflowId: 'w1', estimatedCostUsd: 4 }),
    usageRun('a2', { workflowId: 'w1', estimatedCostUsd: null }), // cost unknown, not zero
    usageRun('a3', { workflowId: 'w2', estimatedCostUsd: 2, startedAt: '2026-10-31T15:00:00.000Z' }),
    // API executor billed as subscription (accountingMode decides billing, not executionKind).
    usageRun('s0', {
      runtimeId: 'api-sub',
      runtimeLabel: 'API sub',
      accountingMode: 'subscription',
      estimatedCostUsd: 9,
    }),
    usageRun('s1', {
      runtimeId: 'codex-a',
      runtimeLabel: 'Codex A',
      executionKind: 'cli',
      accountingMode: 'subscription',
      estimatedCostUsd: 7,
      workflowId: 'w3',
    }),
    usageRun('s2', {
      runtimeId: 'codex-b',
      runtimeLabel: 'Codex B',
      executionKind: 'cli',
      accountingMode: 'subscription',
      estimatedCostUsd: 3,
      startedAt: '2026-11-01T15:00:00.000Z',
    }),
    usageRun('u1', {
      runtimeId: 'grok-a',
      runtimeLabel: 'Grok',
      executionKind: 'cli',
      accountingMode: 'unknown',
      estimatedCostUsd: null,
      status: 'failed',
      errorCode: 'rate_limit',
    }),
    usageRun('old', { startedAt: '2026-08-01T15:00:00.000Z', estimatedCostUsd: 100 }),
    ...Array.from({ length: 8 }, (_, index) =>
      usageRun(`t${index}`, { workflowId: `wt${index}`, estimatedCostUsd: index / 10 }),
    ),
  ];
  const accounts = new Map<string, SpendAccountSnapshot>();
  for (const run of runs)
    accounts.set(
      run.runId,
      run.runtimeId.startsWith('codex')
        ? { key: fp, label: 'Codex — Plus 1', provider: 'codex', source: 'login' }
        : run.runtimeId.startsWith('api')
          ? { key: `api:${run.runtimeId}`, label: run.runtimeLabel, provider: 'pi', source: 'api-card' }
          : { key: `unrecorded:${run.runtimeId}`, label: run.runtimeLabel, provider: 'grok', source: 'unrecorded' },
    );
  const live: SpendLiveAccount[] = [
    {
      runtimeId: 'api-x',
      label: 'API X',
      provider: 'pi',
      accountKey: 'api:api-x',
      accountingMode: 'usage',
      executionKind: 'api',
      budget: budgetView(),
    },
    {
      runtimeId: 'codex-a',
      label: 'Codex A',
      provider: 'codex',
      accountKey: fp,
      accountingMode: 'subscription',
      executionKind: 'cli',
      quotaWindows: [{ id: 'week', label: 'Weekly', usedPercent: 82, resetsAt: '2026-11-04T23:00:00.000Z' }],
    },
    {
      runtimeId: 'codex-b',
      label: 'Codex B',
      provider: 'codex',
      accountKey: fp,
      accountingMode: 'subscription',
      executionKind: 'cli',
      quotaWindows: [{ id: 'week', label: 'Weekly', usedPercent: 60, resetsAt: '2026-11-04T23:00:00.000Z' }],
    },
    {
      runtimeId: 'grok-a',
      label: 'Grok',
      provider: 'grok',
      accountKey: 'unrecorded:grok-a',
      accountingMode: 'subscription',
      executionKind: 'cli',
    },
  ];
  return {
    report: report(runs),
    accounts,
    workflows: [
      workflow('w1'),
      workflow('w2'),
      workflow('w3'),
      ...Array.from({ length: 8 }, (_, i) => workflow(`wt${i}`)),
    ],
    projects: [],
    live,
    now,
  };
}

test('local calendar has 56 midnight-aligned days across the DST change', () => {
  const { days, starts, end } = localDays(now);
  assert.equal(days.length, 56);
  assert.equal(days[55], '2026-11-03');
  assert.equal(new Set(days).size, 56);
  assert.ok(days.includes('2026-11-01'));
  for (const start of [...starts, end]) assert.equal(new Date(start).getHours(), 0);
  const dstDay = days.indexOf('2026-11-01');
  assert.equal(starts[dstDay + 1]! - starts[dstDay]!, 25 * 3_600_000);
});

test('overview returns aggregates only, bills by accountingMode, keeps unknown cost unknown', () => {
  const input = fixtureInput();
  const overview = buildSpendOverview(input, { range: '7d' });
  const json = JSON.stringify(overview);
  assert.equal(json.includes('failureRunIds'), false);
  assert.equal(json.includes('"perRun"'), false);
  assert.ok(overview.insights.tasks.length <= 6);
  assert.deepEqual(overview.insights.tasks.map((task) => task.taskId).slice(0, 2), ['w1', 'w2']);
  assert.equal(overview.insights.tasks[0]!.billedUsd, 4);
  assert.equal(overview.insights.tasks[0]!.missingCost, 1);
  assert.equal(overview.insights.tasks[0]!.traceWorkflowId, 'w1');
  assert.equal(overview.days.length, 56);
  assert.equal(overview.today, '2026-11-03');
  // Billing split by accountingMode; subscription work is reference only; credit = expiring budget card.
  assert.equal(overview.billing.subscription.runs, 3);
  assert.equal(overview.billing.subscription.billedUsd, null);
  assert.equal(overview.billing.subscription.referenceUsd, 19);
  assert.equal(overview.billing.credit.runs, 11);
  assert.equal(overview.billing.unknown.runs, 1);
  assert.equal(overview.billing.unknown.billedUsd, null);
  // Ledger rows: the shared login is one row across two runtimes, unknown account has its own row.
  const codex = overview.accounts.find((account) => account.key.startsWith('acct:'))!;
  assert.deepEqual(codex.runtimes.map((runtime) => runtime.id).sort(), ['codex-a', 'codex-b']);
  assert.equal(codex.group, 'subscription');
  assert.equal(codex.period.runs, 2);
  assert.equal(codex.left?.kind, 'quota');
  assert.equal(codex.left?.kind === 'quota' && codex.left.leftPercent, 18); // tightest of both runtimes
  const grok = overview.accounts.find((account) => account.key === 'unrecorded:grok-a')!;
  assert.equal(grok.known, false);
  assert.equal(grok.left?.kind, 'unreported');
  assert.deepEqual(
    overview.runwayUnreported.map((row) => row.accountKey),
    ['unrecorded:grok-a'],
  );
  const api = overview.accounts.find((account) => account.key === 'api:api-x')!;
  assert.equal(api.group, 'credit');
  const today = api.cells[55]!;
  assert.equal(today.runs, 10);
  assert.equal(today.missingCost, 1);
  assert.ok(Math.abs(today.billedUsd! - (4 + 2.8)) < 1e-9);
  assert.equal(api.cells[0], null);
  const grokCell = grok.cells[55]!;
  assert.equal(grokCell.billedUsd, null); // unknown billing never becomes 0
  // Projects ranked by billed only.
  assert.equal(overview.projects[0]!.projectPath, '/fixture/one');
  // Credit runway: 30 left, pace = last 7 days billed / 7; lapse before Nov 7.
  const credit = overview.runway.find((row) => row.kind === 'credit')!;
  assert.equal(credit.paceSource, 'none');
  assert.equal(credit.pacePerDay, null);
  assert.equal(credit.lapseUsd, null);
  assert.equal(credit.endsAt, '2026-11-07T00:00:00.000Z');
  assert.equal(overview.kpis.lapse, null);
  // Quota with no readings or history: shown but not projected.
  const quota = overview.runway.find((row) => row.kind === 'quota')!;
  assert.equal(quota.pacePerDay, null);
  assert.equal(quota.runsOutAt, null);
  assert.equal(quota.paceSource, 'none');
  assert.equal(overview.kpis.tightestQuota?.leftPercent, 18);
  assert.ok(overview.options.accounts.some((option) => option.key === 'unrecorded:grok-a'));
});

test('filters: billing, account and runtime narrow the selection; options stay whole', () => {
  const input = fixtureInput();
  const subscription = buildSpendOverview(input, { billing: 'subscription' });
  assert.equal(subscription.insights.summary.runs, 3);
  assert.equal(subscription.insights.summary.spendUsd, null);
  const account = buildSpendOverview(input, { account: `acct:${accountKey('fp-sub')}` });
  assert.equal(account.insights.summary.runs, 2);
  assert.deepEqual(
    account.accounts.map((row) => row.key),
    [`acct:${accountKey('fp-sub')}`],
  );
  assert.equal(account.options.runtimes.length, 5);
  const cli = buildSpendOverview(input, { kind: 'cli' });
  assert.ok(cli.accounts.every((row) => !row.key.startsWith('api:')));
});

test('unknown credit burn stays unknown while reported zero remains zero', () => {
  const input = fixtureInput();
  for (const run of input.report.perRun) if (run.accountingMode === 'usage') run.estimatedCostUsd = null;
  const unknown = buildSpendOverview(input).runway.find((row) => row.kind === 'credit')!;
  assert.equal(unknown.pacePerDay, null);
  assert.equal(unknown.lapseUsd, null);
  assert.equal(unknown.runsOutAt, null);
  for (const run of input.report.perRun) if (run.accountingMode === 'usage') run.estimatedCostUsd = 0;
  const zero = buildSpendOverview(input).runway.find((row) => row.kind === 'credit')!;
  assert.equal(zero.pacePerDay, 0);
  assert.equal(zero.lapseUsd, zero.left);
});

test('extra usage counts toward the dollar pace once', (t) => {
  const ledger = new SpendLedger(db(t), () => now.getTime());
  ledger.recordExtraUsage('api-x', policy(), { tokens: 1, costUsd: 7, calls: 1 }, now.getTime() - day);
  const input = fixtureInput();
  input.report.perRun.find((run) => run.runId === 'a2')!.estimatedCostUsd = 0;
  const overview = buildSpendOverview({ ...input, ledger }, {});
  const credit = overview.runway.find((row) => row.kind === 'credit')!;
  assert.ok(Math.abs(credit.pacePerDay! - (8.8 + 7) / 7) < 1e-6);
});

test('one missing cost invalidates pace even with reported runs and extra usage', (t) => {
  const input = fixtureInput();
  const ledger = new SpendLedger(db(t), () => now.getTime());
  ledger.recordExtraUsage('api-x', policy(), { tokens: 1, costUsd: 7, calls: 1 }, now.getTime() - day);
  for (const rows of [input.report.perRun, [...input.report.perRun].reverse()]) {
    const view = buildSpendOverview({ ...input, report: { ...input.report, perRun: rows }, ledger });
    const credit = view.runway.find((row) => row.runtimeId === 'api-x')!;
    assert.equal(credit.pacePerDay, null);
    assert.equal(credit.lapseUsd, null);
  }
});

test('cards sharing an account retain separate run and extra usage pace', (t) => {
  const input = fixtureInput();
  input.report.perRun = [
    usageRun('one', { runtimeId: 'api-x', estimatedCostUsd: 7 }),
    usageRun('two', { runtimeId: 'api-y', estimatedCostUsd: 21 }),
  ];
  const snapshot: SpendAccountSnapshot = { key: 'acct:shared', label: 'Shared', provider: 'pi', source: 'login' };
  input.accounts = new Map([
    ['one', snapshot],
    ['two', snapshot],
  ]);
  input.live = ['api-x', 'api-y'].map((runtimeId) => ({
    ...input.live![0]!,
    runtimeId,
    label: runtimeId,
    accountKey: snapshot.key,
  }));
  const ledger = new SpendLedger(db(t), () => now.getTime());
  ledger.recordExtraUsage('api-y', policy(), { tokens: 1, costUsd: 7, calls: 1 }, now.getTime() - day);
  const view = buildSpendOverview({ ...input, ledger });
  assert.equal(view.runway.length, 2);
  assert.equal(view.runway.find((row) => row.runtimeId === 'api-x')!.pacePerDay, 1);
  assert.equal(view.runway.find((row) => row.runtimeId === 'api-y')!.pacePerDay, 4);
});

test('historical credit classification follows recorded periods, adjustments and removal', (t) => {
  const input = fixtureInput();
  const ledger = new SpendLedger(db(t), () => now.getTime());
  const start = Date.parse('2026-10-31T00:00:00Z');
  const end = Date.parse('2026-11-02T00:00:00Z');
  const credit = policy({ startedAt: new Date(start).toISOString(), expiresAt: '2026-12-01T00:00:00Z' });
  ledger.recordBudget('api-x', undefined, credit, 'created', start);
  ledger.recordBudget('api-x', credit, undefined, 'edit', end);
  input.report.perRun = [
    usageRun('before', { startedAt: new Date(start - 1).toISOString(), estimatedCostUsd: 1 }),
    usageRun('during', { startedAt: new Date(start + 1).toISOString(), estimatedCostUsd: 2 }),
    usageRun('after', { startedAt: new Date(end + 1).toISOString(), estimatedCostUsd: 3 }),
  ];
  const view = buildSpendOverview({ ...input, ledger }, { range: '7d' });
  assert.equal(view.billing.credit.runs, 1);
  assert.equal(view.billing.credit.billedUsd, 2);
  assert.equal(view.billing.usage.runs, 2);
  assert.equal(view.billing.usage.billedUsd, 4);
  const classify = ledger.creditClassifier();
  assert.equal(classify('api-x', start), true);
  assert.equal(classify('api-x', end), false);
  const service = new SpendService({
    report: () => input.report,
    accounts: () => input.accounts,
    workflows: () => input.workflows,
    revision: () => 1,
    projects: () => input.projects,
    live: () => input.live!,
    ledger,
    now: () => now,
  });
  service.overview();
  const replacement = policy({ startedAt: new Date(end).toISOString(), expiresAt: '2026-12-01T00:00:00Z' });
  ledger.recordBudget('api-x', undefined, replacement, 'created', end + 1);
  const updated = service.overview();
  assert.equal(service.stats().misses, 2);
  assert.equal(updated.billing.credit.runs, 2);
  ledger.recordBudget(
    'api-x',
    replacement,
    { ...replacement, expiresAt: undefined, monthlyUsd: undefined },
    'edit',
    end + 2,
  );
  assert.equal(ledger.creditClassifier()('api-x', end + 3), false);
});

test('renewal and expiry preserve unknown lapsed amounts when period costs are missing', (t) => {
  const database = db(t),
    usage = new UsageLedger(database);
  usage.begin(
    runRecord('missing', 'api-x', { executionKind: 'api', startedAt: '2026-10-20T12:00:00Z' }),
    target('api-x', { gateway: 'api' }),
    'usage',
  );
  const ledger = new SpendLedger(database, () => now.getTime());
  const first = policy();
  ledger.recordBudget('api-x', first, { ...first, startedAt: first.expiresAt! }, 'renewal');
  const expiry = ledger.entries('api-x').find((entry) => entry.kind === 'expiry')!;
  assert.equal(expiry.data.lapsedUsd, null);
  ledger.recordExpiry('other', { ...budgetView(), unreportedRuns: 1, phase: 'expired' });
  assert.equal(ledger.entries('other')[0]!.data.lapsedUsd, null);
});

test('details are paged by task, project or run; day and failure narrow; limit is bounded', () => {
  const input = fixtureInput();
  const tasks = buildSpendDetails(input, { group: 'task', range: '7d', offset: 0, limit: 3 });
  assert.equal(tasks.total, 11);
  assert.equal(tasks.tasks.length, 3);
  assert.equal(tasks.nextOffset, 3);
  assert.deepEqual(tasks.report.perRun, []);
  const runs = buildSpendDetails(input, { group: 'run', day: '2026-11-01', offset: 0, limit: 10 });
  assert.deepEqual(
    runs.report.perRun.map((run) => run.runId),
    ['s2'],
  );
  assert.equal(runs.interval.from, new Date(2026, 10, 1).toISOString());
  const failures = buildSpendDetails(input, { group: 'run', failure: 'rate-limit', offset: 0, limit: 10 });
  assert.deepEqual(
    failures.report.perRun.map((run) => run.runId),
    ['u1'],
  );
  const projects = buildSpendDetails(input, { group: 'project', range: 'all', offset: 0, limit: 10 });
  assert.ok(Math.abs(projects.projects[0]!.billedUsd! - 108.8) < 1e-9);
  assert.throws(() => buildSpendDetails(input, { limit: 201 }));
  assert.throws(() => buildSpendDetails(input, { day: '11/01/2026' }));
});

test('SpendService caches aggregates by revision and filters, reloads workflows only on revision change', () => {
  const input = fixtureInput();
  let revision = 1;
  let workflowLoads = 0;
  let live = input.live!;
  const service = new SpendService({
    report: () => input.report,
    accounts: () => input.accounts,
    workflows: () => {
      workflowLoads++;
      return input.workflows;
    },
    revision: () => revision,
    projects: () => [],
    live: () => live,
    now: () => now,
  });
  const cold = service.overview({ range: '7d' });
  const warm = service.overview({ range: '7d' });
  assert.deepEqual(warm, cold);
  assert.equal(service.stats().hits, 1);
  assert.equal(service.stats().misses, 1);
  service.overview({ range: '30d' });
  assert.equal(service.stats().misses, 2);
  service.details({ group: 'run', offset: 0, limit: 5 });
  assert.equal(workflowLoads, 1);
  // What is left is live even on a cache hit.
  live = live.map((item) => (item.budget ? { ...item, budget: budgetView({}, 10) } : item));
  const fresh = service.overview({ range: '7d' });
  assert.equal(service.stats().hits, 2);
  assert.equal(fresh.runway.find((row) => row.kind === 'credit')!.left, 10);
  revision = 2;
  service.overview({ range: '7d' });
  assert.equal(workflowLoads, 2);
  assert.equal(service.stats().misses, 3);
});

test('runs either side of local midnight land on their own local days; project filter matches details', () => {
  const input = fixtureInput();
  const late = usageRun('late', { startedAt: '2026-11-03T04:30:00.000Z', projectPath: '/fixture/two' }); // Nov 2, 23:30 EST
  const early = usageRun('early', { startedAt: '2026-11-03T05:30:00.000Z', projectPath: '/fixture/two' }); // Nov 3, 00:30 EST
  for (const run of [late, early])
    (input.accounts as Map<string, SpendAccountSnapshot>).set(run.runId, {
      key: 'api:api-x',
      label: 'API X',
      provider: 'pi',
      source: 'api-card',
    });
  input.report.perRun.push(late, early);
  const overview = buildSpendOverview(input, { project: '/fixture/two/' });
  const row = overview.accounts.find((account) => account.key === 'api:api-x')!;
  assert.equal(row.cells[54]?.runs, 1);
  assert.equal(row.cells[55]?.runs, 1);
  assert.equal(overview.insights.summary.runs, 2);
  assert.deepEqual(
    overview.projects.map((project) => project.projectPath),
    ['/fixture/two'],
  );
  // Configured accounts without runs are not added under a project filter.
  assert.deepEqual(
    overview.accounts.map((account) => account.key),
    ['api:api-x'],
  );
  const details = buildSpendDetails(input, { group: 'run', project: '/fixture/two', range: '7d', offset: 0, limit: 1 });
  assert.equal(details.total, 2);
  assert.equal(details.report.perRun.length, 1);
  assert.equal(details.nextOffset, 1);
  assert.equal(details.report.totals.runs, 2);
  const day = buildSpendDetails(input, {
    group: 'run',
    project: '/fixture/two',
    day: '2026-11-02',
    offset: 0,
    limit: 10,
  });
  assert.deepEqual(
    day.report.perRun.map((run) => run.runId),
    ['late'],
  );
});
