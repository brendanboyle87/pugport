import type { ApiBudgetView } from './api-providers.ts';
import type { TaskCost, UsageProvider, UsageReport } from './usage.ts';
import type { FailureType, InsightBucket, InsightKind, InsightRange, UsageInsights } from './usage-insights.ts';

/*
 * Usage › Spend contract. GET /api/usage/spend returns aggregates only (no per-run rows, no failure run ids);
 * GET /api/usage/spend/details pages the rows behind them. Nothing here is added to /api/state.
 *
 * Money: `billedUsd` only ever sums runs whose accountingMode is 'usage'. Subscription runs carry a separate
 * `referenceUsd` (API-price reference, never billed). `null` means "not reported", never zero; `missingCost` counts
 * the runs whose cost was not reported. Billing filters use accountingMode, not executionKind.
 */

export type SpendBilling = 'all' | 'subscription' | 'usage';
/** Query of both endpoints. `range` is the rolling window used by KPIs, mix, tasks and health (as /api/usage/insights). */
export type SpendFilters = {
  range: InsightRange;
  kind: InsightKind;
  billing: SpendBilling;
  project?: string;
  runtime?: string;
  /** `SpendAccount.key`. */
  account?: string;
};
export const spendHeatmapDays = 56;
export const spendTopTasks = 6;
export const spendDetailsMaxLimit = 200;

/**
 * Fixed into the usage ledger when a run starts (never rewritten by later target edits, rebinding or deletion).
 * `key` is opaque: `acct:<hash>` for a login (same hash the quota history uses, never the raw fingerprint),
 * `api:<targetId>` for an API card, `unrecorded:<runtimeId>` when the account was not recorded.
 */
export type SpendAccountSource = 'login' | 'api-card' | 'unrecorded';
export type SpendAccountSnapshot = { key: string; label: string; provider: UsageProvider; source: SpendAccountSource };

/** Row group in "Ledger by account". `credit` = pay-per-use card whose budget expires or renews monthly. */
export type SpendGroup = 'usage' | 'credit' | 'subscription' | 'unknown';

/** One heat cell: one account on one local calendar day (by run start). `null` in `cells` = no runs that day. */
export type SpendCell = {
  runs: number;
  /** Usage-billed dollars; null when every usage run that day lacked a cost (or there were none). */
  billedUsd: number | null;
  /** Subscription runs at API prices; never billed. */
  referenceUsd: number | null;
  /** Usage runs that day without a reported cost (corner tick). */
  missingCost: number;
  /** Distinct tasks (root workflows, or root runs without a workflow). */
  tasks: number;
};
export type SpendTotals = SpendCell & {
  subscriptionRuns: number;
  usageRuns: number;
  unknownRuns: number;
  /** Cost of runs whose billing is unknown; shown separately, never added to billed. */
  unknownBillingUsd: number | null;
};

/** What is left on an account right now. Computed per request, never cached. */
export type SpendLeft =
  | {
      kind: 'api';
      runtimeId: string;
      /** No limit set on the card ("No cap set"). */
      noCap: boolean;
      remainingUsd: number | null;
      limitUsd: number | null;
      monthlyUsd: number | null;
      spentUsd: number;
      reservedUsd: number;
      startedAt: string;
      expiresAt: string | null;
      phase: ApiBudgetView['phase'];
      /** Straight-line plan from apiCreditPace ("按计划应已用"); null when there is no plan line. */
      plannedUsd: number | null;
      preferExpiring: boolean;
    }
  | {
      kind: 'quota';
      runtimeId: string;
      windowId: string;
      windowLabel: string;
      usedPercent: number;
      leftPercent: number;
      resetsAt: string | null;
      resetNotReported: boolean;
    }
  | { kind: 'unreported'; runtimeId: string | null };

export type SpendAccount = {
  executionKind?: 'cli' | 'api';
  key: string;
  label: string;
  provider: UsageProvider;
  group: SpendGroup;
  /** False for `unrecorded:` rows: runs whose account was not recorded get their own row per runtime. */
  known: boolean;
  /** Runtimes that ran on this account. `current` = still configured; deleted targets keep their history. */
  runtimes: Array<{ id: string; label: string; current: boolean }>;
  /** Aligned with `SpendOverview.days`. */
  cells: Array<SpendCell | null>;
  /** Totals inside `insights.interval` (the selected period). */
  period: SpendTotals;
  /** Absent when the account is not configured any more. */
  left?: SpendLeft;
  /** First local day a credit/budget period existed (cells before it are drawn as empty outlines). */
  creditSince?: string;
};

/** "What runs out first": next 14 days at the last 7 days' pace. */
export type SpendRunway = {
  accountKey: string;
  runtimeId: string;
  label: string;
  kind: 'quota' | 'credit' | 'budget';
  /** Quota: percent left of the tightest window. Credit/budget: dollars left. */
  left: number | null;
  unit: 'percent' | 'usd';
  /** Pace per day in `unit`; null when unknown (quota without enough readings). */
  pacePerDay: number | null;
  paceSource: 'last-7-days' | 'quota-readings' | 'quota-history' | 'none';
  /** Reset (quota, monthly credit) or expiry (one-off credit); null when none is known. */
  endsAt: string | null;
  endKind: 'reset' | 'expiry' | 'none';
  /** When `left` reaches zero at this pace; null when pace is 0/unknown. */
  runsOutAt: string | null;
  /** Runs out before `endsAt`. */
  outBeforeEnd: boolean;
  shortByMs: number | null;
  /** Credit that lapses unused at `endsAt` at this pace (credit only). */
  lapseUsd: number | null;
  plannedUsd: number | null;
  preferExpiring: boolean;
  /** Lower = more urgent; rows are already sorted by it. */
  urgency: number;
};

