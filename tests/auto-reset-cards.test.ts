import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  autoResetCard,
  afterReset,
  AutoResetCards,
  cardRefreshDue,
  type AutoResetRecord,
} from '../src/server/auto-reset-cards.ts';
import { Controller } from '../src/server/controller.ts';
import { route } from '../src/server/routing.ts';
import type { ResetCredits, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const epoch = Date.parse('2026-10-11T12:00:00Z');
const hour = 3_600_000;
const minute = 60_000;
const iso = (offset = 0) => new Date(epoch + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/synthetic',
  maxConcurrentRuns: 0,
};
const input: RunInput = { prompt: '实现解析器', projectPath: 'C:/synthetic', kind: 'general' };
function snapshot(used = 100, expiry = 48 * hour): RuntimeSnapshot {
  return {
    id: 'fixture',
    label: '测试账号',
    provider: 'codex',
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    accountFingerprint: 'synthetic-account',
    models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: iso(),
      windows: [{ id: 'weekly', label: '周额度', usedPercent: used, resetsAt: iso(7 * 24 * hour) }],
      resetCredits: {
        availableCount: 2,
        source: 'synthetic',
        observedAt: iso(),
        details: [
          { key: 'b'.repeat(64), kind: 'full', status: 'available', grantedAt: null, expiresAt: iso(expiry + hour) },
          { key: 'a'.repeat(64), kind: 'full', status: 'available', grantedAt: null, expiresAt: iso(expiry) },
        ],
      },
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(),
  };
}
const on = { ...settings, autoUseResetCards: true };

test('automatic use is absent/off by default and only the two strict thresholds qualify', () => {
  assert.match(
    readFileSync(new URL('../src/server/controller.ts', import.meta.url), 'utf8'),
    /autoUseResetCards: false/,
  );
  for (const config of [settings, { ...settings, autoUseResetCards: false }])
    assert.equal(autoResetCard(snapshot(100, hour), config, epoch, true), undefined);
  assert.equal(autoResetCard(snapshot(), on, epoch), undefined);
  assert.ok(autoResetCard(snapshot(), on, epoch, true));
  assert.equal(autoResetCard(snapshot(89), on, epoch, true), undefined);
  assert.ok(autoResetCard(snapshot(90), on, epoch, true), 'waiting work redeems at the 10% reserve line');
  // Until its last ten minutes a card waits, so the account's usage is spent down first; then any use at all makes
  // the card worth more than letting it expire.
  assert.equal(autoResetCard(snapshot(99, 24 * hour), on, epoch), undefined);
  assert.equal(autoResetCard(snapshot(99, 10 * minute + 1), on, epoch), undefined);
  assert.ok(autoResetCard(snapshot(1, 10 * minute), on, epoch), 'even 1% used beats letting the card expire');
  assert.equal(autoResetCard(snapshot(0, 10 * minute), on, epoch), undefined, 'nothing used, nothing to gain');
});

test('a card in its last fifteen minutes is read again every minute until it is used or gone', () => {
  const readMinuteAgo = (expiry: number) => ({ ...snapshot(50, expiry), refreshedAt: iso(-minute) });
  assert.equal(cardRefreshDue(readMinuteAgo(15 * minute + 1), epoch), false);
  assert.equal(cardRefreshDue(readMinuteAgo(15 * minute), epoch), true);
  assert.equal(cardRefreshDue(readMinuteAgo(0), epoch), false, 'already expired');
  const fresh = snapshot(50, 5 * minute);
  fresh.refreshedAt = iso(-30_000);
  assert.equal(cardRefreshDue(fresh, epoch), false, 'read less than a minute ago');
});

test('only fresh native subscription readings and usable known-expiry cards qualify, soonest first', () => {
  assert.equal(autoResetCard(snapshot(), on, epoch, true)?.key, 'a'.repeat(64));
  for (const patch of [
    { status: 'consumed' },
    { status: 'unknown' },
    { kind: 'unknown' },
    { expiresAt: null },
    { expiresAt: iso() },
    { expiresAt: 'invalid' },
    { key: undefined },
  ]) {
    const value = snapshot();
    value.quota.resetCredits!.details = [
      { ...value.quota.resetCredits!.details![0]!, ...patch } as NonNullable<ResetCredits['details']>[number],
    ];
    assert.equal(autoResetCard(value, on, epoch, true), undefined);
  }
  for (const patch of [
    { provider: 'claude' },
    { authMode: 'apiKey' },
    { status: 'auth-required' },
    { environment: 'wsl' },
    { accountFingerprint: undefined },
  ])
    assert.equal(autoResetCard({ ...snapshot(), ...patch } as RuntimeSnapshot, on, epoch, true), undefined);
  const value = snapshot();
  value.quota.observedAt = iso(-181_000);
  assert.equal(autoResetCard(value, on, epoch, true), undefined);
  value.quota.observedAt = iso();
  value.quota.windows[0]!.usedPercent = null;
  assert.equal(autoResetCard(value, on, epoch, true), undefined);
  assert.equal(afterReset(value).quota.windows[0]!.usedPercent, null);
  value.quota.windows[0]!.usedPercent = NaN;
  assert.ok(Number.isNaN(afterReset(value).quota.windows[0]!.usedPercent));
});

test('per-account concurrency latch survives restart and unlocks only on a later fresh quota and card read', async () => {
  let now = epoch;
  let saved = '';
  const records = {};
  const state = new AutoResetCards(
    records,
    () => {
      saved = JSON.stringify(records);
    },
    () => now,
  );
  let release!: () => void;
  let calls = 0;
  const value = snapshot();
  const consume = async () => {
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { outcome: 'reset' };
  };
  const first = state.use(value, 'first', iso(20 * hour), consume);
  assert.equal(await state.use({ ...value, id: 'alias' }, 'second', iso(21 * hour), consume), false);
  const restarted = new AutoResetCards(
    JSON.parse(saved),
    () => {},
    () => now,
  );
  assert.equal(await restarted.use(value, 'second', iso(hour), consume), false);
  release();
  await first;
  assert.match(state.records[value.accountFingerprint!]!.notes[0]!, /已自动用掉 1 张重置卡（原本 20 小时后到期）/);
  now += 1000;
  state.observe(value, now);
  assert.equal(await state.use(value, 'second', iso(hour), consume), false);
  value.quota.observedAt = iso(1000);
  value.quota.resetCredits!.observedAt = iso(1000);
  state.observe(value, epoch - 1);
  assert.equal(await state.use(value, 'second', iso(hour), consume), false);
  state.observe(value, now);
  assert.equal(await state.use(value, 'first', iso(hour), consume), false);
  assert.equal(
    await state.use(value, 'second', iso(hour), async () => {
      calls++;
      return { outcome: 'reset' };
    }),
    true,
  );
  assert.equal(calls, 2);
});

test('failed or no-op redemption never claims a card was used and remains latched', async () => {
  for (const outcome of ['nothingToReset', 'noCredit', 'error']) {
    const state = new AutoResetCards(
      {},
      () => {},
      () => epoch,
    );
    await state.use(snapshot(), 'first', iso(hour), async () => {
      if (outcome === 'error') throw Error('synthetic failure');
      return { outcome };
    });
    assert.doesNotMatch(state.records['synthetic-account']!.notes.join(''), /已自动用掉/);
    assert.equal(await state.use(snapshot(), 'second', iso(hour), async () => ({ outcome: 'reset' })), false);
  }
});

test('a read started during redemption cannot unlock it, and quota plus card readings must both be newer', async () => {
  let now = epoch;
  const state = new AutoResetCards(
    {},
    () => {},
    () => now,
  );
  const value = snapshot();
  let release!: () => void;
  const pending = state.use(value, 'first', iso(hour), async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { outcome: 'reset' };
  });
  const record = state.records[value.accountFingerprint!]!;
  now += 1000;
  const fresh = snapshot();
  fresh.quota.observedAt = iso(1000);
  fresh.quota.resetCredits!.observedAt = iso(1000);
  state.observe(fresh, now);
  assert.equal(record.waitingForQuota, true);
  now += 1000;
  release();
  await pending;
  assert.equal(record.finishedAt, epoch + 2000);
  now += 1000;
  fresh.quota.observedAt = iso(3000);
  fresh.quota.resetCredits!.observedAt = iso(3000);
  for (const change of ['read-before-finish', 'quota-old', 'cards-old', 'unknown', 'another-account']) {
    const reading = structuredClone(fresh);
    if (change === 'quota-old') reading.quota.observedAt = iso(2000);
    if (change === 'cards-old') reading.quota.resetCredits!.observedAt = iso(2000);
    if (change === 'unknown') reading.quota.status = 'unknown';
    if (change === 'another-account') reading.accountFingerprint = 'other';
    state.observe(reading, change === 'read-before-finish' ? epoch + 1000 : now);
    assert.equal(record.waitingForQuota, true, change);
  }
  state.observe(fresh, now);
  assert.equal(record.waitingForQuota, false);
  let calls = 0;
  assert.equal(
    await state.use(value, 'second', iso(hour), async () => {
      calls++;
      return { outcome: 'reset' };
    }),
    true,
  );
  assert.equal(calls, 1);
});

