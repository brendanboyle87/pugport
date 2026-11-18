import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { AccountHealth } from '../src/server/account-health.ts';
import { route } from '../src/server/routing.ts';
import type { RunRecord, RuntimeSnapshot, RuntimeTarget, Settings } from '../src/shared/types.ts';

const epoch = Date.parse('2026-09-27T12:00:00Z');
const iso = (offset: number) => new Date(epoch + offset).toISOString();
type Fingerprinted = { accountFingerprint?: string };
type AvailableSnapshot = RuntimeSnapshot & {
  availability?: { reason: 'quota' | 'authentication'; retryAt?: string; observedAt: string };
};
const target = (id = 'grok-one', hash?: string): RuntimeTarget & Fingerprinted => ({
  id,
  provider: 'grok',
  label: id,
  command: 'unused',
  enabled: true,
  environment: 'native',
  ...(hash ? { accountFingerprint: hash } : {}),
});
function failed(runtime = target(), error = 'quota-or-rate-limit', id = 'run-one'): RunRecord {
  return {
    id,
    prompt: 'synthetic test',
    projectPath: 'unused',
    kind: 'general',
    status: 'failed',
    route: { runtimeId: runtime.id, model: 'fixture-model', kind: 'general', reasons: [], warnings: [] },
    startedAt: iso(-1000),
    endedAt: iso(0),
    output: '',
    events: [],
    error,
  };
}
function observed(
  runtime = target(),
  windows: RuntimeSnapshot['quota']['windows'] = [],
): RuntimeSnapshot & Fingerprinted {
  return {
    id: runtime.id,
    provider: runtime.provider,
    label: runtime.label,
    environment: runtime.environment,
    ...(runtime.accountFingerprint ? { accountFingerprint: runtime.accountFingerprint } : {}),
    installed: true,
    status: 'ready',
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low'] }],
    quota: { status: windows.length ? 'known' : 'unknown', source: 'synthetic', observedAt: iso(0), windows },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(0),
  };
}
const window = (id: string, used: number | null, resetsAt: string | null) => ({
  id,
  label: id,
  usedPercent: used,
  resetsAt,
});
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  let clock = epoch;
  t.after(() => db.close());
  return {
    db,
    health: new AccountHealth(db, () => clock),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
const availability = (snapshot: RuntimeSnapshot) => (snapshot as AvailableSnapshot).availability;

test('only exact native failed quota and authentication errors persist health', (t) => {
  const { health } = fixture(t);
  for (const runtime of [
    { ...target(), provider: 'pi' as const },
    { ...target(), provider: 'dsh' as const },
    { ...target(), environment: 'wsl' as const },
    { ...target(), gateway: 'magpie' as const },
  ])
    health.failure(runtime, failed(runtime));
  for (const error of [
    'runtime-timeout',
    'runtime-network-error',
    'operation-cancelled',
    'raw quota text',
    'api-key-auth-or-configuration',
  ])
    health.failure(target(), failed(target(), error));
  for (const status of ['completed', 'cancelled', 'interrupted', 'running'] as const)
    health.failure(target(), { ...failed(), status });
  health.failure(target('wrong-target'), failed());
  assert.deepEqual(health.report(), []);
  health.failure(target(), failed());
  assert.equal(health.report().length, 1);
  assert.equal(health.report()[0]!.reason, 'quota');
  assert.equal(health.report()[0]!.retryAt, iso(60000));
});

test('quota failure waits for the latest genuinely exhausted valid window, excluding reserve margins and invalid windows', (t) => {
  const { health } = fixture(t),
    runtime = target();
  const snapshot = observed(runtime, [
    window('short', 100, iso(300000)),
    window('week', 100, iso(3600000)),
    window('reserve-only', 95, iso(8 * 86400000)),
    window('missing-use', null, iso(9 * 86400000)),
    window('bad-reset', 100, 'not-a-time'),
    window('already-reset', 100, iso(-1000)),
  ]);
  health.failure(runtime, failed(runtime), snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(3600000));
  const before = structuredClone(snapshot),
    applied = health.apply(snapshot);
  assert.deepEqual(snapshot, before, 'apply never mutates the discovery snapshot');
  assert.deepEqual(availability(applied), { reason: 'quota', retryAt: iso(3600000), observedAt: iso(0) });
  const { availability: _health, ...rest } = applied as AvailableSnapshot;
  assert.deepEqual(rest, snapshot, 'quota values, models and capabilities are retained exactly');
});

test('unknown, mismatched or non-exhausted windows use a 60-second retry instead of pretending to know a reset', (t) => {
  const { health } = fixture(t),
    runtime = target();
  const variants = [
    undefined,
    observed(runtime),
    observed(target('other'), [window('full', 100, iso(86400000))]),
    observed(runtime, [window('reserve', 90, iso(86400000))]),
    observed(runtime, [window('missing', 100, null)]),
    {
      ...observed(runtime, [window('full', 100, iso(86400000))]),
      quota: { ...observed(runtime).quota, status: 'error' as const },
    },
  ];
  for (let i = 0; i < variants.length; i++) {
    health.clear(runtime.id);
    health.failure(runtime, failed(runtime, 'quota-or-rate-limit', `run-${i}`), variants[i]);
    assert.equal(health.report()[0]!.retryAt, iso(60000));
  }
});

test('Grok Build billing waits independently of subscription refresh, login checks and successful native custom or API turns', (t) => {
  const { health, advance } = fixture(t);
  const runtime = target('grok-b', 'synthetic-b'),
    alias = target('alias-b', 'synthetic-b');
  const run = failed(runtime);
  run.events = [
    {
      at: iso(0),
      type: 'status',
      data: { source: 'native', kind: 'billing-exhausted', billingSource: 'grok-build', detail: { statusCode: 402 } },
    },
  ];
  health.failure(runtime, run, observed(runtime, [window('week', 0, iso(86400000))]));
  assert.equal(health.report()[0]!.billingSource, 'grok-build');
  assert.equal(health.report()[0]!.retryAt, iso(15 * 60000));
  advance(60000);
  const fresh = observed(alias, [window('week', 0, iso(86400000))]);
  fresh.quota.observedAt = iso(60000);
  assert.equal(
    availability(health.apply(fresh))?.reason,
    'quota',
    'alias + new weekly reading cannot prove Build balance recovery',
  );
  for (const model of ['grok-4.7-build-fast', 'custom-native-model', 'api/grok-custom']) {
    // Controller records every completed turn through failure(), which ignores
    // successes. A model name or reply cannot prove the same billing pool.
    health.failure(runtime, { ...run, status: 'completed', route: { ...run.route, model }, output: 'Actual reply' });
    assert.equal(availability(health.apply(fresh))?.reason, 'quota', model);
  }
  health.failure(runtime, failed(runtime, 'authentication-required', 'auth-after-billing'));
  assert.equal(availability(health.apply(fresh))?.reason, 'authentication');
  health.clear(alias.id);
  assert.equal(
    availability(health.apply(fresh))?.reason,
    'quota',
    'successful login metadata retains the billing gate',
  );
  assert.equal(health.report()[0]!.retryAt, iso(15 * 60000));
  health.clear(runtime.id);
  assert.equal(availability(health.apply(fresh))?.reason, 'quota', 'an ordinary account check cannot clear billing');
  assert.equal(health.report().length, 1);
  advance(15 * 60000);
  assert.equal(
    availability(health.apply(fresh)),
    undefined,
    'cooldown permits a later bounded probe, not a claim of replenishment',
  );
  assert.equal(health.report()[0]!.billingSource, 'grok-build', 'probe time retains the diagnostic history');
  // The probe fails again: a repeated 402 waits longer instead of probing every 15 minutes.
  health.failure(runtime, { ...run, id: 'probe-402', endedAt: iso(16 * 60000) });
  assert.equal(health.report()[0]!.retryAt, iso(16 * 60000 + 60 * 60000));
});

test('the last sanitized actual 402 retains its effective model, request and time across aliases, authentication checks and cooldown expiry', (t) => {
  const { health, advance } = fixture(t);
  const runtime = target('grok-b', 'synthetic-b'),
    alias = target('alias-b', 'synthetic-b');
  const run = failed(runtime, 'quota-or-rate-limit', 'actual-402');
  run.errorCode = 'quota-or-rate-limit';
  run.error = 'private provider diagnostic token=synthetic-secret';
  run.effectiveModel = { model: 'grok-4.7-build-fast', source: 'native' };
  run.events = [
    {
      at: iso(0),
      type: 'status',
      data: {
        source: 'native',
        kind: 'billing-exhausted',
        billingSource: 'grok-build',
        detail: { statusCode: 402, token: 'synthetic-secret' },
      },
    },
  ];
  const fresh = observed(alias, [window('week', 0, iso(86400000))]);
  fresh.quota.grokBilling = { isUnifiedBillingUser: true, percentSource: 'implicit-zero' };
  health.failure(runtime, run);
  const initial = health.apply(fresh);
  const diagnostic = initial.lastRequestFailure!;
  assert.equal(diagnostic.model, 'grok-4.7-build-fast');
  assert.equal(diagnostic.runId, 'actual-402');
  assert.equal(diagnostic.at, iso(0));
  assert.equal(diagnostic.source, 'Grok Build ACP');
  assert.equal(diagnostic.statusCode, 402);
  assert.equal(diagnostic.errorCode, 'quota-or-rate-limit');
  assert.ok(!JSON.stringify(initial).includes('synthetic-secret'));
  assert.equal(initial.availability?.billingFailure?.runId, diagnostic.runId);
  assert.equal(initial.quota.windows[0]!.usedPercent, 0, 'actual failure does not rewrite the official reading');
  assert.equal(initial.quota.grokBilling?.percentSource, 'implicit-zero');
  health.failure(runtime, failed(runtime, 'authentication-required', 'auth-after-402'));
  health.clear(alias.id);
  assert.deepEqual(health.apply(fresh).lastRequestFailure, diagnostic);
  advance(15 * 60000);
  const expired = health.apply(fresh);
  assert.equal(expired.availability, undefined, 'probe time ends the dispatch wait');
  assert.deepEqual(
    expired.lastRequestFailure,
    diagnostic,
    'probe time does not erase the conflicting request evidence',
  );
  health.clear(alias.id);
  assert.deepEqual(health.apply(fresh).lastRequestFailure, diagnostic, 'metadata still does not demonstrate recovery');
  assert.equal(health.apply(observed(target('other-account', 'synthetic-c'))).lastRequestFailure, undefined);

  const next = {
    ...run,
    id: 'next-402',
    endedAt: iso(15 * 60000),
    effectiveModel: { model: 'private token=synthetic-secret', source: 'native' as const },
  };
  health.failure(runtime, next);
  assert.equal(health.apply(fresh).lastRequestFailure?.runId, next.id);
  assert.equal(health.apply(fresh).lastRequestFailure?.model, undefined);
  assert.ok(!JSON.stringify(health.apply(fresh)).includes('synthetic-secret'));
});

function billingRun(runtime: RuntimeTarget, id: string, endedAt: number): RunRecord {
  const run = failed(runtime, 'quota-or-rate-limit', id);
  run.endedAt = iso(endedAt);
  run.events = [
    {
      at: iso(endedAt),
      type: 'status',
      data: { source: 'native', kind: 'billing-exhausted', billingSource: 'grok-build', detail: { statusCode: 402 } },
    },
  ];
  return run;
}

test('repeated Build 402s on one account escalate the wait until a completed run or the billing period end', (t) => {
  const { health, advance } = fixture(t);
  const runtime = target('grok-b', 'synthetic-b');
  const minutes = (value: number) => value * 60000;
  let at = 0;
  const fail = (id: string, snapshot?: RuntimeSnapshot) => {
    health.failure(runtime, billingRun(runtime, id, at), snapshot);
    return Date.parse(health.report()[0]!.retryAt!) - (epoch + at);
  };
  const waits: number[] = [];
  for (const id of ['first', 'second', 'third', 'fourth', 'fifth']) {
    waits.push(fail(id));
    at += waits.at(-1)!;
    advance(waits.at(-1)!);
  }
  assert.deepEqual(waits, [minutes(15), minutes(60), minutes(240), minutes(1440), minutes(1440)]);

  // A completed run on the same account restarts the escalation but does not end the current wait.
  fail('sixth');
  advance(minutes(1));
  at += minutes(1);
  const success = { ...failed(runtime), id: 'later-success', status: 'completed' as const, endedAt: iso(at) };
  health.failure(runtime, success);
  assert.equal(availability(health.apply(observed(runtime)))?.reason, 'quota', 'a reply cannot prove Build balance');
  assert.equal(health.apply(observed(runtime)).lastRequestFailure?.laterSuccessAt, iso(at));
  advance(minutes(1440));
  at += minutes(1440);
  assert.equal(fail('after-success'), minutes(15));
  assert.equal(health.apply(observed(runtime)).lastRequestFailure?.laterSuccessAt, undefined);

  // A billing period that ends sooner caps the wait; once it has passed, the next 402 starts over.
  advance(minutes(15));
  at += minutes(15);
  const period = observed(runtime, [window('included', 0, iso(at + minutes(30)))]);
  period.quota.observedAt = iso(at);
  assert.equal(fail('before-period-end', period), minutes(30), 'probe at the new period, never sooner than 15 min');
  advance(minutes(30));
  at += minutes(30);
  assert.equal(fail('new-period'), minutes(15));
  // Other accounts are unaffected.
  const other = target('grok-c', 'synthetic-c');
  health.failure(other, billingRun(other, 'other-account', at));
  assert.equal(
    health.report().find((entry) => entry.runtimeId === other.id)!.retryAt,
    new Date(epoch + at + minutes(15)).toISOString(),
  );
});

test('an inferred full Grok billing reading does not outrank a real 402 when routing between accounts', (t) => {
  const { health, advance } = fixture(t);
  const a = target('grok-a', 'synthetic-a'),
    b = target('grok-b', 'synthetic-b');
  const settings: Settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 4,
  };
  health.failure(b, billingRun(b, 'b-402', 0));
  advance(16 * 60000);
  const now = epoch + 16 * 60000;
  const reading = (runtime: RuntimeTarget, used: number, source: 'cli-reported' | 'implicit-zero') => {
    const snapshot = observed(runtime, [window('included', used, new Date(now + 10 * 86400000).toISOString())]);
    snapshot.quota.observedAt = snapshot.refreshedAt = new Date(now).toISOString();
    snapshot.quota.grokBilling = { isUnifiedBillingUser: true, percentSource: source };
    return health.apply(snapshot);
  };
  const choose = (snapshots: RuntimeSnapshot[]) =>
    route(
      { prompt: 'Implement a parser', projectPath: 'C:/Fixture', kind: 'general', provider: 'grok' },
      snapshots,
      settings,
      new Set(),
      now,
    );
  const realA = reading(a, 40, 'cli-reported');
  const inferredB = reading(b, 0, 'implicit-zero');
  assert.equal(inferredB.availability, undefined, 'the 15 minute wait is over');
  assert.equal(inferredB.lastRequestFailure?.statusCode, 402);
  assert.equal(choose([inferredB, realA]).runtimeId, 'grok-a', 'A really has 60% left; B only looks full');
  // With nothing else available, B is still probed, and the reason does not claim a real reading.
  const alone = choose([inferredB]);
  assert.equal(alone.runtimeId, 'grok-b');
  assert.ok(alone.reasons.some((reason) => reason.includes('HTTP 402')));
  assert.ok(!alone.reasons.some((reason) => reason.includes('不限量')));
  // A reported percentage, or a later success on B, is real evidence again.
  assert.equal(choose([reading(b, 0, 'cli-reported'), realA]).runtimeId, 'grok-b');
  const tested = {
    ...inferredB,
    lastConnectionTest: { at: new Date(now).toISOString(), ok: true, model: 'fixture-model' },
  };
  assert.equal(choose([tested, realA]).runtimeId, 'grok-b');
  health.failure(b, { ...failed(b), id: 'b-success', status: 'completed', endedAt: new Date(now).toISOString() });
  assert.equal(choose([reading(b, 0, 'implicit-zero'), realA]).runtimeId, 'grok-b');
});

