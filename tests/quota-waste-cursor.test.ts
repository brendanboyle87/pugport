import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { burnKey, cursorGrantWindowId, QuotaHistory } from '../src/server/quota-history.ts';
import {
  creditWaste,
  cursorGrantWaste,
  wasteReason,
  wasteStep,
  wastingAccounts,
  windowWaste,
} from '../src/server/quota-waste.ts';
import { route, type RouteCapacity } from '../src/server/routing.ts';
import type { CursorCredits, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

// Synthetic snapshots and isolated test databases only; no provider, credential or real data directory.
const now = Date.parse('2026-10-12T12:00:00Z');
const day = 86_400_000;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'claude',
  routineProvider: 'claude',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/synthetic',
  maxConcurrentRuns: 2,
};
const input: RunInput = { prompt: 'Implement a parser', kind: 'general', projectPath: settings.defaultProjectPath };
const grant = (remainingUsd = 18, expiresAt: string | null = iso(5 * day)): CursorCredits['grants'][number] => ({
  name: 'Synthetic event',
  totalUsd: 20,
  remainingUsd,
  expiresAt,
});
function cursor(id = 'gift', grants = [grant()]): RuntimeSnapshot {
  return {
    id,
    provider: 'cursor',
    label: 'Cursor',
    environment: 'native',
    installed: true,
    status: 'ready',
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    models: [
      { id: 'composer-2.5', label: 'Composer', efforts: [], quotaPool: 'cursor' },
      { id: 'claude-sonnet-5', label: 'Sonnet', efforts: [], quotaPool: 'other' },
    ],
    refreshedAt: iso(),
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: iso(),
      windows: [
        { id: 'cursor', label: 'Cursor Models', modelPool: 'cursor', usedPercent: 50, resetsAt: iso(20 * day) },
        { id: 'other', label: 'Other Models', modelPool: 'other', usedPercent: 50, resetsAt: iso(20 * day) },
      ],
      cursorCredits: { balanceUsd: null, totalUsd: null, usedUsd: null, grants, onDemand: null },
    },
  };
}
function evidence(t: TestContext, snapshots: RuntimeSnapshot[], age = 20 * day) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const history = new QuotaHistory(db, () => now);
  history.observe(
    snapshots.map((s) => ({
      ...s,
      quota: {
        ...s.quota,
        observedAt: iso(-age),
        ...(s.quota.cursorCredits
          ? {
              cursorCredits: {
                ...s.quota.cursorCredits,
                grants: s.quota.cursorCredits.grants.map((g) => ({ ...g, remainingUsd: g.totalUsd })),
              },
            }
          : {}),
      },
    })),
  );
  history.observe(snapshots);
  return {
    db,
    history,
    capacity: { reservations: new Map(), settlingPools: new Set(), burn: history.burnRates() } satisfies RouteCapacity,
  };
}

test('pre-observation spending does not hide an idle grant as expiry approaches', (t) => {
  let clock = now;
  const gift = cursor('gift', [{ ...grant(17.74, iso(5.4 * day)), totalUsd: 50 }]);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const history = new QuotaHistory(db, () => clock);
  const read = (offset: number, remainingUsd = 17.74) => {
    clock = now + offset;
    gift.quota.observedAt = iso(offset);
    gift.quota.cursorCredits!.grants[0]!.remainingUsd = remainingUsd;
    history.observe([gift]);
    return cursorGrantWaste(gift, clock, history.burnRates())!;
  };
  assert.equal(read(0).percent, 0);
  assert.ok(read(1000).percent < wasteStep);
  assert.deepEqual(wastingAccounts([gift], history.burnRates(), settings, clock), []);
  const waste = read(3.4 * day);
  assert.ok(waste.percent >= wasteStep);
  assert.ok(Math.abs(waste.usd!.unused - (17.74 * (3.4 / 5.4)) / (1 + 3.4 / 5.4)) < 1e-9);
  const found = wastingAccounts([gift], history.burnRates(), settings, clock);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.reason, wasteReason('Cursor', waste, clock).replace('，先用它', ''));
  assert.match(found[0]!.reason, /赠金.*到期，还剩 \$18，按平时用量约 .* 会用不掉/);
  // A corrected balance below the initial used percentage must never create negative spending.
  assert.ok(read(3.5 * day, 18).usd!.unused <= (18 * (3.5 / 5.4)) / (1 + 3.5 / 5.4));
});

