import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Store, presentationBudget } from '../src/server/store.ts';
import { Controller } from '../src/server/controller.ts';
import type { RunEvent, RunRecord, Workflow } from '../src/shared/types.ts';

const stamp = '2020-01-01T00:00:00Z';
const output = 'Synthetic foreground output.\n'.repeat(1000);
const event = (seq: number, data: Record<string, unknown> = {}): RunEvent => ({
  type: 'tool',
  seq,
  at: stamp,
  data: { tool: 'Read', toolCallId: 'call', status: 'completed', output, ...data },
});
const record = (events: RunEvent[]): RunRecord => ({
  id: 'run',
  prompt: 'Synthetic',
  projectPath: 'C:/synthetic',
  kind: 'general',
  status: 'completed',
  startedAt: stamp,
  endedAt: stamp,
  output: 'Final answer',
  reasoning: 'Reasoning',
  events,
  route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'general', reasons: [], warnings: [] },
});
function store(t: TestContext) {
  const value = new Store(mkdtempSync(join(tmpdir(), 'presentation-store-')));
  t.after(() => value.close());
  return value;
}

test('presentation preflight limits audit count and bytes without loading or changing evidence', (t) => {
  const db = store(t);
  db.saveRun(record([event(1, { output: 'small' })]));
  assert.ok(db.presentationSize('run').bytes < presentationBudget.bytes);
  assert.equal(db.presentationSize('run').events, 1);
  const huge = event(2, { output: 'x'.repeat(presentationBudget.eventBytes + 1) });
  db.appendRunAuditEvent('run', huge);
  assert.ok(db.presentationSize('run').maxEventBytes > presentationBudget.eventBytes);
  const archived = db.db.prepare('SELECT value FROM run_audit_events WHERE run_id=? AND seq=?').get('run', 2);
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, { store: db, active: new Map() });
  t.mock.method(controller, 'runWithAudit', () => {
    throw Error('Full audit must not be loaded');
  });
  t.mock.method(db, 'withAudit', () => {
    throw Error('Full audit must not be loaded');
  });
  t.mock.method(db, 'presentationRun', () => {
    throw Error('Full audit must not be loaded');
  });
  const workflow = { id: 'workflow', status: 'completed', input: {}, plan: [], runIds: ['run'] } as unknown as Workflow;
  for (const detail of [false, true]) {
    const projection = controller.conversationPresentation(workflow, [], detail)!;
    assert.equal(projection.detailLimited, true);
    assert.ok(
      projection.items.some((item) => item.text?.includes('Final answer') || item.preview?.includes('Final answer')),
    );
  }
  assert.deepEqual(
    db.db.prepare('SELECT value FROM run_audit_events WHERE run_id=? AND seq=?').get('run', 2),
    archived,
  );
  db.saveRun({ ...record([]), id: 'aggregate' });
  for (let seq = 1; seq <= 10; seq++) db.appendRunAuditEvent('aggregate', event(seq, { output: 'x'.repeat(900_000) }));
  const aggregate = db.presentationSize('aggregate');
  assert.ok(aggregate.bytes > presentationBudget.bytes);
  assert.ok(aggregate.maxEventBytes < presentationBudget.eventBytes);
  assert.equal(
    controller.conversationPresentation({ ...workflow, runIds: ['aggregate'] }, [], true)?.detailLimited,
    true,
  );
  db.saveRun({ ...record([]), id: 'aggregate', visualAssistant: true, output: 'Internal image analysis' });
  assert.equal(db.storedRunSummary('aggregate', true)?.visualAssistant, true);
  assert.ok(
    controller
      .conversationPresentation({ ...workflow, runIds: ['aggregate'] }, [], true)
      ?.items.every((item) => !JSON.stringify(item).includes('Internal image analysis')),
  );
  const many = { ...workflow, runIds: Array.from({ length: 33 }, () => 'run') };
  t.mock.method(db, 'presentationSize', () => {
    throw Error('Run-count limit must precede audit scan');
  });
  assert.equal(controller.conversationPresentation(many, [], true)?.detailLimited, true);
});

test('presentation metadata scans stop after the event-count budget', (t) => {
  const db = store(t);
  db.saveRun(record([]));
  db.db.exec('BEGIN');
  try {
    for (let seq = 1; seq <= presentationBudget.events + 5; seq++)
      db.appendRunAuditEvent('run', { type: 'text', seq, at: stamp, text: 'synthetic' });
    db.db.exec('COMMIT');
  } catch (error) {
    db.db.exec('ROLLBACK');
    throw error;
  }
  assert.equal(db.presentationSize('run').events, presentationBudget.events + 1);
  assert.equal(
    (db.db.prepare('SELECT count(*) AS n FROM run_audit_events WHERE run_id=?').get('run') as { n: number }).n,
    presentationBudget.events + 5,
  );
});

