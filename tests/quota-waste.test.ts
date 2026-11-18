import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { accountKey, burnKey, QuotaHistory, type WindowBurn } from '../src/server/quota-history.ts';
import {
  availableResetCards,
  creditWaste,
  wasteReason,
  wastingAccounts,
  windowWaste,
} from '../src/server/quota-waste.ts';
import { route, type RouteCapacity } from '../src/server/routing.ts';
import type { QuotaWindow, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

// Synthetic accounts, readings and budgets only; no CLI, provider, credential or real data folder is involved.
const now = Date.parse('2026-10-11T12:00:00.000Z');
const hour = 3_600_000;
const day = 24 * hour;
const week = 7 * day;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  // Without waste, general work would go to Claude.
  architectureProvider: 'claude',
  routineProvider: 'claude',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/projects/example',
  maxConcurrentRuns: 2,
};
const input: RunInput = { prompt: 'Implement a parser', projectPath: settings.defaultProjectPath, kind: 'general' };
const weekly = (used: number, resetIn: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: 'weekly',
  label: 'weekly',
  usedPercent: used,
  resetsAt: iso(resetIn),
  durationMinutes: 10080,
  ...extra,
});

function account(id: string, provider: 'codex' | 'claude', label: string, windows: QuotaWindow[]): RuntimeSnapshot {
  return {
    id,
    provider,
    label,
    environment: 'native',
    installed: true,
    status: 'ready',
    models:
      provider === 'codex'
        ? [
            { id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] },
            { id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'medium'], lightweight: true },
          ]
        : [
            { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'] },
            { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
          ],
    quota: { status: 'known', source: 'fixture', observedAt: iso(-1000), windows },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(-1000),
  };
}

/** Codex A: 60% of its week left, resetting the day after tomorrow, and usually used slowly. */
const codex = () =>
  account('codex-a', 'codex', 'Codex A', [
    { id: 'five-hour', label: 'five-hour', usedPercent: 60, resetsAt: iso(3 * hour), durationMinutes: 300 },
    weekly(40, 50 * hour),
  ]);
/** Claude: the same share used, but busy enough to use the rest well before its reset in five days. */
const claude = () => account('claude-a', 'claude', 'Claude', [weekly(40, 120 * hour)]);
const burn = (entries: Record<string, WindowBurn>) =>
  new Map(Object.entries(entries).map(([id, value]) => [burnKey(id, 'weekly'), value]));
const history = burn({
  'codex-a': { account: '', perHour: 0.1, periods: 3 },
  'claude-a': { account: '', perHour: 1, periods: 3 },
});

test('non-standard quota descriptions retain their original text', () => {
  assert.equal(
    wasteReason('设置', { what: 'custom window', left: 60, percent: 40, resetAt: now + 2 * hour }, now),
    '设置 custom window约 2 小时后重置，还剩 60%，按平时用量会剩约 40% 用不掉，先用它',
  );
});
const capacity = (extra: Partial<RouteCapacity> = {}): RouteCapacity => ({
  reservations: new Map(),
  settlingPools: new Set(),
  burn: history,
  ...extra,
});

function withCards(snapshot: RuntimeSnapshot, expiries = [3 * day]): RuntimeSnapshot {
  return {
    ...snapshot,
    quota: {
      ...snapshot.quota,
      resetCredits: {
        availableCount: expiries.length,
        observedAt: iso(),
        source: 'synthetic',
        details: expiries.map((offset) => ({
          kind: 'full',
          status: 'available',
          grantedAt: null,
          expiresAt: iso(offset),
        })),
      },
    },
  };
}

test('executor checklist: predicted waste never brings an unchecked Claude back into automatic routing', () => {
  const rates = burn({
    'codex-a': { account: '', perHour: 10, periods: 3 },
    'claude-a': { account: '', perHour: 0.01, periods: 3 },
  });
  // Codex A ahead of its straight line (15% left, about 30% planned), so the checked pool would pick Claude.
  const pool = [claude(), codex()];
  pool[1]!.quota.windows[1]!.usedPercent = 85;
  assert.equal(route(input, pool, settings, capacity({ burn: rates }), now).runtimeId, 'claude-a');
  const decision = route(
    input,
    pool,
    { ...settings, excludedExecutors: pool.filter((item) => item.id !== 'codex-a').map((item) => item.id) },
    capacity({ burn: rates }),
    now,
  );
  assert.equal(decision.runtimeId, 'codex-a');
  assert.ok(decision.reasons.includes('已按勾选排除：Claude'));
});

test('predicted weekly waste cannot spend scarce session quota on a long task when a backup is eligible', () => {
  const scarce = codex();
  scarce.quota.windows[0]!.usedPercent = 96;
  assert.equal(route(input, [scarce, claude()], settings, capacity(), now).runtimeId, scarce.id);
  const decision = route(
    { ...input, schedule: { estimatedMinutes: 30 } },
    [scarce, claude()],
    settings,
    capacity(),
    now,
  );
  assert.equal(decision.runtimeId, 'claude-a');
  assert.match(decision.reasons.join('\n'), /5 小时额度只剩 4%，长任务改派/);
});

