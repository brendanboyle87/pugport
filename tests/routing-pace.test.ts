import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaPoolKey, route, RouteUnavailableError, type RouteCapacity } from '../src/server/routing.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { burnKey } from '../src/server/quota-history.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-27T18:00:00Z');
const hour = 3_600_000;
const week = 7 * 24 * hour;
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

/** A weekly window whose ideal remaining share is `ideal` percent, with `pace × ideal` percent left. */
function account(
  id: string,
  provider: 'claude' | 'codex',
  pace: number,
  ideal = 80,
  patch: Partial<RuntimeSnapshot> = {},
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
      windows: [
        {
          id: 'weekly',
          label: 'Weekly',
          durationMinutes: 10080,
          usedPercent: 100 - pace * ideal,
          resetsAt: iso((ideal / 100) * week),
        },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(),
    ...patch,
  };
}
const capacity = (patch: Partial<RouteCapacity> = {}): RouteCapacity => ({
  reservations: new Map(),
  settlingPools: new Set(),
  ...patch,
});
const choose = (sources: RuntimeSnapshot[], cap = capacity(), patch: Partial<RunInput> = {}) =>
  route({ ...input, ...patch }, sources, settings, cap, now);
const orders = <T>(items: T[]) => [items, [...items].reverse()];

test('the on-pace account goes first; ahead accounts are used only when no same-tier account is on pace', () => {
  const slow = account('codex-a', 'codex', 0.5);
  const mid = account('codex-b', 'codex', 0.8);
  const behind = account('codex-c', 'codex', 1.2);
  for (const sources of orders([slow, mid, behind])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, behind.id);
    assert.ok(
      picked.reasons.some((reason) => reason.startsWith('codex-c 周额度') && reason.includes('用不掉')),
      picked.reasons.join('\n'),
    );
  }
  for (const sources of orders([slow, mid])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, mid.id);
    assert.match(picked.reasons.join('\n'), /同档账号额度都超前，codex-b 周额度超前（剩 64%，按进度应剩 80%）/);
  }
});

test('a continued session stays unless it is clearly ahead and a same-tier account is on pace', () => {
  const alternative = account('codex-c', 'codex', 1.2);
  for (const [pace, stays] of [
    [0.8, true],
    [0.6, false],
  ] as const) {
    const current = account('codex-current', 'codex', pace);
    const cap = capacity({ continuing: [{ runtimeId: current.id, accountFingerprint: current.accountFingerprint }] });
    for (const sources of orders([current, alternative])) {
      const picked = choose(sources, cap, { continuationRunId: 'prior' });
      assert.equal(picked.runtimeId, stays ? current.id : alternative.id);
      if (!stays) assert.match(picked.reasons.join('\n'), /codex-current 周额度超前.*本轮换到同档进度正常的 codex-c/);
    }
  }
});

const cards = (count: number, expiresIn: number): NonNullable<RuntimeSnapshot['quota']['resetCredits']> => ({
  availableCount: count,
  source: 'synthetic',
  observedAt: iso(),
  details: Array.from({ length: count }, (_, index) => ({
    key: String(index).repeat(64),
    kind: 'full' as const,
    status: 'available' as const,
    grantedAt: null,
    expiresAt: iso(expiresIn),
  })),
});

test('an available reset card doubles the capacity the pace is measured against', () => {
  const carded = account('codex-cards', 'codex', 0.5);
  const other = account('codex-plain', 'codex', 0.6);
  // Without the card: 40% left of 80% ideal (0.5) loses to 0.6.
  assert.equal(choose([carded, other]).runtimeId, other.id);
  // The card outlasts the window, so the window's reset stays the deadline.
  carded.quota.resetCredits = cards(1, 10 * 24 * hour);
  // With it: (40 + 100) ÷ (80 × 2) ≈ 0.88.
  for (const sources of orders([carded, other])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, carded.id);
    assert.ok(
      picked.reasons.includes(
        '同档账号额度都超前，codex-cards 周额度超前（剩 140%，含 1 张重置卡，按进度应剩 160%），超前最少，先用它',
      ),
    );
  }
});

test('strong work goes to an on-pace Claude account before ahead-of-plan Codex accounts', () => {
  const codex = [
    account('codex-a', 'codex', 0.51),
    account('codex-b', 'codex', 0.8),
    account('codex-c', 'codex', 0.88),
  ];
  const claude = account('claude-work', 'claude', 1.15, 43);
  for (const sources of orders([...codex, claude])) assert.equal(choose(sources).runtimeId, claude.id);
});

