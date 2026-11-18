import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/server/store.ts';
import type { RunRecord } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-latency-store-')));
  let store = new Store(directory);
  t.after(() => {
    store.close();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-latency-store-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen: () => {
      store.close();
      store = new Store(directory);
    },
  };
}

function record(index: number): RunRecord {
  const stamp = new Date(Date.parse('2026-10-23T00:00:00Z') + index).toISOString();
  return {
    id: `sample-${index}`,
    status: 'completed',
    kind: 'general',
    prompt: 'PRIVATE_PROMPT',
    output: 'PRIVATE_OUTPUT',
    projectPath: 'C:/synthetic',
    events: [],
    route: { runtimeId: 'fixture', model: 'fixture-model', effort: 'low', kind: 'general', reasons: [], warnings: [] },
    startedAt: stamp,
    endedAt: stamp,
    responseLatency: {
      runId: `sample-${index}`,
      runtimeId: 'fixture',
      key: 'fixture-key',
      model: 'fixture-model',
      effort: 'low',
      sessionMode: 'new',
      firstTextMs: 250,
      observedAt: stamp,
    },
  };
}

test('latency metadata survives reopen and reading does not load run bodies or output', (t) => {
  const f = fixture(t);
  const run = record(1);
  f.store.saveRun(run);
  f.reopen();
  f.store.db.exec("DROP INDEX runs_status; DROP INDEX runs_workflow; UPDATE runs SET value='invalid full body'");
  assert.deepEqual(f.store.responseLatencySamples(), [run.responseLatency]);
  assert.equal(JSON.stringify(f.store.responseLatencySamples()).includes('PRIVATE_'), false);
  const second = record(2);
  f.store.saveRun(second);
  assert.deepEqual(f.store.responseLatencySamples(), [second.responseLatency, run.responseLatency]);
});

test('latency metadata reads only the newest 200 summaries before eligibility filtering', (t) => {
  const f = fixture(t);
  for (let i = 0; i <= 200; i++) {
    const run = record(i);
    if (i > 0) delete run.responseLatency;
    f.store.saveRun(run);
  }
  // If the query filters before its LIMIT or visits full runs, this old malformed row throws.
  f.store.db.exec(
    "UPDATE run_summaries SET value='invalid old summary' WHERE id='sample-0'; DROP INDEX runs_status; DROP INDEX runs_workflow; UPDATE runs SET value='invalid full body'",
  );
  assert.deepEqual(f.store.responseLatencySamples(), []);
  const newest = record(201);
  f.store.saveRun(newest);
  assert.deepEqual(f.store.responseLatencySamples(), [newest.responseLatency]);
});

test('latency metadata rejects unsuccessful, mismatched and malformed samples', (t) => {
  const f = fixture(t);
  const changes: Partial<RunRecord>[] = [
    { status: 'failed' },
    { hadToolActivity: true },
    { steeringInputs: ['correction'] },
  ];
  changes.forEach((change, index) => f.store.saveRun({ ...record(index), ...change }));
  const invalidSamples = [
    { runId: 'wrong' },
    { runtimeId: 'wrong' },
    { firstTextMs: 0 },
    { firstTextMs: -1 },
    { observedAt: 'invalid' },
    { key: '' },
    { model: '' },
    { sessionMode: 'invalid' },
  ];
  invalidSamples.forEach((change, index) => {
    const run = record(10 + index);
    run.responseLatency = { ...run.responseLatency!, ...change } as NonNullable<RunRecord['responseLatency']>;
    f.store.saveRun(run);
  });
  assert.deepEqual(f.store.responseLatencySamples(), []);
});

test('streamed output preserves the latency cache while window and sample changes invalidate it', (t) => {
  const f = fixture(t);
  const run = record(1);
  f.store.saveRun(run);
  const cached = f.store.responseLatencySamples();
  run.output += ' more output';
  run.events.push({ type: 'text', at: run.startedAt, text: 'more' });
  f.store.saveRun(run);
  assert.equal(f.store.responseLatencySamples(), cached);
  run.responseLatency!.firstTextMs = 350;
  f.store.saveRun(run);
  const updated = f.store.responseLatencySamples();
  assert.notEqual(updated, cached);
  assert.equal(updated[0]?.firstTextMs, 350);
  for (let i = 2; i <= 201; i++) {
    const newer = record(i);
    delete newer.responseLatency;
    f.store.saveRun(newer);
  }
  assert.deepEqual(f.store.responseLatencySamples(), [], 'new unrelated runs still evict samples outside the window');
  const empty = f.store.responseLatencySamples();
  run.output += ' an older still-streaming task';
  f.store.saveRun(run);
  assert.equal(f.store.responseLatencySamples(), empty, 'saving an older task cannot enter the current 200-row window');
  f.store.forgetRunSummaries();
  assert.notEqual(f.store.responseLatencySamples(), empty, 'deletion invalidation also clears this cache');
});
