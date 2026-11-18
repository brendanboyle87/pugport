import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { quotaPoolKey, route, type RouteCapacity } from '../src/server/routing.ts';
import { automaticApiTarget } from '../src/shared/automatic-executors.ts';
import type { QuotaWindow, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-27T01:00:00Z');
const iso = (hours = 0) => new Date(now + hours * 3_600_000).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'synthetic',
  maxConcurrentRuns: 2,
};
const window = (id: string, left: number, hours: number): QuotaWindow => ({
  id,
  label: id,
  usedPercent: 100 - left,
  resetsAt: iso(hours),
});
const runtime = (windows: QuotaWindow[]): RuntimeSnapshot => ({
  id: 'claude-fixture',
  provider: 'claude',
  label: 'Fixture',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: ['sonnet', 'opus'].map((id) => ({ id, label: id, efforts: ['low', 'medium', 'high'] })),
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  quota: { status: 'known', source: 'synthetic', observedAt: iso(), windows },
  refreshedAt: iso(),
});
const choose = (source: RuntimeSnapshot, input: Partial<RunInput> = {}, active = 0) => {
  const capacity: RouteCapacity = {
    reservations: new Map([[quotaPoolKey(source), active]]),
    settlingPools: new Set(),
  };
  return route(
    { prompt: 'Evaluate this proposal', kind: 'auto', projectPath: 'synthetic', ...input },
    [source],
    settings,
    capacity,
    now,
  );
};
const sessionWindow = (left: number): QuotaWindow => ({ ...window('session', left, 3), durationMinutes: 300 });
const chooseWithBackup = (
  source: RuntimeSnapshot,
  input: Partial<RunInput> = {},
  backupLeft = 80,
  backupActive = 0,
) => {
  const backup = { ...runtime([sessionWindow(backupLeft)]), id: 'claude-backup', models: source.models };
  return route(
    {
      prompt: 'Evaluate this proposal',
      kind: 'auto',
      projectPath: 'synthetic',
      continuationRunId: 'synthetic-continuation',
      ...input,
    },
    [source, backup],
    settings,
    {
      reservations: new Map([[quotaPoolKey(backup), backupActive]]),
      settlingPools: new Set(),
      continuing: [{ runtimeId: source.id }],
    },
    now,
  );
};

test('a fresh five-hour window at ordinary levels admits light and strong tasks without reset relaxation', () => {
  for (const suggestedTier of ['light', 'strong'] as const) {
    const decision = chooseWithBackup(runtime([sessionWindow(40)]), { suggestedTier });
    assert.equal(decision.runtimeId, 'claude-fixture');
    assert.doesNotMatch(decision.warnings.join('\n'), /临近重置.*保留线/);
  }
});

test('light tasks may use five-hour quota below the configured reserve without reset-relaxation warnings', () => {
  const decision = chooseWithBackup(runtime([sessionWindow(4)]), { suggestedTier: 'light' });
  assert.equal(decision.runtimeId, 'claude-fixture');
  assert.doesNotMatch(decision.warnings.join('\n'), /临近重置.*保留线/);
  assert.doesNotMatch(decision.reasons.join('\n'), /长任务改派/);
});

test('long tasks leave five-hour quota at four percent for another otherwise eligible account', () => {
  const inputs: Partial<RunInput>[] = [
    { suggestedTier: 'strong' },
    { effort: 'high' },
    { suggestedEffort: 'high' },
    { kind: 'architecture' },
    { prompt: 'x'.repeat(8000) },
    { schedule: { estimatedMinutes: 30 } },
  ];
  for (const input of inputs) {
    const decision = chooseWithBackup(runtime([sessionWindow(4)]), input);
    assert.equal(decision.runtimeId, 'claude-backup', JSON.stringify(input).slice(0, 100));
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
  }
});

