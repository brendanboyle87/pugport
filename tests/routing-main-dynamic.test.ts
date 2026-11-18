import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaPoolKey, route, type RouteCapacity } from '../src/server/routing.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { burnKey } from '../src/server/quota-history.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-27T01:00:00Z');
const hour = 3_600_000;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: false,
  routePreferencesEnabled: false,
  routeGoal: 'balanced',
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'cursor',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'synthetic',
  maxConcurrentRuns: 8,
};
const input: RunInput = {
  prompt: 'Evaluate the project requirements',
  kind: 'general',
  projectPath: 'synthetic',
  suggestedTier: 'strong',
  suggestedEffort: 'high',
};
function runtime(
  id: string,
  provider: RuntimeSnapshot['provider'],
  left: number,
  reset = 7 * 24 * hour,
): RuntimeSnapshot {
  const model = provider === 'claude' ? 'claude-opus-4-6' : 'gpt-6-astra';
  return {
    id,
    provider,
    label: id,
    accountFingerprint: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: model, label: model, efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: iso(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 100 - left, resetsAt: iso(reset) }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(),
    ...(provider === 'pi' ? { gateway: 'api', apiProvider: id } : {}),
  };
}
const capacity = (patch: Partial<RouteCapacity> = {}): RouteCapacity => ({
  reservations: new Map(),
  settlingPools: new Set(),
  ...patch,
});
const choose = (sources: RuntimeSnapshot[], cap = capacity(), patch: Partial<RunInput> = {}, config = settings) =>
  route({ ...input, ...patch }, sources, config, cap, now);

test('strong main tasks prefer Codex over Claude while quota remains usable', () => {
  const a = runtime('claude-a', 'claude', 50);
  const b = runtime('codex-b', 'codex', 90);
  assert.equal(choose([a, b]).runtimeId, b.id);
  assert.equal(choose([b, a]).runtimeId, b.id);
  b.quota.windows[0]!.usedPercent = 80;
  assert.equal(choose([a, b]).runtimeId, b.id);
});

test('new main tasks prefer idle same-tier accounts before reset urgency or more remaining quota', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const busy = runtime('claude-busy', 'claude', 90, 0.5 * hour);
    const idle = runtime(`${provider}-idle`, provider, 40);
    const cap = capacity({ reservations: new Map([[quotaPoolKey(busy), 2]]) });
    assert.equal(choose([busy, idle], cap).runtimeId, idle.id);
    assert.match(choose([busy, idle], cap).reasons.join('\n'), /新任务.*负载.*额度/);
  }
});

test('lightweight new tasks prefer the idle Claude account when no free source is enabled for routing', () => {
  const busy = runtime('claude-busy', 'claude', 90, 0.5 * hour);
  const idle = runtime('claude-idle', 'claude', 40);
  const cap = capacity({ reservations: new Map([[quotaPoolKey(busy), 2]]) });
  const free = runtime('free-api', 'pi', 80);
  const patch = { automaticExecutors: [busy.id, idle.id] };
  for (const sources of [
    [busy, idle],
    [busy, idle, { ...free, costTier: 'free' as const }],
    [busy, idle, { ...free, apiProvider: 'ollama' }],
  ]) {
    const decision = choose(sources, cap, patch, { ...settings, routeGoal: 'save' });
    assert.equal(decision.runtimeId, idle.id);
    assert.match(decision.reasons.join('\n'), /新任务.*负载.*额度/);
  }
});

test('requested capability remains ahead of main-task load balancing', () => {
  const strong = runtime('codex-strong', 'codex', 80);
  const standard = runtime('claude-standard', 'claude', 90);
  standard.models = [{ id: 'claude-sonnet-4-6', label: 'Sonnet', efforts: ['medium', 'high'] }];
  const cap = capacity({ reservations: new Map([[quotaPoolKey(strong), 2]]) });
  assert.equal(choose([standard, strong], cap).runtimeId, strong.id);
});

test('strong main tasks prefer Codex before quota approaching reset', () => {
  const soon = runtime('claude-soon', 'claude', 30, 0.5 * hour);
  const later = runtime('codex-later', 'codex', 90);
  assert.equal(choose([soon, later]).runtimeId, later.id);
});

