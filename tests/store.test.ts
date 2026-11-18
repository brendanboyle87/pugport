import { storedRuns } from './helpers/stored-runs.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import type { RunRecord, RuntimeTarget } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-store-test-'));
  let current: Store | undefined = new Store(directory);
  t.after(() => {
    current?.close();
    for (const name of ['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm']) {
      const path = join(directory, name);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(directory);
  });
  return {
    get store() {
      return current!;
    },
    reopen() {
      current?.close();
      current = undefined;
      current = new Store(directory);
      return current;
    },
  };
}

function run(id: string, status: RunRecord['status'], offset = 0): RunRecord {
  return {
    id,
    status,
    prompt: '继续处理中文项目',
    projectPath: 'C:/projects/项目 space',
    kind: 'architecture',
    route: {
      runtimeId: 'codex-native',
      model: 'gpt-6-sol',
      effort: 'high',
      kind: 'architecture',
      reasons: ['test'],
      warnings: [],
    },
    startedAt: new Date(Date.parse('2026-09-26T12:00:00Z') + offset).toISOString(),
    nativeSessionId: `native-${id}`,
    output: '已经保存的输出\n第二行',
    events: [{ at: '2026-09-26T12:00:01Z', type: 'session', data: { sessionId: `native-${id}` } }],
    parentRunId: 'previous-run',
  };
}

test('reopening marks every in-progress state interrupted and preserves resumable context', (t) => {
  const f = fixture(t);
  const records = (['queued', 'running', 'waiting-approval'] as const).map((status) => run(status, status));
  for (const record of records) f.store.saveRun(record);
  const reopened = f.reopen();
  for (const original of records) {
    const saved = reopened.run(original.id)!;
    assert.equal(saved.status, 'interrupted');
    assert.ok(Number.isFinite(Date.parse(saved.endedAt!)));
    assert.match(saved.error!, /未自动重放/);
    assert.deepEqual(saved, { ...original, status: 'interrupted', endedAt: saved.endedAt, error: saved.error });
  }
  const recovered = storedRuns(reopened);
  // A second restart must not reset recovery timestamps or invent another run.
  assert.deepEqual(storedRuns(f.reopen()), recovered);
});

test('reopening preserves terminal statuses, verification results, and errors exactly', (t) => {
  const f = fixture(t);
  const records = (['completed', 'failed', 'cancelled', 'interrupted'] as const).map((status, index) => ({
    ...run(status, status, index),
    endedAt: '2026-09-26T12:01:00Z',
    error: status === 'completed' ? undefined : `original-${status}`,
    verification: { command: 'npm test', status: 'failed' as const, exitCode: 1, output: 'one assertion failed' },
  }));
  for (const record of records) f.store.saveRun(record);
  const before = storedRuns(f.store);
  f.reopen();
  assert.deepEqual(storedRuns(f.store), before);
  for (const record of records)
    assert.deepEqual(
      f.store.run(record.id),
      before.find((saved) => saved.id === record.id),
    );
  assert.equal(f.store.run('does-not-exist'), undefined);
});

test('restart recovers unfinished runs older than the 200-run UI history page', (t) => {
  const f = fixture(t);
  const unfinished = (['running', 'queued', 'waiting-approval'] as const).map((status, index) =>
    run(`old-${status}`, status, index),
  );
  for (const record of unfinished) f.store.saveRun(record);
  for (let index = 0; index < 205; index++)
    f.store.saveRun({ ...run(`recent-${index}`, 'completed', 1000 + index), endedAt: '2026-09-26T12:01:00Z' });
  assert.equal(storedRuns(f.store).length, 200);
  assert.ok(storedRuns(f.store).every((record) => record.status === 'completed'));
  f.reopen();
  for (const original of unfinished) {
    const restored = f.store.run(original.id)!;
    assert.equal(
      restored.status,
      'interrupted',
      `${original.id} must be recovered even when not in the latest history page`,
    );
    assert.equal(restored.nativeSessionId, original.nativeSessionId);
    assert.equal(restored.output, original.output);
  }
});

