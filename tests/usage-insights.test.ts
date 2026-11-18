import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  failureType,
  observationPercentiles,
  routingInsights,
  selectBucket,
  usageInsights,
} from '../src/server/usage-insights.ts';
import type { LayaChoices, LayaInference } from '../src/shared/laya.ts';
import type { UsageReport, UsageRun } from '../src/shared/usage.ts';
import type { Workflow } from '../src/shared/types.ts';

const now = new Date('2026-11-01T12:00:00.000Z');
const hour = 3_600_000;
const run = (id: string, extra: Partial<UsageRun> = {}): UsageRun => ({
  runId: id,
  projectPath: '/fixture',
  runtimeId: 'executor-a',
  runtimeLabel: 'Executor A',
  provider: 'unknown',
  model: 'model-a',
  accountingMode: 'usage',
  executionKind: 'api',
  status: 'completed',
  startedAt: '2026-11-01T10:00:00.000Z',
  endedAt: '2026-11-01T10:00:01.000Z',
  inputTokens: 80,
  cacheReadTokens: 20,
  cacheWriteTokens: 0,
  outputTokens: 10,
  reasoningOutputTokens: 2,
  totalTokens: 112,
  estimatedCostUsd: 1,
  eventCount: 1,
  historyImported: false,
  uncertain: false,
  sources: [],
  notes: [],
  ...extra,
});
const source = (rows: UsageRun[]): UsageReport => ({ perRun: rows, note: '' }) as UsageReport;
const insights = (rows: UsageRun[], flows: Workflow[] = []) =>
  usageInsights(source(rows), flows, { range: '24h', kind: 'all' }, now);
const workflow = (id: string, extra: Partial<Workflow> = {}): Workflow =>
  ({
    id,
    conversationId: 'conversation',
    createdAt: '2026-10-31T12:00:00.000Z',
    status: 'completed',
    input: { content: id },
    ...extra,
  }) as Workflow;

test('bucket selection uses hours, days and weeks and never exceeds 400 buckets', () => {
  assert.deepEqual(selectBucket(0, 48 * hour), { bucket: 'hour', bucketMs: hour });
  assert.deepEqual(selectBucket(0, 49 * hour), { bucket: 'day', bucketMs: 24 * hour });
  assert.equal(selectBucket(0, 91 * 24 * hour).bucket, 'week');
  const long = selectBucket(0, 100 * 365 * 24 * hour);
  assert.ok(Math.ceil((100 * 365 * 24 * hour) / long.bucketMs) <= 400);
  const result = insights([run('only')]);
  assert.equal(result.buckets.length, 24);
  assert.equal(result.buckets.filter((bucket) => bucket.runs === 0).length, 23);
  assert.equal(result.buckets[0]!.spendUsd, 0);
  assert.equal(result.buckets[0]!.cacheHitRate, null);
  assert.equal(
    result.buckets.reduce((total, bucket) => total + bucket.runs, 0),
    1,
  );
});

test('spend buckets distinguish unknown costs from empty intervals and reported zero', () => {
  const result = insights([
    run('unknown', { estimatedCostUsd: null }),
    run('free', { runtimeId: 'executor-b', estimatedCostUsd: 0 }),
  ]);
  const populated = result.buckets.find((bucket) => bucket.runs)!;
  assert.equal(populated.spendByRuntime['executor-a'], null);
  assert.equal(populated.spendByRuntime['executor-b'], 0);
  assert.deepEqual(result.buckets[0]!.spendByRuntime, {});
  assert.equal(result.buckets[0]!.spendUsd, 0);
});

test('cache and failure ratios use summed numerators and matched reporting populations', () => {
  const result = insights([
    run('small', { inputTokens: 0, cacheReadTokens: 10 }),
    run('large', { inputTokens: 90, cacheReadTokens: 0, status: 'failed' }),
    run('missing', { inputTokens: null, cacheReadTokens: 900, status: 'cancelled' }),
    run('interrupted', { inputTokens: null, cacheReadTokens: null, status: 'interrupted' }),
  ]);
  assert.equal(result.summary.cacheHitRate, 0.1);
  assert.equal(result.summary.failureRate, 0.5);
  assert.equal(result.summary.cancelled, 1);
  assert.equal(result.summary.interrupted, 1);
  assert.equal(result.summary.coverage.cache, 2);
  assert.equal(result.tiles.cache.missing, 2);
});