test('observed steady spending that finishes a partly spent grant predicts no waste', (t) => {
  let clock = now;
  const gift = cursor('gift', [{ ...grant(17.74, iso(5.4 * day)), totalUsd: 50 }]);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const history = new QuotaHistory(db, () => clock);
  history.observe([gift]);
  for (const days of [1, 2, 3]) {
    clock = now + days * day;
    gift.quota.observedAt = iso(days * day);
    gift.quota.cursorCredits!.grants[0]!.remainingUsd = 17.74 - days * 4;
    history.observe([gift]);
    assert.equal(cursorGrantWaste(gift, clock, history.burnRates())!.usd!.unused, 0);
    assert.deepEqual(wastingAccounts([gift], history.burnRates(), settings, clock), []);
  }
});

test('first used percentages persist across database close and reopen without being overwritten', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-grant-pace-'));
  const path = join(dir, 'history.sqlite');
  let db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const gift = cursor('gift', [{ ...grant(17.74, iso(2 * day)), totalUsd: 50 }]);
  const history = new QuotaHistory(db, () => now);
  history.observe([{ ...gift, quota: { ...gift.quota, observedAt: iso(-3.4 * day) } }]);
  gift.quota.cursorCredits!.grants[0]!.remainingUsd = 15;
  history.observe([gift]);
  const key = burnKey(gift.id, cursorGrantWindowId(gift.quota.cursorCredits!.grants[0]!));
  const initial = history.burnRates().get(key)!.current!;
  assert.ok(Math.abs(initial.firstUsed! - 64.52) < 1e-9);
  assert.equal(db.prepare("SELECT first_used FROM quota_periods WHERE window_id='cursor'").get()!.first_used, 50);
  const waste = cursorGrantWaste(gift, now, history.burnRates());
  db.close();
  db = new DatabaseSync(path);
  const reopened = new QuotaHistory(db, () => now);
  assert.deepEqual(reopened.burnRates().get(key)!.current, initial);
  reopened.observe([gift]);
  assert.deepEqual(reopened.burnRates().get(key)!.current, initial);
  assert.deepEqual(cursorGrantWaste(gift, now, reopened.burnRates()), waste);
});