test('card waste is capped at the capacity actually expiring at the earliest expiry', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(30, 48 * hour)]), [day, 3 * day]);
  for (const periods of [0, 0.5, 2, 4]) {
    const rates = burn({ x: { account: '', perHour: 0.25, periods } });
    const result = windowWaste(s, s.quota.windows, rates, now)!;
    assert.equal(result.percent, 100);
    assert.equal(result.cards?.percent, result.percent);
    assert.equal(result.cards?.count, 1);
    assert.equal(result.cards?.expiresAt, now + day);
  }
});

test('a card usable now still loses the portion that cannot be spent before expiry', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(90, 78 * hour)]), [3 * day]);
  const rates = burn({ x: { account: '', perHour: 1, periods: 3 } });
  // 10% current + 100% card - 72 hours at 1% per hour = 38%, even though redemption is possible now.
  assert.equal(windowWaste(s, s.quota.windows, rates, now)!.percent, 38);
  assert.equal(windowWaste(s, s.quota.windows, rates, now, 8)!.percent, 30);
});

test('unknown card burn rate does not invent a waste estimate', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(30, 48 * hour, { durationMinutes: null })]), [day]);
  const rates = burn({ x: { account: '', perHour: 0.25, periods: 1 } });
  assert.equal(windowWaste(s, s.quota.windows, rates, now)!.percent, 100);
  assert.equal(windowWaste(s, s.quota.windows, undefined, now), undefined);
});

test('card waste becomes zero when the usual rate can consume all capacity before expiry', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(90, 100 * hour, { durationMinutes: null })]), [11 * hour]);
  const rates = burn({ x: { account: '', perHour: 10, periods: 3 } });
  assert.equal(windowWaste(s, s.quota.windows, rates, now)!.cards, undefined);
});

test('the earliest card deadline applies regardless of the order cards are reported', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(90, 100 * hour, { durationMinutes: null })]), [
    10 * hour,
    hour,
    2 * hour,
  ]);
  const result = windowWaste(s, s.quota.windows, burn({ x: { account: '', perHour: 10, periods: 3 } }), now)!;
  assert.equal(result.cards?.count, 1);
  assert.equal(result.cards?.expiresAt, now + hour);
  assert.equal(result.percent, 100);
});

test('session windows refill, so a fast short window cannot hide weekly card waste', () => {
  const s = withCards(
    account('x', 'codex', 'X', [
      weekly(0, week),
      { id: 'short', label: 'short', usedPercent: 90, resetsAt: iso(hour), durationMinutes: 300 },
    ]),
  );
  const rates = burn({ x: { account: '', perHour: 0.1, periods: 3 } });
  rates.set(burnKey('x', 'short'), { account: '', perHour: 20, periods: 3 });
  // Unused capacity exceeds one card, so card waste is capped at 100%; short-window pace does not count.
  assert.ok(Math.abs(windowWaste(s, s.quota.windows, rates, now)!.cards!.percent - 100) < 1e-9);
  rates.delete(burnKey('x', 'short'));
  assert.ok(Math.abs(windowWaste(s, s.quota.windows, rates, now)!.cards!.percent - 100) < 1e-9);
});

test('a weekly reset before the cards expire adds a full window', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(50, day)]), [3 * day]);
  const rates = burn({ x: { account: '', perHour: 1, periods: 3 } });
  // 50% now + one card + one natural reset, minus under 100 points of usual use over 72 hours; without the reset < 100.
  assert.ok(windowWaste(s, s.quota.windows, rates, now)!.cards!.percent === 100);
});

test('expired, invalid, unknown and consumed cards never contribute waste or spare capacity', () => {
  const s = withCards(codex(), [-hour, 0]);
  const row = s.quota.resetCredits!.details![0]!;
  s.quota.resetCredits!.availableCount = 99;
  s.quota.resetCredits!.details!.push(
    { ...row, expiresAt: null },
    { ...row, expiresAt: 'invalid' },
    ...(['unknown', 'expired', 'consumed'] as const).map((status) => ({ ...row, status, expiresAt: iso(day) })),
    { ...row, kind: 'unknown', expiresAt: iso(day) },
  );
  assert.deepEqual(availableResetCards(s, now), []);
  assert.equal(windowWaste(s, s.quota.windows, history, now)!.cards, undefined);
  assert.equal(availableResetCards(withCards(claude()), now).length, 0);
});

test('missing pace and another login history cannot manufacture card waste', () => {
  const s = {
    ...withCards(account('x', 'codex', 'X', [weekly(30, day, { durationMinutes: null })])),
    accountFingerprint: 'new-login',
  };
  const other = burn({ x: { account: accountKey('old-login'), perHour: 0, periods: 20 } });
  assert.equal(windowWaste(s, s.quota.windows, other, now), undefined);
  assert.equal(windowWaste(s, s.quota.windows, undefined, now), undefined);
});

