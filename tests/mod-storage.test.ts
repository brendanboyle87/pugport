import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModStorage } from '../src/server/mod-storage.ts';

const storage = (quota?: number) => new ModStorage(new DatabaseSync(':memory:'), quota);

test('each Mod has its own namespace and writes are idempotent upserts', () => {
  const s = storage();
  s.put('example.finance', 'ledger', [{ key: 'tx_1', value: '{"amount":12.5}' }], new Date('2026-10-01T00:00:00Z'));
  s.put('example.other', 'ledger', [{ key: 'tx_1', value: 'other' }]);
  // The same write again keeps the first time: nothing changed.
  s.put('example.finance', 'ledger', [{ key: 'tx_1', value: '{"amount":12.5}' }], new Date('2026-10-02T00:00:00Z'));
  assert.deepEqual(s.get('example.finance', 'ledger', ['tx_1', 'missing']), [
    { key: 'tx_1', value: '{"amount":12.5}', updatedAt: '2026-10-01T00:00:00.000Z' },
  ]);
  assert.equal(s.get('example.other', 'ledger', ['tx_1'])[0]!.value, 'other');
  assert.equal(s.usage('example.finance').items, 1);
  assert.deepEqual(s.delete('example.finance', 'ledger', ['tx_1', 'tx_1']), { deleted: 1 });
  assert.equal(s.get('example.other', 'ledger', ['tx_1']).length, 1);
  assert.throws(
    () =>
      s.put('example.finance', 'ledger', [
        { key: 'a', value: '1' },
        { key: 'a', value: '2' },
      ]),
    { code: 'E_INVALID' },
  );
});

test('lists page by cursor and prefix without skipping or repeating', () => {
  const s = storage();
  const items = Array.from({ length: 25 }, (_, i) => ({
    key: `2026-10-${String(i + 1).padStart(2, '0')}`,
    value: `${i}`,
  }));
  s.put('example.finance', 'tx', items);
  s.put('example.finance', 'tx', [{ key: '2025-12-31', value: 'old' }]);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = s.list('example.finance', {
      collection: 'tx',
      prefix: '2026-',
      limit: 10,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...page.items.map((item) => item.key));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(
    seen,
    items.map((item) => item.key),
  );
  // A cursor belongs to its collection.
  const first = s.list('example.finance', { collection: 'tx', limit: 1 });
  assert.throws(() => s.list('example.finance', { collection: 'other', cursor: first.cursor! }), { code: 'E_INVALID' });
  assert.throws(() => s.list('example.finance', { collection: 'tx', cursor: 'not-a-cursor' }), { code: 'E_INVALID' });
});

test('a batch over the quota writes nothing', () => {
  const s = storage(100);
  s.put('example.finance', 'a', [{ key: 'k', value: 'x'.repeat(50) }]);
  assert.throws(
    () =>
      s.put('example.finance', 'a', [
        { key: 'k2', value: 'y'.repeat(30) },
        { key: 'k3', value: 'z'.repeat(30) },
      ]),
    { code: 'E_LIMIT' },
  );
  assert.deepEqual(s.get('example.finance', 'a', ['k2', 'k3']), []);
  // Replacing a value counts only the difference.
  s.put('example.finance', 'a', [{ key: 'k', value: 'w'.repeat(90) }]);
});

test('backup restores into the same Mod only, and delete needs the Mod ID repeated', () => {
  const s = storage();
  s.put('example.finance', 'ledger', [
    { key: 'a', value: '1' },
    { key: 'b', value: '2' },
  ]);
  s.put('example.finance', 'settings', [{ key: 'currency', value: 'CAD' }]);
  const backup = s.backup('example.finance');
  assert.equal(backup.items.length, 3);
  assert.throws(() => s.restore('example.other', backup), { code: 'E_INVALID' });
  assert.throws(() => s.clear('example.finance', 'yes'), { code: 'E_INVALID' });
  assert.deepEqual(s.clear('example.finance', 'example.finance'), { deleted: 3 });
  assert.deepEqual(s.restore('example.finance', JSON.parse(JSON.stringify(backup))), { restored: 3 });
  assert.deepEqual(s.backup('example.finance').items, backup.items);
  assert.deepEqual(s.owners(), [{ modId: 'example.finance', items: 3, bytes: s.usage('example.finance').bytes }]);
  assert.throws(() => s.restore('example.finance', { ...backup, format: 'other' }), { code: 'E_INVALID' });
});
