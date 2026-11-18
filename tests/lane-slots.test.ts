import assert from 'node:assert/strict';
import { test } from 'node:test';
import { laneSlots } from '../src/server/member-allocation.ts';

const GB = 1024 ** 3;
test('lane slots follow available memory alone: 8 GB or more three, 4 to 8 GB one, under 4 GB none', () => {
  for (const [memory, lanes] of [
    [9 * GB, 3],
    [8 * GB, 3],
    [8 * GB - 1, 1],
    [4 * GB, 1],
    [4 * GB - 1, 0],
    [undefined, 1],
    [NaN, 1],
  ] as const)
    assert.equal(laneSlots(memory), lanes, String(memory));
});