test('routing prefers card waste and explains the count, expiry and reason in Chinese', () => {
  const plain = account('codex-a', 'codex', 'Codex A', [weekly(30, 48 * hour)]);
  const card = withCards({ ...plain, id: 'codex-b', label: 'Codex B' });
  for (const snapshots of [
    [plain, card],
    [card, plain],
  ]) {
    const decision = route(input, snapshots, settings, capacity({ burn: undefined }), now);
    assert.equal(decision.runtimeId, card.id);
    assert.ok(decision.reasons.includes('Codex B 有 1 张重置卡 3 天后到期，按平时用量到时还用不上，先多用它'));
  }
});

test('spare cards only break an actual quota tie and never pretend to be current quota', () => {
  const plain = account('codex-a', 'codex', 'A', [weekly(40, 100 * hour, { durationMinutes: null })]);
  const card = withCards({ ...plain, id: 'codex-b', label: 'B' });
  const pick = (s: RuntimeSnapshot) => route(input, [plain, s], settings, capacity({ burn: undefined }), now).runtimeId;
  assert.equal(pick(card), card.id);
  assert.equal(
    pick({ ...card, quota: { ...card.quota, windows: [weekly(41, 100 * hour, { durationMinutes: null })] } }),
    plain.id,
  );
  assert.equal(pick(withCards({ ...plain, id: 'codex-b' }, [-hour])), plain.id);
});

test('card scoring preserves pins, category rules, tier fit and native continuation', () => {
  for (const durationMinutes of [10080, null]) {
    const plain = account('codex-a', 'codex', 'A', [weekly(30, 48 * hour, { durationMinutes })]);
    const card = withCards({ ...plain, id: 'codex-b' });
    const cap = capacity({ burn: undefined, continuing: [{ runtimeId: plain.id }] });
    assert.equal(route({ ...input, runtimeId: plain.id }, [card, plain], settings, cap, now).runtimeId, plain.id);
    assert.equal(
      route({ ...input, continuationRunId: 'synthetic-run' }, [card, plain], settings, cap, now).runtimeId,
      plain.id,
    );
    const weak = { ...card, models: [card.models[1]!] };
    assert.equal(route(input, [weak, plain], settings, cap, now).runtimeId, plain.id);
    assert.equal(
      route(
        input,
        [card, claude()],
        { ...settings, routePreferencesEnabled: true, routePolicy: { general: ['claude'] } },
        cap,
        now,
      ).runtimeId,
      'claude-a',
    );
    assert.equal(route(input, [card, claude()], { ...settings, routeGoal: 'quality' }, cap, now).runtimeId, 'claude-a');
  }
});

test('card tie-break cannot override independent pins, tier fit, continuation, or execution filters', () => {
  const plain = account('codex-a', 'codex', 'A', [weekly(30, 48 * hour, { durationMinutes: null })]);
  const card = withCards({ ...plain, id: 'codex-b' });
  const cap = capacity({ burn: undefined });
  assert.equal(windowWaste(card, card.quota.windows, undefined, now), undefined);
  assert.equal(route(input, [plain, card], settings, cap, now).runtimeId, card.id);
  assert.equal(route({ ...input, runtimeId: plain.id }, [plain, card], settings, cap, now).runtimeId, plain.id);
  assert.equal(route(input, [plain, { ...card, models: [card.models[1]!] }], settings, cap, now).runtimeId, plain.id);
  assert.equal(
    route(
      { ...input, continuationRunId: 'synthetic' },
      [plain, card],
      settings,
      { ...cap, continuing: [{ runtimeId: plain.id }] },
      now,
    ).runtimeId,
    plain.id,
  );
  for (const patch of [
    { installed: false },
    { status: 'auth-required' as const },
    { capabilities: { ...card.capabilities, execute: false } },
    { availability: { reason: 'quota' as const, observedAt: iso(), retryAt: iso(hour) } },
  ])
    assert.equal(route(input, [plain, { ...card, ...patch }], settings, cap, now).runtimeId, plain.id);
  for (const used of [90, 100]) {
    const low = { ...card, quota: { ...card.quota, windows: [weekly(used, 48 * hour, { durationMinutes: null })] } };
    assert.equal(route(input, [plain, low], settings, cap, now).runtimeId, plain.id);
  }
  for (const budget of [credit(199.5), credit(5, { expiresAt: iso(-hour) })])
    assert.equal(route(input, [plain, { ...card, apiBudgetState: budget }], settings, cap, now).runtimeId, plain.id);
});

test('the auto-use switch leaves competitive routing decisions and reasons identical', () => {
  for (const durationMinutes of [10080, null]) {
    const plain = account('codex-a', 'codex', 'A', [weekly(30, 48 * hour, { durationMinutes })]);
    const card = withCards({ ...plain, id: 'codex-b', label: 'B' });
    const cap = capacity({ burn: undefined, continuing: [{ runtimeId: plain.id }] });
    for (const snapshots of [
      [plain, card],
      [card, plain],
      [claude(), card],
    ])
      for (const request of [input, { ...input, runtimeId: card.id }, { ...input, continuationRunId: 'synthetic' }]) {
        const off = route(request, snapshots, { ...settings, autoUseResetCards: false }, cap, now);
        assert.deepEqual(route(request, snapshots, { ...settings, autoUseResetCards: true }, cap, now), off);
        assert.deepEqual(route(request, snapshots, settings, cap, now), off);
      }
  }
});

