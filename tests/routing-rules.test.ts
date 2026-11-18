import { routingRuleSetSchema } from '../src/shared/routing-schema.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import { candidateInputs, effectiveRules, matchRule } from '../src/server/routing-rules.ts';
import { routedMessage, strictRoute, reviewerCandidates } from '../src/server/conversation-routing.ts';
import { upgradeRouting } from '../src/shared/conversation-routing.ts';
import type {
  ConversationRouting,
  MessageInput,
  RoutingRule,
  RoutingRuleSet,
  RunInput,
  RuntimeSnapshot,
  Settings,
} from '../src/shared/types.ts';

const now = Date.parse('2026-10-12T12:00:00Z');
const iso = (minutes = 0) => new Date(now + minutes * 60_000).toISOString();
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
const snapshot = (id: string, provider: RuntimeSnapshot['provider'], used = 10, reset = 60): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low', 'high'] }],
  capabilities: { execute: true, resume: true, cancel: true, approvals: true, toolless: true },
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: iso(),
    windows: [{ id: 'week', label: 'week', usedPercent: used, resetsAt: iso(reset) }],
  },
  refreshedAt: iso(),
});
const rule = (patch: Partial<RoutingRule> = {}): RoutingRule => ({
  id: 'adult',
  category: 'adult',
  candidates: [{ runtimeId: 'a' }, { runtimeId: 'b' }],
  strict: true,
  enabled: true,
  source: 'manual',
  ...patch,
});
const set = (rules: RoutingRule[]): RoutingRuleSet => ({ version: 2, text: '', rules, unparsed: [], updatedAt: iso() });
const input = (r = rule()): RunInput => ({
  prompt: '写成人内容',
  projectPath: 'synthetic',
  kind: 'general',
  routingRules: set([r]),
  category: { id: r.category, confidence: 'high', reason: 'fixture' },
});
const choose = (request: RunInput, snapshots: RuntimeSnapshot[]) => route(request, snapshots, settings, new Set(), now);

test('verifier roles enable review while manual parent picks suppress all profile roles', () => {
  const profile: ConversationRouting = {
    ...set([]),
    chapterAgents: false,
    mask: false,
    roles: {
      coordinator: { provider: 'claude' },
      verifier: [{ provider: 'codex', model: 'fixture-model' }],
    },
  };
  const message: MessageInput = {
    content: 'Explain this code',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    autoEscalate: false,
  };
  const automatic = routedMessage(message, profile, []);
  assert.equal(automatic.review, true);
  assert.equal(automatic.provider, 'claude');
  assert.deepEqual(
    reviewerCandidates({ input: automatic, ownSelection: {}, routingContext: { routingRules: profile } }),
    profile.roles!.verifier,
  );
  for (const pick of [
    { provider: 'codex' as const },
    { runtimeId: 'a' },
    { model: 'fixture-model' },
    { effort: 'high' },
  ]) {
    const manual = { ...message, ...pick };
    assert.deepEqual(routedMessage(manual, profile, []), manual);
    assert.equal(
      reviewerCandidates({ input: manual, ownSelection: pick, routingContext: { routingRules: profile } }),
      undefined,
    );
  }
});

test('reviewer candidates are ordered and unavailable choices fall back to automatic cross-review', () => {
  const request: RunInput = {
    ...input(rule({ category: 'code', candidates: [] })),
    prompt: 'Review the change',
    excludeProviders: ['codex'],
    verifierCandidates: [
      { runtimeId: 'a', model: 'fixture-model', effort: 'high' },
      { runtimeId: 'b', model: 'fixture-model', effort: 'low' },
    ],
  };
  const ready = [snapshot('a', 'claude'), snapshot('b', 'claude'), snapshot('c', 'grok')];
  const first = choose(request, ready);
  assert.equal(first.runtimeId, 'a');
  assert.equal(first.effort, 'high');
  assert.equal(first.routeRule?.id, 'role:verifier');
  const next = choose(request, [snapshot('a', 'claude', 100), ...ready.slice(1)]);
  assert.equal(next.runtimeId, 'b');
  assert.equal(next.effort, 'low');
  assert.match(next.reasons.join('\n'), /核验候选 1 不可用/);
  const fallback = choose(request, [snapshot('a', 'claude', 100), snapshot('b', 'claude', 100), ready[2]!]);
  assert.equal(fallback.runtimeId, 'c');
  assert.match(fallback.reasons.join('\n'), /核验候选均不可用，恢复自动审核/);
  assert.equal(choose({ ...request, runtimeId: 'c' }, ready).runtimeId, 'c');
});