test('near-reset priority requires quota above the reserve in that window, not another window', () => {
  const soon = runtime('claude-soon', 'claude', 90);
  const healthy = runtime('claude-healthy', 'claude', 80);
  soon.quota.windows.push({
    id: 'five_hour',
    label: '5 hours',
    usedPercent: 96,
    resetsAt: iso(0.5 * hour),
    durationMinutes: 300,
  });
  const burn = new Map([
    [burnKey(soon.id, 'five_hour'), { account: '', perHour: 20, periods: 3 }],
    [burnKey(soon.id, 'week'), { account: '', perHour: 10, periods: 3 }],
    [burnKey(healthy.id, 'week'), { account: '', perHour: 10, periods: 3 }],
  ]);
  const patch: Partial<RunInput> = {
    suggestedTier: 'standard',
    suggestedEffort: 'medium',
    schedule: { estimatedMinutes: 5 },
  };
  const pick = () => choose([soon, healthy], capacity({ burn }), patch);
  assert.equal(pick().runtimeId, healthy.id, '4% is usable for short work, but is not a reset opportunity');
  assert.doesNotMatch(pick().reasons.join('\n'), /近期机会窗口内/);
  burn.clear();
  for (const left of [4, 10, 11, 30]) {
    soon.quota.windows[1]!.usedPercent = 100 - left;
    assert.equal(
      pick().runtimeId,
      left > settings.reservePercent ? soon.id : healthy.id,
      `${left}% with no burn history`,
    );
  }
  soon.quota.windows[1]!.usedPercent = 70;
  assert.equal(pick().runtimeId, soon.id, 'unused short-window quota still gets a reset opportunity');
  assert.match(pick().reasons.join('\n'), /近期机会窗口内/);
  soon.quota.windows[1]!.usedPercent = 96;
  burn.set(burnKey(soon.id, 'week'), { account: '', perHour: 0.5, periods: 3 });
  // Keep unrelated weekly waste below the normal waste-ranking threshold.
  assert.equal(pick().runtimeId, healthy.id, 'weekly waste must not validate an exhausted short-window opportunity');
  burn.clear();
  soon.quota.windows[0]!.resetsAt = iso((2 / 3) * hour);
  const laterHealthyWindow = pick();
  assert.equal(laterHealthyWindow.runtimeId, soon.id);
  const opportunity = laterHealthyWindow.reasons.find((reason) => reason.includes('近期机会窗口内'));
  assert.ok(
    opportunity?.includes(iso((2 / 3) * hour)),
    'a scarce earlier window must not hide a healthy later opportunity',
  );
  assert.ok(!opportunity?.includes(iso(0.5 * hour)), 'the scarce window itself remains ineligible');
});

test('valid native continuation stays ahead of another account or platform approaching reset', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const current = runtime('claude-existing', 'claude', 70);
    const other = runtime(`${provider}-soon`, provider, 90, 0.5 * hour);
    const cap = capacity({ continuing: [{ runtimeId: current.id, accountFingerprint: current.accountFingerprint }] });
    const picked = choose([other, current], cap, { continuationRunId: 'prior' });
    assert.equal(picked.runtimeId, current.id);
    assert.match(picked.reasons.join('\n'), /续接本对话的原生会话/);
  }
});

test('continuation cannot bypass quota exhaustion or changed account identity', () => {
  const current = runtime('claude-existing', 'claude', 0, 0.5 * hour);
  const other = runtime('codex-other', 'codex', 90);
  const cap = capacity({ continuing: [{ runtimeId: current.id, accountFingerprint: current.accountFingerprint }] });
  assert.equal(choose([current, other], cap, { continuationRunId: 'prior' }).runtimeId, other.id);
  current.quota.windows[0]!.usedPercent = 30;
  current.quota.windows[0]!.resetsAt = iso(7 * 24 * hour);
  current.accountFingerprint = 'changed-login';
  assert.equal(choose([current, other], cap, { continuationRunId: 'prior' }).runtimeId, other.id);
});