test('existing billing history enriches only its matching archived native 402 without changing identity or retry time', (t) => {
  const { health, db, advance } = fixture(t),
    runtime = target('grok-b', 'synthetic-b');
  const run = failed(runtime, 'quota-or-rate-limit', 'old-402');
  run.errorCode = 'quota-or-rate-limit';
  run.events = [
    {
      at: iso(0),
      type: 'status',
      data: {
        source: 'native',
        kind: 'billing-exhausted',
        billingSource: 'grok-build',
        detail: { provider: 'grok', statusCode: 402 },
      },
    },
  ];
  health.failure(runtime, run);
  db.exec("UPDATE native_account_health SET value=json_remove(value,'$.billingFailure')");
  const before = health.report()[0]!;
  advance(60000);
  for (const candidate of [
    undefined,
    { ...run, id: 'not-the-stored-run' },
    { ...run, route: { ...run.route, runtimeId: 'another-runtime' } },
    { ...run, events: [] },
    { ...run, status: 'completed' as const },
    { ...run, errorCode: 'runtime-request-failed' },
    {
      ...run,
      events: [{ ...run.events[0]!, data: { ...run.events[0]!.data, detail: { provider: 'codex', statusCode: 402 } } }],
    },
  ]) {
    assert.equal(
      health.enrichExistingEvidence(() => candidate),
      0,
    );
    assert.deepEqual(health.report()[0], before);
  }
  const calls: string[] = [];
  assert.equal(
    health.enrichExistingEvidence((id) => {
      calls.push(id);
      return run;
    }),
    1,
  );
  assert.deepEqual(calls, ['old-402']);
  const after = health.report()[0]!;
  assert.deepEqual({ ...after, billingFailure: undefined }, { ...before, billingFailure: undefined });
  assert.equal(after.billingFailure?.runId, run.id);
  assert.equal(after.billingFailure?.at, run.endedAt);
  assert.equal(after.retryAt, iso(15 * 60000), 'startup enrichment does not extend the retry window');
  assert.equal(
    health.enrichExistingEvidence(() => {
      assert.fail('complete evidence must not reread a run');
    }),
    0,
  );
});

