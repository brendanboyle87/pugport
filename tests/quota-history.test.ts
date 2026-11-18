import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { QuotaHistory } from '../src/server/quota-history.ts';
import type { Provider, QuotaWindow, RuntimeSnapshot } from '../src/shared/types.ts';

// Synthetic accounts and readings only; no CLI, provider or real data folder is involved.
const epoch = Date.parse('2026-09-01T00:00:00Z');
const hour = 3_600_000;
const day = 24 * hour;
const week = 7 * day;
const iso = (at: number) => new Date(epoch + at).toISOString();

type Reading = { id?: string; used: number | null; resetsAt: number | null; minutes?: number; family?: 'opus' };
function snapshot(
  at: number,
  readings: Reading[],
  options: {
    id?: string;
    provider?: Provider;
    account?: string;
    percentSource?: 'implicit-zero' | 'cli-reported';
  } = {},
): RuntimeSnapshot {
  const windows: QuotaWindow[] = readings.map((reading) => ({
    id: reading.id ?? 'weekly',
    label: reading.id ?? 'weekly',
    usedPercent: reading.used,
    resetsAt: reading.resetsAt === null ? null : iso(reading.resetsAt),
    durationMinutes: reading.minutes ?? 10080,
    ...(reading.family ? { modelFamily: reading.family } : {}),
  }));
  return {
    id: options.id ?? 'codex-a',
    provider: options.provider ?? 'codex',
    label: 'Fixture',
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [],
    ...(options.account ? { accountFingerprint: options.account } : {}),
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(at),
      windows,
      ...(options.percentSource
        ? { grokBilling: { isUnifiedBillingUser: true, percentSource: options.percentSource } }
        : {}),
    },
    capabilities: { execute: true, resume: false, cancel: false, approvals: false },
    refreshedAt: iso(at),
  };
}
/** A history over an in-memory database whose clock the test moves, counting every write it makes. */
function fixture(db = new DatabaseSync(':memory:')) {
  const clock = { now: epoch };
  const counter = { writes: 0 };
  const counted = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) counter.writes++;
      return db.prepare(sql);
    },
  } as unknown as DatabaseSync;
  const history = new QuotaHistory(counted, () => clock.now);
  const observe = (at: number, readings: Reading[], options?: Parameters<typeof snapshot>[2]) => {
    clock.now = Math.max(clock.now, epoch + at);
    history.observe([snapshot(at, readings, options)]);
  };
  const rows = () =>
    db.prepare('SELECT window_id, peak, ended_at FROM quota_periods ORDER BY id').all() as Array<{
      window_id: string;
      peak: number;
      ended_at: number | null;
    }>;
  return { db, clock, counter, history, observe, rows };
}

test('tracks the peak of a period and closes it when its reset passes', () => {
  const { history, observe, rows, clock } = fixture();
  observe(0, [{ used: 10, resetsAt: week }]);
  assert.deepEqual(history.summary(), {
    basis: 'current',
    percent: 10,
    accounts: 1,
    periods: 0,
    partial: false,
    byProvider: [{ provider: 'codex', basis: 'current', percent: 10, accounts: 1, periods: 0, partial: false }],
    since: iso(0),
  });
  observe(3 * day, [{ used: 40, resetsAt: week }]);
  // A lower reading inside the same period never lowers what was already used.
  observe(5 * day, [{ used: 35, resetsAt: week }]);
  assert.equal(history.summary()!.percent, 40);
  observe(week + hour, [{ used: 5, resetsAt: 2 * week }]);
  assert.deepEqual(
    rows().map((row) => [row.peak, row.ended_at === null ? null : row.ended_at - epoch]),
    [
      [40, week],
      [5, null],
    ],
  );
  const summary = history.summary()!;
  assert.equal(summary.basis, 'ended');
  assert.equal(summary.percent, 40);
  assert.equal(summary.periods, 1);
  assert.equal(summary.partial, false, 'five of seven days seen is enough');
  // PugPort was closed when the second period reset: it still counts as ended, (40 + 5) / 2.
  clock.now = epoch + 2 * week + day;
  assert.deepEqual([history.summary()!.periods, history.summary()!.percent], [2, 23]);
  // Thirty days after they ended, neither counts any more.
  clock.now = epoch + 2 * week + 31 * day;
  assert.equal(history.summary(), undefined);
});

