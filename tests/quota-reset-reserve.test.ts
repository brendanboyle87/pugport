import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCursorPool } from '../src/shared/cursor-models.ts';
import { quotaWindowReservePercent } from '../src/shared/quota-reserve.ts';
import { burnKey } from '../src/server/quota-history.ts';
import { wastingAccounts } from '../src/server/quota-waste.ts';
import type { QuotaWindow, RuntimeSnapshot } from '../src/shared/types.ts';

// Synthetic quota readings only. No account, provider, or real quota is contacted.
const now = Date.parse('2026-10-26T12:00:00Z');
const hour = 3_600_000;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings = { reservePercent: 10, maxQuotaAgeSeconds: 120 };
const quota = { status: 'known' as const, observedAt: iso() };
const window = (resetIn: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: 'session',
  label: 'Session',
  usedPercent: 95,
  resetsAt: iso(resetIn),
  ...extra,
});

test('reserve uses each window reset, including exact 24-hour and 6-hour boundaries', () => {
  for (const [resetIn, expected] of [
    [48 * hour, 10],
    [24 * hour + 1, 10],
    [24 * hour, 2],
    [6 * hour + 1, 2],
    [6 * hour, 0],
    [1, 0],
  ])
    assert.equal(quotaWindowReservePercent(window(resetIn), quota, settings, now), expected, `${resetIn} ms`);
});

test('reset policy never raises a smaller configured reserve', () => {
  for (const configured of [0, 0.5, 1, 2]) {
    const custom = { ...settings, reservePercent: configured };
    assert.equal(quotaWindowReservePercent(window(25 * hour), quota, custom, now), configured);
    assert.equal(quotaWindowReservePercent(window(12 * hour), quota, custom, now), configured);
    assert.equal(quotaWindowReservePercent(window(hour), quota, custom, now), 0);
  }
});

test('session reserve is independent of reset time and the configured long-window reserve', () => {
  for (const reservePercent of [0, 10, 50]) {
    for (const resetIn of [3 * hour, 25 * hour]) {
      for (const extra of [{ durationMinutes: 300 }, { id: 'five_hour' }])
        assert.equal(quotaWindowReservePercent(window(resetIn, extra), quota, { ...settings, reservePercent }, now), 0);
    }
  }
});

test('all non-short windows retain time-based reserve relaxation', () => {
  for (const [resetIn, expected] of [
    [25 * hour, 10],
    [20 * hour, 2],
    [5 * hour, 0],
  ]) {
    for (const durationMinutes of [361, 1440])
      assert.equal(quotaWindowReservePercent(window(resetIn!, { durationMinutes }), quota, settings, now), expected);
    assert.equal(
      quotaWindowReservePercent(window(resetIn!, { id: 'weekly', durationMinutes: 10080 }), quota, settings, now),
      expected,
    );
    assert.equal(quotaWindowReservePercent(window(resetIn!, { id: 'codex:primary' }), quota, settings, now), expected);
  }
  assert.equal(
    quotaWindowReservePercent(window(3 * hour, { id: 'five_hour', durationMinutes: 1440 }), quota, settings, now),
    0,
  );
});

test('short windows retain freshness validation and independent pool or family reserves', () => {
  const short = window(3 * hour, { durationMinutes: 300 });
  assert.equal(quotaWindowReservePercent(short, { ...quota, observedAt: iso(-120_000) }, settings, now), 10);
  for (const extra of [{ modelPool: 'cursor' as const }, { modelFamily: 'opus' as const }])
    assert.equal(
      quotaWindowReservePercent(window(25 * hour, { durationMinutes: 300, ...extra }), quota, settings, now),
      10,
    );
});

test('unknown, invalid, passed and exactly-current resets keep the configured reserve', () => {
  for (const resetsAt of [null, '', 'invalid', iso(-1), iso()])
    assert.equal(quotaWindowReservePercent(window(hour, { resetsAt }), quota, settings, now), 10);
  assert.equal(
    quotaWindowReservePercent(window(hour, { resetsAt: null, resetNotReported: true }), quota, settings, now),
    10,
  );
});

test('stale, missing and future observations cannot relax the reserve', () => {
  for (const observedAt of [null, '', 'invalid', iso(-120_000), iso(-120_001), iso(1)])
    assert.equal(quotaWindowReservePercent(window(hour), { ...quota, observedAt }, settings, now), 10);
  assert.equal(quotaWindowReservePercent(window(hour), { ...quota, observedAt: iso(-119_999) }, settings, now), 0);
  assert.equal(quotaWindowReservePercent(window(hour), { ...quota, status: 'unknown' }, settings, now), 10);
});

test('sparse quota updates preserve the individual window observation age', () => {
  assert.equal(quotaWindowReservePercent(window(hour, { observedAt: iso(-121_000) }), quota, settings, now), 10);
  assert.equal(quotaWindowReservePercent(window(hour, { observedAt: iso(1) }), quota, settings, now), 10);
  assert.equal(
    quotaWindowReservePercent(
      window(hour, { observedAt: iso() }),
      { ...quota, observedAt: iso(-121_000) },
      settings,
      now,
    ),
    0,
  );
});

