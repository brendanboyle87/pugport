import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retainRunEvent, retainedRunEventLimit } from '../src/shared/run-events.ts';
import type { RunEvent } from '../src/shared/types.ts';

const event = (text: string): RunEvent => ({ at: '2026-10-08T12:00:00Z', type: 'status', text });

test('message usage remains transient without consuming sequence numbers or the retained window', () => {
  const run = { events: [] as RunEvent[], eventsDropped: 0 };
  retainRunEvent(run, event('start'));
  for (let i = 0; i <= retainedRunEventLimit; i++) {
    const update = { ...event(''), data: { messageUsage: { input_tokens: i } } };
    assert.equal(retainRunEvent(run, update), update);
    assert.equal(retainRunEvent(run, update).seq, undefined);
  }
  assert.ok(run.events.every((item) => !item.data?.messageUsage));
  assert.equal(run.events.length, 1);
  assert.equal(run.eventsDropped, 0);
  assert.equal(retainRunEvent(run, event('end')).seq, 2);
});

test('retention preserves stable sequence and exact truncation count across persisted reloads', () => {
  const run = { events: [] as RunEvent[], eventsDropped: 0 };
  for (let i = 0; i < retainedRunEventLimit + 3; i++) retainRunEvent(run, event(String(i)));
  assert.equal(run.events.length, retainedRunEventLimit);
  assert.equal(run.eventsDropped, 3);
  assert.equal(run.events[0].seq, 4);
  const loaded = JSON.parse(JSON.stringify(run)) as typeof run;
  const retained = retainRunEvent(loaded, event('next'));
  assert.equal(retained.seq, retainedRunEventLimit + 4);
  assert.equal(loaded.eventsDropped, 4);
});

test('SSE replay preserves source sequence and ignores duplicates including already-dropped events', () => {
  const run = { events: [] as RunEvent[], eventsDropped: 0 };
  retainRunEvent(run, { ...event('first retained'), seq: 1001 });
  retainRunEvent(run, { ...event('duplicate'), seq: 1001 });
  retainRunEvent(run, { ...event('stale'), seq: 1 });
  retainRunEvent(run, { ...event('next'), seq: 1002 });
  assert.deepEqual(
    run.events.map((item) => [item.text, item.seq]),
    [
      ['first retained', 1001],
      ['next', 1002],
    ],
  );
  assert.equal(run.eventsDropped, 0);
});

test('long text streams preserve early paired tools, exact drops and sequence replay after reload', () => {
  const run = { events: [] as RunEvent[], eventsDropped: 0 };
  for (const status of ['inProgress', 'completed'])
    retainRunEvent(run, {
      ...event('Read'),
      type: 'tool',
      data: { toolCallId: 'early-read', status },
    });
  for (let i = 0; i < 1500; i++) retainRunEvent(run, { ...event(String(i)), type: 'text' });
  assert.equal(run.events.length, retainedRunEventLimit);
  assert.equal(run.eventsDropped, 502);
  assert.deepEqual(
    run.events.filter((item) => item.type === 'tool').map((item) => [item.seq, item.data?.status]),
    [
      [1, 'inProgress'],
      [2, 'completed'],
    ],
  );
  assert.equal(run.events.at(-1)?.seq, 1502);
  const loaded = JSON.parse(JSON.stringify(run)) as typeof run;
  const next = retainRunEvent(loaded, { ...event('next delta'), type: 'text' });
  assert.equal(next.seq, 1503);
  assert.equal(loaded.eventsDropped, 503);
  const expected = JSON.stringify(loaded);
  retainRunEvent(loaded, next);
  retainRunEvent(loaded, { ...event('dropped replay'), type: 'text', seq: 3 });
  assert.equal(JSON.stringify(loaded), expected);
});

test('a newly appended text event remains the sequence high-water mark when no older text exists', () => {
  const run = { events: [] as RunEvent[], eventsDropped: 0 };
  for (let i = 0; i < retainedRunEventLimit; i++) retainRunEvent(run, event(String(i)));
  const newest = retainRunEvent(run, { ...event('new text'), type: 'text' });
  assert.equal(newest.seq, 1001);
  assert.equal(run.events.at(-1), newest);
  assert.equal(run.events[0].seq, 2);
  assert.equal(run.eventsDropped, 1);
});

test('legacy completeness remains unknown and reasoning is kept out of event retention', () => {
  const run: { events: RunEvent[]; eventsDropped?: number } = { events: [event('legacy')] };
  assert.equal(retainRunEvent(run, event('new')).seq, 2);
  retainRunEvent(run, { ...event('private thinking'), type: 'reasoning' });
  assert.equal(run.events.length, 2);
  assert.equal(run.eventsDropped, undefined);
  for (let i = run.events.length; i <= retainedRunEventLimit; i++) retainRunEvent(run, event('legacy tail'));
  assert.equal(run.events.length, retainedRunEventLimit);
  assert.equal(run.eventsDropped, undefined);
});