test('repeated readings write nothing until the peak, the period or the slow last-seen save changes', () => {
  const { counter, observe } = fixture();
  observe(0, [{ used: 10, resetsAt: week }]);
  const afterFirst = counter.writes;
  for (let minute = 1; minute < 15; minute++) observe(minute * 60_000, [{ used: 10, resetsAt: week }]);
  assert.equal(counter.writes, afterFirst, 'unchanged readings stay in memory');
  observe(16 * 60_000, [{ used: 10, resetsAt: week }]);
  assert.equal(counter.writes, afterFirst + 1, 'last-seen time is saved every fifteen minutes');
  observe(17 * 60_000, [{ used: 11, resetsAt: week }]);
  assert.equal(counter.writes, afterFirst + 2, 'a new peak is saved at once');
});

test('skips inferred, unknown, out-of-range and stale readings', () => {
  const { history, observe, rows } = fixture();
  observe(0, [{ used: 0, resetsAt: week }], { id: 'grok-a', provider: 'grok', percentSource: 'implicit-zero' });
  observe(0, [{ used: null, resetsAt: week }]);
  observe(0, [{ used: 120, resetsAt: week }]);
  observe(day, [{ used: 50, resetsAt: day - hour }], { id: 'codex-b' });
  observe(day, [{ used: 50, resetsAt: null }], { id: 'codex-c' });
  observe(0, [{ used: 30, resetsAt: week }], { id: 'pi-api', provider: 'pi' });
  const unknown = snapshot(0, [{ used: 30, resetsAt: week }], { id: 'codex-d' });
  unknown.quota.status = 'unknown';
  history.observe([unknown]);
  assert.deepEqual(rows(), []);
  assert.equal(history.summary(), undefined);
  observe(0, [{ used: 52, resetsAt: week }], { id: 'grok-a', provider: 'grok', percentSource: 'cli-reported' });
  assert.equal(rows().length, 1, 'a reported Grok share is recorded');
});

test('Claude: only shared limits count, the weekly one binds, and reset jitter is the same period', () => {
  const { history, observe, rows } = fixture();
  const claude = { id: 'claude-a', provider: 'claude' as const };
  for (const [at, fiveHour, weekly, opus] of [
    [0, 20, 30, 90],
    [2 * hour, 60, 45, 95],
  ])
    observe(
      at,
      [
        // Claude reports the same reset with a different fraction of a second on every read.
        { id: 'five_hour', used: fiveHour, resetsAt: 5 * hour + at / 1000, minutes: 300 },
        { id: 'seven_day', used: weekly, resetsAt: week + at / 1000 },
        { id: 'seven_day_opus', used: opus, resetsAt: week, family: 'opus' },
      ],
      claude,
    );
  assert.deepEqual(
    rows().map((row) => [row.window_id, row.peak]),
    [
      ['five_hour', 60],
      ['seven_day', 45],
    ],
  );
  assert.equal(history.summary()!.percent, 45, 'the weekly window binds, not the busier 5-hour one');
  // The 5-hour period ends; the weekly one is still in progress and is still what the card shows.
  observe(6 * hour, [{ id: 'five_hour', used: 0, resetsAt: 11 * hour, minutes: 300 }], claude);
  assert.equal(rows().length, 3);
  assert.deepEqual([history.summary()!.basis, history.summary()!.percent], ['current', 45]);
});

test('an unused window that keeps sliding its reset forward closes one empty period per full length', () => {
  const { history, observe, rows } = fixture();
  // Codex reports an unstarted 5-hour window as resetting five hours from now on every read.
  for (let at = 0; at <= 6 * hour; at += 5 * 60_000)
    observe(at, [{ id: 'codex:primary', used: 0, resetsAt: at + 5 * hour, minutes: 300 }]);
  assert.deepEqual(
    rows().map((row) => [row.peak, row.ended_at === null ? null : row.ended_at - epoch]),
    [
      [0, 5 * hour],
      [0, null],
    ],
  );
  assert.equal(history.summary()!.percent, 0);
  assert.equal(history.summary()!.partial, false);
});