test('balanced redirects complex long tasks to a healthy same-tier model below the demand tier', () => {
  const source = runtime([sessionWindow(4)]);
  source.models = [{ id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }];
  const backup = { ...runtime([sessionWindow(80)]), id: 'claude-backup', models: source.models };
  const decision = route(
    {
      prompt: 'Evaluate this proposal',
      kind: 'architecture',
      projectPath: 'synthetic',
      suggestedTier: 'strong',
      continuationRunId: 'synthetic-continuation',
    },
    [source, backup],
    { ...settings, routeGoal: 'balanced' },
    { reservations: new Map(), settlingPools: new Set(), continuing: [{ runtimeId: source.id }] },
    now,
  );
  assert.equal(decision.runtimeId, backup.id);
  assert.equal(decision.model, 'sonnet');
  assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
  assert.doesNotMatch(decision.reasons.join('\n'), /没有其他可用执行器/);
});

test('complex and high-effort long tasks keep scarce strong models instead of light-only alternatives', () => {
  const source = runtime([sessionWindow(4)]);
  source.models = source.models.filter((model) => model.id === 'opus');
  const light = { ...runtime([sessionWindow(80)]), id: 'claude-light' };
  light.models = [{ id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'] }];
  for (const patch of [{ kind: 'architecture' as const }, { effort: 'high' }]) {
    const decision = route(
      { prompt: 'Evaluate this proposal', kind: 'general', projectPath: 'synthetic', ...patch },
      [source, light],
      settings,
      new Set(),
      now,
    );
    assert.equal(decision.runtimeId, source.id);
    assert.equal(decision.model, 'opus');
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，没有其他可用执行器，仍按原规则派发长任务/);
    assert.doesNotMatch(decision.reasons.join('\n'), /长任务改派/);
  }
});

test('long-task redirection cannot replace a scarce CLI with a paid API that has budget', () => {
  const source = runtime([sessionWindow(4)]);
  const api: RuntimeSnapshot = {
    ...runtime([sessionWindow(80)]),
    id: 'paid-api',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'openai',
    models: [{ id: 'gpt-6-astra', label: 'Astra', efforts: ['high'], price: { input: 1, output: 2 } }],
    apiBudgetState: apiBudgetView(apiBudgetPolicy({ limitUsd: 20 }, undefined, iso()), 0, 0, 0, now),
  };
  const input: RunInput = { prompt: 'Evaluate this proposal', kind: 'architecture', projectPath: 'synthetic' };
  assert.equal(route({ ...input, runtimeId: api.id }, [api], settings, new Set(), now).runtimeId, api.id);
  for (const routeGoal of ['save', 'balanced', 'quality'] as const) {
    const decision = route(input, [source, api], { ...settings, routeGoal }, new Set(), now);
    assert.equal(decision.runtimeId, source.id);
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，没有.*执行器，仍按原规则派发长任务/);
    assert.doesNotMatch(decision.reasons.join('\n'), /长任务改派/);
  }
});

test('automatic API redirect keeps ordinary paid credit out and lets sprint credit, free APIs and subscriptions in', () => {
  const source = runtime([sessionWindow(80)]);
  assert.equal(automaticApiTarget(source, now), true);
  const api = { ...source, provider: 'pi' as const, gateway: 'api' as const, apiProvider: 'openai' };
  assert.equal(automaticApiTarget(api, now), false);
  api.apiBudgetState = apiBudgetView(
    apiBudgetPolicy({ limitUsd: 100, expiresAt: iso(1) }, undefined, iso(-10)),
    0,
    0,
    0,
    now,
  );
  assert.equal(api.apiBudgetState.phase, 'sprint');
  assert.equal(automaticApiTarget(api, now), true);
  assert.equal(automaticApiTarget({ ...api, costTier: 'free' }, now), true);
  assert.equal(automaticApiTarget({ ...api, apiProvider: 'ollama' }, now), true);
});