test('cards cannot cross reserve lines, in-flight reservations, stale readings or API budgets', () => {
  const card = withCards(account('codex-b', 'codex', 'B', [weekly(30, 48 * hour)]));
  const plain = { ...card, id: 'codex-a', quota: { ...card.quota, resetCredits: undefined } };
  for (const used of [90, 100]) {
    const low = { ...card, quota: { ...card.quota, windows: [weekly(used, 48 * hour)] } };
    assert.equal(route(input, [low, plain], settings, capacity(), now).runtimeId, plain.id);
  }
  assert.equal(
    route(input, [card, plain], settings, capacity({ reservations: new Map([['runtime:codex-b', 7]]) }), now).runtimeId,
    plain.id,
  );
  const stale = { ...card, quota: { ...card.quota, observedAt: iso(-day) } };
  assert.equal(route(input, [stale, plain], settings, capacity(), now).runtimeId, plain.id);
  for (const budget of [credit(199.5), credit(5, { expiresAt: iso(-hour) })])
    assert.equal(
      route(input, [{ ...card, apiBudgetState: budget }, plain], settings, capacity(), now).runtimeId,
      plain.id,
    );
});

test('the waste estimate is what is left minus the usual pace until the reset, damped by thin evidence', () => {
  // 30% used in the 120 hours since the week began, the same 0.25%/h pace as two earlier weeks.
  const window = weekly(30, 48 * hour);
  const two = windowWaste({ id: 'x' }, [window], burn({ x: { account: '', perHour: 0.25, periods: 2 } }), now)!;
  // 70% left, 48 h × 0.25%/h = 12% expected: 58% unused, trusted 19/26 (2 + 5/7 periods of evidence).
  assert.ok(Math.abs(two.percent - (58 * 19) / 26) < 1e-9);
  assert.equal(two.left, 70);
  assert.equal(two.what, '周额度');
  // Fewer periods behind the pace, less trust; the running week alone still counts for something.
  const none = windowWaste({ id: 'x' }, [window], undefined, now)!;
  const half = windowWaste({ id: 'x' }, [window], burn({ x: { account: '', perHour: 0.25, periods: 0.5 } }), now)!;
  const many = windowWaste({ id: 'x' }, [window], burn({ x: { account: '', perHour: 0.25, periods: 4 } }), now)!;
  assert.ok(Math.abs(none.percent - (58 * 5) / 12) < 1e-9);
  assert.ok(none.percent < half.percent && half.percent < two.percent && two.percent < many.percent);
  // Work PugPort already runs there counts as used.
  assert.ok(windowWaste({ id: 'x' }, [window], undefined, now, 20)!.percent < none.percent);
  // A window of unknown length with no history says nothing.
  assert.equal(windowWaste({ id: 'x' }, [{ ...window, durationMinutes: null }], undefined, now), undefined);
});

test('an untouched sliding window loses nothing, and every long limit caps the waste', () => {
  // Codex reports an unstarted week as resetting a full week from now: nothing is lost by waiting.
  assert.equal(windowWaste({ id: 'x' }, [weekly(0, week)], undefined, now)!.percent, 0);
  // Claude's Opus cap resets with the shared week; with 10% of it left, at most that much can still be used.
  const shared = weekly(40, 50 * hour);
  const opus: QuotaWindow = { ...shared, id: 'weekly-opus', label: 'Opus', usedPercent: 90, durationMinutes: null };
  const capped = windowWaste({ id: 'codex-a' }, [shared, opus], history, now)!;
  assert.equal(capped.percent, 10);
  assert.ok(windowWaste({ id: 'codex-a' }, [shared], history, now)!.percent > 30);
});