test('configuration and updated run content survive reopening without duplicate history', (t) => {
  const f = fixture(t);
  const targets: RuntimeTarget[] = [
    {
      id: 'codex-native',
      provider: 'codex',
      label: '本机',
      command: 'C:/Program Files/CLI/codex.exe',
      args: ['app-server'],
      environment: 'native',
      enabled: true,
    },
  ];
  assert.deepEqual(f.store.config('missing', { fallback: true }), { fallback: true });
  f.store.setConfig('targets', targets);
  f.store.setConfig('settings', { reservePercent: 15, defaultProjectPath: 'C:/projects/中文 space' });
  f.store.setConfig('settings', { reservePercent: 25, defaultProjectPath: 'C:/projects/中文 space' });
  const record = run('same-run', 'running');
  f.store.saveRun(record);
  const updated = {
    ...record,
    status: 'completed' as const,
    output: `${record.output}\nfinal result`,
    endedAt: '2026-09-26T12:01:00Z',
  };
  f.store.saveRun(updated);
  f.reopen();
  assert.deepEqual(f.store.config('targets', []), targets);
  assert.deepEqual(f.store.config('settings', {}), {
    reservePercent: 25,
    defaultProjectPath: 'C:/projects/中文 space',
  });
  assert.deepEqual(storedRuns(f.store), [updated]);
});

test('run summaries trim output and events and stay current after later saves', (t) => {
  const f = fixture(t);
  const long = {
    ...run('long', 'completed', 1),
    output: 'a'.repeat(9000) + 'END',
    events: [{ at: 'x', type: 'status' as const, text: 'e' }],
  };
  f.store.saveRun(run('older', 'completed', 0));
  f.store.saveRun(long);
  const fresh = f.reopen();
  const loaded = fresh.runSummaries();
  assert.deepEqual(
    loaded.map((r) => r.id),
    ['long', 'older'],
  );
  assert.equal(loaded[0].summary, true);
  assert.deepEqual(loaded[0].events, []);
  assert.equal(loaded[0].output.length, 1000);
  assert.ok(loaded[0].output.endsWith('END'));
  assert.equal(fresh.run('long')?.output.length, 9003);
  // Saves after the first read update the cache without re-reading the table.
  fresh.saveRun({ ...run('newest', 'running', 2), output: 'live' });
  fresh.saveRun({ ...long, status: 'failed' });
  const updated = fresh.runSummaries();
  assert.deepEqual(
    updated.map((r) => r.id),
    ['newest', 'long', 'older'],
  );
  assert.equal(updated[1].status, 'failed');
  assert.deepEqual(updated[1].events, []);
});

test('run summaries leave out streamed reasoning; the full record keeps it', (t) => {
  const f = fixture(t);
  f.store.saveRun({ ...run('thinking', 'completed'), reasoning: 'long private chain' });
  const fresh = f.reopen();
  assert.equal(fresh.runSummaries()[0]!.reasoning, undefined);
  assert.equal(fresh.run('thinking')?.reasoning, 'long private chain');
  fresh.saveRun({ ...run('thinking', 'completed'), reasoning: 'updated' });
  assert.equal(fresh.runSummaries()[0]!.reasoning, undefined);
});

test('durable summaries backfill legacy runs and follow save rollback and deletion', (t) => {
  const f = fixture(t);
  const selected = { ...run('older-conversation', 'completed'), workflowId: 'selected', output: 'x'.repeat(20000) };
  f.store.saveRun(selected);
  for (let i = 1; i <= 205; i++) f.store.saveRun({ ...run(`other-${i}`, 'completed', i), workflowId: 'other' });
  f.store.db.exec(`DROP TRIGGER IF EXISTS runs_summary_insert; DROP TRIGGER IF EXISTS runs_summary_update;
    DROP TRIGGER runs_summary_delete; DROP TABLE run_summaries;`);
  const store = f.reopen();
  assert.equal(
    store.runSummaries().some((r) => r.id === selected.id),
    false,
  );
  const backfilled = store.db.prepare('SELECT value FROM run_summaries WHERE id=?').get(selected.id) as {
    value: string;
  };
  assert.equal(JSON.parse(backfilled.value).output.length, 1000);
  assert.equal(store.storedRun(selected.id)!.output, selected.output);
  const latest = store.runSummaries()[0]!;
  store.db.exec('BEGIN');
  store.saveRun({ ...latest, status: 'failed' });
  assert.equal(store.runSummaries()[0]!.status, 'failed');
  store.db.exec('ROLLBACK');
  assert.equal(store.runSummaries()[0]!.status, 'completed', 'the in-memory page must also follow rollback');
  store.db.prepare('DELETE FROM runs WHERE id=?').run(selected.id);
  assert.equal(store.db.prepare('SELECT id FROM run_summaries WHERE id=?').get(selected.id), undefined);
});

