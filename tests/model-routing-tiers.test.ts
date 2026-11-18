import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import { modelTier } from '../src/server/model-selection.ts';
import { TASK_JUDGMENT_CONTRACT_VERSION, type TaskComplexity, type TaskJudgment } from '../src/shared/task-judgment.ts';
import type { ModelInfo, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-04T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/Fixture',
  maxConcurrentRuns: 2,
};
const catalogs = [
  { provider: 'codex', light: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' },
  { provider: 'claude', light: 'haiku', standard: 'sonnet', strong: 'opus' },
  { provider: 'grok', light: 'grok-code-fast-1', standard: 'grok-4.7', strong: 'grok-4.7-heavy' },
] as const;
const model = (id: string, patch: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label: id,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  defaultEffort: 'medium',
  ...patch,
});
function runtime(catalog: (typeof catalogs)[number] = catalogs[0]): RuntimeSnapshot {
  return {
    id: `${catalog.provider}-native`,
    provider: catalog.provider,
    label: catalog.provider,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [model(catalog.strong), model(catalog.light), model(catalog.standard)],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(),
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: iso(3_600_000) }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(),
  };
}
const judgment = (complexity: TaskComplexity): TaskJudgment => ({
  contractVersion: TASK_JUDGMENT_CONTRACT_VERSION,
  inputHash: 'fixture-hash',
  status: 'accepted',
  source: 'jev',
  intent: 'action',
  kind: 'general',
  complexity,
  confidence: { intent: null, kind: null, complexity: null },
  observedAt: iso(),
  latencyMs: 1,
  reason: 'accepted',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: null },
  requestAttempted: true,
});
const choose = (
  value: RuntimeSnapshot,
  complexity: TaskComplexity = 'standard',
  routeGoal: Settings['routeGoal'] = 'balanced',
  changes: Partial<RunInput> = {},
) =>
  route(
    {
      prompt: 'Complete the requested task',
      projectPath: settings.defaultProjectPath,
      kind: 'auto',
      taskJudgment: judgment(complexity),
      ...changes,
    },
    [value],
    { ...settings, routeGoal },
    new Set(),
    now,
  );

test('balanced routing selects each native platform tier independently of catalog order', () => {
  for (const catalog of catalogs) {
    for (const [complexity, tier, effort] of [
      ['simple', 'light', 'low'],
      ['standard', 'standard', 'medium'],
      ['complex', 'strong', 'high'],
    ] as const) {
      const value = runtime(catalog);
      for (const models of [value.models, [...value.models].reverse()]) {
        const decision = choose({ ...value, models }, complexity);
        assert.equal(decision.model, catalog[tier], `${catalog.provider}: ${complexity}`);
        assert.equal(decision.effort, effort);
      }
    }
  }
});

test('save keeps complex tasks on a standard model and quality prefers the strong tier', () => {
  for (const catalog of catalogs) {
    const value = runtime(catalog);
    const saved = choose(value, 'complex', 'save');
    assert.equal(saved.model, catalog.standard);
    assert.equal(saved.effort, 'medium');
    for (const complexity of ['simple', 'standard', 'complex'] as const) {
      const quality = choose(value, complexity, 'quality');
      assert.equal(quality.model, catalog.strong);
      assert.equal(quality.effort, complexity === 'complex' ? 'xhigh' : 'high');
    }
  }
});

