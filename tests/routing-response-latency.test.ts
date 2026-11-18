import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { quotaPoolKey, route, type RouteCapacity } from '../src/server/routing.ts';
import type { ResponseLatencySample } from '../src/server/response-latency.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-23T12:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: false,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'cursor',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/synthetic',
  maxConcurrentRuns: 4,
};
const input: RunInput = {
  prompt: '你好',
  projectPath: settings.defaultProjectPath,
  kind: 'auto',
  latencySensitiveChat: true,
  schedule: { preferExpiringQuota: false },
};
function runtime(id: string, provider: RuntimeSnapshot['provider'], used = 20): RuntimeSnapshot {
  return {
    id,
    provider,
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: iso(),
      windows: [{ id: 'week', label: 'Week', usedPercent: used, resetsAt: iso(7 * 86_400_000) }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(),
    ...(provider === 'pi' ? { gateway: 'api' as const, apiProvider: id } : {}),
  };
}
function capacity(runtimes: RuntimeSnapshot[], timings: Record<string, number>): RouteCapacity {
  const responseLatencySamples: ResponseLatencySample[] = runtimes.flatMap((target) =>
    timings[target.id] === undefined
      ? []
      : Array.from({ length: 3 }, (_, index) => ({
          runId: `${target.id}-${index}`,
          runtimeId: target.id,
          key: `key-${target.id}`,
          model: target.models[0]!.id,
          effort: 'low',
          sessionMode: 'new' as const,
          firstTextMs: timings[target.id]!,
          observedAt: iso(-index - 1),
        })),
  );
  return {
    reservations: new Map(),
    settlingPools: new Set(),
    responseLatencySamples,
    responseLatencyKeys: new Map(runtimes.map((target) => [target.id, `key-${target.id}`])),
  };
}
const choose = (runtimes: RuntimeSnapshot[], cap: RouteCapacity, patch: Partial<RunInput> = {}, config = settings) =>
  route({ ...input, ...patch }, runtimes, config, cap, now);

test('measured first response beats default provider and ordinary quota preferences for automatic short chats', () => {
  const cursor = runtime('cursor-native', 'cursor', 10);
  const codex = runtime('codex-native', 'codex', 50);
  const pair = [cursor, codex];
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 4_000 });
  assert.equal(choose(pair, cap).runtimeId, codex.id);
  assert.equal(
    choose(pair, cap, {}, { ...settings, routePreferencesEnabled: true, routePolicy: { routine: ['cursor', 'codex'] } })
      .runtimeId,
    codex.id,
  );
  assert.equal(choose(pair, cap, { effort: 'medium' }).runtimeId, codex.id, 'effort alone is not an executor pin');
  assert.match(choose(pair, cap).reasons.join('\n'), /同模型.*首轮简短对话/);
  assert.equal(
    choose(pair, cap, { latencySensitiveChat: false }, { ...settings, routePreferencesEnabled: true }).runtimeId,
    cursor.id,
  );
});

test('connected API targets use their own observations while explicit transport policies still win', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const api = runtime('new-api-connection', 'pi');
  const otherApi = runtime('other-api-connection', 'pi');
  const pair = [cursor, api, otherApi];
  const cap = capacity(pair, { [cursor.id]: 18_000, [api.id]: 2_000, [otherApi.id]: 12_000 });
  const automatic = choose(pair, cap);
  assert.equal(automatic.runtimeId, cursor.id);
  assert.match(automatic.reasons.join('\n'), /按次计费的 API 卡默认不参与自动选择/);
  assert.equal(choose(pair, cap, { executionPolicy: 'cli-first' }).runtimeId, cursor.id);
  assert.equal(choose(pair, cap, { executionPolicy: 'cli-only' }).runtimeId, cursor.id);
  assert.equal(choose(pair, cap, { executionPolicy: 'api-only' }).runtimeId, api.id);
  cap.responseLatencySamples = capacity(pair, {
    [cursor.id]: 2_000,
    [api.id]: 18_000,
    [otherApi.id]: 2_000,
  }).responseLatencySamples;
  assert.equal(
    choose(pair, cap, { executionPolicy: 'api-only' }).runtimeId,
    otherApi.id,
    'each API connection uses its own observations after paid APIs are explicitly enabled',
  );
  assert.equal(choose(pair, cap).runtimeId, cursor.id, 'API is not permanently ranked first');
});

