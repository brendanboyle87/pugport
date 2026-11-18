import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiBudgetConcurrency,
  apiBudgetPolicy,
  apiBudgetView,
  apiRunCostLimit,
  linkedCreditLapsed,
  renewedApiBudget,
} from '../src/server/api-budget.ts';
import { route, RouteUnavailableError, quotaPoolKey } from '../src/server/routing.ts';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { UsageLedger } from '../src/server/usage.ts';
import { nodeRuntimes } from '../src/server/node/node-runtimes.ts';
import { temporaryFolder } from './helpers/fake-peer.ts';
import type { RuntimeSnapshot, Settings, RunRecord, RuntimeTarget } from '../src/shared/types.ts';

import { apiCreditPace } from '../src/shared/api-providers.ts';
import { automaticApiTarget } from '../src/shared/automatic-executors.ts';

const now = Date.parse('2026-10-09T16:00:00Z');
const at = (hours = 0) => new Date(now + hours * 3_600_000).toISOString();
const policy = (hours = 20, changes = {}) =>
  apiBudgetPolicy({ limitUsd: 10, expiresAt: at(hours), ...changes }, undefined, at());
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/p',
  maxConcurrentRuns: 0,
};
const base = {
  environment: 'native',
  installed: true,
  status: 'ready',
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: at(),
} as const;
const cli: RuntimeSnapshot = {
  ...base,
  id: 'codex-test',
  provider: 'codex',
  label: 'CLI',
  models: [{ id: 'gpt-6.1-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] }],
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: at(),
    windows: [{ id: 'week', label: 'week', usedPercent: 5, resetsAt: at(180) }],
  },
};
const api = (hours = 20, changes: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  ...base,
  id: 'api-budget-test',
  provider: 'pi',
  gateway: 'api',
  apiProvider: 'deepseek',
  label: 'API',
  models: [
    {
      id: 'deepseek/deepseek-v4-pro',
      label: 'Pro',
      efforts: ['low', 'medium', 'high'],
      price: { input: 1, output: 2 },
    },
  ],
  accounting: { mode: 'usage', source: 'fixture' },
  quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
  apiBudgetState: apiBudgetView({ ...policy(hours), startedAt: at(-240) }, 0, 0, 0, now),
  ...changes,
});
const input = { prompt: 'Implement a helper', projectPath: 'C:/p', kind: 'general' as const };

test('API credit lines preserve authentication status through the tray and peer executor', async (t) => {
  const store = new Store(temporaryFolder(t, 'api-credit-status-'));
  new UsageLedger(store.db);
  const snapshot = api(20, { status: 'auth-required' });
  const target: RuntimeTarget = {
    id: snapshot.id,
    provider: 'pi',
    gateway: 'api',
    label: 'Synthetic API',
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    apiBudget: policy(),
  };
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    store,
    targets: [target],
    snapshots: [snapshot],
    active: new Map(),
    apiExtraUsage: {},
    clock: () => now,
    settings,
  });
  const runtimes = nodeRuntimes(() => controller.trayState(), {
    probe: async () => undefined,
    tray: async () => {
      throw new Error('No desktop should be queried');
    },
  });
  try {
    assert.equal(controller.trayState().lines[0]!.status, 'auth-required');
    assert.equal((await runtimes()).executors[0]!.status, 'auth-required');
    Object.assign(controller, { snapshots: [] });
    assert.equal((await runtimes()).executors[0]!.status, 'unknown');
  } finally {
    store.db.close();
  }
});

test('the tray drops a one-time credit once it expires but keeps a monthly one with its reset time', (t) => {
  const store = new Store(temporaryFolder(t, 'api-credit-gone-'));
  new UsageLedger(store.db);
  const target = (id: string, apiBudget: RuntimeTarget['apiBudget']): RuntimeTarget => ({
    id,
    provider: 'pi',
    gateway: 'api',
    label: id,
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    apiBudget,
  });
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    store,
    targets: [
      target('Live credit', policy(20)),
      target('Expired credit', { ...policy(20), expiresAt: at(-1) }),
      target('Monthly credit', { ...policy(20), monthlyUsd: 10 }),
    ],
    snapshots: [],
    active: new Map(),
    apiExtraUsage: {},
    clock: () => now,
    settings,
  });
  try {
    const lines = controller.trayState().lines;
    assert.deepEqual(
      lines.map((line) => line.label),
      ['Live credit', 'Monthly credit'],
    );
    assert.equal(lines[0]!.windows[0]!.resetsAt, undefined);
    assert.equal(lines[1]!.windows[0]!.resetsAt, at(20));
  } finally {
    store.db.close();
  }
});

test('budget rejects malformed money, dates, host fields and inverted concurrency before changing configuration', () => {
  for (const value of [
    { limitUsd: NaN },
    { limitUsd: -1 },
    { limitUsd: 0.2 },
    { perRunUsd: Infinity },
    { expiresAt: 'tomorrow' },
    { maxConcurrentRuns: 17 },
    { maxConcurrentRuns: 4, burstConcurrentRuns: 2 },
    { startedAt: at(-100) },
  ])
    assert.throws(() => apiBudgetPolicy(value));
});
test('editing a budget never erases spend; only an explicit new period does', () => {
  const old = policy();
  assert.equal(apiBudgetPolicy({ limitUsd: 15 }, old, at(1)).startedAt, old.startedAt);
  assert.equal(apiBudgetPolicy({ limitUsd: 15, reset: true }, old, at(1)).startedAt, at(1));
});