test('quota history yields each window pace from ended periods, counting a period seen only early for less', () => {
  const db = new DatabaseSync(':memory:');
  const clock = { now: now - 3 * week };
  const quota = new QuotaHistory(db, () => clock.now);
  const start = now - 3 * week;
  const observe = (at: number, used: number, resetsAt: number, fingerprint = 'synthetic-one') => {
    clock.now = Math.max(clock.now, start + at);
    quota.observe([
      {
        ...account('codex-a', 'codex', 'Codex A', []),
        accountFingerprint: fingerprint,
        quota: {
          status: 'known',
          source: 'fixture',
          observedAt: new Date(start + at).toISOString(),
          windows: [
            {
              id: 'weekly',
              label: 'weekly',
              usedPercent: used,
              resetsAt: new Date(start + resetsAt).toISOString(),
              durationMinutes: 10080,
            },
          ],
        },
      },
    ]);
  };
  // Two weeks seen from start to end at 70% and 35%, then a third under way.
  observe(hour, 10, week);
  observe(week - hour, 70, week);
  observe(week + hour, 5, 2 * week);
  observe(2 * week - hour, 35, 2 * week);
  observe(2 * week + hour, 10, 3 * week);
  clock.now = start + 2 * week + day;
  const rates = quota.burnRates().get(burnKey('codex-a', 'weekly'))!;
  assert.ok(Math.abs(rates.perHour - 52.5 / 168) < 1e-9, 'the average of 70% and 35% a week');
  assert.ok(Math.abs(rates.periods - (2 * 167) / 168) < 1e-9);
  assert.deepEqual(rates.current, { since: start + 2 * week + hour, resetsAt: start + 3 * week });
  assert.equal(rates.account, accountKey('synthetic-one'));
  // Another login on the card starts afresh: the old weeks no longer describe it.
  observe(2 * week + 2 * hour, 3, 2 * week + 5 * day, 'synthetic-two');
  const fresh = quota.burnRates().get(burnKey('codex-a', 'weekly'))!;
  assert.equal(fresh.periods, 0);
  assert.equal(fresh.account, accountKey('synthetic-two'));
  // And the estimate ignores history kept for a different login than the one now signed in.
  const signedIn = { id: 'codex-a', accountFingerprint: 'synthetic-one' };
  assert.equal(
    windowWaste(signedIn, [weekly(30, 48 * hour)], burn({ 'codex-a': { ...rates, account: fresh.account } }), now)!
      .percent,
    windowWaste(signedIn, [weekly(30, 48 * hour)], undefined, now)!.percent,
  );
  // A week PugPort saw only on its first day weighs about one hundred and sixty-eighth of a full one.
  const thin = new QuotaHistory(new DatabaseSync(':memory:'), () => clock.now);
  clock.now = start;
  thin.observe([
    {
      ...account('codex-b', 'codex', 'B', [weekly(10, week)]),
      quota: {
        status: 'known',
        source: 'f',
        observedAt: new Date(start + hour).toISOString(),
        windows: [{ ...weekly(10, 0), resetsAt: new Date(start + week).toISOString() }],
      },
    },
  ]);
  clock.now = start + week + day;
  assert.ok(thin.burnRates().get(burnKey('codex-b', 'weekly'))!.periods < 0.01);
});

test('among capable candidates the account that would waste the most goes first, and says so', () => {
  const decision = route(input, [claude(), codex()], settings, capacity(), now);
  assert.equal(decision.runtimeId, 'codex-a');
  assert.ok(
    decision.reasons.some((reason) =>
      /^Codex A 周额度后天重置，还剩 60%，按平时用量会剩约 4\d% 用不掉，先用它$/.test(reason),
    ),
    decision.reasons.join('\n'),
  );
  // Without the preference, the default platform keeps the work.
  const off = route(
    { ...input, schedule: { preferExpiringQuota: false } },
    [claude(), codex()],
    settings,
    capacity(),
    now,
  );
  assert.equal(off.runtimeId, 'claude-a');
  assert.ok(!off.reasons.some((reason) => reason.includes('用不掉')));
  // Two accounts of one platform compare the same way.
  const second = {
    ...codex(),
    id: 'codex-b',
    label: 'Codex B',
    quota: { ...codex().quota, windows: [weekly(40, 50 * hour)] },
  };
  const busy = new Map([...history, [burnKey('codex-b', 'weekly'), { account: '', perHour: 2, periods: 3 }]]);
  assert.equal(route(input, [second, codex()], settings, capacity({ burn: busy }), now).runtimeId, 'codex-a');
});

test('waste never overrides tier fit, a pinned executor, a continued session or a reset within the hour', () => {
  // A task asking for the strongest tier is not moved to a weaker model just to burn quota.
  const quality = { ...settings, routeGoal: 'quality' as const };
  assert.equal(route(input, [claude(), codex()], quality, capacity(), now).runtimeId, 'claude-a');
  // A pinned executor or platform stays.
  assert.equal(
    route({ ...input, runtimeId: 'claude-a' }, [claude(), codex()], settings, capacity(), now).runtimeId,
    'claude-a',
  );
  assert.equal(
    route({ ...input, provider: 'claude' }, [claude(), codex()], settings, capacity(), now).runtimeId,
    'claude-a',
  );
  // A category the user gave to one platform keeps it.
  const designed = route(
    { ...input, kind: 'design' },
    [claude(), codex()],
    { ...settings, routePreferencesEnabled: true },
    capacity(),
    now,
  );
  assert.equal(designed.runtimeId, 'claude-a');
  // A conversation whose native session lives on Claude stays there.
  const continuing = [{ runtimeId: 'claude-a' }];
  const kept = route(
    { ...input, continuationRunId: 'run-1' },
    [claude(), codex()],
    settings,
    capacity({ continuing }),
    now,
  );
  assert.equal(kept.runtimeId, 'claude-a');
  assert.ok(kept.reasons.includes('续接本对话的原生会话，留在 Claude；快浪费的额度留给新任务'));
  assert.equal(route(input, [claude(), codex()], settings, capacity({ continuing }), now).runtimeId, 'codex-a');
  // Quota resetting within the hour is still used first, as before.
  const soon = account('claude-a', 'claude', 'Claude', [weekly(40, 30 * 60_000)]);
  const urgent = route(input, [soon, codex()], settings, capacity(), now);
  assert.equal(urgent.runtimeId, 'claude-a');
  assert.ok(urgent.reasons.some((reason) => reason.includes('近期机会窗口')));
});

