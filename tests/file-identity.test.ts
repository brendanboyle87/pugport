import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileIdentity, sameIno } from '../src/server/platform/file-identity.ts';
import { largeFileId } from './helpers/file-identity.ts';

test('file identity preserves different IDs beyond Number precision and device boundaries', () => {
  const a = fileIdentity({ dev: 1n, ino: largeFileId });
  const b = fileIdentity({ dev: 1n, ino: largeFileId + 1n });
  assert.equal(Number(a.ino), Number(b.ino));
  assert.notDeepEqual(a, b);
  assert.notDeepEqual(a, fileIdentity({ dev: 2n, ino: largeFileId }));
  assert.deepEqual(a, fileIdentity({ dev: 1n, ino: largeFileId }));
});

test('inode comparisons preserve legacy numeric rounding and exact new string identities', () => {
  assert.equal(sameIno(42, '42'), true);
  assert.equal(sameIno('42', 42), true);
  assert.equal(sameIno(42, 42), true);
  assert.equal(sameIno(42, '43'), false);
  assert.equal(sameIno('43', 42), false);
  assert.equal(sameIno('42', '42'), true);
  assert.equal(sameIno('042', '42'), false);
  assert.equal(sameIno(Number(largeFileId), String(largeFileId + 1n)), true);
  assert.equal(sameIno(String(largeFileId + 1n), Number(largeFileId)), true);
  assert.equal(sameIno(String(largeFileId), String(largeFileId + 1n)), false);
});

for (const value of [
  '',
  ' 5',
  '5 ',
  '0x5',
  '5.0',
  '-5',
  '1e3',
  null,
  true,
  false,
  undefined,
  NaN,
  Infinity,
  -Infinity,
  -1,
  1.5,
  5n,
  {},
  [],
]) {
  test(`inode comparison rejects invalid input ${String(value)} (${typeof value})`, () => {
    for (const other of [value, 0, 1, 5, '0', '5']) {
      assert.equal(sameIno(value, other), false);
      assert.equal(sameIno(other, value), false);
    }
  });
}

test('zero and decimal strings remain valid without normalizing exact strings', () => {
  assert.equal(sameIno(0, '0'), true);
  assert.equal(sameIno('005', 5), false);
  assert.equal(sameIno('005', '5'), false);
});
