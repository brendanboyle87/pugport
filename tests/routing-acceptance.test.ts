import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDistribution, checkRecord, readRecords, replayRoute, summarize } from '../scripts/routing-replay.mts';
import type { LayaChoices, LayaPolicy, LayaReviewRecord } from '../src/shared/laya.ts';
import type { RunInput } from '../src/shared/types.ts';
import { modelSelectionReasons } from '../src/server/model-selection.ts';
import { locallyComplex } from '../src/server/routing.ts';
import { flagLocalComplexity } from '../src/server/laya-workflow.ts';

type Case = {
  id: string;
  question: string;
  difficulty: 'simple' | 'standard' | 'complex';
  tier: 'light' | 'standard' | 'strong';
  effort: 'low' | 'medium' | 'high';
};
const cases = JSON.parse(
  await readFile(new URL('./fixtures/routing-labelled.json', import.meta.url), 'utf8'),
) as Case[];
const choices = (difficulty: Case['difficulty']): LayaChoices => ({
  task_type: 'coding',
  difficulty,
  web_search: 'no',
  input_modality: 'text',
  document_read: 'no',
  media_output: 'none',
  project_access: 'write',
  run_commands: 'yes',
  browser_use: 'no',
  executor_intent: 'none',
});
function record(question = 'synthetic question', difficulty: Case['difficulty'] = 'standard'): LayaReviewRecord {
  return {
    id: '2026-10-27/11111111-1111-4111-8111-111111111111',
    workflowId: 'synthetic',
    projectId: 'synthetic',
    conversationId: 'synthetic',
    createdAt: '2026-10-27T01:00:00.000Z',
    question,
    state: { message: question, recent_context: '', reference_text: '', attachments: [], candidate_executors: [] },
    inference: {
      status: 'ok',
      reason: 'fixture',
      modelVersion: 'pugport-laya-v4',
      latencyMs: 0,
      choices: choices(difficulty),
    },
    policy: { applied: false, reasons: [], conflicts: [], excludeRuntimeIds: [] },
    outcome: {
      status: 'completed',
      routes: [
        {
          runId: 'synthetic',
          runtimeId: 'codex',
          model: 'gpt-6-sol',
          effort: 'medium',
          reason: '自动模型选择：目标常规档',
        },
      ],
    },
    training: { status: 'pending', updatedAt: '2026-10-27T01:00:00.000Z' },
  };
}
const actual = (
  tier: 'light' | 'standard' | 'strong',
  effort: string,
  provider = 'codex',
  model = 'gpt-6.1-terra',
) => ({ tier, effort, provider, model });
// Every labelled case passes since 10-28 (Laya decides outside quality mode; light demand fits light models).
const todoA: Record<string, string> = {};
const todoB: Record<string, string> = {};