test('quantiles use individual observations and exclude invalid or nonterminal duration samples', () => {
  const quantiles = observationPercentiles([100, 200, 1000, -1, NaN]);
  assert.equal(quantiles.p50, 200);
  assert.ok(Math.abs(quantiles.p95! - 920) < 0.000001);
  assert.equal(quantiles.p99, 984);
  assert.equal(quantiles.n, 3);
  const result = insights([
    run('fast', { adapterStartedAt: '2026-11-01T10:00:00.000Z', firstTextAt: '2026-11-01T10:00:00.100Z' }),
    run('slow', { endedAt: '2026-11-01T10:00:09.000Z' }),
    run('running', { status: 'running', endedAt: undefined }),
    run('invalid', { endedAt: '2026-11-01T09:00:00.000Z' }),
  ]);
  assert.equal(result.summary.duration.p50, 5000);
  assert.equal(result.summary.duration.p95, 8600);
  assert.equal(result.summary.duration.n, 2);
  assert.equal(result.summary.firstText.p50, 100);
  assert.equal(result.summary.firstText.n, 1);
});

test('failure categories use error codes and preserve unclassified failures', () => {
  const cases = [
    ['quota-or-rate-limit', 'rate-limit'],
    ['execution-timeout', 'timeout'],
    ['authentication-required', 'auth'],
    ['sandbox-denied', 'tool'],
    ['network-error', 'network'],
    ['content-refused', 'content'],
    ['verification-failed', 'unclassified'],
  ] as const;
  for (const [code, expected] of cases) assert.equal(failureType(code), expected);
  assert.equal(failureType(null), 'unclassified');
  const result = insights(cases.map(([errorCode], index) => run(`failure-${index}`, { errorCode, status: 'failed' })));
  const bucket = result.buckets.find((b) => b.runs)!;
  assert.deepEqual(Object.values(bucket.failures), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(bucket.failureRunIds.unclassified, ['failure-6']);
  assert.equal(result.summary.coverage.classifiedFailures, 6);
});

test('fallbacks count task roots once and require a non-selection executor switch', () => {
  const result = insights(
    [
      run('root', { workflowId: 'root', status: 'failed' }),
      run('relay-one', {
        workflowId: 'child',
        runtimeId: 'executor-b',
        relay: { fromRunId: 'root', fromRuntimeId: 'executor-a', reason: 'quota' },
      }),
      run('relay-two', {
        workflowId: 'child',
        runtimeId: 'executor-c',
        relay: { fromRunId: 'relay-one', fromRuntimeId: 'executor-b', reason: 'technical' },
      }),
      run('selected', {
        workflowId: 'second',
        runtimeId: 'executor-b',
        relay: { fromRunId: 'old', fromRuntimeId: 'executor-a', reason: 'selection' },
      }),
      run('same', {
        workflowId: 'third',
        relay: { fromRunId: 'prior', fromRuntimeId: 'executor-a', reason: 'technical' },
      }),
    ],
    [
      workflow('root'),
      workflow('child', { delegation: { parentId: 'root', role: 'worker', requestId: 'request' } }),
      workflow('second'),
      workflow('third'),
    ],
  );
  assert.equal(result.summary.attemptedTasks, 3);
  assert.equal(result.summary.fallbacks, 1);
  assert.equal(result.summary.fallbackRate, 1 / 3);
  assert.equal(result.summary.successfulTasks, 3);
  assert.equal(result.tasks.find((task) => task.taskId === 'root')!.runs, 3);
});

test('continuations and relays without workflows retain one attempted task root', () => {
  const result = insights([
    run('root', { status: 'failed' }),
    run('next', {
      parentRunId: 'root',
      runtimeId: 'executor-b',
      startedAt: '2026-11-01T10:01:00.000Z',
      relay: { fromRunId: 'root', fromRuntimeId: 'executor-a', reason: 'technical' },
    }),
  ]);
  assert.equal(result.summary.attemptedTasks, 1);
  assert.equal(result.summary.successfulTasks, 1);
  assert.equal(result.summary.fallbackRate, 1);
});

test('billing dimensions remain separate with complete coverage counts and seven-point trends', () => {
  const result = insights([
    run('paid'),
    run('unknown-cost', { estimatedCostUsd: null }),
    run('reference', { accountingMode: 'subscription', executionKind: 'cli', estimatedCostUsd: 9 }),
    run('unknown-billing', { accountingMode: 'unknown', estimatedCostUsd: 12 }),
  ]);
  assert.equal(result.summary.spendUsd, 1);
  assert.equal(result.summary.subscriptionReferenceUsd, 9);
  assert.equal(result.summary.unknownBillingUsd, 12);
  assert.equal(result.summary.coverage.cost, 3);
  assert.equal(result.summary.coverage.usageCost, 1);
  assert.equal(result.summary.coverage.usageRuns, 2);
  assert.equal(result.tiles.spend.sample, 1);
  assert.equal(result.tiles.spend.missing, 1);
  assert.equal(result.executors[0]!.spendTrend.length, 7);
  assert.equal(result.executors[0]!.models[0]!.spendUsd, 1);
});

test('all filters apply equally to tiles, chart buckets, breakdowns and task/run/project tables', () => {
  const rows = [
    run('match', { workflowId: 'task', projectPath: 'C:\\Fixture', executionKind: 'cli' }),
    run('api', { workflowId: 'task', projectPath: 'C:\\Fixture' }),
    run('wrong-runtime', {
      workflowId: 'task',
      projectPath: 'C:\\Fixture',
      executionKind: 'cli',
      runtimeId: 'executor-b',
    }),
    run('wrong-project', { workflowId: 'task', executionKind: 'cli' }),
    run('too-old', {
      workflowId: 'task',
      executionKind: 'cli',
      projectPath: 'C:\\Fixture',
      startedAt: '2026-10-20T10:00:00.000Z',
    }),
  ];
  const result = usageInsights(
    source(rows),
    [workflow('task')],
    { range: '24h', kind: 'cli', project: 'c:/fixture/', runtime: 'executor-a' },
    now,
  );
  assert.equal(result.summary.runs, 1);
  assert.equal(
    result.buckets.reduce((n, bucket) => n + bucket.runs, 0),
    1,
  );
  assert.deepEqual(
    result.report.perRun.map((row) => row.runId),
    ['match'],
  );
  assert.equal(result.report.totals.runs, 1);
  assert.equal(result.report.byProject.length, 1);
  assert.equal(result.tasks[0]!.runs, 1);
  assert.equal(result.executors.length, 1);
});

test('deltas require equal-period comparable coverage and remain absent for all-time', () => {
  const prior = run('prior', { startedAt: '2026-10-31T10:00:00.000Z', estimatedCostUsd: 2 });
  const current = run('current', { estimatedCostUsd: 4 });
  assert.equal(insights([prior, current]).tiles.spend.delta, 1);
  assert.equal(insights([prior, current, run('missing', { estimatedCostUsd: null })]).tiles.spend.delta, null);
  assert.equal(usageInsights(source([prior, current]), [], { range: 'all', kind: 'all' }, now).tiles.spend.delta, null);
  assert.equal(insights([current]).tiles.spend.delta, null);
});

test('unknown costs remain null and full detail is not truncated to a page', () => {
  assert.equal(insights([run('unknown', { estimatedCostUsd: null })]).summary.spendUsd, null);
  const many = Array.from({ length: 450 }, (_, index) => run(`run-${index}`, { workflowId: `task-${index}` }));
  const flows = many.map((row) => workflow(row.workflowId!));
  const result = insights(many, flows);
  assert.equal(result.summary.runs, 450);
  assert.equal(result.report.perRun.length, 450);
  assert.equal(result.tasks.length, 450);
  assert.equal(result.summary.spendUsd, 450);
  const empty = insights([]);
  assert.equal(empty.summary.runs, 0);
  assert.equal(empty.summary.failureRate, null);
  assert.equal(empty.summary.duration.p50, null);
  assert.equal(empty.buckets.length, 24);
});

const choices: LayaChoices = {
  task_type: 'conversation',
  difficulty: 'simple',
  web_search: 'no',
  input_modality: 'text',
  document_read: 'no',
  media_output: 'none',
  project_access: 'none',
  run_commands: 'no',
  browser_use: 'no',
  executor_intent: 'none',
};
function judged(id: string, inference: Partial<LayaInference> = {}, extra: Partial<Workflow> = {}): Workflow {
  return workflow(id, {
    createdAt: '2026-11-01T09:00:00.000Z',
    projectId: 'project-a',
    handlingSource: 'laya',
    laya: {
      inference: {
        status: 'ok',
        reason: 'local_cuda',
        device: 'cuda:0',
        latencyMs: 100,
        modelVersion: 'pugport-laya-v4',
        choices,
        ...inference,
      },
      policy: { applied: false, reasons: [], conflicts: [], excludeRuntimeIds: [] },
    },
    ...extra,
  });
}

test('routing availability excludes privacy skips, keeps outcomes and uses successful latency observations', () => {
  const rows = [
    judged('local'),
    judged('cloud', { reason: 'cloud', device: 'cloud:cuda:0', latencyMs: 900 }),
    judged('timeout', { status: 'fallback', reason: 'timeout', latencyMs: 9000 }, { handlingSource: 'rules' }),
    judged('warming', { status: 'fallback', reason: 'warming' }, { handlingSource: 'rules' }),
    judged('busy', { status: 'fallback', reason: 'busy' }, { handlingSource: 'rules' }),
    judged('error', { status: 'fallback', reason: 'protocol_error' }, { handlingSource: 'rules' }),
    judged('private', { status: 'skipped', reason: 'incognito', latencyMs: 0 }, { handlingSource: 'rules' }),
  ];
  const result = routingInsights(rows, [], { range: '24h', kind: 'all' }, now);
  assert.equal(result.judged, 7);
  assert.equal(result.attempted, 6);
  assert.equal(result.available, 2);
  assert.equal(result.availability, 1 / 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.decidedShare, 2 / 7);
  assert.equal(result.latency.p50, 500);
  assert.equal(result.latency.p95, 860);
  assert.equal(result.localSamples, 1);
  assert.equal(result.cloudSamples, 1);
  const bucket = result.buckets.find((item) => item.outcomes.okLocal)!;
  for (const key of ['okLocal', 'okCloud', 'timeout', 'warming', 'busy', 'error', 'skipped'] as const)
    assert.equal(bucket.outcomes[key], 1);
  assert.equal(result.buckets.length, 24);
  assert.equal(result.buckets[0]!.latency.p50, null);
  assert.equal(result.recent.find((item) => item.workflowId === 'private')!.latencyMs, null);
});

test('routing excludes delegated workflows and uses only range/project filters even without ledger rows', () => {
  const rows = [
    judged('a'),
    judged('b', {}, { projectId: 'project-b' }),
    judged('child', {}, { delegation: { parentId: 'a', role: 'worker', requestId: 'child' } }),
    judged('pending', { status: 'skipped', reason: 'queued-pending-judgment' }, { status: 'queued' }),
    judged('old', {}, { createdAt: '2026-10-01T09:00:00.000Z' }),
  ];
  const projects = [
    { id: 'project-a', path: 'C:/Synthetic/A' },
    { id: 'project-b', path: 'C:/Synthetic/B' },
  ];
  const result = usageInsights(
    source([]),
    rows,
    { range: '24h', kind: 'cli', runtime: 'missing-executor', project: 'c:\\synthetic\\a' },
    now,
    projects,
  );
  assert.equal(result.summary.runs, 0);
  assert.equal(result.routing.judged, 1);
  assert.equal(result.routing.recent[0]!.workflowId, 'a');
  assert.deepEqual(result.projects, ['C:/Synthetic/A', 'C:/Synthetic/B']);
  const all = usageInsights(
    source([]),
    rows,
    { range: 'all', kind: 'api', runtime: 'another-executor', project: 'C:/Synthetic/A' },
    now,
    projects,
  );
  assert.equal(all.routing.judged, 2);
  assert.equal(all.routing.interval.from, '2026-10-01T09:00:00.000Z');
  assert.equal(
    all.routing.buckets.reduce((total, bucket) => total + bucket.outcomes.okLocal, 0),
    2,
  );
});

test('routing decisions reuse handling logic and rank successful task types and difficulty only', () => {
  const rows = [
    judged('question', { choices: { ...choices, task_type: 'coding' } }),
    judged('write', { choices: { ...choices, task_type: 'coding', project_access: 'write', difficulty: 'complex' } }),
    judged('reply'),
    judged('unclear', { choices: { ...choices, task_type: 'unclear' } }),
    judged('bad', { status: 'fallback', choices: { ...choices, task_type: 'writing' } }),
  ];
  const result = routingInsights(rows, [], { range: '7d', kind: 'all' }, now);
  assert.deepEqual(result.decisions, { reply: 2, task: 1, unknown: 1 });
  assert.deepEqual(result.taskTypes[0], { key: 'coding', count: 2 });
  assert.ok(!result.taskTypes.some((item) => item.key === 'writing'));
  assert.deepEqual(result.difficulty, [
    { key: 'simple', count: 3 },
    { key: 'complex', count: 1 },
  ]);
});

test('routing recent rows are capped at 50 with excerpts, conversation links and later run failure evidence', () => {
  const rows = Array.from({ length: 65 }, (_, index) =>
    judged(
      `message-${index}`,
      {},
      {
        createdAt: new Date(now.getTime() - (index + 1) * 60_000).toISOString(),
        conversationId: `conversation-${index}`,
        input: { content: '文'.repeat(100) } as Workflow['input'],
      },
    ),
  );
  const result = routingInsights(
    rows,
    [run('failed-run', { workflowId: 'message-0', status: 'failed' }), run('passed-run', { workflowId: 'message-1' })],
    { range: '24h', kind: 'all' },
    now,
  );
  assert.equal(result.judged, 65);
  assert.equal(result.recent.length, 50);
  assert.equal(result.recent[0]!.workflowId, 'message-0');
  assert.equal(result.recent[0]!.conversationId, 'conversation-0');
  assert.equal(result.recent[0]!.excerpt.length, 60);
  assert.equal(result.recent[0]!.failed, true);
  assert.equal(result.recent[1]!.failed, false);
  assert.equal(result.recent[2]!.failed, null);
});

test('routing unknown origin, missing handling and nonprivacy skips are not relabelled as successful local or privacy', () => {
  const result = routingInsights(
    [
      judged('unknown', { device: undefined, reason: 'legacy', choices: undefined }, { handlingSource: undefined }),
      judged('restricted', { status: 'skipped', reason: 'explicit-restriction' }, { handlingSource: 'rules' }),
    ],
    [],
    { range: '24h', kind: 'all' },
    now,
  );
  assert.equal(result.unknownSamples, 1);
  assert.equal(result.localSamples, 0);
  assert.equal(result.cloudSamples, 0);
  assert.equal(result.handlingUnknown, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.otherSkipped, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.availability, 1);
  assert.equal(result.decisions.unknown, 1);
  const empty = routingInsights([], [], { range: '7d', kind: 'all' }, now);
  assert.equal(empty.decidedShare, null);
  assert.equal(empty.availability, null);
  assert.equal(empty.latency.p50, null);
});

test('chart output and reasoning are disjoint for inclusive adapter counts while ledger accounting stays intact', () => {
  const rows = [
    run('codex', { provider: 'codex', outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 }),
    run('grok', {
      provider: 'grok',
      inputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 3,
      totalTokens: 110,
    }),
  ];
  const result = insights(rows);
  const bucket = result.buckets.find((value) => value.runs)!;
  assert.equal(bucket.tokens.output, 15);
  assert.equal(bucket.tokens.reasoning, 5);
  assert.equal(bucket.tokens.output + bucket.tokens.reasoning, 20);
  assert.equal(result.summary.coverage.tokens, 2);
  assert.equal(bucket.coverage.tokens, 2);
  assert.equal(result.report.totals.outputTokens, 20);
  assert.equal(result.report.totals.reasoningOutputTokens, 5);
  assert.equal(rows[0]!.outputTokens, 10);
});

test('ambiguous or contradictory output semantics reduce chart coverage instead of double counting', () => {
  for (const row of [
    run('unknown', { provider: 'unknown', outputTokens: 10, reasoningOutputTokens: 2 }),
    run('grok-unreconciled', { provider: 'grok', outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 112 }),
    run('grok-missing-total', { provider: 'grok', outputTokens: 10, reasoningOutputTokens: 2, totalTokens: null }),
    run('codex-contradiction', { provider: 'codex', outputTokens: 2, reasoningOutputTokens: 3 }),
  ]) {
    const result = insights([row]);
    const bucket = result.buckets.find((value) => value.runs)!;
    assert.equal(bucket.tokens.output, 0);
    assert.equal(bucket.tokens.reasoning, 0);
    assert.equal(result.summary.coverage.tokens, 0);
    assert.equal(bucket.coverage.tokens, 0);
    assert.equal(result.report.perRun[0]!.outputTokens, row.outputTokens);
  }
  const missing = insights([run('missing-reasoning', { reasoningOutputTokens: null })]);
  assert.equal(missing.buckets.find((value) => value.runs)!.tokens.output, 10);
  assert.equal(missing.summary.coverage.tokens, 0);
  assert.equal(insights([run('observed-zero', { reasoningOutputTokens: 0 })]).summary.coverage.tokens, 1);
});

test('queued rows remain visible but do not create attempted roots or count pending fallbacks', () => {
  const result = insights(
    [
      run('attempted', { status: 'failed' }),
      run('pending-relay', {
        status: 'queued',
        runtimeId: 'executor-b',
        relay: { fromRunId: 'attempted', fromRuntimeId: 'executor-a', reason: 'technical' },
      }),
      run('queued-only', { status: 'queued', workflowId: 'not-started' }),
    ],
    [workflow('not-started')],
  );
  assert.equal(result.summary.runs, 3);
  assert.equal(result.summary.attemptedTasks, 1);
  assert.equal(result.summary.successfulTasks, 0);
  assert.equal(result.summary.fallbacks, 0);
  assert.equal(result.summary.fallbackRate, 0);
  assert.equal(result.report.perRun.length, 3);
  const queued = insights([run('queued', { status: 'queued' })]);
  assert.equal(queued.summary.attemptedTasks, 0);
  assert.equal(queued.summary.fallbackRate, null);
});

test('cache reuse excludes writes, preserves Codex and skips incomplete usage', () => {
  const cases = [
    { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100, expected: 0 },
    { inputTokens: 18, cacheReadTokens: 168293, cacheWriteTokens: 116755, expected: 168293 / 168311 },
    { inputTokens: 78863, cacheReadTokens: 290048, cacheWriteTokens: null, expected: 290048 / 368911 },
  ];
  for (const { expected, ...measures } of cases) {
    const result = insights([run('known', measures), run('missing', { inputTokens: null, cacheReadTokens: 900000 })]);
    assert.equal(result.summary.cacheHitRate, expected);
    assert.equal(result.summary.coverage.cache, 1);
    assert.equal(result.buckets.find((b) => b.runs)!.cacheByKind.api, expected);
  }
});
