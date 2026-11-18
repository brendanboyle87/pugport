import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import { TASK_JUDGMENT_CONTRACT_VERSION, type TaskJudgment } from '../src/shared/task-judgment.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const timestamp = Date.parse('2026-09-27T12:00:00.000Z');
const iso = (offset = 0) => new Date(timestamp + offset).toISOString();
const settings: Settings = {
  routePreferencesEnabled: true,
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/projects/example',
  maxConcurrentRuns: 2,
};
const judgment = (overrides: Partial<TaskJudgment> = {}): TaskJudgment => ({
  contractVersion: TASK_JUDGMENT_CONTRACT_VERSION,
  inputHash: 'fixture-input-hash',
  status: 'accepted',
  source: 'jev',
  intent: 'action',
  kind: 'general',
  complexity: 'standard',
  confidence: { intent: null, kind: null, complexity: null },
  observedAt: iso(),
  latencyMs: 10,
  reason: 'accepted',
  usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, costUsd: null },
  requestAttempted: true,
  ...overrides,
});
const input: RunInput = {
  prompt: 'Complete the requested task',
  projectPath: settings.defaultProjectPath,
  kind: 'auto',
};
function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    id: 'codex-native',
    provider: 'codex',
    label: 'Codex native',
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [
      { id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'medium', 'high'], lightweight: true },
    ],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(-1000),
      windows: [{ id: 'weekly', label: 'weekly', usedPercent: 20, resetsAt: iso(3_600_000) }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(-1000),
    ...overrides,
  };
}
const claude = () =>
  snapshot({
    id: 'claude-native',
    provider: 'claude',
    label: 'Claude native',
    models: [
      { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
      { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'], lightweight: true },
    ],
  });
const choose = (changes: Partial<RunInput> = {}, values = [snapshot()], config = settings, busy = new Set<string>()) =>
  route({ ...input, ...changes }, values, config, busy, timestamp);

test('accepted Jev work domains select provider preferences independently of local keyword matches', () => {
  for (const [kind, runtimeId] of [
    ['design', 'claude-native'],
    ['architecture', 'codex-native'],
    ['general', 'codex-native'],
    ['routine', 'codex-native'],
  ] as const) {
    const result = choose({ taskJudgment: judgment({ kind }) }, [snapshot(), claude()]);
    assert.equal(result.kind, kind);
    assert.equal(result.runtimeId, runtimeId);
    assert.match(result.reasons.join('\n'), /历史任务判断/);
  }
});

test('accepted complexity changes automatic model strength and effort without changing the work domain', () => {
  for (const [complexity, model, effort] of [
    ['simple', 'gpt-6-luna', 'low'],
    ['standard', 'gpt-6-sol', 'medium'],
    ['complex', 'gpt-6-sol', 'high'],
  ] as const) {
    const result = choose({ taskJudgment: judgment({ kind: 'general', complexity }) });
    assert.equal(result.kind, 'general');
    assert.equal(result.model, model);
    assert.equal(result.effort, effort);
  }
  const routineButComplex = choose({ taskJudgment: judgment({ kind: 'routine', complexity: 'complex' }) });
  assert.equal(routineButComplex.model, 'gpt-6-sol');
  assert.equal(routineButComplex.effort, 'high');
});

test('local architecture signals and complex judgments retain the model capability floor', () => {
  const advice = judgment({ kind: 'routine', complexity: 'simple' });
  const result = choose({ prompt: 'Review authentication security', taskJudgment: advice });
  assert.equal(result.kind, 'architecture');
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(result.effort, 'high');
  const lightOnly = snapshot({
    models: [{ id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'high'], lightweight: true }],
  });
  assert.throws(
    () => choose({ prompt: 'Review authentication security', taskJudgment: advice }, [lightOnly]),
    /仅有轻量模型/,
  );
  assert.throws(() => choose({ taskJudgment: judgment({ complexity: 'complex' }) }, [lightOnly]), /仅有轻量模型/);
});

test('Jev advice cannot replace pinned runtime model or effort or repair unsupported pins', () => {
  const advice = judgment({ kind: 'design', complexity: 'simple' });
  const pinned = { runtimeId: 'codex-native', model: 'gpt-6-sol', effort: 'high', taskJudgment: advice };
  const result = choose(pinned, [snapshot(), claude()]);
  assert.equal(result.runtimeId, pinned.runtimeId);
  assert.equal(result.model, pinned.model);
  assert.equal(result.effort, pinned.effort);
  assert.throws(() => choose({ ...pinned, model: 'missing-model' }, [snapshot(), claude()]), /未发现指定模型/);
  assert.throws(() => choose({ ...pinned, effort: 'ultra' }, [snapshot(), claude()]), /不支持 ultra/);
  const explicitLight = choose({
    taskJudgment: judgment({ complexity: 'complex' }),
    model: 'gpt-6-luna',
    effort: 'low',
  });
  assert.equal(explicitLight.model, 'gpt-6-luna');
  assert.equal(explicitLight.effort, 'low');
});

test('accepted advice still rejects depleted stale unknown or busy resources', () => {
  const advice = judgment({ kind: 'design', complexity: 'simple' });
  const exhausted = claude();
  exhausted.quota.windows[0]!.usedPercent = 90;
  exhausted.quota.windows[0]!.resetsAt = iso(48 * 3_600_000);
  assert.equal(choose({ taskJudgment: advice }, [snapshot(), exhausted]).runtimeId, 'codex-native');
  assert.throws(
    () => choose({ taskJudgment: advice, runtimeId: exhausted.id, allowUnknownQuota: true }, [snapshot(), exhausted]),
    /保护阈值/,
  );
  const stale = snapshot();
  stale.quota.observedAt = iso(-180_000);
  assert.throws(() => choose({ taskJudgment: advice }, [stale]), /额度数据已过期/);
  const unknown = snapshot({ quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] } });
  assert.throws(() => choose({ taskJudgment: advice }, [unknown]), /额度未知/);
  assert.throws(
    () => choose({ taskJudgment: advice }, [snapshot()], settings, new Set(['codex'])),
    (error) => error instanceof RouteUnavailableError && error.kind === 'capacity',
  );
});