test('invalid usage or evaluation time cannot relax the reserve', () => {
  for (const usedPercent of [null, NaN, Infinity, -1, 101])
    assert.equal(quotaWindowReservePercent(window(hour, { usedPercent }), quota, settings, now), 10);
  assert.equal(quotaWindowReservePercent(window(hour), quota, settings, NaN), 10);
  assert.equal(quotaWindowReservePercent(window(hour), quota, { ...settings, maxQuotaAgeSeconds: NaN }, now), 10);
});

test('a near session reset does not reduce a weekly or model-family reserve', () => {
  const windows = [
    window(hour),
    window(48 * hour, { id: 'week' }),
    window(12 * hour, { id: 'opus', modelFamily: 'opus' }),
  ];
  assert.deepEqual(
    windows.map((w) => quotaWindowReservePercent(w, quota, settings, now)),
    [0, 10, 2],
  );
});

test('pool choice uses its binding reserve and keeps raw remaining percentages in reasons', () => {
  const base = {
    tier: 'light' as const,
    headroom: { cursor: 13, other: 60 },
    offered: { cursor: true, other: true },
    reservePercent: 10,
  };
  assert.equal(chooseCursorPool(base).order[0], 'other');
  assert.equal(chooseCursorPool({ ...base, reserveByPool: { cursor: 2, other: 10 } }).order[0], 'cursor');
  const near = chooseCursorPool({
    ...base,
    headroom: { cursor: 8, other: 60 },
    reserveByPool: { cursor: 2, other: 10 },
  });
  assert.equal(near.order[0], 'other');
  assert.match(near.reason ?? '', /8%/);
});

test('pool choice does not claim below-reserve rejection after that reserve was released', () => {
  const choice = chooseCursorPool({
    tier: 'strong',
    headroom: { cursor: 50, other: 1 },
    offered: { cursor: true, other: false },
    reservePercent: 10,
    reserveByPool: { other: 0 },
  });
  assert.match(choice.reason ?? '', /没有能用的模型/);
  assert.doesNotMatch(choice.reason ?? '', /已用到保留线/);
});

const snapshot = (short: QuotaWindow): RuntimeSnapshot => ({
  id: 'fixture',
  provider: 'codex',
  label: 'Fixture',
  installed: true,
  status: 'ready',
  environment: 'native',
  models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['medium'] }],
  quota: {
    ...quota,
    source: 'synthetic',
    windows: [short, window(48 * hour, { id: 'week', label: 'Week', usedPercent: 20 })],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: iso(),
});
const burn = new Map([[burnKey('fixture', 'week'), { account: '', perHour: 0, periods: 3 }]]);
const wasting = (s: RuntimeSnapshot) => wastingAccounts([s], burn, settings, now);

test('background quota eligibility shares 24-hour and final-6-hour reserve rules', () => {
  assert.equal(wasting(snapshot(window(12 * hour, { usedPercent: 97 }))).length, 1);
  assert.equal(wasting(snapshot(window(hour, { usedPercent: 99.9 }))).length, 1);
  assert.equal(wasting(snapshot(window(25 * hour, { usedPercent: 97 }))).length, 0);
  assert.equal(wasting(snapshot(window(12 * hour, { usedPercent: 98 }))).length, 0);
  assert.equal(wasting(snapshot(window(hour, { usedPercent: 100 }))).length, 0);
});

test('background eligibility still checks other windows, freshness and account cooldown', () => {
  const s = snapshot(window(hour, { usedPercent: 99 }));
  assert.equal(wasting(s).length, 1);
  assert.equal(wasting({ ...s, quota: { ...s.quota, windows: [s.quota.windows[0], window(48 * hour)] } }).length, 0);
  assert.equal(wasting(snapshot(window(hour, { usedPercent: 99, observedAt: iso(-120_000) }))).length, 0);
  assert.equal(wasting({ ...s, availability: { reason: 'quota', observedAt: iso(), retryAt: iso(hour) } }).length, 0);
});

test('background session eligibility keeps exhaustion, refresh and long-window checks', () => {
  const short = window(3 * hour, { id: 'five_hour', durationMinutes: 300, usedPercent: 96 });
  assert.equal(wasting(snapshot(short)).length, 1);
  assert.equal(wasting(snapshot({ ...short, resetsAt: null, resetNotReported: true })).length, 0);
  assert.equal(wasting(snapshot({ ...short, usedPercent: 60, resetsAt: null, resetNotReported: true })).length, 1);
  for (const extra of [
    { usedPercent: 100 },
    { usedPercent: null },
    { observedAt: iso(-120_000) },
    { resetsAt: iso(-1) },
    { resetsAt: null },
  ])
    assert.equal(wasting(snapshot({ ...short, ...extra })).length, 0);
  const s = snapshot(short);
  s.quota.windows[1]!.usedPercent = 95;
  assert.equal(wasting(s).length, 0);
});