test('presentation size cache follows saved runs and appended audit revisions', (t) => {
  const db = store(t);
  db.saveRun(record([]));
  const first = db.presentationSize('run');
  assert.equal(db.presentationSize('run'), first);
  db.appendRunAuditEvent('run', event(1, { output: 'small' }));
  const appended = db.presentationSize('run');
  assert.notEqual(appended, first);
  assert.equal(appended.events, 1);
  assert.equal(db.presentationSize('run'), appended);
  db.saveRun(record([event(2, { output: 'saved event' })]));
  const saved = db.presentationSize('run');
  assert.notEqual(saved, appended);
  assert.equal(saved.events, 2);
  assert.ok(saved.bytes > appended.bytes);
});

test('compact SQLite reads merge retained and archived events without changing durable detail', (t) => {
  const db = store(t);
  db.appendRunAuditEvent('run', event(1));
  db.appendRunAuditEvent('run', event(2, { status: 'running' }));
  const legacy: RunEvent = { type: 'text', at: stamp, text: 'Legacy narration' };
  db.saveRun(
    record([
      legacy,
      event(2),
      event(3, { tool: 'unknown-tool' }),
      { type: 'status', at: stamp, seq: 4, data: { taskList: [{ title: 'Synthetic step', status: 'completed' }] } },
    ]),
  );
  const compact = db.presentationRun('run')!;
  assert.equal(compact.output, 'Final answer');
  assert.equal(compact.reasoning, 'Reasoning');
  assert.deepEqual(
    compact.events.map((e) => e.seq),
    [undefined, 1, 2, 3, 4],
  );
  assert.equal(compact.events[1].data?.output, undefined);
  assert.equal(compact.events[2].data?.status, 'completed');
  assert.equal(compact.events[3].data?.output, output);
  assert.deepEqual(compact.events[4].data?.taskList, [{ title: 'Synthetic step', status: 'completed' }]);
  assert.equal(db.run('run')!.events[1].data?.output, output);
  assert.equal(db.presentationRun('missing'), undefined);
});

test('compact SQLite reads retain background evidence across observations and JSON string fields', (t) => {
  const db = store(t);
  for (const marker of [
    { arguments: JSON.stringify({ run_in_background: true }) },
    { result: JSON.stringify({ session_id: '42' }) },
    { output: 'session ID 42' },
    { arguments: { task_id: '42' } },
  ]) {
    db.saveRun(record([event(1, marker), event(2, { exitCode: 1 })]));
    assert.equal(db.presentationRun('run')!.events[1].data?.output, output);
  }
  db.appendRunAuditEvent('run', event(1, { output: 'session ID 42' }));
  db.saveRun(record([event(2, { exitCode: 0 })]));
  assert.equal(db.presentationRun('run')!.events[1].data?.output, output);
});

test('audit inserts advance stored revision counters, duplicate replay does not', (t) => {
  const db = store(t);
  db.saveRun(record([]));
  const before = db.runRevisionOf('run');
  db.appendRunAuditEvent('run', event(1));
  const after = db.runRevisionOf('run');
  assert.ok(after > before);
  db.appendRunAuditEvent('run', event(1));
  assert.equal(db.runRevisionOf('run'), after);
});

test('native conversation session metadata does not disable foreground output pruning', (t) => {
  const db = store(t);
  db.saveRun({
    ...record([event(1), { type: 'status', at: stamp, seq: 2, data: { nativeSessionId: 'synthetic-session' } }]),
    nativeSessionId: 'synthetic-session',
  });
  assert.equal(db.presentationRun('run')!.events[0].data?.output, undefined);
  assert.equal(db.run('run')!.events[0].data?.output, output);
});

test('a task that has not started a run yet presents its waiting reason instead of failing', (t) => {
  const db = store(t);
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, { store: db, active: new Map() });
  const reason = '正在本机转写视频语音：3/14 分钟';
  const workflow = {
    id: 'pre-run',
    status: 'running',
    input: { content: 'Synthetic video request' },
    plan: [],
    runIds: [],
    updatedAt: stamp,
    scheduling: { reason, estimatedMinutes: 5, lastEvaluatedAt: stamp },
  } as unknown as Workflow;
  for (const detail of [true, false]) {
    const projection = controller.conversationPresentation(workflow, [workflow], detail);
    assert.ok(projection, 'a pre-run task still has a presentation');
    assert.equal(projection.workflowId, workflow.id);
    assert.deepEqual(projection.items, []);
    assert.equal(projection.waiting, reason);
  }
  // A newer scheduling reason replaces the cached compact projection.
  const next = { ...workflow, updatedAt: '2020-01-01T00:00:05Z', scheduling: { reason: '执行器已启动。' } } as Workflow;
  assert.equal(controller.conversationPresentation(next, [next])?.waiting, '执行器已启动。');
  // Once a run exists, or the task settled without one, the waiting line goes away.
  db.saveRun(record([]));
  assert.equal(controller.conversationPresentation({ ...workflow, runIds: ['run'] }, [], true)?.waiting, undefined);
  assert.equal(controller.conversationPresentation({ ...workflow, status: 'cancelled' }, [], true)?.waiting, undefined);
});