test('prefer credit partial server update preserves every other budget field', () => {
  const previous = apiBudgetPolicy(
    {
      limitUsd: 123,
      monthlyUsd: 123,
      expiresAt: at(72),
      perRunUsd: 7,
      maxConcurrentRuns: 3,
      burstConcurrentRuns: 8,
      preferExpiring: false,
      linkedAccountId: 'paid-fixture',
    },
    undefined,
    at(-24),
    () => 'Pro',
  );
  const target = { id: 'fixture', provider: 'pi', gateway: 'api', apiProvider: 'deepseek', apiBudget: previous };
  const controller = Object.assign(Object.create(Controller.prototype), {
    targets: [target],
    active: new Map(),
    clock: () => now,
    apiTargetFor: () => ({ target }),
    subscriptionPlanOf: () => 'Pro',
    store: { setConfig() {} },
    broadcast() {},
    emit() {},
    apiProviders: () => [],
  }) as Controller;
  controller.updateApiBudget('fixture', { preferExpiring: true });
  assert.deepEqual(target.apiBudget, { ...previous, preferExpiring: true });
  assert.throws(() => controller.updateApiBudget('fixture', { startedAt: at(1) }));
  assert.deepEqual(target.apiBudget, { ...previous, preferExpiring: true });
});
test('expiry boosts compatible real work at seven days, three days and under one day', () => {
  assert.deepEqual(
    [
      apiBudgetView(policy(200), 0, 0, 0, now).phase,
      apiBudgetView(policy(100), 0, 0, 0, now).phase,
      apiBudgetView(policy(50), 0, 0, 0, now).phase,
      apiBudgetView(policy(20), 0, 0, 0, now).phase,
    ],
    ['normal', 'priority', 'accelerated', 'sprint'],
  );
  assert.deepEqual(
    [
      api(100).apiBudgetState!.maxConcurrentRuns,
      api(50).apiBudgetState!.maxConcurrentRuns,
      api(20).apiBudgetState!.maxConcurrentRuns,
    ],
    [1, 3, 4],
  );
  const decision = route({ ...input, executionPolicy: 'cli-first' }, [cli, api()], settings, new Set(), now);
  assert.equal(decision.runtimeId, 'api-budget-test');
  assert.match(decision.reasons.join('\n'), /API 额度 1 天后到期，落后计划/);
});
test('on-line credit keeps ordinary CLI preference and explicit opt-out disables urgency', () => {
  assert.equal(
    route(
      input,
      [cli, api(200, { apiBudgetState: apiBudgetView(policy(200), 0, 0, 0, now) })],
      settings,
      new Set(),
      now,
    ).runtimeId,
    cli.id,
  );
  assert.equal(
    route({ ...input, schedule: { preferExpiringQuota: false } }, [cli, api()], settings, new Set(), now).runtimeId,
    cli.id,
  );
  const disabled = api(20, { apiBudgetState: apiBudgetView(policy(20, { preferExpiring: false }), 0, 0, 0, now) });
  assert.equal(route(input, [cli, disabled], settings, new Set(), now).runtimeId, cli.id);
});
test('manual account and CLI-only choices stay fixed regardless of impending API expiry', () => {
  assert.equal(route({ ...input, runtimeId: cli.id }, [cli, api()], settings, new Set(), now).runtimeId, cli.id);
  assert.equal(
    route({ ...input, executionPolicy: 'cli-only' }, [cli, api()], settings, new Set(), now).runtimeId,
    cli.id,
  );
});
test('expired, fully spent and unpriced APIs cannot receive a new run', () => {
  const snapshots = [
    api(-1),
    api(20, { apiBudgetState: apiBudgetView(policy(), 9.5, 0, 0, now) }),
    api(20, { models: [{ id: 'deepseek/m', label: 'm', efforts: ['medium'] }] }),
  ];
  for (const s of snapshots) {
    assert.equal(route(input, [cli, s], settings, new Set(), now).runtimeId, cli.id);
    assert.throws(() => route({ ...input, runtimeId: s.id }, [s], settings, new Set(), now), RouteUnavailableError);
  }
});
test('expiry does not override complex task model capability requirements', () => {
  const cheap = api(20, {
    models: [
      { id: 'deepseek/flash', label: 'flash', efforts: ['low'], lightweight: true, price: { input: 0.1, output: 0.2 } },
    ],
  });
  assert.equal(
    route({ ...input, kind: 'architecture', prompt: '根因分析数据库认证安全' }, [cli, cheap], settings, new Set(), now)
      .runtimeId,
    cli.id,
  );
});
test('a budgeted account chooses a priced compatible model without rejecting its whole catalog', () => {
  const mixed = api(20, {
    models: [{ id: 'deepseek/unpriced', label: 'Unknown cost', efforts: ['low', 'medium', 'high'] }, ...api().models],
  });
  assert.equal(
    route({ ...input, runtimeId: mixed.id }, [mixed], settings, new Set(), now).model,
    'deepseek/deepseek-v4-pro',
  );
  assert.throws(
    () => route({ ...input, runtimeId: mixed.id, model: 'deepseek/unpriced' }, [mixed], settings, new Set(), now),
    RouteUnavailableError,
  );
});
test('impending expiry cannot displace a stronger compatible model for a complex task', () => {
  const weaker = api(20, {
    models: [
      {
        id: 'deepseek/deepseek-v4-flash',
        label: 'Flash',
        efforts: ['low', 'medium', 'high'],
        price: { input: 1, output: 2 },
      },
    ],
  });
  const stronger: RuntimeSnapshot = { ...cli, models: [{ id: 'gpt-6-astra', label: 'Astra', efforts: ['high'] }] };
  assert.equal(
    route(
      { ...input, kind: 'architecture', prompt: '设计复杂认证架构并审查根因和安全边界' },
      [stronger, weaker],
      settings,
      new Set(),
      now,
    ).runtimeId,
    stronger.id,
  );
});
test('in-flight spend reservations and API sprint concurrency cap both prevent further dispatch', () => {
  const s = api(20, { apiBudgetState: apiBudgetView(policy(), 0, 9.5, 0, now) });
  const capacity = { reservations: new Map([[quotaPoolKey(s), 1]]), settlingPools: new Set<string>() };
  assert.throws(
    () => route({ ...input, runtimeId: s.id }, [s], settings, capacity, now),
    (e: unknown) => e instanceof RouteUnavailableError && e.kind === 'capacity',
  );
  const sprint = api();
  capacity.reservations.set(quotaPoolKey(sprint), 4);
  assert.throws(
    () => route({ ...input, runtimeId: sprint.id }, [sprint], settings, capacity, now),
    (e: unknown) => e instanceof RouteUnavailableError && e.kind === 'capacity',
  );
});
test('unknown cost remains reserved across restarts, a run with no reply holds none, and duplicate usage is counted once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-api-budget-'));
  const store = new Store(dir);
  const controller = Object.create(Controller.prototype) as Controller;
  const target: RuntimeTarget = {
    id: 'api-budget-fixture-no-key',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    label: 'Fixture',
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    apiBudget: policy(),
  };
  Object.assign(controller, {
    store,
    targets: [target],
    active: new Map(),
    apiExtraUsage: {},
    apiBalances: {},
    apiWorkspaceLookups: {},
    clock: () => now,
  });
  const usage = new UsageLedger(store.db);
  const run: RunRecord = {
    id: 'unknown',
    prompt: 'fixture',
    projectPath: 'C:/p',
    kind: 'general',
    status: 'interrupted',
    route: { runtimeId: target.id, model: 'deepseek/m', kind: 'general', reasons: [], warnings: [] },
    startedAt: at(),
    output: '',
    events: [],
    apiBudgetReservation: { periodStartedAt: at(), reservedUsd: 1 },
  };
  try {
    store.saveRun(run);
    usage.begin(run, target, 'usage');
    assert.equal(controller.apiProviders()[0]!.budget!.reservedUsd, 1);
    assert.equal(controller.apiProviders()[0]!.budget!.unreportedRuns, 1);
    const packet = { at: at(), type: 'usage' as const, data: { eventId: 'same', costUsd: 0.4 } };
    usage.record(run, target, packet, 'usage');
    usage.record(run, target, packet, 'usage');
    assert.equal(controller.apiProviders()[0]!.budget!.spentUsd, 0.4);
    assert.equal(controller.apiProviders()[0]!.budget!.reservedUsd, 0);
    assert.equal(controller.apiProviders()[0]!.budget!.remainingUsd, 9.6);
    run.errorCode = 'api-budget-usage-unknown';
    store.saveRun(run);
    assert.equal(controller.apiProviders()[0]!.budget!.reservedUsd, 0.6);
    assert.equal(controller.apiProviders()[0]!.budget!.unreportedRuns, 1);
    assert.equal(controller.apiProviders()[0]!.budget!.remainingUsd, 9);
    // Regression: runs that timed out or were cancelled before any reply held $1 each forever.
    const timedOut: RunRecord = { ...run, id: 'timed-out', status: 'failed', errorCode: 'runtime-timeout' };
    store.saveRun(timedOut);
    usage.begin(timedOut, target, 'usage');
    assert.equal(controller.apiProviders()[0]!.budget!.reservedUsd, 0.6);
    // A run that never got a reply cost nothing, so it no longer raises the unreported-cost chip.
    assert.equal(controller.apiProviders()[0]!.budget!.unreportedRuns, 1);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: every state build re-read each budget run in full (with its audit events) and hung the backend.
test('the API budget reads each settled run once, not on every state build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-api-budget-'));
  const store = new Store(dir);
  const controller = Object.create(Controller.prototype) as Controller;
  const target: RuntimeTarget = {
    id: 'api-budget-fixture-many',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    label: 'Fixture',
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    apiBudget: policy(),
  };
  Object.assign(controller, {
    store,
    targets: [target],
    active: new Map(),
    apiExtraUsage: {},
    apiBalances: {},
    apiWorkspaceLookups: {},
    clock: () => now,
  });
  const usage = new UsageLedger(store.db);
  const make = (index: number): RunRecord => ({
    id: `settled-${index}`,
    prompt: 'fixture',
    projectPath: 'C:/p',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: target.id, model: 'deepseek/m', kind: 'general', reasons: [], warnings: [] },
    startedAt: at(),
    output: 'x'.repeat(2000),
    events: [],
    apiBudgetReservation: { periodStartedAt: at(), reservedUsd: 1 },
  });
  try {
    store.db.exec('BEGIN');
    for (let index = 0; index < 2000; index++) {
      const run = make(index);
      store.saveRun(run);
      usage.begin(run, target, 'usage');
      usage.record(run, target, { at: at(), type: 'usage', data: { eventId: 'cost', costUsd: 0.001 } }, 'usage');
    }
    store.db.exec('COMMIT');
    const first = controller.apiProviders()[0]!.budget!;
    assert.equal(first.spentUsd.toFixed(2), '2.00');
    let scans = 0;
    let reads = 0,
      fieldReads = 0;
    const read = store.run.bind(store);
    store.run = (id: string) => {
      reads++;
      return read(id);
    };
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => {
      if (sql.includes('EXISTS(SELECT 1 FROM runs WHERE runs.id=usage_runs.id)')) scans++;
      const statement = prepare(sql);
      if (!sql.includes('apiBudgetReservation.reservedUsd')) return statement;
      const get = statement.get.bind(statement);
      statement.get = ((...args: Parameters<typeof get>) => {
        fieldReads++;
        return get(...args);
      }) as typeof statement.get;
      return statement;
    }) as typeof store.db.prepare;
    for (let build = 0; build < 20; build++) controller.apiProviders();
    assert.deepEqual([reads, fieldReads], [0, 0]);
    assert.equal(scans, 0, 'cached budget state must not rescan usage on unchanged requests');
    Object.assign(controller, { snapshots: [] });
    for (let build = 0; build < 20; build++) controller.spendLive();
    assert.equal(scans, 0, 'Spend reuses the cached budget state');
    // A run saved again is read again (only that run), so a later change to it still counts.
    const changed = { ...make(0), status: 'interrupted' as const, errorCode: 'api-budget-usage-unknown' };
    store.saveRun(changed);
    assert.equal(controller.apiProviders()[0]!.budget!.unreportedRuns, 1);
    assert.deepEqual([reads, fieldReads], [0, 1]);
    const beforeExtra = controller.apiProviders()[0]!.budget!.spentUsd;
    Object.assign(controller, { apiExtraUsage: { [target.id]: { costUsd: 3, tokens: 0, calls: 1 } } });
    assert.equal(controller.spendLive()[0]!.budget!.spentUsd, beforeExtra + 3);
    const running = { ...make(1), status: 'running' as const };
    Object.assign(controller, { active: new Map([[running.id, { run: running }]]) });
    assert.ok(controller.spendLive()[0]!.budget!.reservedUsd > 0.99, 'active reservations invalidate the view');
    target.apiBudget = { ...target.apiBudget!, limitUsd: 200 };
    assert.equal(controller.spendLive()[0]!.budget!.policy.limitUsd, 200, 'policy edits invalidate the view');
    const beforeUsage = controller.spendLive()[0]!.budget!.spentUsd;
    usage.record(
      make(2),
      target,
      { at: at(), type: 'usage', data: { eventId: 'new-cost', costUsd: 2, cumulative: false } },
      'usage',
    );
    assert.ok(controller.spendLive()[0]!.budget!.spentUsd > beforeUsage + 1, 'new usage invalidates the view');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const paced = (days = 9, spent = 0.22, changes = {}): RuntimeSnapshot =>
  api(days * 24, {
    apiBudgetState: apiBudgetView(
      apiBudgetPolicy({ limitUsd: 200, expiresAt: at(days * 24), ...changes }, undefined, at(-10 * 24)),
      spent,
      0,
      0,
      now,
    ),
  });