test('late native 402 evidence retains its billing source through quota replay and authentication clearing without extending existing retry times', (t) => {
  const { health, advance } = fixture(t);
  for (const reason of ['quota-or-rate-limit', 'authentication-required']) {
    const runtime = target(`grok-${reason}`, `synthetic-${reason}`);
    const original = failed(runtime, reason, `old-${reason}`);
    health.failure(runtime, original);
    const before = health.report().find((entry) => entry.runtimeId === runtime.id)!;
    advance(1000);
    const actual = {
      ...failed(
        runtime,
        'quota-or-rate-limit',
        reason === 'quota-or-rate-limit' ? original.id : 'actual-402-after-auth',
      ),
      errorCode: 'quota-or-rate-limit',
      events: [
        {
          at: iso(0),
          type: 'status' as const,
          data: {
            source: 'native',
            kind: 'billing-exhausted',
            billingSource: 'grok-build',
            detail: { provider: 'grok', statusCode: 402 },
          },
        },
      ],
    };
    health.failure(runtime, actual);
    const after = health.report().find((entry) => entry.runtimeId === runtime.id)!;
    assert.deepEqual(
      { ...after, billingFailure: undefined, billingSource: undefined },
      { ...before, billingFailure: undefined, billingSource: undefined },
      'enrichment retains the original identity, run and retry deadline',
    );
    assert.equal(after.billingSource, 'grok-build');
    assert.equal(after.billingFailure?.runId, actual.id);
    health.clear(runtime.id);
    assert.equal(health.apply(observed(runtime)).lastRequestFailure?.runId, actual.id);
    assert.equal(health.report().find((entry) => entry.runtimeId === runtime.id)?.retryAt, before.retryAt);
  }
});