test('account latches are independent while aliases share the same latch', async () => {
  const state = new AutoResetCards(
    {},
    () => {},
    () => epoch,
  );
  const calls: string[] = [];
  const use = (value: RuntimeSnapshot, key: string) =>
    state.use(value, key, iso(hour), async () => {
      calls.push(value.accountFingerprint!);
      return { outcome: 'reset' };
    });
  assert.deepEqual(
    await Promise.all([
      use(snapshot(), 'first'),
      use({ ...snapshot(), id: 'alias' }, 'second'),
      use({ ...snapshot(), id: 'other', accountFingerprint: 'other-account' }, 'third'),
    ]),
    [true, false, true],
  );
  assert.deepEqual(calls, ['synthetic-account', 'other-account']);
});

test('past reset windows, stale card reports and quota errors cannot authorize an automatic use', () => {
  for (const change of [
    'past-window',
    'unknown-quota',
    'stale-card',
    'future-card-report',
    'stale-window',
    'invalid-usage',
  ]) {
    const value = snapshot(100, hour);
    if (change === 'past-window') value.quota.windows[0]!.resetsAt = iso();
    if (change === 'unknown-quota') value.quota.status = 'error';
    if (change === 'stale-card') value.quota.resetCredits!.observedAt = iso(-180_000);
    if (change === 'future-card-report') value.quota.resetCredits!.observedAt = iso(1);
    if (change === 'stale-window') value.quota.windows[0]!.observedAt = iso(-180_000);
    if (change === 'invalid-usage') value.quota.windows[0]!.usedPercent = 101;
    assert.equal(autoResetCard(value, on, epoch, true), undefined, change);
  }
  const value = snapshot(10, 48 * hour);
  value.availability = { reason: 'quota', observedAt: iso() };
  assert.equal(
    autoResetCard(value, on, epoch, true),
    undefined,
    'a quota error alone is not an exhausted resettable window',
  );
  value.quota.windows.push({ id: 'five-hour', label: '5 小时', usedPercent: 100, resetsAt: iso(hour) });
  assert.ok(autoResetCard(value, on, epoch, true));
});

