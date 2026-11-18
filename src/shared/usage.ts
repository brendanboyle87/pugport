import type { Provider, RunRecord } from './types.ts';

export type AccountingMode = 'subscription' | 'usage' | 'unknown';
export type UsageProvider = Provider | 'unknown';
export const usageMetricKeys = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'estimatedCostUsd',
] as const;
export type UsageMetric = (typeof usageMetricKeys)[number];
/** Null means not reported. A reported zero is retained as zero. Costs are runtime estimates, not invoices. */
export type UsageMeasures = Record<UsageMetric, number | null>;
export type UsageAggregate = UsageMeasures & {
  runs: number;
  reportedRuns: number;
  tokenReportedRuns: number;
  costReportedRuns: number;
  historyImportedRuns: number;
  uncertainRuns: number;
  accountingRuns: Record<AccountingMode, number>;
  metricReportedRuns: Record<UsageMetric, number>;
};
export type UsageRun = UsageMeasures & {
  runId: string;
  projectPath: string;
  runtimeId: string;
  runtimeLabel: string;
  provider: UsageProvider;
  model: string;
  /** Launch snapshots; absent on older clients, null when historical evidence is unavailable. */
  executionKind?: 'cli' | 'api' | null;
  apiProvider?: string | null;
  effort?: string | null;
  errorCode?: string | null;
  parentRunId?: string | null;
  relay?: RunRecord['relay'] | null;
  adapterStartedAt?: string | null;
  firstTextAt?: string | null;
  adapterEndedAt?: string | null;
  accountingMode: AccountingMode;
  status: RunRecord['status'];
  startedAt: string;
  endedAt?: string;
  nativeSessionId?: string;
  workflowId?: string;
  eventCount: number;
  historyImported: boolean;
  uncertain: boolean;
  sources: string[];
  notes: string[];
};
export type UsageFilters = { projectPath?: string; runtimeId?: string; from?: string; to?: string };
export type UsageReport = {
  generatedAt: string;
  filters: UsageFilters;
  totals: UsageAggregate;
  byProject: Array<UsageAggregate & { projectPath: string }>;
  byRuntime: Array<UsageAggregate & { runtimeId: string; label: string; provider: UsageProvider }>;
  byModel: Array<UsageAggregate & { runtimeId: string; model: string }>;
  perRun: UsageRun[];
  note: string;
};

/** What a whole task cost (server/task-costs.ts): the task, its subtasks, reviews, fixes and retries. */
export type TaskCost = UsageMeasures & {
  taskId: string;
  conversationId: string;
  title: string;
  startedAt: string;
  status: string;
  /** Runs in all, and how they split: subtasks, reviews, automatic fixes and continuations, retries. */
  runs: number;
  subtasks: number;
  reviews: number;
  fixes: number;
  retries: number;
  executors: string[];
};

/** Canonical inputTokens are uncached input. Cache writes never enter reuse eligibility. */
export function hasCacheReuseUsage(row: UsageMeasures): boolean {
  return [row.inputTokens, row.cacheReadTokens].every(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );
}
export function cacheReuseRate(rows: UsageMeasures[]): number | null {
  const known = rows.filter(hasCacheReuseUsage);
  if (!known.length) return null;
  const read = known.reduce((sum, row) => sum + row.cacheReadTokens!, 0);
  const eligible = known.reduce((sum, row) => sum + row.inputTokens! + row.cacheReadTokens!, 0);
  return eligible > 0 ? read / eligible : 0;
}