test('Composer rate limiting cannot borrow an exhausted Other Models pool monthly reset', (t) => {
  const { health, advance } = fixture(t);
  const runtime = { ...target('cursor-native', 'c'.repeat(64)), provider: 'cursor' as const };
  const snapshot = observed(runtime, [
    { ...window('cursor-auto', 20, iso(30 * 86400000)), modelPool: 'cursor' },
    { ...window('cursor-api', 100, iso(30 * 86400000)), modelPool: 'other' },
  ]);
  snapshot.models = [
    { id: 'composer-2.5', label: 'Composer', efforts: [], quotaPool: 'cursor' },
    { id: 'claude-sonnet-5', label: 'Claude', efforts: [], quotaPool: 'other' },
  ];
  const run = failed(runtime);
  run.route.model = 'composer-2.5';
  health.failure(runtime, run, snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(60_000));
  assert.equal(availability(health.apply(snapshot))?.reason, 'quota', 'the normal short rate-limit protection remains');
  advance(60_000);
  assert.equal(availability(health.apply(snapshot)), undefined, 'Other Models does not block Composer until month end');
  assert.equal(snapshot.quota.windows[1]!.usedPercent, 100, 'the sibling pool is still reported as exhausted');
});

test('only shared limits can extend a Cursor account cooldown, with or without a matching model', (t) => {
  const { health } = fixture(t);
  const runtime = { ...target('cursor-native', 'd'.repeat(64)), provider: 'cursor' as const };
  const snapshot = observed(runtime, [
    { ...window('cursor-auto', 100, iso(30 * 86400000)), modelPool: 'cursor' },
    { ...window('cursor-api', 100, iso(3600000)), modelPool: 'other' },
  ]);
  snapshot.models = [{ id: 'claude-sonnet-5', label: 'Claude', efforts: [], quotaPool: 'other' }];
  const run = failed(runtime);
  run.route.model = 'claude-sonnet-5';
  health.failure(runtime, run, snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(60_000), 'an exhausted model pool cannot lock the entire account');

  health.clear(runtime.id);
  snapshot.models = [];
  health.failure(runtime, { ...run, id: 'missing-model' }, snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(60_000), 'an absent model cannot identify which pool failed');

  health.clear(runtime.id);
  snapshot.quota.windows.push(window('shared', 100, iso(120000)));
  health.failure(runtime, { ...run, id: 'missing-model-shared-limit' }, snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(120000), 'a shared exhausted limit applies even without a model entry');
});