test('close paces compare plan capacity; a plan without a multiplier counts as one', () => {
  const plan = (label: string) => ({ subscription: { label, source: 'synthetic', observedAt: iso() } });
  const max = account('claude-max', 'claude', 1.1, 40, plan('Max (20x)'));
  const pro = account('claude-pro', 'claude', 1.2, 40, plan('Pro'));
  for (const sources of orders([max, pro])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, max.id);
    assert.ok(
      picked.reasons.includes(
        '进度相近，按套餐容量（倍数 × 剩余）先用 claude-max；claude-pro 套餐名里没有倍数，按 1 倍算',
      ),
      picked.reasons.join('\n'),
    );
  }
  // Since the 2026-10-31 rename Claude's plan names carry no multiplier: Ultra (old Max 20x) still outranks Pro.
  const ultra = account('claude-ultra', 'claude', 1.1, 40, plan('Ultra'));
  for (const sources of orders([ultra, pro])) assert.equal(choose(sources).runtimeId, ultra.id);
  // Far apart, pace wins over plan size.
  max.quota.windows[0]!.usedPercent = 100 - 0.8 * 40;
  assert.equal(choose([max, pro]).runtimeId, pro.id);
});

test('reset cards that expire before the window resets are spent by their expiry first', () => {
  const day = 24 * hour;
  const window = (used: number, minutes: number, resetIn: number) => [
    { id: 'weekly', label: 'Weekly', durationMinutes: minutes, usedPercent: used, resetsAt: iso(resetIn) },
  ];
  const named = (id: string, label: string, used: number, minutes: number, resetIn: number) => {
    const value = account(id, 'codex', 1, 80, { label });
    value.quota.windows = window(used, minutes, resetIn);
    return value;
  };
  // 40% + 2 cards expiring in 3 days: (40 + 200) ÷ (300 × 3/7) ≈ 1.9.
  const local = named('codex-native', 'Codex·本机', 60, 10080, 131 * hour);
  local.quota.resetCredits = cards(2, 3 * day);
  // A 30-day window with 87% + 2 cards expiring in 2 days: 287 ÷ (300 × 2/30) ≈ 14.
  const plus = named('codex-b', 'Codex B', 13, 43200, 0.99 * 30 * day);
  plus.quota.resetCredits = cards(2, 2 * day);
  // 62% with no cards: 62 ÷ 78 ≈ 0.8.
  const work = named('codex-work', 'Codex Work', 38, 10080, 131 * hour);
  for (const sources of orders([work, local, plus])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, plus.id);
    assert.ok(
      picked.reasons.includes('Codex B 有 2 张重置卡（截至后天到期），按平时用量到时还用不上，先多用它'),
      picked.reasons.join('\n'),
    );
  }
  for (const sources of orders([work, local])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, local.id);
    assert.ok(
      picked.reasons.includes('Codex·本机 有 2 张重置卡（截至3 天后到期），按平时用量到时还用不上，先多用它'),
      picked.reasons.join('\n'),
    );
  }
  assert.equal(choose([work]).runtimeId, work.id);
});

test('a Plus account with expiring cards takes the standard work its models can do, never strong work', () => {
  const day = 24 * hour;
  const plus = account('codex-b', 'codex', 1, 80, {
    label: 'Codex B',
    models: [
      { id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'medium'] },
      { id: 'gpt-5.6-terra', label: 'Terra 5.6', efforts: ['low', 'medium', 'high'] },
      { id: 'gpt-5.6-luna', label: 'Luna 5.6', efforts: ['low', 'medium'] },
    ],
  });
  plus.quota.windows = [
    { id: 'monthly', label: 'Monthly', durationMinutes: 43200, usedPercent: 13, resetsAt: iso(0.99 * 30 * day) },
  ];
  plus.quota.resetCredits = cards(2, 2 * day);
  const pro = (id: string, used: number) => {
    const value = account(id, 'codex', 1, 80, {
      models: [
        { id: 'gpt-6-astra', label: 'Astra', efforts: ['low', 'medium', 'high'] },
        { id: 'gpt-6.1-sol', label: 'Sol 6.1', efforts: ['low', 'medium', 'high'] },
      ],
    });
    value.quota.windows[0]!.usedPercent = used;
    return value;
  };
  const others = [pro('codex-work', 38), pro('codex-native', 60)];
  for (const sources of orders([...others, plus])) {
    const standard = choose(sources, capacity(), { suggestedTier: 'standard', suggestedEffort: 'medium' });
    assert.equal(standard.runtimeId, plus.id);
    assert.equal(standard.model, 'gpt-5.6-terra');
    assert.notEqual(choose(sources).runtimeId, plus.id);
  }
});

