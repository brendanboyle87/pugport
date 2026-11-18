import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { findMoveJournal } from '../src/server/file-manager-journals.ts';

test('known journal id uses one direct read; latest search uses at most four bodies and stops early', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-journals-')));
  t.after(() => {
    assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(root.split(sep).at(-1)?.startsWith('pugport-journals-'));
    rmSync(root, { recursive: true, force: true });
  });
  const current = join(root, 'current'),
    legacy = join(root, 'legacy');
  mkdirSync(current);
  mkdirSync(legacy);
  for (let index = 0; index < 100; index++) {
    const journal = {
      id: `journal-${index}`,
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      conversationId: index === 98 ? 'other' : 'wanted',
      moves: [],
      recycled: [],
      created: [],
      ...(index === 99 ? { undoneAt: 'already' } : {}),
    };
    writeFileSync(join(current, journal.id + '.json'), JSON.stringify(journal));
    if (index === 99)
      writeFileSync(join(legacy, journal.id + '.json'), JSON.stringify({ ...journal, undoneAt: undefined }));
  }
  let active = 0,
    maximum = 0,
    reads = 0;
  const read = async (path: string) => {
    reads++;
    active++;
    maximum = Math.max(maximum, active);
    try {
      return await readFile(path, 'utf8');
    } finally {
      active--;
    }
  };
  assert.equal((await findMoveJournal([current, legacy], 'journal-2', 'wanted', read))?.id, 'journal-2');
  assert.equal(reads, 1);
  reads = 0;
  assert.equal((await findMoveJournal([current, legacy], '', 'wanted', read))?.id, 'journal-97');
  assert.equal(reads, 4);
  assert.ok(maximum <= 4);
  assert.equal((await findMoveJournal([current, legacy], 'journal-99', undefined, read))?.undoneAt, 'already');
  reads = 0;
  assert.equal(await findMoveJournal([current], '../journal-2', undefined, read), undefined);
  assert.equal(reads, 0);
});