test('new CLI target IDs participate without a provider-specific speed branch', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const fresh = runtime('future-cli-installation', 'grok');
  const pair = [cursor, fresh];
  assert.equal(choose(pair, capacity(pair, { [cursor.id]: 18_000, [fresh.id]: 2_000 })).runtimeId, fresh.id);
});

test('pins and explicit rule candidate order remain authoritative despite slow measurements', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  const pair = [cursor, codex];
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  for (const patch of [{ runtimeId: cursor.id }, { provider: 'cursor' as const }, { model: 'gpt-6-luna' }])
    assert.equal(choose(pair, cap, patch, { ...settings, routePreferencesEnabled: true }).runtimeId, cursor.id);
  for (const strict of [false, true])
    assert.equal(
      choose(pair, cap, {
        category: { id: 'other', confidence: 'high', reason: 'synthetic' },
        routingRules: {
          version: 2,
          text: '',
          unparsed: [],
          updatedAt: iso(),
          rules: [
            {
              id: 'ordered',
              category: 'other',
              enabled: true,
              strict,
              source: 'manual',
              candidates: [{ runtimeId: cursor.id }, { runtimeId: codex.id }],
            },
          ],
        },
      }).runtimeId,
      cursor.id,
    );
  assert.equal(
    choose(pair, cap, {}, { ...settings, routePreferencesEnabled: true, routePolicy: { routine: ['cursor'] } })
      .runtimeId,
    cursor.id,
    'a named category platform is still preferred over an unlisted faster platform',
  );
});

test('new-session measurements do not move native continuations or consume resume-only observations', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  const pair = [cursor, codex];
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  cap.continuing = [{ runtimeId: cursor.id }];
  assert.equal(choose(pair, cap, { continuationRunId: 'synthetic-prior' }).runtimeId, cursor.id);
  assert.equal(
    choose(pair, cap, { resumeRunId: 'synthetic-prior' }, { ...settings, routePreferencesEnabled: true }).runtimeId,
    cursor.id,
  );
  cap.responseLatencySamples = cap.responseLatencySamples!.map((sample) => ({ ...sample, sessionMode: 'resume' }));
  assert.equal(choose(pair, cap, {}, { ...settings, routePreferencesEnabled: true }).runtimeId, cursor.id);
});

test('latency does not weaken reserve, settlement, capability or quota freshness', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  const pair = [cursor, codex];
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  const mutations: Array<(target: RuntimeSnapshot, state: RouteCapacity) => void> = [
    (target) => {
      target.quota.windows[0]!.usedPercent = 90;
    },
    (target) => {
      target.quota.observedAt = iso(-180_000);
    },
    (target) => {
      target.capabilities.execute = false;
    },
    (target, state) => {
      state.settlingPools = new Set([quotaPoolKey(target)]);
    },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(codex);
    const state = { ...cap };
    mutate(altered, state);
    assert.equal(choose([cursor, altered], state).runtimeId, cursor.id);
  }
});

test('near reset remains ahead of speed', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  const pair = [cursor, codex];
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  cursor.quota.windows[0]!.resetsAt = iso(30 * 60_000);
  assert.equal(choose(pair, cap, { schedule: { preferExpiringQuota: true } }).runtimeId, cursor.id);
});

test('API expiry and predicted credit waste remain ahead of speed, while exhausted budgets still block', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const api = runtime('api-credit', 'pi');
  api.models[0]!.price = { input: 1, output: 2 };
  api.accounting = { mode: 'usage', source: 'synthetic' };
  api.quota = { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] };
  const budget = (expiresIn: number, spent = 0) =>
    apiBudgetView(
      apiBudgetPolicy({ limitUsd: 200, expiresAt: iso(expiresIn) }, undefined, iso(-10 * 86_400_000)),
      spent,
      0,
      0,
      now,
    );
  const pair = [cursor, api];
  let cap = capacity(pair, { [cursor.id]: 2_000, [api.id]: 18_000 });
  api.apiBudgetState = budget(12 * 3_600_000);
  assert.equal(
    choose(pair, cap, { schedule: { preferExpiringQuota: true }, executionPolicy: 'cli-first' }).runtimeId,
    api.id,
    'final expiry priority is stronger than CLI-first and latency',
  );
  api.apiBudgetState = budget(24 * 86_400_000, 5);
  const payg = runtime('api-payg', 'pi');
  payg.models[0]!.price = { input: 1, output: 2 };
  payg.accounting = { mode: 'usage', source: 'synthetic' };
  payg.quota = { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] };
  cap = capacity([api, payg], { [api.id]: 18_000, [payg.id]: 2_000 });
  assert.equal(
    choose([api, payg], cap, { executionPolicy: 'api-only' }).runtimeId,
    payg.id,
    'credit outside fourteen days takes no automatic work',
  );
  api.apiBudgetState = budget(10 * 86_400_000, 5);
  assert.equal(
    choose([api, payg], cap, { schedule: { preferExpiringQuota: true }, executionPolicy: 'api-only' }).runtimeId,
    api.id,
    'predicted expiring credit waste remains ahead of speed',
  );
  api.apiBudgetState = budget(24 * 86_400_000, 200);
  assert.equal(
    choose([api, payg], capacity([api, payg], { [api.id]: 2_000, [payg.id]: 18_000 }), {
      executionPolicy: 'api-only',
    }).runtimeId,
    payg.id,
  );
});