test('three routing goals produce the expected model, tier and effort for three task demands', () => {
  const claude = runtime(catalogs[1]);
  const codex = runtime(catalogs[0]);
  codex.quota.windows[0]!.usedPercent = 40;
  const expected = {
    save: [
      ['haiku', 'light', 'low'],
      ['haiku', 'light', 'low'],
      ['sonnet', 'standard', 'medium'],
    ],
    balanced: [
      ['haiku', 'light', 'low'],
      ['sonnet', 'standard', 'medium'],
      ['gpt-6-astra', 'strong', 'high'],
    ],
    quality: [
      ['gpt-6-astra', 'strong', 'high'],
      ['gpt-6-astra', 'strong', 'high'],
      ['gpt-6-astra', 'strong', 'xhigh'],
    ],
  };
  for (const routeGoal of ['save', 'balanced', 'quality'] as const) {
    for (const [index, complexity] of (['simple', 'standard', 'complex'] as const).entries()) {
      for (const sources of [
        [claude, codex],
        [codex, claude],
      ]) {
        const decision = route(
          {
            prompt: 'Complete the requested task',
            projectPath: 'synthetic',
            kind: 'auto',
            taskJudgment: judgment(complexity),
          },
          sources,
          { ...settings, routeGoal },
          new Set(),
          now,
        );
        const source = sources.find((source) => source.id === decision.runtimeId)!;
        const selected = source.models.find((model) => model.id === decision.model)!;
        assert.deepEqual(
          [decision.model, modelTier(selected, source.provider), decision.effort],
          expected[routeGoal][index],
          `${routeGoal}/${complexity}`,
        );
      }
    }
  }
});

test('strong tier absence falls back to standard while complex tasks reject light-only catalogs', () => {
  for (const catalog of catalogs) {
    const value = runtime(catalog);
    value.models = value.models.filter((item) => item.id !== catalog.strong);
    assert.equal(choose(value, 'complex').model, catalog.standard);
    assert.equal(choose(value, 'standard', 'quality').model, catalog.standard);
    value.models = [model(catalog.light)];
    assert.throws(() => choose(value, 'complex'), /仅有轻量模型/);
    assert.throws(() => choose(value, 'complex', 'save'), /仅有轻量模型/);
  }
});

test('manual model and effort pins take precedence over every automatic tier preference', () => {
  for (const catalog of catalogs) {
    for (const routeGoal of ['save', 'balanced', 'quality'] as const) {
      const decision = choose(runtime(catalog), 'complex', routeGoal, {
        model: catalog.light,
        effort: 'ultra',
      });
      assert.equal(decision.model, catalog.light);
      assert.equal(decision.effort, 'ultra');
    }
  }
  assert.throws(() => choose(runtime(), 'standard', 'balanced', { model: 'unlisted-model' }), /未发现指定模型/);
  assert.throws(
    () => choose(runtime(), 'standard', 'balanced', { model: catalogs[0].standard, effort: 'unsupported' }),
    /不支持 unsupported/,
  );
});

test('explicit effort can select a compatible model beyond the first tier candidate', () => {
  const value = runtime();
  value.models = [
    model(catalogs[0].standard, { efforts: ['medium'] }),
    model(catalogs[0].strong, { efforts: ['high'] }),
  ];
  for (const models of [value.models, [...value.models].reverse()]) {
    const decision = choose({ ...value, models }, 'standard', 'balanced', { effort: 'high' });
    assert.equal(decision.model, catalogs[0].strong);
    assert.equal(decision.effort, 'high');
  }
  assert.throws(() => choose(value, 'standard', 'balanced', { effort: 'ultra' }), /不支持 ultra/);
});

test('automatic effort stays within the selected catalog and avoids normal-task max or ultra defaults', () => {
  for (const defaultEffort of ['max', 'ultra', 'unsupported']) {
    const value = runtime();
    value.models = [model(catalogs[0].strong, { efforts: ['ultra', 'max', 'high', 'low'], defaultEffort })];
    const decision = choose(value, 'standard', 'quality');
    assert.equal(decision.effort, 'high');
    assert.ok(value.models[0]!.efforts.includes(decision.effort!));
  }
  const noEffort = runtime(catalogs[1]);
  noEffort.models = [model('sonnet', { efforts: [], defaultEffort: undefined })];
  assert.equal(choose(noEffort).effort, undefined);
});

