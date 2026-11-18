import assert from 'node:assert/strict';
import test from 'node:test';
import { executionRecordRows, executionUserInput, executionWorkflowRuns } from '../src/ui/execution-records.ts';
import type { RunRecord } from '../src/shared/types.ts';

const run = (id: string, workflowId = 'request', startedAt = '2026-10-09T12:00:00Z'): RunRecord => ({
  id,
  workflowId,
  startedAt,
  prompt: 'GENERATED INTERNAL PROMPT',
  projectPath: 'C:/fixture',
  kind: 'general',
  status: 'failed',
  route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
  output: 'partial internal executor output',
  events: [],
});

test('records show one newest attempt per task and keep delegated children inside the trace unless directly inspected', () => {
  const latest = run('relay', 'request', '2026-10-09T12:02:00Z');
  const child = run('child-run', 'child', '2026-10-09T12:03:00Z');
  const continued = run('continued-run', 'continued', '2026-10-09T12:04:00Z');
  const workflows: any[] = [
    { id: 'request' },
    { id: 'child', delegation: { parentId: 'request' } },
    { id: 'continued', parentWorkflowId: 'request' },
  ];
  const runs = [latest, child, continued, run('original')];
  assert.deepEqual(
    executionRecordRows(runs, workflows).map((record) => record.id),
    ['continued-run', 'relay'],
  );
  assert.deepEqual(
    executionRecordRows(runs, workflows, 'child-run').map((record) => record.id),
    ['continued-run', 'child-run', 'relay'],
  );
});

test('original user input never falls back to generated prompt, and keeps original whitespace', () => {
  assert.equal(executionUserInput(run('a')), undefined);
  assert.equal(executionUserInput({ ...run('a'), userInput: '  original\ntext  ' }), '  original\ntext  ');
  assert.equal(executionUserInput({ ...run('a'), userInput: 'stored' }, 'message original'), 'message original');
});

test('request chain retains failed attempts and selected full detail without unrelated workflows or duplicates', () => {
  const selected = run('b', 'request', '2026-10-09T12:01:00Z');
  const summary = { ...selected, summary: true, output: 'truncated' };
  const chain = executionWorkflowRuns(selected, [summary, run('a'), run('foreign', 'another')]);
  assert.deepEqual(
    chain.map((record) => record.id),
    ['a', 'b'],
  );
  assert.equal(chain[1], selected);
  assert.deepEqual(
    executionWorkflowRuns({ ...selected, workflowId: undefined }, [run('a')]).map((record) => record.id),
    ['b'],
  );
});