test('linear pacing admits nine-day credit before healthy CLI and reports the recorded spend', () => {
  const card = paced();
  const decision = route({ ...input, executionPolicy: 'cli-first' }, [cli, card], settings, new Set(), now);
  assert.equal(decision.runtimeId, card.id);
  assert.ok(decision.reasons.includes('API 额度 9 天后到期，落后计划（应已用 $71.43，实际 $0.22），优先用'));
});

test('on-line and ahead credit are pinned-only even within six days of expiry', () => {
  for (const days of [9, 6]) {
    const planned = (200 * (14 - days)) / 14;
    for (const spent of [planned, planned + 1]) {
      const card = paced(days, spent);
      assert.equal(automaticApiTarget(card, now), false);
      assert.equal(route(input, [cli, card], settings, new Set(), now).runtimeId, cli.id);
      const pin = route({ ...input, runtimeId: card.id }, [cli, card], settings, new Set(), now);
      assert.equal(pin.runtimeId, card.id);
      assert.ok(!pin.reasons.some((reason) => reason.includes('落后计划')));
    }
  }
});

test('relative deficit ranks cards across and within platforms without using dollar size or burn rate', () => {
  const larger = { ...paced(9, 50), id: 'larger' };
  const smaller = { ...paced(9, 0, { limitUsd: 40 }), id: 'smaller' };
  for (const apiProvider of ['deepseek', 'anthropic']) {
    const best = { ...smaller, apiProvider };
    for (const cards of [
      [larger, best, cli],
      [cli, best, larger],
    ])
      assert.equal(route(input, cards, settings, new Set(), now).runtimeId, best.id);
  }
});