test('unknown catalog models remain usable conservatively and never disable explicit selection', () => {
  const value = runtime();
  value.models = [model('future-model')];
  assert.equal(choose(value, 'complex').model, 'future-model');
  assert.equal(choose(value, 'standard', 'quality').model, 'future-model');
  assert.equal(choose(value, 'simple', 'save', { model: 'future-model', effort: 'max' }).effort, 'max');
});

test('tier selection still honors the native CLI automatic approval capability', () => {
  const value = runtime();
  value.models = value.models.map((item) => ({ ...item, noAutoApproval: item.id === catalogs[0].strong }));
  assert.equal(choose(value, 'complex').model, catalogs[0].standard);
  assert.throws(() => choose(value, 'complex', 'quality', { model: catalogs[0].strong }), /不支持自动执行模式/);
});

test('independent model quotas can replace an exhausted strong model with a funded standard model', () => {
  const value: RuntimeSnapshot = { ...runtime(), id: 'cursor-native', provider: 'cursor', label: 'Cursor' };
  value.models = [model('claude-opus-5', { quotaPool: 'other' }), model('composer-2.5', { quotaPool: 'cursor' })];
  value.quota.windows = [
    { id: 'other', label: 'Other Models', modelPool: 'other', usedPercent: 100, resetsAt: iso(3_600_000) },
    { id: 'cursor', label: 'Cursor Models', modelPool: 'cursor', usedPercent: 20, resetsAt: iso(3_600_000) },
  ];
  assert.equal(choose(value, 'complex', 'quality').model, 'composer-2.5');
  assert.throws(() => choose(value, 'complex', 'quality', { model: 'claude-opus-5' }), /Other Models.*保护阈值/);
});

test('strong model availability does not bypass quota freshness or execution policy', () => {
  const value = runtime();
  value.quota.windows[0]!.usedPercent = 90;
  value.quota.windows[0]!.resetsAt = iso(7 * 86_400_000);
  assert.throws(() => choose(value, 'complex', 'quality'), /保护阈值/);
  value.quota.windows[0]!.usedPercent = 20;
  value.quota.observedAt = iso(-180_000);
  assert.throws(() => choose(value, 'complex', 'quality'), /额度数据已过期/);
  assert.throws(() => choose(runtime(), 'complex', 'quality', { executionPolicy: 'api-only' }), RouteUnavailableError);
});

test('newer versions win within one family without outranking the requested capability tier', () => {
  const value = runtime();
  value.models = [model('gpt-6-sol'), model('gpt-6.1-sol'), model('gpt-6-astra')];
  for (const models of [value.models, [...value.models].reverse()]) {
    assert.equal(choose({ ...value, models }).model, 'gpt-6.1-sol');
    assert.equal(choose({ ...value, models }, 'complex').model, 'gpt-6-astra');
  }
});

test('a single Grok model varies its supported effort with task complexity and route goal', () => {
  const value = runtime(catalogs[2]);
  value.models = [model('grok-4.7', { efforts: ['xhigh', 'low', 'high', 'medium'] })];
  for (const [complexity, routeGoal, effort] of [
    ['simple', 'balanced', 'low'],
    ['standard', 'balanced', 'medium'],
    ['complex', 'balanced', 'high'],
    ['standard', 'quality', 'high'],
    ['complex', 'quality', 'xhigh'],
  ] as const) {
    const decision = choose(value, complexity, routeGoal);
    assert.equal(decision.model, 'grok-4.7');
    assert.equal(decision.effort, effort);
    assert.ok(value.models[0]!.efforts.includes(decision.effort!));
  }
});