test('an Other Models quota failure releases Composer after the short cooldown while routing still rejects Other Models', (t) => {
  const { health, advance } = fixture(t);
  const runtime = { ...target('cursor-native', 'e'.repeat(64)), provider: 'cursor' as const };
  const snapshot = observed(runtime, [
    { ...window('Cursor Models', 20, iso(30 * 86400000)), modelPool: 'cursor' },
    { ...window('Other Models', 100, iso(30 * 86400000)), modelPool: 'other' },
  ]);
  snapshot.models = [
    { id: 'claude-sonnet-5', label: 'Claude', efforts: [], quotaPool: 'other' },
    { id: 'composer-2.5', label: 'Composer', efforts: [], quotaPool: 'cursor' },
  ];
  const settings: Settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 4,
  };
  const choose = (model: string | undefined, offset = 0) =>
    route(
      { prompt: 'Implement a parser', projectPath: 'C:/Fixture', kind: 'general', runtimeId: runtime.id, model },
      [health.apply(snapshot)],
      settings,
      new Set(),
      epoch + offset,
    );
  const run = failed(runtime);
  run.route.model = 'claude-sonnet-5';
  health.failure(runtime, run, snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(60_000));
  assert.throws(() => choose('composer-2.5'), /账号刚返回额度不足或限流/, 'shared short protection remains');

  advance(60_000);
  assert.equal(choose('composer-2.5', 60_000).model, 'composer-2.5');
  assert.equal(choose(undefined, 60_000).model, 'composer-2.5', 'automatic selection can recover to the funded pool');
  assert.throws(() => choose('claude-sonnet-5', 60_000), /Other Models.*保护阈值/);

  snapshot.quota.windows.push(window('shared', 100, iso(3600000)));
  health.failure(runtime, { ...run, id: 'shared-quota' }, snapshot);
  assert.equal(health.report()[0]!.retryAt, iso(3600000), 'a real shared limit still locks the whole account');
  assert.throws(() => choose('composer-2.5', 60_000), /账号刚返回额度不足或限流/);
  health.failure(runtime, failed(runtime, 'authentication-required', 'cursor-auth'), snapshot);
  assert.throws(() => choose('composer-2.5', 60_000), /账号认证已失效/, 'authentication always remains account-wide');
});