const priced = [{ id: 'model/pro', label: 'Pro', efforts: ['low', 'medium', 'high'], price: { input: 1, output: 2 } }];
const api = (id: string, platform: string, budget?: RuntimeSnapshot['apiBudgetState']): RuntimeSnapshot => ({
  id,
  provider: 'pi',
  gateway: 'api',
  apiProvider: platform,
  label: platform,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: priced,
  accounting: { mode: 'usage', source: 'fixture' },
  quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
  capabilities: { execute: true, resume: false, cancel: true, approvals: true },
  refreshedAt: iso(),
  ...(budget ? { apiBudgetState: budget } : {}),
});
/** A $200 credit set up ten days ago, expiring in 24 days, with $5 spent so far. */
const credit = (spent = 5, changes = {}) =>
  apiBudgetView(
    apiBudgetPolicy({ limitUsd: 200, expiresAt: iso(24 * day), ...changes }, undefined, iso(-10 * day)),
    spent,
    0,
    0,
    now,
  );

test('an expiring API credit counts as waste; pay-as-you-go money never does', () => {
  const waste = creditWaste(credit(), now)!;
  // $195 left, $0.50 a day for 24 more days uses $12: $183 unused, trusted for the 10 of 34 days seen.
  const trusted = 10 / 34 / (10 / 34 + 1);
  assert.ok(Math.abs(waste.usd!.unused - 183 * trusted) < 1e-9);
  assert.ok(Math.abs(waste.percent - ((183 * trusted) / 200) * 100) < 1e-9);
  assert.equal(
    wasteReason('Claude API', waste, now),
    `Claude API 赠金 24 天后到期，还剩 $195，按平时用量约 $${Math.round(183 * trusted)} 会用不掉，先用它`,
  );
  // No expiry, no limit, opted out of expiry urgency, or no budget at all: nothing is lost by waiting.
  for (const budget of [
    apiBudgetView(apiBudgetPolicy({ limitUsd: 200 }, undefined, iso(-10 * day)), 5, 0, 0, now),
    apiBudgetView(apiBudgetPolicy({ expiresAt: iso(24 * day) }, undefined, iso(-10 * day)), 5, 0, 0, now),
    credit(5, { preferExpiring: false }),
    undefined,
  ])
    assert.equal(creditWaste(budget, now), undefined);
  const payg = api('api-openai', 'openai');
  const deepseek = api('api-deepseek', 'deepseek', credit(5, { expiresAt: iso(10 * day) }));
  assert.equal(
    route({ ...input, executionPolicy: 'api-only' }, [payg, deepseek], settings, capacity(), now).runtimeId,
    deepseek.id,
  );
  assert.equal(
    route({ ...input, runtimeId: deepseek.id }, [payg, deepseek], settings, capacity(), now).runtimeId,
    deepseek.id,
  );
});

test('behind-pace credit is automatic before and during the final expiry phases', () => {
  const normal = api('api-claude', 'anthropic', credit(0, { expiresAt: iso(10 * day) }));
  assert.equal(normal.apiBudgetState!.phase, 'normal');
  for (const cli of [codex(), claude()]) {
    assert.equal(route(input, [normal, cli], settings, capacity(), now).runtimeId, normal.id);
    assert.equal(route({ ...input, runtimeId: normal.id }, [normal], settings, capacity(), now).runtimeId, normal.id);
  }
  for (const [phase, expiresIn] of [
    ['priority', 6 * day],
    ['accelerated', 2 * day],
    ['sprint', 12 * hour],
  ] as const) {
    const gift = api('api-claude', 'anthropic', credit(0, { expiresAt: iso(expiresIn) }));
    assert.equal(gift.apiBudgetState!.phase, phase);
    for (const cli of [codex(), claude()]) {
      assert.equal(route(input, [gift, cli], settings, capacity(), now).runtimeId, gift.id);
      assert.equal(route({ ...input, runtimeId: gift.id }, [gift], settings, capacity(), now).runtimeId, gift.id);
    }
  }
});

test('behind-pace credit goes before CLI waste while retaining demanded model tier', () => {
  const tiny = account('codex-tiny', 'codex', 'Codex Tiny', [weekly(40, 100 * hour)]);
  const rates = new Map([...history, ...burn({ 'codex-tiny': { account: '', perHour: 0.59, periods: 3 } })]);
  const small = windowWaste(tiny, tiny.quota.windows, rates, now)!.percent;
  assert.ok(small > 0 && small < 10);
  for (const expiresAt of [iso(10 * day), iso(8 * day)]) {
    const gift = api('api-claude', 'anthropic', credit(5, { expiresAt }));
    for (const snapshots of [
      [gift, codex()],
      [gift, claude(), tiny],
    ])
      assert.equal(route(input, snapshots, settings, capacity({ burn: rates }), now).runtimeId, gift.id);
    const strong = { ...gift, models: [{ ...priced[0]!, id: 'claude/opus' }] };
    assert.equal(
      route(input, [strong, codex()], { ...settings, routeGoal: 'quality' }, capacity(), now).runtimeId,
      strong.id,
    );
  }
});

