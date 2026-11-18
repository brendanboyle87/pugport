import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskList } from '../src/shared/task-list.ts';
test('native plan and todo schemas share ordered task states', () => {
  assert.deepEqual(
    normalizeTaskList([
      { step: 'Read', status: 'completed' },
      { content: 'Edit', status: 'in_progress' },
      { title: 'Verify', status: 'pending' },
    ]),
    [
      { title: 'Read', status: 'completed' },
      { title: 'Edit', status: 'running' },
      { title: 'Verify', status: 'pending' },
    ],
  );
});
test('empty lists clear snapshots; missing lists preserve them; malformed items and long text are bounded', () => {
  assert.equal(normalizeTaskList(null), undefined);
  assert.deepEqual(normalizeTaskList([]), []);
  assert.deepEqual(normalizeTaskList([null, {}, { content: ' ' }]), []);
  assert.equal(normalizeTaskList(Array.from({ length: 300 }, () => ({ title: 'x'.repeat(1000) })))?.length, 200);
  assert.ok(normalizeTaskList([{ title: 'x'.repeat(1000) }])![0].title.length <= 160);
});