test('catch-up concurrency caps automatic work while pins and final phases retain configured caps', () => {
  for (const [days, limit] of [
    [9, 4],
    [6, 4],
    [2, 4],
    [0.5, 4],
  ]) {
    const card = paced(days, 0, { maxConcurrentRuns: 2, burstConcurrentRuns: 4 });
    const capacity = { reservations: new Map([[quotaPoolKey(card), limit!]]), settlingPools: new Set<string>() };
    // Full: subscriptions keep working; with nothing else the work waits for the card.
    assert.equal(route(input, [cli, card], settings, capacity, now).runtimeId, cli.id);
    assert.throws(
      () => route(input, [card], settings, capacity, now),
      (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'capacity',
    );
    capacity.reservations.set(quotaPoolKey(card), limit! - 1);
    assert.equal(route(input, [cli, card], settings, capacity, now).runtimeId, card.id);
    if (days === 9) {
      capacity.reservations.set(quotaPoolKey(card), 1);
      assert.equal(route({ ...input, runtimeId: card.id }, [card], settings, capacity, now).runtimeId, card.id);
    }
  }
});

test('last-day pacing stops at the remaining reservable balance and never bypasses quality or exclusions', () => {
  const card = paced(0.5, 0.22);
  assert.equal(route(input, [cli, card], settings, new Set(), now).runtimeId, card.id);
  card.apiBudgetState = { ...card.apiBudgetState!, reservedUsd: 199 };
  assert.equal(automaticApiTarget(card, now), false);
  assert.equal(route(input, [cli, card], settings, new Set(), now).runtimeId, cli.id);
  const behind = paced();
  assert.equal(
    route(input, [cli, behind], { ...settings, excludedExecutors: [behind.id] }, new Set(), now).runtimeId,
    cli.id,
  );
  assert.equal(
    route({ ...input, runtimeId: behind.id }, [behind], { ...settings, excludedExecutors: [behind.id] }, new Set(), now)
      .runtimeId,
    behind.id,
  );
  const strong = { ...cli, models: [{ id: 'gpt-6-astra', label: 'Astra', efforts: ['high'] }] };
  assert.equal(
    route(input, [strong, behind], { ...settings, routeGoal: 'quality' }, new Set(), now).runtimeId,
    strong.id,
  );
  assert.throws(
    () => route(input, [behind], { ...settings, routeGoal: 'quality' }, new Set(), now),
    RouteUnavailableError,
  );
});

test('pacing fails closed for missing dates, invalid money and opt-out, and clamps time to the recorded period', () => {
  const view = paced().apiBudgetState!;
  for (const patch of [
    { expiresAt: undefined },
    { startedAt: '' },
    { startedAt: at(300) },
    { expiresAt: at(-300) },
    { limitUsd: undefined },
    { limitUsd: Infinity },
    { perRunUsd: NaN },
    { preferExpiring: false },
  ])
    assert.equal(
      automaticApiTarget({ ...paced(), apiBudgetState: { ...view, policy: { ...view.policy, ...patch } } }, now),
      false,
    );
  for (const patch of [{ spentUsd: NaN }, { spentUsd: -1 }, { reservedUsd: Infinity }, { remainingUsd: NaN }])
    assert.equal(automaticApiTarget({ ...paced(), apiBudgetState: { ...view, ...patch } }, now), false);
  assert.equal(apiCreditPace(view, Date.parse(view.policy.startedAt))!.plannedUsd, 0);
  assert.equal(apiCreditPace(view, now - 20 * 86400000)!.priority, 0);
  assert.equal(apiCreditPace(view, now + 20 * 86400000)!.plannedUsd, 200);
  assert.equal(apiCreditPace(view, now + 20 * 86400000)!.priority, 0);
});

test('UI message default permits behind-pace credit while explicit CLI-only still excludes it', () => {
  const source = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  const schema = source.slice(source.indexOf('const messageSchema ='));
  const declaration = schema.match(
    /executionPolicy: z.enum\(\['cli-first', 'cli-only', 'api-only'\]\).default\('([^']+)'\)/,
  );
  assert.equal(declaration?.[1], 'cli-first');
  const card = paced();
  assert.equal(
    route({ ...input, executionPolicy: declaration![1] as 'cli-first' }, [cli, card], settings, new Set(), now)
      .runtimeId,
    card.id,
  );
  assert.equal(
    route({ ...input, executionPolicy: 'cli-only' }, [cli, card], settings, new Set(), now).runtimeId,
    cli.id,
  );
});