test('credit outside fourteen days stays excluded regardless of predicted waste', () => {
  for (const budget of [credit(0, { limitUsd: 40 }), credit(40)]) {
    const usd = creditWaste(budget, now)!.usd!;
    assert.ok(usd.unused > 0 && usd.unused < Math.max(10, usd.left * 0.1));
    assert.equal(
      route(input, [api('api-claude', 'anthropic', budget), claude()], settings, capacity(), now).runtimeId,
      'claude-a',
    );
  }
  const boundary = credit(0, { limitUsd: 44 });
  const unused = creditWaste(boundary, now)!.usd!.unused;
  assert.ok(unused >= 10 && unused < 10 + 1e-9);
  assert.equal(
    route(input, [api('api-claude', 'anthropic', boundary), claude()], settings, capacity(), now).runtimeId,
    'claude-a',
  );
});

test('outside the final expiry phases credit waste never overrides a pin, platform, rule, continuation or opt-out', () => {
  for (const expiresAt of [iso(24 * day), iso(8 * day)]) {
    const snapshots = [api('api-claude', 'anthropic', credit(5, { expiresAt })), claude()];
    for (const patch of [
      { runtimeId: 'claude-a' },
      { provider: 'claude' as const },
      { continuationRunId: 'run-1' },
      { executionPolicy: 'cli-only' as const },
      { schedule: { preferExpiringQuota: false } },
    ])
      assert.equal(
        route({ ...input, ...patch }, snapshots, settings, capacity({ continuing: [{ runtimeId: 'claude-a' }] }), now)
          .runtimeId,
        'claude-a',
      );
    assert.equal(
      route(
        input,
        snapshots,
        { ...settings, routePreferencesEnabled: true, routePolicy: { general: ['claude'] } },
        capacity(),
        now,
      ).runtimeId,
      'claude-a',
    );
  }
});

test('credit waste never overrides budget, concurrency, reserve, capability or tool-less checks', () => {
  const gift = api('api-claude', 'anthropic', credit());
  for (const budget of [credit(199.5), credit(5, { perRunUsd: 196 }), credit(5, { expiresAt: iso(-hour) })])
    assert.equal(
      route(input, [{ ...gift, apiBudgetState: budget }, claude()], settings, capacity(), now).runtimeId,
      'claude-a',
    );
  const full = capacity({ reservations: new Map([['runtime:api-claude', 1]]) });
  assert.equal(route(input, [gift, claude()], settings, full, now).runtimeId, 'claude-a');
  const weak = { ...gift, models: [{ ...priced[0]!, lightweight: true }] };
  assert.equal(route(input, [weak, claude()], settings, capacity(), now).runtimeId, 'claude-a');
  assert.equal(
    route(
      { ...input, kind: 'architecture' },
      [gift, claude()],
      { ...settings, routePreferencesEnabled: true, routePolicy: { architecture: [] } },
      capacity(),
      now,
    ).runtimeId,
    'claude-a',
  );
  const toolless = { ...claude(), capabilities: { ...claude().capabilities, toolless: true } };
  assert.equal(
    route({ ...input, untrustedContent: true }, [gift, toolless], settings, capacity(), now).runtimeId,
    'claude-a',
  );
  const reserved = { ...gift, quota: account('unused', 'claude', 'unused', [weekly(95, 120 * hour)]).quota };
  assert.equal(route(input, [reserved, claude()], settings, capacity(), now).runtimeId, 'claude-a');
  const spent = api('api-deepseek', 'deepseek', credit(199.5));
  assert.equal(
    route({ ...input, executionPolicy: 'api-only' }, [spent, api('api-openai', 'openai')], settings, capacity(), now)
      .runtimeId,
    'api-openai',
  );
});

test('only expiring paced credit bypasses CLI-first regardless of unknown CLI waste', () => {
  for (const budget of [
    undefined,
    apiBudgetView(apiBudgetPolicy({ expiresAt: iso(24 * day) }, undefined, iso(-10 * day)), 5, 0, 0, now),
    apiBudgetView(apiBudgetPolicy({ limitUsd: 200 }, undefined, iso(-10 * day)), 5, 0, 0, now),
    credit(5, { preferExpiring: false }),
  ])
    assert.equal(
      route(input, [api('api-claude', 'anthropic', budget), claude()], settings, capacity(), now).runtimeId,
      'claude-a',
    );
  const unknownPace = account('cli-unknown', 'claude', 'Claude', [weekly(40, 120 * hour, { durationMinutes: null })]);
  assert.equal(windowWaste(unknownPace, unknownPace.quota.windows, history, now), undefined);
  assert.equal(
    route(
      input,
      [api('api-claude', 'anthropic', credit(5, { expiresAt: iso(10 * day) })), unknownPace],
      settings,
      capacity(),
      now,
    ).runtimeId,
    'api-claude',
  );
});