test('three nearby paces choose the same account for every candidate order', () => {
  const plan = (label: string) => ({ subscription: { label, source: 'synthetic', observedAt: iso() } });
  const a = account('codex-a', 'codex', 1, 40, plan('Plan (3x)'));
  const b = account('codex-b', 'codex', 1.2, 40, plan('Plan (2x)'));
  const c = account('codex-c', 'codex', 1.44, 40, plan('Plan (1x)'));
  for (const sources of [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ])
    assert.equal(choose(sources).runtimeId, c.id);
});

test('plan multipliers only compare plans of one platform', () => {
  // Regression: a 20x plan nearly out of its week beat a much fuller card of another platform on the multiplier.
  const max = account('claude-max', 'claude', 4 / 6, 6, {
    subscription: { label: 'Max (20x)', source: 'synthetic', observedAt: iso() },
  });
  const codex = account('codex-pro', 'codex', 55 / 75, 75);
  for (const sources of orders([max, codex])) {
    const picked = choose(sources);
    assert.equal(picked.runtimeId, codex.id);
    assert.ok(!picked.reasons.some((reason) => reason.includes('套餐容量')), picked.reasons.join('\n'));
  }
});

test('a warm large context keeps its session; a cold or small one can move to an on-pace account', () => {
  const alternative = account('codex-c', 'codex', 1.2);
  const current = account('codex-current', 'codex', 0.6);
  const cap = capacity({ continuing: [{ runtimeId: current.id, accountFingerprint: current.accountFingerprint }] });
  const minute = 60_000;
  const follow = (tokens: number, endedAgo: number, continuationNewTask = false) =>
    choose([current, alternative], cap, {
      continuationRunId: 'prior',
      continuationNewTask,
      continuationContext: { tokens, endedAt: new Date(now - endedAgo).toISOString() },
    });
  const warmLarge = follow(380_000, minute);
  assert.equal(warmLarge.runtimeId, current.id);
  assert.match(warmLarge.reasons.join('\n'), /为缓存留在原卡.*上下文约 38 万 token/);
  // Cache expired: a switch costs the same everywhere, so pace decides.
  const cold = follow(380_000, 10 * minute);
  assert.equal(cold.runtimeId, alternative.id);
  // A small context in a new task moves even when only slightly ahead.
  const slight = account('codex-current', 'codex', 0.9);
  assert.equal(
    choose([slight, alternative], cap, {
      continuationRunId: 'prior',
      continuationNewTask: true,
      continuationContext: { tokens: 20_000, endedAt: new Date(now - minute).toISOString() },
    }).runtimeId,
    alternative.id,
  );
  // A medium context moves only when clearly ahead, and says what the switch re-reads.
  const medium = follow(100_000, minute);
  assert.equal(medium.runtimeId, alternative.id);
  assert.match(medium.reasons.join('\n'), /换卡要重读约 10 万 token/);
});

test('the session card settling its last run is waited for instead of switched away from', () => {
  const current = account('codex-current', 'codex', 1.2);
  const other = account('codex-other', 'codex', 1.1);
  const pool = quotaPoolKey(current);
  const cap = capacity({
    continuing: [{ runtimeId: current.id, accountFingerprint: current.accountFingerprint }],
    settlingPools: new Set([pool]),
    reservations: new Map([[pool, 1]]),
  });
  assert.throws(
    () =>
      choose([current, other], cap, {
        continuationRunId: 'prior',
        continuationContext: { tokens: 80_000, endedAt: new Date(now - 2_000).toISOString() },
      }),
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      error.kind === 'capacity' &&
      error.retryAt === new Date(now + 5_000).toISOString() &&
      /等上一步结算约 5 秒，为缓存留在原卡/.test(error.message),
  );
  // Without a session it is an ordinary settling card: another account runs.
  assert.equal(choose([current, other], cap).runtimeId, other.id);
});

test('a stated size such as "about 15 files" makes the task complex', () => {
  const card = account('codex-a', 'codex', 1.2);
  // No caller advice here, so only the text decides.
  const ask = (prompt: string) =>
    choose([card], capacity(), { prompt, suggestedTier: undefined, suggestedEffort: undefined }).reasons.join('\n');
  for (const prompt of ['Implement batch 1, about 15 files.', '这一批大约 15 个文件，按任务书实现'])
    assert.match(ask(prompt), /目标高能力档/, prompt);
  assert.doesNotMatch(ask('Rename one variable in 2 files.'), /目标高能力档/);
});

