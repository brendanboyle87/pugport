import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { JudgmentStore } from '../src/server/judgment-store.ts';
import { TASK_JUDGMENT_CONTRACT_VERSION, type TaskJudgment } from '../src/shared/task-judgment.ts';

const judgment = (overrides: Partial<TaskJudgment> = {}): TaskJudgment => ({
  contractVersion: TASK_JUDGMENT_CONTRACT_VERSION,
  inputHash: 'fixture-input-hash',
  status: 'skipped',
  source: 'local',
  intent: 'uncertain',
  confidence: { intent: null, kind: null, complexity: null },
  observedAt: '2026-09-27T12:00:00.000Z',
  latencyMs: 0,
  reason: 'disabled',
  usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
  requestAttempted: false,
  ...overrides,
});
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, store: new JudgmentStore(db) };
}

test('judgment pending and final upserts count one workflow and survive store reconstruction', (t) => {
  const { db, store } = fixture(t);
  assert.equal(store.get('workflow-one'), undefined);
  const pending = judgment({ reason: 'in-progress', requestAttempted: true });
  store.save('workflow-one', 'project-one', pending);
  assert.deepEqual(store.get('workflow-one'), pending);
  assert.equal(store.report().calls, 1);
  assert.equal(store.report().attemptedCalls, 1);
  assert.equal(store.report().totalTokens, null);

  const completed = judgment({
    status: 'accepted',
    source: 'jev',
    intent: 'action',
    kind: 'general',
    complexity: 'standard',
    reason: 'accepted',
    requestAttempted: true,
    latencyMs: 12,
    usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, costUsd: null },
  });
  store.save('workflow-one', 'project-one', completed);
  store.save('workflow-one', 'project-one', completed);
  const reopened = new JudgmentStore(db);
  assert.deepEqual(reopened.get('workflow-one'), completed);
  const report = reopened.report();
  assert.equal(report.calls, 1);
  assert.equal(report.attemptedCalls, 1);
  assert.equal(report.inputTokens, 20);
  assert.equal(report.outputTokens, 4);
  assert.equal(report.totalTokens, 24);
  assert.equal(report.byProject.length, 1);
  assert.equal(report.byProject[0]!.calls, 1);
});

test('unknown usage remains null and explicitly reported zero remains zero', (t) => {
  const { store } = fixture(t);
  assert.deepEqual(store.report(), {
    calls: 0,
    attemptedCalls: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    byProject: [],
  });
  store.save('unknown', 'unknown-project', judgment({ status: 'fallback', reason: 'timeout', requestAttempted: true }));
  assert.equal(store.report().inputTokens, null);
  assert.equal(store.report().totalTokens, null);
  store.save(
    'zero',
    'zero-project',
    judgment({
      status: 'accepted',
      source: 'jev',
      reason: 'accepted',
      requestAttempted: true,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
    }),
  );
  const report = store.report();
  const unknown = report.byProject.find((project) => project.projectId === 'unknown-project')!;
  const zero = report.byProject.find((project) => project.projectId === 'zero-project')!;
  assert.equal(unknown.inputTokens, null);
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.totalTokens, null);
  assert.equal(zero.inputTokens, 0);
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.totalTokens, 0);
  assert.equal(report.totalTokens, 0);
  assert.equal(report.costUsd, null);
  assert.equal(zero.costUsd, null);
});

test('judgment usage aggregates independently by project and distinguishes decisions from requests', (t) => {
  const { store } = fixture(t);
  store.save(
    'one',
    'alpha',
    judgment({
      status: 'accepted',
      source: 'jev',
      reason: 'accepted',
      requestAttempted: true,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, costUsd: null },
    }),
  );
  store.save(
    'two',
    'alpha',
    judgment({
      status: 'fallback',
      reason: 'low-confidence',
      requestAttempted: true,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, costUsd: null },
    }),
  );
  store.save('three', 'beta', judgment({ reason: 'confirmation-mode' }));
  store.save(
    'four',
    'beta',
    judgment({
      status: 'fallback',
      reason: 'invalid-response',
      requestAttempted: true,
      usage: { inputTokens: 9, outputTokens: null, totalTokens: null, costUsd: null },
    }),
  );
  const report = store.report();
  assert.deepEqual(
    {
      calls: report.calls,
      attemptedCalls: report.attemptedCalls,
      input: report.inputTokens,
      output: report.outputTokens,
      total: report.totalTokens,
      cost: report.costUsd,
    },
    { calls: 4, attemptedCalls: 3, input: 24, output: 5, total: 20, cost: null },
  );
  const alpha = report.byProject.find((project) => project.projectId === 'alpha')!;
  const beta = report.byProject.find((project) => project.projectId === 'beta')!;
  assert.deepEqual(alpha, {
    projectId: 'alpha',
    calls: 2,
    attemptedCalls: 2,
    inputTokens: 15,
    outputTokens: 5,
    totalTokens: 20,
    costUsd: null,
  });
  assert.deepEqual(beta, {
    projectId: 'beta',
    calls: 2,
    attemptedCalls: 1,
    inputTokens: 9,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  });
});
