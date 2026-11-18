import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskCosts } from '../src/server/task-costs.ts';
import { route } from '../src/server/routing.ts';
import type { RuntimeSnapshot, Settings, Workflow } from '../src/shared/types.ts';
import type { UsageRun } from '../src/shared/usage.ts';

const workflow = (id: string, extra: Partial<Workflow> = {}): Workflow =>
  ({
    id,
    conversationId: 'c',
    projectId: 'p',
    status: 'completed',
    createdAt: `2026-10-0${id.length}T00:00:00.000Z`,
    input: { content: `task ${id}` },
    plan: [{ id: 's' }],
    runIds: [],
    ...extra,
  }) as unknown as Workflow;
const run = (workflowId: string, tokens: number | null, cost: number | null, label = 'Codex'): UsageRun =>
  ({
    runId: `${workflowId}-${Math.random()}`,
    workflowId,
    runtimeLabel: label,
    inputTokens: tokens,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningOutputTokens: null,
    totalTokens: tokens,
    estimatedCostUsd: cost,
  }) as unknown as UsageRun;

test('a task’s total includes its subtasks, reviews, fixes and retries', () => {
  const flows = [
    workflow('a'),
    workflow('ab', { delegation: { parentId: 'a', role: 'worker', requestId: '1' } }),
    workflow('abc', { delegation: { parentId: 'a', role: 'reviewer', requestId: '2' } }),
    workflow('abcd', { parentWorkflowId: 'a', status: 'failed' }),
    workflow('x'),
  ];
  const [latest, other] = taskCosts(flows, [
    run('a', 100, 0.1),
    run('a', 50, null),
    run('ab', 30, 0.02, 'DeepSeek'),
    run('abc', 20, 0.01, 'Claude'),
    run('abcd', 10, null),
    run('x', 5, 0.5),
  ]).sort((left, right) => left.taskId.localeCompare(right.taskId));
  assert.equal(latest!.taskId, 'a');
  assert.equal(latest!.runs, 5);
  assert.equal(latest!.totalTokens, 210);
  assert.equal(Number(latest!.estimatedCostUsd!.toFixed(2)), 0.13);
  assert.equal(latest!.subtasks, 1);
  assert.equal(latest!.reviews, 1);
  assert.equal(latest!.fixes, 1);
  // Two runs for a one-step workflow: one retry.
  assert.equal(latest!.retries, 1);
  // The fix ended the task, and it failed.
  assert.equal(latest!.status, 'failed');
  assert.deepEqual(latest!.executors.sort(), ['Claude', 'Codex', 'DeepSeek']);
  assert.equal(other!.taskId, 'x');
  assert.equal(other!.runs, 1);
});

test('automatic routing tries another executor first when one keeps failing this kind of task', () => {
  const settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    routePreferencesEnabled: true,
    designProvider: 'codex',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'allow',
    defaultProjectPath: '.',
    maxConcurrentRuns: 1,
  } as Settings;
  const snapshots = (['codex', 'claude'] as const).map((provider): RuntimeSnapshot => ({
    id: provider,
    provider,
    label: provider,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'm', label: 'm', efforts: [] }],
    accounting: { mode: 'usage', source: 'fixture' },
    quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
    refreshedAt: new Date().toISOString(),
  }));
  const input = { prompt: 'Refactor the module', projectPath: '.', kind: 'routine' as const };
  assert.equal(route(input, snapshots, settings, new Set()).runtimeId, 'codex');
  assert.equal(
    route({ ...input, struggling: { routine: ['codex'] } }, snapshots, settings, new Set()).runtimeId,
    'claude',
  );
  // Another kind of task is unaffected, and a hand-picked executor is always respected.
  assert.equal(
    route({ ...input, struggling: { design: ['codex'] } }, snapshots, settings, new Set()).runtimeId,
    'codex',
  );
  assert.equal(
    route({ ...input, runtimeId: 'codex', struggling: { routine: ['codex'] } }, snapshots, settings, new Set())
      .runtimeId,
    'codex',
  );
});