test('distillation filters old runs before parsing and omits large task text and audit payloads', (t) => {
  const f = fixture(t);
  const since = Date.parse('2026-09-26T12:01:00.500Z');
  const record = {
    ...run('old-distillation', 'completed'),
    endedAt: '2026-09-26T08:01:00.500-04:00',
    prompt: 'p'.repeat(100_000),
    output: 'o'.repeat(100_000),
    reasoning: 'r'.repeat(100_000),
  };
  f.store.saveRun(record);
  f.store.appendRunAuditEvent(record.id, { seq: 1, at: record.endedAt, type: 'tool', text: 'archive-only' });
  const original = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return original(...args);
  });
  assert.equal(f.store.storedRunForDistillation(record.id, since), undefined);
  assert.equal(f.store.storedRunForDistillation('missing', since), undefined);
  assert.equal(parses, 0);
  f.store.saveRun({ ...record, endedAt: '2026-09-26T08:01:00.501-04:00' });
  const recent = f.store.storedRunForDistillation(record.id, since)!;
  assert.equal(parses, 1);
  assert.equal(recent.prompt, undefined);
  assert.equal(recent.output, undefined);
  assert.equal(recent.reasoning, undefined);
  assert.deepEqual(recent.events, record.events);
  assert.ok(!JSON.stringify(recent).includes('archive-only'));
  assert.equal(f.store.storedRun(record.id)!.prompt, record.prompt);
  for (const status of ['queued', 'running', 'waiting-approval'] as const) {
    f.store.saveRun({ ...record, status });
    assert.equal(f.store.storedRunForDistillation(record.id, since)?.status, status);
  }
  for (const endedAt of [undefined, '', 'invalid']) {
    f.store.saveRun({ ...record, endedAt });
    assert.equal(f.store.storedRunForDistillation(record.id, since)?.id, record.id);
  }
});

test('steering progress survives SQL summaries, cached summaries, and full records', (t) => {
  const f = fixture(t);
  const record: RunRecord = {
    ...run('steering', 'completed'),
    steeringProgress: { id: 'delivery-1', phase: 'received', mode: 'interrupt', at: '2026-10-05T12:00:00Z' },
  };
  f.store.saveRun(record);
  const fresh = f.reopen();
  assert.deepEqual(fresh.runSummaries()[0]!.steeringProgress, record.steeringProgress);
  const updated: RunRecord = {
    ...record,
    steeringProgress: { ...record.steeringProgress!, phase: 'resuming', at: '2026-10-05T12:00:01Z' },
  };
  fresh.saveRun(updated);
  assert.deepEqual(fresh.runSummaries()[0]!.steeringProgress, updated.steeringProgress);
  assert.deepEqual(fresh.run(record.id)!.steeringProgress, updated.steeringProgress);
});

test('a failed summary write rolls back the full run too', (t) => {
  const { store } = fixture(t);
  const original = run('atomic', 'completed');
  store.saveRun(original);
  store.runSummaries();
  store.db.exec(`CREATE TRIGGER reject_summary BEFORE UPDATE ON run_summaries BEGIN
    SELECT RAISE(ABORT, 'synthetic failure'); END;`);
  assert.throws(() => store.saveRun({ ...original, output: 'must roll back' }), /synthetic failure/);
  assert.equal(store.storedRun(original.id)!.output, original.output);
  assert.equal(store.runSummaries()[0]!.output, original.output);
  assert.equal(store.db.isTransaction, false);
});

test('durable commits use FULL and restore NORMAL after success or throw', (t) => {
  const { store } = fixture(t);
  const synchronous = () => store.db.prepare('PRAGMA synchronous').get()!.synchronous;
  assert.equal(synchronous(), 1);
  assert.equal(
    store.durable(() => {
      assert.equal(synchronous(), 2);
      store.setConfig('durable-test', { saved: true });
      return 42;
    }),
    42,
  );
  assert.equal(synchronous(), 1);
  assert.throws(
    () =>
      store.durable(() => {
        assert.equal(synchronous(), 2);
        throw new Error('synthetic failure');
      }),
    /synthetic failure/,
  );
  assert.equal(synchronous(), 1);
  assert.deepEqual(store.config('durable-test', {}), { saved: true });
});

test('context survives trimmed persisted and cached run summaries', (t) => {
  const f = fixture(t);
  const record: RunRecord = {
    ...run('context', 'completed'),
    output: 'x'.repeat(5000),
    context: { tokens: 126000, window: 200000, at: '2026-10-14T12:00:00Z' },
  };
  f.store.saveRun(record);
  assert.deepEqual(f.reopen().runSummaries()[0]!.context, record.context);
  const updated = { ...record, context: { ...record.context!, tokens: 130000 } };
  f.store.saveRun(updated);
  assert.deepEqual(f.store.runSummaries()[0]!.context, updated.context);
  assert.deepEqual(f.store.storedRun(record.id)!.context, updated.context);
  assert.equal(f.store.runSummaries()[0]!.output.length, 1000);
});