function controllerFixture(value = snapshot()) {
  const controller = Object.create(Controller.prototype) as Controller;
  let now = epoch;
  const state = new AutoResetCards(
    {},
    () => {},
    () => now,
  );
  const calls: string[] = [];
  let quotaAtConsume = value.quota;
  let beforeConsume = () => {};
  const targets = [value].map((s) => ({
    id: s.id,
    provider: s.provider,
    label: s.label,
    enabled: true,
    environment: s.environment,
    command: 'synthetic',
  }));
  Object.assign(controller, {
    settings: { ...settings },
    targets,
    snapshots: [value],
    active: new Map(),
    resetRedemptions: new Set(),
    autoResetCards: state,
    clock: () => now,
    nativeLoginPending: () => false,
    assertAvailableRuntime: () => {},
    identityGuard: (_target: unknown, s: RuntimeSnapshot) => s,
    accountHealth: { apply: (s: RuntimeSnapshot) => s },
    freeHealth: { apply: (s: RuntimeSnapshot) => s, failure: () => {}, clear: () => {} },
    cooldown: { apply: (s: RuntimeSnapshot) => s },
    store: { run: () => undefined },
    broadcast: () => {},
    routeCapacity: () => ({ reservations: new Map(), settlingPools: new Set() }),
    redeemReset: async (
      _id: string,
      key: string,
      _identity: string,
      authorize: (quota: RuntimeSnapshot['quota']) => void,
    ) => {
      beforeConsume();
      authorize(quotaAtConsume);
      calls.push(key);
      return { outcome: 'reset' };
    },
  });
  return {
    controller,
    state,
    calls,
    targets,
    setNow: (at: number) => {
      now = at;
    },
    trigger: (request?: RunInput) =>
      (controller as unknown as { autoReset(input?: RunInput): Promise<boolean> }).autoReset(request),
    setConsumeQuota: (quota: RuntimeSnapshot['quota']) => {
      quotaAtConsume = quota;
    },
    beforeConsume: (fn: () => void) => {
      beforeConsume = fn;
    },
  };
}

