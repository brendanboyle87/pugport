import type { Project, Workflow } from '../shared/types.ts';
import { layaRouteDecision } from '../shared/laya-route-decision.ts';
import {
  cacheReuseRate,
  hasCacheReuseUsage,
  usageMetricKeys,
  type UsageAggregate,
  type UsageReport,
  type UsageRun,
} from '../shared/usage.ts';
import {
  failureTypes,
  routingOutcomes,
  type FailureType,
  type InsightBreakdown,
  type InsightBucket,
  type InsightFilters,
  type InsightPercentiles,
  type InsightSummary,
  type InsightTile,
  type UsageInsights,
  type RoutingInsights,
  type RoutingOutcome,
} from '../shared/usage-insights.ts';
import { taskCosts } from './task-costs.ts';

const hour = 3_600_000;
const day = 24 * hour;
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ratio = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : null);
const sum = (values: Array<number | null | undefined>) => {
  const known = values.filter(numeric);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};
const pathKey = (value: string) =>
  /^[a-z]:[\\/]/i.test(value)
    ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : value.replace(/\/+$/, '') || '/';

/** Continuous sample quantiles, calculated from individual observations. */
export function observationPercentiles(values: number[]): InsightPercentiles {
  const sorted = values.filter(numeric).sort((a, b) => a - b);
  const quantile = (p: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
  };
  return { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99), n: sorted.length };
}

export function failureType(errorCode?: string | null): FailureType {
  const code = (errorCode ?? '').toLowerCase();
  if (/quota|rate[-_ ]?limit|too[-_ ]?many[-_ ]?requests|\b429\b/.test(code)) return 'rate-limit';
  if (/timeout|timed[-_ ]?out|deadline/.test(code)) return 'timeout';
  if (/auth|unauthor|credential|login|\b401\b|\b403\b/.test(code)) return 'auth';
  if (/sandbox|tool|permission|approval/.test(code)) return 'tool';
  if (/network|connection|dns|econn|fetch|socket|transport/.test(code)) return 'network';
  if (/content|refus|policy[-_ ]?block|safety/.test(code)) return 'content';
  return 'unclassified';
}

export function selectBucket(from: number, to: number): { bucket: 'hour' | 'day' | 'week'; bucketMs: number } {
  const duration = Math.max(1, to - from);
  const bucket = duration <= 48 * hour ? 'hour' : duration <= 90 * day ? 'day' : 'week';
  const base = bucket === 'hour' ? hour : bucket === 'day' ? day : 7 * day;
  return { bucket, bucketMs: Math.ceil(duration / (base * 400)) * base };
}

function elapsed(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return numeric(value) ? value : null;
}
const terminal = (run: UsageRun) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);
const cacheRows = (rows: UsageRun[]) => rows.filter(hasCacheReuseUsage);

/** Disjoint chart buckets only; ambiguous output remains absent and reduces coverage, never ledger totals. */
export function chartTokenMeasures(row: UsageRun): {
  input: number | null;
  cache: number | null;
  output: number | null;
  reasoning: number | null;
} {
  const result = {
    input: numeric(row.inputTokens) ? row.inputTokens : null,
    cache: numeric(row.cacheReadTokens) ? row.cacheReadTokens : null,
    output: numeric(row.outputTokens) ? row.outputTokens : null,
    reasoning: numeric(row.reasoningOutputTokens) ? row.reasoningOutputTokens : null,
  };
  if (result.reasoning === null || result.reasoning === 0 || result.output === null) return result;
  const reconciledGrok =
    row.provider === 'grok' &&
    numeric(row.inputTokens) &&
    numeric(row.cacheReadTokens) &&
    numeric(row.cacheWriteTokens) &&
    numeric(row.totalTokens) &&
    row.totalTokens === row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + result.output;
  if ((row.provider === 'codex' || reconciledGrok) && result.reasoning <= result.output)
    result.output -= result.reasoning;
  else {
    // A separate reasoning count alone cannot establish whether output already includes it.
    result.output = null;
    result.reasoning = null;
  }
  return result;
}