test('Cursor fast variants remain full models and same-family choices use normal speed and suitable effort', () => {
  const value: RuntimeSnapshot = { ...runtime(), id: 'cursor-native', provider: 'cursor', label: 'Cursor' };
  const variant = (id: string) => model(id, { efforts: [], defaultEffort: undefined });
  value.models = [variant('grok-4.7-high-fast')];
  assert.equal(choose(value, 'complex').model, 'grok-4.7-high-fast');

  value.models = [
    variant('grok-4.7-high-fast'),
    variant('grok-4.7-low'),
    variant('grok-4.7-xhigh'),
    variant('grok-4.7-high'),
  ];
  for (const models of [value.models, [...value.models].reverse()]) {
    for (const [complexity, routeGoal, expected] of [
      ['standard', 'quality', 'grok-4.7-high'],
      ['complex', 'balanced', 'grok-4.7-high'],
      ['complex', 'quality', 'grok-4.7-xhigh'],
    ] as const) {
      const decision = choose({ ...value, models }, complexity, routeGoal);
      assert.equal(decision.model, expected);
      assert.equal(decision.effort, undefined, 'Cursor effort is encoded in the selected model ID');
    }
  }
});

test('a same-platform account with the requested strong tier wins over a richer standard-only account', () => {
  const strong = runtime();
  strong.id = 'codex-strong';
  strong.models = [model('gpt-6-astra')];
  strong.quota.windows[0]!.usedPercent = 65;
  const standard = runtime();
  standard.id = 'codex-standard';
  standard.models = [model('gpt-6.1-sol')];
  standard.quota.windows[0]!.usedPercent = 10;

  for (const snapshots of [
    [standard, strong],
    [strong, standard],
  ]) {
    const decision = route(
      {
        prompt: 'Complete the requested task',
        projectPath: settings.defaultProjectPath,
        kind: 'auto',
        taskJudgment: judgment('complex'),
      },
      snapshots,
      settings,
      new Set(),
      now,
    );
    assert.equal(decision.runtimeId, strong.id);
    assert.equal(decision.model, 'gpt-6-astra');
  }
});

test('routing explanations name the target tier and disclose a missing-tier fallback', () => {
  const value = runtime();
  const fullCatalog = choose(value, 'complex');
  assert.match(fullCatalog.reasons.join('\n'), /目标高能力档.*gpt-6-astra.*高能力档/);
  assert.doesNotMatch(fullCatalog.reasons.join('\n'), /回退选择/);

  value.models = [model('gpt-6.1-sol')];
  const fallback = choose(value, 'complex');
  assert.match(fallback.reasons.join('\n'), /目标高能力档.*gpt-6\.1-sol.*常规档/);
  assert.match(fallback.reasons.join('\n'), /目标档位.*不可用.*回退选择/);
});

test('an unrelated model between two family versions does not prevent choosing the newer version', () => {
  const value = runtime();
  value.models = [model('gpt-5.6-sol'), model('custom'), model('gpt-6.1-sol')];
  for (const models of [value.models, [...value.models].reverse()]) {
    assert.equal(choose({ ...value, models }).model, 'gpt-6.1-sol');
  }
});

test('quota fallback preserves automatic strong-model selection and does not claim a user model pin', () => {
  const source = runtime();
  source.models = [model('gpt-6-luna'), model('gpt-6-sol'), model('gpt-6-astra')];
  source.quota.windows[0]!.usedPercent = 100;
  const cursor: RuntimeSnapshot = {
    ...runtime(),
    id: 'cursor-native',
    provider: 'cursor',
    label: 'Cursor',
    models: ['gpt-6-luna-high', 'gpt-6-astra-high'].map((id) => model(id, { efforts: [], defaultEffort: undefined })),
  };
  for (const changes of [
    { kind: 'auto', taskJudgment: judgment('complex') },
    { kind: 'architecture' },
  ] satisfies Partial<RunInput>[]) {
    const decision = route(
      {
        prompt: 'Complete the requested task',
        projectPath: settings.defaultProjectPath,
        runtimeId: source.id,
        ...changes,
      },
      [source, cursor],
      settings,
      new Set(),
      now,
    );
    assert.equal(decision.runtimeId, cursor.id);
    assert.equal(decision.model, 'gpt-6-astra-high');
    assert.match(decision.warnings.join('\n'), /改由 Cursor/);
    assert.doesNotMatch(decision.reasons.join('\n'), /用户指定模型/);
  }
});

