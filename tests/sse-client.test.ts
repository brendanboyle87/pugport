import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { connectEventStream, ssePendingBytesLimit, sseStallMs } from '../src/server/sse-client.ts';

function fixture(source = new EventEmitter()) {
  const req = new EventEmitter();
  const writes: string[] = [];
  let accept = false;
  let ended = 0;
  const res = Object.assign(new EventEmitter(), {
    write(text: string) {
      writes.push(text);
      return accept;
    },
    end() {
      ended++;
      res.emit('close');
    },
    destroy() {},
  });
  const stats = connectEventStream(req as IncomingMessage, res as unknown as ServerResponse, source, { initial: true });
  return {
    source,
    req,
    res,
    writes,
    stats,
    accept: () => {
      accept = true;
    },
    ended: () => ended,
  };
}

test('10,000 broadcasts retain one byte-bounded latest state and close a stalled reader at 60 seconds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  for (let index = 0; index < 10_000; index++) {
    f.source.emit('run', { index, text: '界'.repeat(2000) });
    f.source.emit('state', { index, text: 'state' });
    assert.equal(f.stats().pendingStates, 1);
    assert.ok(f.stats().pendingBytes <= ssePendingBytesLimit);
    assert.ok(f.stats().pendingRuns <= 2000);
  }
  assert.equal(f.writes.length, 1);
  t.mock.timers.tick(sseStallMs - 1);
  assert.equal(f.ended(), 0);
  t.mock.timers.tick(1);
  assert.equal(f.ended(), 1);
  assert.deepEqual(f.stats(), { pendingStates: 0, pendingRuns: 0, pendingBytes: 0, closed: true });
  assert.equal(f.source.listenerCount('state'), 0);
  assert.equal(f.res.listenerCount('drain'), 0);
});

test('drain delivers the latest state first, drops oldest runs, and resets the stall deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  const payload = 'x'.repeat(1024 * 1024);
  for (let index = 0; index < 12; index++) f.source.emit('run', { index, payload });
  f.source.emit('state', { index: 999 });
  t.mock.timers.tick(59_000);
  f.res.emit('drain'); // Still blocked after the latest state.
  assert.match(f.writes[1]!, /"index":999/);
  t.mock.timers.tick(59_000);
  assert.equal(f.ended(), 0);
  f.accept();
  f.res.emit('drain');
  const indexes = f.writes.slice(2).map((text) => JSON.parse(text.split('data: ')[1]!).index);
  assert.equal(indexes.at(-1), 11);
  assert.ok(indexes[0] > 0);
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => a - b),
  );
  assert.equal(f.stats().pendingBytes, 0);
  t.mock.timers.tick(sseStallMs);
  assert.equal(f.ended(), 0);
  f.req.emit('close');
});

test('connect/close cycles restore every listener baseline, including request and response listeners', () => {
  const source = new EventEmitter();
  source.on('state', () => {});
  source.on('run', () => {});
  for (let index = 0; index < 100; index++) {
    const f = fixture(source);
    (index % 2 ? f.req : f.res).emit('close');
    assert.equal(source.listenerCount('state'), 1);
    assert.equal(source.listenerCount('run'), 1);
    assert.equal(f.req.listenerCount('close'), 0);
    assert.equal(f.res.listenerCount('close'), 0);
    assert.equal(f.res.listenerCount('drain'), 0);
  }
});

test('an oversized single state closes the client without queuing or truncating its JSON', () => {
  const f = fixture();
  f.source.emit('state', { text: 'x'.repeat(ssePendingBytesLimit) });
  assert.equal(f.ended(), 1);
  assert.equal(f.stats().pendingBytes, 0);
  assert.equal(f.writes.length, 1);
});
