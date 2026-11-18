import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { apiCreditPace, type ApiBudgetPolicy, type ApiBudgetView } from '../shared/api-providers.ts';
import { quotaOverviewWindows } from '../shared/quota-summary.ts';
import {
  spendDetailsMaxLimit,
  spendHeatmapDays,
  spendTopTasks,
  type SpendAccount,
  type SpendAccountSnapshot,
  type SpendBillingSplit,
  type SpendCell,
  type SpendDetails,
  type SpendDetailsQuery,
  type SpendFilters,
  type SpendGroup,
  type SpendInsights,
  type SpendKpis,
  type SpendLedgerEntry,
  type SpendLedgerKind,
  type SpendLeft,
  type SpendOverview,
  type SpendProject,
  type SpendRunway,
  type SpendTask,
  type SpendTotals,
} from '../shared/spend-ledger.ts';
import { isApiHarness } from '../shared/provider-registry.ts';
import type { Project, QuotaWindow, RuntimeSnapshot, RuntimeTarget, Workflow } from '../shared/types.ts';
import { failureTypes, type FailureType } from '../shared/usage-insights.ts';
import {
  usageMetricKeys,
  type AccountingMode,
  type UsageAggregate,
  type UsageMetric,
  type UsageProvider,
  type UsageReport,
  type UsageRun,
} from '../shared/usage.ts';
import { accountKey, type BurnRates } from './quota-history.ts';
import { failureType, usageInsights } from './usage-insights.ts';

/*
 * Usage › Spend. Two parts:
 * - SpendLedger: a small table of budget, credit and quota periods (start, adjustment, renewal, expiry, removal,
 *   extra usage outside runs, throttled quota readings). It never holds run costs, so nothing is counted twice.
 * - buildSpendOverview / buildSpendDetails / SpendService: aggregates by local calendar day for the overview,
 *   paged rows for details. The aggregate part is cached; what is left and the runway are computed per request.
 */

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const keepReadings = 120 * day;
const pathKey = (value: string) =>
  /^[a-z]:[\\/]/i.test(value)
    ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : value.replace(/\/+$/, '') || '/';
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const addNullable = (total: number | null, value: number | null | undefined) =>
  numeric(value) ? (total ?? 0) + value : total;