test('Claude prefers daily Sonnet, complex Opus and reserves Fable preference for quality-first', () => {
  const value = runtime(catalogs[1]);
  value.models = ['fable', 'opusplan', 'sonnet', 'opus'].map((id) => model(id));
  for (const models of [value.models, [...value.models].reverse()]) {
    assert.equal(choose({ ...value, models }).model, 'sonnet');
    assert.equal(choose({ ...value, models }, 'complex').model, 'opus');
    assert.equal(choose({ ...value, models }, 'complex', 'quality').model, 'fable');
    assert.equal(choose({ ...value, models }, 'standard', 'balanced', { model: 'opusplan' }).model, 'opusplan');
  }
});

test('implicit modes do not displace explicit catalog models during automatic selection', () => {
  const value: RuntimeSnapshot = { ...runtime(), provider: 'cursor' };
  value.models = ['auto', 'claude-opus-5-5'].map((id) => model(id, { efforts: [] }));
  assert.equal(choose(value).model, 'claude-opus-5-5');
  assert.equal(choose(value, 'standard', 'balanced', { model: 'auto' }).model, 'auto');
  const claude = runtime(catalogs[1]);
  claude.models = ['opusplan', 'best', 'default', 'sonnet'].map((id) => model(id));
  assert.equal(choose(claude).model, 'sonnet');
});

test('Cursor prioritizes the requested reasoning effort over the serving speed variant', () => {
  const value: RuntimeSnapshot = { ...runtime(), provider: 'cursor' };
  value.models = ['grok-4.7-low', 'grok-4.7-xhigh-fast'].map((id) => model(id, { efforts: [] }));
  assert.equal(choose(value, 'complex', 'quality').model, 'grok-4.7-xhigh-fast');
});

test('Claude context aliases compare their resolved version instead of the context length', () => {
  const value = runtime(catalogs[1]);
  value.models = [model('opus[1m]', { label: 'Opus 5.5 (1M context)' }), model('claude-opus-4-6')];
  for (const models of [value.models, [...value.models].reverse()])
    assert.equal(choose({ ...value, models }, 'complex').model, 'opus[1m]');
});

test('cost preference cannot choose a light model when a complex task has a capable fallback', () => {
  const value = runtime(catalogs[1]);
  value.models = [model('fable'), model('haiku')];
  assert.equal(choose(value, 'complex').model, 'fable');
});

test("a sub-task's tier and effort follow its own difficulty; a caller's effort is a target, not a pin", () => {
  const claude = runtime(catalogs[1]);
  const child = (routingPrompt: string, changes: Partial<RunInput> = {}) =>
    route(
      {
        prompt: `Parent architecture context that must not inflate the child.\n\n${routingPrompt}`,
        routingPrompt,
        projectPath: settings.defaultProjectPath,
        kind: 'general',
        agentChild: true,
        ...changes,
      },
      [claude],
      settings,
      new Set(),
      now,
    );
  const lookup = 'Find the files that mention the parser and list their paths';
  const simple = child(lookup);
  assert.deepEqual([simple.model, simple.effort], ['haiku', 'low'], 'a simple sub-task uses the light tier');
  const hard = child('Determine the root cause of this complex failure across the scheduler');
  assert.deepEqual([hard.model, hard.effort], ['opus', 'high'], 'a complex sub-task uses the strong tier');

  // The caller suggests an effort: the tier still follows the task, the nearest supported level is used.
  const limited = { ...claude, models: claude.models.map((item) => ({ ...item, efforts: ['low', 'medium', 'high'] })) };
  const suggested = route(
    {
      prompt: lookup,
      routingPrompt: lookup,
      projectPath: settings.defaultProjectPath,
      kind: 'general',
      agentChild: true,
      suggestedEffort: 'xhigh',
    },
    [limited],
    settings,
    new Set(),
    now,
  );
  assert.deepEqual([suggested.model, suggested.effort], ['haiku', 'high']);
  assert.ok(suggested.reasons.some((reason) => reason.startsWith('调用方建议思考强度：high')));
  assert.ok(!suggested.reasons.some((reason) => reason.startsWith('用户指定思考强度')));
  // A user's effort pin filters catalogs; the caller's suggestion never blocks a route this way.
  assert.throws(
    () =>
      route(
        {
          prompt: lookup,
          projectPath: settings.defaultProjectPath,
          kind: 'general',
          agentChild: true,
          effort: 'xhigh',
        },
        [limited],
        settings,
        new Set(),
        now,
      ),
    RouteUnavailableError,
  );
});

