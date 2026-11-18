import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/server/controller.ts';
import { quotaReadingPending } from '../src/shared/quota-summary.ts';
import type { RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

test('native identity verification hides old request and billing evidence while preserving verified same-account failures', () => {
  const at = '2026-10-10T03:43:00.000Z';
  const target: RuntimeTarget = {
    id: 'grok-b',
    provider: 'grok',
    label: 'Synthetic B',
    environment: 'native',
    command: 'unused',
    enabled: true,
    accountId: 'synthetic-b',
    accountFingerprint: 'synthetic-old-identity',
  };
  const lastRequestFailure = {
    runId: 'synthetic-402',
    model: 'grok-4.7-build-fast',
    at,
    source: 'Grok Build ACP' as const,
    statusCode: 402 as const,
    errorCode: 'quota-or-rate-limit' as const,
    message: 'Synthetic safe billing evidence',
  };
  const snapshot: RuntimeSnapshot = {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: target.environment,
    accountFingerprint: target.accountFingerprint,
    installed: true,
    status: 'ready',
    models: [],
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: at,
    availability: { reason: 'quota', observedAt: at, retryAt: at, billingFailure: lastRequestFailure },
    lastRequestFailure,
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: at,
      windows: [],
      grokBilling: { isUnifiedBillingUser: true, percentSource: 'implicit-zero' },
    },
  };
  let identity: string | undefined = target.accountFingerprint;
  let pending = false;
  // Exercise the pure guard without constructing a controller, opening a database,
  // discovering a CLI or reading real account files.
  const controller = Object.assign(Object.create(Controller.prototype), {
    readAccountIdentity: () => identity,
    nativeLoginPending: () => pending,
  }) as { identityGuard(target: RuntimeTarget, snapshot: RuntimeSnapshot): RuntimeSnapshot };
  const guard = (input = snapshot) => controller.identityGuard(target, input);
  assert.equal(guard(), snapshot);
  const assertHidden = (result: RuntimeSnapshot) => {
    assert.equal(result.availability, undefined);
    assert.equal(result.lastRequestFailure, undefined);
    assert.equal(result.quota.grokBilling, undefined);
    assert.equal(result.lastKnownQuota, undefined);
    if (result.status !== 'refreshing') assert.equal(quotaReadingPending(result), false);
  };
  for (identity of [undefined, 'synthetic-new-identity']) {
    assertHidden(guard());
    assertHidden(guard({ ...snapshot, status: 'error' }));
    assertHidden(guard({ ...snapshot, status: 'missing' }));
  }
  identity = target.accountFingerprint;
  pending = true;
  assertHidden(guard());
  pending = false;
  for (const status of ['error', 'missing'] as const) {
    const result = guard({ ...snapshot, status });
    assert.deepEqual(result.availability, snapshot.availability);
    assert.deepEqual(result.lastRequestFailure, snapshot.lastRequestFailure);
    assert.equal(result.quota.grokBilling, undefined, 'failed discovery does not newly verify a billing mode');
    const authentication = {
      ...snapshot.availability!,
      reason: 'authentication' as const,
    };
    const authResult = guard({ ...snapshot, status, availability: authentication, lastKnownQuota: snapshot.quota });
    assert.deepEqual(authResult.availability, authentication, 'a later auth failure is still real evidence');
    assert.deepEqual(authResult.lastRequestFailure, lastRequestFailure, 'auth failure does not erase the earlier 402');
    assert.equal(authResult.lastKnownQuota, undefined, 'authentication failure withholds quota reference');
  }
  assert.deepEqual(snapshot.lastRequestFailure, lastRequestFailure, 'the old observation remains unchanged');
});