test('unknown or freshly low quota cannot clear a recorded cooldown, and expiry preserves history without fabricating quota', (t) => {
  const { health, advance } = fixture(t),
    runtime = target();
  health.failure(runtime, failed(runtime), observed(runtime, [window('full', 100, iso(120000))]));
  const unknown = observed(runtime),
    fresh = observed(runtime, [window('now-low', 2, iso(86400000))]);
  assert.equal(availability(health.apply(unknown))?.reason, 'quota');
  assert.equal(availability(health.apply(fresh))?.reason, 'quota');
  advance(120000);
  const after = health.apply(health.apply(unknown));
  assert.equal(availability(after), undefined);
  assert.equal(after.quota.status, 'unknown');
  assert.deepEqual(after.quota.windows, []);
  assert.equal(health.report().length, 1);
  assert.equal(health.report()[0]!.retryAt, iso(120000));
});

test('authentication remains latched across time and later quota errors until explicit clear', (t) => {
  const { health, advance } = fixture(t),
    runtime = target();
  health.failure(runtime, failed(runtime, 'authentication-required'));
  advance(30 * 86400000);
  health.failure(runtime, failed(runtime, 'quota-or-rate-limit', 'later-quota'));
  const applied = health.apply(observed(runtime, [window('unused', 0, iso(31 * 86400000))]));
  assert.equal(availability(applied)?.reason, 'authentication');
  assert.equal(availability(applied)?.retryAt, undefined);
  assert.equal(health.report()[0]!.runId, 'run-one');
  health.clear(runtime.id);
  assert.deepEqual(health.report(), []);
  assert.equal(availability(health.apply(applied)), undefined);
});