test('ordinary lookups use the same task-based effort as children without overriding pins or complex judgments', () => {
  const value = runtime();
  const changes: Partial<RunInput> = {
    prompt: 'Earlier conversation concerned security architecture and complex migrations',
    routingPrompt: 'Find the security document in docs/',
    kind: 'auto',
    taskJudgment: undefined,
  };
  const lookup = choose(value, 'standard', 'balanced', changes);
  assert.deepEqual([lookup.kind, lookup.model, lookup.effort], ['routine', catalogs[0].light, 'low']);
  const pinned = choose(value, 'standard', 'balanced', { ...changes, model: catalogs[0].strong, effort: 'max' });
  assert.deepEqual([pinned.model, pinned.effort], [catalogs[0].strong, 'max']);
  const judged = choose(value, 'complex', 'balanced', { ...changes, taskJudgment: judgment('complex') });
  assert.deepEqual([judged.model, judged.effort], [catalogs[0].strong, 'high']);
  const analysis = choose(value, 'standard', 'balanced', {
    ...changes,
    routingPrompt: 'Read the architecture docs and determine the root cause of the complex concurrency failure',
  });
  assert.deepEqual([analysis.kind, analysis.model, analysis.effort], ['architecture', catalogs[0].strong, 'high']);
});

test('web research with judgment requires strong reasoning, while plain lookups keep their tier', () => {
  for (const catalog of catalogs) {
    const value = runtime(catalog);
    for (const prompt of [
      '你搜一下这项产品的新方案，是不是值得采用，你怎么看？',
      '请联网查找资料，分析这个方案并评估是否可靠。',
      'Search the web for this proposal and assess whether its claims are credible.',
    ]) {
      for (const suggestedTier of [undefined, 'light', 'standard'] as const) {
        const decision = choose(value, 'standard', 'balanced', { prompt, suggestedTier });
        assert.deepEqual([decision.model, decision.effort], [catalog.strong, 'high']);
      }
      const fallback = choose(value, 'standard', 'balanced', { prompt, taskJudgment: undefined });
      assert.deepEqual([fallback.model, fallback.effort], [catalog.strong, 'high']);
      const lowAdvice = choose(value, 'standard', 'balanced', {
        prompt,
        suggestedTier: 'light',
        suggestedEffort: 'low',
      });
      assert.deepEqual([lowAdvice.model, lowAdvice.effort], [catalog.strong, 'high']);
      const pinned = choose(value, 'standard', 'balanced', { prompt, model: catalog.standard, effort: 'low' });
      assert.deepEqual([pinned.model, pinned.effort], [catalog.standard, 'low']);
    }
    for (const prompt of [
      '你搜一下这项产品的发布日期。',
      'Search the web for the release date.',
      '你搜一下这个产品是不是在周一发布。',
      'Search the web to find whether the library opens on Monday.',
      '你怎么看这个名字？',
      'Analyze the supplied paragraph.',
    ]) {
      const decision = choose(value, 'standard', 'balanced', { prompt });
      assert.deepEqual([decision.model, decision.effort], [catalog.standard, 'medium']);
    }
  }
});