test('accepted advice cannot bypass execution capability or CLI and API restrictions', () => {
  const advice = judgment({ kind: 'general', complexity: 'simple' });
  const gateway = snapshot({ id: 'api-deepseek', provider: 'pi', apiProvider: 'deepseek', gateway: 'api' });
  assert.equal(
    choose({ taskJudgment: advice, executionPolicy: 'cli-only' }, [snapshot(), gateway]).runtimeId,
    'codex-native',
  );
  assert.equal(
    choose({ taskJudgment: advice, executionPolicy: 'api-only' }, [snapshot(), gateway]).runtimeId,
    'api-deepseek',
  );
  assert.throws(
    () =>
      choose({ taskJudgment: advice, executionPolicy: 'api-only', runtimeId: 'codex-native' }, [snapshot(), gateway]),
    RouteUnavailableError,
  );
  assert.throws(
    () =>
      choose({ taskJudgment: advice }, [
        snapshot({ capabilities: { execute: false, resume: true, cancel: true, approvals: true } }),
      ]),
    RouteUnavailableError,
  );
});

test('attempted Jev fallback does not turn local routine keywords into a lightweight downgrade', () => {
  for (const reason of ['low-confidence', 'timeout', 'invalid-response', 'network-error'] as const) {
    const fallback = judgment({ status: 'fallback', source: 'local', kind: 'routine', complexity: 'simple', reason });
    const result = choose({ prompt: 'Fix a typo in README.md', taskJudgment: fallback });
    assert.equal(result.kind, 'general', reason);
    assert.equal(result.model, 'gpt-6-sol', reason);
    assert.equal(result.effort, 'medium', reason);
    assert.match(result.reasons.join('\n'), /未采纳/);
  }
  const localOnly = judgment({
    status: 'skipped',
    source: 'local',
    kind: undefined,
    complexity: undefined,
    reason: 'disabled',
    requestAttempted: false,
  });
  assert.equal(choose({ prompt: 'Fix a typo in README.md', taskJudgment: localOnly }).model, 'gpt-6-luna');
});

test('route explanations distinguish saved legacy advice from current local rules', () => {
  const local = { source: 'local', kind: undefined, complexity: undefined, requestAttempted: false } as const;
  for (const taskJudgment of [
    judgment({ ...local, status: 'skipped', reason: 'disabled' }),
    // Legacy fallback records remain readable without claiming a new request.
    judgment({ ...local, status: 'fallback', reason: 'not-configured' }),
    judgment({ ...local, status: 'skipped', reason: 'manual-selection' }),
  ])
    assert.doesNotMatch(
      choose({
        taskJudgment,
        runtimeId: taskJudgment.reason === 'manual-selection' ? 'codex-native' : undefined,
      }).reasons.join('\n'),
      /Jev/,
      taskJudgment.reason,
    );
  const asked = judgment({ status: 'fallback', source: 'local', reason: 'timeout', kind: undefined });
  assert.match(choose({ taskJudgment: asked }).reasons.join('\n'), /历史判断未采纳（timeout）/);
});

test('a non-Jev source cannot supply trusted semantic routing advice', () => {
  const result = choose({ taskJudgment: judgment({ source: 'local', kind: 'design', complexity: 'simple' }) }, [
    snapshot(),
    claude(),
  ]);
  assert.equal(result.kind, 'general');
  assert.equal(result.runtimeId, 'codex-native');
  assert.equal(result.model, 'gpt-6-sol');
  assert.equal(result.effort, 'medium');
});