test('save mode keeps its cost ordering ahead of a faster paid API', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const api = runtime('new-api-connection', 'pi');
  const pair = [cursor, api];
  assert.equal(
    choose(pair, capacity(pair, { [cursor.id]: 18_000, [api.id]: 2_000 }), {}, { ...settings, routeGoal: 'save' })
      .runtimeId,
    cursor.id,
  );
});

test('quality target keeps a strong model ahead of a faster light-only platform', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  cursor.models = [{ id: 'claude-opus-5', label: 'Opus', efforts: ['low', 'medium', 'high'] }];
  const pair = [cursor, codex];
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  cap.responseLatencySamples = cap.responseLatencySamples!.map((sample) => ({ ...sample, effort: 'high' }));
  const selected = choose(pair, cap, {}, { ...settings, routeGoal: 'quality' });
  assert.equal(selected.runtimeId, cursor.id);
  assert.equal(selected.model, 'claude-opus-5');
  assert.equal(selected.effort, 'high');
  assert.equal(
    choose(pair, cap, { prompt: 'Review authentication concurrency', kind: 'architecture' }).runtimeId,
    cursor.id,
  );
});

test('unknown and stale observations keep deterministic neutral buckets across input permutations', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  const unknown = runtime('new-gemini', 'gemini');
  const all = [cursor, codex, unknown];
  const cap = capacity(all, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  for (const order of [all, [...all].reverse(), [unknown, cursor, codex], [codex, unknown, cursor]])
    assert.equal(choose(order, cap).runtimeId, codex.id);
  assert.equal(choose(all, capacity(all, {}), {}, { ...settings, routePreferencesEnabled: true }).runtimeId, cursor.id);
  cap.responseLatencySamples = cap.responseLatencySamples!.map((sample) => ({
    ...sample,
    observedAt: iso(-8 * 86_400_000),
  }));
  assert.equal(choose(all, cap, {}, { ...settings, routePreferencesEnabled: true }).runtimeId, cursor.id);
});

test('two-second buckets preserve existing tie breaks and runtime fallback is described honestly', () => {
  const cursor = runtime('cursor-native', 'cursor');
  const codex = runtime('codex-native', 'codex');
  const pair = [cursor, codex];
  assert.equal(
    choose(
      pair,
      capacity(pair, { [cursor.id]: 3_900, [codex.id]: 2_100 }),
      {},
      { ...settings, routePreferencesEnabled: true },
    ).runtimeId,
    cursor.id,
  );
  const cap = capacity(pair, { [cursor.id]: 18_000, [codex.id]: 2_000 });
  cap.responseLatencySamples = cap.responseLatencySamples!.map((sample) => ({ ...sample, model: 'other-model' }));
  const selected = choose(pair, cap);
  assert.equal(selected.runtimeId, codex.id);
  assert.match(selected.reasons.join('\n'), /执行器回退估计.*并非同模型实测/);
});

test('same-platform account selection keeps existing quota allocation rather than chasing speed', () => {
  const fuller = runtime('codex-fuller', 'codex', 10);
  const faster = runtime('codex-faster', 'codex', 60);
  const pair = [fuller, faster];
  assert.equal(choose(pair, capacity(pair, { [fuller.id]: 18_000, [faster.id]: 2_000 })).runtimeId, fuller.id);
});