test('modern terra is strong and wins over astra; older terra remains standard', () => {
  const codex = runtime();
  codex.models = [model('gpt-6-astra'), model('gpt-6.1-terra'), model('gpt-5.6-terra'), model('gpt-6.1-sol')];
  assert.equal(modelTier(codex.models[1], 'codex'), 'strong');
  assert.equal(modelTier(codex.models[2], 'codex'), 'standard');
  assert.equal(choose(codex, 'complex').model, 'gpt-6.1-terra');
  assert.equal(choose(codex, 'standard').model, 'gpt-6.1-sol');
});

test('planner routine and multiple-file requests respect task floors', () => {
  const codex = runtime();
  const request: Partial<RunInput> = {
    kind: 'routine',
    prompt: 'Implement a change '.repeat(12),
    taskJudgment: undefined,
    suggestedEffort: 'low',
  };
  const ordinary = choose(codex, 'standard', 'balanced', request);
  assert.deepEqual([ordinary.model, ordinary.effort], ['gpt-6-luna', 'low']);
  const classified = choose(codex, 'standard', 'balanced', {
    kind: 'auto',
    prompt: 'Fix the spelling',
    taskJudgment: undefined,
  });
  assert.deepEqual([classified.model, classified.effort], ['gpt-6-luna', 'low']);
  const routine = choose(codex, 'standard', 'balanced', { ...request, plannerStep: true });
  assert.notEqual(routine.model, 'gpt-6-luna');
  assert.equal(routine.effort, 'medium');
  const lookup = choose(codex, 'standard', 'balanced', {
    ...request,
    plannerStep: true,
    prompt: 'Read README.md',
  });
  assert.deepEqual([lookup.model, lookup.effort], ['gpt-6-luna', 'low']);
  const multi = choose(codex, 'standard', 'balanced', {
    kind: 'general',
    prompt: 'Fix src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts',
  });
  assert.equal(multi.model, 'gpt-6-astra');
  assert.equal(multi.effort, 'high');
  const bare = choose(codex, 'standard', 'balanced', { kind: 'general', prompt: 'Fix a.ts b.ts c.ts d.ts e.ts' });
  assert.equal(bare.model, 'gpt-6-astra');
  assert.equal(bare.effort, 'high');
});

test('plan steps and briefed tasks inherit the whole task tier; caller tiers and lookups keep theirs', () => {
  const codex = runtime();
  const whole = 'Implement the change in src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts and their tests';
  const step: Partial<RunInput> = {
    kind: 'routine',
    plannerStep: true,
    prompt: 'Step 1: update the parser',
    taskJudgment: undefined,
    suggestedEffort: 'low',
  };
  const alone = choose(codex, 'standard', 'balanced', step);
  assert.notEqual(alone.model, 'gpt-6-astra');
  const inherited = choose(codex, 'standard', 'balanced', { ...step, taskRoutingPrompt: whole });
  assert.deepEqual([inherited.model, inherited.effort], ['gpt-6-astra', 'high']);
  const lookup = choose(codex, 'standard', 'balanced', { ...step, prompt: 'Read README.md', taskRoutingPrompt: whole });
  assert.deepEqual([lookup.model, lookup.effort], ['gpt-6-luna', 'low']);
  const member = choose(runtime(catalogs[1]), 'standard', 'balanced', {
    prompt: 'Summarize the parser',
    taskRoutingPrompt: whole,
    taskJudgment: undefined,
    agentChild: true,
    readOnlyMember: true,
    suggestedTier: 'light',
  });
  assert.deepEqual([member.model, member.effort], ['haiku', 'low']);
});