test('a nearly spent weekly window does not take a long task when another card can', () => {
  // Regression: a card with 3% of its week left (on its line, 6 h to reset) still took a 45-minute task.
  const thin = account('claude-thin', 'claude', 3 / 3.6, 3.6);
  const healthy = account('codex-ok', 'codex', 1.1, 60);
  const long = { schedule: { estimatedMinutes: 45 } };
  for (const sources of orders([thin, healthy])) {
    const picked = choose(sources, capacity(), long);
    assert.equal(picked.runtimeId, healthy.id);
  }
  // Alone, it still runs and says so.
  const alone = choose([thin], capacity(), long);
  assert.equal(alone.runtimeId, thin.id);
  assert.match(alone.reasons.join('\n'), /claude-thin：周额度只剩 3%，.*仍按原规则派发长任务/);
});

test('a struggling card with the demanded tier still beats a healthy card without it', () => {
  // Regression: the strong cards counted as struggling, so a strong review went to another card's standard
  // gpt-5.6-terra.
  const strugglingStrong = account('codex-work', 'codex', 1.1, 60);
  const standardOnly = account('codex-b', 'codex', 1.5, 60, {
    models: [{ id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high'] }],
  });
  const healthyStrong = account('codex-native', 'codex', 1.0, 60);
  const struggling = { struggling: { general: ['codex-work'] } };
  for (const sources of orders([strugglingStrong, standardOnly]))
    assert.equal(choose(sources, capacity(), struggling).runtimeId, 'codex-work');
  // Between cards that both offer the tier, the struggling one still goes last.
  for (const sources of orders([strugglingStrong, healthyStrong]))
    assert.equal(choose(sources, capacity(), struggling).runtimeId, 'codex-native');
});

test('reset cards and API credit compare predicted waste per remaining hour', () => {
  const day = 24 * hour;
  const local = account('codex-native', 'codex', 1, 80, { label: 'Codex · 本机' });
  local.quota.windows = [
    { id: 'weekly', label: 'Weekly', durationMinutes: 10080, usedPercent: 25, resetsAt: iso(6 * day) },
  ];
  local.quota.resetCredits = cards(1, 22 * hour);
  local.quota.resetCredits.details!.push({
    key: 'z'.repeat(64),
    kind: 'full',
    status: 'available',
    grantedAt: null,
    expiresAt: iso(8 * day),
  });
  local.quota.resetCredits.availableCount = 2;
  const credit = (expiresIn: number, spent = 0) => {
    const value = account('api-anthropic', 'codex', 1, 80, {
      label: 'Anthropic',
      provider: 'pi',
      gateway: 'api',
      apiProvider: 'anthropic',
      models: [
        { id: 'gpt-6-astra', label: 'Astra', efforts: ['low', 'medium', 'high'], price: { input: 1, output: 4 } },
      ],
    });
    value.quota.windows[0]!.usedPercent = 10;
    value.apiBudgetState = apiBudgetView(
      apiBudgetPolicy({ limitUsd: 200, expiresAt: iso(expiresIn) }, undefined, iso(-7 * day)),
      spent,
      0,
      0,
      now,
    );
    return value;
  };
  // At 1% an hour the account cannot use up its cards before the first one expires.
  const burn = (perHour: number) =>
    capacity({ burn: new Map([[burnKey(local.id, 'weekly'), { account: '', perHour, periods: 3 }]]) });
  // Cards that would go unused put the account ahead of one without forecast waste.
  const spare = account('claude-spare', 'claude', 1, 80, { label: 'Claude spare' });
  for (const sources of orders([spare, local])) {
    const picked = choose(sources, burn(1));
    const why = picked.reasons.join('\n');
    assert.equal(picked.runtimeId, local.id, why);
    assert.ok(
      picked.reasons.some((reason) => reason.includes('有 1 张重置卡') && reason.includes('用不上')),
      why,
    );
  }
  // A credit behind its line goes first, even against cards forecast to go unused.
  for (const sources of orders([credit(7 * day), local])) {
    assert.equal(choose(sources, burn(1)).runtimeId, 'api-anthropic');
    // A follow-up in an existing conversation keeps its session rule: cards do not pull it away.
    assert.equal(
      choose(sources, burn(1), { continuationRunId: 'prior', continuationNewTask: true }).runtimeId,
      'api-anthropic',
    );
  }
  for (const sources of orders([credit(6 * hour), local]))
    assert.equal(choose(sources, burn(1)).runtimeId, 'api-anthropic');
  // At 5% an hour the account uses its one card up within its 3 days: nothing is forecast to go unused.
  local.quota.resetCredits = cards(1, 3 * day);
  for (const sources of orders([credit(7 * day), local]))
    assert.equal(choose(sources, burn(5)).runtimeId, 'api-anthropic');
});