export type SpendBillingSplit = Record<
  'subscription' | 'usage' | 'credit' | 'unknown',
  { runs: number; billedUsd: number | null; referenceUsd: number | null; missingCost: number }
>;
export type SpendProject = {
  projectPath: string;
  runs: number;
  billedUsd: number | null;
  referenceUsd: number | null;
  missingCost: number;
};

/** A task card. `estimatedCostUsd` (from TaskCost) mixes billing types; cards and sorting use `billedUsd`. */
export type SpendTask = TaskCost & {
  projectPath: string;
  billedUsd: number | null;
  referenceUsd: number | null;
  missingCost: number;
  subscriptionRuns: number;
  /** Runs that left one executor for another (relay reason other than 'selection'). */
  handoffs: number;
  accountKeys: string[];
  runtimeIds: string[];
  /** Open trace: ConversationTrace with initialWorkflowId = taskId in conversationId. */
  traceWorkflowId: string;
};

/** Health & details, aggregates only. Same rolling-window semantics as /api/usage/insights. */
export type SpendInsights = Omit<UsageInsights, 'report' | 'buckets' | 'tasks'> & {
  report: Omit<UsageReport, 'perRun'>;
  buckets: Array<Omit<InsightBucket, 'failureRunIds'>>;
  /** Costliest by billed dollars, at most `spendTopTasks`. */
  tasks: SpendTask[];
  /** Most runs, independently ranked over all matching tasks, at most `spendTopTasks`. */
  tasksByRuns: SpendTask[];
};

export type SpendKpis = {
  /** Soonest credit lapse at the current pace (largest lapse first); null when none expires. */
  lapse: { accountKey: string; label: string; lapseUsd: number; endsAt: string } | null;
  /** When nothing lapses: the soonest-expiring credit balance. */
  creditLeft: { accountKey: string; label: string; remainingUsd: number; endsAt: string | null } | null;
  tightestQuota: {
    accountKey: string;
    label: string;
    windowLabel: string;
    leftPercent: number;
    resetsAt: string | null;
  } | null;
};

export type SpendOverview = {
  generatedAt: string;
  filters: SpendFilters;
  /** IANA zone of the local calendar used by `days`. */
  timeZone: string;
  /** 56 local days `YYYY-MM-DD`, oldest first; the last one is today. */
  days: string[];
  today: string;
  insights: SpendInsights;
  accounts: SpendAccount[];
  runway: SpendRunway[];
  /** Accounts without quota reporting: footnote, not drawn on the runway. */
  runwayUnreported: Array<{ accountKey: string; label: string }>;
  billing: SpendBillingSplit;
  /** Billed by project in the selected period, highest first. */
  projects: SpendProject[];
  kpis: SpendKpis;
  /** Options for the filter bar, from all history (not narrowed by the current filters). */
  options: {
    projects: string[];
    runtimes: Array<{ id: string; label: string }>;
    accounts: Array<{ key: string; label: string }>;
  };
};

export type SpendDetailsGroup = 'task' | 'project' | 'run';
export type SpendDetailsQuery = SpendFilters & {
  group: SpendDetailsGroup;
  /** Local `YYYY-MM-DD` (a heat cell); replaces the rolling range. */
  day?: string;
  /** Only failed runs of this type (replaces InsightBucket.failureRunIds drill-down). */
  failure?: FailureType;
  offset: number;
  limit: number;
};
export type SpendDetails = {
  query: SpendDetailsQuery;
  interval: { from: string; to: string };
  /** Aggregates of the whole selection; `perRun` holds the page when group=run, else []. */
  report: UsageReport;
  /** Page when group=task, else []. Sorted by billed dollars. */
  tasks: SpendTask[];
  /** Page when group=project, else []. Sorted by billed dollars. */
  projects: SpendProject[];
  total: number;
  offset: number;
  limit: number;
  nextOffset?: number;
};

/* Small ledger of budget, credit and quota periods (table spend_ledger). Only the server reads it. */
export type SpendLedgerKind =
  'period-start' | 'adjustment' | 'renewal' | 'expiry' | 'removed' | 'extra-usage' | 'quota-reading';
export type SpendLedgerEntry = {
  seq: number;
  runtimeId: string;
  /** API: `${targetId}@${policy.startedAt}`; quota: `${runtimeId}/${windowId}@${resetsAt}`. */
  periodId: string;
  kind: SpendLedgerKind;
  at: string;
  /** Kind-specific scalars (limits, expiry, cost, tokens, usedPercent…). Never credentials or fingerprints. */
  data: Record<string, string | number | boolean | null>;
};