test('an early reset (reset moved and usage fell) starts a new period; a moved reset alone does not', () => {
  const { observe, rows } = fixture();
  observe(0, [{ used: 70, resetsAt: week }]);
  observe(day, [{ used: 75, resetsAt: week + 2 * hour }]);
  assert.equal(rows().length, 1);
  observe(2 * day, [{ used: 3, resetsAt: 2 * day + week }]);
  assert.deepEqual(
    rows().map((row) => [row.peak, row.ended_at === null ? null : row.ended_at - epoch]),
    [
      [75, 2 * day],
      [3, null],
    ],
  );
});

test('another login on the same card ends the old period at its last reading', () => {
  const { observe, rows } = fixture();
  observe(0, [{ used: 50, resetsAt: week }], { account: 'synthetic-one' });
  observe(hour, [{ used: 55, resetsAt: week }], { account: 'synthetic-one' });
  observe(2 * hour, [{ used: 10, resetsAt: 3 * day }], { account: 'synthetic-two' });
  assert.deepEqual(
    rows().map((row) => [row.peak, row.ended_at === null ? null : row.ended_at - epoch]),
    [
      [55, hour],
      [10, null],
    ],
  );
});

test('a restart continues the open period, and old rows are pruned after 120 days', () => {
  const first = fixture();
  first.observe(0, [{ used: 40, resetsAt: week }]);
  const second = fixture(first.db);
  second.observe(day, [{ used: 60, resetsAt: week }]);
  assert.deepEqual(
    second.rows().map((row) => row.peak),
    [60],
    'the same period, not a second one',
  );
  const third = fixture(first.db);
  third.clock.now = epoch + 130 * day;
  third.observe(130 * day, [{ used: 1, resetsAt: 131 * day }], { id: 'codex-b' });
  // Construction prunes too.
  const fourth = new QuotaHistory(first.db, () => epoch + 130 * day);
  assert.equal(fourth.summary()!.accounts, 1);
  assert.deepEqual(
    third.rows().map((row) => row.peak),
    [1],
  );
});

test('utilization averages each account over its ended periods, then accounts, and flags thin coverage', () => {
  const { history, observe, clock } = fixture();
  // Codex A: two full weeks at 80% and 100%.
  for (const [start, peak] of [
    [0, 80],
    [week, 100],
  ]) {
    observe(start + hour, [{ used: 10, resetsAt: start + week }]);
    observe(start + week - hour, [{ used: peak, resetsAt: start + week }]);
  }
  // Claude B: one week at 60%, seen from its first day.
  const claude = { id: 'claude-b', provider: 'claude' as const };
  observe(hour, [{ id: 'seven_day', used: 5, resetsAt: week }], claude);
  observe(week - 2 * hour, [{ id: 'seven_day', used: 60, resetsAt: week }], claude);
  clock.now = epoch + 2 * week + hour;
  const summary = history.summary()!;
  assert.equal(summary.basis, 'ended');
  assert.equal(summary.percent, 75, 'accounts weigh the same: (90 + 60) / 2');
  assert.equal(summary.periods, 3);
  assert.equal(summary.accounts, 2);
  assert.equal(summary.partial, false);
  assert.deepEqual(
    summary.byProvider.map((item) => [item.provider, item.percent, item.periods]),
    [
      ['codex', 90, 2],
      ['claude', 60, 1],
    ],
  );
  // Grok C was only seen in the last hours of its week.
  const thin = fixture();
  thin.observe(week - 3 * hour, [{ used: 70, resetsAt: week }], { id: 'grok-c', provider: 'grok' });
  thin.observe(week - hour, [{ used: 72, resetsAt: week }], { id: 'grok-c', provider: 'grok' });
  thin.clock.now = epoch + week + hour;
  assert.equal(thin.history.summary()!.percent, 72);
  assert.equal(thin.history.summary()!.partial, true);
});

test('a failed write never breaks the refresh that reported it', () => {
  const db = new DatabaseSync(':memory:');
  const history = new QuotaHistory(db, () => epoch);
  db.close();
  assert.doesNotThrow(() => history.observe([snapshot(0, [{ used: 10, resetsAt: week }])]));
});