test('parked API turns share catch-up caps when reacquiring capacity', () => {
  for (const automaticApi of [true, false]) {
    for (const days of [9, 0.5]) {
      const controller = Object.create(Controller.prototype) as Controller;
      const snapshot = paced(days, 0, { maxConcurrentRuns: 2, burstConcurrentRuns: 4 });
      const entry = {
        run: { id: 'parked', status: 'running', route: { runtimeId: snapshot.id } },
        abort: new AbortController(),
        project: 'fixture',
        permissionMode: 'read-only',
        parked: true,
        automaticApi,
      };
      let resolved = false;
      Object.assign(controller, {
        active: new Map([['parked', entry]]),
        targets: [{ id: snapshot.id, provider: 'pi', gateway: 'api' }],
        executionResumes: [
          {
            runId: 'parked',
            dispose() {},
            resolve() {
              resolved = true;
            },
          },
        ],
        projectDeliveries: new Set(),
        settings: { maxConcurrentRuns: 0 },
        closing: false,
        clock: () => now,
        hasSwarmExecutionCapacity: () => true,
        apiBudgetFor: () => snapshot.apiBudgetState,
        routeCapacity: () => ({ reservations: new Map([[quotaPoolKey(snapshot), 4]]), settlingPools: new Set() }),
      });
      const internals = controller as unknown as { resumeExecutions(): void; routeCapacity(): unknown };
      internals.resumeExecutions();
      assert.equal(resolved, false);
      if (!resolved) {
        internals.routeCapacity = () => ({ reservations: new Map(), settlingPools: new Set() });
        internals.resumeExecutions();
        assert.equal(resolved, true);
      }
      assert.equal(entry.parked, false);
    }
  }
});

test('memory distillation keeps its pinned ordinary paid API through real routing', () => {
  const card = api(200, {
    capabilities: { ...base.capabilities, toolless: true },
    apiBudgetState: apiBudgetView(policy(200), 0, 0, 0, now),
  });
  assert.equal(automaticApiTarget(card, now), false);
  const request = {
    ...input,
    kind: 'routine' as const,
    runtimeId: card.id,
    automaticExecutorSelection: true,
    automaticExecutors: [card.id],
    permissionMode: 'read-only' as const,
    untrustedContent: true,
    agentCalls: false,
    allowExecutorFallback: false,
    memoryDistillation: true,
  };
  const decision = route(request, [card], settings, new Set(), now);
  assert.equal(decision.runtimeId, card.id);
  assert.ok(!decision.reasons.some((reason) => reason.includes('按次计费的 API 卡默认不参与自动选择')));
  assert.throws(
    () => route({ ...request, memoryDistillation: false }, [card], settings, new Set(), now),
    RouteUnavailableError,
  );
  assert.throws(
    () => route({ ...request, runtimeId: undefined }, [card], settings, new Set(), now),
    RouteUnavailableError,
  );
  assert.throws(
    () =>
      route(
        request,
        [{ ...card, apiBudgetState: apiBudgetView(policy(200), 10, 0, 0, now) }],
        settings,
        new Set(),
        now,
      ),
    RouteUnavailableError,
  );
});

test('credit pacing uses only the last fourteen days or the later recorded start', () => {
  const far = paced(20, 0);
  assert.equal(apiCreditPace(far.apiBudgetState, now)!.priority, 0);
  assert.equal(route(input, [cli, far], settings, new Set(), now).runtimeId, cli.id);
  const view = paced(10, 0).apiBudgetState!;
  assert.equal(apiCreditPace(view, now)!.plannedUsd, 200 * (4 / 14));
  assert.ok(apiCreditPace(view, now)!.priority > 0);
  const late = paced(10, 0).apiBudgetState!;
  late.policy.startedAt = at(-24);
  assert.equal(apiCreditPace(late, now)!.plannedUsd, 200 / 11);
});

test('catch-up adds one slot per twenty dollars, capped by burst and balance', () => {
  for (const [behind, expected] of [
    [10, 1],
    [45, 3],
    [90, 4],
  ]) {
    const view = paced(7, 100 - behind!).apiBudgetState!;
    assert.equal(apiBudgetConcurrency(view, true, now), expected);
  }
  const view = paced(7, 10, { burstConcurrentRuns: 2 }).apiBudgetState!;
  assert.equal(apiBudgetConcurrency(view, true, now), 2);
  assert.equal(apiBudgetConcurrency({ ...view, remainingUsd: 1 }, true, now), 1);
});

