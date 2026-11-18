import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLaneEvent, laneEventsPath, readLaneEvents } from '../src/server/lane-events.ts';

test('project events append, filter and read a bounded tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lane-events-'));
  const id = randomUUID();
  const first = { at: 'one', type: 'lane-created' as const, lane: 'a' };
  const second = { at: 'two', type: 'turn-settled' as const, lane: 'b' };
  appendLaneEvent(dir, id, first);
  appendLaneEvent(dir, id, second);
  assert.deepEqual(readLaneEvents(dir, id), [first, second]);
  assert.deepEqual(readLaneEvents(dir, id, { lane: 'a' }), [first]);
  assert.deepEqual(readLaneEvents(dir, id, { limit: 1 }), [second]);
  assert.deepEqual(readLaneEvents(dir, id, { limit: 0 }), []);
  appendFileSync(laneEventsPath(dir, id), 'bad json\n' + 'x'.repeat(256 * 1024) + '\n');
  appendLaneEvent(dir, id, second);
  assert.deepEqual(readLaneEvents(dir, id), [second]);
  appendLaneEvent(dir, '../invalid', first);
  assert.deepEqual(readLaneEvents(dir, '../invalid'), []);
  appendLaneEvent(undefined, id, first);
  assert.deepEqual(readLaneEvents(undefined, id), []);
});
