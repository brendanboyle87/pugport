import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskScheduleSchema } from '../src/server/scheduling-input.ts';

test('schedule compares absolute instants across timezone offsets', () => {
  const valid = { notBefore: '2026-09-26T15:00:00-04:00', deadlineAt: '2026-09-26T20:00:00Z' };
  assert.deepEqual(taskScheduleSchema.parse(valid), valid);
  assert.equal(taskScheduleSchema.safeParse({ ...valid, deadlineAt: '2026-09-26T18:00:00Z' }).success, false);
});

test('schedule rejects timezone-less dates, unbounded estimates and unsupported controls', () => {
  for (const value of [
    { deadlineAt: '2026-09-26T19:00' },
    { estimatedMinutes: 0 },
    { estimatedMinutes: Infinity },
    { estimatedMinutes: 43201 },
    { priority: 'urgent' },
    { budgetOverride: true },
  ]) {
    assert.equal(taskScheduleSchema.safeParse(value).success, false);
  }
  assert.deepEqual(taskScheduleSchema.parse({}), {});
});