test('labelled set has 10 records per difficulty', () => {
  assert.equal(cases.length, 30);
  assert.equal(new Set(cases.map((item) => item.id)).size, 30);
  for (const difficulty of ['simple', 'standard', 'complex'])
    assert.equal(cases.filter((item) => item.difficulty === difficulty).length, 10);
});
for (const item of cases) {
  test(`ok ${item.id}`, { todo: todoA[item.id] }, () => {
    const result = replayRoute(record(item.question, item.difficulty)).actual;
    assert.deepEqual({ tier: result.tier, effort: result.effort }, { tier: item.tier, effort: item.effort });
  });
  test(`fallback ${item.id}`, { todo: todoB[item.id] }, () => {
    const input = record(item.question, item.difficulty);
    input.inference = { status: 'fallback', reason: 'warming', modelVersion: 'pugport-laya-v4', latencyMs: 0 };
    const result = replayRoute(input).actual;
    assert.deepEqual({ tier: result.tier, effort: result.effort }, { tier: 'strong', effort: 'high' });
  });
}
test('R1 checks route and assessment capacity', () => {
  const input = record();
  input.inference.status = 'fallback';
  input.inference.reason = 'warming';
  assert.equal(checkRecord(input, actual('strong', 'high'), []).filter((f) => f.rule === 'R1').length, 0);
  input.outcome!.assessment = { status: 'skipped', reason: 'No spare execution capacity' };
  assert.equal(checkRecord(input, actual('standard', 'medium'), []).filter((f) => f.rule === 'R1').length, 2);
});
test('R2 checks difficulty mapping and excludes difficulty conflicts', () => {
  const input = record();
  assert.equal(checkRecord(input, actual('standard', 'medium'), []).filter((f) => f.rule === 'R2').length, 0);
  assert.equal(checkRecord(input, actual('strong', 'high'), []).filter((f) => f.rule === 'R2').length, 1);
  assert.equal(
    checkRecord(input, actual('strong', 'high'), ['Model command judgment missed']).filter((f) => f.rule === 'R2')
      .length,
    0,
  );
});
test('unclear difficulty is not accepted as verified', () => {
  const input = record();
  input.inference.choices!.difficulty = 'unclear';
  assert.equal(
    checkRecord(input, actual('standard', 'medium'), []).find((f) => f.rule === 'R2')?.code,
    'difficulty_unknown',
  );
});
test('R3 keeps difficulty despite executor conflicts', () => {
  const input = record();
  const conflict = ['Executor request is conditional or ambiguous'];
  assert.equal(checkRecord(input, actual('standard', 'medium'), conflict).filter((f) => f.rule === 'R3').length, 0);
  assert.equal(checkRecord(input, actual('strong', 'high'), conflict).filter((f) => f.rule === 'R3').length, 1);
});
test('R4 detects a lower step and reports unknown assessment order', () => {
  const input = record();
  input.outcome!.routes.push({ runId: 'step', effort: 'high', reason: '自动模型选择：目标高能力档' });
  assert.equal(checkRecord(input, actual('standard', 'medium'), []).filter((f) => f.rule === 'R4').length, 0);
  input.outcome!.routes[1]!.reason = '自动模型选择：目标轻量档';
  assert.equal(checkRecord(input, actual('standard', 'medium'), []).find((f) => f.rule === 'R4')?.code, 'tier_dropped');
  input.outcome!.assessment = { status: 'completed', reason: 'fixture' };
  assert.equal(
    checkRecord(input, actual('standard', 'medium'), []).find((f) => f.rule === 'R4')?.code,
    'assessment_order_unknown',
  );
});
test('R5 requires exactly 20 tasks and no provider above half', () => {
  assert.equal(checkDistribution({ codex: 5, claude: 5, grok: 5, cursor: 5 }), true);
  assert.equal(checkDistribution({ codex: 11, claude: 3, grok: 3, cursor: 3 }), false);
  assert.equal(checkDistribution({ codex: 5 }), false);
});
test('CLI reads synthetic records, excludes steering, and never emits message text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routing-acceptance-'));
  const dir = join(root, 'routing-training', '2026-10-27');
  await mkdir(dir, { recursive: true });
  const secret = 'SYNTHETIC_PRIVATE_SENTINEL_DO_NOT_PRINT';
  const input = record(secret);
  input.state.recent_context = secret;
  input.inference.reason = secret;
  await writeFile(join(dir, 'a.json'), JSON.stringify(input));
  const before = await readFile(join(dir, 'a.json'), 'utf8');
  await writeFile(join(dir, 'b.json'), JSON.stringify({ ...input, origin: 'steering' }));
  assert.equal((await readRecords(root, 50)).length, 1);
  assert.doesNotMatch(JSON.stringify(summarize([input])), new RegExp(secret));
  const out = `${root}-summary.json`;
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/routing-replay.mts'), '--data', root, '--json', out],
    { encoding: 'utf8' },
  );
  assert.ok(run.status === 0 || run.status === 1);
  assert.doesNotMatch(run.stdout + run.stderr + (await readFile(out, 'utf8')), new RegExp(secret));
  assert.equal(JSON.parse(run.stdout).records, 1);
  assert.equal(await readFile(join(dir, 'a.json'), 'utf8'), before);
  const refused = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('scripts/routing-replay.mts'),
      '--data',
      root,
      '--json',
      join(root, 'not-allowed.json'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(secret));
});

