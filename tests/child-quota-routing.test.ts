import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaPoolKey, quotaReservationKeys, route, type RouteCapacity } from '../src/server/routing.ts';
import type { ModelInfo, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-06T12:00:00Z');
const iso = (delta = 0) => new Date(now + delta).toISOString();
const config: Settings = {
  routePreferencesEnabled: true,
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: '/fixture',
  maxConcurrentRuns: 0,
};
const input: RunInput = {
  prompt: 'Review this implementation',
  projectPath: '/fixture',
  kind: 'general',
  agentChild: true,
  executionPolicy: 'cli-only',
};
const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  label: id,
  efforts: ['low', 'medium', 'high', 'xhigh'],
  ...extra,
});
const runtime = (id: string, provider: RuntimeSnapshot['provider'], models: ModelInfo[]): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  accountFingerprint: id,
  models,
  refreshedAt: iso(),
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  quota: {
    status: 'known',
    source: 'Fixture only',
    observedAt: iso(),
    windows: [{ id: 'week', label: 'Week', usedPercent: 20, resetsAt: iso(86400000) }],
  },
});
const capacity = (reservations = new Map<string, number>(), extra: Partial<RouteCapacity> = {}): RouteCapacity => ({
  reservations,
  settlingPools: new Set(),
  ...extra,
});

test('automatic children spread across independent accounts and providers while ordinary main-task preference is preserved', () => {
  const a = runtime('codex-a', 'codex', [model('gpt-6-sol')]);
  const alias = { ...a, id: 'codex-alias' };
  const b = runtime('claude-b', 'claude', [model('claude-sonnet-5')]);
  const load = capacity(new Map([[quotaPoolKey(a), 2]]));
  const choose = (changes: Partial<RunInput>) => route({ ...input, ...changes }, [a, alias, b], config, load, now);
  assert.equal(choose({}).runtimeId, b.id);
  assert.equal(
    choose({ kind: 'architecture' }).runtimeId,
    b.id,
    'a default category preference does not concentrate all sub-tasks',
  );
  assert.equal(choose({ kind: 'architecture', agentChild: false }).runtimeId, a.id);
  assert.equal(choose({ runtimeId: a.id }).runtimeId, a.id);
  assert.equal(choose({ model: 'gpt-6-sol' }).model, 'gpt-6-sol');
  assert.equal(choose({ provider: 'codex' }).runtimeId, a.id);
  assert.match(choose({}).reasons.join('\n'), /自动分散子任务/);
});

test('distribution keeps the capability floor, CLI priority and explicit model overrides', () => {
  const a = runtime('busy-codex', 'codex', [model('gpt-6-sol')]);
  const light = runtime('idle-claude', 'claude', [model('claude-haiku-5')]);
  const api = runtime('api-fixture', 'pi', [model('gpt-6-astra')]);
  api.accounting = { mode: 'usage', source: 'Synthetic API' };
  api.quota = { status: 'unknown', source: 'Synthetic API', observedAt: null, windows: [] };
  const load = capacity(new Map([[quotaPoolKey(a), 2]]));
  assert.equal(route({ ...input, executionPolicy: 'cli-first' }, [a, light, api], config, load, now).runtimeId, a.id);
  assert.throws(() => route(input, [light], config, load, now), /常规或更高能力/);
  assert.equal(route({ ...input, kind: 'routine' }, [a, light], config, load, now).runtimeId, light.id);
  assert.equal(route({ ...input, model: 'claude-haiku-5' }, [a, light], config, load, now).model, 'claude-haiku-5');
  assert.equal(route({ ...input, executionPolicy: 'api-only' }, [a, api], config, load, now).runtimeId, api.id);
});

test('a child selects its own difficulty and supported effort from its request rather than parent context or catalog defaults', () => {
  const catalogs = [
    { provider: 'codex', light: 'gpt-6-luna', standard: 'gpt-6-sol', strong: 'gpt-6-astra' },
    { provider: 'claude', light: 'claude-haiku-5', standard: 'claude-sonnet-5', strong: 'claude-opus-5' },
    { provider: 'grok', light: 'grok-code-fast-1', standard: 'grok-4.7', strong: 'grok-4.7-heavy' },
  ] as const;
  for (const catalog of catalogs) {
    const account = runtime(
      catalog.provider,
      catalog.provider,
      [catalog.strong, catalog.standard, catalog.light].map((id) => model(id, { defaultEffort: 'xhigh' })),
    );
    const choose = (routingPrompt: string, changes: Partial<RunInput> = {}) =>
      route(
        {
          ...input,
          kind: 'auto',
          prompt: 'Parent task: complex security architecture, use the highest possible reasoning strength.',
          routingPrompt,
          ...changes,
        },
        [account],
        config,
        capacity(),
        now,
      );
    for (const request of [
      '查找指定文档并返回文件路径。',
      'Read the named authentication document and return its file path.',
    ]) {
      const lookup = choose(request);
      assert.equal(lookup.model, catalog.light);
      assert.equal(lookup.effort, 'low');
      const localGeneral = choose(request, { kind: 'general' });
      assert.equal(
        localGeneral.model,
        catalog.light,
        'a local general fallback does not inherit the parent difficulty',
      );
      assert.equal(localGeneral.effort, 'low');
    }
    const ordinary = choose('Review this implementation.');
    assert.equal(ordinary.model, catalog.standard);
    assert.equal(ordinary.effort, 'medium');
    const complex = choose('对多个方案进行多约束综合判断，解释复杂权衡。');
    assert.equal(complex.model, catalog.strong);
    assert.equal(complex.effort, 'high');
    const pinned = choose('查找指定文件路径。', { model: catalog.strong, effort: 'xhigh' });
    assert.equal(pinned.model, catalog.strong);
    assert.equal(pinned.effort, 'xhigh');
    assert.equal(choose('查找指定文件路径。', { model: catalog.strong }).effort, 'low');
    const mainTask = choose('查找指定文件路径。', { agentChild: false });
    assert.equal(mainTask.model, catalog.light, 'the same bounded lookup policy applies to main and child tasks');
    assert.equal(mainTask.effort, 'low');
    account.models = [model(catalog.standard, { efforts: ['medium', 'high'], defaultEffort: 'high' })];
    assert.equal(choose('查找指定文件路径。').effort, 'medium', 'only actually supported effort levels are selected');
    assert.throws(
      () => choose('查找指定文件路径。', { effort: 'ultra' }),
      /不支持 ultra/,
      'a caller-supplied child effort is validated against the selected executor catalog',
    );
    account.models[0]!.efforts = [];
    assert.equal(choose('查找指定文件路径。').effort, undefined, 'an effort is never invented for a fixed-effort CLI');
  }
});