test('eight-day credit ninety dollars behind gets four slots; twenty-eight-day credit is not picked automatically', () => {
  const early = { ...paced(8, 0, { limitUsd: 210 }), id: 'early' };
  const late = { ...paced(28, 0), id: 'late' };
  assert.equal(apiCreditPace(early.apiBudgetState, now)!.plannedUsd, 90);
  assert.equal(apiBudgetConcurrency(early.apiBudgetState!, true, now), 4);
  assert.equal(automaticApiTarget(late, now), false);
  // API-only is the user's consent to paid cards, as before.
  assert.equal(route({ ...input, executionPolicy: 'api-only' }, [late], settings, new Set(), now).runtimeId, late.id);
  assert.equal(route({ ...input, runtimeId: late.id }, [late], settings, new Set(), now).runtimeId, late.id);
  const capacity = { reservations: new Map([[quotaPoolKey(early), 3]]), settlingPools: new Set<string>() };
  assert.equal(route(input, [late, early], settings, capacity, now).runtimeId, early.id);
  capacity.reservations.set(quotaPoolKey(early), 4);
  assert.throws(
    () => route(input, [late, early], settings, capacity, now),
    (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'capacity',
  );
});

test('earliest eligible credit wins and queues at its cap until caught up', () => {
  const early = { ...paced(8, 80), id: 'early' };
  const late = { ...paced(10, 0), id: 'late', apiProvider: 'anthropic' };
  for (const cards of [
    [late, early],
    [early, late],
  ]) {
    assert.equal(route(input, cards, settings, new Set(), now).runtimeId, early.id);
    const capacity = { reservations: new Map([[quotaPoolKey(early), 1]]), settlingPools: new Set<string>() };
    assert.throws(
      () => route(input, cards, settings, capacity, now),
      (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'capacity',
    );
    assert.equal(route({ ...input, runtimeId: late.id }, cards, settings, capacity, now).runtimeId, late.id);
    assert.equal(route(input, cards, { ...settings, excludedExecutors: [early.id] }, capacity, now).runtimeId, late.id);
  }
  early.apiBudgetState = paced(8, (200 * 6) / 14).apiBudgetState;
  assert.equal(route(input, [early, late], settings, new Set(), now).runtimeId, late.id);
});

test('credit expiry ordering stays stable when CLI window waste also competes', () => {
  const early = { ...paced(8, 80), id: 'early' };
  const late = { ...paced(10, 0), id: 'late', apiProvider: 'anthropic' };
  const cards = [early, late, cli];
  const selections = cards.flatMap((first) =>
    cards
      .filter((card) => card !== first)
      .map(
        (second) =>
          route(
            input,
            [first, second, ...cards.filter((card) => card !== first && card !== second)],
            settings,
            new Set(),
            now,
          ).runtimeId,
      ),
  );
  assert.equal(new Set(selections).size, 1);
  assert.notEqual(selections[0], late.id);
});

test('no per-run cap: a run may spend what the card has left, and stops only near the total limit', () => {
  const view = (limitUsd: number, spentUsd: number, reservedUsd: number) =>
    apiBudgetView({ ...paced(8, 0).apiBudgetState!.policy, limitUsd }, spentUsd, reservedUsd, 0, now);
  // 50 left with this run's  reservation: spending  or 0 in one run is fine.
  const roomy = apiRunCostLimit(view(200, 50, 1), 1);
  assert.equal(roomy, 150);
  assert.ok(5 < roomy && 30 < roomy);
  // Another run's reservation is not this run's to spend.
  assert.equal(apiRunCostLimit(view(200, 50, 3), 1), 148);
  assert.equal(apiRunCostLimit(view(1, 0.5, 0), 0), 0.5);
  assert.equal(apiRunCostLimit({ ...view(1, 0, 0), remainingUsd: undefined }, 0), Number.MAX_SAFE_INTEGER);
});

test('a behind credit card is not held back by the post-run settling pause of subscriptions', () => {
  const card = paced(8, 0);
  const capacity = {
    reservations: new Map([[quotaPoolKey(card), 1]]),
    settlingPools: new Set([quotaPoolKey(card)]),
    settlingQuotaPools: new Set([quotaPoolKey(card)]),
  };
  // A plan step just finished on the card; the next step still goes to it instead of a subscription.
  assert.equal(route(input, [cli, card], settings, capacity, now).runtimeId, card.id);
});

test('a follow-up that starts new work leaves its session for credit far behind; "continue" stays', () => {
  const far = paced(8, 0, { limitUsd: 210 }); // $90 behind
  const near = paced(8, 60, { limitUsd: 210 }); // $30 behind
  const capacity = {
    reservations: new Map<string, number>(),
    settlingPools: new Set<string>(),
    continuing: [{ runtimeId: cli.id }],
  };
  const followUp = { ...input, continuationRunId: 'prior' };
  const moved = route({ ...followUp, continuationNewTask: true }, [cli, far], settings, capacity, now);
  assert.equal(moved.runtimeId, far.id);
  assert.ok(moved.reasons.some((reason) => /赠金落后 \$90，新任务换卡/.test(reason)));
  assert.equal(
    route({ ...followUp, continuationNewTask: false }, [cli, far], settings, capacity, now).runtimeId,
    cli.id,
  );
  assert.equal(
    route({ ...followUp, continuationNewTask: true }, [cli, near], settings, capacity, now).runtimeId,
    cli.id,
  );
});

test('a write that must run commands skips Pi API cards under automatic approval', () => {
  const card = paced(8, 0);
  const write = { ...input, permissionMode: 'workspace-write' as const, toolApprovalMode: 'auto' as const };
  const withTests = { ...write, prompt: 'Fix the parser and run the tests.' };
  const decision = route(withTests, [cli, card], settings, new Set(), now);
  assert.equal(decision.runtimeId, cli.id);
  // Text-only writes, read-only work, per-tool approval and an explicit API-only choice still use the card.
  assert.equal(
    route({ ...write, prompt: 'Rewrite the README intro.' }, [cli, card], settings, new Set(), now).runtimeId,
    card.id,
  );
  assert.equal(
    route({ ...withTests, permissionMode: 'read-only' }, [cli, card], settings, new Set(), now).runtimeId,
    card.id,
  );
  assert.equal(
    route({ ...withTests, toolApprovalMode: 'ask' }, [cli, card], settings, new Set(), now).runtimeId,
    card.id,
  );
  assert.equal(
    route({ ...withTests, executionPolicy: 'api-only' }, [cli, card], settings, new Set(), now).runtimeId,
    card.id,
  );
});

test('in a trusted project Pi takes writes that run commands, MCP dispatches included; untrusted or web-driven turns do not', () => {
  const card = paced(8, 0);
  const withTests = {
    ...input,
    permissionMode: 'workspace-write' as const,
    toolApprovalMode: 'auto' as const,
    prompt: 'Fix the parser and run the tests.',
  };
  const trusted = { reservations: new Map<string, number>(), settlingPools: new Set<string>(), trustedProject: true };
  assert.equal(route(withTests, [cli, card], settings, trusted, now).runtimeId, card.id);
  const untrusted = route(withTests, [cli, card], settings, { ...trusted, trustedProject: false }, now);
  assert.equal(untrusted.runtimeId, cli.id);
  assert.match(untrusted.reasons.join('\n'), /这一轮项目不在可信列表里/);
  const web = route({ ...withTests, webDriven: true }, [cli, card], settings, trusted, now);
  assert.equal(web.runtimeId, cli.id);
  assert.match(web.reasons.join('\n'), /这一轮本轮上下文带网页搜索结果/);
  // A local session's MCP dispatch with inherited write access counts like the user.
  const caller = { source: 'caller' as const, mode: 'workspace-write' as const, note: 'Claude Code' };
  assert.equal(
    route({ ...withTests, permissionOrigin: caller }, [cli, card], settings, trusted, now).runtimeId,
    card.id,
  );
  // Read-only is still never a command turn.
  assert.equal(
    route(
      { ...withTests, permissionMode: 'read-only' as const, permissionOrigin: caller },
      [cli, card],
      settings,
      trusted,
      now,
    ).runtimeId,
    card.id,
  );
});

test('a monthly credit renews to the full amount at each renewal and unused credit does not roll over', () => {
  const local = (month: number, day: number) => new Date(2026, month - 1, day).toISOString();
  const monthly = apiBudgetPolicy(
    { limitUsd: 84, expiresAt: local(11, 12), monthlyUsd: 200 },
    undefined,
    local(10, 30),
  );
  assert.equal(renewedApiBudget(monthly, Date.parse(local(11, 11))), undefined);
  assert.deepEqual(renewedApiBudget(monthly, Date.parse(local(11, 13))), {
    ...monthly,
    limitUsd: 200,
    startedAt: local(11, 12),
    expiresAt: local(12, 12),
  });
  // Months away: one fresh period, never the sum of missed ones.
  const later = renewedApiBudget(monthly, Date.parse(local(12, 12)) + 3_600_000 + 40 * 86_400_000)!;
  assert.deepEqual(
    [later.limitUsd, later.startedAt, later.expiresAt],
    [200, new Date(2027, 0, 12).toISOString(), new Date(2027, 1, 12).toISOString()],
  );
  // The 31st clamps to a short month's last day.
  const endOfMonth = { ...monthly, expiresAt: new Date(2027, 0, 31).toISOString() };
  assert.equal(
    renewedApiBudget(endOfMonth, Date.parse(endOfMonth.expiresAt))!.expiresAt,
    new Date(2027, 1, 28).toISOString(),
  );
  // A one-off credit still just expires.
  assert.equal(renewedApiBudget({ ...monthly, monthlyUsd: undefined }, Date.parse(local(12, 1))), undefined);
  assert.equal(apiBudgetPolicy({ expiresAt: local(11, 12), monthlyUsd: 200 }).limitUsd, 200);
  assert.throws(() => apiBudgetPolicy({ limitUsd: 84, monthlyUsd: 200 }));
  assert.throws(() => apiBudgetPolicy({ expiresAt: local(11, 12), monthlyUsd: 0.5 }));
});

test('the card renews itself when read: the new period counts only new spend and routing may use it again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-api-monthly-'));
  const store = new Store(dir);
  const usage = new UsageLedger(store.db);
  const renewal = now - 20 * 86_400_000;
  const target: RuntimeTarget = {
    id: 'api-monthly-fixture',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'openai',
    label: 'Synthetic OpenAI',
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    apiBudget: apiBudgetPolicy(
      { limitUsd: 84, expiresAt: new Date(renewal).toISOString(), monthlyUsd: 200 },
      undefined,
      new Date(renewal - 13 * 86_400_000).toISOString(),
    ),
  };
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    store,
    targets: [target],
    active: new Map(),
    apiExtraUsage: {},
    apiBalances: {},
    apiWorkspaceLookups: {},
    snapshots: [],
    clock: () => now,
  });
  const spend = (id: string, startedAt: number, costUsd: number) => {
    const run: RunRecord = {
      id,
      prompt: 'fixture',
      projectPath: 'C:/p',
      kind: 'general',
      status: 'completed',
      route: { runtimeId: target.id, model: 'openai/m', kind: 'general', reasons: [], warnings: [] },
      startedAt: new Date(startedAt).toISOString(),
      output: '',
      events: [],
    };
    store.saveRun(run);
    usage.record(run, target, { at: run.startedAt, type: 'usage', data: { eventId: 'cost', costUsd } }, 'usage');
  };
  try {
    spend('old-period', renewal - 86_400_000, 50);
    spend('new-period', renewal + 86_400_000, 12);
    const budget = controller.apiProviders()[0]!.budget!;
    assert.equal(budget.policy.limitUsd, 200);
    assert.equal(budget.policy.startedAt, new Date(renewal).toISOString());
    assert.ok(Date.parse(budget.policy.expiresAt!) > now);
    assert.equal(budget.spentUsd, 12);
    assert.equal(budget.remainingUsd, 188);
    assert.ok(apiCreditPace(budget, now)!.priority > 0);
    assert.equal(store.config<RuntimeTarget[]>('targets', [])[0]!.apiBudget!.limitUsd, 200);
    // Behind the straight line to the next renewal, so automatic routing may pick it without a pin.
    assert.equal(automaticApiTarget(api(0, { apiBudgetState: budget }), now), true);
    // Linked to a Codex account whose refreshed status is the free plan: the credit stops at once.
    target.apiBudget = { ...target.apiBudget!, linkedAccountId: 'codex-fixture' };
    Object.assign(controller, { snapshots: [{ id: 'codex-fixture', subscription: { label: 'Free' } }] });
    const lapsed = controller.apiProviders()[0]!.budget!;
    assert.equal(lapsed.phase, 'expired');
    assert.equal(automaticApiTarget(api(0, { apiBudgetState: lapsed }), now), false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credit linked to a subscription lasts only while that account shows a paid plan', () => {
  const local = (month: number, day: number) => new Date(2026, month - 1, day).toISOString();
  const plans: Record<string, string | undefined> = { codex: 'Pro', 'codex-free': 'Free' };
  const planOf = (id: string) => plans[id];
  const value = { limitUsd: 84, expiresAt: local(11, 12), monthlyUsd: 200, linkedAccountId: 'codex' };
  const linked = apiBudgetPolicy(value, undefined, local(10, 30), planOf);
  assert.equal(linked.linkedAccountId, 'codex');
  for (const account of ['codex-free', 'missing'])
    assert.throws(() => apiBudgetPolicy({ ...value, linkedAccountId: account }, undefined, local(10, 30), planOf));
  assert.throws(() => apiBudgetPolicy({ limitUsd: 84, linkedAccountId: 'codex' }, undefined, local(10, 30), planOf));
  // Re-saving keeps the link while the account is briefly unreadable.
  assert.equal(apiBudgetPolicy(value, linked, local(11, 1), () => undefined).linkedAccountId, 'codex');
  const after = Date.parse(local(11, 13));
  for (const plan of ['Pro', 'Plus']) {
    plans.codex = plan;
    assert.equal(renewedApiBudget(linked, after, planOf)!.limitUsd, 200, plan);
    assert.equal(linkedCreditLapsed(linked, planOf), false);
  }
  for (const plan of ['Free', undefined]) {
    plans.codex = plan;
    assert.equal(renewedApiBudget(linked, after, planOf), undefined, String(plan));
  }
  // Free right now: the remaining credit is gone before the renewal date, so no run is admitted.
  plans.codex = 'Free';
  assert.equal(linkedCreditLapsed(linked, planOf), true);
  const view = apiBudgetView(linked, 0, 0, 0, Date.parse(local(11, 1)), linkedCreditLapsed(linked, planOf));
  assert.equal(view.phase, 'expired');
  // An unreadable account keeps the current credit; only a reported free plan ends it.
  plans.codex = undefined;
  assert.equal(linkedCreditLapsed(linked, planOf), false);
  // Paid again later: the current month's credit, not the missed ones.
  plans.codex = 'Pro';
  const back = renewedApiBudget(linked, Date.parse(local(12, 20)), planOf)!;
  assert.deepEqual(
    [back.limitUsd, back.startedAt, back.expiresAt],
    [200, local(12, 12), new Date(2027, 0, 12).toISOString()],
  );
});