// Labelled model examples: a build step that must change files runs on astra, which finishes long
// implementations; terra, faster but prone to stopping halfway, keeps short, read-only, review and planning work.
const write = { permissionMode: 'workspace-write' as const };
const modelCases: Array<{ id: string; question: string; extra: Partial<RunInput>; model: string; reason?: RegExp }> = [
  {
    id: 'heuristic-write-keeps-model-routing',
    question: 'Implement the sync loop in src/server/extensions.ts with tests, then run the affected tests.',
    extra: { ...write, checkFileChanges: true, reportTaskOutcome: true, schedule: { estimatedMinutes: 20 } },
    model: 'gpt-6-astra',
  },
  {
    id: 'build-implementation-step',
    question: 'Implement the sync loop in src/server/extensions.ts with tests, then run the affected tests.',
    extra: { ...write, requiresFileChanges: true, reportTaskOutcome: true, schedule: { estimatedMinutes: 20 } },
    model: 'gpt-6-astra',
    reason: /要改文件的实现步骤用 gpt-6-astra：terra 快，但长实现常做到一半就停/,
  },
  {
    id: 'build-fix-step',
    question: '修好 tests/routing-pace.test.ts 里失败的断言和它检查的代码，跑一遍相关测试。',
    extra: { ...write, requiresFileChanges: true, schedule: { estimatedMinutes: 8 } },
    model: 'gpt-6-astra',
  },
  {
    id: 'writable-review-without-file-changes',
    question: 'Review the routing change in src/server/routing.ts and report findings; do not edit.',
    extra: { ...write, schedule: { estimatedMinutes: 20 } },
    model: 'gpt-6.1-terra',
    reason: /短任务、只读、评审或规划用更快的 gpt-6.1-terra/,
  },
  {
    id: 'writable-planning-without-file-changes',
    question: '规划 src/server/routing.ts 的重构步骤，列出要改的文件和测试，不要动代码。',
    extra: { ...write, schedule: { estimatedMinutes: 20 } },
    model: 'gpt-6.1-terra',
  },
  {
    id: 'read-only-review',
    question: 'Review the routing change in src/server/routing.ts for correctness and safety; do not edit.',
    extra: { permissionMode: 'read-only', schedule: { estimatedMinutes: 20 } },
    model: 'gpt-6.1-terra',
  },
  {
    id: 'pinned-terra-implementation',
    question: 'Implement the sync loop in src/server/extensions.ts with tests.',
    extra: { ...write, requiresFileChanges: true, runtimeId: 'codex', model: 'gpt-6.1-terra' },
    model: 'gpt-6.1-terra',
  },
];
for (const item of modelCases)
  test(`model ${item.id}`, () => {
    const result = replayRoute(record(item.question, 'complex'), item.extra);
    assert.equal(result.actual.tier, 'strong');
    assert.equal(result.actual.provider, 'codex');
    assert.equal(result.actual.model, item.model);
    if (item.reason)
      assert.ok(
        result.reasons.some((reason) => item.reason!.test(reason)),
        result.reasons.join('\n'),
      );
  });

