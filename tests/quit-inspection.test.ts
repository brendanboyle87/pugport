import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { inspectQuitWork } from '../src/server/quit-inspection.ts';
import type { BackgroundTask, Workflow, RunRecord } from '../src/shared/types.ts';
import { DesktopQuitController, needsQuitConfirmation } from '../src/electron/lifecycle.ts';

test('backend quit inspection passes the controller background tasks as its fifth argument', () => {
  const main = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  assert.match(
    main,
    /inspectQuitWork\(\s*controller\.store\.db,\s*\[\.\.\.controller\.active\.values\(\)\]\.map\(\(entry\) => entry\.run\),\s*controller\.approvals\.size,\s*Date\.now\(\),\s*controller\.backgroundTasks\(\),?\s*\)/,
  );
});

test('quit inspection retains pre-execution confirmations without claiming they are executing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE workspace_records(kind TEXT,value TEXT); CREATE TABLE runs(value TEXT)');
    db.prepare('INSERT INTO workspace_records VALUES(?,?)').run(
      'workflow',
      JSON.stringify({ id: 'pending', status: 'waiting-confirmation', runIds: [], input: {} }),
    );
    assert.deepEqual(inspectQuitWork(db), { active: 0, queued: 1, waitingApproval: 1, scheduled: 0 });
  } finally {
    db.close();
  }
});

test('quit inspection includes old queued and scheduled tasks beyond history pagination', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE workspace_records(kind TEXT,value TEXT); CREATE TABLE runs(value TEXT)');
    const insert = db.prepare('INSERT INTO workspace_records VALUES(?,?)');
    for (let i = 0; i < 305; i++)
      insert.run(
        'workflow',
        JSON.stringify({
          id: `w${i}`,
          status: i < 3 ? 'queued' : 'completed',
          runIds: [],
          input: { schedule: i === 0 ? { notBefore: '2030-01-01T00:00:00Z' } : {} },
        }),
      );
    assert.deepEqual(inspectQuitWork(db, [], 0, Date.parse('2026-09-26')), {
      active: 0,
      queued: 2,
      waitingApproval: 0,
      scheduled: 1,
    });
  } finally {
    db.close();
  }
});

test('future scheduled work alone is not counted as queued work', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE workspace_records(kind TEXT,value TEXT); CREATE TABLE runs(value TEXT)');
    db.prepare('INSERT INTO workspace_records VALUES(?,?)').run(
      'workflow',
      JSON.stringify({ id: 'future', status: 'queued', runIds: [], input: { schedule: { notBefore: '2030-01-01' } } }),
    );
    assert.deepEqual(inspectQuitWork(db, [], 0, Date.parse('2026-10-14')), {
      active: 0,
      queued: 0,
      waitingApproval: 0,
      scheduled: 1,
    });
    assert.equal(inspectQuitWork(db, [], 0, Date.parse('2030-01-01')).queued, 1);
  } finally {
    db.close();
  }
});

test('quit inspection deduplicates workflow child runs and includes work between steps', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE workspace_records(kind TEXT,value TEXT); CREATE TABLE runs(value TEXT)');
    const workflows = [
      { id: 'w1', status: 'waiting-approval', runIds: ['r1'], input: {} },
      { id: 'w2', status: 'waiting-resource', startedAt: '2026-09-26', runIds: ['r2'], input: {} },
      { id: 'w3', status: 'blocked', runIds: [], input: {} },
    ] as Workflow[];
    for (const workflow of workflows)
      db.prepare('INSERT INTO workspace_records VALUES(?,?)').run('workflow', JSON.stringify(workflow));
    const run = { id: 'r1', workflowId: 'w1', status: 'waiting-approval' } as RunRecord;
    db.prepare('INSERT INTO runs VALUES(?)').run(JSON.stringify(run));
    const refreshing = { id: 'direct-run', status: 'completed' } as RunRecord;
    assert.deepEqual(inspectQuitWork(db, [run, refreshing], 1), {
      active: 3,
      queued: 0,
      waitingApproval: 1,
      scheduled: 0,
    });
  } finally {
    db.close();
  }
});

for (const kind of ['media-analysis', 'image-search'] as const) {
  test(`local-only ${kind} work prompts on normal quit and refuses scripted quit with a blocked parent`, async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE workspace_records(kind TEXT,value TEXT); CREATE TABLE runs(value TEXT)');
      const insert = db.prepare('INSERT INTO workspace_records VALUES(?,?)');
      for (const status of ['blocked', 'completed', 'paused'])
        insert.run('workflow', JSON.stringify({ id: status, status, runIds: [], input: {} }));
      insert.run(
        'workflow',
        JSON.stringify({
          id: 'future',
          status: 'queued',
          runIds: [],
          input: { schedule: { notBefore: '2030-01-01' } },
        }),
      );
      const task: BackgroundTask = {
        id: 'synthetic-local-task',
        kind,
        state: 'running',
        conversationId: 'synthetic-chat',
        title: 'Synthetic local work',
        detail: '',
        done: 0,
        total: 1,
        startedAt: '2026-10-16',
      };
      const inspect = (tasks: BackgroundTask[]) => inspectQuitWork(db, [], 0, Date.parse('2026-10-16'), tasks);
      const state = inspect([task]);
      assert.deepEqual(state, { active: 1, queued: 0, waitingApproval: 0, scheduled: 1 });
      assert.equal(needsQuitConfirmation(state), true);
      assert.equal(inspect([{ ...task, state: 'paused' }]).active, 0);
      assert.equal(inspect([]).active, 0, 'Finished work is absent from the task sources');
      let prompts = 0;
      const quit = new DesktopQuitController({
        inspect: async () => state,
        confirm: async () => {
          prompts++;
          return false;
        },
        stop: async () => assert.fail('Local work must keep the backend alive'),
        exit: () => assert.fail('Local work must prevent exit'),
        error: () => assert.fail('Unexpected quit error'),
      });
      assert.equal(await quit.request('scripted'), false);
      assert.equal(prompts, 0);
      assert.equal(await quit.request(), false);
      assert.equal(prompts, 1);
    } finally {
      db.close();
    }
  });
}