test('long-task redirect goals enforce demand, model tier and effort in automatic and rule routing', () => {
  const source = runtime([sessionWindow(4)]);
  source.models = [{ id: 'opus', label: 'Opus', efforts: ['max'] }];
  const backup = { ...runtime([sessionWindow(80)]), id: 'backup' };
  for (const selection of ['automatic', 'ordered', 'quota'] as const) {
    for (const routeGoal of ['save', 'balanced', 'quality'] as const) {
      for (const suggestedTier of ['standard', 'strong'] as const) {
        for (const [id, effort] of [
          ['sonnet', 'medium'],
          ['opus', 'high'],
          ['opus', 'max'],
        ] as const) {
          backup.models = [{ id, label: id, efforts: [effort] }];
          // Quota rules rank the backup first unless it has less left than the 4% source; a week that low (≤5%) is
          // itself too thin for a long task, so there both stay scarce and the task keeps its rule order.
          backup.quota.windows = [{ ...window('weekly', selection === 'quota' ? 3 : 8, 20) }];
          const input: RunInput = {
            prompt: 'Evaluate this proposal',
            kind: 'general',
            projectPath: 'synthetic',
            suggestedTier,
            schedule: { estimatedMinutes: 45 },
            ...(selection === 'automatic'
              ? {}
              : {
                  category: { id: 'code', confidence: 'high', reason: 'synthetic' },
                  routingRules: {
                    version: 2,
                    text: '',
                    unparsed: [],
                    updatedAt: iso(),
                    selection,
                    rules: [
                      {
                        id: 'test',
                        category: 'code',
                        strict: true,
                        enabled: true,
                        source: 'manual',
                        candidates: [{ runtimeId: source.id }, { runtimeId: backup.id }],
                      },
                    ],
                  },
                }),
          };
          const redirects =
            selection !== 'quota' &&
            (routeGoal === 'save' ||
              (routeGoal === 'balanced'
                ? suggestedTier === 'standard' || id === 'opus'
                : id === 'opus' && effort === 'max'));
          const decision = route(input, [source, backup], { ...settings, routeGoal }, new Set(), now);
          assert.equal(
            decision.runtimeId,
            redirects ? backup.id : source.id,
            `${selection}/${routeGoal}/${suggestedTier}/${id}/${effort}`,
          );
          assert.match(decision.reasons.join('\n'), redirects ? /长任务改派/ : /仍按原规则派发长任务/);
          if (!redirects && routeGoal === 'quality')
            assert.match(decision.reasons.join('\n'), /没有同档或更高档的执行器/);
        }
      }
    }
  }
});

test('balanced weighs an imminent reset against alternative load and still prefers healthier idle accounts', () => {
  const source = runtime([{ ...sessionWindow(4), resetsAt: iso(0.25) }]);
  source.models = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
  const backup = { ...runtime([sessionWindow(80)]), id: 'backup' };
  backup.models = [{ id: 'sonnet', label: 'Sonnet', efforts: ['medium'] }];
  const input: RunInput = {
    prompt: 'Evaluate this proposal',
    kind: 'general',
    projectPath: 'synthetic',
    schedule: { estimatedMinutes: 45 },
  };
  const capacity: RouteCapacity = { reservations: new Map([[quotaPoolKey(backup), 1]]), settlingPools: new Set() };
  assert.equal(route(input, [source, backup], settings, capacity, now).runtimeId, source.id);
  source.quota.windows[0]!.resetsAt = iso(3);
  assert.equal(route(input, [source, backup], settings, capacity, now).runtimeId, backup.id);
  capacity.reservations = new Map();
  source.quota.windows[0]!.resetsAt = iso(0.25);
  const richer = { ...backup, id: 'richer', quota: { ...backup.quota, windows: [sessionWindow(90)] } };
  assert.equal(route(input, [source, backup, richer], settings, capacity, now).runtimeId, richer.id);
});

test('eligible free API sources still qualify as long-task redirect alternatives', () => {
  const source = runtime([sessionWindow(4)]);
  for (const free of [{ costTier: 'free' as const, apiProvider: 'custom-free' }, { apiProvider: 'ollama' }]) {
    const api: RuntimeSnapshot = {
      ...runtime([sessionWindow(80)]),
      id: 'free-api',
      provider: 'pi',
      gateway: 'api',
      local: true,
      ...free,
    };
    const decision = route(
      {
        prompt: 'Evaluate this proposal',
        kind: 'general',
        projectPath: 'synthetic',
        permissionMode: 'read-only',
        effort: 'high',
        textOnlyPrompt: 'Evaluate this proposal',
      },
      [source, api],
      { ...settings, routeGoal: 'save' },
      new Set(),
      now,
    );
    assert.equal(decision.runtimeId, api.id);
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
  }
});