test('a monthly credit paces evenly over its whole period; a one-off credit keeps the last fourteen days', () => {
  const start = now - 2 * 86_400_000;
  const expiry = new Date(now + 28 * 86_400_000).toISOString();
  const view = (changes = {}) =>
    apiBudgetView(
      apiBudgetPolicy({ limitUsd: 200, expiresAt: expiry, ...changes }, undefined, new Date(start).toISOString()),
      0,
      0,
      0,
      now,
    );
  const monthly = apiCreditPace(view({ monthlyUsd: 200 }), now)!;
  assert.equal(monthly.plannedUsd.toFixed(4), ((200 * 2) / 30).toFixed(4));
  assert.ok(monthly.priority > 0);
  assert.equal(automaticApiTarget(api(0, { apiBudgetState: view({ monthlyUsd: 200 }) }), now), true);
  const oneOff = apiCreditPace(view(), now)!;
  assert.equal(oneOff.plannedUsd, 0);
  assert.equal(oneOff.priority, 0);
});

test('a paid card read from the message is a preference that never blocks the task', () => {
  // Regression: a question mentioning DeepSeek pinned the paid card and the whole reply failed.
  const card = api(24 * 30, { apiBudgetState: apiBudgetView(policy(24 * 30), 0, 0, 0, now) });
  assert.equal(automaticApiTarget(card, now), false);
  const request = { ...input, runtimeId: card.id, automaticExecutorSelection: true, runtimeIdFromMessage: true };
  const decision = route(request, [card, cli], settings, new Set(), now);
  assert.equal(decision.runtimeId, cli.id);
  assert.ok(decision.warnings.some((warning) => warning.includes('消息里提到的 API 这次接不了，已自动改用 CLI')));
  // Without the message marker the same selection keeps its existing protection.
  assert.throws(
    () => route({ ...request, runtimeIdFromMessage: undefined }, [card, cli], settings, new Set(), now),
    RouteUnavailableError,
  );
});

