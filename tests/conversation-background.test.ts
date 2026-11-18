import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundWork } from '../src/server/conversation-background.ts';
import type { RunRecord } from '../src/shared/types.ts';
const run = (events: unknown[]) =>
  ({
    id: 'r',
    prompt: 'Synthetic',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    route: { runtimeId: 'synthetic', model: 'synthetic' },
    events,
    output: '',
  }) as RunRecord;
const event = (id: string, input: unknown, output: unknown, exitCode?: number) => ({
  type: 'tool',
  at: '2026-01-01T00:00:01Z',
  data: { tool: 'exec_command', toolCallId: id, status: 'completed', arguments: input, output, exitCode },
});
test('background sessions reconcile polling, cap tails and load full output only on demand', () => {
  const r = run([
    event('start', { command: 'synthetic job' }, { session_id: '42' }),
    event('poll', { session_id: '42' }, Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n'), 0),
  ]);
  const compact = backgroundWork([r], []);
  assert.equal(compact.length, 1);
  assert.equal(compact[0].status, 'completed');
  assert.equal(compact[0].title, 'synthetic job');
  assert.equal(compact[0].tail.split('\n').length, 40);
  assert.equal(compact[0].output, undefined);
  assert.ok(backgroundWork([r], [], true)[0].output!.includes('line 0'));
});
test('foreground commands are excluded and failures remain failures', () => {
  assert.equal(backgroundWork([run([event('a', { command: 'normal' }, 'ok', 0)])], []).length, 0);
  assert.equal(backgroundWork([run([event('a', { session_id: '42' }, 'error', 1)])], [])[0].status, 'failed');
});
