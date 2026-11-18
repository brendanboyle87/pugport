import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ExecutorCooldownStore } from '../src/server/executor-cooldown.ts';
import type { RuntimeTarget, RuntimeSnapshot, RunRecord } from '../src/shared/types.ts';

const epoch = Date.parse('2026-10-27T00:00:00Z');
const iso = (n: number) => new Date(epoch + n).toISOString();
const target = (id = 'one', provider: RuntimeTarget['provider'] = 'cursor'): RuntimeTarget => ({
  id,
  provider,
  label: id,
  command: 'unused',
  environment: 'native',
  enabled: true,
});
const run = (id: string, at: number, code = 'runtime-process-closed', runtime = 'one'): RunRecord => ({
  id,
  prompt: '',
  projectPath: '',
  kind: 'general',
  status: 'failed',
  route: { runtimeId: runtime, model: 'fixture', kind: 'general', reasons: [], warnings: [] },
  startedAt: iso(at),
  output: '',
  events: [],
  errorCode: code,
});
const snapshot = (id = 'one') =>
  ({
    id,
    provider: 'cursor',
    label: id,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [],
    quota: { status: 'unknown', source: 'test', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: iso(0),
  }) as RuntimeSnapshot;
function fixture() {
  let now = 0;
  const db = new DatabaseSync(':memory:');
  return {
    db,
    health: new ExecutorCooldownStore(db, () => epoch + now),
    set: (n: number) => {
      now = n;
    },
  };
}

test('backoff schedule, deduplication and concurrent starts', () => {
  const f = fixture();
  for (const [i, minutes] of [1, 5, 15, 60, 60].entries()) {
    const at = i * 1000;
    f.set(at);
    assert.equal(f.health.failure(target(), run(`run-${i}`, at + 1))?.streak, i + 1);
    const value = f.health.apply(snapshot()).executorCooldown!;
    assert.equal(Date.parse(value.retryAt) - Date.parse(value.observedAt), minutes * 60000);
    assert.equal(f.health.failure(target(), run(`run-${i}`, at + 2))?.counted, false);
    assert.equal(f.health.failure(target(), run(`parallel-${i}`, at))?.counted, false);
  }
  f.db.close();
});

test('only eligible failures count; clear and forget remove entries', () => {
  const f = fixture();
  for (const code of ['', 'quota-or-rate-limit', 'runtime-request-failed', 'authentication-required'])
    assert.equal(f.health.failure(target(), run(code, 1, code)), undefined);
  assert.equal(f.health.failure(target('other'), run('wrong', 1)), undefined);
  assert.equal(f.health.failure({ ...target(), apiProvider: 'openrouter-free' }, run('free', 1)), undefined);
  assert.equal(f.health.failure(target(), { ...run('diagnosis', 1), stepId: 'executor-diagnosis' }), undefined);
  for (const code of [
    'runtime-network-error',
    'runtime-timeout',
    'runtime-process-closed',
    'runtime-protocol-incompatible',
  ]) {
    f.health.clear('one');
    assert.equal(f.health.failure(target(), run(code, 1, code))?.counted, true);
  }
  f.health.clear('one');
  assert.equal(f.health.apply(snapshot()).executorCooldown, undefined);
  f.health.failure(target(), run('again', 2));
  f.health.forget('one');
  assert.equal(f.health.apply(snapshot()).executorCooldown, undefined);
  f.db.close();
});

test('apply replaces stale state, skips free cards and expires at retryAt', () => {
  const f = fixture();
  f.health.failure(target(), run('a', 1));
  const old = {
    ...snapshot(),
    executorCooldown: {
      reason: 'failures' as const,
      streak: 99,
      errorCode: 'old',
      observedAt: iso(0),
      retryAt: iso(100),
    },
  };
  assert.equal(f.health.apply(old).executorCooldown?.streak, 1);
  assert.equal(f.health.apply({ ...old, costTier: 'free' }).executorCooldown, undefined);
  assert.equal(f.health.apply({ ...old, apiProvider: 'openrouter-free' }).executorCooldown, undefined);
  f.set(60000);
  assert.equal(f.health.apply(old).executorCooldown, undefined);
  f.db.close();
});

test('network-wide requires different providers with active network or timeout failures', () => {
  const f = fixture();
  assert.equal(f.health.failure(target(), run('a', 1, 'runtime-network-error'))?.networkWide, false);
  assert.equal(f.health.failure(target('two'), run('b', 1, 'runtime-timeout', 'two'))?.networkWide, false);
  assert.equal(
    f.health.failure(target('three', 'claude'), run('c', 1, 'runtime-process-closed', 'three'))?.networkWide,
    false,
  );
  f.set(1000);
  assert.equal(
    f.health.failure(target('three', 'claude'), run('d', 1001, 'runtime-timeout', 'three'))?.networkWide,
    true,
  );
  f.set(301000);
  assert.equal(
    f.health.failure(target('four', 'grok'), run('e', 301001, 'runtime-network-error', 'four'))?.networkWide,
    false,
  );
  f.db.close();
});

test('a process exit is not network-wide even while two other providers have network failures', () => {
  const f = fixture();
  f.health.failure(target('one', 'cursor'), run('one', 1, 'runtime-network-error', 'one'));
  const second = f.health.failure(target('two', 'claude'), run('two', 1, 'runtime-timeout', 'two'));
  const third = f.health.failure(target('three', 'grok'), run('three', 1, 'runtime-process-closed', 'three'));
  f.db.close();
  assert.equal(second?.networkWide, true);
  assert.equal(third?.counted, true);
  assert.equal(third?.networkWide, false);
});