test('background work can ask which account would waste the most if left unused', () => {
  const low = account('codex-low', 'codex', 'Codex Low', [weekly(95, 50 * hour)]);
  const signedOut = {
    ...codex(),
    id: 'codex-out',
    availability: { reason: 'authentication' as const, observedAt: iso() },
  };
  const found = wastingAccounts(
    [claude(), low, signedOut, api('api-openai', 'openai'), api('api-deepseek', 'deepseek', credit()), codex()],
    history,
    settings,
    now,
  );
  assert.deepEqual(
    found.map((item) => item.runtimeId),
    ['codex-a', 'api-deepseek'],
    'busy, below-reserve, signed-out and pay-as-you-go accounts are left out',
  );
  assert.equal(found[0]!.model, 'gpt-6-sol');
  assert.match(found[0]!.reason, /^Codex A 周额度后天重置，还剩 60%，按平时用量会剩约 4\d% 用不掉$/);
  assert.equal(found[1]!.model, undefined);
});

test('wasting account reasons omit both usage recommendations', () => {
  const card = withCards(codex());
  const [plain] = wastingAccounts([codex()], history, settings, now);
  const [withCard] = wastingAccounts([card], history, settings, now);
  assert.ok(plain && withCard);
  assert.match(wasteReason(plain.label, plain.waste, now), /，先用它$/);
  assert.match(wasteReason(withCard.label, withCard.waste, now), /，先多用它$/);
  assert.equal(plain.reason, wasteReason(plain.label, plain.waste, now).replace(/，先用它$/, ''));
  assert.equal(withCard.reason, wasteReason(withCard.label, withCard.waste, now).replace(/，先多用它$/, ''));
});

test('weekly waste beats a distant card, while tomorrow cards beat a newly reset week', () => {
  const local = account('local', 'codex', 'Codex · 本机', [weekly(3, 3 * day)]);
  const work = withCards(account('work', 'codex', 'Codex Work', [weekly(0, week)]), [29 * day]);
  const rates = burn({
    local: { account: '', perHour: 0.1, periods: 3 },
    work: { account: '', perHour: 0.1, periods: 3 },
  });
  for (const sources of [
    [local, work],
    [work, local],
  ]) {
    const picked = route(input, sources, settings, capacity({ burn: rates }), now);
    assert.equal(picked.runtimeId, local.id);
    assert.match(picked.reasons.join('\n'), /周额度.*97%/);
    assert.ok(!picked.reasons.some((reason) => reason.includes('重置卡')));
  }
  local.quota.windows = [weekly(0, week)];
  const tomorrow = withCards(work, [day]);
  for (const sources of [
    [local, tomorrow],
    [tomorrow, local],
  ]) {
    const picked = route(input, sources, settings, capacity({ burn: rates }), now);
    assert.equal(picked.runtimeId, work.id);
    assert.match(picked.reasons.join('\n'), /重置卡.*到期/);
  }
});

test('no predicted waste falls back to the original pace and quota selection', () => {
  const local = account('local', 'codex', 'Local', [weekly(30, 3 * day)]);
  const work = withCards(account('work', 'codex', 'Work', [weekly(40, 4 * day)]), [29 * day]);
  const rates = burn({
    local: { account: '', perHour: 10, periods: 3 },
    work: { account: '', perHour: 10, periods: 3 },
  });
  for (const sources of [
    [local, work],
    [work, local],
  ]) {
    const cap = capacity({ burn: rates });
    assert.equal(windowWaste(local, local.quota.windows, rates, now)!.percent, 0);
    assert.equal(windowWaste(work, work.quota.windows, rates, now)!.percent, 0);
    // Work has the extra reset card in its existing pace calculation.
    assert.equal(route(input, sources, settings, cap, now).runtimeId, work.id);
  }
});

test('a short window can be the most urgent source even when the same account owns distant cards', () => {
  const s = withCards(
    account('short', 'codex', 'Short', [
      weekly(3, 3 * day),
      { id: 'five-hour', label: 'five-hour', usedPercent: 10, durationMinutes: 300, resetsAt: iso(2 * hour) },
    ]),
    [29 * day],
  );
  const result = windowWaste(s, s.quota.windows, burn({ short: { account: '', perHour: 0.1, periods: 3 } }), now)!;
  assert.equal(result.resetAt, now + 2 * hour);
  assert.equal(result.cards, undefined);
});

test('later card cohorts still compete when the earliest card can be consumed', () => {
  const s = withCards(account('x', 'codex', 'X', [weekly(90, 5 * day, { durationMinutes: null })]), [
    day,
    ...Array.from({ length: 10 }, () => 2 * day),
  ]);
  const result = windowWaste(s, s.quota.windows, burn({ x: { account: '', perHour: 5, periods: 3 } }), now)!;
  assert.equal(result.cards?.count, 11);
  assert.equal(result.resetAt, now + 2 * day);
  assert.equal(result.percent, 870);
  assert.match(wasteReason(s.label, result, now), /截至/);
});