test('verification skips same-vendor profile candidates and uses a different effort only as fallback', () => {
  const request: RunInput = {
    prompt: 'Verify factual statements',
    projectPath: 'synthetic',
    kind: 'general',
    verifierOf: { provider: 'codex', runtimeId: 'a', model: 'fixture-model', effort: 'low' },
    verifierCandidates: [{ runtimeId: 'a' }, { runtimeId: 'b' }, { runtimeId: 'c' }],
  };
  const ready = [snapshot('a', 'codex'), snapshot('b', 'claude'), snapshot('c', 'grok')];
  const different = choose(request, ready);
  assert.equal(different.runtimeId, 'b');
  assert.equal(different.routeRule?.index, 1);
  assert.equal(choose(request, [ready[0]!, { ...ready[1]!, status: 'missing' }, ready[2]!]).runtimeId, 'c');
  const fallback = choose(request, [ready[0]!]);
  assert.equal(fallback.runtimeId, 'a');
  assert.equal(fallback.model, 'fixture-model');
  assert.equal(fallback.effort, 'high');
  assert.match(fallback.reasons.join('\n'), /核验降级.*low → high/);
  assert.equal(
    choose({ ...request, verifierOf: { ...request.verifierOf!, effort: 'high' } }, [ready[0]!]).effort,
    'low',
  );
  const unordered = {
    ...ready[0]!,
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['high', 'low', 'medium'], defaultEffort: 'medium' }],
  };
  assert.equal(
    choose({ ...request, verifierOf: { ...request.verifierOf!, effort: undefined } }, [unordered]).effort,
    'high',
  );
  assert.throws(
    () => choose({ ...request, verifierOf: { ...request.verifierOf!, effort: undefined } }, [ready[0]!]),
    /没有不同的推理强度/,
  );
  assert.throws(
    () => choose(request, [{ ...ready[0]!, models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low'] }] }]),
    /没有不同的推理强度/,
  );
  // A strict category rule or a parent pin must never restore the answerer.
  assert.equal(
    choose({ ...request, runtimeId: 'a', routingRules: set([rule({ candidates: [{ runtimeId: 'a' }] })]) }, ready)
      .runtimeId,
    'b',
  );
});

test('verification changes Cursor effort within the same model family in legacy catalogs', () => {
  const cursor = {
    ...snapshot('cursor', 'cursor'),
    models: ['grok-4.7-high', 'grok-4.7-low'].map((id) => ({ id, label: id, efforts: [] })),
  };
  const selected = choose(
    {
      prompt: 'Verify the claim',
      projectPath: 'synthetic',
      kind: 'general',
      verifierOf: { provider: 'cursor', runtimeId: 'cursor', model: 'grok-4.7-low' },
    },
    [cursor],
  );
  assert.equal(selected.runtimeId, 'cursor');
  assert.equal(selected.model, 'grok-4.7-high');
  assert.match(selected.reasons.join('\n'), /low → high/);
});

test('same-provider verifier candidates are skipped before native-to-Cursor proxy fallback', () => {
  const cursor = { ...snapshot('cursor', 'cursor'), models: [{ id: 'grok-4.7-high', label: 'Grok', efforts: [] }] };
  const selected = choose(
    {
      prompt: 'Verify the claim',
      projectPath: 'synthetic',
      kind: 'general',
      verifierOf: { provider: 'grok', runtimeId: 'grok', model: 'fixture-model', effort: 'low' },
      verifierCandidates: [{ provider: 'grok' }, { provider: 'claude' }],
    },
    [snapshot('grok', 'grok'), cursor, snapshot('claude', 'claude')],
  );
  assert.equal(selected.runtimeId, 'claude');
  assert.equal(selected.routeRule?.index, 1);
});

test('candidate order is authority, with unavailable candidates explained and derived metadata retained', () => {
  const ready = [snapshot('b', 'claude'), snapshot('a', 'grok')];
  const first = choose(input(), ready);
  assert.equal(first.runtimeId, 'a');
  assert.equal(first.routeRule?.derived, true);
  assert.equal(first.routeRule?.index, 0);
  const next = choose(input(), [snapshot('a', 'grok', 100), ready[0]!]);
  assert.equal(next.runtimeId, 'b');
  assert.equal(next.routeRule?.index, 1);
  assert.match(next.reasons[0]!, /强制.*候选 2/);
  assert.match(next.reasons.join('\n'), /候选 1 不可用/);
  assert.doesNotMatch(next.reasons.join('\n'), /用户锁定执行器/);
});

test('automatic rules defer low session quota for long work without widening strict rules or manual pins', () => {
  const scarce = snapshot('a', 'claude', 96);
  scarce.quota.windows[0] = { ...scarce.quota.windows[0]!, id: 'five_hour', durationMinutes: 300 };
  const backup = snapshot('b', 'claude');
  for (const source of [scarce, backup]) source.models[0] = { id: 'opus', label: 'Opus', efforts: ['high'] };
  const request = { ...input(rule({ category: 'code' })), suggestedTier: 'strong' as const };
  for (const selection of ['ordered', 'quota'] as const) {
    request.routingRules!.selection = selection;
    const decision = choose(request, [scarce, backup]);
    assert.equal(decision.runtimeId, 'b');
    assert.equal(decision.shortQuotaLeft, undefined);
    assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
    assert.doesNotMatch(decision.reasons.join('\n'), /没有其他可用执行器/);
    assert.equal(choose({ ...request, runtimeId: 'a' }, [scarce, backup]).runtimeId, 'a');
    const fallback = choose(request, [scarce, snapshot('b', 'claude', 100), snapshot('outside', 'claude')]);
    assert.equal(fallback.runtimeId, 'a');
    assert.equal(fallback.shortQuotaLeft, 4);
    assert.match(fallback.reasons.join('\n'), /5 小时额度只剩 4%.*没有其他可用执行器/);
  }
});

test('overlapping account and provider candidates report a long-task redirect only once', () => {
  const scarce = snapshot('a', 'claude', 96);
  scarce.quota.windows[0] = { ...scarce.quota.windows[0]!, id: 'five_hour', durationMinutes: 300 };
  scarce.models[0] = { id: 'opus', label: 'Opus', efforts: ['high'] };
  const backup = snapshot('b', 'claude');
  backup.models = scarce.models;
  const request = {
    ...input(rule({ category: 'code', candidates: [{ runtimeId: 'a' }, { provider: 'claude' }] })),
    suggestedTier: 'strong' as const,
  };
  const decision = choose(request, [scarce, backup]);
  assert.equal(decision.runtimeId, 'b');
  assert.equal(decision.reasons.filter((reason) => /5 小时额度只剩 4%，长任务改派/.test(reason)).length, 1);
  assert.deepEqual(decision.reasons, [...new Set(decision.reasons)]);
});

test('rule scarcity redirects preserve model fit and do not select paid API alternatives', () => {
  const scarce = snapshot('a', 'claude', 96);
  scarce.quota.windows[0] = { ...scarce.quota.windows[0]!, id: 'five_hour', durationMinutes: 300 };
  scarce.models = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
  for (const selection of ['ordered', 'quota'] as const) {
    const light = snapshot('b', 'claude', selection === 'quota' ? 97 : 20, 20 * 60);
    light.models = [{ id: 'haiku', label: 'Haiku', efforts: ['high'] }];
    const api: RuntimeSnapshot = {
      ...light,
      provider: 'pi',
      gateway: 'api',
      apiProvider: 'openai',
      models: [{ id: 'gpt-6-astra', label: 'Astra', efforts: ['high'], price: { input: 1, output: 2 } }],
      apiBudgetState: apiBudgetView(
        apiBudgetPolicy({ limitUsd: 100 }, undefined, iso()),
        selection === 'quota' ? 97 : 0,
        0,
        0,
        now,
      ),
    };
    const request = {
      ...input(rule({ category: 'code' })),
      prompt: 'Evaluate this proposal',
      suggestedEffort: 'high',
    };
    request.routingRules!.selection = selection;
    for (const backup of [light, api]) {
      const decision = choose(request, [scarce, backup]);
      assert.equal(decision.runtimeId, scarce.id, `${selection}: ${backup.provider}`);
      assert.equal(decision.model, 'opus');
      assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，没有其他可用执行器，仍按原规则派发长任务/);
      assert.doesNotMatch(decision.reasons.join('\n'), /长任务改派/);
      assert.equal(choose({ ...request, runtimeId: backup.id }, [scarce, backup]).runtimeId, backup.id);
    }
    // A configured quota rule may select an API on its own, without a scarcity-induced redirect.
    api.quota = snapshot('b', 'pi', 20).quota;
    api.apiBudgetState = apiBudgetView(api.apiBudgetState!.policy, 0, 0, 0, now);
    request.routingRules!.selection = 'quota';
    assert.equal(choose(request, [scarce, api]).runtimeId, scarce.id);
  }
});