type TaskContext = { root: (run: UsageRun) => string; success: (id: string, members: UsageRun[]) => boolean };
function taskContext(allRows: UsageRun[], workflows: Workflow[]): TaskContext {
  const byRun = new Map(allRows.map((row) => [row.runId, row]));
  const byWorkflow = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const workflowRoots = new Map<string, string>();
  const workflowRoot = (id: string) => {
    const original = id;
    const known = workflowRoots.get(id);
    if (known) return known;
    const visited = new Set<string>();
    while (!visited.has(id)) {
      visited.add(id);
      const workflow = byWorkflow.get(id);
      const parent = workflow?.delegation?.parentId ?? workflow?.parentWorkflowId;
      if (!parent) break;
      id = parent;
    }
    workflowRoots.set(original, id);
    return id;
  };
  const latestByRoot = new Map<string, Workflow>();
  for (const workflow of workflows) {
    if (workflow.delegation) continue;
    const id = workflowRoot(workflow.id);
    const previous = latestByRoot.get(id);
    if (!previous || workflow.createdAt > previous.createdAt) latestByRoot.set(id, workflow);
  }
  const root = (run: UsageRun): string => {
    const visited = new Set<string>();
    let current = run;
    while (!visited.has(current.runId)) {
      visited.add(current.runId);
      if (current.workflowId) return `workflow:${workflowRoot(current.workflowId)}`;
      const parentId = current.relay?.fromRunId ?? current.parentRunId;
      if (!parentId) return `run:${current.runId}`;
      const parent = byRun.get(parentId);
      if (!parent) return `run:${parentId}`;
      current = parent;
    }
    return `run:${[...visited].sort()[0]}`;
  };
  return {
    root,
    success(id, members) {
      if (id.startsWith('workflow:')) {
        const workflowId = id.slice('workflow:'.length);
        const latest = latestByRoot.get(workflowId);
        if (latest) return latest.status === 'completed';
      }
      const last = [...members].sort(
        (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
      )[0];
      return last?.status === 'completed';
    },
  };
}

function summarize(rows: UsageRun[], context: TaskContext): InsightSummary {
  const groups = new Map<string, UsageRun[]>();
  for (const row of rows) {
    if (row.status === 'queued') continue;
    const id = context.root(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  const successful = [...groups].filter(([id, members]) => context.success(id, members));
  const successfulRuns = successful.flatMap(([, members]) => members);
  const fallbackRoots = new Set(
    rows
      .filter(
        (row) =>
          row.status !== 'queued' &&
          row.relay &&
          row.relay.reason !== 'selection' &&
          row.relay.fromRuntimeId !== row.runtimeId,
      )
      .map(context.root),
  );
  const completed = rows.filter((r) => r.status === 'completed').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const durations = rows
    .filter(terminal)
    .map((r) => elapsed(r.startedAt, r.endedAt))
    .filter(numeric);
  const firstTexts = rows.map((r) => elapsed(r.adapterStartedAt, r.firstTextAt)).filter(numeric);
  const usageRows = rows.filter((r) => r.accountingMode === 'usage');
  const successCost = sum(successfulRuns.filter((r) => r.accountingMode === 'usage').map((r) => r.estimatedCostUsd));
  return {
    runs: rows.length,
    spendUsd: sum(usageRows.map((r) => r.estimatedCostUsd)),
    subscriptionReferenceUsd: sum(
      rows.filter((r) => r.accountingMode === 'subscription').map((r) => r.estimatedCostUsd),
    ),
    unknownBillingUsd: sum(rows.filter((r) => r.accountingMode === 'unknown').map((r) => r.estimatedCostUsd)),
    attemptedTasks: groups.size,
    successfulTasks: successful.length,
    successRate: ratio(successful.length, groups.size),
    completed,
    failed,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    interrupted: rows.filter((r) => r.status === 'interrupted').length,
    cacheHitRate: cacheReuseRate(rows),
    failureRate: ratio(failed, completed + failed),
    fallbackRate: ratio(fallbackRoots.size, groups.size),
    fallbacks: fallbackRoots.size,
    costPerSuccessfulTask: successCost === null ? null : ratio(successCost, successful.length),
    duration: observationPercentiles(durations),
    firstText: observationPercentiles(firstTexts),
    coverage: {
      runs: rows.length,
      cost: rows.filter((r) => numeric(r.estimatedCostUsd)).length,
      usageCost: usageRows.filter((r) => numeric(r.estimatedCostUsd)).length,
      usageRuns: usageRows.length,
      cache: cacheRows(rows).length,
      tokens: rows.filter((r) => Object.values(chartTokenMeasures(r)).every(numeric)).length,
      duration: durations.length,
      firstText: firstTexts.length,
      executionKind: rows.filter((r) => r.executionKind === 'cli' || r.executionKind === 'api').length,
      classifiedFailures: rows.filter((r) => r.status === 'failed' && failureType(r.errorCode) !== 'unclassified')
        .length,
    },
  };
}

function aggregate(rows: UsageRun[]): UsageAggregate {
  return {
    ...Object.fromEntries(usageMetricKeys.map((key) => [key, sum(rows.map((row) => row[key]))])),
    runs: rows.length,
    reportedRuns: rows.filter((r) => usageMetricKeys.some((key) => numeric(r[key]))).length,
    tokenReportedRuns: rows.filter((r) => usageMetricKeys.some((key) => key !== 'estimatedCostUsd' && numeric(r[key])))
      .length,
    costReportedRuns: rows.filter((r) => numeric(r.estimatedCostUsd)).length,
    historyImportedRuns: rows.filter((r) => r.historyImported).length,
    uncertainRuns: rows.filter((r) => r.uncertain).length,
    accountingRuns: Object.fromEntries(
      ['subscription', 'usage', 'unknown'].map((mode) => [mode, rows.filter((r) => r.accountingMode === mode).length]),
    ),
    metricReportedRuns: Object.fromEntries(
      usageMetricKeys.map((key) => [key, rows.filter((r) => numeric(r[key])).length]),
    ),
  } as UsageAggregate;
}
function groupRows(rows: UsageRun[], key: (row: UsageRun) => string): UsageRun[][] {
  const groups = new Map<string, UsageRun[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return [...groups.values()];
}

export function routingInsights(
  workflows: Workflow[],
  runs: UsageRun[],
  filters: InsightFilters,
  now: Date,
  projects: Pick<Project, 'id' | 'path'>[] = [],
): RoutingInsights {
  const byProject = new Map(projects.map((project) => [project.id, project.path]));
  const runsByWorkflow = new Map<string, UsageRun[]>();
  for (const run of runs)
    if (run.workflowId) {
      const members = runsByWorkflow.get(run.workflowId);
      if (members) members.push(run);
      else runsByWorkflow.set(run.workflowId, [run]);
    }
  const selected = workflows.filter((workflow) => {
    if (
      !workflow.laya ||
      workflow.delegation ||
      workflow.deletedAt ||
      workflow.laya.inference.reason === 'queued-pending-judgment'
    )
      return false;
    if (!filters.project) return true;
    const path = byProject.get(workflow.projectId);
    return path
      ? pathKey(path) === pathKey(filters.project)
      : (runsByWorkflow.get(workflow.id) ?? []).some((run) => pathKey(run.projectPath) === pathKey(filters.project!));
  });
  const to = now.getTime();
  const from =
    filters.range === 'all'
      ? selected.reduce((earliest, workflow) => {
          const at = Date.parse(workflow.createdAt);
          return Number.isFinite(at) && at < to ? Math.min(earliest, at) : earliest;
        }, to - day)
      : to - { '24h': day, '7d': 7 * day, '30d': 30 * day }[filters.range];
  const rows = selected.filter(
    (workflow) => Date.parse(workflow.createdAt) >= from && Date.parse(workflow.createdAt) < to,
  );
  const origin = (workflow: Workflow) => {
    const { device, reason } = workflow.laya!.inference;
    return device?.startsWith('cloud') || reason === 'cloud'
      ? 'cloud'
      : device?.startsWith('cuda') || reason === 'local_cuda'
        ? 'local'
        : 'unknown';
  };
  const outcome = (workflow: Workflow): RoutingOutcome => {
    const inference = workflow.laya!.inference;
    if (inference.status === 'ok')
      return ({ local: 'okLocal', cloud: 'okCloud', unknown: 'okUnknown' } as const)[origin(workflow)];
    const reason = inference.reason.toLowerCase();
    if (inference.status === 'skipped')
      return /privacy|incognito|not_recorded/.test(reason) ? 'skipped' : 'skippedOther';
    if (/timeout|timed.out|deadline/.test(reason)) return 'timeout';
    if (/warming|starting/.test(reason)) return 'warming';
    if (/busy|cooldown/.test(reason)) return 'busy';
    return 'error';
  };
  const latency = (members: Workflow[]) =>
    observationPercentiles(
      members
        .filter((workflow) => workflow.laya!.inference.status === 'ok')
        .map((workflow) => workflow.laya!.inference.latencyMs)
        .filter(numeric),
    );
  const available = rows.filter((workflow) => workflow.laya!.inference.status === 'ok');
  const attempted = rows.filter((workflow) => workflow.laya!.inference.status !== 'skipped').length;
  const handlingLaya = rows.filter((workflow) => workflow.handlingSource === 'laya').length;
  const handlingRules = rows.filter((workflow) => workflow.handlingSource === 'rules').length;
  const choices = available.flatMap((workflow) =>
    workflow.laya!.inference.choices ? [workflow.laya!.inference.choices!] : [],
  );
  const decisions = { reply: 0, task: 0, unknown: available.length - choices.length };
  for (const choice of choices) decisions[layaRouteDecision(choice)?.handling ?? 'unknown']++;
  const ranked = (keys: string[]) => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return [...counts]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  const bucket = selectBucket(from, to);
  const buckets: RoutingInsights['buckets'] = [];
  for (let start = from; start < to; start += bucket.bucketMs) {
    const end = Math.min(to, start + bucket.bucketMs);
    const members = rows.filter(
      (workflow) => Date.parse(workflow.createdAt) >= start && Date.parse(workflow.createdAt) < end,
    );
    const outcomes = Object.fromEntries(routingOutcomes.map((key) => [key, 0])) as Record<RoutingOutcome, number>;
    for (const workflow of members) outcomes[outcome(workflow)]++;
    buckets.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      outcomes,
      latency: latency(members),
    });
  }
  const localLatency = latency(available.filter((workflow) => origin(workflow) === 'local'));
  const cloudLatency = latency(available.filter((workflow) => origin(workflow) === 'cloud'));
  return {
    interval: { from: new Date(from).toISOString(), to: now.toISOString(), ...bucket },
    judged: rows.length,
    handlingLaya,
    handlingRules,
    handlingUnknown: rows.length - handlingLaya - handlingRules,
    decidedShare: ratio(handlingLaya, handlingLaya + handlingRules),
    attempted,
    available: available.length,
    availability: ratio(available.length, attempted),
    skipped: rows.filter((workflow) => outcome(workflow) === 'skipped').length,
    otherSkipped: rows.filter((workflow) => outcome(workflow) === 'skippedOther').length,
    latency: latency(rows),
    localLatency,
    cloudLatency,
    localSamples: localLatency.n,
    cloudSamples: cloudLatency.n,
    unknownSamples: latency(available.filter((workflow) => origin(workflow) === 'unknown')).n,
    buckets,
    decisions,
    taskTypes: ranked(choices.map((choice) => choice.task_type)),
    difficulty: ranked(choices.map((choice) => choice.difficulty)),
    recent: [...rows]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, 50)
      .map((workflow) => {
        const inference = workflow.laya!.inference;
        const memberRuns = runsByWorkflow.get(workflow.id) ?? [];
        return {
          workflowId: workflow.id,
          conversationId: workflow.conversationId,
          at: workflow.createdAt,
          excerpt: Array.from(workflow.input.content).slice(0, 60).join(''),
          outcome: outcome(workflow),
          reason: inference.reason,
          latencyMs: inference.status !== 'skipped' && numeric(inference.latencyMs) ? inference.latencyMs : null,
          handling: workflow.handlingSource ?? null,
          decision:
            inference.status === 'ok' && inference.choices
              ? (layaRouteDecision(inference.choices)?.handling ?? null)
              : null,
          failed: memberRuns.length ? memberRuns.some((run) => run.status === 'failed') : null,
        };
      }),
  };
}

/** Uses all ledger rows. Detail tables and analytics share the same selection. */
export function usageInsights(
  source: UsageReport,
  workflows: Workflow[],
  filters: InsightFilters = { range: '7d', kind: 'all' },
  now = new Date(),
  projects: Pick<Project, 'id' | 'path'>[] = [],
): UsageInsights {
  const to = now.getTime();
  const selected = source.perRun.filter(
    (r) =>
      (!filters.project || pathKey(r.projectPath) === pathKey(filters.project)) &&
      (!filters.runtime || r.runtimeId === filters.runtime) &&
      (filters.kind === 'all' || r.executionKind === filters.kind),
  );
  const validTimes = selected
    .map((r) => Date.parse(r.startedAt))
    .filter((value) => Number.isFinite(value) && value <= to);
  const from =
    filters.range === 'all'
      ? validTimes.reduce((earliest, time) => Math.min(earliest, time), to - day)
      : to - { '24h': day, '7d': 7 * day, '30d': 30 * day }[filters.range];
  const inInterval = (rows: UsageRun[], start: number, end: number) =>
    rows.filter((r) => Date.parse(r.startedAt) >= start && Date.parse(r.startedAt) < end);
  const rows = inInterval(selected, from, to);
  const context = taskContext(source.perRun, workflows);
  const summary = summarize(rows, context);
  const previous = summarize(inInterval(selected, from - (to - from), from), context);
  const bucket = selectBucket(from, to);
  const buckets: InsightBucket[] = [];
  for (let start = from; start < to; start += bucket.bucketMs) {
    const end = Math.min(to, start + bucket.bucketMs);
    const members = inInterval(rows, start, end);
    const tokenMeasures = members.map(chartTokenMeasures);
    const stats = summarize(members, context);
    const failures = Object.fromEntries(
      failureTypes.map((type) => [
        type,
        members.filter((r) => r.status === 'failed' && failureType(r.errorCode) === type).length,
      ]),
    ) as InsightBucket['failures'];
    buckets.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      runs: members.length,
      spendUsd: members.length ? stats.spendUsd : 0,
      spendByRuntime: Object.fromEntries(
        groupRows(
          members.filter((r) => r.accountingMode === 'usage'),
          (r) => r.runtimeId,
        ).map((group) => [group[0]!.runtimeId, sum(group.map((r) => r.estimatedCostUsd))]),
      ),
      subscriptionReferenceUsd: members.length ? stats.subscriptionReferenceUsd : 0,
      tokens: {
        input: sum(tokenMeasures.map((r) => r.input)) ?? 0,
        cache: sum(tokenMeasures.map((r) => r.cache)) ?? 0,
        output: sum(tokenMeasures.map((r) => r.output)) ?? 0,
        reasoning: sum(tokenMeasures.map((r) => r.reasoning)) ?? 0,
      },
      cacheHitRate: stats.cacheHitRate,
      cacheByKind: {
        cli: cacheReuseRate(members.filter((r) => r.executionKind === 'cli')),
        api: cacheReuseRate(members.filter((r) => r.executionKind === 'api')),
      },
      failureRate: stats.failureRate,
      failures,
      failureRunIds: Object.fromEntries(
        failureTypes.map((type) => [
          type,
          members.filter((r) => r.status === 'failed' && failureType(r.errorCode) === type).map((r) => r.runId),
        ]),
      ) as InsightBucket['failureRunIds'],
      duration: stats.duration,
      firstText: stats.firstText,
      coverage: stats.coverage,
    });
  }
  const trend = (members: UsageRun[]) =>
    Array.from({ length: 7 }, (_, index) => {
      const segment = inInterval(members, from + ((to - from) * index) / 7, from + ((to - from) * (index + 1)) / 7);
      return segment.length ? summarize(segment, context).spendUsd : 0;
    });
  const breakdown = (members: UsageRun[], model?: string): InsightBreakdown => ({
    ...summarize(members, context),
    runtimeId: members[0]!.runtimeId,
    label: members[0]!.runtimeLabel,
    model,
    executionKinds: [
      ...new Set(
        members.map((r) => r.executionKind).filter((kind): kind is 'cli' | 'api' => kind === 'cli' || kind === 'api'),
      ),
    ],
    spendTrend: trend(members),
    models:
      model === undefined ? groupRows(members, (r) => r.model).map((group) => breakdown(group, group[0]!.model)) : [],
  });
  const delta = (
    value: number | null,
    prior: number | null,
    currentCoverage: number | null,
    priorCoverage: number | null,
  ) =>
    filters.range !== 'all' &&
    value !== null &&
    prior !== null &&
    prior !== 0 &&
    currentCoverage !== null &&
    currentCoverage === priorCoverage
      ? (value - prior) / prior
      : null;
  const tile = (
    value: number | null,
    prior: number | null,
    sample: number,
    population: number,
    priorSample: number,
    priorPopulation: number,
    sparkline: Array<number | null>,
    secondary: number | null = null,
  ): InsightTile => ({
    value,
    secondary,
    delta: delta(value, prior, ratio(sample, population), ratio(priorSample, priorPopulation)),
    sample,
    missing: population - sample,
    sparkline,
  });
  const bucketSummaries = buckets.map((b) =>
    summarize(inInterval(rows, Date.parse(b.start), Date.parse(b.end)), context),
  );
  const report: UsageReport = {
    generatedAt: now.toISOString(),
    filters: {
      projectPath: filters.project,
      runtimeId: filters.runtime,
      from: new Date(from).toISOString(),
      to: now.toISOString(),
    },
    totals: aggregate(rows),
    perRun: rows,
    byProject: groupRows(rows, (r) => pathKey(r.projectPath)).map((group) => ({
      projectPath: group[0]!.projectPath,
      ...aggregate(group),
    })),
    byRuntime: groupRows(rows, (r) => r.runtimeId).map((group) => ({
      runtimeId: group[0]!.runtimeId,
      label: group[0]!.runtimeLabel,
      provider: group[0]!.provider,
      ...aggregate(group),
    })),
    byModel: groupRows(rows, (r) => JSON.stringify([r.runtimeId, r.model])).map((group) => ({
      runtimeId: group[0]!.runtimeId,
      model: group[0]!.model,
      ...aggregate(group),
    })),
    note: source.note,
  };
  return {
    generatedAt: now.toISOString(),
    filters,
    interval: { from: new Date(from).toISOString(), to: now.toISOString(), ...bucket },
    summary,
    tiles: {
      spend: tile(
        summary.spendUsd,
        previous.spendUsd,
        summary.coverage.usageCost,
        summary.coverage.usageRuns,
        previous.coverage.usageCost,
        previous.coverage.usageRuns,
        buckets.map((b) => b.spendUsd),
        summary.subscriptionReferenceUsd,
      ),
      success: tile(
        summary.successfulTasks,
        previous.successfulTasks,
        summary.attemptedTasks,
        summary.attemptedTasks,
        previous.attemptedTasks,
        previous.attemptedTasks,
        bucketSummaries.map((b) => b.successfulTasks),
        summary.successRate,
      ),
      cache: tile(
        summary.cacheHitRate,
        previous.cacheHitRate,
        summary.coverage.cache,
        summary.runs,
        previous.coverage.cache,
        previous.runs,
        buckets.map((b) => b.cacheHitRate),
      ),
      failure: tile(
        summary.failureRate,
        previous.failureRate,
        summary.completed + summary.failed,
        summary.runs,
        previous.completed + previous.failed,
        previous.runs,
        buckets.map((b) => b.failureRate),
      ),
      duration: tile(
        summary.duration.p50,
        previous.duration.p50,
        summary.duration.n,
        summary.runs,
        previous.duration.n,
        previous.runs,
        buckets.map((b) => b.duration.p50),
        summary.duration.p95,
      ),
      fallback: tile(
        summary.fallbackRate,
        previous.fallbackRate,
        summary.attemptedTasks,
        summary.attemptedTasks,
        previous.attemptedTasks,
        previous.attemptedTasks,
        bucketSummaries.map((b) => b.fallbackRate),
      ),
    },
    buckets,
    executors: groupRows(rows, (r) => r.runtimeId)
      .map((group) => breakdown(group))
      .sort((a, b) => (b.spendUsd ?? 0) - (a.spendUsd ?? 0) || a.runtimeId.localeCompare(b.runtimeId)),
    projects: [
      ...new Set([
        ...source.perRun.map((r) => r.projectPath),
        ...projects
          .filter((project) =>
            workflows.some(
              (workflow) =>
                workflow.projectId === project.id &&
                workflow.laya &&
                workflow.laya.inference.reason !== 'queued-pending-judgment' &&
                !workflow.delegation &&
                !workflow.deletedAt,
            ),
          )
          .map((project) => project.path),
      ]),
    ].sort(),
    runtimes: [
      ...new Map(source.perRun.map((r) => [r.runtimeId, { id: r.runtimeId, label: r.runtimeLabel }])).values(),
    ],
    report,
    tasks: taskCosts(workflows, rows, Number.MAX_SAFE_INTEGER),
    routing: routingInsights(workflows, source.perRun, filters, now, projects),
  };
}