test('numbered and bulleted checklists keep their floor in main tasks and short planned steps', () => {
  const codex = runtime();
  for (const list of [
    '1. Fix spelling\n2. Rename the label',
    '- Fix spelling\n* Rename the label\n+ Format the heading',
  ]) {
    const main = choose(codex, 'standard', 'balanced', {
      prompt: list,
      taskJudgment: undefined,
      suggestedEffort: 'low',
    });
    assert.deepEqual([main.model, main.effort], ['gpt-6.1-sol', 'medium'], list);
    const step = choose(codex, 'standard', 'balanced', {
      prompt: 'Rename the label',
      taskRoutingPrompt: list,
      plannerStep: true,
      taskJudgment: undefined,
      suggestedEffort: 'low',
    });
    assert.deepEqual([step.model, step.effort], ['gpt-6.1-sol', 'medium'], list);
  }
  for (const prompt of [
    '- Fix spelling',
    'Fix spelling - keep the heading + keep the label',
    'Fix spelling\n---\n***\n+',
  ]) {
    const single = choose(codex, 'standard', 'balanced', { prompt, taskJudgment: undefined });
    assert.deepEqual([single.model, single.effort], ['gpt-6-luna', 'low'], prompt);
  }
});

test('explicit member tiers and main-task advice (outside quality mode) override inferred floors', () => {
  const claude = runtime(catalogs[1]);
  const cases: Array<[Partial<RunInput> & Pick<RunInput, 'prompt'>, string, string]> = [
    [{ kind: 'routine', plannerStep: true, prompt: 'Implement a change' }, 'sonnet', 'medium'],
    [{ prompt: 'Update a.ts and b.ts' }, 'sonnet', 'medium'],
    [{ prompt: '1. Update the parser\n2. Update the handler' }, 'sonnet', 'medium'],
    [{ prompt: '- Update the parser\n* Update the handler' }, 'sonnet', 'medium'],
    [{ prompt: 'Fix a.ts b.ts c.ts d.ts e.ts' }, 'opus', 'high'],
    [{ prompt: 'Determine the root cause across multiple modules. '.repeat(100) }, 'opus', 'high'],
  ];
  for (const [input, model, effort] of cases) {
    const changes = { ...input, taskJudgment: undefined, agentChild: true, readOnlyMember: true };
    const guessed = choose(claude, 'standard', 'balanced', changes);
    assert.deepEqual([guessed.model, guessed.effort], [model, effort], input.prompt);
    for (const [suggestedTier, expectedModel, expectedEffort] of [
      ['light', 'haiku', 'low'],
      ['standard', 'sonnet', 'medium'],
    ] as const) {
      const explicit = choose(claude, 'standard', 'balanced', { ...changes, suggestedTier });
      assert.deepEqual([explicit.model, explicit.effort], [expectedModel, expectedEffort], input.prompt);
    }
    const callerEffort = choose(claude, 'standard', 'balanced', {
      ...changes,
      suggestedTier: 'standard',
      suggestedEffort: 'low',
    });
    assert.deepEqual([callerEffort.model, callerEffort.effort], ['sonnet', 'low'], input.prompt);
    // Laya's advice decides the main task outside quality mode; quality mode keeps its strong floor.
    const main = choose(claude, 'standard', 'balanced', { ...changes, agentChild: false, suggestedTier: 'light' });
    assert.deepEqual([main.model, main.effort], ['haiku', 'low'], input.prompt);
    const quality = choose(claude, 'standard', 'quality', { ...changes, agentChild: false, suggestedTier: 'light' });
    assert.equal(quality.model, 'opus', input.prompt);
  }
});

test('strong routes prefer terra over richer Opus and fall back when Codex is below reserve', () => {
  const codex = runtime();
  codex.models = [model('gpt-6.1-terra'), model('gpt-6-astra')];
  codex.quota.windows![0].usedPercent = 40;
  const claude = runtime(catalogs[1]);
  claude.quota.windows![0].usedPercent = 10;
  const request: RunInput = { prompt: 'Complex task', projectPath: 'synthetic', kind: 'auto', suggestedTier: 'strong' };
  assert.equal(route(request, [claude, codex], settings, new Set(), now).model, 'gpt-6.1-terra');
  codex.quota.windows![0].usedPercent = 95;
  codex.quota.windows![0].resetsAt = iso(72 * 3_600_000);
  assert.equal(route(request, [claude, codex], settings, new Set(), now).model, 'opus');
});
