import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { buildConversationPresentation } from '../src/server/conversation-presentation.ts';
import { deriveTrajectory } from '../src/shared/trajectory.ts';
import type { RunEvent, RunRecord, Workflow } from '../src/shared/types.ts';

const stamp = '2020-01-01T00:00:00Z';
const workflow = (id = 'w'): Workflow => ({
  id,
  conversationId: 'c',
  projectId: 'p',
  userMessageId: 'm',
  input: { content: 'Synthetic', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'execute',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
});
const run = (events: RunEvent[], id = 'r'): RunRecord => ({
  id,
  prompt: 'Synthetic',
  projectPath: 'C:/synthetic',
  kind: 'general',
  status: 'running',
  route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'general', reasons: [], warnings: [] },
  startedAt: stamp,
  output: '',
  events,
});
const tool = (id: string, data: Record<string, unknown>, seq: number): RunEvent => ({
  type: 'tool',
  at: stamp,
  seq,
  data: { toolCallId: id, tool: 'exec_command', ...data },
});

test('compact projection preserves linked identities, replay status, background sessions and text redaction', () => {
  const record = run([
    tool('native', { status: 'running', arguments: { command: 'synthetic command' } }, 1),
    tool(
      'bridge',
      { source: 'pugport', nativeToolCallId: 'native', status: 'completed', output: { session_id: '42' } },
      2,
    ),
    tool('native', { status: 'running' }, 3),
    tool(
      'poll',
      { status: 'failed', arguments: { session_id: '42' }, output: 'password=synthetic-secret\nDone', exitCode: 1 },
      4,
    ),
    tool('poll', { status: 'completed' }, 5),
    { type: 'text', at: stamp, seq: 6, text: 'password=' },
    { type: 'text', at: stamp, seq: 7, text: 'split-secret' },
  ]);
  const compact = buildConversationPresentation(workflow(), [record]);
  const full = buildConversationPresentation(workflow(), [record], [], true);
  assert.deepEqual(
    compact.items.map(({ key, kind, calls, preview }) => ({ key, kind, calls, preview })),
    full.items.map(({ key, kind, calls, preview }) => ({ key, kind, calls, preview })),
  );
  assert.deepEqual(
    compact.background,
    full.background?.map(({ output: _output, ...job }) => job),
  );
  assert.equal(compact.background?.[0].status, 'failed');
  assert.equal(compact.items[0].calls?.length, 2);
  assert.ok(!JSON.stringify(compact).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(compact).includes('split-secret'));
  assert.ok(
    compact.items.every(
      (item) => !item.tools && (item.kind === 'narration' || item.kind === 'final-answer' || !item.text),
    ),
  );
  assert.deepEqual(
    deriveTrajectory(record, undefined, true)
      .rows.filter((row) => row.lane === 'tools')
      .map((row) => row.status),
    ['completed', 'failed'],
  );
});

test('compact background keeps full snapshots when later observations are deltas', () => {
  const record = run([
    tool(
      'start',
      {
        status: 'completed',
        arguments: { command: 'synthetic', run_in_background: true },
        output: 'session ID 42\nOriginal output',
      },
      1,
    ),
    tool('start', { status: 'completed', outputMode: 'delta', output: 'Replacement must not win' }, 2),
  ]);
  assert.equal(
    buildConversationPresentation(workflow(), [record]).background?.[0].tail,
    'session ID 42\nOriginal output',
  );
});

test('30 cold compact projections retain 36000 calls within 800 ms without rendering long ordinary output', (t) => {
  const output = 'Synthetic tool output line.\n'.repeat(320);
  const events = Array.from({ length: 400 }, (_, i) =>
    tool(
      `call-${i}`,
      {
        tool: 'Read',
        status: 'completed',
        arguments: { path: `synthetic/file-${i}.ts` },
        output,
      },
      i + 1,
    ),
  );
  const fixtures = Array.from({ length: 30 }, (_, i) => ({
    workflow: workflow(`w${i}`),
    runs: Array.from({ length: 3 }, (_, j) => ({ ...run(events, `w${i}-r${j}`), status: 'completed' as const })),
  }));
  const started = performance.now();
  const values = fixtures.map(({ workflow, runs }) => buildConversationPresentation(workflow, runs));
  const elapsed = performance.now() - started;
  t.diagnostic(`30 compact projections: ${elapsed.toFixed(2)} ms`);
  assert.equal(values.flatMap((value) => value.items.flatMap((item) => item.calls ?? [])).length, 36000);
  assert.ok(!JSON.stringify(values).includes('Synthetic tool output line'));
  assert.ok(elapsed < 800, `${elapsed.toFixed(2)} ms >= 800 ms`);
});