test('the Astra/Terra reason names a real alternative', () => {
  const terra = { id: 'gpt-6.1-terra', label: 'Terra', efforts: ['high'] };
  const astra = { id: 'gpt-6-astra', label: 'Astra', efforts: ['high'] };
  const longWrite = { tier: 'strong' as const, effort: 'high', goal: 'balanced' as const, longWrite: true };
  // Astra unavailable: say so instead of claiming the policy chose Terra.
  assert.ok(
    modelSelectionReasons(terra, 'codex', longWrite, false, 'high', false, false, [terra]).includes(
      '要改文件的实现步骤本应用 astra，但它现在不可用，改用 gpt-6.1-terra',
    ),
  );
  // No Terra on the account: Astra needs no Terra-versus-Astra explanation.
  assert.ok(
    !modelSelectionReasons(astra, 'codex', longWrite, false, 'high', false, false, [astra]).some((reason) =>
      /terra/.test(reason),
    ),
  );
});

test('quality mode keeps the strong floor that balanced mode leaves to Laya', () => {
  const architecture = 'Refactor the routing architecture across modules and redesign its interfaces.';
  assert.equal(replayRoute(record(architecture, 'standard')).actual.tier, 'standard');
  const quality = replayRoute(record(architecture, 'standard'), {}, { routeGoal: 'quality' }).actual;
  assert.equal(quality.tier, 'strong');
});

test('without Laya, named files raise the floor only for a request to change code', () => {
  const unjudged = (question: string) => {
    const value = record(question);
    value.inference = { status: 'skipped', reason: 'disabled', modelVersion: 'pugport-laya-v4', latencyMs: 0 };
    return replayRoute(value, { kind: 'routine' }).actual.tier;
  };
  assert.equal(unjudged('Rename notes.txt to summary.txt.'), 'light');
  assert.equal(unjudged('Fix the null check in src/a.ts and src/b.ts.'), 'standard');
});

test('a request the local classifier reads as complex is flagged for the assessment, not raised', () => {
  const ok = record().inference;
  const policy = (): LayaPolicy => ({
    applied: true,
    reasons: [],
    conflicts: [] as string[],
    excludeRuntimeIds: [],
    suggestedTier: 'standard' as const,
  });
  const flagged = policy();
  flagLocalComplexity(flagged, ok, 'balanced', locallyComplex('Refactor the routing architecture across modules.'));
  assert.equal(flagged.needsAssessment, true);
  assert.match(flagged.conflicts.join(' '), /Local text classifier/);
  for (const [goal, text] of [
    ['quality', 'Refactor the routing architecture across modules.'],
    ['balanced', 'Explain what latency means.'],
  ] as const) {
    const quiet = policy();
    flagLocalComplexity(quiet, ok, goal, locallyComplex(text));
    assert.equal(quiet.needsAssessment, undefined, goal + ': ' + text);
  }
});

test('R4 uses the recorded target tier and the assessment time when a later step drops a tier', () => {
  const steps = (startedAt: string, completedAt?: string) => {
    const input = record();
    input.outcome = {
      status: 'completed',
      assessment: {
        status: 'completed',
        reason: 'fixture',
        suggestedTier: 'standard',
        ...(completedAt ? { completedAt } : {}),
      },
      routes: [
        {
          runId: 'a',
          runtimeId: 'codex',
          model: 'gpt-6.1-terra',
          effort: 'high',
          targetTier: 'strong',
          startedAt: '2026-10-27T01:00:00.000Z',
        },
        {
          runId: 'b',
          runtimeId: 'codex',
          model: 'gpt-6-sol',
          effort: 'medium',
          targetTier: 'standard',
          stepId: 'step2',
          startedAt,
        },
      ],
    };
    return checkRecord(input, actual('standard', 'medium'), [])
      .filter((f) => f.rule === 'R4')
      .map((f) => f.code);
  };
  assert.deepEqual(steps('2026-10-27T01:10:00.000Z', '2026-10-27T01:05:00.000Z'), []);
  assert.deepEqual(steps('2026-10-27T01:03:00.000Z', '2026-10-27T01:05:00.000Z'), ['tier_dropped_before_assessment']);
  assert.deepEqual(steps('2026-10-27T01:10:00.000Z'), ['assessment_order_unknown']);
});