test('quality scarcity comparisons resolve saved Cursor variants against canonical catalogs', () => {
  const scarce = snapshot('a', 'cursor', 96);
  scarce.quota.windows[0] = { ...scarce.quota.windows[0]!, id: 'five_hour', durationMinutes: 300 };
  scarce.models = [{ id: 'claude-opus-5', label: 'Opus', efforts: ['high', 'xhigh'] }];
  const backup = snapshot('b', 'claude');
  const request = {
    ...input(
      rule({
        category: 'code',
        candidates: [{ runtimeId: 'a', model: 'claude-opus-5-thinking-xhigh' }, { runtimeId: 'b' }],
      }),
    ),
    prompt: 'Evaluate this proposal',
    schedule: { estimatedMinutes: 45 },
  };
  for (const effort of ['high', 'xhigh', 'extra-high']) {
    backup.models = [{ id: 'opus', label: 'Opus', efforts: [effort] }];
    const decision = route(request, [scarce, backup], { ...settings, routeGoal: 'quality' }, new Set(), now);
    assert.equal(decision.runtimeId, effort === 'high' ? scarce.id : backup.id);
    if (effort === 'high') assert.equal(decision.model, 'claude-opus-5-thinking-xhigh');
  }
});

test('explicit quota selection compares eligible candidates across providers without changing ordered defaults', () => {
  const request = input(rule({ category: 'code', candidates: [{ provider: 'codex' }, { provider: 'claude' }] }));
  const available = [snapshot('codex-a', 'codex', 75), snapshot('claude-a', 'claude', 20)];
  assert.equal(choose(request, available).runtimeId, 'codex-a');
  request.routingRules!.selection = 'quota';
  const picked = choose(request, available);
  assert.equal(picked.runtimeId, 'claude-a');
  assert.equal(picked.routeRule?.index, 1);
  assert.match(picked.reasons.join('\n'), /全部可用候选/);
  assert.equal(choose({ ...request, runtimeId: 'codex-a' }, available).runtimeId, 'codex-a');
  assert.equal(choose(request, [available[0]!, snapshot('claude-a', 'claude', 95)]).runtimeId, 'codex-a');
});