test('failure replay is idempotent and a newer short cooldown never shortens an existing reliable reset', (t) => {
  const { health, advance } = fixture(t),
    runtime = target(),
    run = failed(runtime);
  health.failure(runtime, run);
  advance(10000);
  health.failure(runtime, run);
  assert.equal(health.report()[0]!.retryAt, iso(60000));
  assert.equal(health.report()[0]!.observedAt, iso(0));
  health.failure(
    runtime,
    failed(runtime, 'quota-or-rate-limit', 'long-reset'),
    observed(runtime, [window('full', 100, iso(3600000))]),
  );
  advance(10000);
  health.failure(runtime, failed(runtime, 'quota-or-rate-limit', 'unknown-reset'));
  assert.equal(health.report()[0]!.retryAt, iso(3600000));
  assert.equal(health.report()[0]!.observedAt, iso(20000));
});

test('a stable account fingerprint shares cooldown across aliases and an explicit check clears the shared identity', (t) => {
  const { health } = fixture(t),
    first = target('grok-one', 'a'.repeat(64)),
    duplicate = target('grok-two', 'a'.repeat(64)),
    other = target('grok-three', 'b'.repeat(64));
  health.failure(first, failed(first));
  assert.equal(availability(health.apply(observed(duplicate)))?.reason, 'quota');
  assert.equal(availability(health.apply(observed(other))), undefined);
  health.failure(duplicate, failed(duplicate, 'authentication-required', 'alias-auth'));
  assert.equal(health.report().length, 1);
  assert.equal(availability(health.apply(observed(first)))?.reason, 'authentication');
  health.clear(first.id);
  assert.equal(availability(health.apply(observed(duplicate))), undefined);
  assert.deepEqual(health.report(), []);
});

test('unknown identities remain runtime-local and a different known account does not inherit old identity health', (t) => {
  const { health } = fixture(t),
    one = target('grok-one'),
    two = target('grok-two');
  health.failure(one, failed(one));
  assert.equal(availability(health.apply(observed(two))), undefined);
  assert.equal(availability(health.apply(observed(target(one.id, 'c'.repeat(64)))))?.reason, 'quota');
  health.clear(one.id);
  const old = target(one.id, 'd'.repeat(64)),
    replacement = target(one.id, 'e'.repeat(64));
  health.failure(old, failed(old, 'authentication-required', 'old-account'));
  assert.equal(availability(health.apply(observed(replacement))), undefined);
  assert.equal(health.report().length, 1, 'the old account failure remains in history');
  assert.equal(
    availability(health.apply(observed(target('old-alias', old.accountFingerprint))))?.reason,
    'authentication',
  );
});

test('on-disk health survives a database restart and aliases recover the same fingerprint-based cooldown', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-health-test-')),
    file = join(directory, 'health.db');
  let db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('comborunner-health-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  const runtime = target('grok-one', 'f'.repeat(64)),
    alias = target('grok-two', 'f'.repeat(64));
  new AccountHealth(db, () => epoch).failure(runtime, failed(runtime));
  db.close();
  db = new DatabaseSync(file);
  const restored = new AccountHealth(db, () => epoch + 10000);
  assert.equal(availability(restored.apply(observed(alias)))?.retryAt, iso(60000));
  restored.clear(alias.id);
  assert.deepEqual(restored.report(), []);
});

test('same hashes from different providers do not share health, and non-native snapshots remain untouched', (t) => {
  const { health } = fixture(t),
    grok = target('grok-one', 'a'.repeat(64));
  health.failure(grok, failed(grok));
  const codex = { ...target('codex-one', grok.accountFingerprint), provider: 'codex' as const };
  assert.equal(availability(health.apply(observed(codex))), undefined);
  const wsl = { ...observed(grok), environment: 'wsl' as const },
    pi = { ...observed(grok), provider: 'pi' as const };
  assert.equal(health.apply(wsl), wsl);
  assert.equal(health.apply(pi), pi);
});

test("a snapshot from a replaced account cannot supply another account's long reset time", (t) => {
  const { health } = fixture(t),
    runtime = target('grok-one', 'a'.repeat(64));
  const previousAccount = target(runtime.id, 'b'.repeat(64));
  health.failure(runtime, failed(runtime), observed(previousAccount, [window('full', 100, iso(7 * 86400000))]));
  assert.equal(health.report()[0]!.retryAt, iso(60000));
});

