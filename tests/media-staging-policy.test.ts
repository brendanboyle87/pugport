import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaStagingBudget, mediaStagingPairPriority } from '../src/server/media-staging-policy.ts';
const GIB = 1024 ** 3;
test('large media libraries borrow bounded SSD space only when a generous reserve remains', () => {
  assert.deepEqual(mediaStagingBudget(400 * GIB, 2351), { maxBytes: 64 * GIB, minFreeBytes: 32 * GIB });
  assert.deepEqual(mediaStagingBudget(100 * GIB, 2351), { maxBytes: 17 * GIB, minFreeBytes: 32 * GIB });
  assert.deepEqual(mediaStagingBudget(400 * GIB, 50), { maxBytes: 8 * GIB, minFreeBytes: 4 * GIB });
  for (const free of [0, 20 * GIB, 64 * GIB, NaN, Infinity, -1])
    assert.deepEqual(mediaStagingBudget(free, 2351), { maxBytes: 8 * GIB, minFreeBytes: 4 * GIB });
});

test('staging priority reuses expensive cached hubs before unrelated pairs and favors smaller missing peers', () => {
  const cached = new Set(['hub', 'ready-peer']);
  const uses = new Map([
    ['hub', 37],
    ['large-uncached', 200],
  ]);
  const source = (path: string, gib: number) => ({ path, size: gib * GIB });
  const score = (sources: ReturnType<typeof source>[]) => mediaStagingPairPriority(sources, cached, uses);
  assert.ok(score([source('hub', 8), source('small', 0.1)]) > score([source('hub', 8), source('large', 2)]));
  assert.ok(score([source('hub', 8), source('large', 2)]) > score([source('large-uncached', 8), source('other', 2)]));
  assert.ok(score([source('hub', 8), source('ready-peer', 2)]) > score([source('hub', 8), source('small', 0.1)]));
  assert.equal(score([source('hub', 8), source('hub', 8)]), score([source('hub', 8)]));
  assert.ok(Number.isFinite(score([{ path: 'unknown', size: NaN }])));
});
