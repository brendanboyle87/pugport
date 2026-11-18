import type { TaskCost, UsageReport } from './usage.ts';

export type InsightRange = '24h' | '7d' | '30d' | 'all';
export type InsightKind = 'all' | 'cli' | 'api';
export type InsightFilters = { range: InsightRange; kind: InsightKind; project?: string; runtime?: string };
export const failureTypes = ['rate-limit', 'timeout', 'auth', 'tool', 'network', 'content', 'unclassified'] as const;
export type FailureType = (typeof failureTypes)[number];
export type InsightPercentiles = { p50: number | null; p95: number | null; p99: number | null; n: number };
export type InsightCoverage = {
  runs: number;
  cost: number;
  usageCost: number;
  usageRuns: number;
  cache: number;
  tokens: number;
  duration: number;
  firstText: number;
  executionKind: number;
  classifiedFailures: number;
};
export type InsightSummary = {
  runs: number;
  spendUsd: number | null;
  subscriptionReferenceUsd: number | null;
  unknownBillingUsd: number | null;
  attemptedTasks: number;
  successfulTasks: number;
  successRate: number | null;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  cacheHitRate: number | null;
  failureRate: number | null;
  fallbackRate: number | null;
  fallbacks: number;
  costPerSuccessfulTask: number | null;
  duration: InsightPercentiles;
  firstText: InsightPercentiles;
  coverage: InsightCoverage;
};
export type InsightTile = {
  value: number | null;
  secondary: number | null;
  delta: number | null;
  sample: number;
  missing: number;
  sparkline: Array<number | null>;
};
export type InsightBucket = {
  start: string;
  end: string;
  runs: number;
  spendUsd: number | null;
  spendByRuntime: Record<string, number | null>;
  subscriptionReferenceUsd: number | null;
  tokens: { input: number; cache: number; output: number; reasoning: number };
  cacheHitRate: number | null;
  cacheByKind: { cli: number | null; api: number | null };
  failureRate: number | null;
  failures: Record<FailureType, number>;
  failureRunIds: Record<FailureType, string[]>;
  duration: InsightPercentiles;
  firstText: InsightPercentiles;
  coverage: InsightCoverage;
};
export type InsightBreakdown = InsightSummary & {
  runtimeId: string;
  label: string;
  model?: string;
  executionKinds: Array<'cli' | 'api'>;
  spendTrend: Array<number | null>;
  models: InsightBreakdown[];
};
export const routingOutcomes = [
  'okLocal',
  'okCloud',
  'timeout',
  'warming',
  'busy',
  'error',
  'skipped',
  'okUnknown',
  'skippedOther',
] as const;
export type RoutingOutcome = (typeof routingOutcomes)[number];
export type RoutingInsights = {
  interval: { from: string; to: string; bucket: 'hour' | 'day' | 'week'; bucketMs: number };
  judged: number;
  handlingLaya: number;
  handlingRules: number;
  handlingUnknown: number;
  decidedShare: number | null;
  attempted: number;
  available: number;
  availability: number | null;
  skipped: number;
  otherSkipped: number;
  latency: InsightPercentiles;
  localLatency: InsightPercentiles;
  cloudLatency: InsightPercentiles;
  localSamples: number;
  cloudSamples: number;
  unknownSamples: number;
  buckets: Array<{ start: string; end: string; outcomes: Record<RoutingOutcome, number>; latency: InsightPercentiles }>;
  decisions: { reply: number; task: number; unknown: number };
  taskTypes: Array<{ key: string; count: number }>;
  difficulty: Array<{ key: string; count: number }>;
  recent: Array<{
    workflowId: string;
    conversationId: string;
    at: string;
    excerpt: string;
    outcome: RoutingOutcome;
    reason: string;
    latencyMs: number | null;
    handling: 'laya' | 'rules' | null;
    decision: 'reply' | 'task' | null;
    failed: boolean | null;
  }>;
};
export type UsageInsights = {
  generatedAt: string;
  filters: InsightFilters;
  interval: { from: string; to: string; bucket: 'hour' | 'day' | 'week'; bucketMs: number };
  summary: InsightSummary;
  tiles: Record<'spend' | 'success' | 'cache' | 'failure' | 'duration' | 'fallback', InsightTile>;
  buckets: InsightBucket[];
  executors: InsightBreakdown[];
  projects: string[];
  runtimes: Array<{ id: string; label: string }>;
  report: UsageReport;
  tasks: TaskCost[];
  routing: RoutingInsights;
};