test('legacy schema: grant rows take their peak as baseline, subscription windows stay NULL', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE quota_periods (id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL,
    provider TEXT NOT NULL, window_id TEXT NOT NULL, account TEXT NOT NULL, duration_minutes INTEGER,
    first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, resets_at INTEGER NOT NULL, peak REAL NOT NULL, ended_at INTEGER)`);
  const gift = cursor('gift', [{ ...grant(17.74, iso(2 * day)), totalUsd: 50 }]);
  const windowId = cursorGrantWindowId(gift.quota.cursorCredits!.grants[0]!);
  const insert = db.prepare(
    `INSERT INTO quota_periods(runtime_id,provider,window_id,account,first_at,last_at,resets_at,peak)
    VALUES(?,?,?,?,?,?,?,?)`,
  );
  insert.run(gift.id, 'cursor', windowId, '', now - 3.4 * day, now - 1000, now + 2 * day, 64.52);
  insert.run(gift.id, 'cursor', 'cursor', '', now - 3.4 * day, now - 1000, now + 2 * day, 40);
  const history = new QuotaHistory(db, () => now);
  const baseline = (id: string) =>
    (db.prepare('SELECT first_used FROM quota_periods WHERE window_id=?').get(id) as { first_used: number | null })
      .first_used;
  assert.equal(baseline(windowId), 64.52);
  assert.equal(baseline('cursor'), null);
  assert.equal(history.burnRates().get(burnKey(gift.id, windowId))!.current!.firstUsed, 64.52);
  // Idle since the first reading 3.4 days ago, two days before expiry: the leftover counts.
  assert.ok(cursorGrantWaste(gift, now, history.burnRates())!.percent >= wasteStep);
  // The one-time backfill never runs again.
  history.observe([gift]);
  assert.doesNotThrow(() => new QuotaHistory(db, () => now));
  assert.equal(baseline(windowId), 64.52);
});
test('slow expiring Cursor grants match API credit damping, win routing and give a Chinese reason', (t) => {
  const gift = cursor();
  const plain = cursor('plain', []);
  const { capacity } = evidence(t, [gift, plain]);
  const waste = cursorGrantWaste(gift, now, capacity.burn)!;
  const api = apiBudgetView(
    apiBudgetPolicy({ limitUsd: 20, expiresAt: iso(5 * day) }, undefined, iso(-20 * day)),
    2,
    0,
    0,
    now,
  );
  assert.deepEqual(waste, creditWaste(api, now));
  assert.equal(waste.what, '赠金');
  assert.equal(
    wasteReason('Cursor', waste, now),
    'Cursor 赠金 5 天后到期，还剩 $18，按平时用量约 $7.78 会用不掉，先用它',
  );
  assert.equal(windowWaste(gift, gift.quota.windows, capacity.burn, now)!.percent, 0);
  for (const pool of [
    [plain, gift],
    [gift, plain],
  ]) {
    const chosen = route(input, pool, settings, capacity, now);
    assert.equal(chosen.runtimeId, gift.id);
    assert.ok(chosen.reasons.includes(wasteReason('Cursor', waste, now)));
  }
  const found = wastingAccounts([plain, gift], capacity.burn, settings, now);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.runtimeId, gift.id);
  assert.equal(found[0]!.model, undefined);
  assert.equal(found[0]!.reason, wasteReason('Cursor', waste, now).replace('，先用它', ''));
});

test('fast consumption predicts no unused grant and does not enter waste ranking', (t) => {
  const gift = cursor('gift', [grant(2)]);
  const { capacity } = evidence(t, [gift]);
  assert.equal(cursorGrantWaste(gift, now, capacity.burn)!.usd!.unused, 0);
  assert.deepEqual(wastingAccounts([gift], capacity.burn, settings, now), []);
});

test('expired, undated, empty and invalid grants never count', (t) => {
  for (const row of [
    grant(18, iso(-day)),
    grant(18, iso()),
    grant(18, null),
    grant(18, 'invalid'),
    grant(0),
    { ...grant(), totalUsd: null },
    { ...grant(), totalUsd: 0 },
    grant(21),
    grant(NaN),
  ]) {
    const gift = cursor('gift', [row]);
    const { capacity } = evidence(t, [gift]);
    assert.equal(cursorGrantWaste(gift, now, capacity.burn), undefined);
    assert.deepEqual(wastingAccounts([gift], capacity.burn, settings, now), []);
  }
});

test('multiple live grants sum dollars and percentages and use the earliest expiry', (t) => {
  const gift = cursor('gift', [
    grant(18, iso(10 * day)),
    { ...grant(10), name: 'Another event', totalUsd: 10 },
    grant(18, null),
    grant(18, iso(-day)),
  ]);
  const { capacity } = evidence(t, [gift]);
  const waste = cursorGrantWaste(gift, now, capacity.burn)!;
  const unused = (17 * (20 / 30)) / (1 + 20 / 30) + (10 * (20 / 25)) / (1 + 20 / 25);
  assert.ok(Math.abs(waste.usd!.unused - unused) < 1e-9);
  assert.equal(waste.usd!.left, 28);
  assert.ok(Math.abs(waste.percent - (unused / 30) * 100) < 1e-9);
  assert.equal(waste.resetAt, now + 5 * day);
});

test('history survives reopening and keeps grants out of subscription utilization', (t) => {
  const gift = cursor();
  const plain = cursor('gift', []);
  const { db, history, capacity } = evidence(t, [gift]);
  const { history: ordinary } = evidence(t, [plain]);
  assert.deepEqual(history.summary(), ordinary.summary());
  const reopened = new QuotaHistory(db, () => now);
  assert.deepEqual(cursorGrantWaste(gift, now, reopened.burnRates()), cursorGrantWaste(gift, now, capacity.burn));
  const grantsOnly = { ...gift, id: 'only', quota: { ...gift.quota, windows: [] } };
  const { history: only } = evidence(t, [grantsOnly]);
  assert.equal(only.summary(), undefined);
  assert.ok(cursorGrantWaste(grantsOnly, now, only.burnRates())!.percent > 10);
  assert.deepEqual(wastingAccounts([grantsOnly], only.burnRates(), settings, now), []);
  const unlimited = { ...grantsOnly, quota: { ...grantsOnly.quota, unlimited: true } };
  assert.equal(wastingAccounts([unlimited], only.burnRates(), settings, now)[0]!.model, undefined);
});

test('thin evidence and a different login never borrow an older grant lifetime', (t) => {
  const gift = { ...cursor(), accountFingerprint: 'synthetic-a' };
  const { capacity } = evidence(t, [gift]);
  assert.ok(cursorGrantWaste(gift, now, capacity.burn)!.percent > 10);
  assert.equal(cursorGrantWaste(gift, now)!.percent, 0);
  assert.equal(cursorGrantWaste({ ...gift, accountFingerprint: 'synthetic-b' }, now, capacity.burn)!.percent, 0);
  const fresh = { ...gift, quota: { ...gift.quota, observedAt: iso(-1000) } };
  assert.ok(cursorGrantWaste(fresh, now)!.percent < 10);
  assert.deepEqual(wastingAccounts([fresh], undefined, settings, now), []);
  const { capacity: changed } = evidence(t, [
    {
      ...gift,
      quota: { ...gift.quota, cursorCredits: { ...gift.quota.cursorCredits!, grants: [grant(18, iso(6 * day))] } },
    },
  ]);
  assert.equal(cursorGrantWaste(gift, now, changed.burn)!.percent, 0);
  const { history: subscription } = evidence(t, [cursor('gift', [])]);
  subscription.observe([gift]);
  assert.equal(cursorGrantWaste(gift, now, subscription.burnRates())!.percent, 0);
});

test('stale, future or missing readings and unchecked executors cannot contribute grant waste', (t) => {
  const gift = cursor();
  const plain = cursor('plain', []);
  const { capacity } = evidence(t, [gift, plain]);
  for (const observedAt of [iso(-180_000), iso(-day), iso(day), null]) {
    const stale = { ...gift, quota: { ...gift.quota, observedAt } };
    assert.deepEqual(wastingAccounts([stale], capacity.burn, settings, now), []);
    assert.equal(route(input, [stale, plain], settings, capacity, now).runtimeId, plain.id);
  }
  const allowed = { ...settings, excludedExecutors: ['gift'] };
  assert.deepEqual(wastingAccounts([gift], capacity.burn, allowed, now), []);
  assert.equal(route(input, [gift, plain], allowed, capacity, now).runtimeId, plain.id);
});

test('grant waste keeps executor, availability, reserve and in-flight checks', (t) => {
  const gift = cursor();
  const plain = cursor('plain', []);
  const { capacity } = evidence(t, [gift, plain]);
  for (const patch of [
    { installed: false },
    { status: 'auth-required' as const },
    { capabilities: { ...gift.capabilities, execute: false } },
    { availability: { reason: 'quota' as const, observedAt: iso(), retryAt: iso(day) } },
    { quota: { ...gift.quota, windows: gift.quota.windows.map((w) => ({ ...w, usedPercent: 90 })) } },
    { quota: { ...gift.quota, windows: gift.quota.windows.map((w) => ({ ...w, observedAt: iso(-day) })) } },
    { quota: { ...gift.quota, windows: gift.quota.windows.map((w) => ({ ...w, resetsAt: iso(-day) })) } },
  ]) {
    const blocked = { ...gift, ...patch };
    assert.deepEqual(wastingAccounts([blocked], capacity.burn, settings, now), []);
    assert.equal(route(input, [blocked, plain], settings, capacity, now).runtimeId, plain.id);
  }
  const full = { ...capacity, reservations: new Map([['runtime:gift', 5]]) };
  assert.equal(route(input, [gift, plain], settings, full, now).runtimeId, plain.id);
});

test('account-wide grants leave pool selection and routing pins, rules and opt-out intact', (t) => {
  const gift = cursor();
  const plain = cursor('plain', []);
  const { capacity } = evidence(t, [gift, plain]);
  for (const pool of ['cursor', 'other'] as const) {
    const oneLow = {
      ...gift,
      quota: {
        ...gift.quota,
        windows: gift.quota.windows.map((w) => (w.modelPool === pool ? { ...w, usedPercent: 100 } : w)),
      },
    };
    const found = wastingAccounts([oneLow], capacity.burn, settings, now);
    assert.equal(found[0]!.model, undefined);
    assert.equal(route(input, [plain, oneLow], settings, capacity, now).runtimeId, gift.id);
  }
  assert.equal(route({ ...input, runtimeId: plain.id }, [gift, plain], settings, capacity, now).runtimeId, plain.id);
  assert.equal(
    route(
      { ...input, continuationRunId: 'synthetic' },
      [gift, plain],
      settings,
      { ...capacity, continuing: [{ runtimeId: plain.id }] },
      now,
    ).runtimeId,
    plain.id,
  );
  const off = { ...input, schedule: { preferExpiringQuota: false } };
  assert.deepEqual(
    route(off, [plain, gift], settings, capacity, now),
    route(off, [plain, cursor('gift', [])], settings, capacity, now),
  );
  const claude: RuntimeSnapshot = {
    ...plain,
    id: 'claude',
    provider: 'claude',
    label: 'Claude',
    models: [{ id: 'sonnet', label: 'Sonnet', efforts: [] }],
  };
  assert.equal(
    route(
      input,
      [gift, claude],
      { ...settings, routePreferencesEnabled: true, routePolicy: { general: ['claude'] } },
      capacity,
      now,
    ).runtimeId,
    claude.id,
  );
});

test('larger window waste wins and retains its pool-specific model', (t) => {
  const gift = cursor();
  gift.quota.windows = gift.quota.windows.map((w) => ({ ...w, usedPercent: 1, resetsAt: iso(day) }));
  const { capacity } = evidence(t, [gift]);
  const found = wastingAccounts([gift], capacity.burn, settings, now);
  assert.ok(found[0]!.waste.percent > cursorGrantWaste(gift, now, capacity.burn)!.percent);
  assert.equal(found[0]!.model, 'composer-2.5');
  assert.equal(found[0]!.waste.usd, undefined);
});