test('profile model exclusions cover automatic picks, derived children and soft fallback, while manual pins remain explicit', () => {
  const request = input(
    rule({ category: 'code', strict: false, candidates: [{ provider: 'codex', model: 'blocked-lite' }] }),
  );
  request.routingRules!.excludeModels = ['*-lite'];
  const codex = snapshot('codex-a', 'codex'),
    claude = snapshot('claude-a', 'claude');
  codex.models = [{ id: 'blocked-lite', label: 'Lite', efforts: ['low'] }];
  claude.models = [{ id: 'permitted', label: 'Standard', efforts: ['low'] }];
  const picked = choose(request, [codex, claude]);
  assert.equal(picked.runtimeId, 'claude-a');
  assert.equal(picked.model, 'permitted');
  const child = { ...request, agentChild: true, automaticExecutorSelection: true };
  assert.equal(choose(child, [codex, claude]).model, 'permitted');
  const pinned = choose({ ...request, runtimeId: codex.id, model: 'blocked-lite' }, [codex, claude]);
  assert.equal(pinned.model, 'blocked-lite');
  assert.throws(
    () => choose({ ...request, routingRules: { ...request.routingRules!, rules: [] } }, [codex]),
    RouteUnavailableError,
  );
  assert.throws(
    () =>
      choose(
        {
          ...request,
          routeRule: { id: 'derived', label: 'Code', index: 0, strict: true, derived: true },
          model: 'blocked-lite',
        },
        [codex],
      ),
    RouteUnavailableError,
  );
});