test('max and xhigh effort redirect a light-tier task away from scarce five-hour quota', () => {
  const source = runtime([sessionWindow(4)]);
  source.models = source.models.map((model) => ({ ...model, efforts: [...model.efforts, 'max', 'xhigh'] }));
  for (const effort of ['max', 'xhigh']) {
    const decision = chooseWithBackup(source, { suggestedTier: 'light', effort });
    assert.equal(decision.runtimeId, 'claude-backup');
    assert.equal(decision.effort, effort);
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
  }
});

test('the five-hour long-task threshold is exactly five percent, independent of the ten-percent reserve', () => {
  for (const left of [5, 5.1, 9]) {
    const decision = chooseWithBackup(runtime([sessionWindow(left)]), { suggestedTier: 'strong' });
    assert.equal(decision.runtimeId, left <= 5 ? 'claude-backup' : 'claude-fixture');
  }
});

test('the selected model high effort also protects scarce session quota', () => {
  const source = runtime([sessionWindow(4)]);
  source.models = source.models.map((model) => ({ ...model, efforts: ['high'] }));
  const decision = chooseWithBackup(source, { suggestedTier: 'light' });
  assert.equal(decision.runtimeId, 'claude-backup');
  assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
  assert.equal(decision.shortQuotaLeft, undefined);
  assert.equal(choose(source, { suggestedTier: 'light' }).shortQuotaLeft, 4);
});

test('five-hour readings with an explicitly unreported reset keep their existing reserve checks', () => {
  const source = runtime([{ ...sessionWindow(40), resetsAt: null, resetNotReported: true }]);
  const decision = choose(source, { suggestedTier: 'light' });
  assert.equal(decision.runtimeId, source.id);
  assert.match(decision.warnings.join('\n'), /未报告重置时间/);
  source.quota.windows[0]!.usedPercent = 96;
  assert.throws(() => choose(source, { suggestedTier: 'light' }), /保护阈值/);
});

test('a pinned executor keeps its five-hour quota behavior for a long task', () => {
  const source = runtime([sessionWindow(4)]);
  const decision = chooseWithBackup(source, { runtimeId: source.id, suggestedTier: 'strong' });
  assert.equal(decision.runtimeId, source.id);
  assert.doesNotMatch(decision.reasons.join('\n'), /长任务改派/);
});

test('a long task keeps its eligible account when no replacement passes the existing checks', () => {
  const source = runtime([sessionWindow(4)]);
  for (const decision of [
    choose(source, { suggestedTier: 'strong' }),
    chooseWithBackup(source, { suggestedTier: 'strong' }, 0),
  ]) {
    assert.equal(decision.runtimeId, source.id);
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%.*(?:没有|无).*可用/);
    assert.doesNotMatch(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
  }
});

test('all-scarce accounts and a buffer-blocked backup preserve the original eligible route', () => {
  const source = runtime([sessionWindow(4)]);
  for (const [backupLeft, backupActive] of [
    [3, 0],
    [10, 1],
  ]) {
    const decision = chooseWithBackup(source, { suggestedTier: 'strong' }, backupLeft, backupActive);
    assert.equal(decision.runtimeId, source.id);
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，没有其他可用执行器/);
    assert.doesNotMatch(decision.reasons.join('\n'), /长任务改派/);
    if (backupActive) assert.match(decision.reasons.join('\n'), /执行中的任务预留/);
  }
});

test('weekly and unknown-length windows retain their own time-based reserve warnings', () => {
  for (const id of ['weekly', 'unknown-window']) {
    for (const [left, hours, reserve] of [
      [3, 20, 2],
      [1, 5, 0],
    ]) {
      const decision = choose(runtime([window(id, left!, hours!)]));
      assert.match(decision.warnings.join('\n'), new RegExp(`临近重置.*保留线从 10% 降为 ${reserve}%`));
    }
  }
});