test('controller never redeems while disabled; enabled exhausted account needs a routed waiting request', async () => {
  const f = controllerFixture();
  await f.trigger(input);
  assert.equal(f.calls.length, 0);
  f.controller.settings.autoUseResetCards = true;
  await f.trigger();
  assert.equal(f.calls.length, 0);
  await f.trigger(input);
  assert.deepEqual(f.calls, ['a'.repeat(64)]);
  await f.trigger(input);
  assert.equal(f.calls.length, 1);
});

test('controller expiry case needs no waiting work and chooses the soonest card', async () => {
  const f = controllerFixture(snapshot(60, 10 * minute));
  f.controller.settings.autoUseResetCards = true;
  await f.trigger();
  assert.deepEqual(f.calls, ['a'.repeat(64)]);
});

test('a card in its last minutes is used even while the account runs a task; earlier it waits', async () => {
  for (const [expiry, used] of [
    [10 * minute, true],
    [hour, false],
  ] as const) {
    const f = controllerFixture(snapshot(60, expiry));
    f.controller.settings.autoUseResetCards = true;
    Object.assign(f.controller, {
      active: new Map([
        ['run', { run: { route: { runtimeId: 'fixture' }, account: { fingerprint: 'synthetic-account' } } }],
      ]),
    });
    await f.trigger();
    assert.deepEqual(f.calls, used ? ['a'.repeat(64)] : [], String(expiry));
  }
});

test('controller only redeems at the two boundaries, including the default and explicitly disabled states', async () => {
  for (const enabled of [undefined, false, true])
    for (const [used, expiry, waiting, qualifies] of [
      [100, 48 * hour, true, true],
      [100, 48 * hour, false, false],
      [89, 48 * hour, true, false],
      [90, 48 * hour, true, true],
      [99, 24 * hour, false, false],
      [60, 10 * minute, false, true],
      [60, 10 * minute + 1, false, false],
      [1, 5 * minute, false, true],
      [0, 5 * minute, true, false],
    ] as const) {
      const f = controllerFixture(snapshot(used, expiry));
      f.controller.settings.autoUseResetCards = enabled;
      await f.trigger(waiting ? input : undefined);
      assert.deepEqual(
        f.calls,
        enabled === true && qualifies ? ['a'.repeat(64)] : [],
        JSON.stringify({ enabled, used, expiry, waiting }),
      );
    }
});

test('concurrent controller requests consume one card and cannot consume the next before a new read', async () => {
  const f = controllerFixture();
  f.controller.settings.autoUseResetCards = true;
  const reading = structuredClone(f.controller.snapshots[0]!.quota);
  await Promise.all([f.trigger(input), f.trigger(input), f.trigger(input)]);
  assert.deepEqual(f.calls, ['a'.repeat(64)]);
  const current = f.controller.snapshots[0]!;
  assert.deepEqual(current.quota, reading);
  current.quota.resetCredits!.details = current.quota.resetCredits!.details!.filter((card) => card.key !== f.calls[0]);
  await f.trigger(input);
  assert.equal(f.calls.length, 1);
  current.quota.observedAt = iso(1000);
  current.quota.resetCredits!.observedAt = iso(1000);
  f.state.observe(current, epoch + 1000);
  f.setNow(epoch + 1000);
  await f.trigger(input);
  assert.deepEqual(f.calls, ['a'.repeat(64), 'b'.repeat(64)]);
});

