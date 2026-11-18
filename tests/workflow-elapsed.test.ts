import { formatConversationDuration } from '../src/ui/WorkflowElapsed.tsx';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunRecord, Workflow } from '../src/shared/types.ts';
import { formatElapsedDuration, workflowElapsed, WorkflowElapsed } from '../src/ui/WorkflowElapsed.tsx';

const start = Date.parse('2026-10-01T12:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const workflow = (patch: Partial<Workflow> = {}) => ({
  id: 'workflow',
  status: 'running' as Workflow['status'],
  startedAt: at(0),
  updatedAt: at(10),
  runIds: ['run'],
  ...patch,
});
const run = (patch: Partial<RunRecord> = {}) => ({
  id: 'run',
  workflowId: 'workflow',
  startedAt: at(2),
  endedAt: at(8),
  ...patch,
});

test('formats seconds, minutes, hours, and more than one day without wrapping', () => {
  for (const [milliseconds, expected] of [
    [0, '0秒'],
    [59999, '59秒'],
    [60000, '1分00秒'],
    [62000, '1分02秒'],
    [3600000, '1小时00分00秒'],
    [3723000, '1小时02分03秒'],
    [90061000, '25小时01分01秒'],
    [-1000, '0秒'],
    [Number.NaN, '0秒'],
    [Number.POSITIVE_INFINITY, '0秒'],
  ] as const) {
    assert.equal(formatElapsedDuration(milliseconds), expected);
  }
});

test('uses actual workflow launch and advances by wall time, including an approval wait', () => {
  for (const status of ['planning', 'running', 'waiting-approval'] as const) {
    const task = workflow({ status, createdAt: at(-600) });
    assert.equal(workflowElapsed(task, [run()], start + 12000)?.elapsedMs, 12000);
    assert.equal(workflowElapsed(task, [run()], start + 3723000)?.elapsedMs, 3723000);
    assert.equal(workflowElapsed(task, [run()], start + 12000)?.active, true);
  }
});

test('unstarted queue, resource, and confirmation waits have no execution timer', () => {
  for (const status of ['queued', 'waiting-resource', 'waiting-confirmation'] as const) {
    const task = workflow({ status, startedAt: undefined, runIds: [], createdAt: at(-600) });
    assert.equal(workflowElapsed(task, [], start + 12000), undefined);
    assert.equal(renderToStaticMarkup(createElement(WorkflowElapsed, { workflow: task, runs: [] })), '');
  }
});

test('a resource wait after execution shows the known elapsed time without a live timer', () => {
  const task = workflow({ status: 'waiting-resource' });
  assert.deepEqual(workflowElapsed(task, [run()], start + 12000), {
    startedAt: start,
    active: false,
    paused: true,
    elapsedMs: 10000,
  });
  assert.equal(workflowElapsed(task, [run()], start + 600000)?.elapsedMs, 10000);
});

test('all stopped states freeze at the last native end, with workflow stop time as a fallback', () => {
  for (const status of ['completed', 'blocked', 'failed', 'cancelled', 'interrupted'] as const) {
    const task = workflow({ status });
    assert.equal(workflowElapsed(task, [run()], start + 12000)?.elapsedMs, 8000);
    assert.equal(workflowElapsed(task, [run()], start + 600000)?.elapsedMs, 8000);
    assert.equal(workflowElapsed(task, [run()], start + 12000)?.active, false);
    assert.equal(workflowElapsed(task, [run({ endedAt: undefined })], start + 12000)?.elapsedMs, 10000);
  }
});

test('later cancel metadata cannot extend elapsed wall time after all native runs end', () => {
  const task = workflow({ status: 'blocked', updatedAt: at(31), runIds: ['run', 'later'] });
  const runs = [run(), run({ id: 'later', startedAt: at(20), endedAt: at(30) })];
  // Includes the launch and the gap between attempts, rather than summing native execution durations.
  assert.equal(workflowElapsed(task, runs, start + 32000)?.elapsedMs, 30000);
  const cancelled = { ...task, status: 'cancelled' as const, updatedAt: at(600) };
  assert.equal(workflowElapsed(cancelled, runs, start + 660000)?.elapsedMs, 30000);
});

test('old workflows use the earliest own native launch and last valid run end as fallbacks', () => {
  const task = workflow({ status: 'completed', startedAt: undefined, updatedAt: 'invalid', runIds: ['a', 'b', 'bad'] });
  const runs = [
    run({ id: 'b', startedAt: at(5), endedAt: at(9) }),
    run({ id: 'a', startedAt: at(1), endedAt: at(4) }),
    run({ id: 'bad', startedAt: 'invalid', endedAt: 'invalid' }),
    run({ id: 'unrelated', startedAt: at(-100), endedAt: at(100) }),
    run({ id: 'a', workflowId: 'other-workflow', startedAt: at(-200), endedAt: at(200) }),
  ];
  assert.equal(workflowElapsed(task, runs, start + 12000)?.elapsedMs, 8000);
  assert.equal(workflowElapsed(task, runs, start + 600000)?.elapsedMs, 8000);
});

test('invalid, future, and reversed timestamps cannot produce negative or drifting stopped durations', () => {
  assert.equal(workflowElapsed(workflow({ startedAt: 'invalid', runIds: [] }), [], start + 12000), undefined);
  assert.equal(workflowElapsed(workflow({ startedAt: at(20) }), [], start + 12000)?.elapsedMs, 0);
  assert.equal(workflowElapsed(workflow(), [], Number.NaN), undefined);
  for (const updatedAt of ['invalid', at(-10), at(30)]) {
    const task = workflow({ status: 'completed', updatedAt });
    assert.equal(workflowElapsed(task, [run()], start + 12000)?.elapsedMs, 8000);
    assert.equal(workflowElapsed(task, [], start + 12000)?.elapsedMs, 0);
  }
  assert.equal(workflowElapsed(workflow({ deletedAt: at(12) }), [run()], start + 12000), undefined);
});

test('the visible counter explains that approval waits count and avoids announcing every second', (t) => {
  t.mock.method(Date, 'now', () => start + 62000);
  const html = renderToStaticMarkup(
    createElement(WorkflowElapsed, { workflow: workflow({ status: 'waiting-approval' }), runs: [run()] }),
  );
  assert.match(html, /class="workflow-elapsed"/);
  assert.match(html, />1分02秒<\/span>/);
  assert.match(html, /title="已运行 · /);
  assert.match(html, /审批等待/);
  assert.doesNotMatch(html, /aria-live/);
  const stopped = renderToStaticMarkup(
    createElement(WorkflowElapsed, { workflow: workflow({ status: 'completed' }), runs: [run()] }),
  );
  assert.match(stopped, />8秒<\/span>/);
  assert.match(stopped, /title="用时 · /);
});

test('conversation durations use localized units shared by turn and background work', () => {
  for (const [ms, en, zh] of [
    [72000, '1 min 12 s', '1 分 12 秒'],
    [59000, '59 s', '59 秒'],
    [60000, '1 min 0 s', '1 分 0 秒'],
    [3601000, '1 h 1 s', '1 小时 1 秒'],
    [0, '0 s', '0 秒'],
    [-1000, '0 s', '0 秒'],
    [Number.NaN, '0 s', '0 秒'],
  ] as const) {
    assert.equal(formatConversationDuration(ms, 'en'), en);
    assert.equal(formatConversationDuration(ms, 'zh-CN'), zh);
  }
});
