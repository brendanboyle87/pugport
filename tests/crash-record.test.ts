import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCrashRecord, shouldRecordCrash } from '../src/electron/crash-record.ts';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createCrashRecord(directory) };
}
test('crash record persists across repeated reads until cleared and keeps new events independent', (t) => {
  const { directory, store } = fixture(t);
  assert.equal(store.take(), undefined);
  store.record('renderer', 'crashed');
  const previous = createCrashRecord(directory).take()!;
  assert.equal(previous.kind, 'renderer');
  assert.equal(previous.reason, 'crashed');
  assert.ok(Number.isFinite(Date.parse(previous.at)));
  assert.deepEqual(store.take(), previous);
  assert.deepEqual(createCrashRecord(directory).take(), previous);
  store.record('backend', 'abnormal-exit');
  assert.equal(previous.kind, 'renderer');
  assert.equal(store.take()?.kind, 'backend');
  store.record('renderer', 'oom');
  store.clear();
  assert.equal(store.take(), undefined);
});
test('clean exits, quit-time events and unrelated reasons never create records', (t) => {
  const { store } = fixture(t);
  for (const kind of ['renderer', 'backend'] as const) {
    store.record(kind, 'clean-exit');
    store.record(kind, 'crashed', true);
    store.record(kind, 'unknown');
  }
  store.record('backend', 'killed');
  assert.equal(store.take(), undefined);
  assert.equal(shouldRecordCrash('renderer', 'killed', false), true);
});
test('unclean markers and dumps alone do not create a crash notice', (t) => {
  const { directory, store } = fixture(t);
  mkdirSync(join(directory, 'logs'));
  writeFileSync(join(directory, 'logs', 'unclean-exit'), 'true');
  writeFileSync(join(directory, 'logs', 'new-dump.dmp'), 'synthetic');
  assert.equal(store.take(), undefined);
});
test('invalid crash payload is never returned', (t) => {
  const { directory, store } = fixture(t);
  mkdirSync(join(directory, 'logs'));
  for (const value of [
    { kind: 'GPU', reason: 'crashed', at: new Date().toISOString() },
    { kind: 'renderer', reason: 'clean-exit', at: new Date().toISOString() },
    { kind: 'renderer', reason: 'crashed', at: 'invalid' },
  ]) {
    writeFileSync(join(directory, 'logs', 'last-crash.json'), JSON.stringify(value));
    assert.equal(store.take(), undefined);
  }
});

test('acknowledging a displayed crash preserves a newer crash record', (t) => {
  const { store } = fixture(t);
  store.record('renderer', 'crashed');
  const displayed = store.take()!;
  store.record('backend', 'abnormal-exit');
  store.clear(displayed);
  assert.equal(store.take()?.kind, 'backend');
  store.clear(store.take());
  assert.equal(store.take(), undefined);
});