test('waiting work cannot redeem for a different confirmed route', async () => {
  for (const confirmedRoute of [
    { runtimeId: 'other', model: 'gpt-6-sol' },
    { runtimeId: 'fixture', model: 'missing' },
    { runtimeId: 'fixture', model: 'gpt-6-sol', accountFingerprint: 'other-account' },
  ]) {
    const f = controllerFixture();
    f.controller.settings.autoUseResetCards = true;
    await f.trigger({ ...input, confirmedRoute });
    assert.equal(f.calls.length, 0);
  }
});

test('automatic setting uses the existing persistent settings update', () => {
  const f = controllerFixture();
  let saved: Settings | undefined;
  Object.assign(f.controller, {
    resetTimer: () => {},
    sandboxHealth: { snapshot: () => ({}) },
    cursorReferences: {},
    store: {
      setConfig: (key: string, value: Settings) => {
        if (key === 'settings') saved = structuredClone(value);
      },
    },
  });
  f.controller.updateSettings({ autoUseResetCards: true });
  assert.equal(saved?.autoUseResetCards, true);
  f.controller.updateSettings({ autoUseResetCards: false });
  assert.equal(saved?.autoUseResetCards, false);
});

test('pins, provider rules, schedules and capability checks remain routing constraints', async () => {
  for (const request of [
    { ...input, runtimeId: 'another' },
    { ...input, provider: 'claude' as const },
    { ...input, schedule: { notBefore: iso(hour) } },
    { ...input, model: 'missing' },
    { ...input, untrustedContent: true },
  ]) {
    const f = controllerFixture();
    f.controller.settings.autoUseResetCards = true;
    await f.trigger(request);
    assert.equal(f.calls.length, 0);
  }
  const f = controllerFixture();
  f.controller.settings.autoUseResetCards = true;
  f.targets[0]!.enabled = false;
  await f.trigger(input);
  assert.equal(f.calls.length, 0);
});

test('start requests automatic redemption but still waits for real quota before dispatch', async () => {
  const f = controllerFixture();
  f.controller.settings.autoUseResetCards = true;
  Object.assign(f.controller, { hasExecutionCapacity: () => true, leases: new Map() });
  await assert.rejects(f.controller.start({ ...input, projectPath: process.cwd(), permissionMode: 'read-only' }));
  assert.deepEqual(f.calls, ['a'.repeat(64)]);
  assert.equal(f.controller.snapshots[0]!.quota.windows[0]!.usedPercent, 100);
});

test('better tier, user platform preference and native continuation keep work on the other account', async () => {
  for (const mode of ['tier', 'rule', 'continuation']) {
    const f = controllerFixture();
    f.controller.settings.autoUseResetCards = true;
    const other = { ...snapshot(10), id: 'other', accountFingerprint: 'synthetic-other' };
    if (mode === 'tier')
      f.controller.snapshots[0]!.models = [{ id: 'gpt-6-luna', label: 'Luna', efforts: ['low'], lightweight: true }];
    if (mode === 'rule') {
      other.provider = 'claude';
      f.controller.settings.routePreferencesEnabled = true;
      f.controller.settings.routePolicy = { general: ['claude'] };
    }
    f.controller.snapshots.push(other);
    f.targets.push({ ...f.targets[0]!, id: other.id, provider: other.provider });
    if (mode === 'continuation')
      Object.assign(f.controller, {
        store: {
          run: () => ({
            nativeSessionId: 'synthetic-session',
            route: { runtimeId: other.id },
            account: { fingerprint: other.accountFingerprint },
          }),
        },
      });
    await f.trigger({
      ...input,
      ...(mode === 'tier' ? { kind: 'architecture' } : {}),
      ...(mode === 'continuation' ? { continuationRunId: 'old' } : {}),
    });
    assert.equal(f.calls.length, 0, mode);
  }
});

