import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { FreeSourceHealth } from '../src/server/free-source-health.ts';
import type { RunRecord, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

test('free health persists its ladder, honors Retry-After, deduplicates runs and resets after completion', () => {
  const db = new DatabaseSync(':memory:');
  let now = Date.parse('2026-10-12T12:00:00Z');
  const health = new FreeSourceHealth(db, () => now);
  const target = { id: 'api-groq-free', apiProvider: 'groq-free' } as RuntimeTarget;
  const snapshot = { ...target, costTier: 'free' } as unknown as RuntimeSnapshot;
  for (const [i, seconds] of [60, 300, 900, 3600, 3600].entries()) {
    health.record(target, 'quota-or-rate-limit', undefined, String(i));
    const at = health.apply(snapshot).availability!.retryAt!;
    assert.equal(Date.parse(at) - now, seconds * 1000);
    health.record(target, 'quota-or-rate-limit', 1, String(i));
    assert.equal(health.apply(snapshot).availability!.retryAt, at);
    now += seconds * 1000;
    assert.equal(health.apply(snapshot).availability, undefined);
  }
  health.record(target, 'quota-or-rate-limit', 12, 'next');
  assert.equal(Date.parse(health.apply(snapshot).availability!.retryAt!) - now, 12000);
  health.probe(target, { models: [{ id: 'one', name: 'one' }] });
  assert.ok(health.apply(snapshot).availability);
  health.failure(target, { status: 'completed', route: { runtimeId: target.id } } as RunRecord);
  assert.equal(health.apply(snapshot).availability, undefined);
  health.record(target, 'quota-or-rate-limit');
  assert.equal(Date.parse(new FreeSourceHealth(db, () => now).apply(snapshot).availability!.retryAt!) - now, 60000);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='native_account_health'").get(), undefined);
  db.close();
});

test('local errors cool down for 30 seconds; authentication stays latched until key replacement or successful probe', () => {
  const db = new DatabaseSync(':memory:');
  const now = Date.parse('2026-10-12T12:00:00Z');
  const health = new FreeSourceHealth(db, () => now);
  const target = { id: 'api-ollama', apiProvider: 'ollama' } as RuntimeTarget;
  const snapshot = { ...target, costTier: 'free' } as unknown as RuntimeSnapshot;
  health.record(target, 'runtime-network-error');
  assert.equal(Date.parse(health.apply(snapshot).availability!.retryAt!) - now, 30000);
  health.record(target, 'authentication-required');
  health.record(target, 'quota-or-rate-limit');
  health.failure(target, { status: 'completed', route: { runtimeId: target.id } } as RunRecord);
  assert.equal(health.apply(snapshot).availability!.reason, 'authentication');
  assert.equal(health.apply(snapshot).availability!.retryAt, undefined);
  health.probe(target, { models: [], error: 'runtime-network-error' });
  assert.equal(health.apply(snapshot).availability!.reason, 'authentication');
  health.probe(target, { models: [] });
  assert.equal(health.apply(snapshot).availability, undefined);
  health.record(target, 'authentication-required');
  health.clear(target.id);
  assert.equal(health.apply(snapshot).availability, undefined);
  const paid = { id: 'api-openai', apiProvider: 'openai' } as RuntimeSnapshot;
  assert.equal(health.apply(paid), paid);
  db.close();
});