test('a known identity cannot borrow an unidentified snapshot reset, while legacy unidentified runtimes keep their quota behavior', (t) => {
  const { health } = fixture(t);
  const known = target('known-profile', 'a'.repeat(64));
  const unidentified = observed(target(known.id), [window('full', 100, iso(7 * 86400000))]);
  health.failure(known, failed(known), unidentified);
  assert.equal(health.report()[0]!.accountFingerprint, known.accountFingerprint);
  assert.equal(
    health.report()[0]!.retryAt,
    iso(60000),
    "an unknown snapshot identity supplies no evidence of this account's reset",
  );

  health.clear(known.id);
  health.failure(
    known,
    failed(known, 'quota-or-rate-limit', 'same-identity'),
    observed(known, [window('full', 100, iso(7 * 86400000))]),
  );
  assert.equal(
    health.report()[0]!.retryAt,
    iso(7 * 86400000),
    'a matching known identity still supplies its reported reset',
  );

  const legacy = target('legacy-profile');
  health.failure(
    legacy,
    failed(legacy, 'quota-or-rate-limit', 'legacy'),
    observed(legacy, [window('full', 100, iso(3 * 86400000))]),
  );
  assert.equal(health.report().find((entry) => entry.runtimeId === legacy.id)!.retryAt, iso(3 * 86400000));
});

test('Codex API discovery does not inherit a remembered or persisted ChatGPT account cooldown', (t) => {
  const { health, db } = fixture(t);
  const subscription = { ...target('codex-native', 'a'.repeat(64)), provider: 'codex' as const };
  health.failure(subscription, failed(subscription, 'authentication-required'));
  const api = { ...observed({ ...subscription, accountFingerprint: undefined }), authMode: 'apiKey' as const };
  assert.equal(availability(health.apply(api)), undefined, 'an in-memory remembered subscription is ignored');
  const restarted = new AccountHealth(db, () => epoch);
  assert.equal(availability(restarted.apply(api)), undefined, 'a persisted subscription is ignored after restart');
  assert.equal(
    availability(restarted.apply({ ...api, accountFingerprint: subscription.accountFingerprint })),
    undefined,
    'even a stale fingerprint on the API snapshot cannot select a subscription health key',
  );
  assert.equal(
    availability(restarted.apply({ ...observed(subscription), authMode: 'chatgpt' }))?.reason,
    'authentication',
    'the subscription failure is retained for that original identity',
  );
});

test('Codex API discovery retains its own runtime-local quota and authentication failures', (t) => {
  const { health, db } = fixture(t);
  const subscription = { ...target('codex-native', 'b'.repeat(64)), provider: 'codex' as const };
  health.failure(subscription, failed(subscription, 'authentication-required', 'subscription-failure'));
  const apiTarget = { ...subscription, accountFingerprint: undefined };
  const api = { ...observed(apiTarget), authMode: 'apiKey' as const };
  health.failure(apiTarget, failed(apiTarget, 'quota-or-rate-limit', 'api-quota'));
  assert.deepEqual(
    availability(health.apply(api)),
    { reason: 'quota', observedAt: iso(0), retryAt: iso(60000) },
    'the old subscription authentication failure does not override the API cooldown',
  );
  health.failure(apiTarget, failed(apiTarget, 'authentication-required', 'api-auth'));
  const restarted = new AccountHealth(db, () => epoch);
  assert.equal(availability(restarted.apply(api))?.reason, 'authentication');
  assert.equal(
    availability(restarted.apply({ ...api, id: 'codex-other' })),
    undefined,
    'API credentials are not assigned a guessed shared identity',
  );
  restarted.clear(apiTarget.id);
  assert.equal(availability(restarted.apply(api)), undefined);
  assert.equal(
    availability(restarted.apply({ ...observed(subscription), authMode: 'chatgpt' }))?.reason,
    'authentication',
    'clearing an API runtime leaves the old subscription failure intact',
  );
});

test('retired Gemini account health is ignored without changing archived rows', (t) => {
  const { health, db } = fixture(t);
  const runtime = { ...target('gemini-native', 'a'.repeat(64)), provider: 'gemini' as const };
  const entry = {
    runtimeId: runtime.id,
    provider: runtime.provider,
    reason: 'account-disabled',
    observedAt: iso(0),
    runId: 'old-run',
  };
  db.prepare('INSERT INTO native_account_health(health_key,runtime_id,value) VALUES(?,?,?)').run(
    'legacy-gemini',
    runtime.id,
    JSON.stringify(entry),
  );
  health.failure(runtime, failed(runtime, 'authentication-required'));
  assert.deepEqual(health.report(), []);
  const snapshot = observed(runtime);
  assert.equal(health.apply(snapshot), snapshot);
  assert.equal(db.prepare('SELECT count(*) AS count FROM native_account_health').get()?.count, 1);
});
