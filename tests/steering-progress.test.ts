import assert from 'node:assert/strict';
import { test } from 'node:test';
import { steeringProgressFromEvent } from '../src/shared/steering-progress.ts';
import type { RunEvent, SteeringProgress } from '../src/shared/types.ts';

function event(phase: SteeringProgress['phase'], id = 'first', offset = 0, mode?: string): RunEvent {
  return {
    type: 'status',
    at: new Date(Date.UTC(2026, 9, 5, 12, 0, offset)).toISOString(),
    data: {
      steeringPhase: phase,
      steeringId: id,
      steeringMode: mode ?? (phase === 'sending' ? 'interrupt' : undefined),
    },
  };
}

test('receipt cannot downgrade a new native turn that started before the delivery handler returned', () => {
  const sending = steeringProgressFromEvent(undefined, event('sending'))!;
  assert.equal(sending.mode, 'interrupt');
  const resumed = steeringProgressFromEvent(sending, event('resuming', 'first', 1))!;
  assert.equal(resumed.phase, 'resuming');
  assert.equal(steeringProgressFromEvent(resumed, event('received', 'first', 2)), resumed);
  assert.equal(steeringProgressFromEvent(resumed, event('sending', 'first', 3)), resumed);
});

test('failed delivery stays failed and a new correction is isolated from all older receipts', () => {
  const failed = steeringProgressFromEvent(
    steeringProgressFromEvent(undefined, event('sending')),
    event('failed', 'first', 1),
  )!;
  for (const phase of ['received', 'resuming'] as const)
    assert.equal(steeringProgressFromEvent(failed, event(phase, 'first', 2)), failed);
  const next = steeringProgressFromEvent(failed, event('sending', 'second', 3, 'append'))!;
  assert.equal(next.phase, 'sending');
  assert.equal(next.mode, 'append');
  for (const phase of ['received', 'resuming', 'failed'] as const)
    assert.equal(steeringProgressFromEvent(next, event(phase, 'first', 4)), next);
  assert.equal(steeringProgressFromEvent(next, event('sending', 'third', 1)), next);
  const received = steeringProgressFromEvent(next, event('received', 'second', 4))!;
  assert.equal(received.phase, 'received');
  const resumed = steeringProgressFromEvent(received, event('resuming', 'second', 5))!;
  assert.equal(resumed.phase, 'resuming');
  assert.equal(resumed.mode, 'append');
});

test('reasoning, generic statuses, and unmatched native receipts cannot invent steering progress', () => {
  assert.equal(steeringProgressFromEvent(undefined, event('resuming')), undefined);
  assert.equal(steeringProgressFromEvent(undefined, { ...event('sending'), type: 'reasoning' }), undefined);
  assert.equal(steeringProgressFromEvent(undefined, event('sending', 'first', 0, 'unsupported')), undefined);
  assert.equal(steeringProgressFromEvent(undefined, { ...event('sending'), at: 'invalid' }), undefined);
  const sending = steeringProgressFromEvent(undefined, event('sending'))!;
  assert.equal(
    steeringProgressFromEvent(sending, { ...event('resuming'), data: { steeringPhase: 'resuming' } }),
    sending,
  );
  assert.equal(steeringProgressFromEvent(sending, { type: 'status', at: event('sending').at }), sending);
});

test('native append receipt corrects a requested interruption and a generic acknowledgment retains that mode', () => {
  const sending = steeringProgressFromEvent(undefined, event('sending'))!;
  const received = steeringProgressFromEvent(sending, event('received', 'first', 1, 'append'))!;
  assert.equal(received.mode, 'append');
  const acknowledgment = event('received', 'first', 2);
  delete acknowledgment.data!.steeringMode;
  assert.equal(steeringProgressFromEvent(received, acknowledgment)?.mode, 'append');
  const awaitingEcho = steeringProgressFromEvent(sending, acknowledgment)!;
  assert.equal(awaitingEcho.mode, 'interrupt');
  assert.equal(steeringProgressFromEvent(awaitingEcho, event('received', 'first', 3, 'append'))?.mode, 'append');
});