test('immediately before consume rechecks the switch, quota, identity and running work', async () => {
  for (const change of ['off', 'quota', 'identity', 'running']) {
    const f = controllerFixture();
    f.controller.settings.autoUseResetCards = true;
    if (change === 'quota') f.setConsumeQuota(snapshot(10).quota);
    f.beforeConsume(() => {
      if (change === 'off') f.controller.settings.autoUseResetCards = false;
      if (change === 'identity') f.controller.snapshots = [{ ...snapshot(), accountFingerprint: 'changed' }];
      if (change === 'running')
        f.controller.active.set('synthetic', { run: { route: { runtimeId: 'fixture' } } } as never);
    });
    await f.trigger(input);
    assert.equal(f.calls.length, 0, change);
  }
});

test('ordinary preview blocks an account while redemption is in flight', () => {
  const f = controllerFixture(snapshot(10));
  Object.assign(f.controller, { resetRedemptions: new Set(['synthetic-account']) });
  assert.throws(() => f.controller.preview({ ...input, runtimeId: 'fixture' }));
});

test('routing results are identical with automatic use on or off and hypothetical quota never mutates readings', () => {
  const value = snapshot(60, 20 * hour);
  const copy = structuredClone(value);
  afterReset(value);
  assert.deepEqual(value, copy);
  assert.deepEqual(route(input, [value], settings, new Set(), epoch), route(input, [value], on, new Set(), epoch));
});

test('a redemption that failed before its request was sent keeps no latch and can try again', async () => {
  const records: Record<string, AutoResetRecord> = {};
  const state = new AutoResetCards(
    records,
    () => {},
    () => epoch,
  );
  const value = snapshot(60, 10 * minute);
  const notSentYet = Object.assign(new Error('自动用卡条件已变化'), { resetNotSent: true });
  assert.equal(
    await state.use(value, 'a'.repeat(64), iso(10 * minute), async () => {
      throw notSentYet;
    }),
    false,
  );
  assert.equal(Object.keys(records).length, 0);
  assert.equal(await state.use(value, 'a'.repeat(64), iso(10 * minute), async () => ({ outcome: 'reset' })), true);
  assert.match(records['synthetic-account']!.notes.at(-1)!, /原本 10 分钟后到期/);
});

test('automatic use reaches the real redemption while the account runs a task; manual use still waits', async () => {
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    closing: false,
    // A non-native target makes the redemption stop at its first check, before anything is read or sent.
    targets: [
      { id: 'fixture', provider: 'codex', environment: 'wsl', label: 'x', command: 'synthetic', enabled: true },
    ],
    active: new Map([
      ['run', { run: { route: { runtimeId: 'fixture' }, account: { fingerprint: 'synthetic-account' } } }],
    ]),
    resetRedemptions: new Set(),
    nativeLoginPending: () => false,
    refresh: async () => {},
  });
  const automatic = await controller
    .redeemReset('fixture', 'a'.repeat(64), 'synthetic-account', () => {})
    .catch((error: Error & { resetNotSent?: boolean }) => error);
  assert.ok(automatic instanceof Error);
  assert.doesNotMatch(automatic.message, /正在执行操作/);
  assert.equal((automatic as { resetNotSent?: boolean }).resetNotSent, true);
  const manual = await controller
    .redeemReset('fixture', 'a'.repeat(64), 'synthetic-account')
    .catch((error: Error) => error);
  assert.match((manual as Error).message, /正在执行操作/);
});

test('the refresh watches the card automatic use would redeem', () => {
  const value = { ...snapshot(50, 5 * minute), refreshedAt: iso(-minute) };
  // The earliest card has no key, so it can never be redeemed; the keyed one expires in a day.
  value.quota.resetCredits!.details = [
    { ...value.quota.resetCredits!.details![1]!, key: undefined },
    { ...value.quota.resetCredits!.details![0]!, expiresAt: iso(24 * hour) },
  ];
  assert.equal(cardRefreshDue(value, epoch), false);
});