/* ------------------------------------------------------------------------------------------------------------ */
/* Ledger of budget, credit and quota periods                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

type LedgerData = SpendLedgerEntry['data'];
export const apiPeriodId = (targetId: string, policy: Pick<ApiBudgetPolicy, 'startedAt'>) =>
  `${targetId}@${policy.startedAt}`;

export class SpendLedger {
  private readonly lastReading = new Map<string, { at: number; used: number; resetsAt: number; account: string }>();
  private readonly recorded = new Set<string>();
  private prunedAt = 0;
  /** Bumped on every write; part of no cache key (runway is computed per request) but useful to tests. */
  version = 0;
  constructor(
    readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS spend_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL,
      period_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS spend_ledger_runtime ON spend_ledger(runtime_id,kind,at);`);
  }

  /** History is a report: a failed write never stops a budget change or a quota refresh. Returns true when written. */
  record(
    runtimeId: string,
    periodId: string,
    kind: SpendLedgerKind,
    data: LedgerData,
    dedupe?: string,
    at = this.now(),
  ) {
    const key =
      dedupe ??
      `${kind}:${periodId}:${at}:${createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)}`;
    if (this.recorded.has(key)) return false;
    try {
      const result = this.db
        .prepare('INSERT OR IGNORE INTO spend_ledger(runtime_id,period_id,kind,at,data,dedupe) VALUES(?,?,?,?,?,?)')
        .run(runtimeId, periodId, kind, at, JSON.stringify(data), key);
      this.recorded.add(key);
      if (this.recorded.size > 5000) this.recorded.clear();
      if (result.changes) this.version++;
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  private policyData(policy: ApiBudgetPolicy): LedgerData {
    return {
      limitUsd: policy.limitUsd ?? null,
      monthlyUsd: policy.monthlyUsd ?? null,
      expiresAt: policy.expiresAt ?? null,
      startedAt: policy.startedAt,
      preferExpiring: policy.preferExpiring,
      linked: policy.linkedAccountId ? true : false,
    };
  }

  /** Replay small policy events once per overview, never consult the card's present policy for old runs. */
  creditClassifier(): (runtimeId: string, at: number) => boolean {
    const periods = new Map<string, Array<{ from: number; to: number; credit: boolean }>>();
    const states = new Map<string, LedgerData>();
    const events = this.db
      .prepare(
        "SELECT runtime_id,kind,at,data FROM spend_ledger WHERE kind IN ('period-start','renewal','adjustment','removed','expiry') ORDER BY at,seq",
      )
      .all() as Array<{ runtime_id: string; kind: string; at: number; data: string }>;
    for (const event of events) {
      const data = JSON.parse(event.data) as LedgerData;
      const list = periods.get(event.runtime_id) ?? [];
      const previous = states.get(event.runtime_id) ?? {};
      const state = event.kind === 'adjustment' ? { ...previous, ...data } : data;
      const from =
        event.kind === 'period-start' || event.kind === 'renewal' ? Date.parse(String(state.startedAt)) : event.at;
      if (!Number.isFinite(from)) continue;
      const last = list.at(-1);
      if (last) last.to = Math.min(last.to, from);
      if (event.kind !== 'removed' && event.kind !== 'expiry') {
        const expiry = Date.parse(String(state.expiresAt));
        list.push({
          from,
          to: Number.isFinite(expiry) ? expiry : Infinity,
          credit: !!state.expiresAt || !!state.monthlyUsd,
        });
        states.set(event.runtime_id, state);
      } else states.delete(event.runtime_id);
      periods.set(event.runtime_id, list);
    }
    return (runtimeId, at) =>
      (periods.get(runtimeId) ?? []).some((period) => period.credit && at >= period.from && at < period.to);
  }

  /** Spent in a period from the run ledger (usage-billed only) plus extra usage recorded for it. */
  periodSpent(targetId: string, policy: ApiBudgetPolicy, until = this.now()): number | null {
    let spent = 0;
    try {
      const row = this.db
        .prepare(
          `SELECT SUM(json_extract(value,'$.estimatedCostUsd')) AS usd, SUM(CASE WHEN json_extract(value,'$.estimatedCostUsd') IS NULL THEN 1 ELSE 0 END) AS missing FROM usage_runs
          WHERE json_extract(value,'$.runtimeId')=? AND json_extract(value,'$.accountingMode')='usage' AND started_at>=? AND started_at<?`,
        )
        .get(targetId, policy.startedAt, new Date(until).toISOString()) as
        { usd: number | null; missing: number } | undefined;
      if (row?.missing) return null;
      spent += row?.usd ?? 0;
    } catch {
      /* No usage table in an isolated ledger. */
    }
    spent += this.extraUsd(targetId, Date.parse(policy.startedAt), until, apiPeriodId(targetId, policy));
    return spent;
  }

  /** A budget set, changed or removed on a card. `reason` tells a renewal from a user edit. */
  recordBudget(
    targetId: string,
    previous: ApiBudgetPolicy | undefined,
    next: ApiBudgetPolicy | undefined,
    reason: 'edit' | 'renewal' | 'created' = 'edit',
    at = this.now(),
  ) {
    if (!previous && !next) return;
    if (previous && !next) {
      this.record(targetId, apiPeriodId(targetId, previous), 'removed', this.policyData(previous), undefined, at);
      return;
    }
    if (!next) return;
    const nextId = apiPeriodId(targetId, next);
    if (!previous) {
      this.record(targetId, nextId, 'period-start', { ...this.policyData(next), reason }, `start:${nextId}`, at);
      return;
    }
    if (previous.startedAt !== next.startedAt) {
      const previousId = apiPeriodId(targetId, previous);
      if (reason === 'renewal') {
        const limit = previous.limitUsd ?? null;
        const spent = this.periodSpent(targetId, previous, Date.parse(next.startedAt) || at);
        this.record(
          targetId,
          previousId,
          'expiry',
          {
            ...this.policyData(previous),
            spentUsd: spent === null ? null : round(spent),
            lapsedUsd: limit === null || spent === null ? null : round(Math.max(0, limit - spent)),
          },
          `expiry:${previousId}`,
          at,
        );
        this.record(targetId, nextId, 'renewal', this.policyData(next), `start:${nextId}`, at);
      } else this.record(targetId, nextId, 'period-start', { ...this.policyData(next), reason }, `start:${nextId}`, at);
      return;
    }
    const before = this.policyData(previous),
      after = this.policyData(next);
    const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
    if (!changed.length) return;
    const data: LedgerData = { changed: changed.join(',') };
    for (const key of changed) {
      data[`from_${key}`] = before[key] ?? null;
      data[key] = after[key] ?? null;
    }
    this.record(targetId, nextId, 'adjustment', data, undefined, at);
  }

  /** A one-off credit reached its expiry (no renewal follows). Idempotent per period. */
  recordExpiry(targetId: string, view: ApiBudgetView, at = this.now()) {
    if (view.phase !== 'expired') return;
    const id = apiPeriodId(targetId, view.policy);
    this.record(
      targetId,
      id,
      'expiry',
      {
        ...this.policyData(view.policy),
        spentUsd: round(view.spentUsd),
        lapsedUsd: view.unreportedRuns > 0 || view.remainingUsd === undefined ? null : round(view.remainingUsd),
      },
      `expiry:${id}`,
      at,
    );
  }

  /** Usage outside runs (voice tidying). `calls` is the card's lifetime call counter, so a replay is ignored. */
  recordExtraUsage(
    targetId: string,
    policy: ApiBudgetPolicy | undefined,
    usage: { tokens: number; costUsd: number; calls: number },
    at = this.now(),
  ) {
    const periodId = policy ? apiPeriodId(targetId, policy) : `${targetId}@none`;
    this.record(
      targetId,
      periodId,
      'extra-usage',
      { tokens: usage.tokens, costUsd: usage.costUsd },
      `extra:${targetId}:${usage.calls}`,
      at,
    );
  }

  extraUsd(targetId: string, from: number, to = this.now(), periodId?: string): number {
    try {
      const row = this.db
        .prepare(
          `SELECT SUM(json_extract(data,'$.costUsd')) AS usd FROM spend_ledger
          WHERE runtime_id=? AND kind='extra-usage' AND at>=? AND at<?${periodId ? ' AND period_id=?' : ''}`,
        )
        .get(...([targetId, from, to, ...(periodId ? [periodId] : [])] as [string, number, number])) as
        { usd: number | null } | undefined;
      return row?.usd ?? 0;
    } catch {
      return 0;
    }
  }

  /** Throttled quota readings per window: a reading when usage moves, the period changes, or every 30 minutes. */
  observeQuota(snapshots: readonly RuntimeSnapshot[]) {
    try {
      for (const snapshot of snapshots) {
        if (snapshot.quota?.status !== 'known') continue;
        const account = accountKey(snapshot.accountFingerprint);
        for (const window of quotaOverviewWindows(snapshot)) {
          const used = window.usedPercent;
          const at = Date.parse(window.observedAt ?? snapshot.quota.observedAt ?? '');
          const resetsAt = Date.parse(window.resetsAt ?? '');
          if (!numeric(used) || used < 0 || used > 100 || !Number.isFinite(at) || !Number.isFinite(resetsAt)) continue;
          const key = `${snapshot.id}/${window.id}`;
          const last = this.lastReading.get(key) ?? this.latestReading(snapshot.id, window.id);
          if (
            last &&
            last.account === account &&
            at <= last.at + 30 * minute &&
            Math.abs(used - last.used) < 0.5 &&
            Math.abs(resetsAt - last.resetsAt) <= 10 * minute
          )
            continue;
          if (last && at <= last.at) continue;
          const periodId = `${key}@${new Date(resetsAt).toISOString()}`;
          this.record(
            snapshot.id,
            periodId,
            'quota-reading',
            { windowId: window.id, usedPercent: used, resetsAt: new Date(resetsAt).toISOString(), account },
            `q:${key}@${at}`,
            at,
          );
          this.lastReading.set(key, { at, used, resetsAt, account });
        }
      }
      if (this.now() - this.prunedAt >= day) {
        this.prunedAt = this.now();
        this.db.prepare("DELETE FROM spend_ledger WHERE kind='quota-reading' AND at<?").run(this.now() - keepReadings);
      }
    } catch {
      /* The next reading tries again. */
    }
  }

  private latestReading(runtimeId: string, windowId: string) {
    const row = this.db
      .prepare(
        `SELECT at, json_extract(data,'$.usedPercent') AS used, json_extract(data,'$.resetsAt') AS resetsAt,
          json_extract(data,'$.account') AS account
        FROM spend_ledger WHERE runtime_id=? AND kind='quota-reading' AND json_extract(data,'$.windowId')=?
        ORDER BY at DESC LIMIT 1`,
      )
      .get(runtimeId, windowId) as { at: number; used: number; resetsAt: string; account: string } | undefined;
    return row ? { at: row.at, used: row.used, resetsAt: Date.parse(row.resetsAt), account: row.account } : undefined;
  }

  /**
   * Percent of a window used per day over [from, to): increases between consecutive readings of the same period,
   * over the time those readings span. Null with less than an hour of readings.
   */
  quotaPace(runtimeId: string, windowId: string, from: number, to = this.now()): number | null {
    const rows = this.db
      .prepare(
        `SELECT at, json_extract(data,'$.usedPercent') AS used, json_extract(data,'$.resetsAt') AS resetsAt,
          json_extract(data,'$.account') AS account
        FROM spend_ledger WHERE runtime_id=? AND kind='quota-reading' AND json_extract(data,'$.windowId')=?
          AND at>=? AND at<=? ORDER BY at`,
      )
      .all(runtimeId, windowId, from, to) as Array<{ at: number; used: number; resetsAt: string; account: string }>;
    let used = 0,
      span = 0;
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1]!,
        current = rows[index]!;
      if (current.account !== rows.at(-1)?.account || previous.account !== current.account) continue;
      if (Math.abs(Date.parse(current.resetsAt) - Date.parse(previous.resetsAt)) > 10 * minute) continue;
      used += Math.max(0, current.used - previous.used);
      span += current.at - previous.at;
    }
    return span >= hour ? (used / span) * day : null;
  }

  /** First time a budget/credit period existed on the card. */
  firstPeriodAt(runtimeId: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT MIN(at) AS at FROM spend_ledger WHERE runtime_id=? AND kind IN ('period-start','renewal','adjustment')",
      )
      .get(runtimeId) as { at: number | null } | undefined;
    return row?.at ?? undefined;
  }

  entries(runtimeId?: string, limit = 500): SpendLedgerEntry[] {
    const rows = (
      runtimeId === undefined
        ? this.db.prepare('SELECT * FROM spend_ledger ORDER BY seq DESC LIMIT ?').all(limit)
        : this.db
            .prepare('SELECT * FROM spend_ledger WHERE runtime_id=? ORDER BY seq DESC LIMIT ?')
            .all(runtimeId, limit)
    ) as Array<{ seq: number; runtime_id: string; period_id: string; kind: SpendLedgerKind; at: number; data: string }>;
    return rows.map((row) => ({
      seq: Number(row.seq),
      runtimeId: row.runtime_id,
      periodId: row.period_id,
      kind: row.kind,
      at: new Date(row.at).toISOString(),
      data: JSON.parse(row.data) as LedgerData,
    }));
  }
}
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/* ------------------------------------------------------------------------------------------------------------ */
/* Overview and details                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** A configured runtime as it is now; supplies what is left and the runway. */
export type SpendLiveAccount = {
  runtimeId: string;
  label: string;
  provider: UsageProvider;
  accountKey: string;
  accountingMode: AccountingMode;
  executionKind?: 'cli' | 'api';
  budget?: ApiBudgetView;
  /** Quota windows when the runtime reports quota; undefined when it does not. */
  quotaWindows?: QuotaWindow[];
};
/** Same order as the usage ledger's launch snapshot: a login first, then an API card, else unrecorded. */
export function spendAccountKey(
  fingerprint: string | undefined,
  executionKind: 'cli' | 'api' | null | undefined,
  runtimeId: string,
) {
  if (fingerprint) return `acct:${accountKey(fingerprint)}`;
  if (executionKind === 'api') return `api:${runtimeId}`;
  return `unrecorded:${runtimeId}`;
}
/** Live accounts from configured, enabled targets. Budgets come from the controller's own apiBudgetFor. */
export function spendLiveAccounts(
  targets: readonly RuntimeTarget[],
  snapshots: readonly RuntimeSnapshot[],
  budgetFor: (target: RuntimeTarget) => ApiBudgetView | undefined,
): SpendLiveAccount[] {
  return targets
    .filter((target) => target.enabled)
    .map((target) => {
      const snapshot = snapshots.find((item) => item.id === target.id);
      const executionKind = isApiHarness(target.provider) || target.gateway === 'api' ? 'api' : 'cli';
      const budget = target.gateway === 'api' && target.apiBudget ? budgetFor(target) : undefined;
      const mode = snapshot?.accounting?.mode ?? target.accountingMode;
      return {
        runtimeId: target.id,
        label: target.label,
        provider: target.provider,
        accountKey: spendAccountKey(
          snapshot?.accountFingerprint ?? target.accountFingerprint,
          executionKind,
          target.id,
        ),
        accountingMode: mode === 'usage' || mode === 'subscription' ? mode : 'unknown',
        executionKind,
        ...(budget ? { budget } : {}),
        ...(snapshot?.quota?.status === 'known' ? { quotaWindows: quotaOverviewWindows(snapshot) } : {}),
      } satisfies SpendLiveAccount;
    });
}
export type SpendOverviewInput = {
  report: UsageReport;
  accounts: ReadonlyMap<string, SpendAccountSnapshot>;
  workflows: Workflow[];
  projects: Pick<Project, 'id' | 'path'>[];
  live?: SpendLiveAccount[];
  ledger?: Pick<SpendLedger, 'quotaPace' | 'extraUsd' | 'firstPeriodAt'> &
    Partial<Pick<SpendLedger, 'creditClassifier' | 'version'>>;
  burn?: BurnRates;
  now?: Date;
  timeZone?: string;
};

const rangeMs = { '24h': day, '7d': 7 * day, '30d': 30 * day } as const;
export function normalizeSpendFilters(filters: Partial<SpendFilters> = {}): SpendFilters {
  const value: SpendFilters = {
    range: filters.range && ['24h', '7d', '30d', 'all'].includes(filters.range) ? filters.range : '7d',
    kind: filters.kind && ['all', 'cli', 'api'].includes(filters.kind) ? filters.kind : 'all',
    billing: filters.billing && ['all', 'subscription', 'usage'].includes(filters.billing) ? filters.billing : 'all',
  };
  if (filters.project) value.project = filters.project;
  if (filters.runtime) value.runtime = filters.runtime;
  if (filters.account) value.account = filters.account;
  return value;
}

/** Local calendar: `count` days ending today, built day by day so DST changes keep midnight boundaries. */
export function localDays(now: Date, count = spendHeatmapDays) {
  const y = now.getFullYear(),
    m = now.getMonth(),
    d = now.getDate();
  const starts: number[] = [];
  const days: string[] = [];
  for (let index = count - 1; index >= 0; index--) {
    const date = new Date(y, m, d - index);
    starts.push(date.getTime());
    days.push(localDay(date));
  }
  return { days, starts, end: new Date(y, m, d + 1).getTime() };
}
export const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function dayIndex(starts: number[], end: number, time: number): number {
  if (!(time >= starts[0]!) || time >= end) return -1;
  let low = 0,
    high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= time) low = mid;
    else high = mid - 1;
  }
  return low;
}

type Selection = {
  filters: SpendFilters;
  account: (run: UsageRun) => SpendAccountSnapshot;
  rows: UsageRun[];
};
function select(input: SpendOverviewInput, filters: SpendFilters): Selection {
  const fallback = new Map<string, SpendAccountSnapshot>();
  const account = (run: UsageRun) => {
    const known = input.accounts.get(run.runId);
    if (known) return known;
    let value = fallback.get(run.runtimeId);
    if (!value) {
      value = {
        key: `unrecorded:${run.runtimeId}`,
        label: run.runtimeLabel,
        provider: run.provider,
        source: 'unrecorded',
      };
      fallback.set(run.runtimeId, value);
    }
    return value;
  };
  const project = filters.project ? pathKey(filters.project) : undefined;
  const rows = input.report.perRun.filter(
    (run) =>
      (!project || pathKey(run.projectPath) === project) &&
      (!filters.runtime || run.runtimeId === filters.runtime) &&
      (filters.kind === 'all' || run.executionKind === filters.kind) &&
      (filters.billing === 'all' || run.accountingMode === filters.billing) &&
      (!filters.account || account(run).key === filters.account),
  );
  return { filters, account, rows };
}

/** Root of a run's task: its workflow's top caller, else the run itself. */
function taskRoots(workflows: Workflow[]) {
  const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const roots = new Map<string, string>();
  const rootOf = (id: string): string => {
    const known = roots.get(id);
    if (known) return known;
    let current = id;
    for (let depth = 0; depth < 50; depth++) {
      const workflow = byId.get(current);
      const up = workflow?.delegation?.parentId ?? workflow?.parentWorkflowId;
      if (!up || !byId.has(up)) break;
      current = up;
    }
    roots.set(id, current);
    return current;
  };
  return {
    byId,
    workflowRoot: rootOf,
    task: (run: UsageRun) =>
      run.workflowId ? `workflow:${rootOf(run.workflowId)}` : `run:${run.parentRunId ?? run.runId}`,
  };
}

const emptyTotals = (): SpendTotals => ({
  runs: 0,
  billedUsd: null,
  referenceUsd: null,
  missingCost: 0,
  tasks: 0,
  subscriptionRuns: 0,
  usageRuns: 0,
  unknownRuns: 0,
  unknownBillingUsd: null,
});
function addRun(totals: SpendTotals | SpendCell, run: UsageRun) {
  totals.runs++;
  if (run.accountingMode === 'usage') {
    if (numeric(run.estimatedCostUsd)) totals.billedUsd = (totals.billedUsd ?? 0) + run.estimatedCostUsd;
    else totals.missingCost++;
  } else if (run.accountingMode === 'subscription')
    totals.referenceUsd = addNullable(totals.referenceUsd, run.estimatedCostUsd);
  if ('usageRuns' in totals) {
    if (run.accountingMode === 'usage') totals.usageRuns++;
    else if (run.accountingMode === 'subscription') totals.subscriptionRuns++;
    else {
      totals.unknownRuns++;
      totals.unknownBillingUsd = addNullable(totals.unknownBillingUsd, run.estimatedCostUsd);
    }
  }
}
const byBilled = <T extends { billedUsd: number | null; runs: number }>(a: T, b: T) =>
  (b.billedUsd ?? -1) - (a.billedUsd ?? -1) || b.runs - a.runs;

function aggregate(rows: UsageRun[]): UsageAggregate {
  const result = {
    ...Object.fromEntries(usageMetricKeys.map((key) => [key, null])),
    runs: rows.length,
    reportedRuns: 0,
    tokenReportedRuns: 0,
    costReportedRuns: 0,
    historyImportedRuns: 0,
    uncertainRuns: 0,
    accountingRuns: { subscription: 0, usage: 0, unknown: 0 },
    metricReportedRuns: Object.fromEntries(usageMetricKeys.map((key) => [key, 0])) as Record<UsageMetric, number>,
  } as UsageAggregate;
  for (const row of rows) {
    result.accountingRuns[row.accountingMode]++;
    if (usageMetricKeys.some((key) => numeric(row[key]))) result.reportedRuns++;
    if (usageMetricKeys.some((key) => key !== 'estimatedCostUsd' && numeric(row[key]))) result.tokenReportedRuns++;
    if (numeric(row.estimatedCostUsd)) result.costReportedRuns++;
    if (row.historyImported) result.historyImportedRuns++;
    if (row.uncertain) result.uncertainRuns++;
    for (const key of usageMetricKeys)
      if (numeric(row[key])) {
        result[key] = (result[key] ?? 0) + row[key]!;
        result.metricReportedRuns[key]++;
      }
  }
  return result;
}
function groupBy<T>(rows: T[], key: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return [...groups.values()];
}
function reportOf(
  source: UsageReport,
  rows: UsageRun[],
  interval: { from: string; to: string },
  filters: SpendFilters,
) {
  return {
    generatedAt: new Date().toISOString(),
    filters: { projectPath: filters.project, runtimeId: filters.runtime, from: interval.from, to: interval.to },
    totals: aggregate(rows),
    byProject: groupBy(rows, (run) => pathKey(run.projectPath)).map((group) => ({
      projectPath: group[0]!.projectPath,
      ...aggregate(group),
    })),
    byRuntime: groupBy(rows, (run) => run.runtimeId).map((group) => ({
      runtimeId: group[0]!.runtimeId,
      label: group[0]!.runtimeLabel,
      provider: group[0]!.provider,
      ...aggregate(group),
    })),
    byModel: groupBy(rows, (run) => JSON.stringify([run.runtimeId, run.model])).map((group) => ({
      runtimeId: group[0]!.runtimeId,
      model: group[0]!.model,
      ...aggregate(group),
    })),
    note: source.note,
  };
}

function projectsOf(rows: UsageRun[]): SpendProject[] {
  return groupBy(rows, (run) => pathKey(run.projectPath))
    .map((group) => {
      const totals = emptyTotals();
      for (const run of group) addRun(totals, run);
      return {
        projectPath: group[0]!.projectPath,
        runs: totals.runs,
        billedUsd: totals.billedUsd,
        referenceUsd: totals.referenceUsd,
        missingCost: totals.missingCost,
      };
    })
    .sort((a, b) => byBilled(a, b) || a.projectPath.localeCompare(b.projectPath));
}

/** Whole tasks (root workflow plus subtasks, reviews, fixes, retries), billed dollars kept apart from reference. */
export function spendTasks(
  rows: UsageRun[],
  workflows: Workflow[],
  account: (run: UsageRun) => SpendAccountSnapshot,
  roots = taskRoots(workflows),
): SpendTask[] {
  const members = new Map<string, Workflow[]>();
  for (const workflow of workflows) {
    if (workflow.deletedAt) continue;
    const root = roots.workflowRoot(workflow.id);
    const list = members.get(root);
    if (list) list.push(workflow);
    else members.set(root, [workflow]);
  }
  const out: SpendTask[] = [];
  for (const group of groupBy(
    rows.filter((run) => run.workflowId && roots.byId.has(run.workflowId)),
    (run) => roots.workflowRoot(run.workflowId!),
  )) {
    const rootId = roots.workflowRoot(group[0]!.workflowId!);
    const root = roots.byId.get(rootId);
    if (!root || root.deletedAt) continue;
    const family = members.get(rootId) ?? [root];
    const totals = emptyTotals();
    for (const run of group) addRun(totals, run);
    const measures = Object.fromEntries(
      usageMetricKeys.map((key) => [key, group.reduce<number | null>((sum, run) => addNullable(sum, run[key]), null)]),
    ) as Record<UsageMetric, number | null>;
    const runsByWorkflow = new Map<string, number>();
    for (const run of group) runsByWorkflow.set(run.workflowId!, (runsByWorkflow.get(run.workflowId!) ?? 0) + 1);
    const last =
      [...family].filter((member) => !member.delegation).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      root;
    out.push({
      ...measures,
      taskId: rootId,
      conversationId: root.conversationId,
      title: root.input.content.replace(/\s+/g, ' ').trim().slice(0, 80),
      startedAt: root.createdAt,
      status: last.status,
      runs: group.length,
      subtasks: family.filter((member) => member.delegation && member.delegation.role !== 'reviewer').length,
      reviews: family.filter((member) => member.delegation?.role === 'reviewer').length,
      fixes: family.filter((member) => !member.delegation && member.id !== rootId).length,
      retries: family.reduce(
        (sum, member) =>
          sum + Math.max(0, (runsByWorkflow.get(member.id) ?? 0) - Math.max(1, member.plan?.length ?? 1)),
        0,
      ),
      executors: [...new Set(group.map((run) => run.runtimeLabel))],
      projectPath: group[0]!.projectPath,
      billedUsd: totals.billedUsd,
      referenceUsd: totals.referenceUsd,
      missingCost: totals.missingCost,
      subscriptionRuns: totals.subscriptionRuns,
      handoffs: group.filter((run) => run.relay && run.relay.reason !== 'selection').length,
      accountKeys: [...new Set(group.map((run) => account(run).key))],
      runtimeIds: [...new Set(group.map((run) => run.runtimeId))],
      traceWorkflowId: rootId,
    });
  }
  return out.sort((a, b) => byBilled(a, b) || b.startedAt.localeCompare(a.startedAt));
}

/** The part of the overview that only depends on the ledger rows, workflows, filters and the calendar. Cacheable. */
type SpendAggregate = Omit<SpendOverview, 'runway' | 'runwayUnreported' | 'kpis' | 'accounts'> & {
  accounts: Array<Omit<SpendAccount, 'left' | 'creditSince'> & { modes: Record<AccountingMode, number> }>;
  /** Usage-billed dollars per account over the last 7 days (runway pace). */
  pace: Record<string, number | null>;
};

function buildAggregate(input: SpendOverviewInput, filters: SpendFilters, now: Date, creditRuntimes: Set<string>) {
  const { rows, account } = select(input, filters);
  const isCredit =
    input.ledger?.creditClassifier?.() ??
    ((runtimeId: string, at: number) => {
      const policy = input.live?.find((item) => item.runtimeId === runtimeId)?.budget?.policy;
      return (
        !!policy &&
        (!!policy.expiresAt || !!policy.monthlyUsd) &&
        at >= Date.parse(policy.startedAt) &&
        (!policy.expiresAt || at < Date.parse(policy.expiresAt))
      );
    });
  const historicalCredits = new Set(
    rows
      .filter((run) => run.accountingMode === 'usage' && isCredit(run.runtimeId, Date.parse(run.startedAt)))
      .map((run) => run.runtimeId),
  );
  const roots = taskRoots(input.workflows);
  const calendar = localDays(now);
  const to = now.getTime();
  // Health & details: the existing insights, without per-run rows or failure run ids.
  const raw = usageInsights(
    { ...input.report, perRun: rows },
    input.workflows,
    { range: filters.range, kind: 'all' },
    now,
    input.projects,
  );
  const from = Date.parse(raw.interval.from);
  const period = rows.filter((run) => {
    const time = Date.parse(run.startedAt);
    return time >= from && time < to;
  });
  const { perRun: _perRun, ...report } = raw.report;
  void _perRun;
  const tasks = spendTasks(period, input.workflows, account, roots);
  const insights: SpendInsights = {
    ...raw,
    filters: {
      range: filters.range,
      kind: filters.kind,
      ...(filters.project ? { project: filters.project } : {}),
      ...(filters.runtime ? { runtime: filters.runtime } : {}),
    },
    report,
    routing: { ...raw.routing, recent: [] },
    buckets: raw.buckets.map(({ failureRunIds: _ids, ...bucket }) => bucket),
    tasks: tasks.slice(0, spendTopTasks),
    tasksByRuns: [...tasks].sort((a, b) => b.runs - a.runs || byBilled(a, b)).slice(0, spendTopTasks),
  };

  // Ledger by account.
  type Row = SpendAggregate['accounts'][number] & { taskSets: Array<Set<string> | null>; periodTasks: Set<string> };
  const accounts = new Map<string, Row>();
  const rowFor = (snapshot: SpendAccountSnapshot) => {
    let row = accounts.get(snapshot.key);
    if (!row) {
      row = {
        key: snapshot.key,
        label: snapshot.label,
        provider: snapshot.provider,
        group: 'unknown',
        known: snapshot.source !== 'unrecorded',
        runtimes: [],
        cells: Array.from({ length: calendar.days.length }, () => null),
        period: emptyTotals(),
        modes: { usage: 0, subscription: 0, unknown: 0 },
        taskSets: Array.from({ length: calendar.days.length }, () => null),
        periodTasks: new Set(),
      };
      accounts.set(snapshot.key, row);
    }
    return row;
  };
  const pace: Record<string, number | null> = {};
  const paceFrom = to - 7 * day;
  // Remaining balances are account-wide, so their burn rate must not shrink with a project filter.
  for (const run of input.report.perRun) {
    const time = Date.parse(run.startedAt);
    if (time >= paceFrom && time < to && run.accountingMode === 'usage') {
      const key = run.runtimeId;
      pace[key] = pace[key] === null || !numeric(run.estimatedCostUsd) ? null : (pace[key] ?? 0) + run.estimatedCostUsd;
    }
  }
  for (const run of rows) {
    const snapshot = account(run);
    const time = Date.parse(run.startedAt);
    const index = dayIndex(calendar.starts, calendar.end, time);
    const inPeriod = time >= from && time < to;
    if (index < 0 && !inPeriod) continue;
    const row = rowFor(snapshot);
    if (!row.runtimes.some((runtime) => runtime.id === run.runtimeId))
      row.runtimes.push({ id: run.runtimeId, label: run.runtimeLabel, current: false });
    row.executionKind ??= run.executionKind ?? undefined;
    row.modes[run.accountingMode]++;
    const task = roots.task(run);
    if (index >= 0) {
      const cell = (row.cells[index] ??= { runs: 0, billedUsd: null, referenceUsd: null, missingCost: 0, tasks: 0 });
      addRun(cell, run);
      const set = (row.taskSets[index] ??= new Set());
      set.add(task);
      cell.tasks = set.size;
    }
    if (inPeriod) {
      addRun(row.period, run);
      row.periodTasks.add(task);
    }
  }
  const accountRows = [...accounts.values()].map(({ taskSets: _sets, periodTasks, ...row }) => {
    row.period.tasks = periodTasks.size;
    row.group = groupOf(
      row.modes,
      row.runtimes.map((runtime) => runtime.id),
      historicalCredits,
    );
    return row;
  });

  // Where it went.
  const billing: SpendBillingSplit = {
    subscription: { runs: 0, billedUsd: null, referenceUsd: null, missingCost: 0 },
    usage: { runs: 0, billedUsd: null, referenceUsd: null, missingCost: 0 },
    credit: { runs: 0, billedUsd: null, referenceUsd: null, missingCost: 0 },
    unknown: { runs: 0, billedUsd: null, referenceUsd: null, missingCost: 0 },
  };
  for (const run of period) {
    const slot =
      run.accountingMode === 'usage'
        ? isCredit(run.runtimeId, Date.parse(run.startedAt))
          ? billing.credit
          : billing.usage
        : billing[run.accountingMode];
    slot.runs++;
    if (run.accountingMode === 'usage') {
      if (numeric(run.estimatedCostUsd)) slot.billedUsd = (slot.billedUsd ?? 0) + run.estimatedCostUsd;
      else slot.missingCost++;
    } else slot.referenceUsd = addNullable(slot.referenceUsd, run.estimatedCostUsd);
  }

  // Filter-bar options come from the whole history, not the current selection.
  const optionAccounts = new Map<string, string>();
  for (const run of input.report.perRun) {
    const snapshot = account(run);
    if (!optionAccounts.has(snapshot.key)) optionAccounts.set(snapshot.key, snapshot.label);
  }
  const aggregateValue: SpendAggregate = {
    generatedAt: now.toISOString(),
    filters,
    timeZone: input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: calendar.days,
    today: calendar.days[calendar.days.length - 1]!,
    insights,
    accounts: accountRows,
    billing,
    projects: projectsOf(period),
    options: {
      projects: [...new Set([...input.report.perRun.map((run) => run.projectPath), ...raw.projects])].sort(),
      runtimes: [
        ...new Map(
          input.report.perRun.map((run) => [run.runtimeId, { id: run.runtimeId, label: run.runtimeLabel }]),
        ).values(),
      ],
      accounts: [...optionAccounts].map(([key, label]) => ({ key, label })),
    },
    pace,
  };
  return aggregateValue;
}

function groupOf(modes: Record<AccountingMode, number>, runtimeIds: string[], creditRuntimes: Set<string>): SpendGroup {
  if (modes.usage > 0 || (modes.subscription === 0 && runtimeIds.some((id) => creditRuntimes.has(id))))
    return runtimeIds.some((id) => creditRuntimes.has(id)) ? 'credit' : 'usage';
  if (modes.subscription > 0) return 'subscription';
  return 'unknown';
}
const expiring = (budget: ApiBudgetView | undefined) =>
  !!budget && (!!budget.policy.expiresAt || !!budget.policy.monthlyUsd);
const creditRuntimesOf = (live: SpendLiveAccount[]) =>
  new Set(live.filter((item) => expiring(item.budget)).map((item) => item.runtimeId));

/** The tightest reported quota window (least left). */
function tightest(windows: QuotaWindow[] | undefined) {
  let best: { window: QuotaWindow; left: number } | undefined;
  for (const window of windows ?? []) {
    if (!numeric(window.usedPercent)) continue;
    const left = Math.max(0, 100 - window.usedPercent);
    if (!best || left < best.left) best = { window, left };
  }
  return best;
}

/** Adds what is left, the runway and the KPIs to a (possibly cached) aggregate. Cheap; runs per request. */
function withLive(
  aggregateValue: SpendAggregate,
  input: Pick<SpendOverviewInput, 'live' | 'ledger' | 'burn'>,
  now: Date,
): SpendOverview {
  const live = input.live ?? [];
  const filters = aggregateValue.filters;
  const at = now.getTime();
  const admitted = (item: SpendLiveAccount) =>
    (!filters.runtime || item.runtimeId === filters.runtime) &&
    (!filters.account || item.accountKey === filters.account) &&
    (filters.billing === 'all' || item.accountingMode === filters.billing) &&
    (filters.kind === 'all' || !item.executionKind || item.executionKind === filters.kind);
  const liveByKey = new Map<string, SpendLiveAccount[]>();
  for (const item of live) liveByKey.set(item.accountKey, [...(liveByKey.get(item.accountKey) ?? []), item]);
  const creditRuntimes = creditRuntimesOf(live);
  const rows = new Map(aggregateValue.accounts.map((row) => [row.key, row]));
  // Configured accounts stay visible with empty cells even when the period has no runs.
  if (!filters.project)
    for (const item of live) {
      if (rows.has(item.accountKey) || !admitted(item)) continue;
      rows.set(item.accountKey, {
        key: item.accountKey,
        label: item.label,
        provider: item.provider,
        group: 'unknown',
        known: !item.accountKey.startsWith('unrecorded:'),
        runtimes: [],
        cells: aggregateValue.days.map(() => null),
        period: emptyTotals(),
        modes: { usage: 0, subscription: 0, unknown: 0 },
      });
    }
  const accounts: SpendAccount[] = [];
  const runway: SpendRunway[] = [];
  const runwayUnreported: SpendOverview['runwayUnreported'] = [];
  for (const { modes, ...row } of rows.values()) {
    const items = liveByKey.get(row.key) ?? [];
    const runtimes = row.runtimes.map((runtime) => ({
      ...runtime,
      current: items.some((item) => item.runtimeId === runtime.id),
    }));
    for (const item of items)
      if (!runtimes.some((runtime) => runtime.id === item.runtimeId))
        runtimes.push({ id: item.runtimeId, label: item.label, current: true });
    const liveModes = { ...modes };
    if (!modes.usage && !modes.subscription && !modes.unknown)
      for (const item of items) liveModes[item.accountingMode]++;
    const account: SpendAccount = {
      ...row,
      label: items[0]?.label ?? row.label,
      runtimes,
      executionKind: row.executionKind ?? items[0]?.executionKind,
      group:
        modes.usage || modes.subscription || modes.unknown
          ? row.group
          : groupOf(
              liveModes,
              runtimes.map((runtime) => runtime.id),
              creditRuntimes,
            ),
    };
    const budgets = items.filter((item) => item.budget && admitted(item));
    const quota = items
      .map((item) => ({ item, best: tightest(item.quotaWindows) }))
      .filter((entry) => entry.best)
      .sort((a, b) => a.best!.left - b.best!.left)[0];
    if (budgets.length) {
      for (const budgeted of budgets) {
        const view = budgeted.budget!;
        const plan = apiCreditPace(view, at);
        const first = input.ledger?.firstPeriodAt(budgeted.runtimeId) ?? Date.parse(view.policy.startedAt);
        if (expiring(view) && Number.isFinite(first)) account.creditSince = localDay(new Date(first));
        account.left = {
          kind: 'api',
          runtimeId: budgeted.runtimeId,
          noCap: view.policy.limitUsd === undefined,
          remainingUsd: view.remainingUsd ?? null,
          limitUsd: view.policy.limitUsd ?? null,
          monthlyUsd: view.policy.monthlyUsd ?? null,
          spentUsd: view.spentUsd,
          reservedUsd: view.reservedUsd,
          startedAt: view.policy.startedAt,
          expiresAt: view.policy.expiresAt ?? null,
          phase: view.phase,
          plannedUsd: plan ? round(plan.plannedUsd) : null,
          preferExpiring: view.policy.preferExpiring,
        };
        if (view.remainingUsd !== undefined && view.phase !== 'expired') {
          const extra = input.ledger?.extraUsd(budgeted.runtimeId, at - 7 * day, at) ?? 0;
          const recordedPace = aggregateValue.pace[budgeted.runtimeId];
          const pacePerDay = recordedPace === null ? null : ((recordedPace ?? 0) + extra) / 7;
          const endsAt = Date.parse(view.policy.expiresAt ?? '');
          const runsOutAt = pacePerDay !== null && pacePerDay > 0 ? at + (view.remainingUsd / pacePerDay) * day : null;
          const hasEnd = Number.isFinite(endsAt) && endsAt > at;
          const credit = expiring(view);
          const lapseUsd =
            credit && hasEnd && pacePerDay !== null
              ? round(Math.max(0, view.remainingUsd - pacePerDay * ((endsAt - at) / day)))
              : null;
          const outBeforeEnd = runsOutAt !== null && (!hasEnd || runsOutAt < endsAt) && runsOutAt - at <= 14 * day;
          runway.push({
            accountKey: row.key,
            runtimeId: budgeted.runtimeId,
            label: budgeted.label,
            kind: credit ? 'credit' : 'budget',
            left: round(view.remainingUsd),
            unit: 'usd',
            pacePerDay: pacePerDay === null ? null : round(pacePerDay),
            paceSource: pacePerDay === null ? 'none' : 'last-7-days',
            endsAt: hasEnd ? new Date(endsAt).toISOString() : null,
            endKind: hasEnd ? (view.policy.monthlyUsd ? 'reset' : 'expiry') : 'none',
            runsOutAt: runsOutAt === null ? null : new Date(runsOutAt).toISOString(),
            outBeforeEnd,
            shortByMs: outBeforeEnd && hasEnd && runsOutAt !== null ? Math.round(endsAt - runsOutAt) : null,
            lapseUsd,
            plannedUsd: plan ? round(plan.plannedUsd) : null,
            preferExpiring: view.policy.preferExpiring,
            urgency: urgency(outBeforeEnd, runsOutAt, lapseUsd, hasEnd ? endsAt : null, at),
          });
        }
      }
    } else if (
      items.some((item) => item.provider !== 'unknown' && item.accountingMode === 'usage' && !item.quotaWindows)
    ) {
      const item = items[0]!;
      account.left = {
        kind: 'api',
        runtimeId: item.runtimeId,
        noCap: true,
        remainingUsd: null,
        limitUsd: null,
        monthlyUsd: null,
        spentUsd: 0,
        reservedUsd: 0,
        startedAt: '',
        expiresAt: null,
        phase: 'normal',
        plannedUsd: null,
        preferExpiring: false,
      };
    } else if (quota) {
      const { item, best } = quota;
      const window = best!.window;
      account.left = {
        kind: 'quota',
        runtimeId: item.runtimeId,
        windowId: window.id,
        windowLabel: window.label,
        usedPercent: window.usedPercent!,
        leftPercent: best!.left,
        resetsAt: window.resetsAt,
        resetNotReported: !!window.resetNotReported,
      };
      const readings = input.ledger?.quotaPace(item.runtimeId, window.id, at - 7 * day, at) ?? null;
      // The legacy burn rate covers 30 days, not this view's explicitly labelled seven-day horizon.
      const pacePerDay = readings;
      const endsAt = Date.parse(window.resetsAt ?? '');
      const hasEnd = Number.isFinite(endsAt) && endsAt > at;
      const runsOutAt = pacePerDay && pacePerDay > 0 ? at + (best!.left / pacePerDay) * day : null;
      const outBeforeEnd = runsOutAt !== null && hasEnd && runsOutAt < endsAt;
      runway.push({
        accountKey: row.key,
        runtimeId: item.runtimeId,
        label: account.label,
        kind: 'quota',
        left: round(best!.left),
        unit: 'percent',
        pacePerDay: pacePerDay === null ? null : round(pacePerDay),
        paceSource: readings !== null ? 'quota-readings' : pacePerDay !== null ? 'quota-history' : 'none',
        endsAt: hasEnd ? new Date(endsAt).toISOString() : null,
        endKind: hasEnd ? 'reset' : 'none',
        runsOutAt: runsOutAt === null ? null : new Date(runsOutAt).toISOString(),
        outBeforeEnd,
        shortByMs: outBeforeEnd ? Math.round(endsAt - runsOutAt!) : null,
        lapseUsd: null,
        plannedUsd: null,
        preferExpiring: false,
        urgency: urgency(outBeforeEnd, runsOutAt, null, hasEnd ? endsAt : null, at, best!.left),
      });
    } else if (items.length) {
      account.left = { kind: 'unreported', runtimeId: items[0]!.runtimeId };
      if (items.some((item) => item.accountingMode !== 'usage'))
        runwayUnreported.push({ accountKey: row.key, label: account.label });
    }
    accounts.push(account);
  }
  const groupOrder: Record<SpendGroup, number> = { usage: 0, credit: 1, subscription: 2, unknown: 3 };
  accounts.sort(
    (a, b) =>
      groupOrder[a.group] - groupOrder[b.group] ||
      Number(b.known) - Number(a.known) ||
      (a.group === 'subscription'
        ? b.period.runs - a.period.runs
        : (b.period.billedUsd ?? -1) - (a.period.billedUsd ?? -1)) ||
      a.label.localeCompare(b.label),
  );
  runway.sort((a, b) => a.urgency - b.urgency);
  const { pace: _pace, ...rest } = aggregateValue;
  return {
    ...rest,
    accounts,
    runway,
    runwayUnreported,
    kpis: kpisOf(accounts, runway, at, filters.range === 'all' ? Infinity : rangeMs[filters.range]),
  };
}
function urgency(
  out: boolean,
  runsOutAt: number | null,
  lapse: number | null,
  endsAt: number | null,
  at: number,
  left = 100,
) {
  if (out && runsOutAt !== null) return runsOutAt - at;
  if (lapse && lapse > 0 && endsAt !== null) return 1e12 + (endsAt - at);
  return 2e12 + left * 1e9 + (endsAt === null ? 1e9 : Math.min(1e9 - 1, endsAt - at));
}
function kpisOf(accounts: SpendAccount[], runway: SpendRunway[], at: number, horizon: number): SpendKpis {
  const lapses = runway.filter(
    (row) =>
      row.kind === 'credit' && row.lapseUsd && row.lapseUsd > 0 && row.endsAt && Date.parse(row.endsAt) <= at + horizon,
  );
  const lapse = lapses.sort((a, b) => b.lapseUsd! - a.lapseUsd! || a.endsAt!.localeCompare(b.endsAt!))[0];
  const credits = runway
    .filter((row) => row.kind === 'credit' && row.left !== null)
    .sort((a, b) => (a.endsAt ?? '9').localeCompare(b.endsAt ?? '9'));
  let tightestQuota: SpendKpis['tightestQuota'] = null;
  for (const account of accounts)
    if (account.left?.kind === 'quota' && (!tightestQuota || account.left.leftPercent < tightestQuota.leftPercent))
      tightestQuota = {
        accountKey: account.key,
        label: account.label,
        windowLabel: account.left.windowLabel,
        leftPercent: account.left.leftPercent,
        resetsAt: account.left.resetsAt,
      };
  return {
    lapse: lapse
      ? { accountKey: lapse.accountKey, label: lapse.label, lapseUsd: lapse.lapseUsd!, endsAt: lapse.endsAt! }
      : null,
    creditLeft:
      !lapse && credits[0]
        ? {
            accountKey: credits[0].accountKey,
            label: credits[0].label,
            remainingUsd: credits[0].left!,
            endsAt: credits[0].endsAt,
          }
        : null,
    tightestQuota,
  };
}

/** Aggregates only: no per-run rows, no failure run ids, top tasks only. */
export function buildSpendOverview(input: SpendOverviewInput, filters: Partial<SpendFilters> = {}): SpendOverview {
  const now = input.now ?? new Date();
  const normalized = normalizeSpendFilters(filters);
  return withLive(buildAggregate(input, normalized, now, creditRuntimesOf(input.live ?? [])), input, now);
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
export function normalizeSpendDetailsQuery(query: Partial<SpendDetailsQuery> = {}): SpendDetailsQuery {
  const offset = Number(query.offset ?? 0),
    limit = Number(query.limit ?? 50);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid spend details offset');
  if (!Number.isInteger(limit) || limit < 1 || limit > spendDetailsMaxLimit)
    throw new Error('Invalid spend details limit');
  if (query.day !== undefined && !dayPattern.test(query.day)) throw new Error('Invalid spend details day');
  if (query.failure !== undefined && !failureTypes.includes(query.failure)) throw new Error('Invalid failure type');
  return {
    ...normalizeSpendFilters(query),
    group: query.group && ['task', 'project', 'run'].includes(query.group) ? query.group : 'task',
    ...(query.day ? { day: query.day } : {}),
    ...(query.failure ? { failure: query.failure as FailureType } : {}),
    offset,
    limit,
  };
}

/** Paged rows behind the overview: tasks, projects or runs of one selection (period or one local day). */
export function buildSpendDetails(
  input: SpendOverviewInput,
  rawQuery: Partial<SpendDetailsQuery> = {},
  roots?: ReturnType<typeof taskRoots>,
): SpendDetails {
  const query = normalizeSpendDetailsQuery(rawQuery);
  const now = input.now ?? new Date();
  const { rows, account } = select(input, query);
  let from: number, to: number;
  if (query.day) {
    const [y, m, d] = query.day.split('-').map(Number) as [number, number, number];
    from = new Date(y, m - 1, d).getTime();
    to = new Date(y, m - 1, d + 1).getTime();
  } else {
    to = now.getTime();
    from =
      query.range === 'all'
        ? rows.reduce((earliest, run) => Math.min(earliest, Date.parse(run.startedAt) || earliest), to - day)
        : to - rangeMs[query.range];
  }
  const selection = rows.filter((run) => {
    const time = Date.parse(run.startedAt);
    return (
      time >= from &&
      time < to &&
      (!query.failure || (run.status === 'failed' && failureType(run.errorCode) === query.failure))
    );
  });
  const interval = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  const page = <T>(items: T[]) => items.slice(query.offset, query.offset + query.limit);
  const tasks = query.group === 'task' ? spendTasks(selection, input.workflows, account, roots) : [];
  const projects = query.group === 'project' ? projectsOf(selection) : [];
  const total = query.group === 'task' ? tasks.length : query.group === 'project' ? projects.length : selection.length;
  return {
    query,
    interval,
    report: {
      ...reportOf(input.report, selection, interval, query),
      generatedAt: now.toISOString(),
      perRun: query.group === 'run' ? page(selection) : [],
    },
    tasks: page(tasks),
    projects: page(projects),
    total,
    offset: query.offset,
    limit: query.limit,
    ...(query.offset + query.limit < total ? { nextOffset: query.offset + query.limit } : {}),
  };
}

export type SpendServiceDeps = {
  report(): UsageReport;
  accounts(): ReadonlyMap<string, SpendAccountSnapshot>;
  workflows(): Workflow[];
  /** Workspace revision: workflows are reloaded only when it changes. */
  revision(): number;
  projects(): Pick<Project, 'id' | 'path'>[];
  live?(): SpendLiveAccount[];
  ledger?: SpendLedger;
  burn?(): BurnRates;
  now?(): Date;
};

/**
 * Caches the overview aggregate by ledger report identity + workspace revision + filters + local day + time zone
 * offset + minute (rolling ranges move) + which cards hold expiring credit. What is left and the runway are
 * recomputed on every request from live state.
 */
export class SpendService {
  private workflowCache?: { revision: number; value: Workflow[]; roots: ReturnType<typeof taskRoots> };
  private readonly cache = new Map<string, SpendAggregate>();
  private readonly reportIds = new WeakMap<object, number>();
  private nextReportId = 1;
  private readonly counters = { hits: 0, misses: 0, workflowLoads: 0 };
  constructor(private readonly deps: SpendServiceDeps) {}

  private workflows() {
    const revision = this.deps.revision();
    if (this.workflowCache?.revision !== revision) {
      const value = this.deps.workflows();
      this.workflowCache = { revision, value, roots: taskRoots(value) };
      this.counters.workflowLoads++;
    }
    return this.workflowCache;
  }
  private reportId(report: UsageReport) {
    let id = this.reportIds.get(report);
    if (!id) this.reportIds.set(report, (id = this.nextReportId++));
    return id;
  }
  private input(now: Date): SpendOverviewInput & { roots: ReturnType<typeof taskRoots>; revision: number } {
    const workflows = this.workflows();
    return {
      report: this.deps.report(),
      accounts: this.deps.accounts(),
      workflows: workflows.value,
      roots: workflows.roots,
      revision: workflows.revision,
      projects: this.deps.projects(),
      live: this.deps.live?.() ?? [],
      ledger: this.deps.ledger,
      burn: this.deps.burn?.(),
      now,
    };
  }
  overview(filters: Partial<SpendFilters> = {}): SpendOverview {
    const now = this.deps.now?.() ?? new Date();
    const normalized = normalizeSpendFilters(filters);
    const input = this.input(now);
    const credit = creditRuntimesOf(input.live ?? []);
    const key = JSON.stringify([
      this.reportId(input.report),
      input.revision,
      normalized,
      localDay(now),
      now.getTimezoneOffset(),
      Math.floor(now.getTime() / minute),
      [...credit].sort(),
      input.ledger?.version ?? 0,
    ]);
    let value = this.cache.get(key);
    if (value) this.counters.hits++;
    else {
      this.counters.misses++;
      value = buildAggregate(input, normalized, now, credit);
      this.cache.set(key, value);
      while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    }
    return withLive(value, input, now);
  }
  details(query: Partial<SpendDetailsQuery> = {}): SpendDetails {
    const now = this.deps.now?.() ?? new Date();
    const input = this.input(now);
    return buildSpendDetails(input, query, input.roots);
  }
  stats() {
    return { ...this.counters, cached: this.cache.size };
  }
}
