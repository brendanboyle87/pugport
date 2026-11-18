import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../src/server/store.ts';
import { ManualResetNotes, manualResetInput } from '../src/server/manual-reset.ts';
test('local annotations persist, remain runtime-scoped, and can be edited or removed without changing quota config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'combo-manual-test-'));
  let store = new Store(dir);
  try {
    let notes = new ManualResetNotes(store);
    const saved = notes.save('fixture-a', {
      label: 'Synthetic reset',
      count: null,
      expiresOn: '2099-02-20',
      status: 'available',
    });
    assert.equal(saved[0]?.count, null);
    assert.equal(notes.list('fixture-b').length, 0);
    const id = saved[0]!.id;
    store.close();
    store = new Store(dir);
    notes = new ManualResetNotes(store);
    assert.equal(notes.list('fixture-a')[0]?.id, id);
    notes.save('fixture-a', { id, label: 'Updated synthetic reset', count: 0, expiresOn: null, status: 'used' });
    assert.equal(notes.list('fixture-a')[0]?.count, 0);
    assert.throws(() =>
      notes.save('fixture-b', { id, label: 'wrong account', count: 1, expiresOn: null, status: 'available' }),
    );
    assert.deepEqual(store.config('targets', []), []);
    assert.deepEqual(notes.remove('fixture-a', id), []);
  } finally {
    store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('cloud amounts and date precision are validated without inventing missing quantities', () => {
  const common = { label: 'Synthetic credit', count: null, expiresOn: null, status: 'available' };
  const credit = manualResetInput.parse({
    ...common,
    kind: 'cloud-credit',
    remainingUsd: 12,
    totalUsd: 20,
    expiresAt: '2099-04-01T02:00:00-05:00',
  });
  assert.equal(credit.remainingUsd, 12);
  assert.equal(credit.count, null);
  for (const invalid of [
    { remainingUsd: -1 },
    { remainingUsd: 30, totalUsd: 20 },
    { expiresOn: '2099-02-30' },
    { expiresAt: '2099-04-01' },
    { count: 1.5 },
  ])
    assert.throws(() => manualResetInput.parse({ ...common, ...invalid }));
  assert.equal(manualResetInput.parse(common).expiresOn, null);
});

test('subscription credits bind to server identity, preserve previous accounts, and reject stale or spoofed forms', () => {
  const values = new Map<string, unknown>();
  const store = {
    config: <T>(key: string, fallback: T) => (values.get(key) ?? fallback) as T,
    setConfig: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
  };
  const notes = new ManualResetNotes(store);
  const a = { provider: 'cursor', accountFingerprint: 'a'.repeat(64) };
  const b = { provider: 'cursor', accountFingerprint: 'b'.repeat(64) };
  const input = {
    kind: 'subscription-credit',
    creditPool: 'event',
    expiryPrecision: 'estimated',
    remainingUsd: 15,
    totalUsd: 20,
    label: 'Synthetic promo',
    count: null,
    expiresOn: '2099-04-01',
    status: 'available',
    source: 'Official dashboard · manually observed',
    observedAt: '2099-03-18T12:00:00Z',
  };
  assert.throws(() => notes.save('cursor-test', input), /登录身份/);
  assert.throws(() => notes.save('cursor-test', { ...input, accountFingerprint: b.accountFingerprint }, a));
  assert.throws(
    () => notes.save('cursor-test', { ...input, expectedAccountFingerprint: a.accountFingerprint }, b),
    /身份已更改/,
  );
  const saved = notes.save('cursor-test', { ...input, expectedAccountFingerprint: a.accountFingerprint }, a)[0]!;
  assert.equal(saved.accountFingerprint, a.accountFingerprint);
  assert.equal(saved.identityStatus, 'matched');
  assert.equal(notes.list('cursor-test', b)[0]!.identityStatus, 'different');
  assert.equal(notes.list('cursor-test')[0]!.identityStatus, 'unverified');
  assert.throws(
    () => notes.save('cursor-test', { ...input, id: saved.id, expectedAccountFingerprint: b.accountFingerprint }, b),
    /其他或未确认账号/,
  );
  assert.throws(
    () =>
      notes.save(
        'cursor-test',
        { label: 'Unbind', id: saved.id, count: null, expiresOn: null, status: 'available' },
        a,
      ),
    /绑定类型/,
  );
  notes.save(
    'cursor-test',
    { ...input, remainingUsd: 7, label: 'Account B promo', expectedAccountFingerprint: b.accountFingerprint },
    b,
  );
  assert.equal(notes.list('cursor-test', b).length, 2);
  assert.equal(notes.list('cursor-test', a)[0]!.remainingUsd, 15);
  assert.equal(
    (values.get('manualResetNotes') as Record<string, Array<Record<string, unknown>>>)['cursor-test']![0]!
      .identityStatus,
    undefined,
  );
  assert.equal(notes.remove('cursor-test', saved.id, b)[0]!.identityStatus, 'matched');
});

test('subscription snapshots keep estimated expiry and distinct usage pools without manufacturing quota', () => {
  const common = { label: 'Synthetic usage', count: null, expiresOn: null, status: 'unknown' };
  const usage = {
    cycleResetsOn: '2099-04-01',
    cycleResetsAt: null,
    cycleResetPrecision: 'date',
    onDemandEnabled: false,
    pools: [
      { id: 'cursor-models', usedPercent: 0 },
      { id: 'other-models', usedPercent: null },
    ],
  };
  assert.equal(
    manualResetInput.parse({ ...common, kind: 'subscription-usage', subscriptionUsage: usage }).subscriptionUsage
      ?.pools[1]?.usedPercent,
    null,
  );
  for (const changes of [
    { pools: [{ id: 'cursor-models', usedPercent: 101 }] },
    {
      pools: [
        { id: 'cursor-models', usedPercent: 5 },
        { id: 'cursor-models', usedPercent: 5 },
      ],
    },
    { cycleResetsAt: '2099-04-01T00:00:00Z' },
    { cycleResetPrecision: 'unknown' },
  ])
    assert.throws(() =>
      manualResetInput.parse({ ...common, kind: 'subscription-usage', subscriptionUsage: { ...usage, ...changes } }),
    );
  assert.throws(() => manualResetInput.parse({ ...common, subscriptionUsage: usage }));
  assert.throws(() =>
    manualResetInput.parse({ ...common, kind: 'subscription-usage', subscriptionUsage: usage, remainingUsd: 1 }),
  );
  const estimated = manualResetInput.parse({
    ...common,
    kind: 'subscription-credit',
    creditPool: 'event',
    expiryPrecision: 'estimated',
    expiresOn: '2000-01-01',
    remainingUsd: 2,
    status: 'available',
  });
  assert.equal(estimated.status, 'available');
  assert.equal(estimated.remainingUsd, 2);
  assert.throws(() =>
    manualResetInput.parse({
      ...common,
      kind: 'subscription-credit',
      creditPool: 'event',
      expiryPrecision: 'exact',
      expiresOn: '2099-04-01',
    }),
  );
});