test('manual choices and enabled platform preferences keep their priority', () => {
  const a = runtime('claude-a', 'claude', 50);
  const b = runtime('codex-b', 'codex', 90);
  const cap = capacity({ reservations: new Map([[quotaPoolKey(a), 1]]) });
  for (const pin of [
    { runtimeId: a.id },
    { provider: 'claude' as const },
    { model: a.models[0]!.id },
    {
      confirmedRoute: { runtimeId: a.id, model: a.models[0]!.id, effort: 'high' },
      runtimeId: a.id,
    },
  ])
    assert.equal(choose([a, b], cap, pin).runtimeId, a.id);
  assert.equal(
    choose(
      [a, b],
      cap,
      {},
      {
        ...settings,
        routePreferencesEnabled: true,
        routePolicy: { general: ['claude'] },
      },
    ).runtimeId,
    a.id,
  );
  assert.equal(
    choose([a, b], cap, {
      category: { id: 'research', confidence: 'high', reason: 'fixture' },
      routingRules: {
        version: 2,
        text: '',
        unparsed: [],
        updatedAt: iso(),
        rules: [
          {
            id: 'research',
            category: 'research',
            enabled: true,
            strict: true,
            source: 'manual',
            candidates: [{ runtimeId: a.id }],
          },
        ],
      },
    }).runtimeId,
    a.id,
  );
});

test('CLI-first and lightweight policies are not displaced by idle API capacity', () => {
  const cli = runtime('claude-cli', 'claude', 50);
  const api = runtime('paid-api', 'pi', 90);
  const cap = capacity({ reservations: new Map([[quotaPoolKey(cli), 1]]) });
  assert.equal(choose([cli, api], cap, { executionPolicy: 'cli-first' }).runtimeId, cli.id);
  assert.equal(choose([cli, api], cap, {}, { ...settings, routeGoal: 'save' }).runtimeId, cli.id);
  cli.models = [{ id: 'claude-sonnet-4-6', label: 'Sonnet', efforts: ['medium', 'high'] }];
  assert.equal(choose([cli, api], cap, { executionPolicy: 'cli-first' }).runtimeId, cli.id);
});

test('tier, continuation and expiry ordering stays consistent across all three-candidate permutations', () => {
  const current = runtime('claude-existing', 'claude', 40);
  current.models = [{ id: 'claude-sonnet-4-6', label: 'Sonnet', efforts: ['medium', 'high'] }];
  const sameTier = runtime('api-standard', 'pi', 90);
  const otherTier = runtime('api-strong', 'pi', 90);
  sameTier.models = [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['medium', 'high'], price: { input: 1, output: 2 } }];
  otherTier.models[0]!.price = { input: 1, output: 2 };
  for (const [source, expires] of [
    [sameTier, 12 * hour],
    [otherTier, 48 * hour],
  ] as const)
    source.apiBudgetState = apiBudgetView(
      apiBudgetPolicy({ limitUsd: 20, expiresAt: iso(expires) }, undefined, iso(-10 * 24 * hour)),
      0,
      0,
      0,
      now,
    );
  const cap = capacity({ continuing: [{ runtimeId: current.id, accountFingerprint: current.accountFingerprint }] });
  const all = [current, sameTier, otherTier];
  for (const a of all)
    for (const b of all.filter((item) => item !== a)) {
      const c = all.find((item) => item !== a && item !== b)!;
      assert.equal(
        choose([a, b, c], cap, { suggestedTier: 'standard', continuationRunId: 'prior' }).runtimeId,
        current.id,
      );
    }
});

test('existing measured first-response evidence precedes quota only for eligible short chats', () => {
  const slow = runtime('claude-slow', 'claude', 90);
  const fast = runtime('codex-fast', 'codex', 50);
  const sources = [slow, fast];
  const cap = capacity({
    responseLatencyKeys: new Map(sources.map((s) => [s.id, s.id])),
    responseLatencySamples: sources.flatMap((s) =>
      [1, 2].map((n) => ({
        runId: `${s.id}-${n}`,
        runtimeId: s.id,
        key: s.id,
        model: s.models[0]!.id,
        effort: 'high',
        sessionMode: 'new' as const,
        observedAt: iso(-n),
        firstTextMs: s === fast ? 2000 : 20000,
      })),
    ),
  });
  assert.equal(choose(sources, cap, { latencySensitiveChat: true }).runtimeId, fast.id);
  assert.equal(choose(sources, cap).runtimeId, fast.id);
});