test('five-hour exhaustion, stale readings, missing usage and past-reset checks still block routing', () => {
  const cases: [Partial<QuotaWindow>, RegExp][] = [
    [{ usedPercent: 100 }, /保护阈值/],
    [{ observedAt: new Date(now - 180_000).toISOString() }, /读数需要更新/],
    [{ usedPercent: null }, /额度未知/],
    [{ resetsAt: iso() }, /重置后的额度/],
    [{ resetsAt: null }, /重置后的额度/],
  ];
  for (const [change, expected] of cases)
    assert.throws(() => choose(runtime([{ ...sessionWindow(40), ...change }])), expected);
  const stale = runtime([sessionWindow(40)]);
  stale.quota.observedAt = new Date(now - 180_000).toISOString();
  assert.throws(() => choose(stale), /额度数据已过期/);
  assert.throws(() => choose(runtime([])), /额度窗口缺失/);
});

test('routing admits fresh quota above the reserve of its own reset window', () => {
  for (const [left, hours] of [
    [3, 24],
    [1, 6],
    [0.1, 0.25],
  ])
    assert.equal(choose(runtime([window('weekly', left!, hours!)])).model, 'sonnet');
  for (const [left, hours] of [
    [2, 24],
    [0, 6],
    [9, 25],
  ])
    assert.throws(() => choose(runtime([window('weekly', left!, hours!)])), /保护阈值/);
});

test('a soon-resetting session never relaxes a later shared or selected-family limit', () => {
  const source = runtime([window('session', 1, 1), window('weekly', 9, 96)]);
  assert.throws(() => choose(source), /weekly.*保护阈值/);
  source.quota.windows[1] = { ...window('sonnet-weekly', 9, 96), modelFamily: 'sonnet' };
  assert.throws(() => choose(source, { model: 'sonnet' }), /sonnet-weekly.*保护阈值/);
  assert.equal(choose(source, { model: 'opus' }).model, 'opus');
});

test('family model filtering uses the same expiring reserve as final admission', () => {
  const source = runtime([
    window('shared', 80, 96),
    { ...window('opus-weekly', 1, 1), modelFamily: 'opus' },
    { ...window('sonnet-weekly', 80, 96), modelFamily: 'sonnet' },
  ]);
  assert.equal(choose(source, { suggestedTier: 'strong' }).model, 'opus');
});

test('in-flight buffers remain configured and every applicable window must cover them', () => {
  assert.equal(choose(runtime([window('session', 11, 1)]), {}, 1).model, 'sonnet');
  assert.throws(() => choose(runtime([window('session', 10, 1)]), {}, 1), /执行中的任务预留/);
  assert.throws(() => choose(runtime([window('session', 11, 1), window('weekly', 19, 96)]), {}, 1), /执行中的任务预留/);
});

test('members can use fresh expiring quota but bind to the smallest spare after each reserve', () => {
  const near = choose(runtime([window('weekly', 1, 1)]), { agentChild: true });
  assert.match(near.reasons.join('\n'), /同时最多 1 个成员/);
  const source = runtime([window('session', 25, 1), window('weekly', 30, 96)]);
  assert.throws(() => choose(source, { agentChild: true }, 1), /同时最多 1 个成员/);
});

test('Cursor pool preference uses the binding window effective reserve', () => {
  const source = runtime([
    { ...window('cursor', 80, 96), modelPool: 'cursor' },
    { ...window('other', 12, 1), modelPool: 'other' },
  ]);
  source.id = 'cursor-fixture';
  source.provider = 'cursor';
  source.models = [
    { id: 'composer-2.5', label: 'Composer', efforts: [], quotaPool: 'cursor' },
    { id: 'claude-opus-5', label: 'Opus', efforts: [], quotaPool: 'other' },
  ];
  assert.equal(choose(source, { suggestedTier: 'strong' }).model, 'claude-opus-5');
});

test('stale, exhausted and past-reset readings never become usable through reserve tapering', () => {
  const source = runtime([window('weekly', 1, 1)]);
  source.quota.windows[0]!.observedAt = new Date(now - 180_000).toISOString();
  assert.throws(() => choose(source), /读数需要更新/);
  delete source.quota.windows[0]!.observedAt;
  source.quota.windows[0]!.usedPercent = 100;
  assert.throws(() => choose(source), /保护阈值/);
  source.quota.windows[0]!.usedPercent = 99;
  source.quota.windows[0]!.resetsAt = iso(0);
  assert.throws(() => choose(source), /重置后的额度/);
});