test('technical failover cannot reselect a model excluded by the captured profile', () => {
  const blocked = snapshot('codex-a', 'codex'),
    allowed = snapshot('claude-a', 'claude');
  blocked.models = [{ id: 'blocked-lite', label: 'Lite', efforts: ['low'] }];
  allowed.models = [{ id: 'permitted', label: 'Standard', efforts: ['low'] }];
  const request: RunInput = {
    prompt: 'Explain this function',
    projectPath: 'synthetic',
    kind: 'general',
    provider: 'codex',
    model: 'missing',
    allowExecutorFallback: true,
    routingRules: { ...set([]), excludeModels: ['*-lite'] },
  };
  assert.equal(choose(request, [blocked, allowed]).model, 'permitted');
  assert.throws(() => choose(request, [blocked]), RouteUnavailableError);
});
test('strict exhausted candidates wait for the earliest reset while missing candidates remain unavailable', () => {
  assert.throws(
    () => choose(input(), [snapshot('a', 'grok', 100, 120), snapshot('b', 'claude', 100, 30), snapshot('c', 'codex')]),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.equal(error.kind, 'quota');
      assert.equal(error.retryAt, iso(30));
      assert.match(error.message, /不自动改派/);
      return true;
    },
  );
  assert.throws(
    () => choose(input(), [snapshot('c', 'codex')]),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.equal(error.kind, 'unavailable');
      assert.equal(error.retryAt, undefined);
      return true;
    },
  );
});

test('strict rules aggregate recoverable failures without inventing a quota cooldown or widening candidates', () => {
  const stale = snapshot('a', 'grok');
  stale.quota.observedAt = iso(-10);
  const unknown = snapshot('a', 'grok');
  unknown.authMode = 'unknown';
  unknown.quota = { status: 'unknown', source: 'fixture', observedAt: null, windows: [] };
  const signedOut = { ...snapshot('a', 'grok'), status: 'auth-required' as const };
  const unsupported = { ...snapshot('a', 'grok'), models: [] };
  const cases = [
    { name: 'stale plus missing', snapshots: [stale], kind: 'refresh' },
    { name: 'unverified unknown quota plus missing', snapshots: [unknown], kind: 'refresh' },
    { name: 'signed out plus missing', snapshots: [signedOut], kind: 'unavailable' },
    { name: 'unsupported plus missing', snapshots: [unsupported], kind: 'unavailable' },
    { name: 'busy plus missing', snapshots: [snapshot('a', 'grok')], busy: ['a'], kind: 'capacity' },
    { name: 'missing plus exhausted', snapshots: [snapshot('b', 'claude', 100, 30)], kind: 'quota', retry: iso(30) },
    { name: 'exhausted plus missing', snapshots: [snapshot('a', 'grok', 100, 30)], kind: 'quota', retry: iso(30) },
    { name: 'stale plus exhausted', snapshots: [stale, snapshot('b', 'claude', 100)], kind: 'refresh' },
    {
      name: 'busy plus exhausted',
      snapshots: [snapshot('a', 'grok'), snapshot('b', 'claude', 100)],
      busy: ['a'],
      kind: 'capacity',
    },
    { name: 'stale plus busy', snapshots: [stale, snapshot('b', 'claude')], busy: ['b'], kind: 'capacity' },
  ];
  for (const fixture of cases) {
    assert.throws(
      () =>
        route(
          input(),
          [...fixture.snapshots, snapshot('c', 'codex')],
          settings,
          { reservations: new Map(), settlingPools: new Set(fixture.busy?.map((id) => `runtime:${id}`)) },
          now,
        ),
      (error: unknown) => {
        assert.ok(error instanceof RouteUnavailableError, fixture.name);
        assert.equal(error.kind, fixture.kind, fixture.name);
        assert.equal(error.retryAt, fixture.retry, fixture.name);
        assert.equal(error.technicalFallbackAllowed, false, fixture.name);
        assert.match(error.message, /候选 1 不可用/);
        assert.match(error.message, /候选 2 不可用/);
        assert.match(error.message, /不自动改派/);
        return true;
      },
      fixture.name,
    );
  }
});

