import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Workflow } from '../src/shared/types.ts';

test('distillation SQL prefilter does not parse old workflows and preserves the millisecond boundary and live window', (t) => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  t.after(() => db.close());
  const since = Date.parse('2026-10-12T12:00:00.000Z');
  const at = (offset: number) => new Date(since + offset).toISOString();
  for (let n = 0; n < 20; n++)
    store.save('workflow', `old-${n}`, 'synthetic', {
      id: `old-${n}`,
      updatedAt: at(-1),
      input: { content: 'x'.repeat(256 * 1024) },
    } as Workflow);
  store.save('workflow', 'boundary', 'synthetic', { id: 'boundary', updatedAt: at(0) } as Workflow);
  store.save('workflow', 'fresh', 'synthetic', { id: 'fresh', updatedAt: at(1) } as Workflow);
  store.save('workflow', 'offset', 'synthetic', {
    id: 'offset',
    updatedAt: '2026-10-12T08:00:00.001-04:00',
  } as Workflow);
  store.save('workflow', 'invalid', 'synthetic', { id: 'invalid', updatedAt: 'invalid' } as Workflow);
  const parse = t.mock.method(JSON, 'parse');
  const before = [...store.iterateWorkflows('synthetic')];
  assert.equal(before.length, 24);
  assert.equal(parse.mock.callCount(), 24);
  parse.mock.resetCalls();
  const fresh = [...store.iterateWorkflows('synthetic', since)];
  assert.deepEqual(fresh.map((row) => row.id).sort(), ['fresh', 'offset']);
  assert.equal(parse.mock.callCount(), 2);
  parse.mock.resetCalls();
  assert.equal([...store.iterateWorkflows('synthetic', since + 1)].length, 0);
  assert.equal(parse.mock.callCount(), 0);
  parse.mock.restore();
  // SQL filtering must not pull older rows from outside the existing newest-200 workflow window.
  db.prepare("UPDATE workspace_records SET updated_at=? WHERE id='fresh'").run('2000-01-01');
  for (let n = 0; n < 201; n++)
    store.save('workflow', `recent-${n}`, 'synthetic', {
      id: `recent-${n}`,
      updatedAt: at(-1),
    } as Workflow);
  assert.equal(
    [...store.iterateWorkflows('synthetic', since)].some((row) => row.id === 'fresh'),
    false,
  );
  t.diagnostic('synthetic SQL prefilter: workflow JSON parses 24 -> 2; all expired parses 24 -> 0');
});