test('a one-time credit that ran out switches its card off once; turning it back on sticks', (t) => {
  const store = new Store(temporaryFolder(t, 'api-credit-close-'));
  new UsageLedger(store.db);
  const card = (id: string, apiBudget: RuntimeTarget['apiBudget']): RuntimeTarget => ({
    id,
    provider: 'pi',
    gateway: 'api',
    label: id,
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    apiBudget,
  });
  const targets = [
    card('Ended', { ...policy(20), expiresAt: at(-1) }),
    card('Live', policy(20)),
    card('Monthly', { ...policy(20), expiresAt: at(-1), monthlyUsd: 10 }),
  ];
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    store,
    targets,
    snapshots: [],
    active: new Map(),
    apiExtraUsage: {},
    clock: () => now,
    settings,
    targetGeneration: 0,
    cooldown: { forget() {} },
    inbox: { resolveRuntime() {} },
  });
  const close = () => (controller as unknown as { closeEndedCredits(): boolean }).closeEndedCredits();
  try {
    assert.equal(close(), true);
    assert.deepEqual(
      targets.map((target) => target.enabled),
      [false, true, true],
    );
    assert.equal(targets[0]!.executionDisabledByUser, true);
    // The owner turns it back on: the same credit never closes it again.
    targets[0]!.enabled = true;
    delete targets[0]!.executionDisabledByUser;
    assert.equal(close(), false);
    assert.equal(targets[0]!.enabled, true);
  } finally {
    store.db.close();
  }
});

test('switching a card on or off is not blocked by a running task, other changes still are', (t) => {
  const store = new Store(temporaryFolder(t, 'api-toggle-running-'));
  const target: RuntimeTarget = {
    id: 'toggle-card',
    provider: 'pi',
    gateway: 'api',
    label: 'Toggle card',
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
  };
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    store,
    targets: [target],
    snapshots: [],
    active: new Map([['run', { run: { id: 'run', status: 'running' } }]]),
    settings,
    targetGeneration: 0,
    cooldown: { forget() {} },
    inbox: { resolveRuntime() {} },
    executing: () => true,
    clearCursorReference() {},
    broadcast() {},
    refresh: async () => undefined,
  });
  try {
    controller.updateTarget(target.id, { enabled: false });
    assert.equal(target.enabled, false);
    assert.throws(() => controller.updateTarget(target.id, { label: 'Renamed', command: 'other' }), /请等运行结束/);
  } finally {
    store.db.close();
  }
});

test('a saved Navigator route is a preference too, and its model does not carry to the other card', () => {
  const card = api(24 * 30, { apiBudgetState: apiBudgetView(policy(24 * 30), 0, 0, 0, now) });
  const request = {
    ...input,
    runtimeId: card.id,
    model: 'synthetic-api-model',
    automaticExecutorSelection: true,
    runtimeIdFromMode: true,
  };
  const decision = route(request, [card, cli], settings, new Set(), now);
  assert.equal(decision.runtimeId, cli.id);
  assert.notEqual(decision.model, 'synthetic-api-model');
  assert.ok(decision.warnings.some((warning) => warning.includes('领航员使用的 API 这次接不了，已自动改用 CLI')));
});
