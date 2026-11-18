import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStateGate } from '../src/ui/backend-state-gate.ts';

test('a delayed GET cannot replace the native ready flag delivered by SSE', () => {
  const gate = new BackendStateGate();
  const stale = gate.beginSnapshot();
  let ready = false;
  gate.liveEvent();
  ready = true;
  if (gate.accepts(stale)) ready = false;
  assert.equal(ready, true);
  assert.equal(gate.accepts(gate.beginSnapshot()), true);
});

test('a delayed GET cannot erase a run delta or a newer completed snapshot', () => {
  const gate = new BackendStateGate();
  const beforeDelta = gate.beginSnapshot();
  gate.liveEvent();
  assert.equal(gate.accepts(beforeDelta), false);
  const first = gate.beginSnapshot();
  const second = gate.beginSnapshot();
  assert.equal(gate.accepts(first), false);
  assert.equal(gate.accepts(second), true);
});