test('child capability tiers take priority over idle lower tiers while quota and same-tier load still distribute work', () => {
  const strong = runtime('strong', 'codex', [model('gpt-6-astra')]);
  const standard = runtime('standard', 'claude', [model('claude-sonnet-5')]);
  const anotherStrong = runtime('other-strong', 'grok', [model('grok-4.7-heavy')]);
  const load = capacity(new Map([[quotaPoolKey(strong), 2]]));
  const choose = (values: RuntimeSnapshot[]) =>
    route(
      { ...input, kind: 'auto', routingPrompt: 'Make a complex multi-constraint judgment and explain the trade-offs.' },
      values,
      config,
      load,
      now,
    );
  assert.equal(choose([strong, standard]).runtimeId, strong.id);
  assert.equal(choose([strong, standard]).effort, 'high');
  assert.equal(choose([strong, standard, anotherStrong]).runtimeId, anotherStrong.id);
  strong.quota.windows[0]!.usedPercent = 99;
  assert.equal(
    choose([strong, standard]).runtimeId,
    standard.id,
    'an unavailable strong tier falls back within the capability floor',
  );
  assert.equal(choose([strong, standard]).effort, 'high');
  const light = runtime('light', 'codex', [model('gpt-6-luna')]);
  assert.equal(
    route(
      { ...input, kind: 'auto', routingPrompt: 'Find the named file path.' },
      [light, standard],
      config,
      capacity(),
      now,
    ).runtimeId,
    light.id,
  );
});

test('unused independent Claude family inventory can take a sub-task without inheriting another family reservation or settlement', () => {
  const a = runtime('claude-a', 'claude', [model('claude-fable-5'), model('claude-opus-5')]);
  a.quota.windows = ['fable', 'opus'].map((family) => ({
    id: family,
    label: family,
    modelFamily: family as 'fable' | 'opus',
    usedPercent: 20,
    resetsAt: iso(86400000),
  }));
  const account = quotaPoolKey(a);
  const fable = quotaReservationKeys(a, a.models[0]!)[0]!;
  const opus = quotaReservationKeys(a, a.models[1]!)[0]!;
  assert.notEqual(fable, opus);
  const load = capacity(new Map([[account, 3]]), {
    quotaReservations: new Map([[fable, 3]]),
    settlingPools: new Set([account]),
    settlingQuotaPools: new Set([fable]),
  });
  const selected = route(input, [a], { ...config, routeGoal: 'quality' }, load, now);
  assert.equal(selected.model, 'claude-opus-5');
  assert.doesNotMatch(selected.warnings.join('\n'), /预留调度余量/);
  assert.throws(() => route({ ...input, model: 'claude-fable-5' }, [a], config, load, now), /同步任务后的额度/);
  const shared = {
    ...a,
    quota: {
      ...a.quota,
      windows: [...a.quota.windows, { id: 'shared', label: 'Shared', usedPercent: 20, resetsAt: iso(86400000) }],
    },
  };
  assert.ok(quotaReservationKeys(shared, shared.models[1]!).includes(account));
  assert.throws(
    () => route(input, [shared], config, { ...load, settlingQuotaPools: new Set([account]) }, now),
    /同步任务后的额度/,
  );
  assert.throws(() => route(input, [a], config, { ...load, maxRunsPerPool: 3 }, now), /并发容量/);
});

test('equally loaded sub-tasks use expiring inventory while stale or exhausted pools stay excluded', () => {
  const early = runtime('early', 'codex', [model('gpt-6-sol')]);
  const later = runtime('later', 'claude', [model('claude-sonnet-5')]);
  early.quota.windows[0]!.resetsAt = iso(3600000);
  later.quota.windows[0]!.resetsAt = iso(86400000);
  later.quota.windows[0]!.usedPercent = 10;
  assert.equal(route(input, [early, later], config, capacity(), now).runtimeId, early.id);
  early.quota.windows[0]!.usedPercent = 100;
  assert.equal(route(input, [early, later], config, capacity(), now).runtimeId, later.id);
  early.quota.windows[0]!.usedPercent = 20;
  early.quota.windows[0]!.observedAt = iso(-180000);
  assert.equal(route(input, [early, later], config, capacity(), now).runtimeId, later.id);
});