test('checklists skip strict rule candidates with reasons, but an unchecked user pin still wins', () => {
  const snapshots = [snapshot('a', 'grok'), snapshot('b', 'claude'), snapshot('c', 'codex')];
  const request = { ...input(), automaticExecutors: ['b', 'c'] };
  const decision = choose(request, snapshots);
  assert.equal(decision.runtimeId, 'b');
  assert.equal(decision.routeRule?.index, 1);
  assert.ok(decision.reasons.includes('候选 1 未勾选为自动可选，跳过'));
  assert.match(decision.reasons.join('\n'), /候选 1 不可用.*已按勾选排除：a/);
  assert.throws(
    () => choose({ ...request, automaticExecutors: ['c'] }, snapshots),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.match(error.message, /已按勾选排除：a、b/);
      assert.match(error.message, /不自动改派/);
      return true;
    },
  );
  for (const pin of [{ runtimeId: 'a' }, { provider: 'grok' as const }]) {
    const pinned = choose({ ...request, ...pin }, snapshots);
    assert.equal(pinned.runtimeId, 'a');
    assert.equal(pinned.routeRule, undefined);
  }
  const global = { ...settings, excludedExecutors: ['a', 'c'] };
  assert.equal(route(input(), snapshots, global, new Set(), now).runtimeId, 'b');
  // A conversation's own checklist overrides the global exclusions.
  assert.equal(route({ ...input(), automaticExecutors: ['a'] }, snapshots, global, new Set(), now).runtimeId, 'a');
});
test('prefer falls back to automatic scoring only after exhausting the ordered candidates', () => {
  const decision = choose(input(rule({ strict: false })), [
    snapshot('a', 'grok', 100),
    snapshot('b', 'claude', 100),
    snapshot('c', 'codex'),
  ]);
  assert.equal(decision.runtimeId, 'c');
  assert.match(decision.reasons.join('\n'), /恢复自动选择/);
  assert.equal(decision.routeRule, undefined);
});
test('an explicit user pin beats strict adult routing and says why, without changing message permissions', () => {
  const routing: ConversationRouting = { ...set([rule()]), chapterAgents: false, mask: true };
  const message: MessageInput = {
    content: '写成人内容',
    runtimeId: 'c',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
  };
  assert.equal(routedMessage(message, routing, []), message);
  assert.equal(strictRoute(message, routing, []), undefined);
  const decision = choose({ ...input(), runtimeId: 'c' }, [snapshot('a', 'grok'), snapshot('c', 'codex')]);
  assert.equal(decision.runtimeId, 'c');
  assert.match(decision.reasons[0]!, /按你的指定交给 c.*规则里没有它/);
  assert.equal(
    strictRoute({ ...message, runtimeId: undefined }, routing, [{ id: 'a', label: 'A', provider: 'grok' }])?.runtimeId,
    'a',
  );
});
test('low-confidence strict is skipped, adult signals stay strict, and prefer remains a soft preference', () => {
  const category = { id: 'code', confidence: 'low' as const, reason: 'ambiguous' };
  assert.equal(matchRule([rule({ category: 'code' })], category), undefined);
  assert.ok(matchRule([rule()], { ...category, id: 'adult' }));
  const decision = choose({ ...input(rule({ category: 'code', strict: false })), category }, [
    snapshot('a', 'grok'),
    snapshot('b', 'claude'),
  ]);
  assert.equal(decision.runtimeId, 'a');
  assert.match(decision.reasons.join('\n'), /软偏好/);
  const skipped = choose({ ...input(rule({ category: 'code' })), category }, [snapshot('c', 'codex')]);
  assert.match(skipped.reasons.join('\n'), /不触发强制规则/);
});
test('provider candidates balance accounts and permit the Grok Cursor stand-in; runtime candidates stay bound', () => {
  const cursor = snapshot('cursor', 'cursor');
  cursor.models = [{ id: 'grok-4.7', label: 'Grok 4.7', efforts: ['high'] }];
  const native = snapshot('a', 'grok', 100);
  const request = input(rule({ candidates: [{ provider: 'grok' }] }));
  assert.equal(choose(request, [native, cursor]).runtimeId, 'cursor');
  assert.equal(choose(request, [native, snapshot('b', 'grok'), cursor]).runtimeId, 'b');
  assert.throws(
    () => choose(input(rule({ candidates: [{ runtimeId: 'a', provider: 'grok' }] })), [native, cursor]),
    RouteUnavailableError,
  );
});
test('rules never bypass tool-less/capability filters and candidate inputs touch only selection metadata', () => {
  const a = snapshot('a', 'grok');
  a.capabilities.toolless = false;
  const request = { ...input(), untrustedContent: true, permissionMode: 'read-only' as const };
  assert.equal(choose(request, [a, snapshot('b', 'claude')]).runtimeId, 'b');
  const candidates = candidateInputs(rule(), request);
  assert.equal(candidates[0]?.permissionMode, 'read-only');
  assert.equal(candidates[0]?.untrustedContent, true);
  assert.equal(candidates[0]?.routeRule?.derived, true);
});
test('scope replacement preserves other categories and cleared conversation rules override global rules', () => {
  const global = set([rule(), rule({ id: 'code', category: 'code' })]);
  const conversation = set([rule({ candidates: [] })]);
  const rules = effectiveRules(global, conversation);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.find((rule) => rule.category === 'adult')?.candidates, []);
  assert.equal(matchRule(rules, { id: 'adult', confidence: 'high', reason: '' }), undefined);
});
test('v1 migration keeps all selections, original words, masks and chapter flags, moves roles and is idempotent', () => {
  const legacy = {
    automaticExecutors: ['a'],
    text: 'original',
    updatedAt: iso(),
    chapterAgents: true,
    mask: true,
    rules: [
      {
        topic: 'adult' as const,
        target: { provider: 'grok' as const },
        strict: true,
        model: 'grok-4.7',
        effort: 'high',
      },
      { topic: 'other' as const, target: {}, strict: false },
      { topic: 'split' as const, target: { runtimeId: 'b' }, strict: false, model: 'fixture-model' },
      { topic: 'merge' as const, target: { provider: 'claude' as const }, strict: false },
    ],
  };
  const migrated = upgradeRouting(legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.text, legacy.text);
  assert.equal(migrated.updatedAt, legacy.updatedAt);
  assert.equal(migrated.mask, true);
  assert.deepEqual(migrated.automaticExecutors, ['a']);
  assert.equal(migrated.chapterAgents, true);
  assert.deepEqual(migrated.rules[0]?.candidates, [{ provider: 'grok', model: 'grok-4.7', effort: 'high' }]);
  assert.deepEqual(migrated.rules[1]?.candidates, [{}]);
  assert.deepEqual(migrated.roles, {
    coordinator: { runtimeId: 'b', model: 'fixture-model' },
    merger: { provider: 'claude' },
  });
  assert.equal(upgradeRouting(migrated), migrated);
  assert.equal('version' in legacy, false);
});

test('global rule settings validate v2 and reject legacy route policy and duplicate rules', () => {
  const value = { ...set([rule()]), updatedAt: '2026-10-12T00:00:00Z' };
  assert.deepEqual(routingRuleSetSchema.parse(value), value);
  assert.equal(routingRuleSetSchema.safeParse({ ...value, routePolicy: { routine: 'claude' } }).success, false);
  assert.equal(routingRuleSetSchema.safeParse({ ...value, version: 1 }).success, false);
  assert.equal(routingRuleSetSchema.safeParse({ ...value, rules: [rule(), rule()] }).success, false);
});

test('a strict rule for an uninstalled provider falls back to the installed card', () => {
  const request = input(rule({ category: 'code', candidates: [{ provider: 'claude' }], strict: true }));
  const decision = choose(request, [snapshot('codex', 'codex')]);
  assert.equal(decision.runtimeId, 'codex');
  assert.match(decision.reasons.join('\n'), /\u672a\u5b89\u88c5/);
});
