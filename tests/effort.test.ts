import assert from 'node:assert/strict';
import test from 'node:test';
import { effortName, nearestEffort, orderedEfforts } from '../src/shared/effort.ts';

test('nearest explicit effort includes off/none and breaks ties toward the lower level', () => {
  assert.equal(nearestEffort(['high', 'low'], 'medium'), 'low');
  assert.equal(nearestEffort(['off', 'high'], 'minimal'), 'off');
  assert.equal(nearestEffort(['none', 'high'], 'off'), 'none');
  assert.equal(nearestEffort(['off', 'max'], 'off'), 'off');
  assert.equal(nearestEffort(['max', 'high'], 'xhigh'), 'high');
  assert.equal(nearestEffort(['extra-high', 'low'], 'xhigh'), 'extra-high');
  assert.equal(nearestEffort([], 'high'), undefined);
  assert.equal(nearestEffort(['custom'], 'custom'), 'custom');
  assert.deepEqual(orderedEfforts(['ultra', 'low', 'off', 'low', 'max']), ['off', 'low', 'max', 'ultra']);
  assert.equal(effortName('extra-high'), '很高');
  assert.equal(effortName('custom'), 'custom');
});
